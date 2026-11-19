/*
  左メニューの上端・左端そろえの実挙動試験。

  **実build（`apps/web/out`）を実ルーティングで開き、実ブラウザで測る。**
  文字列検査ではないので、組の見出しの文字の上端が右の板の上端と
  そろっているか、ロゴが上の帯の縦の中心にあるか、項目・設定の箱の
  左端がロゴの箱と同じ線にあるかをブラウザの側から見る。
  店の画面（/friends）と統括の画面（/hq）を 1440px・1366px・1152px で見る。
  1366px は谷間帯（1280〜1439px）の上書きが効く幅で、左端のそろえが
  崩れないことを確かめる。

  APIは1か所で受けて必ず `fulfill` する。**外へは1本も出さない。**
  （`tag-archived-edit.spec.mjs` と同じ作法。）
*/
import { expect, test } from '@playwright/test'

const BASE = process.env.SIDEBAR_TOP_ALIGNMENT_BASE ?? 'http://127.0.0.1:3111'

function ok(data) {
  return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ success: true, data }) }
}

function fail() {
  return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ success: false, error: '試験用の失敗' }) }
}

/** APIの応答を1か所で決める。店も統括もアカウント未選択（見出しの位置が札に動かされない形）。 */
async function mockApi(page, accountScope) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/session') {
      await route.fulfill(ok({ id: 'staff-me', name: '確認用', role: 'owner', email: null, permissionKeys: [] }))
      return
    }
    if (path === '/api/staff/me') {
      await route.fulfill(ok({ id: 'staff-me', name: '確認用', role: 'owner', email: null, accountScope }))
      return
    }
    if (path === '/api/line-accounts') {
      await route.fulfill(ok([]))
      return
    }
    await route.fulfill(fail())
  })
  await page.addInitScript(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
}

async function measure(page, heading) {
  await expect(page.locator('main')).toBeVisible()
  const desktop = page.locator('aside:not(#mobile-menu)')
  await expect(desktop).toBeVisible()
  const button = desktop.locator('nav button', { hasText: heading })
  await expect(button).toBeVisible()
  // 見出しが先に描画され、権限やアカウントの読み込み後にリンクが加わる。
  // 測る対象がそろうまで待ち、存在しない場合は計測を飛ばさず試験を失敗させる。
  await expect(desktop.locator('nav a').first()).toHaveCount(1)
  await expect(desktop.locator('a').filter({ hasText: /^(設定|統括の設定)$/ }).first()).toHaveCount(1)
  return page.evaluate((name) => {
    const desk = document.querySelector('aside:not(#mobile-menu)')
    const btn = [...desk.querySelectorAll('nav button')].find((b) => b.textContent?.trim() === name)
    const span = btn.querySelector('span')
    const main = document.querySelector('main')
    const header = document.querySelector('header')
    const logoViewport = desk.querySelector('[data-design-node="J33xq/V2WbXF"] > span')
    const firstItem = desk.querySelector('nav a')
    const settings = [...desk.querySelectorAll('a')].find((a) => a.textContent?.trim() === '設定' || a.textContent?.trim() === '統括の設定')
    const top = (el) => el.getBoundingClientRect().top
    const left = (el) => el.getBoundingClientRect().left
    const centerY = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }
    const mainStyle = getComputedStyle(main)
    return {
      headingTextTop: top(span),
      boardTop: top(main),
      boardRadius: mainStyle.borderRadius,
      logoCenterY: centerY(logoViewport),
      topbarCenterY: centerY(header),
      itemLeft: left(firstItem),
      settingsLeft: left(settings),
      logoLeft: left(logoViewport),
    }
  }, heading)
}

for (const width of [1440, 1366, 1152]) {
  test.describe(`左メニューのそろえ ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, timezoneId: 'Asia/Tokyo' })
    for (const [title, route, scope, heading] of [
      ['店の画面', '/friends', 'accounts', 'メイン'],
      ['統括の画面', '/hq', 'all', '統括'],
    ]) {
      test(`${title}：見出しの文字の上端は板の上端と±2px（上にはみ出さない）`, async ({ page }) => {
        await mockApi(page, scope)
        await page.goto(`${BASE}${route}`)
        const m = await measure(page, heading)
        // 板の正体（main・角丸16）が変わっていたら測り先が違うので落とす。
        expect(m.boardRadius).toContain('16px')
        const diff = m.headingTextTop - m.boardTop
        expect(diff).toBeGreaterThanOrEqual(0)
        expect(diff).toBeLessThanOrEqual(2)
      })

      test(`${title}：ロゴは上の帯の縦の中心・箱の左端はロゴと同じ線`, async ({ page }) => {
        await mockApi(page, scope)
        await page.goto(`${BASE}${route}`)
        const m = await measure(page, heading)
        expect(Math.abs(m.logoCenterY - m.topbarCenterY)).toBeLessThanOrEqual(1)
        expect(m.itemLeft).toBe(m.logoLeft)
        expect(m.settingsLeft).toBe(m.logoLeft)
      })
    }
  })
}
