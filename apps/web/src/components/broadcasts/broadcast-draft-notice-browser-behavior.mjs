// 手動の実ブラウザ検査。画面サーバーを起動し BROADCAST_BROWSER_BASE を指定して実行する。
import test from 'node:test'
import assert from 'node:assert/strict'
import { connectGuardBrowser } from '../../../scripts/v8-guard/browser-session.mjs'
import { mockFetch } from '../../../scripts/v8-guard/mock-local.mjs'
import { stubApi } from '../../../scripts/v8-guard/speed-budget.mjs'
import { PARITY_INIT } from '../../../../../scripts/visual-qa/v8-parity.mjs'

for (const width of [1152, 1440]) {
  test(`下書きを開いた案内は本文の余白に収まる ${width}`, async () => {
    const browser = await connectGuardBrowser()
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP' })
    try {
      const page = await context.newPage()
      await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, PARITY_INIT)
      await stubApi(page, (method, path) => mockFetch(method, path))
      await page.goto(`${process.env.BROADCAST_BROWSER_BASE ?? 'http://127.0.0.1:4323'}/broadcasts/new?draft=visual-confirm&step=basic`, { waitUntil: 'domcontentloaded' })
      const note = page.getByText(/保存済みの下書き.*を開いています/)
      await note.waitFor({ timeout: 30000 })
      const [noteBox, bodyBox, rootBox] = await Promise.all([
        note.boundingBox(), page.locator('#broadcast-step-basic').boundingBox(), page.locator('[data-design-node="FU2aU"]').boundingBox(),
      ])
      assert.ok(noteBox && bodyBox && rootBox, '案内と本文がある')
      assert.ok(Math.abs(noteBox.x - bodyBox.x) <= 1, '案内と本文の左端をそろえる')
      assert.ok(Math.abs((rootBox.x + rootBox.width) - (noteBox.x + noteBox.width) - 24) <= 1, '案内の右側にも本文と同じ余白を置く')
    } finally {
      await context.close()
      await browser.close()
    }
  })
}
