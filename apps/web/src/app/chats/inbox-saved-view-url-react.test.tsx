// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatsPage from './page'

/**
 * 受信箱の保存検索をURLへ残し、再読込・URL共有で復元する試験(N-021)。
 *
 * 本物のReact(react-dom/client)で本物の `ChatsPage` を mount し、
 * `useSearchParams` が返すURLを試験側で書き換えて再レンダリングする。
 * 差し替えるのは通信(fetch)・アカウント文脈・ルーティングだけで、
 * 画面本体・`api.ts` は実物を通す。
 *
 * URLの書き換えは「ブラウザのアドレス欄が変わる」の相当として、
 * router.push/replace の呼び出しを `nav` に記録し、試験が明示的に
 * `applyNavigation` で `fixture.params` へ反映して再レンダリングする。
 * unmount/remount は再読込の相当になる。
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string,
  params: new URLSearchParams(),
}))

const nav = vi.hoisted(() => ({
  /** push/replace が要求したURL。最後の1件が現在のアドレス欄相当。 */
  calls: [] as string[],
  last: null as string | null,
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
    push: (url: string) => { nav.calls.push(`push ${url}`); nav.last = url },
    replace: (url: string) => { nav.calls.push(`replace ${url}`); nav.last = url },
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
    selectedAccount: { emailInboxEnabled: true },
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

type SavedViewFixture = {
  id: string
  name: string
  conditions: Record<string, unknown>
}

function savedView(id: string, name: string, conditions: Record<string, unknown>): SavedViewFixture {
  return { id, name, conditions }
}

/** 「未対応・期限超過・LINEだけ」の保存検索。 */
function overdueLineView(id: string): SavedViewFixture {
  return savedView(id, '未対応・期限超過', {
    version: 1,
    query: '',
    channels: ['line'],
    statuses: ['unread'],
    assignees: [],
    unread: 'all',
    messageTypes: [],
    receivedFrom: null,
    receivedTo: null,
    sort: 'newest',
    due: 'overdue',
  })
}

/**
 * 保存検索一覧だけ差し替え可能にした、それ以外は既定応答の一括ハンドラ。
 * `inbox-673-account-switch-react.test.tsx` の baseHandler と同じ形の口を揃える。
 */
function baseHandler(options: {
  savedViews?: (accountId: string | null) => Promise<unknown>
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
      const accountId = new URLSearchParams(path.split('?')[1] ?? '').get('lineAccountId')
      if (options.savedViews) return options.savedViews(accountId)
      return Promise.resolve({ success: true, data: [] })
    }
    if (path.startsWith('/api/support/inbox')) {
      return Promise.resolve({ success: true, data: { items: [] } })
    }
    if (path.startsWith('/api/operators')) {
      return Promise.resolve({ success: true, data: [] })
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
  fixture.accountId = 'account-a'
  fixture.params = new URLSearchParams()
  nav.calls.length = 0
  nav.last = null
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

/**
 * router.push/replace が要求したURLをアドレス欄へ反映して再レンダリングする。
 * 実ブラウザでは遷移そのものが再レンダリングを起こすので、ここでは
 * 「URLを変えて描き直す」操作を明示的に行う。
 */
async function applyNavigation() {
  if (!nav.last) return
  const url = new URL(nav.last, 'http://localhost')
  fixture.params = new URLSearchParams(url.search)
  nav.last = null
  await render()
  await flush()
}

/** 一覧取得のクエリをURLSearchParamsとして返す。 */
function chatsListQueries(): URLSearchParams[] {
  return net.calls
    .filter((call) => call.startsWith('GET /api/chats?'))
    .map((call) => new URLSearchParams(call.slice('GET /api/chats?'.length)))
}

/** 「保存した検索」ドロップダウンを開く。 */
async function openSavedViews() {
  const toggle = [...host.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === '保存した検索',
  )
  expect(toggle).toBeTruthy()
  await act(async () => { toggle!.click() })
  await flush()
}

/** ドロップダウン内の保存検索を名前で押す。 */
async function clickSavedView(name: string) {
  const item = [...document.body.querySelectorAll('button')].find(
    (button) => button.textContent?.includes(name),
  )
  expect(item, `保存検索「${name}」のボタン`).toBeTruthy()
  await act(async () => { item!.click() })
  await flush()
}

const MISSING_VIEW_NOTICE = 'URLの保存した検索は見つかりませんでした'

describe('受信箱の保存検索URL復元(N-021)', () => {
  it('保存検索を選ぶとURLに savedView=<id> が残り、channel付きなら両方保持する', async () => {
    net.handler = baseHandler({
      savedViews: () => Promise.resolve({ success: true, data: [overdueLineView('sv-1')] }),
    })
    await render()
    await flush()
    await openSavedViews()
    await clickSavedView('未対応・期限超過')

    // URLに savedView と channel の両方が残る。
    expect(nav.last).toBeTruthy()
    const url = new URL(nav.last!, 'http://localhost')
    expect(url.pathname).toBe('/chats')
    expect(url.searchParams.get('savedView')).toBe('sv-1')
    expect(url.searchParams.get('channel')).toBe('line')
  })

  it('savedView付きURLで開くと、一覧取得が保存された条件で走る(再読込・共有の相当)', async () => {
    net.handler = baseHandler({
      savedViews: () => Promise.resolve({ success: true, data: [overdueLineView('sv-1')] }),
    })
    fixture.params = new URLSearchParams('savedView=sv-1')
    await render()
    await flush()
    // 復元で channel=line がURLへそろえられる。
    await applyNavigation()
    await flush()

    const queries = chatsListQueries()
    expect(queries.length).toBeGreaterThan(0)
    const restored = queries[queries.length - 1]
    expect(restored.get('status')).toBe('unread')
    expect(restored.get('quickFilter')).toBe('overdue')
    // channel=line もURLに保持されている。
    expect(fixture.params.get('channel')).toBe('line')
    expect(fixture.params.get('savedView')).toBe('sv-1')
  })

  it('unmount/remount(再読込)しても同じ条件で一覧を取り直す', async () => {
    net.handler = baseHandler({
      savedViews: () => Promise.resolve({ success: true, data: [overdueLineView('sv-1')] }),
    })
    fixture.params = new URLSearchParams('savedView=sv-1&channel=line')
    await render()
    await flush()
    await applyNavigation()

    // 再読込相当: アンマウントして新しいrootで同じURLを開き直す。
    await act(async () => { root.unmount() })
    host.remove()
    net.calls.length = 0
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await render()
    await flush()
    await applyNavigation()

    const queries = chatsListQueries()
    expect(queries.length).toBeGreaterThan(0)
    const restored = queries[queries.length - 1]
    expect(restored.get('status')).toBe('unread')
    expect(restored.get('quickFilter')).toBe('overdue')
  })

  it('不明・削除済みのIDは適用せず、既定条件へ戻して案内し、URLから外す', async () => {
    net.handler = baseHandler({
      // sv-1 は存在しない(削除済み)一覧。
      savedViews: () => Promise.resolve({ success: true, data: [overdueLineView('sv-2')] }),
    })
    fixture.params = new URLSearchParams('savedView=sv-1')
    await render()
    await flush()
    await applyNavigation()

    // 案内が出て、URLから savedView が外れる。
    expect(host.textContent).toContain(MISSING_VIEW_NOTICE)
    expect(fixture.params.get('savedView')).toBeNull()
    // 条件は適用されず、既定(条件なし)のまま一覧を取っている。
    const queries = chatsListQueries()
    expect(queries.length).toBeGreaterThan(0)
    for (const query of queries) {
      expect(query.get('status')).toBeNull()
      expect(query.get('quickFilter')).toBeNull()
    }
  })

  it('手で条件を変えるとURLから savedView が外れ、古い条件は再適用されない', async () => {
    net.handler = baseHandler({
      savedViews: () => Promise.resolve({ success: true, data: [overdueLineView('sv-1')] }),
    })
    fixture.params = new URLSearchParams('savedView=sv-1&channel=line')
    await render()
    await flush()
    await applyNavigation()

    // 手で対応状況を変える = 保存検索の条件から外れる操作。
    const filters = host.querySelector<HTMLButtonElement>('button[aria-label="絞り込み"]')!
    expect(filters).toBeTruthy()
    await act(async () => { filters.click() })
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="対応状況で絞り込む"]')!.click() })
    const resolvedOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent === '対応済み')!
    expect(resolvedOption).toBeTruthy()
    await act(async () => { resolvedOption.querySelector<HTMLButtonElement>('button')!.click() })
    await flush()

    // URLから savedView が外れている(channelは残る)。
    expect(nav.last).toBeTruthy()
    const url = new URL(nav.last!, 'http://localhost')
    expect(url.searchParams.get('savedView')).toBeNull()
    await applyNavigation()
    await flush()

    // 外れたあとは古い条件への再上書きが無い。手で変えた対応状況は
    // resolved に変わり、手を付けていない期限超過はそのまま残る。
    const queries = chatsListQueries()
    const last = queries[queries.length - 1]
    expect(last.get('status')).toBe('resolved')
    expect(last.get('quickFilter')).toBe('overdue')
  })

  it('アカウント切替中に旧アカウントの遅い応答が届いても、新アカウントの一覧と条件を上書きしない', async () => {
    const slowA = deferred<unknown>()
    const savedViewCalls: string[] = []
    net.handler = baseHandler({
      savedViews: (accountId) => {
        savedViewCalls.push(accountId ?? '')
        // A分はpendingのまま。B分はsv-1を持たず、B側の検索だけを返す。
        if (accountId === 'account-a') return slowA.promise
        return Promise.resolve({ success: true, data: [
          savedView('sv-b', 'B社の検索', {
            version: 1, query: '', channels: [], statuses: [], assignees: [],
            unread: 'all', messageTypes: [], receivedFrom: null, receivedTo: null,
            sort: 'newest', due: 'all',
          }),
        ] })
      },
    })
    fixture.params = new URLSearchParams('savedView=sv-1')
    await render()
    await flush()
    expect(savedViewCalls).toEqual(['account-a'])

    // Aの応答が届く前にBへ切り替える。
    fixture.accountId = 'account-b'
    await render()
    await flush()
    expect(savedViewCalls).toEqual(['account-a', 'account-b'])

    // Bの一覧(sv-1を持たない)が届いたので、IDは不明として案内が出る。
    expect(host.textContent).toContain(MISSING_VIEW_NOTICE)

    // ここでAの遅い応答(sv-1を持つ)が届いても、Bの一覧を上書きしない。
    await act(async () => {
      slowA.resolve({ success: true, data: [
        savedView('sv-1', 'A社の検索', {
          version: 1, query: '', channels: [], statuses: ['unread'], assignees: [],
          unread: 'all', messageTypes: [], receivedFrom: null, receivedTo: null,
          sort: 'newest', due: 'overdue',
        }),
      ] })
    })
    await flush()

    // ドロップダウンに並ぶのはBの検索だけ。Aの名前は出ない。
    await openSavedViews()
    expect(document.body.textContent).toContain('B社の検索')
    expect(document.body.textContent).not.toContain('A社の検索')

    // Aの条件(status=unread, quickFilter=overdue)で一覧が取り直されていない。
    for (const query of chatsListQueries()) {
      expect(query.get('status')).not.toBe('unread')
      expect(query.get('quickFilter')).not.toBe('overdue')
    }
    // 案内は消えず、A側の保存検索が適用された形跡がない。
    expect(host.textContent).toContain(MISSING_VIEW_NOTICE)
  })

  it('切替後のアカウントに同じIDがあれば、旧一覧で判定せず新しい一覧が届いてから復元する', async () => {
    const slowA = deferred<unknown>()
    net.handler = baseHandler({
      savedViews: (accountId) => {
        // A分はpendingのまま。B分にも同じID sv-1 がある(共有検索)。
        if (accountId === 'account-a') return slowA.promise
        return Promise.resolve({ success: true, data: [overdueLineView('sv-1')] })
      },
    })
    fixture.params = new URLSearchParams('savedView=sv-1')
    await render()
    await flush()

    // Aの応答を待たずにBへ切り替える。Aの一覧は届いていないので
    // 手元の一覧は空のまま。ここで「見つからない」と判断すると誤り。
    fixture.accountId = 'account-b'
    await render()
    await flush()

    // Bの一覧に sv-1 があるので、Bの条件で復元される。
    const queries = chatsListQueries()
    expect(queries.length).toBeGreaterThan(0)
    expect(queries[queries.length - 1].get('status')).toBe('unread')
    expect(queries[queries.length - 1].get('quickFilter')).toBe('overdue')
    expect(host.textContent).not.toContain(MISSING_VIEW_NOTICE)
  })

  it('保存した検索の件数はカンマ付きで出し、未接続なら0件にせず「—件」と理由を出す', async () => {
    net.handler = baseHandler({
      savedViews: () => Promise.resolve({ success: true, data: [
        { ...overdueLineView('sv-1'), matchCount: 1234 },
        { ...overdueLineView('sv-2'), name: '件数がまだ無い検索', matchCount: null },
      ] }),
    })
    await render()
    await flush()
    await openSavedViews()

    const row = (name: string) => [...document.body.querySelectorAll('button')]
      .find((button) => button.getAttribute('title') === name)?.parentElement
    expect(row('未対応・期限超過')?.textContent).toContain('1,234件')
    expect(row('件数がまだ無い検索')?.textContent).toContain('—件')
    expect(row('件数がまだ無い検索')?.textContent).not.toContain('0件')
    expect(document.body.textContent).toContain('「—件」は0件ではありません。')
  })

  it('「未読だけ」と「要返信」で保存した検索を選ぶと、その2つも一覧の取得へ戻す', async () => {
    net.handler = baseHandler({
      savedViews: () => Promise.resolve({ success: true, data: [savedView('sv-mine', '自分の未読の要返信', {
        version: 1, query: '', channels: ['line'], statuses: ['unread'], assignees: [], unread: 'mine',
        quickFilter: 'reply', messageTypes: [], receivedFrom: null, receivedTo: null, sort: 'newest', due: 'all',
      })] }),
    })
    await render()
    await flush()
    await openSavedViews()
    await clickSavedView('自分の未読の要返信')
    await applyNavigation()
    await flush()

    const last = chatsListQueries().at(-1)!
    expect(last.get('unreadOnly')).toBe('1')
    expect(last.get('quickFilter')).toBe('reply')
  })

  it('保存した検索の削除は行末の「…」の中にあり、選ぶと消す口を呼んで一覧を読み直す', async () => {
    let views = [overdueLineView('sv-1')]
    net.handler = (path: string, init?: RequestInit) => {
      if (path.startsWith('/api/inbox/saved-views/sv-1') && init?.method === 'DELETE') {
        views = []
        return Promise.resolve({ success: true, data: null })
      }
      return baseHandler({ savedViews: () => Promise.resolve({ success: true, data: views }) })(path)
    }
    await render()
    await flush()
    await openSavedViews()
    // 名前の隣に削除ボタンを常設しない。
    expect([...document.body.querySelectorAll('button')].some((button) => button.textContent?.trim() === '保存した検索を削除')).toBe(false)

    const menu = [...document.body.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '未対応・期限超過の操作')
    expect(menu).toBeTruthy()
    await act(async () => { menu!.click() })
    await flush()
    const remove = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find((item) => item.textContent?.trim() === '保存した検索を削除')
    expect(remove).toBeTruthy()
    const before = net.calls.filter((call) => call.startsWith('GET /api/inbox/saved-views')).length
    await act(async () => { remove!.click() })
    await flush()
    await flush()

    expect(net.calls.some((call) => call.startsWith('DELETE /api/inbox/saved-views/sv-1'))).toBe(true)
    expect(net.calls.filter((call) => call.startsWith('GET /api/inbox/saved-views')).length).toBeGreaterThan(before)
  })
})
