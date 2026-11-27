// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DayList, WeekCalendar, calendarEntryBox } from './calendar'
import type { StyleMonth, StyleWeek } from './model'

afterEach(cleanup)

/**
 * カレンダーのインライン style（calc / max）へ実ピクセル値を代入して数値として評価する。
 * 文字列の正規表現ではなく、実際の描画サイズ（0px 未満や NaN にならないか）を確かめる。
 */
function evalCssPx(expr: string, vars: Record<string, number>): number {
  let replaced = expr.trim()
  for (const [name, px] of Object.entries(vars)) {
    replaced = replaced.replaceAll(`var(${name})`, String(px))
  }
  replaced = replaced.replace(/(\d+(?:\.\d+)?)px/g, '$1')
  const evaluate = (input: string): number => {
    const s = input.trim()
    if (s.startsWith('max(') && s.endsWith(')')) {
      const inner = s.slice(4, -1)
      const parts: string[] = []
      let depth = 0
      let start = 0
      for (let i = 0; i < inner.length; i += 1) {
        if (inner[i] === '(') depth += 1
        else if (inner[i] === ')') depth -= 1
        else if (inner[i] === ',' && depth === 0) {
          parts.push(inner.slice(start, i))
          start = i + 1
        }
      }
      parts.push(inner.slice(start))
      const values = parts.map(evaluate)
      return values.some((v) => Number.isNaN(v)) ? Number.NaN : Math.max(...values)
    }
    if (s.startsWith('calc(') && s.endsWith(')')) {
      return evaluate(s.slice(5, -1))
    }
    let depth = 0
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const ch = s[i]
      if (ch === ')') depth += 1
      else if (ch === '(') depth -= 1
      else if (depth === 0 && (ch === '+' || ch === '-') && i > 0) {
        const prev = s.slice(0, i).trimEnd()
        if (prev && !prev.endsWith('*') && !prev.endsWith('/') && !prev.endsWith('+') && !prev.endsWith('-')) {
          const left = evaluate(prev)
          const right = evaluate(s.slice(i + 1))
          return ch === '+' ? left + right : left - right
        }
      }
    }
    depth = 0
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const ch = s[i]
      if (ch === ')') depth += 1
      else if (ch === '(') depth -= 1
      else if (depth === 0 && (ch === '*' || ch === '/')) {
        const left = evaluate(s.slice(0, i))
        const right = evaluate(s.slice(i + 1))
        return ch === '*' ? left * right : left / right
      }
    }
    return Number(s)
  }
  return evaluate(replaced)
}

describe('WeekCalendar / DayList の時刻配置・高さ・重複行ガード', () => {
  it('極端に短い予約を描画しても配置ラッパーの高さが 0 未満にならない', () => {
    const week: StyleWeek = {
      title: '2026年11月',
      from: '2026-11-27',
      to: '2026-11-27',
      days: [{ date: '2026-11-27', label: '金', sub: '11/27', today: true }],
      entries: [
        {
          id: 'e-short',
          day: '2026-11-27',
          start: '12:00',
          end: '12:01',
          title: '短時間コース',
          name: '短い予約',
          state: 'confirmed',
        },
      ],
      free: [],
    }

    render(
      <WeekCalendar
        week={week}
        canWrite={false}
        onMove={vi.fn()}
        onSlot={vi.fn()}
        onOpen={vi.fn()}
      />,
    )

    const vars = { '--tpl-sd-week-hour': 60, '--tpl-sd-board-top': 8, '--tpl-sd-entry-gap': 4 }
    const bookingButton = screen.getByRole('button', { name: /短い予約/ })
    const wrapper = bookingButton.parentElement as HTMLElement
    const top = evalCssPx(wrapper.style.insetBlockStart, vars)
    const height = evalCssPx(wrapper.style.blockSize, vars)
    expect(Number.isFinite(top)).toBe(true)
    expect(Number.isFinite(height)).toBe(true)
    expect(height).toBeGreaterThanOrEqual(0)
  })

  it('不正な時刻・逆転時刻・日数0でも位置と高さが有限で 0 以上になる', () => {
    const vars = { '--tpl-sd-week-hour': 60, '--tpl-sd-board-top': 8, '--tpl-sd-entry-gap': 4 }
    const reversed = calendarEntryBox('12:00', '11:00', 0, 1, 10)
    const reversedHeight = evalCssPx(String(reversed.blockSize ?? ''), vars)
    expect(Number.isFinite(reversedHeight)).toBe(true)
    expect(reversedHeight).toBeGreaterThanOrEqual(0)

    const malformed = calendarEntryBox('invalid', '11:00', 0, 0, 10)
    const malformedTop = evalCssPx(String(malformed.insetBlockStart ?? ''), vars)
    const malformedHeight = evalCssPx(String(malformed.blockSize ?? ''), vars)
    expect(Number.isFinite(malformedTop)).toBe(true)
    expect(Number.isFinite(malformedHeight)).toBe(true)
    expect(malformedHeight).toBeGreaterThanOrEqual(0)
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
