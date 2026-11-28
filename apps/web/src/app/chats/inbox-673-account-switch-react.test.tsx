// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatsPage from './page'

/**
 * 受信箱deep-linkの「アカウント境界」を本物のReactで動かす試験(#673)。
 *
 * `inbox-673-behavior.spec.mjs`（Playwright）の同名シナリオは、ページ
 * ロード時に最初から切替後のアカウントを選んだ状態で開くだけで、
 * 「B選択中に開き、所属確認が終わる前に実際にB→Aへ切り替える」動的な
 * 競合を再現していない（司令塔の独立再審査での指摘）。
 *
 * ここは本物のReact(react-dom/client)で本物の `ChatsPage` を mount し、
 * `useAccount` が返す `selectedAccountId` を試験の途中で書き換えて
 * 再レンダリングすることで、chats画面が実際に受け取る効果の再実行を
 * そのまま通す。差し替えるのは通信(fetch)・アカウント文脈・ルーティング
 * だけで、画面本体・`api.ts`は実物を通す。
 *
 * Required gate（`pnpm --filter web test`）はvitestの `src/**\/*.test.tsx`
 * を拾うので、この試験はそのまま必須ゲートに含まれる（`@vitest-environment
 * happy-dom` はファイル単位の指定で、`apps/web/package.json` /
 * `vitest.config.ts` を変更する必要が無い）。
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-b' as string,
  params: new URLSearchParams(),
}))

const net = vi.hoisted(() => ({
  calls: [] as string[],
  handler: ((url: string) =>
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

/** 通信そのものを差し替える。api・fetchApiは実物を通す。 */
function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : String(input)
    const path = raw.startsWith('http') ? raw.slice(new URL(raw).origin.length) : raw
    net.calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${path}`)
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
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function friendDetail(id: string, lineAccountId: string) {
  return {
    id, displayName: id, pictureUrl: null, isFollowing: true, metadata: {},
    lineAccountId,
    realName: null, systemDisplayName: null, refCode: null,
    createdAt: '2026-09-01T00:00:00.000Z', tags: [], formSubmissions: [], support: null,
  }
}

function chatDetail(id: string, name: string, message: string) {
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
    messages: [{
      id: `message-${id}`,
      direction: 'incoming',
      messageType: 'text',
      isUnsent: false,
      content: message,
      source: 'line',
      originKind: null,
      sentByStaffId: null,
      sentByStaffName: null,
      scenarioName: null,
      createdAt: '2026-09-09T00:00:00.000Z',
    }],
    hasMoreMessages: false,
  }
}

/**
 * 会話が始まる前のfriend照会だけ差し替え可能にした、それ以外は既定応答の
 * 一括ハンドラ。Playwright版 `prepareInbox` と同じ形の口を揃える。
 */
function baseHandler(options: {
  friendHandler: (id: string) => Promise<unknown>
  chatDetails?: Record<string, unknown>
}) {
  return (path: string): Promise<unknown> => {
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
      return options.friendHandler(decodeURIComponent(friendMatch[1]))
    }
    const chatMatch = path.match(/^\/api\/chats\/([^/?]+)(\?|$)/)
    if (chatMatch) {
      const id = decodeURIComponent(chatMatch[1])
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
    if (path.endsWith('/read')) {
      return Promise.resolve({ success: true, data: { isUnread: false } })
    }
    return Promise.resolve({ success: true, data: [] })
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fixture.accountId = 'account-b'
  fixture.params = new URLSearchParams()
  net.calls.length = 0
  vi.stubGlobal('localStorage', new Map<string, string>() as unknown as Storage)
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
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

function talkPaneText(): string {
  const pane = host.querySelector('[data-inbox-v4="talk-pane"]')
  return pane?.textContent ?? ''
}

const OTHER_ACCOUNT_NOTICE = 'いま選んでいるLINEアカウントの相手ではありません'

describe('受信箱deep-linkのアカウント切替競合(#673)', () => {
  it('B選択中にfriend Aを開き、照会が終わる前に実際にA社へ切り替えると、正しくA社の会話が開く', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const friendCalls: string[] = []
    net.handler = baseHandler({
      friendHandler: (id) => {
        friendCalls.push(id)
        // 1回目(B選択中)はpendingのまま。2回目(A切替後)を先に解決する。
        return friendCalls.length === 1 ? first.promise : second.promise
      },
      chatDetails: {
        'friend-a': chatDetail('friend-a', 'A社 太郎', 'A社あての問い合わせ'),
      },
    })

    fixture.params = new URLSearchParams('friend=friend-a')
    await render()
    await flush()

    // 1回目のfriends.get('friend-a')が発行され、pendingのまま止まっている。
    expect(friendCalls).toEqual(['friend-a'])
    expect(talkPaneText()).not.toContain('A社あての問い合わせ')

    // 照会が終わる前に、実際にB→Aへアカウントを切り替える。
    fixture.accountId = 'account-a'
    await render()
    await flush()

    // selectedAccountIdの変化でdeep-link解決useEffectが再実行され、
    // 2回目のfriends.get('friend-a')が発行される。
    expect(friendCalls).toEqual(['friend-a', 'friend-a'])

    // 2回目(A選択・一致)を先に解決する。
    await act(async () => { second.resolve({ success: true, data: friendDetail('friend-a', 'account-a') }) })
    await flush()

    expect(talkPaneText()).toContain('A社あての問い合わせ')
    expect(talkPaneText()).not.toContain(OTHER_ACCOUNT_NOTICE)

    // 1回目(B選択時点)の遅延応答が後から返っても、正しい表示を崩さない。
    await act(async () => { first.resolve({ success: true, data: friendDetail('friend-a', 'account-a') }) })
    await flush()

    expect(talkPaneText()).toContain('A社あての問い合わせ')
    expect(talkPaneText()).not.toContain(OTHER_ACCOUNT_NOTICE)
  })

  it('遅延していたB時点の他アカウント判定が、A切替後に届いても正しい表示を汚染しない', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const friendCalls: string[] = []
    net.handler = baseHandler({
      friendHandler: (id) => {
        friendCalls.push(id)
        return friendCalls.length === 1 ? first.promise : second.promise
      },
      chatDetails: {
        'friend-a': chatDetail('friend-a', 'A社 太郎', 'A社あての問い合わせ'),
      },
    })

    // friend-aは常にaccount-a所属。B選択中に開けば不一致、A選択中に開けば一致。
    fixture.params = new URLSearchParams('friend=friend-a')
    await render()
    await flush()
    expect(friendCalls).toEqual(['friend-a'])

    // 1回目の照会(B時点)が返る前に、A社へ切り替える。
    fixture.accountId = 'account-a'
    await render()
    await flush()
    expect(friendCalls).toEqual(['friend-a', 'friend-a'])

    // 2回目(A選択・一致)を先に解決 → 正しく開く。
    await act(async () => { second.resolve({ success: true, data: friendDetail('friend-a', 'account-a') }) })
    await flush()
    expect(talkPaneText()).toContain('A社あての問い合わせ')
    expect(talkPaneText()).not.toContain(OTHER_ACCOUNT_NOTICE)

    // 1回目(B時点、account-aとは不一致)の遅延応答が後から届く。
    // 正しく無視されれば、表示は崩れない。
    await act(async () => { first.resolve({ success: true, data: friendDetail('friend-a', 'account-a') }) })
    await flush()

    expect(talkPaneText()).toContain('A社あての問い合わせ')
    expect(talkPaneText()).not.toContain(OTHER_ACCOUNT_NOTICE)
  })

  it('B選択中にfriend Aの照会が完了しても、受信箱は空状態のままで会話詳細APIを呼ばない', async () => {
    const friendCalls: string[] = []
    net.handler = baseHandler({
      friendHandler: (id) => {
        friendCalls.push(id)
        // 照会は保留にせず即座に完了させる。B選択中にA社所属の応答が
        // 返ってきた「後」でも境界チェックが会話APIを止めることを見る。
        return Promise.resolve({ success: true, data: friendDetail(id, 'account-a') })
      },
      chatDetails: {
        'friend-a': chatDetail('friend-a', 'A社 太郎', 'A社あての問い合わせ'),
      },
    })

    fixture.accountId = 'account-b'
    fixture.params = new URLSearchParams('friend=friend-a')
    await render()
    await flush()
    await flush()

    // 会話詳細APIは一度も呼ばれていない。呼べば別アカウントの
    // 中身がそのまま見えてしまう。境界判定が壊れたときに真っ先に
    // 崩れる箇所なので、他のアサーションより先に見る。
    // `limit=` 等のクエリが付くため前方一致で見る。
    expect(net.calls.some((c) => c.startsWith('GET /api/chats/friend-a'))).toBe(false)
    // 受信箱は空状態のまま。別人の中身はどこにも出ない。
    expect(talkPaneText()).not.toContain('A社あての問い合わせ')
    expect(talkPaneText()).toContain(OTHER_ACCOUNT_NOTICE)
    // 照会そのものは行われ、完了している(境界判定のために必要な1回)。
    expect(friendCalls).toContain('friend-a')
  })
})
