import { readUiSource } from '../../../scripts/test-ui-source.mjs'
// @vitest-environment happy-dom
/*
 * ★管理画面 グラフ（ノード `h99Gb`）。
 * 増えた = `accent-deep`、減った = `ink-faint` の2色まで。
 * 数字は棒の色だけでなく文字でも読める。
 */
import React from 'react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BarChart, BarChartEmpty, BarChartLegend, barChartTicks, toBarChartItems, type BarChartLegendItem, BarChartEventMark } from './bar-chart'

const DIR = dirname(fileURLToPath(import.meta.url))
const tsx = readFileSync(join(DIR, 'bar-chart.tsx'), 'utf8')
const css = readFileSync(join(DIR, 'bar-chart.module.css'), 'utf8')
const analyticsPage = readUiSource(join(DIR, '..', '..', 'app', 'analytics', 'page.tsx'), 'utf8')

afterEach(() => cleanup())

const SAMPLE = toBarChartItems(
  [
    { date: '2026-09-19', added: 3, removed: 1 },
    { date: '2026-09-20', added: 6, removed: 0 },
    { date: '2026-09-21', added: 0, removed: 2 },
  ],
  {
    campaigns: [{ date: '2026-09-20', name: '朝の配信' }],
    formatTitle: (date) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`,
  },
)

describe('数の写し（画面と一致させる）', () => {
  it('日ごとの増減をそのまま写す（足し引き・丸めなし）', () => {
    expect(SAMPLE).toEqual([
      {
        key: '2026-09-19',
        axisLabel: '9/19',
        tooltipTitle: '9月19日',
        added: 3,
        removed: 1,
        note: null,
      },
      {
        key: '2026-09-20',
        axisLabel: '9/20',
        tooltipTitle: '9月20日',
        added: 6,
        removed: 0,
        note: '朝の配信',
      },
      {
        key: '2026-09-21',
        axisLabel: '9/21',
        tooltipTitle: '9月21日',
        added: 0,
        removed: 2,
        note: null,
      },
    ])
  })

  it('目盛りは上端が最大値を包むきりの良い段', () => {
    expect(barChartTicks(6)).toEqual([0, 2, 4, 6])
    expect(barChartTicks(0)).toEqual([0, 1])
    expect(barChartTicks(30)).toEqual([0, 10, 20, 30])
    expect(barChartTicks(99400)).toEqual([0, 50000, 100000])
    expect(barChartTicks(100001)).toEqual([0, 50000, 100000, 150000])
    expect(barChartTicks(Number.POSITIVE_INFINITY)).toEqual([0, 1])
    expect(barChartTicks(Number.MAX_VALUE)).toEqual([0, Number.MAX_VALUE])
  })
})

describe('色は2つまで（増えた=濃い緑・減った=灰色）', () => {
  it('増えた棒は accent-deep、減った棒は ink-faint', () => {
    expect(css).toMatch(/\.addedBar\s*\{[^}]*var\(--color-accent-deep\)/s)
    expect(css).toMatch(/\.removedBar\s*\{[^}]*var\(--color-ink-faint\)/s)
  })

  it('赤・3つ目の色を使わない', () => {
    expect(tsx).not.toMatch(/danger|#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/danger|#[0-9a-fA-F]{3,8}\b/)
  })

  it('凡例は「増えた」「減った」の文字を持つ', () => {
    render(<BarChart items={SAMPLE} />)
    const legend = screen.getByRole('list', { name: '凡例' })
    expect(legend.textContent).toContain('増えた')
    expect(legend.textContent).toContain('減った')
  })

  it('凡例の文言を変えられる（d8X09：登録／ブロック）', () => {
    render(
      <BarChart
        items={SAMPLE}
        legend={[
          { label: '登録', tone: 'added' },
          { label: 'ブロック', tone: 'removed' },
        ]}
      />,
    )
    const legend = screen.getByRole('list', { name: '凡例' })
    expect(legend.textContent).toContain('登録')
    expect(legend.textContent).toContain('ブロック')
    expect(legend.textContent).not.toContain('増えた')
  })

  it('凡例を外へ置いても、日を選ぶ操作と読み上げる数を保つ', () => {
    const legend: BarChartLegendItem[] = [{ label: '登録', tone: 'added' }, { label: 'ブロック', tone: 'removed' }]
    const selected: string[] = []
    render(<>
      <BarChartLegend items={legend} layout="dashboard" />
      <BarChart items={SAMPLE} layout="dashboard" showLegend={false} legend={legend} onSelect={key => selected.push(key)} />
    </>)
    expect(screen.getAllByRole('list', { name: '凡例' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '9月20日 登録6人・ブロック0人・朝の配信' }))
    expect(selected).toEqual(['2026-09-20'])
    const table = screen.getByRole('table', { name: '日ごとの増減' })
    expect(table.textContent).toContain('6人')
    expect(table.textContent).toContain('2人')
  })
})

describe('数字は文字でも読める（色だけに頼らない）', () => {
  it('1日のボタン名に数が入る', () => {
    render(<BarChart items={SAMPLE} />)
    expect(
      screen.getByRole('button', { name: '9月20日 増えた6人・減った0人・朝の配信' }),
    ).not.toBeNull()
    expect(screen.getByRole('button', { name: '9月21日 増えた0人・減った2人' })).not.toBeNull()
  })

  it('読み上げ用の表が同じ数を持つ', () => {
    render(<BarChart items={SAMPLE} />)
    const table = document.querySelector('table') as HTMLTableElement
    expect(table.textContent).toContain('9月20日')
    expect(table.textContent).toContain('6人')
    expect(table.textContent).toContain('0人')
    expect(table.textContent).toContain('2人')
  })
})

describe('押せる範囲は列全体・選んだ日が分かる', () => {
  it('押すとその日が選ばれ、aria-pressed が立つ', () => {
    let picked = ''
    render(<BarChart items={SAMPLE} selectedKey="2026-09-19" onSelect={(key) => { picked = key }} />)
    const first = screen.getByRole('button', { name: '9月19日 増えた3人・減った1人' })
    expect(first.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '9月20日 増えた6人・減った0人・朝の配信' }))
    expect(picked).toBe('2026-09-20')
  })

  it('キーボードのフォーカスが見える（CSSの指定）', () => {
    expect(css).toMatch(/:focus-visible/)
  })
})

describe('まだ数えられないとき', () => {
  it('0 の棒を並べず、何がそろえば出るかを書く', () => {
    render(<BarChartEmpty title="7日分たまると表示します" detail="いまは 3日分（9月21日から）" />)
    expect(screen.getByText('7日分たまると表示します')).not.toBeNull()
    expect(screen.getByText('いまは 3日分（9月21日から）')).not.toBeNull()
    expect(document.querySelectorAll('button').length).toBe(0)
  })
})

describe('分析画面の配線（見た目と数字の一致）', () => {
  // グラフへ渡す実際の増減と選択日の1行は app/analytics/readonly-v8-react.test.tsx が描いて確かめる。
  it('日ごとの増減の枠がV8のグラフへ実際の増減を渡す', () => {
    expect(analyticsPage).toContain("from '@/components/shared/charts'")
    expect(analyticsPage).toContain('<DailyBars')
  })

  it('減った棒に赤を使わない', () => {
    expect(analyticsPage).not.toContain('rounded-b bg-danger')
  })

  it('日ごとの数は overview.days の増減をそのまま渡す', () => {
    expect(analyticsPage).toContain('overview.campaigns')
  })
})

/*
 * V8 QA 1003-1459 ①：読み上げ用の表が見えないまま画面いっぱいの箱になり、
 * 画面全体の横はみ出し（1440で286px・1152で110px）の原因になっていた。
 * 表は `height: 0` を最小と読むうえ、画面側の `table { width: 100% }`
 * （層の外）が幅を奪い、絶対配置の包含塊＝画面いっぱいに広がる。
 * 最小・最大の両方を 0 で押さえ、箱を作らない。読み上げは残す。
 */
describe('読み上げ用の表は箱を作らない', () => {
  it('表は読み上げに残る（隠し属性なし・見出しつき）', () => {
    render(<BarChart items={SAMPLE} />)
    const table = document.querySelector('table') as HTMLTableElement
    expect(table.getAttribute('aria-hidden')).toBeNull()
    expect(table.querySelector('caption')?.textContent).toBe('日ごとの増減')
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3)
  })

  it('.srOnly は最小・最大の両方を 0 で押さえる', () => {
    expect(css).toMatch(/\.srOnly\s*\{[^}]*min-width:\s*0/s)
    expect(css).toMatch(/\.srOnly\s*\{[^}]*max-width:\s*0/s)
    expect(css).toMatch(/\.srOnly\s*\{[^}]*max-height:\s*0/s)
    expect(css).toMatch(/\.srOnly\s*\{[^}]*overflow:\s*hidden/s)
  })
})

/*
 * 黒をなくす（#2・オーナー「黒がいや」）：指を乗せた日の吹き出しは
 * 白地＋細い線＋浮く影＋ink字。黒（ink地）に戻さないための歯止め。
 */
describe('グラフの吹き出しは白（黒をなくす #2）', () => {
  it('.tooltip は白地＋ink字（ink地にしない）', () => {
    const tooltip = css.match(/\.tooltip \{[^}]*\}/s)?.[0] ?? ''
    expect(tooltip).toMatch(/background:\s*var\(--color-canvas\)/)
    expect(tooltip).toMatch(/color:\s*var\(--color-ink\)/)
    expect(tooltip).not.toMatch(/background:\s*var\(--color-ink\)/)
  })
})


describe('日別の増減と出来事の役目', () => {
  it('減少を下へ指定しても日付・元の数・選択を保つ', () => {
    const picked: string[] = []
    const { container } = render(<BarChart items={SAMPLE} distribution="diverging" onSelect={key => picked.push(key)} />)
    expect(container.querySelector('[data-chart-distribution="diverging"]')).not.toBeNull()
    expect(container.querySelector('[data-chart-baseline]')).not.toBeNull()
    expect(container.querySelector('[data-chart-series="removed"]')?.getAttribute('style')).toContain('height:')
    fireEvent.click(screen.getByRole('button', { name: '9月21日 増えた0人・減った2人' }))
    expect(picked).toEqual(['2026-09-21'])
    const table = screen.getByRole('table', { name: '日ごとの増減' })
    expect(table.textContent).toContain('2人')
    expect(table.textContent).not.toContain('-2人')
  })

  it('配信とシナリオの印を凡例と同じ役目で日付へ渡す', () => {
    const items = toBarChartItems([{ date: '2026-09-20', added: 6, removed: 0 }], { campaigns: [
      { date: '2026-09-20', name: '朝の配信', kind: 'broadcast' },
      { date: '2026-09-20', name: '来店のお礼', kind: 'scenario' },
    ] })
    const { container } = render(<>
      <BarChartLegend items={[{ label: '増えた', tone: 'added' }, { label: '配信した日', tone: 'broadcast' }, { label: 'シナリオを始めた日', tone: 'scenario' }]} layout="analytics" />
      <BarChart items={items} distribution="diverging" showLegend={false} />
      <BarChartEventMark tone="broadcast" />
    </>)
    const tones = [...container.querySelectorAll('[data-chart-event]')].map(mark => mark.getAttribute('data-chart-event'))
    expect(tones).toContain('broadcast')
    expect(tones).toContain('scenario')
    expect(container.querySelector('[data-chart-tone="broadcast"]')?.className).not.toBe(container.querySelector('[data-chart-tone="added"]')?.className)
    expect(screen.getByRole('button', { name: '9月20日 増えた6人・減った0人・朝の配信、来店のお礼' })).not.toBeNull()
    expect(screen.getAllByRole('list', { name: '凡例' })).toHaveLength(1)
  })

  it('追加の指定が無いグラフに基準線上下や出来事の印を足さない', () => {
    const { container } = render(<BarChart items={SAMPLE} />)
    expect(container.querySelector('[data-chart-distribution]')).toBeNull()
    expect(container.querySelector('[data-chart-baseline]')).toBeNull()
    expect(container.querySelector('[data-chart-event]')).toBeNull()
  })
})


it('既定のダッシュボードは従来の読み上げ用見出しを保つ', () => {
  render(<BarChart items={SAMPLE} layout="dashboard" legend={[{ label: '登録', tone: 'added' }, { label: 'ブロック', tone: 'removed' }]} />)
  const table = screen.getByRole('table', { name: '日ごとの増減' })
  expect([...table.querySelectorAll('thead th')].map(header => header.textContent)).toEqual(['日付', '増えた', '減った'])
})
