// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

const state = vi.hoisted(() => ({ canEdit: true, get: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('id=group'),
  useRouter: () => ({ push: state.push }),
  usePathname: () => '/rich-menus/connections',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'a', loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => {},
  usePageCrumbs: () => {},
}))
vi.mock('@/lib/use-feature-access', () => ({
  useFeatureAccess: () => state.canEdit,
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { richMenuGroups: { get: state.get } },
}))

import Connections from './connections'

const BASE_GROUP = {
  id: 'group',
  accountId: 'a',
  name: 'テスト',
  status: 'published',
  defaultPageId: 'p1',
  pages: [
    { id: 'p1', name: 'トップ', orderIndex: 0, lineRichmenuId: 'rm-1', areas: [{ actionType: 'richmenuswitch', actionData: { targetPageId: 'p2' }, label: '商品' }] },
    { id: 'p2', name: '商品', orderIndex: 1, lineRichmenuId: 'rm-2', areas: [{ actionType: 'richmenuswitch', actionData: { targetPageId: 'p1' }, label: 'トップ' }] },
  ],
}

beforeEach(() => {
  verifiedStaffRole('owner')
  state.canEdit = true
  state.push.mockReset()
  state.get.mockReset()
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
})

describe('rich-menus/connections の非有限統計値・403権限失敗ガード', () => {
  it('出る人・今月押された回数が NaN や負数のとき「—人」「—回」や負数を出さず「—」にする', async () => {
    state.get.mockResolvedValue({
      success: true,
      data: {
        ...BASE_GROUP,
        audienceCount: -5,
        monthlyStats: { taps: Number.NaN, uniqueAudience: { value: Number.NaN } },
      },
    })

    const { container } = render(<Connections />)
    await screen.findByText('切替のつながり：テスト')
    const text = container.textContent ?? ''
    expect(text).not.toContain('—人')
    expect(text).not.toContain('—回')
    expect(text).not.toContain('-5人')
    expect(text).not.toContain('NaN')
  })

  it('403 の取得失敗では通信エラー文ではなく権限の案内を表示する', async () => {
    state.get.mockRejectedValue(new ApiError(403, 'Forbidden'))

    const { container } = render(<Connections />)
    await screen.findByText('切替のつながりを読み込めませんでした')
    expect(container.textContent).toContain('権限')
    expect(container.textContent).not.toContain('通信が切れたか')
  })
})
