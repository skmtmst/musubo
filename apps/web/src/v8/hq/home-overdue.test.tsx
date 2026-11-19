// @vitest-environment happy-dom
/*
 * 統括のアカウント画面の「返信の期限を過ぎた会話」（数の帯の1枚）の動きの試験。
 * 守るのは：期限を使う店が無ければ出さない／件数は期限を使う店の合計／
 * 期限が未設定の会話が混じれば「確定できません」と未設定の件数（全店の合計）／
 * 失敗・古い口は 0 と出さない／1店なら押すとその店に切り替えて受信箱の期限超過を開く／
 * 複数店なら押しても別の店へ進まず、店を選んでからその店の期限超過を開く。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushListUrlState } from '@/components/shared/list-url-state'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const attention = vi.hoisted(() => vi.fn())
const accounts = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const select = vi.hoisted(() => vi.fn())
const toast = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { attention } }))
vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchApi: vi.fn(async () => ({ success: true, data: {} })),
    api: {
      ...actual.api,
      lineAccounts: { ...actual.api.lineAccounts, list: accounts, followerImportState: vi.fn(async () => ({ success: true, data: { phase: 'completed' } })) },
      lineAccountFolders: { ...actual.api.lineAccountFolders, list: vi.fn(async () => ({ success: true, data: { folders: [], total: 0, unclassifiedCount: 0 } })) },
      tenants: { ...actual.api.tenants, me: vi.fn(async () => ({ success: true, data: { name: '然 -NEN-' } })) },
    },
  }
})
vi.mock('@/components/shared/toast', async (importOriginal: () => Promise<typeof import('@/components/shared/toast')>) => ({ ...await importOriginal(), notifyToast: toast }))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => React.createElement('a', { href }, children),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/hq',
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/hq/platform-notices', () => ({ default: () => null }))
vi.mock('@/lib/staff-role', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ accounts: [], setSelectedAccountId: select, refreshAccounts: async () => {} }),
}))

import HqHomeV8 from './home'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const account = (id: string, name: string, archivedAt: string | null = null) => ({
  id, revision: 1, channelId: `200000000${id.slice(-1)}`, name, displayName: name, basicId: `@${id}`, isActive: true,
  country: null, role: null, displayOrder: 0, archivedAt, tags: [],
  stats: { friendCount: 3, activeScenarios: 0, messagesThisMonth: 0, staffCount: 1 },
  connection: { status: 'ok', checkedAt: '2026-11-19T10:00:00+09:00', tokenExpired: false, issues: [] },
})
const counts = { connections: 0, unhandledChats: 5, pendingBookings: 0, unpaid: 0, stoppedDeliveries: 0 }
const on = (overdueCount: number | null, uncertainCount = 0) => ({ status: 'enabled', overdueCount, uncertainCount, href: '/chats' })
const off = { status: 'disabled', overdueCount: null, uncertainCount: null, href: '/chats' }
const item = (accountId: string, name: string, overdue?: unknown) => ({ accountId, name, style: 'standard', counts, details: {}, ...(overdue === undefined ? {} : { overdue }) })

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  attention.mockReset()
  accounts.mockReset()
  accounts.mockResolvedValue({ success: true, data: [account('acc-1', '本店'), account('acc-2', '渋谷店'), account('acc-3', 'テスト')] })
  push.mockReset()
  select.mockReset()
  toast.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  flushListUrlState()
  window.history.replaceState(null, '', '/hq')
  container.remove()
  verifiedStaffRole(null)
})

async function render() {
  verifiedStaffRole('owner')
  await act(async () => { root.render(<HqHomeV8 />) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

const overdueCard = () => [...container.querySelectorAll('[data-kpi-label]')]
  .find(label => label.textContent?.includes('返信の期限を過ぎた会話'))?.closest<HTMLElement>('[data-kpi-presentation]') ?? null
const buttonIn = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim() === name) ?? null

it('期限を使う店が1つもなければ、数の帯に出さない', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [item('acc-1', '本店', off), item('acc-2', '渋谷店', off), item('acc-3', 'テスト', off)] } })
  await render()
  expect(container.textContent).toContain('接続に問題')
  expect(overdueCard()).toBeNull()
})

it('1店だけ期限を過ぎていれば件数を出し、押すとその店に切り替えて受信箱の期限超過を開く', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [item('acc-1', '本店', on(3)), item('acc-2', '渋谷店', off), item('acc-3', 'テスト', on(0))] } })
  await render()
  const card = overdueCard()!
  expect(card.querySelector('[data-kpi-badge]')?.textContent).toBe('要確認')
  expect(card.textContent).toContain('3件')
  await act(async () => { buttonIn(card, '対応が必要な会話を確認')!.click() })
  expect(select).toHaveBeenCalledWith('acc-1')
  expect(toast).toHaveBeenCalledWith('本店 に切り替えました', { tone: 'info' })
  expect(push).toHaveBeenCalledWith('/chats?quick=overdue')
})

it('複数店のときは押しても別の店へ進まず、選んだ店の期限超過だけを開く', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [item('acc-1', '本店', on(2)), item('acc-2', '渋谷店', on(3)), item('acc-3', 'テスト', off)] } })
  await render()
  const card = overdueCard()!
  expect(card.textContent).toContain('5件')
  await act(async () => { buttonIn(card, '対応が必要な会話を確認')!.click() })
  expect(select).not.toHaveBeenCalled()
  expect(push).not.toHaveBeenCalled()
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.map(element => element.textContent?.trim())).toEqual(['渋谷店 3件', '本店 2件'])
  await act(async () => { items[1].click() })
  expect(select).toHaveBeenCalledTimes(1)
  expect(select).toHaveBeenCalledWith('acc-1')
  expect(push).toHaveBeenCalledWith('/chats?quick=overdue')
})

it('期限が未設定の会話が混じる店があれば合計を出さず、未設定の件数を全店で足す', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [item('acc-1', '本店', on(null, 2)), item('acc-2', '渋谷店', on(null, 1)), item('acc-3', 'テスト', on(4))] } })
  await render()
  const card = overdueCard()!
  expect(card.textContent).toContain('確定できません')
  expect(card.textContent).toContain('期限未設定 3件')
  expect(card.textContent).not.toContain('4件')
  expect(buttonIn(card, '対応が必要な会話を確認')).toBeNull()
})

it('古い口で期限の値が無いときは 0 と出さず、確認できないと示す', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [item('acc-1', '本店'), item('acc-2', '渋谷店'), item('acc-3', 'テスト')] } })
  await render()
  const card = overdueCard()!
  expect(card.textContent).toContain('件数を確認できません')
  expect(card.textContent).toContain('—')
  expect(card.textContent).not.toMatch(/0\s*件/)
})

it('読み込みに失敗したときは 0 と出さず、読み込めなかったと示す', async () => {
  attention.mockRejectedValue(new Error('network'))
  await render()
  const card = overdueCard()!
  expect(card.textContent).toContain('読み込めませんでした')
  expect(card.textContent).not.toMatch(/0\s*件/)
})

it('アーカイブした店の期限超過は数えない', async () => {
  accounts.mockResolvedValue({ success: true, data: [account('acc-1', '本店'), account('acc-2', '渋谷店', '2026-11-01T00:00:00Z')] })
  attention.mockResolvedValue({ success: true, data: { items: [item('acc-1', '本店', on(1)), item('acc-2', '渋谷店', on(6))] } })
  await render()
  const card = overdueCard()!
  expect(card.textContent).toContain('1件')
  expect(card.textContent).not.toContain('7件')
  await act(async () => { buttonIn(card, '対応が必要な会話を確認')!.click() })
  expect(select).toHaveBeenCalledWith('acc-1')
})

it('表示中の店が口の応答に無いときは、その店を 0 とせず合計を確定しない', async () => {
  attention.mockResolvedValue({ success: true, data: { items: [item('acc-1', '本店', on(3)), item('acc-2', '渋谷店', off)] } })
  await render()
  const card = overdueCard()!
  expect(card.textContent).toContain('件数を確認できません')
  expect(card.textContent).not.toContain('3件')
  expect(buttonIn(card, '対応が必要な会話を確認')).toBeNull()
})
