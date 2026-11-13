import { describe, expect, it } from 'vitest'

import { buildOutgoingMessage, refreshChatListAfterSend } from '@/v8/inbox-chat/send-optimistic'

interface Row {
  id: string
  lastMessageAt: string | null
  status: 'unread' | 'in_progress' | 'on_hold' | 'resolved'
  lastMessageContent: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  lastMessageType: string | null
}

function row(patch: Partial<Row> & { id: string }): Row {
  return {
    lastMessageAt: null,
    status: 'unread',
    lastMessageContent: null,
    lastMessageDirection: null,
    lastMessageType: null,
    ...patch,
  }
}

/**
 * 点検 #493 の10番（送信の楽観更新が画像・本文の2経路で複製）に対する
 * 再発防止。2経路が同じ共通処理に寄っていることを、振る舞いで確かめる。
 */
describe('送信後の一覧の当て直し', () => {
  const update = (c: Row): Row => (c.id === 'b' ? {
    ...c,
    lastMessageAt: '2026-09-08T10:00:00.000Z',
    status: 'in_progress',
    lastMessageContent: 'こんにちは',
    lastMessageDirection: 'outgoing',
    lastMessageType: 'text',
  } : c)

  it('送った行だけ時刻・対応中・プレビューが変わる', () => {
    const prev = [
      row({ id: 'a', lastMessageAt: '2026-09-08T09:00:00.000Z' }),
      row({ id: 'b', lastMessageAt: '2026-09-08T08:00:00.000Z' }),
    ]
    const next = refreshChatListAfterSend(prev, 'all', update)
    expect(next.map((r) => r.id)).toEqual(['b', 'a'])
    expect(next[0]).toMatchObject({
      status: 'in_progress',
      lastMessageContent: 'こんにちは',
      lastMessageDirection: 'outgoing',
      lastMessageType: 'text',
    })
    expect(next[1]).toMatchObject({ status: 'unread', lastMessageContent: null })
  })

  it('別の絞り込みを見ているときは送った行が一覧から外れる', () => {
    const prev = [
      row({ id: 'a', status: 'unread' }),
      row({ id: 'b', status: 'unread' }),
    ]
    const next = refreshChatListAfterSend(prev, 'unread', update)
    expect(next.map((r) => r.id)).toEqual(['a'])
  })

  it('一覧に無い会話の送信では何も変えない', () => {
    const prev = [row({ id: 'a', lastMessageAt: '2026-09-08T09:00:00.000Z' })]
    const next = refreshChatListAfterSend(prev, 'all', (c) => c)
    expect(next).toEqual(prev)
  })
})

describe('送った文面の楽観表示', () => {
  it('口の実応答と同じ形で作る（senderType は無い）', () => {
    const message = buildOutgoingMessage({
      messageType: 'text',
      content: 'こんにちは',
      sentByStaffName: '見本',
      sentAt: '2026-09-08T10:00:00.000Z',
    })
    expect(message).toMatchObject({
      direction: 'outgoing',
      messageType: 'text',
      content: 'こんにちは',
      sentByStaffName: '見本',
      createdAt: '2026-09-08T10:00:00.000Z',
    })
    expect(message).not.toHaveProperty('senderType')
    expect(message.source).toBeNull()
    expect(message.scenarioName).toBeNull()
  })

  it('作るたびに別の仮IDを振る', () => {
    const first = buildOutgoingMessage({
      messageType: 'text', content: 'a', sentByStaffName: '見本', sentAt: '2026-09-08T10:00:00.000Z',
    })
    const second = buildOutgoingMessage({
      messageType: 'text', content: 'a', sentByStaffName: '見本', sentAt: '2026-09-08T10:00:00.000Z',
    })
    expect(first.id).not.toBe(second.id)
  })
})
