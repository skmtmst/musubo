// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

const calls = vi.hoisted(() => ({ staff: vi.fn(), sessions: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('section=sessions'),
  usePathname: () => '/staff',
}))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: null, accounts: [{ id: 'acc' }], loading: false }) }))
vi.mock('@/components/shell/page-chrome', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shell/page-chrome')>()
  return { ...actual, usePageTitle: () => undefined, usePageCrumbs: () => undefined }
})
vi.mock('./self-security', () => ({ default: () => <div>自分の二段階認証</div> }))
vi.mock('./trusted-logins', () => ({ default: () => <div>信頼済みの端末</div> }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    staff: { ...actual.api.staff, list: calls.staff },
    sessions: { ...actual.api.sessions, list: calls.sessions },
  } }
})
import StaffV8 from './staff'
afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('アカウント未選択でも端末欄を開き、本人の端末を読み込む', async () => {
  calls.sessions.mockResolvedValue({ success: true, data: { sessions: [{ id: 'one', current: true, createdAt: '2026-10-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', userAgent: 'Mac OS Chrome/1', ipPrefix: null }] } })
  const scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  render(<StaffV8 />)
  expect(await screen.findByText('上のバーでLINE公式アカウントを選んでください')).toBeTruthy()
  expect(screen.queryByText('ログインユーザーを読み込めませんでした。登録した内容は消えていません。')).toBeNull()
  expect(screen.getByText('自分の二段階認証')).toBeTruthy()
  const details = screen.getByText('ログイン中の端末を確認').closest('details')!
  expect(details.open).toBe(true)
  expect(await screen.findByText(/Mac・Chrome/)).toBeTruthy()
  await waitFor(() => expect(scroll).toHaveBeenCalled())
  expect(calls.sessions).toHaveBeenCalled()
  expect(calls.staff).not.toHaveBeenCalled()
})
