import { test, expect } from '@playwright/test'
import { routeLocalApi } from '../../../../../scripts/visual-qa/local-api.mjs'

const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:13101'
test.beforeEach(routeLocalApi)
test('期間の選択と指定期間は再読込後も残る', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'visual-qa-account')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
  })
  await page.goto(`${base}/?period=last30`)
  await page.getByRole('button', { name: '過去90日', exact: true }).click()
  await expect(page).toHaveURL(/period=last90/)
  await page.reload()
  await expect(page.getByRole('button', { name: '過去90日', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.goto(`${base}/?period=custom&from=2026-01-01&to=2026-01-31`)
  await expect(page.getByRole('button', { name: '期間を指定', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(page.getByRole('button', { name: '期間の始まり' })).toContainText('2026年1月1日')
  await expect(page.getByRole('button', { name: '期間の終わり' })).toContainText('2026年1月31日')
})
