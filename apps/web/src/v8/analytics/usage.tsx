'use client'
import { ListPageStats } from '@/components/templates/list-page'

/*
 * ★V8 分析「使われ方」（Pencil ）。
 * 数の帯 → 注の箱 → 左に機能ごとの表（行の右端は「…」1つ。中身を見る・片づける）、右に気づいたこと。
 * 集計期間は表の下で変えられる（上には出さない）。
 * 呼ぶ口・判定・CSV は今の画面（UsageOverviewTab・app/analytics/analytics-usage.ts）と同じ。
 */
import { useEffect, useMemo, useState } from 'react'
import { PackageOpen, Clock, LayoutGrid, RefreshCw, Zap } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Button from '@/components/shared/button'
import { RowMenu } from '@/components/shared/row-actions'
import { ActionCell, DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import { DetailColumns } from '@/components/templates/detail-columns'
import Disclosure from '@/components/shared/disclosure'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { api, type AnalyticsMetric, type AnalyticsUsageOverview } from '@/lib/api'
import { DEFAULT_FEATURES, SPECIALIZED_FEATURE_KEYS, itemIsEnabled, visibleFeatureGroups } from '@/lib/feature-settings'
import { formatNumber } from '@/lib/format'
import { RangePickerV8, shortWhen } from './common'
import { MetricText } from './reactions'
import { METRIC_STATE_TEXT, downloadCsv, metricCardState, metricText, periodCaption, rangeFor, reportPeriodLabel, shownValue, useOverview, useRegisterExport, formatAnalyticsDateTime } from './parts'
import styles from './analytics.module.css'
import { useReportPeriod } from '@/components/shared/period-picker'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'

type Category = AnalyticsUsageOverview['data']['categories'][number]
function ResourceCount({ item, name }: { item: Category; name: 'created' | 'inUse' | 'unused' }) {
  return <><MetricText metric={item[name]} />{item.key === 'friend_attributes' ?
    item.breakdown?.length ? item.breakdown.map(part => <div key={part.key} className={styles.caption}>{`${part.label} ${metricText(part[name])}`}</div>)
      : <div className={styles.caption}>内訳 —（未取得）</div> : null}</>
}


/* ── app/analytics/analytics-usage.ts から写した判定（文言も同じ）。 ── */
function summarizeMenuFeatures(settings: { features: Record<string, boolean>; specializedFeatureKeys?: string[] }): { enabled: number; total: number } {
  const features = { ...DEFAULT_FEATURES, ...settings.features }
  const items = visibleFeatureGroups({
    specializedFeatureKeys: settings.specializedFeatureKeys ?? SPECIALIZED_FEATURE_KEYS.filter((key) => settings.features[key] === true),
  }).flatMap((group) => group.items)
  return { enabled: items.filter((item) => itemIsEnabled(item, features)).length, total: items.length }
}
function usageObservation(item: Category): { text: string; tone: 'normal' | 'warning' | 'unknown' } {
  if (item.brokenReferences.value !== null && item.brokenReferences.value > 0) return { text: `参照切れが${item.brokenReferences.value} 件あります`, tone: 'warning' }
  if (item.unused.value !== null && item.unused.value > 0) return { text: `${item.unused.value} 個は使われていません`, tone: 'warning' }
  if (item.unused.value === 0) return { text: 'すべて利用中です', tone: 'normal' }
  return { text: item.unused.reason ?? '利用状況を確認できません', tone: 'unknown' }
}
function referenceHealthText(metric: AnalyticsMetric<number>): string {
  const reason = metric.reason ? `: ${metric.reason}` : ''
  if (metric.state === 'failed') return `参照切れ 取得失敗${reason}`
  if (metric.state === 'unavailable' || metric.state === 'pending' || metric.state === 'insufficient') return `参照切れ 未取得${reason}`
  if (metric.state === 'partial') return `参照切れ ${metric.value === null ? emptyValue('unknown') : formatNumber(metric.value)}（一部のみ）${reason}`
  return `参照切れ ${formatNumber(metric.value ?? 0)}`
}
const canTidyUsage = (item: Category) => item.unused.value !== null && item.unused.value > 0

export default function UsageV8({ accountId }: { accountId: string }) {
  const { days, setDays, range, customRange, setRange } = useReportPeriod()
  const periodLabel = reportPeriodLabel(days, Boolean(customRange))
  const [observationsExpanded, setObservationsExpanded] = useState(false)
  const [menuFeatures, setMenuFeatures] = useState<{ enabled: number; total: number } | null>(null)
  const [menuFeaturesError, setMenuFeaturesError] = useState('')
  const [menuReload, setMenuReload] = useState(0)
  const state = useOverview<AnalyticsUsageOverview>(
    () => api.analytics.usageOverview(accountId, range),
    `${accountId}:${range.from}:${range.to}:usage`,
  )
  useEffect(() => {
    let active = true
    setMenuFeatures(null)
    setMenuFeaturesError('')
    void api.featureSettings.visibility(accountId).then((response) => {
      if (!active) return
      if (!response.success) { setMenuFeaturesError('メニューに出している機能を確認できません'); return }
      setMenuFeatures(summarizeMenuFeatures(response.data))
    }).catch(() => { if (active) setMenuFeaturesError('メニューに出している機能を確認できません') })
    return () => { active = false }
  }, [accountId, menuReload])
  const overview = state.data?.data ?? null
  const exportUsage = () => {
    if (!overview) return
    downloadCsv(csvFileName("使われ方"), [
      ['機能', '作成', '利用中', '未使用', '最終利用', '気づいたこと', '参照の状態', 'タグ作成', 'タグ利用中', 'タグ未使用', '友だち情報欄作成（保管を除く）', '友だち情報欄利用中', '友だち情報欄未使用'],
      ...overview.categories.map((item) => [item.label, shownValue(item.created), shownValue(item.inUse), shownValue(item.unused), item.lastUsedAt.value, usageObservation(item).text, referenceHealthText(item.brokenReferences), ...(['tags', 'fields'] as const).flatMap(key => {
        const part = item.breakdown?.find(entry => entry.key === key)
        return part ? [shownValue(part.created), shownValue(part.inUse), shownValue(part.unused)] : [null, null, null]
      })]),
    ])
  }
  const exportDisabled = !overview || overview.categories.length === 0
  const exportReason = state.loading ? '集計結果を読み込んでいます。' : state.error || '書き出せる機能の集計はありません。'
  useRegisterExport(exportUsage, exportDisabled, exportReason)

  if (!state.data || !overview) {
    return <div className={styles.body} data-gap="tab">
      <div className={styles.toolbar}><RangePickerV8 customRange={customRange} onRangeChange={setRange} days={days} onChange={setDays} /></div>
      {state.loading ? <ListState kind="loading" title="分析を読み込んでいます" /> : <ListState kind="error" description={state.error} onRetry={state.retry} />}
    </div>
  }
  const hours = overview.summary.estimatedHoursSaved
  const hoursValue = hours.state === 'available' || hours.state === 'partial' ? hours.value : null
  const observations = overview.categories.filter((item) => usageObservation(item).tone !== 'normal').slice(0, 3)

  return <>
    <ListPageStats><KpiBand className={styles.band}>
      <KpiCard presentation="band" title="使っている機能" icon={<LayoutGrid size={16} aria-hidden="true" />} value={menuFeatures?.enabled ?? null} unit={menuFeatures ? `/ ${menuFeatures.total}` : ''} detail={menuFeaturesError || 'メニューに出している機能のうち'} />
      <KpiCard presentation="band" title="自動で動いた回数" icon={<Zap size={16} aria-hidden="true" />} value={shownValue(overview.summary.automaticRuns)} unit="回" {...metricCardState(overview.summary.automaticRuns, { detail: `${periodLabel}・手で送ったのは${formatNumber(overview.summary.manualSends.value)} 回` }, state.retry)} />
      <KpiCard presentation="band" title="手作業が減った時間" icon={<Clock size={16} aria-hidden="true" />} value={hoursValue} unit="時間" detail={hours.reason ? (METRIC_STATE_TEXT[hours.state] || '未取得') : '1件30秒として試算'} description={hours.reason ?? undefined} onRetry={hours.state === 'failed' ? state.retry : undefined} />
      <KpiCard presentation="band" title="作ったのに使っていない" icon={<PackageOpen size={16} aria-hidden="true" />} value={shownValue(overview.summary.unusedItems)} unit="個" {...metricCardState(overview.summary.unusedItems, { detail: `参照切れ ${metricText(overview.summary.brokenReferences)} 件` }, state.retry)} description={overview.summary.brokenReferences.reason ?? overview.summary.unusedItems.reason ?? undefined} />
    </KpiBand></ListPageStats>
    <div className={styles.body} data-gap="tab">
      {overview.stateReason
        ? <Notice tone="warn">{overview.stateReason}</Notice>
        : <p className={styles.noteBox}>項目が多いほど良い、ではありません。使っていないものは使用先を確かめてから、「片づける」で整理できます。未使用の項目は自動で削除しません。</p>}
      {menuFeaturesError ? <Notice tone="danger" action={<Button variant="secondary" onClick={() => setMenuReload((n) => n + 1)}>もう一度確認</Button>}>{menuFeaturesError}</Notice> : null}
      <DetailColumns presentation="analysis" asideLabel="気づいたこと" expanded={observationsExpanded} onExpandedChange={setObservationsExpanded} aside={
        <section className={styles.flowCard} data-w="full" aria-labelledby="usage-observations-title">
          <h2 id="usage-observations-title" className={styles.hoursTitle}>気づいたこと</h2>
          {observations.length === 0 ? <p className={styles.observation}>気になる項目はありません</p> : observations.map((item) => <p key={item.key} className={styles.observation}>{`・${item.label}：${usageObservation(item).text}`}</p>)}
          <span><Button variant="secondary" onClick={() => { state.retry(); setMenuReload((value) => value + 1) }}><RefreshCw size={16} aria-hidden="true" />もう一度確認</Button></span>
          <Disclosure title="機能ごとの確認結果" size="compact"><ul className={styles.plainList}>{overview.categories.map((item) => <li key={item.key}><span>{`${item.label}：${usageObservation(item).text}`}</span><span title={item.brokenReferences.reason ?? undefined}>{` ／ ${referenceHealthText(item.brokenReferences)}`}</span></li>)}</ul></Disclosure>
        </section>
      }>
        <div className={styles.routesMain}>
          <DataTable label="機能ごとの使われ方" columnSizing="content">
            <thead>
            <TableHeadRow>
              <Th grow>機能</Th>
              <Th align="right">作成</Th>
              <Th align="right">利用中</Th>
              <Th align="right">未使用</Th>
              <Th>最終利用</Th>
              <Th aria-label="操作" />
            </TableHeadRow>
            </thead>
            <tbody>
            {overview.categories.map((item) => <Tr key={item.key}>
              <Td grow title={`${usageObservation(item).text} ／ ${referenceHealthText(item.brokenReferences)}`}><TruncatedText value={item.label} />{item.key === 'friend_attributes' && item.breakdown?.length ? <div className={styles.caption}>保管を除く</div> : null}</Td>
              <Td align="right"><ResourceCount item={item} name="created" /></Td>
              <Td align="right"><ResourceCount item={item} name="inUse" /></Td>
              <Td align="right"><ResourceCount item={item} name="unused" /></Td>
              <Td><span className={item.lastUsedAt.value === null ? styles.faint : undefined} title={item.lastUsedAt.reason ?? undefined}>{shortWhen(item.lastUsedAt.value)}</span></Td>
              {/* 行の右端は「…」1つ（B-253・絵 N8ZrUl）。中身を見る・片づけるはその中。 */}
              <ActionCell><RowMenu label={`${item.label}の操作`} items={[{ id: 'detail', label: '中身を見る', href: item.href }, ...(canTidyUsage(item) ? [{ id: 'tidy', label: '片づける', href: item.href }] : [])]} /></ActionCell>
            </Tr>)}
            </tbody>
          </DataTable>
          <p className={styles.caption}>{`${periodCaption(state.data.period.from, state.data.period.to, state.data.dataCutoffAt)} ／ 利用関係を最後に確認: ${formatAnalyticsDateTime(overview.checkedAt)}`}</p>
          <Disclosure title="集計期間を変更する" hint={periodLabel} size="compact"><RangePickerV8 customRange={customRange} onRangeChange={setRange} days={days} onChange={setDays} /></Disclosure>
        </div>
      </DetailColumns>
    </div>
  </>
}
