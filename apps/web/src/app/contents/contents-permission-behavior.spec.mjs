/*
  N-197（機能15メディア）の権限契約試験。

  **実build（`apps/web/out`）を実ルーティングで開き、実ブラウザで動かす。**
  V8の「…」を開き、権限のない管理操作が隠れるか・APIを本当に呼ばないかを
  ブラウザの側から見る。

  APIは1か所で受けて必ず `fulfill` する。**外へは1本も出さない。**
  `NEXT_PUBLIC_API_URL` は build 時に焼き込まれるため（検証環境のURL）、
  ここで受け止めないと `AuthGuard` の `/api/auth/session` が落ちて
  `/login` へ飛び、権限の検証まで届かない。前回の差し戻しはこれと
  `/contents` 完全一致の2点だった。
*/
import { expect, test } from '@playwright/test'

const BASE = process.env.MEDIA_PERMISSION_BASE ?? 'http://127.0.0.1:3109'
const ORIGIN = new URL(BASE).origin
const MEDIA_NAME = '夏の定番セット.jpg'

/** 静的書き出しは `/contents` でも `/contents/` でも同じ画面を出す。どちらでも通す。 */
const CONTENTS_URL = /\/contents\/?(?:[?#].*)?$/

const ACCOUNTS = [
  {
    id: 'visual-qa-account', name: '画面確認アカウント', displayName: '画面確認アカウント',
    channelId: '0000000000', basicId: '@visual-qa', pictureUrl: null, isActive: true,
    parentAccountId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'visual-qa-account-prod', name: '画面確認アカウント（本番）', displayName: '画面確認アカウント（本番）',
    channelId: '0000000001', basicId: '@visual-qa-prod', pictureUrl: null, isActive: true,
    parentAccountId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

const FOLDERS = [
  { id: 'media-product', kind: 'media', name: '商品', createdAt: '2026-01-01T00:00:00.000Z' },
]

const MEDIA_QUOTA = {
  usageBytes: 2576980378, reservedBytes: 0, limitBytes: 10737418240,
  remainingBytes: 8160437862, usageRate: 0.24, state: 'normal',
}

function mediaItems(accountId) {
  return [
    {
      id: 'media-delete-target', lineAccountId: accountId, folderId: 'media-product',
      kind: 'image', filename: MEDIA_NAME, mimeType: 'image/jpeg',
      sizeBytes: 348160, width: 1024, height: 678, durationMs: null,
      url: '', uploadedBy: '見本 145', createdAt: '2026-08-18T09:00:00.000Z', usageCount: 3,
    },
    {
      id: 'media-delete-safe', lineAccountId: accountId, folderId: null,
      kind: 'file', filename: 'メニュー表.pdf', mimeType: 'application/pdf',
      sizeBytes: 1258291, width: null, height: null, durationMs: null,
      url: '', uploadedBy: '田中', createdAt: '2026-08-15T09:00:00.000Z', usageCount: 0,
    },
  ]
}

const DELETE_IMPACT = {
  media: { id: 'media-delete-target', filename: MEDIA_NAME, kind: 'image' },
  usageCount: 3,
  references: [
    { kind: 'template', name: '夏の定番5点', href: '/templates', state: 'available', scannedAt: '2026-08-31T10:00:00.000Z' },
  ],
  checkedAt: '2026-08-31T10:00:00.000Z', lastScannedAt: '2026-08-31T10:00:00.000Z',
  canDelete: false, recommendedAction: 'review_references',
  versions: [],
}

/**
 * 管理画面とAPIは別サイト扱いなので、返すときに CORS を付ける。
 * `credentials: 'include'` で来るため `*` は使えない。開いている元をそのまま返す。
 */
function corsHeaders() {
  return {
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-credentials': 'true',
    'content-type': 'application/json; charset=utf-8',
  }
}

function preflightHeaders(request) {
  return {
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? 'content-type,authorization,x-csrf-token',
    'access-control-max-age': '0',
  }
}

function ok(data, extra = {}) {
  return { status: 200, body: { success: true, data, ...extra } }
}

/**
 * APIの応答を1か所で決める。
 * `staffMe` だけは試験ごとに差し替える（待たせる・失敗させる）。
 */
async function respond(url, staffMe, role) {
  const path = url.pathname
  if (path === '/admin/version') return ok({ version: '0.24.0', deploy_env: 'test' })
  if (path === '/api/auth/session') {
    return ok(
      { id: 'staff-me', name: '権限確認テスト', role, email: null, permissionKeys: [] },
      { csrfToken: 'media-permission-csrf' },
    )
  }
  if (path === '/api/staff/me') return staffMe()
  if (/^\/api\/line-accounts\/[^/]+\/follower-import$/.test(path)) return ok({ phase: 'complete' })
  if (path === '/api/settings/features/visibility') return ok({ features: { media: true }, favoriteItemIds: [], restaurantHiddenItemIds: [] })
  if (path === '/api/dashboard/style') return ok({ style: 'line' })
  if (path === '/api/line-accounts') return ok(ACCOUNTS)
  if (path === '/api/folders') return ok(FOLDERS)
  if (path === '/api/media') {
    const accountId = url.searchParams.get('accountId') ?? ACCOUNTS[0].id
    const items = mediaItems(accountId)
    return ok({ items, total: items.length })
  }
  if (path === '/api/media/quota') return ok(MEDIA_QUOTA)
  if (/^\/api\/media\/[^/]+\/delete-impact$/.test(path)) return ok(DELETE_IMPACT)
  if (/^\/api\/media\/[^/]+$/.test(path)) {
    const accountId = url.searchParams.get('accountId') ?? ACCOUNTS[0].id
    const item = mediaItems(accountId).find((candidate) => candidate.id === path.split('/').at(-1))
    return item
      ? ok({ item, folderName: item.folderId ? FOLDERS[0].name : null })
      : { status: 404, body: { success: false, error: 'メディアが見つかりません' } }
  }
  /*
    ここに無い口は「用意していない」と返す。空配列などを一律に返すと、
    形が合わないまま画面が描けてしまい、落ちる理由が分からなくなる。
  */
  return { status: 200, body: { success: false, error: 'この契約試験では用意していない応答です' } }
}

/**
 * 画面が使う口をすべて受け止める。**1本も外へ出さない。**
 * `onRequest` で「本当に呼んだか」を数える。
 */
async function stubApi(page, { role = 'owner', staffMe, onRequest = () => {} } = {}) {
  const respondStaffMe = staffMe ?? (async () => ok({ id: `${role}-1`, name: `${role} test`, role, email: null, permissionKeys: ['/contents'], permissionViewKeys: ['/contents'] }))
  await page.route(
    (url) => url.pathname.startsWith('/api/') || url.pathname === '/admin/version',
    async (route) => {
      const request = route.request()
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: preflightHeaders(request), body: '' })
        return
      }
      const url = new URL(request.url())
      onRequest(url, request)
      const result = await respond(url, respondStaffMe, role)
      await route.fulfill({
        status: result.status,
        headers: corsHeaders(),
        body: JSON.stringify(result.body),
      })
    },
  )
}

/** 店舗の選択は認証セッションごとに一度捨てられる。捨て済みの印を先に置く。 */
async function signIn(page) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('lh_auth_selection_cleared', '1')
    window.localStorage.setItem('lh_selected_account', 'visual-qa-account')
    window.localStorage.setItem('lh_staff_name', '権限確認テスト')
  })
}

async function openContents(page, waitUntil = 'networkidle') {
  await page.goto(`${BASE}/contents`, { waitUntil })
  await expect(page).toHaveURL(CONTENTS_URL)
  await expect(page.getByText(MEDIA_NAME, { exact: true }).first()).toBeVisible()
}

async function openMediaMenu(page) {
  await page.getByRole('button', { name: `${MEDIA_NAME}のその他操作`, exact: true }).click()
  return page.getByRole('menu', { name: `${MEDIA_NAME}の操作`, exact: true })
}

async function openUsage(page) {
  const menu = await openMediaMenu(page)
  await menu.getByRole('menuitem', { name: '使用箇所を見る', exact: true }).click()
}

function permissionNote(page) {
  return page.getByRole('note').filter({ hasText: '閲覧のみで見ています。' })
}

async function expectManagementHidden(page, { canRegister = false } = {}) {
  const menu = await openMediaMenu(page)
  await expect(menu).toBeVisible()
  for (const name of ['使用箇所を見る', '名前を変える', 'フォルダへ移す', 'アーカイブ', '削除する', '別のメディアに差し替える']) {
    /* 無効な項目に理由が付いて読み上げ名が長くなっても、隠す契約の違反として検出する。 */
    await expect(menu.getByRole('menuitem', { name })).toHaveCount(0)
  }
  /* 閲覧・ダウンロードは残す。登録は確認済みの書込み可能なstaffだけに出す。 */
  await expect(menu.getByRole('menuitem', { name: 'プレビュー', exact: true })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'ダウンロード', exact: true })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: `${MEDIA_NAME}を選ぶ`, exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /選択したメディアを削除/ })).toHaveCount(0)
  await expect(page.getByText('すべてのメディアを選択', { exact: true })).toHaveCount(0)
  const register = page.getByRole('button', { name: 'メディアを登録する', exact: true })
  if (canRegister) await expect(register.first()).toBeVisible()
  else await expect(register).toHaveCount(0)
}

/** 使用箇所の照会に加え、編集・削除等の書き込み要求も実際に監視する。 */
function managementRequestLog() {
  const requests = []
  return {
    requests,
    onRequest: (url, request) => {
      if (/^\/api\/media\/[^/]+\/delete-impact$/.test(url.pathname)
        || (url.pathname.startsWith('/api/media') && request.method() !== 'GET')) {
        requests.push(`${request.method()} ${url.pathname}`)
      }
    },
  }
}

test.describe('Issue #667 メディア管理権限の実挙動', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1080 })
    await signIn(page)
  })

  test('権限取得中は管理操作を止め、ownerの応答後に詳細を開いてAPIを読む', async ({ page }) => {
    let releaseRole
    const roleReady = new Promise((resolve) => { releaseRole = resolve })
    const management = managementRequestLog()

    await stubApi(page, {
      role: 'owner',
      staffMe: async () => {
        await roleReady
        return ok({ id: 'owner-1', name: 'Owner', role: 'owner', email: null })
      },
      onRequest: management.onRequest,
    })

    await page.goto(`${BASE}/contents`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: 'メディアを登録する', exact: true })).toHaveCount(0)
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect(management.requests).toEqual([])
    releaseRole()
    await expect(page.getByText(MEDIA_NAME, { exact: true }).first()).toBeVisible()
    await expect(permissionNote(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'メディアを登録する', exact: true }).first()).toBeVisible()
    await openUsage(page)
    await expect.poll(() => management.requests).toEqual(['GET /api/media/media-delete-target/delete-impact'])
    await expect(page.getByRole('heading', { name: MEDIA_NAME, exact: true })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: '夏の定番5点' })).toBeVisible()
  })

  test('adminは使用箇所を開ける', async ({ page }) => {
    let impactRequests = 0
    await stubApi(page, {
      role: 'admin',
      onRequest: (url) => {
        if (/^\/api\/media\/[^/]+\/delete-impact$/.test(url.pathname)) impactRequests += 1
      },
    })

    await openContents(page)
    await openUsage(page)
    await expect.poll(() => impactRequests).toBe(1)
    await expect(page.getByRole('heading', { name: MEDIA_NAME, exact: true })).toBeVisible()
  })

  test('staffは理由付きで使用箇所を開けず、編集・削除APIも呼ばない', async ({ page }) => {
    const management = managementRequestLog()
    await stubApi(page, {
      role: 'staff',
      staffMe: async () => ok({ id: 'staff-viewer', name: 'Staff', role: 'staff', permissionKeys: [], permissionViewKeys: ['/contents'] }),
      onRequest: management.onRequest,
    })

    await openContents(page)
    await expect(permissionNote(page)).toContainText('管理者だけができます')
    await expectManagementHidden(page, { canRegister: true })
    expect(management.requests).toEqual([])
    await expect(page.getByRole('heading', { name: MEDIA_NAME, exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'メディアを登録する', exact: true }).first().click()
    await expect(page.getByRole('dialog', { name: 'ファイルを入れる', exact: true })).toBeVisible()
    expect(management.requests).toEqual([])
  })

  for (const restriction of [{ readOnly: true }, { roleBundle: 'view_only' }]) {
    test(`閲覧専用（${Object.keys(restriction)[0]}）は登録を隠し、プレビューとダウンロードを保つ`, async ({ page }) => {
      const management = managementRequestLog()
      await stubApi(page, {
        role: 'staff',
        staffMe: async () => ok({ id: 'viewer-1', name: 'Viewer', role: 'staff', email: null, permissionKeys: ['/contents'], permissionViewKeys: ['/contents'], ...restriction }),
        onRequest: management.onRequest,
      })
      await openContents(page)
      await expectManagementHidden(page)
      expect(management.requests).toEqual([])
    })
  }

  /*
    役割が読めない壊れ方は2通りある。**どちらもfail-closedでなければならない。**
    500 は `fetchApi` が投げるので catch 側、200 + `success:false` は返り値側へ
    落ちる。片方だけを見ていると、もう片方をfail-openへ戻しても気づけない。
  */
  const ROLE_FAILURES = [
    { name: 'HTTP 500', reply: { status: 500, body: { success: false, error: 'role unavailable' } } },
    { name: '200だが success:false', reply: { status: 200, body: { success: false, error: 'role unavailable' } } },
  ]

  for (const failure of ROLE_FAILURES) {
    test(`役割取得失敗（${failure.name}）はfail-closedにして理由を表示する`, async ({ page }) => {
      const management = managementRequestLog()
      await stubApi(page, {
        role: 'owner',
        staffMe: async () => failure.reply,
        onRequest: management.onRequest,
      })

      await page.goto(`${BASE}/contents`, { waitUntil: 'networkidle' })
      await expect(page.locator('[data-page-pending="identity"]')).toBeVisible()
      await expect(page.getByRole('button', { name: /もう一度/ }).first()).toBeVisible()
      await expect(page.getByRole('button', { name: 'メディアを登録する', exact: true })).toHaveCount(0)
      await expect(page.getByRole('menu')).toHaveCount(0)
      expect(management.requests).toEqual([])
      await expect(page.getByRole('heading', { name: MEDIA_NAME, exact: true })).toHaveCount(0)
    })
  }

  test('アカウント切替で開いていた詳細を閉じ、新しいアカウントの一覧を読む', async ({ page }) => {
    const listedAccounts = []
    await stubApi(page, {
      role: 'owner',
      onRequest: (url) => {
        if (url.pathname === '/api/media') listedAccounts.push(url.searchParams.get('accountId'))
      },
    })

    await openContents(page)
    await openUsage(page)
    await expect(page.getByRole('heading', { name: MEDIA_NAME, exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'アカウントを切り替える', exact: true }).click()
    await page.getByRole('menu', { name: 'LINEアカウントの切り替え', exact: true })
      .getByRole('menuitemradio', { name: ACCOUNTS[1].name, exact: true }).click()
    await expect.poll(() => listedAccounts.at(-1)).toBe('visual-qa-account-prod')
    await expect(page.getByRole('heading', { name: MEDIA_NAME, exact: true })).toHaveCount(0)
    await expect(page.getByText(MEDIA_NAME, { exact: true }).first()).toBeVisible()
  })
})
