import test from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from '@playwright/test'

/**
 * 接続ガイドの図の説明と図の注のリンクは途中で折らない。
 * 「画像を拡大」が「画像を拡／大」と切れると押しにくい。
 */
const page = new URL('../../public/manuals/line-connect/index.html', import.meta.url).href

test('図の説明と図の注のリンクは1行に収まる', async () => {
  const browser = await chromium.launch()
  try {
    for (const width of [1152, 1440]) {
      const view = await browser.newPage({ viewport: { width, height: 900 } })
      await view.goto(page, { waitUntil: 'load', timeout: 30000 })
      const wrapped = await view.evaluate(() => {
        const out = []
        for (const a of document.querySelectorAll('figcaption a, .diagram-note a')) {
          if (a.getClientRects().length > 1) out.push(a.textContent.slice(0, 20))
        }
        return out
      })
      assert.deepEqual(wrapped, [], `${width}px で折れたリンク`)
      await view.close()
    }
  } finally {
    await browser.close()
  }
})
