import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectGuardBrowser } from './browser-session.mjs'
import { stubApi } from './speed-budget.mjs'
import { mockFetch } from './mock-local.mjs'
import { trackPendingApiRequests, waitForNavigationContent } from './navigation-content-ready.mjs'
import { PARITY_INIT } from '../../../../scripts/visual-qa/v8-parity.mjs'
import { styleDashboardMock } from '../../../../scripts/visual-qa/style-dashboard-mock.mjs'

const base = process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310'
const output = process.env.V8_GUARD_ARTIFACT_DIR
const storeFixture = JSON.parse((await mockFetch('GET', '/api/restaurant-test/stores')).body).data.stores
styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style: 'restaurant' })
const screens = [
  ['/restaurant-test/menu', 'メニュー管理'],
  ['/restaurant-test/inventory', '予約枠・在庫'],
  ['/restaurant-test/reservations', '予約台帳'],
  ['/restaurant-test/tables', '座席・卓管理'],
  ['/restaurant-test/tables?view=assign', '座席・卓管理'],
  ['/restaurant-test/line-followup', 'LINE来店フォロー'],
  // Googleは右上の共通LINEアカウント選択を使い、店舗数にかかわらず独自の欄を出さない。
  ['/restaurant-test/google', 'Googleビジネス', 0],
  ['/restaurant-test/delivery', 'デリバリー受注'],
  ['/settings/booking-media', '予約サイト・グルメ媒体'],
]

function measureHeading() {
  const rect = element => {
    const r = element.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
  }
  const title = document.querySelector('main h1')
  const pickers = [...document.querySelectorAll('main [data-entity-picker-field]')]
    .filter(element => !element.parentElement.closest('[data-entity-picker-field]'))
    .filter(element => element.querySelector('button[aria-label="店舗"]'))
    .filter(element => getComputedStyle(element).visibility === 'visible')
    .map(rect).filter(r => r.width > 0 && r.height > 0)
  return { title: title ? rect(title) : null, text: title?.textContent, pickers, width: innerWidth, scrollWidth: document.documentElement.scrollWidth }
}

function assertHeading(row, expected) {
  assert.equal(row.text, expected)
  assert.ok(row.title?.width > 0 && row.title.height > 0, `題の幅がありません: ${JSON.stringify(row)}`)
  assert.ok(row.title.x >= 0 && row.title.right <= row.width + 1, `題が画面を超えました: ${JSON.stringify(row)}`)
  assert.ok(row.scrollWidth <= row.width + 1, `横にはみ出しました: ${JSON.stringify(row)}`)
  for (const picker of row.pickers) {
    assert.ok(picker.right <= row.width + 1, `店舗欄が画面を超えました: ${JSON.stringify(row)}`)
    const intersects = Math.min(row.title.right, picker.right) > Math.max(row.title.x, picker.x)
      && Math.min(row.title.bottom, picker.bottom) > Math.max(row.title.y, picker.y)
    assert.equal(intersects, false, `題と店舗欄が重なりました: ${JSON.stringify(row)}`)
  }
}

for (const width of [1152, 1440]) test(`店舗数と長い名前でも題を隠さず、故障を検出して復元する ${width}`, async () => {
  const browser = await connectGuardBrowser()
  const rows = []
  try {
    for (const state of ['multiple', 'long', 'single']) {
      const page = await browser.newPage({ viewport: { width, height: 1080 }, reducedMotion: 'reduce' })
      const pending = trackPendingApiRequests(page), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, PARITY_INIT)
      await stubApi(page, async (method, path) => {
        const response = await mockFetch(method, path)
        if (method === 'GET') {
          const body = JSON.parse(response.body)
          // Googleの口だけはdataで包まず返る。省略可能な店舗一覧も同じ実在の模擬店舗で補う。
          const data = body.data ?? body
          if (new URL(path, base).pathname === '/api/restaurant-test/google/connection') data.stores ??= storeFixture
          if (data.stores?.length) {
            // 媒体設定は選択中LINEアカウントに紐づく店だけを表示する。見本もその読取契約に合わせる。
            if (new URL(path, base).pathname === '/api/restaurant-test/stores') {
              const accountId = new URL(path, base).searchParams.get('account_id')
              assert.ok(accountId, '店舗一覧は選択中アカウントで読む')
              data.stores = data.stores.map(store => ({ ...store, line_account_id: accountId }))
            }
            data.stores = state === 'single' ? data.stores.slice(0, 1) : data.stores
            if (state === 'long') data.stores = data.stores.map(store => ({ ...store, name: store.name + '・駅前の予約とお食事を承る店舗' }))
          }
          response.body = JSON.stringify(body)
        }
        return response
      })
      try {
        for (const [path, expected, pickerCount] of screens) {
          const response = await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded' })
          assert.ok(response?.ok(), path)
          await waitForNavigationContent(page, pending)
          await page.getByRole('heading', { name: expected, exact: true }).waitFor({ state: 'attached' })
          const row = { path, state, ...await page.evaluate(measureHeading) }
          rows.push(row)
          if (output) {
            mkdirSync(output, { recursive: true })
            await page.screenshot({ path: join(output, `${width}-${state}-${path.replace(/[^a-z0-9]/gi, '-')}.png`) })
          }
          assertHeading(row, expected)
          assert.equal(row.pickers.length, pickerCount ?? (state === 'single' ? 0 : 1), `${path}: 店舗欄の表示`)
          if (path === '/restaurant-test/menu' && state === 'long') {
            await page.getByRole('button', { name: '店舗', exact: true }).click()
            const dialog = page.getByRole('dialog', { name: '店舗を選ぶ', exact: true })
            await dialog.waitFor()
            const box = await dialog.boundingBox()
            assert.ok(box.width > 210 && box.x >= 0 && box.x + box.width <= width, '候補の窓は店舗欄の幅で縮めない')
            if (output) await page.screenshot({ path: join(output, `${width}-long-picker-open.png`) })
            await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
          }
          if (path === '/restaurant-test/menu' && state === 'multiple') {
            // 包みを外して、幅いっぱいの欄が題と同じflexの段に入る故障を再現する。
            await page.evaluate(() => {
              const picker = document.querySelector('main [data-entity-picker-field]')
              picker.parentElement.replaceWith(picker)
            })
            const broken = await page.evaluate(measureHeading)
            assert.throws(() => assertHeading(broken, expected), /題の幅|重なり|超え|はみ出し/)
            rows.push({ path, state: 'fault', ...broken })
            if (output) await page.screenshot({ path: join(output, `${width}-fault.png`) })
            await page.reload({ waitUntil: 'domcontentloaded' })
            await waitForNavigationContent(page, pending)
            const restored = { path, state: 'restored', ...await page.evaluate(measureHeading) }
            rows.push(restored)
            assertHeading(restored, expected)
            if (output) await page.screenshot({ path: join(output, `${width}-restored.png`) })
          }
        }
        assert.deepEqual(errors, [])
      } finally { await page.close() }
    }
  } finally {
    if (output) {
      mkdirSync(output, { recursive: true })
      writeFileSync(join(output, `store-heading-${width}.json`), JSON.stringify(rows, null, 2))
    }
    await browser.close()
  }
})
