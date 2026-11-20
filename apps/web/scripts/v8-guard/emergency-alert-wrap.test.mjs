import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

/**
 * 運用状態の警告の要旨は途中で切らず、全文を見せる。
 * 1行に収めると後ろの日時（「10月2日 10:15〜」の続き）が隠れてしまう。
 */
const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const css = read('../../src/v8/settings/emergency/screen.module.css').replace(/:global\(([^)]+)\)/g, '$1')

const shell = (text) => `<html data-theme="v8"><head><style>${css}
*{box-sizing:border-box}
.alertLine{display:flex;align-items:center;gap:8px;width:420px;border:1px solid #ccc;padding:8px}
</style></head><body><main><div class="alertLine"><span>●</span><p class="alertText" title="詳細">${text}</p></div></main></body></html>`

test('警告の要旨は折り返して全文を見せる', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1152, height: 800 } })
    await page.setContent(shell('EC連携・外部連携：取り込みが3件失敗（10月2日 10:15〜10月3日 09:00）'))
    const clipped = await page.locator('.alertText').evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    assert.equal(clipped, false, '要旨が欠けて見えないこと')
    assert.equal(await page.locator('.alertText').innerText(), 'EC連携・外部連携：取り込みが3件失敗（10月2日 10:15〜10月3日 09:00）')
  } finally {
    await browser.close()
  }
})
