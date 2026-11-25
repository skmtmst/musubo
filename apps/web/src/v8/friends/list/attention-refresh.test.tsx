// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fx = vi.hoisted(() => ({ account: 'A', role: 'owner' as string | null, granted: false, list: vi.fn(), save: vi.fn(), notify: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search), usePathname: () => '/friends' }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fx.account, loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: vi.fn() }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => fx.role }))
vi.mock('@/lib/staff-capability', () => ({ canEditFeature: (_key: string, role: string | null) => role === 'owner' || fx.granted }))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({ enabled: () => false }) }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
vi.mock('@/lib/operators-cache', () => ({ loadOperators: async () => [] }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: fx.notify }))
vi.mock('@/components/friends/bulk-run-dialog', () => ({ default: ({ open, onDone, onClose, friendIds }: { open: boolean; onDone: () => void; onClose: () => void; friendIds: string[] }) => open ? <div role="dialog" aria-label="一括操作の試験"><span>{friendIds.length}人が対象</span><button onClick={() => { onDone(); onClose() }}>一括処理完了</button></div> : null }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, fetchApi: fx.save, api: { ...actual.api, friends: { ...actual.api.friends, list: fx.list },
    friendStats: { get: async () => ({ success: false }) }, tags: { list: async () => ({ success: true, data: [] }) }, scenarios: { list: async () => ({ success: true, data: [] }) },
  } }
})
import List from './list'
import { ApiError } from '@/lib/api'
import { flushListUrlState } from '@/components/shared/list-url-state'
const friend = { id: 'one', displayName: '山田さん', tags: [], metadata: {}, updatedAt: 'version-1', createdAt: '2026-10-01T00:00:00Z', isFollowing: true }
const answer = (items = [friend], total = items.length) => ({ success: true, data: { items, total } })
beforeEach(() => {
  flushListUrlState(); window.history.replaceState(null, '', '/friends'); sessionStorage.clear()
  fx.account = 'A'; fx.role = 'owner'; fx.granted = false; vi.clearAllMocks()
  fx.list.mockReset().mockResolvedValue(answer())
  fx.save.mockReset().mockResolvedValue({ success: true, data: { metadata: { __attention: '1' }, updatedAt: 'version-2' } })
})
afterEach(() => { cleanup(); flushListUrlState(); sessionStorage.clear() })
async function open() {
  const view = render(<List />)
  await screen.findByRole('checkbox', { name: '山田さんを選ぶ' })
  return view
}
it('本人の権限が確定しても進行中の初回読取を増やさず、権限変更では選択を捨てる', async () => {
  let finish!: (value: ReturnType<typeof answer>) => void
  fx.role = null
  fx.list.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const view = render(<List />)
  await waitFor(() => expect(fx.list).toHaveBeenCalledTimes(1))
  fx.role = 'owner'; view.rerender(<List />)
  expect(fx.list).toHaveBeenCalledTimes(1)
  await act(async () => finish(answer()))
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fx.role = 'viewer'; view.rerender(<List />)
  expect(screen.queryByRole('checkbox', { name: '山田さんを選ぶ' })).toBeNull()
  expect(screen.getByText('山田さん')).toBeTruthy()
  fx.role = 'owner'; view.rerender(<List />)
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(false)
  expect(fx.list).toHaveBeenCalledTimes(1)
})

it('アカウントを往復した後に届く前の読取応答を表示しない', async () => {
  const pending: Array<(value: ReturnType<typeof answer>) => void> = []
  fx.list.mockImplementation(() => new Promise(resolve => { pending.push(resolve) }))
  const view = render(<List />)
  await waitFor(() => expect(pending).toHaveLength(1))
  fx.account = 'B'; view.rerender(<List />)
  await waitFor(() => expect(pending).toHaveLength(2))
  await act(async () => pending[1](answer([{ ...friend, displayName: 'Bの友だち' }])))
  expect(screen.getByText('Bの友だち')).toBeTruthy()
  fx.account = 'A'; view.rerender(<List />)
  expect(screen.queryByText('Bの友だち')).toBeNull()
  await waitFor(() => expect(pending).toHaveLength(3))
  await act(async () => pending[2](answer([{ ...friend, displayName: '新しいAの友だち' }])))
  await act(async () => pending[0](answer([{ ...friend, displayName: '古いAの友だち' }])))
  expect(screen.getByText('新しいAの友だち')).toBeTruthy()
  expect(screen.queryByText('古いAの友だち')).toBeNull()
})

it('権限を往復した後に届く注目の保存結果を持ち込まない', async () => {
  let finish!: (value: unknown) => void
  fx.save.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const view = await open()
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を付ける' }))
  fx.role = 'viewer'; view.rerender(<List />)
  fx.role = 'owner'; view.rerender(<List />)
  await act(async () => finish({ success: true, data: { metadata: { __attention: null }, updatedAt: 'obsolete-version' } }))
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を外す' }))
  await waitFor(() => expect(fx.save).toHaveBeenCalledTimes(2))
  expect(fx.save.mock.calls[1][0]).toContain('expectedUpdatedAt=version-1')
  expect(fx.notify).not.toHaveBeenCalled()
})

it('全件の選択を待つ間に権限を往復しても前の選択を復活させない', async () => {
  let finish!: (value: ReturnType<typeof answer>) => void
  fx.list.mockResolvedValueOnce(answer([friend], 2)).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const view = await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: '条件に合う2人すべてを選択する' }))
  await waitFor(() => expect(fx.list).toHaveBeenCalledTimes(2))
  fx.role = 'viewer'; view.rerender(<List />)
  fx.role = 'owner'; view.rerender(<List />)
  await act(async () => finish(answer([friend, { ...friend, id: 'two', displayName: '佐藤さん' }])))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(false)
  expect(screen.queryByText('2人を選択中')).toBeNull()
})

it('注目の保存後は全表を取り直さず、選択と新しい版を次の保存に使う', async () => {
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を付ける' }))
  await waitFor(() => expect(fx.save).toHaveBeenCalledTimes(1))
  await act(async () => {})
  expect(fx.list).toHaveBeenCalledTimes(1)
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を外す' }))
  await waitFor(() => expect(fx.save).toHaveBeenCalledTimes(2))
  expect(fx.save.mock.calls[0][0]).toContain('expectedUpdatedAt=version-1')
  expect(fx.save.mock.calls[1][0]).toContain('expectedUpdatedAt=version-2')
})
it('競合の同条件再取得では選択を残し、保存失敗を知らせる', async () => {
  fx.save.mockRejectedValueOnce(new ApiError(409, '競合'))
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を付ける' }))
  await waitFor(() => expect(fx.list).toHaveBeenCalledTimes(2))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(true)
  expect(fx.notify).toHaveBeenCalledWith(expect.stringContaining('ほかの変更と重なりました'), { tone: 'error' })
})
it('通信失敗なら星を戻し、選択を残す', async () => {
  fx.save.mockRejectedValueOnce(new Error('通信断'))
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を付ける' }))
  await waitFor(() => expect(fx.notify).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: '山田さんの注目を付ける' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(true)
})
it('権限・条件・アカウントが変わったら以前の選択を戻さない', async () => {
  const view = await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fx.role = 'staff'; view.rerender(<List />)
  expect(screen.queryByRole('checkbox', { name: '山田さんを選ぶ' })).toBeNull()
  fx.role = 'owner'; view.rerender(<List />)
  await screen.findByRole('checkbox', { name: '山田さんを選ぶ' })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fx.account = 'B'; view.rerender(<List />)
  await screen.findByRole('checkbox', { name: '山田さんを選ぶ' })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(false)
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '新条件' } })
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Enter' })
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(false))
})
it('一括処理の完了で選択と操作の窓を閉じる', async () => {
  fx.list.mockResolvedValue(answer([friend, { ...friend, id: 'two', displayName: '佐藤さん' }]))
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '佐藤さんを選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: '操作を選択する', exact: true }))
  expect(screen.getByRole('dialog', { name: '一括操作の試験' }).textContent).toContain('2人が対象')
  fireEvent.click(screen.getByRole('button', { name: '一括処理完了' }))
  await waitFor(() => expect(fx.list).toHaveBeenCalledTimes(2))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(false)
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '佐藤さんを選ぶ' }).checked).toBe(false)
  expect(screen.queryByRole('dialog', { name: '一括操作の試験' })).toBeNull()
})
it('注目の絞り込みに一致しない人を件数・選択から除いて補充する', async () => {
  window.history.replaceState(null, '', '/friends?attentionOnly=true')
  fx.list.mockResolvedValueOnce(answer([{ ...friend, metadata: { __attention: '1' } }])).mockReturnValue(new Promise(() => {}))
  fx.save.mockResolvedValue({ success: true, data: { metadata: {}, updatedAt: 'version-2' } })
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を外す' }))
  await waitFor(() => expect(fx.list).toHaveBeenCalledTimes(2))
  expect(screen.queryByText('山田さん')).toBeNull()
  expect(screen.queryByText('1人を選択中')).toBeNull()
})

it('同じ役割でも変更権限がなくなれば選択を破棄する', async () => {
  fx.role = 'staff'; fx.granted = true
  const view = await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fx.granted = false; view.rerender(<List />)
  expect(screen.queryByRole('checkbox', { name: '山田さんを選ぶ' })).toBeNull()
  fx.granted = true; view.rerender(<List />)
  await screen.findByRole('checkbox', { name: '山田さんを選ぶ' })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(false)
})
it('別のアカウントへ移った後の保存失敗や再試行を持ち込まない', async () => {
  let reject!: (error: Error) => void
  fx.save.mockReturnValueOnce(new Promise((_yes, no) => { reject = no }))
  const view = await open()
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を付ける' }))
  fx.account = 'B'; view.rerender(<List />)
  await screen.findByRole('button', { name: '山田さんの注目を付ける' })
  await act(async () => reject(new Error('旧アカウントの通信断')))
  expect(fx.notify).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '山田さんの注目を付ける' }).getAttribute('aria-pressed')).toBe('false')
})

it('同条件の取り直しが一度失敗しても、再試行で選択を復元する', async () => {
  fx.save.mockRejectedValueOnce(new ApiError(409, '競合'))
  fx.list.mockResolvedValueOnce(answer()).mockRejectedValueOnce(new Error('通信断')).mockResolvedValue(answer())
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を付ける' }))
  const failure = await screen.findByText('友だちを読み込めませんでした')
  fireEvent.click(failure.closest('[data-list-state]')!.querySelector('button')!)
  await screen.findByRole('checkbox', { name: '山田さんを選ぶ' })
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '山田さんを選ぶ' }).checked).toBe(true)
})
it('同条件の再取得で一覧から消えた行の選択は残さない', async () => {
  fx.save.mockRejectedValueOnce(new ApiError(409, '競合'))
  fx.list.mockResolvedValueOnce(answer()).mockResolvedValue(answer([]))
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を付ける' }))
  await screen.findByText('まだ友だちがいません')
  expect(screen.queryByText('1人を選択中')).toBeNull()
})

it('同条件の一部のページだけでは選択対象の有無を決めつけない', async () => {
  fx.save.mockRejectedValueOnce(new ApiError(409, '競合'))
  fx.list.mockResolvedValueOnce(answer([friend], 100)).mockResolvedValue(answer([{ ...friend, id: 'two', displayName: '別の人' }], 100))
  await open()
  fireEvent.click(screen.getByRole('checkbox', { name: '山田さんを選ぶ' }))
  fireEvent.click(screen.getByRole('button', { name: '山田さんの注目を付ける' }))
  await screen.findByText('別の人')
  expect(screen.getByText('1人を選択中')).toBeTruthy()
})
