import { test, expect } from '@playwright/test'
import { routeLocalApi } from './local-api.mjs'
import { RICH_MENU_GROUP_DETAILS } from './fixtures.mjs'

const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:3101'
const mock = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:8788'
const accountId = 'visual-qa-account'
const guideBar = '[data-guide-bar]'
const tableForm = '[data-guide-balloon="attributes:2"]'

async function openFixture(page, { width = 1440, height = 1000, initialGuide, firstStep = 'attributes', delayProgress, storeProgress = {}, onMenuSave, menuSaveFailures = [] } = {}) {
  await routeLocalApi({ page })
  await page.setViewportSize({ width, height })
  await page.request.put(`${mock}/api/dashboard/style?accountId=${accountId}`, { data: { style: 'restaurant' } })
  let guide = { phase: 'idle', stepKey: null, procedureIndex: 1, updatedAt: '2026-11-20T00:00:00Z', ...initialGuide }
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
      const failure = menuSaveFailures.shift()
      if (failure) return route.fulfill(failure)
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

test('接続済みなら設定を残してリッチメニューから始められる', async ({ page }) => {
  await openFixture(page, { initialGuide: { phase: 'paused', stepKey: 'attributes', procedureIndex: 2 } })
  await page.goto(base)
  const restart = page.getByRole('button', { name: '最初から始める', exact: true })
  await expect(restart).toBeVisible()
  await restart.click()
  const picker = page.getByRole('dialog', { name: /リッチメニューを選ぶ/ })
  await expect(picker).toBeVisible()
  await page.reload()
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: 'あとで', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/tables/)
})

test('Webhookが一致した時だけ0/8から次へ進める', async ({ page }) => {
  await openFixture(page, { firstStep: 'richMenu' })
  let checks = 0
  await page.route(url => url.pathname === '/api/getting-started', async route => {
    const url = new URL(route.request().url())
    const existing = await (await page.request.get(mock + url.pathname + url.search)).json()
    const line = existing.data.steps.find(step => step.key === 'accounts')
    line.state = checks > 1 ? 'done' : 'stalled'
    return route.fulfill({ json: existing })
  })
  await page.route(url => url.pathname === '/api/line-accounts', async route => {
    const existing = await (await page.request.get(mock + '/api/line-accounts')).json()
    const account = existing.data.find(item => item.id === accountId)
    return route.fulfill({ json: { success: true, data: [{ ...account, revision: 7 }] } })
  })
  await page.route(url => url.pathname === `/api/line-accounts/${accountId}/connection-checks`, async route => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().headers()['idempotency-key']).toBeTruthy()
    expect(route.request().postDataJSON()).toEqual({ expectedRevision: 7 })
    checks += 1
    return route.fulfill({ json: { success: true, data: { accountId, checks: [{
      kind: 'webhook_endpoint', webhookActive: checks > 1, result: checks > 1 ? 'matched' : 'mismatched',
    }] } } })
  })
  await page.goto(base)
  await expect(page.getByText(/開店準備 0\/8.*再開できます/)).toBeVisible()
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  await expect(page).toHaveURL(/\/accounts$/)
  const rowMenu = page.locator(`[data-row-id="${accountId}"]`).locator('[data-row-menu]')
  const check = page.getByRole('menuitem', { name: '接続をもう一度確かめる' })
  await rowMenu.click()
  await check.click()
  await expect(page.getByText(/Webhook接続を確認できませんでした/)).toBeVisible()
  await expect(page.locator(guideBar)).toContainText('LINEアカウント')
  await rowMenu.click()
  await check.click()
  await expect(page.getByRole('dialog', { name: /リッチメニューを選ぶ/ })).toBeVisible()
  expect(checks).toBe(2)
})

test('保存の失敗に留まり、成功後は手順3を再開して営業時間へ進む', async ({ page }, testInfo) => {
  await openFixture(page)
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/tables$/, { timeout: 15000 })
  await page.locator('[data-guide-anchor="tables.create"]').click()
  await expect(page.locator(tableForm)).toBeVisible()

  const form = page.getByRole('dialog', { name: '卓を作る' })
  await form.getByRole('textbox', { name: '卓の名前', exact: true }).fill('検証用の卓')
  const save = form.getByRole('button', { name: '保存する', exact: true })
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
  await expect(page).toHaveURL(/\/restaurant-test\/google\?tab=hours$/, { timeout: 15000 })
})

test('Penの5つの型を表示し、欄のエラーを確認してから保存すると卓へ進む', async ({ page }, testInfo) => {
  let saved
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, {
    firstStep: 'richMenu',
    onMenuSave: data => { saved = data },
    menuSaveFailures: [
      { status: 422, json: { error: '入力内容を確認してください', fields: { 'answers.restaurantMenuPreset': 'リッチメニューの型を選び直してください' } } },
      { status: 409, json: { code: 'version_conflict', error: '設定が変更されました。読み直してください。' } },
    ],
  })
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
  const selectNight = night.getByRole('button', { name: 'これにする', exact: true })
  await selectNight.click()
  const presetGroup = menuPicker.getByRole('group', { name: 'リッチメニューの型' })
  await expect(presetGroup).toHaveAttribute('aria-invalid', 'true')
  await expect(presetGroup).toHaveAccessibleDescription('リッチメニューの型を選び直してください')
  await expect(selectNight).toBeEnabled()
  await selectNight.click()
  const reload = menuPicker.getByRole('button', { name: '読み直す', exact: true })
  await expect(reload).toBeVisible()
  await expect(selectNight).toBeDisabled()
  await reload.click()
  await expect(selectNight).toBeEnabled()
  await selectNight.click()
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
    if (route.request().method() !== 'GET') return route.fallback()
    const menu = { ...RICH_MENU_GROUP_DETAILS['rmg-2'], accountId, name: '検証用リッチメニュー', size: 'large', status: 'draft', thumbnailR2Key: 'qa-thumb-autumn' }
    await route.fulfill({ json: { success: true, data: { items: [menu], total: 1 } } })
  })
  await page.goto(base)
  await page.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/inventory$/, { timeout: 15000 })
  await page.getByRole('button', { name: '予約サイト・当日枠などの詳しい配分', exact: true }).click()
  for (const [label, value] of [['予約サイト', '0'], ['当日（ウォークイン）', '0'], ['LINEで受ける席数（各枠）', '1']]) {
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
  await expect(page.locator(guideBar)).toContainText('予約枠と在庫を設定する')
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
  await page.getByRole('dialog', { name: /リッチメニューを選ぶ/ }).getByRole('button', { name: 'あとで', exact: true }).click()
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

for (const [width, height] of [[1440, 1000], [1152, 768], [390, 844], [667, 375]]) {
  test(`卓の作成中もフォームとガイドの操作に届く ${width}×${height}`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openFixture(page, { width, height, initialGuide: { phase: 'active', stepKey: 'attributes', procedureIndex: 2 } })
    await page.goto(`${base}/restaurant-test/tables`)
    const form = page.getByRole('dialog', { name: '卓を作る' })
    const name = form.getByRole('textbox', { name: '卓の名前' })
    await name.fill('窓側')
    const plus = form.getByRole('button', { name: '席数を増やす' })
    for (let count = 0; count < 2; count++) await plus.click()
    await expect(form.getByLabel('席数', { exact: true })).toHaveText('4 席')
    await form.getByRole('button', { name: '席の種類' }).click()
    await page.getByRole('option', { name: 'カウンター', exact: true }).click()
    await form.getByRole('button', { name: '保存する', exact: true }).click({ trial: true })
    const stop = form.getByRole('button', { name: '一時停止' })
    const skip = form.getByRole('button', { name: 'この手順をスキップ' })
    await stop.click({ trial: true })
    await skip.click({ trial: true })
    if (width === 1440) {
      const panel = await form.boundingBox()
      expect(panel.width).toBeCloseTo(500, 0)
      const balloon = await page.locator(tableForm).boundingBox()
      expect(balloon.x).toBeGreaterThan(panel.x + panel.width)
      const saveBox = await form.getByRole('button', { name: '保存する', exact: true }).boundingBox()
      const ring = await page.locator('[data-guide-spotlight="tables.form"]').boundingBox()
      expect(ring.width).toBeLessThan(saveBox.width + 40)
      expect(Math.abs((ring.x + ring.width / 2) - (saveBox.x + saveBox.width / 2))).toBeLessThan(2)
    }
    await page.screenshot({ path: info.outputPath('guided-table.png') })
    const visited = new Set()
    for (let tab = 0; tab < 18; tab++) {
      await page.keyboard.press('Tab')
      visited.add(await page.evaluate(() => document.activeElement?.textContent?.trim()))
    }
    expect(visited).toContain('一時停止')
    expect(visited).toContain('この手順をスキップ')
    if (width === 1440) {
      await form.getByRole('button', { name: 'キャンセル', exact: true }).click()
      await expect(form).toHaveCount(0)
      await expect(page.locator(guideBar)).toHaveCount(0)
    }
  })
}

test('公開確認では最後の公開ボタンにガイドが移る', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, { initialGuide: { phase: 'active', stepKey: 'friendAdd', procedureIndex: 2 }, storeProgress: { tables: true, hours: true } })
  await page.goto(`${base}/restaurant-test/menu/edit`)
  await expect(page.locator('[data-guide-spotlight="menu.form"]')).toBeVisible()
  const basics = page.locator('[data-guide-balloon="friendAdd:2"]')
  const duration = page.getByRole('button', { name: '所要時間', exact: true })
  await expect(duration).toHaveText('所要時間を選ぶ')
  await expect(page.getByRole('button', { name: '提供時間', exact: true })).toHaveText('提供時間帯を選ぶ')
  await page.screenshot({ path: info.outputPath('guided-course-empty.png') })
  await page.getByRole('textbox', { name: 'メニュー名' }).fill('ガイド検証用')
  await page.getByRole('spinbutton', { name: '価格（税込）' }).fill('4200')
  const next = basics.getByRole('button', { name: '次へ', exact: true })
  await expect(next).toBeDisabled()
  await duration.click()
  await page.getByRole('option', { name: '2時間30分（150分）', exact: true }).click()
  await expect(next).toBeEnabled()
  await page.screenshot({ path: info.outputPath('guided-course-basics.png') })
  await next.click()
  await expect(page.locator('[data-guide-balloon="friendAdd:3"]')).toBeVisible()
  await page.getByRole('button', { name: '保存する状態', exact: true }).click()
  await page.getByRole('option', { name: '公開', exact: true }).click()
  await page.getByRole('button', { name: '保存して追加する', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: 'このメニューを公開しますか？' })
  await expect(confirmation.locator(guideBar)).toBeVisible()
  await confirmation.getByRole('button', { name: '一時停止', exact: true }).click({ trial: true })
  const confirm = confirmation.getByRole('button', { name: '公開して追加する', exact: true })
  await expect(confirm).toHaveAttribute('data-guide-anchor', 'menu.save')
  await expect(confirmation.locator('[data-guide-balloon]')).toContainText('「公開して追加する」')
  await confirm.click({ trial: true })
  await page.screenshot({ path: info.outputPath('guided-course-confirmation.png') })
  await confirmation.getByRole('button', { name: 'キャンセル', exact: true }).click()
  await expect(page.locator('[data-guide-balloon="friendAdd:3"]')).toBeVisible()
})

test('取り込んだ営業時間の確定は予約枠の作成成功まで次へ進めない', async ({ page }, info) => {
  await openFixture(page, { initialGuide: { phase: 'active', stepKey: 'hours', procedureIndex: 2 }, storeProgress: { tables: true, hours: true } })
  let requests = 0
  let existingSlots = 0
  await page.route('**/api/restaurant-test/inventory/generate?**', async route => {
    const body = route.request().postDataJSON()
    expect(body).toMatchObject({ storeId: 'store-sby', expectedHoursVersion: 4, otaCapacity: 0, lineCapacity: 0, walkInCapacity: 0 })
    requests += 1
    if (requests === 1) return route.fulfill({ status: 409, json: { success: false, error: '営業時間が変わりました。読み直してください。' } })
    return route.fulfill({ json: { success: true, data: { generated: 0, slotCount: existingSlots, slotMinutes: 30 } } })
  })
  await page.goto(`${base}/restaurant-test/google?tab=hours`)
  await expect(page.getByRole('heading', { name: 'Googleビジネス', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: '取り込んだ営業時間' })).toBeVisible()
  const reload = page.getByRole('button', { name: 'Googleから再読み込み' })
  await reload.click({ trial: true })
  const confirm = page.getByRole('button', { name: 'この営業時間で確定', exact: true })
  await expect(confirm).toHaveAttribute('data-guide-anchor', 'hours.confirm')
  await page.screenshot({ path: info.outputPath('guided-hours-confirmation.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await reload.click({ trial: true })
  await confirm.click({ trial: true })
  await page.screenshot({ path: info.outputPath('guided-hours-confirmation-mobile.png') })
  await confirm.click()
  await expect(page.getByText('営業時間が変わりました。読み直してください。')).toBeVisible()
  await expect(page.locator('[data-guide-balloon="hours:2"]')).toBeVisible()
  await confirm.click()
  await expect(page.getByText('予約枠を作れる営業日がありません。Googleの営業時間を確認してください。')).toBeVisible()
  await expect(page.locator('[data-guide-balloon="hours:2"]')).toBeVisible()
  existingSlots = 4
  await confirm.click()
  await expect(page).toHaveURL(/\/restaurant-test\/menu$/)
  expect(requests).toBeGreaterThan(1)
})

test('来店フォローのおすすめ候補を表示したまま後で使う選択もできる', async ({ page }, info) => {
  await openFixture(page, { initialGuide: { phase: 'active', stepKey: 'followup', procedureIndex: 1 }, storeProgress: { tables: true, hours: true, menus: true, reception: true } })
  await page.goto(`${base}/restaurant-test/line-followup`)
  await expect(page.getByRole('switch', { name: '予約したときを使う' })).toBeChecked()
  await expect(page.getByRole('switch', { name: '前日の確認を使う' })).toBeChecked()
  await expect(page.getByRole('button', { name: '保存して作る' })).toBeEnabled()
  await page.screenshot({ path: info.outputPath('guided-followup-initial.png') })
  await page.getByRole('button', { name: '今は使わない', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '今は使わないと設定しますか' })
  await expect(confirmation.locator(guideBar)).toBeVisible()
  await confirmation.getByRole('button', { name: '今は使わない', exact: true }).click({ trial: true })
  await page.screenshot({ path: info.outputPath('guided-followup-later.png') })
})

test('スマホでLINEアカウントの操作を開ける', async ({ browser }, info) => {
  const viewport = { width: 390, height: 844 }
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true })
  try {
    const page = await context.newPage()
    await openFixture(page, { ...viewport, initialGuide: { phase: 'active', stepKey: 'accounts', procedureIndex: 1 } })
    await page.route(url => url.pathname === '/api/getting-started', async route => {
      const url = new URL(route.request().url())
      const progress = await (await page.request.get(mock + url.pathname + url.search)).json()
      progress.data.steps.find(step => step.key === 'accounts').state = 'stalled'
      return route.fulfill({ json: progress })
    })
    await page.goto(`${base}/accounts`)
    const table = page.getByRole('table', { name: 'LINEアカウントの一覧' })
    await expect(table).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
    const register = page.getByRole('link', { name: 'LINEアカウントを登録' })
    const box = await register.boundingBox()
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    await table.locator(`[data-row-id="${accountId}"] [data-row-menu]`).tap()
    await expect(page.getByRole('menuitem', { name: '接続をもう一度確かめる' })).toBeVisible()
    await page.screenshot({ path: info.outputPath('guided-accounts-touch-menu.png') })
  } finally {
    await context.close()
  }
})

test('タッチ幅の画面でもガイドがGoogle接続と来店フォロー保存を覆わない', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  try {
    const page = await context.newPage()
    await openFixture(page, { width: 390, height: 844,
      initialGuide: { phase: 'active', stepKey: 'hours', procedureIndex: 1 }, storeProgress: { tables: true } })
    await page.route('**/api/restaurant-test/google/connection?**', async route => {
      const url = new URL(route.request().url())
      const data = await (await page.request.get(mock + url.pathname + url.search)).json()
      data.connection = { ...data.connection, status: 'disconnected', locationName: null }
      return route.fulfill({ json: data })
    })
    await page.route('**/api/restaurant-test/google/connect/start?**', route => route.fulfill({
      status: 502, json: { success: false, error: '接続確認の試験' },
    }))
    await page.goto(`${base}/restaurant-test/google?tab=hours`)
    const connect = page.getByRole('button', { name: 'Googleアカウントとつなぐ' })
    await connect.tap()
    await expect(page.getByText('Googleの許可画面を開けませんでした。もう一度お試しください。')).toBeVisible()

    const followup = await context.newPage()
    await openFixture(followup, { width: 390, height: 844,
      initialGuide: { phase: 'active', stepKey: 'followup', procedureIndex: 1 },
      storeProgress: { tables: true, hours: true, menus: true, reception: true } })
    await followup.goto(`${base}/restaurant-test/line-followup`)
    const save = followup.getByRole('button', { name: '保存して作る', exact: true })
    await save.tap({ trial: true })
    await followup.screenshot({ path: info.outputPath('guided-followup-touch-save.png') })
  } finally {
    await context.close()
  }
})

test('営業時間の編集パネル内で説明を読んで次の操作に進める', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, {
    width: 390, height: 844,
    initialGuide: { phase: 'active', stepKey: 'hours', procedureIndex: 2 },
    storeProgress: { tables: true, hours: true },
  })
  await page.goto(`${base}/restaurant-test/google?tab=hours&mode=weekly`)
  const editor = page.getByRole('dialog', { name: '毎週の営業時間を編集' })
  await expect(editor.locator('[data-guide-balloon="hours:2"]')).toContainText('「変更内容を確認」')
  await editor.getByRole('button', { name: '一時停止', exact: true }).click({ trial: true })
  await expect(editor.getByRole('button', { name: '変更内容を確認' })).toHaveAttribute('data-guide-anchor', 'hours.confirm')
  await page.screenshot({ path: info.outputPath('guided-hours-editor.png') })
})

test('来店フォローは明示保存でおすすめ2件を下書きにする', async ({ page }) => {
  await openFixture(page, { initialGuide: { phase: 'active', stepKey: 'followup', procedureIndex: 1 }, storeProgress: { tables: true, hours: true, menus: true, reception: true } })
  const writes = []
  let initializedRows
  await page.route('**/api/restaurant-test/followups/**', async route => {
    if (route.request().method() === 'GET') return route.fallback()
    const path = new URL(route.request().url()).pathname
    writes.push(path.split('/').pop())
    if (!path.endsWith('/engines/initialize')) return route.fulfill({ status: 403, json: { success: false } })
    initializedRows = route.request().postDataJSON().rows
    await route.fulfill({ json: { success: true, data: {} } })
  })
  await page.goto(`${base}/restaurant-test/line-followup`)
  const save = page.getByRole('button', { name: '保存して作る', exact: true })
  await expect(save).toBeEnabled()
  expect(writes).toHaveLength(0)
  await save.click()
  await expect.poll(() => initializedRows?.filter(row => row.input.enabled).map(row => row.trigger)).toEqual(['reservation_created', 'reservation_24h'])
  await expect(page.getByRole('dialog', { name: /最初の1通を受け取る/ })).toBeVisible()
  expect(writes).toEqual(['initialize'])
})

test('Googleに接続した状態で戻っても取込内容を確認する', async ({ page }, info) => {
  await openFixture(page, {
    initialGuide: { phase: 'active', stepKey: 'hours', procedureIndex: 1 },
    storeProgress: { tables: true, hours: true },
  })
  await page.goto(`${base}/restaurant-test/google?tab=hours&google=connected`)
  await expect(page.getByRole('heading', { name: '取り込んだ営業時間' })).toBeVisible()
  await expect(page.locator('[data-guide-balloon="hours:2"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'この営業時間で確定' })).toBeEnabled()
  await page.screenshot({ path: info.outputPath('after-google-connect.png') })
})

test('枠がない日は配分を保存済みにせず、枠作成を案内する', async ({ page }, info) => {
  await openFixture(page, {
    initialGuide: { phase: 'active', stepKey: 'scenario', procedureIndex: 1 },
    storeProgress: { tables: true, hours: true, menus: true },
  })
  await page.route('**/api/restaurant-test/inventory/day?**', route => route.fulfill({ json: { success: true, data: [], closures: [] } }))
  await page.goto(`${base}/restaurant-test/inventory`)
  const empty = page.getByText('この日の時間帯がありません')
  await expect(empty).toBeVisible()
  const line = page.getByRole('spinbutton', { name: 'LINEで受ける席数（各枠）' })
  await line.fill('1')
  await expect(page.getByRole('button', { name: '受付時間と配分を保存' })).toBeDisabled()
  await expect(page.locator('[data-guide-balloon="scenario:1"]')).toContainText('「この日の枠を作る」')
  await expect(page.getByRole('button', { name: 'この日の枠を作る' })).toHaveAttribute('data-guide-anchor', 'reception.lineSeats')
  await page.screenshot({ path: info.outputPath('empty-inventory.png') })
})

test('リッチメニューがすでに公開中なら公開案内を飛ばす', async ({ page }, info) => {
  await openFixture(page, {
    initialGuide: { phase: 'active', stepKey: 'scenario', procedureIndex: 2 },
    storeProgress: { tables: true, hours: true, menus: true, reception: true },
  })
  await page.route('**/api/rich-menu-groups?**', route => route.fulfill({ json: {
    success: true,
    data: { items: [{ id: 'rmg-live', accountId, status: 'published' }], total: 1, facets: { published: 1 } },
  } }))
  await page.goto(`${base}/restaurant-test/inventory`)
  await expect(page).toHaveURL(/\/restaurant-test\/line-followup$/)
  await expect(page.locator('[data-guide-balloon="followup:1"]')).toBeVisible()
  await expect(page.getByRole('dialog', { name: '予約の受け付けが始まりました' })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('after-already-published.png') })
})

test('スマホの上部から閉じたガイドを開き直せる', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  try {
    await openFixture(page, { width: 390, height: 900 })
    await page.goto(base)
    const popup = page.getByRole('dialog', { name: '開店準備を始めましょう' })
    await popup.getByRole('button', { name: /あとで/ }).tap()
    await expect(popup).toHaveCount(0)
    const reopen = page.getByRole('button', { name: /開店準備.*はじめにやることを開く/ })
    await expect(reopen).toBeInViewport()
    await page.screenshot({ path: info.outputPath('mobile-guide-reopen.png') })
    await reopen.tap()
    await expect(popup).toBeVisible()
  } finally {
    await context.close()
  }
})

test('コースの写真は5枚まで。並べ替えと正方形の表示範囲を保存する', async ({ page }, testInfo) => {
  await openFixture(page, {
    initialGuide: { phase: 'active', stepKey: 'friendAdd', procedureIndex: 2 },
    storeProgress: { tables: true, hours: true },
  })
  const images = Array.from({ length: 5 }, (_, index) => ({
    id: `qa-dish-${index}`, lineAccountId: accountId, kind: 'image', filename: `検証写真 ${index + 1}.png`,
  }))
  await page.route('**/api/media?**', route => route.fulfill({ json: { success: true, data: { items: images, total: images.length } } }))
  await page.route('**/api/media/qa-dish-*/content?**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="green"/></svg>',
  }))
  let submitted
  await page.route('**/api/restaurant-test/menu?**', route => {
    if (route.request().method() !== 'POST') return route.fallback()
    submitted = route.request().postDataJSON()
    return route.fulfill({ json: { success: true, data: { id: 'course-gallery-1' } } })
  })
  await page.goto(`${base}/restaurant-test/menu/edit`)
  const add = page.getByRole('button', { name: '写真を追加', exact: true })
  for (const image of images) {
    await add.click()
    await page.getByRole('option', { name: `${image.filename} 画像`, exact: true }).click()
  }
  const gallery = page.getByRole('list', { name: 'コースの写真' })
  const tile = gallery.getByRole('button', { name: /表示範囲を調整/ })
  await expect(tile).toHaveCount(5)
  await expect(add).toHaveCount(0)
  await tile.nth(1).click()
  const crop = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '写真の表示範囲を調整' }) })
  await crop.getByRole('slider', { name: '左右の位置' }).fill('73')
  await crop.getByRole('button', { name: '前へ移動' }).click()
  await crop.getByRole('button', { name: 'この範囲にする' }).click()
  await expect(tile.first().getByText('表紙')).toBeVisible()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(async () => {
      const box = await tile.first().boundingBox()
      return box ? Math.abs(box.width - box.height) : Infinity
    }).toBeLessThan(1)
    await page.screenshot({ path: testInfo.outputPath(`course-photo-gallery-${width}.png`) })
  }
  await page.getByRole('textbox', { name: 'メニュー名' }).fill('写真付きコース')
  await page.getByRole('spinbutton', { name: '価格（税込）' }).fill('4200')
  await page.getByRole('button', { name: '所要時間', exact: true }).click()
  await page.getByRole('option', { name: '2時間（120分）', exact: true }).click()
  await page.locator('[data-guide-balloon="friendAdd:2"]').getByRole('button', { name: '次へ', exact: true }).click()
  await page.getByRole('button', { name: '保存して追加する', exact: true }).click()
  await expect.poll(() => submitted?.photos).toEqual([
    { mediaId: images[1].id, x: 73, y: 50 }, { mediaId: images[0].id, x: 50, y: 50 },
    ...images.slice(2).map(image => ({ mediaId: image.id, x: 50, y: 50 })),
  ])
})
