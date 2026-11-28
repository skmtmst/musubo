// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'

const fx = vi.hoisted(() => ({
  accountId: 'acc-1',
  followerImportState: vi.fn(),
  stepFollowerImport: vi.fn(),
  styleGet: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`accountId=${fx.accountId}`),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/line-account-entry-gate', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    accounts: [{ id: 'acc-1', name: '本店', displayName: '本店', pictureUrl: null, basicId: null }],
    setSelectedAccountId: vi.fn(),
  }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    lineAccounts: {
      followerImportState: (...args: unknown[]) => fx.followerImportState(...args),
      stepFollowerImport: (...args: unknown[]) => fx.stepFollowerImport(...args),
    },
  },
}))
vi.mock('@/lib/api/helpers/styles', () => ({
  styleApi: {
    get: (...args: unknown[]) => fx.styleGet(...args),
  },
}))

import ResumeFollowerHandover from './resume-handover'

describe('ResumeFollowerHandover ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.accountId = 'acc-1'
    rememberStaffIdentity({ id: 'viewer', role: 'viewer' } as StaffMember)
    fx.followerImportState.mockResolvedValue({
      success: true,
      data: {
        phase: 'importing_ids',
        capability: 'available',
        updatedAt: 'not-a-valid-date',
        received: 1,
        imported: 1,
        alreadyPresent: 0,
        reactivated: 0,
        claimedUnassigned: 0,
        conflicts: 0,
        invalid: 0,
        profilesProcessed: 0,
        profilesUpdated: 0,
        profileErrors: 0,
      },
    })
    fx.styleGet.mockResolvedValue({
      success: true,
      data: { style: 'toString' },
    })
  })

  afterEach(() => {
    cleanup()
    forgetStaffIdentity()
  })

  it('updatedAt が不正日時のとき「0秒前」と言い切らず「最終更新を確認できません」と要確認表示を出し、未知のプロトタイプ名スタイルも出さない', async () => {
    render(<ResumeFollowerHandover />)

    await waitFor(() => {
      expect(screen.getByText('最終更新を確認できません')).toBeTruthy()
    })

    expect(screen.queryByText(/最終更新：0秒前/)).toBeNull()
    expect(screen.getByText('進み具合を確認できません')).toBeTruthy()
    expect(screen.getByText('進み具合を確認できません。状態を再確認してください。')).toBeTruthy()
    expect(screen.getByText('要確認')).toBeTruthy()
    expect(screen.queryByText(/function toString/)).toBeNull()
  })
})
