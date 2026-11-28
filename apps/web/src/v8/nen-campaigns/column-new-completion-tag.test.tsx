// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const account = vi.hoisted(() => ({ id: 'account-a' }))
const tagsList = vi.hoisted(() => vi.fn())
const columnAudience = vi.hoisted(() => vi.fn())
const createColumn = vi.hoisted(() => vi.fn())
const routerPush = vi.hoisted(() => vi.fn())

vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ replace: vi.fn(), push: routerPush }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: account.id,
    selectedAccount: { id: account.id, name: account.id, displayName: account.id, liffId: null },
  }),
}))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: { ...actual.api.folders, list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
      tags: { ...actual.api.tags, list: tagsList },
      nenCampaigns: { ...actual.api.nenCampaigns, columnAudience, createColumn },
    },
  }
})
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => ({
  ...(await importOriginal()),
  useStaffRole: () => 'owner',
}))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

import ColumnNew from './column-new'

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  account.id = 'account-a'
  vi.clearAllMocks()
  columnAudience.mockResolvedValue({ success: true, data: { count: 10 } })
  createColumn.mockResolvedValue({ success: true, data: { id: 'col-1', queued: 0 } })
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('コラム作成の読了後に付けるタグの保護', () => {
  it('タグ一覧の読み込み中や失敗時は「読了後に付けるタグ」を選べず、読み込み後に選べるようになる', async () => {
    let resolveFirst!: (value: unknown) => void
    tagsList
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce({ success: true, data: [{ id: 'tag-a', name: '読了タグA', lineAccountId: 'account-a' }] })

    render(<ColumnNew />)

    const pickerButton = () => screen.getByRole('button', { name: '読了後に付けるタグ：選択する' }) as HTMLButtonElement
    expect(pickerButton().disabled).toBe(true)

    await act(async () => {
      resolveFirst({ success: false })
    })

    expect(await screen.findByText(/配信対象のタグを読み込めませんでした/)).toBeTruthy()
    expect(pickerButton().disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    await waitFor(() => expect(pickerButton().disabled).toBe(false))
  })

  it('読了後に付けるタグを選んでアカウントを切り替えると、切替先にないタグは外されて保存時に残らない', async () => {
    let resolveAccountB!: (value: unknown) => void
    const accountBPromise = new Promise((resolve) => { resolveAccountB = resolve })
    tagsList.mockImplementation((params?: { accountId?: string }) => {
      if (params?.accountId === 'account-b') return accountBPromise
      return Promise.resolve({ success: true, data: [{ id: 'tag-a', name: '読了タグA', lineAccountId: 'account-a' }] })
    })

    const { rerender } = render(<ColumnNew />)

    const completionPicker = () => screen.getByRole('button', { name: '読了後に付けるタグ：選択する' }) as HTMLButtonElement
    await waitFor(() => expect(completionPicker().disabled).toBe(false))

    fireEvent.change(screen.getByLabelText('題名'), { target: { value: '秋のコラム' } })
    fireEvent.change(screen.getByLabelText('記事の URL'), { target: { value: 'https://example.test/column' } })

    fireEvent.click(completionPicker())
    const tagCheckbox = await screen.findByRole('checkbox', { name: '読了タグA' })
    fireEvent.click(tagCheckbox)
    fireEvent.click(screen.getByRole('button', { name: '選択する（1件）' }))

    await waitFor(() => expect(screen.getByText('読了タグA')).toBeTruthy())

    account.id = 'account-b'
    rerender(<ColumnNew />)

    const saveButton = () => screen.getByRole('button', { name: '下書きを保存' }) as HTMLButtonElement
    await waitFor(() => expect(saveButton().disabled).toBe(true))
    const lockedCompletionBtn = screen.getByRole('button', { name: /^読了後に付けるタグ：/ }) as HTMLButtonElement
    expect(lockedCompletionBtn.disabled).toBe(true)
    fireEvent.click(saveButton())
    expect(createColumn).not.toHaveBeenCalled()

    await act(async () => {
      resolveAccountB({ success: true, data: [{ id: 'tag-b', name: '読了タグB', lineAccountId: 'account-b' }] })
    })

    expect(await screen.findByText('選んでいたタグは、今のアカウントにないため外しました。選び直してください。')).toBeTruthy()
    await waitFor(() => expect(saveButton().disabled).toBe(false))

    fireEvent.click(saveButton())
    await waitFor(() => expect(createColumn).toHaveBeenCalledTimes(1))
    expect(createColumn).toHaveBeenCalledWith('account-b', expect.objectContaining({
      title: '秋のコラム',
      completionTagId: null,
    }))
  })
})
