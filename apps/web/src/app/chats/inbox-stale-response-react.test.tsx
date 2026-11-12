// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatsPage from './page'

/**
 * 受信箱の「遅れて届いた応答を今の対象へ結び付けない」試験(#962/#965)。
 *
 * `inbox-673-account-switch-react.test.tsx` と同じく本物のReactで
 * `ChatsPage` を mount し、通信(fetch)だけを差し替える。会話の切替は
 * `useSearchParams` が返す `?friend=` を試験の途中で書き換えることで
 * 実際の効果再実行を通す。
 *
 * 見るもの:
 * - F03: 切替後に届いた前の会話の「前のメッセージ」応答が履歴に混ざらない
 * - F06: 送信応答が今開いている別会話の下書きを消さない。下書きは
 *        アカウント＋会話ごとに預かり、送った版だけが消える
 * - F07: 切替後に届いた前の会話の予約一覧が今の会話に出ない
 * - #965: 同じ予約版の再試行は同じ冪等キーを使い回す
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string | null,
  params: new URLSearchParams(),
}))

const net = vi.hoisted(() => ({
  calls: [] as string[],
  posts: [] as Array<{ path: string; key: string | null; body: string }>,
  handler: ((url: string, init?: RequestInit) =>
    Promise.reject(new Error(`未設定: ${url}`))) as
      (url: string, init?: RequestInit) => Promise<unknown>,
}))

vi.mock('next/link', () => ({ default: () => null }))

vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
  usePathname: () => '/chats',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: fixture.accountId,
    selectedAccount: null,
    loading: false,
  }),
}))

/*
 * 時刻の選び欄は共通 Select（listbox）。ここで見たいのは選んだ後の
 * 予約の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string
    id?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

/** 通信そのものを差し替える。api・fetchApiは実物を通す。 */
function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    const method = (init?.method ?? 'GET').toUpperCase()
    net.calls.push(`${method} ${path}`)
    if (method !== 'GET') {
      const headers = (init?.headers ?? {}) as Record<string, string>
      net.posts.push({ path, key: headers['Idempotency-Key'] ?? null, body: String(init?.body ?? '') })
    }
    const body = await net.handler(path, init)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

/** 呼び出し側が返す時刻を決める Promise。実APIと同じ非同期境界になる。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function friendDetail(id: string, lineAccountId: string) {
  return {
    id, displayName: id, pictureUrl: null, isFollowing: true, metadata: {},
    lineAccountId,
    realName: null, systemDisplayName: null, refCode: null,
    createdAt: '2026-09-01T00:00:00.000Z', tags: [], formSubmissions: [], support: null,
  }
}

function chatMessage(id: string, content: string, createdAt = '2026-09-09T00:00:00.000Z') {
  return {
    id,
    direction: 'incoming',
    messageType: 'text',
    content,
    source: 'line',
    originKind: null,
    sentByStaffId: null,
    sentByStaffName: null,
    scenarioName: null,
    createdAt,
  }
}

function chatDetail(id: string, name: string, message: string, hasMore = false) {
  return {
    id,
    friendId: id,
    friendName: name,
    friendRealName: null,
    friendPictureUrl: null,
    operatorId: null,
    status: 'unread',
    notes: null,
    revision: 1,
    lastMessageAt: '2026-09-09T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    messages: [chatMessage(`message-${id}`, message)],
    hasMoreMessages: hasMore,
  }
}

type Handlers = {
  /** 会話ごとの詳細応答。未指定なら既定の1件を返す。 */
  chatDetails?: Record<string, unknown>
  /** 「前のメッセージ」(beforeId 付き) の応答を制御する。 */
  older?: (id: string) => Promise<unknown>
  /** 予約一覧の応答を制御する。 */
  scheduled?: (id: string) => Promise<unknown>
  /** 送信(POST /send)の応答を制御する。 */
  send?: (id: string) => Promise<unknown>
  /** 予約(POST /schedule)の応答を制御する。 */
  schedule?: (id: string) => Promise<unknown>
}

function baseHandler(options: Handlers) {
  return (path: string, init?: RequestInit): Promise<unknown> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (path.startsWith('/api/chats/stats')) {
      return Promise.resolve({ success: true, data: {
        total: 0, unread: 0, inProgress: 0, onHold: 0, resolved: 0,
        oldestUnansweredMinutes: null, assigneeUnread: [],
      } })
    }
    if (path.startsWith('/api/chats?')) {
      return Promise.resolve({ success: true, data: [] })
    }
    if (path.startsWith('/api/inbox/saved-views')) {
      return Promise.resolve({ success: true, data: [] })
    }
    if (path.startsWith('/api/support/inbox')) {
      return Promise.resolve({ success: true, data: { items: [] } })
    }
    if (path.startsWith('/api/operators')) {
      return Promise.resolve({ success: true, data: [] })
    }
    const friendMatch = path.match(/^\/api\/friends\/([^/?]+)(\?|$)/)
    if (friendMatch) {
      const id = decodeURIComponent(friendMatch[1])
      return Promise.resolve({ success: true, data: friendDetail(id, fixture.accountId ?? 'account-a') })
    }
    // /scheduled・/send・/schedule は会話詳細より先に切り分ける。
    const subMatch = path.match(/^\/api\/chats\/([^/?]+)\/(scheduled|send|schedule|read)([?]|$)/)
    if (subMatch) {
      const id = decodeURIComponent(subMatch[1])
      const action = subMatch[2]
      if (action === 'scheduled') return options.scheduled?.(id) ?? Promise.resolve({ success: true, data: { scheduled: [] } })
      if (action === 'send' && method === 'POST') {
        return options.send?.(id) ?? Promise.resolve({ success: true, data: {
          sent: true, messageId: `sent-${id}`, messageIds: [`sent-${id}`],
          sentByStaffName: '担当者', revision: 2,
        } })
      }
      if (action === 'schedule' && method === 'POST') {
        return options.schedule?.(id) ?? Promise.resolve({ success: true, data: {
          id: `sched-${id}`, friendId: id, content: '', scheduledAt: '2026-09-20T00:00:00.000Z',
          status: 'scheduled', createdAt: '2026-09-10T00:00:00.000Z', replayed: false,
        } })
      }
      return Promise.resolve({ success: true, data: { isUnread: false } })
    }
    const chatMatch = path.match(/^\/api\/chats\/([^/?]+)(\?|$)/)
    if (chatMatch) {
      const id = decodeURIComponent(chatMatch[1])
      // 「前のメッセージ」は beforeId クエリが付く。
      if (path.includes('beforeId=') && options.older) return options.older(id)
      const configured = options.chatDetails?.[id]
      return Promise.resolve({ success: true, data: configured ?? chatDetail(id, id, `${id}の会話`) })
    }
    if (/\/mileage(\?|$)/.test(path)) {
      return Promise.resolve({ success: true, data: {
        summary: { programId: 'p', programName: '試験マイル', available: 0, pending: 0, lifetimeEarned: 0, spent: 0 },
        history: [],
      } })
    }
    if (/\/rich-menu(\?|$)/.test(path)) {
      return Promise.resolve({ success: true, data: { id: null, name: null, isDefault: false } })
    }
    return Promise.resolve({ success: true, data: [] })
  }
}

let host: HTMLDivElement
let root: Root

let uuidSeq = 0

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.params = new URLSearchParams()
  net.calls.length = 0
  net.posts.length = 0
  /*
   * Map を Storage に見せかけると getItem が無く、POST の CSRF 読み出しで
   * fetch 以前に落ちる。Storage の形をした素直な実装を当てる。
   */
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size },
  } as Storage)
  /*
   * happy-dom の crypto には randomUUID が無い環境がある。
   * IdempotencyKeyStore.get が投げると送信処理そのものが止まるので、
   * 残りの口は実物へ委譲しつつ randomUUID だけ決定的に供給する。
   */
  const baseCrypto = globalThis.crypto
  vi.stubGlobal('crypto', new Proxy(baseCrypto ?? ({} as Crypto), {
    get(target, prop) {
      if (prop === 'randomUUID') return () => `test-key-${String(++uuidSeq)}`
      const value = (target as Crypto)[prop as keyof Crypto]
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))
  installFetch()
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function render() {
  await act(async () => { root.render(<ChatsPage />) })
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

/** `?friend=` を書き換えて会話を切り替える。実際のdeep-link効果が走る。 */
async function openFriend(friendId: string) {
  fixture.params = new URLSearchParams(`friend=${friendId}`)
  await render()
  await flush()
  await flush()
}

function textarea(): HTMLTextAreaElement | null {
  return document.querySelector('textarea[aria-label="メッセージを入力"]')
}

async function typeMessage(text: string) {
  const el = textarea()
  if (!el) throw new Error('入力欄が見つからない')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function typeDatetime(text: string) {
  // 日時の選択（★管理画面）で選ぶ。値は今までどおり YYYY-MM-DDTHH:mm（日本時間）。
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text)
  if (!match) throw new Error('日時が読めない')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const week = '日月火水木金土'[new Date(year, month - 1, day).getDay()]
  const dialog = () => document.querySelector('[role="dialog"][aria-label="日時を選ぶ"]')
  const trigger = document.querySelector<HTMLElement>('#schedule-at')
  if (!trigger) throw new Error('予約日時の入力が見つからない')
  if (!dialog()) await click(trigger)
  for (let i = 0; i < 36; i += 1) {
    const grid = document.querySelector('[role="grid"]')
    const label = grid?.getAttribute('aria-label')
    if (label === `${year}年${month}月`) break
    const target = year * 12 + month
    const currentLabel = /^(\d+)年(\d+)月$/.exec(label ?? '')
    const current = currentLabel ? Number(currentLabel[1]) * 12 + Number(currentLabel[2]) : target
    const nav = [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === (target > current ? '次の月' : '前の月'),
    )
    if (!nav) throw new Error('暦が見つからない')
    await click(nav)
  }
  // 今日の日付には「、今日」が付くので前方一致で探す。
  await click(
    [...document.querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith(`${year}年${month}月${day}日（${week}）`),
    ) ?? null,
  )
  await setTimeControl(dialog()?.querySelector('input[role="combobox"]') ?? null, `${match[4]}:${match[5]}`)
  await click(Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent?.trim() === '確定')!)
}
import { setTimeControl } from '@/test-utils/time-control'

async function eventually(check: () => void) {
  for (let attempt = 0; ; attempt++) {
    try { check(); return } catch (error) {
      if (attempt >= 100) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

async function click(el: Element | null) {
  if (!el) throw new Error('クリック対象が見つからない')
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function talkPaneText(): string {
  const pane = document.querySelector('[data-inbox-v4="talk-pane"]')
  return pane?.textContent ?? ''
}

function scheduleToggleText(): string {
  return document.querySelector('[data-inbox-v6="schedule-toggle"]')?.textContent ?? ''
}

function scheduledRowsText(): string {
  return [...document.querySelectorAll('[data-inbox-v6="scheduled-row"]')].map((row) => row.textContent).join('\n')
}

async function openSchedulePanel() {
  const toggle = document.querySelector('[data-inbox-v6="schedule-toggle"]')
  if (toggle?.getAttribute('aria-expanded') !== 'true') await click(toggle)
}

describe('受信箱の遅延応答の対象照合(#962)と予約の冪等キー(#965)', () => {
  it('会話切替直後から前の本文を隠し、遅い取得だけ骨組みを出す', async () => {
    const slow = deferred<unknown>()
    const normal = baseHandler({})
    net.handler = (path, init) => /^\/api\/chats\/friend-b(\?|$)/.test(path) ? slow.promise : normal(path, init)
    fixture.params = new URLSearchParams('friend=friend-a')
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(talkPaneText()).toContain('friend-aの会話'))
    fixture.params = new URLSearchParams('friend=friend-b')
    await act(async () => root.render(<ChatsPage />))
    expect(talkPaneText()).not.toContain('friend-aの会話')
    const loading = host.querySelector('[aria-label="会話を読み込んでいます"]')
    expect(loading).not.toBeNull()
    expect(loading?.closest('[data-skeleton-reserve]')).not.toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 330)) })
    expect(host.querySelector('[aria-label="会話を読み込んでいます"]')?.closest('[data-skeleton-reserve]')).toBeNull()
    expect(loading?.querySelector('[data-skeleton]')).not.toBeNull()
    await act(async () => { slow.resolve({ success: true, data: chatDetail('friend-b', 'Bさん', '新しい会話') }) })
    await eventually(() => expect(talkPaneText()).toContain('新しい会話'))
    expect(talkPaneText()).not.toContain('friend-aの会話')
  })

  it('送信待ちの吹き出しは送信中、成功後は送信済みになり連打で増えない', async () => {
    const slow = deferred<unknown>()
    net.handler = baseHandler({ send: () => slow.promise })
    fixture.params = new URLSearchParams('friend=friend-a')
    await act(async () => root.render(<ChatsPage />))
    await eventually(() => expect(host.querySelector('textarea[aria-label="メッセージを入力"]')).not.toBeNull())
    await typeMessage('確認の返信')
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === '送信する')!
    await act(async () => { send.click(); send.click() })
    expect(talkPaneText()).toContain('送信中…')
    expect(talkPaneText()).toContain('確認の返信')
    const pending = [...host.querySelectorAll('[role="article"]')].find((article) => article.textContent?.includes('確認の返信'))
    expect(pending?.querySelector('[data-inbox-v6="quote-reply"]')).toBeNull()
    expect(pending?.querySelector('[data-inbox-v6="correct-message"]')).toBeNull()
    expect(net.posts.filter((post) => post.path.endsWith('/send'))).toHaveLength(1)
    await act(async () => { slow.resolve({ success: true, data: { sent: true, sentByStaffName: '担当者', revision: 2 } }) })
    await eventually(() => expect(talkPaneText()).toContain('送信済み'))
    expect(talkPaneText()).not.toContain('送信中…')
    expect([...host.querySelectorAll('[role="article"]')].filter((article) => article.textContent?.includes('確認の返信'))).toHaveLength(1)
  })

  it('F07: Aの予約一覧応答が遅れてBへ切替後に届いても、Bの予約パネルに混ざらない', async () => {
    const schedA = deferred<unknown>()
    net.handler = baseHandler({
      chatDetails: {
        'friend-a': chatDetail('friend-a', 'A子', 'Aの会話'),
        'friend-b': chatDetail('friend-b', 'B子', 'Bの会話'),
      },
      scheduled: (id) => {
        if (id === 'friend-a') return schedA.promise
        return Promise.resolve({ success: true, data: { scheduled: [{
          id: 'sched-b', friendId: 'friend-b', content: 'Bの予約文面',
          scheduledAt: '2026-09-21T10:00:00.000Z', status: 'scheduled',
          createdAt: '2026-09-10T00:00:00.000Z',
        }] } })
      },
    })

    await openFriend('friend-a')
    expect(talkPaneText()).toContain('Aの会話')
    // Aの予約一覧は要求済み・未応答。
    expect(net.calls.some((c) => c === 'GET /api/chats/friend-a/scheduled')).toBe(true)

    await openFriend('friend-b')
    await flush()
    expect(talkPaneText()).toContain('Bの会話')

    // Bの予約が届いてから、遅れていたAの応答が返る。
    await act(async () => {
      schedA.resolve({ success: true, data: { scheduled: [{
        id: 'sched-a', friendId: 'friend-a', content: 'Aの予約文面',
        scheduledAt: '2026-09-20T10:00:00.000Z', status: 'scheduled',
        createdAt: '2026-09-10T00:00:00.000Z',
      }] } })
    })
    await flush()

    // Bの予約パネルにはBの分だけが出る。Aの「予約文面」も件数も混ざらない。
    await openSchedulePanel()
    expect(scheduleToggleText()).toBe('送信予約(1)')
    expect(scheduledRowsText()).toContain('Bの予約文面')
    expect(scheduledRowsText()).not.toContain('Aの予約文面')
  })

  it('F07失敗: 予約一覧の取得失敗は「予約なし」にせず再読み込みを出す', async () => {
    const schedA = deferred<unknown>()
    net.handler = baseHandler({
      chatDetails: { 'friend-a': chatDetail('friend-a', 'A子', 'Aの会話') },
      scheduled: () => schedA.promise,
    })

    await openFriend('friend-a')
    await openSchedulePanel()
    await act(async () => { schedA.reject(new Error('network down')) })
    await flush()

    // 0件として黙るのではなく、読み込めなかったことと再読み込み口が出る。
    expect(document.body.textContent).toContain('予約の一覧を読み込めませんでした。')
    expect(document.querySelector('[data-inbox-v6="scheduled-retry"]')).not.toBeNull()
    expect(scheduleToggleText()).toBe('送信予約')
  })

  it('F03: Aの「前のメッセージ」応答が遅れてBへ切替後に届いても、Bの履歴に混ざらない', async () => {
    const olderA = deferred<unknown>()
    // Aは「前のメッセージ」がまだある状態にする(hasMore=true)。
    net.handler = baseHandler({
      chatDetails: {
        'friend-a': chatDetail('friend-a', 'A子', 'Aの最新', true),
        'friend-b': chatDetail('friend-b', 'B子', 'Bの最新'),
      },
      older: (id) => {
        if (id === 'friend-a') return olderA.promise
        return Promise.resolve({ success: true, data: chatDetail(id, id, `${id}の会話`) })
      },
    })

    await openFriend('friend-a')
    expect(talkPaneText()).toContain('Aの最新')

    // 「前のメッセージ」を押す → Aの過去分の要求がpendingで残る。
    const olderButton = [...document.querySelectorAll('button')].find((b) => b.textContent === '前のメッセージ')
    await click(olderButton ?? null)
    await flush()
    expect(net.calls.some((c) => c.startsWith('GET /api/chats/friend-a?') && c.includes('beforeId='))).toBe(true)

    // 応答が返る前にBへ切り替える。
    await openFriend('friend-b')
    expect(talkPaneText()).toContain('Bの最新')
    expect(talkPaneText()).not.toContain('Aの最新')

    // 遅れていたAの過去応答が届く。Bの履歴にAの過去分は混ざらない。
    await act(async () => {
      olderA.resolve({ success: true, data: {
        ...chatDetail('friend-a', 'A子', 'Aの最新', false),
        messages: [chatMessage('old-a-1', 'Aの古いメッセージ', '2026-09-01T00:00:00.000Z')],
      } })
    })
    await flush()
    expect(talkPaneText()).toContain('Bの最新')
    expect(talkPaneText()).not.toContain('Aの古いメッセージ')
  })

  it('F06: Aへの送信応答が遅れてもBの入力を消さず、Aに戻ると送った版だけ消えている', async () => {
    const sendA = deferred<unknown>()
    net.handler = baseHandler({
      chatDetails: {
        'friend-a': chatDetail('friend-a', 'A子', 'Aの会話'),
        'friend-b': chatDetail('friend-b', 'B子', 'Bの会話'),
      },
      send: (id) => (id === 'friend-a' ? sendA.promise : Promise.resolve({ success: true, data: {
        sent: true, messageId: `sent-${id}`, messageIds: [`sent-${id}`], sentByStaffName: '担当者', revision: 2,
      } })),
    })

    await openFriend('friend-a')
    await typeMessage('Aへの文面')

    // Aへ送信を開始し、応答は保留のまま。(ダイレクト送信パネルにも
    // 「送信」ボタンがあるので、トーク画面の中に限定する)
    const pane = document.querySelector('[data-inbox-v4="talk-pane"]')
    const sendButton = [...(pane?.querySelectorAll('button') ?? [])].find((b) => b.textContent === '送信する')
    await click(sendButton ?? null)
    await flush()
    expect(net.posts.some((p) => p.path === '/api/chats/friend-a/send')).toBe(true)

    // 応答を待つ間にBへ切り替える。Aの下書きは預かられ、Bの入力欄は空。
    await openFriend('friend-b')
    expect(textarea()?.value).toBe('')
    await typeMessage('Bへの文面')

    // 遅れていたAの送信成功が届く。Bの入力は消えない。
    await act(async () => {
      sendA.resolve({ success: true, data: {
        sent: true, messageId: 'sent-a', messageIds: ['sent-a'], sentByStaffName: '担当者', revision: 2,
      } })
    })
    await flush()
    expect(textarea()?.value).toBe('Bへの文面')

    // Bに戻るとBの下書きが残り、Aへ戻ると送信済みの版は消えている。
    await openFriend('friend-a')
    expect(textarea()?.value).toBe('')
    await openFriend('friend-b')
    expect(textarea()?.value).toBe('Bへの文面')
  })

  it('F06下書き: 送信せず切り替えても、会話ごとの下書きが預かられて戻る', async () => {
    net.handler = baseHandler({
      chatDetails: {
        'friend-a': chatDetail('friend-a', 'A子', 'Aの会話'),
        'friend-b': chatDetail('friend-b', 'B子', 'Bの会話'),
      },
    })

    await openFriend('friend-a')
    await typeMessage('Aの書きかけ')

    await openFriend('friend-b')
    expect(textarea()?.value).toBe('')
    await typeMessage('Bの書きかけ')

    await openFriend('friend-a')
    expect(textarea()?.value).toBe('Aの書きかけ')
    await openFriend('friend-b')
    expect(textarea()?.value).toBe('Bの書きかけ')
  })

  it('#965: 同じ予約版の再試行は同じ冪等キーを使い回し、成功した版は次が別キーになる', async () => {
    const scheduleResults: Array<ReturnType<typeof deferred<unknown>>> = []
    net.handler = baseHandler({
      chatDetails: { 'friend-a': chatDetail('friend-a', 'A子', 'Aの会話') },
      schedule: () => {
        const next = deferred<unknown>()
        scheduleResults.push(next)
        return next.promise
      },
    })

    await openFriend('friend-a')
    await typeMessage('予約する文面')
    await openSchedulePanel()
    await typeDatetime('2026-09-25T10:30')

    const scheduleButton = () =>
      [...document.querySelectorAll('button')].find((b) => /に予約$/.test(b.textContent ?? '') || b.textContent === '予約中...' )

    // 1回目: 通信中に保留 → 失敗させる。
    await click(scheduleButton() ?? null)
    await flush()
    expect(scheduleResults.length).toBe(1)
    await act(async () => { scheduleResults[0].reject(new Error('network down')) })
    await flush()

    // 2回目: 同じ版の再試行は同じ冪等キーで出る。
    await click(scheduleButton() ?? null)
    await flush()
    expect(scheduleResults.length).toBe(2)
    await act(async () => { scheduleResults[1].reject(new Error('network down')) })
    await flush()

    const schedulePosts = net.posts.filter((p) => p.path === '/api/chats/friend-a/schedule')
    expect(schedulePosts.length).toBe(2)
    expect(schedulePosts[0].key).toBeTruthy()
    expect(schedulePosts[1].key).toBe(schedulePosts[0].key)

    // 3回目で成功 → 版のキーは消費される。
    await click(scheduleButton() ?? null)
    await flush()
    expect(scheduleResults.length).toBe(3)
    await act(async () => {
      scheduleResults[2].resolve({ success: true, data: {
        id: 'sched-a-1', friendId: 'friend-a', content: '予約する文面',
        scheduledAt: '2026-09-25T01:30:00.000Z', status: 'scheduled',
        createdAt: '2026-09-10T00:00:00.000Z', replayed: false,
      } })
    })
    await flush()

    // 同じ文面・同じ日時でも、成功済みの版をもう一度予約する操作は
    // 別操作なので新しいキーになる(処理待ち行が同一キーで再利用される)。
    await typeMessage('予約する文面')
    await openSchedulePanel()
    await typeDatetime('2026-09-25T10:30')
    await click(scheduleButton() ?? null)
    await flush()
    expect(scheduleResults.length).toBe(4)
    const posts = net.posts.filter((p) => p.path === '/api/chats/friend-a/schedule')
    expect(posts[3].key).toBeTruthy()
    expect(posts[3].key).not.toBe(posts[0].key)
    await act(async () => {
      scheduleResults[3].resolve({ success: true, data: {
        id: 'sched-a-2', friendId: 'friend-a', content: '予約する文面',
        scheduledAt: '2026-09-25T01:30:00.000Z', status: 'scheduled',
        createdAt: '2026-09-10T00:00:00.000Z', replayed: false,
      } })
    })
    await flush()
  })
})
