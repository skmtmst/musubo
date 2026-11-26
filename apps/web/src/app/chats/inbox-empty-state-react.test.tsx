import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import ChatsPage from './page'

const fixture = vi.hoisted(() => ({ accountId: 'account-a', params: new URLSearchParams() }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {} }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: fixture.accountId, selectedAccount: { emailInboxEnabled: true }, loading: false,
}) }))

type Pending = { resolve: (value: Response) => void }
let root: Root
let host: HTMLDivElement
let calls: URL[]
let handler: (url: URL) => Promise<Response> | Response
let pending: Pending[]
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
})
const linePayload = (names: string[] = []) => ({ success: true, data: names.map((name) => ({
  id: `chat-${name}`, friendId: `friend-${name}`, friendName: name, operatorId: 'operator-a',
  status: 'unread', isUnread: true, lastMessageAt: '2026-09-01T00:00:00.000Z',
  lastMessageContent: name, lastMessageType: 'text', lastMessageDirection: 'incoming',
})) })
const emailPayload = (names: string[] = []) => ({ success: true, data: {
  items: names.map((name) => ({
    id: `email:${name}`, threadId: `thread-${name}`, customerName: name,
    customerIdentifier: `${name}@example.test`, subject: name, preview: name,
    status: 'unread', assignedStaffId: 'operator-a', isUnread: true,
    lastIncomingAt: '2026-09-01T00:00:00.000Z', lastMessageAt: '2026-09-01T00:00:00.000Z',
  })), summary: { total: names.length },
} })
function base(url: URL) {
  if (url.pathname === '/api/chats') return response(linePayload())
  if (url.pathname === '/api/support/inbox') return response(emailPayload())
  if (url.pathname === '/api/operators') return response({ success: true, data: [{ id: 'operator-a', name: '担当A' }] })
  if (url.pathname === '/api/chats/stats') return response({ success: true, data: {
    total: 0, unread: 0, assigneeUnread: [], waiting: 0, waitingOverAnHour: 0,
  } })
  return response({ success: true, data: [] })
}
function hold() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  pending.push({ resolve })
  return { promise, resolve }
}
const list = () => document.querySelector<HTMLElement>('[data-inbox-v4="conversation-list"]')!
const state = (kind: string) => list().querySelector(`[data-inbox-list-state="${kind}"]`)
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function eventually(check: () => void, timeout = 1000) {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}
async function click(label: string) {
  if (label === '要返信' || label === '1時間以上待ち') {
    let control = document.querySelector<HTMLButtonElement>('button[aria-label="期限で絞り込む"]')
    if (!control) {
      const open = document.querySelector<HTMLButtonElement>('button[aria-label="絞り込み"]')!
      await act(async () => { open.click() })
      control = document.querySelector<HTMLButtonElement>('button[aria-label="期限で絞り込む"]')
    }
    await act(async () => { control!.click() })
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent?.trim().startsWith(label))!
    await act(async () => { option.querySelector('button')!.click() })
    return
  }
  const button = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label || item.textContent?.trim().startsWith(label))
  expect(button, label).toBeTruthy()
  await act(async () => { button!.click() })
}
/** 対応状況は絞り込みパネルの中。開いていなければ開いてから選ぶ。 */
async function pickStatus(label: string) {
  if (!document.querySelector('[aria-label="対応状況で絞り込む"]')) await click('絞り込み')
  await click('対応状況で絞り込む')
  await act(async () => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent === label)!
    option.querySelector('button')!.click()
  })
}
const isFilteredRequest = (url: URL) => Boolean(
  url.searchParams.get('q')
    || (url.searchParams.get('status') && url.searchParams.get('status') !== 'all')
    || url.searchParams.get('operatorId')
    || url.searchParams.get('assignee')
    || url.searchParams.get('unreadOnly')
    || url.searchParams.get('quickFilter'),
)
async function renderWithRowsUnlessFiltered() {
  handler = (url) => {
    if (url.pathname === '/api/chats') return response(linePayload(isFilteredRequest(url) ? [] : ['通常の会話']))
    if (url.pathname === '/api/support/inbox') return response(emailPayload())
    return base(url)
  }
  await act(async () => root.render(<ChatsPage />))
}
async function applySingleFilter(kind: 'search' | 'status' | 'quick' | 'assignee' | 'unread') {
  if (kind === 'search') {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('[aria-label="名前・メールアドレス・内容で検索"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '該当なし')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await eventually(() => expect(
      calls.filter((url) => url.pathname === '/api/chats').at(-1)?.searchParams.get('q'),
    ).toBe('該当なし'))
    return
  }
  if (kind === 'status') { await pickStatus('未対応'); return }
  if (kind === 'quick') { await click('1時間以上待ち'); return }
  await click('絞り込み')
  if (kind === 'assignee') {
    // 担当者の選択は候補つき入力へ移した。表示名を打って候補を押す。
    await pickEntity('担当者で絞り込む', '担当A（0）', '選ぶ', '担当者を選ぶ')
    return
  }
  await act(async () => { document.querySelector<HTMLInputElement>('[aria-label="未読だけ表示"]')!.click() })
}
beforeEach(() => {
  calls = []; pending = []; handler = base
  fixture.accountId = 'account-a'; fixture.params = new URLSearchParams()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  vi.stubGlobal('fetch', (input: string | URL) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(url)
    return handler(url)
  })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => {
    for (const item of pending) item.resolve(response({ success: false }, 503))
    await Promise.resolve()
  })
  await act(async () => root.unmount())
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

test('URL の検索語を受信箱に渡し、同じ画面で別の検索を開いても更新する', async () => {
  fixture.params = new URLSearchParams('q=山田')
  await act(async () => root.render(<ChatsPage />))
  await eventually(() => expect(calls.filter(url => url.pathname === '/api/chats').at(-1)?.searchParams.get('q')).toBe('山田'))
  fixture.params = new URLSearchParams('q=佐藤')
  await act(async () => root.render(<ChatsPage />))
  await eventually(() => expect(calls.filter(url => url.pathname === '/api/chats').at(-1)?.searchParams.get('q')).toBe('佐藤'))
  const input = document.querySelector<HTMLInputElement>('[aria-label="名前・メールアドレス・内容で検索"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(input.value).toBe('')
  await eventually(() => expect(calls.filter(url => url.pathname === '/api/chats').at(-1)?.searchParams.get('q')).toBeNull())
  await act(async () => {
    window.dispatchEvent(new CustomEvent('musubo:command-palette-chat-search', { detail: '佐藤' }))
  })
  await eventually(() => expect(document.querySelector<HTMLInputElement>('[aria-label="名前・メールアドレス・内容で検索"]')?.value).toBe('佐藤'))
})

test('all は双方の取得完了後だけ通常0件を一覧内に表示する', async () => {
  const email = hold()
  handler = (url) => url.pathname === '/api/support/inbox' ? email.promise : base(url)
  await act(async () => root.render(<ChatsPage />))
  expect(state('loading')).toBeTruthy()
  expect(list().textContent).not.toContain('まだ会話がありません')
  await act(async () => { email.resolve(response(emailPayload())) })
  expect(state('empty')).toBeTruthy()
  expect(list().textContent).toContain('まだ会話がありません')
})

test('片側に会話があれば、もう片側の待機や障害を0件と表示しない', async () => {
  handler = (url) => {
    if (url.pathname === '/api/chats') return response(linePayload(['田中']))
    if (url.pathname === '/api/support/inbox') return response({ success: false }, 503)
    return base(url)
  }
  await act(async () => root.render(<ChatsPage />))
  await settle()
  expect(list().textContent).toContain('田中')
  expect(state('empty')).toBeNull()
  expect(state('filtered-empty')).toBeNull()
})

test('障害時は0件と断定しない', async () => {
  handler = (url) => url.pathname === '/api/support/inbox'
    ? response({ success: false }, 503)
    : base(url)
  await act(async () => root.render(<ChatsPage />))
  await settle()
  expect(list().textContent).toContain('メールを読み込めませんでした。')
  expect(state('empty')).toBeNull()
})

test('LINE一覧の障害時も0件と断定しない', async () => {
  handler = (url) => url.pathname === '/api/chats'
    ? response({ success: false }, 503)
    : base(url)
  await act(async () => root.render(<ChatsPage />))
  await settle()
  expect(host.textContent).toContain('LINE の会話を読み込めませんでした。')
  expect(state('empty')).toBeNull()
})

test('line 選択時はメールの待機や障害から独立して通常0件を表示する', async () => {
  fixture.params = new URLSearchParams('channel=line')
  const email = hold()
  handler = (url) => url.pathname === '/api/support/inbox' ? email.promise : base(url)
  await act(async () => root.render(<ChatsPage />))
  await settle()
  expect(state('empty')).toBeTruthy()
  expect(list().textContent).not.toContain('メールを読み込めませんでした。')
})

test('line 選択時はメールが失敗しても通常0件を表示する', async () => {
  fixture.params = new URLSearchParams('channel=line')
  handler = (url) => url.pathname === '/api/support/inbox'
    ? response({ success: false }, 503)
    : base(url)
  await act(async () => root.render(<ChatsPage />))
  await settle()
  expect(state('empty')).toBeTruthy()
  expect(list().textContent).not.toContain('メールを読み込めませんでした。')
})

test.each([
  ['検索', 'search'],
  ['状態', 'status'],
  ['期限', 'quick'],
  ['担当', 'assignee'],
  ['未読', 'unread'],
] as const)('%s条件だけで0件なら条件用空状態にする', async (_label, kind) => {
  await renderWithRowsUnlessFiltered()
  expect(list().textContent).toContain('通常の会話')
  await applySingleFilter(kind)
  await eventually(() => expect(state('filtered-empty')).toBeTruthy())
  expect(state('empty')).toBeNull()
})

test('条件変更の描画から新条件取得開始まで旧0件を空状態として出さない', async () => {
  await act(async () => root.render(<ChatsPage />))
  expect(state('empty')).toBeTruthy()
  await click('絞り込み')
  await click('対応状況で絞り込む')
  const next = hold()
  handler = (url) => isFilteredRequest(url) ? next.promise.then((value) => value.clone()) : base(url)
  const button = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent === '未対応')!.querySelector('button')!
  act(() => {
    flushSync(() => button.click())
    expect(state('loading')).toBeTruthy()
    expect(state('filtered-empty')).toBeNull()
  })
})

test('条件解除の描画から再取得開始まで旧0件を通常0件として出さない', async () => {
  handler = (url) => {
    if (url.pathname === '/api/chats') return response(linePayload())
    if (url.pathname === '/api/support/inbox') return response(emailPayload())
    return base(url)
  }
  await act(async () => root.render(<ChatsPage />))
  await pickStatus('未対応')
  await eventually(() => expect(state('filtered-empty')).toBeTruthy())

  const next = hold()
  handler = (url) => isFilteredRequest(url) ? base(url) : next.promise.then((value) => value.clone())
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '絞り込みを外す')!
  act(() => {
    flushSync(() => button.click())
    expect(state('loading')).toBeTruthy()
    expect(state('empty')).toBeNull()
  })
})

test('全条件の結果0件を区別し、解除後に会話を戻す', async () => {
  const filtered = (url: URL) => ['q', 'status', 'operatorId', 'assignee', 'unreadOnly', 'quickFilter']
    .some((key) => url.searchParams.has(key))
  handler = (url) => {
    if (url.pathname === '/api/chats') return response(linePayload(filtered(url) ? [] : ['戻った会話']))
    if (url.pathname === '/api/support/inbox') return response(emailPayload())
    return base(url)
  }
  await act(async () => root.render(<ChatsPage />))

  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="名前・メールアドレス・内容で検索"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '見つからない')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await eventually(() => {
    const searchCall = calls.filter((url) => url.pathname === '/api/chats').at(-1)!
    expect(searchCall.searchParams.get('q')).toBe('見つからない')
  })
  await pickStatus('未対応')
  await pickEntity('担当者で絞り込む', '担当A（0）', '選ぶ', '担当者を選ぶ')
  await eventually(() => {
    const assigneeCall = calls.filter((url) => url.pathname === '/api/chats').at(-1)!
    expect(assigneeCall.searchParams.get('operatorId')).toBe('operator-a')
  })
  await click('1時間以上待ち')
  await act(async () => { document.querySelector<HTMLInputElement>('[aria-label="未読だけ表示"]')!.click() })

  await eventually(() => expect(state('filtered-empty')).toBeTruthy())
  expect(list().textContent).toContain('条件に一致する会話がありません')
  expect(list().contains(state('filtered-empty'))).toBe(true)
  await click('絞り込みを外す')
  await eventually(() => expect(list().textContent).toContain('戻った会話'))

  const line = calls.filter((url) => url.pathname === '/api/chats').at(-1)!
  const email = calls.filter((url) => url.pathname === '/api/support/inbox').at(-1)!
  for (const key of ['q', 'status', 'operatorId', 'assignee', 'unreadOnly', 'quickFilter']) {
    expect(line.searchParams.has(key), `line:${key}`).toBe(false)
    if (key === 'status') expect(email.searchParams.get(key), 'email:status').toBe('all')
    else expect(email.searchParams.has(key), `email:${key}`).toBe(false)
  }
})

test('未選択の中央に件数と行き先を出し、押すと最も古い会話を開く（ID27）', async () => {
  const row = (name: string, at: string) => ({
    id: `chat-${name}`, friendId: `friend-${name}`, friendName: name, operatorId: 'operator-a',
    status: 'unread', isUnread: true, lastMessageAt: at,
    lastMessageContent: name, lastMessageType: 'text', lastMessageDirection: 'incoming',
  })
  handler = (url) => {
    if (url.pathname === '/api/chats/quick-counts') {
      const status = url.searchParams.get('status')
      if (status === 'unread') return response({ success: true, data: { all: 2, reply: 2, overdue: 0 } })
      if (status) return response({ success: true, data: { all: 0, reply: 0, overdue: 0 } })
      return response({ success: true, data: { all: 5, reply: 2, overdue: 1 } })
    }
    if (url.pathname === '/api/chats') {
      return response({ success: true, data: [
        row('新しい会話', '2026-09-02T00:00:00.000Z'),
        row('古い会話', '2026-09-01T00:00:00.000Z'),
      ] })
    }
    const single = url.pathname.match(/^\/api\/chats\/([^/]+)$/)
    if (single && single[1].startsWith('chat-')) {
      const name = single[1].slice(5)
      return response({ success: true, data: {
        id: single[1], friendId: `friend-${name}`, friendName: name, friendRealName: null, friendPictureUrl: null,
        isAttention: false, operatorId: null, status: 'unread', notes: null, revision: 1,
        lastMessageAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', total: 1,
        messages: [{
          id: 'm1', direction: 'incoming', messageType: 'text', content: 'こんにちは', isUnsent: false,
          source: 'user', originKind: null, sentByStaffId: null, sentByStaffName: null,
          scenarioName: null, quoted: null, createdAt: '2026-09-01T00:00:00.000Z',
        }],
        hasMoreMessages: false,
      } })
    }
    return base(url)
  }
  await act(async () => root.render(<ChatsPage />))
  await eventually(() => expect(document.body.textContent).toContain('対応が必要な会話があります'))
  // SLA無し（期限の口が無い試験）なので「1時間以上待ち」。件数はサーバー集計。
  expect(document.body.textContent).toContain('未対応 2 件・1時間以上待ち 1 件')
  await click('いちばん古い会話を開く')
  await eventually(() => expect(document.body.textContent).toContain('こんにちは'))
  expect(document.body.textContent).not.toContain('対応が必要な会話があります')
})

test('中央の行き先からメールも開ける（共用の開き方・ID27）', async () => {
  handler = (url) => {
    if (url.pathname === '/api/chats/quick-counts') {
      const status = url.searchParams.get('status')
      if (status) return response({ success: true, data: { all: status === 'unread' ? 1 : 0, reply: 0, overdue: 0 } })
      return response({ success: true, data: { all: 1, reply: 1, overdue: 0 } })
    }
    if (url.pathname === '/api/chats') return response({ success: true, data: [] })
    if (url.pathname === '/api/support/inbox') return response(emailPayload(['問合せメール']))
    const thread = url.pathname.match(/^\/api\/support\/email\/threads\/([^/]+)$/)
    if (thread && !url.pathname.endsWith('/read')) {
      return response({ success: true, data: {
        thread: {
          id: thread[1], subject: '問合せメール', customer_name: '問合せメール',
          customer_email: 'a@example.test', status: 'unread', assigned_staff_id: null, notes: null, revision: 1,
        },
        messages: [{
          id: 'em1', direction: 'incoming', body_text: 'メール本文です',
          sent_by_staff_name: null, created_at: '2026-09-01T00:00:00.000Z',
        }],
      } })
    }
    return base(url)
  }
  await act(async () => root.render(<ChatsPage />))
  await eventually(() => expect(document.body.textContent).toContain('いちばん古い会話を開く'))
  await click('いちばん古い会話を開く')
  await eventually(() => expect(document.body.textContent).toContain('メール本文です'))
  expect(document.body.textContent).not.toContain('対応が必要な会話があります')
})

test('Instagram のURLでも表示できない一覧には切り替えない', async () => {
  fixture.params = new URLSearchParams('channel=instagram')
  handler = (url) => url.pathname === '/api/chats' ? response(linePayload(['通常の会話'])) : base(url)
  await act(async () => root.render(<ChatsPage />))
  await eventually(() => expect(list().textContent).toContain('通常の会話'))
})

test('メールの一覧が空のときメール向けの案内を表示する', async () => {
  fixture.params = new URLSearchParams('channel=email')
  await act(async () => root.render(<ChatsPage />))
  await eventually(() => expect(state('empty')?.textContent).toContain('メールが届くとここに出ます。'))
})
