import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { connectGuardBrowser } from './browser-session.mjs'
import { stubApi } from './speed-budget.mjs'
import { mockFetch } from './mock-local.mjs'

const base = process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310'
const output = process.env.LEDGER_SHOTS
const screens = [
  ['reservations', '予約台帳'],
  ['tables', '座席・卓管理'],
  ['inventory', '予約枠・在庫'],
]

test('飲食店3画面は共通タブなしで左メニューと画面内の行き先から移動できる', async () => {
  const browser = await connectGuardBrowser()
  try {
    if (output) await mkdir(output, { recursive: true })
    for (const width of [1440, 1152]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
      try {
        await page.addInitScript(() => {
          const NativeDate = Date
          window.Date = class extends NativeDate {
            constructor(...args) { super(...(args.length ? args : ['2026-10-01T03:00:00.000Z'])) }
            static now() { return new NativeDate('2026-10-01T03:00:00.000Z').getTime() }
          }
          for (const [key, value] of Object.entries({ lh_csrf: 'visual-qa-csrf', lh_staff_role: 'owner', lh_staff_name: 'K', lh_staff_permissions: '[]', lh_staff_view_permissions: '[]', lh_selected_account: 'visual-qa-account', lh_auth_selection_cleared: '1' })) localStorage.setItem(key, value)
        })
        let hasActiveTables = true
        await stubApi(page, async (method, path) => {
          const response = await mockFetch(method, path)
          const pathname = new URL(path, base).pathname
          if (pathname === '/api/dashboard/style') {
            const body = JSON.parse(response.body)
            body.data.style = 'restaurant'
            body.data.styleSelected = true
            return { ...response, body: JSON.stringify(body) }
          }
          if (pathname === '/api/restaurant-test/snapshot' && !hasActiveTables) {
            const body = JSON.parse(response.body)
            body.data.tables = body.data.tables.map(table => ({ ...table, is_active: 0 }))
            return { ...response, body: JSON.stringify(body) }
          }
          return response
        })
        for (const [route, title] of screens) {
          await page.goto(`${base}/restaurant-test/${route}`, { waitUntil: 'networkidle' })
          await page.getByRole('heading', { name: title, exact: true }).waitFor()
          await page.evaluate(() => document.fonts.ready)
          assert.equal(await page.getByRole('tablist', { name: '店の中の画面' }).count(), 0)
          for (const [target, label] of screens) {
            const link = page.locator('aside').getByRole('link', { name: label, exact: true })
            assert.equal(await link.getAttribute('href'), `/restaurant-test/${target}`)
          }
          const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, width: innerWidth }))
          assert.ok(size.content <= size.width, `${route}/${width}: horizontal overflow`)
          if (output) await page.screenshot({ path: resolve(output, `${route}-${width}.png`), fullPage: true })
        }
        await page.getByRole('heading', { name: '営業日の基本配分', exact: true }).waitFor()
        await page.getByRole('button', { name: '基本配分をまとめて変更', exact: true }).waitFor()
        await page.locator('aside').getByRole('link', { name: '座席・卓管理', exact: true }).click()
        await page.waitForURL('**/restaurant-test/tables')
        await page.getByRole('heading', { name: '座席・卓管理', exact: true }).waitFor()

        hasActiveTables = false
        await page.goto(`${base}/restaurant-test/inventory`, { waitUntil: 'networkidle' })
        await page.getByText('有効な卓がありません。座席・卓管理で卓を有効にしてください。').waitFor()
        await page.getByRole('link', { name: '座席・卓管理で変える →', exact: true }).click()
        await page.waitForURL('**/restaurant-test/tables')
        await page.getByRole('heading', { name: '座席・卓管理', exact: true }).waitFor()
        await page.locator('aside').getByRole('link', { name: '予約台帳', exact: true }).click()
        await page.waitForURL('**/restaurant-test/reservations')
        await page.getByRole('heading', { name: '予約台帳', exact: true }).waitFor()
      } finally { await page.close() }
    }
  } finally { await browser.close() }
})
