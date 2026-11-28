// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import FriendPickerField from './friend-picker-field'

const list = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { friends: { list } } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const response = (id: string, displayName: string, total = 1) => ({ success: true, data: { items: [{ id, displayName }], total } })

test('名前で選んだ友だちのIDを返す。検索結果は20件ずつ追加で読む', async () => {
  list.mockResolvedValueOnce(response('a', '青木', 2)).mockResolvedValueOnce(response('b', '山田', 2))
  const change = vi.fn()
  render(<FriendPickerField accountId="account-a" label="試す友だち" value="" onChange={change} />)
  expect(list).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '試す友だち：選択する' }))
  await screen.findByRole('radio', { name: '青木' })
  fireEvent.click(screen.getByRole('button', { name: '続きを読み込む' }))
  fireEvent.click(await screen.findByRole('radio', { name: '山田' }))
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'account-a', offset: '1', limit: 20 }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '選択する' }))
  expect(change).toHaveBeenCalledWith('b')
})

test('別アカウントへ切り替えると窓を閉じ、前の遅い結果を候補に入れない', async () => {
  let finish!: (result: ReturnType<typeof response>) => void
  list.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve })).mockResolvedValueOnce(response('b', 'B店の友だち'))
  const view = render(<FriendPickerField accountId="account-a" label="友だち" value="" onChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '友だち：選択する' }))
  await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
  view.rerender(<FriendPickerField accountId="account-b" label="友だち" value="" onChange={() => {}} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '友だち：選択する' }))
  await screen.findByRole('radio', { name: 'B店の友だち' })
  finish(response('a', 'A店の友だち'))
  await waitFor(() => expect(screen.queryByRole('radio', { name: 'A店の友だち' })).toBeNull())
})
