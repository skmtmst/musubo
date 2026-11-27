import type { ScenarioStats } from '@line-crm/shared'
import type { ScenarioRuns } from '@/lib/api'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'

export default function ScenarioResultSummary({ stats, summary, runsState }: {
  stats: ScenarioStats
  summary?: ScenarioRuns['summary']
  runsState?: 'idle' | 'loading' | 'ready' | 'error'
}) {
  const completed = summary?.completed ?? stats.completed
  const inProgress = summary ? summary.active + summary.delivering + summary.paused : null
  const inProgressLoading = !summary && runsState === 'loading'
  const inProgressDetail = !summary && runsState === 'error'
    ? '読み込めませんでした'
    : inProgressLoading
      ? '読み込んでいます'
      : !summary && runsState === 'idle'
        ? 'アカウント未選択'
        : '再参加を含む購読'
  const inProgressStatusLayout = !summary && (runsState === 'error' || runsState === 'loading' || runsState === 'idle') ? 'single' : undefined
  return <KpiBand data-design="KPIs">
    <KpiCard title="始まった" value={stats.enrolledTotal} unit="人"
      detail="購読を始めた人（重複なし）" help="再参加した人も1人として数えます。購読の件数とは数える範囲が異なります。" />
    <KpiCard presentation="cell" title="読み終えた" value={completed}
      unit={summary ? '件' : '人'} detail={summary ? '再参加を含む購読' : '完了した人（重複なし）'}
      help={summary ? '完了した購読の記録数です。同じ人が再参加すると複数件になります。始まった人数を分母にした割合は出しません。' : '完了の記録がある人を重複なく数えています。再参加中の人も含むため、途中の人数とは足し引きできません。'} />
    <KpiCard title="途中" loading={inProgressLoading} value={inProgress} unit="件"
      detail={inProgressDetail} detailLayout={inProgressStatusLayout}
      help="途中・送信中・止まっている購読の記録数です。購読の集計を読み込めないときは—を出します。" />
    <KpiCard presentation="cell" title="離れた" value={null} unit="人"
      detail="離脱人数の集計は未接続" help="人数と購読件数は数える範囲が異なるため、始まった人数から完了・途中の件数を引いて離脱人数にはできません。離脱人数の集計はまだ提供されていません。" />
  </KpiBand>
}
