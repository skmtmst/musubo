// @vitest-environment happy-dom
/*
 * 統括「店の比較」（G7）：店×7つの数・平均との差の札・並べ替え・行の引き出し（店の組は使えるまで描かない・H-16）。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { columnsWithDiff, diffCount, diffTone, formatDiff, formatMetric, METRICS } from './metrics'

const navigation = vi.hoisted(() => ({push:vi.fn(),select:vi.fn(),replace:vi.fn(),search:''}))
const accountState = vi.hoisted(() => ({ accounts: [] as Array<Record<string, unknown>>, refresh: vi.fn(), role: 'owner' as string | null }))
const fetchApi = vi.hoisted(() => vi.fn())
const notify = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (original) => ({ ...await original<typeof import('@/lib/api')>(), fetchApi }))
vi.mock('@/components/shared/toast', async (original) => ({ ...await original<typeof import('@/components/shared/toast')>(), notifyToast: notify }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => accountState.role, canManageRole: (role: string | null) => role === 'owner' || role === 'admin' }))
const api = vi.hoisted(() => ({ get: vi.fn(), detail: vi.fn(), export: vi.fn(), exportStatus: vi.fn(), download: vi.fn() }))
vi.mock('@/lib/api/helpers/gap3', () => ({ storeComparisonApi: api }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: navigation.push, replace: navigation.replace }), usePathname: () => '/hq/store-comparison', useSearchParams: () => new URLSearchParams(navigation.search) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a', setSelectedAccountId: navigation.select, loading: false, accounts: accountState.accounts, refreshAccounts: accountState.refresh }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))

const { default: StoreComparisonList } = await import('./list')

const metric = (value: number | null, diff: number | null, unit = '件') => ({ value, diff, unit, available: value !== null })
const row = (id: string, name: string, bookings: number, bookingsDiff: number, block: number, blockDiff: number) => ({
  accountId: id, name, style: null, computedAt: '2026-10-24T19:30:00.000Z', coveredDays: 30, periodDays: 30,
  metrics: {
    friendChange: metric(4, 0, '人'), blockRate: metric(block, blockDiff, '%'), clickRate: metric(null, null, '%'),
    bookings: metric(bookings, bookingsDiff), visits: metric(10, 1), noShowRate: metric(2, -0.5, '%'), responseMinutes: metric(8, 0, '分'),
  },
})
const DATA = {
  rows: [row('s1', '大宮店', 12, -25, 3.8, 1.4), row('s2', '渋谷店', 72, 35, 1.2, -1.2)],
  average: { friendChange: 10, blockRate: 2.5, clickRate: null, bookings: 40, visits: 30, noShowRate: 3, responseMinutes: 9 },
  total: 2, computedAt: '2026-10-24T19:30:00.000Z',
}
const NOTHING = Object.fromEntries(Object.entries(DATA.rows[0].metrics).map(([key, value]) => [key, { ...value, value: null, diff: null, available: false }]))

beforeEach(() => {
  api.get.mockResolvedValue({ success: true, data: DATA })
  api.detail.mockResolvedValue({ success: true, data: { recentBroadcasts: [{ id: 'b1', title: '秋の新メニュー', status: 'sent', sent_at: '2026-10-14T01:00:00Z' }], attention: null } })
})
afterEach(() => { cleanup(); forgetSessionSnapshot(); vi.clearAllMocks(); accountState.accounts = []; accountState.role = 'owner'; navigation.search = ''; window.history.replaceState(null, '', '/hq/store-comparison') })

describe('数の書き方', () => {
  it('単位と符号：人は ±、割合は pt、件・分はそのまま', () => {
    expect(formatMetric('friendChange', -3)).toBe('−3 人')
    expect(formatMetric('blockRate', 3.84)).toBe('3.8%')
    expect(formatDiff('blockRate', -2.1)).toBe('−2.1')
    expect(formatDiff('bookings', 3)).toBe('+3')
    expect(formatDiff('bookings', 0)).toBeNull()
    expect(formatDiff('responseMinutes', 0.4)).toBeNull()
    expect(formatDiff('blockRate', 0.04)).toBeNull()
    expect(formatDiff('responseMinutes', 0.6)).toBe('+1')
    expect(formatMetric('clickRate', null)).toBe('—')
  })
  it('良い悪いは数ごとに向きが逆：ブロック率は下がると良い、予約は上がると良い', () => {
    const def = (key: string) => METRICS.find((m) => m.key === key)!
    expect(diffTone(def('blockRate'), -1)).toBe('up')
    expect(diffTone(def('blockRate'), 1)).toBe('down')
    expect(diffTone(def('bookings'), 5)).toBe('up')
    expect(diffTone(def('bookings'), -5)).toBe('down')
    expect(diffTone(def('bookings'), 0)).toBeNull()
    expect(diffTone(def('responseMinutes'), 0.3)).toBeNull()
  })
})

describe('店の比較の表', () => {
  it('店と7つの数を出し、初めは予約の少ない順で頼む。取れない数は「—」', async () => {
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(screen.getByRole('table').closest('[class*="listSection"]')).not.toBeNull()
    expect(api.get).toHaveBeenCalledWith(expect.objectContaining({ sort: 'bookings', order: 'asc', compare: 'previous', pageSize: 20 }))
    for (const def of METRICS) expect(screen.getByRole('button', { name: `${def.label}で並べ替える` })).toBeTruthy()
    expect(screen.getByText('−25')).toBeTruthy()
    expect(screen.getAllByTitle('この数はまだ取れていません').length).toBe(2)
    const average = screen.getByText('2 店の平均')
    const fullSummary = average.parentElement?.querySelector('[data-truncated-text]')
    expect(fullSummary?.getAttribute('title')).toBe(fullSummary?.textContent)
    for (const def of METRICS) expect(fullSummary?.getAttribute('title')).toContain(def.label)
    expect(screen.getByText(/数の横の印は前の期間との差（赤＝悪い・緑＝良い）/)).toBeTruthy()
  })

  it('狭い幅で2段に分けられるよう、数と札は別の包みに入れる', async () => {
    render(<StoreComparisonList />)
    const chip = await screen.findByText('−25')
    const cell = chip.closest('span[title]')!
    const wraps = [...cell.children]
    expect(wraps).toHaveLength(2)
    expect(wraps[0].textContent).toBe('12 件')
    expect(wraps[1].textContent).toContain('−25')
  })

  it.each([
    ['friendChange', 'asc'], ['blockRate', 'desc'], ['clickRate', 'asc'],
    ['bookings', 'asc'], ['visits', 'asc'], ['noShowRate', 'desc'], ['responseMinutes', 'desc'],
  ] as const)('%sの初回は悪い順、次は反転し、表示する行と見出しとCSVも一致する', async (key, initial) => {
    const rows = DATA.rows.map((item, index) => ({ ...item, metrics: Object.fromEntries(Object.entries(item.metrics).map(([name, value]) => [name, { ...value, value: index + 1, available: true }])) }))
    api.get.mockImplementation(async (params: { sort: typeof key; order: 'asc' | 'desc' }) => ({ success: true, data: { ...DATA, rows: [...rows].sort((a, b) => (a.metrics[params.sort].value - b.metrics[params.sort].value) * (params.order === 'asc' ? 1 : -1)) } }))
    api.export.mockResolvedValue({ success: true, data: { id: 'sort-export', replayed: false } })
    api.exportStatus.mockResolvedValue({ success: true, data: { id: 'sort-export', status: 'completed', rowCount: 2, downloadUrl: null, errorCode: null } })
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    if (key === 'bookings') {
      fireEvent.click(screen.getByRole('button', { name: '友だちの増減で並べ替える' }))
      await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'friendChange' })))
    }
    const heading = screen.getByRole('button', { name: `${METRICS.find(item => item.key === key)!.label}で並べ替える` })
    for (const direction of [initial, initial === 'asc' ? 'desc' : 'asc']) {
      fireEvent.click(heading)
      await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(expect.objectContaining({ sort: key, order: direction, page: 1 })))
      await waitFor(() => expect([...document.querySelectorAll('[data-row-id]')].map(item => item.getAttribute('data-row-id'))).toEqual(direction === 'asc' ? ['s1', 's2'] : ['s2', 's1']))
      expect(heading.closest('th')?.getAttribute('aria-sort')).toBe(direction === 'asc' ? 'ascending' : 'descending')
    }
    fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
    await waitFor(() => expect(api.export).toHaveBeenCalledWith(expect.objectContaining({ sort: key, order: initial === 'asc' ? 'desc' : 'asc' }), expect.any(String)))
  })

  it('行を押すと右の引き出しに、最近の配信と［この店を開く］を出す', async () => {
    render(<StoreComparisonList />)
    fireEvent.click(await screen.findByText('大宮店'))
    expect(await screen.findByText('秋の新メニュー')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'この店を開く' }))
    expect(notify).toHaveBeenCalledWith('大宮店 に切り替えました', { tone: 'info' })
    expect(api.detail).toHaveBeenCalledWith('s1', expect.any(String), expect.any(String))
  })

  it('CSV は書き出しを頼み、できたら受け取る（今の並び・比べる相手のまま）', async () => {
    api.export.mockResolvedValue({ success: true, data: { id: 'x1', replayed: false } })
    api.exportStatus.mockResolvedValue({ success: true, data: { id: 'x1', status: 'completed', rowCount: 2, downloadUrl: null, errorCode: null } })
    api.download.mockResolvedValue(undefined)
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' })) })
    await waitFor(() => expect(api.download).toHaveBeenCalledWith('x1'))
    expect(api.export).toHaveBeenCalledWith(expect.objectContaining({ sort: 'bookings', order: 'asc', compare: 'previous' }), expect.any(String))
  })

  it('書き出しに失敗したら理由を知らせる', async () => {
    api.export.mockRejectedValue(new Error('down'))
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' })) })
    expect(await screen.findByText(/CSV を書き出せませんでした/)).toBeTruthy()
  })

  it('店の組は使えるまで描かない（H-16：出す＝使える）', async () => {
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(screen.queryByRole('button', { name: '店の組：すべて' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('失敗したら「もう一度」を出す', async () => {
    api.get.mockRejectedValueOnce(new Error('down'))
    render(<StoreComparisonList />)
    expect(await screen.findByRole('button', { name: /もう一度/ })).toBeTruthy()
  })
})

it('推移7種と対応0件を保ち押した店を切り替えて開く',async()=>{
 const values={friendChange:-3,blockRate:1,clickRate:null,bookings:0,visits:0,noShowRate:null,responseMinutes:2};
 api.detail.mockResolvedValue({success:true,data:{trend:[{date:'2026-10-15',values,state:'partial'}],recentBroadcasts:[],attention:{status:'ready',counts:{unhandledChats:5,pendingBookings:3,unpaid:0,connections:1,stoppedDeliveries:0},targets:{unhandledChats:[{href:'/chats?status=unread',count:5}],pendingBookings:[{href:'/booking/bookings?view=list&status=requested',count:1},{href:'/events/bookings?id=definition-a',count:1},{href:'/restaurant-test/reservations?view=list',count:1}]}}}});
 render(<StoreComparisonList/>);fireEvent.click(await screen.findByText('大宮店'));await screen.findByRole('group',{name:'友だちの増減の日ごとの推移'});
 for(const def of METRICS)expect(screen.getByRole('group',{name:`${def.label}の日ごとの推移`})).toBeTruthy();expect(screen.getByText('未払い 0件')).toBeTruthy();expect(screen.queryByRole('button',{name:'お支払いの記録を開く 0件'})).toBeNull();expect(screen.getByText('承認待ちの予約 3件')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'未対応のトークを開く 5件'}));expect(navigation.select).toHaveBeenCalledWith('s1');expect(navigation.push).toHaveBeenCalledWith('/chats?status=unread');
 fireEvent.click(screen.getByRole('button',{name:'イベントの申込を開く 1件'}));expect(navigation.push).toHaveBeenLastCalledWith('/events/bookings?id=definition-a');
 fireEvent.click(screen.getByRole('button',{name:'飲食店の予約台帳を開く 1件'}));expect(navigation.push).toHaveBeenLastCalledWith('/restaurant-test/reservations?view=list');
});
it('対応取得失敗時は0件ボタンを作らず配信は残す',async()=>{
 api.detail.mockResolvedValue({success:true,data:{trend:[],recentBroadcasts:[{id:'b',title:'実際の配信',status:'sent',sent_at:null}],attention:{status:'unavailable',counts:null}}});
 render(<StoreComparisonList/>);fireEvent.click(await screen.findByText('大宮店'));expect(await screen.findByText('対応が要るものを読み込めませんでした。')).toBeTruthy();expect(screen.queryByRole('button',{name:'未払い 0件'})).toBeNull();expect(screen.getByText('実際の配信')).toBeTruthy();
});

describe('数が取れない理由', () => {
  const uncomputed = (rows: typeof DATA.rows) => ({ ...DATA, rows, computedAt: null })

  it('全店の集計がまだなら、集計の時刻と「—」の理由を出す', async () => {
    api.get.mockResolvedValue({ success: true, data: uncomputed(DATA.rows.map((r) => ({ ...r, computedAt: null, metrics: NOTHING as typeof r.metrics }))) })
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(screen.getByText(/^まだ集計していません（毎朝 4 時半から、前の日の分まで集計します）/)).toBeTruthy()
    expect(screen.getAllByTitle('まだ集計していません（毎朝 4 時半から、前の日の分まで集計します）').length).toBe(METRICS.length * 2)
    expect(screen.queryByTitle('この数はまだ取れていません')).toBeNull()
  })

  it('一部の店だけまだ集計していないときは店の数を出し、集計済みの店では出さない', async () => {
    api.get.mockResolvedValueOnce({ success: true, data: uncomputed([{ ...DATA.rows[0], computedAt: null, metrics: NOTHING as typeof DATA.rows[0]['metrics'] }, DATA.rows[1]]) })
    const view = render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(screen.getByText(/まだ集計していない店が 1 店あります/)).toBeTruthy()
    view.unmount()
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(screen.queryByText(/集計していません|集計していない店/)).toBeNull()
  })

  it('期間の途中から集計した店は、件数の横に何日分かを出し、割合とそろった店には出さない', async () => {
    const partial = { ...DATA.rows[0], coveredDays: 12, metrics: { ...DATA.rows[0].metrics, bookings: metric(12, null), friendChange: metric(4, null, '人'), visits: metric(10, null) } }
    api.get.mockResolvedValue({ success: true, data: { ...DATA, rows: [partial, DATA.rows[1]] } })
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    const cells = (id: string) => [...document.querySelectorAll(`[data-row-id="${id}"] td`)].slice(1).map((cell) => cell.textContent)
    // 友だちの増減・予約・来店の 3 つだけ。「—」の店と、ブロック率などの割合には出さない。
    expect(cells('s1').filter((text) => text?.includes('12 日分'))).toHaveLength(3)
    expect(cells('s1')[1]).not.toContain('日分')
    expect(cells('s2').some((text) => text?.includes('日分'))).toBe(false)
    expect(screen.getAllByTitle('期間のうち12 日分の数です（日数が違うので差は出しません）')).toHaveLength(3)
    expect(screen.queryByText(/まだ集計していない店/)).toBeNull()
    fireEvent.click(screen.getByText('大宮店'))
    expect((await screen.findAllByText('12 日分')).length).toBeGreaterThan(3)
  })

  it('LINE の鍵が切れた店の行に知らせを出し、［更新する］で確かめ直して読み直す', async () => {
    accountState.accounts = [{ id: 's1', name: '大宮店', revision: 3, connection: { status: 'warn', checkedAt: null, tokenExpired: true, issues: [] } }, { id: 's2', name: '渋谷店', revision: 2, connection: { status: 'ok', checkedAt: null, tokenExpired: false } }]
    fetchApi.mockResolvedValue({ success: true })
    render(<StoreComparisonList />)
    await waitFor(() => expect(document.querySelector('[data-row-id="s1"]')).toBeTruthy())
    const notices = document.querySelectorAll('[data-store-connection]')
    expect([...notices].map((node) => node.getAttribute('data-store-connection'))).toEqual(['s1'])
    expect(notices[0].textContent).toContain('LINE の接続が切れています')
    expect(notices[0].querySelector('[data-notice-heading]')?.textContent).toBe('要確認：大宮店')
    const calls = api.get.mock.calls.length
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新する' })) })
    expect(fetchApi).toHaveBeenCalledWith('/api/line-accounts/s1/connection-checks', expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRevision: 3 }) }))
    expect(accountState.refresh).toHaveBeenCalled()
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(calls))
    expect(navigation.push).not.toHaveBeenCalled()
  })

  it('確かめ直しに失敗したら行の知らせで伝え、閲覧だけの人には［更新する］を出さない', async () => {
    accountState.accounts = [{ id: 's1', name: '大宮店', revision: 3, connection: { status: 'warn', checkedAt: null, tokenExpired: true } }]
    fetchApi.mockRejectedValue(new Error('down'))
    const view = render(<StoreComparisonList />)
    await waitFor(() => expect(document.querySelector('[data-row-id="s1"]')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新する' })) })
    expect(await screen.findByText(/確かめ直せませんでした/)).toBeTruthy()
    expect(document.querySelector('[data-store-connection="s1"] [data-notice-heading]')?.textContent).toBe('要確認：大宮店')
    view.unmount()
    accountState.role = 'staff'
    render(<StoreComparisonList />)
    await waitFor(() => expect(document.querySelector('[data-row-id="s1"]')).toBeTruthy())
    expect(document.querySelector('[data-store-connection]')?.textContent).toContain('LINE の接続が切れています')
    expect(screen.queryByRole('button', { name: '更新する' })).toBeNull()
  })

  it('複数店の接続警告は各店の直下に名前を出し、再確認中と失敗を押した店だけに示す', async () => {
    accountState.accounts = DATA.rows.map((r) => ({ id: r.accountId, name: r.name, revision: 3, connection: { tokenExpired: true } }))
    let rejectCheck!: (reason: Error) => void
    fetchApi.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCheck = reject }))
    render(<StoreComparisonList />)
    await waitFor(() => expect(document.querySelectorAll('[data-store-connection]')).toHaveLength(2))
    const notices = DATA.rows.map((r) => document.querySelector(`[data-store-connection="${r.accountId}"]`) as HTMLElement)
    for (const [i, notice] of notices.entries()) {
      expect(notice.previousElementSibling?.getAttribute('data-row-id')).toBe(DATA.rows[i].accountId)
      expect(notice.querySelector('[data-notice-heading]')?.textContent).toBe(`要確認：${DATA.rows[i].name}`)
      expect(notice.textContent).not.toContain(DATA.rows[1 - i].name)
    }
    const buttons = notices.map((notice) => within(notice).getByRole('button', { name: '更新する' }))
    fireEvent.click(buttons[1])
    await waitFor(() => expect(buttons[1].getAttribute('aria-busy')).toBe('true'))
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(buttons[0])
    fireEvent.click(buttons[1])
    expect(fetchApi).toHaveBeenCalledTimes(1)
    expect(fetchApi).toHaveBeenCalledWith('/api/line-accounts/s2/connection-checks', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ expectedRevision: 3 }),
      headers: { 'Idempotency-Key': expect.stringMatching(/^store-comparison-check-s2-/) },
    }))
    await act(async () => { rejectCheck(new Error('down')) })
    expect(notices[1].textContent).toContain('確かめ直せませんでした')
    expect(notices[0].textContent).not.toContain('確かめ直せませんでした')
    expect(notices[0].querySelector('[data-notice-heading]')?.textContent).toBe('要確認：大宮店')
    expect(notices[1].querySelector('[data-notice-heading]')?.textContent).toBe('要確認：渋谷店')
    expect(accountState.refresh).not.toHaveBeenCalled()
    expect(navigation.push).not.toHaveBeenCalled()
  })

  it.each([
    ['  保存名  ', '別の名前', '保存名'],
    ['', '  同じ店の名前  ', '同じ店の名前'],
    ['  ', '  ', '店名未取得'],
    ['', undefined, '店名未取得'],
  ])('接続警告に保存名を優先し、同じ店の既知名だけを補完する（%j / %j）', async (savedName, accountName, expectedName) => {
    api.get.mockResolvedValue({ success: true, data: { ...DATA, rows: [{ ...DATA.rows[0], name: savedName }, DATA.rows[1]] } })
    accountState.accounts = [{ id: 's1', name: accountName, revision: 3, connection: { tokenExpired: true } }, { id: 'other', name: '無関係な店', connection: { tokenExpired: true } }]
    render(<StoreComparisonList />)
    await waitFor(() => expect(document.querySelector('[data-store-connection="s1"] [data-notice-heading]')?.textContent).toBe(`要確認：${expectedName}`))
    expect(document.querySelectorAll('[data-store-connection]')).toHaveLength(1)
    expect(document.querySelector('[data-store-connection]')?.textContent).not.toContain('無関係な店')
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it.each(['viewer', 'read', 'missing-revision', 'invalid-revision'])('閲覧・版未取得でも対象の名前を残し、再確認入口を作らない（%s）', async (boundary) => {
    accountState.accounts = [{ id: 's1', name: '大宮店', revision: boundary === 'missing-revision' ? undefined : boundary === 'invalid-revision' ? 0 : 3, connection: { tokenExpired: true } }]
    if (boundary === 'viewer') accountState.role = 'viewer'
    if (boundary === 'read') rememberSessionSnapshot({ impersonation: { id: 'read-session', tenantId: 'tenant', mode: 'read', piiRevealed: false, startedAt: '2026-10-28T00:00:00Z' }, unfamiliarAt: null, stepUpMethod: 'none' })
    render(<StoreComparisonList />)
    await waitFor(() => expect(document.querySelector('[data-store-connection="s1"] [data-notice-heading]')?.textContent).toBe('要確認：大宮店'))
    expect(screen.queryByRole('button', { name: '更新する' })).toBeNull()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('集計前・部分集計でも数を補完せず、接続未取得なら警告を捏造しない', async () => {
    const rows = [{ ...DATA.rows[0], computedAt: null, metrics: NOTHING as typeof DATA.rows[0]['metrics'] }, { ...DATA.rows[1], coveredDays: 12 }]
    api.get.mockResolvedValue({ success: true, data: uncomputed(rows) })
    accountState.accounts = [{ id: 's1', name: '大宮店', connection: { tokenExpired: true } }]
    const view = render(<StoreComparisonList />)
    await waitFor(() => expect(document.querySelector('[data-store-connection="s1"] [data-notice-heading]')?.textContent).toBe('要確認：大宮店'))
    const first = document.querySelector('[data-row-id="s1"]') as HTMLElement
    expect(within(first).getAllByText('—')).toHaveLength(METRICS.length)
    expect(first.textContent).not.toContain('0')
    expect(document.querySelector('[data-row-id="s2"]')?.textContent).toContain('12 日分')
    view.unmount()
    accountState.accounts = []
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(document.querySelector('[data-store-connection]')).toBeNull()
  })

  it('再確認成功後の再取得で保存名と接続状態の更新に追随する', async () => {
    accountState.accounts = [{ id: 's1', name: '大宮店', revision: 3, connection: { tokenExpired: true } }]
    fetchApi.mockResolvedValueOnce({ success: true })
    const view = render(<StoreComparisonList />)
    await waitFor(() => expect(document.querySelector('[data-store-connection="s1"] [data-notice-heading]')?.textContent).toBe('要確認：大宮店'))
    api.get.mockResolvedValue({ success: true, data: { ...DATA, rows: [{ ...DATA.rows[0], name: '更新後の保存名' }, DATA.rows[1]] } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '更新する' })) })
    await waitFor(() => expect(document.querySelector('[data-store-connection="s1"] [data-notice-heading]')?.textContent).toBe('要確認：更新後の保存名'))
    expect(accountState.refresh).toHaveBeenCalledTimes(1)
    accountState.accounts = [{ id: 's1', name: '更新後の保存名', revision: 4, connection: { tokenExpired: false } }]
    view.rerender(<StoreComparisonList />)
    expect(document.querySelector('[data-store-connection]')).toBeNull()
    expect(document.querySelector('[data-row-id="s1"]')?.textContent).toContain('更新後の保存名')
    expect(fetchApi).toHaveBeenCalledTimes(1)
  })

})

describe('違いだけ表示と「7 項目中 5 つが違う」（全店の平均と比べる）', () => {
  /* 平均：友だちの増減・返事の速さは全店で平均と同じ（返事の速さは 0.3 分の差で札では 0）。クリック率は全店で取れない。 */
  const AVERAGE = { friendChange: 4, blockRate: 2.5, clickRate: null, bookings: 40, visits: 30, noShowRate: 2, responseMinutes: 8.3 }
  const store = (id: string, name: string, values: { blockRate: number; bookings: number; visits: number; noShowRate: number }, compare: 'previous' | 'average' = 'average') => {
    const make = (key: keyof typeof AVERAGE, value: number | null, unit: string) => ({ value, unit, available: value !== null, diff: value === null || AVERAGE[key] === null ? null : compare === 'average' ? value - (AVERAGE[key] as number) : 1 })
    return {
      accountId: id, name, style: null, computedAt: '2026-10-24T19:30:00.000Z', coveredDays: 30, periodDays: 30,
      metrics: {
        friendChange: make('friendChange', 4, '人'), blockRate: make('blockRate', values.blockRate, '%'), clickRate: make('clickRate', null, '%'),
        bookings: make('bookings', values.bookings, '件'), visits: make('visits', values.visits, '件'), noShowRate: make('noShowRate', values.noShowRate, '%'), responseMinutes: make('responseMinutes', 8, '分'),
      },
    }
  }
  /* 大宮：ブロック率・予約・来店が違う（無断率は +0.04 で札では 0）。渋谷：予約・無断率が違う。 */
  const ROWS = [store('s1', '大宮店', { blockRate: 3.8, bookings: 12, visits: 20, noShowRate: 2.04 }), store('s2', '渋谷店', { blockRate: 2.5, bookings: 72, visits: 30, noShowRate: 1.2 })]
  const DIFF_DATA = { rows: ROWS, average: AVERAGE, total: 2, computedAt: '2026-10-24T19:30:00.000Z' }
  const headers = () => screen.getAllByRole('button', { name: /で並べ替える$/ }).map((node) => node.getAttribute('aria-label') ?? node.textContent)

  it('取れない数は分母から外し、札に出ない差（+0.0）は数えない。札の数と N は同じ関数で一致する', () => {
    expect(diffCount(ROWS[0] as never, AVERAGE)).toEqual({ differ: 3, compared: 6 })
    expect(diffCount(ROWS[1] as never, AVERAGE)).toEqual({ differ: 2, compared: 6 })
    for (const row of ROWS) {
      const chips = METRICS.filter((def) => formatDiff(def.key, row.metrics[def.key].diff) !== null).length
      expect(chips).toBe(diffCount(row as never, AVERAGE).differ)
    }
    /* 平均が出ない数（店が 3 未満など）も比べられないので分母から外す。値が null の数は「違い」に数えない。 */
    expect(diffCount(ROWS[0] as never, { ...AVERAGE, bookings: null })).toEqual({ differ: 2, compared: 5 })
    const missing = { ...ROWS[0], metrics: { ...ROWS[0].metrics, blockRate: { value: null, diff: null, unit: '%', available: true } } }
    expect(diffCount(missing as never, AVERAGE)).toEqual({ differ: 2, compared: 5 })
    expect(columnsWithDiff(ROWS as never, AVERAGE).map((def) => def.key)).toEqual(['blockRate', 'clickRate', 'bookings', 'visits', 'noShowRate'])
  })

  it('期間の途中から集計した店の件数（友だちの増減・予約・来店）は、日数が違うので平均と比べず分母から外す', async () => {
    /* 12 日分の大宮：予約・来店は平均と違って見えるが比べない。割合（ブロック率・無断率）は比べる。 */
    const partial = { ...ROWS[0], coveredDays: 12, metrics: { ...ROWS[0].metrics, friendChange: { ...ROWS[0].metrics.friendChange, diff: null }, bookings: { ...ROWS[0].metrics.bookings, diff: null }, visits: { ...ROWS[0].metrics.visits, diff: null } } }
    expect(diffCount(partial as never, AVERAGE)).toEqual({ differ: 1, compared: 3 })
    api.get.mockResolvedValue({ success: true, data: { ...DIFF_DATA, rows: [partial, ROWS[1]] } })
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(document.querySelector('[data-diff-count="s1"]')?.textContent).toBe('1/3項目が違う')
    expect(screen.getAllByText('12 日分')).toHaveLength(3)
  })

  it('表の店の名前の下に「N/6項目が違う」を出す。集計前の店には出さない', async () => {
    api.get.mockResolvedValue({ success: true, data: { ...DIFF_DATA, rows: [...ROWS, { ...store('s3', '川口店', { blockRate: 1, bookings: 1, visits: 1, noShowRate: 1 }), computedAt: null }], total: 3 } })
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    const lines = [...document.querySelectorAll('[data-diff-count]')]
    expect(lines.map((node) => [node.getAttribute('data-diff-count'), node.textContent])).toEqual([['s1', '3/6項目が違う'], ['s2', '2/6項目が違う']])
    expect(lines[0].getAttribute('title')).toBe('全店の平均と比べて、6 項目中 3 つが違う')
  })

  it('切り替えを入れると全店で平均と同じ列だけが消え、URL に残る。取れない列は残す', async () => {
    api.get.mockResolvedValue({ success: true, data: DIFF_DATA })
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(headers()).toHaveLength(7)
    fireEvent.click(screen.getByRole('switch', { name: '違いだけ表示' }))
    expect(navigation.replace).toHaveBeenLastCalledWith('/hq/store-comparison?diffOnly=1', { scroll: false })
    expect(screen.queryByRole('button', { name: '友だちの増減で並べ替える' })).toBeNull()
    expect(screen.queryByRole('button', { name: '返事の速さで並べ替える' })).toBeNull()
    for (const label of ['ブロック率', '配信のクリック率', '予約', '来店', '無断率']) expect(screen.getByRole('button', { name: `${label}で並べ替える` })).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: '違いだけ表示' }))
    expect(navigation.replace).toHaveBeenLastCalledWith('/hq/store-comparison', { scroll: false })
    expect(headers()).toHaveLength(7)
  })

  it('URL に ?diffOnly=1 があれば、読み直しても違いだけの表示で開く', async () => {
    navigation.search = 'diffOnly=1'
    api.get.mockResolvedValue({ success: true, data: DIFF_DATA })
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(screen.getByRole('switch', { name: '違いだけ表示' }).getAttribute('aria-checked')).toBe('true')
    expect(headers()).toHaveLength(5)
  })

  it('比べる相手を変えると届いた新しい数で数え、違いは全店の平均と比べる', async () => {
    api.get.mockResolvedValue({ success: true, data: DIFF_DATA })
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    expect(document.querySelector('[data-diff-count="s2"]')?.textContent).toBe('2/6項目が違う')
    const next = { ...DIFF_DATA, rows: [ROWS[0], store('s2', '渋谷店', { blockRate: 1.0, bookings: 72, visits: 31, noShowRate: 1.2 }, 'previous')] }
    api.get.mockResolvedValue({ success: true, data: next })
    fireEvent.click(screen.getByRole('button', { name: '比べる相手' }))
    await act(async () => { fireEvent.click(within(await screen.findByRole('option', { name: /全店の平均/ })).getByRole('button')) })
    await waitFor(() => expect(api.get).toHaveBeenLastCalledWith(expect.objectContaining({ compare: 'average' })))
    await waitFor(() => expect(document.querySelector('[data-diff-count="s2"]')?.textContent).toBe('4/6項目が違う'))
  })

  it('引き出しでは平均と同じ数の行を隠し、隠した数と［すべて表示］を出す', async () => {
    navigation.search = 'diffOnly=1'
    window.history.replaceState(null, '', '/hq/store-comparison?diffOnly=1')
    api.get.mockResolvedValue({ success: true, data: DIFF_DATA })
    render(<StoreComparisonList />)
    fireEvent.click(await screen.findByText('渋谷店'))
    const drawer = await screen.findByRole('dialog')
    expect(drawer.textContent).toContain('全店の平均と比べて 6 項目中 2 つが違う')
    const note = drawer.querySelector('[data-diff-hidden]')
    expect(note?.textContent).toContain('全店の平均と同じ 4 項目（友だちの増減・ブロック率・来店・返事の速さ）を隠しています。')
    /* 行の名前（完全一致）で見る。隠した行は無く、取れない数（クリック率）は「同じ」に数えず残す。 */
    for (const label of ['友だちの増減', 'ブロック率', '来店', '返事の速さ']) expect(within(drawer).queryByText(label)).toBeNull()
    for (const label of ['配信のクリック率', '予約', '無断率']) expect(within(drawer).getByText(label)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'すべて表示' }))
    expect(navigation.replace).toHaveBeenLastCalledWith('/hq/store-comparison', { scroll: false })
    expect(drawer.querySelector('[data-diff-hidden]')).toBeNull()
    for (const def of METRICS) expect(within(drawer).getByText(def.label)).toBeTruthy()
  })

  it('全部の列が平均と同じなら空の状態を出し、［すべて表示］で戻す', async () => {
    navigation.search = 'diffOnly=1'
    const flat = store('s1', '大宮店', { blockRate: 2.5, bookings: 40, visits: 30, noShowRate: 2 })
    const same = { ...flat, metrics: { ...flat.metrics, clickRate: { value: 5, diff: 0, unit: '%', available: true } } }
    api.get.mockResolvedValue({ success: true, data: { ...DIFF_DATA, rows: [same], average: { ...AVERAGE, clickRate: 5 }, total: 1 } })
    render(<StoreComparisonList />)
    expect(await screen.findByText('全店の平均と違う数はありません')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'すべて表示' })) })
    expect(await screen.findByText('大宮店')).toBeTruthy()
    expect(headers()).toHaveLength(7)
  })

  it('CSV は「違いだけ表示」に関係なく全部の列を頼む（表示の切り替えを口へ送らない）', async () => {
    navigation.search = 'diffOnly=1'
    api.get.mockResolvedValue({ success: true, data: DIFF_DATA })
    api.export.mockResolvedValue({ success: true, data: { id: 'x1', replayed: false } })
    api.exportStatus.mockResolvedValue({ success: true, data: { id: 'x1', status: 'completed', rowCount: 2, downloadUrl: null, errorCode: null } })
    render(<StoreComparisonList />)
    await screen.findByText('大宮店')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' })) })
    await waitFor(() => expect(api.download).toHaveBeenCalledWith('x1'))
    expect(Object.keys(api.export.mock.calls[0][0]).sort()).toEqual(['compare', 'from', 'order', 'sort', 'to'])
  })
})
