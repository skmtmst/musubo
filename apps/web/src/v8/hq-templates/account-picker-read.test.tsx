// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { lineAccounts: { list: calls.list } } }))
vi.mock('@/components/shared/hq-account-picker', () => ({ HqAccountPickerField: ({ accounts, onChange }: { accounts: Array<{ id: string; name: string; friendCount: number | null }>; onChange: (ids: string[]) => void }) => <div>{accounts.map(a => <span key={a.name}>{a.name}: {a.friendCount ?? '不明'}</span>)}<button onClick={() => onChange(accounts.map(a => a.id))}>選ぶ</button></div> }))
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
it.each([-1, 1.5, NaN])('不正な友だち数 %s は不明とし、選択操作は使える', async count => {
  calls.list.mockResolvedValue({ success: true, data: [{ id: 'a', stats: { friendCount: count } }] })
  render(<Picker {...props} />)
  await waitFor(() => expect(totals).toHaveBeenLastCalledWith(null))
  expect(await screen.findByText('店A: 不明')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '選ぶ' }))
  expect(props.onChange).toHaveBeenCalledWith(['a'])
})
it('友だちが0人のときはそのまま数える', async () => {
  calls.list.mockResolvedValue({ success: true, data: [{ id: 'a', stats: { friendCount: 0 } }] })
  render(<Picker {...props} />)
  expect(await screen.findByText('店A: 0')).toBeTruthy()
  await waitFor(() => expect(totals).toHaveBeenLastCalledWith(0))
})
it('人数の合計が安全な整数を超えたら不明とする', async () => {
  calls.list.mockResolvedValue({ success: true, data: [{ id: 'a', stats: { friendCount: Number.MAX_SAFE_INTEGER } }, { id: 'b', stats: { friendCount: 1 } }] })
  render(<Picker {...props} allowed={[{ id: 'a', name: '店A' }, { id: 'b', name: '店B' }]} selected={['a', 'b']} />)
  await screen.findByText(`店A: ${Number.MAX_SAFE_INTEGER}`)
  expect(totals).toHaveBeenLastCalledWith(null)
})
