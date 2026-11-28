// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import FriendTrendTable from './friend-trend-table'

afterEach(cleanup)

it.each([false, true])('推定の説明を日付見出しから開ける（全行が推定: %s）', allEstimated => {
  const trend = [
    { date: '2026-09-27', added: 5, blocked: 1, active: 100, estimated: allEstimated },
    { date: '2026-09-20', added: 3, blocked: 0, active: 95, estimated: true },
  ]
  render(<FriendTrendTable trend={trend} />)
  const dateHeader = screen.getByRole('columnheader', { name: /日付/ })
  const help = within(dateHeader).getByRole('button', { name: '日付の推定値の説明' })
  expect(screen.queryByRole('note')).toBeNull()
  fireEvent.click(help)
  const note = screen.getByRole('note')
  expect(note.textContent).toContain('日次の記録が始まる前')
  expect(note.textContent).toContain('退会した人は数に入っていません')
  if (allEstimated) expect(note.textContent).toContain('この表の日はすべて推定です')
  else expect(note.textContent).toContain('「推定」の日は')
  expect(help.getAttribute('aria-describedby')).toBe(note.id)
})
