/** 作業の外部追試を移植。実ビルド＋既存見本APIで取消失敗とマウス操作を確認する。 */
import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stubApi } from './speed-budget.mjs'
import { mockFetch } from './mock-local.mjs'

const [base = 'http://127.0.0.1:4397', out = '/tmp/stgfix17-browser'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const results = []
let fatal = null
async function open(width, route) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/api/entry-routes') page.__stgfix17ApiOrigin = url.origin
  })
  await page.route('**/*', r => new URL(r.request().url()).origin === new URL(base).origin ? r.continue() : r.abort())
  await stubApi(page, mockFetch)
  await page.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'visual-qa-account')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
    sessionStorage.setItem('lh_visual_qa_capture', '1')
    window.__stgfix17CopiedUrl = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async value => { window.__stgfix17CopiedUrl = value } },
    })
  })
  if (route) await page.goto(new URL(route, base).href, { waitUntil: 'networkidle' })
  return page
}
try {
  for (const width of [1152, 1440, 1920]) {
    const page = await open(width, '/inflow-links')
    const menu = page.getByRole('button', { name: '「夏のInstagram投稿」の操作', exact: true })
    await expect(menu).toBeVisible()
    const geometry = await menu.evaluate(el => {
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { x: r.x, buttonWidth: r.width, hitInside: !!hit && el.contains(hit), hitText: hit?.textContent?.trim() }
    })
    let error = null
    try {
      assert.equal(geometry.hitInside, true, '「…」の中央は別の列に遮られない')
      await menu.click({ timeout: 1500 })
      await expect(page.getByRole('menuitem', { name: 'QRコードを見る', exact: true })).toBeVisible()
      const copy = page.getByRole('menuitem', { name: '夏のInstagram投稿のURLをコピー', exact: true })
      await expect(copy).toBeVisible()
      await copy.click()
      await expect.poll(() => page.evaluate(() => window.__stgfix17CopiedUrl)).toMatch(/\/r\/[^/?#]+$/)
      const copiedUrl = new URL(await page.evaluate(() => window.__stgfix17CopiedUrl))
      assert.ok(page.__stgfix17ApiOrigin, '対象アカウントの流入経路APIを読み込んだ')
      assert.equal(copiedUrl.href, `${page.__stgfix17ApiOrigin}/r/summer-ig`, '対象行の発行URLの全文をコピーする')
    } catch (caught) { error = caught.message }
    await page.keyboard.press('Escape')
    await menu.focus(); await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem', { name: 'QRコードを見る', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.screenshot({ path: join(out, `inflow-${width}.png`) })
    results.push({ kind: 'inflow-menu', width, ...geometry, error })
    await page.close()
  }
  for (const kind of ['network', 'conflict409']) {
    const page = await open(1440)
    let reads = 0, deletes = 0, revision = null
    await page.route('**/api/restaurant-test/seat-waitlist**', async r => {
      if (r.request().method() === 'DELETE') {
        deletes++
        revision = new URL(r.request().url()).searchParams.get('expectedConfirmationRevision')
        return kind === 'network' ? r.abort('failed') : r.fulfill({ status: 409, json: { success: false, error: '状態が変わりました' } })
      }
      reads++
      await r.fulfill({ json: { success: true, data: { waitlist: [{ id: 'fixture-wait', confirmation_revision: 1, customer_name: '検証用', status: 'waiting', starts_at: '2026-10-20T01:00:00Z', guest_count: 2 }] } } })
    })
    await page.goto(new URL('/restaurant-test/reservations', base).href, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '予約台帳のその他操作', exact: true }).click()
    await page.getByRole('menuitem', { name: 'キャンセル待ちを見る', exact: true }).click()
    await page.getByRole('button', { name: '取り消す', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: 'キャンセル待ちを取り消しますか？' })
    await dialog.getByRole('button', { name: '取り消す', exact: true }).click()
    await expect.poll(() => reads).toBeGreaterThanOrEqual(2)
    let error = null
    try {
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('alert')).toContainText(kind === 'network' ? '通信' : '状態が変わった')
      assert.equal(deletes, 1)
      assert.equal(revision, '1')
    } catch (caught) { error = caught.message }
    results.push({ kind: `waitlist-${kind}`, reads, deletes, error })
    await page.screenshot({ path: join(out, `waitlist-${kind}.png`) })
    await page.close()
  }
} catch (caught) {
  fatal = caught.message
  console.error(fatal)
  process.exitCode = 1
} finally {
  writeFileSync(join(out, 'results.json'), JSON.stringify({ complete: results.length === 5 && !fatal, fatal, results }, null, 2) + '\n')
  await browser.close()
}
console.log(results)
if (results.length !== 5 || results.some(r => r.error)) {
  console.error('取消の理由が残り、全幅で操作メニューを押せることを確認できませんでした')
  process.exitCode = 1
}
