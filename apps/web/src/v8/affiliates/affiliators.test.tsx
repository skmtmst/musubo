import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 成果とアフィリエイト「アフィリエイター」（src/v8）の動きの試験。BEHAVIOR.md の主要な動きを守る。
 * 行が成果の多い順に並ぶ・閲覧のみでは作る／選ぶ／編集を出さない（帯は出す）・行の「…」に変える操作が出る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const folderList = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ manage: true }))
const updateAffiliate = vi.hoisted(() => vi.fn())
const affiliatesList = vi.hoisted(() => vi.fn())
const allReport = vi.hoisted(() => vi.fn())
const settlementPreview = vi.hoisted(() => vi.fn())
const approvalsList = vi.hoisted(() => vi.fn())
const offersList = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      folders: { ...actual.api.folders, list: folderList },
      affiliates: { ...actual.api.affiliates, list: affiliatesList, allReport, settlementPreview, update: updateAffiliate },
      affiliateOffers: { ...actual.api.affiliateOffers, list: offersList },
      conversionApprovals: { ...actual.api.conversionApprovals, list: approvalsList },
      accountSettings: { ...actual.api.accountSettings, getLinkBaseUrl: async () => ({ success: true, data: null }) },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => (role.manage ? 'owner' : 'staff'), canManageRole: () => role.manage }
})

import { flushListUrlState } from '@/components/shared/list-url-state'
import AffiliatesV8 from './affiliates'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

const affiliates = [
  { id: 'af-1', name: '少ない人', code: 'few', commissionRate: 0, isActive: true, createdAt: '2026-09-01T00:00:00Z', friendId: null },
  { id: 'af-2', name: '多い人', code: 'many', commissionRate: 10, isActive: true, createdAt: '2026-08-01T00:00:00Z', friendId: null },
]
const report = [
  { affiliateId: 'af-1', totalClicks: 1, totalConversions: 2, totalRevenue: 0, confirmedReward: 3000, linkCount: 1, friendAdds: 4 },
  { affiliateId: 'af-2', totalClicks: 1, totalConversions: 9, totalRevenue: 100000, confirmedReward: 0, linkCount: 2, friendAdds: 8 },
]

async function render() {
  await act(async () => { root.render(React.createElement(AffiliatesV8)) })
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(() => {
  flushListUrlState()
  window.history.replaceState(null,'','/affiliates')
  updateAffiliate.mockReset().mockResolvedValue({ success: true })
  folderList.mockResolvedValue({success:true,data:[{id:'f1',name:'紹介の仲間',color:'#228b22',kind:'affiliate',accountId:'account-a',displayOrder:0}]})
  role.manage = true
  verifiedStaffRole('owner')
  affiliatesList.mockResolvedValue({ success: true, data: affiliates })
  allReport.mockResolvedValue({ success: true, data: report })
  settlementPreview.mockResolvedValue({ success: true, data: { totalAmount: 13000, conversionCount: 11, affiliates: [], periodFrom: '', periodTo: '' } })
  approvalsList.mockResolvedValue({ success: true, data: [] })
  offersList.mockResolvedValue({ success: true, data: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('V8 アフィリエイター', () => {
  it('成果が多い順に並べ、作るボタンと選ぶチェックを出す', async () => {
    await render()
    const names = [...host.querySelectorAll('tbody tr')].map((row) => row.querySelector('a[data-row-link]')?.textContent)
    expect(names).toEqual(['多い人', '少ない人'])
    expect(host.textContent).toContain('アフィリエイターを作る')
    expect(host.querySelector('[aria-label="アフィリエイターを作る"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="多い人を選ぶ"]')).not.toBeNull()
    expect(host.textContent).not.toContain('閲覧のみで見ています')
  })

  it('閲覧のみは選ぶ枠と作る・一括操作・行の変更操作を出さず、見る操作を残す', async () => {
    role.manage = false
    verifiedStaffRole('staff')
    await render()
    expect(host.textContent).toContain(PERMISSION_LOCK_SUMMARY.feature)
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.textContent?.includes('アフィリエイターを作る'))
    expect(create.length).toBeGreaterThan(0)
    expect(create.every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true)
    await act(async () => { create[0].click() })
    expect(host.querySelector('a[href="/affiliates/new"]')).toBeNull()
    const selection = host.querySelector('[aria-label="多い人を選ぶ"]') as HTMLInputElement
    expect(selection).toBeNull()
    expect(updateAffiliate).not.toHaveBeenCalled()
    const menu = host.querySelector('[aria-label="多い人の操作"]') as HTMLButtonElement
    await act(async () => { fireEvent.click(menu) })
    expect(document.body.textContent).toContain('紹介リンクをコピー')
    expect(document.body.textContent).not.toContain('紹介を止める')
  })
})


it('止めた紹介者は確認後に再開し、失敗した理由を窓に残す', async () => {
  affiliatesList.mockResolvedValue({ success: true, data: [{ ...affiliates[0], isActive: false }] })
  updateAffiliate.mockRejectedValue(new Error('offline'))
  await render()
  fireEvent.click(screen.getByRole('button', { name: /少ない人.*操作/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: '紹介を再開する' }))
  expect(updateAffiliate).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '紹介を再開する', exact: true }))
  await waitFor(() => expect(updateAffiliate).toHaveBeenCalledWith('af-1', { isActive: true }))
  await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('紹介を再開できませんでした'))
})


it('W2: managed folders offer creation, filtering and each row uses its actual folder', async () => {
  affiliatesList.mockResolvedValue({success:true,data:[{...affiliates[0],folderId:'f1'},affiliates[1]]})
  await render()
  expect(folderList).toHaveBeenCalledWith('affiliate','account-a')
  expect(screen.getByRole('button',{name:'フォルダを追加',exact:true})).toBeTruthy()
  expect(host.querySelector('[data-folder-dot="filed"]')?.getAttribute('title')).toBe('フォルダ：紹介の仲間')
  const rail = host.querySelector('[data-template-region="folders"]')!
  fireEvent.click(rail.querySelector('button[title="紹介の仲間"]')!)
  await waitFor(()=>expect(host.querySelectorAll('tbody tr')).toHaveLength(1))
  expect(host.querySelector('tbody')?.textContent).toContain('少ない人')
  fireEvent.click(screen.getByRole('button',{name:'少ない人の操作'}))
  expect(screen.getByRole('menuitem',{name:'フォルダへ移す'})).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem',{name:'フォルダへ移す'}))
  const picker=screen.getByRole('dialog',{name:'移すフォルダを選ぶ'})
  fireEvent.click(within(picker).getByRole('radio',{name:'未分類'}))
  fireEvent.click(within(picker).getByRole('button',{name:'フォルダへ移す',exact:true}))
  await waitFor(()=>expect(updateAffiliate).toHaveBeenCalledWith('af-1',{folderId:null}))
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'移すフォルダを選ぶ'})).toBeNull())
})

it('W2: readonly users retain folder filtering without adding or moving folders', async () => {
  role.manage=false
  verifiedStaffRole('staff')
  await render()
  await expectPermissionLocked(screen.getByRole('button',{name:'フォルダを追加',exact:true}))
  const menu=host.querySelector('[aria-label="多い人の操作"]')!
  fireEvent.click(menu)
  expect(screen.queryByRole('menuitem',{name:'フォルダへ移す'})).toBeNull()
})

describe('V8 アフィリエイター：読み込みの状態と報酬', () => {
  it('読み込み中・読めなかった・まだいないを言い分ける', async () => {
    let release: (value: unknown) => void = () => {}
    affiliatesList.mockReturnValue(new Promise((resolve) => { release = resolve }))
    await render()
    expect(host.querySelector('[data-list-state="loading"][aria-label="アフィリエイターを読み込んでいます"]')).not.toBeNull()
    await act(async () => { release({ success: true, data: [] }) })
    for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(host.textContent).toContain('まだアフィリエイターがいません')
    expect(host.textContent).not.toContain('読み込めませんでした')

    act(() => root.unmount())
    root = createRoot(host)
    allReport.mockRejectedValue(new Error('offline'))
    await render()
    expect(host.textContent).toContain('アフィリエイターを読み込めませんでした')
    expect(host.textContent).not.toContain('まだアフィリエイターがいません')
  })

  it('報酬の列は案件ごとの確定額と売上の割合から出す', async () => {
    await render()
    const reward = (name: string) => {
      const row = [...host.querySelectorAll('tbody tr')].find((tr) => tr.querySelector('a[data-row-link]')?.textContent === name)
      return [...(row?.querySelectorAll('td') ?? [])].map((cell) => cell.textContent)
    }
    expect(reward('少ない人')).toContain('¥3,000')
    expect(reward('多い人')).toContain('¥10,000')
  })
})

afterEach(() => { verifiedStaffRole(null) })
