// @vitest-environment happy-dom
// @vitest-environment-options { "url": "http://localhost/rich-menus/edit/" }
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RichMenuCreateV8 from '@/v8/rich-menus/new/create'
import type { RichMenuTestApplyItem } from '@/lib/api'

const net = vi.hoisted(() => ({
  role: 'owner', account: { id: 'account-1', name: '店A' },
  state: { linked: true, confirmationRevision: 4, destinationToken: 'a'.repeat(64), linkGuidance: null as string | null,
    destination: { staffName: '担当者A', lineUserIdMasked: 'U***1234' },
    active: null as RichMenuTestApplyItem | null, recent: [] as RichMenuTestApplyItem[] },
  apply: vi.fn(), revert: vi.fn(), readState: vi.fn(),
}))
const group = {
  id: 'g1', accountId: 'account-1', name: 'メニュー', chatBarText: 'メニュー',
  size: 'large', defaultPageId: 'p1', isDefaultForAll: false, status: 'draft',
  targetingCondition: null, targetingPriority: 0, targetingEnabled: false,
  folderId: null, defaultOpen: true, version: 1,
  pages: [{ id: 'p1', orderIndex: 0, name: '1枚目', aliasId: '', lineRichmenuId: null, imageR2Key: 'img', imageContentType: 'image/jpeg', areas: [] }],
}
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: net.account, selectedAccountId: net.account.id, accounts: [net.account], loading: false }),
}))
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    staff: { ...actual.api.staff, me: async () => ({ success: true, data: { id: 'owner-1', role: net.role } }) },
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
    tags: { ...actual.api.tags, list: async () => ({ success: true, data: [] }) },
    templates: { ...actual.api.templates, list: async () => ({ success: true, data: [] }) },
    forms: { ...actual.api.forms, list: async () => ({ success: true, data: [] }) },
    trackedLinks: { ...actual.api.trackedLinks, list: async () => ({ success: true, data: [] }) },
    richMenuGroups: { ...actual.api.richMenuGroups,
      get: async () => ({ success: true, data: group }),
      list: async () => ({ success: true, data: [] }),
      previewTargets: async () => ({ success: true, data: null }),
      audienceSummary: async () => ({ success: true, data: null }),
      prepublishCheck: async () => ({ success: true, data: { selfCheck: { ok: true }, deviceConfirmed: false, deviceConfirmedAt: null, pageCount: 1, maxPages: 10 } }),
      testApplyState: net.readState, testApply: net.apply, testApplyRevert: net.revert,
    },
  } }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
function item(status: string, previousCaptured = true): RichMenuTestApplyItem {
  return { id: 'apply-1', status, previousCaptured, previousRichMenuId: 'old-menu', appliedRichMenuId: 'test-menu', lastErrorCode: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
}
async function renderEditor() {
  await act(async () => { root.render(<RichMenuCreateV8 editGroupId="g1" />) })
  await screen.findByRole('heading', { name: '公開の前の確認' })
}
async function openTest() {
  await renderEditor()
  fireEvent.click(await screen.findByRole('button', { name: '自分のLINEで試す' }))
  await waitFor(() => expect(net.readState).toHaveBeenCalled())
  await screen.findByText('宛先: 担当者AのLINE（U***1234）')
  return screen.getByRole('dialog', { name: '自分のLINEで試す' })
}
async function confirmApply() {
  const dialog = await openTest()
  fireEvent.click(within(dialog).getByRole('button', { name: '自分のLINEに適用して試す' }))
  return screen.findByRole('dialog', { name: '自分のLINEにこのメニューを出しますか？' })
}
beforeEach(() => {
  net.role = 'owner'
  net.account = { id: 'account-1', name: '店A' }
  net.state = { linked: true, confirmationRevision: 4, destinationToken: 'a'.repeat(64), linkGuidance: null, destination: { staffName: '担当者A', lineUserIdMasked: 'U***1234' }, active: null, recent: [] }
  net.readState.mockReset().mockImplementation(async () => ({ success: true, data: { ...net.state } }))
  net.apply.mockReset().mockImplementation(async () => { net.state.active = item('applied'); return { success: true, data: { id: 'apply-1', status: 'applied' } } })
  net.revert.mockReset().mockImplementation(async () => { net.state.active = item('reverted'); return { success: true, data: { ...net.state.active, userMenuAction: 'restored' } } })
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/rich-menus/edit?id=g1&step=publish')
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove(); delete document.documentElement.dataset.theme
})

describe('現役V8の本人LINEでのテスト', () => {
  it('連携済みの本人だけを宛先に示し、確認前と取消では適用しない', async () => {
    const dialog = await confirmApply()
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    expect(within(dialog).getByText(/宛先: 担当者AのLINE（U\*\*\*1234）/)).toBeTruthy()
    expect(within(dialog).getByText(/ほかの友だちには出ません/)).toBeTruthy()
    expect(net.apply).not.toHaveBeenCalled()
    expect(screen.queryByRole('combobox', { name: /友だち/ })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '自分のLINEにこのメニューを出しますか？' })).toBeNull())
    expect(net.apply).not.toHaveBeenCalled()
  })
  it('通信断の押し直しは同じ鍵を使い、成功後は元へ戻す口を出す', async () => {
    net.apply.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const dialog = await confirmApply()
    fireEvent.click(within(dialog).getByRole('button', { name: '自分のLINEに適用する' }))
    await screen.findByText('テスト適用できませんでした。しばらくおいてから、もう一度お試しください。')
    fireEvent.click(within(dialog).getByRole('button', { name: '自分のLINEに適用する' }))
    await screen.findByText('あなたのLINEにこのメニューを出しました。LINEアプリで見え方を確認してください。')
    expect(net.apply).toHaveBeenCalledTimes(2)
    expect(net.apply.mock.calls[0][0]).toBe('g1')
    expect(net.apply.mock.calls[0][1]).toEqual(expect.any(String))
    expect(net.apply.mock.calls[0][2]).toEqual({ expectedConfirmationRevision: 4, expectedDestinationToken: 'a'.repeat(64) })
    expect(net.apply.mock.calls[1][1]).toBe(net.apply.mock.calls[0][1])
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '自分のLINEにこのメニューを出しますか？' })).toBeNull())
    expect(screen.getByRole('button', { name: '元のメニューに戻す' })).toBeTruthy()
  })
  it('409の後は新しい宛先と版を読み直す', async () => {
    const { ApiError } = await import('@/lib/api')
    const dialog = await confirmApply()
    net.state = { ...net.state, confirmationRevision: 5, destinationToken: 'b'.repeat(64), destination: { staffName: '担当者B', lineUserIdMasked: 'U***9999' } }
    net.apply.mockRejectedValueOnce(new ApiError(409, 'changed'))
    fireEvent.click(within(dialog).getByRole('button', { name: '自分のLINEに適用する' }))
    await within(dialog).findByText(/担当者BのLINE/)
    fireEvent.click(within(dialog).getByRole('button', { name: '自分のLINEに適用する' }))
    await waitFor(() => expect(net.apply).toHaveBeenLastCalledWith('g1', expect.any(String), { expectedConfirmationRevision: 5, expectedDestinationToken: 'b'.repeat(64) }))
  })
  it('実行中の二重押下では適用要求を増やさない', async () => {
    let resolve!: (value: unknown) => void
    net.apply.mockReturnValue(new Promise(r => { resolve = r }))
    const dialog = await confirmApply()
    const button = within(dialog).getByRole('button', { name: '自分のLINEに適用する' })
    await act(async () => { fireEvent.click(button); fireEvent.click(button) })
    expect(net.apply).toHaveBeenCalledTimes(1)
    await act(async () => { resolve({ success: true, data: { id: 'apply-1', status: 'applied' } }) })
  })
  it.each([
    ['restored', '適用前の表示へ戻しました。'],
    ['already_restored', 'すでに適用前の表示に戻っていました。テスト用に作ったメニューだけ削除しました。'],
    ['left_as_is', '適用後にあなたの表示が別のメニューへ変わっていたため、今の表示はそのままにしました。テスト用に作ったメニューだけ削除しました。'],
    ['untouched', 'あなたの表示は一度も変わっていなかったため、そのままにしました。'],
  ])('取消の結果 %s を取り違えず知らせる', async (action, message) => {
    net.state.active = item('applied')
    net.revert.mockImplementation(async () => { net.state.active = item('reverted'); return { success: true, data: { ...net.state.active, userMenuAction: action } } })
    const panel = await openTest()
    fireEvent.click(within(panel).getByRole('button', { name: '元のメニューに戻す' }))
    const dialog = await screen.findByRole('dialog', { name: 'テスト適用を取り消しますか？' })
    expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
    expect(within(dialog).getByText('環境')).toBeTruthy()
    expect(within(dialog).getByText(/表示が変わっていた場合は上書きしません/)).toBeTruthy()
    expect(net.revert).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '元のメニューに戻す' }))
    await screen.findByText(message)
    expect(net.revert).toHaveBeenCalledExactlyOnceWith('g1', expect.any(String), 'apply-1')
  })
  it.each([true, false])('失敗後の復元は以前の表示を記録できた場合だけ出す（%s）', async captured => {
    net.state.active = item('failed', captured)
    const panel = await openTest()
    expect(Boolean(within(panel).queryByRole('button', { name: '元のメニューに戻す' }))).toBe(captured)
    expect(Boolean(within(panel).queryByRole('button', { name: '自分のLINEに適用して試す' }))).toBe(!captured)
  })
  it('未連携は案内だけを出し、適用する口を出さない', async () => {
    net.state.linked = false; net.state.linkGuidance = '担当者の設定でLINEを連携してください。'
    await renderEditor()
    fireEvent.click(await screen.findByRole('button', { name: '自分のLINEで試す' }))
    await screen.findByText(net.state.linkGuidance)
    expect(screen.queryByRole('button', { name: '自分のLINEに適用して試す' })).toBeNull()
    expect(net.apply).not.toHaveBeenCalled()
  })
  it.each(['staff', 'viewer'])('管理者以外（%s）にはテスト操作を出さない', async role => {
    net.role = role
    await renderEditor()
    expect(screen.queryByRole('button', { name: '自分のLINEで試す' })).toBeNull()
    expect(net.readState).not.toHaveBeenCalled()
  })
  it('店切替で前の確認を破棄し、古い窓から適用しない', async () => {
    await confirmApply()
    net.account = { id: 'account-2', name: '店B' }
    await act(async () => { root.render(<RichMenuCreateV8 editGroupId="g1" />) })
    expect(screen.queryByRole('dialog', { name: '自分のLINEにこのメニューを出しますか？' })).toBeNull()
    expect(net.apply).not.toHaveBeenCalled()
  })
  it('店を切り替えて戻しても古い確定から適用しない', async () => {
    const dialog = await confirmApply()
    const button = within(dialog).getByRole('button', { name: '自分のLINEに適用する' })
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    net.account = { id: 'account-2', name: '店B' }
    await act(async () => { root.render(<RichMenuCreateV8 editGroupId="g1" />) })
    net.account = { id: 'account-1', name: '店A' }
    await act(async () => { root.render(<RichMenuCreateV8 editGroupId="g1" />) })
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(net.apply).not.toHaveBeenCalled()
  })
})

it.each(['apply', 'revert'] as const)('閉じたテスト確認の古い確定から%sを実行しない', async kind => {
  let dialog: HTMLElement
  if (kind === 'apply') dialog = await confirmApply()
  else {
    net.state.active = item('applied')
    const panel = await openTest()
    fireEvent.click(within(panel).getByRole('button', { name: '元のメニューに戻す' }))
    dialog = await screen.findByRole('dialog', { name: 'テスト適用を取り消しますか？' })
  }
  const label = kind === 'apply' ? '自分のLINEに適用する' : '元のメニューに戻す'
  const button = within(dialog).getByRole('button', { name: label })
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  await act(async () => { await oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(kind === 'apply' ? net.apply : net.revert).not.toHaveBeenCalled()
})
