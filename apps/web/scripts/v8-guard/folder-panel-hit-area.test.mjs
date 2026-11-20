import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

/**
 * フォルダの列の「…」は、乗せる前（ホバーなし）でも実ブラウザで押せなければならない。
 * 件数の札が上にあって当たり判定を奪うと、自動操作が timeout する（A14 control-blocked 相当）。
 * 見た目は変えない（選んでいない行は場所を取らず、乗せたら出る）。
 */
const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const css = read('../../src/components/shared/folder-panel.module.css').replace(/:global\(([^)]+)\)/g, '$1')

const markup = (active) => `
<nav aria-label="フォルダ" class="panel rows">
  <div class="row group" ${active ? 'data-active data-has-actions' : 'data-has-actions'}>
    <button type="button" title="資料請求" data-part="folder-row" class="select">
      <span class="folderIcon" aria-hidden="true"></span>
      <span class="label">資料請求</span>
      <span class="count">4</span>
    </button>
    <div class="menu">
      <button type="button" aria-label="フォルダ「資料請求」の操作" title="フォルダ「資料請求」の操作" class="menuButton">…</button>
    </div>
  </div>
</nav>`

const shell = (body) => `<html data-theme="v8"><head><style>${css}
*{box-sizing:border-box}
.panel{width:252px}
.row{display:flex;align-items:center;position:relative;padding:8px}
.select{display:flex;flex:1 1 auto;align-items:center;gap:8px;min-width:0;border:0;background:none;font:13px sans-serif;padding:4px 8px}
.label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.count{flex-shrink:0}
.menuButton{border:0;background:none;font-size:16px}
</style></head><body>${body}</body></html>`

async function hitAt(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="フォルダ「資料請求」の操作"]')
    const r = btn.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { hitButton: hit === btn || (hit && btn.contains(hit)), hitClass: hit ? hit.className : null }
  })
}

test('選んでいない行の「…」はホバーなしでも件数に遮られず当たる', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(shell(markup(false)))
    await page.mouse.move(5, 5)
    const before = await hitAt(page)
    assert.equal(before.hitButton, true, `ホバーなしで「…」が押せない（当たった物: ${before.hitClass}）`)
    // 実クリックでも開く（メニューの中身までは部品の責務外のため開閉は問わない）
    await page.getByRole('button', { name: 'フォルダ「資料請求」の操作' }).click({ timeout: 5000 })
  } finally {
    await browser.close()
  }
})

test('選んだ行の「…」は従来どおり当たる', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(shell(markup(true)))
    await page.mouse.move(5, 5)
    const at = await hitAt(page)
    assert.equal(at.hitButton, true, `選んだ行の「…」が当たらない（当たった物: ${at.hitClass}）`)
  } finally {
    await browser.close()
  }
})
