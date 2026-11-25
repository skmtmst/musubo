// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import ChatsPage from '@/app/chats/page'

/*
 * 店舗を切り替えた直後の1描画でも、前の店舗の Instagram の会話を出さない。
 * 中央と右の欄は、描いた瞬間の店舗と会話の店舗を書き残す。1度でも食い違ったら落とす。
 */
const fixture = vi.hoisted(() => ({
  accountId: 'account-a',
  params: new URLSearchParams('channel=instagram'),
  rendered: [] as Array<{ part: string; chatAccount: string | undefined; selected: string; lastMessageAt?: string }>,
  polls: [] as Array<() => Promise<void>>,
}))
// 定期更新は手で1回ずつ回す（5秒を待たない）。
vi.mock('@/lib/visible-polling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/visible-polling')>()),
  startVisiblePoll: ({ work }: { work: () => Promise<void> }) => {
    fixture.polls.push(work)
    return { stop() { fixture.polls = fixture.polls.filter((item) => item !== work) }, wake() {} }
  },
}))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {} }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: fixture.accountId, selectedAccount: { emailInboxEnabled: true }, loading: false,
}) }))
vi.mock('./instagram-conversation', () => ({
  default: ({ chat }: { chat: { lineAccountId?: string; friendName: string; lastMessageAt?: string } }) => {
    fixture.rendered.push({ part: 'conversation', chatAccount: chat.lineAccountId, selected: fixture.accountId, lastMessageAt: chat.lastMessageAt })
    return <section data-testid="instagram-conversation">{`会話：${chat.friendName}`}</section>
  },
}))
vi.mock('./instagram-customer-info', () => ({
  default: ({ chat }: { chat: { lineAccountId?: string } }) => {
    fixture.rendered.push({ part: 'customer', chatAccount: chat.lineAccountId, selected: fixture.accountId })
    return <div data-testid="instagram-customer" />
  },
}))

let root: Root
let host: HTMLDivElement
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
const instagramRow = (account: string, name: string, lastMessageAt = '2026-11-20T00:00:00.000Z') => ({
  id: `ig-${account}`, friendId: `sender-${account}`, friendName: name, operatorId: null,
  status: 'unread', isUnread: true, lastMessageAt,
  lastMessageContent: name, lastMessageType: 'text', lastMessageDirection: 'incoming',
  channel: 'instagram', lineAccountId: account, instagramId: `ig-business-${account}`,
})
let chatsFor: (account: string | null) => Promise<Response> | Response

async function eventually(check: () => void, timeout = 1000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.params = new URLSearchParams('channel=instagram')
  fixture.rendered = []
  fixture.polls = []
  chatsFor = (account) => response({ success: true, data: account === 'account-a' ? [instagramRow('account-a', 'A店のお客さま')] : [] })
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/chats') return chatsFor(url.searchParams.get('lineAccountId'))
    if (url.pathname === '/api/support/inbox') return response({ success: true, data: { items: [], hasMore: false } })
    if (url.pathname === '/api/chats/stats') return response({ success: true, data: { total: 0, unread: 0, assigneeUnread: [], waiting: 0, waitingOverAnHour: 0 } })
    return response({ success: true, data: [] })
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

test('店舗を切り替えた直後でも、前の店舗の Instagram の会話と右の欄を描かない', async () => {
  await act(async () => root.render(<ChatsPage />))
  const row = () => [...host.querySelectorAll<HTMLButtonElement>('[data-inbox-v4="conversation-list"] button')]
    .find((button) => button.textContent?.includes('A店のお客さま'))
  await eventually(() => expect(row()).toBeTruthy())
  await act(async () => { row()!.click() })
  await eventually(() => expect(host.textContent).toContain('会話：A店のお客さま'))
  expect(fixture.rendered.some((entry) => entry.part === 'conversation')).toBe(true)

  // 次の店舗の一覧は届かないまま（読み込み中）にして、切り替えた直後の描画だけを見る。
  chatsFor = () => new Promise<Response>(() => undefined)
  fixture.accountId = 'account-b'
  await act(async () => root.render(<ChatsPage />))

  expect(host.textContent).not.toContain('会話：A店のお客さま')
  expect(fixture.rendered.filter((entry) => entry.chatAccount !== entry.selected)).toEqual([])
})

const lastConversation = () => fixture.rendered.filter((entry) => entry.part === 'conversation').at(-1)

test('開いた Instagram の会話には、一覧の定期更新で届いた新着の時刻を渡す（選んだ時の写しのままにしない）', async () => {
  await act(async () => root.render(<ChatsPage />))
  const row = () => [...host.querySelectorAll<HTMLButtonElement>('[data-inbox-v4="conversation-list"] button')]
    .find((button) => button.textContent?.includes('A店のお客さま'))
  await eventually(() => expect(row()).toBeTruthy())
  await act(async () => { row()!.click() })
  await eventually(() => expect(lastConversation()?.lastMessageAt).toBe('2026-11-20T00:00:00.000Z'))

  chatsFor = () => response({ success: true, data: [instagramRow('account-a', 'A店のお客さま', '2026-11-21T03:00:00.000Z')] })
  await act(async () => { for (const work of [...fixture.polls]) await work().catch(() => undefined) })

  await eventually(() => expect(lastConversation()?.lastMessageAt).toBe('2026-11-21T03:00:00.000Z'))
  expect(host.textContent).toContain('会話：A店のお客さま')
})
