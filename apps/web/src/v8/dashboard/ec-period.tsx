'use client'
import { useEffect, useState } from 'react'
import { hoursDateAdd, type ApiResponse, type StyleMetric } from '@line-crm/shared'
import { fetchApi } from '@/lib/api'
import { jstDateOffset } from '@/lib/jst-datetime'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { usePermissionAccess } from '@/lib/use-feature-access'
import Link from 'next/link'
import { formatDateTime } from '@/lib/format'

// T01のec-summary応答から、この表示で使う欄だけを読む。業種4種用の予約集計には混ぜない。
type EcPeriod = { from: string; to: string; timeZone: string; asOf: string | null; status: 'available' | 'unconfigured' | 'unavailable' | 'stale'; orders: StyleMetric; repeatCustomers: StyleMetric }

export default function EcPeriodSummary({ accountId, period, customRange, showStatusNotice = true }: { accountId: string; showStatusNotice?: boolean; period: 'today' | 'last7' | 'last30' | 'last90' | 'custom'; customRange?: { from: string; to: string } | null }) {
  const canConfigure = usePermissionAccess('/ec-commerce')
  const [snapshot, setSnapshot] = useState<{ accountId: string; period: string; rangeKey: string; data: EcPeriod | null; error: unknown } | null>(null)
  const [tick, setTick] = useState(0)
  const rangeKey = period === 'custom' ? `${customRange?.from ?? ''}/${customRange?.to ?? ''}` : ''
  useEffect(() => {
    let active = true
    setSnapshot(null)
    const days = period === 'today' ? 1 : period === 'last7' ? 7 : period === 'last90' ? 90 : 30
    const from = period === 'custom' && customRange ? customRange.from : jstDateOffset(1 - days)
    const to = period === 'custom' && customRange ? hoursDateAdd(customRange.to, 1) : jstDateOffset(1)
    const query = new URLSearchParams({ account_id: accountId, from, to })
    void fetchApi<ApiResponse<EcPeriod>>(`/api/dashboard/style/ec-summary?${query}`).then(res => {
      if (!res.success) throw new Error('注文と再購入の集計を読み込めませんでした')
      if (active) setSnapshot({ accountId, period, rangeKey, data: res.data, error: null })
    }).catch(error => { if (active) setSnapshot({ accountId, period, rangeKey, data: null, error }) })
    return () => { active = false }
  }, [accountId, period, customRange?.from, customRange?.to, tick])
  const current = snapshot?.accountId === accountId && snapshot.period === period && snapshot.rangeKey === rangeKey ? snapshot : null
  const data = current?.data
  const note = (metric?: StyleMetric) => !metric ? '読み込んでいます' : data?.status === 'unavailable' ? 'まだ取り込めていません' : metric.status === 'insufficient_sample' ? '数が少ないため出せません' : metric.status === 'unconfigured' ? '未設定' : undefined
  return <>
    {current?.error ? <ListState kind="error" title="注文と再購入の集計を読み込めませんでした" error={current.error} onRetry={() => setTick(n => n + 1)} /> : null}
    <KpiBand>
      <KpiCard loading={!current} presentation="band" title="期間内の注文" value={data?.orders.value ?? null} unit="件" detail={current?.error ? '読み込めませんでした' : note(data?.orders)} help={data?.orders.formula ?? '注文日で数えます。取消と返金を除きます。'} />
      <KpiCard loading={!current} presentation="band" title="再購入した人の割合" value={data?.repeatCustomers.value == null ? null : data.repeatCustomers.value * 100} unit="%" detail={current?.error ? '読み込めませんでした' : note(data?.repeatCustomers)} help={data ? `${data.repeatCustomers.formula}（${data.repeatCustomers.numerator ?? '—'}人 / ${data.repeatCustomers.denominator ?? '—'}人）` : '同じ連携元の注文から数えます。模擬の自動LINEの成果を含めません。'} />
    </KpiBand>
    {data && showStatusNotice ? <Notice tone={data.status === 'stale' ? 'warn' : 'info'} action={canConfigure && data.status !== 'available' ? <Link href="/ec-commerce?tab=connector">ECの接続へ →</Link> : undefined}>{data.status === 'unconfigured' ? 'ECは未設定です。数字を0件としては表示していません。' : data.status === 'unavailable' ? 'ECは接続済みですが、注文をまだ取り込めていません。数字を0件としては表示していません。' : `注文日で集計：${formatDateTime(data.from)} から ${formatDateTime(data.to)} 未満（${data.timeZone}）。最終取り込み：${formatDateTime(data.asOf)}。${data.status === 'stale' ? '接続が止まっているため、取り込み済みの情報です。' : ''}`}</Notice> : null}
  </>
}
