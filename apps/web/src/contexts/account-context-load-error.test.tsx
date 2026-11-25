// @vitest-environment happy-dom
/*
 * アカウント一覧の取得失敗が「アカウントなし」に見える事故の回帰試験
 * （Issue #978）。
 *
 * これまで refreshAccounts は失敗を空 catch で握りつぶし、
 * `accounts=[]`・`loading=false` のまま終わった。利用側は空一覧と
 * 失敗を見分けられず、「店舗が選ばれていません」「まだアカウントが
 * ありません」が出て、再読み込みの手段も無かった。
 *
 * ここは本物の AccountProvider を react-dom で動かし、通信
 * （アカウント一覧と選択したアカウントの確認）の成否を差し替えて、
 *   1. 失敗時に error が立ち、ガードが「読み込めませんでした＋再読み込み」を出す
 *   2. 再読み込みの成功で一覧が更新され、アカウントの確認が済んでから画面へ戻れる
 *   3. 成功済みの一覧は再取得の失敗で消えない
 *   4. '/' の着地点ゲートが失敗をエラー表示にし、統括へ飛ばさない
 * ことを確認する。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // api.ts は import 時に必須envを検査する。モック本体より先に立てる。
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const api = vi.hoisted(() => ({ listAccounts: vi.fn(), profilePictures: vi.fn(), accountEntry: vi.fn() }))

const fixture = vi.hoisted(() => ({ pathname: '/friends' }))
const router = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }))

vi.mock('next/navigation', () => ({
  usePathname: () => fixture.pathname,
  useRouter: () => router,
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

import { AccountProvider, useAccount, type AccountWithStats } from './account-context'
import { clearLineAccountsCache, prefetchLineAccounts } from '@/lib/line-accounts-cache'
import StoreSelectionGate from '@/components/store-selection-gate'
import RootLandingGate from '@/components/root-landing-gate'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Node の experimental localStorage は実体が無いので、happy-dom でも自前で立てる。 */
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

const ACCOUNT: AccountWithStats = {
  id: 'account-1',
  channelId: 'channel-1',
  name: 'テスト店舗',
  isActive: true,
  country: null,
  role: null,
  displayOrder: 0,
}

/** 文脈の中身を DOM に出すだけの観測点。 */
function Probe() {
  const { accounts, selectedAccountId, error, loading, refreshing, refreshAccounts, clearSelectedAccountId } = useAccount()
  return (
    <div>
      <span data-probe="loading">{String(loading)}</span>
      <span data-probe="refreshing">{String(refreshing)}</span>
      <span data-probe="error">{error ?? ''}</span>
      <span data-probe="count">{accounts.length}</span>
      <span data-probe="picture">{accounts[0]?.pictureUrl ?? ''}</span>
      <span data-probe="selected">{selectedAccountId ?? ''}</span>
      <button type="button" data-probe="clear" onClick={clearSelectedAccountId}>clear</button>
      <button type="button" data-probe="refresh" onClick={() => { void refreshAccounts() }}>
        refresh
      </button>
    </div>
  )
}

let host: HTMLDivElement
let root: Root

const probe = (key: string) => host.querySelector<HTMLElement>(`[data-probe="${key}"]`)!

async function eventually(check: () => void, timeout = 1000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

function byExactText(tag: string, text: string): HTMLElement | null {
  return Array.from(host.querySelectorAll(tag)).find((el) => el.textContent?.trim() === text) ?? null
}

let storage: MemoryStorage

beforeEach(() => {
  vi.clearAllMocks()
  api.profilePictures.mockResolvedValue({ success: true, data: [] })
  api.accountEntry.mockResolvedValue({ success: true, data: { destination: 'dashboard', canResume: false } })
  clearLineAccountsCache()
  storage = new MemoryStorage()
  storage.setItem('lh_csrf', 'fixture-session')
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const { pathname: path, searchParams } = new URL(input)
    const response = path === '/api/staff/me'
      ? { success: true, data: { id: 'staff-a', role: 'owner' } }
      : path === '/api/line-accounts/profile-pictures'
        ? await api.profilePictures()
        : path === `/api/line-accounts/${ACCOUNT.id}/follower-import` && searchParams.get('entry') === '1'
          ? await api.accountEntry()
          : await api.listAccounts()
    return new Response(JSON.stringify(response))
  }))
  fixture.pathname = '/friends'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('1店の自動選択', () => {
  it('店の画面で1店を選び、設定へ移っても保持する', async () => {
    api.listAccounts.mockResolvedValue({ success: true, data: [ACCOUNT] })
    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    await eventually(() => expect(probe('selected').textContent).toBe(ACCOUNT.id))
    fixture.pathname = '/staff'
    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    expect(probe('selected').textContent).toBe(ACCOUNT.id)
    expect(storage.getItem('lh_selected_account')).toBe(ACCOUNT.id)
  })
  it('統括へ戻る解除を維持し、店に戻ると1店を選ぶ', async () => {
    api.listAccounts.mockResolvedValue({ success: true, data: [ACCOUNT] })
    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    await eventually(() => expect(probe('selected').textContent).toBe(ACCOUNT.id))
    await act(async () => { probe('clear').click() })
    expect(probe('selected').textContent).toBe('')
    fixture.pathname = '/hq'
    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    expect(probe('selected').textContent).toBe('')
    fixture.pathname = '/friends'
    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    await eventually(() => expect(probe('selected').textContent).toBe(ACCOUNT.id))
  })
  it('複数あるときは勝手に選ばない', async () => {
    api.listAccounts.mockResolvedValue({ success: true, data: [ACCOUNT, { ...ACCOUNT, id: 'account-2' }] })
    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    await eventually(() => expect(probe('loading').textContent).toBe('false'))
    expect(probe('selected').textContent).toBe('')
  })
  it('統括の画面では1店でも自動選択しない', async () => {
    fixture.pathname = '/hq'
    api.listAccounts.mockResolvedValue({ success: true, data: [ACCOUNT] })
    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    await eventually(() => expect(probe('loading').textContent).toBe('false'))
    expect(probe('selected').textContent).toBe('')
  })
})

describe('アカウント一覧の取得失敗（Issue #978）', () => {
  it('後からLINE公式アカウント画像が登録されても一覧のアイコンへ反映する', async () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    api.listAccounts.mockResolvedValue({ success: true, data: [ACCOUNT] })
    api.profilePictures.mockResolvedValueOnce({ success: true, data: [{ id: ACCOUNT.id, pictureUrl: null }] })
      .mockResolvedValue({ success: true, data: [{ id: ACCOUNT.id, pictureUrl: 'https://line.example/icon.png' }] })
    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    await eventually(() => { expect(api.profilePictures).toHaveBeenCalledTimes(1) })
    expect(probe('picture').textContent).toBe('')
    now += 31_000
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await eventually(() => { expect(probe('picture').textContent).toBe('https://line.example/icon.png') })
    expect(probe('count').textContent).toBe('1')
    clock.mockRestore()
  })

  it('アーカイブ済みを除き、残る1店を選択する', async () => {
    const archived = { ...ACCOUNT, id: 'old-shed', name: 'THE SHED（旧登録）', archivedAt: '2026-10-28T00:00:00Z' }
    const active = { ...ACCOUNT, id: 'current-shed', name: 'THE SHED', archivedAt: null }
    storage.setItem('lh_selected_account', archived.id)
    api.listAccounts.mockResolvedValue({ success: true, data: [archived, active] })

    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    await eventually(() => { expect(probe('loading').textContent).toBe('false') })
    expect(probe('count').textContent).toBe('1')
    await eventually(() => expect(probe('selected').textContent).toBe(active.id))
    expect(storage.getItem('lh_selected_account')).toBe(active.id)

    storage.setItem('lh_selected_account', active.id)
    await act(async () => { probe('refresh').click() })
    await eventually(() => { expect(probe('selected').textContent).toBe(active.id) })

    api.listAccounts.mockResolvedValue({ success: true, data: [archived, { ...active, archivedAt: '2026-10-29T00:00:00Z' }] })
    await act(async () => { probe('refresh').click() })
    await eventually(() => { expect(probe('count').textContent).toBe('0') })
    expect(probe('selected').textContent).toBe('')
    expect(storage.getItem('lh_selected_account')).toBeNull()
  })

  it('初回は先読みした一覧を使い、手動の取り直しは最新を取得する', async () => {
    api.listAccounts.mockResolvedValue({ success: true, data: [ACCOUNT] })
    prefetchLineAccounts()
    await act(async () => { root.render(<AccountProvider><Probe /></AccountProvider>) })
    await eventually(() => { expect(probe('count').textContent).toBe('1') })
    expect(api.listAccounts).toHaveBeenCalledTimes(1)
    api.listAccounts.mockResolvedValue({ success: true, data: [] })
    await act(async () => { probe('refresh').click() })
    await eventually(() => { expect(probe('count').textContent).toBe('0') })
    expect(api.listAccounts).toHaveBeenCalledTimes(2)
  })

  it('初回取得の失敗は error を立て、ガードが「読み込めませんでした＋再読み込み」を出す', async () => {
    api.listAccounts.mockRejectedValue(new Error('network down'))
    await act(async () => {
      root.render(
        <AccountProvider>
          <Probe />
          <StoreSelectionGate>
            <div data-probe="children">画面本体</div>
          </StoreSelectionGate>
        </AccountProvider>,
      )
    })

    await eventually(() => {
      expect(probe('loading').textContent).toBe('false')
      expect(probe('error').textContent).not.toBe('')
      expect(probe('count').textContent).toBe('0')
    })

    // 「店舗が選ばれていません」ではなく、失敗と再読み込みが出る。
    expect(host.textContent).not.toContain('店舗が選ばれていません')
    expect(host.textContent).toContain('アカウント一覧を読み込めませんでした')
    expect(byExactText('button', 'もう一度読み込む')).toBeTruthy()
    expect(host.querySelector('[data-probe="children"]')).toBeNull()
  })

  it('失敗のあとの再読み込みが成功すると、一覧が更新され画面へ戻れる', async () => {
    api.listAccounts.mockRejectedValue(new Error('network down'))
    await act(async () => {
      root.render(
        <AccountProvider>
          <Probe />
          <StoreSelectionGate>
            <div data-probe="children">画面本体</div>
          </StoreSelectionGate>
        </AccountProvider>,
      )
    })
    await eventually(() => {
      expect(probe('error').textContent).not.toBe('')
    })

    // 保存済みの選択を復元しても、対象アカウントの確認が済むまでは画面を開かない。
    storage.setItem('lh_selected_account', ACCOUNT.id)
    api.listAccounts.mockResolvedValue({ success: true, data: [ACCOUNT] })
    let confirmEntry: () => void = () => {}
    api.accountEntry.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { confirmEntry = resolve })
      return { success: true, data: { destination: 'dashboard', canResume: false } }
    })

    const retry = byExactText('button', 'もう一度読み込む')
    expect(retry).toBeTruthy()
    await act(async () => { retry!.click() })

    await eventually(() => {
      expect(probe('error').textContent).toBe('')
      expect(probe('count').textContent).toBe('1')
      expect(probe('selected').textContent).toBe(ACCOUNT.id)
      expect(api.accountEntry).toHaveBeenCalledOnce()
    })
    expect(host.querySelector('[data-probe="children"]')).toBeNull()
    await act(async () => { confirmEntry() })
    expect(host.querySelector('[data-probe="children"]')).toBeTruthy()
  })

  it('一度取れた一覧は、再取得の失敗で消えない', async () => {
    api.listAccounts.mockResolvedValue({ success: true, data: [ACCOUNT] })
    await act(async () => {
      root.render(
        <AccountProvider>
          <Probe />
        </AccountProvider>,
      )
    })
    await eventually(() => {
      expect(probe('count').textContent).toBe('1')
    })

    api.listAccounts.mockRejectedValue(new Error('network down'))
    await act(async () => { probe('refresh').click() })

    await eventually(() => {
      expect(probe('refreshing').textContent).toBe('false')
      expect(probe('error').textContent).not.toBe('')
      // 失敗しても手元の一覧は残る（「アカウントなし」へ巻き戻さない）。
      expect(probe('count').textContent).toBe('1')
    })
  })

  it('API が success:false を返した場合も error が立ち再読み込みできる', async () => {
    api.listAccounts.mockResolvedValue({ success: false, error: 'server error' })
    await act(async () => {
      root.render(
        <AccountProvider>
          <Probe />
          <StoreSelectionGate>
            <div data-probe="children">画面本体</div>
          </StoreSelectionGate>
        </AccountProvider>,
      )
    })

    await eventually(() => {
      expect(probe('error').textContent).toBe('server error')
      expect(byExactText('button', 'もう一度読み込む')).toBeTruthy()
    })
  })

  it("'/' では失敗をエラー表示にし、統括へ飛ばさない", async () => {
    fixture.pathname = '/'
    api.listAccounts.mockRejectedValue(new Error('network down'))
    await act(async () => {
      root.render(
        <AccountProvider>
          <Probe />
          <RootLandingGate>
            <div data-probe="children">ダッシュボード</div>
          </RootLandingGate>
        </AccountProvider>,
      )
    })

    await eventually(() => {
      expect(host.textContent).toContain('アカウント一覧を読み込めませんでした')
      expect(byExactText('button', 'もう一度読み込む')).toBeTruthy()
    })
    // 失敗を「アカウントなし」と読み違えて /hq へ飛ばさない。
    expect(router.replace).not.toHaveBeenCalled()

    // 再読み込みで1件取れたら、その店舗が選ばれてダッシュボードが出る。
    api.listAccounts.mockResolvedValue({ success: true, data: [ACCOUNT] })
    await act(async () => { byExactText('button', 'もう一度読み込む')!.click() })
    await eventually(() => {
      expect(host.querySelector('[data-probe="children"]')).toBeTruthy()
    })
  })
})
