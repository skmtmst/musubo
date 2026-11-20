import { test, expect } from '@playwright/test'
import { routeLocalApi } from './local-api.mjs'
import { RICH_MENU_GROUP_DETAILS } from './fixtures.mjs'

const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:3101'
const mock = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:8788'
const accountId = 'visual-qa-account'
const guideBar = '[data-guide-bar]'
const tableForm = '[data-guide-balloon="attributes:2"]'

async function openFixture(page, { width = 1440, firstStep = 'attributes', delayProgress, storeProgress = {}, onMenuSave } = {}) {
  await routeLocalApi({ page })
  await page.setViewportSize({ width, height: 1000 })
  await page.request.put(`${mock}/api/dashboard/style?accountId=${accountId}`, { data: { style: 'restaurant' } })
  let guide = { phase: 'idle', stepKey: null, procedureIndex: 1, updatedAt: '2026-11-20T00:00:00Z' }
  await page.route('**/api/getting-started/guide?**', route => {
    if (route.request().method() === 'PUT') {
      const { phase, stepKey, procedureIndex } = route.request().postDataJSON()
      guide = { ...guide, phase, stepKey, procedureIndex }
    }
    return route.fulfill({ json: { success: true, data: guide } })
  })
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
    let items = []
    await page.route('**/api/rich-menu-groups?**', route =>
      route.fulfill({ json: { success: true, data: { items, total: items.length } } }))
    await page.route('**/api/dashboard/style?**', async route => {
      if (route.request().method() !== 'PUT') return route.fallback()
      onMenuSave?.(route.request().postDataJSON())
      items = [{ id: 'qa-menu-preset', accountId, status: 'draft' }]
      await route.fulfill({ json: { success: true, data: { version: 2 } } })
    })
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

test('初回だけウェルカムを出し、スキップ後は再読込しても開店準備から始まる', async ({ page }, testInfo) => {
  await openFixture(page)
  const idle = { phase: 'idle', stepKey: null, procedureIndex: 1 }
  let seenAt = null
  await page.route('**/api/getting-started/guide?**', async route => {
    if (route.request().method() === 'PUT') {
      expect(route.request().postDataJSON()).toEqual({ ...idle, acknowledgeWelcome: true })
      seenAt = '2026-11-20T00:00:00Z'
    }
    await route.fulfill({ json: { success: true, data: { ...idle, updatedAt: seenAt } } })
  })
  await page.goto(base)
  const welcome = page.getByRole('dialog', { name: 'ようこそ' })
  await expect(welcome.getByRole('img', { name: 'musubo' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('guide-welcome.png') })
  await welcome.getByRole('button', { name: 'タップでスキップ' }).click()
  const popup = page.getByRole('dialog', { name: '開店準備を始めましょう' })
  await expect(popup).toBeVisible()
  await expect.poll(() => seenAt).not.toBeNull()
  await page.reload()
  await expect(popup).toBeVisible()
  await expect(welcome).toHaveCount(0)
})

test('保存の失敗に留まり、成功後は手順3を再開して営業時間へ進む', async ({ page }, testInfo) => {
  await openFixture(page)
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/tables$/, { timeout: 15000 })
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
  await expect(page).toHaveURL(/\/settings\/sns$|\/restaurant-test\/google\?tab=hours$/, { timeout: 15000 })
})

test('Penの5つの型から選んだリッチメニューを保存し、卓へ進む', async ({ page }, testInfo) => {
  let saved
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, { firstStep: 'richMenu', onMenuSave: data => { saved = data } })
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  const menuPicker = page.getByRole('dialog', { name: /リッチメニューを選ぶ/ })
  await expect(menuPicker.getByRole('article')).toHaveCount(5)
  await expect(menuPicker.getByRole('button', { name: 'これにする', exact: true })).toHaveCount(5)
  const bounds = await menuPicker.boundingBox()
  expect(bounds.width).toBeCloseTo(860, 0)
  expect(Math.abs(bounds.height - 726)).toBeLessThanOrEqual(1)
  const note = menuPicker.getByText('クーポン等の強調色も各型のパレット内で統一', { exact: true })
  const noteBounds = await note.boundingBox()
  expect(noteBounds.x + noteBounds.width).toBeLessThan(bounds.x + bounds.width)
  await page.screenshot({ path: testInfo.outputPath('guide-menu-picker.png') })
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(menuPicker.getByRole('button', { name: '0から自分で作る' })).toBeVisible()
  const mobile = await menuPicker.boundingBox()
  expect(mobile.x + mobile.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: testInfo.outputPath('guide-menu-picker-mobile.png') })
  const night = menuPicker.getByRole('article', { name: '夜（深い紺）', exact: true })
  await night.getByRole('button', { name: 'これにする', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/tables$/, { timeout: 15000 })
  expect(saved.answers.restaurantMenuPreset).toEqual({ mode: 'configured', value: 'night' })
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
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, { storeProgress: { tables: true, hours: true, menus: true } })
  await page.route('**/api/rich-menu-groups?**', async route => {
    if (new URL(route.request().url()).searchParams.get('filter') !== 'draft') return route.fallback()
    const menu = { ...RICH_MENU_GROUP_DETAILS['rmg-2'], accountId, name: '検証用リッチメニュー', size: 'large', status: 'draft', thumbnailR2Key: 'qa-thumb-autumn' }
    await route.fulfill({ json: { success: true, data: { items: [menu], total: 1 } } })
  })
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/inventory$/, { timeout: 15000 })
  for (const [label, value] of [['予約サイト', '0'], ['当日（ウォークイン）', '0'], ['LINE 専用', '1']]) {
    const input = page.getByRole('spinbutton', { name: label, exact: true })
    await input.press('ControlOrMeta+a')
    await input.press(value)
    await expect(input).toHaveValue(value)
  }
  await expect(page.locator('[data-guide-balloon="scenario:2"]')).toBeVisible()
  const save = page.getByRole('button', { name: '受付時間と配分を保存', exact: true })
  await expect(save).toBeEnabled()
  await save.click()
  const announcement = page.getByRole('dialog', { name: '予約の受け付けが始まりました' })
  await expect(announcement).toBeVisible()
  await expect(announcement.getByRole('button', { name: 'リッチメニューを公開する' })).toBeVisible()
  await expect(announcement.getByRole('img', { name: '検証用リッチメニュー' })).toBeVisible()
  await expect(announcement.getByRole('button', { name: '閉じる', exact: true })).toHaveCount(0)
  const bounds = await announcement.boundingBox()
  expect(bounds.x).toBeCloseTo(450, 0)
  expect(bounds.y).toBeCloseTo(245, 0)
  expect(bounds.width).toBeCloseTo(540, 0)
  expect(bounds.height).toBeCloseTo(510, 0)
  await page.screenshot({ path: testInfo.outputPath('reception-rich-menu-prompt.png'), animations: 'disabled' })
  await announcement.getByRole('button', { name: 'リッチメニューを公開する', exact: true }).click()
  await expect(page).toHaveURL(/\/rich-menus\/edit\?id=rmg-2&step=publish$/, { timeout: 15000 })
  await expect(page.getByRole('heading', { name: '公開の前の確認', exact: true })).toBeVisible({ timeout: 15000 })
  await page.goBack()
  await announcement.getByRole('button', { name: 'あとで', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/line-followup$/, { timeout: 15000 })
  await expect(page.locator('[data-guide-balloon="followup:1"]')).toBeVisible()
})

test('一時停止中に受付を止めても最初の未完了項目から始め直せる', async ({ page }) => {
  await openFixture(page, { storeProgress: { tables: true, hours: true, menus: true, reception: true, followup: true } })
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  const receive = page.getByRole('dialog', { name: '最初の1通を受け取る', exact: false })
  await expect(receive).toBeVisible()
  await receive.getByRole('button', { name: 'あとで', exact: true }).click()
  await page.getByRole('link', { name: '予約枠・在庫', exact: true }).click()
  for (const label of ['予約サイト', '当日（ウォークイン）', 'LINE 専用']) {
    const input = page.getByRole('spinbutton', { name: label, exact: true })
    await input.press('ControlOrMeta+a')
    await input.press('0')
    await expect(input).toHaveValue('0')
  }
  const save = page.getByRole('button', { name: '受付時間と配分を保存', exact: true })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.getByText('受付時間と配分を保存しました。予約サイトへは書き戻していません。')).toBeVisible()
  await page.getByRole('link', { name: 'ダッシュボード', exact: true }).click()
  await expect(page.getByRole('button', { name: /開店準備 6\/8。ガイドを再開する/ })).toBeVisible()
  await page.getByRole('button', { name: '最初から始める', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/inventory$/, { timeout: 15000 })
  await expect(page.locator(guideBar)).toContainText('予約枠と在庫を設定する')
})

test('QRで待機し、閉じている間に届いた最初の1通も再読込で完了を表示する', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, { storeProgress: { tables: true, hours: true, menus: true, reception: true, followup: true } })
  let delivered = false
  await page.route('**/api/getting-started?**', async route => {
    const response = await page.request.get(`${mock}/api/getting-started?version=v8`)
    const data = await response.json()
    const firstMessage = data.data.steps.find(step => step.key === 'firstMessage')
    firstMessage.state = delivered ? 'done' : 'todo'
    await route.fulfill({ json: data })
  })
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  const receive = page.getByRole('dialog', { name: /最初の1通を受け取る/ })
  await expect(receive.getByRole('img', { name: '友だち追加のQRコード' })).toBeVisible()
  await expect(receive.getByText('8/8', { exact: true })).toBeVisible()
  await expect(receive.getByRole('status')).toContainText('受信を待っています')
  const receiveBounds = await receive.boundingBox()
  expect(receiveBounds.width).toBeCloseTo(640, 0)
  expect(Math.abs(receiveBounds.height - 368)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('guide-receive.png') })
  await receive.getByRole('button', { name: 'あとで', exact: true }).click()
  await expect(receive).toHaveCount(0)
  delivered = true
  await page.reload()
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
