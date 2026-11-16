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

async function openDashboard(page, width, height) {
  /*
    撮影用の口は使い方のスタイルとガイドの進み具合を持ち続けるので、毎回同じ所から始める。
    9項目の一覧（枠08b）と卓・席の手順（枠14）は飲食店のスタイルで出るので restaurant に合わせる。
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

    /* 「あとで」で閉じたら、帯の「開店準備 N/9」の札から開き直せる（枠02の足の注記）。 */
    await popup.getByRole('button', { name: 'あとで', exact: true }).click()
    await expect(popup).toHaveCount(0)
    const chip = page.locator('[data-setup-chip="open"]')
    await expect(chip, '帯の開店準備の札が無い').toBeVisible()
    await page.screenshot({ path: `${OUT}/${width}-02-closed-chip.png`, fullPage: false })

    await chip.click()
    await expect(popup, '札から開き直せない').toBeVisible()
    await page.screenshot({ path: `${OUT}/${width}-02-reopened.png`, fullPage: false })
  })

  test(`${width}px 枠14 手順別ガイド`, async ({ page }) => {
    await openDashboard(page, width, 1080)
    const popup = page.locator('[data-first-run-popup="open"]')
    await expect(popup).toBeVisible({ timeout: 15000 })
    await popup.getByRole('button', { name: 'ガイドで進める', exact: true }).click()
    await expect(popup).toHaveCount(0)
    /*
      枠14の手順の対象（卓を作る等）は設定画面側にある。
      ダッシュボードでは対象が無いので自動で一時停止する仕様なので、
      08bの「ガイドで開く →」でその段の画面へ移ってから吹き出しを撮る。
    */
    const open = page.getByRole('link', { name: /ガイドで開く/ }).first()
    await expect(open, '「ガイドで開く」が無い').toBeVisible({ timeout: 15000 })
    await open.click()
    /* 移る前のダッシュボードにも一瞬だけ吹き出しが出る（対象が無い間の猶予）。対象が出てから撮る。 */
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
}

test(`${MOBILE_WIDTH}px 枠02b ボトムシート`, async ({ page }) => {
  await openDashboard(page, MOBILE_WIDTH, 844)
  const popup = page.locator('[data-first-run-popup="open"]')
  await expect(popup, 'スマホで初回シートが出ない').toBeVisible({ timeout: 15000 })
  await expect(page.getByText('あとで（下にスワイプで閉じる）')).toBeVisible()
  await page.screenshot({ path: `${OUT}/${MOBILE_WIDTH}-02b-sheet.png`, fullPage: false })

  await popup.getByRole('button', { name: /あとで/ }).click()
  await expect(popup).toHaveCount(0)
  await page.screenshot({ path: `${OUT}/${MOBILE_WIDTH}-02b-closed.png`, fullPage: false })
})

test(`${MOBILE_WIDTH}px 枠14 吹き出しは画面下部固定`, async ({ page }) => {
  await openDashboard(page, MOBILE_WIDTH, 844)
  const popup = page.locator('[data-first-run-popup="open"]')
  await expect(popup).toBeVisible({ timeout: 15000 })
  await popup.getByRole('button', { name: '進める', exact: true }).click()
  await expect(popup).toHaveCount(0)
  const open = page.getByRole('link', { name: /ガイドで開く/ }).first()
  await expect(open, 'スマホで「ガイドで開く」が無い').toBeVisible({ timeout: 15000 })
  await open.click()
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
