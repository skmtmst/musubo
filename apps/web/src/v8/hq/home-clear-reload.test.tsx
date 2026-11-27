// @vitest-environment happy-dom
/*
 * 監査 WEB214/215：統括のアカウント一覧。
 * - 214：「条件を外す」はフォルダの選択も外す（フォルダだけ残って空のまま、にしない）
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  const account = {
    id: 'acc-1', revision: 1, channelId: '2000000001', name: '銀座店', displayName: '銀座店', basicId: '@ginza', isActive: true,
    country: null, role: null, displayOrder: 0, archivedAt: null, tags: [], folderId: null,
    stats: { friendCount: 3, activeScenarios: 0, messagesThisMonth: 0, staffCount: 1 }, connection: { status: 'ok', checkedAt: null, tokenExpired: false, issues: [] },
  }
  return {
    ...actual,
    api: {
      ...actual.api,
      lineAccounts: { ...actual.api.lineAccounts, list: vi.fn(async () => ({ success: true, data: [account] })) },
      lineAccountFolders: {
        ...actual.api.lineAccountFolders,
        update: vi.fn(async () => ({ success: true, data: { id: 'f1' } })),
        create: vi.fn(async () => ({ success: true, data: { id: 'f2' } })),
        list: vi.fn(async () => ({ success: true, data: { folders: [{ id: 'f1', kind: 'line_account', name: '関西', parentId: null, color: null, displayOrder: 1, accountCount: 0, createdAt: '', updatedAt: '' }], total: 1, unclassifiedCount: 1 } })),
      },
      tenants: { ...actual.api.tenants, me: vi.fn(async () => ({ success: true, data: { name: '本部' } })) },
    },
  }
})
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/hq/platform-notices', () => ({ default: () => null }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useTenantWideAccess: () => true, useStaffRole: () => 'owner' }))
const fx = vi.hoisted(() => ({ refreshAccounts: vi.fn(async () => {}) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], setSelectedAccountId: () => {}, refreshAccounts: fx.refreshAccounts }) }))

import HqHomeV8 from './home'
import { api } from '@/lib/api'
afterEach(cleanup)

test('214：「条件を外す」でフォルダの選択も外れ、全部のアカウントに戻る', async () => {
  render(<HqHomeV8 />)
  await screen.findAllByText('銀座店')
  const folderButton = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('関西')) as HTMLButtonElement
  expect(folderButton).toBeTruthy()
  await act(async () => { folderButton.click() })
  await waitFor(() => expect(screen.queryAllByText('銀座店').length).toBe(0))
  const clear = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('条件を外す')) as HTMLButtonElement
  await act(async () => { clear.click() })
  await waitFor(() => expect(screen.getAllByText('銀座店').length).toBeGreaterThan(0))
})

test('215：保存のあとの読み直しが失敗したら知らせ、読み直せる', async () => {
  fx.refreshAccounts.mockRejectedValueOnce(new Error('down'))
  render(<HqHomeV8 />)
  await screen.findAllByText('銀座店')
  const add = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('フォルダを追加')) as HTMLButtonElement
  await act(async () => { add.click() })
  const input = document.querySelector('#hq-account-folder-name') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '九州')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((b) => /追加|保存/.test(b.textContent ?? '') && !(b.textContent ?? '').includes('フォルダを追加')) as HTMLButtonElement
  await act(async () => { save.click() })
  await waitFor(() => expect(screen.getByText('保存はできましたが、一覧を読み直せませんでした。')).toBeTruthy())
})


test('アカウントのフォルダは名前の横から色を選び、新しいフォルダは緑から始まり、選んだ色はそのまま送る', async () => {
  render(<HqHomeV8 />)
  await screen.findAllByText('銀座店')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
  const input = screen.getByRole('textbox', { name: 'フォルダの名前' })
  const colorButton = screen.getByRole('button', { name: 'フォルダの色：緑' })
  expect(input.closest('[data-folder-name-color]')!.contains(colorButton)).toBe(true)
  fireEvent.change(input, { target: { value: '九州' } })
  fireEvent.click(colorButton)
  fireEvent.click(screen.getByRole('radio', { name: '赤' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '追加する' })) })
  expect(api.lineAccountFolders.create).toHaveBeenCalledWith({ name: '九州', color: '#ef4444' })
  await waitFor(() => expect(document.querySelector('#hq-account-folder-name')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダの名前' }), { target: { value: '沖縄' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '追加する' })) })
  expect(api.lineAccountFolders.create).toHaveBeenCalledWith({ name: '沖縄', color: '#16a34a' })
})


test('フォルダの「色を変える」から既存色を変えて保存し、一覧を読み直す', async () => {
  render(<HqHomeV8 />)
  await screen.findAllByText('銀座店')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ「関西」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '色を変更する' }))
  expect(screen.getByRole('textbox', { name: 'フォルダの名前' }).getAttribute('value')).toBe('関西')
  /* 色の無いフォルダは自動の色から始まる（色なしは選べない・2026-10-09 オーナー） */
  fireEvent.click(screen.getByRole('button', { name: /^フォルダの色：/ }))
  expect(screen.queryByRole('radio', { name: '色なし' })).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: '赤' }))
  vi.mocked(api.lineAccountFolders.list).mockResolvedValue({ success: true, data: { folders: [{ id: 'f1', kind: 'line_account', name: '関西', parentId: null, color: '#ef4444', displayOrder: 1, createdAt: '', updatedAt: '' }], total: 1, unclassifiedCount: 1 } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存する' })) })
  expect(api.lineAccountFolders.update).toHaveBeenCalledWith('f1', { name: '関西', color: '#ef4444' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.querySelector('nav svg.lucide-folder')?.getAttribute('style')).toContain('#ef4444')
})


test('フォルダの数はすべてと同じ非アーカイブの一覧から数える',async()=>{
  const original = await api.lineAccounts.list()
  if(!original.success) throw new Error('fixture')
  const base=original.data[0]
  vi.mocked(api.lineAccounts.list).mockResolvedValueOnce({success:true,data:[
    {...base,id:'one',folderId:'f1'}, {...base,id:'two',folderId:null}, {...base,id:'archived',folderId:'f1',archivedAt:'2026-10-01'},
  ]})
  vi.mocked(api.lineAccountFolders.list).mockResolvedValueOnce({success:true,data:{folders:[{id:'f1',kind:'line_account',name:'関西',parentId:null,color:null,displayOrder:1,itemCount:99,createdAt:'',updatedAt:''}],total:99,unclassifiedCount:98}})
  render(<HqHomeV8/>)
  await screen.findAllByText('銀座店')
  const rail=screen.getByRole('complementary',{name:'フォルダ'})
  const rows=[...rail.querySelectorAll('[data-part="folder-row"]')].map(el=>el.textContent?.replace(/\s/g,''))
  expect(rows).toEqual(expect.arrayContaining(['すべて2','関西1','未分類1']))
  fireEvent.click(screen.getByRole('button',{name:'フォルダの説明'}))
  expect((document.body.textContent?.match(/フォルダを消しても/g) ?? [])).toHaveLength(1)
})

test('同名フォルダを拒否したら名前欄に理由を出し、直すと消える', async () => {
  const { ApiError } = await import('@/lib/api')
  vi.mocked(api.lineAccountFolders.create).mockRejectedValueOnce(new ApiError(409, '同じ名前のフォルダがあります'))
  render(<HqHomeV8 />)
  await screen.findAllByText('銀座店')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダを追加' }))
  const input = screen.getByRole('textbox', { name: 'フォルダの名前' })
  fireEvent.change(input, { target: { value: '関西' } })
  fireEvent.click(screen.getByRole('button', { name: '追加する' }))
  await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'))
  expect(screen.getByText('同じ名前のフォルダがあります')).toBeTruthy()
  fireEvent.change(input, { target: { value: '九州' } })
  expect(screen.queryByText('同じ名前のフォルダがあります')).toBeNull()
})

test('フォルダは名前と色が未変更なら理由を出して保存せず、名前を変えると保存できる', async () => {
  vi.mocked(api.lineAccountFolders.update).mockClear()
  render(<HqHomeV8 />)
  await screen.findAllByText('銀座店')
  fireEvent.click(screen.getByRole('button', { name: 'フォルダ「関西」の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '色を変更する' }))
  const save = screen.getByRole('button', { name: '保存する' }) as HTMLButtonElement
  expect(save.disabled).toBe(true)
  expect(screen.getByText('名前か色を変えると保存できます。')).toBeTruthy()
  fireEvent.click(save)
  expect(api.lineAccountFolders.update).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: 'フォルダの名前' }), { target: { value: '関西エリア' } })
  expect(save.disabled).toBe(false)
  expect(screen.queryByText('名前か色を変えると保存できます。')).toBeNull()
})
