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
  capturedIdleSeconds: [] as number[],
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
vi.mock('./step5-completion', () => ({
  default: ({ idleSeconds }: { idleSeconds: number }) => {
    fx.capturedIdleSeconds.push(idleSeconds)
    return <div data-testid="step5-idle">{String(idleSeconds)}</div>
  },
}))

import ResumeFollowerHandover from './resume-handover'

describe('ResumeFollowerHandover ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fx.accountId = 'acc-1'
    fx.capturedIdleSeconds = []
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
        profilesUpdated: 0,
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

  it('updatedAt が不正日時でも idleSeconds が NaN にならず、未知のプロトタイプ名スタイルもそのまま表示しない', async () => {
    render(<ResumeFollowerHandover />)

    await waitFor(() => {
      expect(fx.followerImportState).toHaveBeenCalledWith('acc-1')
      expect(fx.styleGet).toHaveBeenCalledWith('acc-1')
    })

    const idleNode = screen.getByTestId('step5-idle')
    expect(idleNode.textContent).toBe('0')
    expect(idleNode.textContent).not.toBe('NaN')
    expect(screen.queryByText(/function toString/)).toBeNull()
  })
})
