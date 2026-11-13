// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred } from '@/test-utils/race'
const net = vi.hoisted(() => ({ account: 'a', contextId: null as string | null, list: vi.fn(), context: vi.fn(), select: vi.fn(), media: vi.fn(), save: vi.fn(), link: vi.fn(), channels: vi.fn(), notice: vi.fn(), saveNotice: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: net.account }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {}, useHideSettingsNav: () => {} }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/lib/api', async load => ({ ...await load<typeof import('@/lib/api')>(), fetchApi: net.channels }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: {
  listStores: net.list, storeContext: net.context, selectStore: net.select,
  mediaLinks: net.media, saveMediaLink: net.save, reservationLink: net.link,
  closeNotificationSettings: net.notice, saveCloseNotificationSettings: net.saveNotice,
  snapshot: async () => ({ data: { memberships: [] } }),
} }))
import BookingMedia from './screen'
import { ApiError } from '@/lib/api'
const row = { code: 'fixture', name: '人工媒体', acceptsReservations: true, pageUrl: 'https://fixture.invalid/page', loginUrl: null, closeOnBooking: false, version: 3 }
beforeEach(() => {
  vi.resetAllMocks(); net.account = 'a'; net.contextId = null
  net.list.mockResolvedValue({ data: { stores: [
    { id: 'other', name: '別の店', line_account_id: 'b', status: 'active' },
    { id: 'old', name: '現在の店', line_account_id: 'a', status: 'archived' },
    { id: 'current', name: '現在の店', line_account_id: 'a', status: 'active' },
  ] } })
  net.context.mockImplementation(async () => ({ data: { selectedStore: net.contextId ? { id: net.contextId, name: '店' } : null } }))
  net.select.mockImplementation(async (_account, id) => { net.contextId = id; return { data: { selectedStore: { id, name: '店' } } } })
  net.media.mockResolvedValue({ data: [{ ...row }] })
  net.channels.mockResolvedValue({ data: [] })
  net.link.mockResolvedValue({ data: { url: 'https://fixture.invalid/reserve', html: '', available: true } })
  net.save.mockResolvedValue({ data: { version: 4 } })
  net.notice.mockResolvedValue({ data: { notifyReopen: false, recipientMode: 'responsible', membershipIds: [], version: 1 } })
  net.saveNotice.mockResolvedValue({ data: { version: 2 } })
})
afterEach(cleanup)

it('媒体の URL は全文を確認でき、外部リンクの矢印と同じ行に収める', async () => {
  render(<BookingMedia />)
  const link = await screen.findByRole('link', { name: 'fixture.invalid/page' })
  expect(link.getAttribute('href')).toBe('https://fixture.invalid/page')
  expect(link.getAttribute('title')).toBe('https://fixture.invalid/page')
  expect(link.getAttribute('data-truncate')).toBe('true')
  expect(link.querySelector('[data-external-icon]')).toBeTruthy()
})

it('店舗の取得が終わるまで媒体も予約URLも読まず、現在のアカウントの店だけを使う', async () => {
  const pending = deferred<Awaited<ReturnType<typeof net.context>>>()
  net.context.mockReturnValueOnce(pending.promise)
  render(<BookingMedia />)
  await waitFor(() => expect(net.context).toHaveBeenCalledTimes(1))
  expect(net.media).not.toHaveBeenCalled(); expect(net.link).not.toHaveBeenCalled(); expect(net.channels).not.toHaveBeenCalled()
  pending.resolve({ data: { selectedStore: null } })
  await screen.findByText('人工媒体')
  expect(net.media).toHaveBeenCalledExactlyOnceWith('a', 'current')
  expect(net.link).toHaveBeenCalledExactlyOnceWith('a', 'current')
  expect(net.select).not.toHaveBeenCalled()
})

it('選択店の取得が失敗しても先頭の別店へ逃げず、同じ場所で再試行できる', async () => {
  net.context.mockRejectedValueOnce(new Error('取得失敗'))
  render(<BookingMedia />)
  const message = await screen.findByText('店舗を読み込めませんでした')
  expect(net.media).not.toHaveBeenCalled(); expect(net.link).not.toHaveBeenCalled()
  fireEvent.click(message.closest('[data-list-state="error"]')!.querySelector('button')!)
  await screen.findByText('人工媒体')
  expect(net.media).toHaveBeenCalledExactlyOnceWith('a', 'current')
})

it('ログイン中が別店なら全体の店舗も変わると示し、明示の切替後だけ媒体を読む', async () => {
  net.contextId = 'other'
  render(<BookingMedia />)
  const button = await screen.findByRole('button', { name: 'この店舗に切り替えて表示する' })
  expect(screen.getByText(/管理画面全体の表示店舗も切り替わります/)).toBeTruthy()
  expect(net.media).not.toHaveBeenCalled(); expect(net.link).not.toHaveBeenCalled(); expect(net.select).not.toHaveBeenCalled()
  fireEvent.click(button)
  await screen.findByText('人工媒体')
  expect(net.select).toHaveBeenCalledExactlyOnceWith('a', 'current')
  expect(net.media).toHaveBeenCalledExactlyOnceWith('a', 'current')
})

it('保存中に別画面で店舗が変わっても入力と版を残し、明示切替後に同じ変更を保存できる', async () => {
  render(<BookingMedia />)
  await screen.findByText('人工媒体')
  const label = 'LINE・電話で予約が入ったら、他のサイトの枠を閉じる知らせを出す'
  fireEvent.click(screen.getByRole('switch', { name: label }))
  net.save.mockImplementationOnce(async () => { net.contextId = 'other'; throw new ApiError(400, 'API error: 400', 'restaurant_store_mismatch') })
  fireEvent.click(await screen.findByRole('button', { name: '保存する' }))
  const restore = await screen.findByRole('button', { name: 'この店舗に切り替えて表示する' })
  expect(screen.getByText(/別の画面で表示中の店舗が変わりました/)).toBeTruthy()
  fireEvent.click(restore)
  await screen.findByText('人工媒体')
  expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('true')
  expect(net.media).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(net.save).toHaveBeenCalledTimes(2))
  for (const call of net.save.mock.calls) expect(call).toEqual(['a', 'fixture', expect.objectContaining({ storeId: 'current', closeOnBooking: true, expectedVersion: 3 })])
})


it('お知らせだけの保存の404も店の不一致として回復し、お知らせの入力と版を残す', async () => {
  render(<BookingMedia />)
  await screen.findByText('人工媒体')
  const label = 'キャンセルで席が空いたら「もう開けてよい」を知らせる'
  fireEvent.click(await screen.findByRole('switch', { name: label }))
  net.saveNotice.mockImplementationOnce(async () => { net.contextId = 'other'; throw new ApiError(404, 'API error: 404', 'restaurant_store_mismatch') })
  fireEvent.click(await screen.findByRole('button', { name: '保存する' }))
  fireEvent.click(await screen.findByRole('button', { name: 'この店舗に切り替えて表示する' }))
  expect((await screen.findByRole('switch', { name: label })).getAttribute('aria-checked')).toBe('true')
  expect(net.save).not.toHaveBeenCalled()
  expect(net.notice).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(net.saveNotice).toHaveBeenCalledTimes(2))
  for (const call of net.saveNotice.mock.calls) expect(call).toEqual(['a', expect.objectContaining({ storeId: 'current', notifyReopen: true, expectedVersion: 1 })])
})


it('現役の候補が複数なら未選択から始め、実在する店舗を選ぶまで確定できない', async () => {
  net.list.mockResolvedValueOnce({ data: { stores: [
    { id: 'current', name: '現在の店', line_account_id: 'a', status: 'active' },
    { id: 'second', name: 'もう一つの店', line_account_id: 'a', status: 'active' },
  ] } })
  render(<BookingMedia />)
  const picker = await screen.findByRole('button', { name: '店舗', exact: true })
  fireEvent.click(picker)
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).queryByRole('radio', { name: '店舗を選んでください' })).toBeNull()
  expect(within(dialog).getAllByRole('radio')).toHaveLength(2)
  expect((within(dialog).getByRole('button', { name: '選ぶ', exact: true }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('radio', { name: '現在の店', exact: true }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ', exact: true }))
  await screen.findByText('人工媒体')
  expect(net.media).toHaveBeenCalledExactlyOnceWith('a', 'current')
  expect(net.select).not.toHaveBeenCalled()
})

it('同じ案内文でも別の種類の404は店舗の不一致として扱わない', async () => {
  render(<BookingMedia />)
  await screen.findByText('人工媒体')
  const label = 'キャンセルで席が空いたら「もう開けてよい」を知らせる'
  fireEvent.click(await screen.findByRole('switch', { name: label }))
  net.saveNotice.mockImplementationOnce(async () => { net.contextId = 'other'; throw new ApiError(404, '店舗が正しくありません', 'resource_not_found') })
  fireEvent.click(await screen.findByRole('button', { name: '保存する' }))
  await waitFor(() => expect(net.saveNotice).toHaveBeenCalledTimes(1))
  await screen.findByRole('alert')
  expect(net.context).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'この店舗に切り替えて表示する' })).toBeNull()
  expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe('true')
})

vi.mock('@/lib/admin-version-cache', () => ({ loadAdminVersionDetail: async () => ({ version: '2.7.0', deploy_env: 'staging' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'a', name: '対象LINE-A' }, { id: 'b', name: '対象LINE-B' }, { id: 'account-1', name: '対象LINE-1' }, { id: 'account-2', name: '対象LINE-2' }] }) }))

it('媒体の確認で実際の店とLINEを表示し、アカウント切替で古い確認を残さない', async () => {
  const view = render(<BookingMedia />)
  await screen.findByText('人工媒体')
  fireEvent.click(within(screen.getByText('人工媒体').closest('tr')!).getByRole('button'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'URL を変える', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '人工媒体の URL', exact: true })
  const target = within(within(dialog).getByRole('region', { name: '操作の対象' }))
  await target.findByText('対象LINE-A')
  expect(target.getByText('現在の店')).toBeTruthy()
  await target.findByText('検証環境')
  net.account = 'b'
  net.list.mockResolvedValue({ data: { stores: [{ id: 'store-b', name: '切替先の店', line_account_id: 'b', status: 'active' }] } })
  view.rerender(<BookingMedia />)
  await screen.findByText('人工媒体')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '人工媒体の URL', exact: true })).toBeNull())
  fireEvent.click(within(screen.getByText('人工媒体').closest('tr')!).getByRole('button'))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'URL を変える', exact: true }))
  const next = within(await screen.findByRole('dialog', { name: '人工媒体の URL', exact: true }))
  await next.findByText('対象LINE-B')
  expect(next.getByText('切替先の店')).toBeTruthy()
  expect(next.queryByText('現在の店')).toBeNull()
  expect(net.save).not.toHaveBeenCalled()
})
