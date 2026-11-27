// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const list = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, chats: { ...actual.api.chats, savedViews: { ...actual.api.chats.savedViews, list } } } }
})
import { useInboxSavedViews } from './use-inbox-saved-views'
const noop = () => {}
const params = new URLSearchParams()
const router = { replace: noop, push: noop }
function Demo() {
  const views = useInboxSavedViews({ operators: [], setNameQuery: noop, setStatusFilter: noop, setAssigneeFilter: noop,
    setQuickFilter: noop, setUnreadOnly: noop, params: params as never, router: router as never,
    selectedAccountId: 'sample-account', savedViewParam: '', accountsLoading: false, setDebouncedNameQuery: noop,
    channel: 'all', quickFilter: 'all', nameQuery: '', statusFilter: 'all', assigneeFilter: 'all', unreadOnly: false })
  return <div>{views.savedViewError ? <p role="alert">{views.savedViewError}</p> : null}
    <ul>{views.savedViews.map(view => <li key={view.id}>{view.name}</li>)}</ul>
    <button onClick={() => void views.loadSavedViews()}>もう一度読み込む</button></div>
}
function pending() { let resolve!: (value: unknown) => void; let reject!: (error: Error) => void; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const result = (name: string) => ({ success: true, data: [{ id: name, name, conditions: {}, createdBy: null, isShared: false }] })
beforeEach(() => list.mockReset())
afterEach(() => cleanup())

it('新しい一覧の後に古い応答が届いても、新しい一覧を保つ', async () => {
  const old = pending(), latest = pending()
  list.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  render(<Demo />)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await act(async () => latest.resolve(result('新しい検索')))
  expect(screen.getByText('新しい検索')).toBeTruthy()
  await act(async () => old.resolve(result('古い検索')))
  expect(screen.getByText('新しい検索')).toBeTruthy()
  expect(screen.queryByText('古い検索')).toBeNull()
})

it('新しい一覧の後の古い失敗は、読み込み失敗として表示しない', async () => {
  const old = pending(), latest = pending()
  list.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  render(<Demo />)
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await act(async () => latest.resolve(result('新しい検索')))
  await act(async () => old.reject(new Error('見本の通信失敗')))
  expect(screen.getByText('新しい検索')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})
