// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EmailThread from './email-thread'

/**
 * メール会話を本物のReactで動かす試験(#630)。
 *
 * 手作りのhook台では「描画のあとにeffectが動く」順番が出ないので、
 * 前のスレッドの状態を見て新しいスレッドを取りに行かない不具合が
 * すり抜けた。ここは本物のReact(react-dom/client)・本物のタイマー
 * (fake)・本物のstartVisiblePollで、画面に出る文字だけを見る。
 * 差し替えるのは通信(fetchApi)だけ。
 */

type ThreadStatus = 'unread' | 'in_progress' | 'on_hold' | 'resolved'

const net = vi.hoisted(() => ({
  handler: (url: string): Promise<unknown> => Promise.reject(new Error(`未設定: ${url}`)),
  calls: [] as string[],
}))

vi.mock('../../lib/api', async (importOriginal: () => Promise<typeof import('../../lib/api')>) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchApi: (url: string) => {
      net.calls.push(url)
      return net.handler(url)
    },
  }
})

vi.mock('../chats/template-picker', () => ({ default: () => null }))

/*
 * 「対応」欄は共通 Select（listbox）。ここで見たいのは選んだ後の
 * 会話の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label'?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))

function threadBody(id: string, status: ThreadStatus, subject: string) {
  return {
    success: true,
    data: {
      thread: {
        id,
        subject,
        customer_name: null,
        customer_email: `${id}@example.com`,
        status,
        assigned_staff_id: null,
        notes: null,
        revision: 1,
      },
      messages: [],
    },
  }
}

/** いまのスレッドの状態。試験の途中で書き換えて「相手が再オープンした」を作る。 */
const state = new Map<string, ThreadStatus>()

function respond(url: string): Promise<unknown> {
  if (url.startsWith('/api/operators')) return Promise.resolve({ success: true, data: [] })
  // 状態の書き換えは成功だけ返す。何に変えたかは試験側が `state` に入れる。
  if (/\/status$/.test(url)) return Promise.resolve({ success: true })
  const match = /^\/api\/support\/email\/threads\/([^/?]+)$/.exec(url)
  if (match) {
    const id = decodeURIComponent(match[1])
    const status = state.get(id)
    if (!status) return Promise.reject(new Error('not found'))
    return Promise.resolve(threadBody(id, status, `件名 ${id}`))
  }
  return Promise.reject(new Error(`未設定のURL: ${url}`))
}

/** 会話の取得だけを数える(担当者一覧は数えない)。 */
const threadCalls = (id: string) =>
  net.calls.filter((url) => url === `/api/support/email/threads/${id}`).length

let host: HTMLDivElement
let root: Root
let hidden = false

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'))
  net.calls.length = 0
  net.handler = respond
  state.clear()
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function render(threadId: string) {
  await act(async () => {
    root.render(<EmailThread threadId={threadId} onBack={() => undefined} />)
  })
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** 画面の「対応」欄を変える。Reactが見ている値も一緒に動かす。 */
async function selectStatus(next: ThreadStatus) {
  const select = Array.from(host.querySelectorAll('select')).find((element) =>
    Array.from(element.options).some((option) => option.value === 'resolved'),
  )
  if (!select) throw new Error('対応欄が見つかりません')
  const setValue = Object.getOwnPropertyDescriptor(
    globalThis.HTMLSelectElement.prototype,
    'value',
  )?.set
  await act(async () => {
    setValue?.call(select, next)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function setVisibility(next: boolean) {
  hidden = next
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

describe('メール会話の実React動作(#630)', () => {
  it('前の会話の遅い返事で、選び直した会話を上書きしない', async () => {
    let resolveA: (value: unknown) => void = () => { throw new Error('未設定') }
    state.set('B', 'unread')
    net.handler = (url) => url === '/api/support/email/threads/A'
      ? new Promise((resolve) => { resolveA = resolve })
      : respond(url)
    await render('A')
    expect(threadCalls('A')).toBe(1)
    await render('B')
    expect(host.textContent).toContain('件名 B')
    await act(async () => { resolveA(threadBody('A', 'unread', '件名 A')) })
    expect(host.textContent).toContain('件名 B')
    expect(host.textContent).not.toContain('件名 A')
  })

  it('同じ会話でも古い更新が新しい更新を上書きしない', async () => {
    let resolveOld: (value: unknown) => void = () => { throw new Error('未設定') }
    let calls = 0
    net.handler = (url) => {
      if (url === '/api/support/email/threads/A') {
        calls += 1
        if (calls === 2) return new Promise((resolve) => { resolveOld = resolve })
        return Promise.resolve(threadBody('A', 'unread', calls === 1 ? '最初の件名' : '新しい件名'))
      }
      return respond(url)
    }
    await render('A')
    expect(host.textContent).toContain('最初の件名')
    await wait(5000)
    expect(calls).toBe(2)
    await selectStatus('in_progress')
    expect(host.textContent).toContain('新しい件名')
    await act(async () => { resolveOld(threadBody('A', 'unread', '古い件名')) })
    expect(host.textContent).toContain('新しい件名')
    expect(host.textContent).not.toContain('古い件名')
  })

  it('対応済みAから未対応Bへ切り替えても、Bの会話を初回で取って読み込み中で止まらない', async () => {
    state.set('A', 'resolved')
    state.set('B', 'unread')

    await render('A')
    expect(host.textContent).toContain('件名 A')

    // Aは対応済みなので、ここから先は取りに行かない。
    const afterA = threadCalls('A')
    await wait(30_000)
    expect(threadCalls('A')).toBe(afterA)

    // Bへ切り替える。切り替え直後の描画ではまだAの会話が残っているが、
    // その「対応済み」を見てBの初回取得を飛ばしてはいけない。
    await render('B')
    expect(threadCalls('B')).toBe(1)
    expect(host.textContent).toContain('件名 B')
    expect(host.textContent).not.toContain('会話を読み込み中')
  })

  it('対応済みで止まったあと、相手が再オープンしたら取り直しを再開する', async () => {
    state.set('A', 'unread')
    await render('A')
    expect(threadCalls('A')).toBe(1)

    // 未解決の間は5秒ごとに取り直す。
    await wait(5000)
    expect(threadCalls('A')).toBe(2)

    // 対応済みになったら止まる。
    state.set('A', 'resolved')
    await wait(5000)
    expect(threadCalls('A')).toBe(3)
    const whenResolved = threadCalls('A')
    await wait(30_000)
    expect(threadCalls('A')).toBe(whenResolved)

    // 画面の「対応」を未対応へ戻すと、同じ1本が起き直して取り直しに戻る。
    state.set('A', 'unread')
    await selectStatus('unread')
    // 状態変更そのものが1回読み直す。
    expect(threadCalls('A')).toBe(whenResolved + 1)
    // 止まったままなら、ここから先はいくら待っても増えない。
    await wait(5000)
    expect(threadCalls('A')).toBe(whenResolved + 2)
    await wait(5000)
    expect(threadCalls('A')).toBe(whenResolved + 3)
  })

  it('非表示タブで開いたら取りに行かず、表示に戻った時点ですぐ取る', async () => {
    state.set('A', 'unread')
    hidden = true

    await render('A')
    await wait(30_000)
    expect(threadCalls('A')).toBe(0)
    expect(host.textContent).toContain('会話を読み込み中')

    // 表示に戻ったら待たせない。5秒待たせると、そのあいだ
    // 「読み込み中」のままになる。
    await setVisibility(false)
    expect(threadCalls('A')).toBe(1)
    expect(host.textContent).toContain('件名 A')
  })
})
