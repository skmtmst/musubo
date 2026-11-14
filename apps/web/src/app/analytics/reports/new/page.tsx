'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { SettingsFormRow } from '@/components/shared/settings-form-card'

import EntitySelect from '@/components/shared/entity-select'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import Card, { CardHeader } from '@/components/shared/card'
import { CreatePage } from '@/components/templates'
import Checkbox from '@/components/shared/checkbox'
import { TimeField } from '@/components/shared/date-time-field'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import PageHeader from '@/components/shared/page-header'
import StatusBadge from '@/components/shared/status-badge'
import { notifyToast } from '@/components/shared/toast'
import Select from '@/components/shared/select'
import VersionCompare from '@/components/shared/version-compare'
import { usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import './report-v8.css'
import { TextField } from '@/components/shared/text-field'
import NumberInput from '@/components/shared/number-field'
import HelpTip from '@/components/shared/help-tip'
import { Field, RequiredBadge } from '@/components/shared/form-controls'
import PeriodPicker, { pastPeriod } from '@/components/shared/period-picker'
import { Check, ChevronDown, GitCompareArrows, RefreshCw } from 'lucide-react'
import { formatDateTime, formatTime, formatNumber } from '@/lib/format'
import {
  api,
  ApiError,
  describeSaveFailure,
  type AnalyticsReportRun,
  type AnalyticsReportSchedule,
  type AnalyticsReportScheduleOptions,
  type AnalyticsReportSection,
} from '@/lib/api'
import {
  deliveryChannelLabel,
  deliveryStatusLabel,
  runErrorLabel,
  runStateLabel,
} from '../../report-run-state'

/** 実測（available）の数だけ取る。途中・待ち・失敗は見本にしない（Worker の本文と同じ扱い）。 */
function strictNumber(metric: { value: number | null; state: string }): number | null {
  return metric.state === 'available' && typeof metric.value === 'number' ? metric.value : null
}

const SECTION_CHOICES: Array<{ id: AnalyticsReportSection; title: string; detail: string; unavailable?: string }> = [
  { id: 'friends', title: '友だちの増減', detail: '増えた・減った・残っている割合' },
  { id: 'reactions', title: '配信の反応', detail: '押された割合・ブロックされた割合' },
  { id: 'routes', title: '経路と成果', detail: '流入リンクごとの友だち・成果' },
  { id: 'usage', title: '使われ方', detail: '作ったのに使っていないもの' },
  // マイルの期間別集計は未接続で、入れてもレポートは「未取得」になるだけ。
  // 新たに選ばせず、既に入っている既存レポートからは外せるようにする。
  // 48: 理由は短く「集計ができたら選べます」。名前の横には灰の札「未集計」。
  { id: 'mileage', title: 'マイル', detail: '付けたマイル・交換', unavailable: '集計ができたら選べます' },
]

type AlertRuleDraft = { enabled: boolean; threshold: string; minimumSample: string }

// 変化を知らせる決めごとの雛形。数値はあとから変えられる。裏側の検査と同じ
// metric/operator の組だけを出す(正本: apps/worker/src/routes/analytics.ts の
// parseReportBody と packages/db の AnalyticsReportAlertRule)。
const ALERT_RULE_DEFS: Array<{
  id: 'block_rate' | 'friend_adds' | 'conversions'
  metric: 'block_rate' | 'friend_adds' | 'conversions'
  operator: 'greater_than' | 'decrease_percent' | 'zero_streak_days'
  name: string
  lead: string
  tail: string
  detail?: string
  threshold: string
  minimumSample: string
  step: string
  thresholdLabel: string
  sampleLabel: string
}> = [
  {
    id: 'block_rate', metric: 'block_rate', operator: 'greater_than',
    name: 'ブロック増の条件',
    lead: 'ブロックが ', tail: ' % をこえたら、レポートに含めて知らせる',
    detail: '配信の事故に早く気づけます。',
    threshold: '0.5', minimumSample: '20', step: '0.1',
    thresholdLabel: 'ブロック率のしきい値（%）', sampleLabel: 'ブロック条件の判定に必要な最低件数',
  },
  {
    id: 'friend_adds', metric: 'friend_adds', operator: 'decrease_percent',
    name: '友だち減少の条件',
    lead: '友だちが前の週より ', tail: ' % 減ったら、レポートに含めて知らせる',
    threshold: '20', minimumSample: '20', step: '1',
    thresholdLabel: '友だち減少のしきい値（%）', sampleLabel: '友だち減少条件の判定に必要な最低件数',
  },
  {
    id: 'conversions', metric: 'conversions', operator: 'zero_streak_days',
    name: '成果0件がつづく条件',
    lead: '成果が0件の日が ', tail: ' 日つづいたら、レポートに含めて知らせる',
    detail: '計測が壊れていることに気づけます。',
    threshold: '3', minimumSample: '20', step: '1',
    thresholdLabel: '続いた日数', sampleLabel: '成果0件条件の判定に必要な最低件数',
  },
]

function defaultAlertDrafts(enabled: boolean): Record<string, AlertRuleDraft> {
  return Object.fromEntries(ALERT_RULE_DEFS.map((def) => [def.id, { enabled, threshold: def.threshold, minimumSample: def.minimumSample }]))
}

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const

const CHANNEL_LABEL: Record<string, string> = {
  dashboard: '管理画面のお知らせ',
  email: 'メール',
  line: 'LINE',
}

/** 右の見本の行の名前（絵 ：友だち・配信を開いた・成果）。 */
const PREVIEW_LABEL: Partial<Record<string, string>> = { friends: '友だち', reactions: '配信を開いた', routes: '成果', mileage: 'マイル' }

function sectionTitleOf(id: string): string {
  return SECTION_CHOICES.find((choice) => choice.id === id)?.title ?? id
}

/*
 * 「違いを比べる」の比べる文。版の本文ではなく設定の要約。
 * 最新と入力中の2つを作り、VersionCompare（行ごとの比べる）へ渡す。
 */
type ReportSummaryInput = {
  name: string
  sections: string[]
  savedAnalysisIds: string[]
  cadence: string
  weekday: string
  monthDay: string
  sendTime: string
  periodDays: string
  staffIds: string[]
  emails: string[]
  channels: string[]
  alertRules: Array<{ metric: string; operator: string; threshold: number; minimumSample: number }>
  staffName: (id: string) => string
  savedName: (id: string) => string
}

function describeReportSummary(input: ReportSummaryInput, oneTime = false): string {
  const sections = input.sections.map(sectionTitleOf)
  const saved = input.savedAnalysisIds.map(input.savedName)
  const recipients = [
    ...input.staffIds.map(input.staffName),
    ...input.emails,
  ]
  const schedule = input.cadence === 'monthly'
    ? `毎月（${input.monthDay}日 ${input.sendTime}）`
    : `毎週（${WEEKDAY_JA[Number(input.weekday)] ?? input.weekday}曜 ${input.sendTime}）`
  const channels = input.channels.map((channel) => CHANNEL_LABEL[channel] ?? channel)
  const alerts = input.alertRules.map((rule) => {
    const def = ALERT_RULE_DEFS.find((item) => item.metric === rule.metric && item.operator === rule.operator)
    return def ? `${def.name}（${rule.threshold}・最低${rule.minimumSample}件）` : 'その他の条件'
  })
  return [
    `名前: ${input.name || '（名前なし）'}`,
    `入れるもの: ${sections.length > 0 ? sections.join('、') : '（なし）'}`,
    `保存した分析: ${saved.length > 0 ? saved.join('、') : 'なし'}`,
    `宛先: ${recipients.length > 0 ? recipients.join('、') : '（なし）'}`,
    ...(oneTime ? [] : [`送る間かく: ${schedule}`]),
    `集計する期間: 前の${input.periodDays}日間`,
    `通知方法: ${channels.length > 0 ? channels.join('、') : '（なし）'}`,
    `知らせる条件: ${alerts.length > 0 ? alerts.join('、') : 'なし'}`,
  ].join('\n')
}

/*
 * 作るときの未保存の基準。初期値そのままの署名。空の宛先行（文字なし）は
 * 未保存に数えない（下の署名と同じく空欄を外す）。なおすときは読み直した
 * 値で基準を作り直す（読み直し効果の中）。
 */
const NEW_BASELINE = JSON.stringify([
  '週次まとめ', ['friends', 'reactions', 'routes', 'usage'], [], 'weekly', '1', '1', '09:00', '7',
  [], [], true, false, false, true, defaultAlertDrafts(true), [],
])

const ROLE_LABEL = { owner: 'オーナー', admin: '管理者', staff: 'スタッフ' } as const

import { isEmail } from './report-email'
import CloseButton from '@/components/shared/close-button'

/*
 * R454: 1回送信の結果を見る画面。しまうと一覧から消えるため、
 * 依頼ID（この画面のURL）から失敗理由・宛先別結果へ到達させる。
 * 全部失敗の確定分だけ、ここから送り直せる。
 */
function OneTimeResultView({ accountId, schedule, runs, canManage, onRetryDone }: {
  accountId: string
  schedule: AnalyticsReportSchedule
  runs: AnalyticsReportRun[]
  canManage: boolean
  onRetryDone: () => void
}) {
  usePageTitle('1回送信の結果')
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  const latest = runs[0] ?? null
  const sentAny = runs.some((run) => run.deliveryResults.some((item) => item.status === 'sent'))
  const canRetry = canManage && latest !== null && latest.state !== 'running' && !sentAny

  const retry = async () => {
    if (!canRetry || retrying) return
    setRetrying(true)
    setRetryError('')
    try {
      const response = await api.analytics.reportSchedules.retry(accountId, schedule.id)
      if (!response.success) throw new Error(response.error)
      notifyToast('送り直しを受け付けました。結果はこの画面で確認できます。')
      onRetryDone()
    } catch (caught) {
      setRetryError(describeApiFailure(caught, '保存'))
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="text-ink mx-auto flex max-w-screen-2xl flex-col gap-4 pb-24" data-design-node="URqOA">
      <PageHeader
        breadcrumb={[{ label: '分析', href: '/analytics' }, { label: '1回送信の結果' }]}
        title="1回送信の結果"
        help=""
      />
      <section className="border-hairline bg-canvas rounded-card border p-4 sm:p-6">
        <h2 className="truncate text-lg font-semibold" title={schedule.name}>{schedule.name}</h2>
        {!latest && (
          <p className="text-ink-secondary mt-2 text-sm">まだ送信されていません。送信が終わるとここに結果が出ます。</p>
        )}
        {latest && (
          <div className="mt-3 grid gap-2 text-sm">
            <p className="text-ink-secondary">結果: <strong className="text-ink">{runStateLabel(latest.state)}</strong></p>
            {runErrorLabel(latest.errorCode, latest.state) && (
              <Notice tone="info" message={runErrorLabel(latest.errorCode, latest.state) ?? ''} />
            )}
            <ul className="grid list-none gap-2 p-0">
              {latest.deliveryResults.map((item, index) => (
                <li key={index} className="border-hairline rounded-control border px-3 py-2 text-xs">
                  <span className="font-semibold">{deliveryChannelLabel(item.channel)}</span> ／ {item.recipient}
                  {' ／ '}{deliveryStatusLabel(item.status)}
                  {item.reason && <span className="text-ink-secondary">（{item.reason}）</span>}
                </li>
              ))}
              {latest.deliveryResults.length === 0 && (
                <li className="text-ink-secondary text-xs">宛先別の結果はまだありません。</li>
              )}
            </ul>
            {sentAny && (
              <p className="text-ink-secondary text-xs">一部は届いているため、送り直しはできません。</p>
            )}
          </div>
        )}
        {retryError && <Notice tone="danger" message={retryError} onClose={() => setRetryError('')} className="mt-3" />}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onRetryDone}>もう一度確認</Button>
          {canRetry && (
            <Button disabled={retrying} onClick={() => void retry()} busy={retrying} busyLabel="送り直しています">届いていない分を送り直す
            </Button>
          )}
        </div>
      </section>
    </div>
  )
}

function AnalyticsReportFormPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const editId = searchParams.get('id')
  usePageTitle(editId ? '定期レポートを直す' : '定期レポートをつくる')
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const scopeKey = JSON.stringify([selectedAccountId, editId])
  const scope = useRef({ key: scopeKey, generation: 0 })
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 }
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [options, setOptions] = useState<AnalyticsReportScheduleOptions | null>(null)
  const [editing, setEditing] = useState<AnalyticsReportSchedule | null>(null)
  const [editMissing, setEditMissing] = useState(false)
  /* WEB308：履歴の口が読めなかったことを「見つかりません」と分ける。 */
  const [editLoadFailed, setEditLoadFailed] = useState(false)
  const canManage = canManageRole(useStaffRole())
  const canManageRef = useRef(canManage)
  canManageRef.current = canManage
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // レポート名は変えられるようにする(点検#508軽12)。固定だと複数作ったときに区別できない。
  const [name, setName] = useState('週次まとめ')
  const [sections, setSections] = useState<AnalyticsReportSection[]>(['friends', 'reactions', 'routes', 'usage'])
  const [savedAnalysisIds, setSavedAnalysisIds] = useState<string[]>([])
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>('weekly')
  const [weekday, setWeekday] = useState('1')
  const [monthDay, setMonthDay] = useState('1')
  const [sendTime, setSendTime] = useState('09:00')
  const [periodDays, setPeriodDays] = useState('7')
  // 右の見本に出す、前の期間の本当の数（読めた所だけ。読めない所は「送信時に集計」のまま）。
  const [previewNumbers, setPreviewNumbers] = useState<Partial<Record<string, string>>>({})
  // 宛先の初期値は空にする。例のアドレスが入ったまま作ると、選んでいない
  // 相手へ数字の入ったレポートが送られる。受信者の自動チェックもしない。
  const [staffIds, setStaffIds] = useState<string[]>([])
  const [emails, setEmails] = useState<string[]>([])
  // R453: 通知方法は独立した選択にする。新規は従来どおり
  // （管理画面のお知らせあり・メールは宛先ありのみ・LINEなし）。
  // 編集時は保存済みの通知方法をそのまま読み込む。
  const [dashboardEnabled, setDashboardEnabled] = useState(true)
  const [emailEnabled, setEmailEnabled] = useState(false)
  const [lineEnabled, setLineEnabled] = useState(false)
  const [alertsEnabled, setAlertsEnabled] = useState(true)
  // 「＋ 保存した分析を選ぶ」「＋ 宛先を足す」「通知方法」で開く欄（中身は閉じていても置いておく）。
  const [savedOpen, setSavedOpen] = useState(false)
  const [recipientsOpen, setRecipientsOpen] = useState(false)
  const [channelsOpen, setChannelsOpen] = useState(false)
  // 知らせの決めごとは件の条件ごとに on/off と数値を持つ。固定表示だったものを
  // 編集できるようにする(点検のN-285)。
  const [alertDrafts, setAlertDrafts] = useState<Record<string, AlertRuleDraft>>(() => defaultAlertDrafts(true))
  // 画面に出せない決めごと(将来増えた種類など)は、消さずにそのまま保存へ回す。
  const [extraAlertRules, setExtraAlertRules] = useState<AnalyticsReportSchedule['alertRules']>([])
  // なおすときは読み直すまで基準なし。作るときは初期値が基準。
  const [baseline, setBaseline] = useState<string | null>(editId ? null : NEW_BASELINE)
  useEffect(() => {
    setName('週次まとめ'); setSections(['friends', 'reactions', 'routes', 'usage'])
    setSavedAnalysisIds([]); setCadence('weekly'); setWeekday('1'); setMonthDay('1')
    setSendTime('09:00'); setPeriodDays('7'); setStaffIds([]); setEmails([])
    setDashboardEnabled(true); setEmailEnabled(false); setLineEnabled(false); setAlertsEnabled(true)
    setAlertDrafts(defaultAlertDrafts(true)); setExtraAlertRules([])
    setSavedOpen(false); setRecipientsOpen(false); setChannelsOpen(false)
    setBaseline(editId ? null : NEW_BASELINE)
  }, [selectedAccountId, editId])

  // 見本の数：選んだ区画だけ、前の期間の本当の数を順に読む（重い集計を同時に走らせない）。
  // 式・期間は届く本文（Worker の analytics-reports）と同じにする。今日の途中は含めない（昨日まで）。
  useEffect(() => {
    if (!selectedAccountId) return
    const days = Number(periodDays)
    if (!Number.isFinite(days) || days <= 0) { setPreviewNumbers({}); return }
    const wanted = sections.filter((id) => id === 'friends' || id === 'reactions' || id === 'routes')
    if (wanted.length === 0) { setPreviewNumbers({}); return }
    let cancelled = false
    // 前のアカウント・前の期間の数を残さない。
    setPreviewNumbers({})
    // 送り遅れ：期間の切り替えのたびに重い集計を走らせない。
    const timer = setTimeout(() => {
      const range = pastPeriod(days, new Date(Date.now() - 24 * 3600 * 1000))
      void (async () => {
        const next: Partial<Record<string, string>> = {}
        try {
          if (wanted.includes('friends') && !cancelled) {
            const res = await api.analytics.friendsOverview(selectedAccountId, range)
            if (res.success) {
              const added = strictNumber(res.data.data.metrics.added)
              const removed = strictNumber(res.data.data.metrics.removed)
              const net = strictNumber(res.data.data.metrics.net)
              if (added !== null && removed !== null && net !== null) {
                next.friends = net >= 0
                  ? `${formatNumber(net)}人増加（新規${formatNumber(added)}・解除${formatNumber(removed)}）`
                  : `${formatNumber(-net)}人減少（新規${formatNumber(added)}・解除${formatNumber(removed)}）`
              }
            }
          }
          if (wanted.includes('reactions') && !cancelled) {
            const res = await api.analytics.reactionsOverview(selectedAccountId, range)
            if (res.success) {
              const delivered = res.data.data.metrics.delivered
              const opened = res.data.data.metrics.opened
              if ((delivered.state === 'available' || delivered.state === 'partial') && typeof delivered.value === 'number') {
                const openedPart = opened.state === 'available' && typeof opened.value === 'number'
                  ? `・開封${formatNumber(opened.value)}件` : ''
                const scope = delivered.state === 'partial' ? '（一斉配信のみ）' : ''
                next.reactions = `${formatNumber(delivered.value)}件配信${openedPart}${scope}`
              }
            }
          }
          if (wanted.includes('routes') && !cancelled) {
            const res = await api.analytics.routesOverview(selectedAccountId, range)
            if (res.success) {
              let conversions: number | null = 0
              for (const route of res.data.data.routes.filter((item) => item.name !== '経路不明')) {
                const approved = strictNumber(route.conversions.approved)
                const pending = strictNumber(route.conversions.pending)
                if (approved === null || pending === null) { conversions = null; break }
                conversions += approved + pending
              }
              // 1つでも読めなければ出さない（一部だけ足した数は見本にしない）。
              if (conversions !== null) next.routes = `${formatNumber(conversions)}件`
            }
          }
        } catch {
          // 見本の数が読めなければ「送信時に集計」のまま。作る流れは止めない。
        }
        if (!cancelled) setPreviewNumbers(next)
      })()
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [selectedAccountId, periodDays, sections])

  // 読み直し用の数え直し。入力の状態には触らない(点検#508軽8)。
  const [reloadSeq, setReloadSeq] = useState(0)
  // R454: 1回送信の履歴（しまった依頼も依頼IDで結果へ到達させる）。
  const [oneTime, setOneTime] = useState<{ schedule: AnalyticsReportSchedule; runs: AnalyticsReportRun[] } | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setConflictId(null)
    setUpdateConflict(false)
    setConflictLatest(null)
    setCompareOpen(false)
    setCompareError('')
    setNameError('')
    setOptions(null)
    // id が外れた/変わったとき前の編集対象が残ると、新規作成のつもりが旧レポートへ
    // PUT してしまう。取り直すたびに編集状態も初期化する。
    setEditing(null)
    setEditMissing(false)
    setEditLoadFailed(false)
    setOneTime(null)
    if (!selectedAccountId) {
      setLoading(false)
      return () => { active = false }
    }
    void api.analytics.reportSchedules.list(selectedAccountId).then(async (response) => {
      if (!active) return
      if (!response.success) {
        setError(response.error || '定期レポートの設定を読み込めませんでした')
        setLoading(false)
        return
      }
      setOptions(response.data.options)
      if (editId) {
        const schedule = response.data.items.find((item) => item.id === editId)
        if (schedule && !schedule.isOneTime) {
          setEditing(schedule)
          setName(schedule.name)
          setSections(schedule.sections)
          setSavedAnalysisIds(schedule.savedAnalysisIds)
          setCadence(schedule.cadence)
          setWeekday(String(schedule.weekday ?? 1))
          setMonthDay(String(schedule.monthDay ?? 1))
          setSendTime(schedule.sendTime)
          setPeriodDays(String(schedule.periodDays))
          setStaffIds(schedule.recipients.filter((item) => item.kind === 'staff' && item.staffId).map((item) => item.staffId as string))
          setEmails(schedule.recipients.filter((item) => item.kind === 'email' && item.email).map((item) => item.email as string))
          // R453: 保存済みの通知方法をそのまま読み込む。宛先の有無から
          // 組み直さない（変えない保存で通知方法が変わる原因）。
          setDashboardEnabled(schedule.channels.includes('dashboard'))
          setEmailEnabled(schedule.channels.includes('email'))
          setLineEnabled(schedule.channels.includes('line'))
          setAlertsEnabled(schedule.alertRules.length > 0)
          // 保存済みの決めごとを雛形へ戻す。画面に無い種類は別棚へ避けて、
          // 保存するときにそのまま付け直す(編集するたびに消えないように)。
          const drafts = defaultAlertDrafts(false)
          const extras: AnalyticsReportSchedule['alertRules'] = []
          for (const rule of schedule.alertRules) {
            const def = ALERT_RULE_DEFS.find((item) => item.metric === rule.metric && item.operator === rule.operator)
            if (def) drafts[def.id] = { enabled: true, threshold: String(rule.threshold), minimumSample: String(rule.minimumSample) }
            else extras.push(rule)
          }
          setAlertDrafts(drafts)
          setExtraAlertRules(extras)
          // なおし時の未保存の基準は、読み直した値そのまま。
          setBaseline(JSON.stringify([
            schedule.name, schedule.sections, schedule.savedAnalysisIds, schedule.cadence,
            String(schedule.weekday ?? 1), String(schedule.monthDay ?? 1), schedule.sendTime, String(schedule.periodDays),
            schedule.recipients.filter((item) => item.kind === 'staff' && item.staffId).map((item) => item.staffId as string),
            schedule.recipients.filter((item) => item.kind === 'email' && item.email).map((item) => (item.email as string).trim()).filter(Boolean),
            schedule.channels.includes('dashboard'), schedule.channels.includes('email'), schedule.channels.includes('line'),
            schedule.alertRules.length > 0, drafts, extras,
          ]))
          setLoading(false)
          return
        }
        // R454: 一覧に無い・1回送信の依頼は履歴の口で引く。
        // しまった1回送信もここで結果へ到達させる。
        try {
          const detail = await api.analytics.reportSchedules.runs(selectedAccountId, editId)
          if (!active) return
          if (detail.success && detail.data?.schedule?.isOneTime) {
            setOneTime(detail.data)
          } else {
            setEditMissing(true)
          }
        } catch (caught) {
          // 404 は本当に無い。それ以外（通信・一時障害）は読み直せる失敗として出す。
          if (active) {
            if (caught instanceof ApiError && caught.status === 404) setEditMissing(true)
            else setEditLoadFailed(true)
          }
        }
      }
      setLoading(false)
    }).catch(() => {
      if (active) { setError('定期レポートの設定を読み込めませんでした'); setLoading(false) }
    })
    return () => { active = false }
  }, [selectedAccountId, reloadSeq, editId])

  const nextLabel = useMemo(() => cadence === 'weekly'
    ? `${['日', '月', '火', '水', '木', '金', '土'][Number(weekday)]}曜 ${sendTime}`
    : `毎月${monthDay}日 ${sendTime}`, [cadence, monthDay, sendTime, weekday])

  const toggleSection = (id: AnalyticsReportSection) => {
    setSections((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  // 宛先が0件のときは作れない。裏側も「受け取る人を選んでください」で止める。
  const hasRecipient = staffIds.length > 0 || emails.some((item) => item.trim() !== '')
  // R228: 形が合わない宛先行をその場で示す。空行は送信前に外すので対象外。
  const invalidEmails = emails.map((item) => {
    const trimmed = item.trim()
    return trimmed !== '' && !isEmail(trimmed) ? trimmed : null
  })
  const hasInvalidEmail = invalidEmails.some(Boolean)
  const submitDisabledReason = saving ? '保存しています' : !hasRecipient ? '受け取る人を1人以上選んでください' : hasInvalidEmail ? 'メールアドレスの形を確認してください' : undefined

  // R455: 保存応答が遅れて戻ったとき、別の依頼・別アカウントへ移って
  // いたらその応答を捨てる。応答のたびに「いま見ている対象」と比べる。
  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId
  const editIdRef = useRef(editId)
  editIdRef.current = editId
  /*
   * R526: 別アカウント・別編集対象へ移ったら、前の保存の進行表示を
   * 残さない。終わらない作成をAに残したままBへ移ると、Bの保存ボタンが
   * 「作っています」のまま押せなくなる（finally の setSaving(false) は
   * sameTarget の内側なので、移った後の決着では戻らない）。
   * 遅れて戻るAの応答は R455 の sameTarget が捨てるので、ここで戻しても
   * Aの結果がBの画面を上書きしない。読み直し（reloadSeq）では戻さない。
   * 読み直しは同じ対象の再取得であり、進行中の保存と競わせないため。
   */
  const saveTargetRef = useRef<{ accountId: string | null; editId: string | null } | null>(null)
  /*
   * R526・ABA: 保存の試行の世代と、その試行の中身（キー＋内容の署名）。
   * 新しく押すたびに世代が進む。保存の対象（アカウント・編集ID）が
   * 切り替わっても世代を進め、切替前の試行の応答を永続無効化する
   * （読み直し reloadSeq とは別。要求キー自体は残すので、押し直しは
   * 同じキー・同じ内容なら既にある予約へ戻る＝再送の意味は維持）。
   * 古い試行の応答は捨てるのが基本だが、同じキー・同じ内容の正当な
   * 再送の応答だけは受け付ける（同じ行に戻るだけなので害がない）。
   * 下の submit 内の isFresh が比べる。
   */
  const saveSeqRef = useRef(0)
  const latestAttemptRef = useRef<{ seq: number; key: string; signature: string } | null>(null)
  /*
   * R526・ABA: 保存の対象（アカウント・編集ID）の世代。対象が切り替わる
   * たびに進む。試行は始まったときの対象世代を掴み、切替後に戻った古い
   * 応答は内容が同じでも受け付けない（下の isFresh）。
   */
  const switchSeqRef = useRef(0)
  useEffect(() => {
    const prev = saveTargetRef.current
    saveTargetRef.current = { accountId: selectedAccountId, editId }
    if (prev && (prev.accountId !== selectedAccountId || prev.editId !== editId)) {
      setSaving(false)
      /*
       * R526・ABA: 対象を移ったら切替前の保存の応答を永続無効化する。
       * 戻ってきても古い応答は受け付けない。古い作成が成功して古い予約の
       * 画面へ飛ぶと、未送信の編集（新しい保存の内容）が消えるため。
       * 要求キーは残すので、押し直しは再送として効く。
       */
      switchSeqRef.current += 1
    }
  }, [selectedAccountId, editId])
  /*
   * R526: アカウントごとの作成試行の要求キー。応答消失後の押し直しは
   * 同じアカウントの同じキーで送り、サーバは既にある予約を返す。
   * 成功・作り直しではそのアカウントの分だけ捨てる（別アカウントの
   * 試行は残す）。1枠だと、Aで応答を失いBで作るとBがAを上書きし、
   * Aへ戻った押し直しが別物として二重予約になる。
   * 裏側はキーをそのまま行の主キーにする（全アカウントで1つ）ため、
   * アカウントが違えば新しい試行にする。
   */
  const createKeysRef = useRef<Record<string, string>>({})
  /*
   * R526: 同じキーで内容の違う予約が既にあるときの、その予約の番号。
   * 2件目を黙って作らず、既にある予約への案内を出す。
   */
  const [conflictId, setConflictId] = useState<string | null>(null)
  /*
   * : なおし中にほかの人が先に保存した（409）。
   * 入力は残したまま、板の頭の下に琥珀色の帯を出す。
   * 最新の取り直しができたら比べる文に使い、できなくても帯は出す。
   */
  const [updateConflict, setUpdateConflict] = useState(false)
  const [conflictLatest, setConflictLatest] = useState<AnalyticsReportSchedule | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareBusy, setCompareBusy] = useState(false)
  const [compareError, setCompareError] = useState('')
  const [latestBusy, setLatestBusy] = useState(false)
  const conflictActionSeq = useRef(0)
  const conflictBusyRef = useRef(false)
  useEffect(() => {
    setCompareBusy(false)
    setLatestBusy(false)
    conflictBusyRef.current = false
    return () => {
      ++conflictActionSeq.current
      conflictBusyRef.current = false
    }
  }, [selectedAccountId, editId])
  // 入力の誤りは欄だけで知らせ、最初の誤りへ移る。通信・保存の失敗は上の帯。
  const [nameError, setNameError] = useState('')
  const [validation, setValidation] = useState<{ field: string; message: string } | null>(null)
  const reportRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!validation) return
    const field = reportRef.current?.querySelector<HTMLElement>(`[id="${validation.field}"]`)
    field?.focus()
    field?.scrollIntoView?.({ block: 'center' })
  }, [validation])
  const showValidation = (failure: { field: string; error: string }) => {
    setError('')
    setNameError(failure.field === 'report-name' ? failure.error : '')
    if (failure.field === 'report-channels') setChannelsOpen(true)
    setValidation({ field: failure.field, message: failure.error })
  }
  useEffect(() => { setNameError(''); setValidation(null) }, [selectedAccountId, editId])
  const fieldMessage = (id: string) => validation?.field === id ? validation.message : undefined

  /*
   * 保存する中身の検査と組み立て。submit（つくる・なおす）と
   * saveOverLatest（「この内容で保存する」）の両方から使う。
   * 文言・順番はそのまま。画面への表示は呼ぶ側が行う。
   */
  type ReportPayload = {
    name: string
    sections: AnalyticsReportSection[]
    savedAnalysisIds: string[]
    cadence: 'weekly' | 'monthly'
    weekday: number | null
    monthDay: number | null
    sendTime: string
    timeZone: string
    periodDays: number
    recipients: Array<
      | { kind: 'staff'; staffId: string; label: string }
      | { kind: 'email'; email: string; label: string }
    >
    channels: AnalyticsReportSchedule['channels']
    alertRules: AnalyticsReportSchedule['alertRules']
  }
  const buildReportPayload = (
    scheduleOptions: AnalyticsReportScheduleOptions,
  ): { ok: true; payload: ReportPayload } | { ok: false; error: string; field: string } => {
    if (!name.trim()) {
      return { ok: false, field: 'report-name', error: 'レポートの名前を入力してください' }
    }
    if (hasInvalidEmail) {
      return { ok: false, field: `report-email-${invalidEmails.findIndex(Boolean)}`, error: 'メールアドレスの形が正しくない宛先があります。該当の行を直すか消してください。' }
    }
    // R453: 通知方法は選んだとおりに送る。1つも選ばれていない・
    // 受け取れる宛先が無い組み合わせはここで止める（裏側と同じ文）。
    if (!dashboardEnabled && !emailEnabled && !lineEnabled) {
      return { ok: false, field: 'report-channels', error: '通知方法を1つ以上選んでください' }
    }
    const emailRecipients = emails.map((item) => item.trim()).filter(Boolean)
    const staffById = new Map(scheduleOptions.recipients.map((item) => [item.id, item]))
    const emailCapable = emailRecipients.length > 0
      || staffIds.some((id) => staffById.get(id)?.email)
    if (emailEnabled && !emailCapable) {
      return { ok: false, field: 'report-channels', error: 'メールを受け取れる宛先がありません' }
    }
    const lineCapable = staffIds.some((id) => staffById.get(id)?.lineLinked)
    if (lineEnabled && !lineCapable) {
      return { ok: false, field: 'report-channels', error: 'LINE連携済みの宛先がありません' }
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendTime)) return { ok: false, field: 'report-send-time', error: '送る時刻を入力してください' }
    // 画面の数値を裏側が受け取れる形へ直す。変な数はここで止める
    // (裏側は不備のある条件を捨てるので、黙って無効になる前に知らせる)。
    const parsedAlertRules: AnalyticsReportSchedule['alertRules'] = []
    if (alertsEnabled) {
      for (const def of ALERT_RULE_DEFS) {
        const draft = alertDrafts[def.id]
        if (!draft?.enabled) continue
        const threshold = Number(draft.threshold)
        const minimumSample = Number(draft.minimumSample)
        if (!draft.threshold.trim() || !Number.isFinite(threshold) || threshold < 0 || !Number.isInteger(minimumSample) || minimumSample < 1) {
          return { ok: false, field: `report-alert-${def.id}-${!draft.threshold.trim() || !Number.isFinite(threshold) || threshold < 0 ? 'threshold' : 'sample'}`, error: '知らせる条件は、0以上の数と1以上の件数で入力してください' }
        }
        parsedAlertRules.push({ metric: def.metric, operator: def.operator, threshold, minimumSample })
      }
      parsedAlertRules.push(...extraAlertRules)
      if (parsedAlertRules.length === 0) {
        return { ok: false, field: 'report-alerts-enabled', error: '知らせる条件を1つ以上えらぶか、「大きな変化を知らせる」を外してください' }
      }
    }
    const recipients: ReportPayload['recipients'] = [
      ...scheduleOptions.recipients.filter((item) => staffIds.includes(item.id)).map((item) => ({
        kind: 'staff' as const, staffId: item.id, label: item.name,
      })),
      ...emailRecipients.map((email) => ({ kind: 'email' as const, email, label: email })),
    ]
    return {
      ok: true,
      payload: {
        name: name.trim(), sections, savedAnalysisIds, cadence,
        weekday: cadence === 'weekly' ? Number(weekday) : null,
        monthDay: cadence === 'monthly' ? Number(monthDay) : null,
        sendTime, timeZone: scheduleOptions.timeZone, periodDays: Number(periodDays), recipients,
        // R453: 選んだ通知方法をそのまま送る。宛先の有無からの組み直しや
        // dashboard の必須追加はしない（変えない保存で変わる原因）。
        channels: [
          ...(dashboardEnabled ? ['dashboard' as const] : []),
          ...(emailEnabled ? ['email' as const] : []),
          ...(lineEnabled ? ['line' as const] : []),
        ] as AnalyticsReportSchedule['channels'],
        alertRules: parsedAlertRules,
      },
    }
  }

  const submitLock = useRef<{ target: string } | null>(null)
  const [sendOnceOpen, setSendOnceOpen] = useState(false)
  const sendOnceScope = useRef<{ accountId: string; generation: number } | null>(null)
  const renderedSendOnceScope = sendOnceScope.current
  useEffect(() => { setSendOnceOpen(false) }, [selectedAccountId, editId, canManage])
  const submit = async (sendOnce: boolean) => {
    const target = `${selectedAccountId}:${editId}:${switchSeqRef.current}`
    if (submitLock.current?.target === target) return
    if (!selectedAccountId || !options || !canManage || !hasRecipient) return
    const built = buildReportPayload(options)
    if (!built.ok) {
      showValidation(built)
      return
    }
    const { payload } = built
    const lock = { target }
    submitLock.current = lock
    const submittedSignature = signature
    setSaving(true)
    setError('')
    setNameError('')
    setValidation(null)
    // R455: この保存が「どの依頼・どのアカウントへ向けたものか」を
    // 応答時に比べる。移っていたら編集先・文・保存中表示を変えない。
    const wantAccount = selectedAccountId
    const wantEditId = editId
    const sameTarget = () => accountRef.current === wantAccount && editIdRef.current === wantEditId
    /*
     * R526・ABA: 同じ依頼・同じアカウントへ戻って作り直すと、sameTarget
     * だけでは切替前の古い応答が通過する。古い作成が成功すると古い予約の
     * 画面へ飛び、新しい保存の状態と要求キーが消える。失敗でも新しい保存
     * の文を汚し、保存中の表示を落とす。保存の試行ごとに世代を数え、
     * 新しい試行が始まったら古い応答（成功・失敗とも）を捨てる。ただし
     * 同じキー・同じ内容の再送（正当な再送）の応答は受け付ける。
     */
    const mySeq = (saveSeqRef.current += 1)
    // R526・ABA: 試行が始まったときの対象世代。切替後に戻った古い応答は
    // 内容が同じでも受け付けない（対象切替で永続無効化）。
    const mySwitchSeq = switchSeqRef.current
    const myAttempt: { current: { key: string; signature: string } | null } = { current: null }
    const isFresh = () => {
      if (!sameTarget() || mySwitchSeq !== switchSeqRef.current) return false
      const latest = latestAttemptRef.current
      if (!latest || latest.seq === mySeq) return true
      // 対象を移らない新しい試行がある。同じキー・同じ内容の再送なら
      // 同じ行の結果なので受ける。
      const mine = myAttempt.current
      if (!mine) return false
      return latest.key === mine.key && latest.signature === mine.signature
    }
    try {
      if (editing) {
        myAttempt.current = { key: `update:${editing.id}`, signature: JSON.stringify(payload) }
        latestAttemptRef.current = { seq: mySeq, ...myAttempt.current }
        let response
        try {
          response = await api.analytics.reportSchedules.update(selectedAccountId, editing.id, {
            ...payload, expectedUpdatedAt: editing.updatedAt,
          })
        } catch (caught) {
          /*
           * : ほかの人が先に保存した（409）。入力は残したまま、
           * 板の頭の下に注意の帯を出す。
           * 最新を取り直せたら「違いを比べる」の比べる文に使う。
           */
          if (!(caught instanceof ApiError) || caught.status !== 409) throw caught
          if (!isFresh()) return
          setUpdateConflict(true)
          setCompareOpen(false)
          setCompareError('')
          try {
            const latest = await api.analytics.reportSchedules.list(selectedAccountId)
            if (!isFresh()) return
            if (latest.success) {
              setConflictLatest(latest.data.items.find((item) => item.id === editing.id) ?? null)
            }
          } catch {
            // 取り直しに失敗しても帯は出す。比べる文は出さない。
          }
          setError('ほかの人が先に保存しました。閉じて最新の内容と比べてください。')
          return false
        }
        if (!isFresh()) return
        if (!response.success) throw new Error(response.error)
        setUpdateConflict(false)
        setConflictLatest(null)
        setEditing(response.data)
        setBaseline(submittedSignature)
        notifyToast(response.data.status === 'paused'
          ? '定期レポートを更新しました。止まっている間は届きません。再開すると次の予定から届きます。'
          : `定期レポートを更新しました。次は${nextLabel}に届きます。`)
      } else {
        // R526: 作成試行の要求キー。応答消失後の押し直しは同じアカウントの
        // 同じキーで送り、既にある予約へ戻す（2件目を作らない）。
        // 別アカウントの試行は別のキーにする（使い回すと裏側の主キーが
        // 衝突して500になる）。Aへ戻ればAのキーが残っているので再送が効く。
        const requestKey = createKeysRef.current[selectedAccountId]
          ?? (createKeysRef.current[selectedAccountId] = crypto.randomUUID())
        myAttempt.current = { key: `create:${requestKey}`, signature: JSON.stringify(payload) }
        latestAttemptRef.current = { seq: mySeq, ...myAttempt.current }
        let response
        try {
          response = await api.analytics.reportSchedules.create(selectedAccountId, {
            ...payload, sendOnce,
          }, { idempotencyKey: requestKey })
        } catch (caught) {
          // 失敗後に内容を変えて押し直すと、同じキーで内容の違う予約が
          // 既にある。2件目を黙って作らず、既にある予約への案内を出す。
          if (caught instanceof ApiError && caught.status === 409) {
            const existingId = (caught.data as { existingId?: unknown } | undefined)?.existingId
            if (typeof existingId === 'string' && existingId && isFresh()) {
              setConflictId(existingId)
              setError('この依頼は既にあります。閉じて既にある依頼を確認してください。')
              return false
            }
          }
          throw caught
        }
        if (!isFresh()) return
        if (!response.success) throw new Error(response.error)
        // R526: 解決したのはこの保存の試行だけ。別アカウントの試行は残す。
        delete createKeysRef.current[wantAccount]
        setConflictId(null)
        /*
          R76。作ったあとも新規のまま残すと、時刻を直してもう一度押したときに
          更新ではなく別の定期配信が増える。作りたての編集画面へ移せば、
          次の保存は更新（PUT）になる。
          R454: 1回だけ送る場合も、その依頼の結果画面へ移す。
          一覧からは消えるため、結果の行き先をここで渡す。
        */
        if (sendOnce) {
          notifyToast(response.replayed
            ? '依頼は既に受け付けられていました。作り直さず、既にある依頼の結果を開きました。'
            : '1回だけ送る依頼を受け付けました。結果はこの画面で確認できます。')
          router.push(`/analytics/reports/new?id=${response.data.id}`)
        } else {
          notifyToast(response.replayed
            ? '予約は既に作られていました。作り直さず、既にある予約を開きました。内容を確認してください。'
            : `${nextLabel}から届く定期レポートを作りました。`)
          router.push(`/analytics/reports/new?id=${response.data.id}`)
        }
      }
      return true
    } catch (caught) {
      if (!isFresh()) return
      setError(describeSaveFailure(caught))
      return false
    } finally {
      if (submitLock.current === lock) submitLock.current = null
      if (isFresh()) setSaving(false)
    }
  }

  /*
   * 「最新を読み込んで続ける」。取り直せた最新があればそのまま
   * 画面へ戻し、なければ読み直す。どちらも入力中の内容は最新で置き換わる。
   */
  const applySchedule = (schedule: AnalyticsReportSchedule) => {
    setEditing(schedule)
    setName(schedule.name)
    setSections(schedule.sections)
    setSavedAnalysisIds(schedule.savedAnalysisIds)
    setCadence(schedule.cadence)
    setWeekday(String(schedule.weekday ?? 1))
    setMonthDay(String(schedule.monthDay ?? 1))
    setSendTime(schedule.sendTime)
    setPeriodDays(String(schedule.periodDays))
    setStaffIds(schedule.recipients.filter((item) => item.kind === 'staff' && item.staffId).map((item) => item.staffId as string))
    setEmails(schedule.recipients.filter((item) => item.kind === 'email' && item.email).map((item) => item.email as string))
    setDashboardEnabled(schedule.channels.includes('dashboard'))
    setEmailEnabled(schedule.channels.includes('email'))
    setLineEnabled(schedule.channels.includes('line'))
    setAlertsEnabled(schedule.alertRules.length > 0)
    const drafts = defaultAlertDrafts(false)
    const extras: AnalyticsReportSchedule['alertRules'] = []
    for (const rule of schedule.alertRules) {
      const def = ALERT_RULE_DEFS.find((item) => item.metric === rule.metric && item.operator === rule.operator)
      if (def) drafts[def.id] = { enabled: true, threshold: String(rule.threshold), minimumSample: String(rule.minimumSample) }
      else extras.push(rule)
    }
    setAlertDrafts(drafts)
    setExtraAlertRules(extras)
    setBaseline(JSON.stringify([
      schedule.name, schedule.sections, schedule.savedAnalysisIds, schedule.cadence,
      String(schedule.weekday ?? 1), String(schedule.monthDay ?? 1), schedule.sendTime, String(schedule.periodDays),
      schedule.recipients.filter((item) => item.kind === 'staff' && item.staffId).map((item) => item.staffId as string),
      schedule.recipients.filter((item) => item.kind === 'email' && item.email).map((item) => (item.email as string).trim()).filter(Boolean),
      schedule.channels.includes('dashboard'), schedule.channels.includes('email'), schedule.channels.includes('line'),
      schedule.alertRules.length > 0, drafts, extras,
    ]))
    setUpdateConflict(false)
    setConflictLatest(null)
    setCompareOpen(false)
    setCompareError('')
    setError('')
  }

  const reloadLatest = async () => {
    if (!selectedAccountId || !editing || saving || conflictBusyRef.current) return
    conflictBusyRef.current = true
    const actionSeq = ++conflictActionSeq.current
    const targetSeq = switchSeqRef.current
    const isCurrent = () => actionSeq === conflictActionSeq.current
      && targetSeq === switchSeqRef.current
      && accountRef.current === selectedAccountId && editIdRef.current === editId
    setLatestBusy(true)
    setCompareError('')
    setError('')
    try {
      const response = await api.analytics.reportSchedules.list(selectedAccountId)
      if (!isCurrent()) return
      const found = response.success ? response.data.items.find((item) => item.id === editing.id && !item.isOneTime) : undefined
      if (!found || !response.success) throw new Error('最新の内容を読み込めませんでした。入力は残っています。もう一度お試しください。')
      setOptions(response.data.options)
      applySchedule(found)
    } catch {
      if (!isCurrent()) return
      const message = '最新の内容を読み込めませんでした。入力は残っています。もう一度お試しください。'
      setError(message)
      setCompareError(message)
    } finally {
      if (isCurrent()) {
        setLatestBusy(false)
        conflictBusyRef.current = false
      }
    }
  }

  /*
   * 「比べてから保存」→比べる窓の「この内容で保存する」。
   * 比べたうえで、取り直した最新の版つきで保存し直す（相手の変更のうえに
   * 重ねる危ない操作なので、比べる窓の中からだけ押せる）。入力は残す。
   * 失敗したら窓は閉じず、その場で理由を出してもう一度押せる。
   */
  const saveOverLatest = async () => {
    if (!selectedAccountId || !options || !editing || !canManage || !updateConflict || saving || conflictBusyRef.current) return
    const built = buildReportPayload(options)
    if (!built.ok) { setCompareOpen(false); showValidation(built); return }
    conflictBusyRef.current = true
    const actionSeq = ++conflictActionSeq.current
    const targetSeq = switchSeqRef.current
    const mySeq = ++saveSeqRef.current
    latestAttemptRef.current = { seq: mySeq, key: `update:${editing.id}`, signature: JSON.stringify(built.payload) }
    const isCurrent = () => actionSeq === conflictActionSeq.current && targetSeq === switchSeqRef.current
      && accountRef.current === selectedAccountId && editIdRef.current === editId
      && latestAttemptRef.current?.seq === mySeq
    setCompareBusy(true)
    setCompareError('')
    try {
      const latest = await api.analytics.reportSchedules.list(selectedAccountId)
      if (!isCurrent()) return
      const found = latest.success ? latest.data.items.find((item) => item.id === editing.id && !item.isOneTime) : undefined
      if (!found || !latest.success) {
        setCompareError('最新の内容を読み込めませんでした。入力は残っています。「最新を読み込んで続ける」で試し直してください。')
        return
      }
      // 比較を開いた後の変更は未確認なので、この押下では上書きしない。
      if (!conflictLatest || found.updatedAt !== conflictLatest.updatedAt) {
        setConflictLatest(found)
        setOptions(latest.data.options)
        setCompareError('内容がさらに変更されました。違いを確認してから、もう一度保存してください。')
        return
      }
      const response = await api.analytics.reportSchedules.update(selectedAccountId, editing.id, {
        ...built.payload, expectedUpdatedAt: found.updatedAt,
      })
      if (!isCurrent()) return
      if (!response.success) throw new Error(response.error)
      setEditing(response.data)
      setUpdateConflict(false)
      setConflictLatest(null)
      setCompareOpen(false)
      setBaseline(JSON.stringify([
        name, sections, savedAnalysisIds, cadence, weekday, monthDay, sendTime, periodDays,
        staffIds.filter(Boolean), emails.map((item) => item.trim()).filter(Boolean),
        dashboardEnabled, emailEnabled, lineEnabled, alertsEnabled, alertDrafts, extraAlertRules,
      ]))
      notifyToast(`定期レポートを更新しました。次は${nextLabel}に届きます。`)
    } catch (caught) {
      if (!isCurrent()) return
      if (caught instanceof ApiError && caught.status === 409) {
        try {
          const retry = await api.analytics.reportSchedules.list(selectedAccountId)
          if (!isCurrent()) return
          if (retry.success) setConflictLatest(retry.data.items.find((item) => item.id === editing.id) ?? null)
        } catch { /* 入力と比較画面を残す。 */ }
        if (isCurrent()) setCompareError('ほかの人がさらに先に保存しました。比べ直してから、もう一度お試しください。')
        return
      }
      setCompareError(describeSaveFailure(caught))
    } finally {
      if (isCurrent()) {
        setCompareBusy(false)
        conflictBusyRef.current = false
      }
    }
  }

  /*
   * 「違いを比べる」の2つの文。最新が取れていないときは比べる窓を出さない。
   */
  const staffNameOf = (id: string) => options?.recipients.find((item) => item.id === id)?.name ?? id
  const savedNameOf = (id: string) => options?.savedAnalyses.find((item) => item.id === id)?.name ?? id
  const latestSummary = conflictLatest ? describeReportSummary({
    name: conflictLatest.name,
    sections: conflictLatest.sections,
    savedAnalysisIds: conflictLatest.savedAnalysisIds,
    cadence: conflictLatest.cadence,
    weekday: String(conflictLatest.weekday ?? 1),
    monthDay: String(conflictLatest.monthDay ?? 1),
    sendTime: conflictLatest.sendTime,
    periodDays: String(conflictLatest.periodDays),
    staffIds: conflictLatest.recipients.filter((item) => item.kind === 'staff' && item.staffId).map((item) => item.staffId as string),
    emails: conflictLatest.recipients.filter((item) => item.kind === 'email' && item.email).map((item) => item.email as string),
    channels: conflictLatest.channels,
    alertRules: conflictLatest.alertRules,
    staffName: staffNameOf,
    savedName: savedNameOf,
  }) : ''
  const parsedDraftAlerts = (): ReportSummaryInput['alertRules'] => {
    const rules: ReportSummaryInput['alertRules'] = []
    if (alertsEnabled) {
      for (const def of ALERT_RULE_DEFS) {
        const draft = alertDrafts[def.id]
        if (!draft?.enabled) continue
        const threshold = Number(draft.threshold)
        const minimumSample = Number(draft.minimumSample)
        if (!Number.isFinite(threshold) || !Number.isInteger(minimumSample)) continue
        rules.push({ metric: def.metric, operator: def.operator, threshold, minimumSample })
      }
      for (const rule of extraAlertRules) rules.push(rule)
    }
    return rules
  }
  const draftSummaryInput: ReportSummaryInput = {
    name, sections, savedAnalysisIds, cadence, weekday, monthDay, sendTime, periodDays,
    staffIds, emails: emails.map((item) => item.trim()).filter(Boolean),
    channels: [
      ...(dashboardEnabled ? ['dashboard'] : []),
      ...(emailEnabled ? ['email'] : []),
      ...(lineEnabled ? ['line'] : []),
    ],
    alertRules: parsedDraftAlerts(),
    staffName: staffNameOf,
    savedName: savedNameOf,
  }
  const draftSummary = describeReportSummary(draftSummaryInput)
  const oneTimeSummary = describeReportSummary(draftSummaryInput, true)

  /*
   * つくる・なおし途中の離脱確認。基準（初期値または読み直した値）から
   * 変わっていたら、キャンセルや左メニューで確認窓を出す。空の宛先行は
   * 数えない。保存・送信が終わると別画面へ router.push するので、
   * 成功後に警告は出ない。
   */
  const signature = JSON.stringify([
    name, sections, savedAnalysisIds, cadence, weekday, monthDay, sendTime, periodDays,
    staffIds.filter(Boolean),
    emails.map((item) => item.trim()).filter(Boolean),
    dashboardEnabled, emailEnabled, lineEnabled, alertsEnabled, alertDrafts, extraAlertRules,
  ])
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: baseline !== null && signature !== baseline,
    busy: saving || compareBusy || latestBusy,
  })

  if (accountLoading || loading) return <ListState kind="loading" title="定期レポートを読み込んでいます" />
  if (!selectedAccountId) return <ListState kind="empty" title="LINE公式アカウントを選んでください" description="上のバーで、レポートを作るLINE公式アカウントを選んでください。" />
  // 一覧の取得失敗を「見つかりません」へ化けさせない。一時障害はやり直せる画面を先に出す。
  if (error && !options) return <ListState kind="error" title="定期レポートを表示できませんでした" description={error} onRetry={() => setReloadSeq((n) => n + 1)} />
  // R454: 1回送信の依頼は結果の表示にする（しまうと一覧から消えるため）。
  if (oneTime && selectedAccountId) {
    return (
      <OneTimeResultView
        accountId={selectedAccountId}
        schedule={oneTime.schedule}
        runs={oneTime.runs}
        canManage={canManage}
        onRetryDone={() => setReloadSeq((n) => n + 1)}
      />
    )
  }
  if (editLoadFailed) return <ListState kind="error" title="定期レポートを表示できませんでした" description="通信が切れたか、サーバーが応えませんでした。もう一度読み込んでください。" onRetry={() => setReloadSeq((n) => n + 1)} />
  if (editMissing || (editing === null && editId)) return <ListState kind="error" title="定期レポートが見つかりませんでした" description="一覧から選び直してください。" />
  if (editing?.isOneTime) return <ListState kind="empty" title="1回だけ送る依頼は変更できません" description="同じ内容が必要なときは、新しく作ってください。" />
  if (!options) return (
    <ListState
      kind="empty"
      title="受け取るログインユーザーがいません"
      description="先に、受け取る人をログインユーザーへ追加してください。"
      action={<Button href="/staff">ログインユーザーを確認する</Button>}
    />
  )

  return (
    <div className="report-v8-page" ref={reportRef} data-design-node={updateConflict ? 'G83vi' : 'H5UoIu'}>
      <CreatePage
        boardId={updateConflict ? 'G83vi' : 'H5UoIu'}
        title={editing ? '定期レポートを直す' : 'レポートを作る'}
        help="見たい数をまとめて、決まった曜日・時刻に LINE やメールで届けます。数が急に動いたときだけ知らせることもできます。"
        readOnly={!canManage}
        contentDisabled={!canManage || saving || compareBusy || latestBusy}
        contentLabel="レポートの設定"
        notice={updateConflict ? <Notice tone="warn" role="alert"
          heading={conflictLatest ? <>ほかの人が <time dateTime={conflictLatest.updatedAt} title={formatDateTime(conflictLatest.updatedAt)}>{formatTime(conflictLatest.updatedAt)}</time> にこのレポートを保存しました</> : 'ほかの人がこのレポートを先に保存しました'}
          action={<>
            {conflictLatest && <Button variant="secondary" disabled={saving || latestBusy || compareBusy} onClick={() => { setCompareError(''); setCompareOpen(true) }}><GitCompareArrows size={16} aria-hidden="true" />違いを比べる</Button>}
            <Button variant="secondary" disabled={saving || latestBusy || compareBusy} busy={latestBusy} busyLabel="読み込んでいます" onClick={() => void reloadLatest()}><RefreshCw size={16} aria-hidden="true" />最新を読み込んで続ける</Button>
          </>}>
          このまま保存すると、相手の変更が消えます。入力は残っています。
        </Notice> : null}
        dirty={false}
        previewLabel="レポートの見本を見る"
        previewTitle="レポートの見本"
        preview={        <>
          <Card variant="aside">
            <CardHeader size="stacked" title={`${nextLabel} に、こう届きます`} meta="見本" />
            <Card surface="muted" corner="control" padding="compact" layout="vertical" gap="tight"><p className="report-v8-previewTitle">{name.trim() || '（名前なし）'}（前の{periodDays}日）</p>{sections.filter((id) => id !== 'usage').map((id) => <p className="report-v8-previewRow" key={id}>{PREVIEW_LABEL[id] ?? sectionTitleOf(id)} <strong>{previewNumbers[id] ?? '送信時に集計'}</strong></p>)}{Object.keys(previewNumbers).length > 0 ? <p className="report-v8-previewMore">これは前の{periodDays}日の数での見本です</p> : null}<p className="report-v8-previewMore">くわしくは musubo の分析で</p></Card>
          </Card>
          <Card variant="aside"><CardHeader size="stacked" title="レポートが見ているもの" /><p className="report-v8-kvRow">LINE アカウント <strong>{selectedAccount?.name ?? '選択中のアカウント'}</strong></p><p className="report-v8-kvRow">保存した分析 <strong>{formatNumber(savedAnalysisIds.length)} 件</strong></p></Card>
          <Card variant="aside"><CardHeader size="stacked" title="気をつけること" /><ul className="report-v8-notes"><li>数は送る時刻の時点で集めます</li><li>宛先がブロックしていると、LINE では届きません</li></ul></Card>
        </>}
        footerActions={<>
        <Button href="/analytics">キャンセル</Button>
        {/* 閲覧のみには隠さず灰色＋理由で出す。 */}
        {!editing && <PermissionGatedButton allowed={canManage} variant="secondary" disabled={saving || !canManage || !hasRecipient || hasInvalidEmail} title={submitDisabledReason} onClick={() => { const built = buildReportPayload(options); if (!built.ok) { showValidation(built); return }; if (!selectedAccountId) return; sendOnceScope.current = { accountId: selectedAccountId, generation: scope.current.generation }; setError(''); setSendOnceOpen(true) }}>今すぐ1回だけ送る</PermissionGatedButton>}
        {<PermissionGatedButton allowed={canManage} variant="primary" disabled={saving || !canManage || !hasRecipient || hasInvalidEmail} title={submitDisabledReason} onClick={() => { if (editing && updateConflict) { setCompareError(''); setCompareOpen(true) } else void submit(false) }} busy={saving} busyLabel={editing ? '保存しています' : '作っています'}><Check size={16} aria-hidden="true" />{editing ? (updateConflict ? '比べてから保存' : '変更を保存する') : 'つくって動かす'}</PermissionGatedButton>}
      </>}
      >
      {!canManage && <Notice tone="info" message="運用担当は内容を確認できます。作成は統括または管理者が行います。" />}
      {error && <Notice tone="danger" message={error} onClose={() => setError('')} />}
      {conflictId && (
        <Notice tone="warn" onClose={() => setConflictId(null)} action={<>
          <Button variant="secondary" href={`/analytics/reports/new?id=${encodeURIComponent(conflictId)}`}>既にある予約を確認</Button>
          <Button variant="secondary" onClick={() => { delete createKeysRef.current[selectedAccountId]; setConflictId(null) }}>内容を変えた新しい予約として作り直す</Button>
        </>}>
          同じ操作で作った予約が既にあります。内容を変えて送り直したため、新しい予約は作りませんでした。
        </Notice>
      )}

          <Card variant="form" gap="normal">
            <CardHeader size="stacked" title="名前を付けます" />
            <Field label="名前" required><TextField id="report-name" aria-describedby={nameError ? 'report-name-error' : undefined} value={name} onChange={(event) => { setName(event.target.value); setNameError(''); setValidation(null) }} placeholder="例：週次まとめ" aria-invalid={nameError ? true : undefined} /></Field>
            {nameError && <p id="report-name-error" className="report-v8-fieldError" role="alert">{nameError}</p>}
          </Card>
          <Card variant="form" gap="normal">
            {/* 絵に無い「使われ方」は、段の頭の右に小さく置く（落とさない）。 */}
            <CardHeader size="stacked" title="何を入れますか" help={<HelpTip label="レポートに入れるもの">チェックしたものが、この順にレポートへ並びます。</HelpTip>}
              action={<Checkbox checked={sections.includes('usage')} onCheckedChange={() => toggleSection('usage')}>使われ方も入れる</Checkbox>} />
            <div className="report-v8-sectionCards">
              {SECTION_CHOICES.filter((choice) => choice.id !== 'usage').map((choice) => {
                const checked = sections.includes(choice.id)
                const locked = Boolean(choice.unavailable) && !checked
                return <Card surface="inset" corner="control" padding="compact" layout="vertical" gap="tight" key={choice.id}>
                  <Checkbox checked={checked} disabled={locked} onCheckedChange={() => toggleSection(choice.id)} description={<span title={choice.unavailable}>{choice.detail}{choice.unavailable && <>（{choice.unavailable}）</>}</span>}>{choice.unavailable ? <span className="report-v8-sectionTitle">{choice.title} <StatusBadge tone="neutral">未集計</StatusBadge></span> : choice.title}</Checkbox>
                </Card>
              })}
            </div>
          </Card>
          <Card variant="form" gap="normal">
            <CardHeader size="stacked" title="保存した分析を添えます" meta="選んだ分析は、そのときの数で添えます" />
            <EntitySelect aria-label="保存した分析" noun="保存した分析" values={savedAnalysisIds} onChange={setSavedAnalysisIds} readOnly={!canManage} options={options.savedAnalyses.map((item) => ({ value: item.id, label: item.name, description: item.kind === 'cross' ? 'クロス分析' : 'ファネル' }))} />
          </Card>
          <Card variant="form" gap="normal">
            <CardHeader size="stacked" title={<>だれに送りますか <RequiredBadge /></>} />
            {editing && editing.recipients.some((item) => item.kind === 'staff' && item.staffId && !options.recipients.some((person) => person.id === item.staffId)) && <Notice tone="warn" message={`前に選んでいた${editing.recipients.filter((item) => item.kind === 'staff' && item.staffId && !options.recipients.some((person) => person.id === item.staffId)).map((item) => `「${item.label}」`).join('・')}は、いまは受け取れません（利用停止・閲覧範囲外の可能性があります）。このまま保存すると宛先から外れます。`} />}
            <EntitySelect aria-label="レポートを受け取る人" noun="担当者" values={staffIds} onChange={setStaffIds} readOnly={!canManage} candidatesStatus="ready" options={options.recipients.map((person) => ({ value: person.id, label: person.name, description: `${ROLE_LABEL[person.role]}${person.lineLinked ? ' ／ LINE連携済み' : ''}` }))} />
            <div className="report-v8-chips">
              {emails.map((email, index) => email.trim() && <span className="report-v8-chip" key={index}><span className="report-v8-chipText" title={email}>{email}（メール）</span>{canManage && <CloseButton className="report-v8-chipRemove" aria-label={`${email}を宛先から外す`} onClick={() => setEmails((current) => current.filter((_, value) => value !== index))} />}</span>)}
              {!hasRecipient && <span className="report-v8-chipEmpty">受け取る人を1人以上選んでください。選ぶまで作れません。</span>}
            </div>
            <div className="report-v8-linkRow">
              {canManage && <button type="button" className="report-v8-addLink" aria-expanded={recipientsOpen} onClick={() => setRecipientsOpen((open) => !open)}>＋ 宛先を足す</button>}
              {/* 絵に無い「通知方法」は、宛先の行の右に小さく置く（開くと下に選ぶ欄）。 */}
              <button type="button" className="report-v8-sideLink" aria-expanded={channelsOpen} onClick={() => setChannelsOpen((open) => !open)}>通知方法：{[dashboardEnabled ? '管理画面' : '', emailEnabled ? 'メール' : '', lineEnabled ? 'LINE' : ''].filter(Boolean).join('・') || '未選択'}<ChevronDown size={16} aria-hidden="true" /></button>
            </div>
            <div className="report-v8-panel" hidden={!recipientsOpen && !hasInvalidEmail}>
              <ul className="report-v8-recipients divide-y divide-hairline" aria-label="レポートを受け取る人">
                {emails.map((email, index) => <li className="report-v8-recipient" key={index}>
                  <div className="report-v8-emailRow"><TextField id={`report-email-${index}`} type="email" value={email} onChange={(event) => setEmails((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="report@example.com" aria-label={`宛先のメールアドレス ${index + 1}行目`} aria-invalid={invalidEmails[index] ? true : undefined} /><Button size="compact" aria-label={`${index + 1}行目の宛先を消す`} onClick={() => setEmails((current) => current.filter((_, itemIndex) => itemIndex !== index))}>消す</Button></div>
                  {invalidEmails[index] && <p className="report-v8-fieldError" role="alert">「{invalidEmails[index]}」はメールアドレスの形になっていません。この宛先だけ外れないよう、直すか消してください。</p>}
                </li>)}
              </ul>
              <Button variant="secondary" onClick={() => setEmails((current) => [...current, ''])}>メールだけの宛先を足す</Button>
            </div>
            {hasInvalidEmail && <p className="report-v8-fieldError">形が正しくない宛先があるため、いまのままでは作れません。</p>}
            <div className="report-v8-panel" hidden={!channelsOpen}>
              <div className="report-v8-sectionCards" role="group" aria-label="通知方法" onChange={() => setValidation(null)}>
                <Checkbox id="report-channels" invalid={!!fieldMessage('report-channels')} error={fieldMessage('report-channels')} checked={dashboardEnabled} onCheckedChange={setDashboardEnabled} description="運用状態のお知らせに残します。"><strong>管理画面のお知らせにも出す</strong></Checkbox>
                <Checkbox checked={emailEnabled} onCheckedChange={setEmailEnabled} description="宛先のメールアドレスへ送ります。担当者のメールもここで送ります。"><strong>メールでも送る</strong></Checkbox>
                <Checkbox checked={lineEnabled} onCheckedChange={setLineEnabled} description="ログインユーザーのLINEに、要点だけを短くまとめて送ります。"><strong>LINEでも同じ内容を送る</strong></Checkbox>
              </div>
            </div>
          </Card>
          <Card variant="form" gap="normal">
            <CardHeader size="stacked" title="いつ送りますか" help={<HelpTip label="送信時刻の基準">時刻は {options.timeZone} で計算します。</HelpTip>} />
            <SettingsFormRow layout="columns">
              <Field label="間かく" required><Select aria-label="間かく" value={cadence} onChange={(value) => setCadence(value as 'weekly' | 'monthly')} options={[{ value: 'weekly', label: '毎週' }, { value: 'monthly', label: '毎月' }]} size="full" /></Field>
              {cadence === 'weekly' ? <Field label="送る曜日" required><Select aria-label="送る曜日" value={weekday} onChange={setWeekday} options={WEEKDAY_JA.map((day, value) => ({ value: String(value), label: `${day}曜` }))} size="full" /></Field> : <Field label="送る日" required><Select aria-label="送る日" value={monthDay} onChange={setMonthDay} options={Array.from({ length: 28 }, (_, index) => ({ value: String(index + 1), label: `${index + 1}日` }))} size="full" /></Field>}
              <Field label="送る時刻" required><TimeField id="report-send-time" invalid={!!fieldMessage('report-send-time')} aria-describedby={fieldMessage('report-send-time') ? 'report-send-time-error' : undefined} value={sendTime} onChange={(value) => { setSendTime(value); setValidation(null) }} aria-label="送る時刻" />{fieldMessage('report-send-time') && <p id="report-send-time-error" className="report-v8-fieldError" role="alert">{fieldMessage('report-send-time')}</p>}</Field>
              <Field label="集計する期間" required><PeriodPicker days={Number(periodDays)} onChange={(days) => setPeriodDays(String(days))} /></Field>
            </SettingsFormRow>
          </Card>
          <Card variant="form" gap="normal">
            {/* 全体の入り切りは段の頭の右に小さく置く（絵は条件ごとのチェックだけ）。 */}
            <CardHeader size="stacked"
              title="知らせの決めごと" help={<HelpTip label="変化の判定">前の期間と比べ、条件に合えばレポートに含めて知らせます。集計待ちや一部だけ取れた期間は比べません。</HelpTip>}
              meta="数が急に動いたときだけ、すぐに知らせます。少ない数でさわがないよう、最低件数も決めます"
              action={<Checkbox id="report-alerts-enabled" invalid={!!fieldMessage('report-alerts-enabled')} aria-describedby={fieldMessage('report-alerts-enabled') ? 'report-alerts-enabled-error' : undefined} checked={alertsEnabled} onCheckedChange={setAlertsEnabled}>大きな変化を知らせる</Checkbox>} />
            {fieldMessage('report-alerts-enabled') && <p id="report-alerts-enabled-error" className="report-v8-fieldError" role="alert">{fieldMessage('report-alerts-enabled')}</p>}
            <ul className="report-v8-alerts" onChange={() => setValidation(null)}>
              {[...ALERT_RULE_DEFS].sort((a, b) => (a.id === 'friend_adds' ? -1 : b.id === 'friend_adds' ? 1 : 0)).map((def) => {
                const draft = alertDrafts[def.id]
                const fieldsDisabled = !alertsEnabled || !draft.enabled
                return <li key={def.id}><Card surface="inset" corner="control" padding="compact" layout="vertical" gap="var(--polish-space-field)">
                  <Checkbox checked={draft.enabled} disabled={!alertsEnabled} title={!alertsEnabled ? '「大きな変化を知らせる」をオンにすると選べます' : undefined} aria-label={`${def.name}を使う`} onCheckedChange={(checked) => setAlertDrafts((current) => ({ ...current, [def.id]: { ...current[def.id], enabled: checked } }))}><strong>{def.id === 'friend_adds' ? '友だちが減った' : def.id === 'block_rate' ? 'ブロックが増えた' : '成果が0件のまま続いた'}</strong></Checkbox>
                  <SettingsFormRow layout="columns">
                    <Field label={def.id === 'conversions' ? '続いた日数' : def.id === 'block_rate' ? 'ブロック率のしきい値' : 'しきい値'} required><NumberInput unit={def.id === 'conversions' ? '日' : '%'} id={`report-alert-${def.id}-threshold`} aria-invalid={!!fieldMessage(`report-alert-${def.id}-threshold`) || undefined} aria-describedby={fieldMessage(`report-alert-${def.id}-threshold`) ? `report-alert-${def.id}-threshold-error` : undefined} type="number" min={0} step={def.step} inputMode="decimal" aria-label={def.thresholdLabel} value={draft.threshold} disabled={fieldsDisabled} onChange={(event) => setAlertDrafts((current) => ({ ...current, [def.id]: { ...current[def.id], threshold: event.target.value } }))} />{fieldMessage(`report-alert-${def.id}-threshold`) && <p id={`report-alert-${def.id}-threshold-error`} className="report-v8-fieldError" role="alert">{fieldMessage(`report-alert-${def.id}-threshold`)}</p>}</Field>
                    <Field label="判定に必要な最低件数" required help="集計できた件数が、この数以上のときだけ判定します。"><NumberInput unit="件" id={`report-alert-${def.id}-sample`} aria-invalid={!!fieldMessage(`report-alert-${def.id}-sample`) || undefined} aria-describedby={fieldMessage(`report-alert-${def.id}-sample`) ? `report-alert-${def.id}-sample-error` : undefined} type="number" min={1} step={1} inputMode="numeric" aria-label={def.sampleLabel} value={draft.minimumSample} disabled={fieldsDisabled} onChange={(event) => setAlertDrafts((current) => ({ ...current, [def.id]: { ...current[def.id], minimumSample: event.target.value } }))} />{fieldMessage(`report-alert-${def.id}-sample`) && <p id={`report-alert-${def.id}-sample-error`} className="report-v8-fieldError" role="alert">{fieldMessage(`report-alert-${def.id}-sample`)}</p>}</Field>
                  </SettingsFormRow>
                </Card></li>
              })}
            </ul>
          </Card>
      </CreatePage>
      <Dialog open={compareOpen} title="違いを比べる" description="「－」が相手の最新の内容から消える行、「＋」があなたの入力で増える行です。このまま保存すると、相手の変更のうえに重ねて保存します。" onCancel={() => { if (!compareBusy && !latestBusy) setCompareOpen(false) }} footer={<DialogActions><Button variant="secondary" disabled={compareBusy || latestBusy} busy={latestBusy} busyLabel="読み込んでいます" onClick={() => void reloadLatest()}>最新を読み込んで続ける</Button><Button variant="primary" disabled={compareBusy || latestBusy || !canManage} onClick={() => void saveOverLatest()} busy={compareBusy} busyLabel="保存しています">この内容で保存する</Button></DialogActions>} error={compareError || undefined} busy={compareBusy || latestBusy}>
        <VersionCompare before={latestSummary} after={draftSummary} />
      </Dialog>
      <ConfirmDialog open={sendOnceOpen && canManage && renderedSendOnceScope?.generation === scope.current.generation} title="レポートを今すぐ1回だけ送りますか？" description="次の宛先と通知方法で送る依頼を作ります。" confirmLabel="この宛先へ1回だけ送る" busy={saving} onCancel={() => { if (!saving) setSendOnceOpen(false) }} error={error || undefined} confirmDisabled={updateConflict || Boolean(conflictId)} confirmDisabledReason="閉じて最新の内容を確認してください。" onSuccess={() => setSendOnceOpen(false)} onConfirm={() => { if (!alive.current || !canManageRef.current || !renderedSendOnceScope || renderedSendOnceScope !== sendOnceScope.current || renderedSendOnceScope.generation !== scope.current.generation) return; return submit(true) }}>
        {renderedSendOnceScope ? <OperationTargetSummary accounts={[{ id: renderedSendOnceScope.accountId }]} /> : null}
        <p className="whitespace-pre-wrap break-words">{oneTimeSummary}</p>
      </ConfirmDialog>
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力した定期レポート" onConfirm={confirmLeave} onCancel={cancelLeave} />
    </div>
  )
}

export default function AnalyticsReportNewPage() {
  // useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。
  return (
    <Suspense fallback={<div className="text-ink-faint p-6 text-sm">読み込み中…</div>}>
      <AnalyticsReportFormPage />
    </Suspense>
  )
}
