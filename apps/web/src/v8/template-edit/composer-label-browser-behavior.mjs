// 手動の実ブラウザ検査。画面サーバーを起動し COMPOSER_BROWSER_BASE を指定して実行する。
import test from 'node:test'
import assert from 'node:assert/strict'
import { connectGuardBrowser } from '../../../scripts/v8-guard/browser-session.mjs'
import { mockFetch } from '../../../scripts/v8-guard/mock-local.mjs'
import { stubApi } from '../../../scripts/v8-guard/speed-budget.mjs'
import { PARITY_INIT } from '../../../../../scripts/visual-qa/v8-parity.mjs'

for (const width of [1024, 1152, 1440]) {
  test(`吹き出しのテンプレート保存は折り返さず操作できる ${width}`, async () => {
    const browser = await connectGuardBrowser()
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ja-JP' })
    try {
      const page = await context.newPage()
      await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, PARITY_INIT)
      await stubApi(page, (method, path) => mockFetch(method, path))
      await page.goto(`${process.env.COMPOSER_BROWSER_BASE ?? 'http://127.0.0.1:4323'}/broadcasts/new?step=message`, { waitUntil: 'domcontentloaded' })
      await page.getByRole('tab', { name: 'リッチメッセージ' }).first().click()
      await page.getByRole('button', { name: 'ここで作る' }).first().click()
      const label = page.getByText('テンプレートとしても保存する', { exact: true }).first()
      await label.waitFor({ timeout: 30000 })
      const insert = page.getByRole('button', { name: 'この吹き出しに入れる' })
      const switcher = page.getByRole('switch', { name: 'テンプレートとしても保存する' })
      const oneLine = async () => {
        const lines = await label.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length })
        assert.equal(lines, 1, 'テンプレート保存の文字を1行に保つ')
        const [labelBox, buttonBox, groupBox, footerBox] = await Promise.all([label.boundingBox(), insert.boundingBox(), insert.locator('..').boundingBox(), page.locator('[data-window-actions]').last().boundingBox()])
        assert.ok(labelBox && buttonBox && labelBox.x + labelBox.width <= buttonBox.x, '文字と挿入ボタンを重ねない')
        assert.ok(groupBox && footerBox && Math.abs((groupBox.x + groupBox.width / 2) - (footerBox.x + footerBox.width / 2)) <= 4, '操作の組を帯の中央に置く')
      }
      assert.equal(await insert.isDisabled(), true, '画像がない間は挿入できない')
      await oneLine()
      await page.getByRole('textbox', { name: '画像のURL' }).fill('https://example.com/sample.png')
      await insert.waitFor({ state: 'visible' })
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent?.includes('この吹き出しに入れる') && !b.disabled))
      await oneLine()
      await switcher.click()
      assert.equal(await switcher.getAttribute('aria-checked'), 'true', '保存の切り替えを操作できる')
    } finally {
      await context.close()
      await browser.close()
    }
  })
}
