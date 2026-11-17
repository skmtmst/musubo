// @vitest-environment happy-dom
/*
 * D015 実描画回帰: リマインダ編集の下書き取得が 403・429 で落ちたとき、
 * 利用者が見る文言・再試行の有無・回復を実際の描画で確かめる。
 * 文字列検査ではなく、合成 GET reject に対する画面の振る舞いを見る。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const { ApiError: TestApiError } = await import('@/lib/api') as unknown as {
  ApiError: new (status: number, message: string) => Error & { status: number }
}

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
  folderId: null,
  stopConditions: {
    bookingCancelled: true,
    supportMarkCompleted: false,
    daysAfterTarget: 7,
    friendBlocked: true,
  },
  steps: [
    { stableStepId: 's-1', offsetMinutes: 0, offsetDays: -1, sendAtTime: '18:00', messageType: 'text', messageContent: '前日のお知らせ本文' },
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
  fixture.getDraft.mockReset()
  fixture.saveDraft.mockReset()
  fixture.validateDraft.mockReset()
  fixture.validateDraft.mockResolvedValue({ success: true, data: null })
})
afterEach(cleanup)

describe('D015 リマインダ編集の取得失敗（実描画）', () => {
  it('403は権限の理由を出し、再読み込みを出し、保存もできない', async () => {
    fixture.getDraft.mockRejectedValue(new TestApiError(403, 'API error: 403'))
    render(<ReminderEditV8 stage="messages" reminderId="r-1" />)
    const alert = (await screen.findByText(/リマインダを見る権限がありません|混み合っています/)).closest('[data-list-state="error"]') as HTMLElement
    expect(within(alert).getByText('リマインダを見る権限がありません')).not.toBeNull()
    expect(within(alert).getByText(/オーナーか管理者に頼んでください/)).not.toBeNull()
    // 権限の案内を保ち、権限変更後に読み直せる。保存の口はない。
    expect(within(alert).queryByRole('button')).toBeTruthy()
    expect(screen.queryByText('リマインダを読み込めませんでした')).toBeNull()
  })

  it('429は混雑の待ち理由を出し、再試行を残す', async () => {
    fixture.getDraft.mockRejectedValue(new TestApiError(429, 'API error: 429'))
    render(<ReminderEditV8 stage="messages" reminderId="r-1" />)
    const alert = (await screen.findByText(/リマインダを見る権限がありません|混み合っています/)).closest('[data-list-state="error"]') as HTMLElement
    expect(within(alert).getByText('混み合っています')).not.toBeNull()
    expect(within(alert).getByText(/少し待ってから、もう一度読み込んでください/)).not.toBeNull()
    expect(within(alert).getByRole('button', { name: 'もう一度読み込む' })).not.toBeNull()
  })

  it('その他の失敗は下書き固有の案内を出す', async () => {
    fixture.getDraft.mockRejectedValue(new TestApiError(500, 'secret internal'))
    render(<ReminderEditV8 stage="messages" reminderId="r-1" />)
    expect(await screen.findByText('下書きを読み込めませんでした')).toBeTruthy()
    expect(document.body.textContent).toContain('下書きを読み込めませんでした。')
    expect(document.body.textContent).not.toContain('secret internal')
  })

  it('429から読み直すと直り、古い失敗文は消える', async () => {
    fixture.getDraft.mockRejectedValueOnce(new TestApiError(429, 'API error: 429'))
    fixture.getDraft.mockResolvedValue(draftResponse())
    render(<ReminderEditV8 stage="messages" reminderId="r-1" />)
    const alert = (await screen.findByText(/リマインダを見る権限がありません|混み合っています/)).closest('[data-list-state="error"]') as HTMLElement
    expect(within(alert).getByText('混み合っています')).not.toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'もう一度読み込む' }))
    await waitFor(() => {
      expect(screen.queryByText('混み合っています')).toBeNull()
    })
    expect(fixture.getDraft).toHaveBeenCalledTimes(2)
    // 下書きが描かれる（通知ステップの1通目の本文が複数箇所に出る）。
    await waitFor(() => expect(screen.getAllByText('前日のお知らせ本文').length).toBeGreaterThanOrEqual(1))
    expect(document.body.textContent).not.toContain('読み込めませんでした')
  })
})
