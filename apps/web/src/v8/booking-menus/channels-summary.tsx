'use client'

import { Calendar, CalendarCheck, Link, Users } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import type { BookingChannelsData } from './lib/booking-channels'

export type ChannelsSummary = {
  accountId: string
  status: 'loading' | 'ready' | 'error'
  data: BookingChannelsData | null
  conflicts: number | null
}

export default function ChannelsSummaryBand({ summary }: { summary: ChannelsSummary }) {
  const data = summary.status === 'ready' ? summary.data : null
  const activeChannels = data?.channels.filter(channel => channel.status === 'active' && channel.key !== 'google_reserve')
  const knownCounts = activeChannels?.every(channel => Number.isFinite(channel.todayCount) && channel.todayCount !== null)
  const todayCount = knownCounts ? activeChannels?.reduce((sum, channel) => sum + channel.todayCount!, 0) : null
  const missing = summary.status === 'error' ? '読み込めませんでした' : '読み込んでいます'
  const loading = summary.status === 'loading'
  const statusLayout = !data ? 'single' : undefined
  const conflictDetail = summary.conflicts === null ? '重なりを確認できませんでした' : `重なり ${summary.conflicts} 件`
  const todayLayout = !data || (knownCounts && summary.conflicts === null) ? 'single' : undefined
  return <KpiBand aria-label="予約経路の数の帯">
    <KpiCard presentation="band" title="スタッフ" icon={<Users aria-hidden size={16} />} value={data?.staff.length} unit="人" loading={loading} detail={data ? '予約を受ける人' : missing} detailLayout={statusLayout} />
    <KpiCard presentation="band" title="つながったカレンダー" icon={<Calendar aria-hidden size={16} />} value={data?.staff.filter(person => person.status === 'connected').length} unit="件" loading={loading} detail={data ? 'Google カレンダー' : missing} detailLayout={statusLayout} />
    <KpiCard presentation="band" title="予約経路" icon={<Link aria-hidden size={16} />} value={activeChannels?.length} unit="つ" loading={loading} detail={data ? '受付中の経路' : missing} detailLayout={statusLayout} />
    <KpiCard presentation="band" title="今日の予約" icon={<CalendarCheck aria-hidden size={16} />} value={todayCount} unit="件" loading={loading} detail={data ? knownCounts ? conflictDetail : '未取得' : missing} detailLayout={todayLayout} />
  </KpiBand>
}
