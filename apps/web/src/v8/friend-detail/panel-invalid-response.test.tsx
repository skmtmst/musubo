// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ history: vi.fn(), forms: vi.fn() }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  const empty = async () => ({ success: true, data: {} })
  return { ...actual, fetchApi: net.history, api: { ...actual.api,
    friends: { ...actual.api.friends, get: async () => ({ success: true, data: { id: 'fixture' } }), upcoming: empty, mileage: empty, richMenu: empty, formSubmissions: net.forms },
    friendFields: { ...actual.api.friendFields, forFriend: async () => ({ success: true, data: { items: [], hiddenPersonalCount: 0 } }) },
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
  } }
})
import { useFriendDetail } from './use-friend-detail'
import FormsTab from './forms-tab'
import HistoryTab from './history-tab'
function View({ tab }: { tab: 'history' | 'forms' }) { const data = useFriendDetail('fixture', 'account-fixture', tab); return tab === 'forms' ? <FormsTab data={data} /> : <HistoryTab friend={{ createdAt: '' } as never} friendId="fixture" data={data} /> }
beforeEach(() => { net.history.mockReset(); net.forms.mockReset(); window.history.replaceState(null, '', '/friends/detail?id=fixture') })
afterEach(cleanup)
it('履歴の不正な行は空扱いや画面停止にせず、読み直せる', async () => {
  net.history.mockResolvedValueOnce({ success: true, data: { items: [null], nextCursor: null } }).mockResolvedValueOnce({ success: true, data: { items: [], nextCursor: null } })
  render(<View tab="history" />)
  expect(await screen.findByText('履歴を読み込めませんでした。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('友だちに追加されました')).toBeTruthy()
})
it('フォーム回答の不正な行は空扱いや画面停止にせず、読み直せる', async () => {
  net.forms.mockResolvedValueOnce({ success: true, data: { items: [null], total: 1, nextCursor: null } }).mockResolvedValueOnce({ success: true, data: { items: [], total: 0, nextCursor: null } })
  render(<View tab="forms" />)
  expect(await screen.findByText('回答を読み込めませんでした。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('フォームの回答はまだありません。')).toBeTruthy()
})
