'use client'
import { ListPageStats } from '@/components/templates/list-page'

import { ValueBarChart } from '@/components/shared/charts'

/*
 * ★V8 分析「配信の反応」（Pencil ）。
 * 数の帯（配信・届いた人・押された割合・取得できない配信）→ 道具の段（期間・データの範囲・CSV）
 * → 説明 → 配信ごとの表 → 押された時間帯ごとの回数。
 * 呼ぶ口・数の出し方・CSV は今の画面（ReactionsOverviewTab）と同じ。
 */
import { useMemo, useState } from 'react'
import { CircleHelp, Download, MousePointerClick, Send, Users } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import { api, type AnalyticsMetric, type AnalyticsReactionsOverview } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { RangePickerV8, dataRangeCaption, shortDateTime } from './common'
import { METRIC_STATE_TEXT, downloadCsv, metricText, rangeFor, shownValue, useOverview, useRegisterExport, CsvExportButton } from './parts'
import styles from './analytics.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { useReportPeriod } from '@/components/shared/period-picker'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'

/** 表の数。集計待ち・取得できない数は 0 にせず「—」と理由（title）。 */
function metricStateLabel(state: string): string {
  return Object.prototype.hasOwnProperty.call(METRIC_STATE_TEXT, state)
    ? METRIC_STATE_TEXT[state as keyof typeof METRIC_STATE_TEXT]
    : '未取得'
}

export function MetricText({ metric, percent, currency }: { metric: AnalyticsMetric<number | string>; percent?: boolean; currency?: boolean }) {
  const shown = metric.state === 'available' || metric.state === 'partial'
  return <span className={shown && metric.value !== null ? undefined : styles.faint} title={metric.reason ?? undefined}>{shown ? metricText(metric, { percent, currency }) : emptyValue('unknown')}</span>
}

export default function ReactionsV8({ accountId }: { accountId: string }) {
  const { days, setDays, range, customRange, setRange } = useReportPeriod()
  const state = useOverview<AnalyticsReactionsOverview>(
    () => api.analytics.reactionsOverview(accountId, range),
    `${accountId}:${range.from}:${range.to}:reactions`,
  )
  const overview = state.data?.data ?? null
  const broadcastShown = overview ? overview.campaigns.filter((item) => item.kind === 'broadcast').length : 0
  const scenarioShown = overview ? overview.campaigns.length - broadcastShown : 0
  // 打切りに達した系統だけ、一覧に実際に出ている件数で「先頭○件まで」を告げる。
  const truncationNote = overview ? [
    overview.campaignsTruncation?.broadcast ? `一斉配信は新しい方から先頭${broadcastShown} 件` : null,
    overview.campaignsTruncation?.scenario ? `シナリオは新しい方から先頭${scenarioShown} 件` : null,
  ].filter(Boolean).join('・') : ''
  const exportCampaigns = () => {
    if (!overview) return
    downloadCsv(csvFileName("反応"), [
      ['配信', '種類', '送った日時', '対象', '到達', '送信通数', '開封', 'LINEクリック', '成果'],
      ...overview.campaigns.map((item) => [
        item.name, item.kind === 'broadcast' ? '一斉配信' : 'シナリオ', item.sentAt,
        shownValue(item.targetPeople), shownValue(item.delivered), shownValue(item.sentMessages),
        shownValue(item.opened), shownValue(item.lineClicked), shownValue(item.outcomes),
      ]),
      // 打切りのときは CSV 側にも範囲の断りを残す。
      ...(truncationNote ? [[`※${truncationNote}までを表示（それより古い配信は含みません）`]] : []),
    ])
  }
  const exportDisabled = !overview || overview.campaigns.length === 0
  const exportReason = state.loading ? '集計結果を読み込んでいます。' : state.error || 'この期間に書き出せる配信はありません。'
  useRegisterExport(exportCampaigns, exportDisabled, exportReason)

  if (!state.data || !overview) {
    return <div className={styles.body}>
      <div className={styles.toolbar}><RangePickerV8 customRange={customRange} onRangeChange={setRange} days={days} onChange={setDays} /></div>
      {state.loading ? <ListState kind="loading" title="分析を読み込んでいます" /> : <ListState kind="error" description={state.error} onRetry={state.retry} />}
    </div>
  }
  const delivered = shownValue(overview.metrics.delivered)
  const clicked = shownValue(overview.metrics.lineClicked)
  const clickRate = delivered && clicked !== null ? Math.round(clicked / delivered * 1000) / 10 : null
  const targets = overview.campaigns.reduce((sum, item) => sum + (shownValue(item.targetPeople) ?? 0), 0)
  const unavailable = overview.metrics.unavailableCampaigns
  const maxHourly = Math.max(1, ...overview.trackedClickHours.map((item) => item.clicks))
  const topHours = [...overview.trackedClickHours].sort((a, b) => b.clicks - a.clicks).slice(0, 3).filter((item) => item.clicks > 0).map((item) => item.hour)

  return <>
    <ListPageStats><KpiBand className={styles.band}>
      <KpiCard presentation="band" title="配信" icon={<Send size={16} aria-hidden="true" />} value={overview.campaigns.length} unit="件" detail={`一斉配信 ${broadcastShown}・シナリオ ${scenarioShown}`} />
      <KpiCard presentation="band" title="届いた人" icon={<Users size={16} aria-hidden="true" />} value={delivered} unit="人" detail={delivered === null ? (metricStateLabel(overview.metrics.delivered.state)) : `対象 ${formatNumber(targets)} 人のうち`} />
      <KpiCard presentation="band" title="押された割合" icon={<MousePointerClick size={16} aria-hidden="true" />} value={clickRate} unit="%" detail="LINEクリック ÷ 届いた人" />
      <KpiCard presentation="band" title="取得できない配信" icon={<CircleHelp size={16} aria-hidden="true" />} value={shownValue(unavailable)} unit="件" detail={shownValue(unavailable) === null ? (metricStateLabel(unavailable.state)) : '20人未満で数が出ない'} />
    </KpiBand></ListPageStats>
    <div className={styles.body} data-gap="tab">
      <div className={styles.toolbar}>
        <RangePickerV8 customRange={customRange} onRangeChange={setRange} days={days} onChange={setDays} />
        <span className={styles.caption} title={`データ締切 ${state.data.dataCutoffAt}`}>{dataRangeCaption(state.data.period.from, state.data.period.to, state.data.dataCutoffAt)}</span>
        <span className={styles.spacer} />
        <CsvExportButton variant="secondary" onClick={exportCampaigns} disabled={exportDisabled} disabledReason={exportReason}><Download size={16} aria-hidden="true" />CSVで書き出す</CsvExportButton>
      </div>
      <p className={styles.caption}>配信ごとの開かれ方・押され方です。20人未満など取得できない数は、0ではなく「—」と理由で示します。{truncationNote ? ` ${truncationNote}までを表示しています。それより古い配信は一覧にも CSV にも入りません。` : ''}</p>
      <div className={styles.table} role="table" aria-label="配信ごとの反応">
        <div className={styles.thead} role="row">
          <span role="columnheader" className={styles.colMain}>配信</span>
          <span role="columnheader" className={styles.colType}>種類・日時</span>
          <span role="columnheader" className={styles.num} data-w="80">対象</span>
          <span role="columnheader" className={styles.num} data-w="80" title="一斉配信で届いた人数です。シナリオは届いた人数が取れないため「—」です">到達</span>
          <span role="columnheader" className={styles.num} data-w="80" title="開いた人数です。20人未満など取得できない数は「—」で示します">開封</span>
          <span role="columnheader" className={styles.num} data-w="100" title="こちらで作った中継URLを押した人数です">LINEクリック</span>
          <span role="columnheader" className={styles.num} data-w="70">成果</span>
        </div>
        {overview.campaigns.length === 0
          ? <div className={styles.emptyRow} role="row"><span role="cell">この期間の配信はありません</span></div>
          : overview.campaigns.map((item) => <div key={`${item.kind}:${item.id}`} className={styles.trow} role="row" data-h="two">
            <span role="cell" className={styles.colMain}><span className={styles.cellText} ><TruncatedText value={String(item.name ?? '')} /></span></span>
            <span role="cell" className={styles.colType}><strong className={styles.cellStrong}>{item.kind === 'broadcast' ? '一斉配信' : 'シナリオ'}</strong><span className={styles.cellSub}>{shortDateTime(item.sentAt)}</span></span>
            <span role="cell" className={styles.num} data-w="80"><MetricText metric={item.targetPeople} />{item.kind === 'scenario' ? <span className={styles.cellSub}>送信 {metricText(item.sentMessages)} 通</span> : null}</span>
            <span role="cell" className={styles.num} data-w="80"><MetricText metric={item.delivered} /></span>
            <span role="cell" className={styles.num} data-w="80"><MetricText metric={item.opened} /></span>
            <span role="cell" className={styles.num} data-w="100"><MetricText metric={item.lineClicked} /></span>
            <span role="cell" className={styles.num} data-w="70"><MetricText metric={item.outcomes} /></span>
          </div>)}
      </div>
      <section className={styles.hours} aria-labelledby="reactions-hours-title">
        {/* 集計はクリックされた時刻の時間帯。送った時刻ではない。 */}
        <h2 id="reactions-hours-title" className={styles.hoursTitle}>押された時間帯ごとの回数</h2>
        <p className={styles.caption}>こちらで作った中継URLを、相手が押した時刻で時間帯ごとに並べています。送った時刻ではありません。</p>
        <ValueBarChart label="押された時間帯ごとの回数" unit="回" showLastAxis={false} items={Array.from({length:24},(_,hour)=>({key:String(hour),label:`${hour}時台`,value:overview.trackedClickHours.find(item=>item.hour===hour)?.clicks??0,note:topHours.includes(hour)?'よく押された時間帯':undefined}))} />
      </section>
    </div>
  </>
}
