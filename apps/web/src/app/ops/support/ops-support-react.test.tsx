// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OpsSupportPage from './page'
import { OPS_READONLY_LOCK_REASON } from '../../../v8/ops/use-ops-read-only'

vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }))
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ticket = {
  id: 't1', ticketNo: 312, ticketLabel: '#MB-0312', tenantId: 'tenant-a', tenantName: '株式会社サンプル',
  tenantPlanKey: 'standard', tenantPlanStatus: 'active', tenantStatus: 'active', staffId: 's1', staffName: '山田 太郎',
  staffRole: 'owner', staffEmailRegistered: true, kind: 'bug', kindLabel: '不具合', subject: '回答フォームからタグが付かない',
  subjectAuto: false, body: '設定したタグが友だちに付きません。', attachments: [], stage: 'new', stageLabel: '新規',
  priority: 'high', priorityLabel: '高', channel: 'admin', channelLabel: '管理画面', assigneeStaffId: null,
  replyCount: 0, firstRepliedAt: null, lastMessageAt: new Date().toISOString(), resolvedAt: null, closedAt: null,
  createdAt: '2026-09-15T08:40:00.000+09:00', updatedAt: '2026-09-15T08:40:00.000+09:00',
}
const defaults = [
  ['contracts', '契約・解約'], ['usage', '使い方・操作'], ['billing', '請求・支払い'],
  ['line', 'LINE連携・配信'], ['bugs', '不具合・障害'], ['other', 'その他'],
].map(([id, name]) => ({ id, name, isDefault: true }))
type Template = { id: string; folderId: string; title: string; body: string; createdAt: string; updatedAt: string }
let host: HTMLDivElement
let root: Root
let calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }>
let draft: { body: string } | null
let readonly: boolean
let folders: typeof defaults
let templates: Template[]

function respond(url: string, init?: RequestInit) {
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
  calls.push({ url, method, body })
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
  if (url.endsWith('/api/ops/me')) return json({ success: true, data: { id: 'ops-1', readOnly: readonly } })
  if (url.endsWith('/api/ops/support/summary')) return json({ success: true, data: { byStage: { all: 1, new: 1, in_progress: 0, waiting: 0, resolved: 0, closed: 0 }, kpis: null } })
  if (url.includes('/api/ops/support/tickets?')) return json({ success: true, data: [ticket], total: 1 })
  if (url.endsWith('/api/ops/support/templates') && method === 'GET') return json({ success: true, data: { folders, templates } })
  if (url.endsWith('/api/ops/support/template-folders') && method === 'POST') {
    const item = { id: `custom-${folders.length}`, name: String(body?.name), isDefault: false }
    folders.push(item)
    return json({ success: true, data: item }, 201)
  }
  if (url.endsWith('/api/ops/support/templates') && method === 'POST') {
    const item = { id: `template-${templates.length}`, folderId: String(body?.folderId), title: String(body?.title), body: String(body?.body), createdAt: '', updatedAt: '' }
    templates.push(item)
    return json({ success: true, data: item }, 201)
  }
  if (url.endsWith('/api/ops/support/tickets/t1')) return json({ success: true, data: { ticket, tenant: {}, messages: [], draft } })
  if (url.endsWith('/reply')) return json({ success: true, data: { ticket, message: {}, mailSent: true, mailSkippedReason: null } }, 201)
  return json({ success: false, error: `unexpected ${method} ${url}` }, 404)
}
async function flush() { for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve() }) }
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)
  expect(button, `「${label}」ボタン`).toBeTruthy()
  await act(async () => button!.click()); await flush()
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  calls = []; draft = null; readonly = false; folders = [...defaults]
  templates = [{ id: 'welcome', folderId: 'contracts', title: '解約のご案内', body: '解約手続きをご案内します。', createdAt: '', updatedAt: '' }]
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test'
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init)))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

describe('Penに合わせた問い合わせ', () => {
  it('保存済み下書きを編集でき、送信前に確認する', async () => {
    draft = { body: '手で書いた返信' }
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    expect((host.querySelector('textarea[aria-label="返信"]') as HTMLTextAreaElement).value).toBe(draft.body)
    await click('返信する')
    const confirmation = document.body.querySelector('[data-design-node="GgP2d"]')
    expect(confirmation?.textContent).toContain(draft.body)
    expect(confirmation?.textContent).not.toContain('AI')
    expect(calls.some(call => call.url.endsWith('/reply'))).toBe(false)
  })

  it('初期フォルダを表示し、カーソル位置にテンプレートを引用する', async () => {
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    const reply = host.querySelector('textarea[aria-label="返信"]') as HTMLTextAreaElement
    await type(reply, '前文\n後文')
    reply.setSelectionRange(3, 3)
    await click('テンプレート引用')
    expect(document.body.textContent).toContain('契約・解約')
    expect(document.body.textContent).toContain('不具合・障害')
    await click('返信に引用する')
    expect(reply.value).toBe('前文\n解約手続きをご案内します。後文')
    expect(calls.some(call => call.url.endsWith('/reply'))).toBe(false)
  })

  it('フォルダとテンプレートを作成し、そのフォルダから引用できる', async () => {
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    await click('テンプレート引用')
    await click('フォルダを作成')
    await type(document.body.querySelector('input[placeholder="例：キャンペーン対応"]')!, 'キャンペーン対応')
    await click('フォルダを作成')
    expect(calls.find(call => call.url.endsWith('/template-folders') && call.method === 'POST')?.body).toEqual({ name: 'キャンペーン対応' })
    await click('テンプレートを作成')
    await type(document.body.querySelector('input[placeholder="例：解約手続きのご案内"]')!, 'クーポンの案内')
    await type(document.body.querySelector('textarea[placeholder^="お問い合わせありがとうございます。"]')!, 'クーポンはこちらです。')
    await click('テンプレートを保存')
    expect(calls.find(call => call.url.endsWith('/templates') && call.method === 'POST')?.body).toMatchObject({ folderId: 'custom-6', title: 'クーポンの案内', body: 'クーポンはこちらです。' })
    await click('返信に引用する')
    expect((host.querySelector('textarea[aria-label="返信"]') as HTMLTextAreaElement).value).toBe('クーポンはこちらです。')
  })

  it('閲覧のみでは作成・引用・返信できない', async () => {
    readonly = true
    await act(async () => root.render(<OpsSupportPage />)); await flush()
    expect(host.textContent).toContain(OPS_READONLY_LOCK_REASON)
    expect(host.textContent).toContain('チケット作成')
    expect((host.querySelector('textarea[aria-label="返信"]') as HTMLTextAreaElement).disabled).toBe(true)
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '返信する')?.getAttribute('aria-disabled')).toBe('true')
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  })
})
