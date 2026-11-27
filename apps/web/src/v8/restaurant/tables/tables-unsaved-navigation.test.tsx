// @vitest-environment happy-dom
import { useLayoutEffect, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), updateTable: vi.fn(), createTable: vi.fn(), deleteTable: vi.fn(), stopTable: vi.fn() }))
const floorApi = vi.hoisted(() => ({ floors: vi.fn(), saveFloor: vi.fn() }))
const assignmentApi = vi.hoisted(() => ({ getTables: vi.fn(), saveTables: vi.fn(), getTableAutomation: vi.fn(), saveTableAutomation: vi.fn() }))
const nav = vi.hoisted(() => ({ push: vi.fn(), follow: vi.fn(), afterFloorLoaded: null as null | (() => void) }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace() {}, back() {} }), usePathname: () => '/restaurant-test/tables', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/lib/api/helpers/booking-assignment', () => ({ bookingAssignmentApi: assignmentApi }))
vi.mock('@/lib/api/helpers/reservation-board', () => ({ reservationBoardApi: floorApi }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [{ id: 'account-1', name: '本店LINE' }] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: fixture }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: (role: string | null) => role === 'owner' || role === 'admin' }))
/* 座席図の読み込みが終わった描画の直後、useEffect の片付けより前に操作するための差し込み口。描画は本物のまま。 */
vi.mock('@/components/shared/restaurant-floor-map', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/restaurant-floor-map')>()
  function MapWithRenderProbe(props: ComponentProps<typeof actual.default>) {
    useLayoutEffect(() => {
      if (!nav.afterFloorLoaded || document.body.textContent?.includes('座席図を読み込み中です。')) return
      const run = nav.afterFloorLoaded
      nav.afterFloorLoaded = null
      run()
    })
    return <actual.default {...props} />
  }
  return { ...actual, default: MapWithRenderProbe }
})

import TablesPage from './tables'
import { snapshotOf, tables } from '../booking-kit/test-data'

const LEAVE = '保存していない変更があります'
const HREF = '/restaurant-test/reservations'
const floor = { id: 'floor-store-1', storeId: 'store-1', name: '1階', width: 700, height: 300, version: 1, outline: [], fixtures: [], tables: tables.map((table, index) => ({ id: table.id, x: 30 + index * 110, y: 60, width: 80, height: 64, rotation: 0, shape: 'rectangle' as const, minCapacity: table.min_capacity, maxCapacity: table.max_capacity })) }
type Reply = (value: unknown) => void
const snapshotReplies: Reply[] = []
const floorReplies: Reply[] = []

/* 左メニューの Link と同じく、離脱の見張りが止めなかった押下だけを移動として数える。 */
function renderTablesWithLeftMenu() {
  render(<><aside><a href={HREF}>予約台帳</a></aside><TablesPage /></>)
  const link = screen.getByRole('link', { name: '予約台帳' })
  link.addEventListener('click', event => { if (event.defaultPrevented) return; event.preventDefault(); nav.follow(link.getAttribute('href')) })
  return link
}
const leaveDialog = () => screen.queryByRole('dialog', { name: LEAVE })
const saveState = () => screen.getByText(/^(保存済み|未保存の変更があります)$/).textContent
async function answerFloors(from: number, order: 'requested' | 'reversed') {
  const indexes = order === 'requested' ? [from, from + 1] : [from + 1, from]
  for (const index of indexes) await act(async () => floorReplies[index]({ success: true, data: [floor] }))
}
/* 座席図の読み込みが終わった描画の中で左メニューを押し、その時の保存の表示を控える。 */
function clickWhenFloorLoaded(link: HTMLElement) {
  const seen: { state?: string | null } = {}
  nav.afterFloorLoaded = () => {
    seen.state = saveState()
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  }
  return seen
}

beforeEach(() => {
  snapshotReplies.length = 0
  floorReplies.length = 0
  nav.afterFloorLoaded = null
  window.history.replaceState(null, '', '/restaurant-test/tables')
  fixture.snapshot.mockReset().mockImplementation(() => new Promise(resolve => { snapshotReplies.push(resolve) }))
  floorApi.floors.mockReset().mockImplementation(() => new Promise(resolve => { floorReplies.push(resolve) }))
  fixture.updateTable.mockReset().mockResolvedValue({ success: true })
  assignmentApi.getTableAutomation.mockResolvedValue({ success: true, data: { enabled: true, version: 1 } })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('座席・卓管理の左メニューの移動と2系統の座席図の読み込み', () => {
  it.each([['頼んだ順', 'requested'], ['逆の順', 'reversed']] as const)('予約と座席図の取得が遅れ、2系統の座席図が%sに返っても、何も変えていなければ確認を出さずに移る', async (_label, order) => {
    const link = renderTablesWithLeftMenu()
    fireEvent.click(link)
    expect(nav.follow).toHaveBeenCalledTimes(1)

    // 予約データが届くと、座席画面と座席図がそれぞれ座席図を取りに行く。
    await act(async () => snapshotReplies[0]({ data: snapshotOf({ reservations: [] }) }))
    await waitFor(() => expect(floorReplies).toHaveLength(2))
    expect(screen.getByText('座席図を読み込み中です。')).toBeTruthy()
    fireEvent.click(link)
    expect(nav.follow).toHaveBeenCalledTimes(2)
    expect(leaveDialog()).toBeNull()

    const first = clickWhenFloorLoaded(link)
    await answerFloors(0, order)
    expect(first.state).toBe('保存済み')
    expect(leaveDialog()).toBeNull()
    expect(nav.follow).toHaveBeenCalledTimes(3)

    // 停止中の卓を再開すると予約データを読み直し、卓の一覧が変わるので2系統とも座席図を取り直す。
    const stopped = (await screen.findByText('個室B · 個室')).closest('li')!
    fireEvent.click(within(stopped).getByRole('button', { name: '個室B・個室のその他操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '再開' }))
    await waitFor(() => expect(snapshotReplies).toHaveLength(2))
    await act(async () => snapshotReplies[1]({ data: snapshotOf({ reservations: [], tables: tables.map(table => ({ ...table, is_active: 1 })) }) }))
    await waitFor(() => expect(floorReplies).toHaveLength(4))
    expect(screen.getByText('座席図を読み込み中です。')).toBeTruthy()
    fireEvent.click(link)
    expect(nav.follow).toHaveBeenCalledTimes(4)
    expect(leaveDialog()).toBeNull()

    const again = clickWhenFloorLoaded(link)
    await answerFloors(2, order)
    expect(again.state).toBe('保存済み')
    expect(leaveDialog()).toBeNull()
    expect(nav.follow).toHaveBeenCalledTimes(5)
    expect(nav.push).not.toHaveBeenCalled()
    expect(floorApi.saveFloor).not.toHaveBeenCalled()

    // 実際に配置を変えたときだけ、左メニューで確認を出して留まる。
    fireEvent.keyDown(screen.getByRole('button', { name: '4人卓' }), { key: 'ArrowRight' })
    expect(saveState()).toBe('未保存の変更があります')
    fireEvent.click(link)
    expect(within(screen.getByRole('dialog', { name: LEAVE })).getByText('このまま移ると、座席図の変更が消えます。')).toBeTruthy()
    expect(nav.follow).toHaveBeenCalledTimes(5)
  })
})
