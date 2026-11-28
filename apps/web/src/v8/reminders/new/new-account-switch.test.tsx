// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  account: 'account-a',
  foldersList: vi.fn(),
  friendFieldsList: vi.fn(),
  listEvents: vi.fn(),
  createDraft: vi.fn(),
  saveDraft: vi.fn(),
  getDraft: vi.fn(),
  routerPush: vi.fn(),
}))

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.account, loading: false }),
}))
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: fixture.routerPush, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))
vi.mock('@/lib/staff-role', async (original) => ({
  ...(await original<typeof import('@/lib/staff-role')>()),
  useStaffRole: () => 'owner',
}))
vi.mock('@/lib/use-feature-access', () => ({
  useFeatureAccess: () => true,
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: { ...actual.api.folders, list: fixture.foldersList },
      friendFields: { ...actual.api.friendFields, list: fixture.friendFieldsList },
      reminders: {
        ...actual.api.reminders,
        createDraft: fixture.createDraft,
        saveDraft: fixture.saveDraft,
        getDraft: fixture.getDraft,
      },
      staff: { ...actual.api.staff, me: async () => ({ success: true, data: { role: 'owner' } }) },
    },
    eventsApi: { ...actual.eventsApi, listEvents: fixture.listEvents },
  }
})

import NewReminderV8 from './new'

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  fixture.account = 'account-a'
  vi.clearAllMocks()
  fixture.foldersList.mockResolvedValue({ success: true, data: [] })
  fixture.friendFieldsList.mockResolvedValue({ success: true, data: [] })
  fixture.listEvents.mockResolvedValue({ items: [], total: 0, limit: 100, sort: [] })
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('リマインダ新規作成のアカウント切替ガード', () => {
  it('アカウント A で下書き保存したあとにアカウント B へ切り替えると、A の下書きを上書きせず B の新規下書きを作る', async () => {
    fixture.createDraft
      .mockResolvedValueOnce({
        success: true,
        data: {
          reminderId: 'rem-a',
          versionId: 'v-a1',
          updatedAt: '2026-11-27T00:00:00Z',
          settings: { name: '来店前リマインダ', lineAccountId: 'account-a', triggerType: 'booking', deliveryMode: 'time', steps: [] },
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          reminderId: 'rem-b',
          versionId: 'v-b1',
          updatedAt: '2026-11-27T00:01:00Z',
          settings: { name: '来店前リマインダ', lineAccountId: 'account-b', triggerType: 'booking', deliveryMode: 'time', steps: [] },
        },
      })

    const { rerender } = render(<NewReminderV8 />)

    const nameInput = screen.getByLabelText(/リマインダ名/)
    fireEvent.change(nameInput, { target: { value: '来店前リマインダ' } })

    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
    await waitFor(() => expect(fixture.createDraft).toHaveBeenCalledTimes(1))
    expect(fixture.createDraft).toHaveBeenLastCalledWith(expect.objectContaining({ lineAccountId: 'account-a' }))

    fixture.account = 'account-b'
    rerender(<NewReminderV8 />)

    fireEvent.click(screen.getByRole('button', { name: '下書きを保存' }))
    await waitFor(() => expect(fixture.createDraft).toHaveBeenCalledTimes(2))
    expect(fixture.saveDraft).not.toHaveBeenCalled()
    expect(fixture.createDraft).toHaveBeenLastCalledWith(expect.objectContaining({ lineAccountId: 'account-b' }))
  })

  it('アカウント A の作成通信中にアカウント B へ切り替えると、保存中が解除され A の完了で編集画面へ誤遷移しない', async () => {
    let resolveCreate!: (value: unknown) => void
    fixture.createDraft.mockReturnValueOnce(new Promise((resolve) => { resolveCreate = resolve }))

    const { rerender } = render(<NewReminderV8 />)

    fireEvent.change(screen.getByLabelText(/リマインダ名/), { target: { value: '来店前リマインダ' } })

    const nextButton = screen.getByRole('button', { name: /次へ：対象者と止める条件/ }) as HTMLButtonElement
    fireEvent.click(nextButton)
    await waitFor(() => expect(fixture.createDraft).toHaveBeenCalledTimes(1))
    expect(nextButton.disabled).toBe(true)

    fixture.account = 'account-b'
    rerender(<NewReminderV8 />)

    await waitFor(() => expect(nextButton.disabled).toBe(false))

    await act(async () => {
      resolveCreate({
        success: true,
        data: {
          reminderId: 'rem-a',
          versionId: 'v-a1',
          updatedAt: '2026-11-27T00:00:00Z',
          settings: { name: '来店前リマインダ', lineAccountId: 'account-a', triggerType: 'booking', deliveryMode: 'time', steps: [] },
        },
      })
    })

    expect(fixture.routerPush).not.toHaveBeenCalled()
  })
})
