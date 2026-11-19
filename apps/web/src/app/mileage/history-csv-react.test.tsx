// @vitest-environment happy-dom
import React from 'react'
import { Blob as NodeBlob } from 'node:buffer'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ account: 'A' as string | null, history: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: mocks.account, loading: false }),
}))
vi.mock('@/lib/api', async (original) => ({
  ...await original<typeof import('@/lib/api')>(), api: { mileage: { history: mocks.history } },
}))
import { MileageShell } from '@/v8/mileage/frame'
import V8HistoryTab from '@/v8/mileage/history'
import { ApiError } from '@/lib/api'

function Screen() {
  return <MileageShell.Provider value={{ tab: 'history', readonly: true, narrow: false, counts: {}, setCount: () => {} }}><V8HistoryTab /></MileageShell.Provider>
}
const result = (name: string) => ({
  success: true, data: {
    items: [{
      id: name, primaryFriendId: 'f', displayName: name, lineAccountName: 'お店',
      occurredAt: '2026-10-04T00:00:00Z', amount: 100, reason: '付与の理由', entryType: 'grant',
      status: 'available', mode: 'automatic', executedByStaffName: null, balanceAfter: 500,
      source: 'purchase', sourceReferenceId: null, hasSourceEvent: false,
    }],
    summary: { byType: [], manualCount: 2, pendingCount: 1 }, pagination: { total: 1, limit: 20, offset: 0 },
  },
})
let blob: NodeBlob | undefined
let download: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T03:00:00Z'))
  window.history.replaceState(null, '', '/mileage')
  window.dispatchEvent(new Event('popstate'))
  mocks.account = 'A'
  mocks.history.mockReset()
  blob = undefined
  vi.stubGlobal('Blob', NodeBlob)
  vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => { blob = value as NodeBlob; return 'blob:csv' })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const ready = () => waitFor(() => expect(screen.getByRole('button', { name: 'CSVで書き出す' }).hasAttribute('disabled')).toBe(false))

test('絞り込み前後の件数が同じでも、表示中の新しい履歴を書き出す', async () => {
  mocks.history.mockImplementation((query) => Promise.resolve(result(query.limit === 1 ? '集計' : query.entryType === 'grant' ? '=次の会員,"B"' : '前の会員')))
  render(<Screen />)
  await ready()
  expect(screen.getByTitle('この条件で手で動かした分 2 件・反映を待っている 1 件')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '付けた' }))
  await waitFor(() => expect(screen.getByText('=次の会員,"B"')).toBeTruthy())
  await ready()
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
  expect(download).toHaveBeenCalledOnce()
  expect(await blob!.text()).toContain('"\'=次の会員,""B"""')
  expect(await blob!.text()).not.toContain('前の会員')
  expect(mocks.history.mock.calls.some(([query]) => query.limit === 20 && query.entryType === 'grant')).toBe(true)
})

test('アカウント切り替え中は書き出せず、同じ件数で読み込み終わっても前のお店は混ざらない', async () => {
  mocks.history.mockImplementation((query) => Promise.resolve(result(query.limit === 1 ? '集計' : 'Aの会員')))
  const rendered = render(<Screen />)
  await ready()
  let resolve!: (value: ReturnType<typeof result>) => void
  mocks.history.mockImplementation((query) => query.limit === 1 ? Promise.resolve(result('集計')) : new Promise((done) => { resolve = done }))
  mocks.account = 'B'
  rendered.rerender(<Screen />)
  expect(screen.getByRole('button', { name: 'CSVで書き出す' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
  expect(download).not.toHaveBeenCalled()
  await act(async () => resolve(result('Bの会員')))
  await ready()
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
  expect(await blob!.text()).toContain('Bの会員')
  expect(await blob!.text()).not.toContain('Aの会員')
})

test('保存に失敗しても履歴を残し、再試行できる', async () => {
  mocks.history.mockResolvedValue(result('テスト会員'))
  render(<Screen />)
  await ready()
  vi.mocked(URL.createObjectURL).mockImplementationOnce(() => { throw new Error('download') })
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
  expect(screen.getByText('CSVを書き出せませんでした。もう一度お試しください。')).toBeTruthy()
  expect(screen.getByText('テスト会員')).toBeTruthy()
  expect(download).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
  expect(download).toHaveBeenCalledOnce()
})

test('逆転した期間では取得せず、実際の暦で直して種類・状態・方法と一緒に取得する', async () => {
  window.history.replaceState(null, '', '/mileage?from=2026-10-20&to=2026-10-01&entryType=expiration&status=pending&mode=manual')
  mocks.history.mockResolvedValue(result('条件に合う会員'))
  render(<Screen />)
  await screen.findByText('日付の条件を確認してください')
  expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull()
  expect(mocks.history).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('よく使う絞り込み'))
  fireEvent.click(await screen.findByRole('button', { name: '日付・種類・状態を指定' }))
  await screen.findByRole('dialog', { name: '履歴の条件を指定' })
  fireEvent.click(screen.getByLabelText('終了日'))
  const grid = await screen.findByRole('grid')
  fireEvent.keyDown(grid, { key: 'PageDown' })
  const november = await screen.findByRole('grid', { name: '2026年11月' })
  fireEvent.keyDown(november, { key: 'Enter' })
  fireEvent.click(within(screen.getByRole('dialog', { name: '日付を選ぶ' })).getByRole('button', { name: '確定' }))
  fireEvent.click(screen.getByRole('button', { name: 'この条件で絞る' }))
  await screen.findByText('条件に合う会員')
  expect(mocks.history.mock.calls.find(([query]) => query.limit === 20)?.[0]).toMatchObject({
    accountId: 'A', from: '2026-10-20', to: '2026-11-01', entryType: 'expiration', status: 'pending', mode: 'manual', offset: 0,
  })
})

test('期間が逆転したまま確定しても取得せず、両方の日付欄のそばに理由を残す', async () => {
  window.history.replaceState(null, '', '/mileage?from=2026-10-20&to=2026-10-01')
  render(<Screen />)
  await screen.findByText('日付の条件を確認してください')
  fireEvent.click(screen.getByLabelText('よく使う絞り込み'))
  fireEvent.click(await screen.findByRole('button', { name: '日付・種類・状態を指定' }))
  await screen.findByRole('dialog', { name: '履歴の条件を指定' })
  fireEvent.click(screen.getByRole('button', { name: 'この条件で絞る' }))
  expect(mocks.history).not.toHaveBeenCalled()
  expect(screen.getByLabelText('開始日').getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByLabelText('終了日').getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByRole('alert').textContent).toBe('失敗：開始日は終了日より前の日付を入力してください')
})

test('APIの400は再読み込みの通信障害にせず、日付条件の直し方を知らせる', async () => {
  mocks.history.mockImplementation((query) => query.limit === 1 ? Promise.resolve(result('集計')) : Promise.reject(new ApiError(400, 'invalid')))
  render(<Screen />)
  await screen.findByText('日付の条件を確認してください')
  expect(screen.getByText('入力した条件を確認してください。開始日は終了日より前の日付を入力してください。')).toBeTruthy()
  expect(screen.queryByText('マイルの履歴を読み込めませんでした')).toBeNull()
  expect(screen.getByRole('button', { name: 'CSVで書き出す' }).hasAttribute('disabled')).toBe(true)
})

test('店が未選択なら履歴も集計も取得せず、店を選ぶ案内とCSV禁止を出す', async () => {
  mocks.account = null
  render(<Screen />)
  await screen.findByText('LINEアカウントを選択してください')
  expect(mocks.history).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'CSVで書き出す' }).hasAttribute('disabled')).toBe(true)
})
