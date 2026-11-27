// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DayList, WeekCalendar } from './calendar'
import type { StyleMonth, StyleWeek } from './model'

afterEach(cleanup)

describe('WeekCalendar / DayList の不正時刻・重複行ガード', () => {
  it('不正な時刻や逆転した終了時刻の予約でも NaN や負の高さのスタイルを出さない', () => {
    const week: StyleWeek = {
      title: '2026年11月',
      days: [{ date: '2026-11-27', label: '金', sub: '11/27', today: true }],
      entries: [
        {
          id: 'e-bad',
          day: '2026-11-27',
          start: 'invalid',
          end: '11:00',
          title: '壊れた時刻の予約',
          sub: '2名',
          state: 'confirmed',
        },
        {
          id: 'e-rev',
          day: '2026-11-27',
          start: '12:00',
          end: '11:00',
          title: '逆転時刻の予約',
          sub: '2名',
          state: 'confirmed',
        },
      ],
      free: [],
    } as unknown as StyleWeek

    const { container } = render(
      <WeekCalendar
        week={week}
        canWrite={false}
        onMove={vi.fn()}
        onSlot={vi.fn()}
        onOpen={vi.fn()}
      />,
    )

    const styledNodes = [...container.querySelectorAll('[style]')] as HTMLElement[]
    expect(styledNodes.length).toBeGreaterThan(0)
    for (const node of styledNodes) {
      const styleText = node.getAttribute('style') ?? ''
      expect(styleText).not.toContain('NaN')
      expect(styleText).not.toContain('Infinity')
      expect(styleText).not.toMatch(/block-size:\s*calc\([^)]*\*\s*-/i)
    }
  })

  it('DayList に同時刻・同名の行が複数あっても警告なく描画できる', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const month = {
      title: '2026年11月',
      days: [],
      selected: {
        title: '11/27（金）',
        total: '2件',
        moreLabel: '一覧を見る',
        rows: [
          { time: '12:00', name: '当日来店', sub: '2名', state: { tone: 'success', label: '確定' } },
          { time: '12:00', name: '当日来店', sub: '4名', state: { tone: 'success', label: '確定' } },
        ],
      },
    } as unknown as StyleMonth

    render(<DayList month={month} href="/bookings" canWrite />)
    const keyWarnings = errorSpy.mock.calls.filter((args) => String(args[0] ?? '').includes('same key'))
    errorSpy.mockRestore()
    expect(keyWarnings).toHaveLength(0)
  })
})
