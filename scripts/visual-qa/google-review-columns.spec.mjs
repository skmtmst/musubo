import { test, expect } from '@playwright/test'

const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:13118'
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('ローカル確認専用です')

for (const width of [1152, 1440]) {
  test(`口コミ本文と日時の列を揃える ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      localStorage.setItem('lh_selected_account', 'visual-qa-account')
      localStorage.setItem('lh_auth_selection_cleared', '1')
      sessionStorage.setItem('lh_auth_selection_cleared', '1')
    })
    await page.goto(`${base}/restaurant-test/google`)
    const table = page.getByRole('table', { name: '口コミ一覧' })
    await expect(table).toBeVisible()
    const rows = table.locator('[data-row-id]')
    expect(await rows.count()).toBeGreaterThanOrEqual(2)
    await rows.nth(0).getByRole('cell').nth(0).locator('span').first().evaluate(el => { el.textContent = 'とても長い投稿者の名前'.repeat(5) })
    await rows.nth(0).getByRole('cell').nth(2).evaluate(el => { el.textContent = '2025/12/31 23:59' })
    const aligned = async () => rows.evaluateAll(items => {
      const positions = [items[0].parentElement.querySelector('[data-head]'), ...items].map(row => {
        const cells = row.querySelectorAll('[role="cell"], [role="columnheader"]')
        return [Math.round(cells[1].getBoundingClientRect().left), Math.round(cells[2].getBoundingClientRect().right)]
      })
      return positions.every(p => p[0] === positions[0][0] && p[1] === positions[0][1])
    })
    expect(await aligned()).toBe(true)
    // 一行の固定列を外す故障を検出し、元に戻ることも確認する。
    await rows.nth(0).evaluate(row => { row.style.gridTemplateColumns = 'max-content max-content max-content max-content max-content' })
    expect(await aligned()).toBe(false)
    await rows.nth(0).evaluate(row => { row.style.removeProperty('grid-template-columns') })
    expect(await aligned()).toBe(true)
  })
}
