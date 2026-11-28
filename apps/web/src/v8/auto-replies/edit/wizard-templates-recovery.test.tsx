// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

const fixture = vi.hoisted(() => ({
  templatesList: vi.fn(),
  foldersList: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/auto-replies/edit',
  useSearchParams: () => new URLSearchParams('step=response'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'acc-1',
    selectedAccount: { id: 'acc-1', name: '渋谷本店' },
    accounts: [{ id: 'acc-1', name: '渋谷本店' }],
    loading: false,
  }),
}))

vi.mock('@/lib/staff-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...actual, useStaffRole: () => 'admin' }
})

vi.mock('@/lib/use-feature-access', () => ({
  useFeatureAccess: () => true,
}))

vi.mock('@/components/auto-replies/inline-action-list', () => ({
  useActionOptions: () => ({
    tags: [],
    scenarios: [],
    fields: [],
    notificationRules: [],
    loading: false,
    error: '',
    reload: vi.fn(),
  }),
}))

vi.mock('@/lib/use-insert-token-names', () => ({
  useInsertReferences: () => ({ references: { commonVars: [], friendFields: [] }, state: 'ready' }),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      templates: {
        ...actual.api.templates,
        list: fixture.templatesList,
      },
      folders: {
        ...actual.api.folders,
        list: fixture.foldersList,
      },
    },
  }
})

import AutoReplyWizardV8 from './wizard'

describe('自動応答ウィザード：テンプレート候補取得失敗時の表示と再読込復旧', () => {
  beforeEach(() => {
    forgetSessionSnapshot()
    verifiedStaffRole('admin')
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    document.documentElement.dataset.theme = 'v8'
    fixture.foldersList.mockResolvedValue({ success: true, data: [] })
  })

  afterEach(() => {
    cleanup()
    forgetStaffIdentity()
    forgetSessionSnapshot()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.theme
  })

  it('テンプレート候補の取得に失敗したとき案内と「テンプレートを読み直す」を出し、押すと入力を保ったまま復旧する', async () => {
    fixture.templatesList
      .mockRejectedValueOnce(new Error('templates unavailable'))
      .mockResolvedValueOnce({
        success: true,
        data: [
          {
            id: 'tpl-1',
            name: '予約確認テンプレート',
            messageType: 'text',
            messageContent: 'ご予約ありがとうございます。',
            folderId: null,
            updatedAt: '2026-11-26T00:00:00Z',
          },
        ],
      })

    render(<AutoReplyWizardV8 />)

    const tplChip = await screen.findByRole('button', { name: 'テンプレートから' })
    fireEvent.click(tplChip)

    expect(await screen.findByText(/テンプレートを読み込めませんでした/)).toBeTruthy()
    const retryBtn = screen.getByRole('button', { name: 'テンプレートを読み直す' })
    fireEvent.click(retryBtn)

    await waitFor(() => expect(screen.queryByText(/テンプレートを読み込めませんでした/)).toBeNull())
    expect(fixture.templatesList).toHaveBeenCalledTimes(2)
    expect(tplChip.getAttribute('aria-pressed')).toBe('true')
  })

  it('テンプレートを読み直すを連打しても進行中は二重リクエストを送らず、完了後に復旧する', async () => {
    let resolveRetry!: (value: unknown) => void
    fixture.templatesList
      .mockResolvedValueOnce({ success: false, error: 'temporary failure' })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<AutoReplyWizardV8 />)

    const tplChip = await screen.findByRole('button', { name: 'テンプレートから' })
    fireEvent.click(tplChip)

    const retryBtn = await screen.findByRole('button', { name: 'テンプレートを読み直す' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)
    expect(fixture.templatesList).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveRetry({
        success: true,
        data: [
          {
            id: 'tpl-2',
            name: '案内テンプレート',
            messageType: 'text',
            messageContent: 'ご案内いたします。',
            folderId: null,
            updatedAt: '2026-11-26T00:00:00Z',
          },
        ],
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.queryByText(/テンプレートを読み込めませんでした/)).toBeNull())
  })
})
