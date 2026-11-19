// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SupportInbox from './support-inbox'

/**
 * 問い合わせ受信箱を本物のReactで動かす試験(#630)。
 *
 * 手作りのhook台では、絞り込みを「対応済み」「すべて」へ変えたときに
 * 1回も取りに行かず前の一覧が残る不具合がすり抜けた。ここは本物の
 * React(react-dom/client)・本物のタイマー(fake)・本物の
 * startVisiblePollで、画面に出る文字と通信の本数だけを見る。
 * 差し替えるのは通信(fetchApi)と next/link だけ。
 */

type ThreadStatus = 'unread' | 'in_progress' | 'on_hold' | 'resolved'

const net = vi.hoisted(() => ({
  handler: (url: string): Promise<unknown> => Promise.reject(new Error(`未設定: ${url}`)),
  calls: [] as string[],
}))

vi.mock('next/link', () => ({ default: () => null }))

/*
 * 共通の Select は listbox の部品で、その操作は部品自身の試験が持つ。
 * ここで見たいのは選んだ後の受信箱の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, value, onChange, options }: {
    'aria-label': string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
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

function item(id: string, name: string, status: ThreadStatus) {
  return {
    id,
    threadId: id,
    channel: 'email' as const,
    customerName: name,
    customerIdentifier: `${id}@example.com`,
    subject: `件名 ${id}`,
    preview: `本文 ${id}`,
    status,
    lastMessageAt: '2026-09-09T00:00:00.000Z',
    lastIncomingAt: '2026-09-09T00:00:00.000Z',
  }
}

/** 絞り込みごとに返す一覧。試験の中で入れ替える。 */
const inboxByStatus = new Map<string, ReturnType<typeof item>[]>()
/** スレッドごとの状態。詳細の応答に使う。 */
const threadStatus = new Map<string, ThreadStatus>()

function respond(url: string): Promise<unknown> {
  if (url.startsWith('/api/support/inbox')) {
    const status = new URL(url, 'http://x').searchParams.get('status') ?? 'open'
    return Promise.resolve({ success: true, data: { items: inboxByStatus.get(status) ?? [] } })
  }
  const match = /^\/api\/support\/email\/threads\/([^/?]+)$/.exec(url)
  if (match) {
    const id = decodeURIComponent(match[1])
    return Promise.resolve({
      success: true,
      data: {
        thread: {
          id,
          customer_email: `${id}@example.com`,
          customer_name: null,
          subject: `件名 ${id}`,
          status: threadStatus.get(id) ?? 'unread',
          last_message_at: '2026-09-09T00:00:00.000Z',
        },
        messages: [],
      },
    })
  }
  return Promise.reject(new Error(`未設定のURL: ${url}`))
}

const inboxCalls = (status: string) =>
  net.calls.filter((url) => url.includes(`status=${status}&`)).length
const detailCalls = (id: string) =>
  net.calls.filter((url) => url === `/api/support/email/threads/${id}`).length

let host: HTMLDivElement
let root: Root
let hidden = false

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-17T00:00:00.000Z'))
  net.calls.length = 0
  net.handler = respond
  inboxByStatus.clear()
  threadStatus.clear()
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

async function render() {
  await act(async () => {
    root.render(<SupportInbox channel="email" />)
  })
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** 絞り込みの選択を変える。Reactが見ている値も一緒に動かす。 */
async function selectFilter(next: string) {
  const select = host.querySelector('select')
  if (!select) throw new Error('絞り込みが見つかりません')
  const setValue = Object.getOwnPropertyDescriptor(
    globalThis.HTMLSelectElement.prototype,
    'value',
  )?.set
  await act(async () => {
    setValue?.call(select, next)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** 一覧の行を名前で選ぶ。 */
async function choose(name: string) {
  const row = Array.from(host.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(name),
  )
  if (!row) throw new Error(`${name} の行が見つかりません`)
  await act(async () => {
    row.click()
  })
}

describe('問い合わせ受信箱の実React動作(#630)', () => {
  it('別の会話を選ぶと、取得中は前の会話の詳細を消す', async () => {
    inboxByStatus.set('open', [item('t1', '最初さん', 'resolved'), item('t2', '次の人', 'unread')])
    threadStatus.set('t1', 'resolved')
    let resolveNext: (value: unknown) => void = () => { throw new Error('未設定') }
    net.handler = (url) => url === '/api/support/email/threads/t2'
      ? new Promise((resolve) => { resolveNext = resolve })
      : respond(url)
    await render()
    await choose('最初さん')
    expect(host.querySelector('h2')?.textContent).toBe('件名 t1')
    await choose('次の人')
    expect(host.querySelector('h2')?.textContent).not.toBe('件名 t1')
    await act(async () => { resolveNext(await respond('/api/support/email/threads/t2')) })
    expect(host.querySelector('h2')?.textContent).toBe('件名 t2')
  })

  it('「対応済み」「すべて」へ変えても初回は取りに行き、前の一覧を残さない', async () => {
    inboxByStatus.set('open', [item('t1', '未解決さん', 'unread')])
    inboxByStatus.set('resolved', [item('t2', '対応済みさん', 'resolved')])
    inboxByStatus.set('all', [item('t3', 'すべてさん', 'in_progress')])

    await render()
    expect(host.textContent).toContain('未解決さん')
    expect(inboxCalls('open')).toBe(1)

    // 対応済みは5秒更新の対象外だが、初回の1回は取る。
    await selectFilter('resolved')
    expect(inboxCalls('resolved')).toBe(1)
    expect(host.textContent).toContain('対応済みさん')
    expect(host.textContent).not.toContain('未解決さん')

    // 取ったあとは回さない(処理中/未解決だけが5秒更新の対象)。
    await wait(30_000)
    expect(inboxCalls('resolved')).toBe(1)

    // すべても同じ。1回だけ取って回さない。
    await selectFilter('all')
    expect(inboxCalls('all')).toBe(1)
    expect(host.textContent).toContain('すべてさん')
    await wait(30_000)
    expect(inboxCalls('all')).toBe(1)

    // 未解決へ戻したら5秒更新が復活する。
    await selectFilter('open')
    const openCalls = inboxCalls('open')
    await wait(5000)
    expect(inboxCalls('open')).toBe(openCalls + 1)
  })

  it('対応済みを選んだあと未対応へ選び直すと、選び直した方を取り直し続ける', async () => {
    threadStatus.set('t1', 'resolved')
    threadStatus.set('t2', 'unread')
    inboxByStatus.set('open', [item('t1', '済んださん', 'resolved'), item('t2', 'まださん', 'unread')])

    await render()

    // 対応済みを選ぶ。詳細は1回取ったら取り直さない。
    await choose('済んださん')
    expect(detailCalls('t1')).toBe(1)
    await wait(15_000)
    expect(detailCalls('t1')).toBe(1)

    // 未対応へ選び直す。前の「対応済み」を見て止めてはいけない。
    await choose('まださん')
    expect(detailCalls('t2')).toBe(1)
    await wait(5000)
    expect(detailCalls('t2')).toBe(2)
    await wait(5000)
    expect(detailCalls('t2')).toBe(3)
    // 選んでいない方は取り直さない。
    expect(detailCalls('t1')).toBe(1)
  })

  it('非表示タブで開いたら取りに行かず、表示に戻った時点ですぐ取る', async () => {
    inboxByStatus.set('open', [item('t1', '未解決さん', 'unread')])
    hidden = true

    await render()
    await wait(30_000)
    expect(inboxCalls('open')).toBe(0)
    expect(host.querySelector('[aria-label="対応待ちを読み込んでいます"][aria-busy="true"]')).not.toBeNull()

    hidden = false
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(inboxCalls('open')).toBe(1)
    expect(host.textContent).toContain('未解決さん')
  })
})
