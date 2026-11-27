// @vitest-environment happy-dom
import { trustedChallengeUrl } from '@/test-utils/trusted-auth-handoff'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(''), usePathname: () => '/login/two-factor', useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }) }))
vi.mock('@/lib/use-brand', () => ({ useBrand: () => ({ name: '見本' }) }))
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn() }))
import TwoFactorLoginPage from '@/app/login/two-factor/page'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('6桁の入力が必要な理由を示し、入力後は確認を始める', async () => {
  window.history.replaceState(null, '', trustedChallengeUrl('/login/two-factor?next=ops#lh_2fa=example&lh_method=password'))
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  render(<TwoFactorLoginPage />)
  await screen.findByText('認証アプリの6桁の数字を入力してください。')
  const button = screen.getByRole('button', { name: 'ログイン' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('1桁目'), { target: { value: '123456' } })
  await waitFor(() => expect(screen.queryByText('認証アプリの6桁の数字を入力してください。')).toBeNull())
})
