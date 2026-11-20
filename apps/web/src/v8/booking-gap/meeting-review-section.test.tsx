// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ meetingReviews: vi.fn(), resolveMeetingReview: vi.fn(), role: vi.fn() }))
vi.mock('@/lib/api/helpers/gap1', () => ({ bookingCalendarApi: net }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: net.role, canAdministerRole: (role: string) => role === 'admin' || role === 'owner' }))
const { MeetingReviewSection } = await import('./meeting-review-section')
const { ApiError } = await import('@/lib/api')
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('元の会議は相手先で削除したと確認してから記録する', async () => {
  net.role.mockReturnValue('admin')
  net.meetingReviews.mockResolvedValue({ data: { items: [{ id: 'link', provider: 'zoom', staff_name: '担当', starts_at: null, ends_at: null }] } })
  net.resolveMeetingReview.mockResolvedValue({ data: { resolved: true } })
  render(<MeetingReviewSection accountId="account" bookingId="booking" canOperate />)
  fireEvent.click(await screen.findByRole('button', { name: '相手先で削除した' }))
  expect(net.resolveMeetingReview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '削除したことを記録' }))
  await waitFor(() => expect(net.resolveMeetingReview).toHaveBeenCalledWith('account', 'booking', 'link'))
})
it('閲覧のみでは記録の操作を出さない', async () => {
  net.role.mockReturnValue('admin')
  net.meetingReviews.mockResolvedValue({ data: { items: [{ id: 'link', provider: 'zoom', staff_name: '担当', starts_at: null, ends_at: null }] } })
  render(<MeetingReviewSection accountId="account" bookingId="booking" canOperate={false} />)
  await screen.findByText(/Zoom・担当/)
  expect(screen.queryByRole('button', { name: '相手先で削除した' })).toBeNull()
})
it('ほかの操作で対象が解決済みなら一覧を読み直す', async () => {
  net.role.mockReturnValue('owner')
  net.meetingReviews.mockResolvedValueOnce({ data: { items: [{ id: 'link', provider: 'zoom', staff_name: '担当', starts_at: null, ends_at: null }] } }).mockResolvedValueOnce({ data: { items: [] } })
  net.resolveMeetingReview.mockRejectedValue(new ApiError(404, 'not found'))
  render(<MeetingReviewSection accountId="account" bookingId="booking" canOperate />)
  fireEvent.click(await screen.findByRole('button', { name: '相手先で削除した' }))
  fireEvent.click(screen.getByRole('button', { name: '削除したことを記録' }))
  expect(await screen.findByText('会議の状態が変わったため、一覧を更新しました。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '相手先で削除した' })).toBeNull()
})
