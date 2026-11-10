// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RegisterCompletePage from './page'

const fixture = vi.hoisted(() => ({
  check: { ok: false, code: 'expired', data: { maskedEmail: 'o***@example.com', canResend: true } } as Record<string, unknown>,
  resend: vi.fn(async () => ({ ok: true, data: { maskedEmail: 'o***@example.com', sent: true } })),
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('token=expired-token'),
  usePathname: () => '/register/complete',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/lib/auth-email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth-email')>()
  return {
    ...actual,
    authRequest: vi.fn(async (path: string) => path.startsWith('/api/auth/register/check') ? fixture.check : fixture.resend()),
  }
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fixture.check = { ok: false, code: 'expired', data: { maskedEmail: 'o***@example.com', canResend: true } }
  fixture.resend.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('承認メールの期限切れ再開', () => {
  it('再送先を確認して申込時のメールへ新リンクを送る', async () => {
    await act(async () => { root.render(<RegisterCompletePage />) })
    expect(host.textContent).toContain('o***@example.com')
    const resend = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('案内メールを再送する'))
    expect(resend).toBeDefined()
    await act(async () => { resend!.click() })
    expect(fixture.resend).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('ご案内メールをお送りしました')
  })

  it('識別できないリンクでは申込情報を出さない', async () => {
    fixture.check = { ok: false, code: 'invalid', error: 'リンクを確認できません' }
    await act(async () => { root.render(<RegisterCompletePage />) })
    expect(host.textContent).toContain('安全のため、この画面では申込情報を表示しません')
    expect(host.textContent).not.toContain('o***@example.com')
    expect(host.textContent).not.toContain('案内メールを再送する')
  })
})
