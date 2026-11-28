'use client'

import { knownValue } from '@/lib/known-value'
import TextLink from '@/components/shared/text-link'
import { BarChart, BarChartEventMark, BarChartLegend, toBarChartItems } from '@/components/shared/bar-chart'

/*
 * ★V8 分析「友だちの増減」（Pencil ・1152 ・閲覧のみ ）。
 * 数の帯（4つ）→ 左に日ごとの増減の棒、右に「どこから増えたか」「減った友だち」。
 * 1152 では棒が全幅になり、右の2枚はその下に横並び。
 * 呼ぶ口・数の出し方は今の画面（app/analytics/page.tsx の FriendsOverviewTab）と同じ。
 */
import { useState } from 'react'
import { ArrowLeftRight, CircleHelp, UserMinus, Users } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import HelpTip from '@/components/shared/help-tip'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { RangePickerV8 } from './common'
import { api, type AnalyticsFriendsOverview, type AnalyticsRoutesOverview } from '@/lib/api'
import {
  METRIC_STATE_TEXT,
  analyticsWeekday,
  downloadCsv,
  formatAnalyticsDate,
  metricCardState,
  metricText,
  periodCaption,
  rangeFor,
  reportPeriodLabel,
  shortDate,
  shownValue,
  useOverview,
  useRegisterExport,
} from './parts'
import Card, { CardHeader } from '@/components/shared/card'
import { DetailColumns } from '@/components/templates/detail-columns'
import { ListPageSection, ListPageStats } from '@/components/templates/list-page'
import styles from './analytics.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { useReportPeriod } from '@/components/shared/period-picker'
import { csvFileName } from '@/lib/csv-file-name'

type Day = AnalyticsFriendsOverview['data']['days'][number]
type Campaign = AnalyticsFriendsOverview['data']['campaigns'][number]

function DailyBars({ days, campaigns, selected, onSelect }: { days: Day[]; campaigns: Campaign[]; selected: string; onSelect: (date: string) => void }) {
  return <BarChart distribution="diverging" showLegend={false} items={toBarChartItems(days, {campaigns, formatTitle:(date)=>`${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日（${analyticsWeekday(date)}）`})} selectedKey={selected} onSelect={(date)=>onSelect(selected===date?'':date)} />
}

/** 経路の内訳は概要の後に読む（2つの重い集計を同時に走らせない）。 */
function RouteBreakdown({ accountId, from, to }: { accountId: string; from: string; to: string }) {
  const state = useOverview<AnalyticsRoutesOverview>(
    () => api.analytics.routesOverview(accountId, { from, to }),
    `${accountId}:${from}:${to}:friends-routes`,
  )
  if (!state.data) {
    if (state.loading) return <ListState kind="loading" title="分析を読み込んでいます" />
    return <ListState kind="error" description={state.error} onRetry={state.retry} />
  }
  // 右の列は人数の多い順に上位5件（全件は「流入と計測で詳しく見る」）。
  const routes = [...state.data.data.routes].sort((a, b) => (shownValue(b.friendAdds) ?? -1) - (shownValue(a.friendAdds) ?? -1)).slice(0, 5)
  const max = Math.max(1, ...routes.map((route) => shownValue(route.friendAdds) ?? 0))
  if (routes.length === 0) return <p className={styles.sideNote}>この期間に流入リンクから増えた友だちはいません</p>
  return <ul className={styles.routeRows}>{routes.map((route) => <li key={route.id} className={styles.routeRow}>
    <div className={styles.sideRow}><span className={styles.sideName} ><TruncatedText value={String(route.name ?? '')} /></span><strong className={styles.sideValue}>{`${metricText(route.friendAdds)} 人`}</strong></div>
    <div className={styles.track} title={`現在 ${metricText(route.currentFriends)} 人・1人あたり ${metricText(route.costPerFriend)} 円`}><span style={{ width: `${(shownValue(route.friendAdds) ?? 0) / max * 100}%` }} /></div>
  </li>)}</ul>
}

export default function FriendsV8({ accountId }: { accountId: string }) {
  const { days, setDays, range, customRange, setRange } = useReportPeriod()
  const periodLabel = reportPeriodLabel(days, Boolean(customRange))
  const [selectedDate, setSelectedDate] = useState('')
  const [asideExpanded, setAsideExpanded] = useState(false)
  const state = useOverview<AnalyticsFriendsOverview>(
    () => api.analytics.friendsOverview(accountId, range),
    `${accountId}:${range.from}:${range.to}:friends`,
  )
  const overview = state.data?.data ?? null
  const daysShown = overview !== null && (overview.state === 'available' || overview.state === 'partial')
  const exportCsv = () => {
    if (!overview) return
    downloadCsv(csvFileName("友だち分析"), [['日付', '増えた', '減った', '差し引き'], ...overview.days.map((day) => [day.date, day.added, day.removed, day.net])])
  }
  const exportReason = state.loading ? '集計結果を読み込んでいます。' : state.error || overview?.stateReason || (overview ? knownValue(METRIC_STATE_TEXT, overview.state, '集計結果を確認できません。') : '集計結果を確認できません。')
  useRegisterExport(exportCsv, !daysShown, exportReason)

  if (!state.data || !overview) {
    return <ListPageSection>
      <div className={styles.periodRow}><RangePickerV8 customRange={customRange} onRangeChange={setRange} size="small" days={days} onChange={setDays} /></div>
      {state.loading ? <ListState kind="loading" title="分析を読み込んでいます" /> : <ListState kind="error" description={state.error} onRetry={state.retry} />}
    </ListPageSection>
  }
  const addedValue = shownValue(overview.metrics.added)
  const removedValue = shownValue(overview.metrics.removed)
  // 差し引きは増加と減少から導いた値。元の2つが出せないなら差し引きも出さない。
  const netValue = addedValue === null || removedValue === null ? null : shownValue(overview.metrics.net)
  const reasonShownInBanner = overview.state !== 'available' && Boolean(overview.stateReason)
  const pendingReason = overview.stateReason ?? '日ごとの集計がまだありません'
  const selectedDay = overview.days.find((day) => day.date === selectedDate) ?? null
  const caption = periodCaption(state.data.period.from, state.data.period.to, state.data.dataCutoffAt)

  return <>
    <ListPageStats><KpiBand className={styles.band}>
      <KpiCard presentation="band" title="増えた" icon={<Users size={16} aria-hidden="true" />} value={addedValue} unit="人" {...metricCardState(overview.metrics.added, { detail: `${periodLabel}。初回 ${metricText(overview.metrics.firstTime)} 人` }, state.retry)} />
      <KpiCard presentation="band" title="減った" icon={<UserMinus size={16} aria-hidden="true" />} value={removedValue} unit="人" {...metricCardState(overview.metrics.removed, { detail: `${periodLabel}・解除を含む` }, state.retry)} />
      <KpiCard presentation="band" title="差し引き" icon={<ArrowLeftRight size={16} aria-hidden="true" />} value={netValue} unit="人" signed {...metricCardState(overview.metrics.net, { detail: `友だちは ${metricText(overview.metrics.currentFriends)} 人` }, state.retry)} />
      <KpiCard presentation="band" title="ブロック率" icon={<CircleHelp size={16} aria-hidden="true" />} value={null} unit="%" detail="ブロックの数は未取得" />
    </KpiBand></ListPageStats>
    <ListPageSection>
      {reasonShownInBanner ? <Notice tone="warn">{overview.stateReason}</Notice> : null}
      <DetailColumns presentation="analysis" asideLabel="流入と減った友だちを見る" expanded={asideExpanded} onExpandedChange={setAsideExpanded} aside={<>

          <Card variant="form" padding="roomy" layout="vertical" gap="normal" aria-labelledby="friends-routes-title">
            <CardHeader size="stacked" titleId="friends-routes-title" title="どこから増えたか" meta={`流入リンクごと・${periodLabel}`} />
            <RouteBreakdown accountId={accountId} from={range.from} to={range.to} />
            <TextLink href="/inflow-links">流入と計測で詳しく見る</TextLink>
          </Card>
          <Card variant="form" padding="roomy" layout="vertical" gap="normal" aria-labelledby="friends-removed-title">
            <CardHeader size="stacked" titleId="friends-removed-title" title="減った友だち" help={<HelpTip label="減った友だちの説明">ブロックと友だち解除を合わせた人数です。ブロックだけの内訳は未取得です。</HelpTip>} />
            <div className={styles.sideRow}><span className={styles.sideName}>ブロック・友だち解除の合計</span><strong className={styles.sideValue}>{`${metricText(overview.metrics.removed)} 人`}</strong></div>
            <p className={styles.sideNote}>{`ブロックの内訳は未取得です。${formatAnalyticsDate(state.data.period.from)}〜${formatAnalyticsDate(state.data.period.to)} の合計を表示します。`}</p>
          </Card>
      </>}>
        <Card variant="form" padding="roomy" layout="vertical" gap="normal" aria-labelledby="friends-daily-title">
          <CardHeader size="stacked" titleId="friends-daily-title"
            title={`日ごとの増減（${periodLabel}）`}
            help={<HelpTip label="日ごとの増減の説明">{`棒を選ぶとその日の数と配信・シナリオが出ます。${caption}`}</HelpTip>}
            action={<RangePickerV8 customRange={customRange} onRangeChange={setRange} size="small" days={days} onChange={(value) => { setDays(value); setSelectedDate('') }} />} />
          <BarChartLegend layout="analytics" items={[
            { label: '増えた', tone: 'added' }, { label: '減った', tone: 'removed' },
            { label: '配信した日', tone: 'broadcast' }, { label: 'シナリオを始めた日', tone: 'scenario' },
          ]} />
          {daysShown
            ? <DailyBars days={overview.days} campaigns={overview.campaigns} selected={selectedDate} onSelect={setSelectedDate} />
            : <div className={styles.emptyChart} role="status"><p>{reasonShownInBanner ? (knownValue(METRIC_STATE_TEXT, overview.state, '未取得') || '未取得') : pendingReason}</p>{overview.state === 'pending' ? <p>日ごとの集計は数分ごとに自動で更新されます。しばらくしても変わらないときは、時間をおいて開き直してください。</p> : null}</div>}
          {daysShown && (selectedDay || overview.campaigns.length > 0) ? <div className={styles.notes}>
            {selectedDay ? <p className={styles.note}><i data-kind="selected" aria-hidden="true" />{`${shortDate(selectedDay.date)}（${analyticsWeekday(selectedDay.date)}） 増加 ${selectedDay.added} 人・減少 ${selectedDay.removed} 人・差し引き ${selectedDay.net} 人`}</p> : null}
            {overview.campaigns.map((item) => <p key={item.id} className={styles.note}><BarChartEventMark tone={item.kind} />{`${shortDate(item.date)} ${item.kind === 'scenario' ? 'シナリオを始めた' : '一斉配信'}「${item.name}」`}</p>)}
          </div> : null}
        </Card>
      </DetailColumns>
    </ListPageSection>
  </>
}
