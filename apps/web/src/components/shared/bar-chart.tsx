import React from 'react'
import { ChartNoAxesColumn } from 'lucide-react'
import { Th } from './table'
import styles from './bar-chart.module.css'

/**
 * ★管理画面 グラフ（ノード `h99Gb`）の日ごとの増減を描く棒グラフ。
 *
 * - 色は2つまで。増えた = `accent-deep`（正常・増えたの緑）、
 *   減った = `ink-faint` の灰色。赤は使わない。
 * - 数字は必ず文字でも読める（棒の色だけにしない）。1日の数は
 *   ボタンの読み上げ名・黒い吹き出し・読み上げ用の表の3か所に出す。
 * - 高さ0〜1pxの棒は押せないので、押せる範囲は列全体にする。
 * - 表示時の伸びる動きは付けない（毎回見るもので待たせない）。
 * - 外部ライブラリは使わない（CSS とボタンのみ）。
 */
export type BarChartItem = {
  /** 日付（`2026-09-20`）。選択状態の突き合わせに使う。 */
  key: string
  /** 横軸の文字（`9/20`）。1つおきに出す。 */
  axisLabel: string
  /** 吹き出しと読み上げの見出し（`9月20日（日）`）。 */
  tooltipTitle: string
  added: number
  removed: number
  /** 配信やシナリオの名前は、日付を選ぶボタンでも読む。 */
  note?: string | null
  events?: Array<{ kind: 'broadcast' | 'scenario'; label: string }>
}

function defaultTitle(date: string): string {
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  return `${month}月${day}日`
}

/**
 * 分析の日ごとの集計をグラフの1列へ写す。数値はそのまま写すだけで、
 * 足し引き・丸めはしない（画面の数と一致させるため）。
 */
export function toBarChartItems(
  days: Array<{ date: string; added: number; removed: number }>,
  options?: {
    campaigns?: Array<{ date: string; name: string; kind?: 'broadcast' | 'scenario' }>
    formatTitle?: (date: string) => string
    formatAxisLabel?: (date: string) => string
  },
): BarChartItem[] {
  const formatTitle = options?.formatTitle ?? defaultTitle
  return days.map((day) => {
    const note = (options?.campaigns ?? [])
      .filter((item) => item.date === day.date)
      .map((item) => item.name)
      .join('、')
    const events = (options?.campaigns ?? []).filter(item => item.date === day.date && item.kind)
      .map(item => ({ kind: item.kind!, label: item.name }))
    return {
      key: day.date,
      axisLabel: options?.formatAxisLabel?.(day.date) ?? `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8, 10))}`,
      tooltipTitle: formatTitle(day.date),
      added: day.added,
      removed: day.removed,
      note: note || null,
      ...(events.length ? { events } : {}),
    }
  })
}

const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]

/** 目盛りは4本まで。上端が最大値を包むきりの良い段にする。 */
export function barChartTicks(maxValue: number): number[] {
  const max = Math.max(0, Number.isFinite(maxValue) ? maxValue : 0)
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, max / 3)))
  const largeStep = [1, 2, 5, 10].map(value => value * magnitude).find(candidate => max / candidate <= 3)!
  const step = STEPS.find((candidate) => max / candidate <= 3) ?? largeStep
  const top = Math.max(step, Math.ceil(max / step) * step)
  if (!Number.isFinite(top)) return [0, max]
  const ticks: number[] = []
  for (let value = 0; value <= top; value += step) ticks.push(value)
  return ticks
}

function labelStep(count: number): number {
  if (count <= 16) return 2
  return Math.ceil(count / 8)
}

export type BarChartLegendItem = { label: string; tone: 'added' | 'removed' | 'broadcast' | 'scenario' }
const DEFAULT_LEGEND: BarChartLegendItem[] = [
  { label: '増えた', tone: 'added' },
  { label: '減った', tone: 'removed' },
]

/** 凡例を切り替えの隣へ置く板でも、色と文字は同じ部品を使う。 */
export function BarChartLegend({ items = DEFAULT_LEGEND, layout }: { items?: BarChartLegendItem[]; layout?: 'dashboard' | 'analytics' }) {
  return <ul className={styles.legend} data-layout={layout} aria-label="凡例">
    {items.map((entry) => <li key={entry.label} className={styles.legendItem}>
      <span aria-hidden="true" data-chart-tone={entry.tone} className={[styles.swatch, toneClass(entry.tone)].join(' ')} />
      {entry.label}
    </li>)}
  </ul>
}

function toneClass(tone: BarChartLegendItem['tone']): string {
  return { added: styles.swatchAdded, removed: styles.swatchRemoved, broadcast: styles.swatchBroadcast, scenario: styles.swatchScenario }[tone]
}

/** 出来事の注と日付の印は、凡例と同じ色を読む。 */
export function BarChartEventMark({ tone }: { tone: 'broadcast' | 'scenario' }) {
  return <span aria-hidden="true" data-chart-event={tone} className={[styles.eventMark, toneClass(tone)].join(' ')} />
}

/**
 * 日ごとの増減の棒グラフ。1日1列・1列全体がボタン。
 * 選んだ日は `selectedKey` の列に薄い地を敷き、押した結果の1行は
 * 画面側が出す（この部品はグラフだけを持つ）。
 */
export function BarChart({
  items,
  selectedKey,
  onSelect,
  label = '日ごとの増減',
  legend = DEFAULT_LEGEND,
  layout,
  showLegend = true,
  distribution,
}: {
  items: BarChartItem[]
  selectedKey?: string
  onSelect?: (key: string) => void
  label?: string
  /**
   * 凡例の文言（d8X09：登録／ブロック）。渡さないときは今までどおり
   * 増えた／減った。画面側で手書きしない。
   */
  legend?: BarChartLegendItem[]
  /** 短い日別グラフ。凡例を別の段へ出しても数・吹き出し・読み上げ表を保つ。 */
  layout?: 'dashboard'
  showLegend?: boolean
  /** 同じ人数の単位で、増加は基準線より上・減少は下へ描く。 */
  distribution?: 'diverging'
}) {
  const addedLabel = legend.find(item=>item.tone==='added')?.label ?? '増えた'
  const removedLabel = legend.find(item=>item.tone==='removed')?.label ?? '減った'
  const max = Math.max(1, ...items.flatMap((item) => [item.added, item.removed]))
  const ticks = barChartTicks(max)
  const top = ticks[ticks.length - 1] || 1
  const addedTop = barChartTicks(Math.max(0, ...items.map(item => item.added))).at(-1) || 1
  const removedTop = items.some(item => item.removed > 0) ? barChartTicks(Math.max(...items.map(item => item.removed))).at(-1) || 1 : 0
  const scale = Math.max(addedTop, removedTop)
  const span = addedTop / scale + removedTop / scale
  const fraction = (value: number) => (value / scale) / span * 100
  const chartTicks = distribution ? [...barChartTicks(addedTop), ...barChartTicks(removedTop).filter(value => value > 0 && value <= removedTop).map(value => -value)] : ticks
  const step = layout === 'dashboard' && items.length <= 8 ? 1 : labelStep(items.length)
  // 両端の日付は吹き出しを内側へ寄せる。真ん中そろえのままだと板の外へはみ出す（A14・分析の9月27日）。
  const tipEdgeCount = Math.max(1, Math.ceil(items.length * 0.15))
  return (
    <div className={styles.chart} data-layout={layout} data-chart-distribution={distribution} style={distribution ? ({ '--chart-zero': `${fraction(removedTop)}%` } as React.CSSProperties) : undefined}>
      {showLegend ? <BarChartLegend items={legend} layout={layout} /> : null}
      <div className={styles.plot} role="group" aria-label={label} data-blank-ok="棒の高さを共通の縦目盛りと比べるための描画領域">
        {chartTicks.map((tick) => (
          <div
            key={tick}
            aria-hidden="true"
            className={styles.gridline}
            data-chart-baseline={distribution && tick === 0 ? true : undefined}
            style={{ bottom: `${distribution ? fraction(tick) + fraction(removedTop) : (tick / top) * 100}%` }}
          >
            <span className={styles.tick}>{tick}</span>
          </div>
        ))}
        <div className={styles.columns}>
          {items.map((item, index) => {
            const selected = selectedKey !== undefined && item.key === selectedKey
            const name =
              `${item.tooltipTitle} ${addedLabel}${item.added}人・${removedLabel}${item.removed}人` +
              (item.note ? `・${item.note}` : '')
            return (
              <div key={item.key} className={styles.column} data-latest={layout === 'dashboard' && index === items.length - 1 ? true : undefined}>
                <button
                  type="button"
                  className={styles.dayButton}
                  data-tip-edge={index < tipEdgeCount ? 'start' : index >= items.length - tipEdgeCount ? 'end' : undefined}
                  aria-pressed={selected}
                  aria-label={name}
                  title={name}
                  onClick={() => onSelect?.(item.key)}
                >
                  <span aria-hidden="true" className={styles.bars}>
                    <span
                      className={[styles.bar, styles.addedBar].join(' ')}
                      data-chart-series="added"
                      style={{ height: `${distribution ? fraction(item.added) : (item.added / top) * 100}%` }}
                    />
                    <span
                      className={[styles.bar, styles.removedBar, layout === 'dashboard' ? styles.dashboardRemovedBar : ''].filter(Boolean).join(' ')}
                      data-chart-series="removed"
                      style={{ height: `${distribution ? fraction(item.removed) : (item.removed / top) * 100}%` }}
                    />
                  </span>
                  {distribution && item.events?.length ? <span className={styles.events}>{item.events.filter((event, eventIndex, events) => events.findIndex(other => other.kind === event.kind) === eventIndex).map((event, eventIndex) => <BarChartEventMark key={`${event.kind}:${eventIndex}`} tone={event.kind} />)}</span> : null}
                  <span aria-hidden="true" className={styles.tooltip}>
                    <span className={styles.tooltipTitle}>{item.tooltipTitle}</span>
                    <span>
                      {addedLabel} {item.added}人・{removedLabel} {item.removed}人
                    </span>
                  </span>
                </button>
                {index % step === 0 ? (
                  <span aria-hidden="true" className={styles.axisLabel}>
                    {item.axisLabel}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
      {/* 読み上げ用に、同じ数を表でも持つ。見出しは共通Thを使う。 */}
      <table className={styles.srOnly}>
        <caption>{label}</caption>
        <thead>
          <tr>
            <Th scope="col">日付</Th>
            <Th scope="col">{distribution ? addedLabel : '増えた'}</Th>
            <Th scope="col">{distribution ? removedLabel : '減った'}</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key}>
              <Th scope="row">{item.tooltipTitle}</Th>
              <td>{item.added}人</td>
              <td>{item.removed}人</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * まだ数えられないとき。0 の棒を並べず、何がそろえば出るかを書く。
 */
export function BarChartEmpty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className={styles.empty} role="status">
      <ChartNoAxesColumn aria-hidden="true" className={styles.emptyIcon} />
      <p className={styles.emptyTitle}>{title}</p>
      {detail ? <p className={styles.emptyDetail}>{detail}</p> : null}
    </div>
  )
}
