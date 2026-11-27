// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ summary: vi.fn(), draft: vi.fn() }))
vi.mock('@/lib/environment-features', () => ({ conversationAiUiEnabled: () => true }))
vi.mock('./use-ai-settings', () => ({ useAiSettings: () => ({ mode: 'draft_only', permissions: { seeSummary: true, useDraft: true } }) }))
vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, aiReplyApi: { ...actual.aiReplyApi, summary: calls.summary, draft: calls.draft } }
})
import { InboxAiDraft, InboxAiSummary, useInboxAi } from './inbox-ai'
function Demo({ message = 'first', account = 'sample-account' }: { message?: string; account?: string }) {
  const ai = useInboxAi('sample-chat', account, [{ id: message, direction: 'incoming' }])
  return <><InboxAiSummary inboxAi={ai} /><InboxAiDraft inboxAi={ai} onInsert={() => {}} /></>
}
function pending() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const summary = (text: string) => ({ data: { lines: [text], generatedAt: '2026-11-27T00:00:00Z', basedOnMessageId: null } })
const draft = (text: string) => ({ data: { text, sources: [], generatedAt: '2026-11-27T00:00:00Z' } })
beforeEach(() => { vi.clearAllMocks(); calls.summary.mockReturnValue(new Promise(() => {})); calls.draft.mockReturnValue(new Promise(() => {})) })
afterEach(() => cleanup())

it('作り直した要約のあとに古い結果が届いても、新しい要約を保つ', async () => {
  const old = pending(), latest = pending()
  calls.summary.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  render(<Demo />)
  fireEvent.click(screen.getByRole('button', { name: '要約の操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: '作り直す' }))
  await act(async () => latest.resolve(summary('新しい要約')))
  expect(screen.getByText('新しい要約')).toBeTruthy()
  await act(async () => old.resolve(summary('古い要約')))
  expect(screen.getByText('新しい要約')).toBeTruthy()
  expect(screen.queryByText('古い要約')).toBeNull()
})
