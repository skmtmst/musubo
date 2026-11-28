import { pickEntity } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import ChatsPage from './page'

const fixture = vi.hoisted(() => ({ accountId: 'account-a', params: new URLSearchParams() }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params, usePathname: () => '/chats',
  useRouter: () => ({ push() {}, replace() {} }),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({
  selectedAccountId: fixture.accountId, selectedAccount: { emailInboxEnabled: true }, loading: false,
}) }))

type Channel = 'line' | 'email'
type Pending = { resolve: (value: Response) => void }
let root: Root, host: HTMLDivElement
let calls: URL[]
let handler: (url: URL) => Promise<Response> | Response
let pending: Pending[]
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
})
function row(channel: Channel, id: string) {
  const at = '2026-09-01T00:00:00.000Z'
  return channel === 'line' ? {
    id, friendId: id, friendName: id, operatorId: 'target', status: 'unread', isUnread: true,
    lastMessageAt: at, lastMessageContent: id, lastMessageType: 'text', lastMessageDirection: 'incoming',
  } : {
    id: `email:${id}`, threadId: id, customerName: id, customerIdentifier: `${id}@example.test`,
    subject: id, preview: id, status: 'unread', assignedStaffId: 'target', isUnread: true,
    lastIncomingAt: at, lastMessageAt: at,
  }
}
function payload(channel: Channel, ids: string[], total = ids.length) {
  return channel === 'line' ? { success: true, data: ids.map(id => row(channel, id)) }
    : { success: true, data: { items: ids.map(id => row(channel, id)), summary: { total } } }
}
function listChannel(url: URL): Channel | null {
  return url.pathname === '/api/chats' ? 'line' : url.pathname === '/api/support/inbox' ? 'email' : null
}
function base(url: URL) {
  const channel = listChannel(url)
  if (channel) return response(payload(channel, []))
  if (url.pathname === '/api/operators') return response({ success: true, data: [{ id: 'target', name: '担当T' }] })
  if (url.pathname === '/api/chats/stats') return response({ success: true, data: {
    total: 0, unread: 0, assigneeUnread: [], waitingOverAnHour: 0,
  } })
  if (url.pathname === '/api/chats/quick-counts') return response({ success: true, data: {
    all: 0, reply: 0, overdue: 0,
    line: { all: 0, reply: 0, overdue: 0 }, email: { all: 0, reply: 0, overdue: 0 },
  } })
  return response({ success: true, data: [] })
}
function hold() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(done => { resolve = done })
  pending.push({ resolve })
  return { promise, resolve }
}
beforeEach(() => {
  calls = []; pending = []; handler = base
  fixture.accountId = 'account-a'
  fixture.params = new URLSearchParams()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) })
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
    for (const p of pending) p.resolve(response({ success: false }, 503))
    await Promise.resolve()
  })
  await act(async () => root.unmount())
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const render = async () => { await act(async () => root.render(<ChatsPage />)) }
async function click(text: string) {
  if (text === '要返信' || text === '1時間以上待ち') {
    let control = document.querySelector<HTMLButtonElement>('button[aria-label="期限で絞り込む"]')
    if (!control) {
      const open = document.querySelector<HTMLButtonElement>('button[aria-label="絞り込み"]')!
      await act(async () => { open.click() })
      control = document.querySelector<HTMLButtonElement>('button[aria-label="期限で絞り込む"]')
    }
    await act(async () => { control!.click() })
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent?.trim().startsWith(text))!
    await act(async () => { option.querySelector('button')!.click() })
    return
  }
  const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim().startsWith(text) || b.getAttribute('aria-label') === text)
  expect(button, text).toBeTruthy()
  await act(async () => { button!.click() })
}
async function selectAssignee(value: string) {
  if (!document.querySelector('[aria-label="担当者で絞り込む"]')) await click('絞り込み')
  // 担当者の選択は候補つき入力へ移した。表示名を打って候補を押す。
  const label = value === 'unassigned' ? '未割り当て' : '担当T（0）'
  await pickEntity('担当者で絞り込む', label, '選択する', '担当者を選ぶ')
}
const listCalls = (channel: Channel) => calls.filter(url => listChannel(url) === channel)

test('実UIから担当・未割当・未読・要返信・期限を両APIへ送る', async () => {
  await render()
  await selectAssignee('target')
  expect(listCalls('line').at(-1)?.searchParams.get('operatorId')).toBe('target')
  expect(listCalls('email').at(-1)?.searchParams.get('assignee')).toBe('target')
  await selectAssignee('unassigned')
  expect(listCalls('line').at(-1)?.searchParams.get('operatorId')).toBe('unassigned')
  expect(listCalls('email').at(-1)?.searchParams.get('assignee')).toBe('unassigned')
  await act(async () => { document.querySelector<HTMLInputElement>('[aria-label="未読だけ表示"]')!.click() })
  for (const channel of ['line', 'email'] as const) expect(listCalls(channel).at(-1)?.searchParams.get('unreadOnly')).toBe('1')
  await click('絞り込みを閉じる')
  await click('要返信')
  for (const channel of ['line', 'email'] as const) expect(listCalls(channel).at(-1)?.searchParams.get('quickFilter')).toBe('reply')
  await click('1時間以上待ち')
  for (const channel of ['line', 'email'] as const) expect(listCalls(channel).at(-1)?.searchParams.get('quickFilter')).toBe('overdue')
})

describe.each(['line', 'email'] as const)('%s 一覧の条件変更', channel => {
  test('続きも同じ条件を送り、変更直後に一覧とページをリセットする', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `old-${channel}-${i}`)
    const next = hold()
    handler = url => listChannel(url) !== channel ? base(url)
      : url.searchParams.has('quickFilter') ? next.promise.then(r => r.clone()) : response(payload(channel, ids, 401))
    await render()
    await click(channel === 'line' ? 'さらに読み込む' : 'メールの続きを読み込む')
    expect(listCalls(channel).at(-1)?.searchParams.get(channel === 'line' ? 'beforeId' : 'offset'))
      .toBe(channel === 'line' ? ids.at(-1) : '200')
    await click('1時間以上待ち')
    expect(host.textContent).not.toContain(ids[0])
    expect(listCalls(channel).at(-1)?.searchParams.has(channel === 'line' ? 'beforeId' : 'offset')).toBe(false)
    await act(async () => { next.resolve(response(payload(channel, ids, 401))) })
    await click(channel === 'line' ? 'さらに読み込む' : 'メールの続きを読み込む')
    expect(listCalls(channel).at(-1)?.searchParams.get('quickFilter')).toBe('overdue')
    // 200件を描画するため、負荷が重い実行では5秒を越えることがある。
  }, 20000)

  test.each([
    ['initial', false], ['append', false], ['initial', true], ['append', true],
  ] as const)('%s の旧条件の遅い応答を破棄する（失敗=%s）', async (mode, failed) => {
    const old = hold()
    const ids = Array.from({ length: 200 }, (_, i) => `seed-${i}`)
    handler = url => {
      if (listChannel(url) !== channel) return base(url)
      if (url.searchParams.has('quickFilter')) return response(payload(channel, ['new-current']))
      if (mode === 'initial' || url.searchParams.has(channel === 'line' ? 'beforeId' : 'offset')) return old.promise
      return response(payload(channel, ids, 401))
    }
    await render()
    if (mode === 'append') await click(channel === 'line' ? 'さらに読み込む' : 'メールの続きを読み込む')
    await click('1時間以上待ち')
    await act(async () => { old.resolve(failed ? response({ success: false }, 503) : response(payload(channel, ['stale-result']))) })
    expect(host.textContent).toContain('new-current')
    expect(host.textContent).not.toContain('stale-result')
    expect(host.textContent).not.toContain('読み込めませんでした')
    expect(host.textContent).not.toContain('追加読み込みに失敗')
  })

  test('新条件の取得が失敗しても旧一覧を復活させない', async () => {
    handler = url => listChannel(url) !== channel ? base(url)
      : url.searchParams.has('quickFilter') ? response({ success: false }, 503)
        : response(payload(channel, ['old-before-failure']))
    await render()
    expect(host.textContent).toContain('old-before-failure')
    await click('1時間以上待ち')
    expect(host.textContent).not.toContain('old-before-failure')
    expect(host.textContent).toContain('読み込めませんでした')
  })
})
