// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { HistoryScreen } from './profile-history'

const mocks = vi.hoisted(() => ({ history: vi.fn() }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: mocks }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
const entry = { id: 'record-1', changeId: 'change-1', kind: 'profile', summary: '変更した店名', staffName: '担当者', status: 'failed', error: '接続失敗', createdAt: '2026-10-11T00:00:00Z' }
const data = { changes: [entry], total: 21, page: 1, perPage: 20, counts: { all: 21, hours: 10, profile: 10, review_reply: 1 } }
const go = vi.fn()
beforeEach(() => { vi.clearAllMocks(); mocks.history.mockResolvedValue(data) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function open() {
  render(<HistoryScreen accountId="account-1" initialResult="pending" go={go} />)
  await screen.findByText('変更した店名')
}
async function choose(label: string, name: string) {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(within(await screen.findByRole('listbox')).getByRole('button', { name }))
}

describe('Googleの変更履歴を現在の共通の一覧で使う', () => {
  it('初期条件・件数・失敗理由を表示し、クリックとキーボードで同じ変更案を開く', async () => {
    await open()
    expect(mocks.history).toHaveBeenCalledWith('account-1', { kind: 'all', result: 'pending', days: 30, q: undefined, page: 1, perPage: 20 })
    expect(screen.getByText('1–20 / 21件')).toBeTruthy()
    expect(screen.getByText(/接続失敗/)).toBeTruthy()
    const row = screen.getByRole('row', { name: '変更した店名' })
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(go.mock.calls).toEqual([[{ tab: 'profile', view: 'confirm', id: 'change-1' }], [{ tab: 'profile', view: 'confirm', id: 'change-1' }]])
  })
  it('ページ送り・種類・結果・期間の条件を送り、絞り込みでは先頭のページへ戻す', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: '次のページ' }))
    await waitFor(() => expect(mocks.history).toHaveBeenLastCalledWith('account-1', expect.objectContaining({ page: 2 })))
    fireEvent.click(screen.getByRole('tab', { name: /営業時間/ }))
    await waitFor(() => expect(mocks.history).toHaveBeenLastCalledWith('account-1', expect.objectContaining({ kind: 'hours', page: 1 })))
    await choose('結果で絞り込み', '反映済み')
    await waitFor(() => expect(mocks.history).toHaveBeenLastCalledWith('account-1', expect.objectContaining({ result: 'applied' })))
    await choose('期間', '7日')
    await waitFor(() => expect(mocks.history).toHaveBeenLastCalledWith('account-1', expect.objectContaining({ days: 7 })))
  })
  it('検索を待って送り、遅い前の検索結果で現在の条件を上書きしない', async () => {
    await open()
    let finish!: (result: unknown) => void
    mocks.history.mockReturnValueOnce(new Promise((resolve) => { finish = resolve })).mockResolvedValueOnce({ ...data, changes: [{ ...entry, summary: '最新の結果' }] })
    fireEvent.change(screen.getByRole('searchbox', { name: '内容で検索' }), { target: { value: '前の検索' } })
    await waitFor(() => expect(mocks.history).toHaveBeenCalledWith('account-1', expect.objectContaining({ q: '前の検索' })))
    fireEvent.change(screen.getByRole('searchbox', { name: '内容で検索' }), { target: { value: '今の検索' } })
    await screen.findByText('最新の結果')
    await act(async () => { finish({ ...data, changes: [{ ...entry, summary: '古い結果' }] }) })
    expect(screen.queryByText('古い結果')).toBeNull()
    expect(screen.getByText('最新の結果')).toBeTruthy()
  })
  it('取得失敗は読み直せて、空の履歴はCSV出力を止める', async () => {
    mocks.history.mockRejectedValueOnce(new ApiError(500, '履歴の取得に失敗しました')).mockResolvedValueOnce({ ...data, total: 0, changes: [] })
    render(<HistoryScreen accountId="account-1" go={go} />)
    await screen.findByText('変更履歴を読み込めませんでした。')
    fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
    await screen.findByText('この期間の記録はありません')
    expect(screen.getByRole('button', { name: 'CSVで書き出す' })).toHaveProperty('disabled', true)
  })
  it('CSVは現在の絞り込みで全ページを取り、引用符・改行を残して出力する', async () => {
    await open()
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:history-test')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    mocks.history.mockResolvedValueOnce({ ...data, changes: [{ ...entry, summary: '店名"変更\n二行目' }], total: 101, perPage: 100 }).mockResolvedValueOnce({ ...data, changes: [{ ...entry, summary: '次のページ' }], total: 101, perPage: 100 })
    fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
    await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1))
    expect(mocks.history).toHaveBeenLastCalledWith('account-1', expect.objectContaining({ page: 2, perPage: 100, result: 'pending' }))
    const csv = await (createUrl.mock.calls[0][0] as Blob).text()
    expect(csv).toContain('"店名""変更\n二行目"')
    expect(csv).toContain('"次のページ"')
    expect(click).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:history-test')
  })
  it('CSVの取得が失敗しても再試行でき、失敗したCSVを保存しない', async () => {
    await open()
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:history-test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    mocks.history.mockRejectedValueOnce(new ApiError(500, 'CSVの取得に失敗しました')).mockResolvedValueOnce({ ...data, perPage: 100 })
    fireEvent.click(screen.getByRole('button', { name: 'CSVで書き出す' }))
    await screen.findByText('CSVを書き出せませんでした。')
    expect(createUrl).not.toHaveBeenCalled()
    const retry = screen.getByRole('button', { name: 'CSVで書き出す' })
    expect(retry).toHaveProperty('disabled', false)
    fireEvent.click(retry)
    await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1))
  })
})

it('失敗した変更の案内は、操作権限や環境に関わらず確認できることだけを伝える', async () => {
  await open()
  expect(screen.getByText(/失敗した変更は、その画面で内容を確認できます/)).toBeTruthy()
  expect(screen.queryByText(/失敗した変更は、その画面からやり直せます/)).toBeNull()
})
