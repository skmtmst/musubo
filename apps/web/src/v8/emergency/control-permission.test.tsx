import { createRef } from 'react'
import { getPageAction } from '@/test-utils/page-action'
import EmergencyControlV8, { type EmergencyControlV8Handle } from './control'
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import EmergencyPage from '@/app/emergency/page'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

const f = vi.hoisted(() => ({
  preview: vi.fn(), history: vi.fn(), stepUp: vi.fn(), stop: vi.fn(), restore: vi.fn(), restorePreview: vi.fn(),
  activeIncidentId: null as string | null,
}))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useSearchParams: () => new URLSearchParams('tab=control'), usePathname: () => '/emergency' }))
vi.mock('@/contexts/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
vi.mock('@/lib/use-running-version', () => ({ useRunningVersion: () => ({ statusText: '確認済み', detail: { version: 'test' } }) }))
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    staff: { ...actual.api.staff, me: () => new Promise(() => {}) },
    health: { ...actual.api.health, accounts: async () => ({ success: true, data: [{ id: 'account-a', name: 'A' }, { id: 'account-b', name: 'B' }] }) },
    operations: { ...actual.api.operations, preview: f.preview, history: f.history, stepUp: f.stepUp, stop: f.stop, restore: f.restore, restorePreview: f.restorePreview,
      sendPaths: async () => ({ success: false, error: '確認できません' }) },
  } }
})

function payload(accountId: string | null = null, permitted = true) {
  const metric = { itemCount: 1, friendCount: 2, pendingCount: 0 }
  return { success: true, data: {
    control: { scopeKey: accountId ?? 'all', lineAccountId: accountId, version: 7, states: {}, activeIncidentId: f.activeIncidentId,
      actorId: 'owner', reason: '確認', stoppedAt: f.activeIncidentId ? '2026-10-29T00:00:00Z' : null, updatedAt: '' },
    impact: { broadcast_dispatch: metric, scenario_dispatch: metric, reminder_dispatch: metric, automation_actions: metric, auto_reply_dispatch: metric },
    permissions: { canControl: permitted }, calculatedAt: '2026-10-29T00:00:00Z', counts: {},
  } }
}
function identity(role: StaffMember['role'] | null, extra: Partial<StaffMember> = {}) {
  verifiedStaffRole(role)
  if (role) act(() => rememberStaffIdentity({ ...readStaffIdentity()!, ...extra }))
}
function session(mode: 'read' | 'write' | null) {
  act(() => rememberSessionSnapshot({ unfamiliarAt: null, stepUpMethod: 'password', impersonation: mode ? {
    id: 'proxy', tenantId: 'tenant', mode, piiRevealed: false, startedAt: '',
  } : null }))
}
const stopButton = () => screen.getByRole('button', { name: '選んだものを止める' }) as HTMLButtonElement
async function loaded() { await waitFor(() => expect(screen.getByText('いまは止めていません。止めると、ここに止めた時刻・担当・止めたものが出ます。')).toBeTruthy()) }
async function fillStop() {
  fireEvent.click(stopButton())
  const d = await screen.findByRole('alertdialog', { name: '緊急停止を確認' })
  fireEvent.change(within(d).getByRole('textbox', { name: '止める理由' }), { target: { value: '確認のため' } })
  fireEvent.change(within(d).getByRole('textbox', { name: '確認の言葉' }), { target: { value: '停止' } })
  fireEvent.change(within(d).getByLabelText('パスワード'), { target: { value: 'fixture' } })
  return within(d).getByRole('button', { name: '緊急停止する' })
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const grant = { success: true, data: { token: 'grant' } }
beforeEach(() => {
  vi.clearAllMocks(); f.activeIncidentId = null
  identity('owner'); session(null)
  f.preview.mockImplementation(async (id: string | null) => payload(id))
  f.history.mockResolvedValue({ success: true, data: [] })
  f.restorePreview.mockResolvedValue({ success: false, error: '確認できません' })
  f.stepUp.mockResolvedValue(grant)
  f.stop.mockImplementation(async () => ({ success: true, data: { control: payload().data.control } }))
  f.restore.mockImplementation(async () => ({ success: true, data: { control: { ...payload().data.control, activeIncidentId: null } } }))
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot() })

it('停止確認は実際に止める全アカウントと環境を示す', async () => {
  render(<EmergencyPage />); await loaded(); await fillStop()
  const dialog = screen.getByRole('alertdialog', { name: '緊急停止を確認' })
  expect(within(dialog).getByText('すべてのLINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境', { exact: true })).toBeTruthy()
})

it('復旧確認は実際の対象アカウントと環境を示す', async () => {
  identity('admin', { permissionKeys: ['operations.control.execute'] })
  f.activeIncidentId = 'incident'; render(<EmergencyPage />)
  fireEvent.click(await screen.findByRole('button', { name: '復旧する' }))
  const dialog = await screen.findByRole('dialog', { name: '止める前の状態に戻しますか？' })
  expect(within(dialog).getByText('LINEアカウント', { exact: true })).toBeTruthy()
  expect(within(dialog).getByText('A', { exact: true })).toBeTruthy()
  expect(within(dialog).getByText('環境', { exact: true })).toBeTruthy()
})

it.each([
  { role: 'viewer' as const }, { role: 'staff' as const, permissionKeys: ['operations.control.execute'] },
  { role: 'admin' as const }, { role: 'owner' as const, readOnly: true },
  { role: 'owner' as const, roleBundle: 'view_only' as const }, { role: 'owner' as const, proxy: true },
])('確定した拒否を隠さず理由付きにし、読取と対象の選択は残す: %j', async ({ role, ...extra }) => {
  identity(role, extra); if ('proxy' in extra) session('read')
  render(<EmergencyPage />); await loaded()
  const button = stopButton()
  expect(button.hasAttribute('data-permission-locked')).toBe(true)
  expect(button.disabled).toBe(false)
  await waitFor(() => expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(1))
  for (const checkbox of screen.getAllByRole('checkbox')) expect((checkbox as HTMLInputElement).disabled).toBe(true)
  fireEvent.click(button); fireEvent.keyDown(button, { key: 'Enter' })
  const headingAction = getPageAction({ name: '緊急停止する', exact: true })
  expect(headingAction.hasAttribute('data-permission-locked')).toBe(true)
  fireEvent.click(headingAction)
  fireEvent.change(screen.getByRole('combobox', { name: '緊急停止の対象アカウント' }), { target: { value: 'account-a' } })
  await waitFor(() => expect(f.preview).toHaveBeenCalledWith('account-a'))
  await waitFor(() => expect(stopButton().hasAttribute('data-permission-locked')).toBe(true))
  expect(f.history).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(f.stepUp).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.restore).not.toHaveBeenCalled()
})

it.each(['owner', 'admin'] as const)('%sの専用許可は本人確認後に1回停止できる', async role => {
  identity(role, { permissionKeys: role === 'admin' ? ['operations.control.execute'] : [] })
  render(<EmergencyPage />); await loaded()
  if (role === 'admin') {
    expect(f.preview.mock.calls.every(([accountId]) => accountId === 'account-a')).toBe(true)
    const account = screen.getByRole('combobox', { name: '緊急停止の対象アカウント' })
    expect((within(account).getByRole('option', { name: 'すべてのアカウント' }) as HTMLOptionElement).disabled).toBe(true)
    fireEvent.change(account, { target: { value: 'all' } })
    expect((account as HTMLSelectElement).value).toBe('account-a')
    expect(f.preview.mock.calls.some(([accountId]) => accountId === null)).toBe(false)
  } else expect(f.preview).toHaveBeenCalledWith(null)
  await waitFor(() => expect(stopButton().disabled).toBe(false))
  expect(stopButton().hasAttribute('data-permission-locked')).toBe(false)
  fireEvent.click(await fillStop())
  await waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1))
  expect(f.stepUp).toHaveBeenCalledTimes(1)
  expect(f.stop.mock.calls[0][0]).toMatchObject({ expectedVersion: 7, reason: '確認のため', confirmation: '停止', lineAccountId: role === 'admin' ? 'account-a' : null })
  expect(document.querySelector('[data-read-only-notice]')).toBeNull()
})

it('previewが許可でも本人未確認は通常disabled・帯なし、本人の確定で使える', async () => {
  identity(null); render(<EmergencyPage />)
  await act(async () => {})
  expect(f.preview).not.toHaveBeenCalled()
  expect(stopButton().disabled).toBe(true)
  expect(document.querySelector('[data-permission-locked]')).toBeNull()
  expect(document.querySelector('[data-read-only-notice]')).toBeNull()
  fireEvent.click(stopButton()); expect(f.stepUp).not.toHaveBeenCalled()
  identity('owner')
  await waitFor(() => expect(stopButton().disabled).toBe(false))
  expect(document.querySelector('[data-read-only-notice]')).toBeNull()
})

it.each(['pending', 'failed'])('previewが%sの間は権限不足とせず、普通disabledで読直しを残す', async mode => {
  const d = deferred<ReturnType<typeof payload>>()
  f.preview.mockImplementation(() => d.promise)
  render(<EmergencyPage />)
  await waitFor(() => expect(f.preview).toHaveBeenCalledTimes(1))
  if (mode === 'failed') await act(async () => { d.resolve({ success: false, error: '通信失敗' } as never) })
  expect(stopButton().disabled).toBe(true)
  expect(document.querySelector('[data-permission-locked]')).toBeNull()
  expect(document.querySelector('[data-read-only-notice]')).toBeNull()
  expect(f.stepUp).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  if (mode === 'failed') expect(screen.getAllByRole('button', { name: /読み直/ }).length).toBeGreaterThan(0)
})

it.each(['stop', 'restore'] as const)('本人確認待ちのread→writeへの往復で古い%sを再開しない', async operation => {
  if (operation === 'restore') f.activeIncidentId = 'incident'
  const pending = deferred<typeof grant>(); f.stepUp.mockImplementation(() => pending.promise)
  render(<EmergencyPage />)
  if (operation === 'stop') { await loaded(); fireEvent.click(await fillStop()) }
  else {
    fireEvent.click(await screen.findByRole('button', { name: '復旧する' }))
    const d = await screen.findByRole('dialog', { name: '止める前の状態に戻しますか？' })
    fireEvent.change(within(d).getByRole('textbox', { name: '確認の言葉' }), { target: { value: '復旧' } })
    fireEvent.click(within(d).getByRole('button', { name: '復旧を実行する' }))
    const step = await screen.findByRole('dialog', { name: 'パスワードで本人確認' })
    fireEvent.change(within(step).getByLabelText('パスワード'), { target: { value: 'fixture' } })
    fireEvent.click(within(step).getByRole('button', { name: '本人確認して実行' }))
  }
  await waitFor(() => expect(f.stepUp).toHaveBeenCalledTimes(1))
  session('read'); session('write')
  await act(async () => { pending.resolve(grant) })
  expect(f.stop).not.toHaveBeenCalled(); expect(f.restore).not.toHaveBeenCalled()
})

it('開いた停止の確認もread切替で灰色・入力disabledになり、本人確認を送らない', async () => {
  render(<EmergencyPage />); await loaded(); const submit = await fillStop()
  session('read')
  const currentSubmit = within(screen.getByRole('alertdialog')).getByRole('button', { name: '緊急停止する' })
  expect(currentSubmit.hasAttribute('data-permission-locked')).toBe(true)
  fireEvent.click(currentSubmit)
  expect((screen.getByRole('textbox', { name: '止める理由' }) as HTMLInputElement).disabled).toBe(true)
  expect(f.stepUp).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('停止確認中に権限が一度外れて戻ったら古い確認を使わない', async () => {
  render(<EmergencyPage />); await loaded(); await fillStop()
  session('read'); session(null)
  const dialog = screen.queryByRole('alertdialog', { name: '緊急停止を確認' })
  if (dialog) fireEvent.click(within(dialog).getByRole('button', { name: '緊急停止する' }))
  expect(f.stepUp).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()
})

it('許可のある復旧はincident・版・要求鍵を保ち1回実行する', async () => {
  f.activeIncidentId = 'incident'; render(<EmergencyPage />)
  fireEvent.click(await screen.findByRole('button', { name: '復旧する' }))
  const d = await screen.findByRole('dialog', { name: '止める前の状態に戻しますか？' })
  fireEvent.change(within(d).getByRole('textbox', { name: '確認の言葉' }), { target: { value: '復旧' } })
  fireEvent.click(within(d).getByRole('button', { name: '復旧を実行する' }))
  const step = await screen.findByRole('dialog', { name: 'パスワードで本人確認' })
  fireEvent.change(within(step).getByLabelText('パスワード'), { target: { value: 'fixture' } })
  fireEvent.click(within(step).getByRole('button', { name: '本人確認して実行' }))
  await waitFor(() => expect(f.restore).toHaveBeenCalledTimes(1))
  expect(f.restore.mock.calls[0]).toEqual(['incident', { confirmation: '復旧', expectedVersion: 7 }, 'grant', expect.any(String)])
})

it('本人確認待ちで画面を閉じたら送信しない', async () => {
  const pending = deferred<typeof grant>(); f.stepUp.mockImplementation(() => pending.promise)
  const view = render(<EmergencyPage />); await loaded(); fireEvent.click(await fillStop())
  await waitFor(() => expect(f.stepUp).toHaveBeenCalledTimes(1))
  view.unmount(); await act(async () => { pending.resolve(grant) })
  expect(f.stop).not.toHaveBeenCalled()
})

it('閲覧のみの本人が確定していればpreviewの403でも灰色の理由を残し、読込失敗と区別する', async () => {
  identity('viewer')
  f.preview.mockResolvedValue({ success: false, error: '閲覧の許可がありません' })
  render(<EmergencyPage />)
  await waitFor(() => expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(1))
  expect(stopButton().hasAttribute('data-permission-locked')).toBe(true)
  expect(await screen.findByText('いまの停止状態を確認できませんでした。読み直してください。')).toBeTruthy()
  fireEvent.click(stopButton())
  expect(f.stepUp).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('保持した題の入口も本人が変わった後は確認を開かない', async () => {
  const ref = createRef<EmergencyControlV8Handle>()
  render(<EmergencyControlV8 accounts={[]} ref={ref} />); await loaded()
  const open = ref.current!.openStop
  identity('viewer')
  act(() => open())
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(f.stepUp).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('対象を変えると古い確認を捨て、新しいpreviewが返るまで理由なしdisabledで待つ', async () => {
  render(<EmergencyPage />); await loaded(); await fillStop()
  const pending = deferred<ReturnType<typeof payload>>()
  f.preview.mockImplementation(() => pending.promise)
  fireEvent.change(screen.getByRole('combobox', { name: '緊急停止の対象アカウント' }), { target: { value: 'account-b' } })
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(stopButton().disabled).toBe(true)
  expect(document.querySelector('[data-permission-locked]')).toBeNull()
  expect(f.stepUp).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  await act(async () => { pending.resolve(payload('account-b')) })
  await waitFor(() => expect(stopButton().disabled).toBe(false))
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

it('管理者の初回は全体の403を呼ばず、許可アカウントの停止状態を読む', async () => {
  identity('admin')
  f.preview.mockImplementation(async (id: string | null) => {
    if (id === null) throw new Error('all scope forbidden')
    return payload(id, false)
  })
  render(<EmergencyPage />); await loaded()
  expect(f.preview).toHaveBeenCalledWith('account-a')
  expect(f.preview.mock.calls.some(([id]) => id === null)).toBe(false)
  expect(stopButton().hasAttribute('data-permission-locked')).toBe(true)
  expect(f.stop).not.toHaveBeenCalled(); expect(f.restore).not.toHaveBeenCalled()
})
it('管理者の許可アカウントが未取得なら影響人数を要求しない', async () => {
  identity('admin')
  const view = render(<EmergencyControlV8 accounts={[]} />)
  await act(async () => {})
  expect(f.preview).not.toHaveBeenCalled()
  view.rerender(<EmergencyControlV8 accounts={[{ id: 'account-b', name: 'B' }] as never} />)
  await waitFor(() => expect(f.preview).toHaveBeenCalledWith('account-b'))
  expect(f.preview.mock.calls.some(([id]) => id === null)).toBe(false)
})
