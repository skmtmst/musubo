'use client'
import { useEffect, useState } from 'react'
import { api, type EcCommerceOverview, type EcOrderList, type EcShipmentList, type EcSubscriptionList } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'
import SectionHeader from '@/components/shared/section-header'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'
import { formatDateTime, formatDay } from '@/lib/format'
import { jstDayStartIso } from '@/lib/jst-datetime'
import { DashboardRow } from '@/components/templates/dashboard-page'
import EcPeriodSummary from './ec-period'

function shippingDay(value: string | null | undefined): string {
  if (!value) return '—'
  const dateTime = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+09:00` : value
  return Number.isFinite(Date.parse(dateTime)) ? formatDay(dateTime) : '—'
}

/** 既存ECの読取りだけを使う。模擬の自動LINEは実績へ混ぜない。 */
export default function EcSummary({ accountId, period = 'today', customRange }: { accountId: string; period?: 'today' | 'last7' | 'last30' | 'last90' | 'custom'; customRange?: { from: string; to: string } | null }) {
  type Snapshot = { accountId: string; overview: EcCommerceOverview | null; orders: EcOrderList | null; shipments: EcShipmentList | null; subscriptions: EcSubscriptionList | null; ordersAvailable: boolean; ordersSynced: boolean; configured: boolean; failed: string[]; at: string }
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let active = true
    setSnapshot(null)
    const now = new Date()
    void Promise.allSettled([
      api.ecCommerce.overview(accountId),
      api.ecCommerce.orders({ lineAccountId: accountId, status: 'current', from: jstDayStartIso(now), to: jstDayStartIso(now, 1), limit: 1 }),
      api.ecCommerce.shipments({ accountId, limit: 1 }),
      api.ecCommerce.subscriptions({ lineAccountId: accountId, status: 'active', limit: 1 }),
      api.ecCommerce.connector(accountId),
      api.ecCommerce.orders({ lineAccountId: accountId, limit: 1 }),
    ]).then(([overviewResult, ordersResult, shipmentsResult, subscriptionsResult, connectorResult, historyResult]) => {
      const read = <T,>(result: PromiseSettledResult<ApiResponse<T>>): T | null => result.status === 'fulfilled' && result.value.success ? result.value.data : null
      const overview = read(overviewResult), orders = read(ordersResult), shipments = read(shipmentsResult), subscriptions = read(subscriptionsResult)
      const connector = read(connectorResult), history = read(historyResult)
      const failed = [[overview, 'つき合わせ待ち'], [orders && history, '今日の注文'], [shipments, '出荷予定'], [subscriptions, '定期便'], [connector, '接続状態']].filter(([value]) => !value).map(([, label]) => String(label))
      const syncAt = connector?.health?.lastSucceededAt
      const ordersSynced = typeof syncAt === 'string' && Number.isFinite(Date.parse(syncAt))
      const historyValid = history !== null && Number.isSafeInteger(history.total) && history.total >= 0
      const orderCount = orders?.summary?.current
      const ordersValid = typeof orderCount === 'number' && Number.isSafeInteger(orderCount) && orderCount >= 0 && orderCount === orders?.total
      if (active) setSnapshot({ accountId, overview, orders, shipments, subscriptions, ordersSynced, ordersAvailable: historyValid && ordersValid && ordersSynced,
        configured: Boolean(connector?.configured || (history?.total ?? 0) > 0 || (overview?.total ?? 0) > 0 || (shipments?.scanned ?? 0) > 0 || subscriptions?.risk?.calculatedAt), failed, at: new Date().toISOString() })
    })
    return () => { active = false }
  }, [accountId, tick])
  const data = snapshot?.accountId === accountId ? snapshot : null
  const values = data?.configured ? data : null
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  const shipments = values?.shipments
  const shipmentsComplete = shipments && count(shipments.scanned) && count(shipments.scanLimit) && count(shipments.soonCount) && shipments.scanLimit > 0 && shipments.scanned < shipments.scanLimit
  const subscriptions = values?.subscriptions
  const subscriptionsComplete = subscriptions && subscriptions.skipped?.malformedSnapshots === 0 && Array.isArray(subscriptions.items) && count(subscriptions.summary?.active) && Number.isFinite(Date.parse(subscriptions.risk?.calculatedAt ?? ''))
  const nextShipping = subscriptionsComplete && values?.subscriptions ? (values.subscriptions.summary.active === 0 ? 'なし' : shippingDay(values.subscriptions.items[0]?.nextShippingAt)) : undefined
  const allFailed = data?.failed.length === 5
  const missing = data ? '未取得のため件数は分かりません' : '読み込んでいます'
  return <DashboardRow>
    <SectionHeader title="ECの状況" note={data ? `取得 ${formatDateTime(data.at)}` : undefined} help="接続先から取り込んだ今日の注文・今日と明日の出荷予定・定期便の次回予定・つき合わせ待ちです。模擬の自動LINEは含みません。未接続・未取得の数字は「—」です。自動のLINEの設定と模擬確認は、EC連携の「自動LINE」から確認できます。" helpLabel="ECの状況の説明" href="/ec-commerce" linkLabel="注文を見る" />
    {data?.failed.length ? allFailed
      ? <ListState kind="error" title="ECの状況を読み込めませんでした" description="件数は確認できていません。時間をおいて読み直してください。" onRetry={() => setTick(n => n + 1)} />
      : <Notice tone="warn" density="compact" action={<Button size="compact" onClick={() => setTick(n => n + 1)}>もう一度読み込む</Button>}>{data.failed.join('・')}を読み込めませんでした</Notice> : null}
    <KpiBand>
      <KpiCard loading={!data} presentation="band" title="今日の注文" value={values?.ordersAvailable ? values.orders?.summary?.current : null} unit="件" detail={values?.ordersAvailable && values.orders ? '日本時間・取消と返金を除く' : values && !values.ordersSynced ? 'まだ注文を取り込んでいません' : missing} action={{ label: '注文を見る', href: '/ec-commerce' }} />
      <KpiCard loading={!data} presentation="band" title="出荷予定" value={shipmentsComplete ? values?.shipments?.soonCount : null} unit="件" detail={shipmentsComplete ? '今日と明日の合計' : values?.shipments ? '取得上限または欠測で全件を確認できません' : missing} action={{ label: '出荷予定を見る', href: '/ec-commerce' }} />
      <KpiCard loading={!data} presentation="band" title="定期便の次回" value={null} valueText={nextShipping} unit="" detail={subscriptionsComplete && nextShipping !== '—' ? '取り込み済みの次回発送日' : data ? '次回発送日を確認できていません' : '読み込んでいます'} action={{ label: '定期便を見る', href: '/ec-commerce?tab=subscriptions' }} />
      <KpiCard loading={!data} presentation="band" title="つき合わせ待ち" value={values?.overview?.identityPending ?? null} unit="件" detail="友だちとのつき合わせ" action={{ label: 'つき合わせを確認する', href: '/ec-commerce/identity-candidates' }} />
    </KpiBand>
    <EcPeriodSummary accountId={accountId} period={period} customRange={customRange} showStatusNotice={!data?.failed.length} />
  </DashboardRow>
}
