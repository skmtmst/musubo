// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const assignmentApi = vi.hoisted(() => ({
  getTableAutomation: vi.fn(),
  saveTableAutomation: vi.fn(),
}))

const notifySaved = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/restaurant-test/tables',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/api/helpers/booking-assignment', () => ({
  bookingAssignmentApi: assignmentApi,
}))

vi.mock('@/components/shared/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/toast')>()),
  notifySaved,
}))

import TableAutoAssignmentDialog from './auto-assignment-dialog'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('TableAutoAssignmentDialog の応答検証と店舗切替の競合防止', () => {
  it('店舗を切り替えたあと、前の店舗の遅い応答で新しい店舗の設定を上書きしない', async () => {
    const reqA = deferred<{ success: true; data: { enabled: boolean; version: number } }>()
    const reqB = deferred<{ success: true; data: { enabled: boolean; version: number } }>()
    assignmentApi.getTableAutomation
      .mockReturnValueOnce(reqA.promise)
      .mockReturnValueOnce(reqB.promise)

    const view = render(
      <TableAutoAssignmentDialog accountId="account-1" storeId="store-a" canEdit onClose={vi.fn()} />,
    )
    await waitFor(() => expect(assignmentApi.getTableAutomation).toHaveBeenCalledWith('account-1', 'store-a'))

    view.rerender(
      <TableAutoAssignmentDialog accountId="account-1" storeId="store-b" canEdit onClose={vi.fn()} />,
    )
    await waitFor(() => expect(assignmentApi.getTableAutomation).toHaveBeenCalledWith('account-1', 'store-b'))

    await act(async () => {
      reqB.resolve({ success: true, data: { enabled: false, version: 9 } })
      await reqB.promise
    })
    const toggle = await screen.findByRole('switch', { name: '予約の卓を自動で決める' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      reqA.resolve({ success: true, data: { enabled: true, version: 1 } })
      await reqA.promise
    })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('読み込みで success:false が返ったときはエラーを出して再試行で復帰できる', async () => {
    assignmentApi.getTableAutomation
      .mockResolvedValueOnce({ success: false, data: { enabled: true, version: 1 } })
      .mockResolvedValueOnce({ success: true, data: { enabled: false, version: 2 } })

    render(<TableAutoAssignmentDialog accountId="account-1" storeId="store-a" canEdit onClose={vi.fn()} />)

    await screen.findByText('設定を読み込めませんでした。もう一度お試しください。')
    expect(screen.queryByRole('switch', { name: '予約の卓を自動で決める' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '再試行' }))
    const toggle = await screen.findByRole('switch', { name: '予約の卓を自動で決める' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('保存APIが success:false を返したときは完了扱いにせずエラーを出して窓を閉じない', async () => {
    const onClose = vi.fn()
    assignmentApi.getTableAutomation.mockResolvedValueOnce({
      success: true,
      data: { enabled: true, version: 4 },
    })
    assignmentApi.saveTableAutomation.mockResolvedValueOnce({ success: false })

    render(<TableAutoAssignmentDialog accountId="account-1" storeId="store-a" canEdit onClose={onClose} />)

    const toggle = await screen.findByRole('switch', { name: '予約の卓を自動で決める' })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }))

    await screen.findByText('保存できませんでした。もう一度お試しください。')
    expect(notifySaved).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
