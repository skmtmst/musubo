'use client'
import { isConflict } from './cta-errors'
export { isConflict } from './cta-errors'

import { SettingsFormRow } from '@/components/shared/settings-form-card'
import Card from '@/components/shared/card'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SaveConflictBand } from '@/components/shared/save-conflict'
import { Play, Plus } from 'lucide-react'
import { CreatePage } from '@/components/templates'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Dialog from '@/components/shared/dialog'
import { RowMenu } from '@/components/shared/row-actions'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import Toggle from '@/components/shared/toggle'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { TextField } from '@/components/shared/text-field'
import TapActionField from '@/components/shared/tap-action-field'
import type { TapActionKind } from '@/lib/tap-actions'
import { webinarErrorText } from '@/components/webinars/webinar-error-text'
import { ApiError, fetchApi, webinarApi, type WebinarCtaCard, type WebinarEditor } from '@/lib/api'
import { buildCompareRows } from './cta-compare'
import { useFormErrors } from '@/lib/use-form-errors'
import { ErrorCountBadge } from '@/components/shared/error-count-badge'
import ValidationSummary from '@/components/shared/validation-summary'
import { FieldError } from '@/components/shared/form-controls'
import { ReadValue } from './parts'
import { cardFieldProblems, fmtMinSec, parseMinSec } from './cta-validation'
import type { EditContext, PaneSaveProps, WizardChrome } from './types'
import form from './form.module.css'
import styles from './cta.module.css'
import { formatTime as polishFormatTime, formatNumber } from '@/lib/format'
import { Field } from '@/components/shared/form-controls'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import StatusBadge from '@/components/shared/status-badge'


/*
 * ★V8 ウェビナーの ③CTA・フォーム（Pencil ・同時編集の帯 ）。
 * 案内ボタンのカードの並び（時刻・見出し・種類・「…」）→ 選んでいるカードの中身 → 申込に使う回答フォーム。
 * 右はカードの見え方。
 * 口・保存前の確かめ・同時編集（409）の扱いは BEHAVIOR.md。
 */

type FormCandidates = { state: 'idle' | 'loading' | 'ready' | 'error' | 'forbidden'; items: Array<{ id: string; name: string; isActive: boolean; folderId?: string | null }> }

/** CTA の押したら：URL を開く・回答フォーム。 */
const WEBINAR_CTA_KINDS: readonly TapActionKind[] = ['uri', 'form']
const EMPTY_CARD = (atSeconds: number): WebinarCtaCard => ({ atSeconds, kind: 'form', title: '', body: null, buttonLabel: '', autoOpen: false, formId: null, url: null })


export default function CtaPane({ ctx, chrome, onDirtyChange, registerSave }: { ctx: EditContext; chrome: WizardChrome } & PaneSaveProps) {
  const saveErrors = useSaveFormErrors()
  const { webinar, editor, readOnly } = ctx
  const webinarId = webinar.id
  const accountId = webinar.accountId
  const [ctas, setCtas] = useState<WebinarCtaCard[] | null>(null)
  const [times, setTimes] = useState<string[]>([])
  const [selected, setSelected] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState<number | null>(null)
  const [savedCards, setSavedCards] = useState<string | null>(null)
  const [savedForm, setSavedForm] = useState(editor.registrationFormId ?? '')
  const [registrationFormId, setRegistrationFormId] = useState(editor.registrationFormId ?? '')
  const [forms, setForms] = useState<FormCandidates>({ state: 'idle', items: [] })
  const [registrationError, setRegistrationError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [conflictScope, setConflictScope] = useState<'cards' | 'form'>('cards')
  const [latest, setLatest] = useState<{ editor: WebinarEditor; ctas: WebinarCtaCard[] | null } | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const [replaceConfirm, setReplaceConfirm] = useState(false)
  const lock = useRef(false)
  const requestId = useRef(0)
  const formRequestId = useRef(0)
  const webinarScope = useRef({ webinarId, generation: 0 })
  if (webinarScope.current.webinarId !== webinarId) {
    webinarScope.current = { webinarId, generation: webinarScope.current.generation + 1 }
  }
  const prevWebinarIdRef = useRef(webinarId)
  const onCtasReport = ctx.onCtasReport

  useEffect(() => {
    const scope = webinarScope.current
    if (prevWebinarIdRef.current !== webinarId) {
      prevWebinarIdRef.current = webinarId
      setConflict(false)
      setLatest(null)
      setCompareOpen(false)
      setReading(false)
      setReplaceConfirm(false)
      setRegistrationError('')
      setMessage(null)
      setSavedForm(editor.registrationFormId ?? '')
      setRegistrationFormId(editor.registrationFormId ?? '')
    }
    return () => {
      if (webinarScope.current === scope) {
        webinarScope.current = { webinarId: scope.webinarId, generation: scope.generation + 1 }
      }
    }
    // webinarId が変わったときだけ前のウェビナーの競合・比較・フォーム選択を初期化する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webinarId])

  const loadCtas = useCallback(async () => {
    const id = ++requestId.current
    setCtas(null)
    setMessage(null)
    setLoadFailed(false)
    try {
      const res = await webinarApi.ctas(webinarId)
      if (id !== requestId.current) return
      if (!Array.isArray(res.data)) throw new Error('cta_list_not_array')
      setCtas(res.data)
      setTimes(res.data.map((card) => fmtMinSec(card.atSeconds)))
      setSavedCards(JSON.stringify([res.data, res.data.map((card) => fmtMinSec(card.atSeconds))]))
      setSelected(0)
      onCtasReport(res.data)
    } catch (saveFailure) {
      if (id !== requestId.current) return
      saveErrors.capture(saveFailure)
      setLoadFailed(true)
      onCtasReport(null)
    }
  }, [webinarId, onCtasReport, saveErrors])
  useEffect(() => {
    void loadCtas();

    return () => { requestId.current += 1 }
  }, [loadCtas])

  const loadForms = useCallback(() => {
    const id = ++formRequestId.current
    if (!accountId) { setForms({ state: 'idle', items: [] }); return }
    setForms({ state: 'loading', items: [] })
    fetchApi<{ success: boolean; data: Array<{ id: string; name: string; isActive?: boolean; folderId?: string | null }> }>(`/api/forms?account_id=${encodeURIComponent(accountId)}`)
      .then((response) => {
        if (id !== formRequestId.current) return
        if (!response.success || !Array.isArray(response.data)) throw new Error('forms_not_loaded')
        setForms({ state: 'ready', items: response.data.map((item) => ({ ...item, isActive: item.isActive === true })) })
      })
      .catch((cause: unknown) => {
        if (id !== formRequestId.current) return
        setForms({ state: cause instanceof ApiError && (cause.status === 403 || cause.status === 404) ? 'forbidden' : 'error', items: [] })
      })
  }, [accountId])
  useEffect(() => {
    loadForms()
    return () => { formRequestId.current += 1 }
  }, [loadForms])

  const published = forms.items.filter((item) => item.isActive)
  /* 選ぶ窓の候補：公開中のフォーム。選んであるのが公開中でないときも消さずに出す。 */
  const formRows = (current: string | null | undefined) => {
    const kept = current && !published.some((item) => item.id === current) ? forms.items.find((item) => item.id === current) : undefined
    return kept ? [...published, kept] : published
  }
  const formMeta = (row: { isActive?: boolean | null }) => row.isActive ? '公開中' : '公開中ではありません'
  const update = (index: number, patch: Partial<WebinarCtaCard>) => setCtas((prev) => (prev ? prev.map((card, j) => (j === index ? { ...card, ...patch } : card)) : prev))

  /*
   * 保存で落ちた欄。カードは1枚ずつしか開いていないので、落ちた欄が別のカードなら
   * そのカードを選んでから移る。カードの行には直す欄の数の赤い丸を付ける。
   */
  const fields = useFormErrors()
  ;(ctas ?? []).forEach((card, i) => {
    const check = () => cardFieldProblems(card, times[i] ?? '', webinar.durationSeconds)
    const opts = { required: true, reveal: () => setSelected(i), group: `card-${i}` }
    fields.define(`cta-${i}-title`, `カード${i + 1}の見出し`, () => check().title, opts)
    fields.define(`cta-${i}-time`, `カード${i + 1}の出す時刻`, () => check().time, opts)
    fields.define(`cta-${i}-button`, `カード${i + 1}のボタンの言葉`, () => check().button, opts)
    fields.define(`cta-${i}-link`, card.kind === 'form' ? `カード${i + 1}の使うフォーム` : `カード${i + 1}の開く URL`, () => check().link, opts)
  })

  /* 下書きを保存：カードは読めていれば今の中身をそのまま保存する（同時編集の 409 はここでも見つける）。 */
  const saveCards = async (): Promise<boolean> => {
    if (ctas === null) return false
    if (fields.submit().length > 0) { setMessage(null); return false }
    const targetWebinarId = webinarId
    const targetGeneration = webinarScope.current.generation
    const isSameWebinar = () => webinarScope.current.webinarId === targetWebinarId && webinarScope.current.generation === targetGeneration
    const next = ctas.map((card, i) => ({ ...card, atSeconds: parseMinSec(times[i]) ?? 0 }))
    try {
      await webinarApi.saveCtas(targetWebinarId, next)
      if (!isSameWebinar()) return false
      setCtas(next)
      setTimes(next.map((card) => fmtMinSec(card.atSeconds)))
      setSavedCards(JSON.stringify([next, next.map((card) => fmtMinSec(card.atSeconds))]))
      setMessage(null)
      onCtasReport(next)
      return true
    } catch (cause) {
      if (!isSameWebinar()) return false
      const fieldFailure = saveErrors.capture(cause);

      if (isConflict(cause)) { setConflictScope('cards'); setConflict(true); setLatest(null); return false }
      { if (!fieldFailure)
      setMessage('案内ボタンのカードを保存できませんでした。入力は残っています。もう一度保存してください。') }
      return false
    }
  }
  const saveForm = async (): Promise<boolean> => {
    if (forms.state !== 'ready') { setRegistrationError('回答フォームの候補を読み込んでから保存してください。'); return false }
    if (registrationFormId && !published.some((item) => item.id === registrationFormId)) { setRegistrationError('選んだ申込フォームは今の候補にありません。公開中のフォームを選び直してください。'); return false }
    const targetWebinarId = webinarId
    const targetGeneration = webinarScope.current.generation
    const isSameWebinar = () => webinarScope.current.webinarId === targetWebinarId && webinarScope.current.generation === targetGeneration
    setRegistrationError('')
    try {
      const response = await webinarApi.saveEditor(targetWebinarId, {
        expectedVersion: editor.version,
        ...(editor.updatedAt ? { expectedUpdatedAt: editor.updatedAt } : null),
        registrationFormId: registrationFormId || null,
      })
      if (!isSameWebinar()) return false
      ctx.onEditorChange(response.data)
      setSavedForm(registrationFormId)
      return true
    } catch (cause) {
      if (!isSameWebinar()) return false
      const fieldFailure = saveErrors.capture(cause);

      if (isConflict(cause)) { setConflictScope('form'); setConflict(true); setLatest(null); return false }
      if (cause instanceof ApiError && ['form_inactive_or_missing', 'form_account_mismatch'].includes(cause.code ?? '')) loadForms()
      { if (!fieldFailure)
      setRegistrationError(webinarErrorText(cause, '申込フォームを保存できませんでした。入力は残っています。')) }
      return false
    }
  }

  const cardsDirty = savedCards !== null && JSON.stringify([ctas, times]) !== savedCards
  const formDirty = registrationFormId !== savedForm
  const formsReadyForSave = forms.state === 'ready' || (forms.state === 'error' && !formDirty && ctas !== null && ctas.every(card => card.kind !== 'form'))
  const canSave = !readOnly && ctas !== null && formsReadyForSave && !conflict
  const saveCurrent = useRef<() => Promise<boolean>>(async () => false)
  saveCurrent.current = async () => {
    if (!canSave || lock.current) return false
    if (fields.submit().length > 0) { setMessage(null); return false }
    lock.current = true
    setSaving(true)
    try {
      if (formDirty && !(await saveForm())) return false
      return await saveCards()
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  useEffect(() => { onDirtyChange(cardsDirty || formDirty) }, [cardsDirty, formDirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => {
    if (!canSave) { registerSave(null); return }
    registerSave(() => saveCurrent.current())
    return () => registerSave(null)
  }, [registerSave, canSave])

  /* 同時編集：申込フォームだけの競合ではカードの入力を残す。カード自体の競合は確認して最新版へ置き換える。 */
  const readLatest = async () => {
    if (reading) return
    const targetWebinarId = webinarId
    const targetGeneration = webinarScope.current.generation
    const isSameWebinar = () => webinarScope.current.webinarId === targetWebinarId && webinarScope.current.generation === targetGeneration
    setReading(true)
    try {
      const [editorRes, ctasRes] = await Promise.all([webinarApi.editor(targetWebinarId), webinarApi.ctas(targetWebinarId).catch(() => null)])
      if (!isSameWebinar()) return
      setLatest({ editor: editorRes.data, ctas: ctasRes && Array.isArray(ctasRes.data) ? ctasRes.data : null })
      setCompareOpen(true)
    } catch (saveFailure) {
      if (!isSameWebinar()) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setRegistrationError('最新版を読み込めませんでした。入力は残っています。もう一度お試しください。') }
    } finally {
      if (isSameWebinar()) setReading(false)
    }
  }
  const acceptLatest = async () => {
    const targetWebinarId = webinarId
    const targetGeneration = webinarScope.current.generation
    const isSameWebinar = () => webinarScope.current.webinarId === targetWebinarId && webinarScope.current.generation === targetGeneration
    const next = latest ?? await webinarApi.editor(targetWebinarId).then((res) => ({ editor: res.data, ctas: null })).catch(() => null)
    if (!isSameWebinar()) return false
    if (!next) { setRegistrationError('最新版を読み込めませんでした。もう一度お試しください。'); return false }
    ctx.onEditorChange(next.editor)
    setRegistrationFormId(next.editor.registrationFormId ?? '')
    setSavedForm(next.editor.registrationFormId ?? '')
    setConflict(false)
    setLatest(null)
    setCompareOpen(false)
    setReplaceConfirm(false)
    if (conflictScope === 'cards') await loadCtas()
    return true
  }

  const currentIndex = ctas === null ? 0 : Math.min(selected, Math.max(ctas.length - 1, 0))
  const current = ctas === null ? null : ctas[currentIndex] ?? null
  const errId = (part: 'title' | 'time' | 'button' | 'link') => (fields.invalid(`cta-${currentIndex}-${part}`) ? `cta-${part}-error` : undefined)
  const formName = (id: string | null | undefined) => (id ? forms.items.find((item) => item.id === id)?.name ?? '選んだフォーム' : emptyValue('unconfigured'))
  const busy = saving || reading

  return (
    <SaveErrorScope errors={saveErrors}><CreatePage dirty={false}
      boardId={conflict ? 'pvimJ' : 'Q0Jrk'}
      title={chrome.title}
      actions={chrome.actions}
      identity={chrome.identity}
      steps={chrome.steps}
      help="動画の途中や終わりに出すカードと、申込に使う回答フォームを決めます。"
      /* 競合の間は「下書きを保存」を「比べてから保存」に替える（押すと違いを比べる窓。絵 ）。 */
      footerActions={conflict && chrome.footerWithDraft
        ? chrome.footerWithDraft(<Button disabled={busy} busy={reading} onClick={() => void readLatest()}>比べてから保存</Button>)
        : chrome.footerActions}
      status={chrome.status}
      /* 競合の帯は左右の列の上に横いっぱい。 */
      notice={conflict ? (
        <SaveConflictBand designNode="pvimJ"
          title={latest?.editor.updatedAt ? `ほかの人が ${polishFormatTime(new Date(latest.editor.updatedAt))} にこのウェビナーを保存しました` : 'ほかの人がこのウェビナーを保存しました'}
          compareBusy={busy || reading} onCompare={readLatest} onReload={() => setReplaceConfirm(true)} />
      ) : undefined}
      preview={<>
        <h2 className={form.previewTitle}>カードの見え方</h2>
        <div className={styles.previewCard}>
          <span className={styles.player} aria-hidden="true"><Play size={40} /></span>
          <div className={styles.ctaCard}>
            <p className={styles.ctaTitle}>{current?.title || '（見出しなし）'}</p>
            {current?.body ? <p className={styles.ctaBody}>{current.body}</p> : null}
            {current?.buttonLabel.trim() ? <p className={styles.ctaButton} title="動画の下にボタンが出ます。">{current.buttonLabel}</p> : null}
          </div>
        </div>
      </>}
    >

      <Card variant="form" gap="normal" aria-labelledby="webinar-cta-title" data-wc-pane="cta">
        <div className={form.cardHeadRow}><h2 id="webinar-cta-title" className={form.cardTitle}>{ctas === null ? '案内ボタンのカード' : `案内ボタンのカード ${formatNumber(ctas.length)} 枚`}</h2></div>
        <p className={styles.desc}>動画の途中で出す申し込みボタンです。出す時刻は 分:秒 で入れます。</p>
        {message ? <Notice tone="danger">{message}</Notice> : null}
        <ValidationSummary problems={fields.listProblems()} onFocusFirst={fields.focusFirst} minProblems={2} />
        {loadFailed ? (
          <ListState kind="error" title="案内ボタンのカードを読み込めませんでした" description="読み込めるまで保存はできません。" onRetry={() => void loadCtas()} />
        ) : ctas === null ? <ListState kind="loading" /> : <>
          {ctas.map((card, index) => (
            <div key={index} className={form.listRow} data-selected={index === currentIndex || undefined}>
              <button type="button" className={styles.cardPick} aria-current={index === currentIndex || undefined} onClick={() => setSelected(index)}>
                <span className={styles.cardTime}>{times[index] ?? fmtMinSec(card.atSeconds)}</span>
                <span className={`${form.rowMain} ${form.ellipsis}`} title={card.title}>{card.title || '（見出しなし）'}</span>
                <StatusBadge tone={card.kind === 'form' ? 'success' : 'neutral'}>{card.kind === 'form' ? '回答フォーム' : 'URL'}</StatusBadge>
                <ErrorCountBadge count={fields.countIn(`card-${index}`)} label={`カード${index + 1}`} />
              </button>
              {readOnly ? null : (
                <div className={form.menuBox}>
                  <RowMenu label={`カード${index + 1}の操作`} triggerProps={{ disabled: busy }} open={menuOpen === index} onOpenChange={(next) => setMenuOpen(next ? index : null)} items={[
                    { id: 'copy', label: '複製する', onSelect: () => { setMenuOpen(null); setCtas((prev) => (prev ? [...prev.slice(0, index + 1), { ...prev[index] }, ...prev.slice(index + 1)] : prev)); setTimes((prev) => [...prev.slice(0, index + 1), prev[index], ...prev.slice(index + 1)]) } },
                    { id: 'delete', label: '消す', tone: 'danger', onSelect: () => { setMenuOpen(null); setCtas((prev) => (prev ? prev.filter((_, j) => j !== index) : prev)); setTimes((prev) => prev.filter((_, j) => j !== index)); setSelected(0) } },
                  ]} />
                </div>
              )}
            </div>
          ))}
          {ctas.length === 0 ? <p className={form.cardNote}>まだカードがありません。</p> : null}
          {readOnly ? null : (
            <div><Button disabled={busy} onClick={() => { setCtas((prev) => [...(prev ?? []), EMPTY_CARD(0)]); setTimes((prev) => [...prev, '0:00']); setSelected(ctas.length) }}><Plus size={16} aria-hidden="true" />案内ボタンのカードを足す</Button></div>
          )}
          {current ? (
            <fieldset className={styles.editor} disabled={busy}>
              {/* 閲覧のみ：文字の欄は読み取りだけ、選ぶ部品は選んでいる値を文字で見せる（2026-10-06 オーナー決定）。 */}
              <p className={styles.editorTitle}>{`選んでいるカード：${times[currentIndex] ?? fmtMinSec(current.atSeconds)}`}</p>
              <SettingsFormRow layout="columns">
                <div className={form.field}><Field label="見出し" htmlFor="cta-title" requirement={fields.requirement(`cta-${currentIndex}-title`)}><SaveErrorField names={["title","current.title"]}><TextField {...fields.bind(`cta-${currentIndex}-title`)} id="cta-title" value={current.title} readOnly={readOnly} invalid={fields.invalid(`cta-${currentIndex}-title`)} aria-describedby={errId('title')} onChange={(event) => update(currentIndex, { title: event.target.value })} /></SaveErrorField>
<FieldError id="cta-title-error">{fields.error(`cta-${currentIndex}-title`)}</FieldError></Field></div>
                <div className={form.field}><Field label="出す時刻（分:秒）" htmlFor="cta-time" requirement={fields.requirement(`cta-${currentIndex}-time`)}><SaveErrorField names={["times"]}><TextField {...fields.bind(`cta-${currentIndex}-time`)} id="cta-time" value={times[currentIndex] ?? ''} readOnly={readOnly} inputMode="numeric" placeholder="12:00" invalid={fields.invalid(`cta-${currentIndex}-time`)} aria-describedby={errId('time')} onChange={(event) => setTimes((prev) => prev.map((value, j) => (j === currentIndex ? event.target.value : value)))} /></SaveErrorField>
<FieldError id="cta-time-error">{fields.error(`cta-${currentIndex}-time`)}</FieldError></Field></div>
              </SettingsFormRow>
              <div className={form.field}><Field label="ボタンの言葉" htmlFor="cta-button" requirement={fields.requirement(`cta-${currentIndex}-button`)}><SaveErrorField names={["buttonLabel","current.buttonLabel","button_label","current.button_label"]}><TextField {...fields.bind(`cta-${currentIndex}-button`)} id="cta-button" value={current.buttonLabel} readOnly={readOnly} invalid={fields.invalid(`cta-${currentIndex}-button`)} aria-describedby={errId('button')} onChange={(event) => update(currentIndex, { buttonLabel: event.target.value })} /></SaveErrorField>
<FieldError id="cta-button-error">{fields.error(`cta-${currentIndex}-button`)}</FieldError></Field></div>
              <div className={form.field}>
                <Field label="押したら" errorId="cta-link-error" requirement={fields.requirement(`cta-${currentIndex}-link`)} error={fields.error(`cta-${currentIndex}-link`)} errorFrame>
                {/*
                  押したらの共通の欄（TapActionField・YPzmo）。ウェビナーの視聴ページの CTA なので URL と回答フォームの2つだけ
                  （回答フォームは視聴ページの中で開くので LIFF は要らない）。保存の形（kind・formId・url）は今のまま。
                  保存で落ちたら（B-139）この欄の下に理由を出し、欄の中の1つ目へ移る。
                */}
                <div {...fields.bind(`cta-${currentIndex}-link`)} aria-describedby={errId('link')}>
                  <SaveErrorField names={["CTA","_c_t_a"]}><TapActionField
                    name="CTA"
                    kindLabel="リンクの種類"
                    value={{ kind: current.kind === 'form' ? 'form' : 'uri', uri: current.url ?? '', text: '', refId: current.formId ?? '' }}
                    onChange={(patch) => {
                      /* 種類を変えても、もう一方の値（formId・url）は今までどおり残す。 */
                      if (patch.kind !== undefined) { update(currentIndex, { kind: patch.kind === 'form' ? 'form' : 'url' }); return }
                      if (patch.uri !== undefined) update(currentIndex, { url: patch.uri })
                      if (patch.refId !== undefined) update(currentIndex, { formId: patch.refId || null })
                    }}
                    kinds={WEBINAR_CTA_KINDS}
                    hasLiff
                    readOnly={readOnly}
                    sources={forms.state === 'ready' ? { form: forms.items.map((item) => ({ ...item, note: item.isActive ? '公開中' : '公開していません', disabled: !item.isActive })) } : undefined}
                  /></SaveErrorField>
                </div>
                </Field>
              </div>
              <div className={styles.toggleRow}>
                {readOnly ? null : <SaveErrorField names={["autoOpen","current.autoOpen","auto_open","current.auto_open"]}><Toggle checked={current.autoOpen} label="ボタンを押したら、フォームを自動で開く" onChange={(next) => update(currentIndex, { autoOpen: next })} /></SaveErrorField>}
                <span className={styles.toggleText}>{readOnly ? `ボタンを押したら、フォームを自動で${current.autoOpen ? '開く' : '開かない'}` : 'ボタンを押したら、フォームを自動で開く'}</span>
              </div>
            </fieldset>
          ) : null}
        </>}
      </Card>

      <Card variant="form" gap="normal" aria-labelledby="webinar-regform-title">
        <div className={form.cardHeadRow}><h2 id="webinar-regform-title" className={form.cardTitle}>申込に使う回答フォーム</h2></div>
        <p className={styles.desc}>申し込みのときに答えてもらうフォームです。公開中のフォームから1つ選びます。</p>
        <div className={form.field}>
          <span className={form.labelSmall}>申込フォーム</span>
          {forms.state === 'ready' ? (
            <div className={styles.formSelect}>
              {readOnly ? <ReadValue label="申込に使う回答フォーム">{editor.publicPage.form?.name ?? formName(registrationFormId)}</ReadValue> : <SaveErrorField names={["registrationFormId"]}><EntityKindField kind="form" label="申込に使う回答フォーム" options={formRows(registrationFormId)} meta={formMeta} accountId={accountId} value={registrationFormId} disabled={busy || conflict} disabledReason={conflict ? 'ほかの人が更新しました。最新の内容を読み込んでください。' : busy ? '処理中です。完了してから操作してください。' : undefined} invalid={Boolean(registrationFormId) && !published.some((item) => item.id === registrationFormId)} onChange={setRegistrationFormId} /></SaveErrorField>}
            </div>
          ) : forms.state === 'loading' ? <p className={form.cardNote}>回答フォームを読み込んでいます。</p>
            : forms.state === 'forbidden' ? <p className={form.cardNote}>{permissionDeniedMessage('store')}</p>
              : forms.state === 'error' ? <Notice tone="danger" className={form.cardNoteNoticePlacement} >回答フォームを読み込めませんでした。<Button size="compact" onClick={loadForms}>もう一度読み込む</Button></Notice>
                : <p className={form.cardNote}>LINE 公式アカウントを確かめられないため、候補を出せません。</p>}
        </div>
        {forms.state === 'ready' && published.length === 0 ? <p className={form.cardNote}>公開中の回答フォームがありません。</p> : null}
        {forms.state === 'ready' && registrationFormId && !published.some((item) => item.id === registrationFormId) ? <p className={form.fieldError} role="alert">前に選んだフォームは使えなくなりました。公開中のフォームを選び直してください。</p> : null}
        {registrationError ? <p className={form.fieldError} role="alert">{registrationError}</p> : null}
      </Card>

      <ConfirmDialog open={replaceConfirm} title="最新を読み込んで続けますか？" description={conflictScope === 'form' ? '申込フォームを保存されている最新版に置き換えます。案内ボタンのカードの入力は残します。' : '保存されている最新の 案内ボタンのカードと申込フォームに置き換えます。この画面で直したところは消えます。'} confirmLabel="最新を読み込んで続ける" onCancel={() => setReplaceConfirm(false)} error={registrationError || undefined} onSuccess={() => setReplaceConfirm(false)} onConfirm={() => acceptLatest()} />
      {compareOpen && latest ? (
        <Dialog open title="違いを比べる" description="左がこの画面の入力、右が保存されている最新です。" confirmLabel="最新を読み込んで続ける" onConfirm={() => { setCompareOpen(false); setReplaceConfirm(true) }} onCancel={() => setCompareOpen(false)}>
          <DataTable className={styles.compare}>
            <thead><TableHeadRow><Th>項目</Th><Th>この画面</Th><Th>最新</Th></TableHeadRow></thead>
            <tbody>
              {buildCompareRows({ formName: formName(registrationFormId), cards: ctas ?? [], times }, latest.editor.publicPage.form?.name ?? formName(latest.editor.registrationFormId), latest.ctas).map(row => <Tr key={row.key}><Td>{row.label}</Td><Td>{row.mine}</Td><Td>{row.theirs}</Td></Tr>)}
            </tbody>
          </DataTable>
        </Dialog>
      ) : null}
    </CreatePage></SaveErrorScope>
  )
}
