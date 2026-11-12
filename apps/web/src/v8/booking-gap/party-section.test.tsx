// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
import type { StaffMember } from '@line-crm/shared'
import type { BookingGroupView as BookingParty } from '@line-crm/shared'

const cancelGroup = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/helpers/booking-advanced', () => ({ bookingAdvancedApi: { cancelGroup } }))
const { default: PartySection } = await import('./party-section')

const party: BookingParty = { groupId: 'g1', ownerName: '見本 143', version: 2, members: [
  { bookingId: 'b1', label: 'チョコ', menuName: '爪切り', staffName: 'Kenta', startsAt: '2026-10-01T04:30:00.000Z', endsAt: '2026-10-01T04:45:00.000Z', status: 'confirmed', version: 1 },
  { bookingId: 'b2', label: 'マロン', menuName: 'トリミング（中型犬）', staffName: '佐々木', startsAt: '2026-10-01T04:00:00.000Z', endsAt: '2026-10-01T05:30:00.000Z', status: 'confirmed', version: 1 },
] }
beforeEach(() => rememberStaffIdentity({ id: 'owner', role: 'owner' } as StaffMember))
afterEach(() => { cleanup(); forgetStaffIdentity(); vi.clearAllMocks() })

test('人ごとのメニュー・担当・時間を並べる', () => {
  render(<PartySection party={party} canOperate currentBookingId="b1" />)
  expect(screen.getByText('この組（2 人）')).toBeTruthy()
  expect(screen.getByText('13:30〜13:45')).toBeTruthy()
  expect(screen.getByText('13:00〜14:30')).toBeTruthy()
})

test('権限が無い取消は理由を付けて押せなくし、送らない', async () => {
  render(<PartySection party={party} canOperate={false} currentBookingId="b1" />)
  const cancel = screen.getByRole('button', { name: '組をまとめて取り消す' })
  await expectPermissionLocked(cancel)
  fireEvent.click(cancel)
  expect(cancelGroup).not.toHaveBeenCalled()
})

test('組をまとめて取り消す：口が無い間は押すと「現在準備中です」を出し、何も送らない', async () => {
  render(<PartySection party={party} canOperate currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  expect(await screen.findByText('現在準備中です')).toBeTruthy()
})


test('実APIの組IDと版を使い、理由の確認後だけまとめて取り消す', async () => {
  cancelGroup.mockResolvedValue({ success: true, data: { cancelled: 2, version: 3 } })
  const changed = vi.fn()
  render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" onChanged={changed} />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  expect(screen.getByRole('alertdialog').textContent).toContain('LINEアカウント')
  expect(screen.getByRole('alertdialog').textContent).toContain('環境')
  const confirm = screen.getByRole('button', { name: 'まとめて取り消す' })
  expect(confirm.hasAttribute('disabled')).toBe(true)
  expect(cancelGroup).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  fireEvent.click(confirm)
  await waitFor(() => expect(changed).toHaveBeenCalledOnce())
  expect(cancelGroup).toHaveBeenCalledWith('account-1', 'g1', '予定の変更', 2, [{ bookingId: 'b1', version: 1, status: 'confirmed' }, { bookingId: 'b2', version: 1, status: 'confirmed' }])
})

test('確認中に対象アカウントや組が変われば古い取消を閉じる', () => {
  const { rerender } = render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  rerender(<PartySection party={{ ...party, groupId: 'g2' }} canOperate accountId="account-2" currentBookingId="b1" />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(cancelGroup).not.toHaveBeenCalled()
})

test('失敗しても理由と窓を残し、読み直しを案内する', async () => {
  cancelGroup.mockRejectedValue(new Error('conflict'))
  render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" onChanged={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  fireEvent.click(screen.getByRole('button', { name: 'まとめて取り消す' }))
  expect(await screen.findByText(/取り消せませんでした。入力は残っています/)).toBeTruthy()
  expect((screen.getByRole('textbox', { name: '取り消す理由' }) as HTMLInputElement).value).toBe('予定の変更')
  expect(screen.getByRole('button', { name: 'この組を読み直す' })).toBeTruthy()
})

test('確認中に権限が無くなった時は灰の押せない操作に理由を付け、何も送らない', async () => {
  const { rerender } = render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  expect(screen.getByText('取り消す理由を入れてください')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  rerender(<PartySection party={party} canOperate={false} accountId="account-1" currentBookingId="b1" />)
  const confirm = screen.getByRole('button', { name: 'まとめて取り消す' })
  await expectPermissionLocked(confirm)
  fireEvent.click(confirm)
  expect(cancelGroup).not.toHaveBeenCalled()
})

test('理由入力後に権限が無くなっても、独自のキャンセルは破棄確認を通す', async () => {
  const { rerender } = render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  const input = screen.getByRole('textbox', { name: '取り消す理由' }) as HTMLInputElement
  fireEvent.change(input, { target: { value: '予定の変更' } })
  rerender(<PartySection party={party} canOperate={false} accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(await screen.findByRole('dialog', { name: '入力を破棄しますか？' })).toBeTruthy()
  expect(input.value).toBe('予定の変更')
  expect(cancelGroup).not.toHaveBeenCalled()
})

test('読み直す口が無い失敗では何もしないボタンを出さず、入力と再試行の案内を残す', async () => {
  cancelGroup.mockRejectedValue(new Error('down'))
  render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  fireEvent.click(screen.getByRole('button', { name: 'まとめて取り消す' }))
  expect(await screen.findByText(/時間をおいて、もう一度お試しください/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'この組を読み直す' })).toBeNull()
  expect((screen.getByRole('textbox', { name: '取り消す理由' }) as HTMLInputElement).value).toBe('予定の変更')
})

test('版が同じ応答でもエラーを消し、入力理由を保持する', async () => {
  cancelGroup.mockRejectedValue(new Error('conflict'))
  const reload = vi.fn()
  const { rerender } = render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" onReload={reload} />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  fireEvent.click(screen.getByRole('button', { name: 'まとめて取り消す' }))
  await screen.findByText(/取り消せませんでした。入力は残っています/)
  fireEvent.click(screen.getByRole('button', { name: 'この組を読み直す' }))
  expect(reload).toHaveBeenCalledOnce()
  rerender(<PartySection party={{ ...party }} canOperate accountId="account-1" currentBookingId="b1" onReload={reload} />)
  expect(screen.queryByText(/取り消せませんでした。入力は残っています/)).toBeNull()
  expect((screen.getByRole('textbox', { name: '取り消す理由' }) as HTMLInputElement).value).toBe('予定の変更')
})

test('版が変わると最新の対象を示し、理由を保って再確認まで送らない', async () => {
  cancelGroup.mockResolvedValue({ success: true, data: { cancelled: 2, version: 4 } })
  const { rerender } = render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  rerender(<PartySection party={{ ...party, version: 3, members: [{ ...party.members[0], menuName: '新しいメニュー' }, party.members[1]] }} canOperate accountId="account-1" currentBookingId="b1" />)
  const dialog = screen.getByRole('alertdialog')
  expect(dialog.textContent).toContain('新しいメニュー')
  expect(dialog.textContent).toContain('Kenta')
  expect(dialog.textContent).not.toContain('チョコ・爪切り')
  expect((screen.getByRole('textbox', { name: '取り消す理由' }) as HTMLInputElement).value).toBe('予定の変更')
  const confirm = screen.getByRole('button', { name: 'まとめて取り消す' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.click(confirm)
  expect(cancelGroup).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '最新の内容を確認しました' }))
  fireEvent.click(confirm)
  await waitFor(() => expect(cancelGroup).toHaveBeenCalledWith('account-1', 'g1', '予定の変更', 3, [{ bookingId: 'b1', version: 1, status: 'confirmed' }, { bookingId: 'b2', version: 1, status: 'confirmed' }]))
})


test('版変更で取消可能な予約がなくなったら再確認を求めず送らない', () => {
  const { rerender } = render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  rerender(<PartySection party={{ ...party, version: 3, members: party.members.map(member => ({ ...member, status: 'cancelled' })) }} canOperate accountId="account-1" currentBookingId="b1" />)
  expect(screen.getByText(/取り消せる予約がなくなりました/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: '最新の内容を確認しました' })).toBeNull()
  expect((screen.getByRole('button', { name: 'まとめて取り消す' }) as HTMLButtonElement).disabled).toBe(true)
  expect(cancelGroup).not.toHaveBeenCalled()
})

test('版変更と権限喪失が重なれば再確認も取消もできない', () => {
  const { rerender } = render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  rerender(<PartySection party={{ ...party, version: 3 }} canOperate={false} accountId="account-1" currentBookingId="b1" />)
  expect(screen.queryByRole('button', { name: '最新の内容を確認しました' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'まとめて取り消す' }))
  expect(cancelGroup).not.toHaveBeenCalled()
})


test('組の版が同じでも個別予約の版が変わると再確認まで送らない', () => {
  const { rerender } = render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  rerender(<PartySection party={{ ...party, members: [{ ...party.members[0], version: 2 }, party.members[1]] }} canOperate accountId="account-1" currentBookingId="b1" />)
  expect((screen.getByRole('button', { name: 'まとめて取り消す' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('alertdialog').textContent).toContain('最新の内容を確認してください')
  expect(cancelGroup).not.toHaveBeenCalled()
})

test('閉じた組の取消確認を保持しても取り消さない', () => {
  render(<PartySection party={party} canOperate accountId="account-1" currentBookingId="b1" />)
  fireEvent.click(screen.getByRole('button', { name: '組をまとめて取り消す' }))
  fireEvent.change(screen.getByRole('textbox', { name: '取り消す理由' }), { target: { value: '予定の変更' } })
  const button = screen.getByRole('button', { name: 'まとめて取り消す' })
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const held = (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: '破棄する' }))
  held()
  expect(cancelGroup).not.toHaveBeenCalled()
})
