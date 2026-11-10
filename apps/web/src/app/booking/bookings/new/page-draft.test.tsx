// @vitest-environment happy-dom
/*
 * 代理予約画面の「再読み込みで入力が戻る」（#933 N-400）、
 * 「カレンダー空きセルから日時・担当を持って来る」（#933 N-399）、
 * 「閲覧のみの人には操作ボタンを出さない」（#933 N-401）を
 * 本物の React で確かめる。
 *
 * 差し替えるのは通信（bookingApi / api.friends / api.staff.me）と
 * Select・遷移（next/link）だけ。画面の判断は差し替えない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listMenus: vi.fn(),
  listMenuStaff: vi.fn(),
  getAvailability: vi.fn(),
  getCustomerContext: vi.fn(),
  previewReminders: vi.fn(),
  createProxyBooking: vi.fn(),
  getAlternatives: vi.fn(),
  createCustomer: vi.fn(),
}))

const friendsList = vi.hoisted(() => vi.fn())
const staffMe = vi.hoisted(() => vi.fn())

vi.mock('@/lib/api', async (importOriginal: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    bookingApi: api,
    api: {
      ...actual.api,
      friends: { ...actual.api.friends, list: friendsList },
      staff: { ...actual.api.staff, me: staffMe },
    },
  }
})

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', { href }, children),
}))

const accountId = vi.hoisted(() => ({ value: 'account-ny' }))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: accountId.value, accounts: [{ id: accountId.value, name: 'NY店' }] }),
}))

vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label': string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

import NewProxyBookingPage from './page'

const NY = 'America/New_York'
const NY_1000 = '2026-11-02T10:00:00-05:00'
const DRAFT_KEY = 'booking:new-draft:account-ny'

function slot(startUtc: string, start = '10:00', end = '11:00') {
  return {
    date: '2026-11-02',
    start,
    end,
    timeZone: NY,
    startUtc,
    endUtc: new Date(new Date(startUtc).getTime() + 3600_000).toISOString(),
    capacity: 1,
    remaining: 1,
    state: 'available' as const,
  }
}

function availability(slots: Array<ReturnType<typeof slot>>) {
  return { by_staff: [{ staff_id: 'staff-ny', display_name: '担当NY', slots }] }
}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(React.createElement(NewProxyBookingPage)) })
}

async function settle() {
  await act(async () => { await Promise.resolve() })
}

/** メニュー→担当→空き枠と非同期が連鎖するので、効果が落ち着くまで回す。 */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) await settle()
}

function all(tag: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(tag)) as HTMLElement[]
}

function byLabel(label: string): HTMLElement {
  const found = all('input,select,textarea').find((element) => element.getAttribute('aria-label') === label)
  if (!found) throw new Error(`見つかりません: aria-label="${label}"`)
  return found
}

function valueOf(element: HTMLElement): string {
  return (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value
}

function setValue(element: HTMLElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
    'value',
  )!.set!
  setter.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

function seedDraft(extra: Record<string, unknown> = {}) {
  window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
    phoneCustomer: true,
    customerName: '見本 143',
    customerPhone: '09000005678',
    petName: 'ポチ',
    friend: null,
    customer: null,
    menuId: 'menu-ny',
    staffId: 'staff-ny',
    date: '2026-11-02',
    time: '10:00',
    customerNote: '急ぎでお願いします',
    notification: { send_line_confirmation: true, day_before: false, hours_before: true },
    ...extra,
  }))
}

describe('代理予約: 下書き・空きセル・権限（実React）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/booking/bookings/new')
    staffMe.mockResolvedValue({
      success: true,
      data: { role: 'admin', permissionKeys: [] },
    })
    api.listMenus.mockResolvedValue({
      menus: [{
        id: 'menu-ny', name: '相談', category_label: null, description: null,
        duration_minutes: 60, buffer_after_minutes: 0, base_price: 8000,
        sort_order: 0, is_active: 1, auto_tag_id: null,
      }],
    })
    api.listMenuStaff.mockResolvedValue({
      staff: [{
        id: 'staff-ny', display_name: '担当NY', role: null, profile_image_url: null,
        bio: null, is_designation_optional: 0, price: 8000, duration_minutes: 60,
      }],
    })
    api.getAvailability.mockResolvedValue(availability([slot(NY_1000)]))
    api.getCustomerContext.mockResolvedValue({ customer: null })
    api.previewReminders.mockResolvedValue({ reminders: [] })
    api.createProxyBooking.mockResolvedValue({
      booking_id: 'booking-1', status: 'confirmed', calendar_sync: 'not_configured',
      line_notification: 'queued', reminders: [], operations: [], customer_context: null,
    })
    friendsList.mockResolvedValue({
      success: true,
      data: { items: [{ id: 'friend-ny', displayName: '予約者NY', pictureUrl: null }] },
    })
    api.createCustomer.mockResolvedValue({
      customer: {
        id: 'cust-ny', line_account_id: 'account-ny', friend_id: null,
        display_name: '見本 143', phone_last4: '5678', pet_name: 'ポチ',
        is_line_linked: false,
        created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
      },
    })
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  it('N-400: 書きかけの下書きを再読み込み後に戻す', async () => {
    seedDraft()
    await mount()
    await flush()

    expect(valueOf(byLabel('電話客の名前'))).toBe('見本 143')
    expect(valueOf(byLabel('電話客の電話番号'))).toBe('09000005678')
    expect(valueOf(byLabel('電話客のペット名'))).toBe('ポチ')
    expect(valueOf(byLabel('予約メニュー'))).toBe('menu-ny')
    // 担当・時刻は一覧と空き枠の到着後に確かめてから選ぶ。
    expect(valueOf(byLabel('スタッフ'))).toBe('staff-ny')
    expect(valueOf(byLabel('空いている時間'))).toBe('10:00')
    const dateInput = all('input').find((element) => element.getAttribute('name') === 'date')!
    expect(valueOf(dateInput)).toBe('2026-11-02')
    const note = all('textarea')[0]!
    expect(valueOf(note)).toBe('急ぎでお願いします')
    expect(container.textContent).toContain('書きかけの入力を戻しました')
  })

  it('N-400: 壊れた下書きは捨てて初期状態で始める', async () => {
    window.sessionStorage.setItem(DRAFT_KEY, '{broken json')
    await mount()
    await settle()
    expect(valueOf(byLabel('予約メニュー'))).toBe('')
    expect(container.textContent).not.toContain('書きかけの入力を戻しました')
  })

  it('N-400: 予約が入ったら下書きを消す', async () => {
    seedDraft()
    await mount()
    await flush()

    // 復元されたまま確認→登録まで進める。
    const byText = (tag: string, text: string) => {
      const found = all(tag).find((element) => element.textContent?.includes(text))
      if (!found) throw new Error(`見つかりません: <${tag}> "${text}"`)
      return found
    }
    await act(async () => { byText('button', '予約内容を確認する').click() })
    expect(api.createCustomer).not.toHaveBeenCalled()
    expect(api.createProxyBooking).not.toHaveBeenCalled()
    await act(async () => { byText('button', 'この内容で予約を入れる').click() })
    await settle()

    expect(api.createProxyBooking).toHaveBeenCalledTimes(1)
    expect(api.createProxyBooking.mock.calls[0][2]).toMatch(/^[0-9a-f-]{36}$/i)
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('N-399: 空きセルのURL指定（日付・時刻・担当名）を事前入力する', async () => {
    window.history.replaceState(
      null, '',
      '/booking/bookings/new?date=2026-11-02&time=10:00&staff=' + encodeURIComponent('担当NY'),
    )
    await mount()
    await flush()

    const dateInput = all('input').find((element) => element.getAttribute('name') === 'date')!
    expect(valueOf(dateInput)).toBe('2026-11-02')
    // 担当一覧はメニュー選択後に届く。届いた時点で display_name で照合して選ぶ。
    await act(async () => { setValue(byLabel('予約メニュー'), 'menu-ny') })
    await flush()
    expect(valueOf(byLabel('スタッフ'))).toBe('staff-ny')
    // 時刻は空き枠に実在するときだけ選ぶ。
    expect(valueOf(byLabel('空いている時間'))).toBe('10:00')
  })

  it('N-399: URLの時刻が実際に取れない枠なら選ばない', async () => {
    window.history.replaceState(
      null, '',
      '/booking/bookings/new?date=2026-11-02&time=15:00&staff=' + encodeURIComponent('担当NY'),
    )
    await mount()
    await flush()

    await act(async () => { setValue(byLabel('予約メニュー'), 'menu-ny') })
    await flush()
    expect(valueOf(byLabel('スタッフ'))).toBe('staff-ny')
    // 15:00 は空き枠に無いので選ばれない。
    expect(valueOf(byLabel('空いている時間'))).toBe('')
  })

  it('サロン台帳の担当IDを使い、改名後も日時と担当を引き継ぐ（URLを下書きより優先）', async () => {
    seedDraft({ staffId: 'old-draft-staff', date: '2026-11-01', time: '15:00' })
    window.history.replaceState(null, '', '/booking/bookings/new?date=2026-11-02&time=10:00&staffId=staff-ny&staff=old-name')
    await mount()
    await flush()
    expect(valueOf(byLabel('スタッフ'))).toBe('staff-ny')
    expect(valueOf(byLabel('空いている時間'))).toBe('10:00')
    expect(valueOf(all('input').find((element) => element.getAttribute('name') === 'date')!)).toBe('2026-11-02')
    expect(api.listMenuStaff).toHaveBeenCalledWith('account-ny', 'menu-ny')
  })

  it('台帳の担当IDがこの店舗のメニューに存在しなければ選択せず、空き枠を照会しない', async () => {
    window.history.replaceState(null, '', '/booking/bookings/new?date=2026-11-02&time=10:00&staffId=other-account-staff')
    await mount()
    await flush()
    await act(async () => { setValue(byLabel('予約メニュー'), 'menu-ny') })
    await flush()
    expect(valueOf(byLabel('スタッフ'))).toBe('')
    expect(api.getAvailability).not.toHaveBeenCalled()
  })

  it('N-401: 閲覧のみの人には確認・登録の操作ボタンを出さない', async () => {
    staffMe.mockResolvedValue({
      success: true,
      data: { role: 'viewer', permissionKeys: [] },
    })
    await mount()
    await settle()

    expect(container.textContent).toContain('閲覧のみの権限では操作ボタンは出ません')
    expect(all('button').some((b) => b.textContent?.includes('予約内容を確認する'))).toBe(false)
    expect(all('button').some((b) => b.textContent?.includes('この内容で予約を入れる'))).toBe(false)
  })

  it('N-401: 操作できる人には確認ボタンを出す', async () => {
    await mount()
    await settle()
    expect(all('button').some((b) => b.textContent?.includes('予約内容を確認する'))).toBe(true)
  })

  it('R14: 破棄したら「お客様からの要望」も消え、復元元も消える', async () => {
    window.history.replaceState(null, '', '/booking/bookings/new')
    seedDraft()
    await mount()
    await flush()

    expect(valueOf(byLabel('お客様からの要望'))).toBe('急ぎでお願いします')
    expect(container.textContent).toContain('書きかけの入力を戻しました')

    const discard = all('button').find((b) => b.textContent?.includes('破棄して最初から入れ直す'))!
    await act(async () => { discard.click() })
    await flush()

    expect(valueOf(byLabel('お客様からの要望'))).toBe('')
    // 破棄後は最初の状態（LINEの友だち選び）に戻り、メニューも空になる。
    expect(valueOf(byLabel('予約メニュー'))).toBe('')
    expect(window.sessionStorage.getItem(DRAFT_KEY)).toBeNull()
    expect(container.textContent).not.toContain('書きかけの入力を戻しました')
  })

  it('R14: アカウントを切り替えたら前の要望を持ち越さない', async () => {
    window.history.replaceState(null, '', '/booking/bookings/new')
    accountId.value = 'account-ny'
    seedDraft()
    await mount()
    await flush()
    expect(valueOf(byLabel('お客様からの要望'))).toBe('急ぎでお願いします')

    // 切り替え先には下書きが無い。前のアカウントの要望が残っていたら持ち越し。
    accountId.value = 'account-bb'
    await act(async () => { root.render(React.createElement(NewProxyBookingPage)) })
    await flush()

    expect(valueOf(byLabel('お客様からの要望'))).toBe('')
    expect(container.textContent).not.toContain('書きかけの入力を戻しました')
    accountId.value = 'account-ny'
  })
  it('WEB303：電話客作成後の予約失敗から入力へ戻っても再確認できる', async () => {
    api.createProxyBooking.mockRejectedValueOnce(new Error('network'))
    seedDraft()
    await mount(); await flush()
    const click = async (text: string) => { await act(async () => { all('button').find((b) => b.textContent?.includes(text))!.click() }); await flush() }
    await click('予約内容を確認する')
    await click('この内容で予約を入れる')
    await click('入力に戻る')
    await click('予約内容を確認する')
    expect(all('button').some((b) => b.textContent?.includes('この内容で予約を入れる'))).toBe(true)
  })
  it('電話の表記をそろえて保存し、予約失敗後の再確認でも台帳を二重作成しない', async () => {
    api.createProxyBooking.mockRejectedValueOnce(new Error('network'))
    seedDraft({ customerPhone: '０９０－００００－５６７８' })
    await mount(); await flush()
    const click = async (text: string) => { await act(async () => { all('button').find((b) => b.textContent?.includes(text))!.click() }); await flush() }
    await click('予約内容を確認する'); await click('この内容で予約を入れる')
    expect(api.createCustomer).toHaveBeenCalledWith('account-ny', expect.objectContaining({ phone: '09000005678' }), expect.any(String))
    await click('入力に戻る')
    await act(async () => { setValue(byLabel('電話客の電話番号'), '090 0000 5678') }); await flush()
    await click('予約内容を確認する'); await click('この内容で予約を入れる')
    expect(api.createCustomer).toHaveBeenCalledTimes(1)
  })
  it('WEB304：復元した電話客の名前を直したら新しい入力で確定する', async () => {
    seedDraft({ customer: { id: 'old', line_account_id: 'account-ny', display_name: '見本 143', phone_last4: '5678', pet_name: 'ポチ', is_line_linked: false } })
    await mount(); await flush()
    await act(async () => { setValue(byLabel('電話客の名前'), '見本 142') })
    await act(async () => { all('button').find((b) => b.textContent?.includes('予約内容を確認する'))!.click() }); await flush()
    await act(async () => { all('button').find((b) => b.textContent?.includes('この内容で予約を入れる'))!.click() }); await flush()
    expect(api.createCustomer).toHaveBeenCalledWith('account-ny', expect.objectContaining({ display_name: '見本 142' }), expect.any(String))
  })
  it('WEB305：別の担当の候補を選んだら、空き枠の確認後も候補の時刻を残す', async () => {
    api.listMenuStaff.mockResolvedValue({ staff: [
      { id: 'staff-ny', display_name: '担当NY', duration_minutes: 60 },
      { id: 'staff-other', display_name: '別の担当', duration_minutes: 60 },
    ] })
    let first = true
    api.getAvailability.mockImplementation(async (_a: string, query: { staffId: string }) => {
      if (query.staffId === 'staff-other') return { by_staff: [{ staff_id: 'staff-other', slots: [slot(NY_1000)] }] }
      if (first) { first = false; return availability([slot(NY_1000)]) }
      return availability([])
    })
    api.getAlternatives.mockResolvedValue({ conflict: { from: NY_1000, to: slot(NY_1000).endUtc, count: 1, source: 'internal_booking' }, nearbySlots: [], alternateStaff: [{ staffId: 'staff-other', displayName: '別の担当', slot: slot(NY_1000) }] })
    seedDraft(); await mount(); await flush()
    await act(async () => { all('button').find((b) => b.textContent?.includes('予約内容を確認する'))!.click() }); await flush()
    await act(async () => { all('button').find((b) => b.textContent?.includes('この担当に変える'))!.click() }); await flush()
    expect(valueOf(byLabel('スタッフ'))).toBe('staff-other')
    expect(valueOf(byLabel('空いている時間'))).toBe('10:00')
  })
  it('WEB306：未連携の電話客へ自動通知が届くとは案内しない', async () => {
    seedDraft()
    api.createProxyBooking.mockResolvedValue({ booking_id: 'booking-1', status: 'confirmed', calendar_sync: 'not_configured', line_notification: 'not_linked', reminders: [], operations: [], customer_context: null })
    await mount(); await flush()
    await act(async () => { all('button').find((b) => b.textContent?.includes('予約内容を確認する'))!.click() }); await flush()
    await act(async () => { all('button').find((b) => b.textContent?.includes('この内容で予約を入れる'))!.click() }); await flush()
    expect(container.textContent).not.toContain('お知らせはリマインダから自動で届きます')
  })
  it('WEB307：アカウントを変えたら古いメニュー応答を捨てる', async () => {
    accountId.value = 'account-ny'
    let resolveOld!: (value: unknown) => void
    api.listMenus.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    await mount(); await flush()
    accountId.value = 'account-bb'
    await act(async () => { root.render(React.createElement(NewProxyBookingPage)) }); await flush()
    await act(async () => { resolveOld({ menus: [{ id: 'old', name: '旧アカウントのメニュー', is_active: 1 }] }) }); await flush()
    expect(container.textContent).not.toContain('旧アカウントのメニュー')
    accountId.value = 'account-ny'
  })

  it('桁不足の電話番号では確認に進まず、客も予約も作らない', async () => {
    seedDraft({ customerPhone: '123' })
    await mount(); await flush()
    const confirm = all('button').find(b => b.textContent?.includes('予約内容を確認する'))! as HTMLButtonElement
    await act(async () => { confirm.click() }); await flush()
    expect(all('button').some(b => b.textContent?.includes('この内容で予約を入れる'))).toBe(false)
    expect(container.textContent).toContain('電話番号は0から始まる10〜11桁の数字で入れてください。')
    expect(api.createCustomer).not.toHaveBeenCalled()
    expect(api.createProxyBooking).not.toHaveBeenCalled()
  })
})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
