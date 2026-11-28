// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const fetchComparison = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, dashboard: { ...actual.api.dashboard, comparisons: fetchComparison } } }
})
import { useDashboardComparisons } from './comparisons'
function Screen({ account }: { account: string }) {
  const data = useDashboardComparisons(account, true)
  return <p>{data ? `比較 ${data.comparisons.todayBookings?.current}` : '比較を読み込み中'}</p>
}
afterEach(() => { cleanup(); fetchComparison.mockReset() })
it('店を戻した直後は前回の比較値を出さず、新しい結果を待つ', async () => {
  let finish!: (value: unknown) => void
  const payload = (value: number) => ({ success: true, data: { comparisons: { todayBookings: { current: value, previous: 1 } } } })
  fetchComparison.mockResolvedValueOnce(payload(12)).mockImplementationOnce(() => new Promise(() => {})).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<Screen account="A" />)
  expect(await screen.findByText('比較 12')).toBeTruthy()
  view.rerender(<Screen account="B" />)
  view.rerender(<Screen account="A" />)
  expect(screen.getByText('比較を読み込み中')).toBeTruthy()
  expect(screen.queryByText('比較 12')).toBeNull()
  finish(payload(3))
  expect(await screen.findByText('比較 3')).toBeTruthy()
})
