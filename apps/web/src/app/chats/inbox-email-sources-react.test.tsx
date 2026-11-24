// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import ChatsPage from './page'

/*
 * 受信箱のメールは、既存の共通メール（/api/support/*）と店舗の転送メール（/api/account-email/:accountId/*）を
 * 1本の一覧に出し、行の札で分け、会話・既読・返信はそのメールが届いた経路の口だけを使う。
 * 本物の ChatsPage・本物の api と、口を模した fetch で、一覧・検索・続き・権限・件数の条件・押した先・失敗を確かめる。
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string | null,
  account: { emailInboxEnabled: true, accountEmailInboxEnabled: true } as Record<string, unknown>,
  params: new URLSearchParams(),
  role: 'staff' as string | null,
}))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {} }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: fixture.accountId, selectedAccount: fixture.account, loading: false, error: null,
  accounts: [], refreshAccounts: async () => {},
}) }))
vi.mock('@/lib/staff-role', async (original) => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => fixture.role }))

type Mail = {
  id: string; threadId: string; customerName: string; customerIdentifier: string; subject: string; preview: string
  status: 'unread' | 'in_progress' | 'on_hold' | 'resolved'; revision: number; assignedStaffId: string | null
  assignedStaffName: string | null; lastMessageAt: string; lastIncomingAt: string; isUnread: boolean; body: string
}
const mail = (threadId: string, name: string, isUnread: boolean, at: string, body = `${name}の本文`): Mail => ({
  id: `email:${threadId}`, threadId, customerName: name, customerIdentifier: `${threadId}@example.com`, subject: `${name}の件名`,
  preview: body.slice(0, 20), status: isUnread ? 'unread' : 'in_progress', revision: 3, assignedStaffId: null, assignedStaffName: null,
  lastMessageAt: at, lastIncomingAt: at, isUnread, body,
})
/** 口と同じ並び（未読が先→新しい順→id）。 */
const ordered = (rows: Mail[]) => [...rows].sort((a, b) => Number(b.isUnread) - Number(a.isUnread) || b.lastMessageAt.localeCompare(a.lastMessageAt) || b.threadId.localeCompare(a.threadId))

let shared: Mail[]
let store: Mail[]
/** 口の1ページの件数（画面は200を送る。ここでは続きを確かめるために小さく切る）。 */
let pageSize: number
let fail: { shared: number | null; store: number | null }
/** ログイン中の担当者が既読にした会話（経路:会話ID）。口の並び（未読が先）と未読だけの絞りに効く。 */
let readByMe: Set<string>
/** 続きの一覧の応答を止めておく門。開くと、その時点の口の並びで応答を作る。 */
let listGate: Promise<void> | null
let calls: Array<{ method: string; url: URL; body: string }>
let root: Root
let host: HTMLDivElement

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
function page(source: 'shared' | 'store', rows: Mail[], url: URL, withNextOffset: boolean) {
  const q = (url.searchParams.get('q') ?? '').toLowerCase()
  const status = url.searchParams.get('status') ?? 'all'
  const current = rows.map(row => ({ ...row, isUnread: row.isUnread && !readByMe.has(`${source}:${row.threadId}`) }))
  const matched = ordered(current).filter(row => (!q || [row.customerName, row.customerIdentifier, row.subject, row.body].some(value => value.toLowerCase().includes(q)))
    && (status === 'all' || row.status === status)
    && (url.searchParams.get('unreadOnly') !== '1' || row.isUnread))
  const offset = Number(url.searchParams.get('offset') ?? 0)
  // 本文は検索だけに使う（一覧の口は本文を返さない）。
  const items = matched.slice(offset, offset + pageSize).map((row) => {
    const listed: Partial<Mail> = { ...row }
    delete listed.body
    return listed
  })
  // 共通の口は末尾を越えると窓の集計が無くなり総数0になる。店舗の口は nextOffset を返す。
  const total = items.length === 0 && !withNextOffset ? 0 : matched.length
  return response({ success: true, data: {
    items, summary: { total, email: total }, ...(withNextOffset ? { nextOffset: offset + pageSize < matched.length ? offset + pageSize : null } : {}),
  } })
}
function thread(row: Mail | undefined) {
  if (!row) return response({ success: false, error: 'THREAD_NOT_FOUND' }, 404)
  return response({ success: true, data: {
    thread: { id: row.threadId, subject: row.subject, customer_name: row.customerName, customer_email: row.customerIdentifier, status: row.status, assigned_staff_id: null, notes: null, revision: row.revision },
    messages: [{ id: `${row.threadId}-m1`, direction: 'incoming', body_text: row.body, sent_by_staff_name: null, created_at: row.lastMessageAt }],
    hasMoreOlder: false, oldestCursor: null, newestCursor: `${row.lastMessageAt}~${row.threadId}-m1`,
  } })
}
function handle(method: string, url: URL): Response {
  const path = url.pathname
  if (path === '/api/chats') return response({ success: true, data: [] })
  if (path === '/api/support/inbox') return fail.shared ? response({ success: false, error: 'denied' }, fail.shared) : page('shared', shared, url, false)
  if (path === '/api/account-email/account-a/inbox' || path === '/api/account-email/account-b/inbox') {
    return fail.store ? response({ success: false, error: 'boom' }, fail.store) : page('store', store, url, true)
  }
  const sharedThread = /^\/api\/support\/email\/threads\/([^/]+)(\/[a-z]+)?$/.exec(path)
  if (sharedThread) {
    if (sharedThread[2] === '/read' && method === 'POST') readByMe.add(`shared:${sharedThread[1]}`)
    return sharedThread[2] ? response({ success: true, data: {} }) : thread(shared.find(row => row.threadId === sharedThread[1]))
  }
  const storeThread = /^\/api\/account-email\/account-a\/threads\/([^/]+)(\/[a-z]+)?$/.exec(path)
  if (storeThread) {
    if (storeThread[2] === '/read' && method === 'POST') readByMe.add(`store:${storeThread[1]}`)
    return storeThread[2] ? response({ success: true, data: { marked: true } }) : thread(store.find(row => row.threadId === storeThread[1]))
  }
  if (path === '/api/operators') return response({ success: true, data: [{ id: 'operator-a', name: '見本 担当A' }] })
  if (path === '/api/chats/quick-counts') return response({ success: true, data: { all: 3, reply: 2, overdue: 0, line: { all: 0, reply: 0, overdue: 0 }, email: { all: 3, reply: 2, overdue: 0 } } })
  if (path === '/api/chats/stats') return response({ success: true, data: { total: 0, unread: 0, assigneeUnread: [], waiting: 0, waitingOverAnHour: 0 } })
  if (method !== 'GET') return response({ success: true, data: {} })
  return response({ success: true, data: [] })
}

const list = () => host.querySelector<HTMLElement>('[data-inbox-v4="conversation-list"]')!
const rowKeys = () => [...host.querySelectorAll<HTMLElement>('[data-email-row]')].map(row => row.dataset.emailRow)
const row = (key: string) => host.querySelector<HTMLElement>(`[data-email-row="${key}"]`)
const callsTo = (path: string, method = 'GET') => calls.filter(call => call.url.pathname === path && call.method === method)
const buttonNamed = (name: string) => [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === name)
async function eventually(check: () => void, timeout = 1500) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    }
  }
}
async function renderPage() {
  await act(async () => root.render(<ChatsPage />))
}
async function open(key: string) {
  await act(async () => { row(key)!.querySelector('button')!.click() })
}

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.account = { emailInboxEnabled: true, accountEmailInboxEnabled: true }
  fixture.params = new URLSearchParams('channel=email')
  fixture.role = 'staff'
  shared = [
    mail('c1', '見本 共通A', true, '2026-11-24T03:00:00.000Z'),
    mail('c2', '見本 共通B', false, '2026-11-24T05:00:00.000Z'),
  ]
  store = [
    mail('s1', '見本 店舗A', true, '2026-11-24T04:00:00.000Z'),
    mail('s2', '見本 店舗B', false, '2026-11-24T01:00:00.000Z', '予約の変更について。駐車場はありますか'),
  ]
  pageSize = 200
  fail = { shared: null, store: null }
  readByMe = new Set()
  listGate = null
  calls = []
  const values = new Map<string, string>()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : '' })
    if (listGate && url.pathname.endsWith('/inbox') && Number(url.searchParams.get('offset') ?? 0) > 0) await listGate
    return handle(method, url)
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('共通と店舗のメールを1つの一覧に出す', () => {
  test('両方の経路を同じ条件で読み、未読が先・新しい順に混ぜて、行に共通／店舗の札を付ける', async () => {
    await renderPage()
    await eventually(() => expect(rowKeys()).toEqual(['store:s1', 'shared:c1', 'shared:c2', 'store:s2']))
    expect(row('shared:c1')!.querySelector('[data-email-source="shared"]')?.textContent).toBe('共通メール')
    expect(row('store:s1')!.querySelector('[data-email-source="store"]')?.textContent).toBe('店舗メール')
    // 店舗のメールは担当を持たない。共通のメールだけ担当を出す。
    expect(row('shared:c1')!.textContent).toContain('担当：')
    expect(row('store:s1')!.textContent).not.toContain('担当：')
    const sharedList = callsTo('/api/support/inbox').at(-1)!.url.searchParams
    const storeList = callsTo('/api/account-email/account-a/inbox').at(-1)!.url.searchParams
    for (const key of ['channel', 'status', 'limit', 'q', 'assignee', 'unreadOnly', 'quickFilter']) expect(storeList.get(key)).toBe(sharedList.get(key))
  })

  test('検索語は両方の口へ送り、件名や名前に無くても本文で当たった会話を一覧から消さない。件数も同じ語で数える', async () => {
    await renderPage()
    await eventually(() => expect(rowKeys()).toHaveLength(4))
    const search = host.querySelector<HTMLInputElement>('input[aria-label="名前・メールアドレス・内容で検索"]')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(search, '駐車場')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await eventually(() => expect(rowKeys()).toEqual(['store:s2']), 3000)
    expect(callsTo('/api/support/inbox').at(-1)!.url.searchParams.get('q')).toBe('駐車場')
    expect(callsTo('/api/account-email/account-a/inbox').at(-1)!.url.searchParams.get('q')).toBe('駐車場')
    expect(callsTo('/api/chats/quick-counts').some(call => call.url.searchParams.get('q') === '駐車場' && call.url.searchParams.get('lineAccountId') === 'account-a')).toBe(true)
  })

  test('続きは経路ごとの位置から読み、見えている一覧は全体の並びの先頭どおりに保つ', async () => {
    pageSize = 2
    shared = [
      mail('c1', '見本 共通1', true, '2026-11-24T05:00:00.000Z'),
      mail('c2', '見本 共通2', false, '2026-11-24T04:00:00.000Z'),
      mail('c3', '見本 共通3', false, '2026-11-24T02:00:00.000Z'),
    ]
    store = [mail('s1', '見本 店舗1', false, '2026-11-24T03:00:00.000Z')]
    await renderPage()
    // 共通に続きがある間、共通の2件目より古い店舗の行は出さずに待つ。
    await eventually(() => expect(rowKeys()).toEqual(['shared:c1', 'shared:c2']))
    expect(buttonNamed('メールの続きを読み込む')).toBeTruthy()
    const storeCalls = callsTo('/api/account-email/account-a/inbox').length
    await act(async () => { buttonNamed('メールの続きを読み込む')!.click() })
    await eventually(() => expect(rowKeys()).toEqual(['shared:c1', 'shared:c2', 'store:s1', 'shared:c3']))
    expect(callsTo('/api/support/inbox').at(-1)!.url.searchParams.get('offset')).toBe('2')
    // 店舗は読み切っているので、続きの読み込みで店舗の口を呼び直さない。
    expect(callsTo('/api/account-email/account-a/inbox')).toHaveLength(storeCalls)
    expect(buttonNamed('メールの続きを読み込む')).toBeUndefined()
    expect(new Set(rowKeys()).size).toBe(rowKeys().length)
  })

  test('既読にした直後も行の位置と見えている行を変えず、続きを読んでも並びが崩れない', async () => {
    pageSize = 1
    shared = [mail('c1', '見本 共通1', true, '2026-11-24T08:00:00.000Z')]
    store = [mail('s1', '見本 店舗1', false, '2026-11-24T10:00:00.000Z'), mail('s2', '見本 店舗2', false, '2026-11-24T07:00:00.000Z')]
    await renderPage()
    await eventually(() => expect(rowKeys()).toEqual(['shared:c1', 'store:s1']))
    const unreadDot = () => row('shared:c1')!.querySelector('[aria-label="未読"]')
    expect(unreadDot()).toBeTruthy()
    await open('shared:c1')
    await eventually(() => expect(callsTo('/api/support/email/threads/c1/read', 'POST')).toHaveLength(1))
    // 開いた行は赤い点だけ消え、店舗の続きを待つ側へ回って見えなくなったり、下へ跳ねたりしない。
    expect(rowKeys()).toEqual(['shared:c1', 'store:s1'])
    expect(unreadDot()).toBeNull()
    expect(row('shared:c1')!.querySelector('button')!.getAttribute('aria-current')).toBe('true')
    await act(async () => { buttonNamed('メールの続きを読み込む')!.click() })
    await eventually(() => expect(rowKeys()).toEqual(['shared:c1', 'store:s1', 'store:s2']))
    expect(callsTo('/api/account-email/account-a/inbox').at(-1)!.url.searchParams.get('offset')).toBe('1')
    expect(unreadDot()).toBeNull()
    expect(buttonNamed('メールの続きを読み込む')).toBeUndefined()
  })

  test.each([
    ['store', '/api/account-email/account-a/inbox', '/api/account-email/account-a/threads/x1/read'],
    ['shared', '/api/support/inbox', '/api/support/email/threads/x1/read'],
  ] as const)('既読の知らせで口の並びが変わっても、続きの読み込みで未読の会話を飛ばさない（%s）', async (source, listPath, readPath) => {
    pageSize = 1
    const rows = [
      mail('x1', '見本 会話A', true, '2026-11-24T10:00:00.000Z'),
      mail('x2', '見本 会話B', true, '2026-11-24T09:00:00.000Z'),
      mail('x3', '見本 会話C', false, '2026-11-24T11:00:00.000Z'),
    ]
    if (source === 'store') { store = rows; shared = [] } else { shared = rows; store = [] }
    await renderPage()
    await eventually(() => expect(rowKeys()).toEqual([`${source}:x1`]))
    await open(`${source}:x1`)
    await eventually(() => expect(callsTo(readPath, 'POST')).toHaveLength(1))
    // 口の並びは [B（未読）, C, A] に変わる。前の位置（1）から読むと B を飛ばすので、1つ戻して読む。
    await act(async () => { buttonNamed('メールの続きを読み込む')!.click() })
    await eventually(() => expect(rowKeys()).toEqual([`${source}:x1`, `${source}:x2`]))
    expect(callsTo(listPath).at(-1)!.url.searchParams.get('offset') ?? '0').toBe('0')
    await act(async () => { buttonNamed('メールの続きを読み込む')!.click() })
    await eventually(() => expect(rowKeys()).toEqual([`${source}:x1`, `${source}:x2`, `${source}:x3`]))
    // 最後に重なって届いた A は会話IDで除き、二重に出さない。
    while (buttonNamed('メールの続きを読み込む')) {
      const before = callsTo(listPath).length
      await act(async () => { buttonNamed('メールの続きを読み込む')!.click() })
      await eventually(() => expect(callsTo(listPath).length).toBeGreaterThan(before))
      await eventually(() => expect(new Set(rowKeys()).size).toBe(rowKeys().length))
    }
    expect(rowKeys()).toEqual([`${source}:x1`, `${source}:x2`, `${source}:x3`])
  })

  test('続きの読み込みの通信中に別の未読を開き、口が既読のあとの並びでページを作っても取りこぼさない', async () => {
    pageSize = 1
    shared = []
    store = [
      mail('x1', '見本 会話A', true, '2026-11-24T10:00:00.000Z'),
      mail('x2', '見本 会話B', true, '2026-11-24T09:00:00.000Z'),
      mail('x3', '見本 会話C', true, '2026-11-24T08:00:00.000Z'),
      mail('x4', '見本 会話D', false, '2026-11-24T11:00:00.000Z'),
    ]
    await renderPage()
    await eventually(() => expect(rowKeys()).toEqual(['store:x1']))
    let release!: () => void
    listGate = new Promise<void>((done) => { release = done })
    await act(async () => { buttonNamed('メールの続きを読み込む')!.click() })
    await open('store:x1')
    await eventually(() => expect(callsTo('/api/account-email/account-a/threads/x1/read', 'POST')).toHaveLength(1))
    // 口は既読のあとの並び [B, C, D, A] で offset=1 のページ（C）を作る。B が前へ詰まっている。
    listGate = null
    await act(async () => { release() })
    await eventually(() => expect(rowKeys()).toContain('store:x3'))
    while (buttonNamed('メールの続きを読み込む')) {
      const before = callsTo('/api/account-email/account-a/inbox').length
      await act(async () => { buttonNamed('メールの続きを読み込む')!.click() })
      await eventually(() => expect(callsTo('/api/account-email/account-a/inbox').length).toBeGreaterThan(before))
      await eventually(() => expect(buttonNamed('メールの続きを読み込む')?.getAttribute('aria-busy') ?? 'idle').not.toBe('true'))
    }
    // 読めるはずの会話を全部、口の並び（読み込んだ時の未読が先→新しい順）で出し、二重に出さない。
    expect(rowKeys()).toEqual(['store:x1', 'store:x2', 'store:x3', 'store:x4'])
  })

  test('通信中の既読のあと口が「続きなし」と返す最後のページでも、戻した位置を読み直して取りこぼさない', async () => {
    pageSize = 1
    shared = []
    store = [mail('x1', '見本 会話A', true, '2026-11-24T10:00:00.000Z'), mail('x2', '見本 会話B', true, '2026-11-24T09:00:00.000Z')]
    await renderPage()
    await eventually(() => expect(rowKeys()).toEqual(['store:x1']))
    let release!: () => void
    listGate = new Promise<void>((done) => { release = done })
    await act(async () => { buttonNamed('メールの続きを読み込む')!.click() })
    await open('store:x1')
    await eventually(() => expect(callsTo('/api/account-email/account-a/threads/x1/read', 'POST')).toHaveLength(1))
    // 口は既読のあとの並び [B, A] で offset=1 のページ（A だけ・続きなし）を返す。B は前へ詰まっている。
    listGate = null
    await act(async () => { release() })
    await eventually(() => expect(rowKeys()).toEqual(['store:x1', 'store:x2']))
    const offsets = callsTo('/api/account-email/account-a/inbox').map(call => call.url.searchParams.get('offset') ?? '0')
    expect(offsets.slice(-2)).toEqual(['1', '0'])
    while (buttonNamed('メールの続きを読み込む')) {
      const before = callsTo('/api/account-email/account-a/inbox').length
      await act(async () => { buttonNamed('メールの続きを読み込む')!.click() })
      await eventually(() => expect(callsTo('/api/account-email/account-a/inbox').length).toBeGreaterThan(before))
      await eventually(() => expect(buttonNamed('メールの続きを読み込む')?.getAttribute('aria-busy') ?? 'idle').not.toBe('true'))
    }
    expect(rowKeys()).toEqual(['store:x1', 'store:x2'])
  })

  test('共通の行は共通の口、店舗の行は店舗の口で開いて既読にし、逆の口へは送らない', async () => {
    await renderPage()
    await eventually(() => expect(rowKeys()).toHaveLength(4))
    await open('store:s1')
    await eventually(() => expect(callsTo('/api/account-email/account-a/threads/s1')).toHaveLength(1))
    await eventually(() => expect(callsTo('/api/account-email/account-a/threads/s1/read', 'POST')).toHaveLength(1))
    expect(calls.some(call => call.url.pathname.startsWith('/api/support/email/threads/s1'))).toBe(false)
    expect(row('store:s1')!.querySelector('button')!.getAttribute('aria-current')).toBe('true')

    await open('shared:c1')
    await eventually(() => expect(callsTo('/api/support/email/threads/c1')).toHaveLength(1))
    await eventually(() => expect(callsTo('/api/support/email/threads/c1/read', 'POST')).toHaveLength(1))
    expect(calls.some(call => call.url.pathname.startsWith('/api/account-email/account-a/threads/c1'))).toBe(false)
  })

  test('店舗の会話は返信欄を押せない形にし、理由を吹き出しで出して送らない。共通の会話は今の返信の口で送る', async () => {
    await renderPage()
    await eventually(() => expect(rowKeys()).toHaveLength(4))
    await open('store:s1')
    const reply = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="メールの返信を入力"]')
    await eventually(() => expect(reply()).toBeTruthy())
    const reason = '転送メールは受信専用です。返信は共通メールか LINE から'
    expect(reply()!.readOnly).toBe(true)
    expect(reply()!.getAttribute('aria-disabled')).toBe('true')
    // 欄の中に理由の文をそのまま出す（吹き出しにも同じ文を出す）。
    expect(reply()!.placeholder).toBe(reason)
    await act(async () => { reply()!.focus() })
    await eventually(() => expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(reason))
    const send = buttonNamed('メールで返信')!
    expect(send.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { send.click() })
    expect(calls.some(call => call.url.pathname.endsWith('/reply'))).toBe(false)
    expect(host.textContent).not.toContain('差出人')

    await open('shared:c1')
    await eventually(() => expect(callsTo('/api/support/email/threads/c1')).toHaveLength(1))
    await eventually(() => expect(reply()?.readOnly).toBe(false))
    expect(reply()!.placeholder).toBe('メールの返信を入力')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setValue.call(reply()!, 'お問い合わせありがとうございます')
      reply()!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { buttonNamed('メールで返信')!.click() })
    await eventually(() => expect(callsTo('/api/support/email/threads/c1/reply', 'POST')).toHaveLength(1))
    expect(calls.some(call => call.url.pathname.startsWith('/api/account-email/') && call.url.pathname.endsWith('/reply'))).toBe(false)
  })

  test('共通メールの書きかけは、店舗の会話を見て戻っても残り、店舗の会話の欄には値を出さず理由を見せる', async () => {
    await renderPage()
    await eventually(() => expect(rowKeys()).toHaveLength(4))
    const reply = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="メールの返信を入力"]')
    await open('shared:c1')
    await eventually(() => expect(reply()?.readOnly).toBe(false))
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setValue.call(reply()!, '共通への書きかけ')
      reply()!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(reply()!.value).toBe('共通への書きかけ')
    await open('store:s1')
    await eventually(() => expect(reply()?.readOnly).toBe(true))
    expect(reply()!.value).toBe('')
    expect(reply()!.placeholder).toBe('転送メールは受信専用です。返信は共通メールか LINE から')
    await open('shared:c1')
    await eventually(() => expect(reply()?.readOnly).toBe(false))
    expect(reply()!.value).toBe('共通への書きかけ')
    // 書きかけは送らず、店舗の口にもどの口にも漏らさない。
    expect(calls.some(call => call.url.pathname.endsWith('/reply'))).toBe(false)
    expect(calls.some(call => call.body.includes('共通への書きかけ') || call.url.href.includes(encodeURIComponent('共通への書きかけ')))).toBe(false)
  })

  test('閲覧のみの人には対応状況・担当・返信を隠さず灰色にして理由を出し、既読も送らない', async () => {
    fixture.role = 'viewer'
    await renderPage()
    await eventually(() => expect(rowKeys()).toHaveLength(4))
    await open('shared:c1')
    await eventually(() => expect(callsTo('/api/support/email/threads/c1')).toHaveLength(1))
    const status = () => host.querySelector<HTMLElement>('[aria-label="対応状況を変える"]')
    await eventually(() => expect(status()?.getAttribute('aria-disabled')).toBe('true'))
    expect(host.querySelector('[aria-label="担当者を変える"]')?.getAttribute('aria-disabled')).toBe('true')
    const reply = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="メールの返信を入力"]')!
    expect(reply.readOnly).toBe(true)
    expect(buttonNamed('メールで返信')!.getAttribute('aria-disabled')).toBe('true')
    await act(async () => { reply.focus() })
    await eventually(() => expect(document.body.querySelector('[role="tooltip"]')?.textContent).toContain('閲覧のみ'))
    expect(calls.some(call => call.method === 'POST' && call.url.pathname.endsWith('/read'))).toBe(false)
  })
})

describe('経路ごとの失敗', () => {
  test('共通の口が権限で断ったら共通だけを出さず、店舗の一覧を出し、失敗のお知らせは出さない', async () => {
    await renderPage()
    await eventually(() => expect(rowKeys()).toEqual(['store:s1', 'shared:c1', 'shared:c2', 'store:s2']))
    fail.shared = 403
    await act(async () => { window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT)) })
    await eventually(() => expect(rowKeys()).toEqual(['store:s1', 'store:s2']))
    expect(host.querySelector('[data-inbox-list-failure]')).toBeNull()
    expect(list().textContent).not.toContain('読み込めませんでした')
  })

  test('店舗の口が失敗したら店舗メールの失敗を知らせ、共通の行は出したまま、読み直しで店舗だけを取り直す', async () => {
    fail.store = 503
    await renderPage()
    await eventually(() => expect(list().textContent).toContain('店舗メールを読み込めませんでした。'))
    expect(list().textContent).toContain('共通メールは読めています。')
    expect(rowKeys()).toEqual(['shared:c1', 'shared:c2'])
    expect(list().querySelector('[data-inbox-list-state="empty"]')).toBeNull()
    const sharedCalls = callsTo('/api/support/inbox').length
    fail.store = null
    await act(async () => { buttonNamed('もう一度読み込む')!.click() })
    await eventually(() => expect(rowKeys()).toEqual(['store:s1', 'shared:c1', 'shared:c2', 'store:s2']))
    expect(host.querySelector('[data-inbox-list-failure]')).toBeNull()
    expect(callsTo('/api/support/inbox')).toHaveLength(sharedCalls)
  })

  test('店舗の口の権限の失敗も隠さず知らせる', async () => {
    fail.store = 403
    await renderPage()
    await eventually(() => expect(list().textContent).toContain('店舗メールを読み込めませんでした。'))
    expect(rowKeys()).toEqual(['shared:c1', 'shared:c2'])
  })

  test('共通の口が失敗したら共通メールの失敗を知らせ、店舗の行は出す', async () => {
    fail.shared = 503
    await renderPage()
    await eventually(() => expect(list().textContent).toContain('共通メールを読み込めませんでした。'))
    expect(rowKeys()).toEqual(['store:s1', 'store:s2'])
  })
})

describe('アカウントの境界', () => {
  test('新規アカウント（共通を出さない）では共通の口を呼ばず、店舗の一覧だけを出す', async () => {
    fixture.account = { emailInboxEnabled: false, accountEmailInboxEnabled: true }
    await renderPage()
    await eventually(() => expect(rowKeys()).toEqual(['store:s1', 'store:s2']))
    expect(callsTo('/api/support/inbox')).toHaveLength(0)
  })

  test('店舗がつながっていないアカウントでは店舗の口を呼ばず、従来の共通の一覧だけを出す', async () => {
    fixture.account = { emailInboxEnabled: true, accountEmailInboxEnabled: false }
    await renderPage()
    await eventually(() => expect(rowKeys()).toEqual(['shared:c1', 'shared:c2']))
    expect(calls.some(call => call.url.pathname.startsWith('/api/account-email/'))).toBe(false)
    // 1つの経路だけのときは、失敗の文も従来どおり「メール」と言う。
  })

  test('アカウントを切り替えると、店舗の一覧を新しいアカウントで読み直し、前の店の会話を閉じる', async () => {
    await renderPage()
    await eventually(() => expect(rowKeys()).toHaveLength(4))
    await open('store:s1')
    await eventually(() => expect(callsTo('/api/account-email/account-a/threads/s1')).toHaveLength(1))
    fixture.accountId = 'account-b'
    store = [mail('s9', '見本 別店舗の客', true, '2026-11-24T06:00:00.000Z')]
    await renderPage()
    await eventually(() => expect(rowKeys()).toEqual(['store:s9', 'shared:c1', 'shared:c2']))
    expect(callsTo('/api/account-email/account-b/inbox').length).toBeGreaterThan(0)
    expect(host.querySelector('textarea[aria-label="メールの返信を入力"]')).toBeNull()
  })
})
