// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import InitialMenuPage from './initial-menu-page'

const calls = vi.hoisted(() => ({ style: vi.fn(), replace: vi.fn() }))

vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ replace: calls.replace }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/lib/staff-role', async (original) => ({
  ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner',
}))
vi.mock('@/lib/api/helpers/styles', () => ({ styleApi: { get: calls.style } }))

beforeEach(() => {
  localStorage.clear()
  calls.style.mockReset()
  calls.replace.mockClear()
})
afterEach(cleanup)

it('使い方の確認中も題を表示し、古いメニュー選択は開かない', () => {
  calls.style.mockReturnValue(new Promise(() => {}))
  render(<InitialMenuPage />)

  expect(screen.getByRole('heading', { level: 1, name: 'リッチメニュー' })).toBeTruthy()
  expect(screen.getByLabelText('使い方を確認しています')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '最初のリッチメニューを選ぶ' })).toBeNull()
})

it('使い方が未選択なら題と使い方への案内を表示する', async () => {
  calls.style.mockResolvedValue({ success: true, data: { style: 'standard', styleSelected: false, version: 1 } })
  render(<InitialMenuPage />)

  const action = await screen.findByRole('link', { name: '使い方を選択する' })
  expect(action.getAttribute('href')).toBe('/?setup=0&setupReturn=accounts')
  expect(screen.getByRole('heading', { level: 1, name: 'リッチメニュー' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'このメニューで進む' })).toBeNull()
  expect(calls.replace).not.toHaveBeenCalled()
})

it('使い方の取得に失敗しても題を保ち、読み直せる', async () => {
  calls.style.mockRejectedValue(new Error('fixture load failed'))
  render(<InitialMenuPage />)

  expect(await screen.findByText('使い方を読み込めませんでした')).toBeTruthy()
  expect(screen.getByRole('heading', { level: 1, name: 'リッチメニュー' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await waitFor(() => expect(calls.style).toHaveBeenCalledTimes(2))
})

it('飲食店は旧画面を描く前に開店準備のリッチメニューへ進む', async () => {
  calls.style.mockResolvedValue({ success: true, data: { style: 'restaurant', styleSelected: true, version: 1 } })
  render(<InitialMenuPage />)

  await waitFor(() => expect(calls.replace).toHaveBeenCalledExactlyOnceWith('/?guide=richMenu'))
  expect(screen.getByRole('heading', { level: 1, name: 'リッチメニュー' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: '最初のリッチメニューを選ぶ' })).toBeNull()
})
