// @vitest-environment happy-dom
/*
 * 外部の予定・会議の確認（運用状態 › 健全性チェック）。
 *
 * - 管理者だけが一覧を読み、確認窓で確かめてから相手先の片づけを記録する。
 * - 種類・担当・予定の日時だけを出し、分からない値は「—」にする。
 * - 読めない・権限が無い・ほかの人が先に記録した・記録に失敗したを言い分け、確認が要るものを黙って消さない。
 * - アカウントを切り替えたら前のアカウントの応答を捨てる。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const net = vi.hoisted(() => ({ listExternalCleanups: vi.fn(), resolveExternalCleanup: vi.fn(), listStaff: vi.fn(), role: vi.fn(), toast: vi.fn() }))
vi.mock('@/lib/api/helpers/gap1', () => ({ bookingCalendarApi: { listExternalCleanups: net.listExternalCleanups, resolveExternalCleanup: net.resolveExternalCleanup } }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: net.role, canAdministerRole: (role: string | null) => role === 'admin' || role === 'owner' }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, bookingApi: { ...actual.bookingApi, listStaff: net.listStaff } }
})
vi.mock('@/components/shared/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/shared/toast')>()
  return { ...actual, notifyToast: net.toast }
})
const { ExternalCleanupSection } = await import('./external-cleanup')
const { ApiError } = await import('@/lib/api')

const zoom = { id: 'job-zoom', provider: 'zoom', staffId: 'staff-1', startsAt: '2030-01-02T01:00:00Z' } as const
const calendar = { id: 'job-calendar', provider: 'google_calendar', staffId: 'staff-1', startsAt: '2030-01-03T05:30:00Z' } as const
const unknown = { id: 'job-unknown', provider: null, staffId: null, startsAt: null } as const
const staff = { staff: [{ id: 'staff-1', name: '山田', display_name: '山田 花子' }] }
const listed = (...items: unknown[]) => ({ success: true, data: { items } })
/** 待っていた応答を返し、React の描き直しまで終える。 */
const settle = (finish: () => void) => act(async () => { finish(); await new Promise((resolve) => setTimeout(resolve, 0)) })

afterEach(() => { cleanup(); vi.resetAllMocks() })

it.each(['staff', 'viewer', null])('管理者でなければ（%s）口を読まず、何も出さない', async (role) => {
  net.role.mockReturnValue(role)
  const { container } = render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  await Promise.resolve()
  expect(net.listExternalCleanups).not.toHaveBeenCalled()
  expect(net.listStaff).not.toHaveBeenCalled()
  expect(container.textContent).toBe('')
})

it('アカウント未選択では口を読まない', async () => {
  net.role.mockReturnValue('owner')
  const { container } = render(<ExternalCleanupSection accountId={null} reloadRequest={0} />)
  await Promise.resolve()
  expect(net.listExternalCleanups).not.toHaveBeenCalled()
  expect(container.textContent).toBe('')
})

it('件数・種類・担当・予定の日時（別の年でも時刻まで）を出し、分からない値は「—」にする', async () => {
  net.role.mockReturnValue('owner')
  net.listExternalCleanups.mockResolvedValue(listed(zoom, unknown))
  net.listStaff.mockResolvedValue(staff)
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  expect(await screen.findByText('外部の予定・会議の確認 2 件')).toBeTruthy()
  expect(await screen.findByText('Zoom の会議・担当：山田 花子・予定：2030/01/02 10:00')).toBeTruthy()
  expect(screen.getByText('種類が分からない予定・会議・担当：—・予定：—')).toBeTruthy()
  expect(screen.getByText(/Zoom の会議/).textContent).toContain('2030/01/02\u00a010:00')
  expect(screen.getAllByText('要確認')).toHaveLength(2)
  expect(net.listExternalCleanups).toHaveBeenCalledWith('account')
  expect(net.listStaff).toHaveBeenCalledWith('account')
})

it('担当の名前が読めなくても、一覧と記録は使える', async () => {
  net.role.mockReturnValue('admin')
  net.listExternalCleanups.mockResolvedValue(listed(zoom))
  net.listStaff.mockRejectedValue(new TypeError('fetch failed'))
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  expect(await screen.findByText('Zoom の会議・担当：—・予定：2030/01/02 10:00')).toBeTruthy()
  expect(screen.getByRole('button', { name: '片づけ済みにする' })).toBeTruthy()
})

it('確認窓で確かめてから記録し、行を消して知らせる', async () => {
  net.role.mockReturnValue('admin')
  net.listExternalCleanups.mockResolvedValueOnce(listed(zoom, calendar)).mockResolvedValue(listed(calendar))
  net.listStaff.mockResolvedValue(staff)
  net.resolveExternalCleanup.mockResolvedValue({ success: true, data: { resolved: true } })
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  await screen.findByText('Zoom の会議・担当：山田 花子・予定：2030/01/02 10:00')
  fireEvent.click(screen.getAllByRole('button', { name: '片づけ済みにする' })[0])
  expect(net.resolveExternalCleanup).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog', { name: '相手先で片づけましたか？' })
  // 日付と時刻の間は折り返さない空白でつなぐ（窓でも行でも、かたまりで読める）。
  expect(dialog.textContent).toContain('Zoom の会議・担当：山田 花子・予定：2030/01/02\u00a010:00')
  // 会議の URL だけの相手先は空き枠に関わらないので、空きの注意を出さない。
  expect(dialog.textContent).not.toContain('予約の空きから外れます')
  fireEvent.click(within(dialog).getByRole('button', { name: '片づけ済みにする' }))
  await waitFor(() => expect(net.resolveExternalCleanup).toHaveBeenCalledWith('account', 'job-zoom'))
  await waitFor(() => expect(screen.queryByText('Zoom の会議・担当：山田 花子・予定：2030/01/02 10:00')).toBeNull())
  expect(screen.getByText('外部の予定・会議の確認 1 件')).toBeTruthy()
  expect(net.toast).toHaveBeenCalledWith('片づけ済みにしました。', { tone: 'success' })
  expect(net.resolveExternalCleanup).toHaveBeenCalledTimes(1)
})

it('カレンダーの予定は、残ると予約の空きから外れることを確認窓で伝える', async () => {
  net.role.mockReturnValue('owner')
  net.listExternalCleanups.mockResolvedValue(listed(calendar))
  net.listStaff.mockResolvedValue(staff)
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '片づけ済みにする' }))
  expect(screen.getByRole('dialog', { name: '相手先で片づけましたか？' }).textContent).toContain('相手先に予定が残っていると、その時間は予約の空きから外れます。')
})

it('キャンセルでは記録しない', async () => {
  net.role.mockReturnValue('owner')
  net.listExternalCleanups.mockResolvedValue(listed(zoom))
  net.listStaff.mockResolvedValue(staff)
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '片づけ済みにする' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'キャンセル' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '相手先で片づけましたか？' })).toBeNull())
  expect(net.resolveExternalCleanup).not.toHaveBeenCalled()
  expect(screen.getByText('外部の予定・会議の確認 1 件')).toBeTruthy()
})

it('記録に失敗したら窓に理由を残し、行も残して同じ操作でやり直せる', async () => {
  net.role.mockReturnValue('admin')
  net.listExternalCleanups.mockResolvedValueOnce(listed(zoom)).mockResolvedValue(listed())
  net.listStaff.mockResolvedValue(staff)
  net.resolveExternalCleanup.mockRejectedValueOnce(new ApiError(503, 'calendar_settings_unavailable')).mockResolvedValue({ success: true, data: { resolved: true } })
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '片づけ済みにする' }))
  const dialog = screen.getByRole('dialog', { name: '相手先で片づけましたか？' })
  fireEvent.click(within(dialog).getByRole('button', { name: '片づけ済みにする' }))
  expect(await within(dialog).findByText('記録に失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy()
  expect(screen.getByText('外部の予定・会議の確認 1 件')).toBeTruthy()
  expect(net.toast).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '片づけ済みにする' }))
  await waitFor(() => expect(net.resolveExternalCleanup).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByText('外部の予定・会議の確認 1 件')).toBeNull())
})

it('ほかの人が先に記録していたら、一覧を読み直して知らせる', async () => {
  net.role.mockReturnValue('owner')
  net.listExternalCleanups.mockResolvedValueOnce(listed(zoom)).mockResolvedValue(listed())
  net.listStaff.mockResolvedValue(staff)
  net.resolveExternalCleanup.mockRejectedValue(new ApiError(404, 'not_found'))
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '片づけ済みにする' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '片づけ済みにする' }))
  expect(await screen.findByText('ほかの人が先に記録したか、状態が変わりました。一覧を読み直しました。')).toBeTruthy()
  await waitFor(() => expect(screen.queryByRole('button', { name: '片づけ済みにする' })).toBeNull())
  expect(net.listExternalCleanups).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('dialog', { name: '相手先で片づけましたか？' })).toBeNull()
})

it('読めないときは「無い」と扱わず、もう一度読み込める', async () => {
  net.role.mockReturnValue('admin')
  net.listExternalCleanups.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(listed(zoom))
  net.listStaff.mockResolvedValue(staff)
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  expect(await screen.findByText('外部の予定・会議の確認を読み込めませんでした')).toBeTruthy()
  expect(screen.getByText('確認が要るものは無いとは扱いません。時間をおいて、もう一度読み込んでください。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('外部の予定・会議の確認 1 件')).toBeTruthy()
})

it('形の違う応答も「無い」と扱わず、読めなかったと出す', async () => {
  net.role.mockReturnValue('owner')
  net.listExternalCleanups.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 })
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  expect(await screen.findByText('外部の予定・会議の確認を読み込めませんでした')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
})

it('見る権限が無いと言われたら、読み直しを出さずに頼む先を出す', async () => {
  net.role.mockReturnValue('admin')
  net.listExternalCleanups.mockRejectedValue(new ApiError(403, 'forbidden'))
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  expect(await screen.findByText('外部の予定・会議の確認を見る権限がありません')).toBeTruthy()
  expect(screen.getByText('この操作の権限がありません。オーナーか管理者に頼んでください。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
})

it('アカウントを切り替えたら、前のアカウントの応答を捨てる', async () => {
  net.role.mockReturnValue('owner')
  let finishFirst: (value: unknown) => void = () => undefined
  net.listExternalCleanups.mockImplementation((accountId: string) => accountId === 'first'
    ? new Promise((resolve) => { finishFirst = resolve })
    : Promise.resolve(listed(calendar)))
  net.listStaff.mockResolvedValue(staff)
  const view = render(<ExternalCleanupSection accountId="first" reloadRequest={0} />)
  view.rerender(<ExternalCleanupSection accountId="second" reloadRequest={0} />)
  expect(await screen.findByText('Google カレンダーの予定・担当：山田 花子・予定：2030/01/03 14:30')).toBeTruthy()
  await settle(() => finishFirst(listed(zoom, unknown)))
  expect(screen.queryByText(/Zoom の会議/)).toBeNull()
  expect(screen.getByText('外部の予定・会議の確認 1 件')).toBeTruthy()
})

it('記録を続けて押しても、送るのは1回だけ', async () => {
  net.role.mockReturnValue('admin')
  let finish: (value: unknown) => void = () => undefined
  net.listExternalCleanups.mockResolvedValueOnce(listed(zoom)).mockResolvedValue(listed())
  net.listStaff.mockResolvedValue(staff)
  net.resolveExternalCleanup.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '片づけ済みにする' }))
  const dialog = screen.getByRole('dialog', { name: '相手先で片づけましたか？' })
  const confirm = within(dialog).getByRole('button', { name: '片づけ済みにする' })
  // 描き直しで押せない形になる前に続けて届いた押下も、送るのは1回だけ。
  act(() => { confirm.click(); confirm.click(); confirm.click() })
  fireEvent.click(confirm)
  expect(net.resolveExternalCleanup).toHaveBeenCalledTimes(1)
  await settle(() => finish({ success: true, data: { resolved: true } }))
  await waitFor(() => expect(net.toast).toHaveBeenCalledTimes(1))
  expect(net.resolveExternalCleanup).toHaveBeenCalledTimes(1)
})

it('記録の途中でアカウントを切り替えたら、前のアカウントの結果で今の一覧を変えない', async () => {
  net.role.mockReturnValue('owner')
  let finish: (value: unknown) => void = () => undefined
  net.listExternalCleanups.mockImplementation((accountId: string) => Promise.resolve(accountId === 'first' ? listed(zoom) : listed(zoom, calendar)))
  net.listStaff.mockResolvedValue(staff)
  net.resolveExternalCleanup.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const view = render(<ExternalCleanupSection accountId="first" reloadRequest={0} />)
  fireEvent.click(await screen.findByRole('button', { name: '片づけ済みにする' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '片づけ済みにする' }))
  await waitFor(() => expect(net.resolveExternalCleanup).toHaveBeenCalledWith('first', 'job-zoom'))
  view.rerender(<ExternalCleanupSection accountId="second" reloadRequest={0} />)
  expect(await screen.findByText('外部の予定・会議の確認 2 件')).toBeTruthy()
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '相手先で片づけましたか？' })).toBeNull())
  await settle(() => finish({ success: true, data: { resolved: true } }))
  expect(screen.getByText('外部の予定・会議の確認 2 件')).toBeTruthy()
  expect(screen.getByText('Zoom の会議・担当：山田 花子・予定：2030/01/02 10:00')).toBeTruthy()
  expect(net.toast).not.toHaveBeenCalled()
  // 切り替えた先では、前の記録の鍵を引き継がずに操作できる。
  expect(screen.getAllByRole('button', { name: '片づけ済みにする' }).every((button) => !button.hasAttribute('disabled'))).toBe(true)
})

it('頭の「いますぐ確かめる」で読み直す', async () => {
  net.role.mockReturnValue('owner')
  net.listExternalCleanups.mockResolvedValueOnce(listed(zoom)).mockResolvedValue(listed(zoom, calendar))
  net.listStaff.mockResolvedValue(staff)
  const view = render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  expect(await screen.findByText('外部の予定・会議の確認 1 件')).toBeTruthy()
  expect(net.listExternalCleanups).toHaveBeenCalledTimes(1)
  view.rerender(<ExternalCleanupSection accountId="account" reloadRequest={1} />)
  expect(await screen.findByText('外部の予定・会議の確認 2 件')).toBeTruthy()
  expect(net.listExternalCleanups).toHaveBeenCalledTimes(2)
})

it.each([
  [100, '外部の予定・会議の確認 100 件以上', true],
  [99, '外部の予定・会議の確認 99 件', false],
])('口の上限（100 件）に届いたら全部の件数と思わせない（%i 件）', async (count, title, capped) => {
  net.role.mockReturnValue('owner')
  net.listExternalCleanups.mockResolvedValue(listed(...Array.from({ length: count }, (_, index) => ({ ...zoom, id: `job-${index}` }))))
  net.listStaff.mockResolvedValue(staff)
  render(<ExternalCleanupSection accountId="account" reloadRequest={0} />)
  expect(await screen.findByText(title)).toBeTruthy()
  expect(Boolean(screen.queryByText('古い順に先頭 100 件を表示'))).toBe(capped)
  expect(screen.getAllByRole('button', { name: '片づけ済みにする' })).toHaveLength(count)
})
