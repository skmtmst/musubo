// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import ChatsPage from './page'
import * as toast from '@/components/shared/toast'

/**
 * 受信箱の「保存した検索」保存失敗の文言分け(N-027)。
 *
 * 本物のReactで本物の `ChatsPage` を mount し、保存APIだけ失敗を返す。
 * 409(同名競合)・403(権限)・それ以外(通信障害)で、運用者へ出る文言が
 * 分かれること、そして入力した名前が消えないことを確かめる。
 */

const fixture = vi.hoisted(() => ({
  accountId: 'account-a' as string,
  params: new URLSearchParams(),
}))

const nav = vi.hoisted(() => ({
  calls: [] as string[],
  last: null as string | null,
}))

const net = vi.hoisted(() => ({
  calls: [] as string[],
  /** 保存POSTに載った本文。 */
  saveBodies: [] as unknown[],
  /** 保存POSTへ返す応答。{status, body} で失敗を作る。 */
  saveResponse: { status: 200, body: { success: true, data: { id: 'sv-new' } } } as {
    status: number
    body: unknown
  },
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
    if (path.startsWith('/api/inbox/saved-views') && (init?.method ?? 'GET') === 'POST') {
      net.saveBodies.push(JSON.parse(String(init?.body ?? 'null')))
      return new Response(JSON.stringify(net.saveResponse.body), {
        status: net.saveResponse.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(defaultResponse(path)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

function defaultResponse(path: string): unknown {
  if (path.startsWith('/api/chats/stats')) {
    return { success: true, data: {
      total: 0, unread: 0, inProgress: 0, onHold: 0, resolved: 0,
      oldestUnansweredMinutes: null, assigneeUnread: [],
    } }
  }
  if (path.startsWith('/api/chats?')) return { success: true, data: [] }
  if (path.startsWith('/api/support/inbox')) return { success: true, data: { items: [] } }
  if (path.startsWith('/api/operators')) return { success: true, data: [] }
  if (/\/mileage(\?|$)/.test(path)) {
    return { success: true, data: {
      summary: { programId: 'p', programName: '試験マイル', available: 0, pending: 0, lifetimeEarned: 0, spent: 0 },
      history: [],
    } }
  }
  if (/\/rich-menu(\?|$)/.test(path)) {
    return { success: true, data: { id: null, name: null, isDefault: false } }
  }
  if (path.endsWith('/read')) return { success: true, data: { isUnread: false } }
  return { success: true, data: [] }
}

function makeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  } as Storage
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  fixture.accountId = 'account-a'
  fixture.params = new URLSearchParams()
  nav.calls.length = 0
  nav.last = null
  net.calls.length = 0
  net.saveBodies.length = 0
  net.saveResponse = { status: 200, body: { success: true, data: { id: 'sv-new' } } }
  vi.stubGlobal('localStorage', makeStorage())
  vi.stubGlobal('sessionStorage', makeStorage())
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

async function flush(milliseconds = 30) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, milliseconds)) })
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === label || button.textContent?.trim() === label,
  )
}

/** 「保存した検索」→「現在の条件を保存」で作成ダイアログまで進める。 */
async function openSaveDialog() {
  await act(async () => { root.render(<ChatsPage />) })
  await flush(80)
  const toggle = findButton(host, '保存した検索')
  expect(toggle, '「保存した検索」の開閉ボタン').toBeTruthy()
  await act(async () => { toggle!.click() })
  await flush()
  const openCreate = findButton(document.body, '今の条件を保存する')
  expect(openCreate, '「現在の条件を保存」ボタン').toBeTruthy()
  await act(async () => { openCreate!.click() })
  await flush()
  const dialog = document.body.querySelector('[aria-label="保存した検索を作成"]')
  expect(dialog, '作成ダイアログ').toBeTruthy()
  return dialog as HTMLElement
}

async function typeName(dialog: HTMLElement, name: string) {
  const input = dialog.querySelector<HTMLInputElement>('input[placeholder="検索名を入力してください"]')
  expect(input, '検索名の入力欄').toBeTruthy()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input!, name)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(dialog: HTMLElement) {
  const button = findButton(dialog, '検索条件を保存する')
  expect(button, '「検索条件を保存」ボタン').toBeTruthy()
  await act(async () => { button!.click() })
  await flush()
}

describe('保存した検索の保存失敗(N-027)', () => {
  it('409(同名競合)は別名を促す文言を出し、入力した名前が残る', async () => {
    net.saveResponse = { status: 409, body: { success: false, error: '同じ名前の保存検索があります' } }
    const dialog = await openSaveDialog()
    await typeName(dialog, '未対応だけ')
    await submit(dialog)

    expect(dialog.textContent).toContain('同じ名前の保存した検索があります。別の名前を入力してください。')
    expect(dialog.textContent).not.toContain('時間を置いて')
    const input = dialog.querySelector<HTMLInputElement>('input[placeholder="検索名を入力してください"]')
    expect(input?.value).toBe('未対応だけ')
    // ダイアログは開いたまま（作り直しにならない）。
    expect(document.body.querySelector('[aria-label="保存した検索を作成"]')).toBeTruthy()
  })

  it('403(権限)は管理者確認を促す文言を出す', async () => {
    net.saveResponse = { status: 403, body: { success: false, error: 'forbidden' } }
    const dialog = await openSaveDialog()
    await typeName(dialog, '担当外の検索')
    await submit(dialog)

    expect(dialog.textContent).toContain('権限がありません')
    expect(dialog.textContent).not.toContain('時間を置いて')
  })

  it('通信障害・5xxは従来どおりの汎用文言を出す', async () => {
    net.saveResponse = { status: 500, body: { success: false, error: 'Internal server error' } }
    const dialog = await openSaveDialog()
    await typeName(dialog, '朝イチの未対応')
    await submit(dialog)

    expect(dialog.textContent).toContain('保存できませんでした。時間を置いてもう一度お試しください。')
    // API内部文言は素通ししない。
    expect(dialog.textContent).not.toContain('Internal server error')
  })

  it('保存先が成功の形で失敗（success:false）を返しても、内部の文言ではなく汎用の文言を出す', async () => {
    net.saveResponse = { status: 200, body: { success: false, error: 'D1_ERROR: constraint failed' } }
    const dialog = await openSaveDialog()
    await typeName(dialog, '夕方の未対応')
    await submit(dialog)

    expect(dialog.textContent).toContain('保存できませんでした。時間を置いてもう一度お試しください。')
    expect(dialog.textContent).not.toContain('D1_ERROR')
    expect(document.body.querySelector('[aria-label="保存した検索を作成"]')).toBeTruthy()
  })
})

it('保存できた検索は名前付きのトーストで一度だけ知らせる', async () => {
  const saved = vi.spyOn(toast, 'notifySaved').mockImplementation(() => () => {})
  const dialog = await openSaveDialog()
  await typeName(dialog, '朝イチの未対応')
  await submit(dialog)
  expect(saved).toHaveBeenCalledExactlyOnceWith('保存した検索「朝イチの未対応」を保存しました')
  expect(document.body.querySelector('[aria-label="保存した検索を作成"]')).toBeNull()
})

it('窓で変えた条件と「よく使う」を、そのまま保存の口へ送る（画面の今の絞り込みで上書きしない）', async () => {
  const dialog = await openSaveDialog()
  await typeName(dialog, '対応済みの要返信')
  await act(async () => { dialog.querySelector<HTMLButtonElement>('button[aria-label="保存する対応状況"]')!.click() })
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: '対応済み' }).querySelector('button')!) })
  await act(async () => { dialog.querySelector<HTMLButtonElement>('button[aria-label="保存する絞り込み"]')!.click() })
  await act(async () => { fireEvent.click(screen.getByRole('option', { name: '要返信' }).querySelector('button')!) })
  // 画面から開いた窓では「よく使うに追加」が最初から入っている。
  expect((screen.getByRole('checkbox', { name: /よく使うに追加/ }) as HTMLInputElement).checked).toBe(true)
  await submit(dialog)

  expect(net.saveBodies).toHaveLength(1)
  expect(net.saveBodies[0]).toMatchObject({
    name: '対応済みの要返信',
    isFavorite: true,
    conditions: { statuses: ['resolved'], quickFilter: 'reply', unread: 'all', channels: ['line', 'email'] },
  })
})
