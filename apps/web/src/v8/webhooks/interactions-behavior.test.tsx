// @vitest-environment happy-dom
/*
 * ★V8 外部連携「やり取りの記録」の動き。
 * 読み込み中・空・失敗を分けること、期間を書いた補足、結果が分からない失敗を無条件に送り直さないこと、
 * まとめて再試行したあとの残りの知らせ、やり直せる範囲の説明、アカウントを替えたときの古い結果の捨て方を、
 * 描いた画面と口の呼び出しで確かめる。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebhookInteraction } from '@line-crm/shared'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams('tab=interactions'),
}))
let accountId = 'account-a'
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: accountId, selectedAccount: { id: accountId, name: accountId }, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }] })) }))
let role = 'owner'
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role }
})

import WebhooksInteractionsV8 from './interactions'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

function interaction(overrides: Partial<WebhookInteraction> = {}): WebhookInteraction {
  return {
    id: 'wi-1', direction: 'outgoing', webhookName: '予約台帳', eventType: 'booking_created', triggerSummary: '予約が入った・Masato S.',
    status: 'failed', responseLabel: '500 エラー', responseStatus: 500, attemptCount: 1, durationMs: 1200,
    confirmationRevision: 2, webhookRevision: 3, failureReason: null, failureReasonCode: 'response_5xx', canRetry: true, retryBlockReason: null, autoRetryNextAt: null,
    startedAt: '2026-09-30T00:58:00.000Z', completedAt: null, retryOfId: null,
    ...overrides,
  }
}
const SUMMARY = { total: 10, outgoing: 8, incoming: 2, succeeded: 9, failed: 1, resultUnknown: 0, outgoingFailed: 1, retryable: 1, averageDurationMs: 400 }

type Call = { method: string; url: string; body: unknown }
type Route = (url: string, method: string) => Response | Promise<Response> | undefined

let root: Root
let host: HTMLDivElement
let calls: Call[] = []
let route: Route = () => undefined
let items: WebhookInteraction[] = []
let summary: typeof SUMMARY = SUMMARY

beforeEach(() => {
  accountId = 'account-a'
  role = 'owner'
  calls = []
  route = () => undefined
  items = [interaction()]
  summary = SUMMARY
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    const routed = route(url, method)
    if (routed) return routed
    if (url.includes('/staff/me')) return json({ success: true, data: { role } })
    if (url.includes('/api/webhooks/outgoing') || url.includes('/api/webhooks/incoming')) return json({ success: true, data: [] })
    if (url.includes('/api/webhooks/interactions?')) return json({ success: true, data: { total: items.length, page: 1, limit: 20, summary, items } })
    return json({ success: false, error: 'not found' }, 404)
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

const screen = () => <><WebhooksInteractionsV8 /><ToastHost /></>
async function render(node: React.ReactNode = screen()) {
  await act(async () => { root.render(node) })
  await act(async () => {})
  await act(async () => {})
}

const buttonByText = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find((button) => button.textContent?.trim() === text) as HTMLButtonElement | undefined
const designDialog = () => document.querySelector('[data-design-node="DA0Ag"]') as HTMLElement | null
const confirmBox = () => document.querySelector('[role="dialog"]:not([data-design-part="dialog"] [data-design-node="DA0Ag"])') as HTMLElement | null
const titles = () => [...host.querySelectorAll('[title]')].map((node) => node.getAttribute('title') ?? '')
const retries = () => calls.filter((call) => call.method === 'POST')
const notice = () => [...host.querySelectorAll('[data-design-part="notice"]')].map((node) => node.textContent ?? '').join('\n')

async function openContents(name = '予約台帳') {
  await act(async () => { (host.querySelector(`button[aria-label="「${name}」の操作"]`) as HTMLElement).click() })
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent?.includes('中身を見る')) as HTMLElement
  await act(async () => { item.click() })
  await act(async () => {})
}

describe('読み込み・空・失敗を分け、未取得を0件と見せない', () => {
  it('記録が0件なら空の案内を出す', async () => {
    items = []
    await render()
    expect(host.textContent).toContain('条件に合うやり取りはありません')
    expect(host.querySelector('[data-list-state="error"]')).toBeNull()
  })

  it('読めなかったら失敗として出し、帯の数を0にせず、読み直せる', async () => {
    let fail = true
    route = (url) => fail && url.includes('/api/webhooks/interactions?') ? json({ success: false, error: 'boom' }, 500) : undefined
    await render()
    expect(host.querySelector('[data-list-state="error"]')?.textContent).toContain('記録は消えていません。')
    expect(host.textContent).not.toContain('条件に合うやり取りはありません')
    const band = host.querySelector('[aria-label="外部連携の数の帯"]') as HTMLElement
    expect(band.textContent).toContain('集計を読み込めませんでした')
    expect(band.textContent).not.toMatch(/すべて\s*0/)
    fail = false
    await act(async () => { buttonByText('もう一度読み込む')!.click() })
    await act(async () => {})
    expect(host.querySelector('tr[data-row-id="wi-1"]')).not.toBeNull()
  })

  it('平均の時間が取れない期間は「未取得」と書き、行に時間が無いときは処理時間と書く', async () => {
    summary = { ...SUMMARY, averageDurationMs: null as unknown as number }
    await render()
    expect(titles().some((title) => title.includes('この30日は未取得'))).toBe(true)
    act(() => { root.unmount() })
    root = createRoot(host)
    summary = SUMMARY
    items = [interaction({ durationMs: null })]
    await render()
    expect(titles().some((title) => title.includes('この30日の送受信の処理時間'))).toBe(true)
  })
})

describe('結果が分からない失敗を無条件に送り直さない', () => {
  it('アカウントを切り替えて戻しても古い送り直しの確定は送らない', async () => {
    items = [interaction({ failureReasonCode: 'unknown' })]
    await render()
    await openContents()
    await act(async () => { buttonByText('届いたか確かめてから送り直す', designDialog()!)!.click() })
    const button = buttonByText('確かめたので送り直す')!
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    accountId = 'account-b'; await render()
    accountId = 'account-a'; await render()
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(retries()).toHaveLength(0)
  })
  it('結果不明の行は、相手先で確かめた確認を挟んでから confirmed 付きで送る', async () => {
    items = [interaction({ failureReasonCode: 'unknown' })]
    route = (url, method) => method === 'POST' && url.includes('/retry') ? json({ success: true, data: { status: 'succeeded' } }) : undefined
    await render()
    await openContents()
    expect(designDialog()?.textContent).toContain('相手先に届いたか分かっていません')
    await act(async () => { buttonByText('届いたか確かめてから送り直す', designDialog()!)!.click() })
    expect(retries()).toHaveLength(0)
    const confirm = buttonByText('確かめたので送り直す')!
    expect(confirm).toBeTruthy()
    expect(document.body.textContent).toContain('「予約台帳」へ届いたかどうか分かっていません。')
    expect(document.body.textContent).toContain('LINEアカウント')
    expect(document.body.textContent).toContain('環境')
    await vi.waitFor(() => expect(document.body.textContent).toContain('本店'))
    await act(async () => { confirm.click() })
    expect(retries().map((call) => [call.url, call.body])).toEqual([
      [`${process.env.NEXT_PUBLIC_API_URL}/api/webhooks/interactions/wi-1/retry?lineAccountId=account-a`, { confirmed: true, interactionRevision: 2, webhookRevision: 3 }],
    ])
  })

  it('ふつうの失敗は確認なしで送り、口が「確かめが要る」と返したら確認へ回す', async () => {
    route = (url, method) => method === 'POST' && url.includes('/retry')
      ? json({ success: false, error: 'result_unknown_needs_check' }, 409)
      : undefined
    await render()
    await openContents()
    await act(async () => { buttonByText('届いたか確かめてから送り直す', designDialog()!)!.click() })
    expect(retries().map((call) => call.body)).toEqual([{ confirmed: false, interactionRevision: 2, webhookRevision: 3 }])
    expect(buttonByText('確かめたので送り直す')).toBeTruthy()
  })

  it('まとめてやり直すと、結果不明と残りの件数を成功扱いにせず、続きの方法を案内する', async () => {
    route = (url, method) => method === 'POST' && url.includes('/retry-failed')
      ? json({ success: true, data: { requested: 5, succeeded: 1, failed: 0, skipped: 0, remaining: 3, needsReview: 1, excluded: 0 } })
      : undefined
    await render()
    await act(async () => { buttonByText('失敗したものをまとめてやり直す')!.click() })
    expect(retries().map((call) => call.url)).toEqual([`${process.env.NEXT_PUBLIC_API_URL}/api/webhooks/interactions/retry-failed?lineAccountId=account-a`])
    expect(notice()).toContain('まだ失敗のまま残っているものが3 件あります。もう一度押すと続きをやり直します。')
    expect(notice()).toContain('届いたか分からないものが1 件あります。相手先の記録で同じ処理がないか確かめてから、一覧で1件ずつやり直してください。')
  })

  it('まとめてやり直して全部届いたら、危険の帯でなく知らせだけを出す', async () => {
    route = (url, method) => method === 'POST' && url.includes('/retry-failed')
      ? json({ success: true, data: { requested: 2, succeeded: 2, failed: 0, skipped: 0, remaining: 0, needsReview: 0, excluded: 0 } })
      : undefined
    await render()
    await act(async () => { buttonByText('失敗したものをまとめてやり直す')!.click() })
    await act(async () => {})
    expect(notice()).not.toContain('2 件が届きました')
    expect(document.querySelector('[data-toast]')?.textContent).toContain('2 件を確認し、2 件が届きました。')
  })
})

describe('やり直せる範囲とつながりを業務の言葉で示す', () => {
  it('再試行の記録は行に経緯を出し、帯の補足に送り直せる数・対象外・結果不明を分けて書く', async () => {
    items = [interaction({ retryOfId: 'wi-0' })]
    summary = { ...SUMMARY, failed: 4, outgoingFailed: 4, retryable: 2, resultUnknown: 1 }
    await render()
    expect(host.querySelector('tr[data-row-id="wi-1"]')?.textContent).toContain('前の失敗をやり直した記録')
    const failure = titles().find((title) => title.includes('送り直せます')) ?? ''
    expect(failure).toContain('うち2件はここから送り直せます')
    expect(failure).toContain('2件は送り先の停止・削除・自動の送り直し中などで対象外です')
    expect(failure).toContain('うち1件は届いたか分からないため')
  })

  it('受け取りの失敗はこちらから送り直せず、相手側に頼むと書く', async () => {
    items = [interaction({ direction: 'incoming', webhookName: '申込フォーム' })]
    await render()
    await openContents('申込フォーム')
    const box = designDialog()!
    expect(box.textContent).toContain('相手側でもう一度送ってもらってください')
    expect(buttonByText('届いたか確かめてから送り直す', box)).toBeUndefined()
  })

  it('閲覧のみの人には、送り直せるのは統括と管理者だと書く', async () => {
    role = 'staff'
    await render()
    await openContents()
    expect(designDialog()?.textContent).toContain('送り直せるのは統括と管理者です。')
  })

  it('受け取りの試しの記録は、実際の受け取りと別の案内にする', async () => {
    items = [interaction({ direction: 'incoming', webhookName: '申込フォーム', eventType: 'incoming_webhook.test', status: 'succeeded', responseLabel: '受け取った' })]
    await render()
    expect(titles()).toContain('申込フォーム（申込フォームの受け取りを試した）')
    await openContents('申込フォーム')
    expect(designDialog()?.textContent).toContain('受け取りの試しの記録です。実際の受け取りと処理の実行はしていないため')
  })

  it('狭い列で隠れる値（きっかけ・かかった時間）は中身の窓に残り、技術的な記録は開いたときだけ出す', async () => {
    items = [interaction({ retryOfId: 'wi-0' })]
    await render()
    expect(titles()).toContain('予約が入った・Masato S.')
    await openContents()
    const box = designDialog()!
    const rows = Object.fromEntries([...box.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]))
    expect(rows['きっかけ']).toBe('予約が入った（Masato S.）')
    expect(rows['かかった時間']).toBe('返事まで 1.2 秒')
    expect(rows['出来事の種類']).toBe('booking_created')
    expect(rows['返事']).toBe('500 エラー（相手の応答番号 500）')
    expect(rows['やり直し元の記録']).toBeUndefined()
    await act(async () => { buttonByText('技術的な記録を開く', box)!.click() })
    const opened = Object.fromEntries([...designDialog()!.querySelectorAll('dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]))
    expect(opened['やり直し元の記録']).toBe('wi-0')
  })
})

describe('アカウントを替えたら、前の記録や送り直しの結果を出さない', () => {
  it('切替前の遅い記録の応答で、いまのアカウントの記録を上書きしない', async () => {
    let respondA: (response: Response) => void = () => {}
    route = (url) => url.includes('/api/webhooks/interactions?') && url.includes('account-a') && url.includes('limit=20')
      ? new Promise<Response>((resolve) => { respondA = resolve })
      : undefined
    await render()
    accountId = 'account-b'
    items = [interaction({ id: 'wi-b', webhookName: '支店の台帳' })]
    await render()
    expect(host.querySelector('tr[data-row-id="wi-b"]')).not.toBeNull()
    await act(async () => { respondA(json({ success: true, data: { total: 1, page: 1, limit: 20, summary, items: [interaction()] } })) })
    expect(host.querySelector('tr[data-row-id="wi-1"]')).toBeNull()
    expect(host.querySelector('tr[data-row-id="wi-b"]')).not.toBeNull()
  })

  it('送り直しの返事が来る前にアカウントが替わったら、その結果を出さない', async () => {
    let respond: (response: Response) => void = () => {}
    route = (url, method) => method === 'POST' && url.includes('/retry') ? new Promise<Response>((resolve) => { respond = resolve }) : undefined
    await render()
    await openContents()
    await act(async () => { buttonByText('届いたか確かめてから送り直す', designDialog()!)!.click() })
    accountId = 'account-b'
    await render()
    await act(async () => { respond(json({ success: true, data: { status: 'failed' } })) })
    expect(document.body.textContent).not.toContain('送り直しましたが、まだ届きませんでした')
  })
})
