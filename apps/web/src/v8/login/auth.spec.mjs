import { test, expect } from '@playwright/test'
import { waitForOverlayLayout } from '../../../../../scripts/browser/overlay-ready.mjs'
const mockPort = Number(process.env.TRAIN30_MOCK_PORT ?? 8788)
// Drain prefetches before removing interception; the build can use an HTTPS API.
test.afterEach(async ({ page }) => {
  await page.waitForLoadState('networkidle')
  await page.unrouteAll({ behavior: 'wait' })
})
async function openPrimaryAuthenticatedChallenge(page, path, token, method) {
  const nonce = crypto.randomUUID()
  await page.evaluate(({ nonce, path }) => sessionStorage.setItem('lh_login_handoff', JSON.stringify({ nonce, expires: Date.now() + 600000, kind: 'challenge', path })), { nonce, path })
  const fragment = new URLSearchParams({ lh_2fa: token, lh_method: method, lh_nonce: nonce })
  await page.goto(`${path}#${fragment}`)
}
for (const width of [1152,1440,1920]) test(`shared list tools and support actions stay usable at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 })
  await page.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'visual-qa-account')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
  })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    return route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${mockPort}${url.pathname}${url.search}` }) })
  })
  for (const path of ['/auto-replies/runs?id=ar-2', '/friend-add-settings/runs', '/mileage/friends/detail?id=friend-1', '/ops/tenants', '/ops/support']) {
    await page.goto(path)
    await expect(page.locator('[data-list-toolbar]').first()).toBeVisible()
    if (path === '/ops/support') await expect(page.getByRole('button', { name: '返信する', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const main = document.querySelector('main'), bounds = main.getBoundingClientRect()
      const controls = [...main.querySelectorAll('[data-list-toolbar] button, [data-list-toolbar] input, [data-dialog-actions] button')]
        .map(el => ({ el, rect: el.getBoundingClientRect() })).filter(({ rect }) => rect.width > 0 && rect.height > 0)
      const clipped = controls.filter(({ rect }) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1).length
      let overlaps = 0
      for (let a = 0; a < controls.length; a++) for (let b = a + 1; b < controls.length; b++) {
        const one = controls[a], two = controls[b]
        if (one.el.contains(two.el) || two.el.contains(one.el)) continue
        if (Math.min(one.rect.right, two.rect.right) - Math.max(one.rect.left, two.rect.left) > 1
          && Math.min(one.rect.bottom, two.rect.bottom) - Math.max(one.rect.top, two.rect.top) > 1) overlaps++
      }
      return { controls: controls.length > 0, clipped, overlaps, horizontalScroll: main.scrollWidth - main.clientWidth }
    })).toEqual({ controls: true, clipped: 0, overlaps: 0, horizontalScroll: 0 })
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`shared-tools-${path.replace(/\W/g, '-')}-${width}.png`) })
  }
})
async function centered(button) {
  await expect(button).toBeVisible()
  const position = await button.evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el)
    const text = range.getBoundingClientRect(), box = el.getBoundingClientRect()
    return { align: getComputedStyle(el).justifyContent, delta: Math.abs(text.x + text.width/2 - box.x - box.width/2), width: box.width }
  })
  expect(position.align).toBe('center'); expect(position.delta).toBeLessThanOrEqual(1)
}
async function detailTypography(page, label) {
  const heading = page.getByRole('heading', { name: label, exact: true })
  const value = heading.locator('..').locator('strong')
  const typography = el => { const style = getComputedStyle(el); return { size: parseFloat(style.fontSize), weight: Number(style.fontWeight) } }
  const headingStyle = await heading.evaluate(typography)
  const valueStyle = await value.evaluate(typography)
  expect(headingStyle.size).toBeLessThanOrEqual(12)
  expect(valueStyle).toEqual({ size: 13, weight: 600 })
  expect(headingStyle.weight).toBeLessThan(valueStyle.weight)
}
for (const width of [1152,1440,1920]) test(`MFA input and centered auth buttons at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  let submitted = null
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()); const path = url.pathname
    let data
    if (path === '/api/auth/password/reset/check') data = { email: 'fixture@example.com' }
    if (path === '/api/auth/two-factor/setup') data = { provisioningUri: 'otpauth://totp/musubo:fixture?secret=JBSWY3DPEHPK3PXP&issuer=musubo', manualKey: 'JBSW Y3DP EHPK 3PXP' }
    if (path === '/api/auth/two-factor/setup/confirm') data = { sessionToken: 'session-1' }
    if (path === '/api/auth/two-factor/verify') { submitted = route.request().postDataJSON(); return route.fulfill({ status: 400, json: { success: false, error: 'コードが違います' } }) }
    if (data) return route.fulfill({ status: 200, json: { success: true, data } })
    // Every remaining API request is redirected to the local fixture server.
    return route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${mockPort}${url.pathname}${url.search}` }) })
  })
  await page.goto('/login'); await centered(page.getByRole('button', { name: 'ログイン', exact: true }))
  // ログインの 1 段目も、二段階認証と同じ公式ロゴと手順を出す。
  await expect(page.locator('[data-auth-head]')).toContainText('1 / 2')
  const brandSrc = await page.locator('[data-auth-head] img[alt="musubo"]').getAttribute('src')
  expect(brandSrc).toBe('/brand/musubo-color.png')
  await page.goto('/password/reset?token=fixture-reset')
  await centered(page.getByRole('button', { name: 'パスワードを設定してログインへ' }))
  await openPrimaryAuthenticatedChallenge(page, '/login/two-factor', 'fixture-challenge', 'password')
  await expect(page.getByRole('textbox')).toHaveCount(6)
  const authLayout = await page.getByRole('group', { name: '認証コード（6桁）' }).evaluate(input => {
    const card = input.closest('section[data-auth-layout="admin"]')
    const heading = card.querySelector('h1').getBoundingClientRect()
    const box = card.getBoundingClientRect()
    const head = card.querySelector('[data-auth-head]').getBoundingClientRect()
    const slots = input.getBoundingClientRect()
    const boxes = [...input.querySelectorAll('input')].map(el => el.getBoundingClientRect())
    return { titleInset: heading.x - slots.x, headInset: head.x - slots.x, titleGap: slots.top - heading.bottom, headAbove: heading.top - head.bottom, inputRight: slots.right, cardRight: box.right, oneRow: boxes.every(b => Math.abs(b.top - boxes[0].top) < 1), groupGap: boxes[3].left - boxes[2].right, innerGap: boxes[1].left - boxes[0].right }
  })
  expect(Math.abs(authLayout.titleInset)).toBeLessThanOrEqual(1)
  expect(Math.abs(authLayout.headInset)).toBeLessThanOrEqual(1)
  expect(authLayout.titleGap).toBeGreaterThan(0)
  expect(authLayout.titleGap).toBeLessThanOrEqual(48)
  expect(authLayout.headAbove).toBeGreaterThanOrEqual(16)
  expect(authLayout.inputRight).toBeLessThan(authLayout.cardRight)
  // 6 マスは 1 行、3 桁ずつの間は組の中より広い。
  expect(authLayout.oneRow).toBe(true)
  expect(authLayout.groupGap).toBeGreaterThan(authLayout.innerGap)
  await expect(page.locator('[data-auth-head]')).toContainText('2 / 2')
  await expect(page.getByRole('link', { name: '別のアカウントで入る' })).toHaveAttribute('href', '/login')
  expect(await page.getByRole('group', { name: '認証コード（6桁）' }).evaluate(el => getComputedStyle(el.closest('[data-field-content-gap]')).gap)).toBe('12px')
  await centered(page.getByRole('button', { name: '確認してログイン', exact: true }))
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`verify-${width}.png`) })
  await page.getByRole('button', { name: 'コードが使えない場合' }).click()
  await expect(page.getByRole('button', { name: '回復コードを使う' })).toHaveCount(0)
  await openPrimaryAuthenticatedChallenge(page, '/login/two-factor/setup', 'fixture-setup', 'line')
  await expect(page.getByAltText('認証アプリ登録用のQRコード')).toBeVisible()
  await centered(page.getByRole('button', { name: '登録してログイン' }))
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`setup-${width}.png`) })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  expect(errors).toEqual([])
})
for (const width of [1152,1440,1920]) test(`policy confirmation and authenticator settings at ${width}`, async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('lh_selected_account','visual-qa-account'); sessionStorage.setItem('lh_auth_selection_cleared','1') })
  await page.setViewportSize({ width, height: 1000 })
  let required = true, writes = 0
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method()
    let data
    if (path === '/api/auth/two-factor/policy') {
      if (method === 'PUT') { required = route.request().postDataJSON().required; writes++ }
      data = { required, canEdit: true, configured: true, notice: null, registered: 4, total: 6, relogin: false }
    }
    if (path === '/api/auth/passkeys/self') data = []
    if (path === '/api/auth/two-factor/self') data = { staffId: 'visual-qa-owner', enabledAt: '2026-10-12T03:00:00Z', canEdit: true, configured: true, notice: null }
    if (path === '/api/auth/step-up') data = { token: 'fixture-step-up-grant' }
    if (data) return route.fulfill({ status: 200, json: { success: true, data } })
    return route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${mockPort}${url.pathname}${url.search}` }) })
  })
  await page.goto('/staff')
  await expect(page.getByRole('heading', { name: '二段階認証', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '認証アプリ', exact: true })).toContainText('登録済み')
  await page.getByRole('heading', { name: '二段階認証', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`personal-${width}.png`), fullPage: true })
  await page.getByRole('tab', { name: '役割と権限', exact: true }).click()
  await detailTypography(page, '登録済み')
  await page.getByRole('switch', { name: 'ログインで二段階認証を必須にする' }).click()
  const dialog = page.getByRole('dialog', { name: '二段階認証の必須をオフにしますか' })
  await expect(dialog).toBeVisible()
  await waitForOverlayLayout(dialog)
  await dialog.getByRole('textbox', { name: '1桁目' }).fill('123456')
  expect(await dialog.getByRole('textbox').evaluateAll(inputs => inputs.map(input => input.value))).toEqual(['1', '2', '3', '4', '5', '6'])
  expect(writes).toBe(0)
  await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`off-confirm-${width}.png`) })
  await dialog.getByRole('button', { name: 'オフにする', exact: true }).click()
  await expect.poll(() => writes).toBe(1)
  await expect(page.getByRole('switch', { name: 'ログインで二段階認証を必須にする' })).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
})


// The style step shows the six styles as one switch; it only views until 「このスタイルにする」 is pressed.
const STYLE_CHOICE_ORDER = ['restaurant', 'salon', 'consult', 'lesson', 'standard', 'ec']
const styleChoiceButtons = dialog => dialog.getByRole('group', { name: '見るスタイル' }).getByRole('button')

async function expectStyleChoices(dialog) {
  await expect(styleChoiceButtons(dialog)).toHaveCount(STYLE_CHOICE_ORDER.length)
  for (const name of ['あとで設定する', '手動で設定する']) await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible()
}

test('new style selection opens once, explicit later and legacy later stay deferred', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'visual-qa-account')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
  })
  const fixture = await (await page.request.get(`http://127.0.0.1:${mockPort}/api/dashboard/style`)).json()
  let pending = true, mode = 'later', selected = false, version = 1, writes = 0
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/dashboard/style') {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON()
        expect(body).toMatchObject({ expectedVersion: version, styleMode: 'later' })
        pending = false; version++; writes++
      }
      return route.fulfill({ json: { success: true, data: { ...fixture.data, style: 'standard', styleSelected: selected, styleMode: mode, shouldPromptStyleSelection: pending, version, inserted: [], changedAnswers: {}, bookingSettingsChanges: [], answers: { style: { mode } } } } })
    }
    return route.fulfill({ response: await route.fetch({ url: `http://127.0.0.1:${mockPort}${url.pathname}${url.search}` }) })
  })
  const dialog = page.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
  await page.goto('/')
  await expect(dialog).toBeVisible()
  await expectStyleChoices(dialog)
  await dialog.getByRole('button', { name: 'あとで設定する', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toBe(1)
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(dialog).toHaveCount(0)
  // A separate visit with the explicit entry still permits resuming.
  await page.goto('/?setup=0')
  await expect(dialog).toBeVisible()
  await page.goto('/')
  for (const state of [
    { mode: 'later', pending: undefined, selected: false },
    { mode: 'manual', pending: false, selected: false },
    { mode: 'configured', pending: false, selected: true },
  ]) {
    mode = state.mode; pending = state.pending; selected = state.selected
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(dialog).toHaveCount(0)
  }
  expect(writes).toBe(1)
})

async function useIndustryFixture(page, style = 'salon', legacyMeet = false) {
  // Use the same mock responder without a second network request. Navigation can
  // cancel a prefetch while route.fetch() is waiting, before its later fulfill.
  const { mockFetch } = await import('../../../scripts/v8-guard/mock-local.mjs')
  const { styleDashboardMock } = await import('../../../../../scripts/visual-qa/style-dashboard-mock.mjs')
  styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style })
  await page.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'visual-qa-account')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
  })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const response = await mockFetch(route.request().method(), `${url.pathname}${url.search}`)
    if (url.pathname === '/api/dashboard/style') {
      expect(route.request().method()).toBe('GET')
      const fixture = JSON.parse(response.body)
      return route.fulfill({ json: { ...fixture, data: { ...fixture.data, style, styleSelected: true, styleMode: 'configured', shouldPromptStyleSelection: false } } })
    }
    if (legacyMeet && url.pathname === '/api/dashboard/style/schedule') {
      const fixture = JSON.parse(response.body)
      const entry = fixture.data.entries[0]
      entry.id = 'meet:legacy-meet'
      entry.kind = 'meet'
      entry.booking = { ...entry.booking, id: 'legacy-meet', kind: 'meet', friendId: 'friend-1' }
      return route.fulfill({ json: fixture })
    }
    return route.fulfill({ status: response.status, headers: {
      ...response.headers,
      'access-control-allow-origin': route.request().headers().origin ?? 'null',
    }, body: response.body })
  })
}

for (const [style, heading] of [['standard', 'ダッシュボード'], ['ec', 'ダッシュボード'], ['restaurant', 'お店'], ['salon', 'サロン'], ['consult', '面談'], ['lesson', '教室']]) test(`${style} resumes shared setup and summary, then returns without changing the style`, async ({ page }) => {
  await useIndustryFixture(page, style)
  for (const [step, title] of [['0', '使い方のスタイルを選ぶ'], ['summary', '準備ができました']]) {
    await page.goto(`/?setup=${step}`)
    const dialog = page.getByRole('dialog', { name: title })
    await expect(dialog).toBeVisible()
    if (step === '0') await expectStyleChoices(dialog)
    await dialog.getByRole('button', { name: '閉じる', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true, level: 1 })).toBeVisible()
    if (['restaurant','salon','consult','lesson'].includes(style)) await expect(page.locator(`[data-style-dashboard="${style}"]`)).toBeVisible()
  }
})

test('salon keeps existing KPI slots and forwards real staff, time and booking identity', async ({ page }) => {
  await useIndustryFixture(page)
  await page.goto('/')
  const band = page.locator('[data-style-dashboard="salon"]')
  await expect.poll(() => band.locator('[data-kpi-label]').evaluateAll(items => items.map(item => item.title))).toEqual(['今日の予約', '対応待ち', '次回予約率', '呼び戻し待ち', '無断キャンセル率'])
  await expect(band).toContainText('8人')
  for (const width of [1152, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`salon-${width}.png`) })
  }
  const board = page.getByRole('region', { name: '台帳の盤' })
  await board.getByRole('button', { name: /入れる.*15:00/ }).first().click()
  await expect(page).toHaveURL(/\/booking\/bookings\/new\?/)
  let url = new URL(page.url())
  expect(url.searchParams.get('staffId')).toBe('s1')
  expect(url.searchParams.get('time')).toBe('15:00')
  expect(url.searchParams.get('date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  await page.goto('/')
  await board.getByRole('button', { name: /見本 186さん/ }).click()
  await page.getByRole('menuitem', { name: '詳細を開く' }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/booking/bookings' && url.searchParams.getAll('booking').length === 1 && url.searchParams.get('booking') === 'e1')

  await page.goto('/?view=calendar&range=week')
  const week = page.getByRole('region', { name: '1週間のカレンダー' })
  await week.getByRole('button', { name: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}に予約を入れる$/ }).first().click()
  await expect(page).toHaveURL(/\/booking\/bookings\/new\?/)
  url = new URL(page.url())
  expect(url.searchParams.get('date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(url.searchParams.get('time')).toMatch(/^\d{2}:\d{2}$/)
  expect(url.searchParams.has('staffId')).toBe(false)
  await page.goto('/?view=calendar&range=week')
  await week.getByRole('button', { name: '10:00〜11:30 カット 見本 143', exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/booking/bookings' && url.searchParams.getAll('booking').length === 1 && url.searchParams.get('booking') === 'w1')
})


test('consult forwards board and weekly booking identity, date, time and staff', async ({ page }) => {
  await useIndustryFixture(page, 'consult')
  await page.goto('/?view=board')
  const board = page.getByRole('region', { name: '台帳の盤' })
  await board.getByRole('button', { name: /入れる.*13:30/ }).first().click()
  await expect(page).toHaveURL(/\/booking\/bookings\/new\?/)
  let url = new URL(page.url())
  expect(url.searchParams.get('staffId')).toBe('yamaguchi')
  expect(url.searchParams.get('time')).toBe('13:30')
  expect(url.searchParams.get('date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  await page.goto('/?view=board')
  await board.getByRole('button', { name: /見本 125さん/ }).click()
  await page.getByRole('menuitem', { name: '詳細を開く' }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/booking/bookings' && url.searchParams.getAll('booking').length === 1 && url.searchParams.get('booking') === 'm1')
  await page.goto('/?view=calendar&range=week')
  const week = page.getByRole('region', { name: '1週間のカレンダー' })
  await week.getByRole('button', { name: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}に予約を入れる$/ }).first().click()
  await expect(page).toHaveURL(/\/booking\/bookings\/new\?/)
  url = new URL(page.url())
  expect(url.searchParams.get('date')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(url.searchParams.get('time')).toMatch(/^\d{2}:\d{2}$/)
  expect(url.searchParams.has('staffId')).toBe(false)
  await page.goto('/?view=calendar&range=week')
  await week.getByRole('button', { name: '10:00〜11:00 転職の初回面談 見本 125', exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/booking/bookings' && url.searchParams.getAll('booking').length === 1 && url.searchParams.get('booking') === 'm1')
})

test('legacy Meet consult opens the related friend without treating its ID as a booking', async ({ page }) => {
  await useIndustryFixture(page, 'consult', true)
  await page.goto('/?view=board')
  await page.getByRole('region', { name: '台帳の盤' }).getByRole('button', { name: /見本 125さん/ }).click()
  await page.getByRole('menuitem', { name: '詳細を開く' }).click()
  await expect(page).toHaveURL(/\/friends\/detail\?id=friend-1$/)
})

test('pass summary separates simulation failures and cancellation from unavailable real billing', async ({ page }) => {
  await useIndustryFixture(page, 'lesson')
  await page.goto('/booking/menus?tab=passes')
  const card = page.locator('[data-kpi-presentation="band"][data-kpi-density]').filter({ has: page.locator('[data-kpi-label][title="引き落としの失敗"]') })
  await expect(card).toContainText('実課金は未接続')
  await expect(card).toContainText('試験：失敗1・正常解約2')
  await expect(card.locator('[data-kpi-number]')).toHaveText('—')
  for (const width of [1152, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    await expect.poll(() => card.locator('[data-kpi-detail]').evaluate(el => ({ overflow: el.scrollWidth - el.clientWidth, height: el.clientHeight > 0 }))).toEqual({ overflow: 0, height: true })
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`passes-${width}.png`) })
  }
})

for (const style of ['salon', 'ec']) test(`discarding unsaved ${style} setup never saves at three widths`, async ({ page }) => {
  await useIndustryFixture(page, 'standard')
  const writes = []
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname.startsWith('/api/dashboard/style') && !['GET', 'HEAD'].includes(request.method())) {
      writes.push({ path: url.pathname, method: request.method() })
      return route.fulfill({ status: 503, json: { success: false, error: 'Unexpected write during discard' } })
    }
    return route.fallback()
  })
  for (const [width, close] of [[1152, 'button'], [1440, 'escape'], [1920, 'backdrop']]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/?setup=0')
    const selection = page.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
    await styleChoiceButtons(selection).nth(STYLE_CHOICE_ORDER.indexOf(style)).click()
    await selection.getByRole('button', { name: 'このスタイルにする', exact: true }).click()
    await selection.getByRole('button', { name: '次へ', exact: true }).click()
    const question = page.getByRole('dialog', { name: '最初のリッチメニューを選ぶ' })
    await expect(question.getByRole('button', { name: '途中保存して閉じる', exact: true })).toBeEnabled()
    await expect.poll(() => question.evaluate(dialog => {
      const bounds = dialog.getBoundingClientRect()
      const buttons = [...dialog.querySelectorAll('[data-dialog-actions] button')].map(button => button.getBoundingClientRect()).filter(box => box.width > 0)
      const clipped = buttons.filter(box => box.left < bounds.left || box.right > bounds.right).length
      let overlap = 0
      for (let a = 0; a < buttons.length; a++) for (let b = a + 1; b < buttons.length; b++) {
        if (Math.min(buttons[a].right, buttons[b].right) > Math.max(buttons[a].left, buttons[b].left)
          && Math.min(buttons[a].bottom, buttons[b].bottom) > Math.max(buttons[a].top, buttons[b].top)) overlap++
      }
      return { clipped, overlap, horizontal: document.documentElement.scrollWidth - innerWidth }
    })).toEqual({ clipped: 0, overlap: 0, horizontal: 0 })
    await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`discard-${style}-${width}.png`) })
    if (close === 'button') await question.getByRole('button', { name: '閉じる', exact: true }).click()
    else if (close === 'escape') await page.keyboard.press('Escape')
    else await question.locator('..').click({ position: { x: 2, y: 2 } })
    await page.getByRole('button', { name: '破棄する', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'ダッシュボード', exact: true, level: 1 })).toBeVisible()
    await page.goto('/?setup=0')
    const reopened = page.getByRole('dialog', { name: '使い方のスタイルを選ぶ' })
    const saved = styleChoiceButtons(reopened).nth(STYLE_CHOICE_ORDER.indexOf('standard'))
    await expect(saved).toHaveAttribute('aria-pressed', 'true')
    await expect(saved).toHaveAccessibleName(/（選んでいます）$/)
    await reopened.getByRole('button', { name: '閉じる', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(writes).toEqual([])
  }
})
