// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AssetTemplatesList from './asset-list'
function TestAssetList(props: Omit<React.ComponentProps<typeof AssetTemplatesList>, 'query' | 'setQuery'>) {
  const [query, setQuery] = React.useState('')
  return <AssetTemplatesList {...props} query={query} setQuery={setQuery} />
}
const fixture = vi.hoisted(() => ({ folders: vi.fn(), create: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/lib/api', () => ({ api: { broadcastMessageAssets: { folders: { list: fixture.folders, create: fixture.create } } } }))
vi.mock('@/components/broadcasts/broadcast-asset-manager', () => ({ default: ({ renderLayout }: { renderLayout: (state: unknown) => React.ReactNode }) => renderLayout({
  items: [{ id: 'published', name: '公開のクーポン', payload: {}, status: 'published', updatedAt: '2026-10-30', folderId: null },
    { id: 'draft', name: '下書きのクーポン', payload: {}, status: 'draft', updatedAt: '2026-10-30', folderId: null }],
  loadState: 'ready', reload: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), editor: null, deleteDialog: null,
}) }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
it.each(['card_message', 'rich_message', 'coupon', 'research'] as const)('%s では外から渡された検索語で行を絞り、更新にも追従する', async (kind) => {
  fixture.folders.mockResolvedValue({ success: true, data: [] })
  const renderList = (query: string) => <AssetTemplatesList kind={kind} accountId="a" tabs={null} canMutate={false} onChanged={vi.fn()} query={query} setQuery={vi.fn()} />
  const view = render(renderList('公開'))
  await waitFor(() => expect(screen.getByText('公開のクーポン')).toBeTruthy())
  expect(screen.queryByText('下書きのクーポン')).toBeNull()
  view.rerender(renderList('下書き'))
  expect(screen.queryByText('公開のクーポン')).toBeNull()
  expect(screen.getByText('下書きのクーポン')).toBeTruthy()
})
it('公開状態の切り替えで行と件数を絞り、矢印で下書きへ移り、解除すると両方へ戻る', async () => {
  fixture.folders.mockResolvedValue({ success: true, data: [] })
  render(<TestAssetList kind="coupon" accountId="a" tabs={null} canMutate={false} lockedReason="閲覧のみです" onChanged={vi.fn()} />)
  await waitFor(() => expect(fixture.folders).toHaveBeenCalled())
  const group = screen.getByRole('group', { name: '公開の状態' })
  const published = within(group).getByRole('button', { name: '公開中' })
  fireEvent.click(published)
  expect(screen.getByText('公開のクーポン')).toBeTruthy()
  expect(screen.queryByText('下書きのクーポン')).toBeNull()
  fireEvent.keyDown(published, { key: 'ArrowRight' })
  expect(screen.queryByText('公開のクーポン')).toBeNull()
  expect(screen.getByText('下書きのクーポン')).toBeTruthy()
  expect(within(group).getByRole('button', { name: '下書き' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(within(group).getByRole('button', { name: 'すべて' }))
  expect(screen.getByText('公開のクーポン')).toBeTruthy()
  expect(screen.getByText('下書きのクーポン')).toBeTruthy()
})

it('追加するフォルダ名を画面移動から守り、続行で保持する', async () => {
  fixture.folders.mockResolvedValue({ success: true, data: [] })
  render(<TestAssetList kind="coupon" accountId="a" tabs={null} canMutate onChanged={vi.fn()} />)
  await waitFor(() => expect(fixture.folders).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加する' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '未保存のフォルダ' } })
  const a = document.createElement('a'); a.href = '/templates'; document.body.appendChild(a)
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
  act(() => { a.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  fireEvent.click(within(screen.getByRole('dialog', { name: '保存していない変更があります' })).getByRole('button', { name: '編集を続ける' }))
  expect(screen.getByRole('textbox', { name: 'フォルダ名' })).toHaveProperty('value', '未保存のフォルダ')
  a.remove()
})

it('追加するフォルダ名を戻る操作から守る', async () => {
  fixture.folders.mockResolvedValue({ success: true, data: [] })
  render(<TestAssetList kind="coupon" accountId="a" tabs={null} canMutate onChanged={vi.fn()} />)
  await waitFor(() => expect(fixture.folders).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加する' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '未保存のフォルダ' } })
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {})
  fireEvent.popState(window)
  expect(go).toHaveBeenCalledExactlyOnceWith(1)
})

it('フォルダ名を明示破棄して閉じたら開き直しは空から始める', async () => {
  fixture.folders.mockResolvedValue({ success: true, data: [] })
  render(<TestAssetList kind="coupon" accountId="a" tabs={null} canMutate onChanged={vi.fn()} />)
  await waitFor(() => expect(fixture.folders).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加する' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '破棄するフォルダ' } })
  fireEvent.click(within(screen.getByRole('dialog', { name: 'フォルダを追加する' })).getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '入力を破棄しますか？' })).getByRole('button', { name: '破棄する' }))
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加する' }))
  expect(screen.getByRole('textbox', { name: 'フォルダ名' })).toHaveProperty('value', '')
})

it('フォルダを保存した後は離脱確認を残さない', async () => {
  fixture.folders.mockResolvedValue({ success: true, data: [] })
  fixture.create.mockResolvedValue({ success: true, data: { id: 'folder-1', name: '保存した名前' } })
  render(<TestAssetList kind="coupon" accountId="a" tabs={null} canMutate onChanged={vi.fn()} />)
  await waitFor(() => expect(fixture.folders).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加する' }))
  const dialog = screen.getByRole('dialog', { name: 'フォルダを追加する' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'フォルダ名' }), { target: { value: '保存した名前' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '追加する' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'フォルダを追加する' })).toBeNull())
  expect(fixture.create).toHaveBeenCalledWith('a', '保存した名前')
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(false)
})
