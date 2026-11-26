import { CircleHelp, History, Undo2 } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { formatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'

type HistoryStatsProps = {
  title: string; ready: boolean; loading?: boolean; failed?: boolean; summaryFailed?: boolean
  total: number | null; grantedCount: number; spendCount: number; reversalCount: number
  manualCount?: number | null; pendingCount?: number | null; grantAmount: number; spendAmount: number
}

export default function HistoryStats({ title, ready, loading = false, failed = false, summaryFailed = false, total, grantedCount, spendCount, reversalCount, manualCount, pendingCount, grantAmount, spendAmount }: HistoryStatsProps) {
  const hasFailure = failed || summaryFailed
  return <KpiBand>
    <KpiCard presentation="band" title={title} icon={<History size={16} aria-hidden="true" />}
      loading={loading}
      value={ready ? total : null} unit="件"
      detail={<span title={`この条件で手で動かした分 ${manualCount == null ? '未取得' : `${formatNumber(manualCount)} 件`}・反映を待っている ${pendingCount == null ? '未取得' : `${formatNumber(pendingCount)} 件`}`}>
        {ready ? `付けた ${formatNumber(grantedCount)}・使った ${formatNumber(spendCount)}・取り消し ${formatNumber(reversalCount)}` : hasFailure ? '集計を読み込めませんでした' : emptyValue('unknown')}
      </span>} />
    <KpiCard presentation="band" title="付けた" icon={<CircleHelp size={16} aria-hidden="true" />}
      loading={loading}
      value={ready ? grantAmount : null} unit="マイル" detail={hasFailure ? '読み込めませんでした' : ''} />
    <KpiCard presentation="band" title="使った" icon={<CircleHelp size={16} aria-hidden="true" />}
      loading={loading}
      value={ready ? Math.abs(spendAmount) : null} unit="マイル"
      detail={ready ? `交換 ${formatNumber(spendCount)} 件` : hasFailure ? '読み込めませんでした' : emptyValue('unknown')} />
    <KpiCard presentation="band" title="取り消し" icon={<Undo2 size={16} aria-hidden="true" />}
      loading={loading}
      value={ready ? reversalCount : null} unit="件"
      detail={ready ? '注文の取り消しで引いた' : hasFailure ? '読み込めませんでした' : emptyValue('unknown')} />
  </KpiBand>
}
