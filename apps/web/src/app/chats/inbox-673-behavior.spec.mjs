/*
 * #673（点検 #617 N-033）の実挙動試験。
 *
 * 実行:
 *   NEXT_PUBLIC_API_URL=http://127.0.0.1:8800 pnpm --filter web build
 *   npx playwright test apps/web/src/app/chats/inbox-673-behavior.spec.mjs
 *
 * 静的出力したReact画面を本物のChromiumで描画し、routerのsearch paramsと
 * ブラウザ上のAPI応答を操作する。page.tsxの文字列は検査しない。
 *
 * 応答は apps/worker の本物のルートに合わせる。とくに `GET /api/chats/:id`
 * は「見る権限」しか見ないので、別アカウントの相手でも 200 で返す。
 * ここを固定の403にすると、画面が守っているアカウント境界を試験が
 * 肩代わりしてしまい、何も証明できない。実ルートがそう振る舞うことは
 * inbox-673-account-boundary.test.ts が本物のルートを載せて確かめている。
 */
import { createReadStream, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../../..', 'out')

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** 作業中に選んでいるLINEアカウント。 */
const SELECTED_ACCOUNT = 'account-b'
/** 同じ担当者が見られる、もう1つのLINEアカウント。 */
const OTHER_ACCOUNT = 'account-a'

let server
let baseUrl

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!existsSync(resolve(OUT, 'chats.html'))) {
    throw new Error('apps/web/out/chats.html がありません。先に web build を実行してください。')
  }
  server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
    const relative = pathname === '/'
      ? 'index.html'
      : pathname.includes('.')
        ? pathname.slice(1)
        : `${pathname.slice(1)}.html`
    const file = resolve(OUT, relative)
    if (file !== OUT && !file.startsWith(`${OUT}${sep}`)) {
      response.writeHead(400).end('Bad request')
      return
    }
    if (!existsSync(file)) {
      response.writeHead(404).end('Not found')
      return
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    createReadStream(file).pipe(response)
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('試験用サーバーを起動できませんでした')
  baseUrl = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  if (!server) return
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
})

function chatDetail(id, name, message = `${name}の会話`) {
  return {
    id,
    friendId: id,
    friendName: name,
    friendRealName: null,
    friendPictureUrl: null,
    operatorId: null,
    status: 'unread',
    notes: null,
    revision: 1,
    lastMessageAt: '2026-09-09T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    messages: [{
      id: `message-${id}`,
      direction: 'incoming',
      messageType: 'text',
      content: message,
      source: 'line',
      originKind: null,
      sentByStaffId: null,
      sentByStaffName: null,
      scenarioName: null,
      createdAt: '2026-09-09T00:00:00.000Z',
    }],
    hasMoreMessages: false,
  }
}

function chatListItem(id, name) {
  return {
    id,
    friendId: id,
    friendName: name,
    friendPictureUrl: null,
    operatorId: null,
    status: 'unread',
    notes: null,
    revision: 1,
    lastMessageAt: '2026-09-09T00:00:00.000Z',
    lastMessageContent: `${name}の一覧メッセージ`,
    lastMessageDirection: 'incoming',
    lastMessageType: 'text',
    isUnread: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
  }
}

async function fulfillJson(route, body, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function lineAccount(id, name, order) {
  return {
    id, channelId: `channel-${id}`, name, displayName: name,
    isActive: true, country: 'JP', role: 'owner', displayOrder: order, emailInboxEnabled: true,
  }
}

/**
 * 受信箱の口を用意する。
 *
 * options:
 *   selectedAccount  画面で選んでいるLINEアカウント。既定は SELECTED_ACCOUNT。
 *   friendAccounts   友だちIDごとの所属アカウント。'missing' で404。
 *                    未指定の友だちは選択中アカウントの相手として返す。
 *   details          `GET /api/chats/:id` の返し方。
 *   onChatDetail     `GET /api/chats/:id` を自分で捌く。
 */
async function prepareInbox(page, options = {}) {
  const detailCalls = []
  const friendCalls = []
  const details = options.details ?? {}
  const friendAccounts = options.friendAccounts ?? {}
  const selectedAccount = options.selectedAccount ?? SELECTED_ACCOUNT
  await page.addInitScript((accountId) => {
    window.localStorage.setItem('lh_selected_account', accountId)
    window.sessionStorage.setItem('lh_auth_selection_cleared', '1')
  }, selectedAccount)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/auth/session') {
      await fulfillJson(route, {
        success: true,
        data: { id: 'staff-1', name: '試験担当', email: 'test@example.invalid', role: 'owner' },
        csrfToken: 'test-csrf',
      })
      return
    }
    if (path === '/api/line-accounts') {
      // 同じ担当者がA社とB社の両方を見られる。実ルートでも両方に権限が
      // ある担当者は存在する（inbox-673-account-boundary.test.ts）。
      await fulfillJson(route, { success: true, data: [
        lineAccount(SELECTED_ACCOUNT, 'B社アカウント', 1),
        lineAccount(OTHER_ACCOUNT, 'A社アカウント', 2),
      ] })
      return
    }
    const accountEntry = path.match(/^\/api\/line-accounts\/([^/]+)\/follower-import$/)
    if (request.method() === 'GET' && accountEntry && url.searchParams.get('entry') === '1') {
      if (accountEntry[1] !== SELECTED_ACCOUNT && accountEntry[1] !== OTHER_ACCOUNT) {
        return fulfillJson(route, { success: false, error: 'LINE_ACCOUNT_NOT_FOUND' }, 404)
      }
      return fulfillJson(route, { success: true, data: { destination: 'dashboard', canResume: false } })
    }
    if (path === '/api/settings/features') {
      await fulfillJson(route, { success: true, data: {
        features: {}, sidebarOrder: null, sidebarItemOrder: null,
        parentChildMode: false, specializedFeatureKeys: [], version: 1,
      } })
      return
    }
    if (path === '/api/chats') {
      await fulfillJson(route, {
        success: true,
        data: [chatListItem('manual-chat', '手動選択 次郎')],
      })
      return
    }
    // V8 の絞り込み件数は会話の詳細ではない。予約語を ID として数えない。
    if (path === '/api/chats/quick-counts') {
      await fulfillJson(route, { success: true, data: {
        all: 2, reply: 2, overdue: 0,
        line: { all: 1, reply: 1, overdue: 0 }, email: { all: 1, reply: 1, overdue: 0 },
      } })
      return
    }
    if (path === '/api/chats/stats') {
      await fulfillJson(route, { success: true, data: {
        total: 1, unread: 1, inProgress: 0, onHold: 0, resolved: 0,
        oldestUnansweredMinutes: 10, assigneeUnread: [],
      } })
      return
    }
    if (path === '/api/support/inbox') {
      await fulfillJson(route, { success: true, data: { items: [{
        id: 'mail-item', threadId: 'mail-thread', customerName: 'メール 花子',
        customerIdentifier: 'hanako@example.invalid', subject: 'メールの対象', preview: '本文',
        status: 'unread', revision: 1, assignedStaffId: null, assignedStaffName: null,
        lastIncomingAt: '2026-09-09T00:01:00.000Z', isUnread: true,
      }] } })
      return
    }
    if (path === '/api/inbox/saved-views' || path === '/api/operators') {
      await fulfillJson(route, { success: true, data: [] })
      return
    }
    if (path === '/api/support/email/threads/mail-thread') {
      await fulfillJson(route, { success: true, data: {
        thread: {
          id: 'mail-thread', subject: 'メールの対象', customer_name: 'メール 花子',
          customer_email: 'hanako@example.invalid', status: 'unread',
          assigned_staff_id: null, notes: null, revision: 1,
        },
        messages: [{
          id: 'mail-message', direction: 'incoming', body_text: 'メール本文',
          sent_by_staff_name: null, created_at: '2026-09-09T00:01:00.000Z',
        }],
      } })
      return
    }
    if (path.endsWith('/read') && request.method() === 'POST') {
      await fulfillJson(route, { success: true, data: { isUnread: false } })
      return
    }
    const chatMatch = path.match(/^\/api\/chats\/([^/]+)$/)
    if (chatMatch && request.method() === 'GET') {
      const id = decodeURIComponent(chatMatch[1])
      detailCalls.push(id)
      if (options.onChatDetail) {
        await options.onChatDetail({ id, route })
        return
      }
      const configured = details[id]
      if (configured?.status) {
        await fulfillJson(route, { success: false, error: configured.error ?? 'not found' }, configured.status)
        return
      }
      await fulfillJson(route, { success: true, data: configured?.data ?? chatDetail(id, configured?.name ?? id) })
      return
    }
    const friendMatch = path.match(/^\/api\/friends\/([^/]+)$/)
    if (friendMatch) {
      const id = decodeURIComponent(friendMatch[1])
      friendCalls.push(id)
      const configured = friendAccounts[id]
      if (configured === 'missing') {
        await fulfillJson(route, { success: false, error: 'Friend not found' }, 404)
        return
      }
      await fulfillJson(route, { success: true, data: {
        id, displayName: id, pictureUrl: null, isFollowing: true, metadata: {},
        // 実ルート `GET /api/friends/:id` が返す所属アカウント。
        lineAccountId: configured ?? selectedAccount,
        realName: null, systemDisplayName: null, refCode: null,
        createdAt: '2026-09-01T00:00:00.000Z', tags: [], formSubmissions: [], support: null,
      } })
      return
    }
    if (/^\/api\/friends\/[^/]+\/mileage$/.test(path)) {
      await fulfillJson(route, { success: true, data: {
        summary: {
          programId: 'mileage-test', programName: '試験マイル',
          available: 0, pending: 0, lifetimeEarned: 0, spent: 0,
        },
        history: [],
      } })
      return
    }
    if (/^\/api\/friends\/[^/]+\/rich-menu$/.test(path)) {
      await fulfillJson(route, { success: true, data: { id: null, name: null, isDefault: false } })
      return
    }
    await fulfillJson(route, { success: true, data: [] })
  })
  return { detailCalls, friendCalls }
}

async function openFriend(page, friendId) {
  await page.goto(`${baseUrl}/chats?friend=${encodeURIComponent(friendId)}`, { waitUntil: 'domcontentloaded' })
}

function talkText(page, text) {
  return page.locator('[data-inbox-v4="talk-pane"]').getByText(text, { exact: true })
}

/** ブラウザから口を直に叩いて、応答の状態番号だけ取る。 */
function apiStatus(page, path) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'include' })
    return response.status
  }, `${process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:8800'}${path}`)
}

test('正常なfriend URLで対象会話を選び、再読込でも維持する', async ({ page }) => {
  const { detailCalls, friendCalls } = await prepareInbox(page, {
    details: { target: { data: chatDetail('target', '対象 太郎', '対象の会話です') } },
  })
  await openFriend(page, 'target')
  await expect(talkText(page, '対象の会話です')).toBeVisible()
  expect(detailCalls).toContain('target')

  // 照合は繰り返さない。URLが変わらない限り、描画のたびに口を叩くと
  // 受信箱を開いているだけで所属確認が流れ続ける。
  await page.waitForTimeout(500)
  expect(friendCalls.filter((id) => id === 'target').length).toBeLessThanOrEqual(2)
  expect(detailCalls.filter((id) => id === 'target').length).toBeLessThanOrEqual(2)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(talkText(page, '対象の会話です')).toBeVisible()
  expect(detailCalls.filter((id) => id === 'target').length).toBeGreaterThanOrEqual(2)
})

test('戻る・進むでURLの対象会話を選び直す', async ({ page }) => {
  await prepareInbox(page, {
    details: {
      first: { data: chatDetail('first', '一人目', '一人目の会話') },
      second: { data: chatDetail('second', '二人目', '二人目の会話') },
    },
  })
  await openFriend(page, 'first')
  await expect(talkText(page, '一人目の会話')).toBeVisible()
  await page.evaluate(() => window.history.pushState(null, '', '/chats?friend=second'))
  await expect(talkText(page, '二人目の会話')).toBeVisible()

  await page.goBack()
  await expect(talkText(page, '一人目の会話')).toBeVisible()
  await page.goForward()
  await expect(talkText(page, '二人目の会話')).toBeVisible()
})

test('存在しないfriendでは別人を開かず案内を出し、会話詳細も呼ばない', async ({ page }) => {
  const { detailCalls } = await prepareInbox(page, { friendAccounts: { blocked: 'missing' } })
  await openFriend(page, 'blocked')
  await expect(talkText(page, '会話を開けませんでした')).toBeVisible()
  await expect(page.getByRole('button', { name: '受信箱の一覧へ戻る' })).toBeVisible()
  if (await page.getByRole('button', { name: '一覧を表示' }).isVisible()) {
    await page.getByRole('button', { name: '一覧を表示' }).click()
  }
  await expect(page.getByText('手動選択 次郎', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('手動選択 次郎の会話', { exact: true })).toHaveCount(0)
  expect(detailCalls).not.toContain('blocked')
})

test('会話詳細が失敗しても別人を開かず案内を出す', async ({ page }) => {
  await prepareInbox(page, { details: { broken: { status: 404 } } })
  await openFriend(page, 'broken')
  await expect(talkText(page, '会話を開けませんでした')).toBeVisible()
  await expect(page.getByText('手動選択 次郎の会話', { exact: true })).toHaveCount(0)
})

test('選択中と違うアカウントの友だちは、口が200でも開かず案内を出す', async ({ page }) => {
  const { detailCalls } = await prepareInbox(page, {
    selectedAccount: SELECTED_ACCOUNT,
    friendAccounts: { 'friend-a': OTHER_ACCOUNT },
    details: { 'friend-a': { data: chatDetail('friend-a', 'A社 太郎', 'A社あての問い合わせ') } },
  })
  await openFriend(page, 'friend-a')

  await expect(talkText(page, '会話を開けませんでした')).toBeVisible()
  await expect(page.getByText('いま選んでいるLINEアカウントの相手ではありません')).toBeVisible()
  // 別人の中身はどこにも出ない。
  await expect(page.getByText('A社あての問い合わせ')).toHaveCount(0)
  // 会話詳細そのものを呼んでいない。呼べば見えてしまう。
  expect(detailCalls).not.toContain('friend-a')
  // 送信欄も出さない。出ると送信元B社のまま返信できてしまう。
  await expect(page.getByPlaceholder('メッセージを入力')).toHaveCount(0)

  // 止めているのは画面。口は同じ要求に 200 を返す。
  expect(await apiStatus(page, '/api/chats/friend-a')).toBe(200)
})

test('相手のアカウントに切り替えれば同じURLで開ける', async ({ page }) => {
  const { detailCalls } = await prepareInbox(page, {
    selectedAccount: OTHER_ACCOUNT,
    friendAccounts: { 'friend-a': OTHER_ACCOUNT },
    details: { 'friend-a': { data: chatDetail('friend-a', 'A社 太郎', 'A社あての問い合わせ') } },
  })
  await openFriend(page, 'friend-a')
  await expect(talkText(page, 'A社あての問い合わせ')).toBeVisible()
  expect(detailCalls).toContain('friend-a')
})

test('不正IDでは会話詳細APIを呼ばない', async ({ page }) => {
  const { detailCalls } = await prepareInbox(page)
  await openFriend(page, 'bad/id')
  await expect(talkText(page, '会話を開けませんでした')).toBeVisible()
  expect(detailCalls).toEqual([])
})

test('手動のLINE選択とメール選択で古いdeep-link URLを消す', async ({ page }) => {
  await prepareInbox(page, {
    details: {
      old: { data: chatDetail('old', '古い対象', '古い対象の会話') },
      'manual-chat': { data: chatDetail('manual-chat', '手動選択 次郎', '手動で選んだ会話') },
    },
  })
  await openFriend(page, 'old')
  await expect(talkText(page, '古い対象の会話')).toBeVisible()

  if (await page.getByRole('button', { name: '一覧を表示' }).isVisible()) {
    await page.getByRole('button', { name: '一覧を表示' }).click()
  }
  await page.getByText('手動選択 次郎', { exact: true }).first().click()
  await expect(talkText(page, '手動で選んだ会話')).toBeVisible()
  await expect(page).toHaveURL(`${baseUrl}/chats`)

  await page.evaluate(() => window.history.pushState(null, '', '/chats?friend=old'))
  await expect(talkText(page, '古い対象の会話')).toBeVisible()
  if (await page.getByRole('button', { name: '一覧を表示' }).isVisible()) {
    await page.getByRole('button', { name: '一覧を表示' }).click()
  }
  await page.getByText('メール 花子', { exact: true }).first().click()
  await expect(talkText(page, 'メール本文')).toBeVisible()
  await expect(page).toHaveURL(`${baseUrl}/chats`)
})

test('遅延した旧requestが新しいURL選択を上書きしない', async ({ page }) => {
  let releaseSlow
  const slowReleased = new Promise((resolveSlow) => { releaseSlow = resolveSlow })
  let slowRequested
  const slowStarted = new Promise((resolveStarted) => { slowRequested = resolveStarted })
  await prepareInbox(page, {
    onChatDetail: async ({ id, route }) => {
      if (id === 'slow') {
        slowRequested()
        await slowReleased
        await fulfillJson(route, { success: true, data: chatDetail('slow', '遅い相手', '遅い旧会話') })
        return
      }
      await fulfillJson(route, { success: true, data: chatDetail('fast', '新しい相手', '新しい会話') })
    },
  })

  await openFriend(page, 'slow')
  await slowStarted
  await page.evaluate(() => window.history.pushState(null, '', '/chats?friend=fast'))
  await expect(talkText(page, '新しい会話')).toBeVisible()
  releaseSlow()
  await page.waitForTimeout(100)
  await expect(talkText(page, '新しい会話')).toBeVisible()
  await expect(talkText(page, '遅い旧会話')).toHaveCount(0)
})
