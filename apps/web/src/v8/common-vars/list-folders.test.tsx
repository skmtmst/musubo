// @vitest-environment happy-dom
import { expectLockedFolderMenu } from '@/test-utils/permission-locked-control'
/*
 * V8 共通情報の一覧（src/v8/common-vars/list.tsx）のフォルダ操作と、絞り込み0件の動き（R37・R38）。
 * 左のフォルダの列の「…」と、畳んだ欄（狭い幅）の「フォルダの操作」から名前変更・削除へ届くこと、
 * 閲覧のみには口を出さないこと、絞り込みの0件に「条件を外す」を置くことを、画面を描いて押して確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const listVars = vi.hoisted(() => vi.fn())
const listFolders = vi.hoisted(() => vi.fn())
const removeFolder = vi.hoisted(() => vi.fn())
const listExports = vi.hoisted(() => vi.fn())
const staffRole = vi.hoisted(() => ({ value: 'owner' as string }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      commonVars: { ...actual.api.commonVars, list: listVars, listExports },
      folders: { ...actual.api.folders, list: listFolders, delete: removeFolder },
    },
  }
})
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
  useOptionalAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => staffRole.value }
})

import CommonVarsListV8 from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = {
  lineAccountId: 'account-a', type: 'text', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  nextSchedule: null, pendingScheduleCount: 0, validFrom: null, validUntil: null,
}
const company = { ...base, id: 'v-company', folderId: 'f-shop', name: '会社名', varKey: 'company_name', value: '株式会社NEN', usageCount: 15 }
const hours = { ...base, id: 'v-hours', folderId: null, name: '営業時間', varKey: 'hours', value: '10時から', usageCount: 3 }
const SHOP = { id: 'f-shop', kind: 'common_var', accountId: 'account-a', name: '店舗案内', parentId: null, displayOrder: 0, color: '#2f6fde', itemCount: 1, revision: 1 }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/contents/vars')
  staffRole.value = 'owner'
  listVars.mockReset()
  listVars.mockImplementation(async () => ({ success: true, data: [company, hours] }))
  listFolders.mockReset()
  listFolders.mockImplementation(async () => ({ success: true, data: [SHOP], unfiledCount: 1 }))
  removeFolder.mockReset()
  removeFolder.mockResolvedValue({ success: true, data: null })
  listExports.mockResolvedValue({ success: true, data: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.documentElement.removeAttribute('data-theme')
})

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const render = async () => {
  await act(async () => root.render(<CommonVarsListV8 />))
  await settle()
}
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('押す相手がありません')
  await act(async () => { (element as HTMLElement).click() })
  await settle()
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text)
const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) => row.textContent?.trim() === text)
const sidePanel = () => host.querySelector('[data-template-region="folders"]')
const toolbarRegion = () => host.querySelector('[data-template-region="toolbar"]')
/** フォルダの選択は URL の `?folder=` に出る。選んだ状態で開く。 */
const renderInShop = async () => {
  window.history.replaceState(null, '', '/contents/vars?folder=f-shop')
  await render()
}

describe('R37 共通情報のフォルダの名前変更・削除', () => {
  it('左の列の「…」から消すと、中身は未分類に残ると確かめてから選択中のアカウントで消し、読み直す', async () => {
    await render()
    await click(sidePanel()?.querySelector('button[aria-label="フォルダ「店舗案内」の操作"]'))
    expect(menuItem('名前を変える')).toBeDefined()
    await click(menuItem('消す'))
    expect(document.body.textContent).toContain('中の共通情報 1 件は消えずに「未分類」へ移ります')
    expect(removeFolder).not.toHaveBeenCalled()
    const readsBefore = listVars.mock.calls.length
    await click(button('削除する'))
    expect(removeFolder.mock.calls.map((call) => call.slice(0, 3))).toEqual([['f-shop', 'account-a', 1]])
    expect(listVars.mock.calls.length).toBeGreaterThan(readsBefore)
  })

  it('左の列の「…」の名前変更は、同じフォルダを入れた名前の窓を開く', async () => {
    await render()
    await click(sidePanel()?.querySelector('button[aria-label="フォルダ「店舗案内」の操作"]'))
    await click(menuItem('名前を変える'))
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')
    expect(input?.value).toBe('店舗案内')
  })

  it('畳んだ欄でも、選んでいるフォルダの「フォルダの操作」から名前変更・削除に届く', async () => {
    await renderInShop()
    const collapsed = [...(toolbarRegion()?.querySelectorAll<HTMLButtonElement>('button[aria-label="フォルダ「店舗案内」の操作"]') ?? [])]
    expect(collapsed).toHaveLength(1)
    await click(collapsed[0])
    expect(menuItem('フォルダ名を変える')).toBeDefined()
    await click(menuItem('フォルダを削除する'))
    expect(document.body.textContent).toContain('「店舗案内」を削除しますか？')
    await click(button('削除する'))
    expect(removeFolder.mock.calls.map((call) => call.slice(0, 3))).toEqual([['f-shop', 'account-a', 1]])

    await renderInShop()
    await click(toolbarRegion()?.querySelector('button[aria-label="フォルダ「店舗案内」の操作"]'))
    await click(menuItem('フォルダ名を変える'))
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"], [role="dialog"] input:not([type])')?.value).toBe('店舗案内')
  })

  it('閲覧のみでもフォルダの操作を出し、変更を理由付きで拒否する', async () => {
    staffRole.value = 'staff'
    await renderInShop()
    await expectLockedFolderMenu(host.querySelector('button[aria-label="フォルダ「店舗案内」の操作"]'))
    expect(host.textContent).toContain('店舗案内')
  })
})

describe('R38 共通情報の絞り込み0件', () => {
  it('札で絞って0件なら作る口を出さず「条件を外す」を置き、押すと全件へ戻す', async () => {
    await render()
    expect(host.textContent).toContain('営業時間')
    await click(button('使われていない'))
    expect(host.textContent).toContain('条件に合うものがありません')
    expect(host.textContent).not.toContain('営業時間')
    await click(button('条件を外す'))
    expect(host.textContent).toContain('営業時間')
    expect(host.textContent).toContain('会社名')
  })

  it('1件も無いときは「条件を外す」を出さない', async () => {
    listVars.mockImplementation(async () => ({ success: true, data: [] }))
    await render()
    expect(button('条件を外す')).toBeUndefined()
    expect(host.textContent).not.toContain('条件に合うものがありません')
  })
})
