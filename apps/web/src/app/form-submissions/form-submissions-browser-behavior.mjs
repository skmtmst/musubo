/**
 * 回答フォーム一覧（#676 N-172 / N-173 / N-180 / N-181）の実ブラウザ検査。
 *
 * `next build` の書き出し（`apps/web/out`）をそのまま配って動かす。
 * **`networkidle` は待たない。** 管理画面は版の確認や通知の問い合わせを
 * 続けるので、通信が止まる瞬間が来ないことがある（開発サーバではHMRの
 * 接続も残る）。`domcontentloaded` で読み込みを終え、そのあとは
 * **画面が自分で出す印**（一覧の状態と行）を見て待つ。
 *
 * 走らせ方: `pnpm --filter web build` のあとに
 * `node apps/web/src/app/form-submissions/form-submissions-browser-behavior.mjs`
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from '@playwright/test'
import { waitForOverlayLayout } from '../../../../../scripts/browser/overlay-ready.mjs'

/*
 * #1060: 一覧の絞り込み・並び替えは Worker が済ませて1ページ分だけ返す。
 * この検査は実ブラウザに本物と同じ応答を返す必要があるため、APIスタブにも
 * 同じ規則が要る。規則の正本は `packages/shared/src/form-list-summary.ts`
 * （@line-crm/shared）。素の node からは同パッケージの dist が解決できない
 * （拡張子なしimportのため）ので、ここに同じ規則を写している。
 * 正本を変えたらここも同じPRで直すこと。
 */
const displayFormName = (name) => name.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
const compareDatesNewest = (a, b) => (a && b ? new Date(b) - new Date(a) : a ? -1 : b ? 1 : 0)
const answerCount = (f) => f.submitCount ?? f.usedByAccounts.reduce((s, a) => s + a.count, 0)
const inputBlocks = (layout) => [
  ...(layout?.header ?? []),
  ...(layout?.sections ?? []).flatMap((s) => s.blocks ?? []),
].filter((b) => b.kind === 'input')
const collectActionDestinations = (actions, fields, tags) => {
  for (const action of actions ?? []) {
    if (action.kind === 'friend_field' && action.fieldId) fields.add(action.fieldId)
    if (action.kind === 'tag') for (const tagId of action.tagIds) { if (tagId) tags.add(tagId) }
  }
}
const hasStoredDestination = (layout, onSubmitTagId) => {
  const fields = new Set()
  const tags = new Set()
  for (const block of inputBlocks(layout)) {
    for (const id of block.destinations?.friendFieldIds ?? []) { if (id) fields.add(id) }
    if (block.destinations?.realName) fields.add('friends.real_name')
    if (block.destinations?.displayName) fields.add('friends.display_name')
    if (block.destinations?.note) fields.add('friends.note')
    if (block.choiceMode === 'friendField' && block.choiceFriendFieldId) fields.add(block.choiceFriendFieldId)
    for (const choice of block.choices ?? []) {
      if (block.choiceMode === 'tag' && choice.tagId) tags.add(choice.tagId)
      if (block.choiceMode === 'action') collectActionDestinations(choice.actions, fields, tags)
    }
  }
  collectActionDestinations(layout?.options?.afterActions, fields, tags)
  if (onSubmitTagId) tags.add(onSubmitTagId)
  return fields.size + tags.size > 0
}
const formMatchesListFilter = (f, filter) => {
  if (filter === 'published') return f.isActive
  if (filter === 'draft') return !f.isActive
  if (filter === 'stored') return hasStoredDestination(f.layout, f.onSubmitTagId)
  if (filter === 'pending') return (f.pendingPostActionCount ?? 0) > 0
  return true
}
const formMatchesListQuery = (f, raw) => {
  const q = raw.trim().toLocaleLowerCase('ja-JP')
  if (!q) return true
  return displayFormName(f.name).toLocaleLowerCase('ja-JP').includes(q)
    || f.fields.some((field) => String(field.label ?? '').toLocaleLowerCase('ja-JP').includes(q))
    || f.usedByAccounts.some((a) => a.name.toLocaleLowerCase('ja-JP').includes(q))
}
const sortFormListItems = (forms, sort) => {
  if (sort === 'latest-answer') {
    return [...forms].sort((a, b) => {
      if (a.lastSubmittedAt && b.lastSubmittedAt) {
        const diff = new Date(b.lastSubmittedAt) - new Date(a.lastSubmittedAt)
        if (diff !== 0) return diff
      } else if (a.lastSubmittedAt) return -1
      else if (b.lastSubmittedAt) return 1
      return new Date(b.createdAt) - new Date(a.createdAt)
    })
  }
  return [...forms].sort((a, b) => {
    if (sort === 'answers') {
      const diff = answerCount(b) - answerCount(a)
      if (diff !== 0) return diff
      return compareDatesNewest(a.updatedAt, b.updatedAt) || a.id.localeCompare(b.id)
    }
    if (sort === 'updated') {
      return compareDatesNewest(a.updatedAt, b.updatedAt) || a.id.localeCompare(b.id)
    }
    return displayFormName(a.name).localeCompare(displayFormName(b.name), 'ja-JP') || a.id.localeCompare(b.id)
  })
}

let lastHarness


const outDir = join(process.cwd(), 'apps/web/out')

if (!existsSync(outDir)) {
  throw new Error(`${outDir} がありません。先に pnpm --filter web build を実行してください。`)
}

function contentType(path) {
  return ({
    '.css': 'text/css',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
  })[extname(path)] ?? 'application/octet-stream'
}

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  const relative = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\//, '')
  const plain = join(outDir, relative || 'index.html')
  const candidates = extname(plain) ? [plain] : [`${plain}.html`, join(plain, 'index.html')]
  const file = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  if (!file) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  response.writeHead(200, { 'content-type': contentType(file) })
  createReadStream(file).pipe(response)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('テスト用サーバのポートを取得できません')
const baseUrl = `http://127.0.0.1:${address.port}`

const ACCOUNTS = [
  { id: 'account-a', channelId: 'channel-a', name: 'テスト店', isActive: true, country: 'JP', role: null, displayOrder: 0 },
  { id: 'account-b', channelId: 'channel-b', name: '本店', isActive: true, country: 'JP', role: null, displayOrder: 1 },
]

const LAYOUT = {
  version: 2,
  header: [],
  sections: [{ id: 'section-1', name: '質問', blocks: [] }],
  options: {
    thanksUrl: null,
    thanksText: 'ありがとうございました。',
    restorePrevious: false,
    pageTitle: null,
    submitLabel: '送信',
    prevLabel: '前へ',
    nextLabel: '次へ',
    sectionHeader: 'pageNumber',
    confirmDialog: { enabled: false },
    deadline: { enabled: false },
    oncePerFriend: { enabled: false },
    totalLimit: { enabled: false },
    afterActions: [],
  },
}

/**
 * 一覧が読む形は Worker の `serializeForm` に合わせる。
 *
 * `folderId` は入れられる。forms 表に列があり（migration 395）、
 * 一覧の API も返す。箱の絞りは `folder_id` で API 側が済ませる（R25）。
 */
function form(index, overrides = {}) {
  const day = String(Math.min(index, 28)).padStart(2, '0')
  return {
    id: `form-${index}`,
    name: `フォーム${String(index).padStart(2, '0')}`,
    description: `${index}番目のフォーム`,
    fields: [],
    layout: LAYOUT,
    onSubmitTagId: null,
    isActive: index % 2 === 0,
    status: 'active',
    revision: 1,
    submitCount: index,
    monthlySubmitCount: index,
    monthlyOpenCount: index + 1,
    monthlyCompletionRate: 50,
    pendingPostActionCount: 0,
    destinationSummary: { friendFieldCount: 0, tagCount: 0 },
    createdAt: `2025-01-${day}T00:00:00.000Z`,
    updatedAt: `2026-09-${day}T00:00:00.000Z`,
    lastSubmittedAt: `2026-08-${day}T00:00:00.000Z`,
    usedByAccounts: [],
    ...overrides,
  }
}

async function openHarness(browser, {
  role = 'admin', formsByAccount = {}, fail = false, listDelayMs = {},
  detail = null, putResults = [], tags = [], viewport = { width: 1440, height: 1000 },
} = {}) {
  const state = {
    listCalls: [], folderWrites: [], putBodies: [], publishBodies: [], fail,
    formFolders: [
      {
        id: 'fol-a', kind: 'form', accountId: 'account-a', name: 'A箱',
        parentId: null, displayOrder: 0, color: null,
        createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  }
  let savedDetail = detail
  const context = await browser.newContext({ viewport })
  await context.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'account-a')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('browser page error:', error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('browser console:', message.text())
  })

  await page.route('https://example.test/ogp.png', (route) => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  }))
  await page.route('**/admin/version', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: '0.24.0', worker_hash: 'test', admin_hash: 'test', liff_hash: 'test' }),
  }))
  await page.route('**/admin/manifest', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ latest: '0.24.0', releases: [] }),
  }))
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const json = (body, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })

    if (path === '/api/auth/session') {
      return json({ success: true, data: { id: 'staff-1', name: `${role}利用者`, role, permissionKeys: [] }, csrfToken: 'test-csrf' })
    }
    // V8 は保存値でなくこの口で役割を読む。既定の空配列では管理者も閲覧用になる。
    if (path === '/api/staff/me' && request.method() === 'GET') {
      return json({ success: true, data: { id: 'staff-1', name: `${role}利用者`, role, permissionKeys: [], permissionViewKeys: ['/form-submissions'] } })
    }
    if (path === '/api/line-accounts') return json({ success: true, data: ACCOUNTS })
    const entryAccount = /^\/api\/line-accounts\/([^/]+)\/follower-import$/.exec(path)
    if (request.method() === 'GET' && entryAccount && url.searchParams.get('entry') === '1') {
      return ACCOUNTS.some(account => account.id === decodeURIComponent(entryAccount[1]))
        ? json({ success: true, data: { destination: 'dashboard', canResume: false } })
        : json({ success: false, code: 'LINE_ACCOUNT_NOT_FOUND' }, 404)
    }
    if (path === '/api/dashboard/style') return json({ success: true, data: { style: 'standard', styleSelected: true } })
    if (path === '/api/tags') return json({ success: true, data: tags })
    // 左メニューは表示設定を読む。形が違うと画面全体が落ちるので、既定の形で返す。
    if (path === '/api/settings/features') {
      return json({
        success: true,
        data: { features: {}, sidebarOrder: null, sidebarItemOrder: null, parentChildMode: false, specializedFeatureKeys: [], version: 1 },
      })
    }
    /*
     * #723: 編集画面の版競合を見るための口。
     *
     * 詳細は `contentRevision` を返し、保存（PUT）は `putResults` の順に
     * 結果を返す。409 は実物と同じ形（`error` / `message` / `data`）で返す。
     */
    if (detail && path === `/api/forms/${detail.id}/delete-impact`) {
      return json({ success: true, data: {
        form: { id: detail.id, name: detail.name, isActive: true, status: 'active' },
        submissionCount: 3, openCount: 5, references: [], referenceCount: 0,
        answerUrl: null, revision: 9, contentRevision: detail.contentRevision,
        checkedAt: '2026-09-11T10:00:00.000+09:00',
        canDelete: false, canArchive: true, recommendedAction: 'archive',
        blockers: ['has_submissions'],
      } })
    }
    if (detail && path === `/api/forms/${detail.id}`) {
      if (request.method() === 'PUT') {
        const body = JSON.parse(request.postData() ?? '{}')
        state.putBodies.push(body)
        const next = putResults.shift() ?? 'ok'
        if (next === 'conflict') {
          return json({
            success: false,
            error: 'form_content_changed',
            message: 'ほかの人が先に保存しました。最新の内容を読み込んでから、もう一度お試しください。',
            data: { contentRevision: detail.contentRevision + 1, updatedAt: '2026-09-11T14:32:00.000+09:00' },
          }, 409)
        }
        if (next === 'failed') return json({ success: false, error: '保存できませんでした' }, 500)
        savedDetail = { ...savedDetail, ...body, contentRevision: savedDetail.contentRevision + 1 }
        return json({ success: true, data: savedDetail })
      }
      return json({ success: true, data: savedDetail })
    }
    if (path === '/api/forms') {
      if (state.fail) return json({ success: false, error: 'failed' }, 500)
      const accountId = url.searchParams.get('account_id')
      state.listCalls.push(accountId)
      const delay = listDelayMs[accountId ?? ''] ?? 0
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      const all = formsByAccount[accountId] ?? []
      /*
       * #1060: 本物のWorkerと同じく、絞り込み・並び替え・ページ切りを
       * ここ（API側）で済ませて返す。`limit` 未指定なら全件（互換）。
       */
      const rawFilter = url.searchParams.get('filter')
      const rawSort = url.searchParams.get('sort')
      const filter = ['published', 'draft', 'stored', 'pending'].includes(rawFilter) ? rawFilter : 'all'
      const sort = ['answers', 'updated', 'name'].includes(rawSort) ? rawSort : 'latest-answer'
      const search = url.searchParams.get('q') ?? ''
      let list = filter === 'all' ? all : all.filter((f) => formMatchesListFilter(f, filter))
      // R25: 本物の Worker と同じく、箱の絞りもここ（API 側）で済ませて返す。
      const folderParam = url.searchParams.get('folder_id') ?? 'all'
      if (folderParam === 'unfiled') list = list.filter((f) => (f.folderId ?? null) === null)
      else if (folderParam && folderParam !== 'all') list = list.filter((f) => f.folderId === folderParam)
      if (search.trim() !== '') list = list.filter((f) => formMatchesListQuery(f, search))
      list = sortFormListItems(list, sort)
      const total = list.length
      const limitParam = url.searchParams.get('limit')
      if (limitParam !== null && limitParam !== '') {
        const limit = Math.max(1, Math.min(200, Number.parseInt(limitParam, 10) || 20))
        const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
        const items = list.slice((page - 1) * limit, (page - 1) * limit + limit)
        return json({ success: true, data: { items, total, all_total: all.length, page, limit } })
      }
      return json({ success: true, data: { items: list, total, all_total: all.length, page: 1, limit: Math.max(list.length, 1) } })
    }
    /*
     * 編集画面は差し込み先の一覧も読む。`/api/scenarios` は
     * `{ items, total, limit, sort }` の封筒で返る口なので、素の配列で返すと
     * 画面側の読み替え（`data.items.map`）が落ちて読み込みごと失敗する。
     */
    if (path === '/api/scenarios') {
      return json({ success: true, data: { items: [], total: 0, limit: 0, sort: [] } })
    }
    if (detail && path === `/api/forms/${detail.id}/publish` && request.method() === 'POST') {
      state.publishBodies.push(request.postDataJSON())
      savedDetail = { ...savedDetail, isActive: true, publishedVersionId: 'published-1', publishedContentRevision: savedDetail.contentRevision }
      return json({ success: true, data: { id: 'published-1', contentRevision: savedDetail.contentRevision, replayed: false } })
    }
    /*
     * R25: 箱の口の見本。作る・直す・消す・並べ替えを本物と同じ形で返す。
     * 中身（フォーム）は消さず、未分類（`folderId: null`）に戻す。
     */
    if (path === '/api/folders' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}')
      state.folderWrites.push({ method: 'POST', body })
      const created = {
        id: `fol-${state.formFolders.length + 1}`,
        kind: 'form',
        accountId: body.accountId ?? null,
        name: body.name,
        parentId: null,
        displayOrder: state.formFolders.length,
        color: body.color ?? null,
        createdAt: '2026-09-27T00:00:00.000Z',
        updatedAt: '2026-09-27T00:00:00.000Z',
      }
      state.formFolders.push(created)
      return json({ success: true, data: created }, 201)
    }
    if (path === '/api/folders' && request.method() === 'GET') {
      return json({ success: true, data: state.formFolders })
    }
    {
      const folderMatch = path.match(/^\/api\/folders\/([^/]+)(\/swap-order)?$/)
      if (folderMatch && !folderMatch[2] && request.method() === 'PATCH') {
        const body = JSON.parse(request.postData() ?? '{}')
        state.folderWrites.push({ method: 'PATCH', id: folderMatch[1], body })
        const target = state.formFolders.find((folder) => folder.id === folderMatch[1])
        if (!target) return json({ success: false, error: 'Not found' }, 404)
        Object.assign(target, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.color !== undefined ? { color: body.color } : {}),
        })
        return json({ success: true, data: target })
      }
      if (folderMatch && !folderMatch[2] && request.method() === 'DELETE') {
        state.folderWrites.push({ method: 'DELETE', id: folderMatch[1] })
        state.formFolders = state.formFolders.filter((folder) => folder.id !== folderMatch[1])
        return json({ success: true, data: null })
      }
      if (folderMatch && folderMatch[2] === '/swap-order' && request.method() === 'POST') {
        const body = JSON.parse(request.postData() ?? '{}')
        state.folderWrites.push({ method: 'SWAP', id: folderMatch[1], body })
        return json({ success: true, data: { swapped: [folderMatch[1], body.withId] } })
      }
    }
    return json({ success: true, data: [] })
  })

  lastHarness = { context, page, state }
  return lastHarness
}

/**
 * この画面が「出し終えた」と言える条件。
 *
 * 認証の確認が済んで本体（）が現れ、一覧が読み込み中でなくなり、
 * 表の行か「1件も無い／読み込めなかった」のどれかが立っている状態。
 * V8の一覧本体が出す `data-list-state` をそのまま使う。
 */
async function waitForFormList(page) {
  try {
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-design-node="I3L41O"]')
      if (!root) return false
      // 2026-10-06：一覧は src/v8/forms/list。板の印は型の枠に、状態はそれを包む要素に付く。
      const state = root.closest('[data-list-state]')?.dataset.listState ?? root.dataset.listState
      if (state === 'loading') return false
      return Boolean(
        root.querySelector('tbody tr')
        || state === 'empty'
        || state === 'error',
      )
    }, undefined, { timeout: 15_000 })
  } catch (error) {
    console.error('browser current URL:', page.url())
    console.error('browser body:', (await page.locator('body').innerText()).slice(0, 2_000))
    throw error
  }
}

async function openList(page, search = '') {
  await page.goto(`${baseUrl}/form-submissions${search}`, { waitUntil: 'domcontentloaded' })
  await waitForFormList(page)
}

async function reloadList(page) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForFormList(page)
}

const rows = (page) => page.locator('tbody tr')

/**
 * URLの検索文字が指した値になるまで待つ。
 *
 * `router.replace` は描画のあとに効くので、行数だけ見て次の行で
 * URLを読むと、まだ前の値のことがある。**待つ条件をURL自身にする。**
 */
function waitForQuery(page, key, value) {
  return page.waitForFunction(
    ([name, expected]) => new URL(location.href).searchParams.get(name) === expected,
    [key, value],
    { timeout: 10_000 },
  )
}

function waitForRowCount(page, count) {
  return page.waitForFunction(
    (expected) => document.querySelectorAll('tbody tr').length === expected,
    count,
    { timeout: 10_000 },
  )
}

async function switchAccount(page, accountId) {
  const account = ACCOUNTS.find((item) => item.id === accountId)
  assert.ok(account, '切り替えるアカウントを用意している')
  await page.getByRole('button', { name: 'アカウントを切り替える', exact: true }).click()
  await page.getByRole('menu', { name: 'LINEアカウントの切り替え', exact: true })
    .getByRole('menuitemradio', { name: account.name, exact: true }).click()
}

const browser = await chromium.launch({ headless: true })
try {
  // 1. 並び順・表示件数・ページ送りが実際の一覧へ効き、URLと再読み込みへ残る（N-172）
  {
    const forms = Array.from({ length: 23 }, (_, index) => form(index + 1))
    const { context, page } = await openHarness(browser, { formsByAccount: { 'account-a': forms } })
    await openList(page)

    assert.equal(await rows(page).count(), 20, '既定は20件表示')

    await page.getByRole('button', { name: '並び', exact: true }).click()
    await page.getByRole('option', { name: '回答が多い順', exact: true }).click()
    await waitForQuery(page, 'sort', 'answers')
    // URL の更新と、API が返した並びの描画は別。先頭行が更新されるまで待つ。
    await page.waitForFunction(
      () => document.querySelector('tbody tr')?.textContent?.includes('フォーム23'),
      undefined, { timeout: 10_000 },
    )
    assert.equal((await rows(page).first().innerText()).includes('フォーム23'), true, '回答が多い順が先頭へ来る')

    await page.getByRole('button', { name: '次のページ' }).click()
    await waitForQuery(page, 'page', '2')
    await waitForRowCount(page, 3)
    await reloadList(page)
    assert.equal(await rows(page).count(), 3, '再読み込みしても2ページ目のまま')
    assert.equal((await rows(page).first().innerText()).includes('フォーム03'), true, '2ページ目の先頭が変わらない')

    await page.getByRole('button', { name: '表示件数' }).click()
    await page.getByRole('option', { name: '50件表示', exact: true }).click()
    await waitForQuery(page, 'limit', '50')
    await waitForRowCount(page, 23)
    assert.equal(/page=2/.test(page.url()), false, '件数を増やしたら1ページ目へ戻る')
    await reloadList(page)
    assert.equal(await rows(page).count(), 23, '再読み込みしても50件表示のまま')
    assert.equal((await page.getByRole('button', { name: '表示件数' }).innerText()).includes('50件表示'), true)
    await context.close()
  }

  // 2. 回答の導線と月次集計が、その行のフォームの実データを指す（N-173 / N-180）
  {
    const forms = [
      form(1, { id: 'sales-new', name: '営業フォーム', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z' }),
      form(2, { id: 'sales-old', name: '古い営業フォーム', updatedAt: null, monthlySubmitCount: null, monthlyCompletionRate: null }),
    ]
    const { context, page } = await openHarness(browser, { formsByAccount: { 'account-a': forms } })
    await openList(page, `?q=${encodeURIComponent('営業')}`)
    const listSource = new URL(page.url()).pathname + new URL(page.url()).search

    const newLink = page.getByRole('link', { name: '営業フォームの集まった回答を見る', exact: true })
    const oldLink = page.getByRole('link', { name: '古い営業フォームの集まった回答を見る', exact: true })
    for (const [link, id] of [[newLink, 'sales-new'], [oldLink, 'sales-old']]) {
      const destination = new URL(await link.getAttribute('href'), baseUrl)
      assert.equal(destination.pathname, '/form-submissions/responses')
      assert.equal(destination.searchParams.get('id'), id, '回答はその行のフォームを指す')
      const returnDestination = new URL(destination.searchParams.get('returnTo'), baseUrl)
      assert.equal(returnDestination.pathname, '/form-submissions', '回答から同じ一覧へ戻れる')
      assert.equal(returnDestination.searchParams.get('q'), '営業', '検索条件を持ち運ぶ')
      assert.equal(returnDestination.searchParams.get('form'), id, '戻る対象を持ち運ぶ')
      assert.equal(destination.searchParams.get('returnAccount'), 'account-a', '戻り先のアカウントを持ち運ぶ')
    }

    const newRow = rows(page).filter({ has: newLink })
    // V8は更新日時の独立列を廃止し、回答数と今月の回答・完了率をまとめる。
    assert.equal((await newRow.innerText()).includes('今月 1・完了 50%'), true, 'その行の月次集計を出す')
    assert.equal((await rows(page).filter({ has: oldLink }).innerText()).includes('今月 —・完了 —'), true,
      '取れていない月次集計を0と表示しない')
    // R27: 行の「編集」は質問の編集へ。「…」内の操作から対象を引き継ぐ。
    await newRow.getByRole('button', { name: /その他の操作/ }).click()
    await page.getByRole('menuitem', { name: '編集する', exact: true }).click()
    await page.waitForURL((url) => url.pathname === '/form-submissions/edit'
      && url.searchParams.get('id') === 'sales-new' && url.searchParams.get('tab') === 'basic')
    const editDestination = new URL(page.url())
    assert.equal(editDestination.searchParams.get('returnTo'), listSource, '編集メニューも検索条件を持ち運ぶ')
    assert.equal(editDestination.searchParams.get('returnAccount'), 'account-a')
    await context.close()
  }

  /*
   * 3. 箱の接続（R25）。staff には箱の操作を出さない。
   *    owner / admin は選んだアカウントに付けて作る・直す・消す。
   */
  {
    const { context, page, state } = await openHarness(browser, { role: 'staff', formsByAccount: { 'account-a': [form(1)] } })
    await openList(page)
    await page.getByRole('button', { name: /^すべて\s*\d/ }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'フォルダを追加', exact: true }).count(), 0, 'staff にフォルダ追加を出さない')
    assert.equal(state.folderWrites.length, 0, 'フォルダ作成の要求を出さない')
    await context.close()
  }
  for (const role of ['owner', 'admin']) {
    const { context, page, state } = await openHarness(browser, { role, formsByAccount: { 'account-a': [form(1)] } })
    await openList(page)
    const addFolder = page.getByRole('button', { name: 'フォルダを追加', exact: true })
    await addFolder.waitFor()
    assert.equal(await addFolder.isDisabled(), false, `${role} は箱を作れる`)
    await addFolder.click()
    await page.getByRole('textbox', { name: /フォルダ名/ }).fill('来店・予約')
    await page.getByRole('button', { name: '追加する', exact: true }).click()
    // 行ボタンだけを待つ。先頭一致にしないと「フォルダ「来店・予約」の操作」
    // （…ボタン）にも当たって strict mode violation になる。
    await page.getByRole('button', { name: /^来店・予約/ }).waitFor()
    assert.equal(state.folderWrites.length, 1, '箱の作成を1回出す')
    assert.equal(state.folderWrites[0].body.kind, 'form', '箱の種類を送る')
    assert.equal(state.folderWrites[0].body.accountId, 'account-a', '選んだアカウントに付けて作る')
    assert.equal(state.folderWrites[0].body.name, '来店・予約', '打った名前で作る')
    await context.close()
  }

  // 4. 初回空表示（N-181）と account 境界
  {
    const { context, page, state } = await openHarness(browser, {
      formsByAccount: { 'account-a': [], 'account-b': [form(7, { id: 'prod-form', name: '本店フォーム' })] },
    })
    await openList(page)
    await page.getByText('まだ回答フォームがありません', { exact: true }).waitFor()
    await page.getByText('アンケートや申し込みを LINE の中で受け付け、答えを友だち情報に保存します。').waitFor()
    assert.equal(await page.getByText(/見え方です/).count(), 0, '実装事情の文を出さない')

    await switchAccount(page, 'account-b')
    await page.getByText('本店フォーム', { exact: true }).waitFor()
    assert.equal(await page.getByText('まだ回答フォームがありません', { exact: true }).count(), 0)
    assert.deepEqual([...new Set(state.listCalls)].sort(), ['account-a', 'account-b'], '選んだアカウント以外を読まない')
    await context.close()
  }

  // 5. 逆順応答：切替前の遅い応答が、あとから一覧を書き換えない
  {
    const { context, page } = await openHarness(browser, {
      formsByAccount: {
        'account-a': [form(1, { id: 'slow-form', name: '前のアカウントのフォーム' })],
        'account-b': [form(2, { id: 'fast-form', name: '本店フォーム' })],
      },
      listDelayMs: { 'account-a': 2_000 },
    })
    const startedListA = page.waitForRequest((request) =>
      request.url().includes('/api/forms') && request.url().includes('account_id=account-a'))
    await page.goto(`${baseUrl}/form-submissions`, { waitUntil: 'domcontentloaded' })
    const lateListA = (await startedListA).response()
    await switchAccount(page, 'account-b')
    await page.getByText('本店フォーム', { exact: true }).waitFor()
    await lateListA
    await page.waitForTimeout(500)
    assert.equal(await page.getByText('前のアカウントのフォーム', { exact: true }).count(), 0, '切替前の遅い応答を混ぜない')
    assert.equal(await page.getByText('本店フォーム', { exact: true }).count(), 1, '切替後の一覧が残っている')
    await context.close()
  }

  // 6. 取得失敗を0件扱いにしない
  {
    const { context, page, state } = await openHarness(browser, { fail: true })
    await openList(page)
    await page.getByText('読み込めませんでした', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'もう一度読み込む' }).count(), 1)
    assert.equal(await page.getByText('まだ回答フォームがありません', { exact: true }).count(), 0, '失敗を0件と言わない')
    state.fail = false
    await page.getByRole('button', { name: 'もう一度読み込む' }).click()
    await page.getByText('まだ回答フォームがありません', { exact: true }).waitFor()
    await context.close()
  }

  // 7. V8の3タブで409になっても入力を残す。比べるだけでは書き換えず、明示した読み直しで戻す。
  for (const tab of ['content', 'after', 'appearance']) {
    const detail = { ...form(1, { id: 'form-1', name: 'サーバ側の名前' }), contentRevision: 4,
      layout: { ...LAYOUT, sections: [{ id: 'section-1', name: '質問', blocks: [
        { id: 'question-1', kind: 'input', type: 'text', name: 'answer', label: 'お名前' },
      ] }] },
    }
    const { context, page, state } = await openHarness(browser, {
      formsByAccount: { 'account-a': [detail] }, detail, putResults: ['conflict'],
    })
    await openV8Editor(page, detail.name, tab)
    const input = tab === 'content' ? page.locator('#fe-q-question-1')
      : tab === 'after' ? page.locator('#fe-thanks-text') : page.locator('#fe-name')
    const original = await input.inputValue()
    await input.fill('わたしが直した内容')
    await page.getByRole('button', { name: '下書きを保存', exact: true }).click()
    const band = page.locator('[data-save-conflict]')
    await band.waitFor({ timeout: 15_000 })
    assert.equal(state.putBodies.length, 1, `${tab}: 保存は1回だけ`)
    assert.equal(state.putBodies[0].expectedContentRevision, 4, `${tab}: 読み込んだ版を送る`)
    assert.equal(await page.getByText(/^要確認：ほかの人が.*を保存しました$/).count(), 1, `${tab}: 競合の知らせは1つ`)
    assert.equal(await input.inputValue(), 'わたしが直した内容', `${tab}: 409で入力を捨てない`)
    await page.getByRole('button', { name: '比べてから保存', exact: true }).click()
    const compare = page.getByRole('dialog', { name: '最新の保存と比べる', exact: true })
    await compare.waitFor()
    assert.equal(await input.inputValue(), 'わたしが直した内容', `${tab}: 比べるだけでは読み直さない`)
    const reload = compare.getByRole('button', { name: '最新を読み込んで続ける', exact: true })
    await reload.scrollIntoViewIfNeeded()
    assert.equal(await reload.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return node === top || node.contains(top)
    }), true, `${tab}: 読み直す出口が覆いの下敷きにならない`)
    await compare.getByRole('button', { name: 'キャンセル', exact: true }).click()
    assert.equal(await input.inputValue(), 'わたしが直した内容', `${tab}: 比較を取り消しても入力が残る`)
    await band.getByRole('button', { name: '最新を読み込んで続ける', exact: true }).click()
    await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.value === expected,
      { selector: tab === 'content' ? '#fe-q-question-1' : tab === 'after' ? '#fe-thanks-text' : '#fe-name', expected: original })
    assert.equal(await band.count(), 0, `${tab}: 読み直すと競合の出口が消える`)
    console.log(`409・入力保持・比較の取り消し・明示した読み直し（${tab}）: PASS`)
    await context.close()
  }

  /*
   * 8. 受付停止も編集の版を送る（#723）。
   *
   * 免除すると、止めたはずのフォームが編集画面の保存で公開中に戻り、回答が
   * 入り続ける。**影響の版（`revision`=9）ではなく編集の版を送る**ことも見る。
   */
  {
    const detail = {
      ...form(1, { id: 'form-1', name: '停止するフォーム', isActive: true }),
      contentRevision: 4,
    }
    const { context, page, state } = await openHarness(browser, {
      formsByAccount: { 'account-a': [detail] },
      detail,
    })
    await openList(page)
    // V8では受付停止の確認へ行の「…」メニューから直接入る。
    await page.getByRole('button', { name: /「停止するフォーム」のその他の操作/ }).click()
    await page.getByRole('menuitem', { name: '受付を止める', exact: true }).click()
    const stop = page.getByRole('button', { name: '受付を止める', exact: true })
    await stop.waitFor({ timeout: 15_000 })
    await stop.click()
    await page.waitForFunction(() => true)
    await page.waitForTimeout(800)

    assert.equal(state.putBodies.length, 1, '受付停止で保存を1回出す')
    assert.equal(state.putBodies[0].isActive, false, '止める指示を送る')
    assert.equal(state.putBodies[0].expectedContentRevision, 4,
      '編集の版（contentRevision）を送る。影響の版 revision=9 を送らない')
    await context.close()
  }

  async function openV8Editor(page, formName, tab = 'appearance') {
    await openList(page)
    await page.getByRole('link', { name: `「${formName}」の詳細を見る`, exact: true }).click()
    await page.getByRole('tab', { name: '受付と見た目', exact: true }).click()
    await page.waitForFunction(
      (expected) => document.querySelector('#fe-name')?.value === expected,
      formName, { timeout: 15_000 },
    )
    if (tab !== 'appearance') await page.getByRole('tab', { name: tab === 'after' ? '答え終わったあと' : '中身', exact: true }).click()
  }

  // 10. 390pxで共通の追加メニュー・対象を選ぶ窓・行の編集と削除が操作できる。
  {
    const detail = { ...form(1, { id: 'form-1', name: '動作を設定するフォーム' }), contentRevision: 4 }
    const { context, page } = await openHarness(browser, {
      detail, viewport: { width: 390, height: 844 }, formsByAccount: { 'account-a': [detail] },
      tags: [{ id: 'tag-mobile', name: '回答済み' }],
    })
    await page.goto(`${baseUrl}/form-submissions/edit?id=form-1&tab=after`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '行うことを足す', exact: true }).click()
    const kinds = page.getByRole('menu', { name: '行うことの種類', exact: true })
    await kinds.waitFor()
    for (const right of await kinds.getByRole('menuitem').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right))) {
      assert.ok(right <= 390, `R26: 種類の選択が画面に収まる（右端 ${Math.round(right)}px）`)
    }
    await kinds.getByRole('menuitem', { name: 'タグを付ける・外す', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'タグを選ぶ', exact: true })
    await waitForOverlayLayout(dialog)
    const box = await dialog.boundingBox()
    assert.ok(box && box.height <= 844, 'R26: 窓の高さが画面に収まる')
    await dialog.getByRole('checkbox', { name: '回答済み', exact: true }).check()
    for (const right of await dialog.locator('button').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right))) {
      assert.ok(right <= 390, `R26: 動作の操作が画面に収まる（右端 ${Math.round(right)}px）`)
    }
    await dialog.getByRole('button', { name: '選ぶ（1件）', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const action = page.locator('[data-action-row]')
    assert.equal(await action.count(), 1, '対象を確定した行だけ追加する')
    await action.getByRole('button', { name: 'タグ：変える', exact: true }).waitFor()
    const title = await action.getByRole('button', { name: '「回答済み」', exact: true }).boundingBox()
    assert.ok(title && title.width > 0 && title.x >= 0 && title.x + title.width <= 390,
      'R26: 行の名前も省略できる幅を保って画面内に表示する')
    for (const right of await action.getByRole('button').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right))) {
      assert.ok(right <= 390, `R26: 行の操作が画面に収まる（右端 ${Math.round(right)}px）`)
    }
    await action.getByRole('button', { name: '1つ目の行うことのその他操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '削除する', exact: true }).click()
    const removeDialog = page.getByRole('dialog', { name: '「行うこと」を削除しますか？', exact: true })
    await waitForOverlayLayout(removeDialog)
    const remove = await removeDialog.getByRole('button', { name: '削除する', exact: true }).boundingBox()
    assert.ok(remove && remove.x + remove.width <= 390, 'R26: 動作の削除が画面に収まる')
    await removeDialog.getByRole('button', { name: '削除する', exact: true }).click()
    assert.equal(await action.count(), 0, '確認した後に行を削除する')
    await context.close()
  }

  /*
   * 9. V8 の編集画面で、カード（OGP）の3欄が保存へ届き、再読込しても残る（#725 を V8 でも）。
   */
  {
    const detail = {
      ...form(1, { id: 'form-1', name: 'ごはんの相談' }),
      contentRevision: 4,
    }
    const { context, page, state } = await openHarness(browser, {
      formsByAccount: { 'account-a': [detail] },
      detail,
    })
    await openV8Editor(page, 'ごはんの相談')
    // カードの3欄は「リンクの見え方」の窓の中。利用者と同じ順（開く → 打つ → 閉じる → 保存）でたどる。
    await page.getByRole('button', { name: /^リンクの見え方：/ }).click()
    const linkDialog = page.getByRole('dialog', { name: 'リンクの見え方' })
    await waitForOverlayLayout(linkDialog)
    assert.equal(await linkDialog.getByRole('button', { name: '保存する', exact: true }).count(), 0,
      'V8: 設定の窓に2つ目の保存を置かない')
    await page.locator('#fe-og-title').fill('ごはんの相談フォーム')
    assert.equal(await page.locator('#fe-og-title').inputValue(), 'ごはんの相談フォーム', 'V8: 最初の入力を窓の描き直しで失わない')
    await page.locator('#fe-og-desc').fill('3分で終わります')
    // MediaSlot は「URL で入れる」を押してから入力欄を出す。
    assert.equal(await linkDialog.locator('#fe-og-image').count(), 0, 'V8: 画像URLは開く前に出さない')
    // キーボードからも画像URLの欄を開いて保存できる。
    await linkDialog.getByRole('button', { name: 'URL で入れる', exact: true }).press('Enter')
    await linkDialog.locator('#fe-og-image').fill('https://example.test/ogp.png')
    await linkDialog.getByRole('button', { name: '閉じる', exact: true }).last().click()
    await linkDialog.waitFor({ state: 'detached', timeout: 10_000 })
    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/forms/form-1' && response.request().method() === 'PUT' && response.ok(),
    )
    await page.getByRole('button', { name: '下書きを保存', exact: true }).click()
    await saved
    const sent = state.putBodies.at(-1)
    assert.ok(sent, 'V8: 保存が飛ぶ')
    assert.equal(sent.ogTitle, 'ごはんの相談フォーム', 'V8: 打った見出しが保存へ乗る')
    assert.equal(sent.ogDescription, '3分で終わります', 'V8: 打った説明が保存へ乗る')
    assert.equal(sent.ogImageUrl, 'https://example.test/ogp.png', 'V8: 打った画像URLが保存へ乗る')
    // 編集画面を読み直し、サーバが返した値を同じ操作で確かめる。
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('#fe-name').waitFor({ timeout: 15_000 })
    await page.waitForFunction(
      (expected) => document.querySelector('#fe-name')?.value === expected,
      sent.name, { timeout: 15_000 },
    )
    await page.getByRole('button', { name: /^リンクの見え方：/ }).click()
    await waitForOverlayLayout(linkDialog)
    assert.equal(await linkDialog.locator('#fe-og-title').inputValue(), sent.ogTitle, 'V8: 再読込で見出しが残る')
    assert.equal(await linkDialog.locator('#fe-og-desc').inputValue(), sent.ogDescription, 'V8: 再読込で説明が残る')
    // 保存済みの MediaSlot は URL の入口でなく画像の見本を出す。
    assert.equal(await linkDialog.getByRole('img', { name: 'カードの画像', exact: true }).getAttribute('src'), sent.ogImageUrl,
      'V8: 再読込で保存した画像URLを見本に使う')
    await context.close()
  }

  // 保存が失敗しても入力を残し、手で再試行できる。下書きの保存だけでは公開しない。
  {
    const detail = { ...form(1, { id: 'form-1', name: '保存をやり直すフォーム' }), contentRevision: 4 }
    const { context, page, state } = await openHarness(browser, {
      detail, formsByAccount: { 'account-a': [detail] }, putResults: ['failed'],
    })
    await openV8Editor(page, detail.name)
    await page.locator('#fe-name').fill('残しておく入力')
    const failed = page.waitForResponse((response) => response.request().method() === 'PUT' && response.status() === 500)
    await page.getByRole('button', { name: '下書きを保存', exact: true }).click()
    await failed
    await page.getByRole('alert').filter({ hasText: /保存/ }).waitFor()
    assert.equal(await page.locator('#fe-name').inputValue(), '残しておく入力', '保存失敗でも入力が残る')
    const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && response.ok())
    await page.getByRole('button', { name: '下書きを保存', exact: true }).click()
    await saved
    assert.equal(state.putBodies.length, 2, '失敗後の再試行は1回だけ送る')
    assert.equal(state.putBodies[1].expectedContentRevision, 4, '失敗で版を進めない')
    assert.equal(state.publishBodies.length, 0, '下書きの保存では公開しない')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('#fe-name')?.value === '残しておく入力')
    await context.close()
    console.log('保存失敗・入力保持・再試行・読み直し: PASS')
  }

  // 公開は確認の窓で確定したときだけ。保存で返った版を送る。
  {
    const detail = {
      ...form(1, { id: 'form-1', name: '公開するフォーム' }), contentRevision: 4,
      layout: { ...LAYOUT, sections: [{ id: 'section-1', name: '質問', blocks: [
        { id: 'question-1', kind: 'input', type: 'text', name: 'answer', label: 'お名前', required: true },
      ] }] },
    }
    const { context, page, state } = await openHarness(browser, { detail, formsByAccount: { 'account-a': [detail] } })
    await openV8Editor(page, detail.name)
    await page.getByRole('button', { name: 'この版を公開', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'この版を公開する', exact: true })
    await dialog.waitFor()
    assert.equal(state.publishBodies.length, 0, '窓を開くだけでは公開しない')
    await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(state.putBodies.length, 0, '公開を取り消すと保存も送らない')
    await page.getByRole('button', { name: 'この版を公開', exact: true }).click()
    await dialog.getByRole('button', { name: 'この版を公開', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(state.putBodies.length, 1, '公開前の保存は1回')
    assert.deepEqual(state.publishBodies, [{ expectedContentRevision: 5 }], '保存で返った版を1回だけ公開')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('公開中の版と同じです', { exact: true }).waitFor()
    await context.close()
    console.log('公開の確認・取り消し・版・読み直し: PASS')
  }

  // 管理者の編集を通すだけでなく、同じ役割の口で staff が閲覧用になることも守る。
  {
    const detail = { ...form(1, { id: 'form-1', name: '閲覧するフォーム' }), contentRevision: 4 }
    const { context, page, state } = await openHarness(browser, {
      role: 'staff', detail, formsByAccount: { 'account-a': [detail] },
    })
    await page.goto(`${baseUrl}/form-submissions/edit?id=form-1&tab=appearance`, { waitUntil: 'domcontentloaded' })
    await page.getByText('閲覧のみで見ています。変える操作は管理者に頼んでください。', { exact: true }).waitFor({ timeout: 15_000 })
    await page.locator('dd').getByText(detail.name, { exact: true }).waitFor({ timeout: 15_000 })
    assert.equal(await page.locator('#fe-name').count(), 0, 'V8: 閲覧のみでは名前の入力欄を出さない')
    assert.equal(await page.getByRole('button', { name: '下書きを保存', exact: true }).count(), 0, 'V8: 閲覧のみでは保存を出さない')
    assert.equal(await page.getByRole('button', { name: 'この版を公開', exact: true }).count(), 0, 'V8: 閲覧のみでは公開を出さない')
    assert.equal(state.putBodies.length, 0, 'V8: 閲覧のみでは保存を送らない')
    await context.close()
  }

  console.log('form submissions browser behavior: PASS')
} catch (error) {
  console.error('browser current URL:', lastHarness.page.url())
  console.error('browser body:', (await lastHarness.page.locator('body').innerText()).slice(0, 4000))
  console.error('form writes:', JSON.stringify(lastHarness.state.putBodies))
  throw error
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
