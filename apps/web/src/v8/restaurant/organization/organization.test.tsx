import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('next/navigation', async (importOriginal) => ({ ...await importOriginal<typeof import('next/navigation')>(), useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }) }))

const fixture = vi.hoisted(() => ({
  snapshot: vi.fn(), loginMembers: vi.fn(), linkMembershipLogin: vi.fn(), updateMembership: vi.fn(), listIntakeAddresses: vi.fn(),
  storeGroups: vi.fn(), gate: vi.fn(), cancel: vi.fn(), role: 'owner' as string | null,
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fixture.role, canManageRole: (role: string | null) => role === 'owner' || role === 'admin' }))
vi.mock('@/components/step-up-prompt', () => ({
  useStepUpGate: () => ({ gate: fixture.gate, cancel: fixture.cancel, prompt: null }),
  isStepUpRequired: (e: unknown) => !!e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'STEP_UP_REQUIRED',
}))
import OrganizationV8 from './organization'

const member = { id: 'member', organization_id: 'org', store_id: 'store', staff_name: '試験担当', email: null, role: 'staff', status: 'active', staff_id: 'login', loginName: '試験ログイン', loginRole: 'staff', loginPolicyVersion: 3, loginAccountScope: 'accounts', line_uid: null, google_email: null }
const data = { organization: { id: 'org', name: '試験組織', tenant_name: '試験統括' }, stores: [{ id: 'store', name: '試験店', code: 'S', area: '渋谷', capacity: 20, status: 'active', line_account_id: 'account-1', line_account_name: '試験店' }], memberships: [member], tables: [], menuItems: [], reservations: [], inventory: [], approvals: [], connectors: [], reviews: [], posts: [], lineFlows: [] }

beforeEach(() => {
  fixture.role = verifiedStaffRole('owner')
  fixture.snapshot.mockResolvedValue({ data })
  fixture.loginMembers.mockResolvedValue({ data: [{ id: 'login', name: '試験ログイン' }, { id: 'next', name: '別のログイン' }] })
  fixture.updateMembership.mockResolvedValue({ success: true })
  fixture.linkMembershipLogin.mockResolvedValue({ success: true })
  fixture.listIntakeAddresses.mockResolvedValue({ data: [] })
  fixture.storeGroups.mockResolvedValue({ data: [] })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('店舗の入力後のページ移動を確認する', async () => {
  render(<OrganizationV8 />)
  fireEvent.click(await screen.findByRole('button', { name: '店舗を作る' }))
  fireEvent.change(screen.getByLabelText('店舗名'), { target: { value: '新しい店舗' } })
  const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
  fireEvent.click(link)
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  link.remove()
})

it('ユーザーのログイン連携の選択もページ移動の前に確認する', async () => {
  render(<OrganizationV8 />)
  const row = (await screen.findByText('試験担当')).closest('[role="row"]') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: '変更' }))
  await pickEntity('試験担当のログインメンバー', '別のログイン')
  const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
  fireEvent.click(link)
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  link.remove()
})

it('店舗の選択窓で確定前の選択もページ移動の前に確認する', async () => {
  render(<OrganizationV8 />)
  fireEvent.click(await screen.findByRole('button', { name: 'ユーザーを追加する' }))
  fireEvent.click(screen.getByRole('button', { name: /^担当店舗/ }))
  const picker = await screen.findByRole('dialog', { name: '店舗を選ぶ' })
  fireEvent.click(within(picker).getByRole('radio', { name: '試験店' }))
  const link = document.createElement('a'); link.href = '/templates'; document.body.appendChild(link)
  fireEvent.click(link)
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  link.remove()
})

it('ユーザー情報とログイン連携の両方を変更しても確認は一度で、編集に戻れば両方を保つ', async () => {
  render(<OrganizationV8 />)
  const row = (await screen.findByText('試験担当')).closest('[role="row"]') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: '変更' }))
  const name = screen.getByLabelText('氏名') as HTMLInputElement
  fireEvent.change(name, { target: { value: '変更中の名前' } })
  await pickEntity('試験担当のログインメンバー', '別のログイン')
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(await screen.findByRole('dialog', { name: '保存していない変更があります' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(name.value).toBe('変更中の名前')
  expect(screen.getByRole('button', { name: 'ログインと連携' }).hasAttribute('disabled')).toBe(false)
})

it('86: 店が1つしか無い時は選ぶ欄を出さない', async () => {
  render(<OrganizationV8 />)
  expect(await screen.findByText('試験担当')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '店舗' })).toBeNull()
  expect(screen.queryByRole('tablist', { name: '店舗で絞り込む' })).toBeNull()
})

it('86: 2店以上の時は［店舗：…］の選ぶ欄を出す', async () => {
  fixture.snapshot.mockResolvedValue({ data: { ...data, stores: [...data.stores, { ...data.stores[0], id: 'store-2', name: '二号店' }] } })
  render(<OrganizationV8 />)
  expect(await screen.findByText('試験担当')).toBeTruthy()
  expect(screen.getByRole('button', { name: '店舗' })).toBeTruthy()
  expect(screen.queryByRole('tablist', { name: '店舗で絞り込む' })).toBeNull()
})

it('店舗管理の表は3行の中身に合わせて伸びる', async () => {
  render(<OrganizationV8 />)
  const table = await screen.findByRole('table', { name: '店舗管理' })
  within(table).getByText('試験店')
  expect(table.getAttribute('data-table-presentation')).toBe('dashboard')
})

it('ログインとの連携は「変更」の窓の中で保存する', async () => {
  render(<OrganizationV8 />)
  const row = (await screen.findByText('試験担当')).closest('[role="row"]') as HTMLElement
  expect(row.querySelector('[title]')?.getAttribute('title')).toContain('試験ログイン・スタッフ')
  fireEvent.click(within(row).getByRole('button', { name: '変更' }))
  await pickEntity('試験担当のログインメンバー', '別のログイン')
  fireEvent.click(screen.getByRole('button', { name: 'ログインと連携' }))
  await waitFor(() => expect(fixture.linkMembershipLogin).toHaveBeenCalledWith('account-1', 'member', 'next'))
})

it('連携メンバーの停止は本人確認が必要なら確認後に同じ鍵で再送する', async () => {
  fixture.updateMembership.mockRejectedValueOnce({ code: 'STEP_UP_REQUIRED' }).mockResolvedValueOnce({ success: true })
  fixture.gate.mockResolvedValue('verified-token')
  render(<OrganizationV8 />)
  const row = (await screen.findByText('試験担当')).closest('[role="row"]') as HTMLElement
  expect(within(row).queryByRole('button', { name: '停止' })).toBeNull()
  fireEvent.click(within(row).getByRole('button', { name: '試験担当のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '停止' }))
  fireEvent.click(screen.getByRole('button', { name: '停止する' }))
  await waitFor(() => expect(fixture.updateMembership).toHaveBeenCalledTimes(2))
  expect(fixture.updateMembership).toHaveBeenLastCalledWith('account-1', 'member', expect.objectContaining({ status: 'suspended', expectedPolicyVersion: 3 }), 'verified-token')
  expect(fixture.updateMembership.mock.calls[0][2].idempotencyKey).toBe(fixture.updateMembership.mock.calls[1][2].idempotencyKey)
})

it('閲覧のみには作る・編集・変更・停止・発行のボタンを灰色で出し、押せない', async () => {
  fixture.role = verifiedStaffRole('staff')
  render(<OrganizationV8 />)
  expect(await screen.findByText('試験担当')).toBeTruthy()
  expect(screen.getByText(PERMISSION_LOCK_SUMMARY.feature)).toBeTruthy()
  for (const name of ['店舗を作る', '編集する', 'ユーザーを追加する', '変更', '停止', 'アドレスを発行', '試験担当のその他操作']) {
    for (const el of screen.queryAllByRole('button', { name })) expect(((el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)(el)).toBe(true)
  }
})

it('停止中のユーザーは共通の「…」から再開でき、更新中は主操作とメニューを押せない', async () => {
  let resolve!: (value: unknown) => void
  fixture.snapshot.mockResolvedValue({ data: { ...data, memberships: [{ ...member, status: 'suspended' }] } })
  fixture.updateMembership.mockImplementation(() => new Promise(r => { resolve = r }))
  render(<OrganizationV8 />)
  const row = (await screen.findByText('試験担当')).closest('[role="row"]') as HTMLElement
  expect(within(row).queryByRole('button', { name: '再開' })).toBeNull()
  fireEvent.click(within(row).getByRole('button', { name: '試験担当のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '再開' }))
  await waitFor(() => expect(fixture.updateMembership).toHaveBeenCalledWith('account-1', 'member', expect.objectContaining({ status: 'active', expectedPolicyVersion: 3 })))
  expect(within(row).getByRole('button', { name: '変更' }).hasAttribute('disabled')).toBe(true)
  expect(within(row).getByRole('button', { name: '試験担当のその他操作' }).hasAttribute('disabled')).toBe(true)
  await act(async () => resolve({ success: true }))
  await waitFor(() => expect(screen.getByRole('button', { name: '試験担当のその他操作' }).hasAttribute('disabled')).toBe(false))
})

it('ユーザーの保存中は窓の×・キャンセル・Escで閉じられない', async () => {
  let resolve!: (value: unknown) => void
  fixture.linkMembershipLogin.mockImplementation(() => new Promise(r => { resolve = r }))
  render(<OrganizationV8 />)
  const row = (await screen.findByText('試験担当')).closest('[role="row"]') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: '変更' }))
  await pickEntity('試験担当のログインメンバー', '別のログイン')
  fireEvent.click(screen.getByRole('button', { name: 'ログインと連携' }))
  expect(screen.getByRole('button', { name: '閉じる' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'キャンセル' }).hasAttribute('disabled')).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('dialog')).toBeTruthy()
  await act(async () => resolve({ success: true }))
})

it('WEB169：店舗編集のタイムゾーンは日本時間の表示だけ', async () => {
  render(<OrganizationV8 />)
  await screen.findAllByText('試験店')
  fireEvent.click(screen.getByRole('button', { name: '試験店のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '編集する' }))
  expect(screen.queryByRole('textbox', { name: 'タイムゾーン' })).toBeNull()
  expect(screen.getByRole('dialog').textContent).toContain('日本時間（Asia/Tokyo）')
})

it('login candidate failure shows retry rather than an empty selector',async()=>{
 fixture.loginMembers.mockRejectedValueOnce(new Error('人工取得失敗'))
 render(<OrganizationV8 />)
 const error=await screen.findByText('ログインメンバーを読み込めませんでした')
 fireEvent.click(error.closest('[data-list-state="error"]')!.querySelector('button')!)
 await waitFor(()=>expect(screen.queryByText('ログインメンバーを読み込めませんでした')).toBeNull())
})

it('未発行の取り込みアドレスは未設定で表示し、発行の操作を保つ', async () => {
  render(<OrganizationV8 />)
  const heading = await screen.findByText('予約メール取り込みアドレス')
  await waitFor(() => expect(fixture.listIntakeAddresses).toHaveBeenCalledWith('account-1', 'store'))
  await waitFor(() => expect(heading.closest('section')!.textContent).toContain('未設定'))
  expect(within(heading.closest('section')!).getByRole('button', { name: 'アドレスを発行' })).toBeTruthy()
})

it('担当の役割は日本語で示し、保存用の役割IDは保つ', async () => {
  render(<OrganizationV8 />)
  const row = (await screen.findByText('試験担当')).closest('[role="row"]') as HTMLElement
  expect(within(row).getByText('スタッフ')).toBeTruthy()
  fireEvent.click(within(row).getByRole('button', { name: '変更' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('button', { name: '役割' }).textContent).toContain('スタッフ')
  expect(dialog.querySelector<HTMLInputElement>('input[name="role"]')?.value).toBe('staff')
})

afterEach(() => { verifiedStaffRole(null) })
