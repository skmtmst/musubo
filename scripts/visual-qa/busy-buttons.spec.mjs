/**
 * 実際のV8入口で、保留APIによる処理中・失敗・成功と3幅を見張る。
 * 実Googleへは送らない。VISUAL_QA_BASEはローカルでビルドした画面だけを指定する。
 */
import { test, expect } from '@playwright/test'
import scanLayoutDefects from '../../apps/web/scripts/v8-guard/layout-defects-browser.mjs'
import { routeLocalApi } from './local-api.mjs'

test.beforeEach(routeLocalApi)

const base = process.env.VISUAL_QA_BASE ?? 'http://127.0.0.1:3101'
if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(base).hostname)) throw new Error('処理中ボタンの試験はローカル画面専用です')
const fixtureApi = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:8788'
if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(fixtureApi).hostname)) throw new Error('見本APIはローカル専用です')

async function fits(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  const clipped = await page.locator('button:visible').evaluateAll((buttons) => buttons.filter((button) => {
    const box = button.getBoundingClientRect()
    return box.left < -1 || box.right > document.documentElement.clientWidth + 1 || (button.textContent.trim().length > 1 && button.scrollWidth > button.clientWidth + 2)
  }).map((button) => ({ text: button.textContent, left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right, client: button.clientWidth, scroll: button.scrollWidth, css: button.className })))
  expect(clipped).toEqual([])
  await expect(page.locator('nextjs-portal [data-nextjs-dialog]')).toHaveCount(0)
}

for (const width of [1152, 1440, 1920]) {
  test.describe(`処理中のボタン ${width}px`, () => {
    test.use({ viewport: { width, height: 1080 }, timezoneId: 'Asia/Tokyo' })
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        sessionStorage.setItem('lh_auth_selection_cleared', '1')
        localStorage.setItem('lh_auth_selection_cleared', '1')
        localStorage.setItem('lh_selected_account', 'visual-qa-account')
      })
    })
    test('Googleの2入口を同時ロックし、失敗から再試行して成功する', async ({ page, request }, info) => {
      const errors = []
      page.on('pageerror', (err) => errors.push(err.message))
      const fixture = await (await request.get(`${fixtureApi}/api/restaurant-test/google/profile`)).json()
      const profile = { ...fixture, stale: true, googleUpdates: null }
      let release, calls = 0
      await page.route('**/api/restaurant-test/google/profile?*', (route) => route.fulfill({ json: profile }))
      await page.route('**/api/restaurant-test/google/profile/sync?*', async (route) => {
        calls++
        const outcome = await new Promise((done) => { release = done })
        await route.fulfill(outcome === 'failure'
          ? { status: 503, json: { success: false, error: '試験用の接続失敗' } }
          : { json: { ...fixture, stale: false, googleUpdates: null } })
      })
      await page.goto(`${base}/restaurant-test/google?tab=profile`)
      await expect(page).toHaveURL(`${base}/restaurant-test/google?tab=profile`)
      const retry = page.getByRole('button', { name: 'もう一度取得', exact: true })
      const sync = page.getByRole('button', { name: '同期する', exact: true })
      await expect(retry).toBeVisible()
      await expect(sync).toBeVisible()
      await fits(page)
      const before = await retry.boundingBox()
      await retry.click()
      const running = page.getByRole('button', { name: '取得中…', exact: true })
      await expect(running).toHaveCount(2)
      for (const button of await running.all()) {
        await expect(button).toBeDisabled()
        await expect(button).toHaveAttribute('aria-busy', 'true')
      }
      // 実際の連打（disabledなのでクリックは実行されない）。APIは保留のまま1回。
      await running.first().click({ force: true })
      expect(calls).toBe(1)
      expect((await running.first().boundingBox()).width).toBe(before.width)
      await fits(page)
      await info.attach(`取得中-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
      release('failure')
      await expect(retry).toBeEnabled()
      await expect(sync).toBeEnabled()
      await expect(page.getByRole('alert').filter({ hasText: 'プロフィールを読み込めませんでした。' })).toBeVisible()
      await fits(page)
      await sync.click()
      await expect(running).toHaveCount(2)
      await expect.poll(() => calls).toBe(2)
      release('success')
      await expect(sync).toBeEnabled()
      await expect(retry).toHaveCount(0)
      await fits(page)
      expect(errors).toEqual([])
    })
    test('閲覧のみの人には変更操作を出さず、3幅で崩れない', async ({ page }, info) => {
      await page.route('**/api/staff/me', async (route) => {
        const url = new URL(route.request().url())
        const response = await route.fetch({ url: `${fixtureApi}${url.pathname}${url.search}` })
        const json = await response.json()
        await route.fulfill({ json: { ...json, data: { ...json.data, role: 'viewer', readOnly: true } } })
      })
      await page.goto(`${base}/restaurant-test/google?tab=profile`)
      await expect(page).toHaveURL(`${base}/restaurant-test/google?tab=profile`)
      await expect(page.getByText('閲覧のみです。営業時間と店舗情報を確認できます。')).toBeVisible()
      await expect(page.getByRole('button', { name: 'プロフィールを編集', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '営業時間を変更', exact: true })).toHaveCount(0)
      await fits(page)
      await info.attach(`閲覧のみ-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
    })
    for (const route of ['/contents', '/nen-campaigns?tab=columns', '/restaurant-test/organization', '/restaurant-test/stores/new', '/emergency?tab=health', '/tags/fields/migrate?id=field-birthday']) {
      test(`変更した画面のボタンがはみ出さない ${route}`, async ({ page }, info) => {
        const errors = []
        page.on('pageerror', (err) => errors.push(err.message))
        await page.goto(`${base}${route}`)
        await expect(page).toHaveURL(`${base}${route}`)
        await expect(page.locator('main')).toBeVisible()
        await expect(page.getByText('LINEでログイン', { exact: true })).toHaveCount(0)
        await page.waitForLoadState('networkidle')
        if (route === '/restaurant-test/organization') {
          const hierarchy = page.locator('details').filter({ has: page.locator('summary', { hasText: '組織階層' }) })
          if (width === 1152) {
            await expect(hierarchy).toBeVisible()
            await hierarchy.locator('summary').click()
            await expect(hierarchy).toHaveAttribute('open', '')
            await fits(page)
            await hierarchy.locator('summary').click()
          } else await expect(hierarchy).toBeHidden()
          const accounts = page.getByRole('table', { name: 'アカウント一覧' })
          const rows = accounts.getByRole('row').filter({ has: page.getByRole('button', { name: '変更', exact: true }) })
          await expect(rows).toHaveCount(3)
          for (const row of await rows.all()) {
            await expect(row.getByRole('button')).toHaveCount(2)
            await expect(row.getByRole('button', { name: /その他操作$/ })).toBeVisible()
            await expect(row.getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
          }
          await rows.first().getByRole('button', { name: /その他操作$/ }).click()
          await fits(page)
          await page.getByRole('menuitem', { name: '停止', exact: true }).click()
          await expect(page.getByRole('dialog')).toBeVisible()
          await page.getByRole('button', { name: 'キャンセル', exact: true }).click()
          await expect(page.getByRole('dialog')).toHaveCount(0)
          // 変更したアカウント表を同じCI検査で測る（折り返し・潰れ・切れ・重なり）。
          // 店舗一覧の隣り合う行の境界は、この表の検査対象に含めない。
          const defects = await page.evaluate(scanLayoutDefects)
          expect(defects.filter((finding) => finding.target.includes('.organization_table'))).toEqual([])
        }
        await info.attach(`画面-${width}`, { body: await page.screenshot(), contentType: 'image/png' })
        await fits(page)
        expect(errors).toEqual([])
      })
    }
  })
}

for (const width of [390, 1024, 1152, 1440]) {
  test(`リマインダの名前と操作が見える ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      sessionStorage.setItem('lh_auth_selection_cleared', '1')
      localStorage.setItem('lh_auth_selection_cleared', '1')
      localStorage.setItem('lh_selected_account', 'visual-qa-account')
    })
    await page.goto(`${base}/reminders`)
    const row = page.locator('tbody tr').first()
    const name = row.locator('td').nth(2).locator('a')
    await expect(name).toBeVisible()
    const bounds = await name.boundingBox()
    expect(bounds.width).toBeGreaterThan(40)
    const menu = row.getByRole('button', { name: /リマインダ.*操作/ })
    await expect(menu).toBeVisible()
    const table = await row.locator('xpath=ancestor::table').boundingBox()
    expect(table.x + table.width).toBeLessThanOrEqual(width + 1)
    const heading = page.getByRole('columnheader', { name: 'リマインダ（基準日・いつ送るか）' })
    await expect(heading.locator('span').first()).toHaveCSS('overflow', 'hidden')
    if (width > 600) await expect(page.getByRole('columnheader', { name: '次に送る' })).toBeVisible()
  })
}
