// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CUSTOMER_LOOK } from '@line-crm/shared'
import { ApiError } from '@/lib/api'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

const mock = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  api: { accountSettings: { getCustomerLook: mock.get, saveCustomerLook: mock.save } },
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'a', selectedAccount: { id: 'a', name: '店A' }, accounts: [{ id: 'a', name: '店A' }] }),
}))
vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => 'owner',
  canManageRole: (role: string) => ['owner', 'admin'].includes(role),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {}, useHideSettingsNav: () => {} }))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/components/templates/settings-page', () => ({
  SettingsPage: ({ children, preview, saveActions, saveStatus, notice, help }: Pick<ComponentProps<typeof import('@/components/templates/settings-page').SettingsPage>, 'children' | 'preview' | 'saveActions' | 'saveStatus' | 'notice' | 'help'>) => (
    <div>
      {help}
      {notice}
      {children}
      {preview}
      <div data-testid="save-status">{saveStatus}</div>
      {saveActions}
    </div>
  ),
}))
vi.mock('@/components/shared/customer-look-preview', () => ({
  default: ({ look }: { look: typeof DEFAULT_CUSTOMER_LOOK }) => <p>見本：{look.preset}</p>,
}))
vi.mock('@/components/shared/toast', () => ({ notifyToast: () => {} }))
vi.mock('@/lib/use-unsaved-guard', () => ({ useUnsavedGuard: () => ({ guarded: (fn: () => void) => fn(), disarm: () => {}, leaveTarget: null }) }))
vi.mock('@/lib/unsaved-leave-dialog', () => ({ UnsavedLeaveDialog: () => null }))

import CustomerLookScreen from './screen'

beforeEach(() => {
  vi.resetAllMocks()
  verifiedStaffRole('owner')
})

afterEach(() => {
  cleanup()
  forgetStaffIdentity()
  forgetSessionSnapshot()
})

describe('お客さまの画面のデザイン：読み込み失敗時の表示と再読み込み', () => {
  it('読み込み失敗時に再読み込みボタンを1つだけ出し、フッターへ重複エラーを出さずにその場で回復できる', async () => {
    let resolveRetry: ((value: { success: true; data: { look: typeof DEFAULT_CUSTOMER_LOOK; version: number } }) => void) | null = null
    mock.get
      .mockRejectedValueOnce(new ApiError(500, 'サーバーが一時的に混雑しています'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<CustomerLookScreen />)

    expect(await screen.findByText('デザインを読み込めませんでした')).toBeTruthy()
    expect(screen.queryByText(/件数は分かりません/)).toBeNull()
    expect(screen.getByTestId('save-status').textContent).toBe('')

    const retryButtons = screen.getAllByRole('button', { name: 'もう一度読み込む' })
    expect(retryButtons).toHaveLength(1)

    fireEvent.click(retryButtons[0])
    fireEvent.click(retryButtons[0])
    await waitFor(() => expect(mock.get).toHaveBeenCalledTimes(2))

    resolveRetry!({ success: true, data: { look: DEFAULT_CUSTOMER_LOOK, version: 3 } })
    expect(await screen.findByText('見本：line')).toBeTruthy()
  })
})
