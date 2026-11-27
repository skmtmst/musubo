// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

const state = vi.hoisted(() => ({ canEdit: false, get: vi.fn(), push: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('id=group'), useRouter: () => ({ push: state.push }), usePathname: () => '/rich-menus/connections' }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/use-feature-access', () => ({ useFeatureAccess: () => state.canEdit }))
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), api: { richMenuGroups: { get: state.get } } }))
import Connections from './connections'

const page = (id: string, orderIndex: number, targets: string[]) => ({ id, name: id, orderIndex, lineRichmenuId: null, areas: targets.map(targetPageId => ({ actionType: 'richmenuswitch', actionData: { targetPageId }, label: null })) })
const group = { id: 'group', accountId: 'a', name: 'テスト', status: 'draft', defaultPageId: 'トップ', pages: [page('トップ', 0, ['商品']), page('商品', 1, [])] }
beforeEach(() => { verifiedStaffRole('viewer'); state.canEdit = false; state.push.mockReset(); state.get.mockReset().mockResolvedValue({ success: true, data: group }) })
afterEach(() => { cleanup(); verifiedStaffRole(null) })

it('閲覧のみは追加と戻れない先の修正を理由付きで確認でき、移動できない', async () => {
  render(<Connections />)
  for (const name of ['切替先のメニューを足す（最大10 枚）', '商品を開いて直す']) {
    const button = await screen.findByRole('button', { name })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('href')).toBeNull()
    fireEvent.click(button)
  }
  expect(document.body.textContent).toContain('閲覧のみのため変更できません')
  expect(state.push).not.toHaveBeenCalled()
})

it('編集できる人は従来どおり編集先へ移動できる', async () => {
  verifiedStaffRole('owner'); state.canEdit = true
  render(<Connections />)
  const link = await screen.findByRole('link', { name: '商品を開いて直す' })
  expect(link.getAttribute('href')).toBe('/rich-menus/edit?id=group&step=buttons')
})

it('10枚のときも閲覧のみはその他の操作に修正できない理由を見る', async () => {
  state.get.mockResolvedValue({ success: true, data: { ...group, pages: [group.pages[0], ...Array.from({ length: 9 }, (_, i) => page(`頁${i}`, i + 1, []))] } })
  render(<Connections />)
  fireEvent.click(await screen.findByRole('button', { name: 'そのほかの操作' }))
  const item = await screen.findByRole('menuitem', { name: 'ボタンの動きを編集する' })
  expect(item.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(item)
  expect(state.push).not.toHaveBeenCalled()
})
