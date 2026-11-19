// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ScheduleInput, { emptySchedule } from './schedule-input'

afterEach(cleanup)

it('指定時刻の配信で5分単位の遅れを説明する', () => {
  render(<ScheduleInput mode="absolute_time" value={emptySchedule} onChange={vi.fn()} />)
  expect(screen.getByText(/配信時刻は5分単位で処理するため、指定時刻から最大5分遅れる場合があります/)).toBeTruthy()
})

it('どの配信方法でも内部の実行方式を表示しない', () => {
  const view = render(<ScheduleInput mode="relative" value={emptySchedule} onChange={vi.fn()} />)
  expect(view.container.textContent).not.toContain('cron が')
  expect(view.container.innerHTML).not.toContain('cron が')
  view.rerender(<ScheduleInput mode="elapsed" value={emptySchedule} onChange={vi.fn()} />)
  expect(view.container.textContent).not.toContain('cron が')
  expect(view.container.innerHTML).not.toContain('cron が')
  view.rerender(<ScheduleInput mode="absolute_time" value={emptySchedule} onChange={vi.fn()} />)
  expect(view.container.textContent).not.toContain('cron が')
  expect(view.container.innerHTML).not.toContain('cron が')
})
