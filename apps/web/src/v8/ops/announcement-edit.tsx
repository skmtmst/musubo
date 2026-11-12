'use client'

import { shortPublishAt, longPublishAt } from './announcement-dates'
import { SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict'
import { notifySaved } from '@/components/shared/toast'
import { Send } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ApiError, api, type OpsAnnouncement, type OpsAnnouncementAudience, type OpsAnnouncementChannel, type OpsAnnouncementInput, type OpsAudiencePreview, type OpsTenantRow } from '@/lib/api'
import { formatDateTime, opsCall, opsErrorMessage } from '@/components/ops/ops-ui'
import { describeApiFailure, isForbiddenOrRateLimited } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { CreatePage } from '@/components/templates'
import DateTimeField from '@/components/shared/date-time-field'
import Dialog from '@/components/shared/dialog'
import FilterChip from '@/components/shared/filter-chip'
import HelpTip from '@/components/shared/help-tip'
import ListState from '@/components/shared/list-state'
import Radio from '@/components/shared/radio'
import { TextArea, TextField } from '@/components/shared/text-field'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { OPS_READONLY_LOCK_REASON, useOpsReadOnlyState } from './use-ops-read-only'
import { createPageReturnHref } from '@/components/shared/create-page'
import { useFormErrors } from '@/lib/use-form-errors'
import ValidationSummary from '@/components/shared/validation-summary'
import { FieldError, Field } from '@/components/shared/form-controls'
import parts from './parts.module.css'
import styles from './announcements.module.css'
import { formatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'

/**
 * 運営のお知らせ配信 V8（作る・直す画面）。
 *
 * 一覧（/ops/announcements）の右上の［お知らせを作る］→ここ。
 * 下の帯に［下書きを保存］［今すぐ送る］（日時を入れたら［配信を予約する］）。
 * ?id= で下書き・予約の直し、?copy= で送ったものの中身を写して新しく作る。
 * 作ったら一覧に戻して作った行を光らせる。下書きの直しはその場に残り、
 * 直して送信・予約したら一覧へ戻す。送ったものを ?id= で開いたら写しに切り替える。
 * 離脱の確認はこの画面の番兵だけ（CreatePage 側は dirty={false} で止める）。
 */

const AUDIENCES: Array<{ key: OpsAnnouncementAudience; label: string }> = [
  { key: 'all', label: 'すべての契約先' },
  { key: 'plan', label: 'プラン別' },
  { key: 'tenants', label: '契約先を選ぶ' },
]
const PLANS: Array<{ key: string; label: string }> = [
  { key: 'light', label: 'ライト' }, { key: 'standard', label: 'スタンダード' }, { key: 'pro', label: 'プロ' }, { key: 'trial', label: 'トライアル' },
]
const CHANNELS: Array<{ key: OpsAnnouncementChannel; label: string }> = [
  { key: 'screen', label: '画面のお知らせ' }, { key: 'email', label: 'メール' }, { key: 'line', label: '契約者専用LINE' },
]

type Form = {
  subject: string
  body: string
  audienceKind: OpsAnnouncementAudience
  audiencePlans: string[]
  audienceTenantIds: string[]
  channels: OpsAnnouncementChannel[]
  publishAt: string
}
const EMPTY: Form = { subject: '', body: '', audienceKind: 'all', audiencePlans: [], audienceTenantIds: [], channels: ['screen', 'email'], publishAt: '' }

/** datetime-local の値（日本時間）を +09:00 付きの ISO に。空なら null。 */
function toPublishAt(local: string): string | null {
  const v = local.trim()
  if (!v) return null
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? `${v.slice(0, 16)}:00+09:00` : v
}

function toLocalInput(iso: string | null): string {
  return iso ? iso.slice(0, 16) : ''
}

function toForm(a: OpsAnnouncement): Form {
  return { subject: a.subject, body: a.body, audienceKind: a.audienceKind, audiencePlans: a.audiencePlans, audienceTenantIds: a.audienceTenantIds, channels: a.channels, publishAt: toLocalInput(a.publishAt) }
}

function previewLabel(p: OpsAudiencePreview | null, channels: OpsAnnouncementChannel[]): string {
  if (!p) return '宛先を数えています…'
  const words = [`${p.tenants} 件の契約先・${p.staff} 人の権限者`]
  if (channels.includes('line')) words.push(`うち契約者専用LINEに登録済みの${p.lineLinked} 人へ届きます`)
  if (channels.includes('email')) words.push(`メールは${p.withEmail} 人に届きます`)
  return words.join('。')
}

function confirmAudience(form: Form, preview: OpsAudiencePreview | null): string {
  const base = form.audienceKind === 'all'
    ? 'すべての契約先'
    : form.audienceKind === 'plan'
      ? `${form.audiencePlans.map((key) => PLANS.find((p) => p.key === key)?.label ?? key).join('・')}の契約先`
      : '選んだ契約先'
  return preview ? `${base} ${preview.tenants} 社` : `${base}（数えています…）`
}

function confirmChannels(form: Form, preview: OpsAudiencePreview | null): string {
  if (!preview) return '数えています…'
  return form.channels.map((key) => {
    if (key === 'screen') return `画面 ${preview.tenants}`
    if (key === 'email') return `メール ${preview.withEmail}`
    const unlinked = Math.max(preview.staff - preview.lineLinked, 0)
    return `LINE ${preview.lineLinked}（LINE 未登録 ${unlinked}）`
  }).join('・')
}

function loadDescription(err: unknown): string | undefined {
  if (isForbiddenOrRateLimited(err)) return undefined
  if (err instanceof TypeError) return '通信できませんでした。ネットワークを確認してもう一度お試しください'
  return describeApiFailure(err, '読み込み', { scope: 'hq' })
}

export default function OpsAnnouncementEditV8() {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  // 読み直しから使う移動の口。描画ごとの参照に縛られないよう ref 越しに呼ぶ。
  const routerRef = useRef(router)
  routerRef.current = router
  const params = useSearchParams()
  const editId = params.get('id')
  const copyId = params.get('copy')
  const routeKey = JSON.stringify([editId, copyId])
  const routeContext = useRef({ key: routeKey, generation: 0 })
  if (routeContext.current.key !== routeKey) routeContext.current = { key: routeKey, generation: routeContext.current.generation + 1 }
  const sendContext = useRef<{ generation: number; form: string; id: string | null } | null>(null)
  const deleteContext = useRef<{ generation: number; id: string } | null>(null)
  useEffect(() => { setConfirmSend(false); setDeleting(false) }, [routeKey])

  const [source, setSource] = useState<OpsAnnouncement | null>(null)
  const [sourceLoaded, setSourceLoaded] = useState(false)
  const [loadedRouteKey, setLoadedRouteKey] = useState<string | null>(null)
  const [sourceError, setSourceError] = useState<unknown>(null)
  const [sourceMissing, setSourceMissing] = useState(false)
  const [lineConfigured, setLineConfigured] = useState(true)
  const [tenants, setTenants] = useState<OpsTenantRow[]>([])
  const [form, setForm] = useState<Form>(EMPTY)
  const [editingId, setEditingId] = useState<string | null>(null)
  // 作る欄の再実行キー。二重押し・通信再送でも1件だけ作る。
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID())
  // 直し始めたときの版。違う版からの保存は最新の内容つきで409になる。
  const [editingUpdatedAt, setEditingUpdatedAt] = useState<string | null>(null)
  const [preview, setPreview] = useState<OpsAudiencePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmSend, setConfirmSend] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [baseline, setBaseline] = useState<Form>(EMPTY)
  const access = useOpsReadOnlyState()
  const readOnly = access !== 'writer'
  const unknown = access === 'unknown'

  const loadSource = useCallback(async () => {
    const wanted = editId ?? copyId
    const generation = routeContext.current.generation
    if (!wanted) { setSource(null); setEditingId(null); setEditingUpdatedAt(null); setForm(EMPTY); setBaseline(EMPTY); setNotice(''); setSourceMissing(false); setSourceError(null); setLoadedRouteKey(routeKey); setSourceLoaded(true); return }
    setSourceError(null)
    setSourceMissing(false)
    setSourceLoaded(false)
    let switched = false
    try {
      const res = await api.ops.announcements.list()
      if (routeContext.current.generation !== generation) return
      if (!res.success) { setSourceError(new Error(res.error || '読み込めませんでした')); return }
      setLineConfigured(res.noticeLineConfigured)
      const found = res.data.find((row) => row.id === wanted) ?? null
      if (!found) { setSourceMissing(true); return }
      setSource(found)
      // 送ったもの・送信中のものを ?id= で開いたら、写しに切り替える（直しは下書き・予約だけ）。
      // 切替中は読み込み中のままにし、空の作る欄をちらつかせない。
      if (editId && found.status !== 'draft' && found.status !== 'scheduled') {
        switched = true
        routerRef.current.replace(`/ops/announcements/new?copy=${encodeURIComponent(found.id)}`)
        return
      }
      const next = toForm(found)
      if (editId) {
        setEditingId(found.id)
        setEditingUpdatedAt(found.updatedAt)
        setBaseline(next)
        setForm(next)
      } else {
        setEditingId(null)
        setEditingUpdatedAt(null)
        setNotice('送ったお知らせの中身を写しました。直して送ると、新しいお知らせになります')
        setBaseline(EMPTY)
        setForm({ ...next, publishAt: '' })
      }
    } catch (caught) {
      if (routeContext.current.generation !== generation) return
      const fieldFailure = saveErrors.capture(caught)
      { if (!fieldFailure)
      setSourceError(caught) }
    } finally {
      if (!switched && routeContext.current.generation === generation) { setLoadedRouteKey(routeKey); setSourceLoaded(true) }
    }
  }, [editId, copyId, routeKey, saveErrors])

  useEffect(() => { void loadSource() }, [loadSource])

  // 直し・写しが無い作る画面でも、LINE の設定の有無だけ読む。
  useEffect(() => {
    if (editId ?? copyId) return
    void opsCall(api.ops.announcements.list()).then((res) => { if (res.success) setLineConfigured(res.noticeLineConfigured) })
  }, [editId, copyId])

  useEffect(() => {
    if (form.audienceKind !== 'tenants' || tenants.length > 0) return
    void opsCall(api.ops.tenants()).then((res) => { if (res.success) setTenants(res.data.filter((t) => t.status !== 'archived')) })
  }, [form.audienceKind, tenants.length])

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    void opsCall(api.ops.announcements.preview({ audienceKind: form.audienceKind, audiencePlans: form.audiencePlans, audienceTenantIds: form.audienceTenantIds })).then((res) => {
      if (!cancelled && res.success) setPreview(res.data)
    })
    return () => { cancelled = true }
  }, [form.audienceKind, form.audiencePlans, form.audienceTenantIds])

  const toggle = <T extends string>(list: T[], key: T): T[] => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key])

  /* 欄に結び付く誤りは欄で知らせて1つ目へ移る。上の帯は LINE の設定だけ。 */
  const fields = useFormErrors()
  fields.define('subject', '件名', () => (form.subject.trim() ? null : '件名を入力してください'), { required: true })
  fields.define('body', '本文', () => (form.body.trim() ? null : '本文を入力してください'), { required: true })
  fields.define('audience', '宛先', () => (
    form.audienceKind === 'plan' && form.audiencePlans.length === 0 ? 'プランを 1 つ以上選んでください'
      : form.audienceKind === 'tenants' && form.audienceTenantIds.length === 0 ? '契約先を 1 つ以上選んでください'
        : null
  ), { required: form.audienceKind !== 'all' })
  fields.define('channels', '送り方', () => (form.channels.length === 0 ? '送り方を 1 つ以上選んでください' : null), { required: true })
  const describedBy = (key: string) => (fields.invalid(key) ? `ann-${key}-error` : undefined)

  const validation = useMemo(() => {
    if (form.channels.includes('line') && !lineConfigured) return '契約者専用LINEのアカウントが未設定です。メンバー管理の「運営の情報」で指定してください'
    return ''
  }, [form, lineConfigured])

  const input = (mode: OpsAnnouncementInput['mode']): OpsAnnouncementInput => ({
    subject: form.subject.trim(), body: form.body.trim(), audienceKind: form.audienceKind,
    audiencePlans: form.audiencePlans, audienceTenantIds: form.audienceTenantIds, channels: form.channels,
    publishAt: toPublishAt(form.publishAt), mode,
  })

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(baseline), [form, baseline])
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy, onDiscard: () => { setForm(baseline) } })

  const collision = useSaveConflict<OpsAnnouncement>({
    contextKey: editingId ?? 'new',
    fetchLatest: async () => {
      const response = await api.ops.announcements.list()
      return response.success ? response.data.find(row => row.id === editingId) ?? null : null
    },
    reload: async () => {
      const response = await api.ops.announcements.list()
      if (!response.success) throw new Error('読み込めませんでした')
      const latest = response.data.find(row => row.id === editingId)
      if (!latest) throw new Error('お知らせが見つかりませんでした')
      const next = toForm(latest)
      setEditingUpdatedAt(latest.updatedAt)
      setBaseline(next)
      setForm(next)
      collision.clear()
    },
  })

  const submit = async (mode: OpsAnnouncementInput['mode']) => {
    if (readOnly) return
    if (mode !== 'draft' && (!sendContext.current || sendContext.current.generation !== routeContext.current.generation || sendContext.current.form !== JSON.stringify(form) || sendContext.current.id !== editingId || (editId !== null && editId !== editingId))) return
    if (fields.submit().length > 0) { setFormError(''); setConfirmSend(false); return }
    if (validation) { setFormError(validation); setConfirmSend(false); return }
    setBusy(true)
    setFormError('')
    try {
      const res = editingId
        ? await api.ops.announcements.update(editingId, input(mode), editingUpdatedAt ?? undefined)
        : await api.ops.announcements.create(input(mode), createKey)
      if (!res.success) { setFormError('保存できませんでした。時間をおいて、もう一度お試しください。'); return }
      setConfirmSend(false)
      notifySaved(mode === 'draft' ? '下書きとして保存しました' : mode === 'schedule' ? `${formatDateTime(res.data.publishAt)} に配信を予約しました` : `送りました（${formatNumber(res.data.recipientsTotal)}人。LINE ${res.data.lineSent}・メール ${res.data.mailSent}）`)
      collision.clear()
      if (editingId && mode === 'draft') {
        // 下書きの直しはその場に残る。送信・予約したら一覧へ戻して行を光らせる。
        setBaseline(form)
        setEditingUpdatedAt(res.data.updatedAt)
      } else {
        router.push(createPageReturnHref('/ops/announcements', res.data.id))
      }
    } catch (error) {
      const fieldFailure = saveErrors.capture(error);

      if (error instanceof ApiError && error.status === 409) {
        if (error.code === 'IDEMPOTENCY_CONFLICT') {
          { if (!fieldFailure)
          setFormError('同じ再実行キーが別の内容に使われています。作り直してください。') }
          setCreateKey(crypto.randomUUID())
          return
        }
        // 版の違いだけを競合として扱う。配信済みの変更・送信の準備の失敗は文を出す。
        if (error.code === 'VERSION_CONFLICT') {
          collision.mark()
          setConfirmSend(false)
          { if (!fieldFailure)
          setFormError('') }
          return
        }
        { if (!fieldFailure)
        setFormError(opsErrorMessage(error)) }
        setConfirmSend(false)
        // 下書きは通っている場合がある（送信の準備の失敗）。版を読み直し、次が自分の保存と競合しないようにする。
        if (editingId) {
          void opsCall(api.ops.announcements.list()).then((res) => {
            if (!res.success) return
            const latest = res.data.find((row) => row.id === editingId)
            if (latest) { setSource(latest); setEditingUpdatedAt(latest.updatedAt) }
          })
        }
        return
      }
      { if (!fieldFailure)
      setFormError(error instanceof ApiError ? opsErrorMessage(error) : '保存できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (readOnly || !editingId || !deleteContext.current || deleteContext.current.generation !== routeContext.current.generation || deleteContext.current.id !== editingId || editId !== editingId) return
    setBusy(true)
    const res = await opsCall(api.ops.announcements.remove(editingId))
    setBusy(false)
    if (!res.success) { setFormError(res.error || '消せませんでした'); return }
    setDeleting(false)
    router.push('/ops/announcements')
  }

  const scheduled = form.publishAt.trim().length > 0
  // 下書き・予約だけ消せる。送信済みの写し・新規には削除を出さない。
  const deletable = editingId !== null && (source?.status === 'draft' || source?.status === 'scheduled')
  const lock = access === 'readonly' ? OPS_READONLY_LOCK_REASON : undefined

  if (!sourceLoaded || loadedRouteKey !== routeKey) return <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />
  if (sourceMissing) {
    return (
      <ListState permissionScope="hq" kind="error"
        title="お知らせが見つかりませんでした"
        description="一覧から選び直してください。"
        action={<Button href="/ops/announcements">一覧へ戻る</Button>} />
    )
  }
  if (sourceError) {
    return (
      <ListState permissionScope="hq" kind="error"
        title="お知らせを表示できませんでした"
        description={loadDescription(sourceError)}
        error={sourceError ?? undefined}
        onRetry={() => void loadSource()} />
    )
  }

  if ((editId || copyId) && source?.id !== (editId ?? copyId)) return <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />

  return (
    <SaveErrorScope errors={saveErrors}>
      <CreatePage
        title={editingId ? 'お知らせを直す' : 'お知らせを作る'}
        help="契約先へ、画面のお知らせ・メール・契約者専用LINE でお知らせを送ります。"
        contentDisabled={readOnly || busy}
        contentLabel="お知らせの入力"
        dirty={false}
        busy={busy}
        footerActions={<>
          <Button href="/ops/announcements">キャンセル</Button>
          <Button variant="secondary" lockedReason={lock} disabled={busy || unknown} busy={Boolean(busy)} busyLabel="処理中…" onClick={() => void submit('draft')}>下書きを保存する</Button>
          <Button variant="primary" lockedReason={lock} disabled={busy || unknown} onClick={() => { setFormError(''); if (fields.submit().length === 0) { sendContext.current = { generation: routeContext.current.generation, form: JSON.stringify(form), id: editingId }; setConfirmSend(true) } }}>
            <Send aria-hidden="true" />{scheduled ? '配信を予約する' : '今すぐ送る'}
          </Button>
        </>}
        destructive={deletable ? <Button variant="danger" lockedReason={lock} disabled={busy || unknown} onClick={() => { if (editingId && editId === editingId) { deleteContext.current = { generation: routeContext.current.generation, id: editingId }; setDeleting(true) } }}>削除する</Button> : null}
      >
        <div className={styles.formPage}>
          {notice ? <p role="status" className={`${parts.status} ${styles.notice}`}>{notice}</p> : null}
          {collision.conflict ? <SaveConflictBand title="ほかの人が先にお知らせを保存しました" compareBusy={collision.compareBusy} onCompare={collision.compare} onReload={collision.reloadLatest} /> : null}
          <SaveConflictCompareDialog open={collision.compareOpen} busy={collision.compareBusy} error={collision.compareError} onCancel={collision.closeCompare} onReload={collision.reloadLatest}
            lines={collision.latest ? [
              { text: `件名：入力 ${form.subject} ／ 最新 ${collision.latest.subject}` },
              { text: `本文：入力 ${form.body} ／ 最新 ${collision.latest.body}` },
              { text: `公開時刻：入力 ${form.publishAt || 'すぐに'} ／ 最新 ${toLocalInput(collision.latest.publishAt) || 'すぐに'}` },
            ] : null} />
          {formError && !confirmSend ? <Notice tone="danger" className={parts.alertNoticePlacement} >{formError}</Notice> : null}
          <ValidationSummary problems={fields.listProblems()} onFocusFirst={fields.focusFirst} minProblems={2} />
          <div className={styles.field}><Field label="件名" htmlFor="ann-subject" requirement={fields.requirement('subject')}><SaveErrorField names={["subject","form.subject"]}><TextField {...fields.bind('subject')} id="ann-subject" invalid={fields.invalid('subject')} aria-describedby={describedBy('subject')} value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="例：9月20日 深夜のメンテナンスのお知らせ" maxLength={120} disabled={busy} /></SaveErrorField>
<FieldError id="ann-subject-error">{fields.error('subject')}</FieldError></Field></div>
          <div className={styles.field}><Field label="本文" htmlFor="ann-body" requirement={fields.requirement('body')}><SaveErrorField names={["body","form.body"]}><TextArea {...fields.bind('body')} id="ann-body" invalid={fields.invalid('body')} aria-describedby={describedBy('body')} rows={4} className={styles.body} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} placeholder="お客様各位　いつも musubo をご利用いただきありがとうございます。…" maxLength={4000} disabled={busy} /></SaveErrorField>
<FieldError id="ann-body-error">{fields.error('body')}</FieldError></Field></div>
          <fieldset className={styles.field} {...fields.bind('audience')} aria-invalid={fields.invalid('audience') || undefined} aria-describedby={describedBy('audience')}>
            <legend className={`${styles.smallLabel} ${styles.legend}`}>
              宛先
              <HelpTip label="宛先の見込み">{previewLabel(preview, form.channels)}</HelpTip>
            </legend>
            <div className={styles.choices}>
              {AUDIENCES.map((a) => (
                <SaveErrorField names={["announcement-audience","key","a.key","audienceKind","form.audienceKind","form"]} key={a.key}><Radio key={a.key} name="announcement-audience" value={a.key} checked={form.audienceKind === a.key} disabled={busy} onChange={() => setForm((f) => ({ ...f, audienceKind: a.key }))}>{a.label}</Radio></SaveErrorField>
              ))}
            </div>
            {form.audienceKind === 'plan' ? (
              <div className={styles.chips}>
                {PLANS.map((p) => <FilterChip key={p.key} selected={form.audiencePlans.includes(p.key)} onChange={() => setForm((f) => ({ ...f, audiencePlans: toggle(f.audiencePlans, p.key) }))}>{p.label}</FilterChip>)}
              </div>
            ) : null}
            {form.audienceKind === 'tenants' ? (
              <div className={`${styles.chips} ${styles.tenantChips}`}>
                {tenants.length === 0
                  ? <span className={parts.note}>契約先を読み込んでいます…</span>
                  : tenants.map((t) => <FilterChip key={t.id} selected={form.audienceTenantIds.includes(t.id)} onChange={() => setForm((f) => ({ ...f, audienceTenantIds: toggle(f.audienceTenantIds, t.id) }))}>{t.name}</FilterChip>)}
              </div>
            ) : null}
            <FieldError id="ann-audience-error">{fields.error('audience')}</FieldError>
          </fieldset>
          <fieldset className={styles.field} {...fields.bind('channels')} aria-invalid={fields.invalid('channels') || undefined} aria-describedby={describedBy('channels')}>
            <legend className={`${styles.smallLabel} ${styles.legend}`}>送り方</legend>
            <div className={styles.choices}>
              {CHANNELS.map((ch, saveFieldIndex) => <SaveErrorField names={[`CHANNELS.${saveFieldIndex}.key`,"key","ch.key","form"]} key={ch.key}><Checkbox key={ch.key} checked={form.channels.includes(ch.key)} disabled={busy} onCheckedChange={() => setForm((f) => ({ ...f, channels: toggle(f.channels, ch.key) }))}>{ch.label}</Checkbox></SaveErrorField>)}
            </div>
            <FieldError id="ann-channels-error">{fields.error('channels')}</FieldError>
          </fieldset>
          {sourceLoaded && !lineConfigured ? (
            <Notice tone="warn">
              契約者専用LINE のアカウントが未設定です。メンバー管理の「運営の情報」で指定すると LINE で送れます。
            </Notice>
          ) : null}
          <div className={styles.field}>
            <span className={styles.label}>
              配信日時（日本時間）
              <HelpTip label="配信日時の説明">空のままなら、押したときにすぐ送ります。日時を入れると「配信を予約する」に変わります。</HelpTip>
            </span>
            <div className={styles.dateTime}>
            <SaveErrorField names={["publishAt","form.publishAt","publish_at","form.publish_at"]}><DateTimeField value={form.publishAt} onChange={(v) => setForm((f) => ({ ...f, publishAt: v }))} aria-label="公開日時（日本時間）" placeholder="空のままならすぐに送る" disabled={busy} /></SaveErrorField>
            </div>
          </div>
        </div>
      </CreatePage>

      <Dialog
        open={confirmSend}
        designWidth={600}
        designTop={220}
        title="このお知らせを送りますか？"
        cancelLabel="戻って直す"
        confirmLabel={scheduled ? `${shortPublishAt(form.publishAt)} に送る` : '今すぐ送る'}
        confirmIcon={<Send size={16} aria-hidden="true" />}
        busy={busy}
        error={formError || undefined}
        designNode="TJUUl"
        onConfirm={() => submit(scheduled ? 'schedule' : 'send')}
        onCancel={() => { if (!busy) setConfirmSend(false) }}
      >
        <div className={parts.dialogBody}>
          <OperationTargetSummary accounts={[{ id: '', name: '不明' }]} externalTarget={{ label: 'お知らせ 1件', name: form.subject.trim() || null }} />
          <dl className={styles.facts}>
            <div className={styles.fact}><dt>宛先</dt><dd>{confirmAudience(form, preview)}</dd></div>
            <div className={styles.fact}><dt>届く方法</dt><dd>{confirmChannels(form, preview)}</dd></div>
            <div className={styles.fact}><dt>送る日時</dt><dd>{scheduled ? `${longPublishAt(form.publishAt)}（予約）` : '今すぐ'}</dd></div>
          </dl>
          <div className={styles.letter}>
            <p className={styles.letterSubject}>{`件名：${form.subject.trim() || emptyValue('unconfigured')}`}</p>
            <p className={styles.letterBody}>{form.body.trim().length > 80 ? `${form.body.trim().slice(0, 80)}…` : form.body.trim() || '（本文が未入力です）'}</p>
          </div>
          <p className={styles.after}>送ったあとは本文を直せません。画面のお知らせは取り下げられます（メール・LINE は取り消せません）。</p>
        </div>
      </Dialog>
      <ConfirmDialog
        open={deleting}
        title={source && editingId ? `「${source.subject}」を削除しますか？` : ''}
        description="下書き・予約を消します。配信済みのものは消せません。"
        confirmLabel="削除する"
        destructive
        busy={busy}
        error={formError}
        onConfirm={() => remove()}
        onCancel={() => { if (!busy) setDeleting(false) }}
      ><OperationTargetSummary accounts={[{ id: '', name: '不明' }]} externalTarget={{ label: 'お知らせ 1件', name: source?.subject }} /></ConfirmDialog>
      <UnsavedLeaveDialog open={leaveTarget !== null} onConfirm={confirmLeave} onCancel={cancelLeave} />
    </SaveErrorScope>
  )
}
