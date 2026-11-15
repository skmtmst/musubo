import { test, expect } from '@playwright/test'
import { routeLocalApi } from './local-api.mjs'
import { BROADCASTS } from './fixtures.mjs'

const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:3101'
test.beforeEach(routeLocalApi)
test('送信済み配信から訂正の下書きを開く', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1080 })
  await page.addInitScript(() => {
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
    localStorage.setItem('lh_selected_account', 'visual-qa-account')
  })
  let key = ''
  await page.route('**/api/broadcasts/broadcast-2/correction', async route => {
    key = route.request().headers()['idempotency-key'] ?? ''
    await route.fulfill({ status: 201, json: { success: true, data: { id: 'correction-draft' } } })
  })
  await page.route('**/api/broadcasts/correction-draft', async route => {
    await route.fulfill({ json: { success: true, data: { ...BROADCASTS[1], id: 'correction-draft', status: 'draft', correctionOfBroadcastId: 'broadcast-2', targetType: 'segment', segmentConditions: { operator: 'AND', rules: [{ type: 'is_following', value: true }] }, draftStep: 'message' } } })
  })
  await page.goto(`${base}/broadcasts/detail?id=broadcast-2`)
  await expect(page.getByRole('button', { name: '配信「新商品発売のお知らせ」の操作' })).toBeVisible()
  await page.getByRole('button', { name: '配信「新商品発売のお知らせ」の操作' }).click()
  await page.getByRole('menuitem', { name: '訂正を送る' }).click()
  await expect(page).toHaveURL(/\/broadcasts\/new\?draft=correction-draft/)
  expect(key).toMatch(/^[a-f0-9-]{36}$/)
  await page.goto(`${base}/broadcasts/new?draft=correction-draft&step=audience`)
  await expect(page.getByText('訂正は元の配信を送れた人に送ります。宛先は変更できません。')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})
