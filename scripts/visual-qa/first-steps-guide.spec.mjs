import { test, expect } from '@playwright/test'
import { accountId, base, mock, openFixture } from './first-steps-guide-fixture.mjs'
import { RICH_MENU_GROUP_DETAILS } from './fixtures.mjs'

const guideBar = '[data-guide-bar]'
const tableForm = '[data-guide-balloon="attributes:2"]'

async function chooseCourseDuration(page, label) {
  await page.getByRole('button', { name: '所要時間', exact: true }).click()
  await page.getByRole('option', { name: label, exact: true }).getByRole('button').click()
}

test('店舗に初めて入ったときは開店準備から始まる', async ({ page }) => {
  await openFixture(page)
  await page.route('**/api/getting-started/guide?**', async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ json: { success: true, data: { phase: 'idle', stepKey: null, procedureIndex: 1, updatedAt: null } } })
  })
  await page.goto(base)
  const popup = page.getByRole('dialog', { name: '開店準備を始めましょう' })
  await expect(popup).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toHaveCount(0)
  await page.reload()
  await expect(popup).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'ようこそ' })).toHaveCount(0)
})

test('接続済みなら設定を残してリッチメニューから始められる', async ({ page }) => {
  await openFixture(page, { firstStep: 'richMenu', initialGuide: { phase: 'paused', stepKey: 'attributes', procedureIndex: 2 } })
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
  await form.getByRole('textbox', { name: '卓番', exact: true }).fill('21')
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
  await page.getByRole('spinbutton', { name: 'LINEで受ける席数（各枠）', exact: true }).fill('1')
  await expect(page.locator('[data-guide-balloon="scenario:2"]')).toBeVisible()
  const save = page.getByRole('button', { name: '配分を保存する', exact: true })
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
  await page.getByRole('button', { name: '基本配分をまとめて変更', exact: true }).click()
  const allocation = page.getByRole('dialog', { name: '営業日の基本配分を変更' })
  await allocation.getByRole('spinbutton', { name: 'LINEで受ける席数', exact: true }).fill('0')
  const save = allocation.getByRole('button', { name: '基本配分を保存', exact: true })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.getByText('配分を保存しました。', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'ダッシュボード', exact: true }).click()
  await expect(page.getByRole('banner').getByRole('link', { name: /開店準備 6\/8。はじめの設定を開く/ })).toBeVisible()
  await page.getByRole('button', { name: '最初から始める', exact: true }).click()
  await page.getByRole('dialog', { name: /リッチメニューを選ぶ/ }).getByRole('button', { name: 'あとで', exact: true }).click()
  await expect(page).toHaveURL(/\/restaurant-test\/inventory$/, { timeout: 15000 })
  await expect(page.locator(guideBar)).toContainText('予約枠と在庫を設定する')
})

for (const [width, height] of [[1440, 1000], [1152, 768], [390, 844], [667, 375]]) {
  test(`卓の作成中もフォームとガイドの操作に届く ${width}×${height}`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openFixture(page, { width, height, initialGuide: { phase: 'active', stepKey: 'attributes', procedureIndex: 2 } })
    await page.goto(`${base}/restaurant-test/tables`)
    const form = page.getByRole('dialog', { name: '卓を作る' })
    const save = form.getByRole('button', { name: '卓を作る', exact: true })
    await expect(save).toBeDisabled()
    if (width === 1440 || width === 390) {
      await form.getByRole('button', { name: /席の条件を変更/ }).click()
      await expect(form.locator(tableForm)).toContainText('席の条件を確認する')
      await expect(form.getByRole('switch', { name: '座席表に表示' })).toBeVisible()
      if (width === 390) await expect(form.getByRole('textbox', { name: '卓番', exact: true })).toBeHidden()
      await page.screenshot({ path: info.outputPath('guided-table-conditions.png') })
      await form.getByRole('button', { name: 'プレビューへ戻る' }).click()
      await expect(form.locator(tableForm)).toContainText('卓の情報を入れる')
    }
    await form.getByRole('textbox', { name: '卓番', exact: true }).fill('22')
    await form.getByRole('textbox', { name: '表示名', exact: true }).fill('窓側')
    await form.getByRole('spinbutton', { name: '最大人数' }).fill('4')
    await form.getByRole('button', { name: 'カウンター', exact: true }).click()
    if (width === 1440) {
      await page.reload()
      await expect(form.getByRole('textbox', { name: '卓番', exact: true })).toHaveValue('22')
      await expect(form.getByRole('textbox', { name: '表示名', exact: true })).toHaveValue('窓側')
      await expect(form.getByRole('spinbutton', { name: '最大人数' })).toHaveValue('4')
      await expect(form.getByRole('button', { name: 'カウンター', exact: true })).toHaveAttribute('aria-pressed', 'true')
    }
    await save.click({ trial: true })
    const stop = form.getByRole('button', { name: '一時停止' })
    const skip = form.getByRole('button', { name: 'この手順をスキップ' })
    await stop.click({ trial: true })
    await skip.click({ trial: true })
    if (width === 1440) {
      const panel = await form.boundingBox()
      expect(panel.width).toBeCloseTo(824, 0)
      const balloon = await page.locator(tableForm).boundingBox()
      expect(balloon.x).toBeGreaterThan(panel.x + panel.width)
      const saveBox = await save.boundingBox()
      const ring = await page.locator('[data-guide-spotlight="tables.form"]').boundingBox()
      expect(ring.width).toBeLessThan(saveBox.width + 40)
      expect(Math.abs((ring.x + ring.width / 2) - (saveBox.x + saveBox.width / 2))).toBeLessThan(2)
    }
    await page.screenshot({ path: info.outputPath('guided-table.png') })
    const visited = new Set()
    for (let tab = 0; tab < 48; tab++) {
      await page.keyboard.press('Tab')
      visited.add(await page.evaluate(() => document.activeElement?.textContent?.trim()))
      if (visited.has('一時停止') && visited.has('この手順をスキップ')) break
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
  await expect(page.locator('[data-guide-spotlight="menu.status"]')).toBeVisible()
  const duration = page.getByRole('button', { name: '所要時間', exact: true })
  const next = page.getByRole('button', { name: '次へ', exact: true })
  const save = page.getByRole('button', { name: '保存して追加する', exact: true })
  await expect(duration).toHaveText('所要時間を選ぶ')
  await expect(page.getByRole('button', { name: '提供時間', exact: true })).toHaveText('提供時間帯を選ぶ')
  await page.screenshot({ path: info.outputPath('guided-course-empty.png') })
  await page.getByRole('button', { name: '保存する状態', exact: true }).click()
  await page.getByRole('option', { name: '公開', exact: true }).click()
  await next.click()
  await expect(page.locator('[data-guide-spotlight="menu.name"]')).toBeVisible()
  await page.getByRole('textbox', { name: 'メニュー名' }).fill('ガイド検証用')
  await next.click()
  await expect(page.locator('[data-guide-spotlight="menu.price"]')).toBeVisible()
  await page.getByRole('spinbutton', { name: '価格（税込）' }).fill('4200')
  await next.click()
  await expect(page.locator('[data-guide-spotlight="menu.duration"]')).toBeVisible()
  await expect(save).toBeDisabled()
  await chooseCourseDuration(page, '2時間30分（150分）')
  await next.click()
  await expect(page.locator('[data-guide-balloon="friendAdd:6"]')).toBeVisible()
  await expect(save).toBeEnabled()
  await save.click()
  const confirmation = page.getByRole('dialog', { name: 'このメニューを公開しますか？' })
  await expect(confirmation.locator(guideBar)).toBeVisible()
  await confirmation.getByRole('button', { name: '一時停止', exact: true }).click({ trial: true })
  const confirm = confirmation.getByRole('button', { name: '公開して追加する', exact: true })
  await expect(confirm).toHaveAttribute('data-guide-anchor', 'menu.save')
  await expect(confirmation.locator('[data-guide-balloon]')).toContainText('「公開して追加する」')
  await confirm.click({ trial: true })
  await page.screenshot({ path: info.outputPath('guided-course-confirmation.png') })
  await confirmation.getByRole('button', { name: 'キャンセル', exact: true }).click()
  await expect(page.locator('[data-guide-balloon="friendAdd:6"]')).toBeVisible()
})

for (const { width, height, procedureIndex } of [
  { width: 1440, height: 1000, procedureIndex: 2 },
  { width: 390, height: 844, procedureIndex: 3 },
]) {
  test(`コースは直接下書き保存し、成功時だけ次へ進む（${width}px）`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openFixture(page, {
      width, height,
      initialGuide: { phase: 'active', stepKey: 'friendAdd', procedureIndex },
      storeProgress: { tables: true, hours: true },
    })
    const submissions = []
    const verifiedStores = []
    let courseRegistered = false
    let releaseProof
    const proof = new Promise(resolve => { releaseProof = resolve })
    await page.route('**/api/restaurant-test/menu?**', async route => {
      if (route.request().method() !== 'POST') return route.fallback()
      submissions.push(route.request().postDataJSON())
      if (submissions.length === 1) {
        return route.fulfill({ status: 500, json: { success: false, error: 'コースを保存できませんでした' } })
      }
      courseRegistered = true
      return route.fulfill({ json: { success: true, data: { id: 'course-direct-1' } } })
    })
    await page.route('**/api/restaurant-test/setup-progress?**', async route => {
      const { searchParams } = new URL(route.request().url())
      const storeId = searchParams.get('storeId')
      if (courseRegistered) {
        verifiedStores.push({ accountId: searchParams.get('account_id'), storeId })
        await proof
      }
      return route.fulfill({ json: { success: true, data: {
        storeId, tables: true, hours: true, menus: false, courseRegistered, reception: false, followup: false,
      } } })
    })
    await page.goto(`${base}/restaurant-test/menu/edit`)
    const saveGuide = page.locator('[data-guide-balloon="friendAdd:6"]')
    const next = page.getByRole('button', { name: '次へ', exact: true })
    const save = page.getByRole('button', { name: '保存して追加する', exact: true })
    const name = page.getByRole('textbox', { name: 'メニュー名' })
    const price = page.getByRole('spinbutton', { name: '価格（税込）' })
    const duration = page.getByRole('button', { name: '所要時間', exact: true })
    const publication = page.getByRole('dialog', { name: 'このメニューを公開しますか？' })
    if (procedureIndex === 2) {
      await expect(page.locator('[data-guide-spotlight="menu.status"]')).toBeVisible()
      await next.click()
    }
    await expect(page.locator('[data-guide-spotlight="menu.name"]')).toBeVisible()
    await expect(next).toBeDisabled()
    await expect(duration).toHaveText('所要時間を選ぶ')
    await expect(page.getByRole('button', { name: '保存する状態', exact: true })).toHaveText('下書き')
    await expect(save).toBeDisabled()
    await page.screenshot({ path: info.outputPath(`guided-course-empty-${width}.png`) })
    await name.fill('ガイド検証用')
    await next.click()
    await expect(page.locator('[data-guide-spotlight="menu.price"]')).toBeVisible()
    await price.fill('4200')
    const savedProcedure = width === 390 ? page.waitForResponse(response => response.url().includes('/api/getting-started/guide?') &&
      response.request().method() === 'PUT' && response.request().postDataJSON().procedureIndex === 5) : null
    await next.click()
    if (savedProcedure) {
      await savedProcedure
      await page.reload()
      await expect(name).toHaveValue('ガイド検証用')
      await expect(price).toHaveValue('4200')
    }
    await expect(page.locator('[data-guide-spotlight="menu.duration"]')).toBeVisible()
    await expect(save).toBeDisabled()
    await chooseCourseDuration(page, '2時間30分（150分）')
    await expect(save).toBeDisabled()
    await next.click()
    await expect(saveGuide).toBeVisible()
    await expect(page.locator('[data-guide-spotlight="menu.save"]')).toBeVisible()
    await expect(save).toBeEnabled()
    await expect(save).toBeInViewport({ ratio: 1 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    await expect.poll(async () => {
      const guidance = width === 390 ? [saveGuide] : [saveGuide, page.locator(guideBar)]
      const [target, ...boxes] = await Promise.all([save, ...guidance].map(control => control.boundingBox()))
      if (width === 390) return Boolean(target && boxes[0] && boxes[0].y + boxes[0].height <= target.y)
      return Boolean(target && boxes.every(box => box && (
        box.x + box.width <= target.x || target.x + target.width <= box.x ||
        box.y + box.height <= target.y || target.y + target.height <= box.y
      )))
    }).toBe(true)
    if (width === 390) await expect(saveGuide.getByRole('button', { name: '一時停止' })).toBeVisible()
    await save.click({ trial: true })
    await page.screenshot({ path: info.outputPath(`guided-course-save-${width}.png`) })
    expect(submissions).toHaveLength(0)
    await save.click()
    await expect(page.getByRole('alert').filter({ hasText: '保存できませんでした。入力を確かめて、もう一度お試しください。' })).toBeVisible()
    await expect(page).toHaveURL(/\/restaurant-test\/menu\/edit$/)
    await expect(saveGuide).toBeVisible()
    await expect(name).toHaveValue('ガイド検証用')
    await expect(price).toHaveValue('4200')
    await expect(duration).toHaveText('2時間30分（150分）')
    await expect(publication).toHaveCount(0)
    expect(verifiedStores).toHaveLength(0)
    await page.screenshot({ path: info.outputPath(`guided-course-save-error-${width}.png`) })
    await save.click()
    try {
      await expect.poll(() => verifiedStores).toContainEqual({ accountId, storeId: 'store-sby' })
      await expect(page).toHaveURL(/\/restaurant-test\/menu\/edit(?:\?|$)/)
      await expect(publication).toHaveCount(0)
    } finally {
      releaseProof()
    }
    await expect(page).toHaveURL(/\/restaurant-test\/inventory(?:\?|$)/)
    await expect(page.locator(guideBar)).toContainText('予約枠と在庫を設定する')
    expect(submissions).toHaveLength(2)
    for (const submitted of submissions) {
      expect(submitted).toMatchObject({ storeId: 'store-sby', kind: 'course', name: 'ガイド検証用', price: 4200, durationMinutes: 150, status: 'draft' })
    }
    await page.screenshot({ path: info.outputPath(`guided-course-next-${width}.png`) })
  })
}

test('取り込んだ営業時間を確認すると個別の在庫枠を作らずに次へ進む', async ({ page }, info) => {
  await openFixture(page, { initialGuide: { phase: 'active', stepKey: 'hours', procedureIndex: 2 }, storeProgress: { tables: true, hours: true } })
  let requests = 0
  await page.route('**/api/restaurant-test/inventory/generate?**', async route => {
    requests += 1
    await route.fulfill({ status: 400, json: { success: false, error: '日別枠の作成は使いません' } })
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
  await expect(page).toHaveURL(/\/restaurant-test\/menu$/)
  expect(requests).toBe(0)
})

test('来店フォローは初回はオフで、後で使う選択もできる', async ({ page }, info) => {
  await openFixture(page, { initialGuide: { phase: 'active', stepKey: 'followup', procedureIndex: 1 }, storeProgress: { tables: true, hours: true, menus: true, reception: true } })
  await page.goto(`${base}/restaurant-test/line-followup`)
  await expect(page.getByRole('switch', { name: '予約したときを使う' })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: '前日の確認を使う' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: '保存して作る' })).toBeDisabled()
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
    await followup.emulateMedia({ reducedMotion: 'reduce' })
    await openFixture(followup, { width: 390, height: 844,
      initialGuide: { phase: 'active', stepKey: 'followup', procedureIndex: 1 },
      storeProgress: { tables: true, hours: true, menus: true, reception: true } })
    await followup.goto(`${base}/restaurant-test/line-followup`)
    const toggle = followup.getByRole('switch', { name: '予約したときを使う' })
    await expect(followup.locator('[data-guide-spotlight="followup.start"]')).toBeVisible()
    await toggle.tap({ trial: true })
    await followup.screenshot({ path: info.outputPath('guided-followup-touch-initial.png') })
    await toggle.tap()
    const editor = followup.getByRole('dialog', { name: '予約したときを変える' })
    const next = editor.locator('[data-guide-balloon="followup:2"]').getByRole('button', { name: '次へ' })
    await expect(next).toBeEnabled()
    const bodyAnchor = editor.locator('[data-guide-anchor="followup.body"][data-guide-ready]')
    const bodyRing = editor.locator('[data-guide-spotlight="followup.body"]')
    await expect(bodyAnchor).toBeInViewport({ ratio: 0.85 })
    await expectFollowupSpotlight(bodyAnchor, bodyRing)
    await followup.screenshot({ path: info.outputPath('guided-followup-touch-message-review.png') })
    const preview = editor.getByRole('button', { name: '届き方' })
    await preview.tap()
    await expect(editor.getByRole('complementary', { name: '届き方' })).toBeVisible()
    await expect(bodyRing).toBeHidden()
    await followup.screenshot({ path: info.outputPath('guided-followup-touch-preview.png') })
    await preview.tap()
    await next.tap()
    const confirm = editor.getByRole('button', { name: 'この内容でオンにする' })
    await expect(editor.locator('[data-guide-balloon="followup:3"]')).toBeVisible()
    await confirm.tap({ trial: true })
    await followup.screenshot({ path: info.outputPath('guided-followup-touch-confirm.png') })
    await confirm.tap()
    await expect(followup.locator('[data-guide-balloon="followup:4"]')).toBeVisible()
    const save = followup.getByRole('button', { name: '保存して作る', exact: true })
    await save.tap({ trial: true })
    await expectFollowupSpotlight(save, followup.locator('[data-guide-spotlight="followup.save"]'))
    await followup.screenshot({ path: info.outputPath('guided-followup-touch-save.png') })
  } finally {
    await context.close()
  }
})

async function expectFollowupSpotlight(anchor, spotlight) {
  await expect.poll(async () => {
    const [target, ring] = await Promise.all([anchor.boundingBox(), spotlight.boundingBox()])
    if (!target || !ring) return Number.POSITIVE_INFINITY
    return Math.abs(target.x + target.width / 2 - ring.x - ring.width / 2) +
      Math.abs(target.y + target.height / 2 - ring.y - ring.height / 2)
  }).toBeLessThan(5)
}

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

test('来店フォローは本文の確認から明示保存まで案内し、実測が揃ってから次へ進む', async ({ page }, info) => {
  await openFixture(page, { initialGuide: { phase: 'active', stepKey: 'followup', procedureIndex: 1 }, storeProgress: { tables: true, hours: true, menus: true, reception: true } })
  const writes = []
  let initializedRows
  let saved = false
  let acknowledge
  let progressChecks = 0
  const proof = new Promise(resolve => { acknowledge = resolve })
  await page.route('**/api/restaurant-test/setup-progress?**', async route => {
    const storeId = new URL(route.request().url()).searchParams.get('storeId')
    if (saved) {
      progressChecks++
      await proof
    }
    return route.fulfill({ json: { success: true, data: { storeId, tables: true, hours: true, menus: true, reception: true, followup: saved } } })
  })
  await page.route('**/api/restaurant-test/followups/**', async route => {
    if (route.request().method() === 'GET') return route.fallback()
    const path = new URL(route.request().url()).pathname
    writes.push(path.split('/').pop())
    if (!path.endsWith('/engines/initialize')) return route.fulfill({ status: 403, json: { success: false } })
    initializedRows = route.request().postDataJSON().rows
    if (writes.length === 1) return route.fulfill({ status: 500, json: { success: false, error: '来店フォローを保存できませんでした' } })
    saved = true
    await route.fulfill({ json: { success: true, data: {} } })
  })
  await page.goto(`${base}/restaurant-test/line-followup`)
  const save = page.getByRole('button', { name: '保存して作る', exact: true })
  const toggle = page.getByRole('switch', { name: '予約したときを使う' })
  await expect(toggle).not.toBeChecked()
  await expect(save).toBeDisabled()
  await expect(page.locator('[data-guide-spotlight="followup.start"]')).toBeVisible()
  await page.screenshot({ path: info.outputPath('followup-initial-off.png') })
  await toggle.click()
  const editor = page.getByRole('dialog', { name: '予約したときを変える' })
  const next = editor.locator('[data-guide-balloon="followup:2"]').getByRole('button', { name: '次へ' })
  await expect(next).toBeEnabled()
  await expect(editor).toHaveCSS('opacity', '1')
  const bodyAnchor = editor.locator('[data-guide-anchor="followup.body"][data-guide-ready]')
  const bodyRing = editor.locator('[data-guide-spotlight="followup.body"]')
  await expectFollowupSpotlight(bodyAnchor, bodyRing)
  await page.screenshot({ path: info.outputPath('followup-message-review.png') })
  await next.click()
  await expect(editor.locator('[data-guide-spotlight="followup.confirm"]')).toBeVisible()
  await page.screenshot({ path: info.outputPath('followup-confirm.png') })
  await editor.getByRole('button', { name: 'この内容でオンにする' }).click()
  await expect(toggle).toBeChecked()
  await expect(page.getByRole('switch', { name: '前日の確認を使う' })).not.toBeChecked()
  await expect(page.locator('[data-guide-balloon="followup:4"]')).toBeVisible()
  await expect(save).toBeEnabled()
  expect(writes).toHaveLength(0)
  await save.click()
  await expect.poll(() => initializedRows?.filter(row => row.input.enabled).map(row => row.trigger)).toEqual(['reservation_created'])
  const result = page.getByRole('dialog', { name: '保存の結果' })
  await expect(result.getByText('保存できませんでした').first()).toBeVisible()
  await result.getByRole('button', { name: '閉じる' }).click()
  await expect(toggle).toBeChecked()
  await expect(page.locator('[data-guide-balloon="followup:4"]')).toBeVisible()
  await save.click()
  try {
    await expect.poll(() => progressChecks).toBeGreaterThan(0)
    await expect(page).toHaveURL(/\/restaurant-test\/line-followup/)
  } finally {
    acknowledge()
  }
  await expect(page.getByRole('dialog', { name: /最初の1通を受け取る/ })).toBeVisible()
  expect(writes).toEqual(['initialize', 'initialize'])
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

test('選択日が休業日でも営業日共通の配分を保存でき、再読み込みと保存失敗から続けられる', async ({ page }, info) => {
  await openFixture(page, {
    initialGuide: { phase: 'active', stepKey: 'scenario', procedureIndex: 1 },
    storeProgress: { tables: true, hours: true, menus: true },
  })
  await page.route('**/api/restaurant-test/inventory/day?**', route => route.fulfill({ json: {
    success: true, data: [], closures: [], allocation: { version: 0, standard: null, day: null, hoursStatus: 'closed' },
  } }))
  const writes = []
  await page.route('**/api/restaurant-test/inventory/allocation?**', async route => {
    writes.push(route.request().postDataJSON())
    if (writes.length === 1) return route.fulfill({ status: 503, json: { success: false } })
    await route.fallback()
  })
  await page.goto(`${base}/restaurant-test/inventory`)
  await expect(page.getByText('この日は休業日です')).toBeVisible()
  const line = page.getByRole('spinbutton', { name: 'LINEで受ける席数（各枠）' })
  const save = page.getByRole('button', { name: '配分を保存する' })
  await expect(save).toBeDisabled()
  await line.fill('1')
  await expect(page.locator('[data-guide-balloon="scenario:2"]')).toBeVisible()
  await page.reload()
  await expect(line).toHaveValue('1')
  await expect(save).toBeEnabled()
  await save.click()
  await expect(page.getByText(/配分を保存できませんでした/)).toBeVisible()
  await expect(page.locator('[data-guide-balloon="scenario:2"]')).toContainText('もう一度保存する')
  await expect(line).toHaveValue('1')
  await page.screenshot({ path: info.outputPath('allocation-error.png') })
  await save.click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toEqual({ storeId: 'store-sby', scope: 'standard', expectedVersion: 0, allocation: { otaCapacity: 0, lineCapacity: 1, walkInCapacity: 0 } })
})

test('リッチメニューがすでに公開中なら公開案内を飛ばす', async ({ page }, info) => {
  await openFixture(page, {
    initialGuide: { phase: 'active', stepKey: 'scenario', procedureIndex: 2 },
    storeProgress: { tables: true, hours: true, menus: true, reception: true,
      bookingExposure: { reservationLink: true, publicReservationMenu: true, availableCapacity: true } },
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

test('スマホの上部の開店準備からはじめの設定へ移る', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  try {
    await openFixture(page, { width: 390, height: 900 })
    await page.goto(base)
    const popup = page.getByRole('dialog', { name: '開店準備を始めましょう' })
    await popup.getByRole('button', { name: /あとで/ }).tap()
    await expect(popup).toHaveCount(0)
    const chip = page.getByRole('link', { name: /開店準備.*はじめの設定を開く/ })
    await expect(chip).toBeInViewport()
    await expect(chip).toHaveAttribute('href', '/getting-started')
    await page.screenshot({ path: info.outputPath('mobile-guide-link.png') })
    await chip.tap()
    await expect(page).toHaveURL(/\/getting-started\/?$/)
    await expect(popup).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('登録の外側の送信ボタンはEnterと必須・形式の検証を保つ', async ({ page }) => {
  await openFixture(page)
  await page.goto(`${base}/accounts/new`)
  await page.getByRole('radio', { name: 'はい、あります' }).click()
  await page.getByRole('radio', { name: 'いいえ、引き継ぎません' }).click()
  await page.getByRole('radio', { name: '使っていません' }).click()
  await page.getByRole('button', { name: '次へ', exact: true }).click()
  const id = page.locator('#v8-channel-id')
  const secret = page.locator('#v8-channel-secret')
  const next = page.getByRole('button', { name: '次のステップへ' })
  await expect(next).toBeDisabled()
  await id.press('Enter')
  await expect(id).toBeVisible()
  await expect(next).toHaveAttribute('aria-description', 'チャネルIDとチャネルシークレットを入力してください。')
  await id.fill('123456789')
  await secret.fill('a'.repeat(32))
  await expect(next).toBeEnabled()
  await id.fill('abc')
  await expect(secret).toHaveValue('a'.repeat(32))
  await id.press('Enter')
  await expect(secret).toHaveValue('a'.repeat(32))
  await expect(page.getByText(/チャネルIDは余分な空白を除き、半角数字/)).toBeVisible()
  await expect(id).toBeVisible()
  await id.fill('123456789')
  await id.press('Enter')
  await expect(page.locator('#v8-provider-id')).toBeVisible()
})

test('コースの写真は登録メディアと端末から合計5枚を追加して保存できる', async ({ page }, testInfo) => {
  await openFixture(page, { storeProgress: { tables: true, hours: true } })
  const images = Array.from({ length: 12 }, (_, index) => ({
    id: `qa-dish-${index}`, lineAccountId: accountId, kind: 'image', filename: `検証写真 ${index + 1}.png`,
  }))
  const sourceFiles = [
    { name: '端末の写真1.png', id: 'qa-dish-file-a' },
    { name: '端末の写真2.png', id: 'qa-dish-file-b' },
  ]
  const uploaded = []
  const attempts = []
  await page.route('**/api/media?**', route => {
    const query = new URL(route.request().url()).searchParams
    const offset = Number(query.get('offset'))
    const limit = Number(query.get('limit'))
    const all = [...uploaded, ...images]
    return route.fulfill({ json: { success: true, data: { items: all.slice(offset, offset + limit), total: all.length } } })
  })
  await page.route('**/api/media/qa-dish-*/content?**', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="green"/></svg>',
  }))
  await page.route('**/api/media/upload-sessions', route => {
    const { files, accountId: targetAccount } = route.request().postDataJSON()
    expect(targetAccount).toBe(accountId)
    const file = sourceFiles.find(entry => entry.name === files[0].filename)
    expect(file).toBeDefined()
    attempts.push(file.id)
    if (file.id === sourceFiles[1].id && attempts.filter(id => id === file.id).length === 1) {
      return route.fulfill({ status: 500, json: { success: false, error: 'アップロードを準備できませんでした' } })
    }
    return route.fulfill({ json: { success: true, data: { sessions: [{
      id: file.id, method: 'PUT', uploadUrl: `${base}/qa-course-media/${file.id}`, requiredHeaders: {},
    }] } } })
  })
  await page.route('**/qa-course-media/**', route => route.fulfill({ status: 200, headers: { ETag: '"course-photo"' } }))
  await page.route('**/api/media/upload-sessions/*/complete', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)
    const file = sourceFiles.find(entry => entry.id === id)
    uploaded.unshift({ id, filename: file.name, lineAccountId: accountId, kind: 'image' })
    return route.fulfill({ json: { success: true, data: { status: 'completed', mediaId: id } } })
  })
  await page.route('**/api/file-scans/for-media?**', route =>
    route.fulfill({ json: { success: true, data: { scan: { status: 'clean' } } } }))
  let submitted
  await page.route('**/api/restaurant-test/menu?**', route => {
    if (route.request().method() !== 'POST') return route.fallback()
    submitted = route.request().postDataJSON()
    return route.fulfill({ json: { success: true, data: { id: 'course-gallery-1' } } })
  })
  await page.goto(`${base}/restaurant-test/menu/edit`)
  const add = page.getByRole('button', { name: '写真を追加', exact: true })
  await add.click()
  const picker = page.getByRole('dialog', { name: 'コースの写真を選ぶ', exact: true })
  const upload = page.getByRole('dialog', { name: 'ファイルを入れる', exact: true })
  const input = upload.locator('input[type="file"]')
  const imageBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kvfsAAAAASUVORK5CYII=', 'base64')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await expect(picker.getByRole('checkbox', { name: images[0].filename, exact: true })).toBeVisible()
    await expect.poll(() => picker.getByText('すべてのフォルダ', { exact: true }).evaluate(label => label.scrollWidth <= label.clientWidth)).toBe(true)
    await expect(picker.getByRole('button', { name: 'フォルダ', exact: true }).locator('[data-folder-dot]')).toHaveCount(0)
    if (width === 1440) {
      expect(await picker.evaluate(panel => [panel.offsetWidth, panel.offsetHeight])).toEqual([960, 804])
      expect(await picker.getByRole('textbox', { name: '写真の名前' }).evaluate(field => field.offsetWidth)).toBe(208)
      expect(await picker.getByRole('button', { name: '検索', exact: true }).evaluate(button => button.offsetWidth)).toBe(74)
    }
    expect(await picker.getByRole('button', { name: 'ファイルから追加', exact: true }).evaluate(button => button.offsetHeight)).toBe(44)
    expect(await picker.evaluate(panel => panel.scrollWidth <= panel.clientWidth)).toBe(true)
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`course-photo-picker-${width}.png`) })
  }
  await picker.getByRole('button', { name: '次のページ', exact: true }).click()
  await expect(picker.getByRole('checkbox', { name: images[6].filename, exact: true })).toBeVisible()
  await picker.getByRole('button', { name: '前のページ', exact: true }).click()
  await picker.getByRole('button', { name: 'ファイルから追加', exact: true }).click()
  await input.setInputFiles(images.slice(0, 5).map(({ filename: name }) => ({ name, mimeType: 'image/png', buffer: imageBuffer })))
  await expect(upload.getByRole('button', { name: '5件を登録する', exact: true })).toBeEnabled()
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('course-photo-upload-five-ready-390.png') })
  await upload.getByRole('button', { name: '閉じる', exact: true }).click()
  await page.getByRole('button', { name: '破棄する', exact: true }).click()
  for (const image of images.slice(0, 3)) {
    await picker.getByRole('checkbox', { name: image.filename, exact: true }).click()
  }
  await picker.getByRole('button', { name: 'ファイルから追加', exact: true }).click()
  await expect(upload.getByText('2枚まで追加できます', { exact: true })).toBeVisible()
  await expect(upload.getByRole('button', { name: '0件を登録する', exact: true })).toBeDisabled()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    expect(await upload.evaluate(panel => panel.scrollWidth <= panel.clientWidth)).toBe(true)
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`course-photo-upload-${width}.png`) })
  }
  await expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/gif,image/webp')
  await expect(input).toHaveAttribute('multiple', '')
  await input.setInputFiles(sourceFiles.map(file => ({ name: file.name, mimeType: 'image/png', buffer: imageBuffer })))
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('course-photo-upload-ready-390.png') })
  await upload.getByRole('button', { name: '2件を登録する', exact: true }).click()
  await upload.getByRole('button', { name: `「${sourceFiles[1].name}」をもう一度試す`, exact: true }).click()
  await upload.getByRole('button', { name: '1件を登録する', exact: true }).click()
  await upload.getByRole('button', { name: '完了', exact: true }).click()
  expect(attempts).toEqual([sourceFiles[0].id, sourceFiles[1].id, sourceFiles[1].id])
  for (const file of sourceFiles) {
    await expect(picker.getByRole('checkbox', { name: file.name, exact: true })).toBeChecked()
  }
  await expect(picker).toContainText('登録メディア 3枚 ＋ ファイルから登録 2枚')
  await expect(picker.getByRole('checkbox', { name: images[3].filename, exact: true })).toBeDisabled()
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('course-photo-picker-mixed-390.png') })
  await picker.getByRole('button', { name: '5枚を追加', exact: true }).click()
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
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`course-photo-gallery-${width}.png`) })
  }
  await page.getByRole('textbox', { name: 'メニュー名' }).fill('写真付きコース')
  await page.getByRole('spinbutton', { name: '価格（税込）' }).fill('4200')
  await chooseCourseDuration(page, '2時間（120分）')
  await page.getByRole('button', { name: '保存して追加する', exact: true }).click()
  await expect.poll(() => submitted?.photos).toEqual([
    { mediaId: images[1].id, x: 73, y: 50 }, { mediaId: images[0].id, x: 50, y: 50 },
    ...[images[2], ...sourceFiles].map(image => ({ mediaId: image.id, x: 50, y: 50 })),
  ])
})
