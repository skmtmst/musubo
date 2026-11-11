// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ stepState: 'done' as 'done' | 'todo' | 'forbidden', style: 'standard' as import('@line-crm/shared').AccountStyle, role: 'owner' as string | null, allowed: true, reload: vi.fn() }))
vi.mock('@/hooks/use-account-style', async original => ({ ...await original<typeof import('@/hooks/use-account-style')>(), useAccountStyle: () => ({ status: 'ready', data: { style: state.style }, error: null, stale: false, reload: vi.fn() }) }))
vi.mock('@/v8/onboarding/public/style-setup-progress/index', () => ({ useStyleSetupProgress: () => ({ progress: { style: state.style, steps: { attributes: { complete: false }, friendAdd: { complete: true }, scenario: { complete: null, reason: '受付の設定を確認できていません' } } }, reload: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', loading: false }) }))
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
  return { useFirstRun: () => ({ status: 'ready', error: null, reload: state.reload, steps: buildStepsFromApi(['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage'].map((key) => ({ key, state: state.stepState, href: state.allowed ? '/' : null, reason: null }))) }) }
})
import GettingStarted from './getting-started'
beforeEach(() => { state.reload.mockClear(); state.role = 'owner'; state.allowed = true; state.style = 'standard'; state.stepState = 'done' })
afterEach(cleanup)

it('送信せずに2つの確認経路へ案内し、受信後の読み直しを置く', () => {
  render(<GettingStarted />)
  expect(screen.getByRole('link', { name: '友だち追加のQRを開く' }).getAttribute('href')).toBe('/?qr=base')
  expect(screen.getByRole('link', { name: 'シナリオを選んでテスト送信する' }).getAttribute('href')).toBe('/scenarios')
  const card = screen.getByRole('region', { name: '最初の1通の確認方法' })
  const reload = within(card).getByRole('button', { name: '受信後に状態を読み直す' })
  expect(reload.textContent).toBe('読み直す')
  expect(reload.closest('[data-design-node="t0jk8p"]')?.contains(within(card).getByRole('heading', { name: '最初の1通の確認方法' }))).toBe(true)
  expect(card.querySelectorAll('p')).toHaveLength(1)
  expect(within(card).queryByText(/送らずに判定するテスト/)).toBeNull()
  fireEvent.click(within(card).getByRole('button', { name: '最初の1通の判定と確認方法' }))
  expect(within(card).getByRole('note').textContent).toContain('送らずに判定するテストと受信箱の手動返信は完了に数えません')
  expect(state.reload).not.toHaveBeenCalled()
  fireEvent.click(reload)
  expect(state.reload).toHaveBeenCalledTimes(1)
})
it('閲覧のみ・送信権限のない人にも入口を灰色のボタンで残し、移動させない', () => {
  state.role = 'viewer'
  const { unmount } = render(<GettingStarted />)
  for (const label of ['友だち追加のQRを開く', 'シナリオを選んでテスト送信する']) {
    expect(screen.queryByRole('link', { name: label })).toBeNull()
    const button = screen.getByRole('button', { name: label })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.hasAttribute('href')).toBe(false)
    const reason = document.getElementById(button.getAttribute('aria-describedby')!)?.textContent
    expect(reason).toMatch(/閲覧|権限/)
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(state.reload).not.toHaveBeenCalled()
  }
  unmount()
  state.role = 'owner'; state.allowed = false
  render(<GettingStarted />)
  for (const label of ['友だち追加のQRを開く', 'シナリオを選んでテスト送信する']) {
    expect(screen.queryByRole('link', { name: label })).toBeNull()
    const button = screen.getByRole('button', { name: label })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.hasAttribute('href')).toBe(false)
    const reason = document.getElementById(button.getAttribute('aria-describedby')!)?.textContent
    expect(reason).toMatch(/閲覧|権限/)
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(state.reload).not.toHaveBeenCalled()
  }
})
it('板の印を付け、順路は名前の付いた表で読める', () => {
  const { container } = render(<GettingStarted />)
  expect(container.querySelector('[data-design-node="xuJ7D"]')).not.toBeNull()
  expect(screen.getByRole('table', { name: 'はじめの設定の順路' })).toBeTruthy()
})


it.each([
  ['restaurant', '卓と席を登録する'], ['salon', 'メニューを登録する'], ['consult', '面談の枠を作る'], ['lesson', 'クラスを作る'], ['ec', 'ストアをつなぐ'],
] as const)('%sは旧配信が済みでも実設定の未完了と未確認を出す', (style, title) => {
  state.style = style
  render(<GettingStarted />)
  expect(screen.getByText(title).closest('[role="row"]')?.getAttribute('data-step-state')).toBe('todo')
  expect(screen.getAllByText(/受付の設定を確認できていません/).length).toBeGreaterThan(0)
})


it.each(['viewer', 'staff'])('%sの未完了の段は灰色の入口を残す', role => {
  state.role = role
  state.allowed = false
  state.stepState = 'forbidden'
  const { container } = render(<GettingStarted />)
  const rows = [...container.querySelectorAll('[data-step-state="forbidden"]')]
  expect(rows).toHaveLength(7)
  for (const row of rows) {
    const button = row.querySelector('button')!
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('href')).toBe(false)
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
  }
})


it('権限が未確認の間は段の操作を押せないボタンにし、リンク先を持たせない', () => {
  state.role = null
  state.stepState = 'todo'
  const { container } = render(<GettingStarted />)
  const rows = [...container.querySelectorAll('[data-step-state="todo"]')]
  expect(rows).toHaveLength(6)
  for (const row of rows) {
    expect(row.querySelector('a')).toBeNull()
    const button = row.querySelector('button')!
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.hasAttribute('href')).toBe(false)
    fireEvent.click(button)
  }
  expect(screen.queryByRole('link', { name: 'シナリオを選んでテスト送信する' })).toBeNull()
})
