// @vitest-environment happy-dom
/*
 * 受信箱の絞り込みパネルの「担当者で絞り込む」に添える担当者ごとの未読数（設計 `YZaDK`）を、本物の画面で見る。
 * 数の規則そのものは assignee-unread.test.ts、ここは画面の配線：
 * - 数は集計の口（/api/chats/stats）から引く。画面に見えている行からは数えない
 * - 集計に失敗したら数だけ「—」。0件にせず、担当者の候補は残す
 * - アカウントを切り替えたら、新しい集計が届くまで前のアカウントの数を出さない
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findPickerDialog } from '@/components/shared/entity-picker-test-helpers'
import ChatsPage from '@/app/chats/page'

const fixture = vi.hoisted(() => ({ accountId: 'account-a', params: new URLSearchParams() }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params, usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: fixture.accountId, selectedAccount: null, loading: false,
}) }))

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
})
type Stats = { operatorId: string | null; unread: number }[]
let stats: (url: URL) => Promise<Response> | Response
let statsCalls: URL[]
let host: HTMLDivElement
let root: Root

const statsBody = (assigneeUnread: Stats) => json({ success: true, data: {
  total: 5, unread: 5, inProgress: 0, onHold: 0, resolved: 0, oldestUnansweredMinutes: null, assigneeUnread,
} })

function respond(url: URL): Promise<Response> | Response {
  if (url.pathname === '/api/chats/stats') { statsCalls.push(url); return stats(url) }
  // 画面に見えている会話は佐々木さん担当の1件だけ。見本さんの未読はこのページに無い。
  if (url.pathname === '/api/chats') return json({ success: true, data: [{
    id: 'chat-1', friendId: 'friend-1', friendName: '見えている人', operatorId: 'op-m', status: 'unread', isUnread: true,
    lastMessageAt: '2026-10-01T00:00:00.000Z', lastMessageContent: 'こんにちは', lastMessageType: 'text', lastMessageDirection: 'incoming',
  }] })
  if (url.pathname === '/api/support/inbox') return json({ success: true, data: { items: [], summary: { total: 0 } } })
  if (url.pathname === '/api/operators') return json({ success: true, data: [{ id: 'op-k', name: '見本' }, { id: 'op-m', name: '佐々木' }] })
  if (url.pathname === '/api/inbox/saved-views') return json({ success: true, data: [] })
  return json({ success: true, data: [] })
}

beforeEach(() => {
  fixture.accountId = 'account-a'
  statsCalls = []
  stats = () => statsBody([{ operatorId: 'op-k', unread: 3 }, { operatorId: null, unread: 2 }])
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('fetch', (input: string | URL) => respond(new URL(String(input), 'http://localhost')))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}

/** パネルの「担当者で絞り込む」を開き、候補の読み上げ名と窓の文を返して閉じる。 */
async function assigneeChoices(): Promise<{ names: string[]; pickerText: string }> {
  fireEvent.click(await screen.findByRole('button', { name: '絞り込み' }))
  fireEvent.click(await screen.findByRole('button', { name: /^担当者で絞り込む$/ }))
  const dialog = await findPickerDialog()
  const names = within(dialog).getAllByRole('radio').map((radio) => radio.getAttribute('aria-label') ?? '')
  const pickerText = dialog.textContent ?? ''
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await settle()
  return { names, pickerText }
}

describe('担当者ごとの未読数の配線（YZaDK）', () => {
  it('数は集計の口から引き、見えている行からは数えない（集計に出ない担当は0）', async () => {
    await act(async () => root.render(<ChatsPage />))
    await settle()
    expect(statsCalls.length).toBeGreaterThan(0)
    expect(statsCalls.every(call => call.searchParams.get('lineAccountId') === 'account-a')).toBe(true)
    const { names, pickerText } = await assigneeChoices()
    expect(names).toEqual(expect.arrayContaining(['見本（3）', '佐々木（0）']))
    expect(pickerText).toContain('未読 2件')
  })

  it('集計が届くまでは0件ではなく「—」（初めの値は未取得）', async () => {
    stats = () => new Promise<Response>(() => {})
    await act(async () => root.render(<ChatsPage />))
    await settle()
    const { names } = await assigneeChoices()
    expect(names).toEqual(expect.arrayContaining(['見本（—）', '佐々木（—）']))
    expect(names.some((name) => /（0）/.test(name))).toBe(false)
  })

  it('集計に失敗したら数だけ「—」にして、担当者の候補は残す', async () => {
    stats = () => json({ success: false, error: 'down' }, 500)
    await act(async () => root.render(<ChatsPage />))
    await settle()
    const { names, pickerText } = await assigneeChoices()
    expect(names).toEqual(expect.arrayContaining(['見本（—）', '佐々木（—）']))
    expect(pickerText).toContain('未読 —')
    expect(names.some((name) => /（0）/.test(name))).toBe(false)
  })

  it('アカウントを切り替えたら、新しい集計が届くまで前のアカウントの数を出さない', async () => {
    await act(async () => root.render(<ChatsPage />))
    await settle()
    expect((await assigneeChoices()).names).toContain('見本（3）')

    let release!: () => void
    stats = () => new Promise<Response>((done) => { release = () => done(statsBody([{ operatorId: 'op-k', unread: 7 }])) })
    fixture.accountId = 'account-b'
    const before = statsCalls.length
    await act(async () => root.render(<ChatsPage />))
    await settle()
    expect(statsCalls.length).toBeGreaterThan(before)
    expect(statsCalls.slice(before).every(call => call.searchParams.get('lineAccountId') === 'account-b')).toBe(true)
    expect((await assigneeChoices()).names).toContain('見本（—）')

    await act(async () => { release(); await Promise.resolve() })
    await settle()
    expect((await assigneeChoices()).names).toContain('見本（7）')
  })
})
