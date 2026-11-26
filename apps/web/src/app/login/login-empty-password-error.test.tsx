// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LoginPage from './page'

/*
 * R613: /login で空パスワードのまま送信すると「パスワードを入力してください」が出る。
 * その後パスワードを入力しても古い案内が残り、入力が認識されない誤解を招く。
 *   - 空パスワードの案内はパスワード入力が始まったら消す
 *   - 認証失敗など別原因の表示は次の送信まで残す
 */

const fixture = vi.hoisted(() => ({
  bodies: [] as Array<Record<string, unknown>>,
  loginResponse: { success: true, data: { twoFactorSetup: true, challengeToken: 'setup-tok-1' }, csrfToken: 'csrf-1' } as Record<string, unknown>,
  loginStatus: 200,
}))

vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => '/login',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: 'テスト統括' }) }))
vi.mock('@/lib/auth-email', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/auth-email')>(),
  TURNSTILE_SITE_KEY: 'fixture-public-site-key',
}))
vi.mock('@/components/auth/turnstile', () => ({ default: function VerifiedTurnstile({ onToken }: { onToken: (token: string) => void }) {
  React.useEffect(() => { onToken('fixture-turnstile-token') }, [onToken])
  return null
} }))

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
})

let host: HTMLDivElement
let root: Root

function flush(): Promise<void> {
  return act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  fixture.bodies = []
  fixture.loginResponse = { success: true, data: { twoFactorSetup: true, challengeToken: 'setup-tok-1' }, csrfToken: 'csrf-1' }
  fixture.loginStatus = 200
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  window.history.replaceState(null, '', '/login')
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (init?.body) fixture.bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    if (url.endsWith('/api/auth/password/login')) return json(fixture.loginResponse, fixture.loginStatus)
    if (url.endsWith('/api/auth/session')) return json({ success: true, data: { id: 's1', name: 'x' }, csrfToken: 'c' })
    return json({ success: false, error: 'unexpected' }, 500)
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => { root.render(<LoginPage />) })
  await flush()
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function type(id: string, value: string) {
  const input = host.querySelector(id) as HTMLInputElement
  await act(async () => { setInput(input, value) })
  await flush()
}

async function submit() {
  const form = host.querySelector('form')!
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
}

function alertText(): string | null {
  return host.querySelector('[role="alert"]')?.textContent ?? null
}

describe('R613: 空パスワードの古い案内を消す', () => {
  it('認証前には会社名を出さず公式ロゴを表示する', async () => {
    await render()
    expect(host.querySelector('[data-auth-head] img')?.getAttribute('src')).toBe('/brand/musubo-color-188-1x.png')
    expect(host.querySelector('[data-auth-head]')?.textContent).not.toContain('テスト統括')
  })

  it('空パスワードで送信した案内は、パスワード入力が始まったら消える', async () => {
    await render()
    await type('#login-email', 'owner@example.com')
    await submit()

    expect(alertText()).toBe('失敗：パスワードを入力してください')

    await type('#login-password', 'A')
    expect(alertText()).toBeNull()
  })

  it('認証失敗の表示はパスワード入力だけでは消えず、次の送信まで残る', async () => {
    fixture.loginResponse = { success: false, error: 'メールアドレスまたはパスワードが正しくありません' }
    await render()
    await type('#login-email', 'owner@example.com')
    await type('#login-password', 'Wrongpass1')
    await submit()

    expect(alertText()).toBe('失敗：メールアドレスまたはパスワードが正しくありません')

    await type('#login-password', 'Wrongpass2')
    expect(alertText()).toBe('失敗：メールアドレスまたはパスワードが正しくありません')
  })

  it('サーバーエラー(503)の表示もパスワード入力だけでは消えず、次の送信まで残る', async () => {
    // 監査 247-005 の状態方針: 503 など通信・サーバー側の失敗の表示は
    // 意図どおり残す。消すのは空パスワードの案内だけ。
    fixture.loginStatus = 503
    fixture.loginResponse = { success: false, error: 'しばらくしてからもう一度お試しください' }
    await render()
    await type('#login-email', 'owner@example.com')
    await type('#login-password', 'Correct1')
    await submit()

    expect(alertText()).toBe('失敗：しばらくしてからもう一度お試しください')

    await type('#login-password', 'Correct2')
    expect(alertText()).toBe('失敗：しばらくしてからもう一度お試しください')
  })
})

it.each(['/login', '/login?next=m'])('ログインの題の下に重複する説明を出さず入力と操作は残す: %s', async (path) => {
  window.history.replaceState(null, '', path)
  await render()
  expect(host.querySelector('h1')?.textContent).toBe('ログイン')
  expect(host.textContent).not.toContain('メールアドレスとパスワードでログインします。')
  expect(host.textContent).not.toContain('LINE で登録した人は')
  expect(host.querySelector('label[for="login-email"]')?.textContent).toBe('メールアドレス')
  expect(host.querySelector('#login-password')).not.toBeNull()
  expect(host.querySelector('button[type="submit"]')).not.toBeNull()
  expect(fixture.bodies).toEqual([])
})

it('入力不足のログインは押せないまま、入力を促す理由行は出さない', async () => {
  await render()
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')
  expect(submit?.disabled).toBe(true)
  expect(submit?.getAttribute('aria-describedby')).toBeNull()
  expect(host.querySelector('[data-auth-submit-reason]')).toBeNull()
  expect(host.textContent).not.toContain('入れると押せます')
  expect(fixture.bodies).toEqual([])
})
