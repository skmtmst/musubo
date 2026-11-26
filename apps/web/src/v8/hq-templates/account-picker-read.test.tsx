// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { lineAccounts: { list: calls.list } } }))
vi.mock('@/components/shared/hq-account-picker', () => ({ HqAccountPickerField: ({ accounts }: { accounts: Array<{ name: string; friendCount: number | null }> }) => <div>{accounts.map(a => <span key={a.name}>{a.name}: {a.friendCount ?? '不明'}</span>)}</div> }))
import Picker from './account-picker'
const totals = vi.fn()
const props = { title: '配るアカウント', allowed: [{ id: 'a', name: '店A' }], selected: ['a'], onChange: vi.fn(), onFriendTotal: totals }
beforeEach(() => { calls.list.mockReset(); totals.mockReset() })
afterEach(cleanup)
it.each(['response', 'network'])('友だち数の%s失敗を知らせて再取得できる', async failure => {
  if (failure === 'response') calls.list.mockResolvedValueOnce({ success: false })
  else calls.list.mockRejectedValueOnce(new Error('offline'))
  calls.list.mockResolvedValueOnce({ success: true, data: [{ id: 'a', stats: { friendCount: 42 } }] })
  render(<Picker {...props} />)
  expect(await screen.findByText(/友だち数を読み込めませんでした/)).toBeTruthy()
  expect(totals).toHaveBeenLastCalledWith(null)
  fireEvent.click(screen.getByRole('button', { name: '友だち数を読み直す' }))
  await waitFor(() => expect(totals).toHaveBeenLastCalledWith(42))
  expect(calls.list).toHaveBeenCalledTimes(2)
})
it('配布先切替後に古い友だち数を出さない', async () => {
  let resolveOld!: (value: unknown) => void
  calls.list.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce({ success: true, data: [{ id: 'b', stats: { friendCount: 8 } }] })
  const view = render(<Picker {...props} />)
  view.rerender(<Picker {...props} allowed={[{ id: 'b', name: '店B' }]} selected={['b']} />)
  await waitFor(() => expect(totals).toHaveBeenLastCalledWith(8))
  await act(async () => { resolveOld({ success: true, data: [{ id: 'a', stats: { friendCount: 999 } }] }) })
  expect(totals).toHaveBeenLastCalledWith(8)
  expect(screen.queryByText(/999/)).toBeNull()
})
