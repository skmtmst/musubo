// 手動の実ブラウザ検査。画面サーバーを起動し REMINDER_BROWSER_BASE を指定して実行する。
import test from 'node:test'
import assert from 'node:assert/strict'
import { connectGuardBrowser } from '../../../scripts/v8-guard/browser-session.mjs'
import { mockFetch } from '../../../scripts/v8-guard/mock-local.mjs'
import { stubApi } from '../../../scripts/v8-guard/speed-budget.mjs'
import { PARITY_INIT } from '../../../../../scripts/visual-qa/v8-parity.mjs'

for (const width of [390, 430, 1152]) {
  test(`リマインダの名前と残りの操作に届く ${width}`, async () => {
    const browser = await connectGuardBrowser()
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ja-JP' })
    try {
      const page = await context.newPage()
      await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, PARITY_INIT)
      await stubApi(page, (method, path) => mockFetch(method, path))
      await page.goto(`${process.env.REMINDER_BROWSER_BASE ?? 'http://127.0.0.1:4323'}/reminders`, { waitUntil: 'domcontentloaded' })
      const row = page.locator('tbody tr').first()
      await row.waitFor({ timeout: 30000 })
      const frame = page.locator('[data-shared-part="list-table"]').filter({ has: row })
      const name = row.locator('td').nth(2).locator('a')
      await name.waitFor({ timeout: 5000 })
      const first = await name.evaluate(el => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, width: r.width, text: el.textContent }
      })
      assert.ok(first.text?.trim(), '名前が空でない')
      assert.ok(first.width >= 110, `名前の幅: ${first.width}`)
      assert.ok(first.left >= 0 && first.right <= width, '名前を最初に表示する')
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'ページ全体は横にはみ出さない')
      if (width < 640) {
        const before = await frame.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }))
        assert.ok(before.scroll > before.client, '残りの列へ横に送れる')
        assert.equal(await frame.evaluate(el => getComputedStyle(el).overflowX), 'auto', '表内の横送りが有効')
        await frame.evaluate(el => { el.scrollLeft = el.scrollWidth })
        assert.ok(await frame.evaluate(el => el.scrollLeft > 0), '表を実際に横へ送れる')
        const menu = row.getByRole('button', { name: /の操作/ })
        const [box, frameBox] = await Promise.all([menu.boundingBox(), frame.boundingBox()])
        assert.ok(box && frameBox && box.x >= frameBox.x && box.x + box.width <= frameBox.x + frameBox.width + 1, '最後の操作にも届く')
      } else {
        const sizes = await frame.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }))
        assert.ok(sizes.scroll <= sizes.client + 1, 'PCでは横に送らない')
      }
    } finally {
      await context.close()
      await browser.close()
    }
  })
}
