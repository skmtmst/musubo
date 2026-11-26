
import React, { act, Profiler, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { AccountProvider, useAccount } from '@/contexts/account-context'
import { PageChromeProvider } from '@/components/shell/page-chrome'
import { clearLineAccountsCache } from '@/lib/line-accounts-cache'
import { clearFeatureVisibilityCache } from '@/lib/feature-visibility-cache'
import AutoReplyEditPage from './page'
// @vitest-environment happy-dom
/*
 * J7 faithful oracle (R528: 188-001/002)。
 * literal same-view rerender と explicit Retry を別結果として実測する。
 * 実Page/EditDialog/Stepper/TargetMissing/runOptimistic・実AccountProvider/PageChromeProvider・
 * 実useStaffRole/useAccountを使い、mockは輸送 (api)・router transport・URLSearchParams adapterのみ。
 * router spyはnative遷移の再現ではない。原条件未達なら結果として返し、期待を弱めない。
 */

const push = vi.hoisted(() => vi.fn())
const replace = vi.hoisted(() => vi.fn())
const transport = vi.hoisted(() => ({
  getDraft: vi.fn(),
  get: vi.fn(),
  conflicts: vi.fn(),
  summary: vi.fn(),
  templates: vi.fn(),
  folders: vi.fn(),
  tags: vi.fn(),
  friendFields: vi.fn(),
  supportMarks: vi.fn(),
  scenarios: vi.fn(),
  commonVars: vi.fn(),
  reminders: vi.fn(),
  events: vi.fn(),
  notificationRules: vi.fn(),
  staffMe: vi.fn(),
  lineAccounts: vi.fn(),
}))
const netCalls = vi.hoisted(() => ({ count: 0 }))

const searchCalls = vi.hoisted(() => ({ count: 0 }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  // AccountProvider が今いる画面を読む（統括へ戻った直後の選択解除を保つため）。
  usePathname: () => '/auto-replies/edit',
  // 安定したURLSearchParams transport adapter (id=synthetic-rule固定・呼出回数で実body再実行を裏付け)。
  useSearchParams: () => {
    searchCalls.count += 1
    return new URLSearchParams('id=synthetic-rule')
  },
}))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    eventsApi: { ...actual.eventsApi, listEvents: transport.events },
    api: {
      ...actual.api,
      autoReplies: {
        getDraft: transport.getDraft,
        get: transport.get,
        conflicts: transport.conflicts,
        summary: transport.summary,
      },
      templates: { list: transport.templates },
      folders: { list: transport.folders },
      tags: { list: transport.tags },
      friendFields: { list: transport.friendFields },
      supportMarks: { list: transport.supportMarks },
      scenarios: { list: transport.scenarios },
      commonVars: { list: transport.commonVars },
      reminders: { list: transport.reminders },
      notifications: { ...actual.api.notifications, operatorRules: { list: transport.notificationRules } },
      staff: { me: transport.staffMe },
      lineAccounts: { list: transport.lineAccounts },
    },
  }
})

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

const DRAFT = {
  autoReplyId: 'synthetic-rule',
  versionId: 'synthetic-version',
  versionNumber: 1,
  status: 'draft',
  settings: {
    keyword: 'test',
    matchType: 'exact',
    responseType: 'text',
    responseContent: 'test',
    templateId: null,
    lineAccountId: 'synthetic-account',
    activeFrom: null,
    activeUntil: null,
    cooldownMinutes: null,
    skipWhenOperatorActive: false,
    priority: 0,
    messageKinds: null,
    receiveSources: ['line'],
    friendConditions: null,
    actions: null,
    responseWeekdays: null,
    responseHolidayRule: null,
    oncePerFriend: false,
    keywords: null,
    respondToAll: false,
    name: 'J7 synthetic reply',
    keywordMatchMode: 'any',
    folderId: null,
    internalMemo: null,
    replyDelaySeconds: null,
    unmatchedAction: null,
  },
  lastTestStatus: null,
  lastTestedAt: null,
  publishedAt: null,
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
 * 毎回freshなactual Page JSX (同type/key/id/account) でrenderし、
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
          <AutoReplyEditPage />
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
  searchCalls.count = 0
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
  transport.get.mockResolvedValue({ success: true, data: { isActive: false } })
  transport.conflicts.mockResolvedValue({ success: true, data: { conflicts: [] } })
  transport.summary.mockResolvedValue({
    success: true,
    data: { conflicts: [], conflictCount: 0, receiveSourceCounts: [], matchedLast28Days: null },
  })
  transport.templates.mockResolvedValue({ success: true, data: [] })
  transport.folders.mockResolvedValue({ success: true, data: [] })
  transport.tags.mockResolvedValue({ success: true, data: [] })
  transport.friendFields.mockResolvedValue({ success: true, data: [] })
  transport.supportMarks.mockResolvedValue({ success: true, data: [] })
  transport.scenarios.mockResolvedValue({ success: true, data: [] })
  transport.commonVars.mockResolvedValue({ success: true, data: [] })
  transport.reminders.mockResolvedValue({ success: true, data: [] })
  transport.events.mockResolvedValue({ items: [], total: 0, limit: 200, sort: [] })
  transport.notificationRules.mockResolvedValue({ success: true, data: { items: [] } })
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

describe('J7 R528 literal same-view rerender (原条件照合・別結果)', () => {
  it('rerenderだけでは追加取得も回復も起きないことを実測する', async () => {
    const gate = deferred<unknown>()
    transport.getDraft.mockReturnValueOnce(gate.promise)
    mountTree()
    await act(async () => { root.render(buildTree()) })
    await selectAccount()

    // 失敗確認: actual失敗領域と再試行control、編集入力はまだない。
    gate.reject(new TypeError('Failed to fetch'))
    await waitFor(() => expect(screen.getByText('読み込めませんでした')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('例：予約の日程変更')).toBeNull()
    expect(transport.getDraft).toHaveBeenCalledTimes(1)

    // 復旧はtransport mode変更だけ。callback/account/ID/roleの変更なし。
    transport.getDraft.mockResolvedValue({ success: true, data: DRAFT })
    // literal same-view rerender: fresh JSX・同type/key/id/account・retry非click。
    const commitsBefore = profile.commits
    const mountsBefore = profile.mounts
    const searchBefore = searchCalls.count
    await act(async () => { root.render(buildTree()) })
    await act(async () => { await Promise.resolve() })

    // 実測: Profiler update増＋mount不増＋useSearchParams呼出増で実再描画を裏付け。
    // 追加取得なし・実フォームなし・notice残存。原literal回復期待とは食い違う。
    expect(profile.commits).toBeGreaterThan(commitsBefore)
    expect(profile.mounts).toBe(mountsBefore)
    expect(searchCalls.count).toBeGreaterThan(searchBefore)
    expect(transport.getDraft).toHaveBeenCalledTimes(1)
    expect(screen.getByText('読み込めませんでした')).toBeTruthy()
    expect(screen.queryByPlaceholderText('例：予約の日程変更')).toBeNull()
    expect(netCalls.count).toBe(0)
  })
})

describe('J7 R528 explicit Retry (正の受入・別結果)', () => {
  it('失敗mount→transport復旧→もう一度読み込むで実フォームが戻る', async () => {
    const gate = deferred<unknown>()
    transport.getDraft.mockReturnValueOnce(gate.promise)
    mountTree()
    await act(async () => {
      root.render(
        <PageChromeProvider>
          <AccountProvider>
            <SelectAccountButton />
            <AutoReplyEditPage />
          </AccountProvider>
        </PageChromeProvider>,
      )
    })
    await selectAccount()

    gate.reject(new TypeError('Failed to fetch'))
    await waitFor(() => expect(screen.getByText('読み込めませんでした')).toBeTruthy())

    transport.getDraft.mockResolvedValue({ success: true, data: DRAFT })
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))

    // target API advance + actual form/menu recovery。
    await waitFor(() => expect(transport.getDraft).toHaveBeenCalledTimes(2))
    const nameInput = await screen.findByPlaceholderText('例：予約の日程変更') as HTMLInputElement
    expect(nameInput.value).toBe('J7 synthetic reply')
    expect(screen.getByRole('navigation', { name: '自動応答を作る進み方' })).toBeTruthy()
    expect(screen.queryByText('読み込めませんでした')).toBeNull()

    // 入力保持: 回復後に変えた値が無関係rerenderで残る。
    fireEvent.change(nameInput, { target: { value: 'J7 synthetic reply 編集後' } })
    expect((screen.getByPlaceholderText('例：予約の日程変更') as HTMLInputElement).value)
      .toBe('J7 synthetic reply 編集後')
    expect(netCalls.count).toBe(0)
  })
})
