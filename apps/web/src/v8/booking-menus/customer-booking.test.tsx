// @vitest-environment happy-dom
/*
 * 予約メニューの「お客さまの予約のしかた」（要件 B4・B5）。
 * - 管理者が入れた繰り返し・人数・追加メニュー・追加専用は、メニューの保存の口へ送る
 * - 読めない繰り返しの設定は上書きしない（入れ直すと送る）
 * - スタッフには読むだけで出し、保存にも載せない（口が管理者だけなので、載せるとメニューごと保存できない）
 */
import React from 'react'
import { pickEntities } from '@/components/shared/entity-picker-test-helpers'
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addonCandidates, readCustomerBooking, recurringError, useMenuCustomerBooking } from './customer-booking'
import { ApiError, type BookingMenu } from '@/lib/api'

const nav = vi.hoisted(() => ({ menu: null as string | null, push: vi.fn() }))
const who = vi.hoisted(() => ({ role: 'admin' as string | null }))
const net = vi.hoisted(() => ({
  createMenu: vi.fn(), updateMenu: vi.fn(), putStaffMenus: vi.fn(),
  menus: [] as unknown[],
  matrix: [] as unknown[],
  tags: [] as Array<{ id: string; name: string }>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.menu ? `menu=${nav.menu}` : ''),
  usePathname: () => '/booking/menus/new',
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', selectedAccount: null }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('./lib/edit-permission', () => ({ useBookingEdit: () => true }))
vi.mock('@/lib/use-feature-access', () => ({ usePermissionAccess: () => true }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: vi.fn(), notifySaved: vi.fn() }))
vi.mock('./menu-version-history', () => ({ default: () => null }))
vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => who.role }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: { ...actual.api, tags: { ...actual.api.tags, list: async () => ({ success: true, data: net.tags }) }, friends: { ...actual.api.friends, list: async () => ({ success: true, data: { items: [] } }) } },
    bookingApi: {
      ...actual.bookingApi,
      listMenus: async () => ({ menus: net.menus }),
      listStaff: async () => ({ staff: [{ id: 's1', name: '高田', display_name: '高田', role: 'トリマー', is_active: 1, is_designation_optional: 0 }] }),
      getSettings: async () => ({ success: true, data: { exceptions: [], businessHours: [] } }),
      listResources: async () => ({ success: true, data: { resources: [] } }),
      listStaffMenusBulk: async () => ({ staff: [{ staff_id: 's1', matrix: net.matrix }] }),
      getStaffMenus: async () => ({ matrix: [] }),
      saveMenuResources: async () => ({ success: true, data: { version: 1 } }),
      createMenu: (...args: unknown[]) => net.createMenu(...args),
      updateMenu: (...args: unknown[]) => net.updateMenu(...args),
      putStaffMenus: (...args: unknown[]) => net.putStaffMenus(...args),
      getPaymentConfig: async () => ({ success: true, data: { mode: 'onsite', provider: 'onsite', holdMinutes: 10, keyConfigured: false, testMode: true } }),
    },
  }
})
vi.mock('@/lib/api/helpers/booking-payment-admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/helpers/booking-payment-admin')>()
  return {
    ...actual,
    bookingPaymentAdminApi: {
      ...actual.bookingPaymentAdminApi,
      connection: async () => ({ success: true, data: { connected: false, testMode: true, accountIdTail: null, connectedAt: null, dashboardUrl: null } }),
      menuOverrides: async () => ({ success: true, data: { menus: [] } }),
    },
  }
})

const { default: MenuFormV8 } = await import('./menu-form')
const { notifySaved } = await import('@/components/shared/toast')

const menu = (over: Record<string, unknown> = {}) => ({
  id: 'm1', name: 'カット', category_label: null, description: null, duration_minutes: 60, base_price: 3000,
  price_mode: 'fixed', concurrent_capacity: 1, buffer_after_minutes: 0, booking_window_days: null,
  cutoff_hours_before: null, cancel_deadline_hours_before: null, intake_question: null, auto_tag_id: null,
  is_active: 1, sort_order: 1, version: 3, assigned_staff: [{ id: 's1', display_name: '高田' }], assigned_resources: [], ...over,
})
const spa = menu({ id: 'spa', name: 'ヘッドスパ', duration_minutes: 15, base_price: 1500 })
const ask = menu({ id: 'ask', name: '相談', price_mode: 'inquiry', base_price: 0 })

const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() }) }
const card = () => screen.getByLabelText('お客さまの予約のしかた')
const sentBody = (fn: typeof net.createMenu, index: number) => fn.mock.calls[0]![index] as Record<string, unknown>

async function choosePartySize(label: string) {
  await act(async () => { fireEvent.click(within(card()).getByRole('button', { name: '一度に予約できる人数' })) })
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: label }).querySelector('button')!) })
}

beforeEach(() => {
  vi.mocked(notifySaved).mockClear()
  nav.menu = null
  who.role = 'admin'
  net.menus = [spa, ask]
  net.matrix = []
  net.tags = []
  for (const fn of [net.createMenu, net.updateMenu, net.putStaffMenus, nav.push]) fn.mockReset()
  net.putStaffMenus.mockResolvedValue({ ok: true })
})
afterEach(cleanup)

describe('お客さまの予約のしかた（作る）', () => {
  it('管理者が入れた繰り返し・人数・追加メニューを、メニューの保存の口へ送る', async () => {
    net.createMenu.mockImplementation(async () => { net.menus = [spa, ask, menu({ id: 'new-1', version: 1 })]; return { id: 'new-1' } })
    render(<MenuFormV8 />)
    await settle()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カット' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '高田', exact: true }))
    fireEvent.click(within(card()).getByRole('checkbox', { name: /お客さまも繰り返しで予約できる/ }))
    fireEvent.click(within(card()).getByRole('checkbox', { name: '隔週' }))
    fireEvent.change(within(card()).getByRole('spinbutton', { name: '最大の回数' }), { target: { value: '8' } })
    await choosePartySize('3人まで')
    await pickEntities('追加メニュー', ['ヘッドスパ'])
    await act(async () => { screen.getByRole('button', { name: /保存して公開/ }).click() })
    await settle()
    expect(net.createMenu).toHaveBeenCalledTimes(1)
    expect(sentBody(net.createMenu, 1)).toEqual(expect.objectContaining({
      recurring: { enabled: true, freqs: ['weekly', 'biweekly'], maxCount: 8 },
      maxPartySize: 3,
      addonMenuIds: ['spa'],
    }))
    expect(sentBody(net.createMenu, 1)).not.toHaveProperty('addonOnly')
  })

  it('最大の回数が 2〜12 の外なら、保存の前に止めて直し方を出す', async () => {
    render(<MenuFormV8 />)
    await settle()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カット' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '高田', exact: true }))
    fireEvent.click(within(card()).getByRole('checkbox', { name: /お客さまも繰り返しで予約できる/ }))
    fireEvent.change(within(card()).getByRole('spinbutton', { name: '最大の回数' }), { target: { value: '13' } })
    await act(async () => { screen.getByRole('button', { name: /保存して公開/ }).click() })
    await settle()
    expect(net.createMenu).not.toHaveBeenCalled()
    expect(screen.getAllByText('最大の回数は2〜12の整数で入力してください。').length).toBeGreaterThan(0)
  })

  it('追加専用にすると、ほかの欄は出さず addonOnly だけを送る', async () => {
    net.createMenu.mockImplementation(async () => { net.menus = [spa, ask, menu({ id: 'new-1', version: 1 })]; return { id: 'new-1' } })
    render(<MenuFormV8 />)
    await settle()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'トリートメント' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '高田', exact: true }))
    fireEvent.click(within(card()).getByRole('checkbox', { name: /追加専用のメニューにする/ }))
    expect(within(card()).queryByRole('checkbox', { name: /お客さまも繰り返しで予約できる/ })).toBeNull()
    await act(async () => { screen.getByRole('button', { name: /保存して公開/ }).click() })
    await settle()
    expect(sentBody(net.createMenu, 1)).toEqual(expect.objectContaining({ addonOnly: true }))
    expect(sentBody(net.createMenu, 1)).not.toHaveProperty('recurring')
  })
})

describe('お客さまの予約のしかた（直す）', () => {
  it('保存済みの人数・追加メニューを読み、変えていなければ送らない。読めない繰り返しは入れ直すと送る', async () => {
    nav.menu = 'm1'
    net.menus = [menu({ max_party_size: 2, addon_menu_ids_json: '["spa"]', addon_only: 0 }), spa, ask]
    net.matrix = [{ menu_id: 'm1', name: 'カット', is_offered: 1, override_duration_minutes: null, override_price: null }]
    net.updateMenu.mockResolvedValue({ version: 4 })
    render(<MenuFormV8 />)
    await settle()
    expect(within(card()).getByRole('button', { name: '一度に予約できる人数' }).textContent).toContain('2人まで')
    expect(within(card()).getByText(/この画面ではまだ読み出せません/)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カット（直し）' } })
    await act(async () => { screen.getByRole('button', { name: /変更を保存する/ }).click() })
    await settle()
    const first = net.updateMenu.mock.calls[0]![3] as Record<string, unknown>
    for (const key of ['recurring', 'maxPartySize', 'addonMenuIds', 'addonOnly']) expect(first).not.toHaveProperty(key)

    fireEvent.click(within(card()).getByRole('button', { name: '繰り返しの設定を入れ直す' }))
    fireEvent.click(within(card()).getByRole('checkbox', { name: /お客さまも繰り返しで予約できる/ }))
    await act(async () => { screen.getByRole('button', { name: /変更を保存する/ }).click() })
    await settle()
    const second = net.updateMenu.mock.calls[1]![3] as Record<string, unknown>
    expect(second.recurring).toEqual({ enabled: true, freqs: ['weekly'], maxCount: 12 })
  })

  it('人数だけ変えても、ページを離れるときに止める（入力途中の扱い）', async () => {
    nav.menu = 'm1'
    net.menus = [menu(), spa]
    net.matrix = [{ menu_id: 'm1', name: 'カット', is_offered: 1, override_duration_minutes: null, override_price: null }]
    render(<MenuFormV8 />)
    await settle()
    const before = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(false)
    await choosePartySize('2人まで')
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(true)
  })

  it('返ってきた繰り返しの設定はそのまま欄に出す', async () => {
    nav.menu = 'm1'
    net.menus = [menu({ customer_recurring_enabled: 1, recurring_freqs_json: '["weekly","monthly_nth"]', recurring_max_count: 6 }), spa]
    render(<MenuFormV8 />)
    await settle()
    expect((within(card()).getByRole('checkbox', { name: /お客さまも繰り返しで予約できる/ }) as HTMLInputElement).checked).toBe(true)
    expect((within(card()).getByRole('checkbox', { name: '毎月第 n 曜日' }) as HTMLInputElement).checked).toBe(true)
    expect((within(card()).getByRole('checkbox', { name: '隔週' }) as HTMLInputElement).checked).toBe(false)
    expect((within(card()).getByRole('spinbutton', { name: '最大の回数' }) as HTMLInputElement).value).toBe('6')
  })

  it('スタッフには読むだけで出し、メニューの保存にも載せない', async () => {
    who.role = 'staff'
    nav.menu = 'm1'
    net.menus = [menu({ max_party_size: 3, addon_menu_ids_json: '["spa"]' }), spa]
    net.matrix = [{ menu_id: 'm1', name: 'カット', is_offered: 1, override_duration_minutes: null, override_price: null }]
    net.updateMenu.mockResolvedValue({ version: 4 })
    render(<MenuFormV8 />)
    await settle()
    expect(within(card()).queryByRole('checkbox')).toBeNull()
    expect(within(card()).getByText('3人まで')).toBeTruthy()
    expect(within(card()).getByText('ヘッドスパ')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カット（直し）' } })
    await act(async () => { screen.getByRole('button', { name: /変更を保存する/ }).click() })
    await settle()
    const body = net.updateMenu.mock.calls[0]![3] as Record<string, unknown>
    for (const key of ['recurring', 'maxPartySize', 'addonMenuIds', 'addonOnly']) expect(body).not.toHaveProperty(key)
  })
})

describe('お客さまの予約のしかたの判定', () => {
  it('追加メニューの候補は固定の料金のほかのメニューだけ', () => {
    const list = [menu(), spa, ask, menu({ id: 'free', name: '無料', price_mode: 'free', base_price: 0 })] as BookingMenu[]
    expect(addonCandidates(list, 'm1').map((item) => item.id)).toEqual(['spa'])
  })
  it('繰り返しの誤り：オフなら見ない・間隔0件と回数の範囲外は止める', () => {
    expect(recurringError({ enabled: false, freqs: [], maxCount: '99' })).toBeNull()
    expect(recurringError({ enabled: true, freqs: [], maxCount: '12' })).toBe('選べる間隔を1つ以上選んでください。')
    expect(recurringError({ enabled: true, freqs: ['weekly'], maxCount: '1' })).toBe('最大の回数は2〜12の整数で入力してください。')
    expect(recurringError({ enabled: true, freqs: ['weekly'], maxCount: '2' })).toBeNull()
  })
  it('作る画面は既定（繰り返しオフ・1人・追加なし）、返らない繰り返しは null', () => {
    expect(readCustomerBooking(null)).toEqual({ recurring: { enabled: false, freqs: ['weekly'], maxCount: '12' }, maxPartySize: 1, addonMenuIds: [], addonOnly: false })
    expect(readCustomerBooking(menu() as BookingMenu).recurring).toBeNull()
  })
  it('変えられない人の状態は、値が変わっても保存に何も足さず「直しかけ」にもしない', () => {
    const { result } = renderHook(() => useMenuCustomerBooking(false))
    act(() => { result.current.setMaxPartySize(3); result.current.setAddonOnly(true); result.current.setRecurring({ enabled: true }) })
    expect(result.current.body()).toEqual({})
    expect(result.current.dirty).toBe(false)
    const admin = renderHook(() => useMenuCustomerBooking(true))
    act(() => { admin.result.current.setMaxPartySize(3) })
    expect(admin.result.current.body()).toEqual({ maxPartySize: 3 })
    expect(admin.result.current.dirty).toBe(true)
  })
})


describe('見せる相手の保存と読み直し', () => {
  it.each(['include_tags', 'exclude_tags'] as const)('作成した%sの条件を保存先の項目で送り、開き直しても保つ', async (mode) => {
    net.tags = [{ id: 'member', name: '会員' }]
    net.createMenu.mockImplementation(async (_account, body) => {
      net.menus = [menu({ audience_mode: body.audienceMode, audience_tag_ids_json: JSON.stringify(body.audienceTagIds) })]
      return { id: 'm1' }
    })
    const view = render(<MenuFormV8 />)
    await settle()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カット' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '高田', exact: true }))
    fireEvent.click(screen.getByRole('radio', { name: mode === 'include_tags' ? 'タグが付いた人だけに見せる' : 'タグが付いた人には見せない' }))
    await pickEntities('見せる相手のタグ', ['会員'])
    fireEvent.click(screen.getByRole('button', { name: '保存して公開' }))
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith('/booking/menus?highlight=m1'))
    const body = sentBody(net.createMenu, 1)
    expect(body).toMatchObject({ audienceMode: mode, audienceTagIds: ['member'] })
    expect(body).not.toHaveProperty('audience_mode')
    expect(body).not.toHaveProperty('audience_tag_ids')
    view.unmount()
    nav.menu = 'm1'
    render(<MenuFormV8 />)
    await settle()
    expect((screen.getByRole('radio', { name: mode === 'include_tags' ? 'タグが付いた人だけに見せる' : 'タグが付いた人には見せない' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('button', { name: '見せる相手のタグ：変更する' }).textContent).toContain('会員')
  })

  it('編集で全員へ戻すと保存先へ空のタグを送り、読み直しても全員のまま', async () => {
    nav.menu = 'm1'
    net.matrix = [{ menu_id: 'm1', name: 'カット', is_offered: 1, override_duration_minutes: null, override_price: null }]
    net.tags = [{ id: 'member', name: '会員' }]
    net.menus = [menu({ audience_mode: 'include_tags', audience_tag_ids_json: '["member"]' })]
    net.updateMenu.mockImplementation(async (_account, _id, _version, body) => {
      net.menus = [menu({ version: 4, audience_mode: body.audienceMode, audience_tag_ids_json: JSON.stringify(body.audienceTagIds) })]
      return { ok: true, version: 4 }
    })
    const view = render(<MenuFormV8 />)
    await settle()
    fireEvent.click(screen.getByRole('radio', { name: '全員に見せる' }))
    fireEvent.click(screen.getByRole('button', { name: '変更を保存する' }))
    await settle()
    await vi.waitFor(() => expect(notifySaved).toHaveBeenCalledWith('メニューを保存しました'))
    expect(sentBody(net.updateMenu, 3)).toMatchObject({ audienceMode: 'all', audienceTagIds: [] })
    view.unmount()
    render(<MenuFormV8 />)
    await settle()
    expect((screen.getByRole('radio', { name: '全員に見せる' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole('button', { name: /見せる相手のタグ/ })).toBeNull()
  })

  it.each(['staff', 'viewer', null])('変更権限がない役割%sの保存にはタグ条件を混ぜない', async (role) => {
    who.role = role
    net.matrix = [{ menu_id: 'm1', name: 'カット', is_offered: 1, override_duration_minutes: null, override_price: null }]
    nav.menu = 'm1'
    net.menus = [menu({ audience_mode: 'include_tags', audience_tag_ids_json: '["member"]' })]
    net.updateMenu.mockResolvedValue({ ok: true, version: 4 })
    render(<MenuFormV8 />)
    await settle()
    expect(screen.queryByRole('radio', { name: '全員に見せる' })).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カットを変更' } })
    fireEvent.click(screen.getByRole('button', { name: '変更を保存する' }))
    await vi.waitFor(() => expect(net.updateMenu).toHaveBeenCalled())
    const body = net.updateMenu.mock.calls[0][3]
    for (const key of ['audienceMode', 'audienceTagIds', 'audience_mode', 'audience_tag_ids']) expect(body).not.toHaveProperty(key)
  })
})


describe('タグ条件の保存前確認と変更しない設定の保護', () => {
  it.each(['タグが付いた人だけに見せる', 'タグが付いた人には見せない'])('%sでタグが空なら送らず直し方を出す', async (label) => {
    render(<MenuFormV8 />)
    await settle()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カット' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '高田', exact: true }))
    fireEvent.click(screen.getByRole('radio', { name: label }))
    fireEvent.click(screen.getByRole('button', { name: '保存して公開' }))
    await settle()
    expect(net.createMenu).not.toHaveBeenCalled()
    expect(screen.getAllByText('見せる相手のタグを1つ以上選んでください。').length).toBeGreaterThan(0)
  })

  it.each(['admin', 'owner'])('%sが名前だけ変えた場合は、削除済みタグを再検証する項目を送らない', async (role) => {
    who.role = role
    nav.menu = 'm1'
    net.menus = [menu({ audience_mode: 'include_tags', audience_tag_ids_json: '["deleted"]' })]
    net.matrix = [{ menu_id: 'm1', name: 'カット', is_offered: 1, override_duration_minutes: null, override_price: null }]
    net.updateMenu.mockResolvedValue({ version: 4 })
    render(<MenuFormV8 />)
    await settle()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カットを変更' } })
    fireEvent.click(screen.getByRole('button', { name: '変更を保存する' }))
    await vi.waitFor(() => expect(net.updateMenu).toHaveBeenCalledTimes(1))
    const body = sentBody(net.updateMenu, 3)
    expect(body).not.toHaveProperty('audienceMode')
    expect(body).not.toHaveProperty('audienceTagIds')
  })

  it('選択後にタグが使えなくなった場合は選び直す案内を出す', async () => {
    net.tags = [{ id: 'member', name: '会員' }]
    net.createMenu.mockRejectedValue(new ApiError(400, undefined, 'invalid_audience_tags'))
    render(<MenuFormV8 />)
    await settle()
    fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カット' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '高田', exact: true }))
    fireEvent.click(screen.getByRole('radio', { name: 'タグが付いた人だけに見せる' }))
    await pickEntities('見せる相手のタグ', ['会員'])
    fireEvent.click(screen.getByRole('button', { name: '保存して公開' }))
    await vi.waitFor(() => expect(screen.getAllByText('選んだタグは利用できないため保存できませんでした。タグを選び直してください。').length).toBeGreaterThan(0))
    expect(net.createMenu).toHaveBeenCalledTimes(1)
  })
})

it('新規作成の初期値はAPIの全員を使い、管理者用のタグ変更項目を送らない', async () => {
  net.createMenu.mockResolvedValue({ id: 'm1' })
  render(<MenuFormV8 />)
  await settle()
  fireEvent.change(screen.getByPlaceholderText('例：トリミング（小型犬）'), { target: { value: 'カット' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '高田', exact: true }))
  fireEvent.click(screen.getByRole('button', { name: '保存して公開' }))
  await vi.waitFor(() => expect(net.createMenu).toHaveBeenCalledTimes(1))
  expect(sentBody(net.createMenu, 1)).not.toHaveProperty('audienceMode')
  expect(sentBody(net.createMenu, 1)).not.toHaveProperty('audienceTagIds')
})
