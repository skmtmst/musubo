'use client'
import { canManageRole, useTenantWideAccess, useStaffRole } from '@/lib/staff-role'

import { useSamePageUrl } from '@/lib/use-same-page-url'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Ban, Check, CirclePause, Copy, Download, PencilLine, RotateCcw, Send } from 'lucide-react'
import Select from '@/components/shared/select'
import { Tabs } from '@/components/shared/tabs'
import { SingleOperatorFields } from '@/components/broadcasts/broadcast-approval'
import { downloadApiFile, ApiError, describeSaveFailure } from '@/lib/api'
import { HqApprovalBlock, HqTestSendDialog, approvalGate, useHqApproval } from './approval'
import type { HqBroadcastRun } from '@line-crm/shared'
import { PageContent, PageFrame, PageHeading } from '@/components/templates/page-frame'
import { ListPageSection } from '@/components/templates/list-page'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import TargetMissing from '@/components/shared/target-missing'
import StatusBadge from '@/components/shared/status-badge'
import RowMenu from './row-menu'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { notifyToast } from '@/components/shared/toast'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { hqBroadcastsApi } from '@/lib/hq-broadcasts-api'
import { type ResultTarget, canRetry, failedCount, failureLines, fromApiContent, jpDateTime, preflightBadge, previewText, resultBadge, runBadge, sendTotals } from './model'
import styles from './detail.module.css'
import detailStyles from '../broadcast-detail/detail.module.css'
import { BroadcastPhone } from '@/v8/broadcast-detail/public/phone/index'
import { japaneseDetailOf, permissionDeniedMessage, withPermissionFailure } from '@/components/shared/api-error-message'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { DetailLoading } from '@/components/templates/detail-page'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import OperationTargetSummary from '@/components/shared/operation-target-summary'

/*
 * ★V8 統括 一括配信の詳細（提案 E-9 `xOXuY`「⑤ 送った結果」）。
 *
 * 店ごとの送った・成功・失敗・状態と、失敗した店へのやり直し（retry）。予約中・送っている間は止める（stop）、
 * 送る前（下書き）・予約中は取り消す（cancel）。下書きは店ごとの確かめを見て、そのまま送れる（send）。
 * 送った LINE は取り消せない。動きは BEHAVIOR.md。
 */

const n = (value: number) => polishFormatNumber(value)
/** 開いた・押した・反応（API-18）。店の計測がまだ取れていない（null）は「—」。 */
const metric = (value: number | null | undefined) => (value == null ? emptyValue('unknown') : n(value))
/** 送ったアカウントの合計。1つでも取れていなければ「—」（足りない合計を出さない）。 */
export function sumMetric(values: Array<number | null | undefined>): number | null {
  if (values.length === 0 || values.some((value) => value == null)) return null
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}
const ACTIVITY_LABEL: Record<string, string> = {
  target_fixed: '送るアカウントを決めた', draft_updated: '下書きを直した', excluded: 'アカウントを外した', included: 'アカウントを戻した',
  scheduled: '送信を予約した', cancelled: '取り消した', stopped: '止めた', retry_before_delivery: 'やり直した', retry_failed: '失敗した人にやり直した',
  test_send: 'テストを送った', approval_request: '承認を頼んだ', approval_approve: '承認した', approval_reject: '差し戻した', approval_cancel: '承認の依頼を取り消した',
}
type TabKey = 'overview' | 'recipients' | 'activity'

type RetryTarget = ResultTarget & { confirmedCount: number | null; confirmedToken: string | null }
type Ask = { kind: 'send' } | { kind: 'stop' } | { kind: 'cancel' } | { kind: 'retry-all'; runId: string; targets: RetryTarget[] } | { kind: 'retry'; runId: string; target: RetryTarget }

function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) {
    if (caught.status === 409) return japaneseDetailOf(caught) || 'ほかの人が先に操作しました。読み直してください。'
    if (caught.status === 403) return permissionDeniedMessage('hq')
    return withPermissionFailure(caught, describeSaveFailure(caught), 'hq')
  }
  // 「API error: 500」のような内部の文は出さない。
  return japaneseDetailOf(caught) || fallback
}

/** ⑤ 送った結果（店ごと）。 */
export function ResultCard({ run, canManage, onRetry, onRetryAll }: {
  run: HqBroadcastRun
  canManage: boolean
  onRetry: (t: ResultTarget) => void
  onRetryAll: () => void
}) {
  const sentTo = run.targets.filter((t) => !t.excluded)
  const success = sentTo.reduce((sum, t) => sum + (t.successCount ?? 0), 0)
  const failed = sentTo.reduce((sum, t) => sum + failedCount(t), 0)
  const retryable = run.targets.filter((t) => canRetry(run, t))
  return (
    <section className={styles.card} aria-labelledby="hq-bc-result">
      <div className={styles.cardHead}>
        <div className={styles.cardText}>
          <h2 id="hq-bc-result" className={styles.cardTitle}>アカウントごとの送った結果</h2>
          <p className={styles.cardSub}>{`${jpDateTime(run.scheduledAt)}・${n(sentTo.length)}店に送信・成功 ${n(success)} 人・失敗 ${n(failed)} 人`}</p>
        </div>
        {canManage && retryable.length > 0 ? (
          <Button onClick={onRetryAll}><RotateCcw size={16} aria-hidden="true" />失敗した店にやり直す</Button>
        ) : null}
      </div>
      <DataTable className={styles.table} data-design="hq-broadcast-result">
        <thead>
          <TableHeadRow className={styles.headRow}>
            <Th className={styles.colStore}>店</Th>
            <Th className={styles.colNum}>届いた</Th>
            <Th className={styles.colFail}>失敗</Th>
            <Th className={styles.colMetric}>開いた</Th>
            <Th className={styles.colMetric}>押した</Th>
            <Th className={styles.colMetric}>反応</Th>
            <Th className={styles.colState}>状態</Th>
            <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {run.targets.map((t) => {
            const badge = resultBadge(t)
            const off = t.excluded || t.status === 'excluded'
            const fail = failedCount(t)
            return (
              <Tr key={t.accountId} className={styles.row}>
                <Td className={styles.colStore}><span className={styles.store} title={t.accountName}>{t.accountName}</span></Td>
                <Td className={styles.colNum}><span className={styles.num} title={off ? undefined : `送った ${n(t.totalCount ?? 0)}人`}>{off ? emptyValue('unknown') : n(t.successCount ?? 0)}</span></Td>
                <Td className={styles.colFail}><span className={off ? styles.faint : fail > 0 ? styles.numStrong : styles.faint}>{off ? emptyValue('unknown') : n(fail)}</span></Td>
                <Td className={styles.colMetric}><span className={styles.num}>{off ? emptyValue('unknown') : metric(t.openedCount)}</span></Td>
                <Td className={styles.colMetric}><span className={styles.num}>{off ? emptyValue('unknown') : metric(t.clickedCount)}</span></Td>
                <Td className={styles.colMetric}><span className={styles.num}>{off ? emptyValue('unknown') : metric(t.reactionCount)}</span></Td>
                <Td className={styles.colState}><StatusBadge tone={badge.tone} title={t.blockedReasons.join('・') || undefined}>{badge.label}</StatusBadge></Td>
                <Td className={styles.colMenu}>
                  {canManage && canRetry(run, t) ? (
                    <RowMenu subjectName={t.accountName} items={[{ id: 'retry', label: 'この店にやり直す', onSelect: () => onRetry(t) }]} />
                  ) : null}
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
      <FailureReasons run={run} />
    </section>
  )
}

/** 店ごとの失敗の理由（「LINE が混雑しています」など。口の failureReasons）。 */
function FailureReasons({ run }: { run: HqBroadcastRun }) {
  const lines = failureLines(run)
  if (lines.length === 0) return null
  return (
    <div className={styles.reasons} data-failure-reasons="">
      <p className={styles.reasonsTitle}>失敗・送れなかった理由</p>
      <ul className={styles.reasonList}>
        {lines.map((line, i) => (
          <li key={`${line.accountId}-${i}`} className={styles.reason}>
            <span className={styles.reasonStore} title={line.store}>{line.store}</span>
            <span className={styles.reasonText}>{line.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 下書き（送る前）の店ごとの確かめ。preflight の結果（固定した対象に入っている）を出す。 */
function PreparedCard({ run }: { run: HqBroadcastRun }) {
  const totals = sendTotals(run.targets)
  return (
    <section className={styles.card} aria-labelledby="hq-bc-prepared">
      <div className={styles.cardHead}>
        <div className={styles.cardText}>
          <h2 id="hq-bc-prepared" className={styles.cardTitle}>送る前の確かめ</h2>
          <p className={styles.cardSub}>{`送る：${n(totals.sendStores)}店・${n(totals.sendPeople)} 人・外す：${n(totals.skipStores)}店・${n(totals.skipPeople)} 人`}</p>
        </div>
      </div>
      <DataTable className={styles.table} data-design="hq-broadcast-prepared">
        <thead>
          <TableHeadRow className={styles.headRow}>
            <Th className={styles.colStore}>店</Th>
            <Th className={styles.colNum}>送る人数</Th>
            <Th className={styles.colNum}>送信枠の残り</Th>
            <Th className={styles.colState}>確かめ</Th>
            <Th className={styles.colFail}>送るか</Th>
          </TableHeadRow>
        </thead>
        <tbody>
          {run.targets.map((t) => {
            const badge = preflightBadge(t, fromApiContent(run.input?.messageContent ?? ''))
            const go = !t.excluded && t.blockedReasons.length === 0
            return (
              <Tr key={t.accountId} className={styles.row}>
                <Td className={styles.colStore}><span className={styles.store} title={t.accountName}>{t.accountName}</span></Td>
                <Td className={styles.colNum}><span className={styles.num}>{t.audienceCount === null ? emptyValue('unknown') : `${n(t.audienceCount)}人`}</span></Td>
                <Td className={styles.colNum}><span className={styles.faint}>{t.remaining === null ? emptyValue('unknown') : `${n(t.remaining)}通`}</span></Td>
                <Td className={styles.colState}><StatusBadge tone={badge.tone} title={t.blockedReasons.join('・') || undefined}>{badge.label}</StatusBadge></Td>
                <Td className={styles.colFail}><StatusBadge tone={go ? 'success' : 'neutral'}>{go ? '送る' : '外す'}</StatusBadge></Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>
    </section>
  )
}

/** 宛先のタブ：アカウントを選び、その店の配信の宛先を50人ずつ（API-18）。 */
function RecipientsTab({ run }: { run: HqBroadcastRun }) {
  const sentTo = run.targets.filter((t) => !t.excluded && t.broadcastId)
  const [accountId, setAccountId] = useState(sentTo[0]?.accountId ?? '')
  const [rows, setRows] = useState<Array<{ friendId: string; displayName: string | null; state: string; sentAt: string | null; errorCode: string | null }>>([])
  const [total, setTotal] = useState<number | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const load = useCallback(async (cursor: number, append: boolean) => {
    if (!accountId) { setState('ready'); setRows([]); setTotal(0); return }
    setState('loading')
    try {
      const res = (await hqBroadcastsApi.recipients(run.id, accountId, cursor)).data
      setRows((current) => (append ? [...current, ...res.rows] : res.rows)); setTotal(res.total); setNext(res.nextCursor); setState('ready')
    } catch {
      setState('error')
    }
  }, [run.id, accountId])
  useEffect(() => { void load(0, false) }, [load])
  const stateLabel = (value: string) => (value === 'sent' ? '届いた' : value === 'failed' ? '失敗' : value === 'pending' || value === 'claimed' ? '送る前' : value)
  if (sentTo.length === 0) return <p className={detailStyles.note}>まだどのアカウントにも送っていません。送ると、ここに宛先が並びます。</p>
  return (
    <section className={detailStyles.section} aria-label="宛先">
      <div className={styles.cardHead}>
        <div className={styles.cardText}>
          <h3 className={detailStyles.secTitle}>宛先</h3>
          <p className={styles.cardSub}>{total == null ? 'アカウントを選ぶと、その店の宛先が出ます' : `${n(total)} 人`}</p>
        </div>
        <span className={styles.accountPick}>
          <SaveErrorField names={["accountId","account_id"]}><EntitySelect aria-label="宛先を見るアカウント" size="full" value={accountId} onChange={setAccountId} options={sentTo.map((t) => ({ ...entityOptionMetadata(t), value: t.accountId, label: t.accountName }))} /></SaveErrorField>
        </span>
      </div>
      {state === 'error' ? <ListState permissionScope="hq" kind="error" error={new Error('宛先を読み込めませんでした')} onRetry={() => void load(0, false)} /> : (
        <DataTable className={styles.table} data-design="hq-broadcast-recipients">
          <thead>
            <TableHeadRow className={styles.headRow}>
              <Th className={styles.colStore}>友だち</Th>
              <Th className={styles.colState}>状態</Th>
              <Th className={styles.colState}>送った日時</Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Tr key={row.friendId} className={styles.row} data-row-id={row.friendId}>
                <Td className={styles.colStore}><span className={styles.store} title={row.displayName ?? undefined}>{row.displayName ?? emptyValue('unknown')}</span></Td>
                <Td className={styles.colState}><StatusBadge tone={row.state === 'sent' ? 'success' : row.state === 'failed' ? 'danger' : 'neutral'} title={row.errorCode ?? undefined}>{stateLabel(row.state)}</StatusBadge></Td>
                <Td className={styles.colState}><span className={styles.faint}>{row.sentAt ? jpDateTime(row.sentAt) : emptyValue('unknown')}</span></Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {state === 'loading' ? <DetailLoading /> : null}
      {next && state === 'ready' ? <div><Button onClick={() => load(Number(next), true)} busyLabel="処理中…">続きを読む</Button></div> : null}
    </section>
  )
}

/** 記録のタブ：誰がいつ何をしたか（API-18 の activity）。 */
function ActivityTab({ run, names }: { run: HqBroadcastRun; names: Map<string, string> }) {
  const [rows, setRows] = useState<Array<{ id: string; accountId: string; actorId: string; action: string; createdAt: string }>>([])
  const [next, setNext] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const load = useCallback(async (cursor: number, append: boolean) => {
    setState('loading')
    try {
      const res = (await hqBroadcastsApi.activity(run.id, cursor)).data
      setRows((current) => (append ? [...current, ...res.rows] : res.rows)); setNext(res.nextCursor); setState('ready')
    } catch {
      setState('error')
    }
  }, [run.id])
  useEffect(() => { void load(0, false) }, [load])
  const account = (id: string) => run.targets.find((t) => t.accountId === id)?.accountName ?? (id ? emptyValue('unknown') : '一括配信')
  return (
    <section className={detailStyles.section} aria-label="記録">
      <h3 className={detailStyles.secTitle}>記録</h3>
      {state === 'error' ? <ListState permissionScope="hq" kind="error" error={new Error('記録を読み込めませんでした')} onRetry={() => void load(0, false)} /> : rows.length === 0 && state === 'ready' ? (
        <p className={detailStyles.note}>まだ記録はありません。</p>
      ) : (
        <DataTable className={styles.table} data-design="hq-broadcast-activity">
          <thead>
            <TableHeadRow className={styles.headRow}>
              <Th className={styles.colState}>日時</Th>
              <Th className={styles.colStore}>したこと</Th>
              <Th className={styles.colState}>アカウント</Th>
              <Th className={styles.colState}>した人</Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Tr key={row.id} className={styles.row} data-row-id={row.id}>
                <Td className={styles.colState}><span className={styles.faint}>{jpDateTime(row.createdAt)}</span></Td>
                <Td className={styles.colStore}><span className={styles.store}>{Object.prototype.hasOwnProperty.call(ACTIVITY_LABEL, row.action) ? ACTIVITY_LABEL[row.action] : '操作'}</span></Td>
                <Td className={styles.colState}><span className={styles.faint} title={account(row.accountId)}>{account(row.accountId)}</span></Td>
                <Td className={styles.colState}><span className={styles.faint}>{names.get(row.actorId) ?? '統括の担当者'}</span></Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {state === 'loading' ? <DetailLoading /> : null}
      {next && state === 'ready' ? <div><Button onClick={() => load(Number(next), true)} busyLabel="処理中…">続きを読む</Button></div> : null}
    </section>
  )
}

/**
 * 送るまでの段（店の配信の詳細と同じ帯・絵 ）。下書き →（承認待ち）→（予約中）→ 送信中 → 送信済み。
 * 承認が絡まない・予約しない一括配信はその段を省く。分かれ道（一部失敗・失敗あり・止めた・取り消した）は札で添える。
 * 承認の状態は下書きのあいだだけ読める（送ったあとは口に無い）ので、送ったあとは承認の段を出さない。
 */
function HqDeliveryRail({ run, approvalPending }: { run: HqBroadcastRun; approvalPending: boolean }) {
  const live = run.targets.filter((t) => !t.excluded)
  const scheduled = run.scheduledAt != null
  const steps: Array<{ key: string; label: string }> = [
    { key: 'draft', label: '下書き' },
    ...(approvalPending ? [{ key: 'approval', label: '承認待ち' }] : []),
    ...(scheduled ? [{ key: 'scheduled', label: '予約中' }] : []),
    { key: 'sending', label: '送信中' },
    { key: 'sent', label: '送信済み' },
  ]
  const badge = runBadge(run)
  const current = run.status === 'prepared' ? (approvalPending ? 'approval' : 'draft')
    : run.status === 'cancelled' ? 'draft'
    : live.length > 0 && live.every((t) => t.status === 'sent' || t.status === 'failed') ? 'sent'
    : live.some((t) => t.status === 'sending' || t.status === 'sent') || run.status === 'stopped' ? 'sending'
    : scheduled ? 'scheduled' : 'sending'
  const currentIndex = Math.max(0, steps.findIndex((step) => step.key === current))
  const branch = ['一部失敗', '失敗あり', '止めた', '取り消した'].includes(badge.label) ? badge : null
  return (
    <ol className={detailStyles.rail} aria-label="配信の状態">
      {steps.map((step, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'
        return (
          <li key={step.key} className={detailStyles.railItem} data-state={state} data-kind="delivery">
            {index > 0 ? <span className={detailStyles.railLine} data-done={index <= currentIndex || undefined} aria-hidden="true" /> : null}
            <span className={detailStyles.railStep}>
              <span className={detailStyles.railMark} aria-hidden="true">{state === 'done' ? <Check size={16} strokeWidth={3} /> : null}</span>
              <span className={detailStyles.railLabel} aria-current={state === 'current' ? 'step' : undefined}>{step.label}</span>
            </span>
          </li>
        )
      })}
      {branch ? (
        <li className={detailStyles.railItem}>
          <span className={detailStyles.railLine} aria-hidden="true" />
          <StatusBadge tone={branch.tone === 'danger' ? 'danger' : branch.tone === 'warning' ? 'warning' : 'neutral'}>{branch.label}</StatusBadge>
        </li>
      ) : null}
    </ol>
  )
}

/** 送り方（店の配信の詳細と同じ言葉）。分けて送る分数が入っていれば、その分数。 */
export function deliveryWayText(input: Pick<HqBroadcastRun['input'], 'stealthSpreadMinutes'> | null | undefined, sent: boolean): string {
  const minutes = input?.stealthSpreadMinutes ?? 0
  if (minutes > 0) return `${minutes}分かけて分けて送る`
  return sent ? 'すぐに全員へ（分けて送らない）' : 'すぐに全員へ'
}

export default function HqBroadcastDetail() {
  const params = useSearchParams()
  return <HqBroadcastDetailBody key={params.get('id') ?? ''} />
}

function HqBroadcastDetailBody() {
  usePageCrumbs([{ label: '一括配信', href: '/hq/broadcasts' }])
  const params = useSearchParams()
  const samePageUrl = useSamePageUrl()
  const id = params.get('id') ?? ''
  /* タブは ?tab=（店の配信の詳細と同じ。履歴を積まない）。 */
  const tabParam = params.get('tab')
  const [tab, setTab] = useState<TabKey>(tabParam === 'recipients' || tabParam === 'activity' ? tabParam : 'overview')
  const selectTab = (next: TabKey) => {
    setTab(next)
    const q = new URLSearchParams(params.toString())
    if (next === 'overview') q.delete('tab'); else q.set('tab', next)
    samePageUrl.replace(`/hq/broadcasts/detail?${q.toString()}`)
  }
  const role = useStaffRole()
  const canManage = useTenantWideAccess()
  const [run, setRun] = useState<HqBroadcastRun | null>(null)
  const [testOpen, setTestOpen] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [confirmCount, setConfirmCount] = useState('')
  const [exporting, setExporting] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    try {
      const res = await hqBroadcastsApi.get(id)
      setRun(res.data); setLoadError(null)
    } catch (caught) {
      setLoadError(caught)
    }
  }, [id])
  useEffect(() => { void load() }, [load])
  const approval = useHqApproval(run)
  /* 上の帯は「一括配信 › 配信名」、画面名は配信名だけ（店の配信の詳細と同じ・絵 ）。 */
  usePageTitle(run ? run.title : '一括配信の詳細')
  const gate = approvalGate(approval.state)
  const names = new Map(approval.candidates.map((person) => [person.id, person.name]))

  /** CSV（アカウントごと・宛先ごとの送った結果。API-18）。閲覧のみにも出す。 */
  const exportCsv = async () => {
    if (!run || exporting) return
    setExporting(true); setError('')
    try {
      await downloadApiFile(hqBroadcastsApi.exportPath(run.id), csvFileName("一括配信"))
    } catch (caught) {
      setError(errorText(caught, 'CSVを書き出せませんでした。もう一度お試しください。'))
    } finally {
      setExporting(false)
    }
  }

  /* 送っている間は 15 秒ごとに読み直す（店ごとの数が増えていく）。 */
  useEffect(() => {
    if (!run || !run.targets.some((t) => t.status === 'sending' || t.status === 'scheduled')) return
    const timer = setInterval(() => { void load() }, 15_000)
    return () => clearInterval(timer)
  }, [run, load])

  const retryAcknowledged = useRef<{ ask: typeof ask; targets: Set<string> }>({ ask: null, targets: new Set() })
  const [actConflict, setActConflict] = useState(false)
  const retryState = useRef({ ask, run, canManage, busy, actConflict, loadError, active: true })
  retryState.current = { ask, run, canManage, busy, actConflict, loadError, active: retryState.current.active }
  useEffect(() => { retryState.current.active = true; return () => { retryState.current.active = false } }, [])
  useEffect(() => { if (ask) setError(''); setActConflict(false) }, [ask])
  const openRetry = async (targets: ResultTarget[], all: boolean) => {
    if (!run || busy) return
    setBusy(true); setError('')
    try {
      const checked = await Promise.all(targets.map(async target => {
        try {
          const response = await hqBroadcastsApi.retryPreview(run.id, target.accountId)
          if (!response.success) throw new Error('preview unavailable')
          const preview = response.data
          if (!Number.isSafeInteger(preview.count) || preview.count < 0 || typeof preview.token !== 'string' || !preview.token) throw new Error('invalid preview')
          return { ...target, confirmedCount: preview.count, confirmedToken: preview.token }
        } catch { return { ...target, confirmedCount: null, confirmedToken: null } }
      }))
      if (!retryState.current.active || !retryState.current.canManage || retryState.current.run?.id !== run.id) return
      if (all) setAsk({ kind: 'retry-all', runId: run.id, targets: checked })
      else if (checked[0]) setAsk({ kind: 'retry', runId: run.id, target: checked[0] })
    } catch (caught) { setError(errorText(caught, '送る相手を確認できませんでした。')) }
    finally { setBusy(false) }
  }
  const act = async () => {
    if (!run || !ask || busy || actConflict || loadError) return
    if (ask.kind === 'retry' || ask.kind === 'retry-all') {
      const state = retryState.current
      if (!state.active || state.ask !== ask || !state.canManage || state.busy || state.actConflict || state.loadError || !state.run) return false
    }
    if (retryAcknowledged.current.ask !== ask) retryAcknowledged.current = { ask, targets: new Set() }
    const acknowledged = retryAcknowledged.current.targets
    if (ask.kind === 'retry' || ask.kind === 'retry-all') {
      const state = retryState.current
      if (!state.run) return false
      const currentRun = state.run
      const expected = (ask.kind === 'retry' ? [ask.target] : ask.targets).filter(t => !acknowledged.has(t.accountId))
      if (expected.some(t => t.confirmedCount === null || !t.confirmedToken) || !Number.isSafeInteger(expected.reduce((sum,t)=>sum+(t.confirmedCount ?? 0),0))) {
        setError('送る相手を確認できません。閉じてもう一度お試しください。')
        return false
      }
      const current = ask.kind === 'retry'
        ? currentRun.targets.filter(t => t.accountId === ask.target.accountId && canRetry(currentRun, t))
        : currentRun.targets.filter(t => canRetry(currentRun, t) && !acknowledged.has(t.accountId))
      const key = (targets: ResultTarget[]) => JSON.stringify(targets.map(t => [t.accountId, t.version, t.status, t.stopped, t.retryableCount, t.failureReasons?.some(f => f.code === 'before_send_failed') ?? false]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      if (currentRun.id !== ask.runId || expected.length === 0 || expected.some(t => !t.accountId) || key(expected) !== key(current)) {
        setActConflict(true)
        setError('対象が変わりました。閉じて最新の状態を確認してください。')
        return false
      }
    }
    if (ask.kind === 'retry' || ask.kind === 'retry-all') retryState.current.busy = true
    setBusy(true); setError('')
    try {
      if (ask.kind === 'send') {
        /* 送る直前にもう一度確かめる（下書きのあいだに枠・接続が変わる）。問題が出たら口が 409 で止める。 */
        await hqBroadcastsApi.preflight(run.id)
        await (gate === 'single' ? hqBroadcastsApi.send(run.id, run.version, Number(confirmCount)) : hqBroadcastsApi.send(run.id, run.version))
        notifyToast(run.scheduledAt ? '一括配信を予約しました' : '一括配信を送り始めました')
      } else if (ask.kind === 'stop') {
        await hqBroadcastsApi.stop(run.id, run.version)
        notifyToast('一括配信を止めました。まだ送っていない分は送りません')
      } else if (ask.kind === 'cancel') {
        await hqBroadcastsApi.cancel(run.id, run.version)
        notifyToast('一括配信を取り消しました')
      } else if (ask.kind === 'retry') {
        if (ask.target.confirmedCount === null || !ask.target.confirmedToken) throw new Error('送る相手を確認できません。読み直してください。')
        await hqBroadcastsApi.retry(run.id, ask.target.accountId, ask.target.version,{count:ask.target.confirmedCount,token:ask.target.confirmedToken})
        notifyToast(`${ask.target.accountName}にやり直しています`)
      } else {
        const targets = ask.targets.filter((t) => !acknowledged.has(t.accountId))
        const failures: string[] = [], started = ask.targets.filter(t=>acknowledged.has(t.accountId)).map(t=>t.accountName)
        let conflicted = false
        for (const t of targets) {
          try { if (t.confirmedCount === null || !t.confirmedToken) throw new Error('送る相手を確認できません'); await hqBroadcastsApi.retry(run.id, t.accountId, t.version,{count:t.confirmedCount,token:t.confirmedToken}); acknowledged.add(t.accountId); started.push(t.accountName) } catch (cause) {
            if (cause instanceof ApiError && cause.status === 409) conflicted = true
            const current = cause instanceof ApiError && cause.data && typeof cause.data === 'object' ? (cause.data as {currentCount?:unknown}).currentCount : undefined
            failures.push(`${t.accountName}${typeof current === 'number' && Number.isSafeInteger(current) && current >= 0 ? `（今は ${n(current)} 人）` : ''}`)
          }
        }
        if (failures.length) {
          const message = `${started.length ? `${started.join('・')}は送り始めました。` : '送り始めた店はありません。'}やり直せなかった店：${failures.join('・')}。`
          if (conflicted) throw new ApiError(409, message)
          throw new Error(message)
        }
        else notifyToast(`${n(targets.length)}店にやり直しています`)
      }
      setAsk(null)
      void load()
      return true
    } catch (caught) {
      const needsReview = !(caught instanceof ApiError) || caught.status === 409 || caught.status >= 500
      setActConflict(needsReview)
      const reason = errorText(caught, '操作できませんでした。')
      const current = ask.kind === 'retry' && caught instanceof ApiError && caught.data && typeof caught.data === 'object' ? (caught.data as {currentCount?:unknown}).currentCount : undefined
      const countText = typeof current === 'number' && Number.isSafeInteger(current) && current >= 0 ? `今は ${n(current)} 人です。` : ''
      setError(needsReview ? `${reason} ${countText}閉じて最新の状態を確認してください。` : reason)
      return false
    } finally {
      retryState.current.busy = false
      setBusy(false)
    }
  }

  let body
  if (!id) body = null
  else if (loadError && !run) body = <ListState permissionScope="hq" kind="error" error={loadError} onRetry={() => void load()} />
  else if (!run) body = <DetailLoading />
  else body = run.status === 'prepared'
    ? <PreparedCard run={run} />
    : <ResultCard run={run} canManage={canManage} onRetry={(t) => void openRetry([t],false)} onRetryAll={() => void openRetry(run.targets.filter(t=>canRetry(run,t)),true)} />

  const badge = run ? runBadge(run) : null
  /* 全体の状態は送ったあとも scheduled のまま（口の作り）。止める・取り消すは、まだ送っている・予約中の店があるときだけ。 */
  const live = !!run && run.status !== 'cancelled' && run.targets.some((t) => !t.excluded && (t.status === 'scheduled' || t.status === 'sending'))
  const totals = run ? sendTotals(run.targets) : null

  const confirmText: Record<Ask['kind'], { title: string; description: string; label: string }> = {
    send: { title: `${n(totals?.sendStores ?? 0)}店に送ります`, description: `${n(totals?.sendPeople ?? 0)} 人に送ります。送った LINE は取り消せません。`, label: '送る' },
    stop: { title: '一括配信を止めます', description: 'まだ送っていない店・人には送りません。送った LINE は取り消せません。止めたあと、店ごとにやり直せます。', label: '止める' },
    cancel: { title: '一括配信を取り消します', description: '取り消すと、どの店にも送らず、やり直しもできません。送った LINE は取り消せません。', label: '取り消す' },
    retry: { title: 'この店にやり直します', description: '一時的に失敗した人と、止める前に送れなかった人にだけ送ります。', label: 'やり直す' },
    'retry-all': { title: '失敗した店にやり直します', description: '一時的に失敗した人と、止める前に送れなかった人にだけ送ります。', label: 'やり直す' },
  }
  const retryTargets = ask?.kind === 'retry' ? [ask.target] : ask?.kind === 'retry-all' ? ask.targets : []
  const remainingRetryTargets = retryAcknowledged.current.ask === ask ? retryTargets.filter(t => !retryAcknowledged.current.targets.has(t.accountId)) : retryTargets
  const retryTotal = remainingRetryTargets.reduce((sum, t) => sum + (t.confirmedCount ?? 0), 0)
  const retryCount = remainingRetryTargets.length > 0 && remainingRetryTargets.every(t => t.confirmedCount !== null && !!t.confirmedToken) && Number.isSafeInteger(retryTotal)
    ? retryTotal : null
  const retryCountText = retryCount === null ? '人数は送る時に決まります' : `約${n(retryCount)}人に送ります`

  /* 店の配信の詳細と同じ頭・数の帯・右の「配信した設定」とスマホ。統括だけの口はアカウント別の内訳（表）とやり直し。 */
  const sentTo = run ? run.targets.filter((t) => !t.excluded) : []
  const delivered = sentTo.reduce((sum, t) => sum + (t.successCount ?? 0), 0)
  const failedPeople = sentTo.reduce((sum, t) => sum + failedCount(t), 0)
  const skipped = run ? run.targets.filter((t) => t.excluded || t.status === 'excluded').length : 0
  const opened = sumMetric(sentTo.map((t) => t.openedCount))
  const clicked = sumMetric(sentTo.map((t) => t.clickedCount))
  const reacted = sumMetric(sentTo.map((t) => t.reactionCount))
  const rate = (value: number) => (delivered > 0 ? `${((value / delivered) * 100).toFixed(1)}%` : emptyValue('unknown'))
  const audience = run?.input?.audience?.kind === 'tag' ? `タグ：${run.input.audience.tagName}` : '友だち全員'
  const people = run ? (run.status === 'prepared' ? (totals?.sendPeople ?? 0) : sentTo.reduce((sum, t) => sum + (t.totalCount ?? 0), 0)) : 0
  const bubbles = (() => { try { return run?.input?.messageBubblesJson ? JSON.parse(run.input.messageBubblesJson) : null } catch { return null } })()
  const messageText = Array.isArray(bubbles) && bubbles.length > 1
    ? `吹き出し ${polishFormatNumber(bubbles.length)} 通`
    : bubbles?.length ? (bubbles[0].type === 'coupon' ? 'クーポン 1通' : bubbles[0].type === 'text' ? 'テキスト 1通' : 'リッチメッセージ 1通') : 'テキスト 1通'
  const exampleStore = sentTo[0]?.accountName ?? '店の名前'
  const tone = badge?.tone === 'success' ? 'success' : badge?.tone === 'danger' ? 'danger' : badge?.tone === 'warning' ? 'warning' : 'neutral'

  if (!id) return <TargetMissing kind="unspecified" title="開く一括配信が指定されていません" description="一覧から開く一括配信を選び直してください。" backHref="/hq/broadcasts" backLabel="一括配信の一覧へ戻る" />

  /* 選ばれていない時は対象なしの1枚だけ。右の設定・スマホ・タブは出さない。 */
  if (!id) {
    return (
      <PageFrame kind="detail" boardId="M2tJM xOXuY">
        <PageHeading title="一括配信" />
        <PageContent>
          <TargetMissing kind="unspecified" title="一括配信が選ばれていません" description="一括配信の一覧から開いてください。" backHref="/hq/broadcasts" backLabel="一括配信の一覧へ戻る" />
        </PageContent>
      </PageFrame>
    )
  }

  return (
    <>
      <PageFrame kind="detail" boardId="M2tJM xOXuY">
        <PageHeading title={run?.title ?? '一括配信'}
        steps={<>{run ? <HqDeliveryRail run={run} approvalPending={approval.state?.approval.status === 'pending'} /> : null}</>}
        /* 店の詳細と同じ形：題の右に状態の札、題の下に1行の要約。 */
        titleAccessory={badge ? <StatusBadge tone={tone}>{badge.label}</StatusBadge> : undefined}
        crumbs={run ? <p className={detailStyles.meta}>{`${messageText.replace(' 1通', '')}・${audience}・${run.scheduledAt ? `${jpDateTime(run.scheduledAt)} に${run.status === 'prepared' ? '送る予定' : '送信'}` : 'すぐ送る'}・${n(sentTo.length)}アカウント`}</p> : undefined}
        actions={<>{run ? (
            <div className={detailStyles.actions}>
              {/* CSV は見るだけの操作。閲覧のみにも出す。 */}
              <Button size="field" onClick={() => void exportCsv()} busy={exporting} busyLabel="書き出しています…"><Download size={16} aria-hidden="true" />CSVで書き出す</Button>
              {canManage && run.status !== 'prepared' ? (
                <Button size="field" variant="primary" href={`/hq/broadcasts/new?copy=${encodeURIComponent(run.id)}`}><Copy size={16} aria-hidden="true" />複製して作る</Button>
              ) : null}
            </div>
          ) : null}{canManage && run ? (
            <div className={detailStyles.actions}>
              {run.status === 'prepared' || (live && run.status !== 'stopped') ? (
                <Button size="field" variant="danger" onClick={() => setAsk({ kind: 'cancel' })}><Ban size={16} aria-hidden="true" />取り消す</Button>
              ) : null}
              {live && run.status !== 'stopped' ? (
                <Button size="field" onClick={() => setAsk({ kind: 'stop' })}><CirclePause size={16} aria-hidden="true" />止める</Button>
              ) : null}
              {run.status === 'prepared' ? (
                <Button size="field" href={`/hq/broadcasts/new?id=${encodeURIComponent(run.id)}`}><PencilLine size={16} aria-hidden="true" />下書きを直す</Button>
              ) : null}
              {run.status === 'prepared' ? (
                <Button size="field" onClick={() => setTestOpen(true)}><Send size={16} aria-hidden="true" />テストを送る</Button>
              ) : null}
              {run.status === 'prepared' ? (
                gate === 'needsRequest' ? (
                  <Button size="field" variant="primary" onClick={() => setRequestOpen(true)}>承認を依頼する</Button>
                ) : (
                  <Button size="field" variant="primary" onClick={() => { setConfirmCount(''); setAsk({ kind: 'send' }) }} disabled={(totals?.sendStores ?? 0) === 0 || gate === 'pending'} title={(totals?.sendStores ?? 0) === 0 ? '送れる店がありません' : gate === 'pending' ? '承認を待っています' : undefined} >
                    <Send size={16} aria-hidden="true" />{`${n(totals?.sendStores ?? 0)}店に送る`}
                  </Button>
                )
              ) : null}
            </div>
          ) : null}</>} />
        {run ? (
          <div className={detailStyles.tabs}>
            <Tabs
              label="一括配信の詳細"
              items={[
                { label: '概要', current: tab === 'overview', onClick: () => selectTab('overview') },
                { label: `宛先 ${n(sentTo.reduce((sum, t) => sum + (t.totalCount ?? 0), 0))}`, current: tab === 'recipients', onClick: () => selectTab('recipients') },
                { label: '記録', current: tab === 'activity', onClick: () => selectTab('activity') },
              ]}
            />
          </div>
        ) : null}
        <div className={detailStyles.split}>
          <div className={detailStyles.main}>
            <ListPageSection>
            {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
            {run && tab === 'recipients' ? <RecipientsTab run={run} /> : null}
            {run && tab === 'activity' ? <ActivityTab run={run} names={names} /> : null}
            {run && tab === 'overview' && run.status === 'prepared' && canManage ? (
              <HqApprovalBlock
                run={run}
                approval={approval}
                requestOpen={requestOpen}
                onRequestClose={() => setRequestOpen(false)}
                onChanged={() => void load()}
                scheduledLabel={run.scheduledAt ? jpDateTime(run.scheduledAt) : null}
                messageSummary={messageText}
              />
            ) : null}
            {tab === 'overview' && run && run.status !== 'prepared' ? (
              <>
                <h3 className={detailStyles.secTitle}>配信結果</h3>
                <KpiBand density="compact">
                  <KpiCard icon={null} title="届いた" value={delivered} unit={'人'} detail={`送ったアカウント ${n(sentTo.length)}`} />
                  <KpiCard icon={null} title="開いた" value={opened} unit={opened == null ? '' : '人'} detail={opened == null ? 'まだ数えていません' : `開封 ${rate(opened)}`} />
                  <KpiCard icon={null} title="押した" value={clicked} unit={clicked == null ? '' : '人'} detail={clicked == null ? 'まだ数えていません' : `クリック ${rate(clicked)}`} />
                  <KpiCard icon={null} title="反応" value={reacted} unit={reacted == null ? '' : '人'} detail={reacted == null ? 'まだ数えていません' : '送ったあとに返信などがあった人'} />
                </KpiBand>
                <p className={detailStyles.note}>開いた・押したは、各アカウントの配信で数えた人数の合計です。数えていないアカウントがあるときは「—」で出します。反応は、送ったあとにメッセージを受け取った人の数で、送った配信への返信とは限りません。</p>
                <h3 className={detailStyles.secTitle}>エラー</h3>
                <p className={detailStyles.note}>{failedPeople > 0 ? `送信に失敗した人が ${n(failedPeople)} 人います。下の内訳からやり直せます。` : '送信に失敗した人はいません（0 人）。'}{skipped > 0 ? `送らなかったアカウントが ${n(skipped)}あります。` : ''}</p>
              </>
            ) : null}
            {tab === 'overview' || !run ? (
              <section className={detailStyles.section}>
                <h3 className={detailStyles.secTitle}>アカウント別の内訳</h3>
                {body}
              </section>
            ) : null}
            </ListPageSection>
          </div>
          {run ? <aside className={detailStyles.side} aria-label="配信した設定とメッセージ">
            <h3 className={detailStyles.secTitle}>配信した設定</h3>
            <dl className={detailStyles.rows}>
              {[
                ['送るアカウント', `${n(sentTo.length)}アカウント${skipped ? `（外した ${n(skipped)}）` : ''}`],
                ['対象', `${audience} ${n(people)} 人`],
                [run?.status === 'prepared' ? '送る日時' : '送った日時', run?.scheduledAt ? jpDateTime(run.scheduledAt) : 'すぐ送る'],
                ['送り方', deliveryWayText(run?.input, run?.status !== 'prepared')],
                ['メッセージ', messageText],
              ].map(([label, value]) => (
                <div key={label} className={detailStyles.row}><dt>{label}</dt><dd title={value}>{value}</dd></div>
              ))}
            </dl>
            {run ? (
              <>
                <h3 className={detailStyles.secTitle}>メッセージ</h3>
                <BroadcastPhone
                  broadcast={{ messageType: run.input?.messageType ?? 'text', messageContent: previewText(fromApiContent(run.input?.messageContent ?? ''), exampleStore), messageBubbles: bubbles }}
                  accountName={exampleStore}
                  chip={run.scheduledAt ? jpDateTime(run.scheduledAt) : '送る前の見本'}
                  time={run.scheduledAt ? jpDateTime(run.scheduledAt).replace(/^.*）/, '') : emptyValue('unknown')}
                />
              </>
            ) : null}
          </aside> : null}
        </div>
      </PageFrame>
      {ask ? (
        <ConfirmDialog
          open
          title={confirmText[ask.kind].title}
          description={confirmText[ask.kind].description}
          confirmLabel={confirmText[ask.kind].label}
          destructive={ask.kind === 'cancel' || ask.kind === 'stop'}
          warning={ask.kind === 'send'}
          busy={busy}
          onConfirm={ask.kind !== 'send' || gate !== 'single' || (approval.state && Number(confirmCount) === approval.state.gate.recipientCount) ? () => act() : undefined}
          error={error || undefined}
          confirmDisabled={actConflict || Boolean(loadError) || ((ask.kind === 'retry' || ask.kind === 'retry-all') && retryCount === null)}
          confirmDisabledReason={retryCount === null && (ask.kind === 'retry' || ask.kind === 'retry-all') ? '送る相手を確認できません。閉じてもう一度お試しください。' : '閉じて最新の状態を確認してください。'}
          onSuccess={() => setAsk(null)}
          onCancel={() => { setAsk(null); setError(''); if (actConflict) void load() }}
        >
          {ask.kind === 'send' && run ? <OperationTargetSummary accounts={run.targets.filter((target) => !target.excluded && target.blockedReasons.length === 0).map((target) => ({ id: target.accountId, name: target.accountName }))} showAccountCount /> : null}
          {ask.kind === 'retry' || ask.kind === 'retry-all' ? <><OperationTargetSummary accounts={remainingRetryTargets.map(target => ({ id: target.accountId, name: target.accountName }))} compactAccounts /><p>{ask.kind === 'retry-all' ? `${n(remainingRetryTargets.length)}店・${retryCountText}` : retryCountText}</p></> : null}
          {ask.kind === 'send' && gate === 'single' && approval.state ? <SingleOperatorFields recipientCount={approval.state.gate.recipientCount} value={confirmCount} onChange={setConfirmCount} /> : null}
        </ConfirmDialog>
      ) : null}
      {run && run.status === 'prepared' ? (
        <HqTestSendDialog open={testOpen} accounts={run.targets.filter((t) => !t.excluded).map((t) => ({ id: t.accountId, name: t.accountName }))} prepare={async () => run.id} onClose={() => setTestOpen(false)} />
      ) : null}
    </>
  )
}
