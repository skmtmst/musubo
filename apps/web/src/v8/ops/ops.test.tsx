import { getPageAction, querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * ★V8 運営コンソール（src/v8/ops）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * V8 のテーマで表示し、閲覧のみの人に押せない形＋理由で出すこと・送る前に必ず確かめること・
 * 停止の窓が名前と理由を確かめるまで口を呼ばないことを見る。
 */
import React, { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

let search = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/ops/members',
  useSearchParams: () => new URLSearchParams(search),
}))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))

import OpsShellV8 from './shell'
import OpsMembersV8 from './members'
import OpsTenantsV8 from './tenants'
import OpsAnnouncementsV8 from './announcements'
import OpsAnnouncementEditV8 from './announcement-edit'
import OpsTenantDetailV8 from './tenant-detail'
import KnowledgeArticleV8 from './knowledge-article'
import { OPS_READONLY_LOCK_REASON } from './use-ops-read-only'
import { api, type OpsKnowledgeArticle } from '@/lib/api'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const ME = { id: 'ops-1', name: '検証 太郎', email: null, readOnly: false, totpEnabled: true, lineLinked: false, legacy: false, impersonation: null }
const MEMBERS = [
  { staffId: 'ops-1', name: '検証 太郎', email: 'a@example.com', isActive: true, totpEnabled: true, lineLinked: false, inviteStatus: 'accepted', activationState: 'active', invitedAt: null, approvedBy: null, lastLoginAt: null, createdAt: '2026-09-01T00:00:00Z' },
  { staffId: 'ops-2', name: '見本 次郎', email: 'b@example.com', isActive: true, totpEnabled: true, lineLinked: false, inviteStatus: 'accepted', activationState: 'active', invitedAt: null, approvedBy: null, lastLoginAt: null, createdAt: '2026-09-01T00:00:00Z' },
]
const TENANT = {
  id: 't1', name: '契約先A', status: 'active', featurePacks: [], plan_key: 'standard', plan_status: 'active', trial_ends_at: null,
  current_period_ends_at: null, created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z', account_count: 1, staff_count: 1, last_login_at: null,
}

let readOnly = false
let calls: Array<{ method: string; url: string }> = []
let root: Root
let host: HTMLDivElement
/** 役割の応答を止めて「分からない」状態を作る（null のときはすぐ返す）。 */
let meGate: Promise<void> | null = null
let releaseMe: (() => void) | null = null
let tenantAccounts: Array<{ id: string; name: string }> = []
let tenantStatus = 'active'

beforeEach(() => {
  readOnly = false
  search = ''
  calls = []
  meGate = null
  releaseMe = null
  tenantAccounts = []
  tenantStatus = 'active'
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url })
    if (url.endsWith('/api/ops/me')) {
      if (meGate) await meGate
      return json({ success: true, data: { ...ME, readOnly } })
    }
    if (url.endsWith('/api/ops/members')) return json({ success: true, data: MEMBERS, summary: { members: 2, invited: 0, awaitingTotp: 0, totpEnabled: 2, impersonationsThisMonth: 0, writeImpersonationsThisMonth: 0, piiRevealsThisMonth: 0 } })
    if (url.includes('/api/ops/tenants/t1')) return json({ success: true, data: { tenant: { ...TENANT, status: tenantStatus }, accounts: tenantAccounts, members: [], audit: [] } })
    if (url.includes('/api/ops/tenants/t2')) return json({ success: true, data: { tenant: { ...TENANT, id: 't2', name: '契約先B', status: 'suspended' }, accounts: [], members: [], audit: [] } })
    if (url.includes('/api/ops/tenants')) return json({ success: true, data: [TENANT], summary: { active: 1, trialing: 0, suspended: 0, pastDue: 0 } })
    if (url.endsWith('/api/ops/announcements/preview')) return json({ success: true, data: { tenants: 1, staff: 1, lineLinked: 0, withEmail: 1 } })
    if (url.endsWith('/api/ops/announcements')) {
      if (method !== 'GET') return json({ success: false, error: 'should not be called' }, 500)
      return json({ success: true, data: [], linked: { linked: 0, total: 1 }, noticeLineConfigured: true })
    }
    return json({ success: false, error: 'unexpected' }, 404)
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

async function settle(turns = 12) {
  for (let i = 0; i < turns; i += 1) await act(async () => { await Promise.resolve() })
}
const text = () => document.body.textContent ?? ''
const buttons = (label: string) => [...document.body.querySelectorAll('button, a')].filter((el) => el.textContent?.trim() === label)

describe('運営コンソールの V8 外枠', () => {
  it('運営のメニュー・パンくず・注意の帯を出す', async () => {
    await act(async () => {
      root.render(<OpsShellV8 me={ME} meError="" onRetryMe={() => {}} pathname="/ops/members"><p>中身</p></OpsShellV8>)
    })
    for (const label of ['ダッシュボード', '契約先アカウント', 'お問い合わせ', 'お知らせ', '監査ログ', 'メンバー管理']) {
      expect(text()).toContain(label)
    }
    expect(text()).toContain('運営 › メンバー管理')
    expect(document.querySelector('a[aria-current="page"]')).toBeNull()
  })
})

describe('閲覧のみには隠さず押せない形＋理由で出す', () => {
  it('運営メンバー停止は対象者・件数・環境を示し、閉じた確認は実行できない', async () => {
    await act(async () => { root.render(<OpsMembersV8 />) })
    await settle()
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="見本 次郎のその他操作"]')!.click())
    act(() => document.querySelector<HTMLElement>('[role="menuitem"]')!.click())
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('見本 次郎')
    expect(dialog.textContent).toContain('1人')
    expect(dialog.textContent).toContain('環境')
    const confirm = buttons('停止する')[0] as HTMLButtonElement
    const key = Object.keys(confirm).find(k => k.startsWith('__reactProps$'))!
    const oldClick = (confirm as unknown as Record<string, { onClick: () => void }>)[key].onClick
    await act(async () => { (buttons('キャンセル')[0] as HTMLButtonElement).click() })
    await act(async () => { oldClick() })
    expect(calls.some(c => c.method !== 'GET')).toBe(false)
  })

  it('運営メンバー停止の確認から対象者の変更を呼ぶ', async () => {
    await act(async () => { root.render(<OpsMembersV8 />) })
    await settle()
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="見本 次郎のその他操作"]')!.click())
    act(() => document.querySelector<HTMLElement>('[role="menuitem"]')!.click())
    await act(async () => { (buttons('停止する')[0] as HTMLButtonElement).click() })
    await settle()
    expect(calls.filter(c => c.method !== 'GET').map(c => c.url)).toEqual([expect.stringContaining('ops-2')])
  })

  it('自分の運営アカウントは停止できず、理由を示して送信しない', async () => {
    await act(async () => { root.render(<OpsMembersV8 />) })
    await settle()
    const selfMenu = document.querySelector<HTMLButtonElement>('button[aria-label="検証 太郎のその他操作"]')!
    expect(selfMenu).not.toBeNull()
    expect(selfMenu.disabled).toBe(true)
    expect(selfMenu.getAttribute('title')).toBe('自分の運営アカウントは停止・取り消しできません')
    act(() => selfMenu.click())
    await settle()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  })

  it('メンバー管理：書ける人には招待と停止、閲覧のみは押せない形＋理由で押しても口を呼ばない', async () => {
    await act(async () => { root.render(<OpsMembersV8 />) })
    await settle()
    expect(buttons('招待する')).toHaveLength(1)
    const menu = document.querySelector<HTMLButtonElement>('button[aria-label="見本 次郎のその他操作"]')!
    expect(menu).not.toBeNull()
    act(() => menu.click())
    const stop = document.querySelector<HTMLElement>('[role="menuitem"]')!
    expect(stop.textContent).toContain('停止する')
    act(() => stop.click())
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain('停止')
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0)
    act(() => buttons('キャンセル')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()

    act(() => root.unmount())
    readOnly = true
    calls = []
    root = createRoot(host)
    await act(async () => { root.render(<OpsMembersV8 />) })
    await settle()
    expect(text()).toContain('見本 次郎')
    // 招待は押せない形＋理由で出し、押しても口を呼ばない。
    expect(buttons('招待する')).toHaveLength(1)
    expect(text()).toContain(OPS_READONLY_LOCK_REASON)
    act(() => buttons('招待する')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0)
    // 行の「…」も押せない形＋理由で出し、選んでも口を呼ばない。
    const lockedMenu = document.querySelector<HTMLButtonElement>('button[aria-label="見本 次郎のその他操作"]')!
    expect(lockedMenu).not.toBeNull()
    act(() => lockedMenu.click())
    const lockedStop = document.querySelector<HTMLElement>('[role="menuitem"]')!
    expect(lockedStop.textContent).toContain('停止する')
    expect(lockedStop.textContent).toContain(OPS_READONLY_LOCK_REASON)
    act(() => lockedStop.click())
    await settle()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  })

  it('契約先アカウント：閲覧のみは「契約先を作る」を押せない形＋理由で出し、押しても窓を開かない', async () => {
    readOnly = true
    await act(async () => { root.render(<OpsTenantsV8 />) })
    await settle()
    expect(text()).toContain('契約先A')
    expect(buttons('契約先を作る')).toHaveLength(1)
    expect(text()).toContain(OPS_READONLY_LOCK_REASON)
    act(() => buttons('契約先を作る')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  })

  it('役割が分かるまでは理由なしの押せない形で出し、分かったら切り替える', async () => {
    meGate = new Promise<void>((resolve) => { releaseMe = resolve })
    await act(async () => { root.render(<OpsTenantsV8 />) })
    await settle()
    expect(buttons('契約先を作る')).toHaveLength(1)
    expect(text()).not.toContain(OPS_READONLY_LOCK_REASON)
    expect((buttons('契約先を作る')[0] as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { releaseMe!() })
    await settle()
    expect((buttons('契約先を作る')[0] as HTMLButtonElement).disabled).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('契約先の詳細：閲覧のみは停止も押せない形＋理由で出し、押しても窓を開かない', async () => {
    readOnly = true
    search = 'id=t1'
    await act(async () => { root.render(<OpsTenantDetailV8 />) })
    await settle()
    expect(getPageAction({ name: '停止' })).toBeTruthy()
    expect(getPageAction({ name: 'アーカイブ' })).toBeTruthy()
    expect(document.body.textContent).toContain(OPS_READONLY_LOCK_REASON)
    await act(async () => { getPageAction({ name: '停止' }).click() })
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('ナレッジの記事：閲覧のみは保存も承認も押せない形＋理由で出し、欄も止めて口を呼ばない', async () => {
    readOnly = true
    const article = {
      id: 'k1', version: 1, sourceRequestId: 'r1', ticketNo: 12, sourceCurrent: true, articleKind: 'verified', reviewState: 'approved', status: 'active',
      reviewReason: '', evidence: [], usedCount: 0, helpfulCount: 0, unhelpfulCount: 0, updatedAt: '2026-10-01T00:00:00Z',
      title: '配信の止め方', question: '止めたい', answer: '一時停止を押す', kind: 'usage', keywords: [],
    } as unknown as OpsKnowledgeArticle
    await act(async () => { root.render(<KnowledgeArticleV8 article={article} onClose={() => {}} onSaved={() => {}} />) })
    await settle()
    expect(buttons('承認待ちで保存する')).toHaveLength(1)
    expect(text()).toContain(OPS_READONLY_LOCK_REASON)
    expect((document.querySelector('#ka-title') as HTMLInputElement).disabled).toBe(true)
    await act(async () => { (buttons('承認待ちで保存する')[0] as HTMLButtonElement).click() })
    await settle()
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })
})

describe('送る・止める前に確かめる', () => {
  it('お知らせ：今すぐ送るを押すと確認の窓が開き、まだ送らない', async () => {
    await act(async () => { root.render(<OpsAnnouncementEditV8 />) })
    await settle()
    // 件名と本文を入れてから押す（足りない欄があるうちは確認の窓を開かない。）。
    fireEvent.change(document.querySelector('#ann-subject')!, { target: { value: 'メンテナンスのお知らせ' } })
    fireEvent.change(document.querySelector('#ann-body')!, { target: { value: '深夜に止まります。' } })
    const send = buttons('今すぐ送る')[0] as HTMLButtonElement
    expect(send).toBeTruthy()
    await act(async () => { send.click() })
    await settle()
    expect(text()).toContain('このお知らせを送りますか？')
    expect(document.querySelector('[data-design-node="TJUUl"]')?.textContent).toContain('環境')
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/ops/announcements'))).toHaveLength(0)
  })

  it('お知らせ：件名と本文が空なら確認の窓を開かず、欄が赤くなり理由が出て、件名の欄へ移る', async () => {
    await act(async () => { root.render(<OpsAnnouncementEditV8 />) })
    await settle()
    await act(async () => { (buttons('今すぐ送る')[0] as HTMLButtonElement).click() })
    for (let i = 0; i < 2; i += 1) await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(text()).not.toContain('このお知らせを送りますか？')
    const subject = document.querySelector('#ann-subject') as HTMLInputElement
    expect(subject.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#ann-subject-error')?.textContent).toBe('件名を入力してください')
    expect(document.querySelector('#ann-body')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#ann-body-error')?.textContent).toBe('本文を入力してください')
    expect(document.activeElement).toBe(subject)
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/ops/announcements'))).toHaveLength(0)
  })

  it('契約先の停止：名前と理由がそろう前はボタンがあっても口を呼ばず、足りないものを知らせる', async () => {
    search = 'id=t1'
    await act(async () => { root.render(<OpsTenantDetailV8 />) })
    await settle()
    await act(async () => { getPageAction({ name: '停止' }).click() })
    await settle()
    const name = document.querySelector('input[placeholder="契約先A"]') as HTMLInputElement
    expect(name.getAttribute('aria-required')).toBe('true')
    const nameField = name.closest('[data-field]') ?? name.parentElement?.parentElement
    expect(nameField?.textContent).toContain('必須')
    expect(nameField?.textContent).not.toContain('任意')
    const confirm = buttons('停止する')[0] as HTMLButtonElement
    expect(confirm).toBeTruthy()
    await act(async () => { confirm.click() })
    await settle()
    expect(text()).toContain('契約先の名前をそのまま入力してください')
    expect(calls.some((c) => c.method !== 'GET' && c.url.includes('/status'))).toBe(false)
  })

  it('契約先停止の確認に、対象契約先の LINE アカウントと件数と環境を示す', async () => {
    tenantAccounts = [{ id: 'store-b', name: '店B' }]
    search = 'id=t1'
    await act(async () => { root.render(<OpsTenantDetailV8 />) })
    await settle()
    await act(async () => { getPageAction({ name: '停止' }).click() })
    await settle()
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')!
    expect(dialog.textContent).toContain('店B')
    expect(dialog.textContent).toContain('環境')
    expect(dialog.textContent).toContain('1件')
  })

  it('契約先を移動したら古い再開の確認では実行できない', async () => {
    tenantStatus = 'suspended'
    search = 'id=t1'
    await act(async () => { root.render(<OpsTenantDetailV8 />) })
    await settle()
    await act(async () => { getPageAction({ name: '再開' }).click() })
    fireEvent.change(document.querySelector('input[aria-label="理由（4文字以上）"]')!, { target: { value: '確認済みの理由' } })
    const confirm = buttons('再開する')[0] as HTMLButtonElement
    const key = Object.keys(confirm).find(k => k.startsWith('__reactProps$'))!
    const oldClick = (confirm as unknown as Record<string, { onClick: () => void }>)[key].onClick
    search = 'id=t2'
    await act(async () => { root.render(<OpsTenantDetailV8 />) })
    await settle()
    const closed = document.querySelector('[role="dialog"], [role="alertdialog"]') === null
    await act(async () => { oldClick() })
    expect(calls.some(c => c.method !== 'GET' && c.url.includes('/status'))).toBe(false)
    expect(closed).toBe(true)
  })

  it('多数の店舗を短くまとめて件数と残りを示す', async () => {
    tenantAccounts = Array.from({ length: 6 }, (_, i) => ({ id: `store-${i}`, name: `店舗${i + 1}` }))
    search = 'id=t1'
    await act(async () => { root.render(<OpsTenantDetailV8 />) })
    await settle()
    await act(async () => { getPageAction({ name: '停止' }).click() })
    await settle()
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')!
    expect(dialog.textContent).toContain('LINEアカウント（6件）')
    expect(dialog.textContent).toContain('店舗1')
    expect(dialog.textContent).toContain('ほか')
    expect(dialog.textContent).not.toContain('店舗6')
    expect(dialog.textContent).toContain('契約先：契約先A（1件）')
  })

  it.each([
    ['停止', 'active', '要確認'],
    ['アーカイブ', 'active', '要確認'],
    ['再開', 'suspended', '再開すると'],
  ])('契約先の%s確認は対象名と操作前の案内を示す', async (action, status, expected) => {
    tenantStatus = status
    search = 'id=t1'
    await act(async () => { root.render(<OpsTenantDetailV8 />) })
    await settle()
    await act(async () => { getPageAction({ name: action }).click() })
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')!
    expect(dialog.textContent).toContain('契約先：契約先A（1件）')
    expect(dialog.textContent).toContain(expected)
    expect(dialog.textContent).not.toContain('失敗：')
  })

  it('閉じた契約先停止の確認では実行できない', async () => {
    search = 'id=t1'
    await act(async () => { root.render(<OpsTenantDetailV8 />) })
    await settle()
    await act(async () => { getPageAction({ name: '停止' }).click() })
    await settle()
    fireEvent.change(document.querySelector('input[placeholder="契約先A"]')!, { target: { value: '契約先A' } })
    fireEvent.change(document.querySelector('input[aria-label="理由（4文字以上）"]')!, { target: { value: '確認済みの理由' } })
    const confirm = buttons('停止する')[0] as HTMLButtonElement
    const key = Object.keys(confirm).find(k => k.startsWith('__reactProps$'))!
    const oldClick = (confirm as unknown as Record<string, { onClick: () => void }>)[key].onClick
    await act(async () => { (buttons('キャンセル')[0] as HTMLButtonElement).click() })
    await act(async () => { oldClick() })
    expect(calls.some(c => c.method !== 'GET' && c.url.includes('/status'))).toBe(false)
  })

  it('確認した契約先だけに停止を送る', async () => {
    search = 'id=t1'
    await act(async () => { root.render(<OpsTenantDetailV8 />) })
    await settle()
    await act(async () => { getPageAction({ name: '停止' }).click() })
    fireEvent.change(document.querySelector('input[placeholder="契約先A"]')!, { target: { value: '契約先A' } })
    fireEvent.change(document.querySelector('input[aria-label="理由（4文字以上）"]')!, { target: { value: '確認済みの理由' } })
    await act(async () => { (buttons('停止する')[0] as HTMLButtonElement).click() })
    await settle()
    expect(calls.filter(c => c.method !== 'GET' && c.url.includes('/status')).map(c => c.url)).toEqual([expect.stringContaining('/api/ops/tenants/t1/status')])
  })
})

describe('欄で知らせて移る', () => {
  it('ナレッジの記事：題名を消して保存すると、口を呼ばず題名の欄が赤くなり理由が出て、その欄へ移る', async () => {
    const article = {
      id: 'k1', version: 1, sourceRequestId: 'r1', ticketNo: 12, sourceCurrent: true, articleKind: 'verified', reviewState: 'approved', status: 'active',
      reviewReason: '', evidence: [], usedCount: 0, helpfulCount: 0, unhelpfulCount: 0, updatedAt: '2026-10-01T00:00:00Z',
      title: '配信の止め方', question: '止めたい', answer: '一時停止を押す', kind: 'usage', keywords: [],
    } as unknown as OpsKnowledgeArticle
    await act(async () => { root.render(<KnowledgeArticleV8 article={article} onClose={() => {}} onSaved={() => {}} />) })
    const title = document.querySelector('#ka-title') as HTMLInputElement
    fireEvent.change(title, { target: { value: '' } })
    await act(async () => { (buttons('承認待ちで保存する')[0] as HTMLButtonElement).click() })
    await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
    expect(title.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#ka-title-error')?.textContent).toBe('題名を入力してください')
    expect(document.activeElement).toBe(title)
    expect(calls.some((c) => c.method !== 'GET' && c.url.includes('/knowledge'))).toBe(false)
  })
})


describe('承認の前に元の問い合わせを読み合わせる', () => {
  const article = {
    id: 'k-source', version: 1, sourceRequestId: 'request-source', ticketNo: 1045, sourceCurrent: true,
    articleKind: 'answer_example', reviewState: 'pending', status: 'draft', reviewReason: '', evidence: [],
    usedCount: 0, helpfulCount: 0, unhelpfulCount: 0, updatedAt: '2026-10-01T00:00:00Z',
    title: '返答の例', question: '配信を止めたい', answer: '一時停止を押します', kind: 'usage', keywords: [],
  } as unknown as OpsKnowledgeArticle
  const source = (stage: 'resolved' | 'in_progress') => ({ success: true, data: { ticket: {
    id: 'request-source', ticketLabel: '#1045', stage, stageLabel: stage === 'resolved' ? '解決' : '対応中',
  } } }) as unknown as Awaited<ReturnType<typeof api.ops.support.ticket>>
  const openApproval = async () => {
    await act(async () => { root.render(<KnowledgeArticleV8 article={article} onClose={() => {}} onSaved={() => {}} />) })
    await act(async () => { (buttons('保存して承認')[0] as HTMLButtonElement).click() })
    await settle()
    const dialog = document.querySelector('[data-design-node="eSXxA"]')!
    fireEvent.click(dialog.querySelector('input[type="checkbox"]')!)
    await settle()
    return { dialog, approve: ([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存して承認') ?? querySupplementaryPageAction('保存して承認'))! }
  }
  it.each(['resolved', 'in_progress'] as const)('%s は取得した状態を示し、未解決なら承認を止める', async stage => {
    const fetchTicket = vi.spyOn(api.ops.support, 'ticket').mockResolvedValue(source(stage))
    try {
      const { dialog, approve } = await openApproval()
      expect(fetchTicket).toHaveBeenCalledWith('request-source')
      expect(dialog.textContent).toContain('元の問い合わせ #1045 が「解決」になっている')
      const facts = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      expect(facts[1].checked).toBe(stage === 'resolved')
      expect(approve.disabled).toBe(stage !== 'resolved')
      if (stage !== 'resolved') expect(dialog.textContent).toContain('まだ「対応中」です')
      expect(calls.some(call => call.method !== 'GET')).toBe(false)
    } finally { fetchTicket.mockRestore() }
  })
  it('状態が読めない間は承認せず、読み直しで実際の解決状態を出す', async () => {
    const fetchTicket = vi.spyOn(api.ops.support, 'ticket').mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(source('resolved'))
    try {
      const { dialog, approve } = await openApproval()
      expect(approve.disabled).toBe(true)
      expect(dialog.textContent).toContain('状態を確認できませんでした')
      await act(async () => { (buttons('もう一度読み込む')[0] as HTMLButtonElement).click() })
      await settle()
      expect(approve.disabled).toBe(false)
      expect(fetchTicket).toHaveBeenCalledTimes(2)
      expect(calls.some(call => call.method !== 'GET')).toBe(false)
    } finally { fetchTicket.mockRestore() }
  })
})
