/*
  枠 02 (C5i3rw) の寸法を実画面で突き合わせる。
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen の
  実測値（Pencil の Get で取得した bounds）:
    カード G8vBl   x410 y197 w620 h606
    見出し VliWA   h52（輪 cohVt 52 と同じ）
    一覧 LcMa3     h454（通常行 46 x8 ＋ 現在行 54 ＋ gap4 x8）
    通常行 bnJsJ   h46 / 現在行 v4LA6 h54 / 足 TTZx2 h16
  差し戻し V1（カードが40.3px高い）の再発を止めるための検査。
  実行前に Next dev とモックAPIを上げておく:
    VISUAL_QA_MOCK=http://127.0.0.1:8788 VISUAL_QA_BASE=http://127.0.0.1:3101 \
      pnpm exec playwright test scripts/visual-qa/first-run-popup.size.spec.mjs
*/
import { test, expect } from '@playwright/test'
import { captureClockFor, QA_TIMEZONE } from './qa-clock.mjs'
import { routeLocalApi } from './local-api.mjs'

test.beforeEach(routeLocalApi)
test.use({ timezoneId: QA_TIMEZONE })

const BASE = process.env.VISUAL_QA_BASE ?? 'http://localhost:3101'
const MOCK = process.env.VISUAL_QA_MOCK ?? 'http://127.0.0.1:8788'

/* 枠 02 と同じ 1/9（①済み・②が現在）。撮影テストの PEN_STATES['1/9'] と同じ元データ。 */
async function routePenState(page) {
  await page.route('**/api/getting-started**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/getting-started') {
      await route.fallback()
      return
    }
    const steps = [
      { key: 'accounts', state: 'done', href: '/accounts', reason: null, webhook: [{ id: 'visual-qa-account', status: 'matched' }] },
      { key: 'featureSet', state: 'todo', href: '/settings', reason: null },
      { key: 'attributes', state: 'todo', href: '/tags?tab=tags', reason: null },
      { key: 'friendAdd', state: 'todo', href: '/friend-add-settings', reason: null },
      { key: 'scenario', state: 'todo', href: '/scenarios', reason: null },
      { key: 'firstMessage', state: 'todo', href: '/chats', reason: null },
    ]
    await route.fulfill({ json: { success: true, data: { accountId: 'visual-qa-account', doneCount: 1, total: 6, allDone: false, steps } } })
  })
  await page.route('**/api/restaurant-test/setup-progress**', async route => {
    const url = new URL(route.request().url())
    const storeId = url.searchParams.get('storeId') ?? 'store-sby'
    await route.fulfill({ json: { success: true, data: { storeId, tables: false, hours: false, menus: false, reception: false, followup: false } } })
  })
  await page.route('**/api/rich-menu-groups**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/rich-menu-groups') {
      await route.fallback()
      return
    }
    await route.fulfill({
      json: { success: true, data: { items: [], total: 0, limit: 1, sort: 'priority', facets: { total: 0, published: 0, targeting: 0, folderCounts: {} } } },
    })
  })
}

async function openPopup(page, width, height) {
  await page.request.put(`${MOCK}/api/dashboard/style?accountId=visual-qa-account`, { data: { style: 'restaurant' } })
  await page.request.put(`${MOCK}/api/getting-started/guide?accountId=visual-qa-account`, { data: { phase: 'idle', stepKey: null, procedureIndex: 1 } })
  await routePenState(page)
  await page.setViewportSize({ width, height })
  await page.clock.setFixedTime(new Date(captureClockFor('/')))
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem('lh_auth_selection_cleared', '1')
      window.localStorage.setItem('lh_selected_account', 'visual-qa-account')
      window.localStorage.removeItem('lh:v8:first-run-popup-dismissed:visual-qa-account')
      window.localStorage.removeItem('lh:v8:first-steps-folded:visual-qa-account')
    } catch {}
  })
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  const popup = page.locator('[data-first-run-popup="open"]')
  await expect(popup).toBeVisible()
  return popup
}

test('枠 02: 1440x1000・1/9 のカードと行が Pen の実測値どおり', async ({ page }) => {
  const popup = await openPopup(page, 1440, 1000)
  const got = await popup.evaluate(node => {
    const box = el => {
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.x), y: Math.round(b.y * 100) / 100, w: Math.round(b.width), h: Math.round(b.height * 100) / 100 }
    }
    const card = node.querySelector('[class*="card"]')
    const kid = name => [...card.children].find(el => new RegExp(name).test(el.className))
    const rowsBox = kid('rows')
    const rows = [...rowsBox.children]
    const current = rows.find(el => /rowCurrent/.test(el.className))
    return {
      card: box(card),
      header: box(kid('header')).h,
      rows: box(rowsBox).h,
      footer: box(kid('footer')).h,
      rowDone: box(rows.find(el => /rowDone/.test(el.className))).h,
      rowCurrent: box(current).h,
      rowTodo: rows.filter(el => !/rowDone|rowCurrent/.test(el.className)).map(el => box(el).h),
      action: box(current.querySelector('button')).h,
      badge: box(rows.map(el => el.querySelector('[class*="badge"]')).find(Boolean)).h,
    }
  })
  expect(got.card).toEqual({ x: 410, y: 197, w: 620, h: 606 })
  expect(got.header).toBe(52)
  expect(got.rows).toBe(454)
  expect(got.footer).toBe(16)
  expect(got.rowDone).toBe(46)
  expect(got.rowCurrent).toBe(54)
  expect(got.rowTodo).toEqual([46, 46, 46, 46, 46, 46, 46])
  /* 操作 pdn85 h34・札 r7xHZ0 h21。枠の padding（9px 14px・3px 8px）どおりの高さ。 */
  expect(got.action).toBe(34)
  expect(got.badge).toBe(21)
})

/* 枠 02b (nt3Po) のシート noXJA: x0 y118 w390 h782。PC の直しで崩していないことを見る。 */
test('枠 02b: 390x900・1/9 のシートが画面下部固定のまま', async ({ page }) => {
  const popup = await openPopup(page, 390, 900)
  const card = await popup.evaluate(node => {
    const b = node.querySelector('[class*="card"]').getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y * 100) / 100, w: Math.round(b.width), h: Math.round(b.height * 100) / 100 }
  })
  expect(card).toEqual({ x: 0, y: 118, w: 390, h: 782 })
})

/*
  枠 02b を指で押す端末で見る。共通規定（globals.css の `@media (pointer: coarse)` の
  min-height 44）が効くと操作 ZcmBy が 44 になり、現在行が 64 へ伸びて
  足 UanUf が枠の y660 より下がる。高さは枠の 34 のまま、押せる範囲だけ広げる
  （§6.5 の 7）形を固定する。
*/
test.describe('指で押す端末', () => {
  test.use({ hasTouch: true })
  test('枠 02b: 操作は枠どおり h34・押せる範囲は44以上・足は y660', async ({ page }) => {
    const popup = await openPopup(page, 390, 900)
    const got = await popup.evaluate(node => {
      const card = node.querySelector('[class*="card"]')
      const kid = name => [...card.children].find(el => new RegExp(name).test(el.className))
      const rowsBox = kid('rows')
      const current = [...rowsBox.children].find(el => /rowCurrent/.test(el.className))
      const action = current.querySelector('button')
      const b = action.getBoundingClientRect()
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      const reach = [cy - 21, cy + 21].every(y => action.contains(document.elementFromPoint(cx, y)))
      return {
        gap: getComputedStyle(rowsBox).rowGap,
        action: Math.round(b.height * 100) / 100,
        rowCurrent: Math.round(current.getBoundingClientRect().height * 100) / 100,
        footerY: Math.round(kid('footer').getBoundingClientRect().y * 100) / 100,
        reach,
      }
    })
    expect(got.action).toBe(34)
    expect(got.rowCurrent).toBe(54)
    expect(got.gap).toBe('3px')
    expect(got.footerY).toBe(660)
    expect(got.reach).toBe(true)
  })
})
