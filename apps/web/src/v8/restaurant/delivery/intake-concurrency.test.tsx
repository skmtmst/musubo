import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
// 受付操作の同時実行と画面終了後の振る舞い。
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
  roleFailed: { value: false },
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
  useStaffIdentityLoad: () => ({ failed: fixture.roleFailed.value }),
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
  fixture.roleFailed.value = false
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

it('前の店の受付変更が未完了でも別の店を操作でき、元の店の二重操作は止める', async () => {
  let finishFirst!: (value: { stopped: DeliveryService[]; failed: [] }) => void
  let finishSecond!: (value: { resumed: DeliveryService[]; failed: [] }) => void
  fixture.orders.mockImplementation(async (account: string) => ({ ...ordersData([]), store: { id: account, name: account } }))
  fixture.stopIntake.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
  fixture.resumeIntake.mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve }))
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  const first = within(screen.getByRole('alertdialog'))
  fireEvent.click(first.getByRole('button', { name: '60分', exact: true }))
  fireEvent.click(first.getByRole('button', { name: '止める', exact: true }))
  expect(fixture.stopIntake).toHaveBeenCalledTimes(1)
  fixture.accountId.value = 'account-2'; view.rerender(<DeliveryPage />)
  await waitFor(() => expect(fixture.board?.data.store.id).toBe('account-2'))
  const resume = screen.getByRole('button', { name: 'ロケットナウの受付を再開' }) as HTMLButtonElement
  expect(resume.disabled).toBe(false)
  fireEvent.click(resume)
  expect(fixture.resumeIntake).toHaveBeenCalledExactlyOnceWith('account-2', ['rocketnow'])
  fixture.accountId.value = 'account-1'; view.rerender(<DeliveryPage />)
  await waitFor(() => expect(fixture.board?.data.store.id).toBe('account-1'))
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  expect(fixture.stopIntake).toHaveBeenCalledTimes(1)
  await act(async () => { finishFirst({ stopped: ['demaecan'], failed: [] }); await Promise.resolve() })
  fixture.accountId.value = 'account-2'; view.rerender(<DeliveryPage />)
  await waitFor(() => expect(fixture.board?.data.store.id).toBe('account-2'))
  fireEvent.click(screen.getByRole('button', { name: 'ロケットナウの受付を再開' }))
  expect(fixture.resumeIntake).toHaveBeenCalledTimes(1)
  await act(async () => { finishSecond({ resumed: ['rocketnow'], failed: [] }); await Promise.resolve() })
})

it('別のLINEアカウントでも同じ店の受付変更は同時に始めない', async () => {
  let finish!: (value: { stopped: DeliveryService[]; failed: [] }) => void
  fixture.orders.mockImplementation(async () => ({ ...ordersData([]), store: { id: 'shared-store', name: '同じ店' } }))
  fixture.stopIntake.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  const first = within(screen.getByRole('alertdialog'))
  fireEvent.click(first.getByRole('button', { name: '60分', exact: true }))
  fireEvent.click(first.getByRole('button', { name: '止める', exact: true }))
  expect(fixture.stopIntake).toHaveBeenCalledTimes(1)
  fixture.accountId.value = 'account-2'; view.rerender(<DeliveryPage />)
  await waitFor(() => expect(fixture.orders).toHaveBeenCalledWith('account-2', { tab: 'new' }))
  fireEvent.click(screen.getByRole('button', { name: 'ロケットナウの受付を再開' }))
  expect(fixture.resumeIntake).not.toHaveBeenCalled()
  await act(async () => { finish({ stopped: ['demaecan'], failed: [] }); await Promise.resolve() })
})

it.each(['stop', 'resume'] as const)('画面を閉じた後に%sの応答が戻っても注文を読み直さない', async action => {
  let finish!: (value: { stopped: DeliveryService[]; resumed: DeliveryService[]; failed: [] }) => void
  const pending = new Promise<{ stopped: DeliveryService[]; resumed: DeliveryService[]; failed: [] }>(resolve => { finish = resolve })
  fixture.stopIntake.mockReturnValue(pending); fixture.resumeIntake.mockReturnValue(pending)
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  if (action === 'stop') {
    fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
    const dialog = within(screen.getByRole('alertdialog'))
    fireEvent.click(dialog.getByRole('button', { name: '60分', exact: true }))
    fireEvent.click(dialog.getByRole('button', { name: '止める', exact: true }))
  } else fireEvent.click(screen.getByRole('button', { name: 'ロケットナウの受付を再開' }))
  expect(action === 'stop' ? fixture.stopIntake : fixture.resumeIntake).toHaveBeenCalledTimes(1)
  const reads = fixture.orders.mock.calls.length
  view.unmount()
  await act(async () => { finish({ stopped: ['demaecan'], resumed: ['rocketnow'], failed: [] }); await pending })
  expect(fixture.orders).toHaveBeenCalledTimes(reads)
})


it('受付停止の窓で担当者の確認に失敗したら理由を示し送信しない', async () => {
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  const dialog = within(screen.getByRole('alertdialog'))
  fireEvent.click(dialog.getByRole('button', { name: '60分', exact: true }))
  fixture.role.value = null
  fixture.roleFailed.value = true
  view.rerender(<DeliveryPage />)
  expect(dialog.getAllByText('担当者を確認できませんでした。画面を読み直してください。').length).toBeGreaterThan(0)
  expect((dialog.getByRole('button', { name: '止める', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  expect(fixture.stopIntake).not.toHaveBeenCalled()
})

it('閲覧のみへ変わると受付停止の窓と入力を閉じ、古い確定は使えない', async () => {
  const view = render(<DeliveryPage />)
  await screen.findByRole('region', { name: '出前館' })
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '60分', exact: true }))
  const oldSubmit = fixture.stopSubmit
  fixture.role.value = verifiedStaffRole('viewer')
  view.rerender(<DeliveryPage />)
  expect(screen.queryByRole('alertdialog')).toBeNull()
  fixture.role.value = verifiedStaffRole('owner')
  view.rerender(<DeliveryPage />)
  await act(async () => { oldSubmit?.() })
  expect(fixture.stopIntake).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '出前館の受付を止める' }))
  expect((within(screen.getByRole('alertdialog')).getByRole('button', { name: '止める', exact: true }) as HTMLButtonElement).disabled).toBe(true)
})

it('同じ店で停止窓を開き直しても前の窓の確定では送らない', async () => {
  render(<DeliveryPage />)
  await screen.findByText('#UE-1001')
  fireEvent.click(screen.getByRole('button', { name: '受付をまとめて止める', exact: true }))
  const first = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  const held = fixture.stopSubmit!
  fireEvent.click(first.getAllByRole('button', { name: '閉じる' }).at(-1)!)
  fireEvent.click(screen.getByRole('button', { name: '受付をまとめて止める', exact: true }))
  const next = within(await screen.findByRole('alertdialog', { name: '受付を一括停止しますか？' }))
  fireEvent.click(next.getByRole('checkbox', { name: /出前館の受付を止める/ }))
  fireEvent.click(next.getByRole('button', { name: '30分', exact: true }))
  act(() => held())
  expect(fixture.stopIntake).not.toHaveBeenCalled()
})
