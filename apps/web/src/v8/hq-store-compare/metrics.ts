import type { StoreComparisonKey, StoreComparisonRow } from '@line-crm/shared'

/*
 * 店の比較の7つの数（docs/v8-requirements/gap-features/G7 §2-2）。
 * good は「大きいほど良い」か「小さいほど良い」か。平均との差の札の色（良い＝緑・悪い＝赤）を決める。
 */
export type MetricDef = {
  key: StoreComparisonKey
  label: string
  /** 表の見出し（狭い幅でも1行に入る短さ）。 */
  short: string
  good: 'high' | 'low'
  /** 表の見出しの下の説明（「？」）。 */
  help: string
}

export const METRICS: MetricDef[] = [
  { key: 'friendChange', short: '友だちの増減', label: '友だちの増減', good: 'high', help: '期間に増えた友だち－ブロックされた人（人）。' },
  { key: 'blockRate', short: 'ブロック率', label: 'ブロック率', good: 'low', help: '期間のブロック数÷期間の初めの友だち数。' },
  { key: 'clickRate', short: 'クリック率', label: '配信のクリック率', good: 'high', help: '期間の一斉配信を押した人÷送れた人。計測リンクのある配信だけ数えます。' },
  { key: 'bookings', short: '予約', label: '予約', good: 'high', help: '来店日が期間の中にある予約（取り消しは除く）。' },
  { key: 'visits', short: '来店', label: '来店', good: 'high', help: '「来店」の印を付けた件数。' },
  { key: 'noShowRate', short: '無断率', label: '無断率', good: 'low', help: '無断キャンセル÷（来店＋無断キャンセル）。' },
  { key: 'responseMinutes', short: '返事の速さ', label: '返事の速さ', good: 'low', help: 'お客さまへの最初の返事までの時間の真ん中の値（人の返事だけ）。' },
]

/** 足し上げる数（件数・人数）。そろった日数が違う店どうしでは比べられない。 */
const COUNT_KEYS: ReadonlySet<StoreComparisonKey> = new Set(['friendChange', 'bookings', 'visits'])

export type MetricValue = StoreComparisonRow['metrics'][StoreComparisonKey]

const nf = new Intl.NumberFormat('ja-JP')
const one = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export function formatMetric(key: StoreComparisonKey, value: number | null): string {
  if (value === null) return '—'
  if (key === 'friendChange') return `${value > 0 ? '+' : value < 0 ? '−' : ''}${nf.format(Math.abs(value))} 人`
  if (key === 'blockRate' || key === 'clickRate' || key === 'noShowRate') return `${one.format(value)}%`
  if (key === 'responseMinutes') return `${nf.format(Math.round(value))} 分`
  return `${nf.format(Math.round(value))} 件`
}

/** 札に出る桁に丸めたら 0 になる差は、差なしとして扱う（「+0」「−0」を出さない）。 */
export function displayedDiffIsZero(key: StoreComparisonKey, diff: number): boolean {
  const abs = Math.abs(diff)
  if (key === 'blockRate' || key === 'clickRate' || key === 'noShowRate') return one.format(abs) === '0.0'
  return Math.round(abs) === 0
}

/** 札に出る差があるか。札（formatDiff・diffTone）と「N つが違う」の数え方は、この 1 つを読む。 */
export function hasDiff(key: StoreComparisonKey, diff: number | null): diff is number {
  return diff !== null && diff !== 0 && !displayedDiffIsZero(key, diff)
}

/** 平均との差（「−2.1 pt」「+3 件」）。差が無い・取れないときは null。 */
export function formatDiff(key: StoreComparisonKey, diff: number | null): string | null {
  if (!hasDiff(key, diff)) return null
  const sign = diff > 0 ? '+' : '−'
  const abs = Math.abs(diff)
  /* 札は符号と数だけ（単位は値と見出しにあり、全文は title に残す）。札を細くして 1152 でも右端を越えない。 */
  if (key === 'blockRate' || key === 'clickRate' || key === 'noShowRate') return `${sign}${one.format(abs)}`
  return `${sign}${nf.format(Math.round(abs))}`
}

export function diffTone(def: MetricDef, diff: number | null): 'up' | 'down' | null {
  if (!hasDiff(def.key, diff)) return null
  const better = def.good === 'high' ? diff > 0 : diff < 0
  return better ? 'up' : 'down'
}

/** 平均より悪い数の個数（引き出しの「平均より下の数 4 つ」）。 */
export function worseCount(row: StoreComparisonRow): number {
  return METRICS.filter((def) => diffTone(def, row.metrics[def.key]?.diff ?? null) === 'down').length
}

export type StoreAverage = Record<StoreComparisonKey, number | null>

/**
 * 全店の平均との差（口が「比べる相手：全店の平均」で返す差と同じ式）。
 * 取れない数（available:false・値が null）、平均が出ない数（店が 3 未満など）、日数がそろっていない店の件数は null。
 */
export function averageDiff(row: StoreComparisonRow, average: StoreAverage, key: StoreComparisonKey): number | null {
  const metric = row.metrics[key]
  const base = average[key]
  if (!metric?.available || metric.value === null || base === null || base === undefined) return null
  /* 件数は、期間の全部の日がそろった店だけが平均と比べられる（口の差・平均と同じ条件）。 */
  if (COUNT_KEYS.has(key) && row.coveredDays !== row.periodDays) return null
  return metric.value - base
}

/**
 * 「7 項目中 5 つが違う」。違いは全店の平均と比べる。
 * compared＝平均と比べられた数（取れない数・平均の無い数は分母から外す）。differ＝札に出る差がある数（良い・悪いの両方）。
 */
export function diffCount(row: StoreComparisonRow, average: StoreAverage): { differ: number; compared: number } {
  let differ = 0
  let compared = 0
  for (const def of METRICS) {
    const diff = averageDiff(row, average, def.key)
    if (diff === null) continue
    compared += 1
    if (hasDiff(def.key, diff)) differ += 1
  }
  return { differ, compared }
}

/** 平均と比べられて、札に出る差が無い数（「違いだけ表示」で隠す数）。取れない数は「同じ」に数えない。 */
export function sameAsAverage(row: StoreComparisonRow, average: StoreAverage, key: StoreComparisonKey): boolean {
  const diff = averageDiff(row, average, key)
  return diff !== null && !hasDiff(key, diff)
}

/**
 * 「違いだけ表示」で表に残す列。全部の店で平均と同じ列だけを隠す。
 * どこかの店で差がある列と、どの店でも取れない列（「—」で取れないことを見せる）は残す。
 */
export function columnsWithDiff(rows: StoreComparisonRow[], average: StoreAverage): MetricDef[] {
  return METRICS.filter((def) => {
    const anyDiff = rows.some((row) => hasDiff(def.key, averageDiff(row, average, def.key)))
    const anySame = rows.some((row) => sameAsAverage(row, average, def.key))
    return anyDiff || !anySame
  })
}

export function diffCountLabel(count: { differ: number; compared: number }): string {
  return `${count.compared} 項目中 ${count.differ} つが違う`
}

/** 表の名前の下でも、違う数と比較した数を両方読める短い形。 */
export function diffCountShortLabel(count: { differ: number; compared: number }): string {
  return `${count.differ}/${count.compared}項目が違う`
}

export function formatAverage(key: StoreComparisonKey, value: number | null): string {
  return formatMetric(key, value)
}

/** 札の全文（「平均より 2.1 pt 高い」）。 */
export function diffTitle(key: StoreComparisonKey, diff: number | null, compare: 'previous' | 'average'): string | undefined {
  if (diff === null || diff === 0) return undefined
  const base = compare === 'average' ? '全店の平均' : '前の期間'
  const abs = Math.abs(diff)
  const amount = key === 'blockRate' || key === 'clickRate' || key === 'noShowRate' ? `${one.format(abs)} pt` : key === 'friendChange' ? `${nf.format(Math.round(abs))} 人` : key === 'responseMinutes' ? `${nf.format(Math.round(abs))} 分` : `${nf.format(Math.round(abs))} 件`
  return `${base}より ${amount} ${diff > 0 ? '多い' : '少ない'}`
}

/** 期間の途中から集計した店の件数に添える「12 日分」。全部の日がそろった・0 日の店は null。 */
export function coverageLabel(key: StoreComparisonKey, row: Pick<StoreComparisonRow, 'coveredDays' | 'periodDays'>): string | null {
  if (!COUNT_KEYS.has(key)) return null
  if (!(row.coveredDays > 0) || row.coveredDays >= row.periodDays) return null
  return `${nf.format(row.coveredDays)} 日分`
}
