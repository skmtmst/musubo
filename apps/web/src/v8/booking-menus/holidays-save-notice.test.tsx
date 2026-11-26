// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BookingException, BookingSettings } from '@/lib/api'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
const net = vi.hoisted(() => ({ updateException: vi.fn(), createException: vi.fn() }))
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), bookingApi: { ...(await original<typeof import('@/lib/api')>()).bookingApi, updateException: net.updateException, createException: net.createException } }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }))
import { HolidaysTabV8 } from './tabs/holidays-tab'
const item: BookingException = { id: 'e1', lineAccountId: 'a', scopeKind: 'store', scopeId: null, date: null, dateFrom: '2026-10-20', dateTo: '2026-10-20', kind: 'closed', intervals: [], reason: '見本', note: null, version: 1, createdAt: '', updatedAt: '' }
const saved = vi.fn()
const view = (accountId = 'a') => <><HolidaysTabV8 accountId={accountId} settings={{ exceptions: [item] } as BookingSettings} status="ready" error={null} exceptions={[item]} closedWeekdays={[]} bookingCountOnClosed={0} canEdit onSaved={saved} onReload={() => {}} /><ToastHost /></>
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-15T03:00:00Z')); net.updateException.mockReset(); net.createException.mockReset(); saved.mockReset() })
afterEach(() => { cleanup(); clearToastsForTest(); vi.useRealTimers() })
function open() { fireEvent.click(screen.getByText('見本').previousElementSibling!); fireEvent.change(screen.getByLabelText('休業の理由'), { target: { value: '変更後' } }) }
async function submit() { await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: '休業日を直す' })).getByRole('button', { name: '休業日を保存する' })) }) }
it('休業日の保存が成功すると完了を知らせる', async () => {
 net.updateException.mockResolvedValueOnce({ success: true, data: { ...item, reason: '変更後' } })
 render(view()); open(); await submit()
 expect(await screen.findByText('休業日を保存しました。')).toBeTruthy(); expect(saved).toHaveBeenCalledOnce()
})
it('保存失敗なら完了を知らせず入力を保つ', async () => {
 net.updateException.mockResolvedValueOnce({ success: false, error: '保存に失敗しました' })
 render(view()); open(); await submit()
 expect(screen.queryByText('休業日を保存しました。')).toBeNull(); expect(screen.getByDisplayValue('変更後')).toBeTruthy(); expect(saved).not.toHaveBeenCalled()
})
it('アカウント切替後は古い保存結果で知らせたり表示を変えたりしない', async () => {
 let resolve!: (value: unknown) => void
 net.updateException.mockImplementationOnce(() => new Promise(done => { resolve = done }))
 const tree = render(view()); open(); fireEvent.click(within(screen.getByRole('dialog', { name: '休業日を直す' })).getByRole('button', { name: '休業日を保存する' }))
 tree.rerender(view('b')); await act(async () => { resolve({ success: true, data: item }) })
 expect(screen.queryByText('休業日を保存しました。')).toBeNull(); expect(saved).not.toHaveBeenCalled()
})

it('休業日の登録が成功すると完了を知らせる', async () => {
 net.createException.mockResolvedValueOnce({ success: true, data: item })
 render(view()); fireEvent.click(screen.getByRole('button', { name: '臨時休業を足す' }))
 const dialog = screen.getByRole('dialog', { name: '臨時休業を足す' })
 for (const name of ['休業の開始日', '休業の終了日']) {
  fireEvent.click(within(dialog).getByRole('button', { name }))
  fireEvent.click(screen.getByRole('button', { name: /2026年10月20日/ }))
  fireEvent.click(screen.getByRole('button', { name: '確定' }))
 }
 await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '休業日を保存する' })) })
 expect(await screen.findByText('休業日を登録しました。')).toBeTruthy(); expect(saved).toHaveBeenCalledOnce()
})
