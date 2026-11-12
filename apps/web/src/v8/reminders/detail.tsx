'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'

import { JST_LOCAL, dateTimeLocalJst } from './detail-dates'
export { dateTimeLocalJst } from './detail-dates'
import { scheduledJstIso } from '@/lib/jst-datetime';
import SharedStatusPill from '@/components/shared/status-pill'
import { useListUrlValue } from '@/components/shared/list-url-state';
import { useFeatureAccess } from '@/lib/use-feature-access';
import { useSamePageUrl } from '@/lib/use-same-page-url';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, Check, Copy, Download, Pause, Pencil, Play, RotateCcw, Trash2, X } from 'lucide-react';
import Link from '@/components/shared/list-navigation'

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { ChevronLeft, CircleAlert } from 'lucide-react';
import { describeReminderTiming, type Reminder, type ReminderStep } from '@line-crm/shared';
import { api, ApiError, type ReminderDeliveryRun, type ReminderDeliveryRunsResponse, type ReminderDeliveryRunStatus, type ReminderRegistrant } from '@/lib/api';
import { useAccount } from '@/contexts/account-context';
import { useStaffRole, canManageRole } from '@/lib/staff-role';
import { formatDateTime, formatNumber, formatDate as polishFormatDate } from '@/lib/format';
import { csvCell } from '@/lib/presentation';
import { usePageTitle } from '@/components/shell/page-chrome';
import { PageFrame, PageHeading, PageContent } from '@/components/templates/page-frame';
import { PageExplanationBody, PageExplanationProvider, PageExplanationToggle } from '@/components/shared/page-explanation';
import { CreateSummaryCard } from '@/components/templates/create-parts';
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import { TableHeadRow } from '@/components/shared/table';
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table';
import { ListToolbarFrame, ListToolbarRow, ListToolbarEnd, ListToolbarSearchSlot } from '@/components/shared/list-toolbar';
import TruncatedText from '@/components/shared/truncated-text';
import { DetailColumns } from '@/components/templates/detail-columns';
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import DateTimeField from '@/components/shared/date-time-field'
import SegmentedControl from '@/components/shared/segmented'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview';
import ListState from '@/components/shared/list-state'
import TargetMissing from '@/components/shared/target-missing'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import { Tabs } from '@/components/shared/tabs';
import PageSizeSelect from '@/components/shared/page-size-select'
import { reminderTriggerLabel, reminderStopSummary } from '@/components/reminders/reminder-labels'
import { fillPreviewSample } from '@/components/shared/preview-sample'
import SheetDialog from './sheet-dialog'
import styles from './detail.module.css'
import { csvFileName } from '@/lib/csv-file-name';
import { emptyValue } from '@/components/shared/empty-value';
import { DetailLoading } from '@/components/templates/detail-page';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';

const PAGE_SIZE = 20
/** 書き出しの上限。実行結果が多いとき、手元に全部ため込むと固まる。 */
const EXPORT_LIMIT = 5000
/** 配信予定を一度に取る件数。予定は近い順に返る。 */
const PLANNED_LIMIT = 100
const DAY_MS = 86_400_000

const STATUS_VIEW: Record<ReminderDeliveryRunStatus, { label: string; tone: 'ok' | 'warn' | 'muted' }> = {
  planned: { label: '配信予定', tone: 'muted' },
  claimed: { label: '送信処理中', tone: 'muted' },
  succeeded: { label: '送れた', tone: 'ok' },
  skipped: { label: '送信なし', tone: 'muted' },
  retry_wait: { label: '再試行待ち', tone: 'warn' },
  permanent_failed: { label: '失敗', tone: 'warn' },
  cancelled: { label: '取り消し', tone: 'muted' },
}

export type DetailTab = 'overview' | 'schedule' | 'runs' | 'registrants'

/** URL の ?tab=（今の画面と同じ名前）。 */
export function tabFromParam(value: string | null): DetailTab {
  if (value === 'schedule' || value === 'runs' || value === 'registrants') return value
  return 'overview'
}

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土']
const JST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
})

function jstParts(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = Object.fromEntries(JST_PARTS.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const weekday = WEEKDAYS_JA[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)] ?? ''
  return { year: parts.year, month: Number(parts.month), day: Number(parts.day), time: `${parts.hour}:${parts.minute}`, weekday }
}

/** 「10/1（水）18:00」（日本時間）。 */
function formatMd(value: string | null): string {
  const p = jstParts(value)
  return p ? `${p.month}/${p.day}（${p.weekday}）${p.time}` : emptyValue('unknown')
}

/** 「9/30 18:00」（日本時間）。 */
function formatShort(value: string | null): string {
  const p = jstParts(value)
  return p ? `${p.month}/${p.day} ${p.time}` : emptyValue('unknown')
}

/** 「9月28日」（日本時間）。 */
function formatMonthDay(value: string | null): string {
  const p = jstParts(value)
  return p ? `${p.month}月${p.day}日` : ''
}

function formatJst(value: string | null): string {
  return polishFormatDate(value, { style: 'detail', fallback: '—' })
}

/** datetime-local の JST の壁時計時刻を、曖昧さなく UTC ISO へ変える。 */
export function dateTimeLocalJstToUtcIso(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value)
  return match ? scheduledJstIso(match[1], match[2]) : null
}

/** 通知の短い呼び名。日で書いた通は「1日前 18:00」、分で書いた通は「1時間前」。 */
function stepTiming(step: ReminderDeliveryRunsResponse['steps'][number], detail: ReminderStep | undefined, mode: Reminder['deliveryMode']): string {
  if (detail && mode === 'time' && detail.offsetDays != null && detail.sendAtTime) {
    const days = detail.offsetDays
    return `${days === 0 ? '当日' : days < 0 ? `${-days}日前` : `${days}日後`} ${detail.sendAtTime}`
  }
  return describeReminderTiming({ offsetMinutes: step.offsetMinutes }, 'countdown').replace('ゴールちょうど', '基準時刻')
}

/** 通知の本文を、番号だけでなく人が見分けられる短い名前にする。 */
function stepLabel(step: ReminderDeliveryRunsResponse['steps'][number]): string {
  const firstLine = step.messageContent.trim().split(/\r?\n/, 1)[0]?.trim()
  return firstLine ? firstLine.slice(0, 40) : `${step.stepNumber} 通目`
}

function csvFor(items: ReminderDeliveryRun[]): string {
  const rows = [
    ['友だち', '通知', '結果', '配信予定', '実行時刻', '試行回数', '次の再試行', 'LINE要求ID', '理由'],
    ...items.map((item) => [
      item.friendName ?? '削除済みの友だち',
      `${item.stepNumber} 通目`,
      STATUS_VIEW[item.domainStatus].label,
      formatJst(item.scheduledAt),
      formatJst(item.completedAt ?? item.startedAt),
      item.attemptCount,
      formatJst(item.nextRetryAt),
      item.lineRequestId ?? emptyValue('unknown'),
      item.lastErrorMessage ?? '',
    ]),
  ]
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\n')}`
}

function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: ReactNode }) {
  return (
    <SharedStatusPill tone={tone === 'ok' ? 'success' : tone === 'warn' ? 'warning' : 'neutral'}>{children}</SharedStatusPill>
  )
}

export default function ReminderDetailV8Page() {
  // useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。
  return (
    <Suspense fallback={<DetailLoading />}>
      <ReminderDetailV8 />
    </Suspense>
  )
}

function ReminderDetailV8() {
  const saveErrors = useSaveFormErrors()

  const router = useRouter()
  const samePageUrl = useSamePageUrl()
  const searchParams = useSearchParams()
  const reminderId = searchParams.get('id') ?? ''
  const tab = tabFromParam(searchParams.get('tab'))
  const runsStatusParam = searchParams.get('runStatus')
  const { selectedAccount, selectedAccountId } = useAccount()
  const pauseContext = useRef({ accountId: selectedAccountId, reminderId, generation: 0 })
  if (pauseContext.current.accountId !== selectedAccountId || pauseContext.current.reminderId !== reminderId) pauseContext.current = { accountId: selectedAccountId, reminderId, generation: pauseContext.current.generation + 1 }
  const pauseRef = useRef<{ generation: number } | null>(null)
  const openedPause = pauseRef.current
  const loadSequence = useRef(0)
  const staffRole = useStaffRole()
  const featureAccess = useFeatureAccess('reminders')
  const canManage = featureAccess

  const [asideExpanded, setAsideExpanded] = useState(false)
  const [data, setData] = useState<ReminderDeliveryRunsResponse | null>(null)
  const [reminder, setReminder] = useState<(Reminder & { steps?: ReminderStep[] }) | null>(null)
  const [planned, setPlanned] = useState<ReminderDeliveryRun[]>([])
  const [plannedTotal, setPlannedTotal] = useState(0)
  const [plannedLoaded, setPlannedLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  /** 404・空で見つからないとき。取得の失敗（error）とは分ける。 */
  const [missing, setMissing] = useState(false)
  const [actionMessage, setActionMessage] = useState('')
  const [exporting, setExporting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteScope = JSON.stringify([selectedAccountId, reminderId])
  const [confirmedDeleteScope, setConfirmedDeleteScope] = useState('')
  const [confirmedDeleteGeneration, setConfirmedDeleteGeneration] = useState(-1)
  useEffect(() => { setConfirmDelete(false); setConfirmedDeleteScope('') }, [deleteScope])
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [duplicating, setDuplicating] = useState(false)
  const [confirmPause, setConfirmPause] = useState(false)
  const [pausing, setPausing] = useState(false)

  usePageTitle(data?.reminder.id === reminderId && data.reminder.name ? `${data.reminder.name}・リマインダ` : null)

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    const generation = pauseContext.current.generation
    const current = () => sequence === loadSequence.current && generation === pauseContext.current.generation
    // id なしで帰ると「読み込んでいます」が永遠に出る。先に止めて文面を出す。
    if (!reminderId) {
      setLoading(false)
      setError('')
      setMissing(false)
      return
    }
    setLoading(true)
    setError('')
    setMissing(false)
    // 読み直しに失敗したとき、前に取れた数字を現在値として残さない。
    setData(null)
    setReminder(null)
    try {
      const [runsRes, reminderRes] = await Promise.all([
        api.reminders.runs(reminderId, { limit: 5, offset: 0 }),
        api.reminders.get(reminderId),
      ])
      if (!current()) return
      if (!runsRes.success) throw new Error(runsRes.error)
      if (runsRes.data.reminder.id !== reminderId || (reminderRes.success && reminderRes.data.id !== reminderId)) throw new Error('reminder id mismatch')
      setData(runsRes.data)
      if (reminderRes.success) setReminder(reminderRes.data)
    } catch (caught) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 404) {
        setMissing(true)
      } else {
        { if (!fieldFailure)

        setError('リマインダの詳細を読み込めませんでした。時間を置いてもう一度お試しください。') }
      }
    } finally {
      if (current()) setLoading(false)
    }
  }, [reminderId, saveErrors])

  useEffect(() => {
    void load()
    return () => { loadSequence.current += 1 }
  }, [load, selectedAccountId])

  /*
   * 「次に送る」（通知ごとの最早の予定）と、一時停止の窓の「今後24時間で送る予定」は
   * 配信予定（status=planned）から数える。
   */
  useEffect(() => {
    setPlanned([])
    setPlannedTotal(0)
    setPlannedLoaded(false)
    if (!reminderId) return
    let cancelled = false
    void api.reminders.runs(reminderId, { status: 'planned', limit: PLANNED_LIMIT }).then((res) => {
      if (cancelled || !res.success || res.data.reminder.id !== reminderId) return
      setPlanned(res.data.items)
      setPlannedTotal(res.data.pagination.total)
      setPlannedLoaded(true)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [reminderId, selectedAccountId])

  const selectTab = (next: DetailTab) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('id', reminderId)
    params.set('tab', next)
    if (next !== 'runs') params.delete('runStatus')
    samePageUrl.replace(`/reminders/detail?${params.toString()}`)
  }

  /* ===== 状態を変える操作 ===== */

  // 公開版の無い下書きは「停止中」ではなく「下書き」。再開は公開の経路に統一し、この画面からは出さない。
  const isUnpublishedDraft = data ? !data.reminder.hasPublishedVersion : false

  const setReminderActive = async (isActive: boolean): Promise<boolean> => {
    if (!data || data.reminder.id !== reminderId || pauseContext.current.reminderId !== reminderId) return false
    if (data.reminder.isActive === isActive) return true
    const generation = pauseContext.current.generation
    setActionMessage('')
    try {
      const response = await api.reminders.update(reminderId, { isActive })
      if (generation !== pauseContext.current.generation) return false
      if (!response.success) throw new Error(response.error)
      setData((current) => current?.reminder.id === reminderId ? { ...current, reminder: { ...current.reminder, isActive } } : current)
      setActionMessage(isActive ? 'リマインダを再開しました。' : 'リマインダを一時停止しました。')
      return true
    } catch (caught) {
      if (generation !== pauseContext.current.generation) return false
      const fieldFailure = saveErrors.capture(caught)
      // API も未公開の再開を 409 で止める。その文面をそのまま出す。
      { if (!fieldFailure)
      setActionMessage(caught instanceof ApiError && caught.status === 409
        ? describeApiFailure(caught, '状態の変更')
        : isActive
          ? '再開できませんでした。状態を読み直してからお試しください。'
          : '一時停止できませんでした。状態を読み直してからお試しください。') }
      return false
    }
  }

  const runPause = async () => {
    if (pausing || !openedPause || pauseRef.current !== openedPause || openedPause.generation !== pauseContext.current.generation) return
    setPausing(true)
    const ok = await setReminderActive(false)
    setPausing(false)
    if (ok) { pauseRef.current = null; setConfirmPause(false) }
  }

  const exportCsv = async () => {
    if (exporting) return
    setExporting(true)
    setActionMessage('')
    try {
      const all: ReminderDeliveryRun[] = []
      let offset = 0
      let total = 0
      for (;;) {
        const response = await api.reminders.runs(reminderId, { limit: 100, offset })
        if (!response.success) throw new Error(response.error)
        total = response.data.pagination.total
        for (const item of response.data.items) {
          if (all.length >= EXPORT_LIMIT) break
          all.push(item)
        }
        offset += response.data.items.length
        if (all.length >= EXPORT_LIMIT || offset >= total || response.data.items.length === 0) break
      }
      if (total > EXPORT_LIMIT) {
        setActionMessage(`件数が多いため、全${formatNumber(total)} 件のうち${formatNumber(EXPORT_LIMIT)} 件まで書き出しました。`)
      }
      const url = URL.createObjectURL(new Blob([csvFor(all)], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = csvFileName("リマインダの実行履歴")
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionMessage('CSVを書き出せませんでした。もう一度お試しください。') }
    } finally {
      setExporting(false)
    }
  }

  /* ===== 複製（下書きとして写す。一覧と同じ手順） ===== */

  const runDuplicate = async () => {
    if (duplicating) return
    setDuplicating(true)
    setActionMessage('')
    try {
      const draft = await api.reminders.getDraft(reminderId)
      if (!draft.success) throw new Error(draft.error)
      const res = await api.reminders.createDraft({
        ...draft.data.settings,
        name: `${data?.reminder.name ?? 'リマインダ'} のコピー`,
      })
      if (!res.success) throw new Error(res.error)
      router.push(`/reminders/edit?id=${encodeURIComponent(String(res.data.reminderId))}&stage=target`)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setActionMessage('複製できませんでした。通信を確かめて、もう一度お試しください。') }
    } finally {
      setDuplicating(false)
    }
  }

  /* ===== 削除 ===== */

  const runDelete = async () => {
    if (deleting || data?.reminder.id !== reminderId || confirmedDeleteScope !== deleteScope || confirmedDeleteGeneration !== pauseContext.current.generation) return
    setDeleting(true)
    setDeleteError('')
    try {
      const res = await api.reminders.delete(reminderId)
      if (!res.success) throw new Error(res.error)
      router.push('/reminders')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setDeleteError('削除できませんでした。時間を置いてもう一度お試しください。') }
      setDeleting(false)
    }
  }

  // 閲覧のみの人には、押せない操作を置かない（書き出しだけ残す）。
  const menuItems: ActionMenuItem[] = [
    {
      id: 'csv',
      label: '実行結果をCSVで書き出す',
      icon: <Download size={16} aria-hidden="true" />,
      disabled: exporting || loading,
      onSelect: () => void exportCsv(),
    },
    ...(canManage ? [
      {
        id: 'duplicate',
        label: '複製する',
        icon: <Copy size={16} aria-hidden="true" />,
        disabled: duplicating,
        onSelect: () => void runDuplicate(),
      },
      {
        id: 'delete',
        label: '削除する',
        icon: <Trash2 size={16} aria-hidden="true" />,
        tone: 'danger' as const,
        dividerBefore: true,
        onSelect: () => { setConfirmedDeleteScope(deleteScope); setConfirmedDeleteGeneration(pauseContext.current.generation); setConfirmDelete(true) },
      },
    ] : []),
  ]

  const nextByStep = useMemo(() => {
    const next: Record<number, string> = {}
    for (const item of planned) {
      if (item.domainStatus !== 'planned' && item.domainStatus !== 'claimed' && item.domainStatus !== 'retry_wait') continue
      const at = item.domainStatus === 'retry_wait' ? item.nextRetryAt : item.scheduledAt
      if (!at) continue
      const current = next[item.stepNumber]
      if (!current || at < current) next[item.stepNumber] = at
    }
    return next
  }, [planned])

  // 一時停止の窓：今後24時間で送る予定の数（取れた予定の中で数える。取り切れていなければ「以上」）。
  const pauseImpact = useMemo(() => {
    const now = Date.now()
    const within = planned.filter((item) => {
      const at = Date.parse(item.scheduledAt ?? '')
      return Number.isFinite(at) && at >= now && at <= now + DAY_MS
    }).length
    /*
     * WEB084：予定は新しい順で最大100件しか読めない。読めていない予定があるときは、
     * 近い予定が抜けていることがあるので、数を言い切らない（0 と言わない）。
     * 近い順・件数の集計は口に頼んでいる（Codex）。
     */
    const truncated = plannedTotal > planned.length
    return { count: within, truncated }
  }, [planned, plannedTotal])
  const plannedPartial = plannedTotal > planned.length

  if (!reminderId) {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing kind="unspecified" title="リマインダが指定されていません" description="一覧から選び直してください。" backHref="/reminders" backLabel="リマインダ一覧へ戻る" /></SaveErrorScope>
    )
  }
  if (loading || (data && data.reminder.id !== reminderId)) return <SaveErrorScope errors={saveErrors}><DetailLoading label="リマインダの詳細を読み込んでいます" /></SaveErrorScope>
  if (missing) {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing kind="not-found" title="このリマインダは見つかりません" description="削除されたか、別の記録です。一覧から選び直してください。" backHref="/reminders" backLabel="リマインダ一覧へ戻る" /></SaveErrorScope>
    )
  }
  if (error || !data) {
    return <SaveErrorScope errors={saveErrors}><TargetMissing kind="error" title="リマインダを読み込めませんでした" description={error || '詳細を読み込めませんでした。'} onRetry={() => void load()} /></SaveErrorScope>
  }

  const hasErrors = data.summary.errors > 0
  const firstStep = data.steps[0] ?? null
  const statusLabel = !data.reminder.hasPublishedVersion ? '下書き' : (reminder?.followupManagement?reminder.followupManagement.effectiveSendingStatus==='active':data.reminder.isActive) ? '有効' : '停止中'
  const nextTime = jstParts(data.summary.nextScheduledAt)?.time ?? ''
  const accountName = selectedAccount?.name ?? 'LINE公式アカウント'
  const meta = [
    reminder?.triggerType ? `基準日：${reminderTriggerLabel(reminder.triggerType)}` : null,
    `通知 ${data.steps.length} 通`,
    reminder?.updatedAt ? `更新 ${formatMonthDay(reminder.updatedAt)}` : null,
  ].filter(Boolean).join('・')

  return (
    <SaveErrorScope errors={saveErrors}><PageExplanationProvider pageKey="reminders:registrants"><PageFrame kind="detail" boardId={tab === 'registrants' ? 'loVfW' : 'rbAig'}>
      <PageHeading title={data.reminder.name}
        help="登録した友だちごとに、基準日から決めた日時に通知を送ります。"
        explanationToggle={tab === 'registrants' ? <PageExplanationToggle /> : undefined}
        crumbs={<><p>{meta}</p></>}
        tabs={<><Tabs
          label="リマインダの詳細"
          items={[
            { label: '概要', current: tab === 'overview', onClick: () => selectTab('overview') },
            { label: '配信予定', current: tab === 'schedule', onClick: () => selectTab('schedule') },
            { label: '実行結果', current: tab === 'runs', onClick: () => selectTab('runs') },
            { label: '登録者', current: tab === 'registrants', onClick: () => selectTab('registrants') },
          ]}
        /></>} />


      <PageContent><DetailColumns presentation="notification" toggleLabel={asideExpanded ? 'いまの状態と操作を閉じる' : 'いまの状態と操作を開く'} asideLabel="いまの状態と操作" expanded={asideExpanded} onExpandedChange={setAsideExpanded} aside={<>
          <div className={styles.sideActions}>
            {canManage && !isUnpublishedDraft ? (
              data.reminder.isActive ? (
                <Button className={styles.sideAction} onClick={() => { pauseRef.current = { generation: pauseContext.current.generation }; setConfirmPause(true) }}>
                  <Pause size={16} aria-hidden="true" />一時停止する
                </Button>
              ) : (
                <Button className={styles.sideAction} onClick={() => setReminderActive(true)} busyLabel="処理中…">
                  <Play size={16} aria-hidden="true" />再開する
                </Button>
              )
            ) : null}
            {canManage ? (
              <Button className={styles.sideAction} onClick={() => router.push(`/reminders/edit?id=${encodeURIComponent(reminderId)}`)}>
                <Pencil size={16} aria-hidden="true" />
                {isUnpublishedDraft ? '編集を続ける' : '編集する'}
              </Button>
            ) : null}
            <span className={styles.menuAnchor}>
              <RowMenu
                className={styles.menuButton}
                label={`リマインダ「${data.reminder.name}」のその他の操作`}
                title="その他の操作"
                items={menuItems}
              />
            </span>
          </div>

          <CreateSummaryCard
            title="いまの状態"
            rows={[
              { key: 'state', label: '状態', value: <span className={styles.valueState} title={reminderStopSummary(data.reminder.stopConditions)} data-tone={statusLabel === '有効' ? 'ok' : undefined}>{statusLabel}</span> },
              { key: 'registrants', label: '登録者', value: `${formatNumber(data.summary.targetCount)}人` },
              { key: 'next7', label: 'これから送る（今後7日）', value: `${formatNumber(data.summary.scheduledNext7Days ?? 0)}通` },
              { key: 'month', label: '今月送った', value: `${formatNumber(data.summary.sentThisMonth ?? 0)}通` },
              { key: 'errors', label: '失敗', value: <span className={hasErrors ? styles.valueDanger : undefined}>{`${formatNumber(data.summary.errors)}通`}</span> },
            ]}
          />

          {tab === 'registrants' ? null : (
            <div className={styles.phoneWrap}>
            <LinePreview
              accountName={accountName}
              caption={data.summary.nextScheduledAt ? formatMd(data.summary.nextScheduledAt) : '次の送信予定はありません'}
              note={firstStep?.messageContent.trim() ? '届き方：次に送る通知が、友だちのLINEにこう届きます。差し込みは見本の値です。' : undefined}
              empty={!firstStep}
            >
              {firstStep ? (
                <LinePreviewMessage accountName={accountName} avatar={accountName.slice(0, 1)} time={nextTime}>
                  {fillPreviewSample(firstStep.messageContent || '本文はまだありません').text}
                </LinePreviewMessage>
              ) : null}
            </LinePreview>
            </div>
          )}
        </>}>
        <div className={styles.main}>
          {reminder?.followupManagement?<Notice tone={reminder.followupManagement.effectiveSendingStatus==='active'?'info':'warn'} action={<Button href={reminder.followupManagement.path}>来店フォローを見る →</Button>}>来店フォロー（{reminder.followupManagement.storeName}）で管理しています。{reminder.followupManagement.reason??'承認された内容で送っています。'}</Notice>:null}
          {actionMessage ? <Notice tone="info">{actionMessage}</Notice> : null}
          {tab === 'overview' ? (
            <OverviewTab
              data={data}
              reminder={reminder}
              nextByStep={plannedPartial ? null : nextByStep}
              onShowErrors={() => {
                const params = new URLSearchParams(searchParams.toString())
                params.set('id', reminderId)
                params.set('tab', 'runs')
                params.set('runStatus', 'permanent_failed')
                samePageUrl.replace(`/reminders/detail?${params.toString()}`)
              }}
              onShowAllRuns={() => selectTab('runs')}
            />
          ) : tab === 'schedule' ? (
            <ScheduleTab key={`${selectedAccountId}:${reminderId}`} reminderId={reminderId} steps={data.steps} />
          ) : tab === 'runs' ? (
            <RunsTab
              // 概要の警告帯から飛んだとき、絞り込みを確実に掛け直す。
              key={JSON.stringify([selectedAccountId, reminderId, runsStatusParam])}
              reminderId={reminderId}
              canManage={canManage}
              initialStatus={runsStatusParam === 'permanent_failed' ? 'permanent_failed' : ''}
            />
          ) : (
            <RegistrantsTab key={`${selectedAccountId}:${reminderId}`} reminderId={reminderId} canManage={canManage} />
          )}
        </div>
      </DetailColumns></PageContent>

      <SheetDialog
        open={confirmPause && openedPause?.generation === pauseContext.current.generation}
        designNode="RwVo5" designWidth={480}
        title={`「${data.reminder.name}」を一時停止する`}
        description="止めているあいだ、通知は送りません。止めているあいだに送る予定だった通知は、再開しても送りません（過去の日時になるため）。登録者と送った履歴は残ります。"
        band={!plannedLoaded ? '送る予定の通知の件数は確認できません。' : pauseImpact.truncated
          ? `送る予定の ${formatNumber(plannedTotal)} 通が送られなくなります（今後24時間の分は数え切れませんでした）。`
          : `今後24時間で送る予定の ${formatNumber(pauseImpact.count)} 通 が送られなくなります。`}
        busy={pausing}
        onClose={() => { if (!pausing) { pauseRef.current = null; setConfirmPause(false) } }}
        actions={(
          <>
            <Button onClick={() => { pauseRef.current = null; setConfirmPause(false) }} disabled={pausing}>キャンセル</Button>
            <Button widthReserve="idle" variant="primary" onClick={() => void runPause()} disabled={pausing || !openedPause || openedPause.generation !== pauseContext.current.generation} busy={pausing} busyLabel="止めています…">
              <Pause size={16} aria-hidden="true" />一時停止する
            </Button>
          </>
        )}
      ><OperationTargetSummary accounts={[{ id: data.reminder.lineAccountId ?? '', name: data.reminder.lineAccountId ? undefined : '不明' }]} externalTarget={{ label: '対象件数', name: '1件' }} /></SheetDialog>

      <ConfirmDialog
        open={confirmDelete && confirmedDeleteScope === deleteScope && confirmedDeleteGeneration === pauseContext.current.generation}
        title={`「${data.reminder.name}」を削除しますか`}
        description="登録者への未送信の通知と送信の履歴も消えます。この操作は取り消せません。"
        confirmLabel="削除する"
        destructive
        busy={deleting}
        error={deleteError}
        onConfirm={() => runDelete()}
        onCancel={() => setConfirmDelete(false)}
      ><OperationTargetSummary accounts={[{ id: data.reminder.lineAccountId ?? '', name: data.reminder.lineAccountId ? undefined : '不明' }]} /></ConfirmDialog>
    </PageFrame></PageExplanationProvider></SaveErrorScope>
  )
}

/* ===== 概要タブ ===== */

function OverviewTab({
  data,
  reminder,
  nextByStep,
  onShowErrors,
  onShowAllRuns,
}: {
  data: ReminderDeliveryRunsResponse
  reminder: (Reminder & { steps?: ReminderStep[] }) | null
  /** WEB084：予定を読み切れていないときは null（「次に送る」を言い切らない）。 */
  nextByStep: Record<number, string> | null
  onShowErrors: () => void
  onShowAllRuns: () => void
}) {
  const hasErrors = data.summary.errors > 0
  const detailSteps = reminder?.steps ?? []
  // 「最近の実行」は送った・送れなかったものだけ。これから送る予定（配信予定・処理中）は配信予定タブに出す。
  const recent = data.items.filter((item) => item.domainStatus !== 'planned' && item.domainStatus !== 'claimed').slice(0, 5)

  return (
    <>
      {hasErrors ? (
        <Notice tone="danger" heading={<> 送れなかった通知が {formatNumber(data.summary.errors)}通あります </>} action={<> <Button onClick={onShowErrors}>
            実行結果を見る<ArrowRight size={16} aria-hidden="true" />
          </Button> </>} >友だちがブロックしていたか、LINE が受け付けませんでした。理由を見て、送り直せます。</Notice>
      ) : null}

      <section className={styles.card} aria-labelledby="rm-detail-steps">
        <div className={styles.cardHead}>
          <h2 id="rm-detail-steps" className={styles.cardTitle}>通知ごとの送信状況</h2>
          <p className={styles.cardNote}>LINEでは、友だち単位の既読は分かりません</p>
        </div>
        <GridTable label="通知ごとの送信状況" framed={false} design={{ columns: 'var(--tpl-rm-col-num) minmax(0, 1fr) var(--tpl-rm-col-step) var(--tpl-rm-col-fail) minmax(0, 1.5fr)', gap: 'var(--tpl-rm-row-gap-lg)', rowPadding: 'var(--tpl-rm-stop-pad)', fontSize: 'var(--tpl-rm-note-size)' }}>
          <GridHeadRow>
            <GridCell role="columnheader">通知</GridCell>
            <GridCell role="columnheader">タイミング</GridCell>
            <GridCell role="columnheader">送った</GridCell>
            <GridCell role="columnheader">失敗</GridCell>
            <GridCell role="columnheader">次に送る</GridCell>
          </GridHeadRow>
          {data.steps.map((step, index) => (
            <GridRow key={step.id}>
              <GridCell>{step.stepNumber}</GridCell>
              <GridCell title={stepLabel(step)}>{stepTiming(step, detailSteps[index], reminder?.deliveryMode)}</GridCell>
              <GridCell>{formatNumber(step.sent)}通</GridCell>
              <GridCell tone={step.errors > 0 ? 'danger' : undefined}>{formatNumber(step.errors)}通</GridCell>
              <GridCell>{nextByStep ? formatMd(nextByStep[step.stepNumber] ?? null) : emptyValue('unknown')}</GridCell>
            </GridRow>
          ))}
        </GridTable>
      </section>

      <section className={styles.card} aria-labelledby="rm-detail-recent">
        <div className={styles.cardHead}>
          <h2 id="rm-detail-recent" className={styles.cardTitle}>最近の実行</h2>
        </div>
        {recent.length === 0 && (data.items.length > 0 || data.pagination.total > data.items.length) ? (
          /* WEB084：先頭5件が予定ばかりで実行が見えないだけのときは「まだありません」と言わない。 */
          <p className={styles.cardNote}>
            最近の実行をここでは読み切れませんでした。{' '}
            <button type="button" className="font-semibold underline" onClick={onShowAllRuns}>実行結果で見る</button>
          </p>
        ) : recent.length === 0 ? (
          <p className={styles.cardNote}>まだ実行した通知はありません。届き始めるとここに出ます。</p>
        ) : (
          <>
            <div className={styles.table} role="table" aria-label="最近の実行">
              <TableHeadRow as="div" presentation="embedded" className={styles.headRow}>
                <span role="columnheader" className={styles.colWhen}>時刻</span>
                <span role="columnheader" className={styles.colFlex}>友だち</span>
                <span role="columnheader" className={styles.colStep}>通知</span>
                <span role="columnheader" className={styles.colResult}>結果</span>
              </TableHeadRow>
              {recent.map((item) => (
                <div key={item.id} role="row" className={styles.row}>
                  <span role="cell" className={styles.colWhen}>{formatShort(item.completedAt ?? item.startedAt ?? item.scheduledAt)}</span>
                  <span role="cell" className={styles.colFlex}>
                    <Link href={`/friends/${encodeURIComponent(item.friendId)}`} className={styles.friendName}>
                      {item.friendName ?? '削除済みの友だち'}
                    </Link>
                  </span>
                  <span role="cell" className={styles.colStep}>{item.stepNumber}</span>
                  <span role="cell" className={styles.colResult}>
                    <StatusPill tone={STATUS_VIEW[item.domainStatus].tone}>{STATUS_VIEW[item.domainStatus].label}</StatusPill>
                  </span>
                </div>
              ))}
            </div>
            <div className={styles.moreRow}>
              <Button variant="text" onClick={onShowAllRuns}>
                すべての実行結果<ArrowRight size={16} aria-hidden="true" />
              </Button>
            </div>
          </>
        )}
      </section>
    </>
  )
}

/* ===== 配信予定タブ ===== */

function ScheduleTab({ reminderId, steps }: { reminderId: string; steps: ReminderDeliveryRunsResponse['steps'] }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [items, setItems] = useState<ReminderDeliveryRun[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useListUrlValue('page', 1)

  const stepNameByNumber = useMemo(() => Object.fromEntries(steps.map((step) => [step.stepNumber, stepLabel(step)])), [steps])

  const load = useCallback(async () => {
    setState('loading')
    try {
      const res = await api.reminders.runs(reminderId, { status: 'planned', limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      if (!res.success) throw new Error(res.error)
      setItems(res.data.items)
      setTotal(res.data.pagination.total)
      setState('ready')
    } catch {
      setState('error')
    }
  }, [page, reminderId])

  useEffect(() => { void load() }, [load])

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])

  return (
    <section className={styles.card} aria-labelledby="rm-detail-schedule">
      <div className={styles.cardHead}>
        <h2 id="rm-detail-schedule" className={styles.cardTitle}>配信予定</h2>
        <p className={styles.cardNote}>これから送る通知を予定の近い順に並べています。</p>
      </div>
      {state === 'loading' ? (
        <DetailLoading label="配信予定を読み込んでいます" />
      ) : state === 'error' ? (
        <ListState kind="error" title="配信予定を読み込めませんでした" onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <ListState kind="empty" emptyPreset="readonly" title="送る予定はありません" description="登録者の基準日が来ると、ここに送る予定が並びます。" />
      ) : (
        <>
          <div className={styles.table} role="table" aria-label="配信予定">
            <TableHeadRow as="div" presentation="embedded" className={styles.headRow}>
              <span role="columnheader" className={styles.colNext}>送る日時</span>
              <span role="columnheader" className={styles.colFlex}>友だち</span>
              <span role="columnheader" className={styles.colWide}>通知</span>
              <span role="columnheader" className={styles.colResult}>状態</span>
            </TableHeadRow>
            {items.map((item) => (
              <div key={item.id} role="row" className={styles.row} data-warn={item.domainStatus === 'retry_wait' || undefined}>
                <span role="cell" className={styles.colNext}>
                  {formatMd(item.domainStatus === 'retry_wait' ? item.nextRetryAt : item.scheduledAt)}
                  {item.domainStatus === 'retry_wait' ? <span className={styles.cellSub}>再試行の予定</span> : null}
                </span>
                <span role="cell" className={styles.colFlex}>
                  <Link href={`/friends/${encodeURIComponent(item.friendId)}`} className={styles.friendName}>{item.friendName ?? '削除済みの友だち'}</Link>
                </span>
                <span role="cell" className={styles.colWide} title={stepNameByNumber[item.stepNumber] ?? ''}>{item.stepNumber} 通目</span>
                <span role="cell" className={styles.colResult}>
                  <StatusPill tone={STATUS_VIEW[item.domainStatus].tone}>{STATUS_VIEW[item.domainStatus].label}</StatusPill>
                </span>
              </div>
            ))}
          </div>
          <div className={styles.pager}>
            <span className={styles.pagerCount}>{formatNumber(total)} 件中 {(page - 1) * PAGE_SIZE + 1}〜{Math.min(page * PAGE_SIZE, total)} 件</span>
            <Pagination page={page} pageCount={pageCount} onPageChange={setPage} ariaLabel="配信予定のページ送り" />
          </div>
        </>
      )}
    </section>
  )
}

/* ===== 実行結果タブ ===== */

const RUN_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'すべての結果' },
  { value: 'succeeded', label: '送れた' },
  { value: 'permanent_failed', label: '失敗' },
  { value: 'retry_wait', label: '再試行待ち' },
  { value: 'skipped', label: '送信なし' },
  { value: 'cancelled', label: '取り消し' },
  { value: 'planned', label: '配信予定' },
]

function RunsTab({ reminderId, canManage, initialStatus }: { reminderId: string; canManage: boolean; initialStatus: '' | ReminderDeliveryRunStatus }) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const loadSequence = useRef(0)
  const [status, setStatus] = useState<'' | ReminderDeliveryRunStatus>(initialStatus)
  const [search, setSearch] = useListUrlValue('q', '')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [page, setPage] = useListUrlValue('page', 1)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [items, setItems] = useState<ReminderDeliveryRun[]>([])
  const [total, setTotal] = useState(0)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setState('loading')
    try {
      const res = await api.reminders.runs(reminderId, {
        status: status || undefined,
        search: appliedSearch || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      })
      if (!mounted.current || sequence !== loadSequence.current) return
      if (!res.success) throw new Error(res.error)
      if (res.data.reminder.id !== reminderId) throw new Error('reminder id mismatch')
      setItems(res.data.items)
      setTotal(res.data.pagination.total)
      setState('ready')
    } catch {
      if (mounted.current && sequence === loadSequence.current) setState('error')
    }
  }, [appliedSearch, page, reminderId, status])

  useEffect(() => { void load() }, [load])

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])

  const retry = async (runId: string) => {
    if (!mounted.current || !items.some(item => item.id === runId && item.canRetry) || !canManage) return
    setRetryingId(runId)
    setNotice('')
    try {
      const response = await api.reminders.retryRun(runId, crypto.randomUUID())
      if (!response.success) throw new Error(response.error)
      setNotice('再試行を受け付けました。次の配信処理で送ります。')
      await load()
    } catch {
      setNotice('再試行を受け付けられませんでした。状態を読み直してからお試しください。')
    } finally {
      setRetryingId(null)
    }
  }

  const filtered = Boolean(status || appliedSearch)

  return (
    <section className={styles.card} aria-labelledby="rm-detail-runs">
      <div className={styles.cardHead}>
        <h2 id="rm-detail-runs" className={styles.cardTitle}>実行結果</h2>
      </div>
      {notice ? <Notice tone="info">{notice}</Notice> : null}
      <div className={styles.toolbar}>
        <SearchField
          className={styles.search}
          aria-label="友だちの名前で実行結果を検索"
          placeholder="友だちの名前で探す"
          value={search}
          onChange={setSearch}
          onClear={() => { setSearch(''); setAppliedSearch(''); setPage(1) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setAppliedSearch(search.trim())
              setPage(1)
            }
          }}
        />
        <SaveErrorField names={["status"]}><Select aria-label="結果で絞り込む" label="結果" value={status} onChange={(value) => { setStatus(value as '' | ReminderDeliveryRunStatus); setPage(1) }} options={RUN_STATUS_OPTIONS} /></SaveErrorField>
        <Button onClick={() => { setAppliedSearch(search.trim()); setPage(1) }}>探す</Button>
      </div>
      {state === 'loading' ? (
        <DetailLoading label="実行結果を読み込んでいます" />
      ) : state === 'error' ? (
        <ListState kind="error" title="実行結果を読み込めませんでした" onRetry={() => void load()} />
      ) : items.length === 0 ? (
        <ListState
          kind="empty"
          emptyPreset={filtered ? 'filtered' : 'readonly'}
          title={filtered ? undefined : 'まだ実行した通知はありません'}
          action={filtered ? <Button onClick={() => { setStatus(''); setSearch(''); setAppliedSearch(''); setPage(1) }}>条件を外す</Button> : undefined}
        />
      ) : (
        <>
          <div className={styles.table} role="table" aria-label="実行結果">
            <TableHeadRow as="div" presentation="embedded" className={styles.headRow}>
              <span role="columnheader" className={styles.colWhen}>時刻</span>
              <span role="columnheader" className={styles.colFlex}>友だち</span>
              <span role="columnheader" className={styles.colStep}>通知</span>
              <span role="columnheader" className={styles.colResult}>結果</span>
              <span role="columnheader" className={styles.colReason}>詳細</span>
              <span role="columnheader" className={styles.colOps}><span className="sr-only">操作</span></span>
            </TableHeadRow>
            {items.map((item) => (
              <div key={item.id} role="row" className={styles.row}>
                <span role="cell" className={styles.colWhen}>
                  {formatShort(item.completedAt ?? item.startedAt ?? item.scheduledAt)}
                  {item.nextRetryAt ? <span className={styles.cellSub}>次回 {formatShort(item.nextRetryAt)}</span> : null}
                </span>
                <span role="cell" className={styles.colFlex}>
                  <Link href={`/friends/${encodeURIComponent(item.friendId)}`} className={styles.friendName}>{item.friendName ?? '削除済みの友だち'}</Link>
                </span>
                <span role="cell" className={styles.colStep}>{item.stepNumber} 通目</span>
                <span role="cell" className={styles.colResult}>
                  <StatusPill tone={STATUS_VIEW[item.domainStatus].tone}>{STATUS_VIEW[item.domainStatus].label}</StatusPill>
                </span>
                <span role="cell" className={styles.colReason} title={item.lastErrorMessage ?? undefined}>{item.lastErrorMessage ?? `${item.attemptCount} 回試行`}</span>
                <span role="cell" className={styles.colOps}>
                  {item.canRetry && canManage ? (
                    <Button variant="text" disabled={retryingId === item.id} busy={retryingId === item.id} busyLabel="受け付けています" onClick={() => void retry(item.id)}>
                      <RotateCcw size={16} aria-hidden="true" />再試行する
                    </Button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          <div className={styles.pager}>
            <span className={styles.pagerCount}>{formatNumber(total)} 件中 {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}〜{Math.min(page * PAGE_SIZE, total)} 件</span>
            <Pagination page={page} pageCount={pageCount} onPageChange={setPage} ariaLabel="実行結果のページ送り" />
          </div>
        </>
      )}
    </section>
  )
}

/* ===== 登録者タブ ===== */

type RegistrantFilter = 'all' | 'active' | 'cancelled'

export function RegistrantsTab({ reminderId, canManage }: { reminderId: string; canManage: boolean }) {
  const saveErrors = useSaveFormErrors()

  const { selectedAccountId } = useAccount()
  const [items, setItems] = useState<ReminderRegistrant[]>([])
  const [draftDates, setDraftDates] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actioningId, setActioningId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useListUrlValue('q', '')
  const [filter, setFilter] = useListUrlValue<RegistrantFilter>('filter', 'all')
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [page, setPage] = useListUrlValue('page', 1)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const registrants = await api.reminders.registrants.list(reminderId)
      if (!registrants.success) throw new Error('load failed')
      setItems(registrants.data)
      setDraftDates(Object.fromEntries(registrants.data.map((item) => [item.id, dateTimeLocalJst(item.targetDate)])))
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)
      setItems([])
      { if (!fieldFailure)

      setError('登録者を読み込めませんでした。時間を置いてもう一度お試しください。') }
    } finally {
      setLoading(false)
    }
  }, [reminderId, saveErrors])

  useEffect(() => {
    // アカウント切替直後に前の店舗の一覧を見せたままにしない。
    setItems([])
    setDraftDates({})
    void load()
  }, [load, selectedAccountId])

  const activeCount = useMemo(() => items.filter((item) => item.status === 'active').length, [items])
  const cancelledCount = items.filter((item) => item.status === 'cancelled').length

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return items.filter((item) => {
      if (filter === 'active' && item.status !== 'active') return false
      if (filter === 'cancelled' && item.status !== 'cancelled') return false
      if (needle && !(item.friendName ?? '').toLowerCase().includes(needle)) return false
      return true
    })
  }, [filter, items, search])

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  const pageItems = visible.slice((page - 1) * pageSize, page * pageSize)

  const apply = (id: string, value: { targetDate: string; status: string; lockVersion: number }) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...value, updatedAt: new Date().toISOString() } as ReminderRegistrant : item))
    setDraftDates((current) => ({ ...current, [id]: dateTimeLocalJst(value.targetDate) }))
  }

  const saveDate = async (item: ReminderRegistrant) => {
    if (actioningId) return
    const local = draftDates[item.id]
    const targetDate = local ? dateTimeLocalJstToUtcIso(local) : null
    if (!targetDate) {
      setNotice('基準日を正しく入力してください。')
      return
    }
    setActioningId(item.id)
    setNotice('')
    try {
      const response = await api.reminders.registrants.updateTargetDate(reminderId, item.id, targetDate, item.lockVersion)
      if (!response.success) throw new Error(response.error)
      apply(item.id, response.data)
      setNotice(response.data.replayed ? '同じ変更を確認しました。基準日は変更済みです。' : '基準日を変更しました。未送信分だけ新しい日程で組み直します。')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setNotice('基準日を変更できませんでした。ほかの担当者による変更がないか、一覧を読み直してください。') }
    } finally { setActioningId(null) }
  }

  const changeStatus = async (item: ReminderRegistrant, action: 'cancel' | 'resume') => {
    if (actioningId) return
    setActioningId(item.id)
    setNotice('')
    try {
      const response = action === 'cancel'
        ? await api.reminders.registrants.cancel(reminderId, item.id, item.lockVersion)
        : await api.reminders.registrants.resume(reminderId, item.id, item.lockVersion)
      if (!response.success) throw new Error(response.error)
      apply(item.id, response.data)
      setNotice(action === 'cancel'
        ? '登録を取り消しました。送信済みの履歴は残り、未送信分だけを止めています。'
        : '登録を再開しました。未送信分だけを次の配信処理で組み直します。')
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setNotice('操作を完了できませんでした。一覧を読み直してからもう一度お試しください。') }
    } finally { setActioningId(null) }
  }

  return (
    <SaveErrorScope errors={saveErrors}><>
      <PageExplanationBody keepMounted>基準日を変えると、まだ送っていない通知だけ新しい日程で組み直します。送った履歴は消えません。</PageExplanationBody>

      <section className={styles.card} aria-labelledby="rm-detail-registrants">
        <div className={styles.cardHead}>
          <h2 id="rm-detail-registrants" className={styles.cardTitle}>登録者</h2>
          <p className={styles.cardNote}>{formatNumber(items.length)} 人</p>
        </div>
        {notice ? <Notice tone="info">{notice}</Notice> : null}
        <ListToolbarFrame><ListToolbarRow>
          <ListToolbarSearchSlot><SearchField
            aria-label="友だちの名前で登録者を検索"
            placeholder="友だちの名前で探す"
            value={search}
            onChange={(value) => { setSearch(value); setPage(1) }}
            onClear={() => { setSearch(''); setPage(1) }}
          /></ListToolbarSearchSlot>
          <SegmentedControl
            aria-label="登録者の状態で絞り込む"
            value={filter}
            onChange={(next) => { setFilter(next); setPage(1) }}
            options={[
              { value: 'all', label: 'すべて' },
              { value: 'active', label: '有効', count: activeCount },
              { value: 'cancelled', label: '取消済み', count: cancelledCount },
            ]}
          />
          <ListToolbarEnd>
          <PageSizeSelect value={pageSize} options={[10, 20, 50]} onChange={(value) => { setPageSize(value); setPage(1) }} />
          </ListToolbarEnd>
        </ListToolbarRow></ListToolbarFrame>

        {loading ? (
          <DetailLoading label="登録者を読み込んでいます" />
        ) : error ? (
          <ListState kind="error" title="登録者を表示できませんでした" description={error} onRetry={() => void load()} />
        ) : items.length === 0 ? (
          <ListState kind="empty" emptyPreset="readonly" title="登録者はいません" description="このリマインダに登録すると、ここで基準日と状態を管理できます。" />
        ) : visible.length === 0 ? (
          <ListState kind="empty" emptyPreset="filtered" action={<Button onClick={() => { setSearch(''); setFilter('all'); setPage(1) }}>条件を外す</Button>} />
        ) : (
          <>
            <GridTable label="登録者" framed={false} design={{ columns: 'minmax(0, 1fr) minmax(0, 1.5fr) var(--tpl-rm-col-step) calc(var(--row-action-width, 0px) + var(--tpl-rm-icon-btn) + var(--tpl-toolbar-gap))', gap: 'var(--tpl-rm-row-gap-lg)', rowPadding: 'var(--tpl-rm-stop-pad)', fontSize: 'var(--tpl-rm-note-size)' }}>
              <GridHeadRow>
                <GridCell role="columnheader">友だち</GridCell>
                <GridCell role="columnheader">基準日（予約日時）</GridCell>
                <GridCell role="columnheader">状態</GridCell>
                <GridCell role="columnheader"><span className="sr-only">操作</span></GridCell>
              </GridHeadRow>
              {pageItems.map((item) => {
                const dirty = (draftDates[item.id] ?? '') !== dateTimeLocalJst(item.targetDate)
                const busy = actioningId === item.id
                return (
                  <GridRow key={item.id}>
                    <GridCell>
                      <Link href={`/friends/${encodeURIComponent(item.friendId)}`} className={styles.friendName}><TruncatedText value={item.friendName || '名前未設定'} /></Link>
                    </GridCell>
                    <GridCell>
                      <SaveErrorField names={["draftDates","draft_dates"]}><DateTimeField

                        labelFormat="short" readOnly={!canManage}
                        clearable={false}
                        aria-label={`${item.friendName || '登録者'}の基準日`}
                        value={draftDates[item.id] ?? ''}
                        disabled={item.status !== 'active' || busy || !canManage}
                        onChange={(v) => setDraftDates((current) => ({ ...current, [item.id]: v }))}
                      /></SaveErrorField>
                    </GridCell>
                    <GridCell>
                      <StatusPill tone={item.status === 'active' ? 'ok' : 'muted'}>
                        {item.status === 'active' ? '有効' : item.status === 'cancelled' ? '取消済み' : item.status}
                      </StatusPill>
                    </GridCell>
                    <GridCell data-list-action-cell="">
                      {/* 閲覧のみの人には、押せない操作を置かない。 */}
                      {/* 行の操作は「…」1つの中（B-253）。基準日を変えたときだけ、その場で保存するボタンを横に出す。閲覧のみの人には置かない。 */}
                      {canManage && item.status === 'active' && dirty ? (
                        <Button variant="primary" disabled={busy} busy={busy} busyLabel="保存しています" onClick={() => void saveDate(item)}>
                          <Check size={16} aria-hidden="true" />基準日を保存
                        </Button>
                      ) : null}
                      {canManage && (item.status === 'active' || item.status === 'cancelled') ? (
                        <RowMenu
                          label={`${item.friendName || '登録者'}の操作`}
                          title="その他の操作"
                          items={item.status === 'active'
                            ? [{ id: 'cancel', label: '取り消す', icon: <X size={16} aria-hidden="true" />, disabled: busy, onSelect: () => void changeStatus(item, 'cancel') }]
                            : [{ id: 'resume', label: '再開する', icon: <RotateCcw size={16} aria-hidden="true" />, disabled: busy, onSelect: () => void changeStatus(item, 'resume') }]}
                        />
                      ) : null}
                    </GridCell>
                  </GridRow>
                )
              })}
            </GridTable>
            <div className={styles.pager}>
              <span className={styles.pagerCount}>{formatNumber(visible.length)} 人中 {visible.length === 0 ? 0 : (page - 1) * pageSize + 1}〜{Math.min(page * pageSize, visible.length)} 人</span>
              <Pagination page={page} pageCount={pageCount} onPageChange={setPage} ariaLabel="登録者のページ送り" />
            </div>
          </>
        )}
      </section>
    </></SaveErrorScope>
  )
}
