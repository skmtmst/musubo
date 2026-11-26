import { test, expect } from '@playwright/test'
import { routeLocalApi } from './local-api.mjs'

const base = process.env.VISUAL_QA_BASE ?? 'http://localhost:3101'
const mock = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:8788'
test.describe.configure({ mode: 'serial' })
test.beforeEach(routeLocalApi)
test.afterAll(async ({ request }) => {
  await request.put(`${mock}/api/dashboard/style?accountId=visual-qa-account`, { data: { style: 'standard' } })
  await request.put(`${mock}/api/getting-started/guide?accountId=visual-qa-account`, { data: { phase: 'idle', stepKey: null, procedureIndex: 1 } })
})

for (const style of ['standard', 'restaurant', 'salon', 'consult', 'lesson', 'ec']) {
  for (const width of [1152, 1440]) {
    test(`${style} ${width}px で操作を中央に並べ、説明を開ける`, async ({ page }) => {
      await page.request.put(`${mock}/api/dashboard/style?accountId=visual-qa-account`, { data: { style } })
      await page.request.put(`${mock}/api/getting-started/guide?accountId=visual-qa-account`, { data: { phase: 'paused', stepKey: 'attributes', procedureIndex: 2 } })
      await page.setViewportSize({ width, height: 1000 })
      await page.addInitScript(() => {
        localStorage.setItem('lh_selected_account', 'visual-qa-account')
        localStorage.setItem('lh_csrf', 'visual-qa-csrf')
        localStorage.setItem('lh_staff_role', 'owner')
        localStorage.setItem('lh:v8:first-run-popup-dismissed:visual-qa-account', '1')
        localStorage.setItem('lh:v8:guide-engine:visual-qa-account', JSON.stringify({ phase: 'paused', stepKey: 'attributes', procedureIndex: 2 }))
        sessionStorage.setItem('lh_auth_selection_cleared', '1')
      })
      await page.route('**/api/getting-started/guide?**', route => route.fulfill({ json: { success: true, data: { phase: 'paused', stepKey: 'attributes', procedureIndex: 2, updatedAt: '2026-11-20T00:00:00Z' } } }))
      await page.route('**/api/getting-started?**', async route => {
        const steps = [
          { key: 'accounts', state: 'done', href: '/accounts', reason: null, webhook: [{ id: 'visual-qa-account', status: 'matched' }] },
          { key: 'featureSet', state: 'done', href: '/settings', reason: null },
          { key: 'attributes', state: 'todo', href: '/tags', reason: null },
          { key: 'friendAdd', state: 'todo', href: '/friend-add-settings', reason: null },
          { key: 'scenario', state: 'todo', href: '/scenarios', reason: null },
          { key: 'firstMessage', state: 'todo', href: '/chats', reason: null },
        ]
        await route.fulfill({ json: { success: true, data: { accountId: 'visual-qa-account', doneCount: 2, total: steps.length, allDone: false, steps } } })
      })
      await page.goto(base, { waitUntil: 'networkidle' })
      const card = page.locator('section[aria-labelledby="first-steps-title"]')
      const resume = card.getByRole('button', { name: '続きから進める' })
      const restart = card.getByRole('button', { name: '最初から始める' })
      await expect(resume).toBeVisible()
      const a = await resume.boundingBox(), b = await restart.boundingBox(), box = await card.boundingBox()
      expect(Math.abs((a.x + b.x + b.width) / 2 - (box.x + box.width / 2))).toBeLessThan(2)
      expect(Math.abs(a.y - b.y)).toBeLessThan(1)
      expect(Math.abs(a.height - b.height)).toBeLessThan(1)
      const help = card.getByRole('button', { name: 'はじめにやることのチェックについて' })
      await help.click()
      await expect(card.getByRole('note')).toContainText('チェックは設定の実データで自動判定。ガイドを使わなくても付きます')
    })
  }
}

test('標準の手順からガイドを開始できる', async ({ page }) => {
  await page.request.put(`${mock}/api/dashboard/style?accountId=visual-qa-account`, { data: { style: 'standard' } })
  await page.request.put(`${mock}/api/getting-started/guide?accountId=visual-qa-account`, { data: { phase: 'idle', stepKey: null, procedureIndex: 1 } })
  await page.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'visual-qa-account')
    localStorage.setItem('lh_csrf', 'visual-qa-csrf')
    localStorage.setItem('lh_staff_role', 'owner')
    localStorage.setItem('lh:v8:first-run-popup-dismissed:visual-qa-account', '1')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
  })
  await page.route('**/api/getting-started?**', route => route.fulfill({ json: { success: true, data: { accountId: 'visual-qa-account', doneCount: 1, total: 2, allDone: false, steps: [
    { key: 'accounts', state: 'done', href: '/accounts', reason: null, webhook: [{ id: 'visual-qa-account', status: 'matched' }] },
    { key: 'attributes', state: 'todo', href: '/tags', reason: null },
  ] } } }))
  await page.goto(base, { waitUntil: 'networkidle' })
  const card = page.locator('section[aria-labelledby="first-steps-title"]')
  await expect(card.getByRole('button', { name: '続きから進める' })).toHaveCount(0)
  const save = page.waitForRequest(request => request.method() === 'PUT' && request.url().includes('/api/getting-started/guide'))
  await card.getByRole('link', { name: '友だちの分け方を決めるを開く' }).click()
  expect((await save).postDataJSON()).toMatchObject({ phase: 'active', stepKey: 'attributes' })
})
