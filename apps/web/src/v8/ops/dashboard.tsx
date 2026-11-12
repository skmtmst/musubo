'use client'

import { ValueBarChart } from '@/components/shared/charts'

import Link from '@/components/shared/list-navigation'
import { Banknote, Hourglass, Wallet } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, type OpsDashboard, type OpsDashboardPeriod, type OpsLineUnregistered } from '@/lib/api'
import { formatDateTime, formatNumber } from '@/lib/format'
import { opsCall } from '@/components/ops/ops-ui'
import { formatYen, formatBytes } from '@/components/ops/ops-charts'
import { contractDetail, minutesLabel, revenueDetail } from '@/v8/ops/dashboard/format'
import OpsFirstRunCard from '@/v8/ops/dashboard/first-run'
import Button from '@/components/shared/button'
import Chip from '@/components/shared/chip'
import Dialog from '@/components/shared/dialog'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import PeriodPicker from '@/components/shared/period-picker'
import { OpsHead } from './shell'
import { OPS_READONLY_LOCK_REASON, useOpsReadOnlyState } from './use-ops-read-only'
import { PageFrame } from '@/components/templates/page-frame'
import { DashboardColumns } from '@/components/templates/dashboard-page'
import Card from '@/components/shared/card'
import SectionHeader from '@/components/shared/section-header'
import { GridTable, GridHeadRow, GridRow, GridCell, GridNameCell } from '@/components/shared/grid-table'
import TruncatedText from '@/components/shared/truncated-text'
import parts from './parts.module.css'
import styles from './dashboard.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import Notice from '@/components/shared/notice'

/**
 * 運営ダッシュボード V8。
 *
 * 動きは 管理画面（app/ops/dashboard）と同じ口を使う：期間（今月・先月・今年）で
 * /api/ops/dashboard を読み直す。要対応の4行は契約先一覧・お問い合わせへの入口。
 * 「Stripe と同期」は書ける運営メンバー（readOnly でない人）にだけ出す。
 */

const PERIODS: Array<{ value: OpsDashboardPeriod; label: string }> = [
  { value: 'month', label: '今月' },
  { value: 'prev_month', label: '先月' },
  { value: 'year', label: '今年' },
]

export default function OpsDashboardV8() {
  const [period, setPeriod] = useState<OpsDashboardPeriod>('month')
  const [data, setData] = useState<OpsDashboard | null>(null)
  const [error, setError] = useState('')
  const access = useOpsReadOnlyState()
  const lock = access === 'readonly' ? OPS_READONLY_LOCK_REASON : undefined
  const [syncingBilling, setSyncingBilling] = useState(false)
  const [billingSyncNotice, setBillingSyncNotice] = useState('')
  const [billingSyncError, setBillingSyncError] = useState('')
  const [unregistered, setUnregistered] = useState<OpsLineUnregistered | null>(null)
  const [unregisteredError, setUnregisteredError] = useState('')
  const [showUnregistered, setShowUnregistered] = useState(false)

  const load = useCallback(async () => {
    setError('')
    const res = await opsCall(api.ops.dashboard(period))
    if (!res.success) { setError(res.error || '読み込めませんでした'); return }
    setData(res.data)
  }, [period])

  useEffect(() => { void load() }, [load])

  // 下の「未登録の権限者」の1行のため、先に読む（窓を開いたときの読み直しは openUnregistered）。
  useEffect(() => {
    if (!data || unregistered || unregisteredError) return
    let active = true
    void (async () => {
      const res = await opsCall(api.ops.lineUnregistered())
      if (!active) return
      if (res.success) setUnregistered(res.data)
      else setUnregisteredError(res.error || '読み込めませんでした')
    })()
    return () => { active = false }
  }, [data, unregistered, unregisteredError])

  const syncBilling = async () => {
    if (access !== 'writer') return
    setSyncingBilling(true)
    setBillingSyncNotice('')
    setBillingSyncError('')
    const res = await opsCall(api.ops.billingSync())
    if (!res.success) {
      setBillingSyncError(res.error || 'Stripe と同期できませんでした。時間をおいて、もう一度お試しください。')
      setSyncingBilling(false)
      return
    }
    setBillingSyncNotice(`Stripe から ${res.data.imported} 件取り込みました（失敗 ${formatNumber(res.data.failed)} 件）`)
    await load()
    setSyncingBilling(false)
  }

  const openUnregistered = async () => {
    setShowUnregistered(true)
    if (unregistered) return
    setUnregisteredError('')
    const res = await opsCall(api.ops.lineUnregistered())
    if (!res.success) { setUnregisteredError(res.error || '読み込めませんでした'); return }
    setUnregistered(res.data)
  }

  const k = data?.kpis ?? null
  const loading = data === null && !error

  return (
    <PageFrame kind="dashboard" boardId="CyW0E" standalone>
      <OpsHead
        title="ダッシュボード"
        description="契約先の売上・使用量・お問い合わせを見て、要対応から片づけます。"
        actions={<PeriodPicker days={PERIODS.findIndex((item) => item.value === period)} choices={PERIODS.map((item, index) => ({ days: index, label: item.label }))} onChange={(value) => setPeriod(PERIODS[value].value)} />}
      />

      {!data && error ? (
        <div className={parts.panel}>
          <ListState permissionScope="hq" kind="error" title="ダッシュボードを表示できませんでした" description={error} onRetry={() => void load()} />
        </div>
      ) : (
        <div className={parts.stack}>
          {error ? <Notice tone="danger" className={parts.alertNoticePlacement} >{error}</Notice> : null}
          <KpiBand>
            <KpiCard presentation="cell" icon={<Wallet size={16} aria-hidden="true" />} title="契約中の月額合計" value={null} unit="" valueText={k ? formatYen(k.contractMonthlyTotal) : undefined} detail={k && data ? <span title={contractDetail(k.active, k.byPlan, k.filledByListPriceCount)}>{`契約中 ${k.active}・決済失敗 ${data.alerts.pastDue}（トライアルは入れない）`}</span> : emptyValue('unknown')} loading={loading} />
            <KpiCard presentation="cell" icon={<Banknote size={16} aria-hidden="true" />} title="今月の売上" value={null} unit="" valueText={k ? formatYen(k.revenueThisMonth) : undefined} detail={data && k ? <span title={revenueDetail(k.revenueDelta, k.refundsThisMonth)}>{`決済失敗 ${data.alerts.pastDue} 社`}</span> : emptyValue('unknown')} description={k ? `今月の売上（入金済み）・${revenueDetail(k.revenueDelta, k.refundsThisMonth)}` : '今月に入金済みの売上です。'} loading={loading} />
            <KpiCard presentation="cell" icon={<Hourglass size={16} aria-hidden="true" />} title="トライアル中" value={k ? k.trialing : null} unit="社" detail={data && k ? <span title={`新規 ${k.newInPeriod}件・新規トライアル ${k.newTrialsInPeriod}件・解約 ${k.churnInPeriod}件・解約率 ${k.churnRate.toFixed(1)}%`}>{`期限 3日以内 ${data.alerts.trialEndingSoon}`}</span> : emptyValue('unknown')} loading={loading} />
          </KpiBand>

          <DashboardColumns layout="cards" cardHeight="natural">{[
            <Card key="alerts" aria-label="要対応" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
              <SectionHeader title="要対応" />
              {data ? (
                <GridTable label="要対応" framed={false} design={{ columns: 'minmax(0, 1fr) var(--tpl-op-dash-count-w) var(--tpl-op-dash-open-w)', gap: 'var(--polish-space-card)', rowPadding: '0', fontSize: 'var(--polish-text-body)' }}>
                  <GridHeadRow>
                    <GridCell role="columnheader">何が</GridCell>
                    <GridCell role="columnheader" align="right">件数</GridCell>
                    <GridCell role="columnheader">操作</GridCell>
                  </GridHeadRow>
                  <AlertRow label="決済が失敗している契約先" count={data.alerts.pastDue} href="/ops/tenants?status=past_due" />
                  <AlertRow label="トライアル期限が3日以内" count={data.alerts.trialEndingSoon} href="/ops/tenants?status=trialing" />
                  <AlertRow label="LINEのトークン期限が近い店舗" count={data.alerts.lineTokenExpiring} href="/ops/tenants" />
                  <AlertRow label="未返信のお問い合わせ" count={data.alerts.unansweredTickets} href="/ops/support" />
                </GridTable>
              ) : <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />}
            </Card>,
            <Card key="revenue" aria-label="月ごとの売上" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
              <SectionHeader title="月ごとの売上" />
              {data ? <RevenueColumns rows={data.revenueByMonth} /> : <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />}
              <div className={styles.chartFoot}>
                <p className={parts.note}>単位：千円（月額の合計）・{data ? revenueSourceLabel(data.pricing, data.lastSyncedAt) : emptyValue('unknown')}</p>
                <Button size="compact" lockedReason={lock} disabled={syncingBilling || access === 'unknown'} busy={syncingBilling} busyLabel="同期しています…" onClick={() => void syncBilling()}>Stripe と同期</Button>
              </div>
              {billingSyncNotice ? <p role="status" className={parts.status}>{billingSyncNotice}</p> : null}
              {billingSyncError ? <Notice tone="danger" className={parts.alertNoticePlacement} >{billingSyncError}</Notice> : null}
            </Card>
          ]}</DashboardColumns>

          <DashboardColumns layout="cards" cardHeight="natural">{[
            <Card key="usage" aria-label="上限に近い契約先" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
              <SectionHeader title="上限に近い契約先" />
              {!data ? (
                <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />
              ) : data.usage.length === 0 ? (
                <ListState permissionScope="hq" kind="empty" title="今月はまだ使用量がありません" description="配信・バナー生成・メディア登録があると、上限に近い契約先から順に並びます。" />
              ) : (
                <GridTable label="上限に近い契約先" framed={false} design={{ columns: 'minmax(0, 1fr) var(--tpl-op-dash-rate-w) var(--tpl-op-dash-rate-w) var(--tpl-op-dash-media-w)', gap: 'var(--polish-space-card)', rowPadding: '0', fontSize: 'var(--polish-text-body)' }}>
                  <GridHeadRow>
                    <GridCell role="columnheader">契約先</GridCell>
                    <GridCell role="columnheader" align="right">配信通数</GridCell>
                    <GridCell role="columnheader" align="right" title="バナー生成">バナー</GridCell>
                    <GridCell role="columnheader" align="right" title="メディア容量">メディア</GridCell>
                  </GridHeadRow>
                  {data.usage.map((row) => (
                    <GridRow key={row.tenantId}>
                      <GridNameCell folder={false} name={<><Link href={`/ops/tenants/detail?id=${encodeURIComponent(row.tenantId)}`}><TruncatedText value={row.tenantName} /></Link><TruncatedText value={row.planLabel} /></>} />
                      <GridCell align="right" title={`${row.messages.toLocaleString('ja-JP')} / ${row.limits.messages?.toLocaleString('ja-JP') ?? '—'}`}>{usagePercent(row.messages, row.limits.messages)}</GridCell>
                      <GridCell align="right" title={`${row.bannerUnits} / ${row.limits.images ?? '—'}`}>{usagePercent(row.bannerUnits, row.limits.images)}</GridCell>
                      <GridCell align="right" title={`${formatBytes(row.mediaBytes)} / ${row.limits.mediaBytes === null ? '—' : formatBytes(row.limits.mediaBytes)}`}>{usagePercent(row.mediaBytes, row.limits.mediaBytes)}</GridCell>
                    </GridRow>
                  ))}
                </GridTable>
              )}
            </Card>,
            <Card key="tickets" aria-label="お問い合わせ（チケット）" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
              <SectionHeader title="お問い合わせ（チケット）" help={data ? `解決済み ${data.tickets.closedInPeriod}件・初回返信 ${minutesLabel(data.tickets.avgFirstReplyMinutes)}` : undefined} helpLabel="お問い合わせの集計の説明" />
              {data ? (
                <>
                  <KpiBand density="compact">
                    <KpiCard title="未対応" valueText={`${formatNumber(data.tickets.newCount)} 件`} icon={null} presentation="band" value={null} unit="" detail={null} />
                    <KpiCard title="対応中" valueText={`${formatNumber(data.tickets.inProgressCount)} 件`} icon={null} presentation="band" value={null} unit="" detail={null} />
                    <KpiCard title="平均の初回返信" valueText={hoursLabel(data.tickets.avgFirstReplyMinutes)} icon={null} presentation="band" value={null} unit="" detail={null} />
                  </KpiBand>
                  <Link href="/ops/support" className={parts.textLink}>すべて見る →</Link>
                </>
              ) : <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />}
            </Card>
          ]}</DashboardColumns>

          <DashboardColumns layout="cards" cardHeight="natural">{[
            <Card key="plans" aria-label="プラン別の契約" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
              <SectionHeader title="プラン別の契約" />
              {data ? <p className={parts.line} title={data.planShare.rows.map(row => `${row.label} ${row.percent}%`).join('・')}>{planShareLine(data.planShare.rows)}</p> : <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />}
            </Card>,
            <Card key="unregistered" aria-label="契約者専用LINEに未登録の権限者" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
              <SectionHeader title="契約者専用LINEに未登録の権限者" />
              {data ? (
                <div className={styles.lineRow}>
                  <p className={parts.line} title={`契約者専用LINEの登録 ${data.lineRegistration.registered}人 / ${formatNumber(data.lineRegistration.total)}人`}>{lineUnregisteredLine(data.lineRegistration.unregisteredCount, unregistered)}</p>
                  {data.lineRegistration.unregisteredCount > 0 ? (
                    <button type="button" className={parts.textLink} onClick={() => void openUnregistered()}>
                      {`未登録の${formatNumber(data.lineRegistration.unregisteredCount)} 人を見る`}
                    </button>
                  ) : null}
                </div>
              ) : <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />}
            </Card>
          ]}</DashboardColumns>

          <OpsFirstRunCard period={period} />
        </div>
      )}

      <Dialog
        open={showUnregistered}
        title="契約者専用LINEに未登録の権限者"
        description="契約者専用LINEの案内は、お知らせ配信の LINE の口ができてから、ここから送れるようにします。いまは対象の人を確かめられます。"
        onCancel={() => setShowUnregistered(false)}
      >
        {unregistered ? (
          unregistered.people.length === 0 ? (
            <p className={parts.line}>未登録の人はいません。</p>
          ) : (
            <GridTable label="契約者専用LINEに未登録の権限者" framed={false} design={{ columns: 'minmax(0, 1fr) minmax(0, 1fr) var(--tpl-rt-col-130)', gap: 'var(--polish-space-card)', rowPadding: '0', fontSize: 'var(--polish-text-body)' }}>
              {unregistered.people.map((p) => (
                <GridRow key={p.staffId}>
                  <GridCell><TruncatedText value={p.name} /></GridCell>
                  <GridCell><TruncatedText value={p.tenantName} /></GridCell>
                  <GridCell>{p.hasEmail ? null : <Chip tone="warn">メール未登録</Chip>}</GridCell>
                </GridRow>
              ))}
            </GridTable>
          )
        ) : unregisteredError ? (
          <ListState permissionScope="hq" kind="error" title="未登録の人を表示できませんでした" description={unregisteredError} onRetry={() => void openUnregistered()} />
        ) : <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />}
      </Dialog>
    </PageFrame>
  )
}

function AlertRow({ label, count, href }: { label: string; count: number; href: string }) {
  return (
    <GridRow>
      <GridCell><TruncatedText value={label} /></GridCell>
      <GridCell align="right">{count}</GridCell>
      <GridCell align="right">
        <Button href={href} aria-label={`${label}を開く`}>開く</Button>
      </GridCell>
    </GridRow>
  )
}

/** 月ごとの売上の柱（千円）。いちばん高い月を柱の高さいっぱいにする。いまの月は濃い緑。 */
function RevenueColumns({ rows }: { rows: Array<{ label: string; yen: number; current: boolean }> }) {
  return <ValueBarChart label="月ごとの売上" unit="円" presentation="summary" items={rows.map(r=>({key:r.label,label:r.label,value:r.yen,note:r.current?'今月':undefined,emphasis:r.current}))} />
}

function revenueSourceLabel(pricing: 'stripe_actual' | 'list_price', lastSyncedAt: string | null): string {
  if (pricing === 'list_price') return '定価で数えています'
  if (!lastSyncedAt) return 'Stripe の入金実績'
  const date = new Date(lastSyncedAt)
  if (!Number.isFinite(date.getTime())) return 'Stripe の入金実績'
  return `Stripe の入金実績（最後に取り込んだ日時 ${formatDateTime(date)}）`
}

/** 平均の初回返信（2.4 時間のように小数1桁の時間）。 */
function hoursLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—'
  return `${Math.round(Math.max(0, minutes) / 6) / 10} 時間`
}

/** 使用率（上限が無いときは —）。 */
function usagePercent(value: number, limit: number | null): string {
  if (limit === null || limit <= 0) return '—'
  return `${Math.round((value / limit) * 100)}%`
}

/** プラン別の契約の1行（スタンダード 1・プロ 1・…の順）。 */
function planShareLine(rows: Array<{ key: string; label: string; count: number }>): string {
  const order = ['standard', 'pro', 'light', 'trial']
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const known = order.filter((key) => byKey.has(key)).map((key) => byKey.get(key)!)
  const rest = rows.filter((row) => !order.includes(row.key))
  return [...known, ...rest].map((row) => `${row.label} ${row.count}`).join('・') || '契約はまだありません'
}

/** 未登録の権限者の1行（メール未登録 M 人・LINE 未登録 N 人（店 1・店 1））。 */
function lineUnregisteredLine(unregisteredCount: number, unregistered: OpsLineUnregistered | null): string {
  if (!unregistered) return `LINE 未登録 ${formatNumber(unregisteredCount)} 人`
  const noEmail = unregistered.people.filter((p) => !p.hasEmail).length
  const byTenant = new Map<string, number>()
  for (const p of unregistered.people) byTenant.set(p.tenantName, (byTenant.get(p.tenantName) ?? 0) + 1)
  const top = [...byTenant].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name, n]) => `${name} ${n}`)
  const tail = top.length > 0 ? `（${top.join('・')}）` : ''
  return `メール未登録 ${noEmail} 人・LINE 未登録 ${formatNumber(unregisteredCount)} 人${tail}`
}
