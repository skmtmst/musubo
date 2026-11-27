// @vitest-environment happy-dom
/*
 * E-03 #657: 予約メニュー一覧の編集窓「予約申込時に自動付与するタグ」を、
 * 実物の React で描いて操作する。
 *
 * ソース文字列の検査では次が固定できない。ここでは happy-dom へ実物の画面を
 * マウントし、一覧の取得を実物の Promise で返してから編集窓を開いて確かめる。
 *
 *   - 候補に出るのが「いま選んでいるアカウントの有効なタグ」だけであること
 *     (別アカウント・整理済み(archived)は出ない)
 *   - 設定済みのタグが整理済み・別アカウントになっていたら、黙って「なし」へ
 *     倒さず、使えないことを出して選び直させること
 *   - 選び直した値が保存 request に載ること
 */
import React from 'react'
import { pickEntity, pickEntities } from '@/components/shared/entity-picker-test-helpers'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

const localStorageValues = new Map<string, string>()
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageValues.set(key, String(value)) },
    removeItem: (key: string) => { localStorageValues.delete(key) },
    clear: () => { localStorageValues.clear() },
  },
})

const fixture = vi.hoisted(() => ({
  selectedAccountId: 'account-a' as string | null,
  activeTab: 'menus',
  tagsList: null as null | (() => Promise<unknown>),
  updateMenu: null as null | ((...args: unknown[]) => Promise<unknown>),
  listMenus: null as null | ((...args: unknown[]) => Promise<unknown>),
  getSettings: null as null | ((...args: unknown[]) => Promise<unknown>),
  saveSettings: null as null | ((...args: unknown[]) => Promise<unknown>),
  listResources: null as null | ((...args: unknown[]) => Promise<unknown>),
  saveMenuResources: null as null | ((...args: unknown[]) => Promise<unknown>),
  patchMenu: null as null | ((...args: unknown[]) => Promise<unknown>),
}))

/**
 * account 切替を「実物の React 再レンダー」として起こす口。
 * context を差し替えるのではなく、購読している state を動かすので、
 * 切替後の useEffect（選択の初期化）も本番と同じ順で走る。
 */
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

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('menu=menu-1'),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: useControllableAccount() }),
}))

vi.mock('@/components/layout/merged-tabs', () => ({
  default: () => <nav aria-label="予約設定のタブ" />,
  useMergedTab: () => fixture.activeTab,
}))

vi.mock('@/app/booking/staff/page', () => ({
  default: () => <section>担当スタッフ</section>,
}))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後のメニューの判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label'?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  class ApiError extends Error {
    status: number
    code: string | undefined
    constructor(status: number, message?: string, code?: string) {
      super(message || `API error: ${status}`)
      this.name = 'ApiError'
      this.status = status
      this.code = code
    }
  }
  return {
    ...actual,
    ApiError,
    api: {
      mileage: { rules: async () => ({ success: true, data: [] }) },
      staff: { me: async () => ({ success: true, data: { role: window.localStorage.getItem('lh_staff_role') ?? 'owner', permissionKeys: [] } }) },
      tags: { list: (...args: unknown[]) => fixture.tagsList!(...(args as [])) },
    },
    bookingApi: {
      putStaffMenus: async () => ({ ok: true }),
      getStaffMenus: async () => ({ matrix: [] }),
      listStaff: async () => ({ staff: [{ id: 'staff-a', display_name: '担当A', is_active: 1 }] }),
      listStaffMenusBulk: async () => ({ staff: [{ staff_id: 'staff-a', matrix: [{ menu_id: 'menu-1', is_offered: 1 }] }] }),
      updateMenu: (...args: unknown[]) => fixture.updateMenu!(...args),
      listMenus: (...args: unknown[]) => fixture.listMenus!(...args),
      patchMenu: (...args: unknown[]) => fixture.patchMenu!(...args),
      getSettings: (...args: unknown[]) => fixture.getSettings!(...args),
      saveSettings: (...args: unknown[]) => fixture.saveSettings!(...args),
      listResources: (...args: unknown[]) => fixture.listResources!(...args),
      saveMenuResources: (...args: unknown[]) => fixture.saveMenuResources!(...args),
    },
  }
})

import MenusPage from '@/v8/booking-menus/menu-form'
import { ApiError } from '@/lib/api'

/** 同アカウントの有効タグ／同アカウントの整理済み／別アカウントの有効タグ。 */
const TAGS = [
  { id: 'tag-active', name: '予約中', color: '#111111', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-a', status: 'active' },
  { id: 'tag-active-2', name: '常連さん', color: '#444444', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-a', status: 'active' },
  { id: 'tag-archived', name: '旧キャンペーン', color: '#222222', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-a', status: 'archived' },
  { id: 'tag-other-account', name: 'B店のタグ', color: '#333333', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-b', status: 'active' },
  { id: 'tag-b-only', name: 'B店だけの分類', color: '#555555', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-b', status: 'active' },
]

const SETTINGS = {
  id: null,
  lineAccountId: 'account-a',
  organizationName: '本店',
  version: 0,
  timeZone: 'Asia/Tokyo',
  bookingWindowDays: 60,
  cutoffMinutesBefore: 1440,
  cancelDeadlineMinutesBefore: 1440,
  maxActiveBookingsPerFriend: 1,
  approvalMode: 'automatic',
  holdMinutes: 15,
  slotGranularityMinutes: 15,
  menuCount: 0,
  activeMenuCount: 0,
  inactiveMenuCount: 0,
  businessHours: [],
  exceptions: [],
  updatedAt: '2026-09-01T00:00:00+09:00',
}

/** 選べる中身。プルダウンの option をそのまま読む。 */
function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.querySelectorAll('option')].map((option) => option.textContent ?? '')
}

beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember)
  window.localStorage.setItem('lh_staff_role', 'owner')
  clearToastsForTest()
  fixture.selectedAccountId = 'account-a'
  fixture.activeTab = 'menus'
  fixture.tagsList = async () => ({ success: true, data: TAGS })
  fixture.updateMenu = vi.fn(async () => ({ version: 2 }))
  fixture.patchMenu = vi.fn(async () => ({ ok: true }))
  fixture.listMenus = vi.fn(async () => ({ menus: [] }))
  fixture.getSettings = vi.fn(async () => ({ success: true, data: SETTINGS }))
  fixture.saveSettings = vi.fn(async (_accountId, body: Record<string, unknown>) => ({
    success: true,
    data: { ...SETTINGS, ...body, id: 'settings-a', version: 1 },
  }))
  fixture.listResources = vi.fn(async () => ({ data: { resources: [
    { id: 'room-a', name: '個室A', type: 'room', capacity: 3, isActive: true, version: 1 },
    { id: 'seat-a', name: '席A', type: 'seat', capacity: 2, isActive: true, version: 1 },
  ] } }))
  fixture.saveMenuResources = vi.fn(async (_accountId, _menuId, body: { expectedVersion: number; resources: unknown[] }) => ({
    success: true, data: { id: 'menu-1', version: body.expectedVersion + 1, resources: body.resources },
  }))
})

afterEach(() => {
  cleanup()
  forgetStaffIdentity()
  accountSetters.clear()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('V8メニュー編集: 共有設備の割当', () => {
  function menu() {
    return {
      id: 'menu-1', name: 'カット', category_label: null, description: null,
      duration_minutes: 60, buffer_after_minutes: 0, base_price: 8000,
      price_mode: 'fixed', sort_order: 0, is_active: 1, auto_tag_id: null,
      concurrent_capacity: 1, booking_window_days: null, cutoff_hours_before: null,
      cancel_deadline_hours_before: null, intake_question: null, assigned_staff: [{ id: 'staff-a', display_name: '担当A' }],
      assigned_resources: [{
        menuId: 'menu-1', resourceId: 'room-a', name: '個室A', type: 'room', capacity: 3,
        quantity: 1, isActive: true, warning: null,
      }],
      version: 1,
    }
  }

  async function openEditor(target = menu()) {
    fixture.listMenus = vi.fn(async () => ({ menus: [target] }))
    render(<><MenusPage /><ToastHost /></>)
    await screen.findByText('予約メニューを直す')
  }

  test('複数選択・quantityを独立保存し、連打しても1要求だけ送る', async () => {
    let resolveSave!: (value: unknown) => void
    fixture.saveMenuResources = vi.fn(() => new Promise((resolve) => { resolveSave = resolve }))
    await openEditor()
    await screen.findByText('個室A')
    // 絵 ：設備は札＋［変える］。窓で足して「選ぶ（2件）」で決める。
    fireEvent.click(screen.getByRole('button', { name: '使う設備：変更する' }))
    const picker = await screen.findByRole('dialog')
    fireEvent.click(within(picker).getByRole('checkbox', { name: '席A' }))
    fireEvent.click(within(picker).getByRole('button', { name: '選択する（2件）' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.change(screen.getByRole('spinbutton', { name: '個室Aの必要数' }), { target: { value: '2' } })
    const saveButton = screen.getByRole('button', { name: '設備の割当を保存する' })
    // 同じ描画中に2イベントを届け、disabledへの再描画ではなくuseRefの
    // single-flight guardそのものが二重要求を止めることを確かめる。
    act(() => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(fixture.saveMenuResources).toHaveBeenCalledTimes(1)
    expect(fixture.saveMenuResources).toHaveBeenCalledWith('account-a', 'menu-1', {
      expectedVersion: 1,
      resources: [{ resourceId: 'room-a', quantity: 2 }, { resourceId: 'seat-a', quantity: 1 }],
    })
    await act(async () => {
      resolveSave({ success: true, data: { id: 'menu-1', version: 2, resources: [] } })
      await Promise.resolve()
    })
    // 画面の中の知らせ（role=status）。置き場所の知らせの入れ物も role=status なので、全部の中から文で見る
    expect(screen.getAllByRole('status').map((el) => el.textContent).join('\n')).toContain('設備の割当を保存しました')
  })

  test('409でも入力を保持し、最新内容の読み直しを案内する', async () => {
    fixture.saveMenuResources = vi.fn(async () => { throw new ApiError(409, 'conflict', 'version_conflict') })
    await openEditor()
    const quantity = await screen.findByRole('spinbutton', { name: '個室Aの必要数' })
    fireEvent.change(quantity, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    await waitFor(() => expect(screen.getAllByRole('status').map((el) => el.textContent).join('\n')).toContain('最新の内容を読み直して'))
    expect((quantity as HTMLInputElement).value).toBe('2')
  })

  test('account切替後に旧保存応答を画面へ反映しない', async () => {
    let resolveSave!: (value: unknown) => void
    fixture.saveMenuResources = vi.fn(() => new Promise((resolve) => { resolveSave = resolve }))
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    fixture.listMenus = vi.fn(async (accountId) => ({ menus: accountId === 'account-a' ? [menu()] : [] }))
    switchAccount('account-b')
    await act(async () => {
      resolveSave({ success: true, data: { id: 'menu-1', version: 2, resources: [] } })
      await Promise.resolve()
    })
    expect(screen.queryByText('設備の割当を保存しました。新しい予約枠から反映されます。')).toBeNull()
    expect(screen.queryByText('予約メニューを直す')).toBeNull()
  })

  test('staffは割当を閲覧できるが変更・保存できない', async () => {
    window.localStorage.setItem('lh_staff_role', 'staff')
    forgetStaffIdentity(); rememberStaffIdentity({ role: 'staff', permissionKeys: ['/booking/menus'] } as StaffMember)
    await openEditor()
    expect(await screen.findByText('設備の割当は閲覧のみです。変更は管理者へ依頼してください。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '設備の割当を保存する' })).toBeNull()
    // 閲覧のみは札を外せず、欄は「見る」だけ。
    expect(screen.queryByRole('button', { name: '個室Aを外す' })).toBeNull()
    expect(screen.queryByRole('button', { name: '使う設備：変更する' })).toBeNull()
  })

  test.each(['', '0', '-1', '1.5', '1001'])('必要数%sは送信せず、入力を残す', async (value) => {
    await openEditor()
    const quantity = await screen.findByRole('spinbutton', { name: '個室Aの必要数' })
    fireEvent.change(quantity, { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    expect(screen.getAllByRole('status').map((element) => element.textContent).join('\n')).toContain('必要数は1〜1000の整数')
    expect(fixture.saveMenuResources).not.toHaveBeenCalled()
    expect((quantity as HTMLInputElement).value).toBe(value)
  })

  test('設備の独立保存は名前を保存せず、名前の離脱確認を残す', async () => {
    await openEditor()
    fireEvent.change(screen.getByRole('textbox', { name: 'メニュー名' }), { target: { value: '直しかけ' } })
    fireEvent.change(await screen.findByRole('spinbutton', { name: '個室Aの必要数' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    await screen.findByText('設備の割当を保存しました。新しい予約枠から反映されます。')
    expect(fixture.updateMenu).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox', { name: 'メニュー名' }) as HTMLInputElement).value).toBe('直しかけ')
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  test('設備だけ保存した後は次の版を使い、離脱時に未保存と扱わない', async () => {
    await openEditor()
    const quantity = await screen.findByRole('spinbutton', { name: '個室Aの必要数' })
    fireEvent.change(quantity, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    await screen.findByText('設備の割当を保存しました。新しい予約枠から反映されます。')
    fireEvent.change(quantity, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    await waitFor(() => expect(fixture.saveMenuResources).toHaveBeenCalledTimes(2))
    expect(fixture.saveMenuResources).toHaveBeenLastCalledWith('account-a', 'menu-1', { expectedVersion: 2, resources: [{ resourceId: 'room-a', quantity: 3 }] })
    await waitFor(() => expect((screen.getByRole('button', { name: '設備の割当を保存する' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('通常の取得失敗後も必要数を残し、同じ入力で再試行できる', async () => {
    fixture.saveMenuResources = vi.fn().mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ success: true, data: { version: 2 } })
    await openEditor()
    const quantity = await screen.findByRole('spinbutton', { name: '個室Aの必要数' })
    fireEvent.change(quantity, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    await screen.findByText('設備の割当を保存できませんでした。入力は残っています。もう一度お試しください。')
    expect((quantity as HTMLInputElement).value).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    await screen.findByText('設備の割当を保存しました。新しい予約枠から反映されます。')
    expect(fixture.saveMenuResources).toHaveBeenNthCalledWith(2, 'account-a', 'menu-1', { expectedVersion: 1, resources: [{ resourceId: 'room-a', quantity: 2 }] })
  })

  test('停止済みで候補から消えた設備も割当を見せ、外した値を保存できる', async () => {
    fixture.listResources = vi.fn(async () => ({ data: { resources: [] } }))
    const target = menu()
    target.assigned_resources[0].isActive = false
    await openEditor(target)
    const quantity = await screen.findByRole('spinbutton', { name: '個室Aの必要数' })
    expect((quantity as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '個室A（停止中）を外す' }))
    expect(screen.queryByRole('spinbutton', { name: '個室Aの必要数' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    await waitFor(() => expect(fixture.saveMenuResources).toHaveBeenCalledWith('account-a', 'menu-1', { expectedVersion: 1, resources: [] }))
  })

  test('必要数の保存エラーを欄へ返し、訂正後は同じ設備を再保存できる', async () => {
    fixture.saveMenuResources = vi.fn().mockRejectedValueOnce({ status: 422, fields: { 'resources.0.quantity': '空きの数を超えています' } })
      .mockResolvedValue({ success: true, data: { version: 2 } })
    await openEditor()
    const quantity = await screen.findByRole('spinbutton', { name: '個室Aの必要数' })
    fireEvent.change(quantity, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    await screen.findByText('空きの数を超えています')
    expect(quantity.getAttribute('aria-invalid')).toBe('true')
    expect((quantity as HTMLInputElement).value).toBe('3')
    expect(screen.queryByText('設備の割当を保存できませんでした。入力は残っています。もう一度お試しください。')).toBeNull()
    fireEvent.change(quantity, { target: { value: '2' } })
    expect(screen.queryByText('空きの数を超えています')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '設備の割当を保存する' }))
    await screen.findByText('設備の割当を保存しました。新しい予約枠から反映されます。')
    expect(fixture.saveMenuResources).toHaveBeenLastCalledWith('account-a', 'menu-1', { expectedVersion: 1, resources: [{ resourceId: 'room-a', quantity: 2 }] })
  })
})

describe('V8メニュー編集: 予約申込時に自動付与するタグ', () => {
  function menu(overrides: Record<string, unknown> = {}) {
    return {
      id: 'menu-1',
      name: 'カット',
      category_label: null,
      description: null,
      duration_minutes: 60,
      buffer_after_minutes: 0,
      base_price: 8000,
      price_mode: 'fixed',
      sort_order: 0,
      is_active: 1,
      auto_tag_id: null as string | null,
      concurrent_capacity: 1,
      booking_window_days: null,
      cutoff_hours_before: null,
      cancel_deadline_hours_before: null,
      intake_question: null,
      assigned_staff: [{ id: 'staff-a', display_name: '担当A' }],
      version: 1,
      ...overrides,
    }
  }

  async function openEditor(target: Record<string, unknown>) {
    fixture.listMenus = vi.fn(async () => ({ menus: [menu(target)] }))
    render(<><MenusPage /><ToastHost /></>)
    await screen.findByText('予約メニューを直す')
  }
  async function tagLabels() {
    fireEvent.click(await screen.findByRole('button', { name: '予約後に付けるタグ' }))
    const dialog = (await screen.findAllByRole('dialog')).at(-1)!
    const labels = within(dialog).queryAllByRole('radio').map((item) => item.getAttribute('aria-label'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    return labels
  }
  function chosenTag() {
    return screen.getByRole('button', { name: '予約後に付けるタグ' }).closest('[data-entity-picker-field]')!.textContent
  }

  test('候補は対象アカウントの有効タグだけ。整理済みも別アカウントも出さない', async () => {
    await openEditor({ auto_tag_id: null })
    const labels = await tagLabels()
    expect(labels).toEqual(['予約中', '常連さん'])
    expect(labels).not.toContain('旧キャンペーン')
    expect(labels).not.toContain('B店のタグ')
  })

  test('アカウントを切り替えると、候補も切替先の有効タグになる', async () => {
    await openEditor({ auto_tag_id: null })
    expect(await tagLabels()).toEqual(['予約中', '常連さん'])
    switchAccount('account-b')
    await waitFor(() => expect(fixture.tagsList).toBeTruthy())
    await screen.findByRole('button', { name: '予約後に付けるタグ' })
    expect(await tagLabels()).toEqual(['B店のタグ', 'B店だけの分類'])
  })

  test('設定済みのタグが整理済みなら、黙って「なし」にせず選び直させる', async () => {
    await openEditor({ auto_tag_id: 'tag-archived' })

    // 値は残す。勝手に「なし」へ倒して気付かないまま保存させない。
    expect(chosenTag()).toContain('旧キャンペーン（今は使えません）')
    expect(await tagLabels()).toContain('旧キャンペーン（今は使えません）')
    expect(screen.getByText(
      '設定されていたタグは整理済みか、このアカウントのタグではありません。選び直すか「なし」にしてください。',
    )).toBeTruthy()
  })

  test('設定済みのタグが別アカウントのものでも、同じように選び直させる', async () => {
    await openEditor({ auto_tag_id: 'tag-other-account' })
    expect(chosenTag()).toContain('B店のタグ（今は使えません）')
    expect(screen.getByText(
      '設定されていたタグは整理済みか、このアカウントのタグではありません。選び直すか「なし」にしてください。',
    )).toBeTruthy()
  })

  test('選び直して保存すると、新しい auto_tag_id が保存 request に載る', async () => {
    await openEditor({ auto_tag_id: 'tag-archived' })
    await pickEntity('予約後に付けるタグ', '常連さん')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '変更を保存する' }))
    })

    await waitFor(() => { expect(fixture.updateMenu).toHaveBeenCalled() })
    expect(fixture.updateMenu).toHaveBeenCalledWith(
      'account-a',
      'menu-1',
      1,
      expect.objectContaining({ auto_tag_id: 'tag-active-2' }),
    )
  })

  test('使えるタグが1つも無いアカウントでは、タグなしで保存できることを出す', async () => {
    fixture.tagsList = async () => ({ success: true, data: [TAGS[3]] })
    await openEditor({ auto_tag_id: null })
    expect(screen.queryByRole('button', { name: '予約後に付けるタグ' })).toBeNull()
    expect(screen.getByText('このアカウントに使えるタグがありません。タグなしで保存できます。')).toBeTruthy()
  })
})
