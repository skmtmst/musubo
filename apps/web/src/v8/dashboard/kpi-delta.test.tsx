// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import KpiCard from '@/components/shared/kpi-card'
import KpiDelta, { kpiDeltaText } from './kpi-delta'

afterEach(cleanup)

const delta = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-kpi-delta]')

/*
 * 数の帯の差の札。色は良し悪しの向きで決め、矢印と言葉でも増減が分かる。
 */
describe('差の札', () => {
  it('予約が先週 10 件・今日 12 件は「2 件 先週比」の緑、読み上げは「先週の同じ曜日より 2 件多い」', () => {
    const { container } = render(<KpiDelta current={12} previous={10} better="high" unit="件" />)
    const chip = delta(container)!
    expect(chip.dataset.kpiDelta).toBe('good')
    expect(chip.querySelector('[aria-hidden="true"]:not(svg)')?.textContent).toBe('+2 件 先週比')
    expect(chip.querySelector('.sr-only')?.textContent).toBe('先週の同じ曜日より 2 件多い')
    expect(chip.title).toBe('先週の同じ曜日より 2 件多い')
    expect(chip.querySelector('[data-delta-direction="up"]')).not.toBeNull()
  })

  it('友だち（増えると良い）が減ると赤、配信の失敗（減ると良い）が減ると緑', () => {
    const friends = render(<KpiDelta current={140} previous={146} better="high" unit="人" />)
    expect(delta(friends.container)?.dataset.kpiDelta).toBe('bad')
    expect(friends.container.textContent).toContain('先週の同じ曜日より 6 人少ない')
    cleanup()
    const failures = render(<KpiDelta current={1} previous={4} better="low" unit="件" />)
    expect(delta(failures.container)?.dataset.kpiDelta).toBe('good')
    expect(delta(failures.container)?.querySelector('[data-delta-direction="down"]')).not.toBeNull()
    cleanup()
    const worse = render(<KpiDelta current={4} previous={1} better="low" unit="件" />)
    expect(delta(worse.container)?.dataset.kpiDelta).toBe('bad')
    expect(delta(worse.container)?.querySelector('[data-delta-direction="up"]')).not.toBeNull()
  })

  it('差 0 は灰色の → で「先週の同じ曜日と同じ」。消さない', () => {
    const { container } = render(<KpiDelta current={5} previous={5} better="high" unit="件" />)
    const chip = delta(container)!
    expect(chip.dataset.kpiDelta).toBe('flat')
    expect(chip.querySelector('[data-tone="neutral"]')).not.toBeNull()
    expect(chip.textContent).toContain('0 件 先週比')
    expect(chip.textContent).toContain('先週の同じ曜日と同じ')
  })

  it('どちらでもない数の増減は灰色。良し悪しの色を付けない', () => {
    const { container } = render(<KpiDelta current={9} previous={3} better="neutral" unit="件" />)
    const chip = delta(container)!
    expect(chip.dataset.kpiDelta).toBe('neutral')
    expect(chip.querySelector('[data-tone="neutral"]')).not.toBeNull()
    expect(chip.textContent).toContain('先週の同じ曜日より 6 件多い')
    expect(chip.querySelector('svg.lucide-arrow-up')).not.toBeNull()
    expect(chip.textContent).toContain('+6 件 先週比')
  })

  it('大きい差は桁の区切りを付ける', () => {
    expect(kpiDeltaText(-1234, '人', { short: '先週比', reading: '先週の同じ曜日' })).toEqual({ visible: '−1,234 人 先週比', reading: '先週の同じ曜日より 1,234 人少ない' })
  })

  it('数が回る動きの途中でも、本当の値と差の文字が最初から DOM にある', () => {
    const { container } = render(<KpiCard presentation="band" title="今日の予約" value={12} unit="件" detail="" delta={<KpiDelta current={12} previous={10} better="high" unit="件" />} />)
    expect(container.textContent).toContain('12')
    expect(container.textContent).toContain('2 件 先週比')
    expect(container.textContent).toContain('先週の同じ曜日より 2 件多い')
  })
})
