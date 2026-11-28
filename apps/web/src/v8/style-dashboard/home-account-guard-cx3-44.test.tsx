// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const account = vi.hoisted(() => ({ loading: true, error: null as string | null, accounts: [] as Array<{ id: string }>, selectedAccountId: null as string | null, refreshAccounts: vi.fn() }))
const styleGet = vi.hoisted(() => ({ fn: vi.fn() as (...args: unknown[]) => Promise<unknown> }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => account }))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: (...args: unknown[]) => styleGet.fn(...args) } }))
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>, opts?: { loading?: () => React.ReactNode }) =>
    function DynamicStub(props: Record<string, unknown>) {
      const [Comp, setComp] = React.useState<React.ComponentType<Record<string, unknown>> | null>(null)
      React.useEffect(() => { loader().then((m) => setComp(() => m.default)) }, [])
      if (!Comp) return (opts?.loading ? opts.loading() : null) as React.ReactElement | null
      return <Comp {...props} />
    },
}))
vi.mock('@/v8/dashboard/index', () => ({
  DashboardV8: () => <div data-design-node="WQmep" data-screen="standard"><div data-template-region="heading"><h1>ダッシュボード</h1></div></div>,
}))
vi.mock('@/v8/style-dashboard/style-dashboard', () => ({
  default: ({ style }: { style: string }) => (
    <div data-design-node={`style-${style}`} data-screen="industry">
      <div data-template-region="heading"><h1>ダッシュボード</h1></div>
    </div>
  ),
}))
import HomeDashboard from './home'

beforeEach(() => { localStorage.clear(); account.loading = false; account.error = null; account.accounts = []; account.selectedAccountId = null; account.refreshAccounts.mockReset(); styleGet.fn = vi.fn(async () => ({ success: true, data: { style: 'restaurant' } })) })
afterEach(cleanup)

it('アカウント一覧の失敗を知らせて読み直せる', async () => {
  account.error = '一覧の取得に失敗しました'
  const view = render(<HomeDashboard />)
  expect(screen.getByText('アカウント一覧を読み込めませんでした')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(account.refreshAccounts).toHaveBeenCalledTimes(1)
  account.error = null; view.rerender(<HomeDashboard />)
  expect(await screen.findByText('ダッシュボード')).toBeTruthy()
  expect(document.querySelector('[data-screen="standard"]')).toBeTruthy()
})

it('一覧があり未選択なら選ぶよう伝え、選ぶと業種のホームを開く', async () => {
  account.accounts = [{ id: 'acc-a' }, { id: 'acc-b' }]
  const view = render(<HomeDashboard />)
  expect(screen.getByText('上部でLINE公式アカウントを選んでください')).toBeTruthy()
  account.selectedAccountId = 'acc-a'; view.rerender(<HomeDashboard />)
  await waitFor(() => expect(document.querySelector('[data-design-node="style-restaurant"]')).toBeTruthy())
})

it('アカウントが1件なら自動選択を待ち、選択案内を出さない', () => {
  account.accounts = [{ id: 'acc-a' }]
  render(<HomeDashboard />)
  expect(screen.queryByText('上部でLINE公式アカウントを選んでください')).toBeNull()
  expect(screen.getByLabelText('読み込んでいます')).toBeTruthy()
})
