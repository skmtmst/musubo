import { expect, it } from 'vitest'
import { oldestAttentionTarget } from './inbox-model'

const chat = (id: string, status: string, lastMessageAt: string | null) => ({ id, status, lastMessageAt }) as Parameters<typeof oldestAttentionTarget>[0][number]
const mail = (threadId: string, isUnread: boolean, lastMessageAt: string | null, lastIncomingAt: string, source: 'shared' | 'store' = 'shared') => ({ threadId, isUnread, lastMessageAt, lastIncomingAt, source })

it('未対応の中で最も古いLINE会話を選ぶ（新しい・対応済みは選ばない）', () => {
  const target = oldestAttentionTarget(
    [
      chat('new', 'unread', '2026-08-19T00:00:00.000Z'),
      chat('old', 'unread', '2026-08-11T00:00:00.000Z'),
      chat('done', 'resolved', '2026-08-01T00:00:00.000Z'),
    ],
    [],
  )
  expect(target).toEqual({ kind: 'chat', id: 'old' })
})

it('メールも混ぜて最も古い物を選ぶ（既読メールは選ばない）', () => {
  const target = oldestAttentionTarget(
    [chat('line', 'unread', '2026-08-19T00:00:00.000Z')],
    [
      mail('thread-old', true, null, '2026-08-10T00:00:00.000Z'),
      mail('thread-read', false, null, '2026-08-01T00:00:00.000Z'),
    ],
  )
  expect(target).toEqual({ kind: 'email', threadId: 'thread-old', source: 'shared' })
})

it('店舗のメールが最も古ければ、店舗の経路のまま行き先にする（同じ会話IDの共通メールと取り違えない）', () => {
  const target = oldestAttentionTarget(
    [],
    [
      mail('thread-same', true, null, '2026-08-12T00:00:00.000Z', 'shared'),
      mail('thread-same', true, null, '2026-08-09T00:00:00.000Z', 'store'),
    ],
  )
  expect(target).toEqual({ kind: 'email', threadId: 'thread-same', source: 'store' })
})

it('開いて既読にしたメールは、並びの未読が残っていても選ばない', () => {
  const target = oldestAttentionTarget([], [
    { ...mail('thread-opened', true, null, '2026-08-01T00:00:00.000Z', 'store'), readNow: true },
    mail('thread-next', true, null, '2026-08-05T00:00:00.000Z', 'shared'),
  ])
  expect(target).toEqual({ kind: 'email', threadId: 'thread-next', source: 'shared' })
})

it('時刻が無い・読めない物は選ばず、無ければ null', () => {
  expect(oldestAttentionTarget(
    [chat('no-time', 'unread', null), chat('bad-time', 'unread', 'not-a-date')],
    [mail('thread-bad', true, 'not-a-date', 'not-a-date')],
  )).toBeNull()
  expect(oldestAttentionTarget([], [])).toBeNull()
})
