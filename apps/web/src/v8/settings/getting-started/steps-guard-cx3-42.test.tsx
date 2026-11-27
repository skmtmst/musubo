// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ stepState: 'done' as string, reason: null as unknown, style: 'standard' as import('@line-crm/shared').AccountStyle, progressStyle: null as import('@line-crm/shared').AccountStyle | null, role: 'owner' as string | null, allowed: true, progressStatus: 'ready' as 'ready' | 'loading' | 'idle', revalidating: false, revalidationError: null as unknown, progressRevalidationError: null as unknown, reload: vi.fn(), progressReload: vi.fn(), account: 'a' as string | null, runEnabled: vi.fn() }))
vi.mock('@/hooks/use-account-style', async original => ({ ...await original<typeof import('@/hooks/use-account-style')>(), useAccountStyle: () => ({ status: 'ready', data: { style: state.style }, error: null, stale: false, reload: vi.fn() }) }))
vi.mock('@/v8/onboarding/public/style-setup-progress/index', () => ({ useStyleSetupProgress: () => ({ status: state.progressStatus, revalidating: state.revalidating, revalidationError: state.progressRevalidationError, progress: state.progressStatus === 'idle' ? undefined : { style: state.progressStyle ?? state.style, steps: { attributes: { complete: false }, friendAdd: { complete: true }, scenario: { complete: null, reason: '受付の設定を確認できていません' } } }, reload: state.progressReload }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, loading: false }) }))
vi.mock('@/lib/staff-role', async (original) => ({
  ...await original<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => state.role,
  useStaffIdentity: () => ({ id: 'u07-test', role: state.role, readOnly: state.role === 'viewer' }),
}))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/v8/onboarding/use-first-run', async () => {
  const { buildStepsFromApi } = await import('./steps')
  return { useFirstRun: (_account: string | null, enabled: boolean) => (state.runEnabled(enabled), { status: 'ready', revalidating: state.revalidating, revalidationError: state.revalidationError, error: null, reload: state.reload, steps: buildStepsFromApi(['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage'].map((key) => ({ key, state: state.stepState, href: state.allowed ? '/' : null, reason: state.reason } as never))) }) }
})
import GettingStarted from './getting-started'
beforeEach(() => { state.reload.mockClear(); state.progressReload.mockClear(); state.role = 'owner'; state.allowed = true; state.style = 'standard'; state.progressStyle = null; state.stepState = 'done'; state.reason = null; state.progressStatus = 'ready'; state.revalidating = false; state.revalidationError = null; state.progressRevalidationError = null; state.account = 'a'; state.runEnabled.mockClear() })
afterEach(cleanup)

it('未知の状態は確認できないと示し、その段から操作させない', () => {
  state.stepState = 'toString'
  const { container } = render(<GettingStarted />)
  const row = screen.getByText('LINEアカウントをつなぐ').closest('[role="row"]')!
  expect(row.getAttribute('data-step-state')).toBe('unknown')
  expect(row.querySelector('a')).toBeNull()
  expect(container.textContent).not.toContain('function toString')
})

it('理由が文字でないときは画面を落とさず状態の確認を案内する', () => {
  state.stepState = 'stalled'
  state.reason = { broken: true }
  const { container } = render(<GettingStarted />)
  expect(container.textContent).not.toContain('[object Object]')
  expect(screen.getAllByText(/確認/).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: '受信後に状態を読み直す' }))
  expect(state.reload).toHaveBeenCalledTimes(1)
})
