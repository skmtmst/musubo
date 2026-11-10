// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PagePendingLayout } from './templates/page-pending'
const state = vi.hoisted(() => ({ accounts: [] as Array<{ id: string }>, selectedAccountId: null as string | null, loading: false, error: 'offline' as string | null, refreshing: false, refreshAccounts: vi.fn(), setSelectedAccountId: vi.fn(), replace: vi.fn() }))
const pricing = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ replace: state.replace }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => state }))
vi.mock('@/lib/api', () => ({ api: { musuboOnboardingPricing: { get: pricing.get } } }))
import RootLandingGate from './root-landing-gate'
afterEach(() => {
  cleanup()
  state.accounts = []; state.selectedAccountId = null; state.loading = false; state.error = 'offline'
  state.replace.mockReset(); pricing.get.mockReset()
})

it('表示先の失敗・再試行中もホームの題を保ち、取得後に本文を始める', () => {
  const draw = () => <PagePendingLayout variant="dashboard"><RootLandingGate><p>ホームの中身</p></RootLandingGate></PagePendingLayout>
  const view = render(draw())
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ダッシュボード')
  expect(screen.getByText('アカウント一覧を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('ホームの中身')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(state.refreshAccounts).toHaveBeenCalledTimes(1)
  state.refreshing = true
  view.rerender(draw())
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ダッシュボード')
  expect(screen.getByRole('button', { name: '読み込んでいます' }).hasAttribute('disabled')).toBe(true)
  state.loading = true; state.error = null
  view.rerender(draw())
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ダッシュボード')
  state.accounts = [{ id: 'a' }]; state.selectedAccountId = 'a'; state.loading = false
  view.rerender(draw())
  expect(screen.getByText('ホームの中身')).toBeTruthy()
  expect(state.replace).not.toHaveBeenCalled()
})

it.each([
  [{ status: 'awaiting_first_line', quoteId: null, consentedAt: null }, '/hq/onboarding/pricing'],
  [{ status: 'awaiting_first_line', quoteId: null, consentedAt: '2026-11-09' }, '/hq/onboarding/card'],
  [{ status: 'awaiting_first_line', quoteId: 'q1', consentedAt: null }, '/hq/onboarding/quotes?id=q1'],
  [{ status: 'trialing', quoteId: null, consentedAt: null }, '/hq'],
] as const)('LINE未接続の再ログイン先を保存状態から決める: %s', async (data, path) => {
  state.error = null
  pricing.get.mockResolvedValue({ success: true, data })
  render(<RootLandingGate><p>ホームの中身</p></RootLandingGate>)
  expect(screen.queryByText('ホームの中身')).toBeNull()
  await waitFor(() => expect(state.replace).toHaveBeenCalledWith(path))
})

it('旧契約や料金状態の読取失敗でも通常の統括一覧へ戻れる', async () => {
  state.error = null
  pricing.get.mockResolvedValue({ success: false, error: 'not found' })
  render(<RootLandingGate><p>ホームの中身</p></RootLandingGate>)
  await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/hq'))
})
