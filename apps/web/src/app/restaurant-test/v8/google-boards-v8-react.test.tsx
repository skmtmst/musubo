// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), connection: vi.fn(), dirty: false, router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() } }))
const search = vi.hoisted(() => ({ tab: null as string | null, view: null as string | null }))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', setSelectedAccountId: vi.fn(), accounts: [] }) }))
vi.mock('next/navigation',async()=>({... (await import('@/test-utils/navigation-mock')).navigationMock(),
 useRouter:()=>fixture.router,
 usePathname:()=>'/restaurant-test/google',
 useSearchParams:()=>new URLSearchParams({...search.tab?{tab:search.tab}:{},...search.view?{view:search.view,id:'r1'}:{}}),
}))
vi.mock('@/components/shell/page-chrome',async()=> (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { snapshot: fixture.snapshot } }))
vi.mock('@/lib/restaurant-google-api', () => ({
  restaurantGoogleApi: { connection: fixture.connection },
}))
// Inspect the live URL-to-board mapping; child behavior has its own tests.
vi.mock('@/v8/restaurant/google/reviews',()=>({ReviewDraft:()=> <div>現役の子画面</div>,ReviewsBoard:()=> <div>現役の子画面</div>}))
vi.mock('@/v8/restaurant/google/posts',()=>({PostEditor:()=> <div>現役の子画面</div>,PostConfirm:()=> <div>現役の子画面</div>,PostsBoard:()=> <div>現役の子画面</div>}))
vi.mock('@/v8/restaurant/google/performance',()=>({default:()=> <div>現役の子画面</div>}))
vi.mock('@/v8/restaurant/google/hours',()=>({default:()=> <div data-design-node="tYbl8">現役の子画面</div>}))
vi.mock('@/v8/restaurant/google/profile',()=>({default:()=> <div>現役の子画面</div>}))
vi.mock('@/v8/restaurant/google/profile-confirm',()=>({ChangeConfirmScreen:()=> <div>現役の子画面</div>}))
vi.mock('@/v8/restaurant/google/profile-history',()=>({HistoryScreen:()=> <div>現役の子画面</div>}))
vi.mock('@/v8/restaurant/google/profile-hours',()=>({HoursEditor:()=> <div>現役の子画面</div>}))
vi.mock('@/v8/restaurant/google/profile-edit',async()=>{
  const { useUnsavedGuard } = await import('@/lib/use-unsaved-guard')
  const { UnsavedLeaveDialog } = await import('@/lib/unsaved-leave-dialog')
  return { ProfileEditScreen: () => {
    const guard = useUnsavedGuard({ dirty: fixture.dirty })
    return <><div>現役の子画面</div><UnsavedLeaveDialog open={guard.leaveTarget !== null} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></>
  } }
})
vi.mock('@/v8/restaurant/google/settings',()=>({default:()=> <div>現役の子画面</div>}))
import GoogleV8 from '@/v8/restaurant/google/google'

const store = { id: 'store-1', organization_id: 'org-1', name: '渋谷店', code: 'SHIBUYA', area: null, capacity: 26, timezone: 'Asia/Tokyo', status: 'active', line_status: 'connected', google_status: 'connected', line_account_id: 'account-1', line_account_name: '渋谷' }
const connectionData = {
  success: true,
  store: { id: 'store-1', name: '渋谷店', lineAccountId: 'account-1' },
  connection: { status: 'connected', googleAccountEmail: 't@example.com', locationName: 'accounts/111/locations/222', locationTitle: '渋谷店', locationMapsUrl: null, connectedAt: null, lastSyncedAt: null, lastSyncError: null, averageRating: 4.2, totalReviewCount: 24 },
  candidates: [],
  summary: { unrepliedCount: 2, draftCount: 1, attentionCount: 1, newCount: 0, storedCount: 24, postsAttentionCount: 0, syncStale: false },
  writeEnabled: true,
  oauthConfigured: true,
  aiAvailable: false,
  permissions: { canManageConnection: true, canPublishReply: true },
}

beforeEach(() => {
  fixture.dirty = false
  search.tab = null
  search.view = null
  fixture.snapshot.mockResolvedValue({ data: { organization: { id: 'org-1', account_id: 'account-1', tenant_id: null, tenant_name: null, name: '組', status: 'active' }, stores: [store] } })
  fixture.connection.mockResolvedValue(connectionData)
})
afterEach(() => { cleanup(); vi.clearAllMocks(); delete document.documentElement.dataset.theme })

/*
 * Googleビジネス子板6枚の契約。タブ・状態ごとに外枠の板IDが出ることを固定する。
 * 中身は現役の子画面の試験が守る。
 */
describe('Googleビジネス子板の印', () => {
  it.each([
    ['performance', null, 'SrmVs'],
    ['profile', null, 'JUTGz'],
    ['profile', 'hours', 'tYbl8'],
    ['profile', 'confirm', 'JUTGz'],
    ['profile', 'history', 'JUTGz'],
    ['profile', 'edit', 'JUTGz'],
    ['posts', null, 'Cfed0'],
    ['posts', 'new', 'T1j2Sw'],
    ['posts', 'confirm', 'T1j2Sw'],
    ['hours', null, 'tYbl8'],
    ['reviews', 'draft', 'x9HIR'],
  ])('tab=%s view=%s → %s', async (tab, view, node) => {
    search.tab = tab
    search.view = view
    render(<GoogleV8 />)
    await screen.findByText('現役の子画面')
    expect(document.querySelector(`[data-design-node="${node}"]`)).not.toBeNull()
  })

  it('未接続はSNS連携への案内を表示する', async () => {
    search.tab = null
    search.view = null
    fixture.connection.mockResolvedValue({ ...connectionData, connection: { ...connectionData.connection, status: 'new' } })
    render(<GoogleV8 />)
    await screen.findByText('Googleビジネスは未接続です')
    expect(screen.getByRole('link', { name: 'SNS連携を開く' }).getAttribute('href')).toBe('/settings/sns')
  })

  it('編集の子画面が書きかけを持つとき、タブ移動は共有の確認を通してから実行する', async () => {
    document.documentElement.dataset.theme = 'v8'
    fixture.dirty = true; search.tab = 'profile'; search.view = 'edit'
    render(<GoogleV8 />)
    await screen.findByText('現役の子画面')
    fireEvent.click(screen.getByRole('tab', { name: 'パフォーマンス' }))
    await screen.findByRole('dialog')
    expect(fixture.router.replace).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('tab', { name: 'パフォーマンス' }))
    fireEvent.click(await screen.findByRole('button', { name: '保存せずに移る' }))
    expect(fixture.router.replace).toHaveBeenCalledExactlyOnceWith('/restaurant-test/google?tab=performance')
  })
})
