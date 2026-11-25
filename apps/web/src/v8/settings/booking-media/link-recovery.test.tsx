// @vitest-environment happy-dom
import React, { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred } from '@/test-utils/race'
const net = vi.hoisted(() => ({ account: 'a' as string | null, role: 'owner' as string | null, contextId: null as string | null, list: vi.fn(), context: vi.fn(), select: vi.fn(), media: vi.fn(), link: vi.fn(), channels: vi.fn(), notice: vi.fn(), save: vi.fn(), add: vi.fn(), push: vi.fn(), copy: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: net.push, replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: net.account }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => net.role, canManageRole: (role: string | null) => role === 'owner' || role === 'admin' }))
vi.mock('@/lib/api', async load => ({ ...await load<typeof import('@/lib/api')>(), fetchApi: net.channels }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: {
  listStores: net.list, storeContext: net.context, selectStore: net.select, mediaLinks: net.media,
  reservationLink: net.link, closeNotificationSettings: net.notice, saveMediaLink: net.save, addGourmetMedia: net.add,
  snapshot: async () => ({ data: { memberships: [] } }),
} }))
import BookingMedia from './screen'
import { ApiError } from '@/lib/api'
const setupMessage = 'お客さま向けの予約ページの設定がまだ無いため、URL を出せません。'
const genericMessage = '予約ページの URL を読み込めませんでした。'
const setupLink = 'LINEアカウントの設定を見る'
const success = { url: 'https://fixture.invalid/reserve', html: '<a href="https://fixture.invalid/reserve">予約</a>', available: true }
const store = (id: string, account = 'a') => ({ id, name: id, line_account_id: account, status: 'active' })
const area = () => within(screen.getByRole('region', { name: 'LINE 予約を他のサイトに貼る', exact: true }))
const copies = () => [area().getByRole('button', { name: '予約ページのURLをコピー' }), area().getByRole('button', { name: 'コードをコピー' })] as HTMLButtonElement[]
function noWrites() { expect(net.save).not.toHaveBeenCalled(); expect(net.add).not.toHaveBeenCalled() }
beforeEach(() => {
  vi.resetAllMocks(); net.account = 'a'; net.role = 'owner'; net.contextId = null
  net.list.mockImplementation(async (account: string) => ({ data: { stores: [store('current', account), store('foreign', 'foreign-account')] } }))
  net.context.mockImplementation(async () => ({ data: { selectedStore: net.contextId ? { id: net.contextId } : null } }))
  net.media.mockResolvedValue({ data: [{ code: 'fixture', name: '人工媒体', acceptsReservations: true, pageUrl: null, loginUrl: null, closeOnBooking: false, version: 3 }] })
  net.channels.mockResolvedValue({ data: [] })
  net.notice.mockResolvedValue({ data: { notifyReopen: false, recipientMode: 'responsible', membershipIds: [], version: 1 } })
  net.link.mockResolvedValue({ data: success })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: net.copy.mockResolvedValue(undefined) } })
  window.history.replaceState(null, '', '/settings/booking-media')
})
afterEach(cleanup)

it('媒体の取得に失敗しても読み直すと対象店舗の媒体一覧を表示する', async () => {
  net.channels.mockRejectedValueOnce(new Error('人工取得失敗'))
  render(<BookingMedia />)
  const error = await screen.findByText('媒体を読み込めませんでした')
  fireEvent.click(within(error.closest('[data-list-state="error"]') as HTMLElement).getByRole('button', { name: /もう一度/ }))
  expect(await screen.findByText('人工媒体')).toBeTruthy()
  expect(net.media).toHaveBeenLastCalledWith('a', 'current')
  expect(net.channels).toHaveBeenCalledTimes(2)
  noWrites()
})

it('503の理由は一つの帯だけで示し、同じLINEの設定へ案内しコピーしない', async () => {
  net.account = 'a /?&店'; net.link.mockRejectedValue(new ApiError(503, 'fixture'))
  render(<BookingMedia />)
  await waitFor(() => expect(area().getAllByText(setupMessage)).toHaveLength(1))
  expect(area().getAllByRole('alert')).toHaveLength(1)
  expect(area().getByRole('link', { name: setupLink }).getAttribute('href')).toBe('/accounts/detail?id=a%20%2F%3F%26%E5%BA%97')
  for (const button of copies()) { expect(button.disabled).toBe(true); fireEvent.click(button) }
  expect(net.copy).not.toHaveBeenCalled()
  expect(net.link).toHaveBeenCalledExactlyOnceWith('a /?&店', 'current'); noWrites()
})

it.each([['500', new ApiError(500, 'fixture')], ['通信失敗', new TypeError('connection lost')]])('%sは理由の帯一本だけで設定へ誘導せずコピーしない', async (_name, error) => {
  net.link.mockRejectedValue(error); render(<BookingMedia />)
  await waitFor(() => expect(area().getAllByText(genericMessage)).toHaveLength(1))
  expect(area().getAllByRole('alert')).toHaveLength(1)
  expect(area().queryByRole('link', { name: setupLink })).toBeNull()
  expect(copies().every(button => button.disabled)).toBe(true)
  expect(net.link).toHaveBeenCalledExactlyOnceWith('a', 'current'); noWrites()
})

it('読込中は既存の待ちとコピー無効、成功後は元のURLとコードを各一度だけコピーする', async () => {
  const pending = deferred<{ data: typeof success }>(); net.link.mockReturnValue(pending.promise)
  render(<BookingMedia />); await screen.findByText('人工媒体')
  expect(area().getAllByText('読み込んでいます…')).toHaveLength(2)
  expect(area().queryByRole('alert')).toBeNull(); expect(copies().every(button => button.disabled)).toBe(true)
  await act(async () => pending.resolve({ data: success }))
  expect(area().getByText(success.url)).toBeTruthy(); expect(area().getByText(success.html)).toBeTruthy()
  expect(copies().every(button => !button.disabled)).toBe(true)
  for (const button of copies()) fireEvent.click(button)
  await waitFor(() => expect(net.copy.mock.calls).toEqual([[success.url], [success.html]]))
  expect(net.link).toHaveBeenCalledTimes(1); noWrites()
})

it('available:falseの応答は従来のコピー値と可否を変えず設定不足の失敗と混ぜない', async () => {
  net.link.mockResolvedValue({ data: { ...success, available: false } }); render(<BookingMedia />)
  await areaReady()
  expect(area().queryByRole('alert')).toBeNull(); expect(area().queryByRole('link', { name: setupLink })).toBeNull()
  expect(copies().every(button => !button.disabled)).toBe(true)
  for (const button of copies()) fireEvent.click(button)
  await waitFor(() => expect(net.copy.mock.calls).toEqual([[success.url], [success.html]])); noWrites()
})
async function areaReady() { await screen.findByText(success.url) }

it.each(['staff', 'viewer', null])('権限%sでは予約URLを要求せず設定リンクとコピーを出さない', async role => {
  net.role = role; render(<BookingMedia />); await screen.findByText('人工媒体')
  expect(net.link).not.toHaveBeenCalled(); expect(area().queryByRole('link', { name: setupLink })).toBeNull()
  expect(area().queryByRole('button', { name: 'コードをコピー' })).toBeNull()
  expect(area().getByText('予約ページの URL は、管理者が確かめられます。')).toBeTruthy(); noWrites()
})

it('503後に同じ範囲の取得が成功すると理由と設定リンクをともに消す', async () => {
  net.link.mockRejectedValueOnce(new ApiError(503)); const view = render(<BookingMedia />)
  await screen.findByRole('link', { name: setupLink })
  net.role = 'admin'; view.rerender(<BookingMedia />); await areaReady()
  expect(area().queryByText(setupMessage)).toBeNull(); expect(area().queryByRole('link', { name: setupLink })).toBeNull()
  expect(net.link).toHaveBeenCalledTimes(2); noWrites()
})

it('503後の別の取得が500なら設定リンクを残さず一般の失敗に戻す', async () => {
  net.link.mockRejectedValueOnce(new ApiError(503)).mockRejectedValueOnce(new ApiError(500))
  const view = render(<BookingMedia />); await screen.findByRole('link', { name: setupLink })
  net.role = 'admin'; view.rerender(<BookingMedia />)
  await waitFor(() => expect(area().getAllByText(genericMessage)).toHaveLength(1))
  expect(area().queryByRole('link', { name: setupLink })).toBeNull(); noWrites()
})

it.each(['b', null])('アカウントを%sへ切り替えた全描画で旧503と設定リンクを出さない', async account => {
  net.link.mockRejectedValueOnce(new ApiError(503))
  const commits: string[] = []; const ui = () => <Profiler id="media" onRender={() => { commits.push(document.body.textContent ?? '') }}><BookingMedia /></Profiler>
  const view = render(ui()); await screen.findByRole('link', { name: setupLink })
  const pending = deferred<{ data: typeof success }>(); net.link.mockReturnValue(pending.promise)
  commits.length = 0; net.account = account; view.rerender(ui())
  if (account) await waitFor(() => expect(net.link).toHaveBeenCalledTimes(2))
  expect(commits.length).toBeGreaterThan(0)
  for (const text of commits) { expect(text).not.toContain(setupMessage); expect(text).not.toContain(setupLink) }
  expect(screen.queryByRole('link', { name: setupLink })).toBeNull()
  if (account) { await act(async () => pending.resolve({ data: success })); await areaReady() }
  else expect(net.link).toHaveBeenCalledTimes(1)
  noWrites()
})

it('店舗の切替中と切替後の全描画に旧503を残さず、新店舗だけを読む', async () => {
  net.contextId = 'current'; net.list.mockResolvedValue({ data: { stores: [store('current'), store('second')] } })
  net.select.mockImplementation(async (_account, id) => { net.contextId = id; return { data: { selectedStore: { id } } } })
  net.link.mockRejectedValueOnce(new ApiError(503))
  const commits: string[] = []; render(<Profiler id="media" onRender={() => { commits.push(document.body.textContent ?? '') }}><BookingMedia /></Profiler>)
  await screen.findByRole('link', { name: setupLink })
  fireEvent.click(screen.getByRole('button', { name: '店舗', exact: true }))
  const picker = within(await screen.findByRole('dialog'))
  fireEvent.click(picker.getByRole('radio', { name: 'second', exact: true }))
  commits.length = 0; fireEvent.click(picker.getByRole('button', { name: '選択する', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'この店舗に切り替えて表示する' }))
  await areaReady()
  expect(commits.length).toBeGreaterThan(0)
  for (const text of commits) { expect(text).not.toContain(setupMessage); expect(text).not.toContain(setupLink) }
  expect(net.link.mock.calls).toEqual([['a', 'current'], ['a', 'second']]); expect(net.select).toHaveBeenCalledExactlyOnceWith('a', 'second'); noWrites()
})

it('遅い旧503が切替後に届いても新アカウントの成功を書き換えない', async () => {
  const pending = deferred<{ data: typeof success }>(); net.link.mockReturnValueOnce(pending.promise)
  const view = render(<BookingMedia />); await waitFor(() => expect(net.link).toHaveBeenCalledTimes(1))
  net.account = 'b'; view.rerender(<BookingMedia />); await areaReady()
  await act(async () => pending.reject(new ApiError(503)))
  expect(area().queryByText(setupMessage)).toBeNull(); expect(area().queryByRole('link', { name: setupLink })).toBeNull()
  expect(net.link.mock.calls).toEqual([['a', 'current'], ['b', 'current']]); noWrites()
})

it('設定リンクへの移動は既存の未保存確認を通り、続行は入力を保ち破棄した時だけ移る', async () => {
  net.link.mockRejectedValue(new ApiError(503)); render(<BookingMedia />)
  const link = await screen.findByRole('link', { name: setupLink })
  const label = 'LINE・電話で予約が入ったら、他のサイトの枠を閉じる知らせを出す'
  fireEvent.click(screen.getByRole('switch', { name: label }))
  fireEvent.click(link)
  const dialog = within(await screen.findByRole('dialog', { name: '保存していない変更があります' }))
  expect(net.push).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: '編集を続ける' }))
  expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(link)
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '保存せずに移る' }))
  expect(net.push).toHaveBeenCalledExactlyOnceWith('/accounts/detail?id=a'); noWrites()
})
