'use client'

import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  name: requiredText("名前を入力してください"),
  step_label: requiredText("この段に名前を付けてください"),
}


import { jstDateOffset } from '@/lib/jst-datetime'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { ApiError, api } from '@/lib/api'
import { SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict'
import { notifySaved } from '@/components/shared/toast'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import type { FunnelEditDraft } from './funnel'
import styles from './funnel-form.module.css'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect from '@/components/shared/entity-select'
import EntityRemoteField, { type RemoteEntityKind } from '@/components/shared/entity-remote-field'


/*
 * ★V8-B 分析「ファネルを作る」（板 ）と「ファネルを直す」（同じ形）。
 *
 * 今の作る・直すフォーム（app/analytics/page.tsx の FunnelForm）の動きを写して一から書いた。
 * 絵は「段Nの名前 ｜ 何をしたら」の2列。何をしたらは、種類と相手（成果地点・タグ・フォーム）を
 * 1つの選ぶ欄にまとめる（例：成果「商品を買った」）。一覧に無い相手・IDで決める種類
 * （情報欄・サイトのページ・リンク・オートメーション）は「ほかの条件」を選ぶと、
 * その段の下に種類と候補を選ぶ欄が出る。保存の形（kind・match・版の追加）は今と同じ。
 */

/** 段の種類（今の画面と同じ並び・同じ言葉）。hint は ID の欄の名前。 */
export const FUNNEL_STEP_KINDS = [
  { key: 'friend_add', label: '友だち追加', hint: '' },
  { key: 'tag', label: 'タグが付いた', hint: 'タグ' },
  { key: 'field', label: '情報欄に値が入った', hint: '情報欄（値は問いません）' },
  { key: 'form', label: 'フォームに答えた', hint: '回答フォーム' },
  { key: 'site_event', label: 'サイトのページを見た', hint: 'パスのまとまり（例：thanks）' },
  { key: 'purchase', label: '購入が確定した', hint: '' },
  { key: 'link_click', label: 'リンクを踏んだ', hint: '計測リンク' },
  { key: 'conversion', label: '成果が記録された', hint: '成果地点' },
  { key: 'message', label: 'メッセージを受信した', hint: '' },
  { key: 'booking', label: '予約が確定した', hint: '' },
  { key: 'automation', label: 'オートメーションが動いた', hint: 'ルール' },
] as const

const NO_VALUE_KINDS = ['friend_add', 'purchase', 'message', 'booking']
const OTHER = '__other__'
const ENTITY_TARGETS: Record<string, RemoteEntityKind> = Object.assign(Object.create(null), { tag: 'tag', field: 'friend_field', form: 'form', link_click: 'tracked_link', conversion: 'conversion', automation: 'automation' })
const MAX_STEPS = 10
const MIN_STEPS = 2

export function kindNeedsValue(kind: string): boolean {
  return !NO_VALUE_KINDS.includes(kind)
}

/** 段の条件（match）。今の画面の matchFor と同じ。 */
export function funnelMatchFor(kind: string, value: string): Record<string, string> {
  if (kind === 'friend_add') return {}
  if (kind === 'tag') return { tagId: value }
  if (kind === 'field') return { fieldId: value }
  if (kind === 'form') return { formId: value }
  if (kind === 'site_event') return { eventType: 'page_view', pathGroup: value }
  if (kind === 'purchase') return { status: 'confirmed' }
  if (kind === 'link_click') return { trackedLinkId: value }
  if (kind === 'conversion') return { conversionPointId: value }
  if (kind === 'message') return { direction: 'received' }
  if (kind === 'booking') return { status: 'confirmed' }
  return { automationId: value }
}

/** 直すとき、元の版の副条件に入れ直す主キー。今の画面と同じ。 */
export function funnelStepPrimaryKey(kind: string): string | null {
  switch (kind) {
    case 'tag': return 'tagId'
    case 'field': return 'fieldId'
    case 'form': return 'formId'
    case 'site_event': return 'pathGroup'
    case 'link_click': return 'trackedLinkId'
    case 'conversion': return 'conversionPointId'
    case 'automation': return 'automationId'
    default: return null
  }
}

function explainSaveError(code: string, fallback: string): string {
  if (code === 'analytics_funnel_version_conflict' || code === 'analytics_funnel_status_conflict') {
    return '他の人が先に変更しています。最新の状態を開き直してください'
  }
  if (code === 'analytics_funnel_invalid_transition') return 'その状態へは進めません'
  return fallback
}

type Target = { kind: 'conversion' | 'tag' | 'form'; id: string; name: string }
type Step = { label: string; kind: string; value: string; matchBase?: Record<string, string>; other: boolean }

/** 選ぶ欄の値。種類だけの段は kind、相手のある段は kind:id、それ以外は「ほかの条件」。 */
export function choiceOf(step: Pick<Step, 'kind' | 'value' | 'other'>, targets: Target[]): string {
  if (step.other) return OTHER
  if (!kindNeedsValue(step.kind)) return step.kind
  if (targets.some((t) => t.kind === step.kind && t.id === step.value)) return `${step.kind}:${step.value}`
  if (!step.value) return `${step.kind}:`
  return OTHER
}

const EMPTY_LABEL: Record<Target['kind'], string> = Object.assign(Object.create(null), { conversion: '成果（成果地点を選ぶ）', tag: 'タグ（タグを選ぶ）', form: 'フォーム（フォームを選ぶ）' })

function isoDay(offsetDays: number): string {
  return jstDateOffset(offsetDays)
}

export default function FunnelFormV8({ accountId, onCancel, onCreated, edit, presetConversion }: {
  accountId: string
  onCancel: () => void
  onCreated: (id: string, usageWarnings?: string[]) => void
  edit?: FunnelEditDraft
  presetConversion?: { id: string; name: string } | null
}) {
  const saveErrors = useSaveFormErrors()
  const [name, setName] = useState(edit?.name ?? '')
  // 裏は1〜365日を受け付ける。7・30・90以外の日数も、直すときに失わないよう選ぶ欄に足す。
  const [windowDays, setWindowDays] = useState(edit?.windowDays ?? '30')
  const [steps, setSteps] = useState<Step[]>(
    edit?.steps.map((s) => ({ label: s.label, kind: s.kind, value: s.value, matchBase: s.match, other: false })) ?? [
      { label: '', kind: 'friend_add', value: '', other: false },
      { label: presetConversion?.name ?? '', kind: 'conversion', value: presetConversion?.id ?? '', other: false },
    ],
  )
  const [targets, setTargets] = useState<Target[]>([])
  const [expectedVersion, setExpectedVersion] = useState(edit?.expectedVersionNumber ?? 0)
  const [versionContext, setVersionContext] = useState({ segment: edit?.segment, comparisonGroups: edit?.comparisonGroups })
  const [saving, setSaving] = useState(false)
  const saved = useRef(JSON.stringify({ name, windowDays, steps }))
  const snapshot = JSON.stringify({ name, windowDays, steps })
  const dirty = snapshot !== saved.current
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({ dirty: dirty || saving, busy: saving, onDiscard: onCancel })
  const current = useRef({ saving, accountId, target: guard.leaveTarget })
  current.current = { saving, accountId, target: guard.leaveTarget }
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { guard.cancelLeave() }, [accountId, guard.cancelLeave])
  const discardAndLeave = () => {
    const target = guard.leaveTarget
    if (!alive.current || current.current.saving || current.current.accountId !== accountId || !target || current.current.target !== target) return
    current.current.target = null
    guard.disarm(); guard.confirmLeave()
  }
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const formRef = useRef<HTMLDivElement>(null)
  const focusTarget = useRef<string | null>(null)

  useEffect(() => {
    if (!focusTarget.current) return
    const control = formRef.current?.querySelector<HTMLElement>(`[id="${focusTarget.current}"]`)
    control?.focus()
    control?.scrollIntoView?.({ block: 'center' })
    focusTarget.current = null
  }, [fieldErrors])

  const clearFieldError = (id: string) => setFieldErrors((current) => {
    const next = { ...current }
    delete next[id]
    return next
  })

  // 何をしたらの相手（成果地点・タグ・フォーム）。読めなかったものは並べないだけ（IDで決める道は残る）。
  useEffect(() => {
    let active = true
    void Promise.allSettled([
      api.conversions.definitions({ from: isoDay(-365), to: isoDay(0), lineAccountId: accountId, sort: 'name_asc', limit: 100 }),
      api.tags.list({ accountId }),
      api.forms.list(accountId),
    ]).then(([conversions, tags, forms]) => {
      if (!active) return
      const next: Target[] = []
      if (conversions.status === 'fulfilled' && conversions.value.success) {
        const items = (conversions.value.data as { items?: Array<{ id: string; name: string; status?: string }> }).items ?? []
        for (const item of items) if (item.status !== 'stopped') next.push({ kind: 'conversion', id: item.id, name: item.name })
      }
      if (tags.status === 'fulfilled' && tags.value.success) {
        for (const tag of tags.value.data as Array<{ id: string; name: string }>) next.push({ kind: 'tag', id: tag.id, name: tag.name })
      }
      if (forms.status === 'fulfilled' && forms.value.success) {
        for (const form of forms.value.data) if (form.isActive) next.push({ kind: 'form', id: form.id, name: form.name })
      }
      // 成果地点の一覧から来たときは、その地点が一覧に無くても選べるようにする。
      if (presetConversion?.id && !next.some((t) => t.kind === 'conversion' && t.id === presetConversion.id)) {
        next.unshift({ kind: 'conversion', id: presetConversion.id, name: presetConversion.name })
      }
      setTargets(next)
    })
    return () => { active = false }
  }, [accountId, presetConversion?.id, presetConversion?.name])

  const options = useMemo(() => {
    const list: Array<{ value: string; label: string }> = [
      { value: 'friend_add', label: '友だち追加' },
    ]
    for (const t of targets.filter((x) => x.kind === 'conversion')) list.push({ value: `conversion:${t.id}`, label: `成果「${t.name}」` })
    list.push({ value: 'booking', label: '予約が確定した' }, { value: 'purchase', label: '購入が確定した' }, { value: 'message', label: 'メッセージを受信した' })
    for (const t of targets.filter((x) => x.kind === 'form')) list.push({ value: `form:${t.id}`, label: `フォーム「${t.name}」` })
    for (const t of targets.filter((x) => x.kind === 'tag')) list.push({ value: `tag:${t.id}`, label: `タグ「${t.name}」` })
    list.push({ value: OTHER, label: 'ほかの条件' })
    return list
  }, [targets])

  const optionsFor = (step: Step) => {
    const choice = choiceOf(step, targets)
    // 相手がまだ決まっていない段（成果地点を選ぶ前など）は、その旨の選択肢を先頭に出す。
    if (choice.endsWith(':')) {
      const kind = choice.slice(0, -1) as Target['kind']
      const label = EMPTY_LABEL[kind] ?? (FUNNEL_STEP_KINDS.some((item) => item.key === kind) ? `${kind}を選ぶ` : '未対応の条件')
      return [{ value: choice, label }, ...options]
    }
    return options
  }

  const update = (index: number, patch: Partial<Step>) => {
    if ('label' in patch) clearFieldError(`fn-v8-step-${index}`)
    if ('kind' in patch || 'value' in patch || 'other' in patch) {
      clearFieldError(`fn-v8-choice-${index}`)
      clearFieldError(`fn-v8-value-${index}`)
    }
    setSteps((prev) => prev.map((s, j) => (j === index ? { ...s, ...patch } : s)))
  }

  const choose = (index: number, value: string) => {
    if (value === OTHER) {
      // 種類はそのまま、IDの欄を開く。
      update(index, { other: true, matchBase: undefined })
      return
    }
    const [kind, id = ''] = value.split(':')
    // 種類を変えた段は旧条件の match を引き継がない（別種類のキーが残ると誤集計になる）。
    update(index, { kind, value: id, other: false, matchBase: undefined })
  }

  type Definition = Awaited<ReturnType<typeof api.analytics.v6Funnels.get>> & { success: true }
  const fetchLatest = async () => {
    if (!edit) return null
    const response = await api.analytics.v6Funnels.get(accountId, edit.funnelId)
    return response.success ? response.data : null
  }
  const conflict = useSaveConflict<Definition['data']>({
    contextKey: `${accountId}:${edit?.funnelId ?? 'new'}`,
    fetchLatest,
    reload: async () => {
      const latest = await fetchLatest()
      if (!latest?.currentVersion) throw new Error('最新の内容を読み込めませんでした')
      const latestWindow = String(latest.currentVersion.windowDays)
      const latestSteps = latest.currentVersion.steps.map(step => ({
        label: step.label, kind: step.kind,
        value: step.match[funnelStepPrimaryKey(step.kind) ?? ''] ?? '',
        matchBase: step.match, other: false,
      }))
      saved.current = JSON.stringify({ name: latest.name, windowDays: latestWindow, steps: latestSteps })
      setName(latest.name)
      setWindowDays(latestWindow)
      setSteps(latestSteps)
      setExpectedVersion(latest.currentVersion.versionNumber)
      setVersionContext({ segment: latest.currentVersion.segment, comparisonGroups: latest.currentVersion.comparisonGroups })
      setFieldErrors({}); setError(''); conflict.clear()
    },
  })
  const isConflict = (code: string | undefined) => code === 'analytics_funnel_version_conflict' || code === 'analytics_funnel_status_conflict'

  const save = async () => {
    const errors: Record<string, string> = {}
    if ((FIELD_REQUIREMENTS.name.check(name) !== null)) errors['fn-v8-name'] = '名前を入力してください'
    steps.forEach((step, index) => {
      if ((FIELD_REQUIREMENTS.step_label.check(step.label) !== null)) errors[`fn-v8-step-${index}`] = 'この段に名前を付けてください'
      if (kindNeedsValue(step.kind) && !step.value.trim()) errors[`fn-v8-${step.other ? 'value' : 'choice'}-${index}`] = step.kind === 'site_event' ? 'パスのまとまりを入力してください' : '何をしたら進むかを選んでください'
    })
    focusTarget.current = Object.keys(errors)[0] ?? null
    setFieldErrors(errors)
    setError('')
    if (focusTarget.current) return
    setSaving(true)
    setError('')
    try {
      const payloadSteps = steps.map((s) => {
        // フォームに出せない副条件は元の版から残す。種類を変えた段は matchBase を捨ててある。
        const match = s.matchBase ? { ...s.matchBase } : funnelMatchFor(s.kind, s.value.trim())
        if (s.matchBase) {
          const key = funnelStepPrimaryKey(s.kind)
          if (key) match[key] = s.value.trim()
        }
        return { label: s.label.trim(), kind: s.kind, match }
      })
      if (edit) {
        const res = await api.analytics.v6Funnels.createVersion(accountId, edit.funnelId, {
          name: name.trim(),
          windowDays: Number(windowDays),
          steps: payloadSteps,
          segment: versionContext.segment,
          comparisonGroups: versionContext.comparisonGroups,
          expectedVersionNumber: expectedVersion,
        })
        if (!res.success) {
          if (isConflict(res.error)) conflict.mark()
          else setError(explainSaveError(res.error, res.error))
          return
        }
        setExpectedVersion(res.data.versionNumber)
        saved.current = snapshot
        conflict.clear()
        notifySaved()
        onCreated(edit.funnelId, res.data.usageWarnings)
      } else {
        const res = await api.analytics.v6Funnels.create(accountId, { name: name.trim(), windowDays: Number(windowDays), steps: payloadSteps })
        if (!res.success) return setError(res.error)
        saved.current = snapshot
        notifySaved()
        onCreated(res.data.funnelId, res.data.usageWarnings)
      }
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && (caught.status === 409 || isConflict(caught.code))) { conflict.mark(); return }
      if (!fieldFailure)
 setError('保存に失敗しました。通信を確かめて、もう一度お試しください。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><Dialog
      open
      title={edit ? 'ファネルを直す' : 'ファネルを作る'}
      designWidth={600}
      designTop={120}
      designNode={edit ? undefined : 'VDPz5'}
      busy={saving}
      dirty={dirty}
      error={error || undefined}
      onCancel={onCancel}
      footer={(<DialogActions>
          <Button onClick={onCancel} disabled={saving}>キャンセル</Button>
          <Button variant="primary" onClick={() => void save()} busy={saving} busyLabel="保存しています…">
            {edit ? null : <Plus size={16} aria-hidden="true" />}{edit ? '新版として保存する' : '作る'}
          </Button>
        </DialogActions>)}
    >
      <div className={styles.form} ref={formRef} inert={saving}>
        {conflict.conflict ? <SaveConflictBand title="ほかの人が先にこのファネルを保存しました" compareBusy={conflict.compareBusy} onCompare={conflict.compare} onReload={conflict.reloadLatest} /> : null}
        <SaveConflictCompareDialog open={conflict.compareOpen} onCancel={conflict.closeCompare} onReload={conflict.reloadLatest} error={conflict.compareError} lines={conflict.latest ? [
          { text: `あなたの入力：${name}／${windowDays}日／${JSON.stringify(steps)}` },
          { text: `最新の内容：${conflict.latest.name}／${conflict.latest.currentVersion?.windowDays}日／${JSON.stringify(conflict.latest.currentVersion?.steps)}` },
        ] : null} />
        {presetConversion && !edit ? (
          <Notice tone="info">
            成果地点「{presetConversion.name}」を2段目に入れています。このまま段を組んで作成すると、その成果地点を使う分析として登録されます。
          </Notice>
        ) : null}
        <Field label="名前" htmlFor="fn-v8-name" error={fieldErrors['fn-v8-name']} requirement={FIELD_REQUIREMENTS.name}>
          <SaveErrorField names={["name"]}><TextField id="fn-v8-name" value={name} onChange={(e) => { setName(e.target.value); clearFieldError('fn-v8-name') }} placeholder="例：広告から購入まで" /></SaveErrorField>
        </Field>
        <div className={styles.field}>
          <span className={styles.subLabel} id="fn-v8-window-label">何日以内の通過で数えるか</span>
          <SaveErrorField names={["windowDays","window_days"]}><Select
            id="fn-v8-window"
            aria-label="何日以内の通過で数えるか"
            size="full"
            value={windowDays}
            onChange={setWindowDays}
            options={[
              ...(['7', '30', '90'].includes(windowDays) ? [] : [{ value: windowDays, label: `${windowDays}日以内` }]),
              { value: '7', label: '7日以内' },
              { value: '30', label: '30日以内' },
              { value: '90', label: '90日以内' },
            ]}
          /></SaveErrorField>
        </div>
        <div className={styles.steps} role="group" aria-label="段（上から順に見ます）">
          {steps.map((step, i) => {
            const kindHint = FUNNEL_STEP_KINDS.find((k) => k.key === step.kind)?.hint ?? ''
            return (
              <div key={i} className={styles.stepBlock}>
                <div className={styles.stepRow}>
                  <div className={styles.stepCol}>
                    <Field label={`段${i + 1}の名前`} htmlFor={`fn-v8-step-${i}`} error={fieldErrors[`fn-v8-step-${i}`]} requirement={FIELD_REQUIREMENTS.step_label}>
                      <SaveErrorField names={[`steps.${i}.label`,"label","step.label"]}><TextField id={`fn-v8-step-${i}`} value={step.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="例：友だち追加" /></SaveErrorField>
                    </Field>
                      {steps.length > MIN_STEPS ? (
                        <button type="button" className={styles.removeStep} onClick={() => { setSteps((prev) => prev.filter((_, j) => j !== i)); setFieldErrors({}) }} aria-label={`段${i + 1}を外す`}>
                          <X size={16} aria-hidden="true" />外す
                        </button>
                      ) : null}
                  </div>
                  <div className={styles.stepCol}>
                    <span className={styles.subLabel}>何をしたら</span>
                    <SaveErrorField names={["step","targets"]}><EntitySelect
                      id={`fn-v8-choice-${i}`}
                      error={fieldErrors[`fn-v8-choice-${i}`]}
                      aria-label={`${i + 1}段目で何をしたら進むか`}
                      size="full"
                      value={choiceOf(step, targets)}
                      onChange={(value) => choose(i, value)}
                      options={optionsFor(step)}
                    /></SaveErrorField>
                  </div>
                </div>
                {step.other ? (
                  <div className={styles.stepRow}>
                    <div className={styles.stepCol}>
                      <span className={styles.subLabel}>種類</span>
                      <SaveErrorField names={[`steps.${i}.kind`,"kind","step.kind"]}><Select
                        aria-label={`${i + 1}段目の種類`}
                        size="full"
                        value={step.kind}
                        onChange={(value) => update(i, { kind: value, value: '', matchBase: undefined })}
                        options={FUNNEL_STEP_KINDS.map((k) => ({ value: k.key, label: k.label }))}
                      /></SaveErrorField>
                    </div>
                    <div className={styles.stepCol}>
                      <Field label={kindHint || '追加の指定はありません'} htmlFor={`fn-v8-value-${i}`} error={fieldErrors[`fn-v8-value-${i}`]}>
                        {ENTITY_TARGETS[step.kind] ? <EntityRemoteField kind={ENTITY_TARGETS[step.kind]} label={kindHint} accountId={accountId} id={`fn-v8-value-${i}`} value={step.value} onChange={(value) => update(i, { value })} />
                          :
                        <SaveErrorField names={[`steps.${i}.value`,"value","step.value"]}><TextField id={`fn-v8-value-${i}`} value={step.value} disabled={!kindNeedsValue(step.kind)} onChange={(e) => update(i, { value: e.target.value })} /></SaveErrorField>}
                      </Field>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        <div className={styles.addRow}>
          {steps.length < MAX_STEPS ? (
            <Button onClick={() => setSteps((prev) => [...prev, { label: '', kind: 'friend_add', value: '', other: false }])}>＋ 段を足す</Button>
          ) : null}
          <span className={styles.addNote}>段は2つ以上10個まで。上から順に、次へ進んだ人を数えます。</span>
        </div>
      </div>
    </Dialog><OverlayDepthContext.Provider value={depth + 1}><UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="ファネルの変更" onConfirm={discardAndLeave} onCancel={guard.cancelLeave} busy={saving} /></OverlayDepthContext.Provider></SaveErrorScope>
  )
}
