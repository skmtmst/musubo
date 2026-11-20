import { test, expect } from '@playwright/test'
import { routeLocalApi } from './local-api.mjs'

const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:3101'
const mock = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:8788'
const accountId = 'visual-qa-account'
const guideBar = '[data-guide-bar]'
const tableForm = '[data-guide-balloon="attributes:2"]'

async function openFixture(page, { width = 1440, firstStep = 'attributes', delayProgress, storeProgress = {} } = {}) {
  await routeLocalApi({ page })
  await page.setViewportSize({ width, height: 1000 })
  await page.request.put(`${mock}/api/dashboard/style?accountId=${accountId}`, { data: { style: 'restaurant' } })
  await page.request.put(`${mock}/api/getting-started/guide?accountId=${accountId}`, { data: { phase: 'idle', stepKey: null, procedureIndex: 1 } })
  await page.addInitScript((account) => {
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
    localStorage.setItem('lh_selected_account', account)
  }, accountId)
  const setup = { tables: false, hours: false, menus: false, reception: false, followup: false, ...storeProgress }
  await page.route('**/api/restaurant-test/setup-progress?**', async route => {
    await delayProgress
    const storeId = new URL(route.request().url()).searchParams.get('storeId')
    await route.fulfill({ json: { success: true, data: { storeId, ...setup } } })
  })
  if (firstStep === 'richMenu') {
    await page.route('**/api/rich-menu-groups?**', route =>
      route.fulfill({ json: { success: true, data: { items: [], total: 0 } } }))
  }
  await page.route('**/api/restaurant-test/inventory/allocation?**', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    setup.reception = route.request().postDataJSON().lineCapacity > 0
    await route.fulfill({ json: { success: true, data: {} } })
  })
  let saves = 0
  await page.route('**/api/restaurant-test/tables?**', async route => {
    if (route.request().method() !== 'POST') return route.fallback()
    saves += 1
    if (saves === 1) {
      return route.fulfill({ status: 500, json: { success: false, error: '卓を保存できませんでした' } })
    }
    setup.tables = true
    return route.fulfill({ json: { success: true, data: { id: 'qa-table-1' } } })
  })
  await page.route('**/api/restaurant-test/floors/**', async route => {
    if (route.request().method() !== 'PUT') return route.fallback()
    return route.fulfill({ json: { success: true, data: route.request().postDataJSON() } })
  })
}

test('保存の失敗に留まり、成功後は手順3を再開して営業時間へ進む', async ({ page }, testInfo) => {
  await openFixture(page)
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/tables$/)
  await page.locator('[data-guide-anchor="tables.create"]').click()
  await expect(page.locator(tableForm)).toBeVisible()

  const form = page.getByRole('dialog', { name: '卓を作る' })
  await form.getByRole('textbox', { name: '卓番', exact: true }).fill('QA01')
  await form.getByRole('textbox', { name: '表示名', exact: true }).fill('検証用の卓')
  const save = form.getByRole('button', { name: '卓を作る', exact: true })
  await save.click()
  await expect(form.getByRole('alert')).toContainText('卓を保存できませんでした')
  await expect(page.locator(tableForm)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('table-save-failure.png') })

  await save.click()
  await expect(page.locator('[data-guide-balloon="attributes:3"]')).toBeVisible()
  const next = page.getByRole('button', { name: '次へ進む', exact: true })
  await expect(next).toBeVisible()
  await page.locator(guideBar).getByRole('button', { name: '一時停止' }).click()
  await page.getByRole('link', { name: 'ダッシュボード', exact: true }).click()
  const resume = page.getByRole('button', { name: '続きから進める' })
  await expect(resume).toBeVisible()
  await page.reload()
  await resume.click()
  await expect(next).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('table-next-after-reload.png') })
  await next.click()
  await expect(page).toHaveURL(/\/settings\/sns$|\/restaurant-test\/google\?tab=hours$/)
})

test('台本のない段もガイドを操作できる', async ({ page }) => {
  await openFixture(page, { firstStep: 'richMenu' })
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  await expect(page).toHaveURL(/\/getting-started\/rich-menu$/)
  await expect(page.locator(guideBar)).toContainText('リッチメニューを選ぶ')
  await page.locator(guideBar).getByRole('button', { name: 'この手順をスキップ' }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/tables$/)
})

test('狭いPCでもスワイプを案内せず、設定の操作はカードに収まる', async ({ page }, testInfo) => {
  await openFixture(page, { width: 454 })
  await page.goto(base)
  const popup = page.getByRole('dialog', { name: '開店準備を始めましょう' })
  await expect(popup.getByRole('button', { name: 'あとで', exact: true })).toBeVisible()
  await expect(popup.getByText('閉じたあとは右上', { exact: false })).toBeVisible()
  await popup.getByRole('button', { name: 'あとで', exact: true }).click()
  await page.goto(`${base}/getting-started`)
  const actions = page.getByRole('region', { name: '最初の1通の確認方法' })
  const send = actions.getByRole('link', { name: 'シナリオを選んでテスト送信する' })
  await expect(send).toBeVisible()
  const card = await actions.boundingBox()
  const button = await send.boundingBox()
  expect(button.x + button.width).toBeLessThanOrEqual(card.x + card.width)
  await page.screenshot({ path: testInfo.outputPath('narrow-desktop-settings.png'), fullPage: true })
})

test('店舗の進捗を読む間は暫定値を表示しない', async ({ page }) => {
  let finishProgress
  const delayProgress = new Promise(resolve => { finishProgress = resolve })
  await openFixture(page, { delayProgress })
  await page.goto(`${base}/getting-started`, { waitUntil: 'domcontentloaded' })
  try {
    await expect(page.getByRole('heading', { name: 'はじめの設定', exact: true })).toBeVisible()
    await expect(page.getByText(/\d+ \/ 8 済み/)).toHaveCount(0)
  } finally {
    finishProgress()
  }
  await expect(page.getByText(/\d+ \/ 8 済み/)).toBeVisible()
  await expect(page.getByRole('table', { name: 'はじめの設定の順路' }).getByRole('row')).toHaveCount(8)
})

test('受付開始後は公開前の案内を出し、あとでを押すと来店フォローへ進む', async ({ page }, testInfo) => {
  await openFixture(page, { storeProgress: { tables: true, hours: true, menus: true } })
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/inventory$/)
  await page.getByRole('spinbutton', { name: '予約サイト', exact: true }).fill('0')
  await page.getByRole('spinbutton', { name: '当日（ウォークイン）', exact: true }).fill('0')
  await page.getByRole('spinbutton', { name: 'LINE 専用', exact: true }).fill('1')
  await expect(page.locator('[data-guide-balloon="scenario:2"]')).toBeVisible()
  const save = page.getByRole('button', { name: '受付時間と配分を保存', exact: true })
  await save.click()
  const announcement = page.getByRole('dialog', { name: '予約の受け付けが始まりました' })
  await expect(announcement).toBeVisible()
  await expect(announcement.getByRole('button', { name: 'リッチメニューを公開する' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('reception-rich-menu-prompt.png') })
  await announcement.getByRole('button', { name: 'あとで', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/line-followup$/)
  await expect(page.locator('[data-guide-balloon="followup:1"]')).toBeVisible()
})
