import { CircleCheck, History, LogOut, Undo2 } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import type { WebinarAnalytics } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { percent, thisMonthReservations } from './helpers'

export default function CommentViewerStats({ analytics, state, onRetry }: {
  analytics: WebinarAnalytics | null
  state: 'idle' | 'loading' | 'ready' | 'error'
  onRetry: () => void
}) {
  const summary = state === 'ready' ? analytics?.summary ?? null : null
  const missing = state === 'error' ? '集計を読み込めませんでした' : '集計を読み込んでいます'
  const metrics = [
    { title: '申込', icon: History, value: summary?.reservations ?? null, detail: summary ? `今月 +${formatNumber(thisMonthReservations(analytics?.daily ?? []))}` : missing, help: '申し込んだ人の数です。今月の数はサーバーの集計日（UTC）を基準にしています。' },
    { title: '視聴完了', icon: CircleCheck, value: summary?.completed ?? null, detail: summary ? `申込の ${percent(summary.completed, summary.reservations)}` : missing, help: '動画の9割以上を見た人です。' },
    { title: '途中で離れた', icon: LogOut, value: summary ? Math.max(0, summary.viewers - summary.completed) : null, detail: summary ? '平均離脱時間 —' : missing, help: '入場した人から、視聴完了の人を引いた数です。途中で離れた人だけの平均離脱時間は、まだ数えていません。' },
    { title: '見ていない', icon: Undo2, value: summary ? Math.max(0, summary.reservations - summary.registeredAndJoined) : null, detail: summary ? '見逃し案内の対象' : missing, help: '申し込んだが入場の記録がない人です。' },
  ]
  return <>
    <KpiBand data-template-region="stats">
      {metrics.map(metric => <KpiCard key={metric.title} presentation="band" title={metric.title} icon={<metric.icon size={16} aria-hidden="true" />} help={metric.help} value={metric.value} unit={metric.value === null ? '' : '人'} detail={metric.detail} />)}
    </KpiBand>
    {state === 'error' ? <Notice tone="danger" action={<Button onClick={onRetry}>もう一度読み込む</Button>}>視聴の集計を読み込めませんでした。コメントの入力は続けられます。</Notice> : null}
  </>
}
