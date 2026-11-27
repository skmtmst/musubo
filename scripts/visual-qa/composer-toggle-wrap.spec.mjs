/** 吹き出し編集の下帯で、保存の選択肢を途中で折らない。 */
import { test, expect } from '@playwright/test'
import { routeLocalApi } from './local-api.mjs'

const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:4328'
if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(base).hostname)) throw new Error('ローカル専用です')
test.beforeEach(routeLocalApi)
for (const width of [1024, 1152, 1440]) {
  test(`テンプレート保存の表示と操作が収まる ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      localStorage.setItem('lh_selected_account', 'visual-qa-account')
      localStorage.setItem('lh_auth_selection_cleared', '1')
      sessionStorage.setItem('lh_auth_selection_cleared', '1')
    })
    await page.goto(`${base}/broadcasts/new`)
    await page.getByPlaceholder('例：8月キャンペーンのお知らせ').fill('見本配信')
    await page.getByRole('button', { name: '対象設定へ' }).click()
    await page.getByText('友だち全員に配信する', { exact: true }).click()
    await page.getByRole('button', { name: 'メッセージ設定へ' }).click()
    await page.getByRole('tab', { name: 'カルーセル' }).click()
    await page.getByRole('button', { name: 'ここで作る' }).click()
    const toggle = page.getByRole('switch', { name: 'テンプレートとしても保存する' })
    await expect(toggle).toBeVisible()
    for (const checked of [false, true]) {
      if (checked) await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', String(checked))
      const layout = await toggle.evaluate((node) => {
        const label = document.getElementById(node.getAttribute('aria-labelledby'))
        const range = document.createRange()
        range.selectNodeContents(label)
        const own = node.getBoundingClientRect()
        const action = [...document.querySelectorAll('button')].find(button => button.textContent.includes('この吹き出しに入れる')).getBoundingClientRect()
        return { lines: range.getClientRects().length, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, overlap: own.left < action.right && own.right > action.left && own.top < action.bottom && own.bottom > action.top }
      })
      expect(layout).toEqual({ lines: 1, overflow: 0, overlap: false })
    }
  })
}
