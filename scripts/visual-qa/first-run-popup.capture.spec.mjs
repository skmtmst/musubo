/*
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 02 (C5i3rw) / 02b (nt3Po) / 08b (Bnkcl) / 14 (orKSi) の照合用の撮影。

  受入条件5「ローカル起動で02/02b/08b/14をPC1152/1440/1920とスマホ390で目視し、
  承認Penと照合したスクリーンショットを残す」のための実写。
  出力先 docs/design-qa/first-run-popup/ は .gitignore 済み。

  使い方（mock-api 8788 と Next 3101 を起こしてから）:
    VISUAL_QA_MOCK=http://127.0.0.1:8788 pnpm exec playwright test scripts/visual-qa/first-run-popup.capture.spec.mjs
*/
import { test, expect } from '@playwright/test'
import { captureClockFor, QA_TIMEZONE } from './qa-clock.mjs'
import { routeLocalApi } from './local-api.mjs'

test.beforeEach(routeLocalApi)

const BASE = process.env.VISUAL_QA_BASE ?? 'http://localhost:3101'
const OUT = 'docs/design-qa/first-run-popup'
const PC_WIDTHS = [1152, 1440, 1920]
const MOBILE_WIDTH = 390

test.use({ timezoneId: QA_TIMEZONE })
test.describe.configure({ mode: 'serial' })

const MOCK = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:8788'

/*
  承認済み Pen v09（枠 C5i3rw / nt3Po）に合わせる。
  済み数は実データ計測なので、数を直接入れず「元になる応答」を差し替えて作る。
  ① LINE接続・② 初期セット・最後の1通 はサーバの /api/getting-started、
  リッチメニューは /api/rich-menu-groups の件数、
  卓と席・営業時間・メニュー・予約枠・来店フォロー は /api/restaurant-test/setup-progress の真偽値から決まる
  （apps/web/src/v8/settings/getting-started/steps.ts と restaurant-setup-progress.ts）。
  ② 初期セットはLINE接続時に決まるので、済みなら一覧から外れて8段になる（Pen v09）。
*/
const PEN_STATES = {
  /* 枠02 (C5i3rw) 1/8: ①だけ表示上済み。初期セットは保存済みで表示から外れる。 */
  '1/8': {
    server: { accounts: 'done', featureSet: 'done', firstMessage: 'todo' },
    richMenuEmpty: true,
    store: { tables: false, hours: false, menus: false, reception: false, followup: false },
  },
  /* 枠08b (Bnkcl) 3/8: ①接続・リッチメニュー・卓と席まで済み。②は済みで一覧から外れるので8段。 */
  '3/8': {
    server: { accounts: 'done', featureSet: 'done', firstMessage: 'todo' },
    richMenuEmpty: false,
    store: { tables: true, hours: false, menus: false, reception: false, followup: false },
  },
}

/** 承認Penと同じ済み数の状態を作る。指定しない口は撮影用の口（mock-api）のまま。 */
async function routePenState(page, name) {
  const state = PEN_STATES[name]
  await page.route('**/api/getting-started**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/getting-started') { await route.fallback(); return }
    const steps = [
      { key: 'accounts', state: state.server.accounts, href: '/accounts', reason: null, webhook: [{ id: 'visual-qa-account', status: 'matched' }] },
      { key: 'featureSet', state: state.server.featureSet, href: '/settings', reason: null },
      { key: 'attributes', state: 'todo', href: '/tags?tab=tags', reason: null },
      { key: 'friendAdd', state: 'todo', href: '/friend-add-settings', reason: null },
      { key: 'scenario', state: 'todo', href: '/scenarios', reason: null },
      { key: 'firstMessage', state: state.server.firstMessage, href: '/chats', reason: null },
    ]
    await route.fulfill({
      json: {
        success: true,
        data: {
          accountId: 'visual-qa-account',
          doneCount: steps.filter(step => step.state === 'done').length,
          total: steps.length,
          allDone: false,
          steps,
        },
      },
    })
  })
  await page.route('**/api/restaurant-test/setup-progress**', async route => {
    const url = new URL(route.request().url())
    await route.fulfill({
      json: { success: true, data: { storeId: url.searchParams.get('storeId') ?? 'store-sby', ...state.store } },
    })
  })
  if (state.richMenuEmpty) {
    await page.route('**/api/rich-menu-groups**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname !== '/api/rich-menu-groups') { await route.fallback(); return }
      await route.fulfill({
        json: { success: true, data: { items: [], total: 0, limit: 1, sort: 'priority', facets: { total: 0, published: 0, targeting: 0, folderCounts: {} } } },
      })
    })
  }
}

async function openDashboard(page, width, height) {
  /*
    撮影用の口は使い方のスタイルとガイドの進み具合を持ち続けるので、毎回同じ所から始める。
    はじめにやることの一覧（枠08b）と卓・席の手順（枠14）は飲食店のスタイルで出るので restaurant に合わせる。
  */
  await page.request.put(`${MOCK}/api/dashboard/style?accountId=visual-qa-account`, {
    data: { style: 'restaurant' },
  })
  await page.request.put(`${MOCK}/api/getting-started/guide?accountId=visual-qa-account`, {
    data: { phase: 'idle', stepKey: null, procedureIndex: 1 },
  })
  await page.setViewportSize({ width, height })
  await page.clock.setFixedTime(new Date(captureClockFor('/')))
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem('lh_auth_selection_cleared', '1')
      window.localStorage.setItem('lh_selected_account', 'visual-qa-account')
      /* 初回ポップアップを毎回出す。閉じた記録と畳んだ記録を消す。 */
      window.localStorage.removeItem('lh:v8:first-run-popup-dismissed:visual-qa-account')
      window.localStorage.removeItem('lh:v8:first-steps-folded:visual-qa-account')
    } catch {
    }
  })
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  expect(new URL(page.url()).pathname, 'ダッシュボードから飛ばされた').toBe('/')
}

for (const width of PC_WIDTHS) {
  test(`${width}px 枠02 初回ポップアップ`, async ({ page }) => {
    await openDashboard(page, width, 1080)
    const popup = page.locator('[data-first-run-popup="open"]')
    await expect(popup, '初回ポップアップが出ない').toBeVisible({ timeout: 15000 })
    await expect(page.getByText('開店準備を始めましょう')).toBeVisible()
    await page.screenshot({ path: `${OUT}/${width}-02-popup.png`, fullPage: false })

    /* 「あとで」で閉じたら、上の帯の「開店準備 N/8」の札からはじめの設定へ移る。 */
    await popup.getByRole('button', { name: 'あとで', exact: true }).click()
    await expect(popup).toHaveCount(0)
    const chip = page.getByRole('banner').locator('[data-setup-chip="open"]')
    await expect(chip, '帯の開店準備の札が無い').toBeVisible()
    await page.screenshot({ path: `${OUT}/${width}-02-closed-chip.png`, fullPage: false })

    await chip.click()
    await expect(page, '札からはじめの設定へ移れない').toHaveURL(/\/getting-started\/?$/)
    await expect(popup).toHaveCount(0)
    await page.screenshot({ path: `${OUT}/${width}-02-getting-started.png`, fullPage: false })
  })

  test(`${width}px 枠14 手順別ガイド`, async ({ page }) => {
    await openDashboard(page, width, 1080)
    const popup = page.locator('[data-first-run-popup="open"]')
    await expect(popup).toBeVisible({ timeout: 15000 })
    await popup.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
    await expect(popup).toHaveCount(0)
    /*
      枠14の手順の対象（卓を作る等）は設定画面側にある。
      枠14 共通ルール izsr5「『続きから』＝最初の未完了ステップの手順1へ」のとおり、
      始めると案内がその段の画面まで連れていく（差し戻し R1c）。
    */
    await expect(page).toHaveURL(/\/restaurant-test\/tables/, { timeout: 15000 })
    /* 移った直後は対象がまだ描かれていない。対象が出てから撮る。 */
    await expect(page.locator('[data-guide-anchor="tables.create"]'), '手順1/3の対象が出ない')
      .toBeVisible({ timeout: 15000 })
    const balloon = page.locator('[data-guide-balloon]')
    await expect(balloon, 'ガイドの吹き出しが出ない').toBeVisible({ timeout: 15000 })
    /* 対象を測れていない間は吹き出しが右下の仮置きに出る。光りを待ってから撮る。 */
    await expect(page.locator('[data-guide-spotlight="tables.create"]'), '手順1/3の対象が光らない')
      .toBeVisible({ timeout: 15000 })
    await page.screenshot({ path: `${OUT}/${width}-14-guide.png`, fullPage: false })
  })

  test(`${width}px 枠08b はじめにやること`, async ({ page }) => {
    await openDashboard(page, width, 1080)
    const popup = page.locator('[data-first-run-popup="open"]')
    await expect(popup).toBeVisible({ timeout: 15000 })
    await popup.getByRole('button', { name: 'あとで', exact: true }).click()
    await expect(popup).toHaveCount(0)
    const card = page.getByText('はじめにやること').first()
    await expect(card, '08bのカードが無い').toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${OUT}/${width}-08b-first-steps.png`, fullPage: false })
  })

  /* 差し戻し: 承認Penと同じ済み数（枠02=1/8）で照合できるようにする。 */
  test(`${width}px 枠02 初回ポップアップ 1/8`, async ({ page }) => {
    await routePenState(page, '1/8')
    await openDashboard(page, width, 1080)
    const popup = page.locator('[data-first-run-popup="open"]')
    await expect(popup, '初回ポップアップが出ない').toBeVisible({ timeout: 15000 })
    await expect(popup.getByText('1/8', { exact: true }), '枠02の済み数が1/8にならない')
      .toBeVisible({ timeout: 15000 })
    await page.screenshot({ path: `${OUT}/${width}-02-popup-1of8.png`, fullPage: false })
  })

  /* 承認済み Pen v09: ②が済みなら一覧から外れるので、枠08bの状態は3/8になる。 */
  test(`${width}px 枠08b はじめにやること 3/8`, async ({ page }) => {
    await routePenState(page, '3/8')
    await openDashboard(page, width, 1080)
    const popup = page.locator('[data-first-run-popup="open"]')
    await expect(popup).toBeVisible({ timeout: 15000 })
    await popup.getByRole('button', { name: 'あとで', exact: true }).click()
    await expect(popup).toHaveCount(0)
    const card = page.getByText('はじめにやること').first()
    await expect(card, '08bのカードが無い').toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await expect(page.getByText('3 / 8 済み', { exact: true }), '枠08bの済み数が3/8にならない')
      .toBeVisible({ timeout: 15000 })
    await page.screenshot({ path: `${OUT}/${width}-08b-first-steps-3of8.png`, fullPage: false })
  })
}

/* 枠 02b (nt3Po) は 390x900。シート noXJA の位置・大きさもここで測る。 */
const MOBILE_HEIGHT = 900

test(`${MOBILE_WIDTH}px 枠02b ボトムシート`, async ({ page }) => {
  await openDashboard(page, MOBILE_WIDTH, MOBILE_HEIGHT)
  const popup = page.locator('[data-first-run-popup="open"]')
  await expect(popup, 'スマホで初回シートが出ない').toBeVisible({ timeout: 15000 })
  await expect(popup.getByRole('button', { name: 'あとで', exact: true })).toBeVisible()

  /* 差し戻し R3: 承認Pen noXJA (x0,y118,w390,h782) と上端・高さを合わせる。 */
  const sheet = await popup.locator('[role="dialog"]').boundingBox()
  expect(Math.round(sheet.x), 'シートの左端がPenと違う').toBe(0)
  expect(Math.round(sheet.width), 'シートの幅がPenと違う').toBe(MOBILE_WIDTH)
  expect(Math.round(sheet.y), 'シートの上端がPen noXJA の y118 と違う').toBe(118)
  expect(Math.round(sheet.height), 'シートの高さがPen noXJA の h782 と違う').toBe(782)
  await page.screenshot({ path: `${OUT}/${MOBILE_WIDTH}-02b-sheet.png`, fullPage: false })

  await popup.getByRole('button', { name: /あとで/ }).click()
  await expect(popup).toHaveCount(0)
  await page.screenshot({ path: `${OUT}/${MOBILE_WIDTH}-02b-closed.png`, fullPage: false })
})

/* 差し戻し R2: 足の文言どおり、掴み手を下に引いたら閉じる。指の動きで確かめる。 */
test.describe('枠02b 下スワイプで閉じる', () => {
  test.use({ hasTouch: true, isMobile: true })

  test(`${MOBILE_WIDTH}px 掴み手を下に引くとシートが閉じる`, async ({ page }) => {
    await openDashboard(page, MOBILE_WIDTH, MOBILE_HEIGHT)
    const popup = page.locator('[data-first-run-popup="open"]')
    await expect(popup, 'スマホで初回シートが出ない').toBeVisible({ timeout: 15000 })

    const sheet = await popup.locator('[role="dialog"]').boundingBox()
    const x = Math.round(sheet.x + sheet.width / 2)
    const from = Math.round(sheet.y + 10)
    const cdp = await page.context().newCDPSession(page)
    const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 8, radiusY: 8, force: 1 }],
    })
    await touch('touchStart', from)
    for (const step of [40, 90, 140, 180]) await touch('touchMove', from + step)
    await page.screenshot({ path: `${OUT}/${MOBILE_WIDTH}-02b-swipe-drag.png`, fullPage: false })
    await touch('touchEnd', from + 180)

    await expect(popup, '下スワイプでシートが閉じない').toHaveCount(0, { timeout: 5000 })
    await page.screenshot({ path: `${OUT}/${MOBILE_WIDTH}-02b-swipe-closed.png`, fullPage: false })
  })
})

test(`${MOBILE_WIDTH}px 枠14 吹き出しは画面下部固定`, async ({ page }) => {
  await openDashboard(page, MOBILE_WIDTH, 844)
  const popup = page.locator('[data-first-run-popup="open"]')
  await expect(popup).toBeVisible({ timeout: 15000 })
  await popup.getByRole('button', { name: '進める', exact: true }).click()
  await expect(popup).toHaveCount(0)
  /*
    枠14 共通ルール izsr5 のとおり、始めた直後にその手順の画面まで連れていく
    （PC と同じ形。ダッシュボードに「ガイドで開く」を置く形は a32571717c で無くなった）。
  */
  await expect(page).toHaveURL(/\/restaurant-test\/tables/, { timeout: 15000 })
  await expect(page.locator('[data-guide-anchor="tables.create"]'), 'スマホで手順1/3の対象が出ない')
    .toBeVisible({ timeout: 15000 })
  const balloon = page.locator('[data-guide-balloon]')
  await expect(balloon, 'スマホでガイドの吹き出しが出ない').toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-guide-spotlight="tables.create"]'), 'スマホで手順1/3の対象が光らない')
    .toBeVisible({ timeout: 15000 })
  /*
    本人回答「スマホは画面下部固定の簡易表示」。
    吹き出しは画面下部に固定し、いちばん下の帯とは重ねない（重ねると説明が読めない）。
  */
  const box = await balloon.boundingBox()
  const barBox = await page.locator('[data-guide-bar]').boundingBox()
  const viewport = page.viewportSize()
  expect(viewport.height - (box.y + box.height), '吹き出しが画面下部に固定されていない').toBeLessThanOrEqual(120)
  expect(box.y + box.height, '吹き出しがガイド帯に重なっている').toBeLessThanOrEqual(barBox.y + 1)
  expect(viewport.height - (barBox.y + barBox.height), 'ガイド帯が画面の最下部にない').toBeLessThanOrEqual(1)
  await page.screenshot({ path: `${OUT}/${MOBILE_WIDTH}-14-guide-bottom.png`, fullPage: false })
})
