// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import MfaPolicy from './mfa-policy'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), gate: vi.fn() }))
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), fetchApi: mocks.fetch }))
vi.mock('@/components/step-up-prompt', () => ({ useStepUpGate: () => ({ gate: mocks.gate, prompt: null }) }))
beforeEach(() => { mocks.fetch.mockReset(); mocks.gate.mockReset() }); afterEach(() => { cleanup(); clearToastsForTest() })
it('Off requires the common confirmation flow and sends its one-use grant', async () => {
  mocks.fetch.mockResolvedValueOnce({ success: true, data: { required: true, canEdit: true } })
    .mockResolvedValueOnce({ success: true, data: { required: false, relogin: false } })
  mocks.gate.mockResolvedValue('fixture-grant')
  render(<><MfaPolicy /><ToastHost /></>)
  fireEvent.click(await screen.findByRole('switch', { name: 'ログインで二段階認証を必須にする' }))
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
  expect(mocks.gate).toHaveBeenCalledWith('auth.mfa.policy', '二段階認証の必須をオフにする')
  expect(mocks.fetch.mock.calls[1][1]).toMatchObject({ method: 'PUT', headers: { 'X-Step-Up-Token': 'fixture-grant' }, body: '{"required":false}' })
  await screen.findByText('パスワードやLINEだけで入れます。自分で登録した人には、確かめが出ます。')
  expect(await screen.findByText('二段階認証の必須を解除しました。')).toBeTruthy()
})
it('cancelling confirmation retains On and sends no update', async () => {
  mocks.fetch.mockResolvedValueOnce({ success: true, data: { required: true, canEdit: true } }); mocks.gate.mockResolvedValue(null)
  render(<MfaPolicy />); fireEvent.click(await screen.findByRole('switch'))
  await waitFor(() => expect(mocks.gate).toHaveBeenCalledOnce())
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})
it('a person without ownership sees the policy and has no switch', async () => {
  mocks.fetch.mockResolvedValueOnce({ success: true, data: { required: true, canEdit: false } })
  render(<MfaPolicy />); await screen.findByText('全員が、ログインのたびに認証アプリの6桁を入れます。まだ登録していない人は、次のログインで登録します。')
  expect(screen.queryByRole('switch')).toBeNull()
})
it('turning On warns that everyone must log in and permits initial enrollment', async () => {
  mocks.fetch.mockResolvedValueOnce({ success: true, data: { required: false, canEdit: true } })
  render(<MfaPolicy />); fireEvent.click(await screen.findByRole('switch'))
  await screen.findByRole('dialog')
  expect(screen.getByText(/まだ登録していない人は、次のログインで登録/)).toBeTruthy()
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

it('shows the missing-key notice and prevents enabling unavailable MFA', async () => {
  mocks.fetch.mockResolvedValueOnce({ success: true, data: { required: false, canEdit: true, configured: false, notice: '二段階認証の鍵が未設定のため、必須にできません', registered: 0, total: 2 } })
  render(<MfaPolicy />)
  await screen.findByText('二段階認証の鍵が未設定のため、必須にできません')
  expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('switch'))
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

const accountPerson = (name: string, twoFactorEnabled = false) => ({ name, twoFactorEnabled, isActive: true, inviteStatus: 'active' as const })
const tenantPolicy = () => ({ success: true, data: { required: false, canEdit: true, registered: 5, total: 7 } })

it('counts the selected account members instead of the seven people in the tenant policy', async () => {
  mocks.fetch.mockResolvedValue(tenantPolicy())
  render(<MfaPolicy accountMembers={[accountPerson('自分', true)]} />)
  await screen.findByText('1 / 1 人')
  expect(screen.queryByText('5 / 7 人')).toBeNull()
  expect(screen.getByText('登録済み（このアカウント）')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '未登録の人を見る →' }))
  await screen.findByText('未登録の人はいません')
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
})

it('excludes stopped and invited people and shows unregistered names only from the selected account', async () => {
  mocks.fetch.mockResolvedValue(tenantPolicy())
  render(<MfaPolicy accountMembers={[
    accountPerson('自分', true), accountPerson('このアカウントの未登録者'),
    { ...accountPerson('停止中の人'), isActive: false },
    { ...accountPerson('招待中の人'), inviteStatus: 'pending_email' },
  ]} />)
  await screen.findByText('1 / 2 人')
  fireEvent.click(screen.getByRole('button', { name: '未登録の人を見る →' }))
  const dialog = within(await screen.findByRole('dialog', { name: '二段階認証が未登録の人' }))
  expect(dialog.getByText('このアカウントの未登録者')).toBeTruthy()
  expect(dialog.queryByText('停止中の人')).toBeNull()
  expect(dialog.queryByText('招待中の人')).toBeNull()
  expect(mocks.fetch).not.toHaveBeenCalledWith('/api/staff')
})

it('does not substitute tenant totals while the selected account is loading or unavailable', async () => {
  mocks.fetch.mockResolvedValue(tenantPolicy())
  const view = render(<MfaPolicy accountMembers={null} />)
  await screen.findByText('— / — 人')
  expect((screen.getByRole('button', { name: '未登録の人を見る →' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.queryByText('5 / 7 人')).toBeNull()
  view.rerender(<MfaPolicy accountMembers={[]} />)
  expect(screen.getByText('0 / 0 人')).toBeTruthy()
})

it('retains tenant totals for the operations policy view', async () => {
  mocks.fetch.mockResolvedValueOnce(tenantPolicy()).mockResolvedValueOnce({ success: true, data: [accountPerson('統括の未登録者')] })
  render(<MfaPolicy loginPath="/ops/login" />)
  await screen.findByText('5 / 7 人')
  fireEvent.click(screen.getByRole('button', { name: '未登録の人を見る →' }))
  await screen.findByText('統括の未登録者')
  expect(mocks.fetch).toHaveBeenLastCalledWith('/api/staff')
})
