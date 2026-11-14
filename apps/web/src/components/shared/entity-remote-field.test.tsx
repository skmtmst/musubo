// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import EntityRemoteField, { loadEntityCandidates } from './entity-remote-field'

const calls = vi.hoisted(() => ({ forms: vi.fn(), links: vi.fn(), events: vi.fn(), resources: vi.fn() }))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { forms: { list: calls.forms }, trackedLinks: { list: calls.links }, commonActions: { resources: calls.resources }, folders: { list: async () => ({ success: true, data: [] }) } },
  bookingApi: {}, eventsApi: { listEvents: calls.events },
}))
vi.mock('@/contexts/account-context', () => ({ useOptionalAccount: () => null }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const forms = (id: string, name: string) => ({ success: true, data: [{ id, name }] })

test('取得済み0件と取得失敗を区別し、別アカウントに持ち越さない', async () => {
  calls.forms.mockResolvedValueOnce({ success: true, data: [] }).mockRejectedValueOnce(new Error('failure'))
  const change = vi.fn()
  const view = render(<EntityRemoteField kind="form" label="回答フォーム" accountId="account-a" value="missing" onChange={change} />)
  fireEvent.click(screen.getByRole('button', { name: '回答フォーム：変える' }))
  expect(await screen.findByText('回答フォームは今は選べません')).toBeTruthy()
  expect(screen.getByText('選び直してください。')).toBeTruthy()
  view.rerender(<EntityRemoteField kind="form" label="回答フォーム" accountId="account-b" value="missing" onChange={change} />)
  expect(screen.queryByText('回答フォームは今は選べません')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '回答フォーム：変える' }))
  expect(await screen.findByText('回答フォームを読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('回答フォームは今は選べません')).toBeNull()
  expect(change).not.toHaveBeenCalled()
})

test('読み込み失敗では確定できず、再試行後に名前で選んだ同じIDを返す', async () => {
  calls.forms.mockRejectedValueOnce(new Error('読み込み失敗')).mockResolvedValueOnce(forms('form-a', '相談フォーム'))
  const change = vi.fn()
  render(<EntityRemoteField kind="form" label="回答フォーム" accountId="account-a" value="" onChange={change} />)
  expect(calls.forms).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '回答フォーム：選ぶ' }))
  await screen.findAllByRole('alert')
  expect(screen.getByRole('button', { name: '選ぶ' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /もう一度|再読み込み|再試行/ }))
  fireEvent.click(await screen.findByRole('radio', { name: '相談フォーム' }))
  fireEvent.click(screen.getByRole('button', { name: '選ぶ' }))
  expect(change).toHaveBeenCalledWith('form-a')
  expect(calls.forms).toHaveBeenLastCalledWith('account-a')
})

test('アカウント切替で窓を閉じ、切替前の応答を捨てる', async () => {
  let resolve!: (value: ReturnType<typeof forms>) => void
  calls.forms.mockImplementationOnce(() => new Promise((done) => { resolve = done })).mockResolvedValueOnce(forms('form-b', 'B店のフォーム'))
  const view = render(<EntityRemoteField kind="form" label="回答フォーム" accountId="account-a" value="" onChange={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '回答フォーム：選ぶ' }))
  view.rerender(<EntityRemoteField kind="form" label="回答フォーム" accountId="account-b" value="" onChange={() => {}} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '回答フォーム：選ぶ' }))
  await screen.findByRole('radio', { name: 'B店のフォーム' })
  resolve(forms('form-a', 'A店のフォーム'))
  await waitFor(() => expect(screen.queryByRole('radio', { name: 'A店のフォーム' })).toBeNull())
})

test('計測リンクは選択アカウントのAPI、イベントは最後のページまで読む', async () => {
  calls.links.mockResolvedValue({ success: true, data: [{ id: 'link', name: '店頭' }] })
  expect(await loadEntityCandidates('tracked_link', 'account-a')).toEqual([{ id: 'link', name: '店頭' }])
  expect(calls.links).toHaveBeenCalledWith('account-a')
  calls.events.mockResolvedValueOnce({ items: [{ id: 'a', name: '説明会' }], total: 2 }).mockResolvedValueOnce({ items: [{ id: 'b', name: '個別相談' }], total: 2 })
  expect((await loadEntityCandidates('event', 'account-a')).map((item) => item.id)).toEqual(['a', 'b'])
  expect(calls.events).toHaveBeenLastCalledWith('account-a', { page: 2, limit: 100 })
})
