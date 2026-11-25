import { test, expect } from '@playwright/test'

const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:3579'
const mock = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:18791'
const account = 'visual-qa-account'

test('新着の開閉は Enter・Space で動き、再読込後も本人と店の状態を復元する', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1500 })
  const result = await page.request.put(`${mock}/api/dashboard/style?accountId=${account}`, { data: { style: 'restaurant' } })
  expect(result.ok()).toBe(true)
  await page.addInitScript((id) => {
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
    localStorage.setItem('lh_selected_account', id)
    localStorage.setItem(`lh:v8:first-run-popup-dismissed:${id}`, '1')
  }, account)
  await page.goto(base)
  const heading = page.locator('[data-today-check]').getByRole('heading', { name: '今日の確認' })
  await expect(heading).toHaveCSS('font-size', '16px')
  await expect(heading).toHaveCSS('font-weight', '600')
  const toggle = page.locator('#today-check-new button[data-disclosure-toggle]')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.focus()
  const focusRing = await toggle.evaluate(element => {
    const head = element.closest('[class*="itemHead"]')
    return { button: getComputedStyle(element).outlineStyle, head: head ? getComputedStyle(head).outlineStyle : null, width: head ? getComputedStyle(head).outlineWidth : null }
  })
  expect(focusRing).toEqual({ button: 'none', head: 'solid', width: '2px' })
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
})
