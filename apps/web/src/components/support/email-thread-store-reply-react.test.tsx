// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import EmailThread from './email-thread'

/*
 * 受信専用の店舗のメールの会話。預かりに書きかけがあっても、欄には値を出さず理由をそのまま見せる。
 * 書きかけは消さない（同じ預かりを使う共通メールの下書きを壊さない）。
 */
const REASON = '転送メールは受信専用です。返信は共通メールか LINE から'
const thread = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, accountEmail: { ...actual.api.accountEmail, thread } } }
})
vi.mock('../chats/template-picker', () => ({ default: () => null }))
afterEach(cleanup)

it('受信専用の店舗の会話は、預かりに書きかけがあっても欄に値を出さず理由を見せ、書きかけは消さない', async () => {
  thread.mockResolvedValue({ success: true, data: {
    thread: { id: 's1', subject: '見本の件名', customer_name: '見本 店舗の客', customer_email: 'mihon-store@example.com', status: 'unread', assigned_staff_id: null, notes: null, revision: 1 },
    messages: [{ id: 'm1', direction: 'incoming', body_text: '見本の本文', sent_by_staff_name: null, created_at: '2026-11-24T01:00:00.000Z' }],
    hasMoreOlder: false, oldestCursor: null, newestCursor: '2026-11-24T01:00:00.000Z~m1',
  } })
  const drafts = new Map([['s1', '前の書きかけ']])
  render(<EmailThread threadId="s1" storeAccountId="account-a" sourceLabel="店舗" replyLockedReason={REASON} draftStore={drafts} onBack={() => {}} />)
  const field = await screen.findByLabelText('メールの返信を入力') as HTMLTextAreaElement
  expect(thread).toHaveBeenCalledWith('account-a', 's1', { after: null })
  expect(field.value).toBe('')
  expect(field.placeholder).toBe(REASON)
  expect(field.readOnly).toBe(true)
  expect(drafts.get('s1')).toBe('前の書きかけ')
})
