import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectGuardBrowser } from './browser-session.mjs'
import { PARITY_INIT } from '../../../../scripts/visual-qa/v8-parity.mjs'
import { stubApi } from './speed-budget.mjs'
import { mockFetch } from './mock-local.mjs'

/*
 * 一覧の名前を押したら詳細が開く（F1・本物の静的出力で見る）。
 *
 * 統括のタグ・テンプレート・回答フォームで、名前を押すと URL だけ
 * `?item=…&mode=detail` に変わり、画面は一覧のままだった（再読込では開く）。
 * 行のリンクが同じ画面の URL へ client 遷移するだけで、開く処理が
 * 動かない物を見つける。店の一覧（別画面の詳細へ行く物）も同じ目で見る。
 *
 * 省いた物：/affiliates・/conversions（名前で引き出しを開き一覧は残る別形）、
 * /staff・/accounts・/line-notifications・/common-actions・/contents
 * （偽APIに行が無く押す名前が無い。行が増えたら足す）。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../out')
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }

/** 偽APIの応答に統括の利用範囲を足す（統括の画面の入口の鍵）。 */
async function hqFetch(method, path) {
  const tagDetail = /^\/api\/hq\/templates\/(visual-hq-tpl-tag-[^/?]+)$/.exec(path)
  if (tagDetail && method === 'GET') {
    // 偽APIのタグ詳細はメッセージの形しか無い。開く動作だけ見るため形を補う。
    const answered = await mockFetch(method, path)
    try {
      const json = JSON.parse(answered.body)
      if (json?.data?.template) {
        json.data.definition = {
          schemaVersion: 1,
          tag: { name: json.data.template.name, description: null, manualAssignmentAllowed: true },
          folders: [],
        }
        return { ...answered, body: JSON.stringify(json) }
      }
    } catch { /* 補えない時は偽APIのまま */ }
    return answered
  }
  const answered = await mockFetch(method, path)
  if (!path.startsWith('/api/staff/me')) return answered
  try {
    const json = JSON.parse(answered.body)
    if (json?.data) json.data.accountScope = 'all'
    return { ...answered, body: JSON.stringify(json) }
  } catch { return answered }
}

const ROUTES = [
  '/hq/templates', '/hq/friend-attributes', '/hq/form-submissions', '/hq/rich-menus',
  '/friends', '/tags', '/tags?tab=fields', '/tags?tab=marks', '/tags?tab=searches',
  '/templates', '/form-submissions', '/broadcasts', '/scenarios', '/rich-menus',
  '/webhooks', '/events', '/automations', '/auto-replies', '/inflow-links',
  '/webinars', '/contents/vars', '/nen-campaigns', '/friend-add-settings',
]

let server, base
before(async () => {
  assert.ok(existsSync(join(root, 'version.json')), '本物の静的出力を先に組み立てる')
  server = createServer((req, res) => {
    const path = resolve(root, `.${new URL(req.url, 'http://localhost').pathname}`)
    const file = [path, `${path}.html`, join(path, 'index.html')].find(file => file.startsWith(`${root}/`) && existsSync(file) && statSync(file).isFile())
    if (!file) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise(done => server.close(done)))

async function openList(browser, route) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  await stubApi(page, hqFetch)
  await page.addInitScript((init) => {
    for (const [key, value] of Object.entries(init)) localStorage.setItem(key, value)
  }, PARITY_INIT)
  const response = await page.goto(`${base}${route}`)
  assert.ok(response?.ok(), `${route} が開けない`)
  await page.waitForLoadState('networkidle')
  return page
}

/** 押した名前の行が画面から外れる・別画面へ行く・窓が開くのどれか。 */
async function openedDetail(page, handle, listUrl, hadDialog) {
  const deadline = Date.now() + 8000
  for (;;) {
    const state = await page.evaluate(() => ({
      url: location.href,
      dialog: Boolean(document.querySelector('[role="dialog"], [data-dialog], [data-drawer]')),
    })).catch(() => null)
    if (!state) return 'navigated'
    const detached = await handle.evaluate((el) => !el.isConnected).catch(() => true)
    // 窓は「押したあとに新しく現れた」ものだけ数える（前からある窓での見逃しを防ぐ）。
    if (detached || new URL(state.url).pathname !== new URL(listUrl).pathname || (state.dialog && !hadDialog)) return 'opened'
    if (state.url !== listUrl && Date.now() > deadline - 4000) {
      // URL だけ変わって止まった（F1 の形）。少し待って確定させる。
      await page.waitForTimeout(500)
      const again = await handle.evaluate((el) => !el.isConnected).catch(() => true)
      if (!again) return 'stuck'
    }
    if (Date.now() > deadline) return state.url === listUrl ? 'no-navigation' : 'stuck'
    await page.waitForTimeout(200)
  }
}

test('一覧の名前を押したら一覧のままにならず詳細が開く', async () => {
  const browser = await connectGuardBrowser()
  try {
    const failures = []
    for (const route of ROUTES) {
      const page = await openList(browser, route)
      try {
        const links = page.locator('a[data-row-link]')
        // 読み込み直後の空欄を判定せず、偽APIの行が描画されるまで待つ。
        await links.first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {})
        await page.waitForLoadState('networkidle')
        const count = await links.count()
        // 行が無い画面があっても後ろの画面まで見て、最後にまとめて落とす。
        if (count === 0) { const main = page.locator('main'); const text = (await (await main.count() ? main.first() : page.locator('body')).innerText()).replace(/\s+/g, ' ').slice(0, 500); failures.push(`${route} に押せる名前が無い（偽APIの行を確認）: ${text}`); continue }
        const first = links.first()
        await first.scrollIntoViewIfNeeded()
        const handle = await first.elementHandle()
        const listUrl = page.url()
        const hadDialog = await page.evaluate(() => Boolean(document.querySelector('[role="dialog"], [data-dialog], [data-drawer]'))).catch(() => false)
        assert.ok(await handle.evaluate(el => el.isConnected), `${route}: 押す前に行が消えた`)
        await handle.click()
        const result = await openedDetail(page, handle, listUrl, hadDialog)
        console.log(`${route}: ${count}行 → ${result} ${page.url().replace(base, '')}`)
        if (result !== 'opened' && result !== 'navigated') failures.push(`${route} は ${result}（${page.url().replace(base, '')}）`)
      } finally { await page.close() }
    }
    assert.deepEqual(failures, [])
  } finally { await browser.close() }
})
