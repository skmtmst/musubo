// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ChannelsTables from './channels-tables'
import type { BookingChannelsData } from './lib/booking-channels'

afterEach(cleanup)
it('状態が分からない経路とカレンダーを未接続と見せず操作を止める', () => {
  const connect = vi.fn()
  const data: BookingChannelsData = { timeZone: 'Asia/Tokyo', autoAssign: false,
    staff: [{ staffId: 's', displayName: '担当', status: 'future' as BookingChannelsData['staff'][number]['status'], externalEventsThisWeek: null, lastReadAt: null, readError: null }],
    channels: [{ key: 'line', status: 'future', todayCount: null }] }
  render(<ChannelsTables data={data} canEdit roles={{}} calendars={{}} onDetail={vi.fn()} onConnect={connect} />)
  expect(screen.getAllByText('状態を確認できません')).toHaveLength(2)
  expect(screen.queryByText('つないでいない')).toBeNull()
  expect(screen.queryByText('まだ届いていない')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'つなぎ直す' }))
  expect(connect).not.toHaveBeenCalled()
})
it('サーバーの未接続はこれまでどおり接続できる', () => {
  const connect = vi.fn()
  const data: BookingChannelsData = { timeZone: 'Asia/Tokyo', autoAssign: false,
    staff: [{ staffId: 's', displayName: '担当', status: 'disconnected' as BookingChannelsData['staff'][number]['status'], externalEventsThisWeek: null, lastReadAt: null, readError: null }], channels: [] }
  render(<ChannelsTables data={data} canEdit roles={{}} calendars={{}} onDetail={vi.fn()} onConnect={connect} />)
  expect(screen.getByText('つないでいない')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'つなぐ' }))
  expect(connect).toHaveBeenCalledOnce()
})
