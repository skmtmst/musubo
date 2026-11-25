import { test, expect } from '@playwright/test'
const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:13129'
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('ローカル確認専用です')
for (const width of [1152, 1440]) for (const single of [false, true]) test(`注文状態タブの読込前後の位置 ${width} 店舗${single ? '1つ' : '複数'}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'visual-qa-account')
    localStorage.setItem('lh_auth_selection_cleared', '1')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
    localStorage.setItem('lh:v8:first-run-popup-dismissed:visual-qa-account', '1')
  })
  if (single) await page.route('**/api/restaurant-test/snapshot?**', async route => { const response = await route.fetch(); const body = await response.json(); body.data.stores = body.data.stores.slice(0, 1); await route.fulfill({ response, json: body }) })
  let release
  const pending = new Promise(resolve => { release = resolve })
  await page.route('**/api/restaurant-test/delivery/orders?**', async route => { await pending; await route.continue() })
  await page.goto(`${base}/restaurant-test/delivery`)
  const tabs = page.getByRole('tablist', { name: '注文の状態' })
  await expect(tabs).toBeVisible()
  await expect(page.getByText('32', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '出前館の受付を止める' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '受付をまとめて止める' })).toHaveAttribute('aria-description', '読み込み中です')
  const before = (await tabs.boundingBox()).y
  release()
  await expect(page.getByText('32', { exact: true })).toBeVisible()
  const after = (await tabs.boundingBox()).y
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2)
})
