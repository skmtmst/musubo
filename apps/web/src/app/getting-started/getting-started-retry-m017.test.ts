// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const get = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), api: { gettingStarted: { get } } }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', loading: false }) }))
vi.mock('@/hooks/use-account-style', async (original) => ({ ...await original<typeof import('@/hooks/use-account-style')>(), useAccountStyle: () => ({ status: 'ready', data: { style: 'standard' }, error: null, reload: vi.fn() }) }))
vi.mock('@/v8/onboarding/public/style-setup-progress/index', () => ({ useStyleSetupProgress: () => ({ progress: undefined, reload: vi.fn() }) }))
vi.mock('@/lib/staff-role', async (original) => ({
  ...await original<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => 'owner',
  useStaffIdentity: () => ({ id: 'u07-test', role: 'owner', readOnly: false }),
}))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import { useFirstRun } from '@/v8/onboarding/use-first-run'
import GettingStartedPage from './page'
afterEach(cleanup)

it('M017: 取得失敗を未設定にせず、読み直すと保存済み状態に復旧する', async () => {
  get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ success: true, data: { steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }] } })
  const { result } = renderHook(() => useFirstRun('account-1'))
  await waitFor(() => expect(result.current.status).toBe('error'))
  expect(result.current.steps).toEqual([])
  expect(result.current.error).toBeInstanceOf(Error)
  await act(async () => result.current.reload())
  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(result.current.steps.find((step) => step.key === 'featureSet')?.state).toBe('done')
})

it('M017: 実画面の失敗表示から再取得し、保存済みの進捗を出す', async () => {
  get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ success: true, data: { steps: [{ key: 'featureSet', state: 'done', href: '/settings', reason: null }] } })
  render(createElement(GettingStartedPage))
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' })
  expect(screen.queryByRole('progressbar', { name: 'はじめの設定の進み具合' })).toBeNull()
  fireEvent.click(retry)
  await screen.findByText('1 / 7 済み')
  expect(get).toHaveBeenLastCalledWith('account-1', 'v8')
  expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
})
