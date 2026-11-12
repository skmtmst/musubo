// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
const fixture = vi.hoisted(() => ({ allowed: true, account: 'account-a', remove: vi.fn(), crumbs: [] as unknown[], confirm: null as null | (() => unknown), openTanaka: null as null | (() => void) }))
vi.mock('@/components/shared/row-actions', async original => {
  const actual = await original<typeof import('@/components/shared/row-actions')>()
  return { ...actual, RowActions: (props: React.ComponentProps<typeof actual.RowActions>) => {
    if (props.subjectName === '田中' && props.destructiveItem?.onSelect) fixture.openTanaka = props.destructiveItem.onSelect
    return <actual.RowActions {...props} />
  } }
})
vi.mock('@/components/shared/confirm-dialog', async original => {
  const actual = await original<typeof import('@/components/shared/confirm-dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.open && props.onConfirm) fixture.confirm = props.onConfirm
    return <actual.default {...props} />
  } }
})
vi.mock('@/lib/use-feature-access', () => ({ usePermissionAccess: () => fixture.allowed }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account }) }))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: () => {}, usePageCrumbs: (crumbs: unknown[]) => { fixture.crumbs = crumbs } }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock() }))
vi.mock('./staff-edit-dialog', () => ({ EMPTY_STAFF: {}, StaffEditModal: () => <div role="dialog" aria-label="スタッフ編集" /> }))
vi.mock('@/lib/api', async original => ({ ...(await original<typeof import('@/lib/api')>()), bookingApi: {
  listStaff: async () => ({ staff: ['佐藤', '田中'].map((name, i) => ({ id: `s${i}`, name, display_name: name, is_active: 1, sort_order: i })) }),
  deleteStaff: (...args: unknown[]) => fixture.remove(...args),
} }))
import StaffPage from './page'
beforeEach(() => { verifiedStaffRole('owner'); fixture.allowed = true; fixture.account = 'account-a'; fixture.crumbs = []; fixture.confirm = null; fixture.openTanaka = null; fixture.remove.mockReset().mockResolvedValue({ ok: true }) })
afterEach(() => { cleanup(); verifiedStaffRole(null) })

it('どのスタッフにもシフト1つとメニュー1つ、編集と最後の削除を保つ', async () => {
  const view = render(<StaffPage />)
  await screen.findByText('佐藤')
  const heading = screen.getByRole('heading', { name: '担当スタッフ' })
  expect(heading.closest('[data-page-template="list"]')).toBeTruthy()
  expect(heading.closest('header')?.contains(screen.getByRole('button', { name: '＋ スタッフを作る' }))).toBe(true)
  expect(view.container.querySelector('nav[aria-label="パンくず"]')).toBeNull()
  expect(fixture.crumbs).toEqual([{ label: '予約設定', href: '/booking/menus' }])
  for (const row of view.container.querySelectorAll('tbody tr')) {
    const actions = row.querySelector('[data-row-actions]')!
    expect(actions?.querySelectorAll(':scope > a, :scope > button')).toHaveLength(2)
    expect(actions.querySelector('[data-row-menu]')).toBeTruthy()
  }
  expect(screen.getAllByRole('link', { name: 'シフト' }).map(e => e.getAttribute('href'))).toEqual(['/booking/staff/shifts?staff_id=s0', '/booking/staff/shifts?staff_id=s1'])
  fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
  expect(screen.getAllByRole('menuitem').map(e => e.textContent)).toEqual(['編集する', '削除する'])
  expect(screen.getByRole('menuitem', { name: '削除する' }).className).toContain('danger')
  fireEvent.click(screen.getByRole('menuitem', { name: '編集する' }))
  expect(screen.getByRole('dialog', { name: 'スタッフ編集' })).toBeTruthy()
})

it('閲覧のみでも同じ操作を残し、理由と実行拒否を保つ', async () => {
  fixture.allowed = false; verifiedStaffRole('viewer')
  render(<StaffPage />)
  await screen.findByText('佐藤')
  const create = screen.getByRole('button', { name: '＋ スタッフを作る' })
  expect(create.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(create)
  fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
  for (const name of ['編集する', '削除する']) {
    const item = screen.getByRole('menuitem', { name })
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect((item as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(item)
  }
  fireEvent.focus(screen.getByRole('menuitem', { name: '削除する' }))
  expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', expect.stringContaining('閲覧のみ'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(fixture.remove).not.toHaveBeenCalled()
})

it('開いたメニューでも権限変更に追従して編集と削除を止める', async () => {
  const view = render(<StaffPage />)
  await screen.findByText('佐藤')
  fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
  fixture.allowed = false; verifiedStaffRole('viewer'); view.rerender(<StaffPage />)
  const item = screen.getByRole('menuitem', { name: '削除する' })
  expect(item.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(item)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(fixture.remove).not.toHaveBeenCalled()
})

it('削除は確認後だけ送り、失敗したら窓で理由を示して再試行できる', async () => {
  fixture.remove.mockRejectedValueOnce(new Error('private backend detail'))
  render(<StaffPage />)
  await screen.findByText('佐藤')
  fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  expect(fixture.remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '削除する' }))
  expect(await screen.findByText('このスタッフを削除できませんでした。状態を読み直してから、もう一度お試しください。')).toBeTruthy()
  expect(screen.queryByText('private backend detail')).toBeNull()
  expect(fixture.remove).toHaveBeenCalledWith('account-a', 's0')
  fireEvent.click(screen.getByRole('button', { name: '削除する' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(fixture.remove).toHaveBeenCalledTimes(2)
})

it('スタッフ削除の対象を表示し、アカウント変更後の古い確認は実行しない', async () => {
  const view = render(<StaffPage />)
  await screen.findByText('佐藤')
  fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const dialog = screen.getByRole('alertdialog')
  expect(dialog.textContent).toContain('LINEアカウント')
  const button = screen.getByRole('button', { name: '削除する' })
  const reactKey = Object.keys(button).find(key => key.startsWith('__reactProps$'))!
  const oldConfirm = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[reactKey].onClick
  fixture.account = 'account-b'; view.rerender(<StaffPage />)
  fixture.account = 'account-a'; view.rerender(<StaffPage />)
  oldConfirm({ preventDefault() {}, stopPropagation() {} })
  expect(fixture.remove).not.toHaveBeenCalled()
})

it('閉じた佐藤の確認を田中の確認中に実行しても削除しない', async () => {
  render(<StaffPage />)
  await screen.findByText('佐藤')
  fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  const oldConfirm = fixture.confirm!
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  fireEvent.click(screen.getByRole('button', { name: '田中のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  await oldConfirm()
  expect(fixture.remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '削除する' }))
  await waitFor(() => expect(fixture.remove).toHaveBeenCalledExactlyOnceWith('account-a', 's1'))
})

it('前の削除が成功しても、次に開いたスタッフの確認を閉じない', async () => {
  let finish!: (value: unknown) => void
  fixture.remove.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<StaffPage />)
  await screen.findByText('佐藤')
  expect(fixture.openTanaka).toBeTypeOf('function')
  const openNext = fixture.openTanaka!
  fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '削除する' }))
  fireEvent.click(screen.getByRole('button', { name: '削除する' }))
  await waitFor(() => expect(fixture.remove).toHaveBeenCalledExactlyOnceWith('account-a', 's0'))
  act(() => openNext())
  expect(screen.getByRole('alertdialog').textContent).toContain('田中')
  await act(async () => finish({ ok: true }))
  expect(screen.getByRole('alertdialog').textContent).toContain('田中')
  expect(fixture.remove).toHaveBeenCalledTimes(1)
})
