import { Inbox, Clock, Hourglass, RotateCcw } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import type { OpsSupportSummary } from '@/lib/api'

function validStageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** 期間別の件数を作らず、集計APIから取れる状態別の件数だけを表示する。 */
export default function OpsSupportStats({ summary, loading }: { summary: OpsSupportSummary | null; loading: boolean }) {
  const byStage = summary && typeof summary.byStage === 'object' && summary.byStage !== null ? summary.byStage : null
  return (
    <KpiBand>
      <KpiCard presentation="cell" title="新規" icon={<Inbox size={16} aria-hidden="true" />} value={validStageCount(byStage?.new)} unit="件" detail="新しく受け付けた相談" loading={loading} />
      <KpiCard presentation="cell" title="対応中" icon={<Clock size={16} aria-hidden="true" />} value={validStageCount(byStage?.in_progress)} unit="件" detail="運営が対応している相談" loading={loading} />
      <KpiCard presentation="cell" title="確認待ち" icon={<Hourglass size={16} aria-hidden="true" />} value={validStageCount(byStage?.waiting)} unit="件" detail="契約先の返事待ち" loading={loading} />
      <KpiCard presentation="cell" title="解決" icon={<RotateCcw size={16} aria-hidden="true" />} value={validStageCount(byStage?.resolved)} unit="件" detail="解決済みの相談" loading={loading} />
    </KpiBand>
  )
}
