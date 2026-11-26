// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ get: vi.fn(), slots: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), eventsApi: { getEvent: calls.get, listSlots: calls.slots, setEventLifecycle: calls.update } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('next/link', () => ({ default: ({ children, href }: React.PropsWithChildren<{href: string}>) => <a href={href}>{children}</a> }))
import { LifecycleSection } from './edit'
beforeEach(() => { calls.get.mockReset().mockResolvedValue({ lifecycle_status: 'published' }); calls.slots.mockReset(); calls.update.mockReset() })
afterEach(cleanup)
it('予約枠を読めない間は公開中と誤認せず、枠だけ読み直せる', async () => {
  calls.slots.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [] })
  render(<LifecycleSection accountId="a" eventId="e" onChanged={vi.fn()} />)
  expect(await screen.findByText(/予約枠を読み込めないため/)).toBeTruthy()
  expect(screen.queryByText('公開中')).toBeNull()
  expect(screen.queryByRole('button', { name: '一時停止する' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '予約枠を読み直す' }))
  expect(await screen.findByText('終了')).toBeTruthy()
  expect(calls.slots).toHaveBeenCalledTimes(2)
  expect(calls.get).toHaveBeenCalledTimes(1)
  expect(calls.update).not.toHaveBeenCalled()
})
it('切替前の遅い失敗は新しいイベントに出ない', async () => {
  let rejectOld!: (reason: Error) => void
  calls.slots.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject }))
    .mockResolvedValueOnce({ items: [{ is_active: 1, starts_at: '2099-01-01T00:00:00Z' }] })
  const view = render(<LifecycleSection key="a" accountId="a" eventId="e" onChanged={vi.fn()} />)
  view.rerender(<LifecycleSection key="b" accountId="b" eventId="e" onChanged={vi.fn()} />)
  expect(await screen.findByText('公開中')).toBeTruthy()
  await act(async () => { rejectOld(new Error('offline')) })
  expect(screen.queryByText(/予約枠を読み込めないため/)).toBeNull()
})
