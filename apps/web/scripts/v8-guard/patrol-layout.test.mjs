import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectGuardBrowser } from './browser-session.mjs'
import { mockFetch } from './mock-local.mjs'
import { stubApi } from './speed-budget.mjs'
import { trackPendingApiRequests, waitForNavigationContent } from './navigation-content-ready.mjs'
import { PARITY_INIT } from '../../../../scripts/visual-qa/v8-parity.mjs'
import { scanPatrolLayout } from './patrol-layout-browser.mjs'
import { scanLayoutOverflow } from './layout-overflow.mjs'
import scanLayoutDefects from './layout-defects-browser.mjs'
import { styleDashboardMock } from '../../../../scripts/visual-qa/style-dashboard-mock.mjs'

const base = process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310'
const output = join(process.env.V8_GUARD_ARTIFACT_DIR || '/tmp/v8-guard', 'patrol-layout')
const settingsPaths = ['/settings/customer-look', '/getting-started', '/accounts', '/pools', '/staff', '/staff/new', '/staff/edit?id=stf-1', '/settings', '/emergency', '/ec-commerce', '/settings/sns', '/settings/booking-media', '/settings/delivery']

for (const width of [1024, 1152, 1440]) test(`settings navigation ${width}`, async () => {
  await withPage(width, `settings-${width}`, async (page, pending, dir, rows) => {
    for (const [index, path] of settingsPaths.entries()) {
      styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style: path === '/ec-commerce' ? 'ec' : 'restaurant' })
      await page.goto(base + path, { waitUntil: 'domcontentloaded' })
      await waitForNavigationContent(page, pending, 15000)
      assert.equal(new URL(page.url()).pathname, new URL(path, base).pathname)
      await page.evaluate(async () => { await document.fonts.ready; await Promise.allSettled(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished)) })
      const normal = await page.evaluate(scanPatrolLayout, 'settings')
      const overflow = await page.evaluate(scanLayoutOverflow), defects = await page.evaluate(scanLayoutDefects)
      rows.push({ path, normal, overflow, defects })
      await page.screenshot({ animations: 'disabled', path: join(dir, `${index}-normal.png`) })
      assert.deepEqual(normal, [], path)
      assert.equal(overflow.pageX, false, path)
      for (const [kind, findings] of Object.entries(overflow)) if (Array.isArray(findings)) assert.deepEqual(findings, [], `${path} ${kind}`)
      assert.deepEqual(defects, [], `${path} 切れ・重なり`)
    }
    // 全幅の入口を含む巡回とは分け、設定の列を持つ入口で故障を入れる。
    await page.goto(base + '/settings', { waitUntil: 'domcontentloaded' })
    await waitForNavigationContent(page, pending, 15000)
    const nav = page.locator('[data-settings-nav]:visible')
    assert.equal(await nav.count(), 1)
    await nav.evaluate(node => { node.setAttribute('style', 'display:flex;flex-direction:row!important') })
    const broken = await page.evaluate(scanPatrolLayout, 'settings')
    assert.ok(broken.some(item => item.kind === 'settings-navigation-band'))
    await nav.evaluate(node => node.removeAttribute('style'))
    const restored = await page.evaluate(scanPatrolLayout, 'settings')
    rows.push({ broken, restored }); assert.deepEqual(restored, [])
    await page.locator('main').evaluate(node => { const fault = document.createElement('div'); fault.dataset.patrolOverflow = ''; fault.style.cssText = 'width:200vw;min-width:200vw;flex:none;height:40px'; fault.textContent = 'はみ出す故障'; node.append(fault) })
    const brokenOverflow = await page.evaluate(scanLayoutOverflow)
    // mainは独立したスクロール枠なので、本文の右端越えを直接確かめる。
    assert.ok(brokenOverflow.outOfMain.some(label => label.includes('はみ出す故障')))
    await page.screenshot({ animations: 'disabled', path: join(dir, 'overflow-broken.png') })
    await page.locator('[data-patrol-overflow]').evaluate(node => node.remove())
    const restoredOverflow = await page.evaluate(scanLayoutOverflow)
    rows.push({ brokenOverflow, restoredOverflow })
    assert.equal(restoredOverflow.pageX, false)
    assert.deepEqual(restoredOverflow.outOfMain, [])
  })
})

for (const width of [1152, 1440]) test(`patrol details ${width}`, async () => {
  await withPage(width, `details-${width}`, async (page, pending, dir, rows) => {
    const open = async path => { await page.goto(base + path, { waitUntil: 'domcontentloaded' }); await waitForNavigationContent(page, pending, 15000); assert.equal(new URL(page.url()).pathname, new URL(path, base).pathname) }
    const check = async (kind, breakLayout, restore) => {
      const normal = await page.evaluate(scanPatrolLayout, kind)
      assert.deepEqual(normal, [], kind)
      await page.screenshot({ animations: 'disabled', path: join(dir, `${kind}-normal.png`) })
      await breakLayout()
      const broken = await page.evaluate(scanPatrolLayout, kind)
      assert.ok(broken.length > 0, `${kind} 故障は赤`)
      await page.screenshot({ animations: 'disabled', path: join(dir, `${kind}-broken.png`) })
      await restore()
      const restored = await page.evaluate(scanPatrolLayout, kind)
      rows.push({ kind, normal, broken, restored }); assert.deepEqual(restored, [])
    }
    await open('/webhooks?tab=interactions')
    await page.getByRole('button', { name: '「予約台帳」の操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '中身を見る', exact: true }).click()
    await page.getByRole('dialog', { name: 'やり取りの中身', exact: true }).waitFor()
    const badge = page.locator('[role="dialog"] h2').locator('..').locator('[data-tone]')
    assert.equal(await badge.count(), 1)
    await check('dialog', async () => badge.evaluate(node => { const r = node.parentElement.querySelector('h2').getBoundingClientRect(); node.style.position = 'absolute'; const parent = node.offsetParent.getBoundingClientRect(); node.style.left = `${r.x - parent.x}px`; node.style.top = `${r.y - parent.y}px` }), async () => badge.evaluate(node => node.removeAttribute('style')))
    await open('/analytics?view=conversion-report')
    await page.locator('[data-aggregation-state="failed"]').waitFor()
    await check('aggregation', async () => page.locator('[data-aggregation-state="failed"]').evaluate(node => { const copy = node.cloneNode(true); copy.setAttribute('data-patrol-fault', ''); node.after(copy) }), async () => page.locator('[data-patrol-fault]').evaluate(node => node.remove()))
    await open('/tags?tab=searches')
    await page.getByText('割り当て済み', { exact: true }).first().waitFor()
    await check('status', async () => page.getByText('割り当て済み', { exact: true }).first().evaluate(node => { const cell = node.closest('td'); cell.dataset.patrolOriginal = cell.innerHTML; cell.innerHTML = '' }), async () => page.locator('td[data-patrol-original]').evaluate(node => { node.innerHTML = node.dataset.patrolOriginal; delete node.dataset.patrolOriginal }))
  })
})

for (const width of [1152, 1440]) test(`step heading focus ${width}`, async () => {
  await withPage(width, `focus-${width}`, async (page, pending, dir, rows) => {
    await page.goto(base + '/accounts/new', { waitUntil: 'domcontentloaded' })
    await waitForNavigationContent(page, pending, 15000)
    assert.equal(new URL(page.url()).pathname, '/accounts/new')
    const firstAnswer = page.getByRole('radio', { name: 'はい、あります', exact: true })
    for (let index = 0; index < 100 && !await firstAnswer.evaluate(node => document.activeElement === node); index++) await page.keyboard.press('Tab')
    assert.equal(await firstAnswer.evaluate(node => document.activeElement === node), true, JSON.stringify(await page.evaluate(() => ({ tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.slice(0, 160) }))))
    await page.keyboard.press('Space')
    await page.getByRole('radio', { name: 'はい、引き継ぎます', exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.matches('[data-step-heading][tabindex="-1"]'))
    const normal = await page.evaluate(scanPatrolLayout, 'focus')
    assert.deepEqual(normal, [])
    await page.screenshot({ animations: 'disabled', path: join(dir, 'focus-normal.png') })
    const faultStyle = await page.addStyleTag({ content: 'html:root [data-step-heading]:focus-visible { outline: none !important; }' })
    const broken = await page.evaluate(scanPatrolLayout, 'focus')
    assert.ok(broken.some(item => item.kind === 'step-heading-focus-ring-missing'))
    await page.screenshot({ animations: 'disabled', path: join(dir, 'focus-broken.png') })
    await faultStyle.evaluate(node => node.remove())
    const restored = await page.evaluate(scanPatrolLayout, 'focus')
    assert.deepEqual(restored, [])
    rows.push({ kind: 'focus', normal, broken, restored, heading: await page.locator('[data-step-heading]').evaluate(node => ({ tag: node.tagName, text: node.textContent, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, outline: getComputedStyle(node).outline, active: document.activeElement === node })) })
    await page.screenshot({ animations: 'disabled', path: join(dir, 'focus-restored.png') })
  })
})

async function withPage(width, name, run) {
  const browser = await connectGuardBrowser(), video = process.env.V8_GUARD_VIDEO === '1'
  const dir = join(output, name); mkdirSync(dir, { recursive: true })
  const context = await browser.newContext({ viewport: { width, height: 1080 }, locale: 'ja-JP', ...(video ? { recordVideo: { dir: join(dir, 'video'), size: { width, height: 1080 } } } : {}) })
  const page = await context.newPage(), pending = trackPendingApiRequests(page), rows = [], errors = []
  let failure = null
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, PARITY_INIT)
  await stubApi(page, async (method, path) => {
    const pathname = new URL(path, base).pathname
    if (pathname === '/api/conversions/report') return { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ success: false, error: '巡回の失敗応答' }) }
    const response = await mockFetch(method, path)
    if (pathname === '/api/staff/me') { const body = JSON.parse(response.body); body.data.accountScope = 'all'; response.body = JSON.stringify(body) }
    return response
  })
  try { await run(page, pending, dir, rows); assert.deepEqual(errors, []) }
  catch (error) { failure = error.stack ?? String(error); await page.screenshot({ animations: 'disabled', path: join(dir, 'failure.png') }); throw error }
  finally {
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ width, rows, errors, failure }, null, 2))
    try { await context.close(); if (video) { const file = join(dir, 'navigation.webm'); await page.video().saveAs(file); assert.ok(statSync(file).size > 0) } }
    finally { await browser.close() }
  }
}

for (const width of [390, 430, 1152, 1440]) test(`getting started rows do not overlap ${width}`, async () => {
  await withPage(width, `getting-started-rows-${width}`, async (page, pending, dir, rows) => {
    styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style: 'restaurant' })
    await page.route('**/api/restaurant-test/setup-progress?**', route => {
      const storeId = new URL(route.request().url()).searchParams.get('storeId')
      return route.fulfill({ json: { success: true, data: { storeId, tables: false, hours: false, menus: false, reception: false, followup: false } } })
    })
    await page.goto(base + '/getting-started', { waitUntil: 'domcontentloaded' })
    await waitForNavigationContent(page, pending, 15000)
    const table = page.getByRole('table', { name: 'はじめの設定の順路' })
    await table.waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="はじめの設定の順路"] [role="row"]')[2]?.getAttribute('data-step-state') === 'todo')
    await page.evaluate(async () => { await document.fonts.ready })
    await page.screenshot({ path: join(dir, 'settings.png'), fullPage: true, animations: 'disabled' })
    const bounds = await table.evaluate(node => [...node.querySelectorAll('[role="row"]')].map(row => {
      const rect = row.getBoundingClientRect()
      const action = row.querySelector('a,button')?.getBoundingClientRect()
      return { text: row.innerText, top: rect.top, bottom: rect.bottom, height: rect.height, actionTop: action?.top ?? null, actionBottom: action?.bottom ?? null }
    }))
    rows.push({ bounds })
    assert.ok(bounds.length > 1, '設定の手順が表示される')
    for (const [index, row] of bounds.entries()) {
      if (row.actionBottom !== null) assert.ok(row.actionTop >= row.top - 1 && row.actionBottom <= row.bottom + 1, `行${index + 1}のボタンが行をはみ出す: ${JSON.stringify(row)}`)
      if (index + 1 < bounds.length) assert.ok(row.bottom <= bounds[index + 1].top + 1, `行${index + 1}と次の行が重なる`)
    }
    const action = table.getByRole('link', { name: '座席・卓を開く' })
    assert.equal(await action.count(), 1)
    await action.click({ timeout: 5000 })
    await page.waitForURL(url => url.pathname === '/restaurant-test/tables', { timeout: 15000 })
  })
})
