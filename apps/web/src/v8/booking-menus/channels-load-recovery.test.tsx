// @vitest-environment happy-dom
/*
 * 予約経路タブの補助取得失敗（重なり・カレンダー詳細）と再試行の振る舞い。
 * - 重なり一覧だけが失敗しても、スタッフのカレンダーと予約経路一覧を残し、案内・集計カードの未確認表示・再読み込みから復旧できる
 * - カレンダー詳細の取得失敗を黙らせず、案内と再読み込みを出す
 * - 再読み込み連打で二重通信にならない
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

const api = vi.hoisted(() => ({
  channels: vi.fn(),
  conflicts: vi.fn(),
  calendarDetail: vi.fn(),
  connectCalendar: vi.fn(),
  reassign: vi.fn(),
}))

vi.mock('./lib/booking-channels', () => ({ bookingChannelsApi: api }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: vi.fn(), notifySaved: vi.fn() }))

import ChannelsTabV8 from './channels-tab'
import ChannelsSummaryBand, { type ChannelsSummary } from './channels-summary'

const CHANNELS_DATA = {
  timeZone: 'Asia/Tokyo',
  staff: [
    { staffId: 's1', displayName: '高田誠', status: 'connected' as const, externalEventsThisWeek: 5, lastReadAt: '2026-10-02T18:40:00+09:00', readError: null },
  ],
  autoAssign: true,
  channels: [{ key: 'line', status: 'active', todayCount: 14 }],
}

beforeEach(() => {
  verifiedStaffRole('owner')
  for (const fn of Object.values(api)) fn.mockReset()
  api.channels.mockResolvedValue({ success: true, data: CHANNELS_DATA })
  api.conflicts.mockResolvedValue({ success: true, data: { conflicts: [] } })
  api.calendarDetail.mockResolvedValue({ connection: { calendar_id: 'takada@example.com' }, service_account: { configured: true, email: null } })
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
})

describe('予約経路タブの失敗表示と再試行', () => {
  it('重なり取得だけが失敗しても経路一覧を残し、集計カードに未確認を示し、再読み込み連打を抑えて復旧できる', async () => {
    let resolveConflictsRetry!: (value: unknown) => void
    api.conflicts
      .mockRejectedValueOnce(new Error('conflicts offline'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveConflictsRetry = resolve }))

    function Harness() {
      const [summary, setSummary] = React.useState<ChannelsSummary>({ accountId: 'account-a', status: 'loading', data: null, conflicts: 0 })
      return <>
        <ChannelsSummaryBand summary={summary} />
        <ChannelsTabV8 accountId="account-a" canEdit onSummaryChange={setSummary} />
      </>
    }

    render(<Harness />)

    await screen.findByText('高田誠')
    await screen.findByText(/予約の重なりを確認できませんでした/)
    expect(screen.getByText('重なりを確認できませんでした')).toBeTruthy()
    expect(screen.queryByText('予約経路を読み込めませんでした')).toBeNull()

    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(api.conflicts).toHaveBeenCalledTimes(2))

    resolveConflictsRetry({ success: true, data: { conflicts: [] } })
    await waitFor(() => expect(screen.queryByText(/予約の重なりを確認できませんでした/)).toBeNull())
    expect(await screen.findByText('重なり 0 件')).toBeTruthy()
    expect(api.conflicts).toHaveBeenCalledTimes(2)
  })

  it('カレンダー詳細の取得失敗を黙らせず案内と再読み込みを出す', async () => {
    api.calendarDetail
      .mockRejectedValueOnce(new Error('calendar detail offline'))
      .mockResolvedValueOnce({ connection: { calendar_id: 'takada@example.com' }, service_account: { configured: true, email: null } })

    render(<ChannelsTabV8 accountId="account-a" canEdit />)

    await screen.findByText('高田誠')
    await screen.findByText(/一部のカレンダー詳細を読み込めませんでした/)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => expect(screen.queryByText(/一部のカレンダー詳細を読み込めませんでした/)).toBeNull())
  })

  it('本体取得の失敗後に再読み込みを連打しても二重通信にならない', async () => {
    let resolveChannelsRetry!: (value: unknown) => void
    api.channels
      .mockRejectedValueOnce(new Error('channels offline'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveChannelsRetry = resolve }))

    render(<ChannelsTabV8 accountId="account-a" canEdit />)

    await screen.findByText('予約経路を読み込めませんでした')
    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(api.channels).toHaveBeenCalledTimes(2))

    resolveChannelsRetry({ success: true, data: CHANNELS_DATA })
    await screen.findByText('高田誠')
    expect(api.channels).toHaveBeenCalledTimes(2)
  })
})
