// @vitest-environment happy-dom
/*
 * 飲食店組織・店舗管理画面のログインメンバー補助取得失敗と再試行の振る舞い。
 * - ログインメンバー取得に失敗しても店舗管理・名簿を残したまま案内と再読み込みを出せる
 * - 再読み込み連打で二重通信にならず、成功すれば案内が消えてログイン連携候補が出る
 * - 非配列の壊れた応答も黙って成功扱いせず、失敗案内を出す
 */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn(),
  storeGroups: vi.fn(),
  loginMembers: vi.fn(),
  linkMembershipLogin: vi.fn(),
  updateMembership: vi.fn(),
  listIntakeAddresses: vi.fn(),
  gate: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/components/step-up-prompt', () => ({
  useStepUpGate: () => ({ gate: fixture.gate, cancel: fixture.cancel, prompt: null }),
  isStepUpRequired: () => false,
}))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))

import OrganizationV8 from './organization'

const SNAPSHOT = {
  organization: { id: 'org', name: '試験組織', tenant_name: '然 本部' },
  stores: [{ id: 'store-1', name: '渋谷店', code: 'SBY', status: 'active', capacity: 40, line_account_id: 'account-1' }],
  memberships: [
    {
      id: 'm-1',
      organization_id: 'org',
      store_id: 'store-1',
      staff_name: '田中 花子',
      email: 'tanaka@example.com',
      role: 'store_manager',
      status: 'active',
      staff_id: null,
      line_uid: null,
      google_email: null,
    },
  ],
  tables: [],
  menuItems: [],
  reservations: [],
  inventory: [],
  approvals: [],
  connectors: [],
  reviews: [],
  posts: [],
  lineFlows: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  fixture.snapshot.mockResolvedValue({ data: SNAPSHOT })
  fixture.storeGroups.mockResolvedValue({ data: [] })
  fixture.listIntakeAddresses.mockResolvedValue({ data: [] })
  fixture.loginMembers.mockResolvedValue({ data: [{ id: 'login-1', name: '管理 太郎' }] })
})

afterEach(() => {
  cleanup()
})

describe('飲食店組織管理のログインメンバー失敗表示と再試行', () => {
  it('取得失敗時に店舗管理を残したまま案内を出し、再読み込み連打を抑えて復旧できる', async () => {
    let resolveRetry!: (value: unknown) => void
    fixture.loginMembers
      .mockRejectedValueOnce(new Error('login members offline'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve }))

    render(<OrganizationV8 />)

    await screen.findByText('田中 花子')
    await screen.findByText(/ログインメンバーを読み込めませんでした。店舗管理や名簿の確認は続けられます。/)
    expect(screen.queryByText(/読み込めていないため件数は分かりません/)).toBeNull()

    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)
    fireEvent.click(retryBtn)

    await waitFor(() => expect(fixture.loginMembers).toHaveBeenCalledTimes(2))

    resolveRetry({ data: [{ id: 'login-1', name: '管理 太郎' }] })
    await waitFor(() => expect(screen.queryByText(/ログインメンバーを読み込めませんでした/)).toBeNull())
    expect(fixture.loginMembers).toHaveBeenCalledTimes(2)
  })

  it('配列でない応答も成功扱いせず失敗案内を出す', async () => {
    fixture.loginMembers.mockResolvedValueOnce({ success: false, data: null })

    render(<OrganizationV8 />)

    await screen.findByText(/ログインメンバーを読み込めませんでした。店舗管理や名簿の確認は続けられます。/)
  })
})
