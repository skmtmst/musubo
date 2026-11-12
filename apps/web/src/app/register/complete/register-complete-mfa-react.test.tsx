// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureTwoFactorChallenge } from '@/lib/admin-session'

import RegisterCompletePage from './page'

/*
 * N-426: 会員登録の完了直後の分岐。
 *   - 新しいオーナーは二段階認証が必須 → twoFactorSetup 応答なら設定画面へ合言葉付きで進む
 *     （セッションはまだ発行しない。/hq へは行かない）
 *   - 必須でない応答（twoFactorSetup なし）なら従来どおりセッションを受け取り /hq へ
 */

const fixture = vi.hoisted(() => ({
  completeResponse: {
    ok: true,
    data: { tenantId: 't1', deviceMarker: 'dm-1', twoFactorSetup: true, challengeToken: 'setup-tok-9' },
    csrfToken: 'csrf-1',
  } as { ok: boolean; data?: Record<string, unknown>; error?: string; errors?: Record<string, string>; csrfToken?: string },
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
        return { ok: true, data: { email: 'new@example.com', trialDays: 30, companyName: '株式会社テスト', contactName: '見本 141' } }
      }
      return fixture.completeResponse
    }),
    readDeviceMarker: () => 'dm-0',
    storeDeviceMarker: () => {},
  }
})

let host: HTMLDivElement
let root: Root

function flush(): Promise<void> {
  return act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  fixture.completeResponse = {
    ok: true,
    data: { tenantId: 't1', deviceMarker: 'dm-1', twoFactorSetup: true, challengeToken: 'setup-tok-9' },
    csrfToken: 'csrf-1',
  }
  window.sessionStorage.clear()
  const memoryStore = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memoryStore.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryStore.set(key, String(value)),
    removeItem: (key: string) => void memoryStore.delete(key),
    clear: () => memoryStore.clear(),
  })
  window.history.replaceState(null, '', '/register/complete?token=reg-token-1')
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
  await act(async () => { root.render(<RegisterCompletePage />) })
  await flush()
}

async function fillAndSubmit() {
  const setValue = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const inputs = host.querySelectorAll('input')
  const passwords = [...inputs].filter((i) => i.type === 'password')
  expect(host.querySelector('#complete-tenant')?.textContent).toBe('株式会社テスト')
  expect(host.querySelector('#complete-name')?.textContent).toBe('見本 141')
  await act(async () => {
    setValue(passwords[0], 'StrongPass123!')
    setValue(passwords[1], 'StrongPass123!')
  })
  const form = host.querySelector('form')!
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await flush()
}

describe('N-426: 登録完了直後の二段階設定への分岐', () => {
  it('twoFactorSetup 応答なら /hq へは行かず、設定画面へ合言葉付きで進む', async () => {
    await render()
    await fillAndSubmit()
    expect(window.location.pathname).toBe('/login/two-factor/setup')
    expect(window.location.search).toBe('')
    expect(new URLSearchParams(window.location.hash.slice(1)).get('lh_2fa')).toBe('setup-tok-9')
    expect(new URLSearchParams(window.location.hash.slice(1)).get('lh_nonce')).toMatch(/^[0-9a-f-]{36}$/)
    expect(captureTwoFactorChallenge()).toBe('setup-tok-9')
    expect(window.sessionStorage.getItem('lh_admin_session_fallback')).toBeNull()
  })

  it('新料金の申込は二段階認証後に料金確認へ進む印を引き継ぐ', async () => {
    fixture.completeResponse = { ...fixture.completeResponse,
      data: { ...fixture.completeResponse.data, newPricingFlow: true } }
    await render()
    await fillAndSubmit()
    expect(window.location.pathname).toBe('/login/two-factor/setup')
    expect(window.location.search).toBe('?next=musubo-pricing')
  })

  it('従来の申込はセッションを受け取り統括へ進む', async () => {
    fixture.completeResponse = {
      ok: true,
      data: { tenantId: 't1', deviceMarker: 'dm-1', sessionToken: 'sess-9' },
      csrfToken: 'csrf-2',
    }
    await render()
    await fillAndSubmit()
    expect(window.location.pathname).toBe('/hq')
    expect(window.sessionStorage.getItem('lh_admin_session_fallback')).toBe('sess-9')
  })

  it('新料金の申込で二段階設定が不要なら料金確認へ進む', async () => {
    fixture.completeResponse = { ok: true,
      data: { tenantId: 't1', deviceMarker: 'dm-1', newPricingFlow: true, sessionToken: 'sess-9' },
      csrfToken: 'csrf-2' }
    await render()
    await fillAndSubmit()
    expect(window.location.pathname).toBe('/hq/onboarding/pricing')
  })

  it('M045: csrf保存に失敗しても登録は進む（止まらない）', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key === 'lh_csrf') throw new Error('QuotaExceededError')
        store.set(key, String(value))
      },
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    })
    fixture.completeResponse = {
      ok: true,
      data: { tenantId: 't1', deviceMarker: 'dm-1' },
      csrfToken: 'csrf-2',
    }
    await render()
    await fillAndSubmit()
    expect(window.location.pathname).toBe('/hq')
  })
})
