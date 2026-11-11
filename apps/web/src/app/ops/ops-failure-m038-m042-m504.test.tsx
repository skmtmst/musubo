// @vitest-environment happy-dom
import React, { act } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import OpsAnnouncementsPage from './announcements/page'
import OpsInvitePage from './invite/page'
import OpsLoginPage from './login/page'
import OpsTwoFactorPage from './two-factor/page'
import OpsTenantsPage from './tenants/page'
import { qrToDataURL } from '@/lib/qr-image'

vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  usePathname: () => '/ops/announcements',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: 'musubo' }) }))
vi.mock('@/lib/auth-email', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth-email')>(),
  TURNSTILE_SITE_KEY: 'fixture-public-site-key',
}))
vi.mock('@/components/auth/turnstile', () => ({ default: function VerifiedTurnstile({ onToken }: { onToken: (token: string) => void }) {
  React.useEffect(() => { onToken('fixture-turnstile-token') }, [onToken])
  return null
} }))
vi.mock('@/lib/qr-image', () => ({ qrToDataURL: vi.fn() }))

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

const src = (...parts: string[]) => readFileSync(join(process.cwd(), 'src', ...parts), 'utf8')
const ANN = src('v8', 'ops', 'announcements.tsx')
const LOG = src('v8', 'ops', 'login.tsx')
const TEN = src('v8', 'ops', 'tenants.tsx')
const TFA = src('v8', 'ops', 'two-factor.tsx')

/**
 * M038・M042・M039・M041・M504 の失敗表示の契約。
 * 一覧の読み込み失敗は捕まえた失敗をそのまま ListState へ渡し、
 * 403 で再試行を隠し・429 で待ち案内にする。再読み込みの口は残す。
 */

describe('M038/M042 一覧の403契約（ソース）', () => {
  it('M038 お知らせは捕まえた失敗を ListState へ渡して読み直す', () => {
    expect(ANN).toContain('setLoadError(caught)')
    expect(ANN).toContain('error={loadError ?? undefined}')
    expect(ANN).toContain('description={loadDescription(loadError)}')
    expect(ANN).toContain('onRetry={() => void load()}')
  })

  it('M042 契約先は捕まえた失敗を ListState へ渡して読み直す', () => {
    expect(TEN).toContain('setListLoadError(caught)')
    expect(TEN).toContain('error={listLoadError ?? undefined}')
    expect(TEN).toContain('description={loadDescription(listLoadError)}')
    expect(TEN).toContain('onRetry={() => void load()}')
  })
})

describe('M039/M041/M504 の契約（ソース）', () => {
  it.each([503, 404, 410])('招待の確認失敗%sを一時的な失敗と使えない招待に分ける', async status => {
    window.history.replaceState(null, '', '/ops/invite#invite=test-token')
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes('/api/auth/ops-invite/check')) {
        return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      calls += 1
      const body = calls === 1
        ? { success: false, error: '招待を確認できません', code: status === 410 ? 'expired' : undefined }
        : { success: true, data: { email: 'ops@example.com', name: '運営 太郎', needsPassword: false } }
      return new Response(JSON.stringify(body), { status: calls === 1 ? status : 200, headers: { 'Content-Type': 'application/json' } })
    }))
    await act(async () => { root.render(<OpsInvitePage />) })
    await flush()
    const retry = retryButton()
    if (status === 503) {
      expect(retry).toBeTruthy()
      await act(async () => { retry!.click() })
      await flush()
      expect(calls).toBe(2)
      expect(host.querySelector('#ops-invite-email')).not.toBeNull()
    } else {
      expect(retry).toBeUndefined()
      expect(host.textContent).toContain('運営のログインへ')
      expect(calls).toBe(1)
    }
  })

  it('M041 ログインの csrf 保存は投げても固まらない', () => {
    expect(LOG).toContain("try { localStorage.setItem('lh_csrf', res.csrfToken) } catch")
  })

  it('M504 二段階認証のQR失敗は表示し直しの口を出す', () => {
    expect(TFA).toContain('qrFailed')
    expect(TFA).toContain('QRをもう一度表示する')
    expect(TFA).toContain('もう一度読み込む')
  })
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() })
}

async function waitMs(ms: number) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)) })
}

const retryButton = () =>
  Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('もう一度読み込む'))

describe('M038 お知らせの403（動作）', () => {
  it('403では権限の案内を出し、再読み込みの口を出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/ops/announcements/preview')) {
        return new Response(JSON.stringify({ success: true, data: { tenants: 1, staff: 1, lineLinked: 1, withEmail: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.endsWith('/api/ops/announcements')) {
        return new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    await act(async () => { root.render(<OpsAnnouncementsPage />) })
    await flush()

    expect(host.querySelector('[data-list-state="error"]')).not.toBeNull()
    expect(host.textContent).toContain('権限')
    expect(retryButton()).toBeTruthy()
  })
})

describe('M042 契約先の403（動作）', () => {
  it('403では権限の案内を出し、再読み込みの口を出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ops/tenants')) {
        return new Response(JSON.stringify({ success: false, error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    await act(async () => { root.render(<OpsTenantsPage />) })
    await flush()

    expect(host.querySelector('[data-list-state="error"]')).not.toBeNull()
    expect(host.textContent).toContain('権限')
    expect(retryButton()).toBeTruthy()
  })
})

describe('M039 招待の確認失敗（動作）', () => {
  it('通信断でも読み直しの口から確認をやり直せる', async () => {
    window.history.replaceState(null, '', '/ops/invite#invite=test-token')
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/auth/ops-invite/check')) {
        calls += 1
        if (calls === 1) throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify({ success: true, data: { email: 'ops@example.com', name: '運営 太郎', needsPassword: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    await act(async () => { root.render(<OpsInvitePage />) })
    await flush()

    expect(host.querySelector('[data-list-state="error"]')).not.toBeNull()
    const retry = retryButton()
    expect(retry).not.toBeUndefined()
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()

    expect(calls).toBe(2)
    expect(host.querySelector('#ops-invite-email')).not.toBeNull()
  })
})

describe('M041 ログインのcsrf保存失敗（動作）', () => {
  it('保存に投げても固まらず運営コンソールへ進む', async () => {
    const realStorage = window.localStorage
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: () => null,
        setItem: () => { throw new Error('denied') },
        removeItem: () => {},
        clear: () => {},
        get length() { return 0 },
        key: () => null,
      },
      configurable: true,
    })
    try {
      window.history.replaceState(null, '', '/ops/login')
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/auth/password/login')) {
          return new Response(JSON.stringify({ success: true, data: {}, csrfToken: 'csrf-1' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.includes('/api/auth/session')) {
          return new Response(JSON.stringify({ data: { platformAdmin: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }))
      await act(async () => { root.render(<OpsLoginPage />) })
      const email = host.querySelector('#ops-login-email') as HTMLInputElement
      const password = host.querySelector('#ops-login-password') as HTMLInputElement
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
        setter.call(email, 'ops@example.com'); email.dispatchEvent(new Event('input', { bubbles: true }))
        setter.call(password, 'Abcdefg1'); password.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => {
        host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await Promise.resolve()
      })
      await flush()

      expect(window.location.pathname).toBe('/ops')
    } finally {
      Object.defineProperty(window, 'localStorage', { value: realStorage, configurable: true })
      window.history.replaceState(null, '', '/ops/login')
    }
  })
})

describe('M504 QRの表示失敗（動作）', () => {
  it('QRを作れなくても表示し直しの口を出す', async () => {
    vi.mocked(qrToDataURL).mockRejectedValueOnce(new Error('offline'))
    vi.mocked(qrToDataURL).mockResolvedValue('data:image/png;base64,AAA')
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    window.history.replaceState(null, '', '/ops/two-factor')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/auth/session')) {
        return new Response(JSON.stringify({ success: true, data: { id: 's1', name: '運営 太郎', platformAdmin: true }, csrfToken: 'csrf-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('two-factor/setup')) {
        return new Response(JSON.stringify({ success: true, data: { provisioningUri: 'otpauth://totp/musubo?secret=ABC123', manualKey: 'ABC123' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ success: true, data: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    await act(async () => { root.render(<OpsTwoFactorPage />) })
    await flush()

    const qrRetry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('QRをもう一度表示する'))
    expect(qrRetry).not.toBeUndefined()
    await act(async () => {
      qrRetry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()

    expect(host.querySelector('img[alt="認証アプリ登録用のQRコード"]')).not.toBeNull()
  })
})
