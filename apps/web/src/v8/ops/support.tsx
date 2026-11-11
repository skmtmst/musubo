'use client'
import { CardHeader } from '@/components/shared/card'
import TruncatedText from '@/components/shared/truncated-text'
import { PRIORITY_FILTER, SORT_OPTIONS } from './support-list-options'

import { useListUrlValue } from '@/components/shared/list-url-state'
import { notifySaved } from '@/components/shared/toast'
import { Building2, ChevronLeft, FileText, LogIn, Paperclip, Plus, Send } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type OpsSupportDetail, type OpsSupportPriority, type OpsSupportStage, type OpsSupportSummary, type OpsSupportTicket, type OpsTenantRow } from '@/lib/api'
import { tenantDetailHref, opsCall, formatDateTime } from '@/components/ops/ops-ui'
import { elapsedLabel } from '@/v8/ops/support/format'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { ListToolbarRow } from '@/components/shared/list-toolbar'
import ListState from '@/components/shared/list-state'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { TextArea, TextField } from '@/components/shared/text-field'
import { OpsHead } from './shell'
import OpsSupportStats from './support-stats'
import { PageFrame } from '@/components/templates/page-frame'
import { OPS_READONLY_LOCK_REASON, useOpsReadOnlyState } from './use-ops-read-only'
import { useFormErrors } from '@/lib/use-form-errors'
import { FieldError, Field } from '@/components/shared/form-controls'
import parts from './parts.module.css'
import styles from './support.module.css'
import { formatDate as polishFormatDate } from '@/lib/format'
import TextLink from '@/components/shared/text-link'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import Notice from '@/components/shared/notice'
import SupportTemplatePicker from '@/components/shared/reply-template-picker'
import { RowMenu } from '@/components/shared/row-actions'
import StickyBar from '@/components/shared/sticky-bar'

/**
 * 運営のお問い合わせ。確定した Pen の一覧・返信・テンプレート引用に対応する。
 *
 * 動きは 管理画面（app/ops/support）と同じ口：一覧（段階・優先度・並び・検索）、内容と返信、
 * テンプレート引用、下書きの保存、返信の前の確認、
 * 解決・クローズ・対応中に戻す、チケット作成、`?id=` で1件を開く。
 * 閲覧のみの運営メンバーには、起票・返信・段階の変更を出さない（読むだけ）。
 */

const STAGE_CHIPS: Array<{ key: OpsSupportStage | 'all'; label: string }> = [
  { key: 'all', label: 'すべて' },
  { key: 'new', label: '新規' },
  { key: 'in_progress', label: '対応中' },
  { key: 'waiting', label: '確認待ち' },
  { key: 'resolved', label: '解決' },
  { key: 'closed', label: 'クローズ' },
]

const STAGE_TONE: Record<OpsSupportStage, StatusBadgeTone> = {
  new: 'danger', in_progress: 'info', waiting: 'warning', resolved: 'success', closed: 'neutral',
}

function stageLabel(stage: OpsSupportStage, fallback: string): string {
  if (stage === 'waiting') return '確認待ち'
  if (stage === 'resolved') return '解決'
  return fallback
}
const PRIORITY_OPTIONS = [
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' },
]
const KIND_OPTIONS = [
  { value: 'usage', label: '使い方について' },
  { value: 'bug', label: '不具合' },
  { value: 'billing', label: '料金・請求' },
  { value: 'feature', label: '要望' },
  { value: 'other', label: 'その他' },
]

/** 「9/30 11:00」の形。 */
function shortDateTime(value: string | null): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

/** WEB218：チケットを1回に読む件数。 */
const TICKET_PAGE = 50

export default function OpsSupportV8() {
  const access = useOpsReadOnlyState()
  const lock = access === 'readonly' ? OPS_READONLY_LOCK_REASON : undefined
  const unknown = access === 'unknown'
  const [summary, setSummary] = useState<OpsSupportSummary | null>(null)
  const [tickets, setTickets] = useState<OpsSupportTicket[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [stage, setStage] = useState<OpsSupportStage | 'all'>('all')
  const [priority, setPriority] = useState<'' | OpsSupportPriority>('')
  const [sort, setSort] = useListUrlValue<'newest' | 'oldest' | 'priority'>('sort', 'priority')
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<OpsSupportDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [creating, setCreating] = useState(false)
  const [tenants, setTenants] = useState<OpsTenantRow[]>([])
  const [form, setForm] = useState({ tenantId: '', subject: '', body: '', kind: 'usage', priority: 'medium' as OpsSupportPriority })
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState('')
  const [mobile, setMobile] = useState(false)
  const [replyStage, setReplyStage] = useState<OpsSupportStage>('new')
  const [draftSaving, setDraftSaving] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [stageOpen, setStageOpen] = useState(false)
  const replyRef = useRef<HTMLTextAreaElement>(null)
  const insertAt = useRef(0)
  const replyCaretKnown = useRef(false)
  const detailRequest = useRef(0)
  const listRequest = useRef(0)
  const deepLink = useRef<string | null>(null)
  const [listFailed, setListFailed] = useState(false)
  const [detailFailed, setDetailFailed] = useState(false)
  const [confirmReply, setConfirmReply] = useState(false)
  const [createError, setCreateError] = useState('')

  useEffect(() => {
    deepLink.current = new URLSearchParams(window.location.search).get('id')
    if (deepLink.current) setSelectedId(deepLink.current)
    return () => { detailRequest.current += 1; listRequest.current += 1 }
  }, [])

  useEffect(() => {
    document.body.toggleAttribute('data-ops-support-detail', Boolean(selectedId))
    return () => document.body.removeAttribute('data-ops-support-detail')
  }, [selectedId])

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 640px)')
    if (!query) return
    const update = () => setMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  const loadSummary = useCallback(async () => {
    const res = await opsCall(api.ops.support.summary())
    if (res.success) setSummary(res.data)
  }, [])

  /*
   * WEB218：チケットは50件ずつ読む。50件ちょうど返ったときは続きがあるかもしれないので、
   * 「続きを読み込む」で足す（絞り込みや直接のリンクでしか51件目へ行けない、をなくす）。
   */
  const [mayHaveMore, setMayHaveMore] = useState(false)
  const [moreBusy, setMoreBusy] = useState(false)
  const loadMore = async () => {
    if (moreBusy) return
    const sequence = listRequest.current
    setMoreBusy(true)
    const res = await opsCall(api.ops.support.tickets({ stage, priority: priority || undefined, q: q.trim() || undefined, sort, limit: TICKET_PAGE, offset: tickets.length }))
    setMoreBusy(false)
    if (sequence !== listRequest.current) return
    if (!res.success) { setError(res.error || '続きを読み込めませんでした'); return }
    setTickets((current) => [...current, ...res.data.filter((item) => !current.some((known) => known.id === item.id))])
    if (typeof res.total === 'number') setTotal(res.total)
    setMayHaveMore(res.data.length >= TICKET_PAGE)
  }

  const loadList = useCallback(async () => {
    const sequence = ++listRequest.current
    setLoading(true)
    setListFailed(false)
    const res = await opsCall(api.ops.support.tickets({ stage, priority: priority || undefined, q: q.trim() || undefined, sort, limit: TICKET_PAGE }))
    if (sequence !== listRequest.current) return
    setLoading(false)
    if (!res.success) { setError(res.error || '読み込めませんでした'); setListFailed(true); return }
    setTickets(res.data)
    setTotal(typeof res.total === 'number' ? res.total : null)
    setMayHaveMore(res.data.length >= TICKET_PAGE)
    setSelectedId((current) => deepLink.current || (current && res.data.some((t) => t.id === current) ? current : res.data[0]?.id ?? null))
  }, [stage, priority, q, sort])

  /*
   * WEB219：同じチケットを読み直すとき（優先度を変えたあとなど）は、書きかけの返信を
   * サーバーの下書きで置き換えない。返信の欄を入れ直すのは、チケットを開いたときだけ。
   */
  const loadDetail = useCallback(async (id: string, options?: { keepReply?: boolean }) => {
    const sequence = ++detailRequest.current
    setDetailLoading(true)
    setDetailFailed(false)
    const res = await opsCall(api.ops.support.ticket(id))
    if (sequence !== detailRequest.current) return
    setDetailLoading(false)
    if (!res.success) { setError(res.error || '内容を読み込めませんでした'); setDetailFailed(true); return }
    setDetail(res.data)
    if (options?.keepReply) return
    setReplyStage(res.data.ticket.stage)
    replyCaretKnown.current = false
    setReply(res.data.draft?.body ?? '')
  }, [])

  useEffect(() => { void loadSummary() }, [loadSummary])
  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => {
    setReply(''); setTemplateOpen(false); setStageOpen(false)
    detailRequest.current += 1
    setDetail(null)
    if (!selectedId) return
    void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  useEffect(() => {
    if (!creating || tenants.length > 0) return
    void opsCall(api.ops.tenants()).then((res) => { if (res.success) setTenants(res.data.filter((t) => t.status !== 'archived')) })
  }, [creating, tenants.length])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadSummary(), loadList()])
    if (selectedId) await loadDetail(selectedId)
  }, [loadSummary, loadList, loadDetail, selectedId])

  const changeStage = async (next: OpsSupportStage) => {
    if (!detail || access !== 'writer') return
    setBusy(true)
    setError('')
    const res = await opsCall(api.ops.support.update(detail.ticket.id, { stage: next }))
    setBusy(false)
    if (!res.success) { setError(res.error || '変更できませんでした。時間をおいて、もう一度お試しください。'); return }
    setNotice(`${res.data.ticketLabel} を「${res.data.stageLabel}」にしました`)
    deepLink.current = res.data.id
    setStage(next)
    await Promise.all([loadSummary(), loadDetail(res.data.id)])
  }

  const changePriority = async (next: OpsSupportPriority) => {
    if (!detail || access !== 'writer') return
    const res = await opsCall(api.ops.support.update(detail.ticket.id, { priority: next }))
    if (!res.success) { setError(res.error || '変更できませんでした。時間をおいて、もう一度お試しください。'); return }
    await Promise.all([loadSummary(), loadList()])
    if (selectedId) await loadDetail(selectedId, { keepReply: true })
  }

  const saveDraft = async () => {
    if (!detail || access !== 'writer') return
    setDraftSaving(true)
    setError('')
    const res = await opsCall(api.ops.support.saveDraft(detail.ticket.id, reply))
    setDraftSaving(false)
    if (!res.success) { setError(res.error || '下書きを保存できませんでした。時間をおいて、もう一度お試しください。'); return }
    notifySaved(res.data ? '下書きを保存しました' : '下書きを消しました')
  }

  const clearDraftFromConfirm = async () => {
    if (!detail || busy || access !== 'writer') return
    setBusy(true)
    const res = await opsCall(api.ops.support.deleteDraft(detail.ticket.id))
    setBusy(false)
    if (!res.success) { setError(res.error || '下書きを消せませんでした'); return }
    setReply('')
    setConfirmReply(false)
  }

  const send = async () => {
    if (!detail || !reply.trim() || access !== 'writer') return
    setBusy(true)
    setError('')
    // WEB217：送信時に選んだ状態へ進める。既定は開いたときの状態。
    const res = await opsCall(api.ops.support.reply(detail.ticket.id, { body: reply, nextStage: replyStage }))
    setBusy(false)
    if (!res.success) { setError(res.error || '返信できませんでした。時間をおいて、もう一度お試しください。'); return }
    setReply('')
    setConfirmReply(false)
    setNotice(res.data.mailSent
      ? `${res.data.ticket.ticketLabel} に返信しました。登録メールにも送りました`
      : res.data.mailSkippedReason === 'no_email'
        ? `${res.data.ticket.ticketLabel} に返信しました。起票者のメールが未登録のため、管理画面の履歴だけに載ります`
        : `${res.data.ticket.ticketLabel} に返信しました。メールは送れなかったので、管理画面の履歴で伝わります`)
    await refreshAll()
  }

  /* 起票の窓で落ちた欄は、その欄の真下に理由を出して移る。 */
  const createFields = useFormErrors()
  createFields.define('tenant', '契約先', () => (form.tenantId ? null : '契約先を選んでください'), { required: true })
  createFields.define('subject', '件名', () => (form.subject.trim() ? null : '件名を入れてください'), { required: true })
  createFields.define('body', '内容', () => (form.body.trim() ? null : '内容を入れてください'), { required: true })

  const create = async () => {
    if (busy || access !== 'writer') return
    if (createFields.submit().length > 0) { setCreateError(''); return }
    setBusy(true)
    setCreateError('')
    const res = await opsCall(api.ops.support.create({ tenantId: form.tenantId, subject: form.subject.trim(), body: form.body.trim(), kind: form.kind, priority: form.priority }))
    setBusy(false)
    if (!res.success) { setCreateError(res.error || '作れませんでした'); return }
    setCreating(false)
    setForm({ tenantId: '', subject: '', body: '', kind: 'usage', priority: 'medium' })
    setNotice(`${res.data.ticketLabel} を作りました`)
    setStage('new')
    setSelectedId(res.data.id)
    await refreshAll()
  }
  const ticket = detail?.ticket ?? null
  const closed = ticket?.stage === 'closed'
  const pick = (id: string) => { deepLink.current = null; setSelectedId(id) }
  const openTemplates = () => { insertAt.current = replyCaretKnown.current ? replyRef.current?.selectionStart ?? insertAt.current : reply.length; setTemplateOpen(true) }
  const insertTemplate = (body: string): boolean => {
    const point = Math.min(insertAt.current, reply.length)
    const before = reply.slice(0, point)
    const after = reply.slice(point)
    const leading = point === reply.length && before && !before.endsWith('\n') && !body.startsWith('\n') ? '\n\n' : ''
    const trailing = point === 0 && after && !after.startsWith('\n') && !body.endsWith('\n') ? '\n\n' : ''
    const next = `${before}${leading}${body}${trailing}${after}`
    if (next.length > 4000) return false
    setReply(next)
    const nextPoint = before.length + leading.length + body.length
    insertAt.current = nextPoint
    replyCaretKnown.current = true
    requestAnimationFrame(() => { replyRef.current?.focus(); replyRef.current?.setSelectionRange(nextPoint, nextPoint) })
    return true
  }
  const proxyMenuItems = ticket ? [{ id: 'proxy-login', label: '代理ログイン', icon: <LogIn aria-hidden="true" />, disabled: busy || unknown, lockedReason: lock, onSelect: () => { if (access === 'writer') void impersonate(ticket.tenantId, setBusy, setError) } }] : []

  return (
    <PageFrame kind="list" boardId="P0jhqO" standalone skeleton>
      <div className={selectedId ? styles.overviewSelected : styles.overview}>
      <OpsHead
        title="お問い合わせ"
        description="チケットを選び、返信や状態の変更を行います。"
        band={(
          <div className={styles.band}>
          <OpsSupportStats summary={summary} loading={loading && summary === null} />
          </div>
        )}
        actions={(
          <Button variant="secondary" className={styles.createAction} lockedReason={lock} disabled={unknown} onClick={() => { setCreateError(''); createFields.reset(); setCreating(true) }}><Plus aria-hidden="true" />チケット作成</Button>
        )}
      />
      </div>
      {notice ? <p role="status" className={`${parts.status} ${styles.notice}`}>{notice}</p> : null}
      {error && !listFailed && !detailFailed ? <Notice tone="danger" >{error}</Notice> : null}

      <div data-ops-support-detail={selectedId ? '' : undefined} className={`${styles.columns} ${selectedId ? styles.columnsSelected : ''}`}>
        <section aria-label="チケットの一覧" className={styles.list}>
          <SearchField value={q} onChange={setQ} onClear={() => setQ('')} placeholder="チケットを探す" aria-label="チケットを探す" />
          <ListToolbarRow>
            <Select aria-label="状態で絞る" label="状態" options={STAGE_CHIPS.map(c => ({ value: c.key, label: c.label, description: summary ? `${summary.byStage[c.key]}件` : undefined }))} value={stage} onChange={value => setStage(value as typeof stage)} size="page-size" />
            <SaveErrorField names={["priority"]}><Select aria-label="優先度で絞る" options={PRIORITY_FILTER} value={priority} onChange={value => setPriority(value as '' | OpsSupportPriority)} size="page-size" /></SaveErrorField>
            <SaveErrorField names={["sort"]}><Select aria-label="並び替え" options={SORT_OPTIONS} value={sort} onChange={value => setSort(value as typeof sort)} size="page-size" /></SaveErrorField>
          </ListToolbarRow>
          {loading && tickets.length === 0 ? (
            <ListState permissionScope="hq" kind="loading" title="チケットを読み込んでいます" />
          ) : listFailed && tickets.length === 0 ? (
            <ListState permissionScope="hq" kind="error" title="チケットを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。" onRetry={() => void loadList()} />
          ) : tickets.length === 0 ? (
            <ListState permissionScope="hq" kind="empty" title="チケットがありません" description="統括の管理画面「お問い合わせ」から送られると、ここに新規として並びます。" />
          ) : (
            <ul className={styles.tickets} title={total === null ? undefined : `${total}件中 ${tickets.length === 0 ? 0 : 1}〜${tickets.length}件を表示`}>
              {tickets.map((t) => (
                <li key={t.id}>
                  <button type="button" aria-current={t.id === selectedId ? 'true' : undefined} onClick={() => pick(t.id)} className={`${styles.ticket} ${t.id === selectedId ? styles.ticketSelected : ''}`}>
                    <span className={styles.ticketTop}>
                      <span className={styles.ticketNo}>{t.ticketLabel}</span>
                      <span className={styles.badges}><StatusBadge tone={STAGE_TONE[t.stage]}>{stageLabel(t.stage, t.stageLabel)}</StatusBadge><span className={styles[`priority${t.priority}`]}>{t.priorityLabel}</span></span>
                    </span>
                    <span className={styles.ticketSubject}>{t.subject}</span>
                    <span className={styles.ticketMeta} title={`${t.staffName || emptyValue('unknown')}・${t.channelLabel}・最終のやり取り ${formatDateTime(t.lastMessageAt)}（${elapsedLabel(t.lastMessageAt)}）`}>{t.tenantName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {mayHaveMore && !loading ? (
            <Button onClick={() => void loadMore()} disabled={moreBusy} busy={moreBusy}>続きを読み込む</Button>
          ) : null}
        </section>

        <section aria-label="内容と返信" className={styles.detail}>
          {!ticket ? (
            detailLoading ? <ListState permissionScope="hq" kind="loading" title="内容を読み込んでいます" /> : detailFailed ? (
              <ListState permissionScope="hq" kind="error" title="内容を読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。" onRetry={selectedId ? () => void loadDetail(selectedId) : undefined} />
            ) : <ListState permissionScope="hq" kind="empty" title="チケットを選んでください" description="左の一覧から開きます。" />
          ) : (
            <>
              <div className={styles.mobileTop}><Button variant="text" textTone="ink" className={styles.mobileBack} onClick={() => setSelectedId(null)}><ChevronLeft aria-hidden="true" />お問い合わせ</Button><RowMenu label="その他の操作" appearance="outlined" className={styles.outlinedMore} items={proxyMenuItems} /></div>
              <div className={styles.detailTitleRow}><CardHeader size="content" title={<TruncatedText value={`${ticket.ticketLabel} ${ticket.subject}`} />} /></div>
              <div className={styles.detailControls}>
                <div className={styles.statusWrap}><Button variant="text" data-stage={ticket.stage} className={styles.statusButton} aria-label="状態を変更" aria-expanded={stageOpen} disabled={busy || unknown || access !== 'writer'} title={lock} onClick={() => setStageOpen((value) => !value)}><StatusBadge tone={STAGE_TONE[ticket.stage]}>{stageLabel(ticket.stage, ticket.stageLabel)}</StatusBadge><span aria-hidden="true">⌄</span></Button>
                  {stageOpen ? <div className={styles.actionMenu}>{(ticket.stage === 'resolved' || ticket.stage === 'closed' ? [{ value: 'in_progress' as const, label: '対応中に戻す' }] : [{ value: 'resolved' as const, label: '解決する' }, { value: 'closed' as const, label: 'クローズする' }]).map((item) => <Button variant="text" textTone="ink" key={item.value} onClick={() => { setStageOpen(false); void changeStage(item.value) }}>{item.label}</Button>)}</div> : null}
                </div>
                <span className={styles.prioritySelect}>
                  <SaveErrorField names={["priority","ticket.priority"]}><Select size="page-size" aria-label="優先度を変える" lockedReason={lock} disabled={unknown} value={ticket.priority} onChange={(value) => void changePriority(value as OpsSupportPriority)} options={PRIORITY_OPTIONS} /></SaveErrorField>
                </span>
                <Button variant="text" textTone="quiet" className={styles.contractLink} href={tenantDetailHref(ticket.tenantId)}><Building2 aria-hidden="true" />契約先を開く</Button>
                <div className={styles.moreWrap}><RowMenu label="その他の操作" appearance="outlined" className={styles.outlinedMore} items={proxyMenuItems} /></div>
              </div>
              <ol className={styles.messages} aria-label="やり取り">
                <Message mine={false} at={ticket.createdAt} author={`${ticket.staffName || ticket.tenantName}（${shortDateTime(ticket.createdAt)}）`} body={ticket.body} attachments={ticket.attachments} />
                {detail?.messages.map((m) => (
                  <Message
                    key={m.id}
                    mine={m.authorKind === 'ops'}
                    at={m.createdAt}
                    author={`${m.authorKind === 'ops' ? `運営 ${m.authorName}` : m.authorName}（${shortDateTime(m.createdAt)}）`}
                    body={m.body}
                    attachments={m.attachments}
                  />
                ))}
              </ol>

              {(
                <>
                  <div className={styles.draft}>
                    <div className={styles.replyHeading}><strong>返信</strong><Button variant="text" textTone="quiet" lockedReason={lock} disabled={busy || unknown || closed} onClick={openTemplates}><FileText aria-hidden="true" />テンプレート引用</Button></div>
                    <SaveErrorField names={["reply","body"]}><TextArea
                      ref={replyRef}
                      className={styles.replyBox}
                      rows={10}
                      value={reply}
                      onChange={(e) => { setReply(e.target.value); insertAt.current = e.currentTarget.selectionStart; replyCaretKnown.current = true }}
                      onSelect={(e) => { insertAt.current = e.currentTarget.selectionStart; replyCaretKnown.current = true }}
                      placeholder={mobile ? '返信文を入力してください。' : '返信文を入力してください。引用した内容はここで編集できます。'}
                      aria-label="返信"
                      disabled={closed || access !== 'writer'}
                      maxLength={4000}
                    /></SaveErrorField>
                  </div>
                  <StickyBar presentation="support-reply" actions={<>
                    <Button variant="text" textTone="quiet" lockedReason={lock} onClick={() => saveDraft()} disabled={busy || unknown || draftSaving || closed} busy={draftSaving}>下書き保存</Button>
                    <SaveErrorField names={["replyStage","nextStage","reply_stage"]}><Select aria-label="送信後の状態" label="送信後" size="content" lockedReason={lock} value={replyStage} onChange={value => setReplyStage(value as OpsSupportStage)} disabled={busy || unknown || closed} options={STAGE_CHIPS.filter(item => item.key !== 'all').map(item => ({ value: item.key, label: item.label }))} /></SaveErrorField>
                    <span className={styles.sendSurface}><Button variant={busy || unknown || closed || !reply.trim() ? 'secondary' : 'primary'} fullWidth lockedReason={lock} onClick={() => { setError(''); setConfirmReply(true) }} disabled={busy || unknown || closed || !reply.trim()}><Send aria-hidden="true" />返信する</Button></span>
                  </>} />
                </>
              )}
            </>
          )}
        </section>
      </div>

      <Dialog
        open={creating}
        designWidth={560}
        designTop={160}
        title="チケット作成"
        confirmLabel="作成する"
        cancelLabel="キャンセル"
        confirmIcon={<Plus size={16} aria-hidden="true" />}
        busy={busy}
        error={createError || undefined}
        designNode="Izau1"
        onConfirm={() => create()}
        onCancel={() => { if (!busy) setCreating(false) }}
      >
        <div className={parts.dialogBody}>
          <div className={styles.field}>
            <span className={styles.smallLabel}>契約先</span>
            <div className={styles.fullSelect} {...createFields.bind('tenant')}>
              <SaveErrorField names={["tenantId","form.tenantId","tenant_id","form.tenant_id"]}><EntitySelect size="full" aria-label="契約先" error={createFields.error('tenant') ?? undefined} value={form.tenantId} onChange={(value) => setForm((f) => ({ ...f, tenantId: value }))} options={[{ value: '', label: '契約先を選ぶ' }, ...tenants.map((t) => ({ ...entityOptionMetadata(t), value: t.id, label: t.name }))]} /></SaveErrorField>
            </div>
            <FieldError id="sup-tenant-error">{createFields.error('tenant')}</FieldError>
          </div>
          <div className={styles.pair}>
            <div className={styles.field}>
              <span className={styles.smallLabel}>種類</span>
              <div className={styles.fullSelect}>
                <SaveErrorField names={["kind","form.kind"]}><Select size="full" aria-label="種類" value={form.kind} onChange={(value) => setForm((f) => ({ ...f, kind: value }))} options={KIND_OPTIONS} /></SaveErrorField>
              </div>
            </div>
            <div className={styles.field}>
              <span className={styles.smallLabel}>優先度</span>
              <div className={styles.fullSelect}>
                <SaveErrorField names={["priority","form.priority"]}><Select size="full" aria-label="優先度" value={form.priority} onChange={(value) => setForm((f) => ({ ...f, priority: value as OpsSupportPriority }))} options={PRIORITY_OPTIONS} /></SaveErrorField>
              </div>
            </div>
          </div>
          <div className={styles.field}><Field label="件名" htmlFor="sup-subject" requirement={createFields.requirement('subject')}><SaveErrorField names={["subject","form.subject"]}><TextField {...createFields.bind('subject')} id="sup-subject" invalid={createFields.invalid('subject')} aria-describedby={createFields.invalid('subject') ? 'sup-subject-error' : undefined} value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="例：電話で受けた配信の相談" maxLength={120} aria-label="件名" /></SaveErrorField>
<FieldError id="sup-subject-error">{createFields.error('subject')}</FieldError></Field></div>
          <div className={styles.field}><Field label="内容" htmlFor="sup-body" requirement={createFields.requirement('body')}><SaveErrorField names={["body","form.body"]}><TextArea {...createFields.bind('body')} id="sup-body" invalid={createFields.invalid('body')} aria-describedby={createFields.invalid('body') ? 'sup-body-error' : undefined} className={styles.createBody} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} placeholder="相手から聞いた内容をそのまま書きます" maxLength={4000} aria-label="内容" /></SaveErrorField>
<FieldError id="sup-body-error">{createFields.error('body')}</FieldError></Field></div>
          <Notice tone="info">電話や LINE で受けた相談をチケットとして登録します。相手にはメールは届きません。</Notice>
        </div>
      </Dialog>

      {ticket ? (
        <Dialog
          open={confirmReply}
          title="この返事を送りますか？"
          busy={busy}
          error={error || undefined}
          designNode="GgP2d"
          /* 絵 ：幅 600・窓の上 202（本文の長さで上下しない）。 */
          designWidth={600}
          designTop={202}
          onCancel={() => { if (!busy) setConfirmReply(false) }}
          footer={(
            <DialogActions leadingAction={<Button variant="danger" onClick={() => clearDraftFromConfirm()} disabled={busy} busy={Boolean(busy)} busyLabel="処理中…">下書きを削除</Button>}>
              <Button onClick={() => { if (!busy) setConfirmReply(false) }} disabled={busy}>戻って直す</Button>
              <Button variant="primary" onClick={() => send()} disabled={busy} busy={busy} busyLabel="送信中…"><Send aria-hidden="true" />送信する</Button>
            </DialogActions>
          )}
        >
          <div className={parts.dialogBody}>
            <OperationTargetSummary accounts={[]} />
            <dl className={styles.facts}>
              <div className={styles.fact}><dt>宛先</dt><dd>{`${ticket.tenantName}（担当：${ticket.staffName || emptyValue('unknown')}）・${ticket.channelLabel}`}</dd></div>
              <div className={styles.fact}><dt>状態</dt><dd>{`${ticket.stageLabel} → ${STAGE_CHIPS.find(item => item.key === replyStage)?.label ?? replyStage}（送ったあと）`}</dd></div>
              <div className={styles.fact}><dt>優先度</dt><dd>{ticket.priorityLabel}</dd></div>
            </dl>
            <p className={styles.confirmBody}>{reply}</p>
          </div>
        </Dialog>
      ) : null}
      <SupportTemplatePicker open={templateOpen} onClose={() => setTemplateOpen(false)} onInsert={insertTemplate} writable={access === 'writer'} />
    </PageFrame>
  )
}

async function impersonate(tenantId: string, setBusy: (v: boolean) => void, setError: (v: string) => void) {
  setBusy(true)
  const res = await opsCall(api.ops.impersonation.start(tenantId))
  setBusy(false)
  if (!res.success) { setError(res.error || '代理ログインを始められませんでした'); return }
  window.location.assign('/hq')
}

function Message({ mine, author, body, attachments, at }: { mine: boolean; author: string; body: string; at: string; attachments: Array<{ key: string; url: string; name: string }> }) {
  return (
    <li className={`${styles.message} ${mine ? styles.messageMine : ''}`}>
      <span className={styles.messageAuthor} title={formatDateTime(at)}>{author}</span>
      <p className={styles.messageBody}>{body}</p>
      {attachments.length > 0 ? (
        <span className={styles.attachments}>
          {attachments.map((a) => (
            <TextLink external key={a.key} href={a.url}   className={parts.textLink}>
              <Paperclip aria-hidden="true" />{`${a.name}（${mine ? '運営から' : '契約先から'}）`}
            </TextLink>
          ))}
        </span>
      ) : null}
    </li>
  )
}
