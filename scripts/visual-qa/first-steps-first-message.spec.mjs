import { test, expect } from '@playwright/test'
import { base, mock, openFixture } from './first-steps-guide-fixture.mjs'

test('最初の1通を送信し、再読込しても受取確認を待って完了する', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, { storeProgress: { tables: true, hours: true, menus: true, reception: true, followup: true } })
  let status = 'ready'
  let sendCount = 0
  const messageState = () => ({ status, accountName: 'LINEアカウントA', friendUrl: null, retryAt: null, verificationPending: false })
  await page.route('**/api/getting-started/first-message?**', route => route.fulfill({ json: { success: true, data: messageState() } }))
  await page.route('**/api/getting-started/first-message/send?**', route => {
    sendCount += 1
    status = 'sent'
    return route.fulfill({ json: { success: true, data: messageState() } })
  })
  await page.route('**/api/getting-started?**', async route => {
    const response = await page.request.get(`${mock}/api/getting-started?version=v8`)
    const data = await response.json()
    const firstMessage = data.data.steps.find(step => step.key === 'firstMessage')
    firstMessage.state = status === 'received' ? 'done' : 'todo'
    await route.fulfill({ json: data })
  })
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  const receive = page.getByRole('dialog', { name: /最初の1通を受け取る/ })
  await expect(receive.getByText('8/8', { exact: true })).toBeVisible()
  await expect(receive.getByRole('status')).toContainText('送信先を確認済み')
  expect(sendCount).toBe(0)
  const receiveBounds = await receive.boundingBox()
  expect(receiveBounds.width).toBeCloseTo(650, 0)
  expect(receiveBounds.y + receiveBounds.height).toBeLessThanOrEqual(page.viewportSize().height)
  const primary = receive.getByRole('button', { name: '自分のLINEにテスト送信' })
  const later = receive.getByRole('button', { name: 'あとで', exact: true })
  const [primaryBox, laterBox] = await Promise.all([primary.boundingBox(), later.boundingBox()])
  expect(laterBox.x).toBeGreaterThanOrEqual(primaryBox.x + primaryBox.width)
  expect(Math.abs(primaryBox.y + primaryBox.height / 2 - laterBox.y - laterBox.height / 2)).toBeLessThan(4)
  await page.screenshot({ path: testInfo.outputPath('guide-receive.png') })
  await primary.click()
  await expect(receive.getByRole('status')).toContainText('受け取りました')
  await page.reload()
  await expect(receive.getByRole('status')).toContainText('受け取りました')
  expect(sendCount).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('guide-receive-waiting.png') })
  status = 'received'
  const complete = page.getByRole('dialog', { name: '開店準備が完了しました' })
  await expect(complete).toBeVisible()
  await expect(complete.getByRole('link')).toHaveCount(3)
  expect((await complete.boundingBox()).width).toBeCloseTo(560, 0)
  await page.screenshot({ path: testInfo.outputPath('guide-complete.png') })
  await complete.getByRole('button', { name: 'ダッシュボードへ', exact: true }).click()
  await expect(complete).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true })).toBeVisible()
  await expect(complete).toHaveCount(0)
})

test('送信先を確認できないときは同じ画面から自分のLINEを確認できる（390px）', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, { width: 390, height: 844, initialGuide: { phase: 'active', stepKey: 'firstMessage' },
    storeProgress: { tables: true, hours: true, menus: true, reception: true, followup: true } })
  let status = 'identity_required'
  await page.route('**/api/getting-started/first-message?**', route => route.fulfill({ json: { success: true, data: {
    status, accountName: 'LINEアカウントA', friendUrl: null, retryAt: null, verificationPending: false,
  } } }))
  await page.route('**/api/getting-started/first-message/identity?**', route => route.fulfill({ json: {
    success: true, data: { verificationUrl: 'https://line.me/R/oaMessage/%40fixture/?sample' },
  } }))
  await page.goto(base)
  const receive = page.getByRole('dialog', { name: /最初の1通を受け取る/ })
  await expect(receive.getByRole('status')).toContainText('本人のLINEの確認が必要です')
  await expect(receive.getByRole('button', { name: '自分のLINEにテスト送信' })).toHaveCount(0)
  await receive.getByRole('button', { name: '自分のLINEを確認' }).click()
  await expect(receive.getByRole('link', { name: 'お店のLINEを開く' })).toBeVisible()
  await expect(receive.getByRole('img', { name: /QRコード/ })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('guide-receive-identity-390.png') })
  status = 'ready'
  await expect(receive.getByRole('status')).toContainText('送信先を確認済み')
  await page.screenshot({ path: testInfo.outputPath('guide-receive-390.png') })
})

test('送信できなかった理由を表示し、結果が不明なときは再送しない', async ({ page }, info) => {
  await openFixture(page, { width: 390, height: 844, initialGuide: { phase: 'active', stepKey: 'firstMessage' },
    storeProgress: { tables: true, hours: true, menus: true, reception: true, followup: true } })
  let status = 'ready'
  let sends = 0
  const result = () => ({ json: { success: true, data: {
    status, accountName: 'LINEアカウントA', friendUrl: null, retryAt: null, verificationPending: false,
  } } })
  await page.route('**/api/getting-started/first-message?**', route => route.fulfill(result()))
  await page.route('**/api/getting-started/first-message/send?**', route => {
    sends += 1
    status = sends === 1 ? 'busy' : 'unknown'
    return route.fulfill(result())
  })
  await page.goto(base)
  const dialog = page.getByRole('dialog', { name: '最初の1通を受け取る' })
  await dialog.getByRole('button', { name: '自分のLINEにテスト送信' }).click()
  await expect(dialog.getByRole('status')).toContainText('LINEが一時的に混み合っています')
  await page.screenshot({ path: info.outputPath('guide-receive-busy-390.png') })
  await dialog.getByRole('button', { name: 'もう一度送信する' }).click()
  await expect(dialog.getByRole('status')).toContainText('送信結果を確認できませんでした')
  await page.screenshot({ path: info.outputPath('guide-receive-unknown-390.png') })
  await dialog.getByRole('button', { name: '送信結果を確認する' }).click()
  await expect(dialog.getByRole('button', { name: 'もう一度送信する' })).toHaveCount(0)
  expect(sends).toBe(2)
})
