// @vitest-environment happy-dom
/*
 * B27: サロン・面談・教室の担当・講師の欄は、名前が1字で切れない幅にする。
 * 「担当：見本 30」は実測で欄の文字部 95px・枠の余白 48px＝143px 要る。
 * 広げすぎると B28 の日付の段（1152 で 852px）に載らなくなるので上限も守る。
 */
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))

const noop = () => {}
const scope = vi.hoisted(() => ({ store: null as null | { id: string; name: string } }))

vi.mock('./use-style-dashboard', () => ({
  useStyleDashboard: () => ({
    cfg: {
      title: 'サロン', tabs: { main: '台帳', bookings: '予約', people: 'お客さま', analytics: '分析' },
      staffNoun: '担当', search: '名前・電話で探す', primary: '予約を入れる',
      views: [{ value: 'board', label: '盤' }], defaultView: 'board',
      links: { bookings: '/booking/bookings', people: '/friends' },
    },
    router: { push: () => {} },
    tab: 'main', subTab: null, view: 'board', range: 'today', days: '30',
    accountId: 'account-a', role: 'owner', canWrite: true,
    date: '2026-10-30', setDate: noop, staff: 'all', setStaff: noop,
    compare: 'last_week', setCompare: noop, search: '', setSearch: noop,
    failed: false, analytics: null, analyticsFailed: false, layout: null,
    applyPresentation: () => true, metricSelectionFallback: false, reloadPresentation: noop,
    defaultMetrics: [], viewOpen: false, setViewOpen: noop,
    closureOpen: true, setClosureOpen: noop, phoneOpen: false, setPhoneOpen: noop,
    walkInOpen: false, setWalkInOpen: noop, busy: '', setBusy: noop,
    rosterId: null, setRosterId: noop, asideOpen: false, setAsideOpen: noop,
    floor: null, loadedAt: '2026-10-30T01:02:00+09:00', store: { store: scope.store }, tables: [],
    setParam: noop, load: noop, loadAnalytics: noop, setCardDefaults: noop,
    roster: null, rosterRow: null, today: null,
    preparing: { dialog: null, open: noop }, openPayment: noop, reload: noop,
    subtitle: '', openRow: noop, markVisit: noop, markNoShow: noop, approve: noop,
    undoVisit: noop, cancelRow: null, setCancelRow: noop, refundRow: null, setRefundRow: noop,
    resultRow: null, setResultRow: noop, classRow: null, setClassRow: noop,
    menuFor: () => [], confirmCancel: noop, saveResult: noop, testMode: false,
    alertAction: noop, attend: noop, KIND: {}, saveClosure: noop, addNew: noop,
  }),
}))

import StyleDashboard from './style-dashboard'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })


it.each(['salon', 'consult', 'lesson'] as const)('%s の休業窓に存在しない店舗を出さない', (style) => {
  scope.store = null
  render(<StyleDashboard style={style} />)
  const dialog = screen.getByRole('dialog', { name: '休みを入れる' })
  expect(within(dialog).queryByText('店舗', { selector: 'dt' })).toBeNull()
})

it('飲食店で店舗が分かる時は対象に店舗名を出す', () => {
  scope.store = { id: 'store-1', name: '本店' }
  render(<StyleDashboard style="restaurant" />)
  const dialog = screen.getByRole('dialog', { name: '休みを入れる' })
  expect(within(dialog).getByText('店舗', { selector: 'dt' })).toBeTruthy()
  expect(within(dialog).getByText('本店')).toBeTruthy()
})
