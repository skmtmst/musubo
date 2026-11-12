// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
// 紹介者の一部停止で、受け付けた分の再送防止と未完了の選択保持を守る。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const folderList = vi.hoisted(() => vi.fn())
const role = vi.hoisted(() => ({ manage: true }))
const accountState = vi.hoisted(() => ({ id: 'account-a' }))
const archiveAffiliate = vi.hoisted(() => vi.fn())
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
      affiliates: { ...actual.api.affiliates, list: affiliatesList, allReport, settlementPreview, update: updateAffiliate, archive: archiveAffiliate },
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
  useAccount: () => ({ selectedAccountId: accountState.id, accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
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
  accountState.id = 'account-a'
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

it('まとめ停止の受け付けた分を行へ反映し、取消後の読み込みでも未完了だけ選択に残る', async () => {
 archiveAffiliate.mockReset().mockImplementation(async (id: string) => { if (id === 'af-2') return { success: true }; throw new Error('通信できませんでした。') })
 await render()
 fireEvent.click(screen.getByRole('checkbox', { name: '多い人を選ぶ' })); fireEvent.click(screen.getByRole('checkbox', { name: '少ない人を選ぶ' }))
 fireEvent.click(screen.getByRole('button', { name: 'まとめて紹介を止める' }))
 const dialog = await screen.findByRole('alertdialog', { name: '2 人の紹介をまとめて止めますか？' })
 await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'まとめて止める' })) })
 expect(within(dialog).getByRole('alert').textContent).toContain('1 人を止めました。1 人は止められませんでした')
 expect(screen.getByRole('checkbox', { name: '多い人を選ぶ' })).toHaveProperty('checked', false)
 expect(screen.getByRole('checkbox', { name: '少ない人を選ぶ' })).toHaveProperty('checked', true)
 expect(screen.getByText('多い人').closest('tr')?.textContent).toContain('停止中')
 expect(archiveAffiliate.mock.calls.map(call => call[0])).toEqual(['af-1', 'af-2'])
 affiliatesList.mockResolvedValue({ success: true, data: affiliates.map(row => row.id === 'af-2' ? { ...row, isActive: false } : row) })
 const reads = affiliatesList.mock.calls.length
 fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
 await waitFor(() => expect(affiliatesList).toHaveBeenCalledTimes(reads + 1))
 expect(await screen.findByRole('checkbox', { name: '多い人を選ぶ' })).toHaveProperty('checked', false)
 expect(screen.getByRole('checkbox', { name: '少ない人を選ぶ' })).toHaveProperty('checked', true)
 expect(archiveAffiliate).toHaveBeenCalledTimes(2)
})

it('まとめ停止の再試行は受け付け済みを飛ばし、未完了だけ1回送って閉じる', async () => {
 archiveAffiliate.mockReset().mockImplementation(async (id: string) => { if (id === 'af-2') return { success: true }; throw new Error('通信できませんでした。') })
 await render()
 fireEvent.click(screen.getByRole('checkbox', { name: '多い人を選ぶ' })); fireEvent.click(screen.getByRole('checkbox', { name: '少ない人を選ぶ' }))
 fireEvent.click(screen.getByRole('button', { name: 'まとめて紹介を止める' }))
 const dialog = await screen.findByRole('alertdialog', { name: '2 人の紹介をまとめて止めますか？' })
 await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'まとめて止める' })) })
 expect(within(dialog).getByRole('alert').textContent).toContain('1 人を止めました。1 人は止められませんでした')
 archiveAffiliate.mockResolvedValue({ success: true })
 await act(async () => { const retry = within(dialog).getByRole('button', { name: 'もう一度' }); fireEvent.click(retry); fireEvent.click(retry) })
 expect(archiveAffiliate.mock.calls.map(call => call[0])).toEqual(['af-1', 'af-2', 'af-1'])
 await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
 expect(screen.getByRole('checkbox', { name: '多い人を選ぶ' })).toHaveProperty('checked', false)
 expect(screen.getByRole('checkbox', { name: '少ない人を選ぶ' })).toHaveProperty('checked', false)
})

vi.mock('@/lib/admin-version-cache', () => ({ loadAdminVersionDetail: async () => ({ version: '2.7.0', deploy_env: 'staging' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '二号店' }] }) }))

it('一括停止の窓は操作先を示し、アカウント切替で閉じて古い紹介者を送らない', async () => {
  archiveAffiliate.mockReset().mockResolvedValue({ success: true })
  await render()
  fireEvent.click(screen.getByRole('checkbox', { name: '多い人を選ぶ' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '少ない人を選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: 'まとめて紹介を止める' }))
  const dialog = await screen.findByRole('alertdialog', { name: '2 人の紹介をまとめて止めますか？' })
  await within(within(dialog).getByRole('region', { name: '操作の対象' })).findByText('本店')
  expect(within(dialog).getByText(/承認待ちの成果がある人は、行の「…」から個別に中身を確認して止めてください/)).toBeTruthy()
  expect(archiveAffiliate).not.toHaveBeenCalled()
  accountState.id = 'account-b'
  await render()
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(archiveAffiliate).not.toHaveBeenCalled()
  expect(screen.queryAllByRole('checkbox', { checked: true })).toHaveLength(0)
})
