import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import React from 'react'
import { Storage } from 'happy-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewAutomationV8 } from '@/v8/automations/create/create'
import { pickAutomationTag, pickAutomationTestFriend, replaceFirstAutomationAction, openFirstAutomationAction } from '@/test-utils/automation-v8-interactions'
import { usePageTitle } from '@/components/shell/page-chrome'
import { requestUnsavedAction } from '@/lib/unsaved-action'

const account = vi.hoisted(() => ({ id: 'account-a' }))
const notices = vi.hoisted(() => vi.fn())
vi.mock('@/components/shared/toast', () => ({ notifyToast: notices, notifySaved: notices }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: account.id }) }))
vi.mock('@/components/automations/use-common-action-permission', () => ({ useCanManageCommonActions: () => true }))

const WORKER_SRC = resolve(process.cwd(), '../worker/src') + '/'
const requireFromWorker = createRequire(resolve(process.cwd(), '../worker/package.json'))
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL!
const webOrigin = 'http://localhost:3000'
const ACCOUNT_A = 'account-a', ACCOUNT_B = 'account-b'
const FRIEND_A = 'friend-account-a', FRIEND_B = 'friend-account-b'
const DRAFT_STORAGE_KEY = 'lh-automation-new-draft-v1'
type StoredDraft = { id: string; draftVersionId: string }
type StoredDrafts = Record<string, StoredDraft>
interface ApiCall { method: string; pathname: string; search: string; body: unknown }
interface MockApi { calls: ApiCall[]; createCalls: ApiCall[]; updateCalls: ApiCall[]; testCalls: ApiCall[]; releaseCreate: () => void; releaseTest: () => void }
interface Route {
  request: () => { url: () => string; method: () => string; postDataJSON: () => unknown; postData: () => string | null }
  fulfill: (data: { status: number; headers?: Record<string, string>; contentType?: string; body?: string }) => Promise<void>
}
class FetchRoutes {
  handlers: Array<{ pattern: string; handler: (route: Route) => Promise<unknown> }> = []
  async route(pattern: string, handler: (route: Route) => Promise<unknown>) { this.handlers.push({ pattern, handler }) }
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET', body = init?.body == null ? null : String(init.body)
    const handler = this.handlers.findLast(item => url.startsWith(item.pattern.split('*')[0]))
    if (!handler) throw new Error(`Unstubbed request: ${method} ${url}`)
    let response: Response | undefined
    await handler.handler({
      request: () => ({ url: () => url, method: () => method, postDataJSON: () => JSON.parse(body ?? 'null'), postData: () => body }),
      fulfill: async data => { response = new Response(data.body ?? null, { status: data.status, headers: { ...data.headers, ...(data.contentType ? { 'Content-Type': data.contentType } : {}) } }) },
    })
    if (!response) throw new Error(`No response: ${method} ${url}`)
    return response
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': webOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, X-Admin-Session',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  }
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: corsHeaders(),
    body: JSON.stringify(body),
  })
}

/** この画面の合否に関係しない、共通の下ごしらえ（在席・店の一覧・機能表）。 */
async function serveSharedStubs(route: Route, pathname: string): Promise<boolean> {
  if (pathname === '/api/staff/me') {
    await json(route, { success: true, data: { name: '試験担当', role: 'owner', permissionKeys: [], accountScope: 'all' } })
    return true
  }
  if (pathname === '/api/friends') {
    const accountId = new URL(route.request().url()).searchParams.get('lineAccountId')
    const ids = accountId === ACCOUNT_B ? [FRIEND_B] : [FRIEND_A, 'friend-a', 'friend-001']
    await json(route, { success: true, data: { items: ids.map((id) => ({ id, displayName: `試験-${id}` })), total: ids.length } })
    return true
  }
  if (pathname === '/api/auth/session') {
    await json(route, { success: true, data: { name: '試験担当', role: 'owner', permissionKeys: [] }, csrfToken: 'csrf-test' })
    return true
  }
  if (pathname === '/api/line-accounts') {
    await json(route, {
      success: true,
      data: [
        { id: ACCOUNT_A, channelId: 'channel-a', name: '店舗A', isActive: true, country: 'JP', role: 'shop', displayOrder: 1 },
        { id: ACCOUNT_B, channelId: 'channel-b', name: '店舗B', isActive: true, country: 'JP', role: 'shop', displayOrder: 2 },
      ],
    })
    return true
  }
  if (pathname === '/api/settings/features') {
    await json(route, {
      success: true,
      data: { features: {}, sidebarOrder: null, sidebarItemOrder: null, parentChildMode: false, specializedFeatureKeys: [], version: 1 },
    })
    return true
  }
  return false
}

async function answerPreflight(route: Route): Promise<void> {
  await route.fulfill({ status: 204, headers: corsHeaders() })
}

// ========== 手元の応答表 ==========

type MockDraft = {
  id: string
  draftVersionId: string
  name: string
  description: string | null
  eventType: string
  triggerConfig: Record<string, unknown>
  conditions: Record<string, unknown>
  actions: Array<{ id: string; type: string; params: Record<string, unknown>; onFailure: 'stop' }>
}

async function attachApiMock(page: FetchRoutes, options: { slowCreate?: boolean; slowTest?: boolean; knownDrafts?: MockDraft[] } = {}): Promise<MockApi> {
  let createNumber = 0
  let revisionNumber = 0
  let releaseCreate = () => {}
  let releaseTest = () => {}
  const createBarrier = new Promise<void>((resolve) => { releaseCreate = resolve })
  const testBarrier = new Promise<void>((resolve) => { releaseTest = resolve })
  const state: MockApi = { calls: [], createCalls: [], updateCalls: [], testCalls: [], releaseCreate, releaseTest }
  // 店ごとの保存済みの内容と版を持つ。
  const drafts = new Map<string, MockDraft>()
  // 「前に保存した下書き」として控えに載っているものを、サーバー側にも用意する。
  for (const known of options.knownDrafts ?? []) drafts.set(known.id, known)

  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') {
      await answerPreflight(route)
      return
    }

    let body: unknown = null
    try { body = request.postDataJSON() } catch { /* GETなど本文なし */ }
    const call = { method: request.method(), pathname: url.pathname, search: url.search, body }
    state.calls.push(call)

    if (await serveSharedStubs(route, url.pathname)) return

    // V8の共通タグ選択は、窓を開いたときに店のタグとフォルダを読み直す。
    if (url.pathname === '/api/tags') {
      await json(route, { success: true, data: [{ id: 'tag-vip', name: 'VIP', lineAccountId: url.searchParams.get('accountId') ?? ACCOUNT_A, groupId: null }] })
      return
    }
    if (url.pathname === '/api/tag-groups') {
      await json(route, { success: true, data: [] })
      return
    }
    if (url.pathname === '/api/automation-draft-resources') {
      await json(route, { success: true, data: { tags: [{ id: 'tag-vip', name: 'VIP' }], scenarios: [] } })
      return
    }
    if (url.pathname === '/api/automations' && request.method() === 'GET') {
      await json(route, { success: true, data: [], summary: { active: 0, stopped: 0, executionCount30d: 0, failureCount30d: 0 } })
      return
    }
    if (/^\/api\/automation-templates\/[^/]+\/drafts$/.test(url.pathname)) {
      state.createCalls.push(call)
      createNumber += 1
      if (options.slowCreate) await createBarrier
      const accountId = url.searchParams.get('account_id')
      const draft: MockDraft = {
        id: `draft-${accountId}-${createNumber}`,
        draftVersionId: `version-${accountId}-${createNumber}`,
        name: '問い合わせを見分ける',
        description: null,
        eventType: 'message_received',
        triggerConfig: {},
        conditions: {},
        actions: [{ id: 'step-1', type: 'add_tag', params: { tagId: '' }, onFailure: 'stop' }],
      }
      drafts.set(draft.id, draft)
      await json(route, { success: true, data: { id: draft.id, draftVersionId: draft.draftVersionId } })
      return
    }
    const draftMatch = /^\/api\/automation-drafts\/([^/]+)$/.exec(url.pathname)
    if (draftMatch && request.method() === 'PUT') {
      state.updateCalls.push(call)
      // 画面に控えだけ残っている下書きも、サーバー側には在るものとして扱う。
      const draft = drafts.get(draftMatch[1]) ?? {
        id: draftMatch[1],
        draftVersionId: `${draftMatch[1]}-v0`,
        name: '', description: null, eventType: 'message_received',
        triggerConfig: {}, conditions: {}, actions: [],
      }
      drafts.set(draft.id, draft)
      const patch = body as Partial<MockDraft>
      revisionNumber += 1
      // 本物の Worker と同じく、**中身が変われば版の札も変わる**。
      Object.assign(draft, {
        draftVersionId: `${draft.id}-r${revisionNumber}`,
        name: patch.name ?? draft.name,
        eventType: patch.eventType ?? draft.eventType,
        triggerConfig: patch.triggerConfig ?? draft.triggerConfig,
        conditions: patch.conditions ?? draft.conditions,
        actions: patch.actions ?? draft.actions,
      })
      await json(route, { success: true, data: { updated: true, draftVersionId: draft.draftVersionId } })
      return
    }
    if (draftMatch && request.method() === 'GET') {
      const draft = drafts.get(draftMatch[1])
      if (!draft) {
        await json(route, { success: false, error: '編集中の下書きが見つかりません' }, 404)
        return
      }
      await json(route, { success: true, data: draft })
      return
    }
    if (/^\/api\/automations\/[^/]+\/audience-preview$/.test(url.pathname)) {
      await json(route, { success: true, data: { automationId: 'draft', versionId: 'version', matched: 3, total: 10, freshness: 'available', calculatedAt: '2026-09-09T00:00:00.000Z' } })
      return
    }
    if (/^\/api\/automations\/[^/]+\/test$/.test(url.pathname)) {
      state.testCalls.push(call)
      if (options.slowTest) await testBarrier
      await json(route, { success: true, data: { runId: 'run-1', versionId: 'version', status: 'queued' } })
      return
    }

    // サイドバーなど、この画面の合否に関係しない共通取得。
    await json(route, { success: true, data: {} })
  })
  return state
}

/** 札（`<版の行のid>.<中身の指紋>`）から、DBの行のidだけを取り出す。 */
function versionRowId(revision: string): string {
  const separator = revision.lastIndexOf('.')
  return separator <= 0 ? revision : revision.slice(0, separator)
}

// ========== 本物の Worker ==========

/**
 * 本物の Worker を載せるのに要る形だけを書き出したもの。
 *
 * `apps/worker` の型は `apps/web` から読めない（別の依存の束）ので、
 * ここで使う口だけを最小限で写す。実体は `apps/worker` のものをそのまま動かす。
 */
interface WorkerContext {
  env: { DB: unknown }
  set: (key: string, value: unknown) => void
}

interface HonoLike {
  use: (path: string, handler: (c: WorkerContext, next: () => Promise<void>) => Promise<void>) => void
  route: (path: string, app: unknown) => void
  request: (input: string, init?: { method?: string; body?: string }) => Promise<Response>
}

interface SqliteStatement {
  run: (...args: unknown[]) => unknown
  get: (...args: unknown[]) => unknown
}

interface SqliteRaw {
  close: () => void
  prepare: (sql: string) => SqliteStatement
}

interface WorkerHarness {
  /** `apps/worker` の automations ルートへそのまま投げる。 */
  request: (path: string, init?: { method?: string; body?: string }) => Promise<Response>
  /** SQLite を直接読む（画面を通さずに、いまDBに何があるかを確かめる）。 */
  raw: SqliteRaw
  calls: ApiCall[]
  testCalls: ApiCall[]
  releaseTest: () => void
}

/**
 * 本物の automations ルートを SQLite の D1 に載せる。
 *
 * `apps/worker` は変更していない。`packages/db/bootstrap.sql` を流した
 * その場限りのDBに、実物の Hono ルートをそのまま繋ぐだけ。
 */
const databases = new Set<SqliteRaw>()

async function startWorker(options: { slowTest?: boolean } = {}): Promise<WorkerHarness> {
  const { Hono } = await import(pathToFileURL(requireFromWorker.resolve('hono')).href) as { Hono: new () => HonoLike }
  const { automations } = await import(/* @vite-ignore */ `${WORKER_SRC}routes/automations.ts`) as { automations: unknown }
  const { createTestD1, insertFriend } = await import(/* @vite-ignore */ `${WORKER_SRC}test-utils/d1-sqlite.ts`) as {
    createTestD1: () => { db: unknown; raw: SqliteRaw }
    insertFriend: (raw: unknown, id: string, overrides?: Record<string, unknown>) => void
  }

  const testDb = createTestD1()
  const raw = testDb.raw
  databases.add(raw)
  raw.prepare("INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')").run()
  // tags.name は全体で一意なので、店ごとに違う名前にする。
  for (const [id, channel, name, friendId, tagName] of [
    [ACCOUNT_A, 'channel-a', '店舗A', FRIEND_A, 'VIP（店舗A）'],
    [ACCOUNT_B, 'channel-b', '店舗B', FRIEND_B, 'VIP（店舗B）'],
  ]) {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES (?, ?, ?, '', '', 1, 'tenant-1')`,
    ).run(id, channel, name)
    raw.prepare('INSERT INTO tags (id, line_account_id, name) VALUES (?, ?, ?)').run(`tag-vip-${id}`, id, tagName)
    insertFriend(raw, friendId, { line_account_id: id })
  }

  const app = new Hono()
  app.use('*', async (c: WorkerContext, next: () => Promise<void>) => {
    c.env = { DB: testDb.db }
    c.set('staff', {
      id: 'admin-1', name: '管理者', role: 'admin', readOnly: false, tenantId: 'tenant-1', permissionKeys: [],
    })
    await next()
  })
  app.route('/', automations)

  let releaseTest = () => {}
  const testBarrier = new Promise<void>((resolve) => { releaseTest = resolve })
  const harness: WorkerHarness = {
    request: (path, init) => app.request(`http://worker.test${path}`, init),
    raw,
    calls: [],
    testCalls: [],
    releaseTest,
  }
  ;(harness as { slowTest?: boolean }).slowTest = options.slowTest
  ;(harness as { testBarrier?: Promise<void> }).testBarrier = testBarrier
  return harness
}

/** いま下書きに入っている本当の中身を、画面を通さずDBから読む。 */
function draftInDb(harness: WorkerHarness, id: string): { versionId: string; actions: unknown } {
  const row = harness.raw.prepare(
    `SELECT d.current_draft_version_id AS version_id, v.action_config AS actions
       FROM automation_definitions d
       JOIN automation_versions v ON v.id = d.current_draft_version_id
      WHERE d.id = ?`,
  ).get(id) as { version_id: string; actions: string }
  return { versionId: row.version_id, actions: JSON.parse(row.actions) }
}

/** 実行記録の行数。送った跡が残っていないかを見る。 */
function runCounts(harness: WorkerHarness): { runs: number; steps: number } {
  const runs = harness.raw.prepare('SELECT COUNT(*) AS count FROM automation_runs').get() as { count: number }
  const steps = harness.raw.prepare('SELECT COUNT(*) AS count FROM automation_run_steps').get() as { count: number }
  return { runs: runs.count, steps: steps.count }
}

async function attachWorkerApi(
  page: FetchRoutes,
  harness: WorkerHarness,
  options: { beforeTest?: () => void } = {},
): Promise<void> {
  const slowTest = (harness as { slowTest?: boolean }).slowTest
  const testBarrier = (harness as { testBarrier?: Promise<void> }).testBarrier
  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') {
      await answerPreflight(route)
      return
    }
    let body: unknown = null
    try { body = request.postDataJSON() } catch { /* GETなど本文なし */ }
    const call = { method: request.method(), pathname: url.pathname, search: url.search, body }
    harness.calls.push(call)

    if (await serveSharedStubs(route, url.pathname)) return

    if (url.pathname.startsWith('/api/automation')) {
      if (/^\/api\/automations\/[^/]+\/test$/.test(url.pathname)) {
        harness.testCalls.push(call)
        // 画面の突き合わせが済んだあと、Worker が受け取る前に割り込む。
        options.beforeTest?.()
        if (slowTest) await testBarrier
      }
      const response = await harness.request(`${url.pathname}${url.search}`, {
        method: request.method(),
        body: request.method() === 'GET' ? undefined : (request.postData() ?? '{}'),
      })
      await route.fulfill({
        status: response.status,
        headers: { ...corsHeaders(), 'content-type': 'application/json' },
        body: await response.text(),
      })
      return
    }

    await json(route, { success: true, data: {} })
  })
}


beforeEach(() => {
  account.id = ACCOUNT_A
  vi.stubGlobal('localStorage', new Storage())
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/automations/new')
  document.documentElement.dataset.theme = 'v8'
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('sessionStorage', window.sessionStorage)
  vi.stubGlobal('localStorage', window.localStorage)
  window.localStorage.setItem('lh_selected_account', ACCOUNT_A)
  notices.mockReset()
})
afterEach(() => { cleanup(); for (const raw of databases) raw.close(); databases.clear(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme })

function startView() { return render(<NewAutomationV8 chrome="create" />) }
async function openPage(options: Parameters<typeof attachApiMock>[1] = {}) {
  const transport = new FetchRoutes()
  const api = await attachApiMock(transport, options)
  vi.stubGlobal('fetch', transport.fetch.bind(transport))
  const view = startView()
  await waitFor(() => expect(getPageAction({ name: '下書きを保存', exact: true }).hasAttribute('disabled')).toBe(false))
  return { api, view, transport }
}
async function openWorkerPage(options: { slowTest?: boolean; beforeTest?: (worker: WorkerHarness) => void } = {}) {
  const worker = await startWorker(options)
  const transport = new FetchRoutes()
  await attachWorkerApi(transport, worker, { beforeTest: () => options.beforeTest?.(worker) })
  vi.stubGlobal('fetch', transport.fetch.bind(transport))
  const view = startView()
  await waitFor(() => expect(getPageAction({ name: '下書きを保存', exact: true }).hasAttribute('disabled')).toBe(false))
  return { worker, view }
}
function nameInput() { return screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement }
async function fillTagRule(name: string, tag = 'VIP') {
  fireEvent.change(nameInput(), { target: { value: name } })
  await pickAutomationTag(tag)
}
async function fillMessageRule(name: string, message: string) {
  fireEvent.change(nameInput(), { target: { value: name } })
  if (!document.querySelector('[data-action-row]')?.textContent?.includes('メッセージを送る')) await replaceFirstAutomationAction('メッセージを送る')
  if (!screen.queryByRole('textbox', { name: '送る文面' })) await openFirstAutomationAction()
  fireEvent.change(screen.getByRole('textbox', { name: '送る文面' }), { target: { value: message } })
}
async function saveDraft() {
  const before = notices.mock.calls.length
  fireEvent.click(getPageAction({ name: '下書きを保存', exact: true }))
  await waitFor(() => expect(notices.mock.calls.slice(before).some(args => String(args[0]).includes('下書きに保存しました'))).toBe(true))
}
function storedDraftsOf(): StoredDrafts { return JSON.parse(sessionStorage.getItem(DRAFT_STORAGE_KEY) ?? '{}') }
async function switchAccount(view: ReturnType<typeof render>, id: string) {
  await act(async () => requestUnsavedAction(() => { account.id = id; window.localStorage.setItem('lh_selected_account', id) }))
  view.rerender(<NewAutomationV8 chrome="create" />)
  await act(async () => { await Promise.resolve() })
}
async function openTestConfirmation(friendId: string) {
  await pickAutomationTestFriend(friendId)
  fireEvent.click(screen.getByRole('button', { name: '1人で試す', exact: true }))
  return screen.findByRole('dialog', { name: '1人テストの確認' })
}
async function sentNotice() {
  await waitFor(() => expect(notices).toHaveBeenCalledWith(expect.stringContaining('1人テストを受け付けました')))
}

describe('M4torYの保存・送信の誤操作防止（DOMと実API境界）', () => {
  it('保存の422を名前の下へ出し、焦点と入力を保ち、直した欄だけ消す', async () => {
    const { transport } = await openPage()
    expect(screen.getByRole('heading', { name: 'オートメーションを作る' })).toBeTruthy()
    expect(usePageTitle).toHaveBeenCalledWith('オートメーションを作る')
    await fillTagRule('入力を残すルール')
    await transport.route(`${API_ORIGIN}/api/automation-drafts/`, async route => {
      await json(route, { success: false, error: '入力を確認してください', fields: { name: 'この名前は使われています' } }, 422)
    })
    fireEvent.click(getPageAction({ name: '下書きを保存', exact: true }))
    const reason = await screen.findByText('この名前は使われています', { exact: true })
    await waitFor(() => expect(document.activeElement).toBe(nameInput()))
    expect(nameInput().value).toBe('入力を残すルール')
    expect(nameInput().getAttribute('aria-invalid')).toBe('true')
    expect(nameInput().getAttribute('aria-describedby')).toContain(reason.id)
    expect(screen.queryByText('入力を確認してください', { exact: true })).toBeNull()
    fireEvent.change(nameInput(), { target: { value: '直した名前' } })
    await waitFor(() => expect(screen.queryByText('この名前は使われています')).toBeNull())
    expect(nameInput().getAttribute('aria-invalid')).not.toBe('true')
  })
  it('遅い保存の連打は1件、再読込と戻った画面でも同じ下書きを更新する', async () => {
    const { api, view: initialView } = await openPage({ slowCreate: true })
    let view = initialView
    await fillTagRule('来店後フォロー')
    const save = getPageAction({ name: '下書きを保存', exact: true }) as HTMLButtonElement
    await act(async () => { save.click(); save.click() })
    await waitFor(() => expect(api.createCalls).toHaveLength(1))
    expect((getPageAction({ name: '作成中…', exact: true }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => api.releaseCreate())
    await waitFor(() => expect(api.updateCalls).toHaveLength(1))
    await waitFor(() => expect(storedDraftsOf()[ACCOUNT_A]?.id).toBe('draft-account-a-1'))
    for (const name of ['再読込後の更新', '戻った後の更新']) {
      view.unmount()
      view = startView()
      await waitFor(() => expect(nameInput().value).not.toBe(''))
      await fillTagRule(name); await saveDraft()
    }
    expect(api.createCalls).toHaveLength(1); expect(api.updateCalls).toHaveLength(3)
    expect(api.updateCalls.every(call => call.pathname === '/api/automation-drafts/draft-account-a-1')).toBe(true)
  })
  it('一覧からの再入場は別の操作鍵と下書きを使う（DETAIL-13）', async () => {
    const { api, view } = await openPage()
    await fillTagRule('最初のルール'); await saveDraft()
    view.unmount(); window.history.replaceState(null, '', '/automations/new'); startView()
    await fillTagRule('二つ目のルール'); await saveDraft()
    expect(api.createCalls).toHaveLength(2)
    const keys = api.createCalls.map(call => (call.body as { operationKey: string }).operationKey)
    expect(keys.every(key => /^[A-Za-z0-9._-]{8,128}$/.test(key))).toBe(true)
    expect(keys[0]).not.toBe(keys[1])
    expect(api.updateCalls.at(-1)?.pathname).toBe('/api/automation-drafts/draft-account-a-2')
  })
  it('遅延保存中は店舗切替を止め、往復後も各店の下書きを保つ', async () => {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ [ACCOUNT_A]: { id: 'existing-a', draftVersionId: 'existing-version-a' } }))
    const { api, view } = await openPage({ slowCreate: true, knownDrafts: [{
      id: 'existing-a', draftVersionId: 'existing-version-a', name: '既存Aの下書き',
      description: null, eventType: 'message_received', triggerConfig: {}, conditions: {},
      actions: [{ id: 'step-1', type: 'add_tag', params: { tagId: 'tag-vip' }, onFailure: 'stop' }],
    }] })
    expect(nameInput().value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: '保存した下書きを開く' }))
    await waitFor(() => expect(nameInput().value).toBe('既存Aの下書き'))
    await switchAccount(view, ACCOUNT_B)
    await fillTagRule('新規B'); fireEvent.click(getPageAction({ name: '下書きを保存', exact: true }))
    await waitFor(() => expect(api.createCalls).toHaveLength(1))
    await switchAccount(view, ACCOUNT_A); expect(account.id).toBe(ACCOUNT_B)
    await act(async () => api.releaseCreate()); await waitFor(() => expect(api.updateCalls).toHaveLength(1))
    await waitFor(() => expect((getPageAction({ name: '下書きを保存', exact: true }) as HTMLButtonElement).disabled).toBe(false))
    for (const id of [ACCOUNT_A, ACCOUNT_B]) {
      await switchAccount(view, id); await fillTagRule(`更新${id}`); await saveDraft()
      expect(api.updateCalls.at(-1)?.pathname).toBe(`/api/automation-drafts/${id === ACCOUNT_A ? 'existing-a' : 'draft-account-b-1'}`)
    }
    expect(api.createCalls).toHaveLength(1)
  })
  it('1人テストは保存済みの文面・送り先・副作用を確認して1回だけ送る', async () => {
    const { api } = await openPage({ slowTest: true })
    await fillMessageRule('予約返信', '保存済みの文面'); await saveDraft()
    await fillMessageRule('予約返信', 'まだ保存していない文面')
    const dialog = await openTestConfirmation('friend-001')
    expect(api.testCalls).toHaveLength(0)
    expect(dialog.textContent).toContain('保存済みの文面'); expect(dialog.textContent).not.toContain('まだ保存していない文面')
    expect(dialog.textContent).toContain('送り先：friend-001')
    expect(dialog.textContent).toContain('メッセージが相手に届きます'); expect(dialog.textContent).toContain('取り消せません')
    expect(dialog.textContent).toContain('画面の入力は、ここに出ている内容と違います。')
    const confirm = within(dialog).getByRole('button', { name: 'この内容で送る' }) as HTMLButtonElement
    await act(async () => { confirm.click(); confirm.click() })
    await waitFor(() => expect(api.testCalls).toHaveLength(1))
    expect(api.testCalls[0].body).toEqual({ versionId: storedDraftsOf()[ACCOUNT_A].draftVersionId, friendId: 'friend-001', operationKey: expect.stringMatching(/^[A-Za-z0-9._-]{8,128}$/) })
    await act(async () => api.releaseTest()); await sentNotice(); expect(api.testCalls).toHaveLength(1)
  })
  it('タグきっかけで付いたとき・外れたときを選んで保存できる', async () => {
    const { api } = await openPage()
    fireEvent.click(screen.getByRole('radio', { name: /タグが付いた・外れたとき/ }))
    fireEvent.click(screen.getByLabelText('付いたとき・外れたとき'))
    const list = await screen.findByRole('listbox')
    expect(within(list).getAllByRole('option').map(el => el.textContent)).toEqual(['付いたとき', '外れたとき'])
    fireEvent.click(within(list).getByRole('button', { name: '外れたとき' }))
    fireEvent.click(screen.getByRole('button', { name: /きっかけのタグ：(選択する|変更する)/ }))
    const picker = await screen.findByRole('dialog', { name: 'タグを選ぶ' })
    fireEvent.click(within(picker).getByRole('checkbox', { name: 'VIP', exact: true }))
    fireEvent.click(within(picker).getByRole('button', { name: '選択する（1件）' }))
    await fillTagRule('タグが外れたときのルール'); await saveDraft()
    expect(api.updateCalls.at(-1)?.body).toMatchObject({ eventType: 'tag_change', triggerConfig: { tagId: 'tag-vip', action: 'remove' } })
  })
})

describe('M4torYの描画を本物のWorker/D1へつなぐ送信安全性', () => {
  it('別接続が保存したら古い確認では送らず、再確認後に最新の版だけ送る', async () => {
    const { worker } = await openWorkerPage()
    await fillMessageRule('予約返信', '最初の文面です。'); await saveDraft()
    const draft = storedDraftsOf()[ACCOUNT_A]
    const dialog = await openTestConfirmation(FRIEND_A)
    const response = await worker.request(`/api/automation-drafts/${draft.id}?account_id=${ACCOUNT_A}`, { method: 'PUT', body: JSON.stringify({ name: '予約返信', eventType: 'message_received', triggerConfig: {}, conditions: {}, actions: [{ id: 'step-1', type: 'send_message', params: { messageType: 'text', content: '別接続の文面です。' }, onFailure: 'stop' }], expectedDraftVersionId: draft.draftVersionId }) })
    expect(response.status).toBe(200)
    const changed = draftInDb(worker, draft.id); expect(changed.versionId).not.toBe(versionRowId(draft.draftVersionId))
    fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で送る' }))
    await screen.findByText(/確認したあとに下書きが変わりました/)
    expect(worker.testCalls).toHaveLength(0)
    const retry = await openTestConfirmation(FRIEND_A)
    expect(retry.textContent).toContain('別接続の文面です。')
    fireEvent.click(within(retry).getByRole('button', { name: 'この内容で送る' })); await sentNotice()
    expect(worker.testCalls).toHaveLength(1)
    expect(versionRowId((worker.testCalls[0].body as { versionId: string }).versionId)).toBe(changed.versionId)
  })
  it('画面の確認後に割り込まれてもWorkerの409で送信と記録を止める', async () => {
    let interrupted = false
    const { worker } = await openWorkerPage({ beforeTest: harness => {
      interrupted = true
      harness.raw.prepare(`UPDATE automation_versions SET action_config = ? WHERE id = (SELECT current_draft_version_id FROM automation_definitions WHERE line_account_id = ? AND status = 'draft')`).run(JSON.stringify([{ id: 'step-1', type: 'send_message', params: { messageType: 'text', content: '割り込みの文面' }, onFailure: 'stop' }]), ACCOUNT_A)
    } })
    await fillMessageRule('予約返信', '確認の文面'); await saveDraft()
    const dialog = await openTestConfirmation(FRIEND_A)
    fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で送る' }))
    await screen.findByText(/確認したあとに下書きが変わりました/)
    expect(interrupted).toBe(true)
    expect(JSON.stringify(draftInDb(worker, storedDraftsOf()[ACCOUNT_A].id).actions)).toContain('割り込みの文面')
    expect(worker.testCalls).toHaveLength(1); expect(runCounts(worker)).toEqual({ runs: 0, steps: 0 })
    expect(screen.queryByRole('dialog', { name: '1人テストの確認' })).toBeNull()
  })
  it.each(['成功', '失敗'])('本物Workerの%s応答待ちで切替を止め、切替後に他店の成否を残さない', async outcome => {
    const { worker, view } = await openWorkerPage({ slowTest: true, beforeTest: harness => {
      if (outcome === '失敗') harness.raw.prepare('UPDATE friends SET line_account_id = ? WHERE id = ?').run(ACCOUNT_B, FRIEND_A)
    } })
    await fillMessageRule('予約返信', '店舗Aの文面'); await saveDraft()
    const dialog = await openTestConfirmation(FRIEND_A)
    fireEvent.click(within(dialog).getByRole('button', { name: 'この内容で送る' }))
    await waitFor(() => expect(worker.testCalls).toHaveLength(1))
    await switchAccount(view, ACCOUNT_B); expect(account.id).toBe(ACCOUNT_A)
    await act(async () => worker.releaseTest())
    if (outcome === '成功') await sentNotice()
    else await screen.findByText(/対象が見つかりませんでした。一覧から開き直してください/)
    // 応答の文が先に出ても、送信中の解除を待ってから切り替える。
    await waitFor(() => expect((screen.getByRole('button', { name: '1人で試す', exact: true }) as HTMLButtonElement).disabled).toBe(false))
    await switchAccount(view, ACCOUNT_B)
    expect(account.id).toBe(ACCOUNT_B)
    expect(screen.queryByRole('dialog', { name: '1人テストの確認' })).toBeNull()
    expect(screen.queryByText(/テストする友だちが見つかりません/)).toBeNull()
    expect((screen.getByRole('button', { name: '1人で試す', exact: true }) as HTMLButtonElement).disabled).toBe(true)
    await switchAccount(view, ACCOUNT_A)
    expect(screen.queryByText(/テストする友だちが見つかりません/)).toBeNull()
  })
})
