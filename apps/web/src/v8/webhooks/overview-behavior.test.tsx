// @vitest-environment happy-dom
/*
 * ★V8 外部連携の「送る」「受け取る」タブの動き。
 * 削除の確認窓・アカウントを替えたときの古い応答の捨て方・一覧の読み込みの成功と失敗・
 * 試し送信の確認・行の「…」のキーボード操作を、描いた画面と口の呼び出しで確かめる。
 */
import React, { act } from 'react'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams(),
}))
let accountId = 'account-a'
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: accountId, selectedAccount: { id: accountId, name: accountId }, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: vi.fn(async () => ({ success: true, data: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }] })) }))
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => false }))
let role = verifiedStaffRole('owner')
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role }
})

import WebhooksIncomingV8 from './incoming'
import WebhooksOutgoingV8 from './outgoing'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const SUMMARY = { total: 10, outgoing: 8, incoming: 2, succeeded: 10, failed: 0, resultUnknown: 0, outgoingFailed: 0, retryable: 0, averageDurationMs: 400 }
const inlet = (id: string, name: string) => ({ id, name, confirmationRevision: 5, sourceType: 'form', hasSecret: true, isActive: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' })
const destination = (id: string, name: string, url = 'https://crm.example.com/line/hook?token=secret-path') => ({
  id, name, url, eventTypes: ['friend_add'], isActive: true, hasSecret: true, folderId: null, version: 3, confirmationRevision: 4,
  deliverySummary: { total: 0, failed: 0, pending: 0, canRetry: false, lastResult: null },
})

type Call = { method: string; url: string; body: unknown }
type Route = (url: string, method: string) => Response | Promise<Response> | undefined

let root: Root
let host: HTMLDivElement
let calls: Call[] = []
let route: Route = () => undefined
let outgoingByAccount: Record<string, unknown[]> = {}
let incomingByAccount: Record<string, unknown[]> = {}

beforeEach(() => {
  accountId = 'account-a'
  role = verifiedStaffRole('owner')
  calls = []
  route = () => undefined
  outgoingByAccount = { 'account-a': [destination('out-1', '顧客台帳')], 'account-b': [destination('out-b', '支店の台帳')] }
  incomingByAccount = { 'account-a': [inlet('in-1', '申込フォーム')], 'account-b': [inlet('in-b', '支店のフォーム')] }
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
    const account = new URL(url).searchParams.get('lineAccountId') ?? ''
    if (url.includes('/staff/me')) return json({ success: true, data: { role } })
    if (url.includes('/api/folders')) return json({ success: true, data: [] })
    if (url.includes('/unmatched')) return json({ success: true, data: [], total: 0 })
    if (/\/api\/webhooks\/incoming\/[^/?]+\?/.test(url) && method === 'GET') {
      const id = url.match(/\/incoming\/([^/?]+)/)![1]
      return json({ success: true, data: { ...inlet(id, '申込フォーム'), version: 1, identityMatching: { methods: [{ kind: 'verified_email', path: '$.email' }], onNotFound: 'do_nothing' }, actions: [], actionExecution: { state: 'not_configured', reason: null }, latestSample: null, templateFields: [], pendingUnmatched: 0, previousSecretUsableUntil: null } })
    }
    if (url.includes('/api/webhooks/incoming') && method === 'GET') return json({ success: true, data: incomingByAccount[account] ?? [] })
    if (url.includes('/api/webhooks/outgoing') && method === 'GET') return json({ success: true, data: outgoingByAccount[account] ?? [] })
    if (url.includes('/interactions')) return json({ success: true, data: { total: 0, page: 1, limit: 1, summary: SUMMARY, items: [] } })
    if (method === 'DELETE') return json({ success: true, data: null })
    return json({ success: false, error: 'not found' }, 404)
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  clearToastsForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
})

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node) })
  await act(async () => {})
  await act(async () => {})
}

const clickables = () => [...document.querySelectorAll('button, a')] as HTMLElement[]
const byText = (text: string) => clickables().find((element) => element.textContent?.trim() === text)
const buttonIn = (scope: ParentNode, text: string) => [...scope.querySelectorAll('button')].find((button) => button.textContent?.trim() === text) as HTMLButtonElement
const dialog = () => document.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement | null
const confirmButton = (label: string) => [...(dialog()?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes(label)) as HTMLButtonElement
const deletes = () => calls.filter((call) => call.method === 'DELETE')
const writes = () => calls.filter((call) => call.method !== 'GET')
const outgoingScreen = () => <><WebhooksOutgoingV8 /><ToastHost /></>

async function openRowMenu(name: string) {
  await act(async () => { (document.querySelector(`[aria-label="「${name}」の操作"]`) as HTMLElement).click() })
}
async function chooseMenuItem(label: string) {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent?.trim() === label) as HTMLElement
  expect(item, `メニューに「${label}」がない`).toBeTruthy()
  await act(async () => { item.click() })
}
async function askDeleteOutgoing(name = '顧客台帳') {
  await openRowMenu(name)
  await chooseMenuItem('削除する')
}
async function askDeleteIncoming() {
  await act(async () => { byText('この受け取り口を削除する')!.click() })
}

describe('削除は共通の確認窓を通し、対象アカウントで削除する', () => {
  it('送る：「削除する」を選んでも口は叩かず、ブラウザの confirm でなく確認窓を出す', async () => {
    const browserConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await render(outgoingScreen())
    await askDeleteOutgoing()
    expect(browserConfirm).not.toHaveBeenCalled()
    expect(deletes()).toHaveLength(0)
    const box = dialog()!
    expect(box.getAttribute('role')).toBe('alertdialog')
    expect(box.textContent).toContain('「顧客台帳」を削除しますか？')
    expect(box.textContent).toContain('この宛先への送信が止まり')
    expect(box.textContent).toContain('すでに送った記録は残ります。')
    expect(box.textContent).toContain('この操作は取り消せません。')
    expect(box.textContent).toContain('LINEアカウント')
    expect(box.textContent).toContain('環境')
    await vi.waitFor(() => expect(box.textContent).toContain('本店'))
    expect(box.textContent).not.toContain('支店')
    await act(async () => { confirmButton('削除する').click() })
    expect(deletes().map((call) => call.url)).toEqual([`${process.env.NEXT_PUBLIC_API_URL}/api/webhooks/outgoing/out-1?lineAccountId=account-a&expectedConfirmationRevision=4`])
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  it('受け取る：削除の入口は確認窓を開くだけで、確定すると選んだ口をそのアカウントで消す', async () => {
    const browserConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await render(<WebhooksIncomingV8 />)
    await askDeleteIncoming()
    expect(browserConfirm).not.toHaveBeenCalled()
    expect(deletes()).toHaveLength(0)
    const box = dialog()!
    expect(box.getAttribute('role')).toBe('alertdialog')
    expect(box.textContent).toContain('「申込フォーム」を削除しますか？')
    expect(box.textContent).toContain('LINEアカウント')
    expect(box.textContent).toContain('環境')
    await vi.waitFor(() => expect(box.textContent).toContain('本店'))
    expect(box.textContent).toContain('このURLへの通知を受け取らなくなります。')
    expect(box.textContent).toContain('すでに受け取った記録は残ります。')
    expect(box.textContent).toContain('この操作は取り消せません。')
    await act(async () => { confirmButton('削除する').click() })
    expect(deletes().map((call) => call.url)).toEqual([`${process.env.NEXT_PUBLIC_API_URL}/api/webhooks/incoming/in-1?lineAccountId=account-a&expectedConfirmationRevision=5`])
    await vi.waitFor(() => expect(dialog()).toBeNull())
  })

  for (const side of ['outgoing', 'incoming'] as const) {
    it(`${side}：二度押しても1回だけ送り、処理中は閉じず、失敗は窓の中に運用の言葉で出して押せる状態に戻す`, async () => {
      let respond: (response: Response) => void = () => {}
      route = (_url, method) => method === 'DELETE' ? new Promise<Response>((resolve) => { respond = resolve }) : undefined
      await render(side === 'outgoing' ? outgoingScreen() : <WebhooksIncomingV8 />)
      if (side === 'outgoing') await askDeleteOutgoing()
      else await askDeleteIncoming()
      const confirm = confirmButton('削除する')
      const cancel = confirmButton('キャンセル')
      await act(async () => { confirm.click() })
      await act(async () => { confirm.click() })
      expect(deletes()).toHaveLength(1)
      // 処理中はキャンセル・Escape でも閉じない。
      await act(async () => { cancel.click() })
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
      expect(dialog()).not.toBeNull()
      await act(async () => { respond(json({ success: false, error: 'internal boom' }, 200)) })
      const box = dialog()!
      expect(box.textContent).toContain(side === 'outgoing'
        ? 'この送り先を削除できませんでした。状態を読み直してから、もう一度お試しください。'
        : 'この受け取り口を削除できませんでした。状態を読み直してから、もう一度お試しください。')
      expect(box.textContent).not.toContain('internal boom')
      expect(box.querySelector('[role="alert"]')).not.toBeNull()
      expect(confirmButton('削除する').disabled).toBe(false)
    })

    it(`${side}：権限が無くて断られたら、統括に頼む言葉を出す`, async () => {
      route = (_url, method) => method === 'DELETE' ? json({ success: false, error: 'forbidden' }, 403) : undefined
      await render(side === 'outgoing' ? outgoingScreen() : <WebhooksIncomingV8 />)
      if (side === 'outgoing') await askDeleteOutgoing()
      else await askDeleteIncoming()
      await act(async () => { confirmButton('削除する').click() })
      expect(dialog()?.textContent).toContain('オーナー')
      expect(dialog()?.textContent).not.toContain('状態を読み直してから')
    })
  }
})

describe('アカウントを替えたら、前のアカウントの応答・窓・書き込みを使わない', () => {
  it('切替前の遅い一覧の応答で、いまのアカウントの一覧を上書きしない', async () => {
    let respondA: (response: Response) => void = () => {}
    route = (url, method) => method === 'GET' && url.includes('/api/webhooks/outgoing') && url.includes('account-a')
      ? new Promise<Response>((resolve) => { respondA = resolve })
      : undefined
    await render(outgoingScreen())
    accountId = 'account-b'
    await render(outgoingScreen())
    expect(host.querySelector('tr[data-row-id="out-b"]')).not.toBeNull()
    await act(async () => { respondA(json({ success: true, data: [destination('out-1', '顧客台帳')] })) })
    expect(host.querySelector('tr[data-row-id="out-1"]')).toBeNull()
    expect(host.querySelector('tr[data-row-id="out-b"]')).not.toBeNull()
  })

  it('送る：確認窓を開いたままアカウントが替わったら、削除を送らず選び直しを頼む', async () => {
    await render(outgoingScreen())
    await askDeleteOutgoing()
    accountId = 'account-b'
    await render(outgoingScreen())
    await act(async () => { confirmButton('削除する').click() })
    expect(deletes()).toHaveLength(0)
    expect(dialog()?.textContent).toContain('LINEアカウントが切り替わりました。削除する送り先を選び直してください。')
  })

  it('送る：アカウントを切り替えて戻しても古い削除確定を送らない', async () => {
    await render(outgoingScreen())
    await askDeleteOutgoing()
    const button = confirmButton('削除する')
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    accountId = 'account-b'; await render(outgoingScreen())
    accountId = 'account-a'; await render(outgoingScreen())
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(deletes()).toHaveLength(0)
  })

  it('送る：削除の返事が来る前にアカウントが替わったら、前の失敗を新しいアカウントに出さない', async () => {
    let respond: (response: Response) => void = () => {}
    route = (_url, method) => method === 'DELETE' ? new Promise<Response>((resolve) => { respond = resolve }) : undefined
    await render(outgoingScreen())
    await askDeleteOutgoing()
    await act(async () => { confirmButton('削除する').click() })
    accountId = 'account-b'
    await render(outgoingScreen())
    await act(async () => { respond(json({ success: false, error: 'boom' })) })
    expect(document.body.textContent).not.toContain('この送り先を削除できませんでした')
  })

  it('受け取る：切り替えると削除と合言葉の窓を閉じる', async () => {
    await render(<WebhooksIncomingV8 />)
    await askDeleteIncoming()
    expect(dialog()).not.toBeNull()
    accountId = 'account-b'
    await render(<WebhooksIncomingV8 />)
    await vi.waitFor(() => expect(dialog()).toBeNull())

    await act(async () => { byText('合言葉を更新する')!.click() })
    expect(dialog()?.textContent).toContain('合言葉を更新する')
    accountId = 'account-a'
    await render(<WebhooksIncomingV8 />)
    await vi.waitFor(() => expect(dialog()).toBeNull())
    expect(writes()).toHaveLength(0)
  })

  it('受け取る：アカウントを切り替えて戻しても古い削除確定を送らない', async () => {
    await render(<WebhooksIncomingV8 />)
    await askDeleteIncoming()
    const button = confirmButton('削除する')
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    accountId = 'account-b'; await render(<WebhooksIncomingV8 />)
    accountId = 'account-a'; await render(<WebhooksIncomingV8 />)
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(deletes()).toHaveLength(0)
  })

  it('受け取る：新しいアカウントの一覧がまだ届かない間は、前の口の切り替えを送らない', async () => {
    route = (url, method) => method === 'GET' && url.includes('/api/webhooks/incoming?') && url.includes('account-b')
      ? new Promise<Response>(() => {})
      : undefined
    await render(<WebhooksIncomingV8 />)
    accountId = 'account-b'
    await render(<WebhooksIncomingV8 />)
    // 前のアカウントの口は、新しい一覧が届くまで画面に残っている。
    const toggle = host.querySelector('[role="switch"]') as HTMLElement
    expect(toggle).not.toBeNull()
    await act(async () => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(host.textContent).toContain('LINEアカウントの一覧を読み直してください')
    expect(writes()).toHaveLength(0)
  })

  it('受け取る：前のアカウントの口が取れたあと、新しいアカウントの読み込みが失敗したら前の口を出さない', async () => {
    route = (url, method) => method === 'GET' && url.includes('/api/webhooks/incoming?') && url.includes('account-b')
      ? json({ success: false, error: 'boom' }, 500)
      : undefined
    await render(<WebhooksIncomingV8 />)
    expect(host.querySelector('[aria-label="受け取り口「申込フォーム」を見る"]')).not.toBeNull()
    accountId = 'account-b'
    await render(<WebhooksIncomingV8 />)
    expect(host.textContent).toContain('受け取り口を読み込めませんでした')
    expect(host.querySelector('[aria-label="受け取り口「申込フォーム」を見る"]')).toBeNull()
  })
})

describe('一覧の読み込みは送る・受け取るを別々に扱い、失敗を空と見せない', () => {
  it('送り先だけ読めなくても受け取り口は出し、送るタブは失敗として読み直せる', async () => {
    let failOutgoing = true
    route = (url, method) => method === 'GET' && url.includes('/api/webhooks/outgoing') && failOutgoing
      ? json({ success: false, error: 'boom' }, 500)
      : undefined
    await render(outgoingScreen())
    expect(host.textContent).toContain('送り先を読み込めませんでした')
    expect(host.textContent).toContain('登録内容は消えていません。')
    expect(host.textContent).not.toContain('まだ送り先がありません')
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())
    expect(tabs).toContain('こちらから送る')
    expect(tabs).toContain('こちらで受け取る 1')
    // 見本タブの数は、画面に並べる見本（受け取る5＋送る4）から数える。
    expect(tabs).toContain('見本 9')
    failOutgoing = false
    await act(async () => { byText('もう一度読み込む')!.click() })
    await act(async () => {})
    expect(host.querySelector('tr[data-row-id="out-1"]')).not.toBeNull()
    expect(host.textContent).not.toContain('送り先を読み込めませんでした')
  })

  it('受け取り口だけ読めなくても、受け取るタブは失敗を出して空の案内を出さず、読み直せる', async () => {
    let failIncoming = true
    route = (url, method) => method === 'GET' && url.includes('/api/webhooks/incoming?') && failIncoming
      ? json({ success: false, error: 'boom' }, 500)
      : undefined
    await render(<WebhooksIncomingV8 />)
    expect(host.textContent).toContain('受け取り口を読み込めませんでした')
    expect(host.textContent).not.toContain('まだ受け取り口がありません')
    const tabs = [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())
    expect(tabs).toContain('こちらから送る 1')
    expect(tabs).toContain('こちらで受け取る')
    failIncoming = false
    await act(async () => { byText('もう一度読み込む')!.click() })
    await act(async () => {})
    expect(host.querySelector('[aria-label="受け取り口「申込フォーム」を見る"]')).not.toBeNull()
  })

  it('受け取り口の詳細だけ読めなくても、届いた後の処理の欄で失敗を出して読み直せる', async () => {
    let failDetail = true
    route = (url, method) => method === 'GET' && /\/api\/webhooks\/incoming\/in-1\?/.test(url) && failDetail
      ? json({ success: false, error: 'boom' }, 500)
      : undefined
    await render(<WebhooksIncomingV8 />)
    const card = () => host.querySelector('[aria-labelledby="wh-in-actions"]') as HTMLElement
    expect(card().querySelector('[data-list-state="error"]')).not.toBeNull()
    expect(card().textContent).not.toContain('届いた後に動かす処理は、まだ決めていません。')
    const detailReads = () => calls.filter((call) => /\/api\/webhooks\/incoming\/in-1\?/.test(call.url)).length
    const before = detailReads()
    failDetail = false
    await act(async () => { buttonIn(card(), 'もう一度読み込む').click() })
    await act(async () => {})
    expect(detailReads()).toBe(before + 1)
    expect(card().querySelector('[data-list-state="error"]')).toBeNull()
  })

  it('何も無いときの案内から、同じ作る操作へ進める', async () => {
    outgoingByAccount = { 'account-a': [] }
    incomingByAccount = { 'account-a': [] }
    await render(outgoingScreen())
    expect(byText('最初の送り先を作る')?.getAttribute('href')).toBe('/webhooks/new')
    expect(byText('送り先を作る')?.getAttribute('href')).toBe('/webhooks/new')
    expect(byText('見本から作る')?.getAttribute('href')).toBe('/webhooks?tab=notify')
    act(() => { root.unmount() })
    root = createRoot(host)
    await render(<WebhooksIncomingV8 />)
    await act(async () => { byText('最初の受け取り口を作る')!.click() })
    expect(dialog()?.textContent).toContain('受け取る設定を追加')
  })
})

describe('権限と失敗の言葉', () => {
  it('管理者は通常編集と試しを使え、合言葉と削除は理由付きで拒む', async () => {
    role = verifiedStaffRole('admin')
    await render(<WebhooksIncomingV8 />)
    expect(byText('試す')).toBeTruthy()
    expect(byText('合言葉を更新する')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => byText('合言葉を更新する')!.click())
    expect(byText('この受け取り口を削除する')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => byText('この受け取り口を削除する')!.click())
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0)
    const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement
    expect(toggle.disabled).toBe(false)
    await act(async () => toggle.click())
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1)
  })

  it('受け取り口を作る口に断られたら、原因どおりの言葉を窓に出す', async () => {
    route = (url, method) => method === 'POST' && url.includes('/api/webhooks/incoming') ? json({ success: false, error: 'forbidden' }, 403) : undefined
    await render(<WebhooksIncomingV8 />)
    await act(async () => { byText('受け取り口を作る')!.click() })
    const name = document.querySelector('#wh-incoming-name') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '体験申込')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { confirmButton('作る').click() })
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
    expect(dialog()?.textContent).toContain('オーナー')
    expect(dialog()?.textContent).not.toContain('通信を確かめて')
  })

  it('受け取り口の合言葉更新窓に操作先と環境を示す', async () => {
    await render(<WebhooksIncomingV8 />)
    await act(async () => { byText('合言葉を更新する')!.click() })
    const box = dialog()!
    expect(box.textContent).toContain('LINEアカウント')
    expect(box.textContent).toContain('環境')
    await vi.waitFor(() => expect(box.textContent).toContain('本店'))
    expect(writes()).toHaveLength(0)
  })
  it('受け取り口の古い合言葉更新は切替後に送らない', async () => {
    await render(<WebhooksIncomingV8 />)
    await act(async () => { byText('合言葉を更新する')!.click() })
    await act(async () => { confirmButton('自動生成').click() })
    const button = confirmButton('保存する')
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    accountId = 'account-b'; await render(<WebhooksIncomingV8 />)
    accountId = 'account-a'; await render(<WebhooksIncomingV8 />)
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(writes()).toHaveLength(0)
  })

  it('合言葉の更新が断られたら、原因どおりの言葉を窓に出す', async () => {
    route = (_url, method) => method === 'PUT' || method === 'PATCH' ? json({ success: false, error: 'forbidden' }, 403) : undefined
    await render(<WebhooksIncomingV8 />)
    await act(async () => { byText('合言葉を更新する')!.click() })
    await act(async () => { confirmButton('自動生成').click() })
    await act(async () => { confirmButton('保存する').click() })
    expect(writes()).toHaveLength(1)
    expect(dialog()?.textContent).toContain('オーナー')
    expect(dialog()?.textContent).not.toContain('通信を確かめて')
  })
})

describe('試し送信は送り先を確かめてから送る', () => {
  it('送り先の鍵を作り直す窓に操作先と環境を示す', async () => {
    await render(outgoingScreen())
    await openRowMenu('顧客台帳')
    await chooseMenuItem('鍵を作り直す')
    const box = dialog()!
    expect(box.textContent).toContain('LINEアカウント')
    expect(box.textContent).toContain('環境')
    await vi.waitFor(() => expect(box.textContent).toContain('本店'))
    expect(writes()).toHaveLength(0)
  })
  it('アカウントを切り替えて戻しても古い鍵の確定を送らない', async () => {
    await render(outgoingScreen())
    await openRowMenu('顧客台帳')
    await chooseMenuItem('鍵を作り直す')
    await act(async () => { confirmButton('自動生成').click() })
    const button = confirmButton('保存する')
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    accountId = 'account-b'; await render(outgoingScreen())
    accountId = 'account-a'; await render(outgoingScreen())
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(writes()).toHaveLength(0)
  })
  it('開いた後にアカウントを切り替えて戻しても古い試し送信を送らない', async () => {
    await render(outgoingScreen())
    await openRowMenu('顧客台帳')
    await chooseMenuItem('試しに送る')
    const button = confirmButton('この送り先へ送る')
    const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
    const handler = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
    accountId = 'account-b'; await render(outgoingScreen())
    accountId = 'account-a'; await render(outgoingScreen())
    await act(async () => { await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
    expect(writes()).toHaveLength(0)
  })
  it('「試しに送る」は確認窓に実際のURLを省略せず出し、確定するまで送らない', async () => {
    await render(outgoingScreen())
    await openRowMenu('顧客台帳')
    await chooseMenuItem('試しに送る')
    expect(writes()).toHaveLength(0)
    const box = dialog()!
    expect(box.textContent).toContain('試し送信をします')
    expect(box.textContent).toContain('LINEアカウント')
    expect(box.textContent).toContain('環境')
    await vi.waitFor(() => expect(box.textContent).toContain('本店'))
    expect(box.querySelector('code')?.textContent).toBe('https://crm.example.com/line/hook?token=secret-path')
    route = (url, method) => method === 'POST' && url.includes('/test') ? json({ success: true, data: { delivered: true, responseStatus: 200 } }) : undefined
    await act(async () => { confirmButton('この送り先へ送る').click() })
    expect(writes().map((call) => call.url)).toEqual([`${process.env.NEXT_PUBLIC_API_URL}/api/webhooks/outgoing/out-1/test?lineAccountId=account-a`])
    expect(writes()[0].body).toEqual({ expectedVersion: 3, expectedConfirmationRevision: 4 })
  })
})

describe('行の「…」はキーボードだけで開いて選べ、Escape・外側で閉じる', () => {
  it('開くと最初の項目にいて、End・Home・矢印で動き、Escape で閉じて「…」へ戻る', async () => {
    await render(outgoingScreen())
    const trigger = document.querySelector('[aria-label="「顧客台帳」の操作"]') as HTMLElement
    await openRowMenu('顧客台帳')
    const menu = document.querySelector('[role="menu"]') as HTMLElement
    const items = [...menu.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
    expect(items.length).toBeGreaterThan(2)
    expect(document.activeElement).toBe(items[0])
    const press = async (key: string) => {
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    }
    // 先頭からの End は ↑ の折り返しと同じ所へ着くので、1つ下げてから押す。
    await press('ArrowDown')
    await press('End')
    expect(document.activeElement).toBe(items.at(-1))
    await press('Home')
    expect(document.activeElement).toBe(items[0])
    await press('ArrowDown')
    expect(document.activeElement).toBe(items[1])
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('外側を押すと閉じる', async () => {
    await render(outgoingScreen())
    await openRowMenu('顧客台帳')
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  })
})
