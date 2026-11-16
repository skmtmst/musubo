// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api, type ChatListItem } from '@/lib/api'
import InstagramConversation from './instagram-conversation'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'

const chat = { id: 'ig:1', friendId: 'customer', friendName: 'Instagramユーザー', lineAccountId: 'a1' } as ChatListItem
const messages = [{ id: 'm1', direction: 'incoming' as const, content: 'こんにちは', createdAt: '2026-11-16T00:00:00Z' }]
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('会話を開き返信を送る', async () => {
  vi.spyOn(api.instagram, 'conversation').mockResolvedValue({ success: true, data: { messages, replyState: 'ready' } })
  vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
  const send = vi.spyOn(api.instagram, 'sendReply').mockResolvedValue({})
  render(<InstagramConversation chat={chat} role="owner" onChanged={() => {}} />)
  expect(await screen.findByText('こんにちは')).toBeTruthy()
  const refresh = vi.fn()
  window.addEventListener(UNANSWERED_REFRESH_EVENT, refresh)
  fireEvent.change(screen.getByLabelText('メッセージを入力'), { target: { value: '返信' } })
  fireEvent.click(screen.getByRole('button', { name: '送る' }))
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  expect(send.mock.calls[0].slice(0, 3)).toEqual(['a1', 'm1', '返信'])
  await waitFor(() => expect(refresh).toHaveBeenCalled())
  window.removeEventListener(UNANSWERED_REFRESH_EVENT, refresh)
})
it.each([['disconnected', '接続が切れているため返信できません'], ['permission_required', 'DMの権限がありません']] as const)('%s の理由を示し返信を止める', async (replyState, reason) => {
  vi.spyOn(api.instagram, 'conversation').mockResolvedValue({ success: true, data: { messages, replyState } })
  vi.spyOn(api.instagram, 'markConversationRead').mockResolvedValue({})
  render(<InstagramConversation chat={chat} role="owner" onChanged={() => {}} />)
  expect(await screen.findByText(new RegExp(reason))).toBeTruthy()
  expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true)
})
it('閲覧のみの人は会話を読めるが返信できない', async () => {
  vi.spyOn(api.instagram, 'conversation').mockResolvedValue({ success: true, data: { messages, replyState: 'ready' } })
  const send = vi.spyOn(api.instagram, 'sendReply').mockResolvedValue({})
  render(<InstagramConversation chat={chat} role="viewer" onChanged={() => {}} />)
  expect(await screen.findByText('こんにちは')).toBeTruthy()
  expect(screen.getByText('閲覧のみの権限では返信できません。')).toBeTruthy()
  expect((screen.getByRole('button', { name: '送る' }) as HTMLButtonElement).disabled).toBe(true)
  expect(send).not.toHaveBeenCalled()
})
