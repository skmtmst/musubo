'use client'
import TextLink from '@/components/shared/text-link'
import { ListPageStats } from '@/components/templates/list-page'
import { formatYen } from '@line-crm/shared';

/*
 * ★V8 分析「経路と成果」（Pencil ）と、その中の「成果地点ごとのレポート」（）の共通部分。
 * 数の帯（友だちになった・成果・かかった広告費・差し引き）→ 道具の段（期間・データの範囲・
 * Search Console・CSV）→ 左に全体の流れ、右に経路ごとの表。
 * 呼ぶ口・合計の出し方・CSV は今の画面（RoutesOverviewTab）と同じ。
 */
import { useMemo, useState, type ReactNode } from 'react'
import { Download, Target, TrendingUp, UserPlus, Wallet } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import { api, type AnalyticsMetric, type AnalyticsRoutesOverview } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { RangePickerV8, dataRangeCaption } from './common'
import { MetricText } from './reactions'
import { downloadCsv, metricText, rangeFor, shownValue, useOverview, useRegisterExport, CsvExportButton } from './parts'
import styles from './analytics.module.css'
import { useReportPeriod, type PeriodRange } from '@/components/shared/period-picker'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'

const SAFE_SEARCH_CONSOLE_ORIGIN = 'https://same.invalid'

function safeSearchConsoleHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
  if (trimmed.startsWith('/')) {
    if (trimmed.length >= 2 && (trimmed[1] === '/' || trimmed[1] === '\\')) return null
    try {
      const resolved = new URL(trimmed, SAFE_SEARCH_CONSOLE_ORIGIN)
      return resolved.origin === SAFE_SEARCH_CONSOLE_ORIGIN ? trimmed : null
    } catch {
      return null
    }
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null
  } catch {
    return null
  }
}

function metricSum(metrics: Array<AnalyticsMetric<number>>): number | null {
  const values = metrics.map((metric) => {
    if (!metric || typeof metric !== 'object') return null
    const value = shownValue(metric)
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  })
  return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}
const yen = (value: number | null, signed = false) => value === null ? undefined : `${signed && value > 0 ? '+' : ''}${formatYen(value)}`

/** 経路と成果の数の帯と道具の段を読み込み、本文は呼び出し側（経路の表／成果地点のレポート）が描く。 */
export function useRoutesOverview(accountId: string, controlled?: { days: number; setDays: (days: number) => void; customRange?: PeriodRange | null; setRange?: (range: PeriodRange) => void }) {
  const own = useReportPeriod()
  const days = controlled?.days ?? own.days
  const setDays = controlled?.setDays ?? own.setDays
  const customRange = controlled ? controlled.customRange : own.customRange
  const setRange = controlled ? controlled.setRange : own.setRange
  const range = customRange ?? rangeFor(days - 1)
  const state = useOverview<AnalyticsRoutesOverview>(
    () => api.analytics.routesOverview(accountId, range),
    `${accountId}:${range.from}:${range.to}:routes`,
  )
  return { days, setDays, range, customRange, setRange, state }
}

export function RoutesFrame({ accountId, children, exportCsv, exportDisabled, exportDisabledReason, days: controlledDays, onDaysChange, customRange: controlledRange, onRangeChange }: {
  accountId: string
  /** 期間を呼び出し側で持つとき（成果地点ごとのレポートは同じ期間で成果を読む）。 */
  days?: number
  onDaysChange?: (days: number) => void
  customRange?: PeriodRange | null
  onRangeChange?: (range: PeriodRange) => void
  /** 道具の段より下。渡さないときは経路の表。 */
  children?: (overview: AnalyticsRoutesOverview['data'] | null) => ReactNode
  exportCsv?: () => void
  exportDisabled?: boolean
  exportDisabledReason?: string
}) {
  const { days, setDays, customRange, setRange, state } = useRoutesOverview(accountId, controlledDays !== undefined && onDaysChange ? { days: controlledDays, setDays: onDaysChange, customRange: controlledRange, setRange: onRangeChange } : undefined)
  const overview = state.data?.data ?? null
  const exportRoutes = () => {
    if (!overview) return
    downloadCsv(csvFileName("流入経路"), [
      ['経路', '友だち', '反応', '成果', '売上', 'かかった費用', '差し引き'],
      ...overview.routes.map((item) => [item.name, shownValue(item.friendAdds), shownValue(item.reactionPeople), shownValue(item.conversions.approved), shownValue(item.conversions.revenue), shownValue(item.adCost), shownValue(item.profitAfterAdCost)]),
    ])
  }
  const onExport = exportCsv ?? exportRoutes
  const disabled = exportCsv ? Boolean(exportDisabled) : !overview || overview.routes.length === 0
  const exportReason = exportCsv ? exportDisabledReason : state.loading ? '集計結果を読み込んでいます。' : state.error || 'この期間に書き出せる経路はありません。'
  useRegisterExport(onExport, disabled, exportReason)

  if (!state.data || !overview) {
    return <div className={styles.body} data-gap="tab">
      <div className={styles.toolbar}><RangePickerV8 customRange={customRange} onRangeChange={setRange} days={days} onChange={setDays} /></div>
      {state.loading ? <ListState kind="loading" title="分析を読み込んでいます" /> : <ListState kind="error" description={state.error} onRetry={state.retry} />}
      {/* 成果地点のレポートは経路の集計とは別の口。経路が読めなくても下は出す。 */}
      {children ? children(null) : null}
    </div>
  }
  const clicks = metricSum(overview.routes.map((item) => item.clicks))
  const friends = metricSum(overview.routes.map((item) => item.friendAdds))
  const conversions = metricSum(overview.routes.map((item) => item.conversions.approved))
  const pending = metricSum(overview.routes.map((item) => item.conversions.pending))
  const rejected = metricSum(overview.routes.map((item) => item.conversions.rejected))
  const revenue = metricSum(overview.routes.map((item) => item.conversions.revenue))
  const adCost = metricSum(overview.routes.map((item) => item.adCost))
  const profit = metricSum(overview.routes.map((item) => item.profitAfterAdCost))
  const noCost = overview.routes.filter((item) => shownValue(item.adCost) === null).length

  const safeSearchConsole = safeSearchConsoleHref(overview.searchConsoleHref)

  return <>
    <ListPageStats><KpiBand className={styles.band}>
      <KpiCard presentation="band" title="友だちになった" icon={<UserPlus size={16} aria-hidden="true" />} value={friends} unit="人" detail={clicks === null ? 'クリックは未取得です' : `リンクを押した ${formatNumber(clicks)} 回から`} />
      <KpiCard presentation="band" title="成果" icon={<Target size={16} aria-hidden="true" />} value={conversions} unit="件" detail={pending === null || rejected === null ? '保留・却下は未取得です' : `保留 ${formatNumber(pending)}・却下 ${formatNumber(rejected)}`} />
      <KpiCard presentation="band" title="かかった広告費" icon={<Wallet size={16} aria-hidden="true" />} value={adCost} valueText={yen(adCost)} unit="円" detail={`費用を取れない経路 ${noCost}`} />
      <KpiCard presentation="band" title="差し引き" icon={<TrendingUp size={16} aria-hidden="true" />} value={profit} valueText={yen(profit, true)} unit="円" detail={revenue === null ? '売上は未取得です' : `売上 ${yen(revenue)} − 費用`} />
    </KpiBand></ListPageStats>
    <div className={styles.body} data-gap="tab">
      <div className={styles.toolbar}>
        <RangePickerV8 customRange={customRange} onRangeChange={setRange} days={days} onChange={setDays} />
        <span className={styles.caption}>{dataRangeCaption(state.data.period.from, state.data.period.to, state.data.dataCutoffAt)}</span>
        <span className={styles.spacer} />
        {safeSearchConsole ? <TextLink href={safeSearchConsole} truncate>Search Console を見る</TextLink> : null}
        <CsvExportButton variant="secondary" onClick={onExport} disabled={disabled} disabledReason={exportReason}><Download size={16} aria-hidden="true" />CSVで書き出す</CsvExportButton>
      </div>
      {children ? children(overview) : <RoutesTable overview={overview} clicks={clicks} />}
    </div>
  </>
}

function RoutesTable({ overview, clicks }: { overview: AnalyticsRoutesOverview['data']; clicks: number | null }) {
  const friends = metricSum(overview.routes.map((item) => item.friendAdds))
  const reactions = metricSum(overview.routes.map((item) => item.reactionPeople))
  const conversions = metricSum(overview.routes.map((item) => item.conversions.approved))
  const stages = [
    { label: 'リンクを押した', value: clicks, unit: '回' },
    { label: '友だちになった', value: friends, unit: '人' },
    { label: '1回でも反応した', value: reactions, unit: '人' },
    { label: '成果になった', value: conversions, unit: '件' },
  ]
  return <div className={styles.routesSplit}>
    <section className={styles.flowCard} aria-labelledby="routes-flow-title">
      <h2 id="routes-flow-title" className={styles.hoursTitle}>全体の流れ</h2>
      {stages.map((stage, index) => {
        const previous = index > 0 ? stages[index - 1].value : null
        const rate = previous !== null && previous > 0 && stage.value !== null && stage.value >= 0
          ? `前段の ${(stage.value / previous * 100).toFixed(1)}%`
          : undefined
        const width = stage.value !== null && clicks !== null && clicks > 0
          ? `${Math.max(0, Math.min(100, (stage.value / clicks) * 100))}%`
          : '0%'
        return <div key={stage.label} className={styles.routeRow} title={rate}>
          <div className={styles.sideRow}><span className={styles.flowLabel}>{stage.label}</span><strong className={styles.sideValue}>{stage.value === null ? emptyValue('unknown') : `${formatNumber(stage.value)} ${stage.unit}`}</strong></div>
          <div className={styles.track} data-size="flow" aria-hidden="true"><span style={{ width }} /></div>
        </div>
      })}
    </section>
    <div className={styles.routesMain}>
      <DataTable label="経路ごとの成果" columnSizing="content">
        <thead>
        <TableHeadRow>
          <Th grow truncate>経路</Th>
          <Th align="right" truncate>友だち</Th>
          <Th align="right" truncate>反応</Th>
          <Th align="right" truncate>成果</Th>
          <Th align="right" truncate>売上</Th>
          <Th align="right" truncate>かかった費用</Th>
          <Th align="right" truncate>差し引き</Th>
        </TableHeadRow>
        </thead>
        <tbody>
        {overview.routes.length === 0
          ? <Tr><Td colSpan={7}>この期間に集計できる経路はありません</Td></Tr>
          : overview.routes.map((item) => <Tr key={item.id}>
            <Td grow title={`${item.refCode ? `流入と計測 ／ ref=${item.refCode}` : '参照コードなし'} ／ クリック ${metricText(item.clicks)}`}><TruncatedText value={item.name} /></Td>
            <Td align="right" data-list-number title={`現在 ${metricText(item.currentFriends)}`}><MetricText metric={item.friendAdds} /></Td>
            <Td align="right" data-list-number><MetricText metric={item.reactionPeople} /></Td>
            <Td align="right" data-list-number title={`保留 ${metricText(item.conversions.pending)}・却下 ${metricText(item.conversions.rejected)}`}><MetricText metric={item.conversions.approved} /></Td>
            <Td align="right" data-list-number title={item.conversions.revenue.reason ?? undefined}>{shownValue(item.conversions.revenue) === null ? <span className={styles.faint}><TruncatedText value="売上は未取得" /></span> : <span>{yen(shownValue(item.conversions.revenue))}</span>}</Td>
            <Td align="right" data-list-number title={`友だち1人 ${metricText(item.costPerFriend, { currency: true })}・成果1件 ${metricText(item.costPerConversion, { currency: true })}`}>{shownValue(item.adCost) === null ? <span className={styles.faint} title={item.adCost.reason ?? undefined}>{emptyValue('unknown')}</span> : <span>{yen(shownValue(item.adCost))}</span>}</Td>
            <Td align="right" data-list-number>{shownValue(item.profitAfterAdCost) === null ? <span className={styles.faint} title={item.profitAfterAdCost.reason ?? undefined}>{emptyValue('unknown')}</span> : <span>{yen(shownValue(item.profitAfterAdCost), true)}</span>}</Td>
          </Tr>)}
        </tbody>
      </DataTable>
      <p className={styles.caption}>{`「—」は費用を取得できない経路です。広告とのつなぎで費用を取り込むと出ます。0として差し引きを計算していません（帰属は「${overview.attributionLabel}」）。`}</p>
    </div>
  </div>
}

export default function RoutesV8({ accountId }: { accountId: string }) {
  return <RoutesFrame accountId={accountId} />
}
