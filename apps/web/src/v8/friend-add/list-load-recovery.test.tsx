// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot } from '@/lib/session-snapshot'

const fixture = vi.hoisted(() => ({
  list: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/friend-add-settings',
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: 'acc-1',
    selectedAccount: { id: 'acc-1', name: '渋谷本店' },
    accounts: [{ id: 'acc-1', name: '渋谷本店' }],
    loading: false,
  }),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))

vi.mock('@/lib/staff-role', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/staff-role')>()
  return { ...actual, useStaffRole: () => 'admin' }
})

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      friendAddRules: {
        ...actual.api.friendAddRules,
        list: fixture.list,
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import FriendAddListV8 from './list'

const sampleData = {
  items: [
    {
      id: 'rule-1',
      accountId: 'acc-1',
      friendKind: 'first_time' as const,
      name: '店頭QRの初回案内',
      folderName: '店頭',
      priority: 1,
      isFallback: false,
      status: 'published' as const,
      versionId: 'v1',
      versionNumber: 1,
      versionStatus: 'published',
      lastTestStatus: null,
      lastTestedAt: null,
      lastTestedByStaffId: null,
      lastTestedByStaffName: null,
      publishedAt: null,
      matchedLast7Days: 12,
      version: 1,
      routeNames: ['店頭QR'],
      scenarioName: null,
      definition: {
        routeIds: ['route-1'],
        scenarioId: null,
        messageType: 'text' as const,
        messageText: 'こんにちは',
        timing: 'immediate' as const,
        actions: [],
        friendCondition: '',
        activeFrom: null,
        activeUntil: null,
      },
    },
  ],
  total: 1,
  nextCursor: null,
  folderCounts: [{ name: '店頭', count: 1 }],
  summary: { rules: 1, active: 1, recentAdds: 15, captured: 12, unknownRoute: 3, delivered: 10, failed: 0 },
  options: { routes: [], scenarios: [], tags: [], folders: [{ id: 'f1', name: '店頭', color: '#16a34a' }] },
}

describe('友だち追加時の配信一覧：失敗・権限不足・読み込み中のKPIと再読込表示', () => {
  beforeEach(() => {
    forgetSessionSnapshot()
    verifiedStaffRole('admin')
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    document.documentElement.dataset.theme = 'v8'
  })

  afterEach(() => {
    cleanup()
    forgetStaffIdentity()
    forgetSessionSnapshot()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.theme
  })

  it('一覧の読み込み失敗時はKPIカード4枚すべてに「読み込めませんでした」を出し、フォルダ件数に偽の0を出さず再読込で復旧できる', async () => {
    fixture.list
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ success: true, data: sampleData })

    const { container } = render(<FriendAddListV8 />)

    await screen.findByText('設定を読み込めませんでした')
    const kpiCards = Array.from(container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"]'))
    expect(kpiCards.length).toBe(4)
    for (const card of kpiCards) {
      expect(card.textContent).toContain('読み込めませんでした')
    }

    const folderNav = container.querySelector('[data-design="FolderList"]')
    expect(folderNav?.textContent ?? '').not.toMatch(/すべて\s*0/)

    const retryBtn = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retryBtn)

    await screen.findByText('店頭QRの初回案内')
    expect(fixture.list).toHaveBeenCalledTimes(2)
  })

  it('権限不足（403）では権限不足の案内とKPIの権限文言を出し、読み込み中はKPIカード4枚をローディングにする', async () => {
    let resolveFirst!: (value: unknown) => void
    fixture.list.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))

    const { container } = render(<FriendAddListV8 />)
    await waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(1))

    expect(container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"][aria-busy="true"]').length).toBe(4)

    await act(async () => {
      resolveFirst(Promise.reject(new ApiError(403, 'forbidden')))
      await Promise.resolve()
    })

    await screen.findByText('設定を表示する権限がありません')
    expect(screen.getByRole('alert').textContent).toContain('設定を表示する権限がありません')
    const kpiCards = Array.from(container.querySelectorAll('[data-design="KPIs"] [data-kpi-presentation="band"]'))
    expect(kpiCards.length).toBe(4)
    for (const card of kpiCards) {
      expect(card.textContent).toContain('表示する権限がありません')
    }
  })
})
