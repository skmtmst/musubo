'use client'

import { ValueBarChart, LineChart, FunnelChart } from '@/components/shared/charts'

/*
 * ★V8 Googleビジネス パフォーマンス（）。
 * 数4（共通の KpiCard）→ 飲食店向け指標 → 注。期間は 7／28／90 日（今の画面と同じ口・既定28日）。
 * 表示数の推移は、飲食店向け指標の題の右の操作から開閉する。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, MapPin, MousePointerClick, Phone } from 'lucide-react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import SectionHeader from '@/components/shared/section-header'
import ListToolbar from '@/components/shared/list-toolbar'
import KpiBand from '@/components/shared/kpi-band'
import PeriodPicker from '@/components/shared/period-picker'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import {
  restaurantGoogleApi,
  type GooglePerformanceData,
  type GooglePerformanceDays,
  type GooglePerformanceTotals,
} from '@/lib/restaurant-google-api'
import { displayRange } from '@/lib/display-range'
import { errorMessage } from './format'
import { useGooglePermission } from './use-google-permission'
import styles from './google.module.css'
import { formatDate as polishFormatDate, formatNumber as polishFormatNumber } from '@/lib/format'


const METRICS: Array<{ key: keyof GooglePerformanceTotals; title: string; icon: typeof Eye }> = [
  { key: 'impressions', title: 'プロフィール表示', icon: Eye },
  { key: 'directionRequests', title: 'ルート検索', icon: MapPin },
  { key: 'callClicks', title: '電話ボタンのクリック', icon: Phone },
  { key: 'websiteClicks', title: 'サイトへのクリック', icon: MousePointerClick },
]

/** 前期比「前の28日より +12%」。比べられないときは「—」。 */
export function compareText(days: number, current: number | null, previous: number | null): string {
  if (current === null || previous === null || previous === 0) return `前の${days}日より —`
  const percent = Math.round(((current - previous) / previous) * 100)
  return `前の${days}日より ${percent >= 0 ? '+' : '−'}${Math.abs(percent)}%`
}

/** 日別値を描画用の束にまとめる。7日=1日ごと、28日=2日ごと、90日=7日ごと（今の画面と同じ）。 */
export function bucketDaily(daily: Array<{ date: string; impressions: number | null }>, days: GooglePerformanceDays): Array<{ startDate: string; total: number | null }> {
  const size = days === 7 ? 1 : days === 28 ? 2 : 7
  const buckets: Array<{ startDate: string; total: number | null }> = []
  for (let index = 0; index < daily.length; index += size) {
    const slice = daily.slice(index, index + size)
    let total: number | null = null
    for (const day of slice) {
      if (day.impressions === null) continue
      total = (total ?? 0) + day.impressions
    }
    buckets.push({ startDate: slice[0].date, total })
  }
  return buckets
}

/** 期間の言い方。Google の集計が 28 日区切りなので 30 日にはせず、「過去 28 日（Google の集計）」と書く。 */
const PERIOD_CHOICES: Array<{ days: GooglePerformanceDays; label: string }> = [
  { days: 7, label: '過去7日' },
  { days: 28, label: '過去28日（Google の集計）' },
  { days: 90, label: '過去90日' },
]

const BUCKET_LABELS: Record<GooglePerformanceDays, string> = { 7: '1日ごと', 28: '2日ごと', 90: '7日ごと' }

function shortDate(isoDate: string): string {
  return polishFormatDate(isoDate, { style: 'list-day', fallback: '—' })
}

function ImpressionsChart({ data }: { data: GooglePerformanceData }) {
  const buckets = useMemo(() => bucketDaily(data.daily, data.days), [data])
  if (!buckets.some((bucket) => bucket.total !== null)) {
    return <ListState kind="empty" title="表示数のデータがまだありません" description="夜間の自動取得のあとに表示されます。" />
  }
  return <ValueBarChart label={`プロフィール表示の推移（${BUCKET_LABELS[data.days]}の合計）`} unit="回" items={buckets.map(bucket=>({key:bucket.startDate,label:bucket.startDate,value:bucket.total}))} />
}

export default function PerformanceBoard({ accountId }: { accountId: string }) {
  const [days, setDays] = useState<GooglePerformanceDays>(28)
  const [data, setData] = useState<GooglePerformanceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [showTrend, setShowTrend] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const { allowed: canSync, lockedReason } = useGooglePermission()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      setData(await restaurantGoogleApi.performance(accountId, days))
    } catch (err) {
      setData(null)
      setLoadError(errorMessage(err, 'パフォーマンスを読み込めませんでした。'))
    } finally {
      setLoading(false)
    }
  }, [accountId, days])

  useEffect(() => { void load() }, [load])

  const sync = useCallback(async () => {
    if (!canSync || syncing) return
    setSyncing(true)
    setSyncError('')
    try {
      const result = await restaurantGoogleApi.syncPerformance(accountId)
      if (result.synced !== 1) {
        throw new Error(result.failed > 0
          ? 'Googleのデータを読み込めませんでした。接続を確認して、もう一度お試しください。'
          : 'データの取り込みを始められませんでした。機能の設定とGoogleとの接続を確認してください。')
      }
      await load()
    } catch (err) {
      setSyncError(errorMessage(err, 'Googleのデータを読み込めませんでした。'))
    } finally {
      setSyncing(false)
    }
  }, [accountId, canSync, load, syncing])

  const range = data ? displayRange(data.range.startDate.replace(/-/g, '/'), data.range.endDate.slice(5).replace('-', '/')) : ''

  return (
    <>
      <ListToolbar
        filters={<PeriodPicker days={days} onChange={(value) => setDays(value as GooglePerformanceDays)} choices={PERIOD_CHOICES} />}
        trailing={data?.lastMetricsSyncedAt ? <Button size="compact" onClick={() => void sync()} disabled={!canSync} lockedReason={lockedReason} busy={syncing} busyLabel="取得中…">データを更新</Button> : null}
      />
      {loading && !data ? <div className={styles.stateBox}><ListState kind="loading" title="パフォーマンスを読み込んでいます" /></div> : null}
      {loadError ? <ListState kind="error" title="パフォーマンスを表示できませんでした" description={loadError} onRetry={() => void load()} /> : null}
      {data ? (
        <>
          {syncError ? <Notice tone="danger" action={<Button variant="text" onClick={() => void sync()} disabled={!canSync} lockedReason={lockedReason} busy={syncing} busyLabel="取得中…">もう一度取得</Button>}>{syncError}</Notice> : null}
          {!syncError && data.lastMetricsSyncedAt === null ? <Notice tone="info" action={<Button size="compact" onClick={() => void sync()} disabled={!canSync} lockedReason={lockedReason} busy={syncing} busyLabel="取得中…">データを取得</Button>}>{syncing ? 'Googleからパフォーマンスを取得しています。' : 'まだデータがありません。Googleからパフォーマンスを取得できます。'}</Notice> : null}
          <KpiBand presentation="band" gridClassName="">
            {METRICS.map(({ key, title, icon: Icon }) => (
              <KpiCard
                key={key}
                presentation="band"
                title={title}
                icon={<Icon aria-hidden className={styles.icon13} />}
                value={data.totals[key]}
                unit="回"
                detail={compareText(data.days, data.totals[key], data.previousTotals[key])}
                help={key === 'callClicks' ? '電話ボタンが押された数です。通話が成立した数ではありません。' : undefined}
              />
            ))}
          </KpiBand>
          <Card appearance="outlined" layout="vertical" padding="default" gap="normal">
            <SectionHeader size="small" title={<>飲食店向け指標</>} actions={<Button size="compact" onClick={() => setShowTrend((current) => !current)} aria-expanded={showTrend}>表示数の推移を見る</Button>} />
            <dl className={styles.facts}>
              <div className={styles.factRow}><dt className={styles.factKey}>予約ボタンのクリック</dt><dd className={styles.factValue}>{data.food.bookings === null ? '—（連携サービス未対応）' : `${polishFormatNumber(data.food.bookings)} 回`}</dd></div>
              <div className={styles.factRow}><dt className={styles.factKey}>メニューの閲覧</dt><dd className={styles.factValue}>{data.food.menuClicks === null ? '—（対象機能を使っている店舗のみ）' : `${polishFormatNumber(data.food.menuClicks)} 回`}</dd></div>
              <div className={styles.factRow}><dt className={styles.factKey}>料理の写真の閲覧</dt><dd className={styles.factValue}>—</dd></div>
            </dl>
          </Card>
          {showTrend ? (
            <Card appearance="outlined" layout="vertical" padding="default" gap="normal" aria-label="プロフィール表示の推移">
              <div className={styles.cardHead}>
                <SectionHeader size="small" title={<>プロフィール表示の推移</>} />
                <span className={styles.spacer} aria-hidden="true" />
                <span className={styles.muted}>{`■ 表示数 / ${BUCKET_LABELS[data.days]}の合計・${range}`}</span>
                <Button variant="text" onClick={() => setShowTrend(false)}>閉じる</Button>
              </div>
              <ImpressionsChart data={data} />
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  )
}
