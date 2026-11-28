// @vitest-environment happy-dom
/*
 * 板 ：LINEアカウント一覧の行操作は「⋯」にまとめる。
 * 開くと詳細・確かめ直し・引き継ぎ・アーカイブが出ることを実マウントで確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const listAccounts = vi.hoisted(() => vi.fn())
const checkConnection = vi.hoisted(() => vi.fn())
const push = vi.hoisted(() => vi.fn())
const staff = vi.hoisted(() => ({ role: 'owner' as string | null }))

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    api: {
      ...actual.api,
      lineAccounts: { ...actual.api.lineAccounts, list: listAccounts, checkConnection },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) =>
    React.createElement('a', props, children),
}))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/accounts',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', loading: false }),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => {},
  usePageChrome: () => ({}),
}))

vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: vi.fn(async () => ({ success: true, data: { style: 'standard', styleSelected: true } })) } }))

import AccountsPage from './page'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity } from '@/lib/staff-identity-state'
vi.mock('@/lib/staff-role', async original => ({ ...await original(), useStaffRole: () => staff.role }))
vi.mock('@/components/accounts/account-ordering', () => ({
  default: () => <div role="dialog" aria-label="LINEアカウント階層を編集" data-testid="account-ordering" />,
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme='v8'
  window.history.replaceState(null,'','/accounts')
  push.mockClear()
  checkConnection.mockReset()
  staff.role = 'owner'
  verifiedStaffRole('owner')
  // 設定ナビの機能表示GETは見本で返す。この試験から外へ通信させない。
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":true,"data":{}}', { status: 200, headers: { 'content-type': 'application/json' } })))
  listAccounts.mockImplementation(async () => ({
    success: true,
    data: [{
      id: 'account-a',
      name: '本店アカウント',
      revision: 7,
      channelId: '1234567890',
      channelSecret: null,
      isActive: true,
      isDefault: true,
      timezone: 'Asia/Tokyo',
      webhook: { status: 'matched' },
      stats: { friendCount: 120 },
      parentLineAccountId: null,
      archivedAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }],
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  forgetStaffIdentity()
  const writes = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => init?.method && !['GET', 'HEAD', 'OPTIONS'].includes(init.method))
  expect(writes).toHaveLength(0)
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

async function flush() {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

describe('V7vn3 LINEアカウント一覧の行操作', () => {
  it('行の操作は「⋯」1つで、枠つき「詳細」ボタンは無い', async () => {
    await act(async () => { root.render(<AccountsPage />) })
    await flush()

    const menuButton = [...host.querySelectorAll('button')]
      .find((el) => el.getAttribute('aria-label') === '本店アカウントの操作')
    expect(menuButton, '行の「⋯」ボタンが見つかりません').toBeTruthy()
    // #641 の枠つき詳細ボタンはやめ、メニューの中に移した。
    expect(host.textContent).not.toContain('•••')
    const detailLinks = [...host.querySelectorAll('a')]
      .filter((el) => el.getAttribute('href') === '/accounts/detail?id=account-a')
    expect(detailLinks, '行に直接の詳細リンクが残っています').toHaveLength(0)
  })

  it('「⋯」を開くと4項目が出て、詳細で詳しい画面へ行く', async () => {
    await act(async () => { root.render(<AccountsPage />) })
    await flush()

    const menuButton = [...host.querySelectorAll('button')]
      .find((el) => el.getAttribute('aria-label') === '本店アカウントの操作')
    expect(menuButton).toBeTruthy()
    await act(async () => { menuButton?.click() })
    await flush()

    // メニューはポータルに出るので、画面全体で探す。
    const body = document.body.textContent ?? ''
    for (const label of ['詳細', '接続をもう一度確かめる', '引き継ぎ', 'アーカイブ']) {
      expect(body, `メニューに「${label}」がありません`).toContain(label)
    }

    const detail = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === '詳細') as HTMLElement | undefined
    expect(detail).toBeTruthy()
    expect(detail?.getAttribute('href')).toBe('/accounts/detail?id=account-a')
    await act(async () => { detail?.click() })
    await flush()
    expect(host.querySelector('[aria-label="本店アカウントの操作"]')?.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    ['matched', true, '「本店アカウント」のWebhook接続を確認しました。'],
    ['matched', false, 'Webhook接続を確認できませんでした'],
    ['mismatched', true, 'Webhook接続を確認できませんでした'],
  ])('現在の版を使ってWebhookを確認し、結果を表示する（%s、%s）', async (result, webhookActive, message) => {
    checkConnection.mockResolvedValue({ success: true, data: { accountId: 'account-a', checks: [{ kind: 'webhook_endpoint', result, webhookActive }] } })
    const refreshed = vi.fn()
    window.addEventListener('lh:v8:guide-signal', refreshed)
    try {
      await renderList()
      await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="本店アカウントの操作"]')!.click() })
      const recheck = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find(item => item.textContent === '接続をもう一度確かめる')!
      await act(async () => { recheck.click() })
      expect(checkConnection).toHaveBeenCalledExactlyOnceWith('account-a', 7)
      expect(listAccounts).toHaveBeenLastCalledWith(true)
      expect(host.textContent).toContain(message)
      expect(refreshed).toHaveBeenCalledWith(expect.objectContaining({ detail: { anchor: 'accounts.connection', accountId: 'account-a' } }))
    } finally {
      window.removeEventListener('lh:v8:guide-signal', refreshed)
    }
  })
})

const ROW = {
  channelSecret: null, timezone: 'Asia/Tokyo', parentLineAccountId: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
}

function listOf(...rows: Array<Record<string, unknown>>) {
  listAccounts.mockImplementation(async () => ({ success: true, data: rows.map((row) => ({ ...ROW, ...row })) }))
}

const rowNames = () => [...host.querySelectorAll('tbody tr[data-row-id]')].map((row) => row.getAttribute('data-row-id'))

async function renderList() {
  verifiedStaffRole(staff.role)
  await act(async () => { root.render(<AccountsPage />) })
  await flush()
}

describe('V7vn3 LINEアカウント一覧の骨組みと道具の段', () => {
  beforeEach(() => {
    listOf(
      { id: 'main', name: '本店', channelId: '2007000001', isActive: true, isDefault: true, webhook: { status: 'matched' }, stats: { friendCount: 120 }, archivedAt: null },
      { id: 'branch', name: '支店', channelId: '2007000002', isActive: false, isDefault: false, webhook: { status: 'unknown' }, stats: { friendCount: 5 }, archivedAt: null },
      { id: 'old', name: '旧店', channelId: '2007000003', isActive: false, isDefault: false, webhook: null, archivedAt: '2026-09-01T00:00:00.000Z' },
    )
  })

  it('板 V7vn3 の枠に、数の4枚と共通の表を出し、既定の行に印を付ける', async () => {
    await renderList()
    expect(host.querySelector('[data-design-node="V7vn3"]'), '板の枠').toBeTruthy()
    const cards = host.querySelector('[data-design="KPIs"]')?.children
    expect(cards).toHaveLength(4)
    expect([...cards!].map((card) => card.textContent)).toEqual([
      expect.stringContaining('つないでいる'), expect.stringContaining('有効'), expect.stringContaining('接続に問題'), expect.stringContaining('友だちの合計'),
    ])
    const table = host.querySelector('table[aria-label="LINEアカウントの一覧"]')
    expect(table?.getAttribute('data-table-presentation')).toBe('account-list')
    expect(table?.querySelector('tr[data-row-id="main"] [aria-label="既定のアカウント"]')).toBeTruthy()
    expect(table?.querySelector('tr[data-row-id="branch"] [aria-label="既定のアカウント"]')).toBeNull()
  })

  it('並び替えの部品は一覧に置かず、「並び順と親子を変更する」で窓として開く', async () => {
    await renderList()
    expect(document.querySelector('[data-testid="account-ordering"]')).toBeNull()
    const open = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('並び順と親子を変更する'))
    await act(async () => { open?.click() })
    await flush()
    expect(document.querySelector('[data-testid="account-ordering"]')).toBeTruthy()
  })

  it('検索欄は道具の段に1つだけで、打った言葉で行を絞り込む', async () => {
    await renderList()
    const searches = host.querySelectorAll('input[aria-label="アカウント名・チャネル ID で探す"]')
    expect(searches).toHaveLength(1)
    const search = searches[0] as HTMLInputElement
    expect(search.placeholder).toBe('アカウント名・チャネル ID で探す')
    const filters = host.querySelector('[aria-label="状態で絞り込む"]')
    expect(filters, '絞り込みの札は検索欄と同じ段').toBeTruthy()
    expect(search.closest('div:has([aria-label="状態で絞り込む"])')).toBeTruthy()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '2007000002')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 検索欄は打ち終わりを 300ms 待ってから絞り込む。
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)) })
    await flush()
    expect(rowNames()).toEqual(['branch'])
  })

  it('絞り込みの札は状態ごとの実数を出し、選べない件数表示は置かない', async () => {
    await renderList()
    const filters = host.querySelector('[aria-label="状態で絞り込む"]')!
    const count = (label: string) => [...filters.querySelectorAll('button')].find((button) => button.textContent?.startsWith(label))?.querySelector('[data-segment-count]')?.textContent
    expect(count('すべて')).toBe('3')
    expect(count('稼働中')).toBe('1')
    expect(count('停止中')).toBe('1')
    expect(count('アーカイブ')).toBe('1')
    expect(host.textContent).not.toContain('20件表示')
  })

  it('読み込みに失敗している間は、札に件数を出さない', async () => {
    listAccounts.mockImplementation(async () => { throw new TypeError('fetch failed') })
    await renderList()
    const filters = host.querySelector('[aria-label="状態で絞り込む"]')!
    expect(filters.querySelectorAll('[data-segment-count]')).toHaveLength(0)
  })

  it('アーカイブ済みの行の「⋯」は「アーカイブから戻す」を出し、「アーカイブ」は出さない', async () => {
    await renderList()
    const filters = host.querySelector('[aria-label="状態で絞り込む"]')!
    const archived = [...filters.querySelectorAll('button')].find((button) => button.textContent?.startsWith('アーカイブ'))
    await act(async () => { archived?.click() })
    await flush()
    expect(rowNames()).toEqual(['old'])
    const menu = host.querySelector('button[aria-label="旧店の操作"]') as HTMLButtonElement
    await act(async () => { menu.click() })
    await flush()
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())
    expect(items).toContain('アーカイブから戻す')
    expect(items).not.toContain('アーカイブ')
  })

  it('変更権限のない担当者にも変える操作を理由付きで残し、読取は妨げない', async () => {
    staff.role = 'staff'
    await renderList()
    const ordering = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('並び順と親子を変更する'))!
    expect(ordering.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { ordering.click() })
    expect(document.querySelector('[data-testid="account-ordering"]')).toBeNull()
    const menu = host.querySelector('button[aria-label="本店の操作"]') as HTMLButtonElement
    await act(async () => { menu.click() })
    await flush()
    const nodes = [...document.body.querySelectorAll('[role="menuitem"]')]
    expect(nodes.map(item => item.getAttribute('aria-label') ?? item.textContent?.trim())).toEqual(['詳細', '接続をもう一度確かめる', '引き継ぎ', 'アーカイブ'])
    for (const item of nodes.slice(2)) expect(item.getAttribute('aria-disabled')).toBe('true')
    for (const item of nodes.slice(0, 2)) expect(item.getAttribute('aria-disabled')).toBeNull()
  })
})
