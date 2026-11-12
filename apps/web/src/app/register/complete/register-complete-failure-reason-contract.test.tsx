// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let RegisterCompletePage: React.ComponentType

beforeAll(async () => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  ;({ default: RegisterCompletePage } = await import('./page'))
})

/*
 * M045: 本登録の完了送信が 503 { success:false, error:'audit_unavailable' } で
 * 返っても、生の audit_unavailable を出さず、日本語の失敗理由と再試行案内を出す。
 * 入力値は保持し、busy を戻す。400 検証・2FA/成功の既存仕様は保つ。
 */

const fixture = vi.hoisted(() => ({
  completeResponse: { ok: false, status: 503, error: 'audit_unavailable' } as {
    ok: boolean; status: number; data?: Record<string, unknown>; error?: string; errors?: Record<string, string>; csrfToken?: string
  },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('token=reg-token-1'),
  usePathname: () => '/register/complete',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/lib/auth-email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-email')>()
  return {
    ...actual,
    authRequest: vi.fn(async (path: string) => {
      if (path.startsWith('/api/auth/register/check')) {
        return { ok: true, status: 200, data: { email: 'new@example.com', trialDays: 30, companyName: 'テスト統括', contactName: '見本 141' } }
      }
      return fixture.completeResponse
    }),
    readDeviceMarker: () => 'dm-0',
    storeDeviceMarker: () => {},
  }
})

let host: HTMLDivElement
let root: Root

function setInput(selector: string, value: string) {
  const el = host.querySelector(selector) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function submitForm() {
  await act(async () => {
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  fixture.completeResponse = { ok: false, status: 503, error: 'audit_unavailable' }
  window.sessionStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('本登録の失敗理由案内（M045）', () => {
  it('503 audit_unavailable は生コードを出さず日本語の理由と再試行案内を出す', async () => {
    await act(async () => { root.render(<RegisterCompletePage />) })
    await act(async () => { await Promise.resolve() })
    expect(host.querySelector('#complete-tenant')?.textContent).toBe('テスト統括')
    expect(host.querySelector('#complete-name')?.textContent).toBe('見本 141')
    expect(host.querySelectorAll('#complete-tenant input, #complete-name input')).toHaveLength(0)
    setInput('#complete-password', 'StrongPass123!')
    setInput('#complete-confirm', 'StrongPass123!')
    await submitForm()

    const alert = host.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).not.toContain('audit_unavailable')
    expect(alert).toContain('もう一度お試しください')
    // 入力値は保持される。
    expect(host.querySelector('#complete-tenant')?.textContent).toBe('テスト統括')
    expect((host.querySelector('#complete-password') as HTMLInputElement).value).toBe('StrongPass123!')
    // busy が戻り、再送信できる。
    expect(host.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(false)
  })

  it('429 のコードのみは混雑の待ち案内を出す', async () => {
    fixture.completeResponse = { ok: false, status: 429, error: 'rate_limited' }
    await act(async () => { root.render(<RegisterCompletePage />) })
    await act(async () => { await Promise.resolve() })
    setInput('#complete-password', 'StrongPass123!')
    setInput('#complete-confirm', 'StrongPass123!')
    await submitForm()

    const alert = host.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).not.toContain('rate_limited')
    expect(alert).toContain('少し待ってから')
  })
})
