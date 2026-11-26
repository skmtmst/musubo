import { test, expect } from '@playwright/test'
import { routeLocalApi } from './local-api.mjs'

const base = process.env.VISUAL_QA_BASE ?? 'http://localhost:3101'
const mock = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:8788'
test.beforeEach(routeLocalApi)
test.afterAll(async ({ request }) => {
  await request.put(`${mock}/api/dashboard/style?accountId=visual-qa-account`, { data: { style: 'standard' } })
  await request.put(`${mock}/api/getting-started/guide?accountId=visual-qa-account`, { data: { phase: 'idle', stepKey: null, procedureIndex: 1 } })
})

test('最初の1通を確かめる窓はダッシュボード上で開き、閉じても移動しない', async ({ page }) => {
  await page.request.put(`${mock}/api/dashboard/style?accountId=visual-qa-account`, { data: { style: 'restaurant' } })
  await page.request.put(`${mock}/api/getting-started/guide?accountId=visual-qa-account`, { data: { phase: 'idle', stepKey: null, procedureIndex: 1 } })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'visual-qa-account')
    localStorage.setItem('lh_csrf', 'visual-qa-csrf')
    localStorage.setItem('lh_staff_role', 'owner')
    localStorage.setItem('lh:v8:first-run-popup-dismissed:visual-qa-account', '1')
    localStorage.removeItem('lh:v8:guide-engine:visual-qa-account')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
  })
  await page.route('**/api/getting-started?**', route => {
    const steps = ['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage'].map(key => ({ key, state: key === 'firstMessage' ? 'todo' : 'done', href: '/settings', reason: null, ...(key === 'accounts' ? { webhook: [{ id: 'visual-qa-account', status: 'matched' }] } : {}) }))
    return route.fulfill({ json: { success: true, data: { accountId: 'visual-qa-account', doneCount: 5, total: 6, allDone: false, steps } } })
  })
  await page.route('**/api/restaurant-test/setup-progress?**', route => route.fulfill({ json: { success: true, data: { storeId: 'store-sby', tables: true, hours: true, menus: true, reception: true, followup: true } } }))
  const visits = []
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) visits.push(frame.url()) })
  await page.goto(base, { waitUntil: 'networkidle' })
  const link = page.getByRole('link', { name: '最初の1通を受け取るを確かめる' })
  await expect(link).toBeVisible()
  await link.scrollIntoViewIfNeeded()
  const position = await link.boundingBox()
  const capture = process.env.SETUP_CENTER_CAPTURE
  if (capture) await page.screenshot({ path: `${capture}/first-message-before.png` })
  visits.length = 0
  await link.click()
  const dialog = page.getByRole('dialog', { name: '最初の1通を受け取る' })
  await expect(dialog).toBeVisible()
  await page.waitForTimeout(2000)
  await expect(dialog).toBeVisible()
  if (capture) await page.screenshot({ path: `${capture}/first-message-open.png` })
  expect(new URL(page.url()).pathname).toBe('/')
  await dialog.getByRole('button', { name: 'あとで' }).click()
  await expect(dialog).toBeHidden()
  expect(Math.abs((await link.boundingBox()).y - position.y)).toBeLessThan(2)
  if (capture) await page.screenshot({ path: `${capture}/first-message-closed.png` })
  expect(visits.map(url => new URL(url).pathname).filter(path => path !== '/')).toEqual([])
  await link.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '閉じる' }).click()
  await expect(dialog).toBeHidden()
  expect(new URL(page.url()).pathname).toBe('/')
  expect(visits.map(url => new URL(url).pathname).filter(path => path !== '/')).toEqual([])
})
