// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import UnfamiliarLoginNotice from './unfamiliar-login-notice'
const route = vi.hoisted(() => ({ pathname: '/friends' }))
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }))
const snapshot = (unfamiliarAt: string | null) => ({ impersonation: null, unfamiliarAt, stepUpMethod: 'totp' as const })
beforeEach(() => { route.pathname = '/friends' })
afterEach(() => { cleanup(); forgetSessionSnapshot(); localStorage.clear() })

it('［閉じる］でそのログインは翌日以降も出さず、端末の確認への道は閉じる前に出している', async () => {
  rememberSessionSnapshot(snapshot('2026-10-25T01:00:00Z'))
  render(<UnfamiliarLoginNotice />)
  expect((await screen.findByRole('link', { name: 'ログイン中の端末を見る' })).getAttribute('href')).toBe('/staff?section=sessions')
  fireEvent.click(screen.getByRole('button', { name: '通知を閉じる' }))
  expect(screen.queryByRole('note')).toBeNull()
  cleanup()
  route.pathname = '/chats'
  render(<UnfamiliarLoginNotice />)
  await Promise.resolve()
  expect(screen.queryByRole('note')).toBeNull()
})

it('閉じた後に別のいつもと違うログインがあれば、また出す', async () => {
  rememberSessionSnapshot(snapshot('2026-10-25T01:00:00Z'))
  render(<UnfamiliarLoginNotice />)
  fireEvent.click(await screen.findByRole('button', { name: '通知を閉じる' }))
  cleanup()
  rememberSessionSnapshot(snapshot('2026-10-25T05:00:00Z'))
  render(<UnfamiliarLoginNotice />)
  expect(await screen.findByRole('link', { name: 'ログイン中の端末を見る' })).toBeTruthy()
})

it.each(['/', '/settings'])('%sでも閉じられ、閉じたログインはその画面でも出さない', async pathname => {
  route.pathname = pathname
  rememberSessionSnapshot(snapshot('2026-10-25T01:00:00Z'))
  render(<UnfamiliarLoginNotice />)
  fireEvent.click(await screen.findByRole('button', { name: '通知を閉じる' }))
  expect(screen.queryByRole('note')).toBeNull()
  cleanup()
  render(<UnfamiliarLoginNotice />)
  await Promise.resolve()
  expect(screen.queryByRole('note')).toBeNull()
})

it('閉じたログインは日付が変わっても出さない', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-10-25T03:00:00Z'))
  rememberSessionSnapshot(snapshot('2026-10-25T01:00:00Z'))
  render(<UnfamiliarLoginNotice />)
  fireEvent.click(await screen.findByRole('button', { name: '通知を閉じる' }))
  cleanup()
  vi.setSystemTime(new Date('2026-10-28T03:00:00Z'))
  render(<UnfamiliarLoginNotice />)
  await Promise.resolve()
  expect(screen.queryByRole('note')).toBeNull()
  vi.useRealTimers()
})

it('二段階認証が未設定なら本人確認を押せず、設定への案内を出す', async () => {
  rememberSessionSnapshot({ impersonation: null, unfamiliarAt: '2026-10-25T01:00:00Z', stepUpMethod: 'password' })
  render(<UnfamiliarLoginNotice />)
  const button = await screen.findByRole('button', { name: '自分のログインです' })
  expect(button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('link', { name: '二段階認証を設定する' }).getAttribute('href')).toBe('/staff#self-security')
})
