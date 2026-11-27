// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatDetail, ChatListItem } from '@/lib/api'
const fx = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), fetchApi: fx.request }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
import { useInboxActions } from './use-inbox-actions'
function Screen() {
  const [chatDetail, setChatDetail] = useState({ id: 'a', friendId: 'a', isAttention: false, notes: '' } as ChatDetail)
  const [chats, setChats] = useState([{ id: 'a', friendId: 'a', isAttention: false }] as ChatListItem[])
  const [error, setError] = useState('')
  const actions = useInboxActions({ chatDetail, selectedChatId: 'a', setChatDetail, setChats, setError, loadChatDetail: vi.fn(), loadChats: vi.fn() })
  return <><button onClick={() => void actions.handleAttentionUpdate()}>注目を変更</button><p>{chatDetail.isAttention ? '注目中' : '未注目'}</p><p>{chats[0].isAttention ? '一覧も注目中' : '一覧も未注目'}</p><p>{error}</p></>
}
beforeEach(() => { fx.request.mockReset() })
afterEach(cleanup)
it('保存が拒否されたら注目の表示を戻して理由を出す', async () => {
  fx.request.mockResolvedValueOnce({ success: true, data: { updatedAt: 'v1' } }).mockResolvedValueOnce({ success: false })
  render(<Screen />)
  fireEvent.click(screen.getByRole('button', { name: '注目を変更' }))
  expect(await screen.findByText('注目の変更に失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy()
  expect(screen.getByText('未注目')).toBeTruthy()
  expect(screen.getByText('一覧も未注目')).toBeTruthy()
})

it('版を取得できなければ変更を送らず、注目の表示を戻す', async () => {
  fx.request.mockResolvedValueOnce({ success: false, data: { updatedAt: 'v1' } })
  render(<Screen />)
  fireEvent.click(screen.getByRole('button', { name: '注目を変更' }))
  expect(await screen.findByText('注目の変更に失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy()
  expect(screen.getByText('未注目')).toBeTruthy()
  expect(fx.request).toHaveBeenCalledTimes(1)
})
