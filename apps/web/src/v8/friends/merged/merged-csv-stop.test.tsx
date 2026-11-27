// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, usersGrouped: { ...actual.api.usersGrouped, list: mocks.list }, lineAccounts: { ...actual.api.lineAccounts, list: vi.fn(async () => ({ success: true, data: [] })) } } }
})
import { useMergedUsers } from './use-merged-users'
const row = { identityKey: 'fixture', displayName: '見本', emails: [], phones: [], accounts: [{ accountId: 'a', accountName: '見本', lineUserId: 'fixture' }], identityKeyKind: 'solo', lastActivityAt: '' }
const response = (rows = [row], total = 2) => ({ success: true, data: { memberAccountId: 'a', rows, total, page: 1, pageSize: 200 } })
function View() { const u = useMergedUsers('a'); return <><button onClick={() => void u.exportCsv()} disabled={u.loading || u.exporting}>CSV</button>{u.exporting && <p>書き出し中</p>}{u.exportError && <p role="alert">{u.exportError}</p>}</> }
let create: ReturnType<typeof vi.spyOn>
beforeEach(() => { window.history.replaceState(null, '', '/friends?tab=merged'); mocks.list.mockReset(); create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('連打では1回だけ取得し、離脱後は次を取得せずダウンロードしない', async () => {
  let resolve!: (v: unknown) => void
  const pending = new Promise(done => { resolve = done })
  mocks.list.mockImplementation((input: { pageSize: number }) => input.pageSize === 200 ? pending : Promise.resolve(response()))
  const view = render(<View />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'CSV' }) as HTMLButtonElement).disabled).toBe(false))
  const button = screen.getByRole('button', { name: 'CSV' })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  expect(mocks.list.mock.calls.filter(([input]) => input.pageSize === 200)).toHaveLength(1)
  const signal = mocks.list.mock.calls.find(([input]) => input.pageSize === 200)?.[0].signal as AbortSignal
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => { resolve(response()); await pending })
  expect(mocks.list.mock.calls.filter(([input]) => input.pageSize === 200)).toHaveLength(1)
  expect(create).not.toHaveBeenCalled()
})
it('途中の候補取得に失敗したら不完全なCSVを作らず失敗を知らせる', async () => {
  mocks.list.mockImplementation((input: { pageSize: number; page: number }) => input.pageSize !== 200 ? Promise.resolve(response()) : input.page === 1 ? Promise.resolve(response()) : Promise.resolve({ success: false }))
  render(<View />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'CSV' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
  expect((await screen.findByRole('alert')).textContent).toContain('CSVを書き出せませんでした')
  expect(create).not.toHaveBeenCalled()
})
it('途中で空のページが返り件数に足りない場合も、失敗を知らせる', async () => {
  mocks.list.mockImplementation((input: { pageSize: number; page: number }) => input.pageSize !== 200 ? Promise.resolve(response()) : input.page === 1 ? Promise.resolve(response()) : Promise.resolve(response([], 2)))
  render(<View />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'CSV' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
  expect((await screen.findByRole('alert')).textContent).toContain('CSVを書き出せませんでした')
  expect(create).not.toHaveBeenCalled()
})
