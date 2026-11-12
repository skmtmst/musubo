// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * R16 の差し込みボタンと見本の再発防止。
 *
 * 差し込みは押せるボタンで、押すと本文のカーソル位置に入り、
 * カーソルはその後ろへ移る。本文の下と LINE プレビューには
 * 同じ見本値で読んだ文が出る。
 */

const fixture = vi.hoisted(() => ({
  getDraft: vi.fn(),
  saveDraft: vi.fn(),
  validateDraft: vi.fn(),
  routerPush: vi.fn(),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: fixture.routerPush }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-1', loading: false }),
}))
vi.mock('@/lib/use-feature-visibility', () => ({
  useFeatureVisibility: () => ({ status: 'ready' as const, features: null, enabled: () => false }),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    reminders: { ...actual.api.reminders,
      previewDraft: vi.fn(async () => ({ success: true, data: null })),
      validateDraft: vi.fn(async () => ({ success: true, data: { valid: true, checks: [], audience: { matched: 5, excluded: 1 } } })),
      ...fixture,
    },
    folders: { ...actual.api.folders, list: vi.fn(async () => ({ success: true, data: [], unfiledCount: 0 })) },
    friendFields: { ...actual.api.friendFields, list: vi.fn(async () => ({ success: true, data: [] })) },
  } }
})
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))


import ReminderEditV8 from '@/v8/reminders/edit'

const DRAFT_SETTINGS = {
  name: '予約前のお知らせ',
  description: null,
  lineAccountId: 'account-1',
  triggerType: 'booking',
  deliveryMode: 'time',
  triggerFieldId: null,
  triggerEventId: null,
  repeatYearly: false,
  triggerOffsetMinutes: null,
  sendAtTime: '18:00',
  targetTagId: null,
  targetCondition: null,
  folderId: null,
  stopConditions: {
    bookingCancelled: true,
    supportMarkCompleted: false,
    daysAfterTarget: 7,
    friendBlocked: true,
  },
  steps: [
    { stableStepId: 's-1', offsetMinutes: 0, offsetDays: -1, sendAtTime: '18:00', messageType: 'text', messageContent: '{{name}}さん、こんにちは' },
  ],
}

function draftResponse() {
  return {
    success: true,
    data: {
      reminderId: 'r-1',
      versionId: 'v-1',
      versionNumber: 1,
      status: 'draft',
      settings: structuredClone(DRAFT_SETTINGS),
      lastTestStatus: null,
      lastTestedAt: null,
      publishedAt: null,
    },
  }
}

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  fixture.getDraft.mockResolvedValue(draftResponse())
  fixture.validateDraft.mockResolvedValue({
    success: true,
    data: { valid: true, checks: [], audience: { matched: 5, excluded: 1 } },
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('通知ステップの差し込みボタンと見本', () => {
  it('差し込みは押せるボタンで表示だけの札を出さない', async () => {
    const { container } = render(<ReminderEditV8 stage="messages" reminderId="r-1" />)
    await waitFor(() => expect(container.querySelector('[role="textbox"][contenteditable]')).toBeTruthy())
    const nameButton = screen.getByRole('button', { name: '名前' })
    expect(nameButton.tagName).toBe('BUTTON')
    // 表示だけの札 (Pill) は差し込み欄に出さない。
    expect(screen.queryByText('回答フォーム')).toBeNull()
  })

  it('名前を押すとカーソル位置に入り、見本に同じ値が出る', async () => {
    const { container } = render(<ReminderEditV8 stage="messages" reminderId="r-1" />)
    await waitFor(() => expect(container.querySelector('[role="textbox"][contenteditable]')).toBeTruthy())
    const area = container.querySelector('[role="textbox"][contenteditable]') as HTMLTextAreaElement
    // カーソルを文末へ置く。
    area.focus()
    const range = document.createRange()
    range.selectNodeContents(area)
    range.collapse(false)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.click(screen.getByRole('button', { name: '名前' }))
    await waitFor(() => expect(area.value).toContain('{{name}}さん、こんにちは{{name}}'))
    // 保存する本文は差し込みのまま、現在のLINEプレビューで見本値を確認する。
    expect(area.value).toBe('{{name}}さん、こんにちは{{name}}')
    fireEvent.click(screen.getByRole('button', { name: /LINEでの見え方を見る/ }))
    const preview = await screen.findByRole('region', { name: 'LINEでの見え方' })
    expect(await within(preview).findByText('見本 143さん、こんにちは見本 143')).toBeTruthy()
  })

  it('差し込みの無い本文では見本を出さない', async () => {
    fixture.getDraft.mockResolvedValue({
      ...draftResponse(),
      data: {
        ...draftResponse().data,
        settings: { ...structuredClone(DRAFT_SETTINGS), steps: [{ ...DRAFT_SETTINGS.steps[0], messageContent: 'こんにちは' }] },
      },
    })
    const { container } = render(<ReminderEditV8 stage="messages" reminderId="r-1" />)
    await waitFor(() => expect(container.querySelector('[role="textbox"][contenteditable]')).toBeTruthy())
    expect(screen.queryByText(/見本：/)).toBeNull()
  })
})
