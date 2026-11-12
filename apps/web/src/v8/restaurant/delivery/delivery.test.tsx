import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * デリバリー受注の見え方（★承認済み デリバリー受注_v02.pen／2026-10-09 利用者承認）。
 * 守るのは BEHAVIOR.md に書いた決めごと：
 *  - 板の印は `?view=` で入れ替わる（注文一覧 kDQHr・注文履歴・売上 OzHLO・品切れ一括設定 h7OeT）。
 *  - 注文番号を押すと `?id=` が付いて注文の詳細（hjdqV）が開く。移動は useSamePageUrl を通す。
 *  - 「まとめて受け付ける」は新着だけを相手にし、まとめ送りの口が無いので1件ずつ順に送る。
 *  - 急ぎ度は結果と理由の文だけを出し、判定の仕組みの名前（Clef）は画面に出さない。
 *  - 閲覧のみ（staff）には送るボタンを置かない。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestaurantStore } from '@/lib/restaurant-test-api'
import type {
  DeliveryMenuItem,
  DeliveryOrderDetailData,
  DeliveryOrderSummary,
  DeliveryOrdersData,
  DeliveryService,
  DeliveryServiceState,
} from '@/lib/restaurant-delivery-api'

const fixture = vi.hoisted(() => ({
  orders: vi.fn(),
  order: vi.fn(),
  accept: vi.fn(),
  ready: vi.fn(),
  handOver: vi.fn(),
  reject: vi.fn(),
  cancel: vi.fn(),
  history: vi.fn(),
  historyCsv: vi.fn(),
  menuItems: vi.fn(),
  bulkSoldOut: vi.fn(),
  stopIntake: vi.fn(),
  stopSubmit: null as (() => void) | null,
  resumeIntake: vi.fn(),
  snapshot: vi.fn(),
  ubereatsConnection: vi.fn(),
  role: { value: 'owner' as string | null },
  accountId: { value: 'account-1' as string | null },
  accountLoading: { value: false },
  board: null as React.ComponentProps<typeof import('./orders').default> | null,
  stopDialog: null as import('./bulk').IntakeStopDialogProps | null,
}))

vi.mock('@/lib/restaurant-delivery-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/restaurant-delivery-api')>()
  return {
    ...actual,
    restaurantDeliveryApi: {
      ubereatsConnection: fixture.ubereatsConnection,
      orders: fixture.orders,
      order: fixture.order,
      accept: fixture.accept,
      ready: fixture.ready,
      handOver: fixture.handOver,
      reject: fixture.reject,
      cancel: fixture.cancel,
      history: fixture.history,
      historyCsv: fixture.historyCsv,
      menuItems: fixture.menuItems,
      bulkSoldOut: fixture.bulkSoldOut,
      stopIntake: fixture.stopIntake,
      resumeIntake: fixture.resumeIntake,
    },
  }
})

vi.mock('@/lib/restaurant-test-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/restaurant-test-api')>()
  return { ...actual, restaurantTestApi: { snapshot: fixture.snapshot } }
})

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: fixture.accountId.value,
    setSelectedAccountId: vi.fn(),
    accounts: [],
    loading: fixture.accountLoading.value,
  }),
}))

vi.mock('./orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orders')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    fixture.board = props
    return <actual.default {...props} />
  } }
})

vi.mock('./bulk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bulk')>()
  return { ...actual, IntakeStopDialog: (props: import('./bulk').IntakeStopDialogProps) => {
    fixture.stopSubmit = props.onSubmit
    fixture.stopDialog = props
    return <actual.IntakeStopDialog {...props} />
  } }
})

vi.mock('@/lib/staff-role', () => ({
  useStaffRole: () => fixture.role.value,
  useStaffIdentityLoad: () => ({ failed: false }),
  canManageRole: (role: string | null) => role === 'owner' || role === 'admin',
}))

/*
 * 絞り込みは URL から読む。移動は `useSamePageUrl` がルーターを通さず
 * `window.history` を直に書く（読み直しが起きないようにするため）。本物の Next は
 * その書き換えを拾って `useSearchParams` を新しくするので、試験でも同じように
 * 履歴の書き換えを見張って読み直す形にする。
 */
vi.mock('next/navigation', async () => {
  const react = await import('react')
  const listeners = new Set<() => void>()
  for (const key of ['pushState', 'replaceState'] as const) {
    const original = window.history[key].bind(window.history)
    window.history[key] = ((...args: Parameters<History['pushState']>) => {
      original(...args)
      for (const listener of [...listeners]) listener()
    }) as History['pushState']
  }
  return {
    useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
    usePathname: () => '/restaurant-test/delivery',
    useSearchParams: () => {
      const search = react.useSyncExternalStore(
        (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify) } },
        () => window.location.search,
        () => '',
      )
      return new URLSearchParams(search)
    },
  }
})

import DeliveryPage from './delivery'

function serviceState(
  service: DeliveryService,
  label: string,
  patch: Partial<DeliveryServiceState> = {},
): DeliveryServiceState {
  return {
    service,
    label,
    connectionStatus: 'connected',
    version: 1,
    target: `target-${service}`,
    intakeStatus: 'open',
    stopUntil: null,
    todayCount: 4,
    todayAmount: 12000,
    ...patch,
  }
}

function order(
  id: string,
  orderNumber: string,
  patch: Partial<DeliveryOrderSummary> = {},
): DeliveryOrderSummary {
  return {
    id,
    version: 1,
    service: 'ubereats',
    serviceLabel: 'Uber Eats',
    orderNumber,
    status: 'new',
    statusLabel: '新着',
    totalAmount: 3480,
    itemCount: 2,
    itemSummary: '唐揚げ弁当×1・味噌汁×1',
    urgency: 'urgent',
    urgencyReason: '受け取り希望まで10分を切っています',
    receivedAt: '2026-10-09T03:02:00.000Z',
    wantedAt: '2026-10-09T03:15:00.000Z',
    ...patch,
  }
}

function ordersData(
  orders: DeliveryOrderSummary[],
  uberOrderActionsEnabled?: boolean,
): DeliveryOrdersData {
  return {
    success: true,
    store: { id: 'store-1', name: '然-NEN- 本店' },
    services: [
      serviceState('ubereats', 'Uber Eats', uberOrderActionsEnabled === undefined
        ? {}
        : { orderActionsEnabled: uberOrderActionsEnabled }),
      serviceState('demaecan', '出前館'),
      serviceState('rocketnow', 'ロケットナウ', {
        intakeStatus: 'stopped',
        stopUntil: '2026-10-09T04:00:00.000Z',
      }),
    ],
    kpis: {
      todayCount: 12,
      todayCountDelta: 2,
      handedOverCount: 8,
      todaySales: 41_200,
      todaySalesDeltaPercent: 12,
      averageAmount: 3433,
      urgentCount: 1,
      averagePrepMinutes: 14,
      averagePrepMinutesDelta: -1,
    },
    tab: 'new',
    tabCounts: { all: 12, new: orders.length, cooking: 2, handed_over: 8 },
    orders,
  }
}

function store(): RestaurantStore {
  return {
    id: 'store-1',
    organization_id: 'org-1',
    name: '然-NEN- 本店',
    code: 'NEN01',
    area: null,
    capacity: 20,
    timezone: 'Asia/Tokyo',
    status: 'active',
    line_status: 'connected',
    google_status: 'connected',
    line_account_id: 'account-1',
    line_account_name: '然-NEN-',
  }
}

function menuItem(id: string, name: string, soldOut = false): DeliveryMenuItem {
  return {
    id,
    version: 1,
    target: `menu-${id}`,
    name,
    category: '弁当',
    price: 980,
    soldOut,
    soldOutAt: soldOut ? '2026-10-09T03:00:00.000Z' : null,
    services: [{ service: 'ubereats', label: 'Uber Eats' }],
  }
}

function at(url: string) {
  window.history.replaceState(null, '', url)
}

beforeEach(() => {
  fixture.stopSubmit = null
  fixture.stopDialog = null
  fixture.role.value = verifiedStaffRole('owner')
  fixture.accountId.value = 'account-1'
  fixture.accountLoading.value = false
  fixture.ubereatsConnection.mockResolvedValue({ connection: { status: 'connected', lastError: null } })
  fixture.snapshot.mockResolvedValue({ success: true, data: { stores: [store()] } })
  fixture.orders.mockResolvedValue(ordersData([
    order('o1', 'UE-1001'),
    order('o2', 'DM-2002', {
      service: 'demaecan',
      serviceLabel: '出前館',
      status: 'cooking',
      statusLabel: '調理中',
      urgency: 'normal',
      urgencyReason: '余裕があります',
    }),
  ]))
  fixture.accept.mockResolvedValue({
    success: true,
    order: { id: 'o1', status: 'cooking', statusLabel: '調理中', updatedAt: null },
  })
  fixture.handOver.mockResolvedValue({
    success: true,
    order: { id: 'o1', status: 'handed_over', statusLabel: '受け渡し済み', updatedAt: null },
  })
  fixture.order.mockResolvedValue({
    success: true,
    order: {
      id: 'o1',
      version: 1,
      service: 'ubereats',
      serviceLabel: 'Uber Eats',
      orderNumber: 'UE-1001',
      status: 'new',
      statusLabel: '新着',
      totalAmount: 3480,
      currency: 'JPY',
      itemCount: 2,
      urgency: 'urgent',
      urgencyReason: '受け取り希望まで10分を切っています',
      pickupMethod: '配達員が受け取り',
      wantedAt: '2026-10-09T03:15:00.000Z',
      customerNote: null,
      cancelReasonCode: null,
      canceledBy: null,
      receivedAt: '2026-10-09T03:02:00.000Z',
      acceptedAt: null,
      readyAt: null,
      handedOverAt: null,
      canceledAt: null,
    },
    items: [{ name: '唐揚げ弁当', note: null, quantity: 1, amount: 980 }],
  })
  fixture.history.mockResolvedValue({
    success: true,
    range: { from: '2026-10-09', to: '2026-10-09' },
    filter: { service: null, status: null },
    totals: { count: 12, amount: 41_200, canceledCount: 1, byService: [] },
    orders: [],
  })
  fixture.menuItems.mockResolvedValue({
    success: true,
    store: { id: 'store-1', name: '然-NEN- 本店' },
    items: [menuItem('m1', '唐揚げ弁当'), menuItem('m2', '味噌汁', true)],
  })
  at('/restaurant-test/delivery?tab=new')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  at('/')
})

describe('kDQHr デリバリー受注', () => {
  it('注文がないときは選んだ状態に合う案内を出す', async () => {
    fixture.orders.mockImplementation(async (_account, options) => ({ ...ordersData([]), tab: options.tab }))
    at('/restaurant-test/delivery?tab=all')
    render(<DeliveryPage />)
    expect(await screen.findByText('注文はまだありません')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /新着/ }))
    expect(await screen.findByText('この状態の注文はありません')).toBeTruthy()
  })
  it('注文一覧の板・サービス3枚・新着の操作を出す', async () => {
    render(<DeliveryPage />)

    expect(await screen.findByText('#UE-1001')).toBeTruthy()
    expect(document.querySelector('[data-design-node="kDQHr"]')).toBeTruthy()

    // 相手は Uber Eats・出前館・ロケットナウの3つだけ（menu も Camel も出さない）。
    expect(screen.getAllByText('Uber Eats').length).toBeGreaterThan(0)
    expect(screen.getAllByText('出前館').length).toBeGreaterThan(0)
    expect(screen.getAllByText('ロケットナウ').length).toBeGreaterThan(0)

    // 行の右端は、主な操作を1つだけボタンにし、残り（断る）は「…」に入れる（ C）。
    // 新着は「受け付ける」、調理中は「準備完了にする」。
    const accept = screen.getByLabelText('注文UE-1001を受け付ける') as HTMLButtonElement
    expect(accept.disabled).toBe(true)
    fireEvent.click(accept)
    expect(fixture.accept).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('注文UE-1001を拒否')).toBeNull()
    expect(screen.getByLabelText('注文DM-2002を準備完了にする')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '注文UE-1001のその他の操作' }))
    const reject = await screen.findByRole('menuitem', { name: '断る' })
    expect((reject as HTMLButtonElement).disabled || reject.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(reject)
    expect(fixture.reject).not.toHaveBeenCalled()

    // 停止中のサービスには再開を置く。
    expect(screen.getByLabelText('ロケットナウの受付を再開')).toBeTruthy()
  })

  it('急ぎ度は札だけを出し、理由は添え書きに回して仕組みの名前は出さない', async () => {
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')

    expect(screen.getAllByText('急ぎ').length).toBeGreaterThan(0)
    // 絵（kDQHr）の一覧は札だけ。理由の文は幅を押し広げるので添え書きにする。
    expect(screen.queryByText('受け取り希望まで10分を切っています')).toBeNull()
    expect(document.querySelector('[title="受け取り希望まで10分を切っています"]')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Clef/i)
  })

  it('まとめて受け付けるはUberを除いた新着だけを1件ずつ順に送る', async () => {
    fixture.orders.mockResolvedValue(ordersData([order('o1', 'UE-1001'), order('other-new', 'DM-NEW', { service: 'demaecan', serviceLabel: '出前館' }), order('o2', 'DM-2002', { service: 'demaecan', status: 'cooking' })]))
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')

    // 調理中は選べない（新着だけが相手）。
    const cooking = screen.getByLabelText('注文DM-2002を選ぶ') as HTMLInputElement
    expect(cooking.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('新着の注文をすべて選ぶ'))
    expect(screen.getByText('1件を選択中')).toBeTruthy()

    fireEvent.click(screen.getByText('まとめて受け付ける'))
    await waitFor(() => expect(fixture.accept).toHaveBeenCalledTimes(1))
    expect(fixture.accept).toHaveBeenCalledWith('account-1', 'other-new', 1)
    expect(fixture.accept).not.toHaveBeenCalledWith('account-1', 'o1', 1)
  })

  it('注文番号を押すと ?id= が付いて注文の詳細が開く', async () => {
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')

    fireEvent.click(screen.getByLabelText('注文UE-1001の詳細'))

    await waitFor(() => expect(window.location.search).toContain('id=o1'))
    expect(await screen.findByText('注文の詳細')).toBeTruthy()
    expect(document.querySelector('[data-design-node="hjdqV"]')).toBeTruthy()
    expect(fixture.order).toHaveBeenCalledWith('account-1', 'o1')

    // 急ぎ度の理由の文は注文の詳細（hjdqV）の帯で出す。仕組みの名前は出さない。
    expect(await screen.findByText('急ぎ対応のおすすめ')).toBeTruthy()
    expect(screen.getByText('受け取り希望まで10分を切っています')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Clef/i)
  })

  it('店舗を選ぶ欄は共通の選ぶ部品（押すと選ぶ窓が開く）にする', async () => {
    // 86: 選ぶ意味があるのは2店以上の時。1店では欄を出さない。
    fixture.snapshot.mockResolvedValue({ success: true, data: { stores: [store(), { ...store(), id: 'store-2', name: '二号店' }] } })
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')

    // 自作の `<select>` ではなく、共通部品の押しボタン＋選ぶ窓であること。
    const picker = screen.getByRole('button', { name: '店舗' })
    fireEvent.click(picker)
    expect(await screen.findByRole('dialog', { name: '店舗を選ぶ' })).toBeTruthy()
  })

  it('86: 店が1つしか無い時は選ぶ欄を出さない', async () => {
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')
    expect(screen.queryByRole('button', { name: '店舗' })).toBeNull()
    expect(screen.queryByRole('tablist', { name: '店舗で絞り込む' })).toBeNull()
  })
})

describe('?view= で板を入れ替える', () => {
  it('history は注文履歴・売上（OzHLO）を出す', async () => {
    at('/restaurant-test/delivery?view=history')
    render(<DeliveryPage />)

    await waitFor(() => expect(fixture.history).toHaveBeenCalled())
    expect(document.querySelector('[data-design-node="OzHLO"]')).toBeTruthy()
    expect(screen.getByText('注文履歴・売上')).toBeTruthy()
  })

  it('商品が未登録ならメニュー管理への案内とリンクを出す', async () => {
    fixture.menuItems.mockResolvedValue({ success: true, store: { id: 'store-1', name: '架空店' }, items: [] })
    at('/restaurant-test/delivery?view=sold-out')
    render(<DeliveryPage />)
    expect(await screen.findByText('メニュー管理で商品を作ると表示されます。')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'メニュー管理を開く' }).getAttribute('href')).toBe('/restaurant-test/menu')
  })

  it('検索結果だけが空なら商品登録を促さず条件の見直しを案内する', async () => {
    at('/restaurant-test/delivery?view=sold-out')
    render(<DeliveryPage />)
    await screen.findByText('唐揚げ弁当')
    fireEvent.change(screen.getByLabelText('商品名で探す'), { target: { value: '存在しない商品' } })
    expect(await screen.findByText('条件を変えて、もう一度お試しください。')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'メニュー管理を開く' })).toBeNull()
  })

  it('sold-out は品切れ一括設定（h7OeT）を出す', async () => {
    at('/restaurant-test/delivery?view=sold-out')
    render(<DeliveryPage />)

    expect(await screen.findByText('唐揚げ弁当')).toBeTruthy()
    expect(document.querySelector('[data-design-node="h7OeT"]')).toBeTruthy()
    expect(screen.getByText('品切れ一括設定')).toBeTruthy()
  })
})

describe('閲覧のみ（staff）', () => {
  it('権限の取得中は管理者用の接続情報を照会しない', async () => {
    fixture.role.value = verifiedStaffRole(null)
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')
    expect(fixture.ubereatsConnection).not.toHaveBeenCalled()
    expect(screen.getByText('接続未確認')).toBeTruthy()
    expect(screen.queryByLabelText('注文UE-1001を受け付ける')).toBeNull()
  })

  it('受け付ける・拒否・準備完了・停止・再開を置かない', async () => {
    fixture.role.value = verifiedStaffRole('staff')
    fixture.orders.mockResolvedValue(ordersData([order('o1', 'UE-1001')], true))
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')

    expect(screen.queryByLabelText('注文UE-1001を受け付ける')).toBeNull()
    expect(screen.queryByLabelText('注文UE-1001を拒否')).toBeNull()
    expect(screen.queryByLabelText('注文DM-2002を準備完了にする')).toBeNull()
    expect(screen.queryByLabelText('ロケットナウの受付を再開')).toBeNull()
    expect(screen.queryByLabelText('Uber Eatsの受付を止める')).toBeNull()
    expect(screen.queryByText('受付をまとめて止める')).toBeNull()
    // 閲覧のみの帯を出す。
    expect(screen.getByText(PERMISSION_LOCK_SUMMARY.feature)).toBeTruthy()

    expect(fixture.ubereatsConnection).not.toHaveBeenCalled()
    expect(screen.getByText('接続未確認')).toBeTruthy()
    // 見るだけの操作は残す。
    expect(screen.getByLabelText('注文UE-1001の詳細')).toBeTruthy()
  })
})

/* 見た目は実ブラウザで測る。この組は一覧と確認の操作を守る。 */
describe('一覧と確認の操作を保つ', () => {

  it('品切れ（h7OeT）の「品切れ」の札は赤（tone="danger"）', async () => {
    // 重ねた絵の色を測ったら、絵の「品切れ」は赤 #b3261e、画面は橙 #c2410c(warning) だった。
    // 赤の系統は共通の札の tone="danger"。画面CSSで色を塗らず、渡す種類を直す。
    at('/restaurant-test/delivery?view=sold-out')
    render(<DeliveryPage />)

    const soldOut = await screen.findByText('品切れ')
    expect(soldOut.closest('[data-tone]')?.getAttribute('data-tone')).toBe('danger')
    expect(screen.getByText('販売中').closest('[data-tone]')?.getAttribute('data-tone')).toBe('success')
  })

  it('注文履歴（OzHLO）は売上の4つの数を線で区切った1本の帯（KpiBand）で出す', async () => {
    at('/restaurant-test/delivery?view=history')
    render(<DeliveryPage />)
    await waitFor(() => expect(fixture.history).toHaveBeenCalled())

    // 絞り込みは共通の道具の段（ListToolbarRow）。日付は月日の書き方で切れない。
    expect(await screen.findByLabelText('日付')).toBeTruthy()

    const band = await waitFor(() => {
      const el = document.querySelector('[data-shared-part="kpi-band"][data-design="ZuE0v"]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    expect(within(band).getByText('¥41,200')).toBeTruthy()
    expect(within(band).getByText('12件')).toBeTruthy()
    // 合計＋サービス3つの4マス。
    expect(band.querySelectorAll('[data-kpi-label]').length).toBe(4)
  })

  it('キャンセルの確認（dgeTy）は白地の頭＋注意三角で、危険用の帯を出さない', async () => {
    const original = await fixture.order()
    fixture.order.mockResolvedValue({ ...original, order: { ...original.order, service: 'demaecan', serviceLabel: '出前館' } })
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')
    fireEvent.click(screen.getByLabelText('注文UE-1001の詳細'))

    const detail = (await waitFor(() => {
      const el = document.querySelector('[data-design-node="hjdqV"]')
      expect(el).toBeTruthy()
      return el
    })) as HTMLElement
    fireEvent.click(within(detail).getByRole('button', { name: '注文をキャンセルする' }))

    const dialog = (await waitFor(() => {
      const el = document.querySelector('[data-design-node="dgeTy"]')
      expect(el).toBeTruthy()
      return el
    })) as HTMLElement

    // 共通の窓は危険な操作のとき頭を帯で囲むが、絵は白地。plainTitle で帯を外している。
    expect(dialog.querySelector('[data-qa-dialog-callout]')).toBeNull()
    // 題の左に丸い注意三角を置く。
    const heading = dialog.querySelector('h2')
    const mark = heading?.querySelector('[aria-hidden="true"]')
    expect(mark?.tagName).toBe('SPAN')
    expect(mark?.querySelector('svg')).toBeTruthy()
  })

  it('受付の一括停止（XCVGd）は共通のチェックの札（CheckCard）と、別々の時間札4つを置く', async () => {
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')
    fireEvent.click(screen.getByText('受付をまとめて止める'))

    const dialog = (await waitFor(() => {
      const el = document.querySelector('[data-design-node="XCVGd"]')
      expect(el).toBeTruthy()
      return el
    })) as HTMLElement

    expect(dialog.querySelector('[data-qa-dialog-callout]')).toBeNull()

    // サービスごとに共通のチェックの札を置き、中に丸い札を入れる。
    for (const label of ['Uber Eats', '出前館', 'ロケットナウ']) {
      const box = within(dialog).getByRole('checkbox', { name: new RegExp(`${label}の受付を止める`) })
      expect(box.closest('label')).toBeTruthy()
      expect(within(dialog).getAllByText(label).length).toBeGreaterThan(0)
    }

    // 時間は共通の切り替え部品に任せ、つながった帯ではなく離れた札4つにする。
    const times = within(dialog).getByRole('group', { name: '停止する時間' })
    expect(times.getAttribute('data-appearance')).toBe('intake-stop')
    // 選択の面だけが滑り、4つの時間の操作と選択状態を保つ。
    expect(times.querySelector('[aria-hidden="true"]')).toBeNull()
    const cards = times.querySelectorAll('button')
    expect(cards.length).toBe(4)
    expect(Array.from(cards).map((card) => card.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'false',
      'false',
    ])
  })
})


describe('注文履歴のページ送り', () => {
  it('次のページと表示件数を変えても重複や抜けなく注文を読める', async () => {
    fixture.history.mockResolvedValue({
      success: true,
      range: { from: '2026-10-09', to: '2026-10-09' },
      filter: { service: null, status: null },
      totals: { count: 25, amount: 87000, canceledCount: 0, byService: [] },
      orders: Array.from({ length: 25 }, (_, index) => order(`page-${index}`, `PAGE-${index + 1}`)),
    })
    at('/restaurant-test/delivery?view=history')
    render(<DeliveryPage />)
    const table = await screen.findByRole('table', { name: 'デリバリーの注文履歴' })
    await within(table).findByText('#PAGE-20')
    expect(within(table).queryByText('#PAGE-21')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))
    expect(await within(table).findByText('#PAGE-21')).toBeTruthy()
    expect(within(table).getByText('#PAGE-25')).toBeTruthy()
    expect(within(table).queryByText('#PAGE-20')).toBeNull()
    expect(screen.getByRole('button', { name: '次のページ' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '表示件数' }))
    fireEvent.click(screen.getByRole('option', { name: '10件表示' }).querySelector('button')!)
    expect(await within(table).findByText('#PAGE-1')).toBeTruthy()
    expect(within(table).getByText('#PAGE-10')).toBeTruthy()
    expect(within(table).queryByText('#PAGE-11')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))
    expect(await within(table).findByText('#PAGE-11')).toBeTruthy()
    expect(within(table).getByText('#PAGE-20')).toBeTruthy()
    expect(within(table).queryByText('#PAGE-10')).toBeNull()
  })
})


describe('Uberの接続と未完成の操作を分ける', () => {
  it('保存済みの接続を読み、注文連携の説明は共通の窓で開く', async () => {
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')
    expect(fixture.ubereatsConnection).toHaveBeenCalledWith('account-1')
    const uber = within(screen.getByRole('region', { name: 'Uber Eats' }))
    expect(uber.getByText('接続済み')).toBeTruthy()
    expect(uber.queryByText('受付中')).toBeNull()
    expect((uber.getByRole('button', { name: 'Uber Eatsの受付を止める' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(uber.getByRole('button', { name: 'Uber Eatsの受付を止める' }))
    expect(fixture.stopIntake).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Uber Eats の営業状態変更・メニュー同期は準備中' }))
    expect(await screen.findByRole('dialog', { name: '現在準備中です' })).toBeTruthy()
    expect(fixture.accept).not.toHaveBeenCalled()
  })

  it('停止済みのUberも再開を送れず、他社の再開は残す', async () => {
    const data = ordersData([])
    data.services[0].intakeStatus = 'stopped'
    fixture.orders.mockResolvedValue(data)
    fixture.resumeIntake.mockResolvedValue({ failed: [] })
    render(<DeliveryPage />)
    const uber = await screen.findByRole('button', { name: 'Uber Eatsの受付を再開' })
    expect((uber as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(uber)
    expect(fixture.resumeIntake).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'ロケットナウの受付を再開' }))
    await waitFor(() => expect(fixture.resumeIntake).toHaveBeenCalledWith('account-1', ['rocketnow']))
  })

  it.each(['new', 'cooking'] as const)('旧形式の応答ではUberの%s詳細は読めるが変更を送れない', async (status) => {
    const original = await fixture.order()
    fixture.order.mockResolvedValue({ ...original, order: { ...original.order, status } })
    at('/restaurant-test/delivery?id=o1')
    render(<DeliveryPage />)
    const dialog = within(await screen.findByRole('dialog', { name: '注文の詳細' }))
    await dialog.findByText('唐揚げ弁当')
    expect(dialog.getByText(/この店舗では Uber Eats の個別注文操作をまだ利用できません/)).toBeTruthy()
    for (const name of status === 'new' ? ['注文をキャンセルする', '断る', '受け付ける'] : ['注文をキャンセルする', '準備完了にする']) {
      const button = dialog.getByRole('button', { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('準備中')
      fireEvent.click(button)
    }
    expect(fixture.accept).not.toHaveBeenCalled()
    expect(fixture.reject).not.toHaveBeenCalled()
    expect(fixture.ready).not.toHaveBeenCalled()
    expect(fixture.cancel).not.toHaveBeenCalled()
  })

  it.each([
    ['new', '受け付ける', 'accept'],
    ['new', '断る', 'reject'],
    ['cooking', '準備完了にする', 'ready'],
    ['ready', '受け渡し済みにする', 'handOver'],
  ] as const)('サーバが利用可能と返したUberの%s注文で%sを実行できる', async (status, label, action) => {
    const original = await fixture.order()
    fixture.order.mockResolvedValue({ ...original, order: { ...original.order, status } })
    fixture.orders.mockResolvedValue(ordersData([order('o1', 'UE-1001', { status })], true))
    at('/restaurant-test/delivery?id=o1')
    render(<DeliveryPage />)

    const dialog = within(await screen.findByRole('dialog', { name: '注文の詳細' }))
    expect(await dialog.findByText(/Uber Eats の準備完了・受け渡し済みは、店舗内の進行記録/)).toBeTruthy()
    const button = dialog.getByRole('button', { name: label }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(fixture[action]).toHaveBeenCalledWith('account-1', 'o1', 1))
  })

  it('サーバが利用可能と返したUber注文を確認後にキャンセルできる', async () => {
    fixture.orders.mockResolvedValue(ordersData([order('o1', 'UE-1001')], true))
    at('/restaurant-test/delivery?id=o1')
    render(<DeliveryPage />)
    const detail = within(await screen.findByRole('dialog', { name: '注文の詳細' }))
    fireEvent.click(await detail.findByRole('button', { name: '注文をキャンセルする' }))
    const confirmation = within(await screen.findByRole('alertdialog', { name: 'この注文をキャンセルしますか？' }))
    expect(confirmation.getByText('LINEアカウント')).toBeTruthy()
    expect(confirmation.getByText('店舗')).toBeTruthy()
    expect(confirmation.getByText('環境')).toBeTruthy()
    fireEvent.click(confirmation.getByRole('button', { name: 'キャンセルする' }))
    await waitFor(() => expect(fixture.cancel).toHaveBeenCalledWith('account-1', 'o1', 'out_of_stock', 1))
  })

  it('キャンセル確認中にアカウントを切り替えたら古い窓から送らない', async () => {
    fixture.orders.mockResolvedValue(ordersData([order('o1', 'UE-1001')], true))
    at('/restaurant-test/delivery?id=o1')
    const view = render(<DeliveryPage />)
    const detail = within(await screen.findByRole('dialog', { name: '注文の詳細' }))
    fireEvent.click(await detail.findByRole('button', { name: '注文をキャンセルする' }))
    const confirmation = within(await screen.findByRole('alertdialog', { name: 'この注文をキャンセルしますか？' }))
    const button = confirmation.getByRole('button', { name: 'キャンセルする' })
    fixture.accountId.value = 'account-2'
    view.rerender(<DeliveryPage />)
    fireEvent.click(button)
    expect(fixture.cancel).not.toHaveBeenCalled()
  })

  it('アカウント切替後に遅れて戻った利用可能フラグを混ぜない', async () => {
    let resolveOld!: (data: DeliveryOrdersData) => void
    const oldResponse = new Promise<DeliveryOrdersData>((resolve) => { resolveOld = resolve })
    fixture.orders.mockImplementation((accountId: string) => accountId === 'account-1'
      ? oldResponse
      : Promise.resolve(ordersData([order('o1', 'UE-1001')])))
    const rendered = render(<DeliveryPage />)
    await waitFor(() => expect(fixture.orders).toHaveBeenCalledWith('account-1', { tab: 'new' }))

    fixture.accountId.value = 'account-2'
    rendered.rerender(<DeliveryPage />)
    await waitFor(() => expect(fixture.orders).toHaveBeenCalledWith('account-2', { tab: 'new' }))
    const button = await screen.findByLabelText('注文UE-1001を受け付ける') as HTMLButtonElement
    expect(button.disabled).toBe(true)

    resolveOld(ordersData([order('o1', 'UE-1001')], true))
    await Promise.resolve()
    expect((screen.getByLabelText('注文UE-1001を受け付ける') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(fixture.accept).not.toHaveBeenCalled()
  })

  it('アカウント切替後に遅れて戻った注文詳細を操作対象にしない', async () => {
    const current = await fixture.order()
    let resolveOld!: (data: DeliveryOrderDetailData) => void
    const oldResponse = new Promise<DeliveryOrderDetailData>((resolve) => { resolveOld = resolve })
    fixture.orders.mockResolvedValue(ordersData([order('o1', 'UE-1001')], true))
    fixture.order.mockImplementation((accountId: string) => accountId === 'account-1'
      ? oldResponse
      : Promise.resolve({
          ...current,
          order: { ...current.order, orderNumber: 'UE-ACCOUNT-2' },
        }))
    at('/restaurant-test/delivery?id=o1')
    const rendered = render(<DeliveryPage />)
    await waitFor(() => expect(fixture.order).toHaveBeenCalledWith('account-1', 'o1'))

    fixture.accountId.value = 'account-2'
    rendered.rerender(<DeliveryPage />)
    expect(await screen.findByText('#UE-ACCOUNT-2')).toBeTruthy()
    resolveOld({ ...current, order: { ...current.order, orderNumber: 'UE-OLD' } })
    await Promise.resolve()
    expect(screen.queryByText('#UE-OLD')).toBeNull()

    const dialog = within(screen.getByRole('dialog', { name: '注文の詳細' }))
    fireEvent.click(dialog.getByRole('button', { name: '受け付ける' }))
    await waitFor(() => expect(fixture.accept).toHaveBeenCalledWith('account-2', 'o1', 1))
    expect(fixture.accept).not.toHaveBeenCalledWith('account-1', 'o1', 1)
  })

  it.each([
    ['demaecan', '出前館', 'new', '受け付ける', 'accept'],
    ['rocketnow', 'ロケットナウ', 'new', '受け付ける', 'accept'],
    ['demaecan', '出前館', 'cooking', '準備完了にする', 'ready'],
    ['rocketnow', 'ロケットナウ', 'cooking', '準備完了にする', 'ready'],
  ] as const)('%s（%s）の%s注文で%sを送れる', async (service, serviceLabel, status, label, action) => {
    const original = await fixture.order()
    fixture.order.mockResolvedValue({ ...original, order: { ...original.order, service, serviceLabel, status } })
    fixture.orders.mockResolvedValue(ordersData([order('o1', 'OTHER-1001', { service, serviceLabel, status })]))
    fixture[action].mockResolvedValue({ success: true })
    at('/restaurant-test/delivery?id=o1')
    render(<DeliveryPage />)
    const dialog = within(await screen.findByRole('dialog', { name: '注文の詳細' }))
    const actionButton = await dialog.findByRole('button', { name: label })
    expect((actionButton as HTMLButtonElement).disabled).toBe(false)
    expect(dialog.queryByText(/操作はまだ利用できません/)).toBeNull()
    for (const name of status === 'new' ? ['注文をキャンセルする', '断る'] : ['注文をキャンセルする']) {
      expect((dialog.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false)
    }
    fireEvent.click(actionButton)
    await waitFor(() => expect(fixture[action]).toHaveBeenCalledWith('account-1', 'o1', 1))
  })

  it('一括停止でUberを選べず、他社だけを送る', async () => {
    fixture.stopIntake.mockResolvedValue({ stopped: ['demaecan'], failed: [] })
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')
    fireEvent.click(screen.getByText('受付をまとめて止める'))
    const dialog = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
    const uber = dialog.getByRole('checkbox', { name: /Uber Eatsの受付を止める/ }) as HTMLInputElement
    expect(uber.disabled).toBe(true)
    expect(uber.checked).toBe(false)
    fireEvent.click(uber)
    fireEvent.click(dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }))
    fireEvent.click(dialog.getByRole('button', { name: '60分', exact: true }))
    fireEvent.click(dialog.getByRole('button', { name: '止める' }))
    await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledWith('account-1', ['demaecan'], '60m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'demaecan', version: 1, target: 'target-demaecan' }] }))
  })

  it('Uberを含む商品の同期を止め、他社だけの商品は残す', async () => {
    const other = { ...menuItem('other', '他社だけの商品'), services: [{ service: 'demaecan', label: '出前館' }] }
    fixture.menuItems.mockResolvedValue({ success: true, store: { id: 'store-1', name: '架空店' }, items: [menuItem('m1', 'Uberの商品'), other] })
    fixture.bulkSoldOut.mockResolvedValue({ updated: ['other'], failed: [] })
    at('/restaurant-test/delivery?view=sold-out')
    render(<DeliveryPage />)
    await screen.findByText('Uberの商品')
    const toggle = screen.getByRole('switch', { name: 'Uberの商品の販売' })
    expect((toggle as HTMLInputElement).disabled || toggle.getAttribute('aria-disabled') === 'true').toBe(true)
    fireEvent.click(toggle)
    expect(fixture.bulkSoldOut).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Uberの商品を選ぶ') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('表示中をすべて選ぶ'))
    fireEvent.click(screen.getByRole('button', { name: '選んだ商品を品切れにする' }))
    await waitFor(() => expect(fixture.bulkSoldOut).toHaveBeenCalledWith('account-1', ['other'], true, { expectedStoreId: 'store-1', expectedItems: [{ id: 'other', version: 1, target: 'menu-other' }] }))
  })

  it('商品の個別変更も表示した版と接続先を送る', async () => {
    const other = { ...menuItem('other', '他社だけの商品'), services: [{ service: 'demaecan', label: '出前館' }] }
    fixture.menuItems.mockResolvedValue({ success: true, store: { id: 'store-1', name: '架空店' }, items: [other] })
    fixture.bulkSoldOut.mockResolvedValue({ updated: ['other'], failed: [] })
    at('/restaurant-test/delivery?view=sold-out')
    render(<DeliveryPage />)
    fireEvent.click(await screen.findByRole('switch', { name: '他社だけの商品の販売' }))
    await waitFor(() => expect(fixture.bulkSoldOut).toHaveBeenCalledWith('account-1', ['other'], true, { expectedStoreId: 'store-1', expectedItems: [{ id: 'other', version: 1, target: 'menu-other' }] }))
  })

  it('Uberの過去の注文・詳細・CSVを引き続き確認できる', async () => {
    fixture.history.mockResolvedValue({ success: true, totals: { count: 1, amount: 3480, byService: [], canceledCount: 0 }, orders: [order('o1', 'UE-1001')] })
    fixture.historyCsv.mockResolvedValue({ truncated: false })
    at('/restaurant-test/delivery?view=history')
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')
    fireEvent.click(screen.getByRole('button', { name: /CSV/ }))
    await waitFor(() => expect(fixture.historyCsv).toHaveBeenCalledWith('account-1', expect.objectContaining({ from: expect.any(String), to: expect.any(String) })))
    fireEvent.click(screen.getByRole('button', { name: '注文UE-1001の詳細' }))
    expect(await screen.findByRole('dialog', { name: '注文の詳細' })).toBeTruthy()
  })
})

afterEach(() => { verifiedStaffRole(null) })

function chooseAvailableStopServices() {
  const dialog = within(screen.getByRole('alertdialog'))
  for (const element of dialog.getAllByRole('checkbox')) {
    const checkbox = element as HTMLInputElement
    if (!checkbox.disabled && !checkbox.checked) fireEvent.click(checkbox)
  }
  fireEvent.click(dialog.getByRole('button', { name: '60分', exact: true }))
}

describe('受付操作は現在の接続状態と店を確かめる', () => {
  it.each([
    ['demaecan', '出前館', 'disconnected', 'open'],
    ['demaecan', '出前館', 'error', 'stopped'],
    ['rocketnow', 'ロケットナウ', 'disconnected', 'stopped'],
    ['rocketnow', 'ロケットナウ', 'error', 'open'],
  ] as const)('%s（%s）の接続=%s・受付=%sでは受付を断定せず、停止も再開も送らない', async (service, label, connectionStatus, intakeStatus) => {
    const data = ordersData([])
    data.services = data.services.map((state) => state.service === service ? { ...state, connectionStatus, intakeStatus } : state)
    fixture.orders.mockResolvedValue(data)
    render(<DeliveryPage />)
    const card = within(await screen.findByRole('region', { name: label }))
    expect(card.getByText(connectionStatus === 'error' ? '接続の異常' : '未接続')).toBeTruthy()
    expect(card.queryByText('受付中')).toBeNull()
    expect(card.queryByText('停止中')).toBeNull()
    const button = card.getByRole('button', { name: `${label}の受付を${intakeStatus === 'open' ? '止める' : '再開'}` }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-description')).toMatch(/接続/)
    fireEvent.click(button)
    expect(fixture.stopIntake).not.toHaveBeenCalled()
    expect(fixture.resumeIntake).not.toHaveBeenCalled()
    expect(fixture.orders).toHaveBeenCalledWith('account-1', { tab: 'new' })
  })

  it('まとめ停止は接続済みかつ受付中だけを選び、未接続を直接選ぼうとしても送らない', async () => {
    const data = ordersData([])
    data.services = data.services.map((state) => state.service === 'demaecan'
      ? { ...state, connectionStatus: 'disconnected' }
      : state.service === 'rocketnow' ? { ...state, intakeStatus: 'open' } : state)
    fixture.orders.mockResolvedValue(data)
    fixture.stopIntake.mockResolvedValue({ stopped: ['rocketnow'], failed: [] })
    render(<DeliveryPage />)
    await screen.findByRole('region', { name: '出前館' })
    fireEvent.click(screen.getByRole('button', { name: '受付をまとめて止める' }))
    chooseAvailableStopServices()
    const dialog = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
    const disconnected = dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement
    expect(disconnected.disabled).toBe(true)
    expect(disconnected.checked).toBe(false)
    expect((dialog.getByRole('checkbox', { name: /ロケットナウの受付を止める/ }) as HTMLInputElement).checked).toBe(true)
    act(() => fixture.stopDialog!.onToggleService('demaecan', true))
    expect(fixture.stopDialog!.selected).toEqual(['rocketnow'])
    fireEvent.click(dialog.getByRole('button', { name: '止める' }))
    await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledTimes(1))
    expect(fixture.stopIntake).toHaveBeenCalledWith('account-1', ['rocketnow'], '60m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'rocketnow', version: 1, target: 'target-rocketnow' }] })
  })

  it('停止できる接続が無い時はまとめ停止にも理由を出し、保持した入口からも窓を開かない', async () => {
    const data = ordersData([])
    data.services = data.services.map((state) => ({ ...state, connectionStatus: 'disconnected', intakeStatus: 'open' }))
    fixture.orders.mockResolvedValue(data)
    render(<DeliveryPage />)
    await screen.findByRole('region', { name: '出前館' })
    const button = screen.getByRole('button', { name: '受付をまとめて止める' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-description')).toMatch(/接続/)
    act(() => fixture.board!.onStopService('demaecan'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fixture.stopIntake).not.toHaveBeenCalled()
  })

  it('窓を開いてから接続が切れたら、保持した確定でも書込0で選択と窓を残す', async () => {
    const data = ordersData([])
    fixture.orders.mockResolvedValue(data)
    fixture.stopIntake.mockResolvedValue({ stopped: ['demaecan'], failed: [] })
    render(<DeliveryPage />)
    await screen.findByRole('region', { name: '出前館' })
    fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
    await screen.findByRole('alertdialog')
    const heldConfirm = fixture.stopDialog!.onSubmit
    const next = { ...data, services: data.services.map((state) => state.service === 'demaecan' ? { ...state, connectionStatus: 'disconnected' as const } : state) }
    fixture.orders.mockResolvedValue(next)
    await act(async () => at('/restaurant-test/delivery?tab=all'))
    await waitFor(() => expect(fixture.board!.data.services.find((state) => state.service === 'demaecan')!.connectionStatus).toBe('disconnected'))
    await act(async () => heldConfirm())
    expect(fixture.stopIntake).not.toHaveBeenCalled()
    const dialog = within(screen.getByRole('alertdialog'))
    expect(dialog.getByRole('button', { name: '止める' }).getAttribute('disabled')).not.toBeNull()
    expect(fixture.stopDialog!.selected).toEqual(['demaecan'])
    expect(dialog.getAllByText(/接続/).length).toBeGreaterThan(0)
  })

  it('別の店へ切り替えた後に古い再開を押しても、元の店にも新しい店にも送らない', async () => {
    fixture.orders.mockResolvedValue(ordersData([]))
    fixture.resumeIntake.mockResolvedValue({ resumed: ['rocketnow'], failed: [] })
    const view = render(<DeliveryPage />)
    await screen.findByRole('region', { name: 'ロケットナウ' })
    const heldResume = fixture.board!.onResumeService
    fixture.accountId.value = 'account-2'
    view.rerender(<DeliveryPage />)
    await waitFor(() => expect(fixture.orders).toHaveBeenCalledWith('account-2', { tab: 'new' }))
    await act(async () => heldResume('rocketnow'))
    expect(fixture.resumeIntake).not.toHaveBeenCalled()
  })

  it.each(['owner', 'admin'] as const)('%s は接続済みのサービスを停止・再開できる', async (role) => {
    fixture.role.value = verifiedStaffRole(role)
    fixture.stopIntake.mockResolvedValue({ stopped: ['demaecan'], failed: [] })
    fixture.resumeIntake.mockResolvedValue({ resumed: ['rocketnow'], failed: [] })
    render(<DeliveryPage />)
    await screen.findByRole('region', { name: '出前館' })
    fireEvent.click(screen.getByRole('button', { name: 'ロケットナウの受付を再開' }))
    await waitFor(() => expect(fixture.resumeIntake).toHaveBeenCalledWith('account-1', ['rocketnow']))
    await waitFor(() => expect((screen.getByRole('button', { name: 'ロケットナウの受付を再開' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
    const dialog = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
    fireEvent.click(dialog.getByRole('button', { name: '止める' }))
    await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledWith('account-1', ['demaecan'], '60m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'demaecan', version: 1, target: 'target-demaecan' }] }))
    expect(fixture.stopIntake).toHaveBeenCalledTimes(1)
    expect(fixture.resumeIntake).toHaveBeenCalledTimes(1)
  })
})

// 確認窓を開く前の正当な入力を使い、途中の変更と二重実行を対照にする。
it.each(['staff', null] as const)('停止の窓を開いた後に役割が%sなら古い確定から書き込まない', async role => {
  render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
  const confirm = fixture.stopDialog!.onSubmit
  fixture.role.value = verifiedStaffRole(role)
  await act(async () => at('/restaurant-test/delivery?tab=all'))
  await act(async () => confirm())
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  if (role === null) {
    const dialog = within(screen.getByRole('alertdialog'))
    expect(within(screen.getByRole('alertdialog').querySelector('[data-window-actions]') as HTMLElement).getByText('担当者の確認が終わるまでお待ちください。')).toBeTruthy()
    expect((dialog.getByRole('button', { name: '止める', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  } else {
    expect(screen.queryByRole('alertdialog')).toBeNull()
  }
})

it('未取得の別の店では、前の店のサービスを使って停止を開かない', async () => {
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  const heldOpen = fixture.board!.onStopService
  fixture.orders.mockReturnValue(new Promise(() => {}))
  fixture.accountId.value = 'account-2'
  view.rerender(<DeliveryPage />)
  act(() => heldOpen('demaecan'))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  expect(fixture.orders).toHaveBeenCalledWith('account-2', { tab: 'new' })
})

it('停止中に同じ確定や再開を連続して呼んでも、次の書込は送らない', async () => {
  let resolve!: (result: { stopped: DeliveryService[]; failed: [] }) => void
  fixture.stopIntake.mockReturnValue(new Promise(done => { resolve = done }))
  render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
  const confirm = fixture.stopDialog!.onSubmit
  act(() => { confirm(); confirm(); fixture.board!.onResumeService('rocketnow') })
  expect(fixture.stopIntake).toHaveBeenCalledTimes(1)
  expect(fixture.resumeIntake).not.toHaveBeenCalled()
  await act(async () => resolve({ stopped: ['demaecan'], failed: [] }))
})

it('StrictModeの2回描画でも正当な受付停止を変化扱いにしない', async () => {
  fixture.stopIntake.mockResolvedValue({ stopped: ['demaecan'], failed: [] })
  render(<React.StrictMode><DeliveryPage /></React.StrictMode>)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '止める', exact: true }))
  await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledWith('account-1', ['demaecan'], '60m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'demaecan', version: 1, target: 'target-demaecan' }] }))
  expect(screen.queryByText(/店舗や権限が変わった/)).toBeNull()
})

it.each(['stop', 'resume'] as const)('送信済み%sの応答が店の切替後に戻っても元の店を読み直して上書きしない', async action => {
  let resolve!: (result: { stopped: DeliveryService[]; resumed: DeliveryService[]; failed: [] }) => void
  const pending = new Promise(done => { resolve = done })
  fixture.stopIntake.mockReturnValue(pending); fixture.resumeIntake.mockReturnValue(pending)
  fixture.orders.mockImplementation(async (account: string) => ({ ...ordersData([]), store: { id: account, name: account } }))
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  if (action === 'stop') {
    fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '止める', exact: true }))
  } else fireEvent.click(screen.getByRole('button', { name: 'ロケットナウの受付を再開' }))
  expect(action === 'stop' ? fixture.stopIntake : fixture.resumeIntake).toHaveBeenCalledTimes(1)
  fixture.accountId.value = 'account-2'
  view.rerender(<DeliveryPage />)
  await waitFor(() => expect(fixture.board!.data.store.id).toBe('account-2'))
  await act(async () => resolve({ stopped: ['demaecan'], resumed: ['rocketnow'], failed: [] }))
  expect(fixture.board!.data.store.id).toBe('account-2')
  expect(fixture.orders.mock.calls.filter(([account]) => account === 'account-1')).toHaveLength(1)
})

it.each(['resolve', 'reject'] as const)('自動更新が%sする途中も確認済みの受付操作を保つ', async outcome => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let resolve!: (data: DeliveryOrdersData) => void
  let reject!: (error: Error) => void
  try {
    fixture.stopIntake.mockResolvedValue({ stopped: ['demaecan'], failed: [] })
    render(<DeliveryPage />)
    await screen.findByRole('region', { name: '出前館' })
    fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
    const pending = new Promise<DeliveryOrdersData>((done, fail) => { resolve = done; reject = fail })
    fixture.orders.mockReturnValue(pending)
    await act(async () => { vi.advanceTimersByTime(30_000) })
    const dialog = within(screen.getByRole('alertdialog'))
    expect((dialog.getByRole('button', { name: '止める', exact: true }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: '出前館の受付を止める' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('注文の状態を読み直してから操作してください。')).toBeNull()
    if (outcome === 'resolve') {
      fireEvent.click(dialog.getByRole('button', { name: '止める', exact: true }))
      await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledTimes(1))
      await act(async () => resolve(ordersData([])))
    } else {
      await act(async () => reject(new Error('background refresh failed')))
      expect((dialog.getByRole('button', { name: '止める', exact: true }) as HTMLButtonElement).disabled).toBe(false)
      expect(screen.queryByText('注文の状態を読み直してから操作してください。')).toBeNull()
    }
    expect(fixture.orders.mock.calls.length).toBeGreaterThanOrEqual(2)
  } finally { cleanup(); vi.useRealTimers() }
})

it('接続が切れた選択だけを外し、窓を開き直さず他のサービスを停止できる', async () => {
  const first = ordersData([])
  first.services = first.services.map(state => ({ ...state, intakeStatus: 'open' }))
  fixture.orders.mockResolvedValue(first)
  fixture.stopIntake.mockResolvedValue({ stopped: ['rocketnow'], failed: [] })
  render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '受付をまとめて止める' }))
  chooseAvailableStopServices()
  fixture.orders.mockResolvedValue({ ...first, services: first.services.map(state => state.service === 'demaecan' ? { ...state, connectionStatus: 'disconnected' } : state) })
  await act(async () => at('/restaurant-test/delivery?tab=all'))
  await waitFor(() => expect((within(screen.getByRole('alertdialog')).getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement).disabled).toBe(true))
  const dialog = within(screen.getByRole('alertdialog'))
  fireEvent.click(dialog.getByRole('button', { name: '操作できないサービスの選択を外す' }))
  expect(fixture.stopDialog!.selected).toEqual(['rocketnow'])
  fireEvent.click(dialog.getByRole('button', { name: '止める', exact: true }))
  await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledWith('account-1', ['rocketnow'], '60m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'rocketnow', version: 1, target: 'target-rocketnow' }] }))
})

it('本人の確認中に保持された操作を呼んでも拒否と断定せず書き込まない', async () => {
  fixture.role.value = verifiedStaffRole(null)
  render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  act(() => fixture.board!.onStopService('demaecan'))
  expect(screen.getByText('担当者の確認が終わるまでお待ちください。')).toBeTruthy()
  expect(screen.queryByText('受付を変更する権限がありません。')).toBeNull()
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(fixture.stopIntake).not.toHaveBeenCalled()
})

it('提供前の営業状態を直接呼んでも選択・停止・再開を書き込まない', async () => {
  render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  act(() => { fixture.board!.onStopService('ubereats'); fixture.board!.onResumeService('ubereats') })
  expect(screen.queryByRole('alertdialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
  act(() => fixture.stopDialog!.onToggleService('ubereats', true))
  expect(fixture.stopDialog!.selected).toEqual(['demaecan'])
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  expect(fixture.resumeIntake).not.toHaveBeenCalled()
})

it('店の切替後や画面を閉じた後の古い確定からは書き込まない', async () => {
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
  const confirm = fixture.stopDialog!.onSubmit
  fixture.accountId.value = 'account-2'
  view.rerender(<DeliveryPage />)
  await waitFor(() => expect(fixture.orders).toHaveBeenCalledWith('account-2', { tab: 'new' }))
  await act(async () => confirm())
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  view.unmount()
  await act(async () => confirm())
  expect(fixture.stopIntake).not.toHaveBeenCalled()
})


it('店の選択を読み込んでいる間は保持された停止と再開を書き込まない', async () => {
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
  const confirm = fixture.stopDialog!.onSubmit
  const resume = fixture.board!.onResumeService
  fixture.accountLoading.value = true
  view.rerender(<DeliveryPage />)
  await act(async () => { confirm(); resume('rocketnow') })
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  expect(fixture.resumeIntake).not.toHaveBeenCalled()
  expect(screen.getAllByText('注文の状態を読み直してから操作してください。').length).toBeGreaterThan(0)
})

it('同じ店で画面を閉じた後も保持された確定と再開を書き込まない', async () => {
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
  const confirm = fixture.stopDialog!.onSubmit
  const resume = fixture.board!.onResumeService
  view.unmount()
  await act(async () => { confirm(); resume('rocketnow') })
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  expect(fixture.resumeIntake).not.toHaveBeenCalled()
})

it('停止の選択を全部外しても接続済みの行を選び直して送れる', async () => {
  const data = ordersData([])
  data.services = data.services.map(state => ({ ...state, intakeStatus: 'open' }))
  fixture.orders.mockResolvedValue(data)
  fixture.stopIntake.mockResolvedValue({ stopped: ['rocketnow'], failed: [] })
  render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '受付をまとめて止める' }))
  chooseAvailableStopServices()
  const dialog = within(screen.getByRole('alertdialog'))
  fireEvent.click(dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }))
  fireEvent.click(dialog.getByRole('checkbox', { name: /ロケットナウの受付を止める/ }))
  expect(fixture.stopDialog!.selected).toEqual([])
  const choose = dialog.getByRole('checkbox', { name: /ロケットナウの受付を止める/ }) as HTMLInputElement
  expect(choose.disabled).toBe(false)
  expect((dialog.getByRole('button', { name: '止める', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  const reason = dialog.getByText('停止するサービスを選んでください')
  expect(reason.closest('[data-window-actions]')).not.toBeNull()
  expect(reason.closest('[class*="dialogActions"]')).toBeNull()
  fireEvent.click(choose)
  fireEvent.click(dialog.getByRole('button', { name: '止める', exact: true }))
  await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledWith('account-1', ['rocketnow'], '60m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'rocketnow', version: 1, target: 'target-rocketnow' }] }))
  expect(fixture.stopIntake).toHaveBeenCalledTimes(1)
})

it('1件だけの選択が切れたら、その選択を外して他の接続済みサービスを選べる', async () => {
  const data = ordersData([])
  data.services = data.services.map(state => ({ ...state, intakeStatus: 'open' }))
  fixture.orders.mockResolvedValue(data)
  fixture.stopIntake.mockResolvedValue({ stopped: ['rocketnow'], failed: [] })
  render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
  const changed = { ...data, services: data.services.map(state => state.service === 'demaecan' ? { ...state, connectionStatus: 'disconnected' as const } : state) }
  fixture.orders.mockResolvedValue(changed)
  await act(async () => at('/restaurant-test/delivery?tab=all'))
  await waitFor(() => expect((within(screen.getByRole('alertdialog')).getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement).disabled).toBe(true))
  const dialog = within(screen.getByRole('alertdialog'))
  const uber = dialog.getByRole('checkbox', { name: /Uber Eatsの受付を止める/ }).closest('label')!
  expect(within(uber).getByText(/営業状態の連携は準備中/)).toBeTruthy()
  expect(within(uber).queryByText('未接続のため操作できません。')).toBeNull()
  const other = dialog.getByRole('checkbox', { name: /ロケットナウの受付を止める/ }) as HTMLInputElement
  expect(other.disabled).toBe(false)
  fireEvent.click(dialog.getByRole('button', { name: '操作できないサービスの選択を外す' }))
  expect(fixture.stopDialog!.selected).toEqual([])
  expect(other.disabled).toBe(false)
  fireEvent.click(other)
  fireEvent.click(dialog.getByRole('button', { name: '止める', exact: true }))
  await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledWith('account-1', ['rocketnow'], '60m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'rocketnow', version: 1, target: 'target-rocketnow' }] }))
})

it('接続が切れた選択の理由を他の接続済みの行へ流用しない', async () => {
  const data = ordersData([])
  data.services = data.services.map(state => ({ ...state, intakeStatus: 'open' }))
  fixture.orders.mockResolvedValue(data)
  render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '受付をまとめて止める' }))
  chooseAvailableStopServices()
  fixture.orders.mockResolvedValue({ ...data, services: data.services.map(state => state.service === 'demaecan' ? { ...state, connectionStatus: 'disconnected' as const } : state) })
  await act(async () => at('/restaurant-test/delivery?tab=all'))
  await waitFor(() => expect((within(screen.getByRole('alertdialog')).getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement).disabled).toBe(true))
  const dialog = within(screen.getByRole('alertdialog'))
  const other = dialog.getByRole('checkbox', { name: /ロケットナウの受付を止める/ }) as HTMLInputElement
  expect(other.disabled).toBe(false)
  const row = other.closest('label')!
  expect(within(row).getByText(/現在 受付中/)).toBeTruthy()
  expect(within(row).queryByText('未接続のため操作できません。')).toBeNull()
  expect((dialog.getByRole('button', { name: '止める', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  expect(fixture.stopIntake).not.toHaveBeenCalled()
})

vi.mock('@/lib/admin-version-cache', () => ({ loadAdminVersionDetail: async () => ({ version: '2.7.0', deploy_env: 'staging' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'a', name: '対象LINE-A' }, { id: 'b', name: '対象LINE-B' }, { id: 'account-1', name: '対象LINE-1' }, { id: 'account-2', name: '対象LINE-2' }] }) }))

it('一括停止は切替後の対象を表示し、切替前の確認では送らず再確認した対象へ1回だけ送る', async () => {
  fixture.stopIntake.mockResolvedValue({ stopped: ['demaecan'], failed: [] })
  const view = render(<DeliveryPage />)
  await screen.findByText('#UE-1001')
  fireEvent.click(screen.getByRole('button', { name: '受付をまとめて止める', exact: true }))
  const first = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  await first.findByText('対象LINE-1')
  fireEvent.click(first.getByRole('checkbox', { name: /出前館の受付を止める/ }))
  fireEvent.click(first.getByRole('button', { name: '60分', exact: true }))
  const held = fixture.stopSubmit
  expect(held).toBeTypeOf('function')
  fixture.accountId.value = 'account-2'
  const next = ordersData([])
  next.store = { id: 'store-2', name: '切替先の店' }
  fixture.orders.mockResolvedValue(next)
  view.rerender(<DeliveryPage />)
  await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '受付を一括停止しますか？' })).toBeNull())
  act(() => { held!() })
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  await waitFor(() => expect(fixture.orders).toHaveBeenCalledWith('account-2', {tab:'new'}))
  await waitFor(() => expect((screen.getByRole('button', {name:'受付をまとめて止める',exact:true}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '受付をまとめて止める', exact: true }))
  const reopened = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  expect(reopened.getByRole('group', { name: '停止する時間' }).querySelectorAll('[aria-pressed="true"]')).toHaveLength(0)
  expect((reopened.getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement).checked).toBe(false)
  expect((reopened.getByRole('button', { name: '止める', exact:true }) as HTMLButtonElement).disabled).toBe(true)
  const target = within(await screen.findByRole('region', { name: '操作の対象' }))
  await target.findByText('対象LINE-2')
  await target.findByText('切替先の店')
  expect(target.queryByText('対象LINE-1')).toBeNull()
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  fireEvent.click(reopened.getByRole('checkbox', { name: /出前館の受付を止める/ }))
  fireEvent.click(reopened.getByRole('button', { name: '30分', exact: true }))
  act(() => { held!() })
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  fireEvent.click(reopened.getByRole('button', { name: '止める', exact: true }))
  await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledTimes(1))
  expect(fixture.stopIntake.mock.calls).toEqual([['account-2', ['demaecan'], '30m', { expectedStoreId: 'store-2', expectedStates: [{ service: 'demaecan', version: 1, target: 'target-demaecan' }] }]])
})


describe('受付を止める前の明示選択', () => {
  it('一括の初期状態はサービスも時間も未選択で、片方だけ選んでも停止しない', async () => {
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')
    fireEvent.click(screen.getByText('受付をまとめて止める'))
    expect(screen.queryByRole('alertdialog', { name: '受付を一括停止しますか？' })).not.toBeNull()
    const dialog = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
    const service = dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement
    const submit = dialog.getByRole('button', { name: '止める' }) as HTMLButtonElement
    expect(service.checked).toBe(false)
    expect(dialog.getByRole('group', { name: '停止する時間' }).querySelectorAll('[aria-pressed="true"]')).toHaveLength(0)
    expect(submit.disabled).toBe(true)
    expect(dialog.getByText('停止するサービスを選んでください')).toBeTruthy()
    fireEvent.click(submit)
    expect(fixture.stopIntake).not.toHaveBeenCalled()
    fireEvent.click(service)
    expect(submit.disabled).toBe(true)
    expect(dialog.getByText('停止する時間を選んでください')).toBeTruthy()
    fireEvent.click(dialog.getByRole('button', { name: '90分', exact: true }))
    expect(submit.disabled).toBe(false)
    expect(dialog.getByRole('group', { name: '停止する時間' }).querySelector('[aria-hidden="true"]')).not.toBeNull()
    fireEvent.click(service)
    expect(submit.disabled).toBe(true)
    expect(fixture.stopIntake).not.toHaveBeenCalled()
  })

  it('明示したサービスと時間だけを送り、失敗では選択を保ち、開き直すと選択を消す', async () => {
    fixture.stopIntake.mockRejectedValueOnce(new Error('停止を確認できませんでした'))
    render(<DeliveryPage />)
    await screen.findByText('#UE-1001')
    fireEvent.click(screen.getByText('受付をまとめて止める'))
    const element = await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' })
    const dialog = within(element)
    fireEvent.click(dialog.getByRole('button', { name: '30分', exact: true }))
    expect((dialog.getByRole('button', { name: '止める' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }))
    fireEvent.click(dialog.getByRole('button', { name: '止める' }))
    await waitFor(() => expect(fixture.stopIntake).toHaveBeenCalledExactlyOnceWith('account-1', ['demaecan'], '30m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'demaecan', version: 1, target: 'target-demaecan' }] }))
    await dialog.findByText('受付を停止できませんでした。')
    expect((dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement).checked).toBe(true)
    expect(dialog.getByRole('button', { name: '30分', exact: true }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(dialog.getByText('閉じる', { exact: true }))
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '受付を一括停止しますか？' })).toBeNull())
    fireEvent.click(screen.getByText('受付をまとめて止める'))
    const reopened = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
    expect((reopened.getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement).checked).toBe(false)
    expect(reopened.getByRole('group', { name: '停止する時間' }).querySelectorAll('[aria-pressed="true"]')).toHaveLength(0)
    expect((reopened.getByRole('button', { name: '止める' }) as HTMLButtonElement).disabled).toBe(true)
  })
})


it('個別の停止入口は押したサービスだけを選び、時間は明示するまで送らない', async () => {
  render(<DeliveryPage />)
  await screen.findByText('#UE-1001')
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  const dialog = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  expect((dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement).checked).toBe(true)
  expect((dialog.getByRole('checkbox', { name: /ロケットナウの受付を止める/ }) as HTMLInputElement).checked).toBe(false)
  expect(dialog.getByRole('group', { name: '停止する時間' }).querySelectorAll('[aria-pressed="true"]')).toHaveLength(0)
  expect((dialog.getByRole('button', { name: '止める' }) as HTMLButtonElement).disabled).toBe(true)
  expect(dialog.getByText('停止する時間を選んでください')).toBeTruthy()
  expect(fixture.stopIntake).not.toHaveBeenCalled()
})


it('古い停止の押し口も最新の未選択で止まり、二度呼んでも一回だけ送る', async () => {
  let finish!: (value: { stopped: DeliveryService[]; failed: [] }) => void
  fixture.stopIntake.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<DeliveryPage />)
  await screen.findByText('#UE-1001')
  fireEvent.click(screen.getByText('受付をまとめて止める'))
  const dialog = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  const service = dialog.getByRole('checkbox', { name: /出前館の受付を止める/ })
  fireEvent.click(service)
  fireEvent.click(dialog.getByRole('button', { name: '90分', exact: true }))
  const held = fixture.stopSubmit
  expect(held).toBeTypeOf('function')
  fireEvent.click(service)
  act(() => { held!() })
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  fireEvent.click(service)
  act(() => { held!(); held!() })
  expect(fixture.stopIntake).toHaveBeenCalledExactlyOnceWith('account-1', ['demaecan'], '90m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'demaecan', version: 1, target: 'target-demaecan' }] })
  finish({ stopped: ['demaecan'], failed: [] })
  await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '受付を一括停止しますか？' })).toBeNull())
})


it('切替先の一覧待ちでは前の店のサービスを表示せず停止しない', async () => {
  const view = render(<DeliveryPage />)
  await screen.findByText('#UE-1001')
  let finish!: (value: DeliveryOrdersData) => void
  fixture.orders.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  fixture.accountId.value = 'account-2'
  view.rerender(<DeliveryPage />)
  expect(fixture.stopDialog!.services).toEqual([])
  const button = screen.getByRole('button', { name: '受付をまとめて止める', exact: true }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(fixture.stopSubmit).toBeTypeOf('function')
  act(() => { fixture.stopSubmit!() })
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  const next = ordersData([]);next.store = { id: 'store-2', name: '切替先の店' }
  await act(async () => { finish(next) })
  await waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
  const dialog = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  expect((dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement).checked).toBe(false)
})


it.each(['success', 'failure'] as const)('停止の%s応答前に切り替えた時は新しい店と知らせに混ぜない', async (outcome) => {
  fixture.orders.mockImplementation(async (account: string) => ({ ...ordersData([]), store: { id: account, name: account } }))
  let finish!: (value: { stopped: DeliveryService[]; failed: [] }) => void
  let fail!: (error: Error) => void
  fixture.stopIntake.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByText('受付をまとめて止める'))
  const first = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  fireEvent.click(first.getByRole('checkbox', { name: /出前館の受付を止める/ }))
  fireEvent.click(first.getByRole('button', { name: '30分', exact: true }))
  expect(fixture.stopSubmit).toBeTypeOf('function')
  let completion: void = undefined
  act(() => { completion = fixture.stopSubmit!() })
  expect(fixture.stopIntake).toHaveBeenCalledExactlyOnceWith('account-1', ['demaecan'], '30m', { expectedStoreId: 'account-1', expectedStates: [{ service: 'demaecan', version: 1, target: 'target-demaecan' }] })
  fixture.accountId.value = 'account-2'
  view.rerender(<DeliveryPage />)
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  await waitFor(() => expect(fixture.orders).toHaveBeenCalledWith('account-2', { tab: 'new' }))
  expect((screen.getByRole('button', { name: '受付をまとめて止める' }) as HTMLButtonElement).disabled).toBe(false)
  const callsBeforeResponse = fixture.orders.mock.calls.length
  await act(async () => {
    if (outcome === 'success') finish({ stopped: ['demaecan'], failed: [] })
    else fail(new Error('前の店の停止失敗'))
    await completion
  })
  expect(fixture.orders).toHaveBeenCalledTimes(callsBeforeResponse)
  expect(screen.queryByText('1件のサービスの受付を停止しました。')).toBeNull()
  expect(fixture.stopDialog!.error).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '受付をまとめて止める' }))
  const reopened = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  expect((reopened.getByRole('checkbox', { name: /出前館の受付を止める/ }) as HTMLInputElement).checked).toBe(false)
  expect(reopened.queryByText('受付を停止できませんでした。')).toBeNull()
  expect(fixture.stopIntake).toHaveBeenCalledTimes(1)
})

it('停止後の一覧読み直し中に切り替えた時も前の店の成功を知らせない', async () => {
  let finishReload!: (value: DeliveryOrdersData) => void
  fixture.stopIntake.mockResolvedValue({ stopped: ['demaecan'], failed: [] })
  const view = render(<DeliveryPage />)
  await screen.findByText('#UE-1001')
  fireEvent.click(screen.getByText('受付をまとめて止める'))
  const dialog = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  fireEvent.click(dialog.getByRole('checkbox', { name: /出前館の受付を止める/ }))
  fireEvent.click(dialog.getByRole('button', { name: '30分', exact: true }))
  fixture.orders.mockImplementationOnce(() => new Promise(resolve => { finishReload = resolve }))
  expect(fixture.stopSubmit).toBeTypeOf('function')
  let completion: void = undefined
  act(() => { completion = fixture.stopSubmit!() })
  await waitFor(() => expect(fixture.orders).toHaveBeenCalledTimes(2))
  fixture.accountId.value = 'account-2'
  view.rerender(<DeliveryPage />)
  await waitFor(() => expect(fixture.orders).toHaveBeenCalledWith('account-2', { tab: 'new' }))
  await act(async () => { finishReload(ordersData([])); await completion })
  expect(screen.queryByText('1件のサービスの受付を停止しました。')).toBeNull()
  expect(fixture.stopIntake).toHaveBeenCalledExactlyOnceWith('account-1', ['demaecan'], '30m', { expectedStoreId: 'store-1', expectedStates: [{ service: 'demaecan', version: 1, target: 'target-demaecan' }] })
})

it('注文取消の窓を閉じた後は保持した確定から送らない', async () => {
  fixture.orders.mockResolvedValue(ordersData([order('o1', 'UE-1001')], true))
  at('/restaurant-test/delivery?id=o1')
  render(<DeliveryPage />)
  const detail = within(await screen.findByRole('dialog', { name: '注文の詳細' }))
  fireEvent.click(await detail.findByRole('button', { name: '注文をキャンセルする' }))
  const dialog = within(await screen.findByRole('alertdialog', { name: 'この注文をキャンセルしますか？' }))
  const button = dialog.getByRole('button', { name: 'キャンセルする' })
  const propsKey = Object.keys(button).find(key => key.startsWith('__reactProps$'))!
  const held = (button as unknown as Record<string, { onClick: () => void }>)[propsKey].onClick
  fireEvent.click(dialog.getAllByRole('button', { name: '閉じる' }).at(-1)!)
  act(() => held())
  expect(fixture.cancel).not.toHaveBeenCalled()
})

it('受注画面の説明はできる操作を示す', async () => {
  render(<DeliveryPage />)
  await screen.findByText('#UE-1001')
  const trigger = screen.getByRole('button', { name: 'デリバリー受注の説明' })
  fireEvent.click(trigger)
  const note = document.getElementById(trigger.getAttribute('aria-describedby')!)
  expect(note?.textContent).toContain('新着注文を受け付け')
  expect(note?.textContent).toContain('注文履歴')
})
