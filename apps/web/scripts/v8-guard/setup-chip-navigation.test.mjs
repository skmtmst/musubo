import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { connectGuardBrowser } from './browser-session.mjs'
import { openPage } from './browser-env.mjs'
import { stubApi } from './speed-budget.mjs'
import { mockFetch } from './mock-local.mjs'

const baseUrl = process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310'
const output = process.env.V8_GUARD_ARTIFACT_DIR
const headers = { 'access-control-allow-origin': baseUrl, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-csrf-token' }

test('開店準備の札は直接開いた画面でも進捗を示し、完了・非表示では消える', { timeout: 120000 }, async () => {
  const browser = await connectGuardBrowser()
  try {
    for (const scenario of ['normal', 'done', 'dismissed']) {
      for (const [route, width] of scenario === 'normal' ? [['/tags', 1440], ['/friends', 1152]] : [['/tags', 1440]]) {
        let reads = 0
        const prepared = { newPage: async options => {
          const page = await browser.newPage(options)
          await stubApi(page, mockFetch)
          await page.route('**/api/getting-started?**', async request => {
            if (request.request().method() === 'OPTIONS') return request.fulfill({ status: 204, headers })
            reads += 1
            const url = new URL(request.request().url())
            const response = await mockFetch('GET', `${url.pathname}${url.search}`)
            const data = JSON.parse(response.body)
            data.data.dismissed = scenario === 'dismissed'
            if (scenario === 'done') { data.data.steps = data.data.steps.map(step => ({ ...step, state: 'done' })); data.data.allDone = true }
            await request.fulfill({ status: 200, headers, json: data })
          })
          if (scenario === 'done') {
            await page.route('**/api/restaurant-test/google/connection?**', request => request.fulfill({ status: 200, headers, json: { success: true, store: { lineAccountId: 'visual-qa-account' }, connection: { status: 'connected', locationName: '店舗' } } }))
            await page.route('**/api/restaurant-test/google/profile?**', request => request.fulfill({ status: 200, headers, json: { success: true, store: { lineAccountId: 'visual-qa-account' }, closed: false, profile: { regularHours: { MONDAY: [{ open: '09:00', close: '18:00' }] } } } }))
          }
          return page
        } }
        const page = await openPage(prepared, { baseUrl, route, width, height: 900, settleMs: 2500, requireSuccess: true })
        const chip = page.getByRole('link', { name: /開店準備/ }).filter({ visible: true })
        assert.equal(reads, 1, `${scenario}: 最初の取得は1回`)
        if (scenario === 'normal') {
          assert.equal(await chip.count(), 1)
          if (output) { mkdirSync(output, { recursive: true }); await page.screenshot({ path: join(output, `setup-chip-${route.slice(1)}-${width}.png`) }) }
          await page.getByRole('link', { name: route === '/tags' ? '友だち' : 'タグ', exact: true }).first().click()
          await page.waitForTimeout(1200)
          assert.equal(reads, 1, '画面を切り替えても再取得しない')
          await page.getByRole('link', { name: /開店準備/ }).filter({ visible: true }).click()
          await page.waitForURL('**/getting-started')
          await page.waitForTimeout(1200)
          assert.equal(reads, 1, 'はじめの設定でも取得済みの値を使う')
          const count = await page.getByRole('link', { name: /開店準備/ }).filter({ visible: true }).innerText()
          const progress = await page.getByRole('note').first().innerText()
          assert.ok(progress.replaceAll(' ', '').includes(count.replace('開店準備 ', '')))
        } else assert.equal(await chip.count(), 0, scenario)
        await page.close()
      }
    }
  } finally { await browser.close() }
})
