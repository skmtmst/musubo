// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { BroadcastListKpis } from '@/lib/api'
import BroadcastKpis from './broadcast-kpis'

afterEach(cleanup)

it('取得できない数は単位を出さず、実測の0には単位を出す', () => {
  const stats = { scheduled: Number.NaN, drafts: 0, thisMonth: 2, delivered: 1234, openRate: null } satisfies BroadcastListKpis
  render(<BroadcastKpis listKpis={stats} />)
  const scheduled = screen.getByText('予約中').parentElement!
  const drafts = screen.getByText('下書き').parentElement!
  const rate = screen.getByText('平均開封率').parentElement!
  expect(within(scheduled).getByText('—')).toBeTruthy()
  expect(within(scheduled).queryByText('件')).toBeNull()
  expect(within(drafts).getByText('件')).toBeTruthy()
  expect(within(drafts).getByText('0')).toBeTruthy()
  expect(within(rate).getByText('—')).toBeTruthy()
  expect(within(rate).queryByText('%')).toBeNull()
  expect(screen.getByText('今日 —（未取得）')).toBeTruthy()
  expect(screen.getByText('過去28日')).toBeTruthy()
  expect(screen.getByText('今月の配信')).toBeTruthy()
  expect(screen.getByText('1,234人へ到達')).toBeTruthy()
  expect(screen.getByText('2')).toBeTruthy()
})
