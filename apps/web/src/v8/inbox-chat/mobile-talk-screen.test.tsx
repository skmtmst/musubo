// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * 電話の画面のトーク（/m/chats）。PC の受信箱と同じ守りを電話の画面でも保つ。
 * - 送ると 1 回だけ送る（冪等キー付き）。失敗したら書いた文を残し、もう一度送ると同じキーで送る。
 * - 閲覧のみ・受信箱を変えられない人には返信欄を出さない（閲覧のみの帯は出す）。
 * - いま選んでいるアカウントの相手でない会話は開かない（別のアカウントから送らない）。
 * - 受信箱を見る権限が無い人には、トークの中身もタブも出さない。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  params: new URLSearchParams(),
  role: 'staff' as string | null,
  canView: true,
  canEdit: true,
  friendAccount: 'account-a',
  sendStatus: [] as number[],
  sendKeys: [] as string[],
  sendBodies: [] as string[],
  chatCalls: 0,
  previewCalls: 0,
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  useSearchParams: () => fixture.params,
  usePathname: () => '/m/chats',
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}))
vi.mock('@/components/auth-guard', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('@/contexts/account-context', () => ({
  AccountProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAccount: () => ({
    accounts: [{ id: 'account-a', name: '店A', displayName: '店A', iconUrl: null, pictureUrl: null, basicId: null }],
    selectedAccountId: 'account-a',
    setSelectedAccountId() {},
    loading: false,
  }),
}))
vi.mock('@/lib/staff-role', async (original) => ({
  ...(await original<typeof import('@/lib/staff-role')>()),
  useStaffRole: () => fixture.role,
}))
vi.mock('@/lib/staff-capability', () => ({
  canViewFeature: () => fixture.canView,
  canEditFeature: () => fixture.canEdit,
}))

import MobileShell from '@/components/mobile/mobile-shell'
import MobileTalkScreen from './mobile-talk-screen'

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const chatRow = {
  id: 'friend-a', friendId: 'friend-a', friendName: '山田', operatorId: null,
  status: 'unread', isUnread: true, lastMessageAt: '2026-09-16T01:00:00.000Z',
  lastMessageContent: '届きましたか', lastMessageType: 'text', lastMessageDirection: 'incoming',
}
const detail = {
  id: 'friend-a', friendId: 'friend-a', friendName: '山田', friendRealName: null, friendPictureUrl: null,
  isAttention: false, operatorId: null, status: 'unread', notes: null, revision: 1,
  lastMessageAt: '2026-09-16T01:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z', total: 1,
  messages: [{
    id: 'm-1', direction: 'incoming', messageType: 'text', content: '届きましたか', isUnsent: false, source: 'user',
    originKind: null, sentByStaffId: null, sentByStaffName: null, scenarioName: null, quoted: null, createdAt: '2026-09-16T01:00:00.000Z',
  }],
  hasMoreMessages: false,
}

function responseFor(url: URL, init?: RequestInit): Response {
  if (url.pathname === '/api/chats') return json({ success: true, data: [chatRow] })
  if (url.pathname === '/api/support/inbox') return json({ success: true, data: { items: [], summary: { total: 0 } } })
  if (url.pathname === '/api/inbox/unanswered/count') return json({ success: true, data: { total: 3, byAccount: [] } })
  if (url.pathname === '/api/chats/friend-a/render-preview') {
    fixture.previewCalls += 1
    return json({ success: true, data: { content: '山田さん {{var.guest_count}}', unresolved: ['var.guest_count'] } })
  }
  if (url.pathname === '/api/chats/friend-a/send' && init?.method === 'POST') {
    fixture.sendKeys.push(new Headers(init.headers).get('Idempotency-Key') ?? '')
    fixture.sendBodies.push(String(init.body))
    const status = fixture.sendStatus.shift() ?? 200
    return status === 200
      ? json({ success: true, data: { sent: true, messageId: 'm-2', sentByStaffName: '担当', revision: 2 } })
      : json({ success: false, error: 'LINE への送信に失敗しました' }, status)
  }
  if (url.pathname === '/api/chats/friend-a') {
    fixture.chatCalls += 1
    return json({ success: true, data: detail })
  }
  if (url.pathname === '/api/friends/friend-a') {
    return json({ success: true, data: { id: 'friend-a', displayName: '山田', lineAccountId: fixture.friendAccount, tags: [] } })
  }
  if (url.pathname === '/api/auth/session') return json({ success: true, data: { impersonation: null } })
  return json({ success: true, data: [] })
}

async function eventually(check: () => void, timeout = 2_000): Promise<void> {
  const started = Date.now()
  while (true) {
    try { check(); return } catch (error) {
      if (Date.now() - started >= timeout) throw error
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
    }
  }
}

describe('電話の画面のトーク', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.assign(fixture, { params: new URLSearchParams(), role: 'staff', canView: true, canEdit: true, friendAccount: 'account-a', sendStatus: [], sendKeys: [], sendBodies: [], chatCalls: 0, previewCalls: 0 })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {}, removeItem() {} })
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => responseFor(new URL(String(input), 'http://localhost'), init))
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    window.scrollTo = () => {}
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const show = async () => { await act(async () => root.render(<MobileShell><MobileTalkScreen /></MobileShell>)) }
  const draft = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="メッセージを入力"]')
  const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(name)) ?? null
  const type = async (text: string) => {
    const area = draft()!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text)
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('一覧はカード 1 列で会話を開く住所を持ち、トークのタブに未対応の数を出す', async () => {
    await show()
    await eventually(() => expect(host.querySelector('a[href="/m/chats?friend=friend-a"]')).not.toBeNull())
    const tab = host.querySelector('nav[aria-label="電話のメニュー"] a[href="/m/chats"]')!
    expect(tab.getAttribute('aria-current')).toBe('page')
    await eventually(() => expect(tab.textContent).toContain('3件'))
  })

  it('送ると冪等キー付きで 1 回だけ送り、送った文が会話に出る', async () => {
    fixture.params = new URLSearchParams('friend=friend-a')
    await show()
    await eventually(() => expect(draft()).not.toBeNull())
    expect(button('送る')).toBeNull() // 空の時は送るボタンを出さない
    await type('予約を承りました')
    await act(async () => { button('送る')!.click() })
    await eventually(() => expect(host.textContent).toContain('予約を承りました'))
    await eventually(() => expect(draft()!.value).toBe(''))
    expect(fixture.sendKeys).toHaveLength(1)
    expect(fixture.sendKeys[0]).not.toBe('')
    expect(JSON.parse(fixture.sendBodies[0])).toMatchObject({ content: '予約を承りました', revision: 1 })
  })

  it('スマホも予約の不足と送信見本を同じ1回の取得で表示する', async () => {
    fixture.params = new URLSearchParams('friend=friend-a')
    await show()
    await eventually(() => expect(draft()).not.toBeNull())
    await type('{{name}}さん {{var.guest_count}}')
    await eventually(() => expect(host.textContent).toContain('送るとこうなります：'))
    expect(host.textContent).toContain('山田さん {{var.guest_count}}')
    expect(host.textContent).toContain('予約の値がないため')
    expect(host.querySelector('[title="山田さん {{var.guest_count}}"]')).not.toBeNull()
    expect(fixture.previewCalls).toBe(1)
    await type('こんにちは')
    expect(host.textContent).not.toContain('送るとこうなります：')
  })

  it('送れなかったら書いた文を残し、もう一度送ると同じ冪等キーで送る', async () => {
    fixture.params = new URLSearchParams('friend=friend-a')
    fixture.sendStatus = [500, 200]
    await show()
    await eventually(() => expect(draft()).not.toBeNull())
    await type('明日10時でお取りしました')
    await act(async () => { button('送る')!.click() })
    await eventually(() => expect(button('もう一度送る')).not.toBeNull())
    expect(draft()!.value).toBe('明日10時でお取りしました')
    await act(async () => { button('もう一度送る')!.click() })
    await eventually(() => expect(fixture.sendKeys).toHaveLength(2))
    expect(fixture.sendKeys[1]).toBe(fixture.sendKeys[0])
    await eventually(() => expect(draft()!.value).toBe(''))
  })

  it('書きかけの返信がある時に上の帯の＜で戻ると、捨ててよいかを確かめる', async () => {
    fixture.params = new URLSearchParams('friend=friend-a')
    await show()
    await eventually(() => expect(draft()).not.toBeNull())
    await type('途中まで書いた返事')
    const back = host.querySelector<HTMLAnchorElement>('a[aria-label="トークへ戻る"]')!
    await act(async () => { back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })) })
    await eventually(() => expect(document.body.textContent).toContain('書きかけの返信'))
    expect(draft()!.value).toBe('途中まで書いた返事')
  })

  it('閲覧のみには返信欄を出さず、閲覧のみの帯を出す', async () => {
    fixture.params = new URLSearchParams('friend=friend-a')
    fixture.role = verifiedStaffRole('viewer')
    fixture.canEdit = false
    await show()
    await eventually(() => expect(host.textContent).toContain('届きましたか'))
    expect(draft()).toBeNull()
    expect(host.querySelector('[data-read-only-notice]')).not.toBeNull()
  })

  it('いま選んでいるアカウントの相手でない会話は開かない', async () => {
    fixture.params = new URLSearchParams('friend=friend-a')
    fixture.friendAccount = 'account-b'
    await show()
    await eventually(() => expect(host.textContent).toContain('いま選んでいるLINEアカウントの相手ではありません'))
    expect(fixture.chatCalls).toBe(0)
    expect(draft()).toBeNull()
  })

  it('受信箱を見る権限が無い人には、トークの中身もタブも出さない', async () => {
    fixture.canView = false
    await show()
    await eventually(() => expect(host.querySelector('[data-list-state="forbidden"], [data-list-state]')).not.toBeNull())
    expect(host.querySelector('a[href="/m/chats?friend=friend-a"]')).toBeNull()
    expect(host.querySelector('nav[aria-label="電話のメニュー"] a[href="/m/chats"]')).toBeNull()
  })
})

afterEach(() => { verifiedStaffRole(null) })
