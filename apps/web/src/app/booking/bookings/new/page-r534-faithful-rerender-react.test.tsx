// @vitest-environment happy-dom
/*
 * J7 faithful oracle (R534: 197-001/002)。
 * literal same-view rerender と explicit Retry を別結果として実測する。
 * 実NewProxyBookingPage/Select/MenuPortal/Notice/StickyBar・実AccountProvider/PageChromeProvider・
 * 実canOperateBookings/useAccountを使い、mockは輸送 (bookingApi/api)・router transportのみ。
 * router spyはnative遷移の再現ではない。原条件未達なら結果として返し、期待を弱めない。
 */
import React, { act, Profiler, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

const push = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())
const transport = vi.hoisted(() => ({
  listMenus: vi.fn(),
  listMenuStaff: vi.fn(),
  getAvailability: vi.fn(),
  getCustomerContext: vi.fn(),
  previewReminders: vi.fn(),
  createProxyBooking: vi.fn(),
  getAlternatives: vi.fn(),
  createCustomer: vi.fn(),
  friendsList: vi.fn(),
  staffMe: vi.fn(),
  lineAccounts: vi.fn(),
}))
const netCalls = vi.hoisted(() => ({ count: 0 }))

// 題の言葉のためのスタイル読み込みは、この試験（メニューの読み直し）の対象外。本物の通信を数えないよう固定する。
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ status: 'ready', data: { style: 'standard' }, error: null, reload: () => {}, stale: false }) }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push, replace }),
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const blocked = (name: string) => vi.fn(async () => {
    throw new Error(`MUTATION_BLOCKED:${name}`)
  })
  return {
    ...actual,
    bookingApi: {
    ...(await import('@/test-utils/booking-visit-api-mock')).bookingVisitApiMock(),
      listMenus: transport.listMenus,
      listMenuStaff: transport.listMenuStaff,
      getAvailability: transport.getAvailability,
      getCustomerContext: transport.getCustomerContext,
      previewReminders: blocked('previewReminders'),
      createProxyBooking: transport.createProxyBooking,
      getAlternatives: blocked('getAlternatives'),
      createCustomer: transport.createCustomer,
    },
    api: {
      ...actual.api,
      friends: { ...actual.api.friends, list: transport.friendsList },
      staff: { ...actual.api.staff, me: transport.staffMe },
      lineAccounts: { list: transport.lineAccounts },
    },
  }
})

import { AccountProvider, useAccount } from '@/contexts/account-context'
import { PageChromeProvider } from '@/components/shell/page-chrome'
import { clearLineAccountsCache } from '@/lib/line-accounts-cache'
import { clearFeatureVisibilityCache } from '@/lib/feature-visibility-cache'
import NewProxyBookingPage from './page'

const ACCOUNT = {
  id: 'synthetic-account',
  channelId: 'synthetic-channel',
  name: '監査店',
  isActive: true,
  country: null,
  role: 'owner',
  displayOrder: 0,
}

const OWNER_ME = {
  id: 'synthetic-staff',
  tenantId: 'synthetic-tenant',
  name: '監査担当',
  email: null,
  role: 'owner',
  lineLinked: false,
  twoFactorEnabled: false,
  isActive: true,
  permissionKeys: [],
  permissionViewKeys: [],
  permissionScope: {},
  notificationPreferences: {},
  inviteStatus: 'active',
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:00:00.000Z',
  assignedLineAccountId: 'synthetic-account',
  canAccessDescendantAccounts: false,
  accountScope: 'accounts',
  scopedLineAccountIds: ['synthetic-account'],
  roleBundle: 'administrator',
  emailMask: 'none',
  policyVersion: 1,
}

const MENU = {
  id: 'synthetic-menu',
  name: '監査メニュー',
  is_active: 1,
  base_price: 1000,
  duration_minutes: 60,
  category_label: null,
  description: null,
  buffer_after_minutes: 0,
  sort_order: 0,
  auto_tag_id: null,
}

function SelectAccountButton() {
  const { setSelectedAccountId } = useAccount()
  return (
    <button type="button" onClick={() => setSelectedAccountId('synthetic-account')}>
      監査店を選ぶ
    </button>
  )
}

/*
 * 同一elementを使い回すとroot.renderがbailoutし描画自体が起きない。
 * 毎回freshなactual Page JSX (stable type・非memo・同id/account) でrenderし、
 * Profilerのupdate増＋mount不増で実component再描画を裏付ける。
 */
const profile = { commits: 0, mounts: 0 }
function LeafProfiler({ children }: { children: ReactNode }) {
  return (
    <Profiler
      id="j7-leaf"
      onRender={(_id, phase) => {
        profile.commits += 1
        if (phase === 'mount') profile.mounts += 1
      }}
    >
      {children}
    </Profiler>
  )
}
function buildTree() {
  return (
    <PageChromeProvider>
      <AccountProvider>
        <SelectAccountButton />
        <LeafProfiler>
          <NewProxyBookingPage />
        </LeafProfiler>
      </AccountProvider>
    </PageChromeProvider>
  )
}

let host: HTMLDivElement
let root: Root

function mountTree() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
}

async function selectAccount() {
  fireEvent.click(screen.getByRole('button', { name: '監査店を選ぶ' }))
  await waitFor(() => expect(transport.lineAccounts).toHaveBeenCalled())
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  netCalls.count = 0
  profile.commits = 0
  profile.mounts = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    netCalls.count += 1
    throw new TypeError('unexpected actual fetch in faithful oracle')
  }))
  try { localStorage.clear() } catch { /* happy-dom without storage */ }
  clearLineAccountsCache()
  clearFeatureVisibilityCache()
  transport.lineAccounts.mockResolvedValue({ success: true, data: [ACCOUNT] })
  transport.staffMe.mockResolvedValue({ success: true, data: OWNER_ME })
  transport.listMenuStaff.mockResolvedValue({ staff: [] })
  transport.getAvailability.mockRejectedValue(new Error('MUTATION_BLOCKED:getAvailability'))
  transport.getCustomerContext.mockRejectedValue(new Error('MUTATION_BLOCKED:getCustomerContext'))
  transport.friendsList.mockResolvedValue({ success: true, data: { items: [] } })
  transport.createProxyBooking.mockRejectedValue(new Error('MUTATION_BLOCKED:createProxyBooking'))
  transport.createCustomer.mockRejectedValue(new Error('MUTATION_BLOCKED:createCustomer'))
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('J7 R534 literal same-view rerender (原条件照合・別結果)', () => {
  it('rerenderだけでは追加取得も回復も起きないことを実測する', async () => {
    const gate = deferred<unknown>()
    transport.listMenus.mockReturnValueOnce(gate.promise)
    mountTree()
    await act(async () => { root.render(buildTree()) })
    await selectAccount()

    // 失敗確認: actualメニュー失敗と再試行control、候補optionはまだない。
    fireEvent.change(screen.getByRole('textbox', { name: 'お客様からの要望' }), { target: { value: 'J7 note' } })
    gate.reject(new TypeError('Failed to fetch'))
    await waitFor(() => expect(screen.getByText('予約メニューを読み込めませんでした')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '予約メニュー' }))
    expect(screen.queryByRole('option', { name: '監査メニュー' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '予約メニュー' }))
    expect(transport.listMenus).toHaveBeenCalledTimes(1)

    // 復旧はtransport mode変更だけ。
    transport.listMenus.mockResolvedValue({ menus: [MENU] })
    // literal same-view rerender: fresh leaf props・同id/account・Retry非click・入力は触らない。
    const commitsBefore = profile.commits
    const mountsBefore = profile.mounts
    await act(async () => { root.render(buildTree()) })
    await act(async () => { await Promise.resolve() })

    // 実測: Profiler update増＋mount不増で実再描画を裏付け。
    // 追加取得なし・候補なし・notice残存・入力保持。原literal回復期待とは食い違う。
    expect(profile.commits).toBeGreaterThan(commitsBefore)
    expect(profile.mounts).toBe(mountsBefore)
    expect(transport.listMenus).toHaveBeenCalledTimes(1)
    expect(screen.getByText('予約メニューを読み込めませんでした')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'お客様からの要望' }) as HTMLTextAreaElement).value).toBe('J7 note')
    expect(netCalls.count).toBe(0)
  })
})

describe('J7 R534 explicit Retry (正の受入・別結果)', () => {
  it('失敗mount→transport復旧→もう一度読み込むで候補が戻り入力が残る', async () => {
    const gate = deferred<unknown>()
    transport.listMenus.mockReturnValueOnce(gate.promise)
    mountTree()
    await act(async () => {
      root.render(
        <PageChromeProvider>
          <AccountProvider>
            <SelectAccountButton />
            <NewProxyBookingPage />
          </AccountProvider>
        </PageChromeProvider>,
      )
    })
    await selectAccount()

    fireEvent.change(screen.getByRole('textbox', { name: 'お客様からの要望' }), { target: { value: 'J7 note' } })
    gate.reject(new TypeError('Failed to fetch'))
    await waitFor(() => expect(screen.getByText('予約メニューを読み込めませんでした')).toBeTruthy())

    transport.listMenus.mockResolvedValue({ menus: [MENU] })
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    // target API advance + actual候補回復。
    await waitFor(() => expect(transport.listMenus).toHaveBeenCalledTimes(2))
    expect(transport.listMenus).toHaveBeenLastCalledWith('synthetic-account')
    await waitFor(() => expect(screen.queryByText('予約メニューを読み込めませんでした')).toBeNull()
    )
    // actual Selectを開き、portal optionを観測 (選択は行わずstaff追加取得なし)。
    fireEvent.click(screen.getByRole('button', { name: '予約メニュー' }))
    expect(await screen.findByRole('radio', { name: '監査メニュー' })).toBeTruthy()
    expect(transport.listMenuStaff).not.toHaveBeenCalled()
    // 入力保持・登録系0・未知0。
    expect((screen.getByRole('textbox', { name: 'お客様からの要望' }) as HTMLTextAreaElement).value).toBe('J7 note')
    expect(transport.createProxyBooking).not.toHaveBeenCalled()
    expect(transport.createCustomer).not.toHaveBeenCalled()
    expect(netCalls.count).toBe(0)
  })
})
