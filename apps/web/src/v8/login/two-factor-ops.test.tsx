// @vitest-environment happy-dom
import { trustedChallengeUrl } from '@/test-utils/trusted-auth-handoff'
import React, { act, type ReactNode } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startAuthentication } from '@simplewebauthn/browser'

import TwoFactorLoginPage from '@/app/login/two-factor/page'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/*
 * ★V8-B 運営 ログイン 2段目。入口の分け方を見張る：
 * 運営も管理画面もV8の6桁入力に固定し、運営の戻り先と権限確認は区別する。
 */
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/login/two-factor',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: 'テスト統括' }) }))
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn(async () => ({ id: 'key-1' })) }))

let host: HTMLDivElement
let root: Root

async function open(url: string, theme: 'v7' | 'v8') {
  window.history.replaceState(null, '', trustedChallengeUrl(url))
  document.documentElement.dataset.theme = theme
  await act(async () => { root.render(<TwoFactorLoginPage />) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}

beforeEach(() => {
  sessionStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
})

describe('運営 ログイン 2段目（V8 の入口）', () => {
  it('登録済みの統括と運営はパスキーを先に表示し、認証アプリへ切り替えられる', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { available: true } }), { status: 200 })))
    try {
      await open('/login/two-factor?next=ops#lh_2fa=challenge-1&lh_method=password', 'v8')
      expect(host.textContent).toContain('パスキーで確認')
      expect(host.textContent).toContain('パスキーで認証する')
      const switchMethod = [...host.querySelectorAll('button')].find(button => button.textContent === '認証アプリで確認')
      await act(async () => { switchMethod?.click() })
      expect(host.textContent).toContain('6桁の確認')
      expect(host.textContent).toContain('パスキーを使う')
    } finally { vi.unstubAllGlobals() }
  })
  it('パスキー確認後も運営権限を確かめてからコンソールへ進む', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      const data = url.endsWith('/passkeys/login/options')
        ? { success: true, data: { available: true, options: { challenge: 'fixture' }, challengeToken: 'passkey-challenge' } }
        : url.endsWith('/passkeys/login/verify')
          ? { success: true, data: { sessionToken: 'session-1' }, csrfToken: 'csrf-1' }
          : { success: true, data: { platformAdmin: true } }
      return new Response(JSON.stringify(data), { status: 200 })
    }))
    try {
      await open('/login/two-factor?next=ops#lh_2fa=challenge-1&lh_method=password', 'v8')
      const submit = [...host.querySelectorAll('button')].find(button => button.textContent === 'パスキーで認証する')
      await act(async () => { submit?.click(); await new Promise(resolve => setTimeout(resolve, 10)) })
      expect(startAuthentication).toHaveBeenCalled()
      expect(calls.some(url => url.endsWith('/passkeys/login/verify'))).toBe(true)
      expect(calls.some(url => url.endsWith('/api/auth/session'))).toBe(true)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
      expect(assign).toHaveBeenCalledTimes(1)
    } finally { assign.mockRestore(); vi.unstubAllGlobals() }
  })
  it('パスキーの失敗は日本語で知らせ、再試行で確認を完了できる', async () => {
    const previousApiUrl = process.env.NEXT_PUBLIC_API_URL
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    let verifies = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/passkeys/login/options')) return new Response(JSON.stringify({ success: true, data: { available: true, options: { challenge: 'fixture' }, challengeToken: 'passkey-challenge' } }), { status: 200 })
      if (url.endsWith('/passkeys/login/verify') && ++verifies === 1) return new Response(JSON.stringify({ success: false, error: 'API error: 503' }), { status: 503 })
      return new Response(JSON.stringify(url.endsWith('/api/auth/session') ? { success: true, data: { platformAdmin: true } } : { success: true, data: { sessionToken: 'session-1' }, csrfToken: 'csrf-1' }), { status: 200 })
    }))
    try {
      await open('/login/two-factor?next=ops#lh_2fa=challenge-1&lh_method=password', 'v8')
      const submit = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'パスキーで認証する')!
      await act(async () => { submit().click(); await new Promise(resolve => setTimeout(resolve, 10)) })
      const reason = host.querySelector('[role="alert"]')?.textContent ?? ''
      expect(reason).toMatch(/[ぁ-んァ-ヶ一-龠]/)
      expect(reason).not.toContain('API error')
      expect(submit().disabled).toBe(false)
      await act(async () => { submit().click(); await new Promise(resolve => setTimeout(resolve, 500)) })
      expect(verifies).toBe(2)
      expect(assign).toHaveBeenCalledTimes(1)
    } finally {
      assign.mockRestore(); vi.unstubAllGlobals()
      if (previousApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL
      else process.env.NEXT_PUBLIC_API_URL = previousApiUrl
    }
  })
  it('V8 で運営から来たら「6桁の確認」を出し、6桁が入るまでログインを止める', async () => {
    await open('/login/two-factor?next=ops#lh_2fa=challenge-1&lh_method=password', 'v8')
    expect(host.querySelector('[data-design-node="tOPeY"]')).not.toBeNull()
    expect(host.textContent).toContain('6桁の確認')
    expect(host.querySelector('button[aria-label="6桁の確認の説明"]')).toBeNull()
    expect(host.textContent).toContain('パスワードを確かめました。')
    expect(host.textContent).toContain('認証アプリが使えないときは、運営のオーナーに連絡してください。')
    const login = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('ログイン'))
    expect(login?.hasAttribute('disabled')).toBe(true)
    expect(host.textContent).toContain('認証アプリに出ている6桁を入れてください。')
  })

  it('LINEで認証したときは、パスワードを確認したとは案内しない', async () => {
    await open('/login/two-factor?next=ops#lh_2fa=challenge-1&lh_method=line', 'v8')
    expect(host.textContent).toContain('LINEでのログインを確かめました。')
    expect(host.textContent).not.toContain('パスワードを確かめました。')
  })

  it('認証の情報が無いときは、確認済みの案内を出さずログインのやり直しを案内する', async () => {
    await open('/login/two-factor?next=ops', 'v8')
    expect(host.textContent).toContain('ログインの情報が見つかりませんでした。')
    expect(host.textContent).not.toContain('パスワードを確かめました。')
  })

  it('管理画面の2段目もV8で出し、LINEでのログイン方法を保つ', async () => {
    await open('/login/two-factor#lh_2fa=challenge-1', 'v8')
    expect(host.textContent).toContain('二段階認証')
    // 頭は公式ロゴだけを表示し、段数と店舗名は混ぜない。
    expect(host.querySelector('[data-auth-head] img')?.getAttribute('src')).toBe('/brand/musubo-color-188-1x.png')
    expect(host.querySelector('[data-auth-head]')?.textContent).not.toContain('テスト統括')
    expect(host.querySelector('[data-auth-head]')?.textContent).not.toContain('2 / 2')
    const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'コードが使えない場合')
    await act(async () => { toggle?.click() })
    expect(host.textContent).toContain('別のLINEアカウントでログイン')
  })

  it('旧テーマ属性が残っても運営はV8で出す', async () => {
    await open('/login/two-factor?next=ops#lh_2fa=challenge-1', 'v7')
    expect(host.textContent).toContain('6桁の確認')
    expect(host.querySelector('[data-design-node="tOPeY"]')).not.toBeNull()
  })
})

describe('二段階認証の6桁（自動で確かめる・間違い・戻る）', () => {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  })
  let bodies: Array<Record<string, unknown>> = []
  let verifyAnswer: () => Response

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
    bodies = []
    verifyAnswer = () => json({ success: true, data: { sessionToken: 'session-1' }, csrfToken: 'csrf-1' })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/auth/two-factor/verify')) {
        if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return verifyAnswer()
      }
      return json({ success: false, error: 'unexpected' }, 500)
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function openAdmin() {
    await open('/login/two-factor#lh_2fa=challenge-1&lh_method=password', 'v8')
  }

  function slots() {
    return [...host.querySelectorAll('input[aria-label$="桁目"]')] as HTMLInputElement[]
  }

  it('6桁そろうと押さずに確かめ、正しいコードでログインへ進む', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
    let answer: (response: Response) => void = () => {}
    verifyAnswer = () => new Promise<Response>((resolve) => { answer = resolve }) as unknown as Response
    try {
      await openAdmin()
      await act(async () => {
        fireEvent.change(slots()[0], { target: { value: '482917' } })
        await Promise.resolve()
      })
      expect(bodies[0]).toMatchObject({ challengeToken: 'challenge-1', code: '482917' })
      // 確かめ中：6 マスは数字を残したまま、ボタンは緑のまま回る印と「確かめています…」。
      expect(slots().map((input) => input.value).join('')).toBe('482917')
      const button = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-busy') === 'true')
      expect(button?.textContent).toBe('確かめています…')
      expect(host.textContent).toContain('確かめています…')
      await act(async () => {
        answer(json({ success: true, data: { sessionToken: 'session-1' }, csrfToken: 'csrf-1' }))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      // 通った：枠は緑（data-state）、下の 1 行とボタンが「開いています」。✓ はマスのそばに出さない。
      expect(host.querySelector('[role="group"][data-state="success"]')).not.toBeNull()
      expect(host.textContent).toContain('確認できました。開いています…')
      expect([...host.querySelectorAll('button')].some((b) => b.textContent === '開いています')).toBe(true)
      expect(host.querySelector('[role="group"] svg')).toBeNull()
      expect(slots().map((input) => input.value).join('')).toBe('482917')
      expect(host.querySelector('[role="status"]')?.textContent).toBe('確認できました')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)) })
      expect(assign).toHaveBeenCalledTimes(1)
      expect(String(assign.mock.calls[0][0])).toContain('lh_session=session-1')
    } finally {
      assign.mockRestore()
    }
  })

  it('入れ終わるまでは主ボタンを押せない形を保ち、理由行なしで6桁目に自動でログインする', async () => {
    await openAdmin()
    const submit = () => [...host.querySelectorAll('button')].find((button) => button.textContent === '確認してログイン') as HTMLButtonElement | undefined
    const reason = () => host.querySelector('#ops-two-factor-submit-reason')
    expect(submit()?.disabled).toBe(true)
    expect(reason()).toBeNull()
    expect(submit()?.getAttribute('aria-describedby')).toBeNull()
    verifyAnswer = () => new Promise<Response>(() => {}) as unknown as Response
    await act(async () => {
      fireEvent.change(slots()[0], { target: { value: '482917' } })
      await Promise.resolve()
    })
    // 6 桁目で自動で確かめ始めても、理由の行は出さない。
    expect(bodies[0]).toMatchObject({ code: '482917' })
    expect(reason()).toBeNull()
  })

  it('間違えると赤い理由を出し、四角を空にして1つ目へ戻る', async () => {
    verifyAnswer = () => json({ success: false, error: '認証コードが正しくありません' }, 400)
    await openAdmin()
    await act(async () => {
      fireEvent.change(slots()[0], { target: { value: '000000' } })
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('コードが違います。今の数字を入れ直してください。')
    expect(slots().map((input) => input.value).join('')).toBe('')
    expect(document.activeElement).toBe(slots()[0])
  })

  it('コードが使えない場合は別アカウントへの戻り道だけを示す', async () => {
    await openAdmin()
    const back = [...host.querySelectorAll('a')].find((link) => link.textContent === '別のアカウントで入る')
    expect(back?.getAttribute('href')).toBe('/login')
    const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'コードが使えない場合')
    await act(async () => { toggle?.click() })
    expect(host.textContent).not.toContain('回復コード')
    expect(slots()).toHaveLength(6)
  })
})
