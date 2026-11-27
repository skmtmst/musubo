// @vitest-environment happy-dom
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
/*
 * E-03 #657: 予約メニュー作成画面の「予約後に付けるタグ」を、実物の React で描いて操作する。
 *
 * ソース文字列の検査では次が固定できない。ここでは happy-dom へ実物の画面を
 * マウントし、実物の Promise を後から解決させて確かめる。
 *
 *   - タグ取得が遅れて返る間の入力が消えないこと、返った後に候補が出ること
 *   - 候補に出るのが「いま選んでいるアカウントの有効なタグ」だけであること
 *     (別アカウント・整理済み(archived)は出ない)
 *   - アカウントを切り替えると前の選択が残らないこと
 *   - 保存 request に auto_tag_id が載ること
 *   - 保存が tag_not_found で落ちても入力が消えず、選び直せること
 */
import React from 'react'
import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

type DeferredTags = {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

const fixture = vi.hoisted(() => ({
  selectedAccountId: 'account-a' as string | null,
  tagsList: null as null | (() => Promise<unknown>),
  createMenu: null as null | ((...args: unknown[]) => Promise<unknown>),
  mileageRules: null as null | (() => Promise<unknown>),
  getSettings: vi.fn(),
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
  useSearchParams: () => new URLSearchParams(),
}))

// N-411: 画面は localStorage の権限表を読む。happy-dom では未定義なので
// インメモリに差し替え、既定を owner（全通過）にする。
const memStorage = vi.hoisted(() => {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
  }
})
vi.stubGlobal('localStorage', memStorage)
memStorage.setItem('lh_staff_role', 'owner')

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: useControllableAccount() }),
}))

vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock(),
  usePageTitle: () => undefined,
}))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後のメニュー登録の判断なので、素の <select> に置き換える。
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
      tags: { list: (...args: unknown[]) => fixture.tagsList!(...(args as [])) },
      mileage: { rules: (...args: unknown[]) => fixture.mileageRules!(...(args as [])) },
    },
    bookingApi: {
      listMenus: async () => ({ menus: [] }),
      listResources: async () => ({ data: { resources: [] } }),
      listStaffMenusBulk: async () => ({ staff: [] }),

      createMenu: (...args: unknown[]) => fixture.createMenu!(...args),
      getSettings: (...args: unknown[]) => fixture.getSettings(...args),
      listStaff: async () => ({ staff: [{ id: 'staff-a', display_name: '担当A', is_active: 1 }] }),
      getStaffMenus: async () => ({ matrix: [] }),
      putStaffMenus: async () => ({ ok: true }),
    },
  }
})

import { ApiError } from '@/lib/api'
import NewBookingMenuPage from './page'

/** 同アカウントの有効タグ／同アカウントの整理済み／別アカウントの有効タグ。 */
const TAGS = [
  { id: 'tag-active', name: '予約中', color: '#111111', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-a', status: 'active' },
  { id: 'tag-active-2', name: '常連さん', color: '#444444', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-a', status: 'active' },
  { id: 'tag-archived', name: '旧キャンペーン', color: '#222222', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-a', status: 'archived' },
  { id: 'tag-other-account', name: 'B店のタグ', color: '#333333', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-b', status: 'active' },
  { id: 'tag-b-only', name: 'B店だけの分類', color: '#555555', createdAt: '2026-09-01T00:00:00Z', lineAccountId: 'account-b', status: 'active' },
]

function deferredTags(): DeferredTags {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** メニュー名の入力欄。 */
function nameInput(): HTMLInputElement {
  return screen.getByPlaceholderText("例：トリミング（小型犬）") as HTMLInputElement
}

/** 選べる中身。プルダウンの option をそのまま読む。 */
function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.querySelectorAll('option')].map((option) => option.textContent ?? '')
}

beforeEach(() => {
  forgetStaffIdentity(); rememberStaffIdentity({ role: 'owner' } as StaffMember);
  fixture.selectedAccountId = 'account-a'
  fixture.tagsList = async () => ({ success: true, data: TAGS })
  fixture.createMenu = vi.fn(async () => ({ id: 'menu-new', version: 1 }))
  fixture.mileageRules = async () => ({ success: true, data: [] })
  fixture.getSettings.mockReset().mockResolvedValue({ success: true, data: { menuCount: 1, bookingWindowDays: 30 } })
})

afterEach(() => {
  cleanup()
  accountSetters.clear()
  vi.restoreAllMocks()
})

async function openTags() {
  fireEvent.click(await screen.findByRole('button', { name: '予約後に付けるタグ' }))
  return (await screen.findAllByRole('dialog')).at(-1)!
}
async function tagLabels() {
  const dialog = await openTags()
  const labels = within(dialog).queryAllByRole('radio').map(item => item.getAttribute('aria-label'))
  fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
  return labels
}
async function chooseTag(name: string) { await pickEntity('予約後に付けるタグ', name) }
function chosenTag() { return screen.getByRole('button', { name: '予約後に付けるタグ' }).closest('[data-entity-picker-field]')!.textContent }
async function publish() {
  fireEvent.change(nameInput(), { target: { value: 'トリミング' } })
  fireEvent.click(await screen.findByRole('checkbox', { name: '担当A' }))
  fireEvent.click(screen.getByRole('button', { name: '保存して公開' }))
}
describe('新規作成画面: 予約後に付けるタグ', () => {
  async function renderNew() { render(<NewBookingMenuPage />); await screen.findByRole('button', { name: '予約後に付けるタグ' }) }
  test('タグ取得が遅れて返る間も入力は消えず、返った後に候補が出る', async () => {
    const deferred = deferredTags(); fixture.tagsList = () => deferred.promise
    render(<NewBookingMenuPage />)
    expect(screen.getByText('タグを読み込んでいます').className).toContain('sr-only')
    expect(screen.queryByRole('button', { name: '予約後に付けるタグ' })).toBeNull()
    fireEvent.change(nameInput(), { target: { value: 'トリミング' } })
    await act(async () => { deferred.resolve({ success: true, data: TAGS }); await deferred.promise })
    expect(nameInput().value).toBe('トリミング')
    expect(nameInput().closest('[data-template-region="content"]')?.closest('[data-page-template="create"]')).toBeTruthy()
    expect(await tagLabels()).toEqual(['予約中', '常連さん'])
  })
  test('取得に失敗しても保存はできる文言を出し、選ぶ口は出さない', async () => {
    fixture.tagsList = async () => { throw new Error('network down') }
    render(<NewBookingMenuPage />)
    expect(await screen.findByText('タグを読み込めませんでした。タグなしで保存できます。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '予約後に付けるタグ' })).toBeNull()
    await publish(); await waitFor(() => expect(fixture.createMenu).toHaveBeenCalled())
    expect(fixture.createMenu).toHaveBeenCalledWith('account-a', expect.objectContaining({ auto_tag_id: null }), expect.any(String))
  })
  test('候補は対象アカウントの有効タグだけ。整理済みも別アカウントも出さない', async () => {
    await renderNew(); expect(await tagLabels()).toEqual(['予約中', '常連さん'])
  })
  test('検索で絞り込み、選び、解除できる', async () => {
    await renderNew()
    const dialog = await openTags()
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: '常連' } })
    // 本線の300ms検索後の状態待機を、V8の選択窓へ移して残す。
    await waitFor(() => expect(within(dialog).queryAllByRole('radio').map(item => item.getAttribute('aria-label'))).toEqual(['常連さん']))
    fireEvent.click(within(dialog).getByRole('radio', { name: '常連さん' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '選択する' }))
    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0))
    expect(chosenTag()).toContain('常連さん')
    expect(await tagLabels()).toEqual(['予約中', '常連さん'])
    expect(chosenTag()).toContain('常連さん')
    fireEvent.click(screen.getByRole('button', { name: '予約後に付けるタグを外す' }))
    expect(chosenTag()).toContain('付けるタグ：なし')
  })
  test('検索に合うタグが無いときも選択を残す', async () => {
    await renderNew(); await chooseTag('予約中')
    const dialog = await openTags()
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'ありえない語' } })
    await waitFor(() => {
      expect(within(dialog).queryAllByRole('radio')).toHaveLength(0)
      expect(within(dialog).getByText(/見つかりません|ありません/)).toBeTruthy()
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }))
    expect(chosenTag()).toContain('予約中')
  })
  test('アカウントを替えると前の選択を残さず、候補も切替先のものになる', async () => {
    await renderNew(); await chooseTag('予約中'); switchAccount('account-b')
    await screen.findByRole('button', { name: '予約後に付けるタグ' })
    expect(chosenTag()).toContain('付けるタグ：なし')
    expect(await tagLabels()).toEqual(['B店のタグ', 'B店だけの分類'])
    await publish(); await waitFor(() => expect(fixture.createMenu).toHaveBeenCalled())
    expect(fixture.createMenu).toHaveBeenCalledWith('account-b', expect.objectContaining({ auto_tag_id: null }), expect.any(String))
  })
  test('保存 request に選んだ auto_tag_id が載る', async () => {
    await renderNew(); await chooseTag('予約中'); await publish()
    await waitFor(() => expect(fixture.createMenu).toHaveBeenCalled())
    expect(fixture.createMenu).toHaveBeenCalledWith('account-a', expect.objectContaining({ auto_tag_id: 'tag-active' }), expect.any(String))
  })
  test('保存が tag_not_found で落ちても入力は残り、選び直せる', async () => {
    fixture.createMenu = vi.fn(async () => { throw new ApiError(400, 'tag not found', 'tag_not_found') })
    await renderNew(); await chooseTag('予約中'); await publish()
    expect(await screen.findByText('選んだタグは利用できないため保存できませんでした。タグを選び直してください。')).toBeTruthy()
    expect(nameInput().value).toBe('トリミング')
    await chooseTag('常連さん'); expect(chosenTag()).toContain('常連さん')
  })
})

describe('R306/R307 予約時マイルの設定リンク', () => {
  async function renderNew() {
    render(<NewBookingMenuPage />)
    // タグ欄が出れば画面の読み込みは終わっている。
    await screen.findByRole('button', {name:'予約後に付けるタグ'})
  }

  function settingsLink(): HTMLAnchorElement {
    return screen.getByRole('link', { name: 'マイル設定へ' }) as HTMLAnchorElement
  }

  test('行き先はマイルの付与ルールで、行動スコアのルールではない', async () => {
    await renderNew()
    const link = settingsLink()
    expect(link.getAttribute('href')).toBe('/mileage?tab=earning-rules')
  })

  test('R307: 新しいタブで開くので、作成中の入力は残る', async () => {
    await renderNew()
    const link = settingsLink()
    expect(link.getAttribute('target')).toBe('_blank')
    // 同じタブで離れない（rel も付けて参照元を渡さない）。
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  test('付与ルールが無いときは「未設定」と出し、取得失敗と区別する', async () => {
    await renderNew()
    await waitFor(() => expect((screen.getByLabelText('予約したときのマイル（お店全体の設定）') as HTMLInputElement).value).toBe('未設定'))
  })

  test('取得に失敗したときは「未取得」と出し、未設定と区別する', async () => {
    fixture.mileageRules = async () => { throw new Error('network down') }
    await renderNew()
    await waitFor(() => expect((screen.getByLabelText('予約したときのマイル（お店全体の設定）') as HTMLInputElement).value).toBe('未取得'))
  })

  test('有効な予約イベントのルールがあるときは付ける量を出す', async () => {
    fixture.mileageRules = async () => ({
      success: true,
      data: [{ eventType: 'booking_created', isActive: true, amount: 50 }],
    })
    await renderNew()
    await waitFor(() => expect((screen.getByLabelText('予約したときのマイル（お店全体の設定）') as HTMLInputElement).value).toBe('50'))
  })
})

// 同じ保存口で、価格の意味と店舗ルールの継承を確かめる。
test.each([['', 'inquiry', 0], ['0', 'free', 0], ['8400', 'fixed', 8400]])('金額 %s は %s として送り、上書きしない店舗ルールはnullで送る', async (amount, mode, price) => {
  render(<NewBookingMenuPage />)
  fireEvent.change(screen.getByLabelText('金額（円）'), { target: { value: amount } })
  await publish()
  await waitFor(() => expect(fixture.createMenu).toHaveBeenCalled())
  expect(fixture.createMenu).toHaveBeenCalledWith('account-a', expect.objectContaining({
    price_mode: mode, base_price: price,
    booking_window_days: null, cutoff_hours_before: null, cancel_deadline_hours_before: null,
  }), expect.any(String))
})


test('店舗のきまりを読み、固有の期限を設定して送れる', async () => {
  render(<NewBookingMenuPage />)
  await waitFor(() => expect(fixture.getSettings).toHaveBeenCalledWith('account-a'))
  expect(screen.getByText('空ならお店全体のきまり（予約のルール）を使います')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'このメニューだけ変更する' }))
  fireEvent.change(screen.getByLabelText('先の予約が取れる範囲（日）'), { target: { value: '45' } })
  fireEvent.change(screen.getByLabelText('受付の締め切り（時間前）'), { target: { value: '5' } })
  fireEvent.change(screen.getByLabelText('キャンセルの期限（時間前）'), { target: { value: '12' } })
  await publish()
  await waitFor(() => expect(fixture.createMenu).toHaveBeenCalledWith('account-a', expect.objectContaining({ booking_window_days: 45, cutoff_hours_before: 5, cancel_deadline_hours_before: 12 }), expect.any(String)))
})

test('お店のきまりに戻すと固有の期限は送らない', async () => {
  render(<NewBookingMenuPage />)
  fireEvent.click(screen.getByRole('button', { name: 'このメニューだけ変更する' }))
  fireEvent.change(screen.getByLabelText('先の予約が取れる範囲（日）'), { target: { value: '45' } })
  fireEvent.click(screen.getByRole('button', { name: 'お店のきまりに戻す' }))
  expect(screen.queryByLabelText('先の予約が取れる範囲（日）')).toBeNull()
  await publish()
  await waitFor(() => expect(fixture.createMenu).toHaveBeenCalledWith('account-a', expect.objectContaining({ booking_window_days: null, cutoff_hours_before: null, cancel_deadline_hours_before: null }), expect.any(String)))
})

test('予約後の通知とリマインダの説明を開け、予約用の有効なマイルだけを示す', async () => {
  fixture.mileageRules = async () => ({ success: true, data: [
    { eventType: 'message_received', isActive: true, amount: 999 },
    { eventType: 'booking_created', isActive: false, amount: 888 },
    { eventType: 'booking_created', isActive: true, amount: 12345 },
  ] })
  render(<NewBookingMenuPage />)
  expect(screen.getByText('予約を受けたときにすること')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '予約を受けたときにすることの説明' }))
  expect(screen.getByText(/予約を受け付けたことを知らせる/).textContent).toContain('前日・開始前に思い出してもらう')
  await waitFor(() => expect((screen.getByLabelText('予約したときのマイル（お店全体の設定）') as HTMLInputElement).value).toBe('12,345'))
})
