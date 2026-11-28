// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const mocks = vi.hoisted(() => ({
  getDraft: vi.fn(),
  validateDraft: vi.fn(),
  audience: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) =>
    React.createElement('a', { href, className }, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/reminders/edit',
  useSearchParams: () => new URLSearchParams('id=reminder-1&stage=target'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { id: 'account-a', name: '本店' }, accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => false }) }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      staff: { me: vi.fn(async () => ({ success: true, data: { role: 'owner' } })) },
      reminders: {
        ...actual.api.reminders,
        getDraft: (...args: unknown[]) => mocks.getDraft(...args),
        validateDraft: (...args: unknown[]) => mocks.validateDraft(...args),
        audience: (...args: unknown[]) => mocks.audience(...args),
        getTestRecipient: vi.fn(async () => ({ success: true, data: { kind: 'unset' } })),
      },
      friendFields: { list: vi.fn(async () => ({ success: true, data: [] })) },
      folders: { list: vi.fn(async () => ({ success: true, data: [] })) },
    },
  }
})

import ReminderEditV8 from './edit'

const baseDraft = {
  reminderId: 'reminder-1',
  versionId: 'v1',
  versionNumber: 1,
  status: 'draft',
  lastTestStatus: null,
  lastTestedAt: null,
  publishedAt: null,
  updatedAt: '2026-09-30T00:00:00Z',
  settings: {
    name: '予約前日のご案内',
    description: null,
    lineAccountId: 'account-a',
    folderId: null,
    triggerType: 'booking',
    deliveryMode: 'time',
    triggerFieldId: null,
    triggerEventId: null,
    repeatYearly: false,
    leapYearPolicy: 'feb28',
    triggerOffsetMinutes: null,
    sendAtTime: null,
    targetTagId: null,
    targetCondition: null,
    stopConditions: { bookingCancelled: true, supportMarkCompleted: true, daysAfterTarget: 7, friendBlocked: true },
    steps: [
      { stableStepId: 's1', offsetMinutes: 0, offsetDays: -1, sendAtTime: '18:00', messageType: 'text', messageContent: '明日のご案内です。' },
    ],
  },
}

beforeEach(() => {
  vi.resetAllMocks()
  document.documentElement.dataset.theme = 'v8'
  mocks.getDraft.mockResolvedValue({ success: true, data: baseDraft })
  mocks.validateDraft.mockResolvedValue({ success: true, data: { valid: true, checks: [], audience: { matched: 12, excluded: 1 } } })
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
})

describe('リマインダ編集：対象者の顔ぶれ取得失敗時のエラー帯と再読み込み回復', () => {
  it('顔ぶれ取得が失敗したとき赤帯と再読み込みボタンを出し、再試行で対象者一覧へ回復できる', async () => {
    mocks.audience
      .mockRejectedValueOnce(new ApiError(500, '一時エラー'))
      .mockResolvedValueOnce({
        success: true,
        data: { matched: 2, excluded: 0, sample: [{ id: 'f1', displayName: '山田 太郎' }, { id: 'f2', displayName: '佐藤 花子' }] },
      })

    render(<ReminderEditV8 reminderId="reminder-1" stage="target" />)

    const openButton = await screen.findByRole('button', { name: /顔ぶれを見る/ })
    fireEvent.click(openButton)

    const dialog = await screen.findByRole('dialog', { name: '対象者を確認' })
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('対象者を確認できませんでした')

    const retryButton = within(dialog).getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryButton)

    await waitFor(() => expect(within(dialog).getByText('山田 太郎')).toBeTruthy())
    expect(within(dialog).getByText('佐藤 花子')).toBeTruthy()
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(mocks.audience).toHaveBeenCalledTimes(2)
  })
})
