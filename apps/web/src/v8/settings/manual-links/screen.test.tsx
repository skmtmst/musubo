// @vitest-environment happy-dom
import React from 'react'
import { setImmediate } from 'node:timers'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import ManualLinksScreen from './screen'
import { useManualLinks } from './use-manual-links'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'

const mocks = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn(), check: vi.fn(), readOnly: false, me: vi.fn(), roleBundle: undefined as string | undefined }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), usePathname: () => '/settings/manual-links' }))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => <nav>設定の目次</nav> }))
vi.mock('@/lib/api', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api')>()
  return { ...original, api: { ...original.api, staff: { ...original.api.staff, me: mocks.me }, manualLinks: { ...original.api.manualLinks, list: mocks.list, update: mocks.update, check: mocks.check } } }
})
const link = { key: '2-1', keyKind: 'screen', name: '受信箱', url: 'https://example.test/inbox', status: 'ok', lastCheckedAt: '2026-10-01T00:00:00Z', version: 2 }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.readOnly = false
  mocks.roleBundle = undefined
  mocks.me.mockImplementation(async () => ({ success: true, data: { id: 'owner', role: 'owner', readOnly: mocks.readOnly, roleBundle: mocks.roleBundle } }))
  mocks.list.mockResolvedValue({ success: true, data: { items: [link], total: 1 } })
  mocks.update.mockResolvedValue({ success: true, data: { ...link, version: 3 } })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot() })
async function edit() {
  render(<ManualLinksScreen />)
  fireEvent.click(await screen.findByRole('button', { name: '受信箱のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '行き先を編集する' }))
  return screen.getByRole('textbox', { name: '受信箱のマニュアルのURL' }) as HTMLInputElement
}
it('行内のURLを編集し、下部の保存から対象の版付きで1回送る', async () => {
  const input = await edit()
  fireEvent.change(input, { target: { value: 'https://example.test/new' } })
  const save = screen.getByRole('button', { name: '決める' })
  expect(save.closest('[data-template-region="footer"]')).toBeTruthy()
  expect(save.closest('[role="row"]')).toBeNull()
  fireEvent.click(save)
  await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('2-1', { url: 'https://example.test/new', expectedVersion: 2 }))
  expect(mocks.update).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '受信箱のマニュアルのURL' })).toBeNull())
})
it('競合で読み直しても編集中のURLと下部の操作を残す', async () => {
  mocks.update.mockRejectedValue(new ApiError(409, 'version_conflict'))
  const input = await edit()
  fireEvent.change(input, { target: { value: 'https://example.test/draft' } })
  fireEvent.click(screen.getByRole('button', { name: '決める' }))
  await screen.findByText(/ほかの人が先に変更しました/)
  expect(input.value).toBe('https://example.test/draft')
  expect(screen.getByRole('button', { name: '決める' }).closest('[data-template-region="footer"]')).toBeTruthy()
  expect(mocks.list).toHaveBeenCalledTimes(2)
})
it('未保存の取消は確認し、続けるなら値を保ち、破棄しても保存を送らない', async () => {
  const input = await edit()
  fireEvent.change(input, { target: { value: 'https://example.test/draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(input.value).toBe('https://example.test/draft')
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: '保存せずに移る' }))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: '受信箱のマニュアルのURL' })).toBeNull())
  expect(mocks.update).not.toHaveBeenCalled()
})

it('初回取得失敗は0件と混ぜず、同じ表を読み直せる', async () => {
  mocks.list.mockRejectedValueOnce(new Error('offline'))
  render(<ManualLinksScreen />)
  await screen.findByText('対応表を読み込めませんでした')
  expect(screen.queryByText('受信箱')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await screen.findByText('受信箱')
  expect(mocks.list).toHaveBeenCalledTimes(2)
})
it('保存を拒否されたら依頼先と編集中URLを残す', async () => {
  mocks.update.mockRejectedValue(new ApiError(403))
  const input = await edit()
  fireEvent.change(input, { target: { value: 'https://example.test/draft' } })
  fireEvent.click(screen.getByRole('button', { name: '決める' }))
  await screen.findByText(/運営に依頼してください/)
  expect(input.value).toBe('https://example.test/draft')
})
it('リンク確認の通信失敗は理由を出し、操作を再試行できる状態に戻す', async () => {
  mocks.check.mockRejectedValue(new Error('offline'))
  render(<ManualLinksScreen />)
  await screen.findByText('受信箱')
  const button = screen.getByRole('button', { name: /確かめる/ })
  fireEvent.click(button)
  await screen.findByText(/確かめられませんでした/)
  expect((button as HTMLButtonElement).disabled).toBe(false)
})

it.each(['readOnly', 'view_only'])('閲覧のみの運営担当は表を読めるが変更ボタンは理由付きで止まる: %s', async mode => {
  mocks.readOnly = mode === 'readOnly'
  mocks.roleBundle = mode === 'view_only' ? 'view_only' : undefined
  render(<ManualLinksScreen />)
  await screen.findByText('受信箱')
  expect(screen.getByText(/閲覧のみで見ています/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '受信箱のその他操作' }))
  const item = screen.getByRole('menuitem', { name: '行き先を編集する' })
  expect(item.getAttribute('aria-disabled')).toBe('true')
  expect((item as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(item)
  expect(screen.queryByRole('textbox', { name: '受信箱のマニュアルのURL' })).toBeNull()
  const check = screen.getByRole('button', { name: /確かめる/ })
  expect(check.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(check)
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.check).not.toHaveBeenCalled()
})
it('読み込み中は待つ表示、0件は条件の外し方を出さず、絞り込みで0件なら「条件を外す」で戻せる', async () => {
  let release: (value: unknown) => void = () => {}
  mocks.list.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
  const view = render(<ManualLinksScreen />)
  await waitFor(() => expect(view.container.querySelector('[data-list-state="loading"]')).not.toBeNull())
  release({ success: true, data: { items: [], total: 0 } })
  await screen.findByText('条件に合うものはありません')
  expect(screen.queryByRole('button', { name: '条件を外す' })).toBeNull()
  cleanup()
  render(<ManualLinksScreen />)
  await screen.findByText('受信箱')
  // 行の描画だけでなく、検索欄の初期値を同期する effect まで終えてから入力する。
  await act(() => new Promise<void>(resolve => setImmediate(resolve)))
  const search = screen.getByPlaceholderText('画面の番号・画面名で探す') as HTMLInputElement
  fireEvent.change(search, { target: { value: '存在しない画面' } })
  expect(search.value).toBe('存在しない画面')
  await screen.findByText('条件に合うものはありません')
  fireEvent.click(screen.getByRole('button', { name: '条件を外す' }))
  await screen.findByText('受信箱')
})


const impersonate = (mode: 'read' | 'write') => rememberSessionSnapshot({
  impersonation: { id: 'proxy', tenantId: 'tenant', mode, piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none',
})

it('閲覧代理のownerは表と絞り込みを使え、確認POST/編集/保存は起動しない', async () => {
  impersonate('read')
  const view = render(<ManualLinksScreen />)
  await screen.findByText('受信箱')
  const band = view.container.querySelector('[data-read-only-notice]')!
  expect(view.container.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
  const title = screen.getByRole('heading', { name: 'マニュアルの対応表' })
  const search = screen.getByPlaceholderText('画面の番号・画面名で探す')
  expect(title.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(band.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const check = screen.getByRole('button', { name: /確かめる/ })
  expect(check.getAttribute('aria-disabled')).toBe('true')
  expect((check as HTMLButtonElement).disabled).toBe(false)
  fireEvent.pointerEnter(check, { pointerType: 'mouse' })
  expect(screen.getByRole('tooltip').textContent).toMatch(/代理ログイン/)
  fireEvent.click(check)
  fireEvent.pointerLeave(check, { pointerType: 'mouse' })
  fireEvent.click(screen.getByRole('button', { name: '受信箱のその他操作' }))
  const editItem = screen.getByRole('menuitem', { name: '行き先を編集する' })
  expect(editItem.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(editItem)
  expect(screen.queryByRole('textbox', { name: '受信箱のマニュアルのURL' })).toBeNull()
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: /^開けない/ }))
  await screen.findByText('条件に合うものはありません')
  fireEvent.click(screen.getByRole('button', { name: '条件を外す' }))
  await screen.findByText('受信箱')
  expect(mocks.list).toHaveBeenCalledTimes(1)
  expect(mocks.check).not.toHaveBeenCalled()
  expect(mocks.update).not.toHaveBeenCalled()
})

it('編集中に閲覧代理へ切替えたら保存0、書込代理に戻すと同じ下書きを保存1回', async () => {
  const input = await edit()
  fireEvent.change(input, { target: { value: 'https://example.test/draft' } })
  const oldSave = screen.getByRole('button', { name: '決める' })
  await act(async () => { impersonate('read') })
  expect(screen.queryByRole('textbox', { name: '受信箱のマニュアルのURL' })).toBeNull()
  expect(screen.queryByRole('button', { name: '決める' })).toBeNull()
  fireEvent.click(oldSave)
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.check).not.toHaveBeenCalled()
  await act(async () => { impersonate('write') })
  expect((screen.getByRole('textbox', { name: '受信箱のマニュアルのURL' }) as HTMLInputElement).value).toBe('https://example.test/draft')
  fireEvent.click(screen.getByRole('button', { name: '決める' }))
  await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))
  expect(mocks.update).toHaveBeenCalledWith('2-1', { url: 'https://example.test/draft', expectedVersion: 2 })
})

it('本人未確定は帯と権限理由なしで待ち、owner確定後に通常の操作を出す', async () => {
  let resolveMe!: (result: unknown) => void
  mocks.me.mockReturnValueOnce(new Promise(resolve => { resolveMe = resolve }))
  const view = render(<ManualLinksScreen />)
  await waitFor(() => expect(view.container.querySelector('[data-list-state="loading"]')).not.toBeNull())
  expect(view.container.querySelector('[data-read-only-notice]')).toBeNull()
  expect(view.container.querySelector('[data-permission-locked]')).toBeNull()
  expect(screen.queryByText('受信箱')).toBeNull()
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.check).not.toHaveBeenCalled()
  await act(async () => { resolveMe({ success: true, data: { id: 'owner', role: 'owner' } }) })
  await screen.findByText('受信箱')
  expect(screen.getByRole('button', { name: /確かめる/ }).getAttribute('aria-disabled')).toBeNull()
})


it('編集中に保持された保存handler自身も現在の代理snapshotを読み、閲覧中はAPI0を守る', async () => {
  const { result } = renderHook(() => useManualLinks())
  await waitFor(() => expect(result.current.status).toBe('ready'))
  act(() => { result.current.startEdit('2-1') })
  act(() => { result.current.setEditingUrl('https://example.test/retained') })
  const retainedSave = result.current.saveEdit
  const retainedCheck = result.current.checkAll
  await act(async () => { impersonate('read') })
  await act(async () => { await retainedSave(); await retainedCheck() })
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.check).not.toHaveBeenCalled()
  await act(async () => { impersonate('write') })
  await act(async () => { await retainedSave() })
  expect(mocks.update).toHaveBeenCalledTimes(1)
  expect(mocks.update).toHaveBeenCalledWith('2-1', { url: 'https://example.test/retained', expectedVersion: 2 })
})

// 114: 開けない行は白のまま（行の赤地なし）。赤は札だけ。件数の札は表の上、表の下に赤い文は出さない。
it('開けない行は白のまま札だけ赤で、件数の札は表の上', async () => {
  mocks.list.mockResolvedValue({ success: true, data: { items: [link, { ...link, key: '2-2', name: '壊れた画面', status: 'broken' }], total: 2 } })
  const view = render(<ManualLinksScreen />)
  await screen.findByText('壊れた画面')
  // 行に壊れ印（赤地）は付けない。
  expect(view.container.querySelectorAll('[data-broken]').length).toBe(0)
  // 行の状態の札は赤のまま。
  expect(screen.getByText('開けません')).toBeTruthy()
  // 件数の札は表より前（上）にある。
  const summary = screen.getByText('開けないリンクが 1 件')
  const table = view.container.querySelector('[role="table"], table, [role="grid"]')
  expect(table).not.toBeNull()
  expect(Boolean(summary.compareDocumentPosition(table!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  // 表の下に赤い文は出さない（添え文は札の横の1か所だけ）。
  expect(view.container.textContent?.match(/押しても何も出ません/g)?.length).toBe(1)
})

it.each(['constructor', 'toString', '__proto__', 'future'])('知らないマニュアルの状態 %s は確認できないと表示する', async status => {
  mocks.list.mockResolvedValue({ success: true, data: { items: [{ ...link, status }], total: 1 } })
  render(<ManualLinksScreen />)
  expect(await screen.findByText('状態を確認できません')).toBeTruthy()
})
