import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
// @vitest-environment-options { "url": "http://localhost/rich-menus/edit/" }
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RichMenuCreateV8 from '@/v8/rich-menus/new/create'
import RichMenuDetailV8 from './detail'

const net = vi.hoisted(() => ({ role: 'owner', get: vi.fn(), update: vi.fn(), unpublish: vi.fn(), deleteImpact: vi.fn(), push: vi.fn(), reconcile: vi.fn(), runs: vi.fn(), retry: vi.fn() }))
const account = { id: 'account-1', name: '店A' }
const group = {
  id: 'g1', accountId: 'account-1', name: 'メニュー', chatBarText: 'メニュー',
  size: 'large', defaultPageId: 'p1', isDefaultForAll: false, status: 'published',
  targetingCondition: JSON.stringify({ operator: 'AND', rules: [{ type: 'private_memo', value: '保存済み' }] }), targetingPriority: 2, targetingEnabled: true,
  folderId: null, defaultOpen: true, version: 1, publicationGeneration: 3, confirmationRevision: 4,
  pages: [{ id: 'p1', orderIndex: 0, name: '1枚目', aliasId: '', lineRichmenuId: null, imageR2Key: 'img', imageContentType: 'image/jpeg', areas: [] }],
}
vi.mock('next/navigation', async () => {
  const base = (await import('@/test-utils/navigation-mock')).navigationMock()
  const router = { push: net.push, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }
  return { ...base, useRouter: () => router }
})
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccount: account, selectedAccountId: account.id, accounts: [account], loading: false }),
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
      get: net.get, update: net.update, unpublish: net.unpublish, deleteImpact: net.deleteImpact,
      list: async () => ({ success: true, data: [] }),
      previewTargets: async () => ({ success: true, data: null }),
      audienceSummary: async () => ({ success: true, data: null }),
      publishProgress: async () => ({ success: true, data: { steps: [], run: null, message: null } }),
      publishRuns: net.runs, retryPublishRun: net.retry,
      tapStats: async () => ({ success: true, data: { byGroup: [] } }),
      reconcile: net.reconcile,
    },
  } }
})
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  net.role = 'owner'; net.push.mockReset()
  net.get.mockReset().mockResolvedValue({ success: true, data: group })
  net.update.mockReset().mockImplementation(async (_id, input) => ({ success: true, data: { ...group, ...input } }))
  net.unpublish.mockReset().mockResolvedValue({ success: true, data: { warnings: [] } })
  net.runs.mockReset().mockResolvedValue({ success: true, data: { runs: [] } })
  net.retry.mockReset().mockResolvedValue({ success: true, data: {} })
  net.deleteImpact.mockReset().mockResolvedValue({ success: true, data: { group: { id: 'g1', accountId: 'account-1', status: 'published', version: 1, publishingGeneration: 0 }, lineResources: { isDefaultForAll: false, pages: [{ id: 'p1', orderIndex: 0, lineRichMenuId: null }] } } })
  net.reconcile.mockReset().mockResolvedValue({ success: true, data: { dryRun: true, diffs: [] } })
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/rich-menus/edit?id=g1&step=audience')
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => { root.unmount() }); container.remove(); delete document.documentElement.dataset.theme })
async function openPriority() {
  await act(async () => { root.render(<RichMenuCreateV8 editGroupId="g1" />) })
  fireEvent.click(await screen.findByRole('button', { name: '順番を変える' }))
  return screen.getByRole('dialog', { name: '出す順番' })
}
async function openUnpublish() {
  await act(async () => { root.render(<RichMenuDetailV8 groupId="g1" />) })
  fireEvent.click(await screen.findByRole('button', { name: 'そのほかの操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'LINEから取り下げる' }))
  const dialog = await screen.findByRole('alertdialog', { name: '「メニュー」をLINEから取り下げますか？' })
  await waitFor(() => expect(net.deleteImpact).toHaveBeenCalled())
  return dialog
}

describe('現役V8へ残す旧編集の動き', () => {
  it('照合と読み直しの印を出し、読み直しでは確認だけを呼ぶ', async () => {
    await act(async () => { root.render(<RichMenuDetailV8 groupId="g1" />) })
    const retry = await screen.findByRole('button', { name: 'もう一度照らし合わせる' })
    await waitFor(() => expect(net.reconcile).toHaveBeenCalledTimes(1))
    expect(container.querySelector('.lucide-shield-check')).toBeTruthy()
    expect(retry.querySelector('.lucide-refresh-cw')).toBeTruthy()
    fireEvent.click(retry)
    await waitFor(() => expect(net.reconcile).toHaveBeenCalledTimes(2))
    expect(net.reconcile).toHaveBeenLastCalledWith('g1', true)
    expect(net.unpublish).not.toHaveBeenCalled()
  })
  it.each(['wizard', 'detail'] as const)('%sは取得の403を権限の案内にし、保存は出さず一覧へ戻れる', async page => {
    const { ApiError } = await import('@/lib/api')
    net.get.mockRejectedValue(new ApiError(403, 'API error: 403'))
    await act(async () => { root.render(page === 'wizard' ? <RichMenuCreateV8 editGroupId="g1" /> : <RichMenuDetailV8 groupId="g1" />) })
    expect(await screen.findByText('この操作の権限がありません。オーナーか管理者に頼んでください。')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'リッチメニュー一覧へ戻る' }).getAttribute('href')).toBe('/rich-menus')
    expect(screen.queryByRole('button', { name: /下書きを保存/ })).toBeNull()
    expect(container.textContent).not.toContain('API error: 403')
    expect(net.update).not.toHaveBeenCalled()
  })
  it('出す順番は1番始まりで案内し、変えた順番を0番始まりで保存する', async () => {
    const dialog = await openPriority()
    const input = within(dialog).getByRole('textbox', { name: '出す順番' }) as HTMLInputElement
    expect(input.value).toBe('3')
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '順番を変える' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '出す順番' })).toBeNull())
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(net.update).toHaveBeenCalledWith('g1', expect.objectContaining({ targetingPriority: 0 })))
  })
  it('順番の窓を取り消すと元の値を保つ', async () => {
    const dialog = await openPriority()
    fireEvent.change(within(dialog).getByRole('textbox', { name: '出す順番' }), { target: { value: '1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    const discard = await screen.findByRole('dialog', { name: '入力を破棄しますか？' })
    fireEvent.click(within(discard).getByRole('button', { name: '破棄する' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '出す順番' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '順番を変える' }))
    expect((screen.getByRole('textbox', { name: '出す順番' }) as HTMLInputElement).value).toBe('3')
    expect(net.update).not.toHaveBeenCalled()
  })
  it('閲覧のみでは順番を変える口を出さない', async () => {
    net.role = 'viewer'
    await act(async () => { root.render(<RichMenuCreateV8 editGroupId="g1" />) })
    await screen.findByRole('heading', { name: '出す順番' })
    expect(screen.queryByRole('button', { name: '順番を変える' })).toBeNull()
  })
  it.each([{ pages: [] }, { id: 'g1', name: 'メニュー', pages: undefined }])('形の違う取得結果（%j）で編集画面を落とさない', async data => {
    net.get.mockResolvedValue({ success: true, data })
    await act(async () => { root.render(<RichMenuCreateV8 editGroupId="g1" />) })
    expect(await screen.findByText('このリッチメニューは見つかりません')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '下書きを保存' })).toBeNull()
    expect(net.update).not.toHaveBeenCalled()
  })
  it('取り下げの部分失敗を種類ごとに日本語で知らせ、内部IDを出さず再試行できる', async () => {
    net.unpublish.mockResolvedValueOnce({ success: true, data: { warnings: ['delete alias secret-1: down', 'delete alias secret-2: down', 'delete richmenu private-3', 'default lookup/clear: down', 'unknown detail'] } })
    const dialog = await openUnpublish()
    expect(dialog.textContent).toContain('LINEアカウント'); expect(dialog.textContent).toContain('環境')
    fireEvent.click(within(dialog).getByRole('button', { name: 'LINEから取り下げる' }))
    await within(dialog).findByText(/切り替え設定の一部を取り下げきれていません/)
    const text = dialog.textContent ?? ''
    expect(text.match(/切り替え設定の一部を取り下げきれていません/g)).toHaveLength(1)
    expect(text).toContain('メニュー本体の一部を取り下げきれていません')
    expect(text).toContain('標準表示の解除を確認できませんでした')
    expect(text).not.toMatch(/secret-|private-|delete alias|unknown detail/)
    expect(net.push).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'LINEから取り下げる' }))
    await waitFor(() => expect(net.push).toHaveBeenCalledWith('/rich-menus'))
    expect(net.unpublish).toHaveBeenCalledTimes(2)
  })
  it('取り下げが409なら最新の版を読み直す', async () => {
    const { ApiError } = await import('@/lib/api')
    const dialog = await openUnpublish()
    net.get.mockResolvedValueOnce({ success: true, data: { ...group, publicationGeneration: 8, confirmationRevision: 9 } })
    net.unpublish.mockRejectedValueOnce(new ApiError(409, 'changed'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'LINEから取り下げる' }))
    await waitFor(() => expect(net.get).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(net.unpublish).toHaveBeenCalledTimes(1)
  })
  it('取り下げが完全に成功したら一覧へ戻る', async () => {
    const dialog = await openUnpublish()
    expect(net.unpublish).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'LINEから取り下げる' }))
    await waitFor(() => expect(net.push).toHaveBeenCalledWith('/rich-menus'))
    expect(net.unpublish).toHaveBeenCalledExactlyOnceWith('g1', { expectedVersion: 1, expectedPublishGeneration: 0, expectedIsDefaultForAll: false, expectedPages: [{ id: 'p1', orderIndex: 0, lineRichMenuId: null }] })
  })
  it('取り下げの409は窓を閉じ、最新の内容を読み直す', async () => {
    const { ApiError } = await import('@/lib/api')
    net.unpublish.mockRejectedValueOnce(new ApiError(409, 'changed', 'RICH_MENU_CONFIRMATION_CHANGED'))
    const dialog = await openUnpublish()
    await waitFor(() => expect(within(dialog).getByRole('button', {name: 'LINEから取り下げる'})).not.toHaveProperty('disabled', true))
    fireEvent.click(within(dialog).getByRole('button', { name: 'LINEから取り下げる' }))
    await screen.findByText('公開内容が変わりました。最新の状態を確認してください。')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(net.get).toHaveBeenCalledTimes(2)
    expect(net.push).not.toHaveBeenCalled()
  })
  it('詳細の表示より新しい版の影響が返ったら取り下げない', async () => {
    net.deleteImpact.mockResolvedValueOnce({ success: true, data: { group: { id: 'g1', accountId: 'account-1', status: 'published', version: 2, publishingGeneration: 0 }, lineResources: { isDefaultForAll: false, pages: [] } } })
    await openUnpublish()
    await screen.findByText('公開内容が変わりました。最新の状態を確認してください。')
    await waitFor(() => expect(net.get).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(net.unpublish).not.toHaveBeenCalled()
  })
  it('取り下げ失敗は確認を残して再試行できる', async () => {
    net.unpublish.mockRejectedValueOnce(new Error('down'))
    const dialog = await openUnpublish()
    fireEvent.click(within(dialog).getByRole('button', { name: 'LINEから取り下げる' }))
    await within(dialog).findByText('リッチメニューをLINEから取り下げられませんでした。状態を確認して、もう一度お試しください。')
    expect(net.push).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'LINEから取り下げる' }))
    await waitFor(() => expect(net.push).toHaveBeenCalledWith('/rich-menus'))
  })
})

it('閉じた取り下げ確認の古い確定からLINEへ操作しない', async () => {
  const dialog = await openUnpublish()
  const button = within(dialog).getByRole('button', { name: 'LINEから取り下げる' })
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  await act(async () => { await oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(net.unpublish).not.toHaveBeenCalled()
})

it('閉じた公開再試行の古い確定からLINEへ操作しない', async () => {
  net.runs.mockResolvedValue({ success: true, data: { runs: [{ id:'run-1', status:'failed', lastErrorCode:'line_unavailable', createdAt:'2026-10-01T00:00:00Z', updatedAt:'2026-10-01T01:00:00Z', version:{ name:'公開した版',chatBarText:'メニュー',pageCount:2,isDefaultForAll:true,targetingEnabled:false }, pages:[] }] } })
  await act(async () => { root.render(<RichMenuDetailV8 groupId="g1" />) })
  fireEvent.click(await screen.findByRole('button', { name: '失敗だけやり直す' }))
  const dialog = await screen.findByRole('dialog', { name: '失敗した公開をやり直しますか？' })
  const button = within(dialog).getByRole('button', { name: 'やり直す' })
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  await act(async () => { await oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(net.retry).not.toHaveBeenCalled()
})
