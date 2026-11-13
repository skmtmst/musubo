// @vitest-environment happy-dom
/*
 * 受信箱V4で既存機能を失わない：本物の受信箱（ChatsPage）を描き、通信（fetch）だけを差し替える。
 * - 顧客情報は会話IDではなく友だちIDで読み、右の列へ今のアカウントを渡す
 * - 見出しに本名、こちらの吹き出しに送った担当者の名前を出す
 * - 頭の担当・対応状況は、選んだ値で保存の口を呼ぶ（「すべて」は担当として送らない）
 * - テンプレートは選んでも送らず、書きかけの文を残して入力欄へ足す
 * - 同じ会話の読み直しが重なっても、遅れて届いた古い詳細で新しい表示を上書きしない
 * - ☆は注目の印（metadata.__attention）を保存する。内部メモは書き換えるまで保存できない
 * - メールの会話を開くと、その会話の既読の口を呼ぶ。担当の付け替えはメールの担当の口へ送る
 * LINE の既読・送信・注目・遅い応答・担当の絞り込みは app/chats/*-react.test.tsx が見る。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatsPage from '@/app/chats/page'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

const fixture = vi.hoisted(() => ({ params: new URLSearchParams() }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params, usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', selectedAccount: { emailInboxEnabled: true }, loading: false }),
}))

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
})
type Call = { method: string; path: string; search: URLSearchParams; body: unknown }
let calls: Call[]
/** 会話の詳細の n 回目の取得へ返す物を差し替える（無ければ既定の詳細）。 */
let detailFor: ((nth: number) => Promise<Response> | Response | null) | null
let detailReads: number
let host: HTMLDivElement
let root: Root

const at = '2026-10-01T01:00:00.000Z'
const chatRow = {
  id: 'chat-1', friendId: 'friend-a', friendName: '表示名の人', operatorId: 'op-k', status: 'unread', isUnread: false,
  lastMessageAt: at, lastMessageContent: '届きましたか', lastMessageType: 'text', lastMessageDirection: 'incoming',
}
const chatDetail = {
  id: 'chat-1', friendId: 'friend-a', friendName: '表示名の人', friendRealName: '山本 恭平', friendPictureUrl: 'https://img.example.test/face.png',
  isAttention: false, operatorId: 'op-k', status: 'unread', notes: null, revision: 4, lastMessageAt: at, createdAt: at, total: 2,
  messages: [
    { id: 'm-in', direction: 'incoming', messageType: 'text', content: '届きましたか', isUnsent: false, source: 'user',
      originKind: null, sentByStaffId: null, sentByStaffName: null, scenarioName: null, quoted: null, createdAt: at },
    { id: 'm-out', direction: 'outgoing', messageType: 'text', content: '届いています', isUnsent: false, source: 'manual',
      originKind: null, sentByStaffId: 'staff-1', sentByStaffName: '見本', scenarioName: null, quoted: null, createdAt: at },
  ],
  hasMoreMessages: false,
}
const emailItem = {
  id: 'email:thread-1', threadId: 'thread-1', customerName: 'メールの人', customerIdentifier: 'mail@example.test',
  subject: '発送について', preview: 'いつ届きますか', status: 'unread', assignedStaffId: null, isUnread: true,
  lastIncomingAt: at, lastMessageAt: at,
}

function respond(method: string, url: URL, body: unknown): Response | Promise<Response> {
  const path = url.pathname
  if (path === '/api/chats') return json({ success: true, data: [chatRow] })
  if (path === '/api/chats/stats') return json({ success: true, data: { total: 1, unread: 1, inProgress: 0, onHold: 0, resolved: 0, oldestUnansweredMinutes: null, assigneeUnread: [] } })
  if (path === '/api/support/inbox') return json({ success: true, data: { items: [emailItem], summary: { total: 1 } } })
  if (path === '/api/operators') return json({ success: true, data: [{ id: 'op-k', name: '見本' }, { id: 'op-m', name: '佐々木' }] })
  if (path === '/api/inbox/saved-views') return json({ success: true, data: [] })
  if (path === '/api/chats/chat-1' && method === 'PUT') {
    return json({ success: true, data: { ...chatDetail, ...(body as object), revision: 5 } })
  }
  if (path === '/api/chats/chat-1') {
    detailReads += 1
    const override = detailFor?.(detailReads)
    if (override) return override as Response
    return json({ success: true, data: chatDetail })
  }
  if (path === '/api/friends/friend-a') {
    return json({ success: true, data: {
      id: 'friend-a', displayName: '表示名の人', pictureUrl: null, isFollowing: true, metadata: {}, lineAccountId: 'account-a',
      realName: '山本 恭平', systemDisplayName: null, refCode: null, createdAt: at, tags: [], formSubmissions: [], support: null,
    } })
  }
  if (path.endsWith('/read')) return json({ success: true, data: { isUnread: false } })
  if (path === '/api/templates') {
    return json({ success: true, data: { items: [{
      id: 'tp-1', accountId: 'account-a', name: '発送のご案内', category: 'general', messageType: 'text',
      messageContent: '本日発送しました。', folderId: null, createdAt: at, updatedAt: at,
    }], total: 1, limit: 100 } })
  }
  if (path === '/api/support/email/threads/thread-1/assignee') return json({ success: true })
  if (path === '/api/support/email/threads/thread-1') {
    return json({ success: true, data: {
      thread: { id: 'thread-1', subject: '発送について', customer_name: 'メールの人', customer_email: 'mail@example.test',
        status: 'unread', assigned_staff_id: null, notes: null, revision: 1 },
      messages: [],
    } })
  }
  return json({ success: true, data: [] })
}

beforeEach(() => {
  calls = []
  detailFor = null
  detailReads = 0
  fixture.params = new URLSearchParams()
  document.documentElement.dataset.theme = 'v8'
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) })
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ method, path: url.pathname, search: url.searchParams, body })
    return await respond(method, url, body)
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  verifiedStaffRole('owner')
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); cleanup(); verifiedStaffRole(null)
  delete document.documentElement.dataset.theme
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function eventually(check: () => void, timeout = 2_000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

async function openLineChat() {
  await act(async () => root.render(<ChatsPage />))
  const row = () => host.querySelector<HTMLButtonElement>('button[aria-labelledby="chat-row-name-chat-1"]')
  await eventually(() => expect(row()).toBeTruthy())
  await act(async () => { row()!.click() })
  await eventually(() => expect(host.textContent).toContain('届いています'))
}

describe('受信箱V4で既存機能を失わない', () => {
  it('顧客情報は会話IDではなく友だちIDで読み、右の列へ今のアカウントを渡す', async () => {
    await openLineChat()
    const toggle = host.querySelector<HTMLButtonElement>('[data-inbox-v6="customer-info-toggle"]')!
    if (toggle.getAttribute('aria-expanded') !== 'true') await act(async () => { toggle.click() })
    await eventually(() => expect(calls.some((call) => call.path === '/api/friends/friend-a')).toBe(true))
    expect(calls.some((call) => call.path === '/api/friends/chat-1')).toBe(false)
    // 前払いのみの印は、その店（アカウント）でのその人の判定を読む。
    await eventually(() => {
      const noshow = calls.find((call) => call.path === '/api/booking/admin/friends/friend-a/noshow')
      expect(noshow?.search.get('account_id')).toBe('account-a')
    })
  })

  it('見出しに本名と顔の写真を、こちらの吹き出しに送った担当者の名前を出す', async () => {
    await openLineChat()
    expect(host.textContent).toContain('山本 恭平・LINE')
    expect(host.querySelector('img[src="https://img.example.test/face.png"]')).toBeTruthy()
    expect(host.textContent).toContain('見本 が送信')
  })

  it('頭の担当で「未割り当て」を選ぶと担当なしで保存する。候補に「すべて」は無い', async () => {
    await openLineChat()
    fireEvent.click(screen.getByRole('button', { name: '担当者を変える' }))
    const dialog = screen.getAllByRole('dialog').at(-1)!
    const names = within(dialog).getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'))
    expect(names).not.toContain('すべて')
    fireEvent.click(within(dialog).getByRole('radio', { name: '未割り当て' }))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ' })) })
    await eventually(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.path === '/api/chats/chat-1')
      expect(put?.body).toMatchObject({ operatorId: null, revision: 4 })
    })
  })

  it('頭の対応状況で選んだ状態を、そのまま保存する', async () => {
    await openLineChat()
    fireEvent.click(screen.getByRole('button', { name: '対応状況を変える' }))
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: '対応中' }).querySelector('button')!) })
    await eventually(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.path === '/api/chats/chat-1')
      expect(put?.body).toMatchObject({ status: 'in_progress', revision: 4 })
    })
  })

  it('メールの会話を開くと、その会話の既読の口を呼び、一覧の未読の印を外す', async () => {
    await act(async () => root.render(<ChatsPage />))
    const row = () => [...host.querySelectorAll<HTMLElement>('[data-inbox-v4="conversation-list"] button')].find((button) => button.textContent?.includes('メールの人'))
    await eventually(() => expect(row()).toBeTruthy())
    expect(row()!.querySelector('[aria-label="未読"]')).toBeTruthy()
    await act(async () => { row()!.click() })
    await eventually(() => expect(calls.some((call) => call.method === 'POST' && call.path === '/api/support/email/threads/thread-1/read')).toBe(true))
    expect(row()!.querySelector('[aria-label="未読"]')).toBeNull()
  })

  it('メールの会話でも頭の担当で選んだ人を、メールの担当の口へ送る', async () => {
    await act(async () => root.render(<ChatsPage />))
    const row = () => [...host.querySelectorAll<HTMLElement>('[data-inbox-v4="conversation-list"] button')].find((button) => button.textContent?.includes('メールの人'))
    await eventually(() => expect(row()).toBeTruthy())
    await act(async () => { row()!.click() })
    await eventually(() => expect(screen.getByRole('button', { name: '担当者を変える' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '担当者を変える' }))
    const dialog = screen.getAllByRole('dialog').at(-1)!
    await eventually(() => expect(within(dialog).getByRole('radio', { name: '佐々木' })).toBeTruthy())
    fireEvent.click(within(dialog).getByRole('radio', { name: '佐々木' }))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ' })) })
    await eventually(() => {
      const patch = calls.find((call) => call.method === 'PATCH' && call.path === '/api/support/email/threads/thread-1/assignee')
      expect(patch?.body).toMatchObject({ staffId: 'op-m', revision: 1 })
    })
  })

  it('テンプレートは選んでも送らず、書きかけの文を残して入力欄へ足す', async () => {
    await openLineChat()
    const box = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="メッセージを入力"], textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(box(), 'お待たせしました。')
      box().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('テンプレートを選択'))!.click() })
    await eventually(() => expect(screen.getByText('発送のご案内').closest('button')).toBeTruthy())
    fireEvent.click(screen.getByText('発送のご案内').closest('button')!)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '入力欄に入れる' })) })
    expect(box().value).toBe('お待たせしました。\n本日発送しました。')
    expect(calls.some((call) => call.method === 'POST' && /\/api\/chats\/chat-1\/(send|messages)/.test(call.path))).toBe(false)
  })

  it('☆を押すと、その人の注目の印を保存する', async () => {
    await openLineChat()
    await act(async () => { screen.getByRole('button', { name: '注目にする' }).click() })
    await eventually(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.path === '/api/friends/friend-a/metadata')
      expect(put?.body).toEqual({ __attention: '1' })
    })
  })

  it('内部メモは開いている間ボタン自身が印になり、書き換えるまで保存できない', async () => {
    await openLineChat()
    const toggle = host.querySelector<HTMLButtonElement>('[data-inbox-v6="internal-memo-toggle"]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { toggle.click() })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const save = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'メモを保存する')!
    expect(save().disabled).toBe(true)
    const area = document.querySelector<HTMLTextAreaElement>('[aria-labelledby="chat-internal-memo-title"] textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(area, '折り返し電話の約束')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(save().disabled).toBe(false)
    await act(async () => { save().click() })
    await eventually(() => {
      const put = calls.find((call) => call.method === 'PUT' && call.path === '/api/chats/chat-1')
      expect(put?.body).toMatchObject({ notes: '折り返し電話の約束' })
    })
  })

  it('同じ会話の読み直しが重なっても、遅れて届いた古い詳細で新しい表示を上書きしない', async () => {
    let releaseOld!: () => void
    const withMessage = (content: string, status: string) => json({ success: true, data: {
      ...chatDetail, status, messages: [{ ...chatDetail.messages[0], id: `m-${content}`, content }],
    } })
    detailFor = (nth) => {
      // 1回目は開いたとき。2回目（担当を変えた後の読み直し）だけ遅らせ、古い中身を返す。
      if (nth === 2) return new Promise<Response>((done) => { releaseOld = () => done(withMessage('古い本文', 'unread')) })
      if (nth >= 3) return withMessage('新しい本文', 'in_progress')
      return null
    }
    await openLineChat()
    fireEvent.click(screen.getByRole('button', { name: '担当者を変える' }))
    const dialog = screen.getAllByRole('dialog').at(-1)!
    fireEvent.click(within(dialog).getByRole('radio', { name: '佐々木' }))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ' })) })
    await eventually(() => expect(detailReads).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: '対応状況を変える' }))
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: '対応中' }).querySelector('button')!) })
    await eventually(() => expect(host.textContent).toContain('新しい本文'))

    await act(async () => { releaseOld(); await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(host.textContent).toContain('新しい本文')
    expect(host.textContent).not.toContain('古い本文')
  })
})
