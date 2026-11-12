// @vitest-environment happy-dom
/*
 * PERF-07: AuthGuard のセッション確認は、直前の確認を短時間再利用する。
 *
 * 以前は画面遷移（pathname 変更）のたびに /api/auth/session へ往復していた。
 * 管理画面と API は別サイトなので、この往復は遅い。
 *
 * 再利用してよいのは「同じログインの確認が取れている直後」だけ。
 * トークン/CSRF の指紋が変わる、401 の合図が届く、期限が切れる、
 * のどれかなら必ず確認し直す（権限変更やログアウトを取りこぼさないため）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let currentPath = '/'
const replaceMock = vi.fn()
const routerMock = { replace: replaceMock }

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => currentPath,
}))

vi.mock('./hq/platform-notices', () => ({
  default: () => <div data-platform-notices>運営からのお知らせ</div>,
}))

import AuthGuard, { invalidateAuthSessionCheck } from './auth-guard'
import { SESSION_LOST_EVENT } from '@/lib/api'

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

let host: HTMLDivElement
let root: Root
let fetchSpy: ReturnType<typeof vi.fn>
let storage: MemoryStorage

function sessionOk(tenantStatus: 'active' | 'suspended' | 'archived' = 'active', onboarding: {
  status: 'awaiting_first_line'; quoteId: string | null; consentedAt: string | null
} | null = null) {
  return new Response(
    JSON.stringify({
      success: true,
      data: { name: 'テスト担当', role: 'admin', tenantStatus, onboarding, permissionKeys: [], viewPermissionKeys: [] },
      csrfToken: 'csrf-token-1',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

async function render() {
  await act(async () => {
    root.render(<AuthGuard><div data-child>中身</div></AuthGuard>)
  })
}

describe('PERF-07 AuthGuard のセッション確認再利用', () => {
  beforeEach(() => {
    currentPath = '/'
    replaceMock.mockReset()
    invalidateAuthSessionCheck()
    storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    fetchSpy = vi.fn(async () => sessionOk())
    vi.stubGlobal('fetch', fetchSpy)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('初回は /api/auth/session を確認して中身を出す', async () => {
    await render()
    await settle()

    // 確認と並べてアカウント一覧も先に取り始める（直列にしない）。
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const urls = fetchSpy.mock.calls.map(([url]) => String(url))
    expect(urls.some((url) => url.includes('/api/auth/session'))).toBe(true)
    expect(urls.some((url) => url.includes('/api/line-accounts'))).toBe(true)
    expect(host.querySelector('[data-child]')).not.toBeNull()
  })

  it.each(['/', '/hq', '/friends'])('利用開始前に %s を開いても通常画面を描画せず料金確認へ進む', async (path) => {
    currentPath = path
    fetchSpy.mockImplementation(async () => sessionOk('active', {
      status: 'awaiting_first_line', quoteId: null, consentedAt: null,
    }))
    await render()
    expect(host.querySelector('[data-auth-pending]')).not.toBeNull()
    expect(host.querySelector('[data-child]')).toBeNull()
    expect(host.textContent).not.toContain('対応が必要なもの')
    await settle()
    expect(replaceMock).toHaveBeenCalledWith('/hq/onboarding/pricing')
    expect(host.querySelector('[data-child]')).toBeNull()

    currentPath = '/hq/onboarding/pricing'
    await render()
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()
  })

  it('初回LINEの有効化後は再確認し、通常画面へ進める', async () => {
    currentPath = '/hq/onboarding/card'
    let beforeFirstLine = true
    fetchSpy.mockImplementation(async () => sessionOk('active', beforeFirstLine ? {
      status: 'awaiting_first_line', quoteId: null, consentedAt: '2026-11-11',
    } : null))
    await render()
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()

    beforeFirstLine = false
    currentPath = '/hq'
    await render()
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()
    expect(replaceMock).not.toHaveBeenCalledWith('/hq/onboarding/card')
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/auth/session'))).toHaveLength(2)
  })

  it('確認の応答を待たずに一覧を取り始める（並列）', async () => {
    let resolveSession: ((res: Response) => void) | null = null
    fetchSpy.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/api/auth/session')) {
        return new Promise<Response>((resolve) => { resolveSession = resolve })
      }
      return sessionOk()
    })

    await render()
    await settle()

    // 確認がまだ返事を待っているあいだに、一覧の取得が出ている。
    expect(resolveSession).not.toBeNull()
    expect(fetchSpy.mock.calls.map(([url]) => String(url)).some((url) => url.includes('/api/line-accounts'))).toBe(true)
    // 確認が終わるまで中身は出さない（認可を待たずに描かない）。
    expect(host.querySelector('[data-child]')).toBeNull()

    await act(async () => { resolveSession?.(sessionOk()) })
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()
  })

  it('直後の画面遷移では再確認しない', async () => {
    await render()
    await settle()

    currentPath = '/friends'
    await act(async () => { root.render(<AuthGuard><div data-child>中身</div></AuthGuard>) })
    await settle()

    currentPath = '/templates'
    await act(async () => { root.render(<AuthGuard><div data-child>中身</div></AuthGuard>) })
    await settle()

    // 30秒以内の遷移なら確認も一覧も初回の1回ずつだけ。
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[data-child]')).not.toBeNull()
  })

  it('期限（30秒）を過ぎた遷移では確認し直す', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    let now = 1_000_000
    nowSpy.mockImplementation(() => now)

    await render()
    await settle()
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    now += 31_000
    currentPath = '/friends'
    await act(async () => { root.render(<AuthGuard><div data-child>中身</div></AuthGuard>) })
    await settle()

    // 期限切れは確認と一覧を取り直し、認証世代のある本人情報も先読みする。
    expect(fetchSpy).toHaveBeenCalledTimes(5)
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/staff/me'))).toHaveLength(1)
  })

  it('CSRFトークンが変わった（別ログイン/権限更新）なら期限前でも確認し直す', async () => {
    await render()
    await settle()
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    storage.setItem('lh_csrf', 'csrf-token-2')
    currentPath = '/friends'
    await act(async () => { root.render(<AuthGuard><div data-child>中身</div></AuthGuard>) })
    await settle()

    // 指紋が変わったので古い答えを捨て、本人情報も新しい世代で先読みする。
    expect(fetchSpy).toHaveBeenCalledTimes(5)
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/staff/me'))).toHaveLength(1)
  })

  it('401の合図（SESSION_LOST_EVENT）のあとは期限前でも確認し直す', async () => {
    await render()
    await settle()
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    act(() => { window.dispatchEvent(new Event(SESSION_LOST_EVENT)) })

    currentPath = '/friends'
    await act(async () => { root.render(<AuthGuard><div data-child>中身</div></AuthGuard>) })
    await settle()

    // 合図で古い答えを捨て、確認・一覧・本人情報を取り直す。
    expect(fetchSpy).toHaveBeenCalledTimes(5)
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/staff/me'))).toHaveLength(1)
  })

  it('確認に失敗したら再利用せずログイン画面へ送る', async () => {
    fetchSpy.mockImplementation(async () => new Response(null, { status: 401 }))

    await render()
    await settle()

    expect(replaceMock).toHaveBeenCalledWith('/login')
    expect(host.querySelector('[data-child]')).toBeNull()
  })

  it.each([
    ['/m', '/login?next=m'],
    ['/m/chats', '/login?next=m'],
    ['/mileage', '/login'],
  ])('ログインしていない人が %s を開くと %s へ送る（電話の画面だけ戻り先の印を付ける）', async (path, login) => {
    fetchSpy.mockImplementation(async () => new Response(null, { status: 401 }))
    currentPath = path
    await render()
    await settle()

    expect(replaceMock).toHaveBeenCalledWith(login)
    expect(host.querySelector('[data-child]')).toBeNull()
  })

  it.each(['suspended', 'archived'] as const)('%s の通常画面を管理画面の停止案内に差し替える', async (status) => {
    fetchSpy.mockImplementation(async () => sessionOk(status))
    currentPath = '/friends'
    await render()
    await settle()

    expect(host.querySelector('[data-child]')).toBeNull()
    expect(host.querySelector('[data-design-node="CXFjb9"]')).not.toBeNull()
    expect(host.textContent).toContain('現在ご利用いただけません')
    expect(host.querySelector('[data-platform-notices]')).not.toBeNull()
  })

  it('停止中でも /hq/support は通常画面へ到達できる', async () => {
    fetchSpy.mockImplementation(async () => sessionOk('suspended'))
    currentPath = '/hq/support'
    await render()
    await settle()

    expect(host.querySelector('[data-child]')).not.toBeNull()
    expect(host.querySelector('[data-design-node="CXFjb9"]')).toBeNull()
  })

  it('停止中の /hq/support は専用シェルを使う', async () => {
    fetchSpy.mockImplementation(async () => sessionOk('suspended'))
    currentPath = '/hq/support'
    await act(async () => {
      root.render(
        <AuthGuard suspendedSupport={<div data-suspended-support>停止中お問い合わせ</div>}>
          <div data-child>通常画面</div>
        </AuthGuard>,
      )
    })
    await settle()

    expect(host.querySelector('[data-suspended-support]')).not.toBeNull()
    expect(host.querySelector('[data-child]')).toBeNull()
  })

  it('停止中は遷移ごとに状態を確認し、activeへ戻れば再ログインせず通常画面へ戻る', async () => {
    fetchSpy.mockImplementation(async () => currentPath === '/friends' ? sessionOk('suspended') : sessionOk('active'))
    currentPath = '/friends'
    await render()
    await settle()
    expect(host.querySelector('[data-design-node="CXFjb9"]')).not.toBeNull()

    currentPath = '/hq'
    await act(async () => { root.render(<AuthGuard><div data-child>通常画面</div></AuthGuard>) })
    await settle()

    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(host.querySelector('[data-child]')).not.toBeNull()
  })
})

/*
 * R505: 古い確認の応答が新しいログインの画面用権限・CSRFを上書きしない。
 *
 * 確認ごとに要求世代と開始時の指紋を持ち、副作用の前に照合する。
 * 古い成功応答は捨て、古い401ではログインへ送らず、新しいログインを
 * 確認し直す。新しい応答が最後なら今の状態を保つ。
 */
describe('R505 古い確認の応答は新しいログインを上書きしない', () => {
  beforeEach(() => {
    currentPath = '/'
    replaceMock.mockReset()
    invalidateAuthSessionCheck()
    storage = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function sessionResponse(opts: { name: string; role: string; csrf: string; permissions?: string[] }) {
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          name: opts.name,
          role: opts.role,
          tenantStatus: 'active',
          permissionKeys: opts.permissions ?? [],
          viewPermissionKeys: [],
        },
        csrfToken: opts.csrf,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  /** 確認の往復だけ保留できる fetch。確認以外（一覧の先取りなど）はすぐ返す。 */
  function holdSessionChecks() {
    const resolvers: Array<(res: Response) => void> = []
    fetchSpy = vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/auth/session')) {
        return new Promise<Response>((resolve) => { resolvers.push(resolve) })
      }
      return sessionOk()
    })
    vi.stubGlobal('fetch', fetchSpy)
    return resolvers
  }

  /** 別タブでBがログインしたことにする（このタブには storage イベントだけ届く）。 */
  function otherTabLoginAsB() {
    storage.setItem('lh_csrf', 'csrf-B')
    storage.setItem('lh_staff_name', 'B担当')
    storage.setItem('lh_staff_role', 'viewer')
    let event: Event
    try {
      event = new StorageEvent('storage', { key: 'lh_csrf' })
    } catch {
      event = new Event('storage')
      Object.defineProperty(event, 'key', { value: 'lh_csrf' })
    }
    act(() => { window.dispatchEvent(event) })
  }

  const responseA = () => sessionResponse({ name: 'A担当', role: 'admin', csrf: 'csrf-A', permissions: ['staff.manage'] })
  const responseB = () => sessionResponse({ name: 'B担当', role: 'viewer', csrf: 'csrf-B', permissions: [] })

  it('別タブのログイン後に届いた古い成功応答は捨て、新しいログインを確認し直す', async () => {
    const resolvers = holdSessionChecks()
    await render()
    await settle()
    expect(resolvers).toHaveLength(1)

    otherTabLoginAsB()

    // 遅れていたAの成功応答が届いても、Bの名前・権限・CSRFを書き戻さない。
    await act(async () => { resolvers[0](responseA()) })
    await settle()
    expect(storage.getItem('lh_csrf')).toBe('csrf-B')
    expect(storage.getItem('lh_staff_name')).toBe('B担当')
    expect(storage.getItem('lh_staff_role')).toBe('viewer')
    expect(replaceMock).not.toHaveBeenCalled()

    // 新しいログインを確認し直す。再確認がBを返せばBで画面を出す。
    expect(resolvers).toHaveLength(2)
    await act(async () => { resolvers[1](responseB()) })
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()
    expect(storage.getItem('lh_staff_name')).toBe('B担当')
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('新しい画面の確認が済んだ後に届いた古い成功応答は捨てる', async () => {
    const resolvers = holdSessionChecks()
    await render()
    await settle()
    expect(resolvers).toHaveLength(1)

    currentPath = '/friends'
    await act(async () => { root.render(<AuthGuard><div data-child>中身</div></AuthGuard>) })
    await settle()
    expect(resolvers).toHaveLength(2)

    await act(async () => { resolvers[1](responseB()) })
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()
    expect(storage.getItem('lh_csrf')).toBe('csrf-B')

    // 取り消された旧画面のAの応答が遅れて届いても、Bを書き戻さない。
    await act(async () => { resolvers[0](responseA()) })
    await settle()
    expect(storage.getItem('lh_csrf')).toBe('csrf-B')
    expect(storage.getItem('lh_staff_name')).toBe('B担当')
    expect(storage.getItem('lh_staff_role')).toBe('viewer')
    expect(host.querySelector('[data-child]')).not.toBeNull()
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('別タブのログイン後に届いた古い401ではログインへ送らず、確認し直す', async () => {
    const resolvers = holdSessionChecks()
    await render()
    await settle()
    expect(resolvers).toHaveLength(1)

    otherTabLoginAsB()

    // 古いAの401が届いても、Bでログイン中の画面をログインへ戻さない。
    await act(async () => { resolvers[0](new Response(null, { status: 401 })) })
    await settle()
    expect(replaceMock).not.toHaveBeenCalledWith('/login')
    expect(resolvers).toHaveLength(2)

    await act(async () => { resolvers[1](responseB()) })
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()
    expect(replaceMock).not.toHaveBeenCalledWith('/login')
  })

  it('新しい確認の応答が最後に届けば今の状態を保つ', async () => {
    const resolvers = holdSessionChecks()
    await render()
    await settle()

    currentPath = '/friends'
    await act(async () => { root.render(<AuthGuard><div data-child>中身</div></AuthGuard>) })
    await settle()

    // 古いAが先に届き、新しいBが後に届けば、最後はBの状態になる。
    await act(async () => { resolvers[0](responseA()) })
    await settle()
    await act(async () => { resolvers[1](responseB()) })
    await settle()
    expect(storage.getItem('lh_csrf')).toBe('csrf-B')
    expect(storage.getItem('lh_staff_name')).toBe('B担当')
    expect(host.querySelector('[data-child]')).not.toBeNull()
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('画面遷移で取り消された旧401はログインへ送らない', async () => {
    const resolvers = holdSessionChecks()
    await render()
    await settle()

    currentPath = '/friends'
    await act(async () => { root.render(<AuthGuard><div data-child>中身</div></AuthGuard>) })
    await settle()

    // 旧画面のAの401が遅れても、新しい画面の確認が生きていれば遷移しない。
    await act(async () => { resolvers[0](new Response(null, { status: 401 })) })
    await settle()
    expect(replaceMock).not.toHaveBeenCalledWith('/login')

    await act(async () => { resolvers[1](responseB()) })
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()
    expect(replaceMock).not.toHaveBeenCalledWith('/login')
  })
})

/* 再読込はモジュールを読み込み直して再現する。sessionStorage は残る。 */
describe('再読込時の認証と利用開始状態の確認', () => {
  let session: MemoryStorage

  beforeEach(() => {
    currentPath = '/'
    replaceMock.mockReset()
    invalidateAuthSessionCheck()
    storage = new MemoryStorage()
    session = new MemoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', session)
    fetchSpy = vi.fn(async () => sessionOk())
    vi.stubGlobal('fetch', fetchSpy)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** 画面の読み直し：描いた木を捨て、モジュールを読み込み直す。sessionStorage と localStorage は残る。 */
  async function reloadPage() {
    act(() => { root.unmount() })
    root = createRoot(host)
    vi.resetModules()
    const fresh = await import('./auth-guard')
    return fresh.default
  }

  /** 確認の往復だけ保留する。 */
  function holdSession() {
    let resolveSession: ((res: Response) => void) | null = null
    fetchSpy.mockImplementation(async (url: unknown) => {
      if (String(url).includes('/api/auth/session')) {
        return new Promise<Response>((resolve) => { resolveSession = resolve })
      }
      return sessionOk()
    })
    return (res: Response) => resolveSession?.(res)
  }

  it('確認済みの印があっても認証が済むまで中身を出さず、失敗したらログインへ送る', async () => {
    await render()
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()
    // 印に秘密（CSRF）をそのまま置かない。
    expect(session.getItem('lh_auth_checked')).not.toBeNull()
    expect(session.getItem('lh_auth_checked')).not.toContain('csrf-token-1')

    const FreshGuard = await reloadPage()
    const resolve = holdSession()
    currentPath = '/friends'
    await act(async () => { root.render(<FreshGuard><div data-child>中身</div></FreshGuard>) })
    await settle()

    expect(host.querySelector('[data-child]')).toBeNull()
    expect(host.querySelector('[data-auth-pending]')).not.toBeNull()
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/auth/session'))).toBe(true)

    await act(async () => { resolve(new Response(null, { status: 401 })) })
    await settle()
    expect(replaceMock).toHaveBeenCalledWith('/login')
    // 失敗した印は捨てる（次の読み直しでは待つ）。
    expect(session.getItem('lh_auth_checked')).toBeNull()
  })

  it('前回の認証印が通常利用でも、新たに利用開始前なら通常画面を表示しない', async () => {
    await render()
    await settle()
    const FreshGuard = await reloadPage()
    const resolve = holdSession()
    currentPath = '/hq'
    await act(async () => { root.render(<FreshGuard><div data-child>中身</div></FreshGuard>) })
    await settle()
    expect(host.querySelector('[data-child]')).toBeNull()
    expect(host.querySelector('[data-auth-pending]')).not.toBeNull()

    await act(async () => { resolve(sessionOk('active', {
      status: 'awaiting_first_line', quoteId: null, consentedAt: null,
    })) })
    await settle()
    expect(replaceMock).toHaveBeenCalledWith('/hq/onboarding/pricing')
    expect(host.querySelector('[data-child]')).toBeNull()
  })

  it('再読込時に停止中と分かれば停止の画面に進む', async () => {
    await render()
    await settle()

    const FreshGuard = await reloadPage()
    const resolve = holdSession()
    currentPath = '/friends'
    await act(async () => { root.render(<FreshGuard><div data-child>中身</div></FreshGuard>) })
    await settle()
    expect(host.querySelector('[data-child]')).toBeNull()
    expect(host.querySelector('[data-auth-pending]')).not.toBeNull()

    await act(async () => { resolve(sessionOk('suspended')) })
    await settle()
    expect(host.querySelector('[data-child]')).toBeNull()
    expect(host.querySelector('[data-design-node="CXFjb9"]')).not.toBeNull()
    // 停止中は印を残さない（次も確かめてから出す）。
    expect(session.getItem('lh_auth_checked')).toBeNull()
  })

  it('印が無ければ、確認が済むまで骨組みで待ち中身を出さない', async () => {
    const FreshGuard = await reloadPage()
    const resolve = holdSession()
    await act(async () => { root.render(<FreshGuard><div data-child>中身</div></FreshGuard>) })
    await settle()

    expect(host.querySelector('[data-child]')).toBeNull()
    expect(host.querySelector('[data-auth-pending]')).not.toBeNull()

    await act(async () => { resolve(sessionOk()) })
    await settle()
    expect(host.querySelector('[data-child]')).not.toBeNull()
    expect(host.querySelector('[data-auth-pending]')).toBeNull()
  })

  it('指紋が違えば（別のログイン・権限の更新）印を使わず待つ', async () => {
    await render()
    await settle()
    expect(session.getItem('lh_auth_checked')).not.toBeNull()

    storage.setItem('lh_csrf', 'csrf-other-login')
    const FreshGuard = await reloadPage()
    holdSession()
    currentPath = '/friends'
    await act(async () => { root.render(<FreshGuard><div data-child>中身</div></FreshGuard>) })
    await settle()

    expect(host.querySelector('[data-child]')).toBeNull()
    expect(host.querySelector('[data-auth-pending]')).not.toBeNull()
  })

  it('期限（30分）を過ぎた印は使わず待つ', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    let now = 5_000_000
    nowSpy.mockImplementation(() => now)
    await render()
    await settle()

    now += 31 * 60_000
    const FreshGuard = await reloadPage()
    holdSession()
    await act(async () => { root.render(<FreshGuard><div data-child>中身</div></FreshGuard>) })
    await settle()

    expect(host.querySelector('[data-child]')).toBeNull()
    expect(host.querySelector('[data-auth-pending]')).not.toBeNull()
  })

  it('401の合図・別タブのログアウトで印を捨てる', async () => {
    await render()
    await settle()
    expect(session.getItem('lh_auth_checked')).not.toBeNull()

    act(() => { window.dispatchEvent(new Event(SESSION_LOST_EVENT)) })
    expect(session.getItem('lh_auth_checked')).toBeNull()

    // もう一度通してから、別タブのログアウト（lh_csrf の書き換え）。
    currentPath = '/friends'
    await act(async () => { root.render(<AuthGuard><div data-child>中身</div></AuthGuard>) })
    await settle()
    expect(session.getItem('lh_auth_checked')).not.toBeNull()
    let event: Event
    try {
      event = new StorageEvent('storage', { key: 'lh_csrf' })
    } catch {
      event = new Event('storage')
      Object.defineProperty(event, 'key', { value: 'lh_csrf' })
    }
    act(() => { window.dispatchEvent(event) })
    expect(session.getItem('lh_auth_checked')).toBeNull()
  })
})
