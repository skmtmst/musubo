// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ path: '/tags', push: vi.fn(), replace: vi.fn() }))
const net = vi.hoisted(() => ({
  gettingStarted: vi.fn(),
  guideGet: vi.fn(),
  guideSave: vi.fn(),
  styleGet: vi.fn(),
  googleConnection: vi.fn(),
  googleProfile: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }),
  useOptionalAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { basicId: '@test' }, refreshAccounts: vi.fn() }),
}))
vi.mock('@/lib/staff-role', async (original) => ({
  ...await original<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => 'owner',
  useStaffIdentity: () => ({ id: 'staff-1', role: 'owner', readOnly: false }),
}))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      gettingStarted: {
        ...actual.api.gettingStarted,
        get: net.gettingStarted,
        guide: { ...actual.api.gettingStarted.guide, get: net.guideGet, save: net.guideSave },
      },
    },
  }
})
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: net.styleGet } }))
vi.mock('@/lib/restaurant-google-api', () => ({
  restaurantGoogleApi: { connection: net.googleConnection, profile: net.googleProfile },
}))

import { SetupChip } from '@/components/shell/setup-chip'
import { API_MUTATION_SUCCEEDED } from '@/lib/api/transport/mutation-events'
import { markLineAccountEntryReady } from '@/lib/line-account-entry'
import { GuideHost } from '@/v8/onboarding/guide-host'
import GettingStarted from './getting-started'

const stepsPayload = (attributesState: 'done' | 'todo') => ({
  success: true,
  data: {
    dismissed: false,
    steps: [
      { key: 'accounts', state: 'done', href: '/accounts', reason: null },
      { key: 'featureSet', state: 'done', href: '/settings', reason: null },
      { key: 'attributes', state: attributesState, href: '/tags?tab=tags', reason: null },
      { key: 'friendAdd', state: 'todo', href: '/friend-add-settings', reason: null },
      { key: 'scenario', state: 'todo', href: '/scenarios', reason: null },
      { key: 'firstMessage', state: 'todo', href: '/chats', reason: null },
    ],
  },
})

function AppShell() {
  return (
    <GuideHost>
      <SetupChip />
      {nav.path === '/getting-started' ? <GettingStarted /> : <div>作業画面</div>}
    </GuideHost>
  )
}

let clearEntry: (() => void) | undefined
beforeEach(() => {
  clearEntry = markLineAccountEntryReady('acc-1')
  window.localStorage.clear()
  nav.path = '/tags'
  nav.push.mockClear()
  nav.replace.mockClear()
  net.gettingStarted.mockReset().mockResolvedValue(stepsPayload('done'))
  net.guideGet.mockReset().mockResolvedValue({ success: true, data: { phase: 'idle', stepKey: null, procedureIndex: 1 } })
  net.guideSave.mockReset().mockResolvedValue({ success: true })
  net.styleGet.mockReset().mockResolvedValue({ success: true, data: { style: 'standard', styleSelected: true, version: 1 } })
  net.googleConnection.mockReset().mockResolvedValue({ success: true, store: { lineAccountId: 'acc-1' }, connection: { status: 'disconnected', locationName: null } })
  net.googleProfile.mockReset().mockResolvedValue(null)
})

afterEach(() => { cleanup(); clearEntry?.() })

it('保存後の読み直しが失敗したとき、札は直前の数を保ち、一覧は古い済みを戻さずエラーと再試行から回復する', async () => {
  nav.path = '/getting-started'
  const view = render(<AppShell />)
  await screen.findByText('2 / 6 済み')
  expect(screen.getByRole('link', { name: '開店準備 2/6。はじめの設定を開く' })).toBeTruthy()

  let rejectRefresh!: (reason?: unknown) => void
  net.gettingStarted.mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject }))

  nav.path = '/tags'
  view.rerender(<AppShell />)
  act(() => {
    window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId: 'acc-1' } }))
  })
  /* 保存直後に一覧画面へ戻ると、再取得が始まり古い「済み」は隠れる */
  nav.path = '/getting-started'
  view.rerender(<AppShell />)
  await waitFor(() => expect(net.gettingStarted).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('link', { name: '開店準備 2/6。はじめの設定を開く' })).toBeTruthy()
  expect(screen.queryByRole('table', { name: 'はじめの設定の順路' })).toBeNull()

  /* 読み直しが失敗したら、札は2/6のまま、一覧は古い済みを戻さずエラーと再試行ボタンを出す */
  await act(async () => { rejectRefresh(new Error('通信エラー')) })
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む', exact: true })
  expect(screen.getByRole('link', { name: '開店準備 2/6。はじめの設定を開く' })).toBeTruthy()
  expect(screen.queryByRole('table', { name: 'はじめの設定の順路' })).toBeNull()
  expect(screen.queryByText('2 / 6 済み')).toBeNull()

  /* もう一度読み込むで成功したら、一覧と札が最新の1/6へ揃う */
  net.gettingStarted.mockResolvedValueOnce(stepsPayload('todo'))
  fireEvent.click(retry)
  await screen.findByText('1 / 6 済み')
  expect(screen.getByRole('table', { name: 'はじめの設定の順路' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '開店準備 1/6。はじめの設定を開く' })).toBeTruthy()
})

it('連続保存・先に始まった読み直しの応答・画面移動・次の読み直し成功まで一覧に古い済みを戻さない', async () => {
  const view = render(<AppShell />)
  await screen.findByRole('link', { name: '開店準備 2/6。はじめの設定を開く' })

  let resolveEarlier!: (value: unknown) => void
  let resolveFinal!: (value: unknown) => void
  net.gettingStarted
    .mockImplementationOnce(() => new Promise(resolve => { resolveEarlier = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveFinal = resolve }))

  /* 先に始まった裏の読み直し（タブ復帰）の途中で連続して2回保存が成功する */
  act(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await waitFor(() => expect(net.gettingStarted).toHaveBeenCalledTimes(2))

  act(() => {
    window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId: 'acc-1' } }))
    window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId: 'acc-1' } }))
  })

  /* 先に始まった読み直しの古い応答が返っても、一覧画面へ移動したときに古い「済み」を表示しない */
  await act(async () => { resolveEarlier(stepsPayload('done')) })
  nav.path = '/getting-started'
  view.rerender(<AppShell />)
  await waitFor(() => expect(net.gettingStarted).toHaveBeenCalledTimes(3))
  expect(screen.getByRole('link', { name: '開店準備 2/6。はじめの設定を開く' })).toBeTruthy()
  expect(screen.queryByRole('table', { name: 'はじめの設定の順路' })).toBeNull()
  expect(screen.queryByText('2 / 6 済み')).toBeNull()

  /* 次の読み直しが成功してはじめて最新の一覧と札になる */
  await act(async () => { resolveFinal(stepsPayload('todo')) })
  await screen.findByText('1 / 6 済み')
  expect(screen.getByRole('table', { name: 'はじめの設定の順路' })).toBeTruthy()
  expect(screen.getByRole('link', { name: '開店準備 1/6。はじめの設定を開く' })).toBeTruthy()
})
