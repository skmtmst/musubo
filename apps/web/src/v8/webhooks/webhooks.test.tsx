import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * ★V8 外部連携（src/v8/webhooks）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * 受け取り口を作る窓・閲覧のみで押せない物を置かない・同期の記録の束ね方・
 * やり取りの記録の札と中身の2行・作る画面の既定（選んだものだけ送る）と詳細条件。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

let search = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/webhooks',
  useSearchParams: () => new URLSearchParams(search),
}))
let accountId = 'account-a'
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: accountId, selectedAccount: { id: accountId, name: accountId === 'account-a' ? '本店' : '支店' }, accounts: [{ id: 'account-a', name: '本店' }, { id: 'account-b', name: '支店' }], loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
let narrow = false
vi.mock('@/lib/use-narrow-viewport', () => ({ useNarrowViewport: () => narrow }))
let role = 'owner'
vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role }
})

import WebhooksIncomingV8 from './incoming'
import WebhooksOutgoingV8 from './outgoing'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import WebhooksSamplesV8 from './samples'
import WebhooksInteractionsV8 from './interactions'
import WebhooksCreateV8 from './create'
import { api, ApiError } from '@/lib/api'
import { groupRuns } from './sheets'
import { eventLabel, maskedUrl } from './words'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const SUMMARY = { total: 2146, outgoing: 1734, incoming: 412, succeeded: 2144, failed: 2, resultUnknown: 0, outgoingFailed: 2, retryable: 2, averageDurationMs: 400 }
const INLET = { id: 'in-1', name: '申込フォーム', sourceType: 'form', hasSecret: true, isActive: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }

let root: Root
let host: HTMLDivElement
let posted: Array<{ url: string; body: unknown }> = []

beforeEach(() => {
  accountId = 'account-a'
  role = verifiedStaffRole('owner')
  narrow = false
  search = ''
  posted = []
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method && init.method !== 'GET') posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
    if (url.includes('/staff/me')) return json({ success: true, data: { role } })
    if (url.includes('/unmatched')) return json({ success: true, data: [], total: 0 })
    if (/\/api\/webhooks\/incoming\/in-1/.test(url)) {
      return json({ success: true, data: { ...INLET, version: 1, identityMatching: { methods: [{ kind: 'verified_email', path: '$.email' }], onNotFound: 'do_nothing' }, actions: [], actionExecution: { state: 'not_configured', reason: null }, latestSample: null, templateFields: [], pendingUnmatched: 0, previousSecretUsableUntil: null } })
    }
    if (url.includes('/api/webhooks/incoming')) return json({ success: true, data: [INLET] })
    if (url.includes('/api/webhooks/outgoing')) return json({ success: true, data: [] })
    if (url.includes('/interactions')) {
      return json({ success: true, data: { total: 1, page: 1, limit: 20, summary: SUMMARY, items: [{
        id: 'wi-1', direction: 'outgoing', webhookName: '予約台帳', eventType: 'booking_created', triggerSummary: '予約が入った・Masato S.',
        status: 'failed', responseLabel: '500 エラー', responseStatus: 500, attemptCount: 3, durationMs: 30000, failureReason: null,
        failureReasonCode: 'response_5xx', canRetry: true, retryBlockReason: null, autoRetryNextAt: null,
        startedAt: '2026-09-30T00:58:00.000Z', completedAt: null, retryOfId: null,
      }] } })
    }
    if (url.includes('/api/folders')) return json({ success: true, data: [] })
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

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node) })
  await act(async () => {})
  await act(async () => {})
}

const buttons = () => [...document.querySelectorAll('button, a')] as HTMLElement[]

function unmatchedFixture(resolveStatus = 200) {
  const base = globalThis.fetch
  const resolutions: unknown[] = [], limits: string[] = []
  const rows = ['candidate', 'ambiguous', 'unmatched'].map((kind, index) => ({
    id: `unmatched-${index}`, kind, status: 'pending', receivedAt: '2026-10-21T01:02:00Z',
    identityAttempts: [{ kind: 'verified_email', path: '$.email', value: `very-long-incoming-address-${index}@example.invalid` }],
    candidates: kind === 'unmatched' ? [] : [
      { friendId: 'friend-1', displayName: '候補の長い名前その一' },
      ...(kind === 'ambiguous' ? [{ friendId: 'friend-2', displayName: '候補の長い名前その二' }] : []),
    ],
    maskedShape: null, resolvedFriendId: null, resolvedAt: null,
  }))
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/webhooks/unmatched/') && init?.method === 'POST') {
      resolutions.push({ url, body: JSON.parse(String(init.body)) })
      return resolveStatus === 403 ? json({ success: false, error: 'forbidden' }, 403) : json({ success: true, data: { id: 'unmatched-1', status: 'resolved' } })
    }
    if (url.includes('/incoming/in-1/unmatched')) {
      limits.push(new URL(url).searchParams.get('limit') || '')
      return json({ success: true, data: rows, total: 51 })
    }
    const response = await base(input, init)
    if (/\/incoming\/in-1\?/.test(url)) {
      const body = await response.json()
      body.data.pendingUnmatched = 51
      body.data.identityMatching.onNotFound = 'unmatched_box'
      return json(body)
    }
    return response
  })
  return { resolutions, limits }
}

describe('外部連携 V8', () => {
  it('受け取り口と受信数を取得できない時はゼロでなく未取得と表示する', async () => {
    const base = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/webhooks/incoming') || url.includes('/interactions')) return json({ success: false, error: 'unavailable' }, 500)
      return base(input, init)
    })
    await render(<WebhooksIncomingV8 />)
    await waitFor(() => expect(host.textContent).toContain('受け取り口を読み込めませんでした'))
    expect(host.textContent).toContain('集計を読み込めませんでした')
    const band = host.querySelector('[data-kpi-strip]')!
    for (const label of ['受け取り口', '過去30日 受け取った']) {
      const card = within(band as HTMLElement).getByText(label).closest('[data-kpi-presentation]')
      expect(card?.textContent).toContain('—')
    }
  })

  it('届物は値に余り幅を渡し、複数候補の各結び付けと追加読み込みを保つ', async () => {
    const fixture = unmatchedFixture()
    await render(<WebhooksIncomingV8 />)
    const table = within(host).getByRole('table', { name: '人が見つからなかった届物' })
    const row = table.querySelector('[data-row-id="unmatched-1"]') as HTMLElement
    expect(row.children[1].hasAttribute('data-cell-grow')).toBe(true)
    expect(row.lastElementChild?.hasAttribute('data-list-action-cell')).toBe(true)
    expect(row.lastElementChild?.hasAttribute('data-cell-grow')).toBe(false)
    expect(row.querySelector('[title="very-long-incoming-address-1@example.invalid"]')).not.toBeNull()
    const candidates = within(row).getAllByRole('button', { name: 'この人に結び付ける' })
    expect(candidates).toHaveLength(2)
    await act(async () => candidates[1].click())
    expect(fixture.resolutions).toContainEqual(expect.objectContaining({ body: { action: 'link', friendId: 'friend-2' } }))
    await act(async () => within(host).getByRole('button', { name: 'さらに表示' }).click())
    expect(fixture.limits).toContain('50')
    expect(fixture.limits).toContain('100')
  })

  it('届物の403は該当行に紐づく全幅のエラーで表示し、操作列を押し広げない', async () => {
    const fixture = unmatchedFixture(403)
    await render(<WebhooksIncomingV8 />)
    const row = host.querySelector('[data-row-id="unmatched-0"]') as HTMLElement
    await act(async () => within(row).getByRole('button', { name: '結び付ける' }).click())
    expect(fixture.resolutions).toHaveLength(1)
    const notice = host.querySelector('#wh-unmatched-error-unmatched-0')!
    expect(notice.getAttribute('role')).toBe('alert')
    expect(notice.closest('td')?.getAttribute('colspan')).toBe('4')
    expect(row.getAttribute('aria-describedby')).toBe(notice.id)
    expect(row.querySelector('[role="alert"]')).toBeNull()
    expect(within(row).getByRole('button', { name: '結び付ける' }).hasAttribute('disabled')).toBe(false)
  })

  it('届物があっても閲覧のみでは結び付けを出さず、見本の省略文字は全文を残す', async () => {
    role = verifiedStaffRole('staff')
    const fixture = unmatchedFixture()
    await render(<WebhooksIncomingV8 />)
    expect(within(host).queryByRole('button', { name: '結び付ける' })).toBeNull()
    expect(within(host).queryByRole('button', { name: 'この人に結び付ける' })).toBeNull()
    expect(fixture.resolutions).toHaveLength(0)
    act(() => root.unmount()); root = createRoot(host)
    await render(<WebhooksSamplesV8 />)
    for (const text of ['LINE公式アカウント', '予約ID・メニュー・担当', '注文番号・金額・お客様名']) {
      expect([...host.querySelectorAll('[data-truncated-text]')].some(node => node.getAttribute('title') === text && node.textContent === text)).toBe(true)
    }
  })

  it('やり取りの記録は1ページは件数だけを帯に出す', async () => {
    await render(<WebhooksInteractionsV8 />)
    const pager = host.querySelector('[data-pagination]')!
    expect(pager.querySelector('[data-pagination-summary]')?.textContent).toBe('1件中 1〜1件')
    expect(within(pager as HTMLElement).queryByRole('button', { name: '前のページ' })).toBeNull()
    expect(within(pager as HTMLElement).queryByRole('button', { name: '次のページ' })).toBeNull()
    expect(within(host).getByRole('button', { name: '表示件数' }).closest('[data-template-region="toolbar"]')).not.toBeNull()
  })

  it('やり取りの総数と実範囲を分け、頁と表示件数をAPIへ渡す', async () => {
    const base = globalThis.fetch
    const queries: URLSearchParams[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await base(input, init)
      if (!String(input).includes('/interactions')) return response
      const params = new URL(String(input)).searchParams
      queries.push(params)
      const body = await response.json()
      const page = Math.max(2, Number(params.get('page') || 2))
      body.data = { ...body.data, total: 214, page, limit: Number(params.get('limit') || 20), items: [body.data.items[0], { ...body.data.items[0], id: 'wi-2' }] }
      return json(body)
    })
    await render(<WebhooksInteractionsV8 />)
    const pager = within(host).getByRole('navigation', { name: 'やり取りの記録のページ送り' })
    expect(pager.querySelector('[data-pagination-summary]')?.textContent).toBe('214件中 21〜22件')
    await act(async () => fireEvent.click(within(pager).getByRole('button', { name: '次のページ' })))
    expect(queries.some(params => params.get('page') === '3')).toBe(true)
    await act(async () => fireEvent.click(within(host).getByRole('button', { name: '表示件数' })))
    const option = within(document.body).getByRole('option', { name: '50件表示' })
    await act(async () => fireEvent.click(within(option).getByRole('button')))
    await vi.waitFor(() => expect(queries.map(params => ({ limit: params.get('limit'), page: params.get('page') }))).toContainEqual({ limit: '50', page: '1' }))
  })

  it('受け取り口を作る：窓（H031gC）が開き、名前が空なら作らずに理由を出す', async () => {
    await render(<WebhooksIncomingV8 />)
    const open = buttons().find((element) => element.textContent?.includes('受け取り口を作る'))!
    await act(async () => { open.click() })
    const dialog = document.querySelector('[data-design-node="H031gC"]')
    expect(dialog?.textContent).toContain('受け取る設定を追加')
    expect(dialog?.textContent).toContain('作るときに本人確認が出ます。')
    const create = [...dialog!.querySelectorAll('button')].find((element) => element.textContent?.includes('作る') && !element.textContent.includes('受け取り口'))!
    await act(async () => { create.click() })
    expect(dialog?.textContent).toContain('名前を入力してください')
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(document.activeElement?.id).toBe('wh-incoming-name')
    expect(dialog?.querySelector('#wh-incoming-name')?.getAttribute('aria-invalid')).toBe('true')
    expect(dialog?.querySelectorAll('[data-design-part=notice][role=alert]')).toHaveLength(0)
    expect(posted.filter((item) => item.url.includes('/api/webhooks/incoming'))).toHaveLength(0)
  })

  it('見本の受信元は初回のアカウント読込で消さず、実際の切替で作る窓と入力を消す', async () => {
    search = 'source=booking'
    window.history.replaceState(null, '', '/webhooks?source=booking')
    accountId = ''
    await render(<WebhooksIncomingV8 />)
    accountId = 'account-a'
    await render(<WebhooksIncomingV8 />)
    const dialog = () => document.querySelector('[role="dialog"]')
    expect(dialog()?.textContent).toContain('予約サービス')
    const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!
    await act(async () => {
      for (const [id, value] of [['wh-incoming-name', '前の店の下書き'], ['wh-incoming-secret', 'a'.repeat(32)]]) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(id), value)
        input(id).dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    expect(input('wh-incoming-name').value).toBe('前の店の下書き')

    accountId = 'account-b'
    await render(<WebhooksIncomingV8 />)
    await vi.waitFor(() => expect(dialog()).toBeNull())
    await act(async () => { buttons().find((element) => element.textContent?.includes('受け取り口を作る'))!.click() })
    expect(dialog()?.textContent).toContain('LINE公式アカウント')
    expect(dialog()?.textContent).not.toContain('予約サービス')
    expect(input('wh-incoming-name').value).toBe('')
    expect(input('wh-incoming-secret').value).not.toBe('a'.repeat(32))
    expect(posted).toHaveLength(0)
  })

  it.each(['admin', 'staff'])('狭い幅でも %s の権限に合わせて試し送信を出す', async (staffRole) => {
    role = verifiedStaffRole(staffRole)
    narrow = true
    const base = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => String(input).includes('/api/webhooks/outgoing')
      ? Promise.resolve(json({ success: true, data: [{
        id: 'out-1', name: '顧客台帳', url: 'https://example.com/hook', eventTypes: ['friend_add'],
        isActive: true, hasSecret: true, folderId: null,
        deliverySummary: { total: 0, failed: 0, pending: 0, canRetry: false, lastResult: null },
      }] }))
      : base(input, init))
    await render(<WebhooksOutgoingV8 />)
    await act(async () => { buttons().find((element) => element.getAttribute('aria-label') === '「顧客台帳」の操作')!.click() })
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(items).toContain('送信の記録を見る')
    expect(items.includes('試しに送る')).toBe(staffRole === 'admin')
    for (const action of ['鍵を作り直す', '削除する']) {
      const locked = within(document.body).getByRole('menuitem', { name: action })
      expect(locked.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(locked)
    }
    expect(within(document.body).getByRole('menuitem', { name: '止める' }).getAttribute('aria-disabled')).toBe(staffRole === 'admin' ? null : 'true')
    expect(posted).toHaveLength(0)
  })

  it('閲覧のみ：受け取り口と見本の入口は理由付きで拒み、閲覧のみの帯を出す', async () => {
    role = verifiedStaffRole('staff')
    await render(<WebhooksIncomingV8 />)
    expect(host.textContent).toContain(PERMISSION_LOCK_SUMMARY.manager)
    expect(within(host).getByRole('button', { name: '受け取り口を作る' }).getAttribute('aria-disabled')).toBe('true')
    act(() => { root.unmount() })
    root = createRoot(host)
    await render(<WebhooksSamplesV8 />)
    expect(within(host).getAllByRole('button', { name: 'この見本で作る' })).toHaveLength(9)
    for (const button of within(host).getAllByRole('button', { name: 'この見本で作る' })) {
      expect(button.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(button)
    }
    expect(posted).toHaveLength(0)
    act(() => { root.unmount() })
    root = createRoot(host)
    await render(<WebhooksInteractionsV8 />)
    expect(buttons().some((element) => element.textContent?.includes('まとめてやり直す'))).toBe(false)
  })

  it('送り先の切替中に別アカウントへ移ったら仮の状態を消し、戻っても古い失敗を出さない', async () => {
    const base = globalThis.fetch
    const outgoing = {
      id: 'out-1', name: '顧客台帳', url: 'https://example.com/hook', eventTypes: ['friend_add'],
      isActive: true, hasSecret: true, folderId: null,
      deliverySummary: { total: 0, failed: 0, pending: 0, canRetry: false, lastResult: null },
    }
    let respond: (response: Response) => void = () => {}
    let started = false
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/webhooks/outgoing')) {
        if (init?.method === 'PUT') {
          started = true
          return new Promise<Response>((resolve) => { respond = resolve })
        }
        return Promise.resolve(json({ success: true, data: [outgoing] }))
      }
      return base(input, init)
    })
    // 新しい要素を渡して、Context の切替と同じように再描画する。
    const screen = () => <><WebhooksOutgoingV8 /><ToastHost /></>
    await render(screen())
    await act(async () => { buttons().find((element) => element.getAttribute('aria-label') === '「顧客台帳」の操作')!.click() })
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
    await act(async () => { buttons().find((element) => element.getAttribute('role') === 'menuitem' && element.textContent === '止める')!.click() })
    expect(started).toBe(true)
    expect(host.textContent).toContain('切り替え中')

    accountId = 'account-b'
    await render(screen())
    expect(host.textContent).not.toContain('切り替え中')
    accountId = 'account-a'
    await render(screen())
    await act(async () => { respond(json({ success: false, error: '古い失敗' })) })
    expect(host.textContent).not.toContain('切り替えできませんでした')
    expect(host.textContent).not.toContain('切り替え中')
  })

  it('やり取りの記録：札に件数、中身は「・」の前を1行目・後ろと経緯を2行目に出す', async () => {
    await render(<WebhooksInteractionsV8 />)
    expect(within(host).getByRole('tab', { name: /^すべて\s*2,?146$/ })).toBeTruthy()
    expect(within(host).getByRole('tab', { name: /^失敗\s*2$/ })).toBeTruthy()
    const row = host.querySelector('tr[data-row-id="wi-1"]')
    expect(row?.textContent).toContain('予約が入った')
    expect(row?.textContent).toContain('Masato S.・3回やり直して失敗')
    expect(row?.textContent).toContain('30.0 秒')
  })

  it('やり取りの中身：状態は共通の札・時刻は time。技術的な記録で伏せた後の JSON を開いて写せる', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await render(<WebhooksInteractionsV8 />)
    const row = host.querySelector('tr[data-row-id="wi-1"]')!
    expect(row.querySelector('time')?.getAttribute('dateTime')).toBe('2026-09-30T00:58:00.000Z')
    expect(row.querySelector('[data-design-node="xRvDB"]')?.getAttribute('data-tone')).toBe('danger')
    await act(async () => { fireEvent.click(within(row as HTMLElement).getByRole('button', { name: '「予約台帳」の操作' })) })
    await act(async () => { fireEvent.click(document.querySelector('[role="menuitem"]') as HTMLElement) })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(within(dialog).queryByRole('button', { name: /JSON を開く/ })).toBeNull()
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /技術的な記録を開く/ })) })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /この記録の JSON を開く/ })) })
    const text = dialog.querySelector('pre')?.textContent ?? ''
    expect(text).toContain('"id": "wi-1"')
    expect(text).toContain('"status": "failed"')
    expect(text).not.toContain('Masato')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'この記録の JSON をコピー' })) })
    expect(writeText).toHaveBeenLastCalledWith(text)
  })

  it('やり取りの中身：閲覧のみは JSON を読めるが写す操作は出さない', async () => {
    role = verifiedStaffRole('viewer')
    await render(<WebhooksInteractionsV8 />)
    const row = host.querySelector('tr[data-row-id="wi-1"]') as HTMLElement
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '「予約台帳」の操作' })) })
    await act(async () => { fireEvent.click(document.querySelector('[role="menuitem"]') as HTMLElement) })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /技術的な記録を開く/ })) })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: /この記録の JSON を開く/ })) })
    expect(dialog.querySelector('pre')?.textContent).toContain('"id": "wi-1"')
    expect(within(dialog).queryByRole('button', { name: /JSON をコピー/ })).toBeNull()
  })

  it('作る：既定は「選んだものだけ送る」。絵に無い出来事は詳細条件を開くと選べる', async () => {
    await render(<WebhooksCreateV8 />)
    const selected = host.querySelector('input[name="wh-new-mode"][value="selected"]') as HTMLInputElement
    expect(selected.checked).toBe(true)
    expect(host.textContent).toContain('問い合わせが来た')
    expect(host.textContent).not.toContain('フォームが送られた')
    const details = buttons().find((element) => element.textContent?.includes('詳細条件'))!
    await act(async () => { details.click() })
    expect(host.textContent).toContain('フォームが送られた')
  })

  it('作る：見本から絵に無い出来事で来たら、詳細条件を開いてその出来事を選んでおく', async () => {
    search = 'event=form_submitted'
    await render(<WebhooksCreateV8 />)
    expect(host.textContent).toContain('フォームが送られた')
  })

  it('送り先を作る：未入力では送信せず、最初の誤りに移動し欄で知らせる', async () => {
    await render(<WebhooksCreateV8 />)
    await act(async () => { buttons().find((button) => button.textContent?.includes('つくって動かす'))!.click() })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    expect(document.activeElement?.id).toBe('wh-new-name')
    expect(host.querySelector('#wh-new-name')?.getAttribute('aria-invalid')).toBe('true')
    expect(host.querySelector('#wh-new-url')?.getAttribute('aria-invalid')).toBe('true')
    expect(host.querySelectorAll('[data-design-part=notice][role=alert]')).toHaveLength(0)
    expect(posted).toHaveLength(0)
  })

  it('送り先を作る：秘密の鍵は読み取り専用で、保存前にコピーできる', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await render(<WebhooksCreateV8 />)
    const secret = host.querySelector<HTMLInputElement>('#wh-new-secret')!
    expect(secret.readOnly).toBe(true)
    const initial = secret.value
    expect(host.textContent).toContain('保存すると秘密の鍵は二度と表示されません。今コピーしてください。')
    await act(async () => { buttons().find((button) => button.getAttribute('aria-label') === '秘密の鍵をコピー')!.click() })
    expect(writeText).toHaveBeenCalledWith(initial)
    await act(async () => { buttons().find((button) => button.textContent?.trim() === '作り直す')!.click() })
    expect(secret.readOnly).toBe(true)
    expect(secret.value).not.toBe(initial)
    await act(async () => { buttons().find((button) => button.getAttribute('aria-label') === '秘密の鍵をコピー')!.click() })
    expect(writeText).toHaveBeenLastCalledWith(secret.value)
  })

  it('鍵を作り直すとAPIの鍵の理由だけを消し、ほかの欄の理由を残す', async () => {
    const create = vi.spyOn(api.webhooks.outgoing, 'create').mockRejectedValueOnce(
      new ApiError(422, '入力を確認してください', undefined, undefined, undefined, undefined, {
        secret: '新しい鍵を作り直してください', name: 'この名前を確認してください',
      }),
    )
    try {
      await render(<WebhooksCreateV8 />)
      await act(async () => {
        fireEvent.change(host.querySelector('#wh-new-name')!, { target: { value: '連携先' } })
        fireEvent.change(host.querySelector('#wh-new-url')!, { target: { value: 'https://example.com/hook' } })
        fireEvent.click(host.querySelector('input[name="wh-new-mode"][value="all"]')!)
      })
      const secret = host.querySelector<HTMLInputElement>('#wh-new-secret')!
      const previous = secret.value
      await act(async () => { fireEvent.click(within(host).getByRole('button', { name: /つくって動かす/ })) })
      await waitFor(() => expect(secret.getAttribute('aria-invalid')).toBe('true'))
      expect(host.textContent).toContain('新しい鍵を作り直してください')
      expect(host.textContent).toContain('この名前を確認してください')
      await act(async () => { fireEvent.click(within(host).getByRole('button', { name: '作り直す' })) })
      expect(secret.value).not.toBe(previous)
      expect(secret.readOnly).toBe(true)
      expect(secret.getAttribute('aria-invalid')).not.toBe('true')
      expect(host.textContent).not.toContain('新しい鍵を作り直してください')
      expect(host.querySelector('#wh-new-name')?.getAttribute('aria-invalid')).toBe('true')
      expect(host.textContent).toContain('この名前を確認してください')
      expect(create).toHaveBeenCalledTimes(1)
    } finally { create.mockRestore() }
  })

  it('同期の記録：同じ時刻の行を束ね、失敗で0件の行は書き出したものに数えない', () => {
    const run = (id: string, dataType: 'friends' | 'form_answers', status: 'ok' | 'partial' | 'error', rowsWritten: number, startedAt: string) => ({
      id, kind: 'scheduled' as const, dataType, status, rowsWritten, error: null, startedAt, finishedAt: startedAt,
    })
    const groups = groupRuns([
      run('a', 'friends', 'ok', 1280, 't1'),
      run('b', 'form_answers', 'partial', 0, 't1'),
      run('c', 'friends', 'error', 0, 't2'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].parts).toEqual(['友だち 1,280', 'フォーム回答 0'])
    expect(groups[0].status).toBe('partial')
    expect(groups[1].parts).toEqual([])
    expect(groups[1].status).toBe('error')
  })

  it('言葉：URLは道を伏せる・いつ送るかは2つまで並べて残りは件数', () => {
    expect(maskedUrl('https://crm.example.com/line/hook?token=x')).toBe('https://crm.example.com/••••')
    expect(eventLabel(['friend_add', 'tag_change'])).toBe('友だちになった・タグが付いた')
    expect(eventLabel(['friend_add', 'tag_change', 'booking_created'])).toBe('友だちになった・タグが付いた ほか1 件')
  })

  // 監査 WEB-024：切り替えの返事が来る前にアカウントを移っても、仮の表示（止めた）を残さない。
  it('切り替え中にアカウントを移り、失敗が返ったあと戻ると、サーバーの状態（動いている）を出す', async () => {
    const base = globalThis.fetch
    let rejectToggle: (reason: unknown) => void = () => {}
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET' && String(input).includes('/api/webhooks/incoming/in-1')) {
        return new Promise((_, reject) => { rejectToggle = reject })
      }
      return base(input, init)
    })
    await render(<WebhooksIncomingV8 />)
    const toggle = () => host.querySelector('[role="switch"]') as HTMLElement | null
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')
    await act(async () => { toggle()!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(toggle()?.getAttribute('aria-checked')).toBe('false')

    accountId = 'account-b'
    await render(<WebhooksIncomingV8 />)
    await act(async () => { rejectToggle(new TypeError('network')) })
    accountId = 'account-a'
    await render(<WebhooksIncomingV8 />)
    await act(async () => {})
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')
  })
})

afterEach(() => { verifiedStaffRole(null) })

it('管理者が見本の受信元で開いても、作成の窓と入力を保つ', async () => {
  role = verifiedStaffRole('admin')
  search = 'source=booking'
    window.history.replaceState(null, '', '/webhooks?source=booking')
  await render(<WebhooksIncomingV8 />)
  const dialog = within(document.body).getByRole('dialog', { name: '受け取る設定を追加' })
  expect(dialog.textContent).toContain('予約サービス')
  fireEvent.change(within(dialog).getByRole('textbox', { name: '名前' }), { target: { value: '管理者の予約受信' } })
  await render(<WebhooksIncomingV8 />)
  expect(within(dialog).getByRole('textbox', { name: '名前' }).getAttribute('value')).toBe('管理者の予約受信')
  expect((within(dialog).getByRole('button', { name: '作る', exact: true }) as HTMLButtonElement).disabled).toBe(false)
  expect(posted).toHaveLength(0)
})

it('管理者は実際の受け取り口の中で、受信後の行動を追加し保存できる', async () => {
  role = verifiedStaffRole('admin')
  const base = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/api/common-actions/resources')) return Promise.resolve(json({ success: true, data: {
      tags: [{ id: 'tag-new', name: '申し込み済み' }], supportMarks: [], templates: [], scenarios: [], webhooks: [], commonActions: [], richMenus: [],
    } }))
    return base(input, init)
  })
  await render(<WebhooksIncomingV8 />)
  await act(async () => fireEvent.click(within(host).getByRole('button', { name: '行うことを足す' })))
  await act(async () => fireEvent.click(within(document.body).getByRole('menuitem', { name: /タグを付ける/ })))
  const picker = within(document.body).getByRole('dialog', { name: 'タグを付ける対象を選ぶ' })
  await act(async () => fireEvent.click(within(picker).getByRole('radio', { name: '申し込み済み' })))
  await act(async () => fireEvent.click(within(picker).getByRole('button', { name: '選ぶ', exact: true })))
  await act(async () => fireEvent.click(within(host).getByRole('button', { name: '行うことを保存する' })))
  await waitFor(() => expect(posted.filter(call => call.url.includes('/config'))).toHaveLength(1))
  expect(posted.find(call => call.url.includes('/config'))?.body).toMatchObject({ expectedVersion: 1,
    actions: [{ refKind: 'tag', refId: 'tag-new', refVersionId: null }],
  })
})
it('受け取りと見本には送信タブの数を表示しない', async () => {
  await render(<WebhooksIncomingV8 />)
  expect(host.textContent).toContain('受け取り口')
  expect(host.textContent).toContain('過去30日 受け取った')
  expect(host.textContent).not.toContain('直近30日 送った')
  await render(<WebhooksSamplesV8 />)
  expect(host.textContent).toContain('こちらで受け取る（どこから来るか）')
  expect(host.textContent).not.toContain('直近30日 送った')
})

it('受け取り口の作成中は画面移動前に確認する', async () => {
  window.history.replaceState(null, '', '/webhooks?tab=incoming')
  await render(<WebhooksIncomingV8 />)
  await act(async () => { buttons().find(element => element.textContent?.includes('受け取り口を作る'))!.click() })
  const input = document.querySelector<HTMLInputElement>('#wh-incoming-name')!
  await act(async () => { fireEvent.change(input, { target: { value: '新しい受け取り口' } }) })
  const link = document.createElement('a'); link.href = '/events'; link.textContent = 'イベントへ'; document.body.append(link)
  await act(async () => link.click())
  expect(document.body.textContent).toContain('保存していない変更があります')
  link.remove()
})
it('受け取り口の合言葉を編集中は画面移動前に確認する', async () => {
  window.history.replaceState(null, '', '/webhooks?tab=incoming')
  await render(<WebhooksIncomingV8 />)
  await vi.waitFor(() => expect(within(host).getByRole('button', { name: '合言葉を更新する' })).toBeTruthy())
  await act(async () => { within(host).getByRole('button', { name: '合言葉を更新する' }).click() })
  const input = within(document.body).getByLabelText('新しい合言葉')
  await act(async () => { fireEvent.change(input, { target: { value: 'test-secret' } }) })
  const link = document.createElement('a'); link.href = '/events'; link.textContent = 'イベントへ'; document.body.append(link)
  await act(async () => link.click())
  expect(document.body.textContent).toContain('保存していない変更があります')
  link.remove()
})
it('受け取り口の名前を編集中は画面移動前に確認する', async () => {
  window.history.replaceState(null, '', '/webhooks?tab=incoming')
  await render(<WebhooksIncomingV8 />)
  const edit = await vi.waitFor(() => within(host).getByRole('button', { name: '受け取り口の名前を変更する' }))
  await act(async () => { edit.click() })
  const input = within(host).getByRole('textbox', { name: '受け取り口の名前' })
  await act(async () => { fireEvent.change(input, { target: { value: '新しい名前' } }) })
  const link = document.createElement('a'); link.href = '/events'; link.textContent = 'イベントへ'; document.body.append(link)
  await act(async () => { fireEvent.blur(input); link.click() })
  expect(document.body.textContent).toContain('保存していない変更があります')
  link.remove()
})

it('編集途中の受け取り口が再読込で消えたら、残った画面の移動を妨げない', async () => {
  window.history.replaceState(null, '', '/webhooks?tab=incoming')
  await render(<WebhooksIncomingV8 />)
  const edit = await vi.waitFor(() => within(host).getByRole('button', { name: '受け取り口の名前を変更する' }))
  await act(async () => { edit.click() })
  await act(async () => { fireEvent.change(within(host).getByRole('textbox', { name: '受け取り口の名前' }), { target: { value: '変更中' } }) })
  const original = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (/\/api\/webhooks\/incoming\/in-1/.test(url) && init?.method === 'PATCH') return json({ success: true, data: INLET })
    if (url.includes('/api/webhooks/incoming') && !url.includes('/in-1')) return json({ success: true, data: [] })
    return original(input, init)
  })
  await act(async () => { fireEvent.click(within(host).getByRole('switch', { name: '申込フォームを動かす' })) })
  await vi.waitFor(() => expect(within(host).queryByRole('textbox', { name: '受け取り口の名前' })).toBeNull())
  const link = document.createElement('a'); link.href = '/events'; link.textContent = 'イベントへ'; document.body.append(link)
  try {
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link.dispatchEvent(click) })
    expect(click.defaultPrevented).toBe(false)
    expect(document.body.textContent).not.toContain('保存していない変更があります')
  } finally { link.remove() }
})

it('受け取り口を切り替える前に名前と行うことの両方を確認する', async () => {
  const original = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/webhooks/incoming/in-2')) return json({ success: true, data: { ...INLET, id: 'in-2', name: '二つ目の窓口', version: 1, identityMatching: { methods: [{ kind: 'verified_email', path: '$.email' }], onNotFound: 'do_nothing' }, actions: [], actionExecution: { state: 'not_configured', reason: null }, latestSample: null, templateFields: [], pendingUnmatched: 0, previousSecretUsableUntil: null } })
    if (url.includes('/api/common-actions/resources')) return json({ success: true, data: { tags: [{ id: 'tag-new', name: '新しいタグ' }], templates: [], scenarios: [], webhooks: [], richMenus: [], commonActions: [], supportMarks: [] } })
    if (url.includes('/api/webhooks/incoming') && !url.includes('/in-1') && !url.includes('/unmatched')) return json({ success: true, data: [INLET, { ...INLET, id: 'in-2', name: '二つ目の窓口' }] })
    return original(input, init)
  })
  window.history.replaceState(null, '', '/webhooks?tab=incoming')
  await render(<WebhooksIncomingV8 />)
  const edit = await vi.waitFor(() => within(host).getByRole('button', { name: '受け取り口の名前を変更する' }))
  await act(async () => { edit.click() })
  await act(async () => { fireEvent.change(within(host).getByRole('textbox', { name: '受け取り口の名前' }), { target: { value: '変更中の名前' } }) })
  const add = await vi.waitFor(() => within(host).getByRole('button', { name: '行うことを足す' }))
  await act(async () => { add.click() })
  await act(async () => { within(document.body).getByRole('menuitem', { name: /タグを付ける/ }).click() })
  const picker = within(document.body).getByRole('dialog', { name: 'タグを付ける対象を選ぶ' })
  await act(async () => { within(picker).getByRole('radio', { name: '新しいタグ' }).click(); within(picker).getByRole('button', { name: '選ぶ' }).click() })
  await act(async () => { within(host).getByText('二つ目の窓口').click() })
  const dialog = within(document.body).getByRole('dialog', { name: '保存していない変更があります' })
  expect(dialog.textContent).toContain('受け取り口の変更')
  expect(dialog.textContent).toContain('行うことの変更')
  await act(async () => { within(dialog).getByRole('button', { name: 'すべて保存せずに移る' }).click() })
  await vi.waitFor(() => expect(within(document.body).queryByRole('dialog', { name: '保存していない変更があります' })).toBeNull())
  await vi.waitFor(() => expect(within(host).getByRole('switch', { name: '二つ目の窓口を動かす' })).toBeTruthy())
})

it('受け取り口の名前に未保存の変更がある間は合言葉の窓を開く前に確認する', async () => {
  window.history.replaceState(null, '', '/webhooks?tab=incoming')
  await render(<WebhooksIncomingV8 />)
  const edit = await vi.waitFor(() => within(host).getByRole('button', { name: '受け取り口の名前を変更する' }))
  await act(async () => { edit.click() })
  await act(async () => { fireEvent.change(within(host).getByRole('textbox', { name: '受け取り口の名前' }), { target: { value: '変更中' } }) })
  await act(async () => { within(host).getByRole('button', { name: '合言葉を更新する' }).click() })
  expect(document.body.textContent).toContain('保存していない変更があります')
  expect(within(document.body).queryByLabelText('新しい合言葉')).toBeNull()
})
