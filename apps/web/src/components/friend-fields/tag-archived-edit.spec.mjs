/*
  Issue #710 の実挙動試験。

  **実build（`apps/web/out`）を実ルーティングで開き、実ブラウザで動かす。**
  文字列検査ではないので、archived タグを開いたときに通常の編集フォーム
  （フォルダ・マイル・連動アクション）が本当に出ないか、名前と説明だけの
  専用フォームが本当に出るか、保存で送る内容が本当に限定されているかを
  ブラウザの側から見る。一覧の「保管済み」表示も同じ実buildで確かめる。

  APIは1か所で受けて必ず `fulfill` する。**外へは1本も出さない。**
  （`contents-permission-behavior.spec.mjs` と同じ作法。）
*/
import { expect, test } from '@playwright/test'

const BASE = process.env.TAG_ARCHIVED_EDIT_BASE ?? 'http://127.0.0.1:3110'
const ORIGIN = new URL(BASE).origin

const ACCOUNT = {
  id: 'visual-qa-account', name: '画面確認アカウント', displayName: '画面確認アカウント',
  channelId: '0000000000', basicId: '@visual-qa', pictureUrl: null, isActive: true,
  parentAccountId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

function baseTag(overrides) {
  return {
    id: 'tag-active', name: '会員', color: '#8b938d', groupId: null,
    mileageReward: 0, referralMileageReward: 0, mileageMultiplierBps: null, mileageMultiplierPriority: 0,
    isStarred: false, displayOrder: 0, createdAt: '2026-01-01T00:00:00.000Z',
    lineAccountId: ACCOUNT.id, description: '会員向けのタグです', manualAssignmentAllowed: true,
    reapplyPolicy: 'first_only', linkedEnabled: false, status: 'active', version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z', friendCount: 12,
    ...overrides,
  }
}

const ACTIVE_TAG = baseTag({})
const ARCHIVED_TAG = baseTag({
  id: 'tag-archived', name: '休眠会員(旧)', status: 'archived', version: 5, friendCount: 0,
})

function ok(data, extra = {}) {
  return { status: 200, body: { success: true, data, ...extra } }
}

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

/**
 * APIの応答を1か所で決める。`tags` は可変（PATCH で書き換わる）ので
 * クロージャで持つ。
 */
function makeRespond(tags, onPatch) {
  return async (request) => {
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    if (path === '/api/auth/session') {
      return ok({ id: 'staff-me', name: '確認用', role: 'owner', email: null, permissionKeys: [] }, { csrfToken: 'tag-archived-edit-csrf' })
    }
    if (path === '/api/staff/me') return ok({ id: 'staff-me', name: '確認用', role: 'owner', email: null })
    if (path === '/api/line-accounts') return ok([ACCOUNT])
    if (/^\/api\/line-accounts\/[^/]+\/follower-import$/.test(path)) return ok(url.searchParams.get('entry') === '1' ? { destination: 'dashboard', canResume: false } : { phase: 'complete' })
    if (path === '/api/dashboard/style') return ok({ style: 'standard', styleSelected: true })
    if (path === '/api/tag-groups') return ok([])
    if (path === '/api/tags' && method === 'GET') return ok(Object.values(tags))
    const idMatch = /^\/api\/tags\/([^/]+)$/.exec(path)
    if (idMatch && method === 'GET') {
      const tag = tags[idMatch[1]]
      if (!tag) return { status: 404, body: { success: false, error: 'tag not found' } }
      return ok({ ...tag, tag, automation: null })
    }
    if (idMatch && method === 'PATCH') {
      const tag = tags[idMatch[1]]
      if (!tag) return { status: 404, body: { success: false, error: 'tag not found' } }
      const body = request.postDataJSON()
      onPatch(idMatch[1], body)
      // 実物のサーバー(updateTagDefinition)と同じ制約をここでも再現する。
      // archived な間は name/description 以外を送ってきたら拒否する。
      if (tag.status === 'archived') {
        const restrictedKeys = ['groupId', 'isStarred', 'manualAssignmentAllowed', 'reapplyPolicy', 'linkedEnabled', 'mileage', 'actions', 'automationId']
        const touched = restrictedKeys.filter((key) => body[key] !== undefined)
        if (touched.length > 0) {
          return { status: 409, body: { success: false, code: 'archived_readonly', error: '保管済みのタグは名前と説明だけ変更できます' } }
        }
      }
      if (body.name !== undefined) tag.name = body.name
      if (body.description !== undefined) tag.description = body.description
      tag.version += 1
      return ok({ ...tag, tag, queued: 0 })
    }
    const depMatch = /^\/api\/tags\/([^/]+)\/dependencies$/.exec(path)
    if (depMatch && method === 'GET') {
      const tag = tags[depMatch[1]]
      if (!tag) return { status: 404, body: { success: false, error: 'Not found' } }
      return ok({
        tag: { id: tag.id, name: tag.name, version: tag.version, status: tag.status },
        friendCount: tag.friendCount ?? 0,
        referenceCounts: {},
        references: [],
      })
    }
    return { status: 200, body: { success: false, error: 'この試験では用意していない応答です' } }
  }
}

async function stubApi(page, tags, onPatch = () => {}) {
  const respond = makeRespond(tags, onPatch)
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      if (request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: preflightHeaders(request), body: '' })
        return
      }
      const result = await respond(request)
      await route.fulfill({ status: result.status, headers: corsHeaders(), body: JSON.stringify(result.body) })
    },
  )
}

async function signIn(page) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('lh_auth_selection_cleared', '1')
    window.localStorage.setItem('lh_selected_account', 'visual-qa-account')
  })
}

test.describe('Issue #710 保管済みタグの編集は名前と説明だけ（実挙動）', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 960 })
    await signIn(page)
  })

  test('archived タグを開くと、専用の縮小フォームが出て通常編集フォームは出ない', async ({ page }) => {
    const tags = { [ARCHIVED_TAG.id]: { ...ARCHIVED_TAG } }
    await stubApi(page, tags)

    await page.goto(`${BASE}/tags/edit?id=${ARCHIVED_TAG.id}`, { waitUntil: 'networkidle' })

    await expect(page.getByText('このタグは保管済みです')).toBeVisible()
    await expect(page.getByLabel('タグ名')).toHaveValue(ARCHIVED_TAG.name)
    await expect(page.getByLabel('説明')).toHaveValue(ARCHIVED_TAG.description)
    // 通常の編集フォーム固有の段（V8 の「タグ連動」）が出ていないことを見る。
    await expect(page.getByRole('region', { name: 'タグ連動' })).toHaveCount(0)
  })

  test('archived タグの名前を直して保存すると、名前と説明だけ送られる', async ({ page }) => {
    const tags = { [ARCHIVED_TAG.id]: { ...ARCHIVED_TAG } }
    const patches = []
    await stubApi(page, tags, (id, body) => patches.push({ id, body }))

    await page.goto(`${BASE}/tags/edit?id=${ARCHIVED_TAG.id}`, { waitUntil: 'networkidle' })
    await page.getByLabel('タグ名').fill('休眠会員(誤字修正)')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(page.getByText('保存しました。')).toBeVisible()

    expect(patches).toHaveLength(1)
    expect(patches[0].body).toMatchObject({ name: '休眠会員(誤字修正)' })
    // フォルダ・マイル・連動などは送っていない。
    expect(patches[0].body.groupId).toBeUndefined()
    expect(patches[0].body.mileage).toBeUndefined()
    expect(patches[0].body.actions).toBeUndefined()
  })

  test('active なタグは今までどおり通常の編集フォームが出る(対照)', async ({ page }) => {
    const tags = { [ACTIVE_TAG.id]: { ...ACTIVE_TAG } }
    await stubApi(page, tags)

    await page.goto(`${BASE}/tags/edit?id=${ACTIVE_TAG.id}`, { waitUntil: 'networkidle' })

    await expect(page.getByText('このタグは保管済みです')).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'タグ連動' })).toBeVisible()
  })

  test('タグは確認してから保管し、知らせに取り消しを出さない', async ({ page }) => {
    const item = { ...ACTIVE_TAG, friendCount: 0 }
    const tags = { [item.id]: item }
    let archiveRequests = 0
    await stubApi(page, tags)
    await page.route('**/api/tags/tag-active/dependencies**', async route => {
      await route.fulfill({ status: 200, headers: corsHeaders(), body: JSON.stringify({ success: true, data: {
        tag: { id: item.id, name: item.name, version: item.version, status: item.status }, friendCount: 0,
        referenceCounts: {}, references: [], linkedActions: [], pendingRunCount: 0, blockingReferenceCount: 0,
        canArchive: true, canDelete: true, revision: 'revision-1',
        mileageImpact: { configured: false, self: 0, referrer: 0, multiplier: null, priority: 0, reapplyPolicy: 'first_only', historyPreserved: true },
      } }) })
    })
    await page.route('**/api/tags/tag-active/archive**', async route => {
      archiveRequests++
      item.status = 'archived'
      await route.fulfill({ status: 200, headers: corsHeaders(), body: JSON.stringify({ success: true, data: { archived: true, replacedFriendCount: 0 } }) })
    })
    await page.goto(`${BASE}/tags`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: `タグ「${item.name}」の操作` }).click()
    await page.getByRole('menuitem', { name: '保管する', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: `「${item.name}」を保管しますか？` })
    await expect(dialog).toBeVisible()
    expect(archiveRequests).toBe(0)
    await dialog.getByPlaceholder(item.name).fill(item.name)
    await dialog.getByRole('button', { name: 'このタグを保管する' }).click()
    await expect.poll(() => archiveRequests).toBe(1)
    await expect(page.getByRole('status', { name: '知らせ' })).toContainText('保管しました')
    await expect(page.getByRole('status', { name: '知らせ' }).getByRole('button', { name: '元に戻す' })).toHaveCount(0)
  })

  test('保管したタグは保管一覧のバッジで識別でき、通常のタグへは付けない', async ({ page }) => {
    const tags = { [ACTIVE_TAG.id]: { ...ACTIVE_TAG }, [ARCHIVED_TAG.id]: { ...ARCHIVED_TAG } }
    await stubApi(page, tags)

    await page.goto(`${BASE}/tags`, { waitUntil: 'networkidle' })

    await expect(page.getByRole('link', { name: ACTIVE_TAG.name, exact: true })).toBeVisible()
    const activeRows = page.locator('tr').filter({ has: page.getByRole('link', { name: ACTIVE_TAG.name, exact: true }) })
    await expect(activeRows.getByText('アーカイブ', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: ARCHIVED_TAG.name, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '保管', exact: true }).click()
    const rows = page.locator('tr').filter({ has: page.getByRole('link', { name: ARCHIVED_TAG.name, exact: true }) })
    await expect(rows.getByText('アーカイブ', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: ACTIVE_TAG.name, exact: true })).toHaveCount(0)
  })
})
