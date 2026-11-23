import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectGuardBrowser } from './browser-session.mjs'
import { mockFetch } from './mock-local.mjs'
import { stubApi } from './speed-budget.mjs'
import { PARITY_INIT } from '../../../../scripts/visual-qa/v8-parity.mjs'
import { styleDashboardMock } from '../../../../scripts/visual-qa/style-dashboard-mock.mjs'

function scanStyleSwitcher() {
  const dialog = document.querySelector('[role="dialog"]'), body = dialog?.querySelector('[data-window-body]'), switcher = dialog?.querySelector('[data-style-switcher]')
  if (!dialog || !body || !switcher) return ['窓・本文・スタイル切り替えが必要']
  const r = switcher.getBoundingClientRect(), br = body.getBoundingClientRect(), dr = dialog.getBoundingClientRect()
  const errors = []
  if (body.contains(switcher)) errors.push('切り替えがスクロールする本文の中にある')
  if (r.top < dr.top || r.bottom > br.top + 1 || r.right > dr.right + 1 || r.left < dr.left - 1) errors.push('切り替えが題の下の固定帯に収まらない')
  if (dialog.scrollWidth > dialog.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1) errors.push('窓の横にはみ出す')
  const content = body.querySelector('[data-step-content]')?.getBoundingClientRect()
  if (content && (content.left < br.left - 1 || content.right > br.right + 1)) errors.push('本文の包みが窓の幅を超える')
  return errors
}

for (const width of [1152, 1440, 390]) for (const entry of ['setup', 'registration']) test(`style switcher ${entry} ${width}`, async () => {
  styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style: 'standard' })
  const base = process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310', output = join(process.env.V8_GUARD_ARTIFACT_DIR || '/tmp/v8-guard', 'style-switcher', `${entry}-${width}`)
  mkdirSync(output, { recursive: true })
  const browser = await connectGuardBrowser(), context = await browser.newContext({ viewport: { width, height: 1080 }, locale: 'ja-JP' }), page = await context.newPage()
  const identity = JSON.parse((await mockFetch('GET', '/api/staff/me')).body).data
  const resumeKey = `musubo-registration-style:${encodeURIComponent(identity.tenantId)}:${encodeURIComponent(identity.id)}`
  const errors = [], writes = [], rows = []; let failure = null
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ values, resumeKey, registration }) => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); if (registration) sessionStorage.setItem(resumeKey, 'visual-qa-account') }, { values: PARITY_INIT, resumeKey, registration: entry === 'registration' })
  await stubApi(page, async (method, path) => {
    if (method !== 'GET') writes.push({ method, path: new URL(path, base).pathname })
    const response = await mockFetch(method, path)
    if (new URL(path, base).pathname === '/api/staff/me') { const body = JSON.parse(response.body); body.data.accountScope = 'all'; response.body = JSON.stringify(body) }
    return response
  })
  try {
    assert.ok((await page.goto(base + (entry === 'setup' ? '/?setup=0' : '/accounts/new'), { waitUntil: 'domcontentloaded' }))?.ok())
    const dialog = page.getByRole('dialog', { name: '使い方のスタイルを選ぶ', exact: true })
    await dialog.waitFor()
    const body = dialog.locator('[data-window-body]'), switcher = dialog.locator('[data-style-switcher]')
    await body.evaluate(node => { node.scrollTop = 0 })
    assert.deepEqual(await page.evaluate(scanStyleSwitcher), [])
    await page.screenshot({ animations: 'disabled', path: join(output, 'top.png') })
    const before = await switcher.boundingBox()
    await body.evaluate(node => { node.scrollTop = node.scrollHeight })
    assert.ok(await body.evaluate(node => node.scrollTop > 0), '実際に本文の下までスクロールした')
    const below = await switcher.boundingBox()
    assert.ok(Math.abs(before.y - below.y) <= 1 && Math.abs(before.height - below.height) <= 1)
    assert.deepEqual(await page.evaluate(scanStyleSwitcher), [])
    await page.screenshot({ animations: 'disabled', path: join(output, 'bottom.png') })
    if (width < 640) {
      await switcher.getByRole('button', { name: '見るスタイル', exact: true }).click()
      await page.getByRole('option', { name: /^面談・相談/ }).click()
    } else await switcher.getByRole('group', { name: '見るスタイル', exact: true }).getByRole('button', { name: /^面談・相談/ }).click()
    await dialog.getByRole('heading', { name: '面談・相談でできること', exact: true }).waitFor({ state: 'attached' })
    assert.deepEqual(writes.filter(write => /\/style$|\/styles$|\/line-accounts$/.test(write.path)), [], '見ているスタイルの切り替えだけでは保存しない')
    const normal = await page.evaluate(scanStyleSwitcher)
    await switcher.evaluate(node => { const marker = document.createElement('span'); marker.dataset.styleSwitcherOriginal = ''; node.before(marker); node.closest('[role="dialog"]').querySelector('[data-window-body]').prepend(node) })
    const broken = await page.evaluate(scanStyleSwitcher)
    assert.ok(broken.length > 0, '切り替えを本文へ戻す故障は赤')
    await page.locator('[data-style-switcher-original]').evaluate(marker => { marker.replaceWith(document.querySelector('[data-style-switcher]')) })
    const restored = await page.evaluate(scanStyleSwitcher)
    assert.deepEqual(restored, [])
    rows.push({ before, below, normal, broken, restored, writes })
    await page.screenshot({ animations: 'disabled', path: join(output, 'restored.png') })
    if (width === 1440) {
      await switcher.getByRole('group', { name: '見るスタイル', exact: true }).getByRole('button', { name: /^飲食店/ }).click()
      const choose = dialog.getByRole('button', { name: 'このスタイルにする', exact: true })
      if (await choose.count()) await choose.click()
      await dialog.getByRole('button', { name: '次へ', exact: true }).click()
      const next = page.getByRole('dialog', { name: '最初のリッチメニューを選ぶ', exact: true })
      if (entry === 'registration') {
        await page.getByRole('heading', { name: '使い方を保存しました', exact: true }).waitFor()
        assert.equal(await next.count(), 0, '登録時にリッチメニューの段を出さない')
        assert.deepEqual(writes.filter(write => write.path === '/api/dashboard/style'), [{ method: 'PUT', path: '/api/dashboard/style' }])
        await page.screenshot({ animations: 'disabled', path: join(output, 'completed.png') })
      } else {
        await next.waitFor()
        assert.equal(await next.locator('[data-style-switcher]').count(), 0, 'メニューの段では固定帯を出さない')
        await page.screenshot({ animations: 'disabled', path: join(output, 'menu-step.png') })
        await next.getByRole('button', { name: 'スタイルを選び直す', exact: true }).click()
        await dialog.waitFor()
        assert.deepEqual(await page.evaluate(scanStyleSwitcher), [])
        const returned = await dialog.evaluate(node => ({ focusInside: node.contains(document.activeElement), focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.slice(0, 100), scrollTop: node.querySelector('[data-window-body]').scrollTop }))
        assert.equal(returned.focusInside, true, '戻ったあとの焦点も窓の中にある')
        rows.push({ returned })
        await page.screenshot({ animations: 'disabled', path: join(output, 'returned.png') })
      }
    }
    assert.deepEqual(errors, [])
  } catch (error) { failure = error.stack ?? String(error); await page.screenshot({ animations: 'disabled', path: join(output, 'failure.png') }); writeFileSync(join(output, 'body.txt'), await page.locator('body').innerText()); throw error }
  finally { styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style: 'standard' }); writeFileSync(join(output, 'summary.json'), JSON.stringify({ width, entry, rows, errors, failure }, null, 2)); await context.close(); await browser.close() }
})
