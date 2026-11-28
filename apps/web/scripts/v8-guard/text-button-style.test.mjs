import test from 'node:test'
import assert from 'node:assert/strict'
import { connectGuardBrowser } from './browser-session.mjs'
import { compileTextButtonFixture, textButtonFixtureHtml } from './text-button-fixture.mjs'
import { openPage } from './browser-env.mjs'
import { stubApi } from './speed-budget.mjs'
import { mockFetch } from './mock-local.mjs'

test('文字操作は本文と違う緑、明示色・選択・灰色と理由・焦点の下線を保つ', async () => {
  const fixture = await compileTextButtonFixture()
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    page.on('pageerror', error => console.error('fixture-runtime:', error.stack || error.message))
    for (const width of [1152, 1440]) {
      await page.setViewportSize({ width, height: 1100 })
      await page.setContent(textButtonFixtureHtml(fixture.css))
      await page.addScriptTag({ content: fixture.script })
      await page.locator('[data-case]').last().waitFor()
      const measured = await page.evaluate(() => {
        const color = el => getComputedStyle(el).color
        return {
          body: color(document.querySelector('[data-body]')),
          tokens: Object.fromEntries([...document.querySelectorAll('[data-token]')].map(el => [el.dataset.token, color(el)])),
          selection: color(document.querySelector('[data-selection]')),
          rows: [...document.querySelectorAll('[data-case]')].map(el => ({ ...el.dataset, color: color(el.querySelector('button')), decoration: getComputedStyle(el.querySelector('button')).textDecorationLine })),
          link: color(document.querySelector('[data-link]')),
          icon: color(document.querySelector('[data-icon]')),
          dataName: color(document.querySelector('[data-real-data-name] button')),
        }
      })
      const { tokens } = measured
      assert.equal(measured.rows.length, 60)
      assert.notEqual(tokens['accent-deep'], measured.body, '操作を本文の色と区別する')
      for (const row of measured.rows) {
        let expected
        if (['disabled', 'aria', 'locked'].includes(row.state)) expected = tokens['ink-secondary']
        else if (row.state === 'selected') expected = measured.selection
        else if (row.state === 'filter') expected = row.size === 'inline' && ['danger', 'accent'].includes(row.tone) ? tokens[row.tone === 'danger' ? 'danger' : 'accent-deep'] : tokens.ink
        else if (['default', 'accent'].includes(row.tone)) expected = tokens['accent-deep']
        else if (row.tone === 'danger') expected = tokens.danger
        else expected = tokens[row.size === 'inline' ? 'ink' : 'ink-secondary']
        assert.equal(row.color, expected, `${width}: ${row.case}`)
        assert.equal(row.decoration, 'none', `${row.case}: 平常時は下線なし`)
      }
      assert.equal(measured.link, tokens['accent-deep'])
      assert.notEqual(measured.icon, tokens['accent-deep'], '画像だけの操作を緑にしない')
      assert.equal(measured.dataName, tokens['ink-secondary'], '実際の担当未設定の予約名を緑にしない')
      const normal = page.locator('[data-case="standard-default-enabled"] button')
      await normal.hover()
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-case="standard-default-enabled"] button')).textDecorationLine === 'underline')
      await normal.click()
      assert.equal(await page.evaluate(() => window.fixtureClicks), 1)
      await page.locator('[data-body]').click()
      await page.keyboard.press('Tab')
      await page.waitForFunction(() => document.activeElement === document.querySelector('[data-case="standard-default-enabled"] button') && document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).textDecorationLine === 'underline')
      await page.keyboard.press('Tab')
      await page.keyboard.press('Tab')
      assert.equal(await page.locator('[data-case="standard-default-locked"] button').evaluate(el => el === document.activeElement), true)
      await page.getByRole('tooltip').filter({ hasText: '閲覧のみのため変更できません。' }).waitFor()
      await page.keyboard.press('Enter')
      assert.equal(await page.evaluate(() => window.fixtureClicks), 1, '権限のない操作は送らない')
      assert.equal(await page.locator('[data-case="standard-default-locked"] button').evaluate(el => getComputedStyle(el).textDecorationLine), 'none')
      await page.locator('[data-real-data-name] button').click()
      assert.equal(await page.evaluate(() => window.opened), 1, 'データ名の開く操作は保持する')
      for (const selector of ['[data-native-arrow]', '[data-native-inline]']) {
        assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).color), tokens.link, '文字リンクも共通の緑で操作を区別する')
      }
      await page.getByRole('button', { name: '顧客情報をすべて表示', exact: true }).click()
      const actualLink = page.getByRole('link', { name: '情報欄をすべて見る', exact: true })
      assert.equal(await actualLink.getAttribute('href'), '/friends/detail?id=friend-link&tab=info')
      assert.equal(await actualLink.evaluate(el => getComputedStyle(el).color), tokens.link, '実際の顧客欄の操作も本文の色に戻さない')
      await actualLink.hover()
      assert.equal(await actualLink.evaluate(el => getComputedStyle(el).textDecorationLine), 'underline')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    }
  } finally { await browser.close() }
})

for (const width of [1152, 1440]) {
  test(`重複候補の実表で名前と操作を残し、操作の折り返しの故障を検出する ${width}`, async () => {
    const browser = await connectGuardBrowser()
    const errors = []
    try {
      const fixtureBrowser = { newPage: async options => {
        const page = await browser.newPage(options)
        await stubApi(page, mockFetch)
        return page
      } }
      const page = await openPage(fixtureBrowser, { baseUrl: process.env.V8_GUARD_BASE ?? 'http://127.0.0.1:4310', route: '/duplicates', width, stable: true, requireSuccess: true, onPageError: error => errors.push(error.message) })
      const actions = page.getByRole('link', { name: '根拠を確認 →', exact: true })
      await actions.first().waitFor()
      const measure = () => page.evaluate(() => {
        const table = [...document.querySelectorAll('main table')].find(table => [...table.querySelectorAll('thead th')].some(th => th.textContent.trim() === '操作'))
        if (!table) return null
        return [...table.querySelectorAll('tbody tr')].map(row => {
          const cells = [...row.children], action = cells[5]?.querySelector('a')
          if (!action) return { cells: cells.length, action: null }
          const style = getComputedStyle(action), box = action.getBoundingClientRect()
          const textNodes = document.createTreeWalker(action, NodeFilter.SHOW_TEXT), tops = new Set()
          while (textNodes.nextNode()) {
            const range = document.createRange(); range.selectNodeContents(textNodes.currentNode)
            for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top * 10))
          }
          const token = document.createElement('span'); token.style.color = 'var(--color-link)'; document.body.append(token)
          const expectedColor = getComputedStyle(token).color; token.remove()
          return { cells: cells.length, names: [...cells[0].querySelectorAll('a')].map(link => link.textContent.trim()), action: { text: action.textContent.trim(), href: action.getAttribute('href'), inline: action.hasAttribute('data-inline'), whiteSpace: style.whiteSpace, color: style.color, expectedColor, height: box.height, lines: tops.size, right: box.right, cellRight: cells[5].getBoundingClientRect().right } }
        })
      })
      const valid = rows => Array.isArray(rows) && rows.length > 0 && rows.every(row => row.cells === 6 && row.names.length === 2 && row.names.every(Boolean) && row.action?.text === '根拠を確認 →' && row.action.href?.startsWith('/friends/identity-candidates?id=') && row.action.inline && row.action.whiteSpace === 'nowrap' && row.action.color === row.action.expectedColor && row.action.height > 0 && row.action.lines === 1 && row.action.right <= row.action.cellRight + 1)
      await page.waitForFunction(() => !document.querySelector('[data-kpi-rolling]'))
      const normal = await measure()
      assert.ok(valid(normal), `実表の全行に名前と1行の共通の操作がある: ${JSON.stringify(normal)}`)
      assert.deepEqual(errors, [])
      const first = actions.first()
      await first.evaluate(element => element.removeAttribute('data-inline'))
      assert.equal(valid(await measure()), false, '共通の文中リンクの指定を落とすと赤になる')
      await first.evaluate(element => element.setAttribute('data-inline', 'true'))
      assert.deepEqual(await measure(), normal, '共通の文中リンクの指定を戻すと元の表示へ戻る')
      await first.evaluate(element => element.style.whiteSpace = 'normal')
      assert.equal(valid(await measure()), false, '折り返さない指定を壊すと赤になる')
      await first.evaluate(element => element.style.removeProperty('white-space'))
      assert.deepEqual(await measure(), normal, '折り返しを復元すると元の表示へ戻る')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    } finally { await browser.close() }
  })
}

for (const width of [1152, 1440]) {
  test(`経路分析の短い操作名は1行で省略し、全文と行き先を保つ ${width}`, async () => {
    const browser = await connectGuardBrowser()
    const errors = []
    try {
      const fixtureBrowser = { newPage: async options => {
        const page = await browser.newPage(options)
        await stubApi(page, mockFetch)
        return page
      } }
      const page = await openPage(fixtureBrowser, { baseUrl: process.env.V8_GUARD_BASE ?? 'http://127.0.0.1:4310', route: '/analytics?tab=routes', width, stable: true, requireSuccess: true, onPageError: error => errors.push(error.message) })
      const link = page.getByRole('link', { name: 'Search Console を見る', exact: true })
      await link.waitFor()
      const measured = await link.evaluate(element => {
        const label = element.firstElementChild, style = getComputedStyle(label), box = element.getBoundingClientRect(), parent = element.parentElement.getBoundingClientRect()
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT), tops = new Set()
        while (walker.nextNode()) {
          const range = document.createRange(); range.selectNodeContents(walker.currentNode)
          for (const rect of range.getClientRects()) if (rect.width > 0) tops.add(Math.round(rect.top * 10))
        }
        const token = document.createElement('span'); token.style.color = 'var(--color-link)'; document.body.append(token)
        const expectedColor = getComputedStyle(token).color; token.remove()
        return { viewport: innerWidth, lines: tops.size, whiteSpace: style.whiteSpace, overflow: style.overflow, ellipsis: style.textOverflow, title: element.title, href: element.getAttribute('href'), color: getComputedStyle(element).color, expectedColor, visible: box.width > 0 && box.height > 0, right: box.right, parentRight: parent.right, pageOverflow: document.documentElement.scrollWidth > innerWidth }
      })
      assert.equal(measured.viewport, width)
      assert.equal(measured.lines, 1, '短い操作名を2行に折らない')
      assert.equal(measured.whiteSpace, 'nowrap')
      assert.equal(measured.overflow, 'hidden')
      assert.equal(measured.ellipsis, 'ellipsis')
      assert.equal(measured.title, 'Search Console を見る', '省略時にも全文が読める')
      assert.equal(measured.href, 'https://search.google.com/search-console', '分析の既存の行き先を保つ')
      assert.equal(measured.color, measured.expectedColor)
      assert.ok(measured.visible && measured.right <= measured.parentRight + 0.5 && measured.right <= width + 0.5, JSON.stringify(measured))
      assert.equal(measured.pageOverflow, false)
      assert.deepEqual(errors, [])
    } finally { await browser.close() }
  })
}

for (const width of [1152, 1440]) for (const role of ['owner', 'viewer']) {
  test(`友だちの要点の行は共通の緑か、理由つきの灰色になる ${width} ${role}`, async () => {
    const browser = await connectGuardBrowser()
    const writes = [], errors = []
    try {
      const fixtureBrowser = { newPage: async options => {
        const page = await browser.newPage(options)
        await stubApi(page, async (method, path) => {
          if (!['GET', 'HEAD'].includes(method)) writes.push({ method, path })
          const response = await mockFetch(method, path)
          if (['/api/staff/me', '/api/auth/session'].includes(path.split('?')[0])) {
            const body = JSON.parse(response.body)
            body.data = { ...body.data, role, readOnly: role === 'viewer', roleBundle: role === 'viewer' ? 'view_only' : 'admin', permissionKeys: [] }
            return { ...response, body: JSON.stringify(body) }
          }
          return response
        })
        return page
      } }
      const page = await openPage(fixtureBrowser, { baseUrl: process.env.V8_GUARD_BASE ?? 'http://127.0.0.1:4310', route: '/friends/detail?id=friend-1', width, height: 1100, stable: true, requireSuccess: true, onPageError: error => errors.push(error.message) })
      await page.waitForFunction(role => localStorage.getItem('lh_staff_role') === role, role)
      if (await page.locator('[data-customer-rail][data-collapsed]').count()) await page.getByRole('button', { name: '顧客情報', exact: true }).click()
      const rich = page.locator('[data-friend-profile-panel] section[aria-label="リッチメニュー"]')
      const action = rich.getByRole(role === 'owner' ? 'link' : 'button', { name: '変更する', exact: true })
      await action.waitFor()
      assert.equal(await action.getAttribute('data-variant'), 'text')
      const color = await action.evaluate(el => {
        const probe = document.createElement('span')
        probe.style.color = `var(${el.getAttribute('aria-disabled') === 'true' ? '--color-ink-secondary' : '--color-accent-deep'})`
        document.body.append(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return { actual: getComputedStyle(el).color, expected }
      })
      assert.equal(color.actual, color.expected)
      if (role === 'owner') {
        assert.equal(await action.getAttribute('href'), '/rich-menus')
        const delivery = page.locator('[data-friend-profile-panel] section[aria-label="配信の受け取り"]').getByRole('button', { name: '変更する', exact: true })
        assert.equal(await delivery.getAttribute('data-variant'), 'text')
        assert.equal(await delivery.evaluate(el => getComputedStyle(el).color), color.expected)
      } else {
        assert.equal(await action.getAttribute('aria-disabled'), 'true')
        assert.equal(await action.getAttribute('href'), null)
        await action.hover()
        await page.getByRole('tooltip').filter({ hasText: '閲覧のみ' }).waitFor()
        const before = await page.evaluate(() => location.href)
        await action.evaluate(el => el.focus())
        await page.keyboard.press('Enter')
        assert.equal(await page.evaluate(() => location.href), before)
        assert.equal(writes.length, 0, '変更できない人の操作で更新しない')
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
    } finally { await browser.close() }
  })
}
