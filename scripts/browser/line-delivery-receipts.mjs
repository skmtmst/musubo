/** 人工の受信失敗で、要確認・安全な工程の操作と3幅を実画面で確かめる。実送信なし。 */
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { measurePage, assessAgainstBase } from '../../apps/web/scripts/v8-guard/layout-defects.mjs'
const baseUrl = process.argv[2]
const comparisonUrl = process.argv[3]
const out = process.argv[4] ?? '/tmp/line-delivery-receipts'
assert(baseUrl && comparisonUrl, 'headと本線のローカルURLが必要です')
mkdirSync(out, { recursive: true })
const row = (id, extra = {}) => ({ webhookEventId: id, lineAccountId: 'visual-qa-account', eventType: 'message', status: 'failed', receivedAt: '2026-10-12T00:09:00+09:00', canRetry: false, recoveryStatus: 'needs_review', recoveryReason: '返信の鍵が残っていないため自動返信できません。送信履歴を確認し、必要なら受信箱から担当者が返信してください。', ...extra })
const browser = await chromium.launch({ headless: true })
const results = []
const makePage = async (url, width, rows) => {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []; page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    for (const [key, value] of Object.entries({ lh_csrf: 'visual-qa-csrf', lh_staff_role: 'owner', lh_staff_name: 'K', lh_staff_permissions: '[]', lh_staff_view_permissions: '[]', lh_selected_account: 'visual-qa-account', lh_auth_selection_cleared: '1' })) localStorage.setItem(key, value)
  })
  const state = { rows, retries: 0 }
  await page.route('**/api/line-webhook-events**', async (route) => {
    const retry = route.request().method() === 'POST'
    if (retry) { state.retries++; state.rows = state.rows.filter((item) => item.webhookEventId !== 'safe') }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(retry ? { success: true, status: 'succeeded' } : { success: true, data: state.rows }) })
  })
  assert((await page.goto(url + '/emergency'))?.ok())
  await page.waitForTimeout(1500)
  await page.evaluate(() => document.fonts.ready)
  return { page, state, errors }
}
try {
  for (const width of [1152, 1440, 1920]) {
    const prior = await makePage(comparisonUrl, width, [])
    const baseline = await measurePage(prior.page)
    await prior.page.close()
    for (const scenario of ['review', 'safe']) {
      const rows = scenario === 'review' ? [row('review', { canRetry: true })] : [row('safe', { canRetry: true, recoveryStatus: null, recoveryReason: null })]
      const { page, state, errors } = await makePage(baseUrl, width, rows)
      try {
        const region = page.getByRole('region', { name: 'LINE受信の失敗' })
        await region.waitFor()
        const text = await region.innerText()
        for (const phrase of ['履歴を照らし', '担当者が返信', 'お客さまに送り直しを頼んで']) assert(text.includes(phrase))
        if (scenario === 'review') {
          assert(text.includes('要確認') && text.includes('返信の鍵'))
          assert.equal(await region.getByRole('button').count(), 0)
        } else assert.equal(await region.getByRole('button', { name: 'やり直す', exact: true }).count(), 1)
        const findings = await measurePage(page)
        const compared = assessAgainstBase(findings, baseline, '/emergency', width)
        const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)
        await page.screenshot({ path: `${out}/${scenario}-${width}.png`, fullPage: true })
        results.push({ width, scenario, overflow, errors, failures: compared.failures, existing: compared.existing })
        assert.equal(overflow, 0)
        assert.deepEqual(errors, [])
        assert.deepEqual(compared.failures, [])
        assert.deepEqual(compared.needsReview ?? [], [])
        if (scenario === 'safe') {
          await region.getByRole('button', { name: 'やり直す', exact: true }).click()
          await region.waitFor({ state: 'detached' })
          assert.equal(state.retries, 1)
        }
      } finally { await page.close() }
    }
  }
} finally {
  writeFileSync(out + '/results.json', JSON.stringify(results, null, 2) + '\n')
  await browser.close()
}
console.log(JSON.stringify(results.map(({ width, scenario, overflow, failures }) => ({ width, scenario, overflow, newFailures: failures.length }))))
