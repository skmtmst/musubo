// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatListItem } from '@/lib/api'
import { MobileTalkList } from '@/components/templates/mobile-talk-list'
import { talkItem } from './mobile-talk-item'

vi.mock('next/link', () => ({ default: ({ children, href, ...props }: React.PropsWithChildren<{ href: string }>) => <a href={href} {...props}>{children}</a> }))
const chat = {
  id: 'chat-a', friendId: 'friend-a', friendName: '山田', friendPictureUrl: null,
  lastMessageAt: '2026-11-26T03:00:00Z', lastMessageDirection: 'incoming', isUnread: false,
  lastMessageType: 'text', lastMessageContent: 'こんにちは',
} as ChatListItem
const show = (item: ChatListItem) => {
  const onOpen = vi.fn()
  render(<MobileTalkList label="トーク" items={[talkItem(item)]} onOpen={onOpen} />)
  return onOpen
}
afterEach(cleanup)

it('名前の形が不正でも会話を開ける', () => {
  const open = show({ ...chat, friendName: { invalid: true } } as unknown as ChatListItem)
  expect(screen.getByText('名前を確認できません')).toBeTruthy()
  fireEvent.click(screen.getByRole('link', { name: /名前を確認できません/ }))
  expect(open).toHaveBeenCalledOnce()
})

it('未読の形が不正なら未読と決めつけず、確認できないと知らせる', () => {
  const open = show({ ...chat, isUnread: 'false' } as unknown as ChatListItem)
  expect(screen.getByText(/未読状態を確認できません/)).toBeTruthy()
  expect(screen.queryByText('未読。')).toBeNull()
  fireEvent.click(screen.getByRole('link', { name: /山田/ }))
  expect(open).toHaveBeenCalledOnce()
})
