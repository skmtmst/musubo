import { pickEntity, pickEntities } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  selectedAccountId: 'account-a' as string | null,
  listStaff: vi.fn(),
  createStaff: vi.fn(),
  updateStaff: vi.fn(),
  deleteStaff: vi.fn(),
  listMenus: vi.fn(),
  putStaffMenus: vi.fn(),
  listMyStaff: vi.fn(),
  staffList: vi.fn(),
  routerPush: vi.fn(),
}))

const accountSetters = new Set<(id: string | null) => void>()
function useControllableAccount(): string | null {
  const [id, setId] = React.useState(fixture.selectedAccountId)
  React.useEffect(() => {
    accountSetters.add(setId)
    return () => { accountSetters.delete(setId) }
  }, [])
  return id
}
function switchAccount(id: string | null): void {
  fixture.selectedAccountId = id
  act(() => { accountSetters.forEach((setId) => setId(id)) })
}

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: useControllableAccount() }),
}))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(), usePageTitle: vi.fn() }))
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: fixture.routerPush }),
}))
vi.mock('@/components/shared/image-uploader', () => ({
  default: ({ value, onChange, label }: {
    value: { url: string } | null
    onChange: (value: { mode: 'url'; url: string } | null) => void
    label: string
  }) => (
    <label>{label}
      <input
        aria-label={`${label}URL`}
        value={value?.url ?? ''}
        onChange={(event) => onChange({ mode: 'url', url: event.target.value })}
      />
    </label>
  ),
}))
vi.mock('@/lib/api', () => ({
  bookingApi: {
    listStaff: (...args: unknown[]) => fixture.listStaff(...args),
    createStaff: (...args: unknown[]) => fixture.createStaff(...args),
    updateStaff: (...args: unknown[]) => fixture.updateStaff(...args),
    deleteStaff: (...args: unknown[]) => fixture.deleteStaff(...args),
    listMenus: (...args: unknown[]) => fixture.listMenus(...args),
    putStaffMenus: (...args: unknown[]) => fixture.putStaffMenus(...args),
    listMyStaff: (...args: unknown[]) => fixture.listMyStaff(...args),
  },
  api: {
    staff: {
      list: (...args: unknown[]) => fixture.staffList(...args),
    },
  },
}))

import BookingStaffPage from './page'
import NewBookingStaffPage from './new/page'

// happy-dom の localStorage はこの環境では未定義。権限表の読み取り
// (staff-capability.ts) が参照するのでインメモリで差し替える。
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}
const storage = new MemoryStorage()
vi.stubGlobal('localStorage', storage)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

async function openCreateModal() {
  render(<BookingStaffPage />)
  await screen.findByText('予約スタッフはまだいません')
  fireEvent.click(screen.getByRole('button', { name: '＋ スタッフを作る' }))
  await screen.findByText('新規スタッフ')
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText(/内部名/), { target: { value: '  見本 170  ' } })
  fireEvent.change(screen.getByLabelText(/表示名/), { target: { value: '  みさき  ' } })
}

beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember);
  fixture.selectedAccountId = 'account-a'
  fixture.listStaff.mockReset().mockResolvedValue({ staff: [] })
  fixture.createStaff.mockReset().mockResolvedValue({ id: 'new-staff' })
  fixture.updateStaff.mockReset().mockResolvedValue({ ok: true })
  fixture.deleteStaff.mockReset().mockResolvedValue({ ok: true })
  fixture.listMenus.mockReset().mockResolvedValue({ menus: [] })
  fixture.putStaffMenus.mockReset().mockResolvedValue({ ok: true })
  fixture.listMyStaff.mockReset().mockResolvedValue({ staff: [] })
  fixture.staffList.mockReset().mockResolvedValue({ success: true, data: [] })
  fixture.routerPush.mockReset()
  // N-411: 画面側の権限制御は localStorage の権限表を読む。
  // 既定は owner（全通過）にし、権限試験では個別に上書きする。
  storage.setItem('lh_staff_role', 'owner'); rememberStaffIdentity({ role: 'owner' } as StaffMember)
  storage.setItem('lh_staff_permissions', '[]')
  storage.setItem('lh_staff_view_permissions', '[]')
})

afterEach(() => {
  cleanup()
  accountSetters.clear()
  storage.clear()
})

describe('予約スタッフ保存前検証（実React）', () => {
  test.each([
    ['空白名', async () => {
      fireEvent.change(screen.getByLabelText(/内部名/), { target: { value: '   ' } })
      fireEvent.change(screen.getByLabelText(/表示名/), { target: { value: '表示名' } })
    }, 'スタッフ名を入力してください'],
    ['過長値', async () => {
      fillRequired()
      fireEvent.change(screen.getByLabelText('紹介文'), { target: { value: 'あ'.repeat(2_001) } })
    }, '紹介文は2000文字以内で入力してください'],
    ['不正URL', async () => {
      fillRequired()
      fireEvent.change(screen.getByLabelText('プロフィール画像URL'), { target: { value: 'javascript:alert(1)' } })
    }, 'プロフィール画像URLはhttp://またはhttps://で始まるURLを入力してください'],
    ['範囲外整数', async () => {
      fillRequired()
      fireEvent.change(screen.getByLabelText('並び順'), { target: { value: '1000001' } })
    }, '並び順は0から1000000までの整数で入力してください'],
  ])('%sは理由を表示し、APIを呼ばない', async (_label, arrange, message) => {
    await openCreateModal()
    await arrange()
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    expect(await screen.findByText(message)).toBeTruthy()
    expect(fixture.createStaff).not.toHaveBeenCalled()
  })

  test('正常値はtrimした値で保存し、一覧を再読込する', async () => {
    await openCreateModal()
    fillRequired()
    fireEvent.change(screen.getByLabelText('役職'), { target: { value: '  店長  ' } })
    fireEvent.change(screen.getByLabelText('紹介文'), { target: { value: '  小型犬が得意です。  ' } })
    fireEvent.change(screen.getByLabelText('プロフィール画像URL'), {
      target: { value: '  https://example.test/staff.png  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))

    await waitFor(() => expect(fixture.createStaff).toHaveBeenCalledWith('account-a', expect.objectContaining({
      name: '見本 170', display_name: 'みさき', role: '店長',
      bio: '小型犬が得意です。', profile_image_url: 'https://example.test/staff.png',
    })))
    await waitFor(() => expect(fixture.listStaff).toHaveBeenCalledTimes(2))
  })

  test('account切替後に遅れて返った旧accountの一覧を表示しない', async () => {
    const oldAccount = deferred<{ staff: Array<Record<string, unknown>> }>()
    fixture.listStaff.mockImplementation((accountId: string) => accountId === 'account-a'
      ? oldAccount.promise
      : Promise.resolve({ staff: [{
        id: 'staff-b', name: 'B店内部名', display_name: 'B店担当', role: null,
        profile_image_url: null, bio: null, sort_order: 0,
        is_designation_optional: 0, is_active: 1,
      }] }))
    render(<BookingStaffPage />)
    switchAccount('account-b')
    expect(await screen.findByText('B店担当')).toBeTruthy()

    oldAccount.resolve({ staff: [{
      id: 'staff-a', name: 'A店内部名', display_name: 'A店担当', role: null,
      profile_image_url: null, bio: null, sort_order: 0,
      is_designation_optional: 0, is_active: 1,
    }] })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('A店担当')).toBeNull()
  })

  test('専用の新規登録画面も空白名を同じ理由で止める', async () => {
    render(<NewBookingStaffPage />)
    fireEvent.change(screen.getByLabelText(/スタッフ名/), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'スタッフを登録する' }))
    expect(await screen.findByText('スタッフ名を入力してください')).toBeTruthy()
    expect(fixture.createStaff).not.toHaveBeenCalled()
  })

  test('専用の新規登録画面もtrimした値を保存する', async () => {
    fixture.listMenus.mockResolvedValue({ menus: [{
      id: 'menu-a', name: 'カット', category_label: null, description: null,
      duration_minutes: 60, buffer_after_minutes: 0, base_price: 5_000,
      price_mode: 'fixed', sort_order: 0, is_active: 1, auto_tag_id: null,
      concurrent_capacity: 1, booking_window_days: null, cutoff_hours_before: null,
      cancel_deadline_hours_before: null, intake_question: null,
      assigned_staff: [], assigned_resources: [], version: 1,
    }] })
    render(<NewBookingStaffPage />)
    fireEvent.change(screen.getByLabelText(/スタッフ名/), { target: { value: '  田中  ' } })
    fireEvent.change(screen.getByLabelText(/お客さま向けの表示名/), { target: { value: '  たなか  ' } })
    fireEvent.change(screen.getByLabelText(/肩書き/), { target: { value: '  店長  ' } })
    fireEvent.change(screen.getByRole('textbox', {name:/顔写真.*URL/}), { target: { value: '  https://example.test/tanaka.png  ' } })
    fireEvent.change(screen.getByLabelText(/紹介文/), { target: { value: '  丁寧に対応します。  ' } })
    await pickEntities('予約を受けられるメニュー', ['カット'])
    fireEvent.click(screen.getByRole('button', { name: 'スタッフを登録する' }))

    await waitFor(() => expect(fixture.createStaff).toHaveBeenCalledWith('account-a', expect.objectContaining({
      name: '田中', display_name: 'たなか', role: '店長',
      profile_image_url: 'https://example.test/tanaka.png', bio: '丁寧に対応します。',
    })))
    await waitFor(() => expect(fixture.putStaffMenus).toHaveBeenCalledWith('account-a', 'new-staff', [{
      menu_id: 'menu-a', is_offered: true,
      override_duration_minutes: null, override_price: null,
    }]))
  })
})

describe('N-411 項目別権限と画面の一致（実React）', () => {
  const STAFF_ROW = {
    id: 'staff-1', name: 'sato', display_name: '佐藤', role: null,
    profile_image_url: null, bio: null, sort_order: 0,
    is_designation_optional: 0, is_active: 1, staff_member_id: null,
  }

  function asStaff(editKeys: string[] = [], viewKeys: string[] = []) {
    rememberStaffIdentity({ role: 'staff', permissionKeys: editKeys, permissionViewKeys: viewKeys } as StaffMember)
    storage.setItem('lh_staff_role', 'staff')
    storage.setItem('lh_staff_permissions', JSON.stringify(editKeys))
    storage.setItem('lh_staff_view_permissions', JSON.stringify(viewKeys))
  }

  test('予約設定の権限が無い staff にも新規・編集・削除を理由付きで残して実行を止める', async () => {
    asStaff(['/booking/bookings'], [])
    fixture.listStaff.mockResolvedValue({ staff: [STAFF_ROW] })
    render(<BookingStaffPage />)
    await screen.findByText('佐藤')
    const create = screen.getByRole('button', { name: '＋ スタッフを作る' })
    expect(create.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(create)
    expect(screen.queryByText('新規スタッフ')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
    for (const name of ['編集する', '削除する']) {
      const item = screen.getByRole('menuitem', { name })
      expect(item.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(item)
    }
    expect(screen.queryByText('スタッフ編集')).toBeNull()
    expect(fixture.createStaff).not.toHaveBeenCalled()
    expect(fixture.updateStaff).not.toHaveBeenCalled()
    expect(fixture.deleteStaff).not.toHaveBeenCalled()
    // シフトへの導線は残す（閲覧権限があれば本人・他人どちらも開ける）
    expect(screen.getByText('シフト')).toBeTruthy()
  })

  test('booking.settings の edit を持つ staff には編集操作を出す', async () => {
    asStaff(['booking.settings'], [])
    fixture.listStaff.mockResolvedValue({ staff: [STAFF_ROW] })
    render(<BookingStaffPage />)
    await screen.findByText('佐藤')
    expect((screen.getByRole('button', { name: '＋ スタッフを作る' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('編集')).toBeNull()
    // 削除は行に直に置かず、…メニューの中の危ない操作にある。
    expect(screen.queryByRole('menuitem', { name: '削除する' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
    expect(screen.getByRole('menuitem', { name: '削除する' })).toBeTruthy()
  })

  test('権限の無い staff が新規登録画面を直URLで開いても保存導線を出さない', async () => {
    asStaff([], [])
    render(<NewBookingStaffPage />)
    expect(await screen.findByText('予約設定の変更権限がありません')).toBeTruthy()
    expect(fixture.createStaff).not.toHaveBeenCalled()
  })

  test('編集モーダルでログインユーザーを選ぶと staff_member_id が保存される', async () => {
    fixture.staffList.mockResolvedValue({
      success: true,
      data: [{
        id: 'member-1', name: '山田', email: 'yamada@example.com', role: 'staff',
        isActive: true,
      }],
    })
    fixture.listStaff.mockResolvedValue({ staff: [STAFF_ROW] })
    render(<BookingStaffPage />)
    await screen.findByText('佐藤')
    fireEvent.click(screen.getByRole('button', { name: '佐藤のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '編集する' }))
    await screen.findByText('スタッフ編集')
    // 共有 Select（button + listbox）。開いて選択肢のボタンを押す。
    await pickEntity('ログインユーザーとの紐づけ', '山田（yamada@example.com）')
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await waitFor(() => expect(fixture.updateStaff).toHaveBeenCalledWith(
      'account-a', 'staff-1', expect.objectContaining({ staff_member_id: 'member-1' }),
    ))
  })
})
