'use client'

import { knownValue } from '@/lib/known-value'
import TextLink from '@/components/shared/text-link'
import { LINE_TOKEN_REFRESH_DAYS } from '@line-crm/shared'
import { useRunningVersion } from '@/lib/use-running-version'

import { operationFailureText } from './health-error'
import TruncatedText from '@/components/shared/truncated-text'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from '@/components/shared/list-navigation'
import Button from '@/components/shared/button'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { api, type LineWebhookRecoveryEvent, type OperationAlert, type OperationHealthCheckKey, type OperationHealthSnapshot, type OperationHistoryEntry } from '@/lib/api'
import { formatOperationDate, type OperationSeverity } from '@/lib/operation-status'
import { formatMinutesRough } from '@/lib/format-duration'
import { onlyWhenVisible } from '@/lib/visible-polling'
import styles from './screen.module.css'
import Notice from '@/components/shared/notice'
import { japaneseDetailOf, describeApiFailure } from '@/components/shared/api-error-message'
import { formatTime as polishFormatTime, formatDate as polishFormatDate, formatNumber } from '@/lib/format'
import { formatElapsedMinutes } from '@/lib/format-duration'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/*
 * ★V8 運用状態 健全性チェック（Pencil ）。
 *
 * 現役の健全性と異常の受領・通知をここに集める。絵の並びは：上の「全体の状態」の帯／表の上に「開いている異常」／9行の表／下の3枚。
 * 動き（初回だけ読み込み中・5分ごとの取り直し・手動確認の世代照合・受領・通知のやり直し・
 * 古い確認と未確認の言い分け・アカウント切替の見張り）は同じ。
 */

// 全文（release-log.json）ではなく要約を読む（V6R-S3-a）。

const HISTORY_FETCH_LIMIT = 200

type ControlMessage = { tone: 'success' | 'warning' | 'danger'; text: string }

type HealthCheckId = 'line' | 'quota' | 'api' | 'webhook' | 'delivery' | 'friends' | 'monitoring' | 'infra' | 'credential'

interface HealthCheckItem {
  id: HealthCheckId
  title: string
  sub: string
  severity: OperationSeverity
  /** 判定の見方。 */
  threshold: string
  /** 注意・エラーのときの中身（口の summary）。判定の見方の欄に出す。 */
  summary: string | null
  href: string
  observedAt: string | null
  /** 前回の確認が古い（A32-01）。「未確認」とは分ける。 */
  stale: boolean
}

/** 板  の9行。並び・言葉は板が正本。 */
const CHECK_DEFINITIONS: Array<Pick<HealthCheckItem, 'id' | 'title' | 'sub' | 'threshold' | 'href'>> = [
  { id: 'line', title: 'LINE のアカウントとつながっているか', sub: 'アカウント', threshold: 'LINE の確認で問題が出ると「注意」・重いと「エラー」', href: '/accounts' },
  { id: 'monitoring', title: '5分ごとの確認が動いているか', sub: '自動確認', threshold: '10分（2回分）止まると「エラー」', href: '/emergency?tab=health' },
  { id: 'api', title: 'API・外部連携', sub: 'EC連携・外部連携', threshold: '取り込みの失敗が続くと「注意」', href: '/ec-commerce' },
  { id: 'quota', title: '送れる数の上限', sub: 'LINE と musubo', threshold: '80%で「注意」・95%・予定分の超過で「エラー」', href: '/broadcasts' },
  { id: 'friends', title: '友だちの急な減り', sub: 'この1日', threshold: '1日で5%以上・10人以上減ると「注意」', href: '/friends' },
  { id: 'webhook', title: 'Webhook が届いているか', sub: 'LINE からの受け取り', threshold: '受け取りの失敗が続くと「注意」', href: '/webhooks' },
  { id: 'delivery', title: '配信が送れているか', sub: '予約・自動の配信', threshold: '10分の遅れで「注意」・30分で「エラー」', href: '/broadcasts/reserved' },
  { id: 'infra', title: '保存と送信のしくみ', sub: 'データ・ファイル・送る前の待ち', threshold: '10分より古いと「古い確認」・一度も確かめていなければ「未確認」', href: '/emergency?tab=health' },
  { id: 'credential', title: 'トークンの期限', sub: 'LINE接続とは別に確認', threshold: `自動交換の失敗・残り${LINE_TOKEN_REFRESH_DAYS}日未満で「注意」・期限切れで「エラー」`, href: '/accounts' },
]

const CHECK_COUNT = CHECK_DEFINITIONS.length

const HEALTH_CHECK_ID: Record<OperationHealthCheckKey, HealthCheckId> = {
  line_connection: 'line',
  message_quota: 'quota',
  external_integrations: 'api',
  webhook: 'webhook',
  dispatch_jobs: 'delivery',
  friend_change: 'friends',
  monitoring_heartbeat: 'monitoring',
  infra_canary: 'infra',
  credential_expiry: 'credential',
}

const CHECK_KEY_BY_ID = Object.fromEntries(
  Object.entries(HEALTH_CHECK_ID).map(([key, id]) => [id, key]),
) as Record<HealthCheckId, OperationHealthCheckKey>

const SEVERITY: Record<OperationSeverity, { label: string; tone: 'good' | 'warn' | 'danger' | 'muted' }> = {
  normal: { label: '正常', tone: 'good' },
  warning: { label: '注意', tone: 'warn' },
  danger: { label: 'エラー', tone: 'danger' },
  unknown: { label: '未確認', tone: 'muted' },
}

/** 札（点＋文字）。古い確認は灰。 */
export function StatusPill({ severity, stale = false }: { severity: OperationSeverity; stale?: boolean }) {
  const style = stale ? { label: '古い確認', tone: 'muted' as const } : SEVERITY[severity]
  const tones: Record<string, StatusBadgeTone> = { good: 'success', warn: 'warning', danger: 'danger', muted: 'neutral' }
  return <StatusBadge tone={tones[style.tone]}>{style.label}</StatusBadge>
}

const STALE_ITEM_AFTER_MS = 10 * 60 * 1000

function isOldCheck(observedAt: string | null | undefined, now = Date.now()): boolean {
  if (!observedAt) return false
  const time = Date.parse(observedAt)
  if (Number.isNaN(time)) return false
  return now - time > STALE_ITEM_AFTER_MS
}

/** 「最後の確認」。`10:15`。10分以上前なら `9:58（17分前）`。 */
function formatCheckedAt(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return '—'
  const clock = polishFormatTime(new Date(time))
  const minutes = Math.floor((now - time) / 60000)
  if (minutes < 10) return clock
  // E33：経過の言い方は共通の関数へ（切り捨て・48時間で日に直す）。
  return `${clock}（${formatElapsedMinutes(minutes)}）`
}

function formatMonthDayTime(iso: string | null | undefined): string {
  return polishFormatDate(iso, { style: 'detail', fallback: '' })
}

function formatDetectedSince(iso: string | null | undefined): string {
  const text = formatMonthDayTime(iso)
  return text ? `（${text}〜）` : ''
}

/** LINE行の補足。実数が取れれば「アカウント N 件」。数は作らない。 */
function lineSub(accountCount: number | null | undefined): string {
  return typeof accountCount === 'number' ? `アカウント ${formatNumber(accountCount)} 件` : 'アカウント'
}

function mostSevere(items: HealthCheckItem[]): OperationSeverity {
  if (items.some((item) => item.severity === 'danger')) return 'danger'
  if (items.some((item) => item.severity === 'warning')) return 'warning'
  if (items.some((item) => item.severity === 'unknown')) return 'unknown'
  return 'normal'
}

const ALERT_ACTION_LABEL: Record<OperationAlert['events'][number]['action'], string> = {
  opened: '検知', escalated: '悪化', acknowledged: '受領', resolved: '解消', reopened: '再発',
}

/* 異常が出たとき、運用者が最初に知りたい3つ（#1050）。可能性として書く（A32-01）。 */
const ALERT_RESPONSE_FIRST: Record<OperationHealthCheckKey, { impact: string; recovery: string; href: string }> = {
  line_connection: { impact: 'LINEへの返信や配信が止まっている可能性があります。', recovery: 'アカウント設定でLINE接続を確認し直してください。', href: '/accounts' },
  message_quota: { impact: '配信が途中で止まる可能性があります。', recovery: '配信数を減らすか、月の更新を待ってください。', href: '/broadcasts' },
  external_integrations: { impact: 'EC連携など外部とのやり取りが止まっている可能性があります。', recovery: '連携設定を確認し、止まっている連携を再設定してください。', href: '/ec-commerce' },
  webhook: { impact: '外部システムへの通知が届いていない可能性があります。', recovery: '合言葉と送信先を確認し、失敗した通知を再送してください。', href: '/webhooks' },
  dispatch_jobs: { impact: '予約した配信が時刻どおりに出ていない可能性があります。', recovery: '緊急コントロールで止めたままになっていないか確認してください。', href: '/emergency?tab=control' },
  friend_change: { impact: '友だちが急に減っている可能性があります。誤配信やブロックが原因の可能性があります。', recovery: '直近の配信内容を確認し、必要なら緊急停止してください。', href: '/emergency?tab=control' },
  monitoring_heartbeat: { impact: '異常があっても通知されない可能性があります。', recovery: '時間をおいても直らなければ、運営へ連絡してください。', href: '/emergency?tab=health' },
  infra_canary: { impact: '配信・保存・画面表示が止まる可能性があります。', recovery: '時間をおいて再確認し、続く場合は運営へ連絡してください。', href: '/emergency?tab=health' },
  credential_expiry: { impact: '期限切れ後はLINEとのやり取りが止まる可能性があります。', recovery: 'アカウント設定でトークンの期限を確認し直してください。', href: '/accounts' },
}

/** 表の上の「開いている異常」。受領（メモつき）・通知のやり直し。異常なしと「読めない」を混同しない。 */
export function OpenAlerts({
  alerts,
  failed,
  busyId,
  canManage,
  onAcknowledge,
  onRetry,
}: {
  alerts: OperationAlert[]
  failed: boolean
  busyId: string | null
  canManage: boolean
  onAcknowledge: (alert: OperationAlert, note: string) => Promise<void>
  onRetry: (alert: OperationAlert) => Promise<void>
}) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [openNoteId, setOpenNoteId] = useState<string | null>(null)
  if (failed) return <p className={styles.alertsNote} role="status">異常の受領・通知記録を読み込めませんでした。異常なしとは扱いません。時間をおいて読み直してください。</p>
  if (alerts.length === 0) return <p className={styles.alertsNote}>異常の記録はありません。健全性チェックで新しい異常が見つかると、ここで担当者と通知結果を確認できます。</p>
  return (
    <section className={styles.alerts} aria-label="開いている異常">
      <h2 className={styles.alertsTitle}>{`開いている異常 ${formatNumber(alerts.length)} 件`}</h2>
      <div className={styles.alertRows}>
        {[...alerts].sort((a, b) => {
          const rank = { danger: 0, warning: 1, unknown: 2 }
          const priority = rank[a.severity] - rank[b.severity]
          if (priority) return priority
          const time = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0 }
          return time(b.lastDetectedAt) - time(a.lastDetectedAt)
        }).map((alert) => {
          const busy = busyId === alert.id
          const lastEvent = alert.events[0]
          const notification = alert.notification.unconfigured > 0
            ? `${alert.notification.unconfigured} 件の通知先が未設定です。担当者または連絡先を設定して再確認できます。`
            : alert.notification.failed > 0
              ? `${formatNumber(alert.notification.failed)} 件の通知が送れませんでした。再送できます。`
              : alert.notification.total === 0
                ? '通知の準備を確認しています。'
                : alert.notification.queued + alert.notification.sending > 0
                  ? '通知を送っています。'
                  : `${formatNumber(alert.notification.sent)} 件の通知を送信しました。`
          const response = ALERT_RESPONSE_FIRST[alert.checkKey]
          const checkTitle = CHECK_DEFINITIONS.find((item) => HEALTH_CHECK_ID[alert.checkKey] === item.id)?.sub ?? alert.checkKey
          const detail = [
            lastEvent ? `${knownValue(ALERT_ACTION_LABEL, lastEvent.action, '状態を確認できません')}：${formatOperationDate(lastEvent.createdAt)}` : formatOperationDate(alert.lastDetectedAt),
            notification,
            alert.status !== 'resolved' && response ? `お客さまへの影響：${alert.severity === 'unknown' ? 'この項目はまだ確認できていないため、影響の有無も未確認です。' : response.impact}` : null,
            `担当：${alert.acknowledgedById ?? 'まだ受領されていません'}`,
            response ? `直し方：${response.recovery}` : null,
          ].filter(Boolean).join('\n')
          const canRetry = alert.notification.failed + alert.notification.unconfigured > 0
          return (
            <div key={alert.id} className={styles.alertRow}>
              <div className={styles.alertLine}>
                <StatusPill severity={alert.severity} />
                <p className={styles.alertText} title={detail}>{`${checkTitle}：${alert.summary}${formatDetectedSince(alert.firstDetectedAt)}`}</p>
                {alert.status === 'acknowledged' ? <StatusBadge tone="info">受領済み</StatusBadge> : alert.status === 'resolved' ? <StatusBadge tone="info">解消済み</StatusBadge> : null}
                {response ? <Link href={response.href} className={styles.srOnly}>対象画面へ</Link> : null}
                {canManage && alert.status === 'open' ? (
                  <Button variant="secondary" disabled={busy} busy={busy} onClick={() => {
                    if (openNoteId !== alert.id) { setOpenNoteId(alert.id); return }
                    void onAcknowledge(alert, notes[alert.id] ?? '')
                  }}>
                    {openNoteId === alert.id ? '受領を記録する' : '受領する'}
                  </Button>
                ) : null}
                {canManage ? (
                  <Button variant="secondary" disabled={busy || !canRetry} title={canRetry ? undefined : 'やり直せる通知はありません'}  onClick={() => void onRetry(alert)}>
                    {alert.notification.unconfigured > 0 ? '通知先を再確認する' : '通知をやり直す'}
                  </Button>
                ) : null}
              </div>
              {openNoteId === alert.id && alert.status === 'open' ? (
                <Field label="受領メモ。「受領を記録する」で記録します。" htmlFor={`operation-alert-note-${alert.id}`}><SaveErrorField names={["notes"]}><SharedTextField
                    id={`operation-alert-note-${alert.id}`}
                    value={notes[alert.id] ?? ''}
                    maxLength={500}
                    onChange={(event) => setNotes((current) => ({ ...current, [alert.id]: event.target.value }))}
                    disabled={busy}
                  /></SaveErrorField></Field>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function HealthPanelV8({
  accountId,
  manualRunRequest,
  onSeverity,
  onManualRunSettled,
  accountCount = null,
  canManage,
}: {
  accountId: string | null
  manualRunRequest: number
  onSeverity: (severity: OperationSeverity) => void
  onManualRunSettled?: () => void
  accountCount?: number | null
  canManage: boolean
}) {
  const runningVersion = useRunningVersion()
  const blankChecks = useCallback((): HealthCheckItem[] => CHECK_DEFINITIONS.map((item) => ({
    ...item,
    sub: item.id === 'line' ? lineSub(accountCount) : item.sub,
    severity: 'unknown',
    summary: null,
    observedAt: null,
    stale: false,
  })), [accountCount])
  const [checks, setChecks] = useState<HealthCheckItem[]>(blankChecks)
  /* 初回だけ読み込み中（#518 中2）。2回目以降は前回の結果のまま。 */
  const [loading, setLoading] = useState(true)
  const hasLoaded = useRef(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [loginSecurityNotice, setLoginSecurityNotice] = useState<string | null>(null)
  const [snapshotStatus, setSnapshotStatus] = useState<OperationHealthSnapshot['overallStatus']>('unknown')
  const [alerts, setAlerts] = useState<OperationAlert[]>([])
  const [stats, setStats] = useState<{ stops: number; longest: string } | null>(null)
  const [statsNote, setStatsNote] = useState('この30日')
  const [alertsFailed, setAlertsFailed] = useState(false)
  const [alertBusyId, setAlertBusyId] = useState<string | null>(null)
  const [alertNotice, setAlertNotice] = useState<ControlMessage | null>(null)
  const alertRequestGeneration = useRef(0)
  const currentAccountIdRef = useRef(accountId)
  currentAccountIdRef.current = accountId

  const [lineReceipts, setLineReceipts] = useState<LineWebhookRecoveryEvent[]>([])
  const [lineReceiptsFailed, setLineReceiptsFailed] = useState(false)
  const [lineRetryId, setLineRetryId] = useState<string | null>(null)
  const lineRetryLock = useRef(false)
  const receiptGeneration = useRef(0)
  const loadLineReceipts = useCallback(async () => {
    const generation = ++receiptGeneration.current
    const requestedAccountId = accountId
    if (!canManage || !accountId) { setLineReceipts([]); setLineReceiptsFailed(false); return }
    try {
      const response = await api.operations.lineReceipts(accountId)
      if (generation !== receiptGeneration.current || requestedAccountId !== currentAccountIdRef.current) return
      if (!response.success) throw new Error(response.error)
      setLineReceipts(response.data.filter((item) => item.lineAccountId === accountId))
      setLineReceiptsFailed(false)
    } catch {
      if (generation !== receiptGeneration.current || requestedAccountId !== currentAccountIdRef.current) return
      setLineReceiptsFailed(true)
    }
  }, [accountId, canManage])
  useEffect(() => {
    setLineReceipts([])
    setLineReceiptsFailed(false)
    void loadLineReceipts()
    const timer = window.setInterval(onlyWhenVisible(() => { void loadLineReceipts() }), 5 * 60 * 1000)
    return () => { ++receiptGeneration.current; window.clearInterval(timer) }
  }, [loadLineReceipts, manualRunRequest])
  const retryLineReceipt = async (item: LineWebhookRecoveryEvent) => {
    if (!canManage || !item.canRetry || item.recoveryStatus === 'needs_review' || lineRetryLock.current) return
    const requestedAccountId = accountId
    const generation = receiptGeneration.current
    lineRetryLock.current = true
    setLineRetryId(item.webhookEventId)
    try {
      const response = await api.operations.retryLineReceipt(item.webhookEventId)
      if (generation !== receiptGeneration.current || requestedAccountId !== currentAccountIdRef.current) return
      if (!response.success) throw new Error(response.reason ?? '受信の工程をやり直せませんでした。履歴を確認してください。')
      setAlertNotice({ tone: 'success', text: '保存済みの受信から、残っていた工程をやり直しました。' })
    } catch (error) {
      if (generation !== receiptGeneration.current || requestedAccountId !== currentAccountIdRef.current) return
      setAlertNotice({ tone: 'warning', text: japaneseDetailOf(error) || describeApiFailure(error, '受信のやり直し') })
    } finally {
      lineRetryLock.current = false
      setLineRetryId(null)
      if (generation === receiptGeneration.current && requestedAccountId === currentAccountIdRef.current) await loadLineReceipts()
    }
  }

  const applySnapshot = useCallback((snapshot: OperationHealthSnapshot) => {
    setLoginSecurityNotice(snapshot.loginSecurity?.notice ?? null)
    const results = snapshot.latestRun?.results ?? []
    const snapshotStale = snapshot.overallStatus === 'stale'
    setChecks(CHECK_DEFINITIONS.map((definition) => {
      const result = results.find((item) => HEALTH_CHECK_ID[item.checkKey] === definition.id)
      const stale = Boolean(result) && (snapshotStale || isOldCheck(result?.observedAt ?? snapshot.lastCheckedAt))
      return {
        ...definition,
        sub: definition.id === 'line' ? lineSub(accountCount) : definition.sub,
        severity: (result?.status ?? 'unknown'),
        summary: result?.summary ?? null,
        observedAt: result?.observedAt ?? snapshot.lastCheckedAt,
        stale,
      }
    }))
    setCheckedAt(snapshot.lastCheckedAt)
    setSnapshotStatus(snapshot.overallStatus)
  }, [accountCount])

  const loadStats = useCallback(async () => {
    try {
      const response = await api.operations.history(HISTORY_FETCH_LIMIT)
      if (!response.success || !Array.isArray(response.data)) {
        setStats(null)
        setStatsNote('読み込めませんでした')
        return
      }
      const entries = response.data as OperationHistoryEntry[]
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      const recent = entries.filter((item) =>
        item.historyKind !== 'deployment'
        && !Number.isNaN(Date.parse(item.createdAt))
        && Date.parse(item.createdAt) >= cutoff)
      const longest = recent.reduce((found, item) => {
        if (!item.stoppedAt || !item.resolvedAt) return found
        return Math.max(found, Math.round((Date.parse(item.resolvedAt) - Date.parse(item.stoppedAt)) / 60000))
      }, 0)
      setStats({ stops: recent.length, longest: longest > 0 ? formatMinutesRough(longest) : emptyValue('unknown') })
      setStatsNote('この30日')
    } catch {
      setStats(null)
      setStatsNote('読み込めませんでした')
    }
  }, [])

  const load = useCallback(async (manual: boolean) => {
    const requestedAccountId = accountId
    const generation = ++alertRequestGeneration.current
    if (!hasLoaded.current) setLoading(true)
    if (!accountId) {
      setChecks(blankChecks())
      setCheckedAt(null)
      setSnapshotStatus('unknown')
      setAlerts([])
      setAlertsFailed(false)
      setLoading(false)
      hasLoaded.current = true
      if (manual) onManualRunSettled?.()
      return
    }
    try {
      const [response, alertResponse] = await Promise.all([
        manual ? api.operations.runHealth(accountId) : api.operations.health(accountId),
        api.operations.alerts(accountId, true).catch(() => null),
      ])
      if (generation !== alertRequestGeneration.current || requestedAccountId !== currentAccountIdRef.current) return
      if (!response.success) throw new Error(response.error)
      applySnapshot(response.data)
      if (alertResponse?.success) {
        setAlerts(alertResponse.data)
        setAlertsFailed(false)
      } else {
        setAlerts([])
        setAlertsFailed(true)
      }
    } catch {
      if (generation !== alertRequestGeneration.current || requestedAccountId !== currentAccountIdRef.current) return
      setChecks(blankChecks())
      setCheckedAt(null)
      setSnapshotStatus('unknown')
      setAlerts([])
      setAlertsFailed(true)
    } finally {
      if (generation === alertRequestGeneration.current && requestedAccountId === currentAccountIdRef.current) {
        setLoading(false)
        hasLoaded.current = true
      }
      if (manual) onManualRunSettled?.()
    }
  }, [accountId, applySnapshot, blankChecks, onManualRunSettled])

  useEffect(() => {
    setAlertBusyId(null)
    setAlertNotice(null)
  }, [accountId])

  /* クリック由来の増分だけ手動実行と見なす（N-458）。 */
  const handledManualRequest = useRef(manualRunRequest)
  useEffect(() => {
    const manual = manualRunRequest > handledManualRequest.current
    handledManualRequest.current = manualRunRequest
    void load(manual)
  }, [load, manualRunRequest])

  useEffect(() => {
    const timer = window.setInterval(onlyWhenVisible(() => { void load(false) }), 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [load])

  useEffect(() => { void loadStats() }, [loadStats, manualRunRequest])

  const displayedSeverity = loading || snapshotStatus === 'stale' ? 'unknown' : mostSevere(checks)
  const snapshotStale = !loading && snapshotStatus === 'stale'
  const staleItems = checks.filter((check) => check.stale)
  const dangers = checks.filter((check) => check.severity === 'danger' && !check.stale)
  const warnings = checks.filter((check) => check.severity === 'warning' && !check.stale)
  const allNormal = !loading && checks.length > 0 && checks.every((check) => check.severity === 'normal' && !check.stale)
  const worst = dangers[0] ?? warnings[0] ?? null
  const checkedText = formatMonthDayTime(checkedAt)

  /* 上の帯「全体の状態」。数は実測だけ。 */
  const banner: { tone: 'info' | 'good' | 'warn' | 'danger'; title: string; body: string } = loading
    ? { tone: 'info', title: '全体の状態：確認中', body: '最新の状態を読み込んでいます。' }
    : worst
      ? {
        tone: worst.severity === 'danger' ? 'danger' : 'warn',
        title: `全体の状態：${worst.severity === 'danger' ? 'エラー' : '注意'} ${formatNumber((worst.severity === 'danger' ? dangers : warnings).length)} 件`,
        body: `${ALERT_RESPONSE_FIRST[CHECK_KEY_BY_ID[worst.id]].impact}${checkedText ? `最後の確認 ${checkedText}（5分ごとに自動確認）` : ''}`,
      }
      : allNormal
        ? { tone: 'good', title: '全体の状態：正常', body: `${CHECK_COUNT}つの項目はすべて正常です。${checkedText ? `最後の確認 ${checkedText}（5分ごとに自動確認）` : ''}` }
        : staleItems.length > 0 || snapshotStale
          ? { tone: 'warn', title: '全体の状態：未確認', body: '前回の確認結果が期限切れです。自動確認が止まっている可能性があります。「いますぐ確かめる」で確かめ直してください。' }
          : { tone: 'info', title: '全体の状態：未確認', body: 'まだ確認できていない項目があります。時間をおいて確かめ直してください。' }

  const acknowledgeAlert = useCallback(async (alert: OperationAlert, note: string) => {
    if (!accountId) return
    const requestedAccountId = accountId
    setAlertBusyId(alert.id)
    try {
      const response = await api.operations.acknowledgeAlert(alert.id, { lineAccountId: accountId, expectedVersion: alert.version, note })
      if (!response.success) throw new Error(response.error)
      if (requestedAccountId !== currentAccountIdRef.current) return
      setAlerts((current) => current.map((item) => item.id === alert.id ? response.data : item))
      setAlertNotice({ tone: 'success', text: response.duplicate ? 'この異常はすでに受領済みです。' : '異常を受領しました。対応内容は履歴に残ります。' })
    } catch (error) {
      if (requestedAccountId !== currentAccountIdRef.current) return
      setAlertNotice({ tone: 'danger', text: operationFailureText(error, '異常を受領できませんでした。最新の状態を読み直してください。') })
    } finally {
      if (requestedAccountId === currentAccountIdRef.current) setAlertBusyId(null)
    }
  }, [accountId])

  const retryAlertNotifications = useCallback(async (alert: OperationAlert) => {
    if (!accountId) return
    const requestedAccountId = accountId
    setAlertBusyId(alert.id)
    try {
      const response = await api.operations.retryAlertNotifications(alert.id, accountId)
      if (!response.success) throw new Error(response.error)
      if (requestedAccountId !== currentAccountIdRef.current) return
      setAlertNotice({ tone: 'success', text: response.data.retried > 0 ? `${response.data.retried} 件の通知または通知先を再確認しました。` : '再確認できる通知はありません。' })
      await load(false)
    } catch (error) {
      if (requestedAccountId !== currentAccountIdRef.current) return
      setAlertNotice({ tone: 'danger', text: operationFailureText(error, '通知を再送待ちへ戻せませんでした。') })
    } finally {
      if (requestedAccountId === currentAccountIdRef.current) setAlertBusyId(null)
    }
  }, [accountId, load])

  useEffect(() => { if (hasLoaded.current) onSeverity(displayedSeverity) }, [displayedSeverity, onSeverity])

  const openAlerts = alerts.filter((alert) => alert.status !== 'resolved' || alert.notification.failed + alert.notification.unconfigured > 0)

  return (
    <>
      {loginSecurityNotice ? <Notice tone="warn" message={loginSecurityNotice} /> : null}
      <Notice tone={banner.tone === "good" ? "success" : banner.tone} data-tone={banner.tone} role="status" action={<>
        {worst ? <TextLink href={worst.href}>{`${worst.sub.split('・')[0]}を開く`}</TextLink> : null}
      </>} heading={<>{banner.title}</>}>
        <p className={styles.bannerBody}>{banner.body}</p>
      </Notice>
      {!accountId && !loading ? (
        <p className={styles.minor}>上のバーでLINEアカウントを選択してください。アカウントを選ぶと9つの項目を確かめます。</p>
      ) : null}
      {alertNotice ? <Notice tone={alertNotice.tone === "warning" ? "warn" : alertNotice.tone} data-tone={alertNotice.tone} role="status">
        {alertNotice.text}
      </Notice> : null}
      <section className={styles.table} aria-label="チェック結果">
        <OpenAlerts
          alerts={openAlerts}
          failed={alertsFailed}
          busyId={alertBusyId}
          canManage={canManage}
          onAcknowledge={acknowledgeAlert}
          onRetry={retryAlertNotifications}
        />
        {canManage && accountId && lineReceiptsFailed ? <Notice tone="danger" action={<Button variant="secondary" onClick={() => void loadLineReceipts()}>読み直す</Button>}>LINE受信の失敗を読み込めませんでした。失敗なしとは扱いません。</Notice> : null}
        {canManage && !lineReceiptsFailed && lineReceipts.some((item) => item.lineAccountId === accountId) ? (
          <section className={styles.alerts} aria-label="LINE受信の失敗">
            <h2 className={styles.alertsTitle}>LINE受信の失敗</h2>
            <div className={styles.alertRows}>
              {lineReceipts.filter((item) => item.lineAccountId === accountId).map((item) => (
                <div className={styles.alertRow} key={item.webhookEventId}>
                  <div className={styles.alertLine}>
                    <StatusBadge tone={item.recoveryStatus === 'needs_review' ? 'caution' : 'warning'}>{item.recoveryStatus === 'needs_review' ? '要確認' : '未完了'}</StatusBadge>
                    <p className={styles.alertText} title={item.webhookEventId}>受信：{formatOperationDate(item.receivedAt)}</p>
                    {item.canRetry === true && item.recoveryStatus !== 'needs_review' ? <Button variant="secondary" disabled={lineRetryId !== null} busy={lineRetryId === item.webhookEventId} onClick={() => void retryLineReceipt(item)}>やり直す</Button> : null}
                  </div>
                  <Notice tone="warn">
                    {item.recoveryReason ?? (item.canRetry ? '保存済みの受信から、やり直せる工程が残っています。' : 'やり直せる工程を確認できません。受信と処理の履歴を照らしてください。')}
                    履歴を照らし、必要なら受信箱から担当者が返信するか、お客さまに送り直しを頼んでください。
                  </Notice>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <GridTable label="確かめていること" framed={false} design={{ columns: 'minmax(0, 1fr) var(--tpl-sb-hc-col-judge) var(--tpl-sb-hc-col-time) var(--tpl-sb-hc-col-how)', gap: 'var(--tpl-sb-ec-gap)', rowPadding: 'var(--tpl-sb-hc-row-pad)', headPadding: 'var(--tpl-sb-ec-head-pad)', fontSize: 'var(--tpl-sb-band-text)', headFontSize: 'var(--tpl-sb-row-sub)', headLineHeight: 'var(--tpl-sb-row-sub-lh)', headBackground: 'var(--color-surface-pearl)' }}>
          <div role="rowgroup">
            <GridHeadRow>
              <GridCell role="columnheader">確かめていること</GridCell>
              <GridCell role="columnheader">判定</GridCell>
              <GridCell role="columnheader">最後の確認</GridCell>
              <GridCell role="columnheader">判定の見方</GridCell>
            </GridHeadRow>
          </div>
          <div role="rowgroup">
            {checks.map((check) => {
              const abnormal = !check.stale && (check.severity === 'warning' || check.severity === 'danger') && check.summary
              return (
                <GridRow key={check.id}>
                  <GridCell role="cell" className={styles.stack}>
                    <span className={styles.main} title={check.title}>{check.title}</span>
                    <span className={styles.sub}>{check.sub}</span>
                  </GridCell>
                  <GridCell role="cell" className={styles.judge}><StatusPill severity={check.severity} stale={check.stale} /></GridCell>
                  <GridCell role="cell" className={styles.time}>{formatCheckedAt(check.observedAt)}</GridCell>
                  <GridCell role="cell" className={styles.how} title={abnormal ? check.threshold : undefined}><TruncatedText value={abnormal ? (check.summary ?? '') : check.threshold} /></GridCell>
                </GridRow>
              )
            })}
          </div>
        </GridTable>
      </section>
      <KpiBand presentation="band">
        <KpiCard presentation="band" title="止めた回数" value={stats ? stats.stops : null} unit="" detail={statsNote} />
        <KpiCard presentation="band" title="いちばん長かった停止" value={null} valueText={stats?.longest ?? '—'} unit="" detail={statsNote} />
        <KpiCard presentation="band" title="いまの版" value={null} valueText={runningVersion.detail?.version ?? '—'} unit="" detail={runningVersion.statusText} />
      </KpiBand>
    </>
  )
}
