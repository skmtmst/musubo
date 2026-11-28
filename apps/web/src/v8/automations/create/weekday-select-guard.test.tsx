// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeekdaySelect } from './weekday-select'

afterEach(cleanup)

describe('WeekdaySelect defensive guards', () => {
  it('shows 時刻未定 when time is whitespace-only and trims surrounding spaces for next run calculation', () => {
    const { container, rerender } = render(
      <WeekdaySelect value={[1]} time="   " onChange={vi.fn()} />,
    )
    expect(container.textContent).toContain('毎週 月 の 時刻未定（日本時間）に動きます。')
    expect(container.textContent).toContain('時刻を選ぶと次の日時が分かります。')

    rerender(<WeekdaySelect value={[1]} time=" 09:30 " onChange={vi.fn()} />)
    expect(container.textContent).toContain('毎週 月 の 09:30（日本時間）に動きます。次は ')
  })

  it('handles non-array value safely without throwing', () => {
    const { container } = render(
      <WeekdaySelect value={null as unknown as ReadonlyArray<number>} time="09:00" onChange={vi.fn()} />,
    )
    expect(container.textContent).toContain('曜日を1つ以上選んでください。')
  })
})
