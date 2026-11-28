'use client'
import { ListPageStats } from '@/components/templates/list-page'
import { ValueBarChart } from '@/components/shared/charts'
import { useEffect, useState } from 'react'
import { Download, Eye, ListOrdered, MousePointerClick, Percent, SlidersHorizontal } from 'lucide-react'
import { DashboardColumns, ListPage } from '@/components/templates'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import PeriodPicker from '@/components/shared/period-picker'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { api, ApiError, type SearchConsoleMetric, type SearchConsoleMetricRow, type SearchConsolePerformance, type SearchConsoleSetup } from '@/lib/api'
import { csvCell } from '@/lib/presentation'
import { formatDateTime, formatNumber } from '@/lib/format'
import { StatePill, shortDay } from './common'
import styles from './search-console.module.css'
import Card, { CardHeader } from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import TruncatedText from '@/components/shared/truncated-text'
import { DataTable, TableHeadRow, Tr, Th, Td } from '@/components/shared/table'
import { Field } from '@/components/shared/form-controls'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField } from '@/components/shared/text-field'

/*
 * ★V8 Search Console（Pencil ・`/search-console`）。
 * 板の頭（CSV）→ 数の帯（合計クリック数・合計表示回数・平均CTR・平均掲載順位）→ 道具の段
 * （対象プロパティ・連携中・期間・連携を設定）→ 検索クリックの推移 → キーワード・ページ上位・デバイス別 → 見かたの注意。
 * つないでいないとき・閲覧権限が無いときは設定の案内。
 * 呼ぶ口（`api.searchConsole.performance(days)`）・403 とそれ以外の失敗の言い分け・CSV は今の画面（app/search-console/page.tsx）と同じ。
 */

const RANGES = [7, 28, 90] as const
type RangeDays = typeof RANGES[number]
const DEVICE_LABELS: Record<string, string> = { MOBILE: 'スマートフォン', DESKTOP: 'パソコン', TABLET: 'タブレット' }

export function deviceLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(DEVICE_LABELS, key) ? DEVICE_LABELS[key] : 'その他のデバイス'
}

function pagePath(key: string) {
  try { const url = new URL(key); return `${url.pathname}${url.search}` || '/' } catch { return key }
}

function Ranking({ title, rows, kind }: { title: string; rows: SearchConsoleMetricRow[]; kind: 'query' | 'page' }) {
  return <Card variant="form" aria-label={title}>
    <CardHeader size="stacked" title={title} />
    {rows.length === 0 ? <p>データがありません</p> : <DataTable label={title} grid={{
      columns: 'minmax(0, 1fr) var(--tpl-an-col-60) var(--tpl-an-col-70) var(--tpl-an-sc-col-64)',
      gap: 'var(--polish-space-row)', padding: '0 var(--polish-space-field)', headPadding: '0 var(--polish-space-field)',
      rowHeight: 'var(--tpl-list-row-h)',
      bodyTextSize: 'var(--text-caption)', headTextSize: 'var(--text-micro)',
    }}>
      <thead><TableHeadRow>
        <Th>{kind === 'query' ? 'キーワード' : 'ページ'}</Th>
        <Th align="right">クリック</Th>
        <Th align="right">表示回数</Th>
        <Th align="right">掲載順位</Th>
      </TableHeadRow></thead>
      <tbody>{rows.map(row => <Tr key={row.key}>
        <Td><TruncatedText value={kind === 'query' ? (row.key || '（検索語句なし）') : pagePath(row.key)} /></Td>
        <Td align="right" title={`クリックされた割合 ${formatNumber(row.ctr * 100, { digits: 1 })}%`}>{formatNumber(row.clicks)}</Td>
        <Td align="right">{formatNumber(row.impressions)}</Td>
        <Td align="right">{formatNumber(row.position, { digits: 1 })}</Td>
      </Tr>)}</tbody>
    </DataTable>}
  </Card>
}

function SetupCard({ setup, denied }: { setup: SearchConsoleSetup | null; denied: boolean }) {
  return <Card variant="form" aria-labelledby="sc-setup-title">
    <CardHeader size="stacked" titleId="sc-setup-title" title={denied ? '閲覧権限の確認が必要です' : 'Search Consoleとつなぐ設定'} meta="Search Consoleで対象プロパティを開き、サービスアカウントを「制限付きユーザー」として追加すると、検索データを読み取り専用で表示できます。" />
    <div className={styles.compareRow}><span >対象プロパティ</span><span className={styles.spacer} /><strong title={setup?.siteUrl ?? ''}>{setup?.siteUrl ?? emptyValue('unconfigured')}</strong></div>
    <div className={styles.compareRow}><span >追加するアカウント</span><span className={styles.spacer} /><strong title={setup?.serviceAccountEmail ?? ''}>{setup?.serviceAccountEmail ?? emptyValue('unconfigured')}</strong></div>
  </Card>
}

export default function SearchConsoleV8() {
  usePageTitle('Search Console')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: '分析', href: '/analytics' }])
  const [days, setDays] = useState<RangeDays>(28)
  const [data, setData] = useState<SearchConsolePerformance | null>(null)
  const [setup, setSetup] = useState<SearchConsoleSetup | null>(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)
  // 403（Google 側の閲覧権限なし）だけ権限の案内にし、通信断・500・429・success:false は失敗と読み直しを出す。
  const [loadError, setLoadError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setLoading(true); setDenied(false); setLoadError(null)
    api.searchConsole.performance(days).then((response) => {
      if (!active) return
      if (!response.success) { setData(null); setSetup(null); setLoadError(new Error('search console load failed')); return }
      if (response.data.status === 'connected') { setData(response.data); setSetup(null) } else { setData(null); setSetup(response.data) }
    }).catch((caught: unknown) => {
      if (!active) return
      setData(null); setSetup(null)
      if (caught instanceof ApiError && caught.status === 403) setDenied(true)
      else setLoadError(caught)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [days, attempt])

  const metrics: Array<{ label: string; key: keyof SearchConsoleMetric; unit: string; help: string; icon: typeof MousePointerClick }> = [
    { label: '合計クリック数', key: 'clicks', unit: '回', help: 'クリック ÷ 表示回数', icon: MousePointerClick },
    { label: '合計表示回数', key: 'impressions', unit: '回', help: 'Google検索の結果に表示された回数です', icon: Eye },
    { label: 'クリックされた割合', key: 'ctr', unit: '%', help: 'クリック ÷ 表示回数', icon: Percent },
    { label: '平均掲載順位', key: 'position', unit: '位', help: '平均値。人や場所で変わる', icon: ListOrdered },
  ]
  const exportCsv = () => {
    if (!data) return
    const lines: string[][] = [
      ['区分', '項目', '表示回数', 'クリック数', 'クリックされた割合(%)', '掲載順位'],
      ['集計', `合計（${data.startDate}〜${data.endDate}）`, String(data.summary.impressions), String(data.summary.clicks), formatNumber(data.summary.ctr * 100, { digits: 1 }), formatNumber(data.summary.position, { digits: 1 })],
      ...data.daily.map((row) => ['日別', row.key, '', String(row.clicks), '', '']),
      ...data.devices.map((device) => ['デバイス', deviceLabel(device.key), '', String(device.clicks), '', '']),
      ...data.queries.map((row) => ['キーワード', row.key || '（検索語句なし）', String(row.impressions), String(row.clicks), formatNumber(row.ctr * 100, { digits: 1 }), formatNumber(row.position, { digits: 1 })]),
      ...data.pages.map((row) => ['ページ', row.key, String(row.impressions), String(row.clicks), formatNumber(row.ctr * 100, { digits: 1 }), formatNumber(row.position, { digits: 1 })]),
    ]
    const csv = lines.map((row) => row.map((value) => csvCell(value)).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = csvFileName("Search Console")
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const settingsSiteUrl = data?.siteUrl ?? setup?.siteUrl
  const settingsHref = settingsSiteUrl ? `https://search.google.com/search-console/users?resource_id=${encodeURIComponent(settingsSiteUrl)}` : null
  const periodControl = <SaveErrorField names={["days"]}><PeriodPicker days={days} onChange={(value) => setDays(value as RangeDays)} supportedDays={RANGES} /></SaveErrorField>
  const settingsButton = settingsHref ? <Button external variant="secondary" href={settingsHref}  ><SlidersHorizontal size={16} aria-hidden="true" />連携を設定</Button> : null

  return <ListPage
    boardId="h1G4d"
    title="Search Console"
    help={<>Google の検索から、どのキーワード・どのページで人が来たかを見ます。サイトスクリプトとつなぐと、検索から友だち追加までを結べます。</>}
    actions={<Button variant="secondary" onClick={exportCsv} disabled={!data || loading}><Download size={16} aria-hidden="true" />CSVで書き出す</Button>}
  >
    {loading ? <div className={styles.body} data-gap="tab"><DelayedSkeleton loading skeleton={<Skeleton className="block h-36 w-full rounded-card" />} /></div>
      : loadError ? <div className={styles.body} data-gap="tab"><ListState kind="error" error={loadError} onRetry={() => setAttempt((current) => current + 1)} /></div>
      : !data ? <div className={styles.body} data-gap="tab">
        <div className={styles.toolbar}>{periodControl}<span className={styles.spacer} />{settingsButton}</div>
        <Notice tone="info">Search Console をつなぐと、検索からの流入が見られます。</Notice>
        <SetupCard setup={setup} denied={denied} />
      </div>
      : <>
        <ListPageStats><KpiBand>
          {metrics.map((item) => {
            const value = data.summary[item.key] * (item.key === 'ctr' ? 100 : 1)
            const previous = data.previousSummary[item.key] * (item.key === 'ctr' ? 100 : 1)
            const difference = value - previous
            const detail = item.key === 'clicks' || item.key === 'impressions' ? `前の${data.rangeDays}日より ${difference >= 0 ? '+' : ''}${formatNumber(difference)}` : item.help
            return <KpiCard key={item.key} presentation="band" title={item.label} icon={<item.icon size={16} aria-hidden="true" />} value={Math.round(value * 10) / 10} unit={item.unit} detail={detail} />
          })}
        </KpiBand></ListPageStats>
        <div className={styles.body} data-gap="tab">
          <div className={styles.controls} data-gap="narrow">
            <div className={styles.property}><Field label="対象プロパティ"><SaveErrorField names={["siteUrl","data.siteUrl","site_url","data.site_url"]}><TextField id="search-property" readOnly value={data.siteUrl} title={data.siteUrl} /></SaveErrorField></Field></div>
            <StatePill tone="ok">連携中</StatePill>
            {periodControl}
            <span className={styles.spacer} />
            {settingsButton}
          </div>
          <Card variant="form" aria-labelledby="sc-trend-title">
            <CardHeader size="stacked" titleId="sc-trend-title" title="検索クリックの推移（日別クリック数）" />
            {data.daily.length === 0 ? <ListState kind="empty" title="期間内のデータがありません" description="集計期間を変えると、ここに推移が出ます。" /> : <>
              {/* 絵どおり目盛りの無い小さい棒（summary）。日付の文字は部品の下の段に出し、最後の日に「反映待ち」を添える。 */}
              <ValueBarChart label="日別クリック数の推移" unit="クリック" presentation="summary" items={data.daily.map((row, index) => ({ key: row.key, label: index === data.daily.length - 1 ? `${shortDay(row.key)}（反映待ち）` : shortDay(row.key), value: row.clicks }))} />
            </>}
          </Card>
          <div className={styles.rankings}>
            <Ranking title="検索キーワード 上位10件" rows={data.queries} kind="query" />
            <Ranking title="検索流入ページ 上位10件" rows={data.pages} kind="page" />
            <Card variant="form" aria-labelledby="sc-devices-title">
              <CardHeader size="stacked" titleId="sc-devices-title" title="デバイス別" />
              <DataTable label="デバイス別のクリック数" grid={{ columns: 'minmax(0, 1fr) max-content', padding: '0 var(--polish-space-field)', headPadding: '0 var(--polish-space-field)', gap: 'var(--polish-space-row)', rowHeight: 'var(--tpl-list-row-h)', bodyTextSize: 'var(--text-caption)' }}><tbody>{data.devices.map((device) => {
                const ratio = data.summary.clicks ? device.clicks / data.summary.clicks * 100 : 0
                const label = deviceLabel(device.key)
                return <Tr key={device.key} title={`${label}：${ratio.toFixed(1)}%`}><Td><TruncatedText value={label} /></Td><Td align="right">{formatNumber(device.clicks)}</Td></Tr>
              })}</tbody></DataTable>
            </Card>
          </div>
          <Notice tone="info" title={`集計期間 ${data.startDate}〜${data.endDate} ／ 読み取り専用で取得・最終更新 ${formatDateTime(data.fetchedAt)}`}>見かたの注意：Search Console のデータは反映まで2〜3日かかります。直近の数字は出ません。掲載順位は平均値です。「検索から友だち追加」はサイトスクリプトで結びついた分だけを数えるものですが、その突き合わせはまだありません。</Notice>
        </div>
      </>}
  </ListPage>
}
