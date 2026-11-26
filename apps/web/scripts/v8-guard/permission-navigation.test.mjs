import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectGuardBrowser } from './browser-session.mjs'
import { mockFetch } from './mock-local.mjs'
import { stubApi } from './speed-budget.mjs'
import { styleDashboardMock } from '../../../../scripts/visual-qa/style-dashboard-mock.mjs'
import { PARITY_INIT } from '../../../../scripts/visual-qa/v8-parity.mjs'
import { observePermissionFrames, assertNoPermissionFlash } from './permission-flash-browser.mjs'
import { trackPendingApiRequests, waitForNavigationContent } from './navigation-content-ready.mjs'

const require = createRequire(import.meta.url)
const { build } = createRequire(createRequire(require.resolve('vitest/package.json')).resolve('vite'))('esbuild')
const webRoot = fileURLToPath(new URL('../..', import.meta.url))
const menuBundle = await build({ stdin: { resolveDir: webRoot, contents: `
  import {MENU_SECTIONS,HQ_MENU_SECTIONS} from './src/lib/menu';
  export default [...MENU_SECTIONS,...HQ_MENU_SECTIONS].flatMap(section=>section.items.map(item=>item.href));
` }, bundle: true, write: false, platform: 'node', format: 'esm' })
const menuRoutes = (await import(`data:text/javascript;base64,${Buffer.from(menuBundle.outputFiles[0].text).toString('base64')}`)).default
const routes = [...new Set([...menuRoutes, '/settings', '/getting-started', '/ec-commerce', '/accounts/new', '/common-actions/new', '/automations/new', '/booking/staff/new'])]
const base = process.env.V8_GUARD_BASE ?? 'http://127.0.0.1:4310'
const output = process.env.V8_GUARD_ARTIFACT_DIR

for (const width of [1152, 1440]) for (const delay of [0, 600]) {
  test(`全メニューの初回・画面間・タブ切替で権限の文を挟まない ${width} API+${delay}ms`, async () => {
    const browser = await connectGuardBrowser()
    const dir = output && join(output, `navigation-${width}-${delay}`)
    if (dir) mkdirSync(dir, { recursive: true })
    const context = await browser.newContext({ viewport: { width, height: 1080 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
      ...(dir && process.env.V8_GUARD_VIDEO === '1' ? { recordVideo: { dir: join(dir, 'video'), size: { width, height: 1080 } } } : {}) })
    const page = await context.newPage(), results = [], errors = [], runtimeReports = []
    const pendingApi = trackPendingApiRequests(page)
    const sidebar = page.locator('aside:has(nav[data-sidebar-scroll]):visible')
    let style = 'standard', failure = null
    const selectStyle = next => { style = next; styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style }) }
    selectStyle(style)
    page.on('pageerror', error => errors.push(error.message))
    if (process.env.V8_GUARD_PERMISSION_FAULT === '1') await page.route('**/_next/static/**/*.js', async route => {
      const response = await route.fetch()
      // 実際に配る共通の読み込み文へ故障を入れる。配信ファイルは書き換えない。
      await route.fulfill({ response, body: (await response.text()).replaceAll('読み込んでいます', '権限を確認しています') })
    })
    await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, PARITY_INIT)
    await page.addInitScript(observePermissionFrames)
    const answer = async (method, path) => {
      const url = new URL(path, base)
      if (url.pathname === '/api/client-errors' && method === 'POST') runtimeReports.push(url.pathname)
      if (delay) await new Promise(done => setTimeout(done, delay))
      const response = await mockFetch(method, url.pathname + url.search)
      let body = response.body
      if (url.pathname === '/api/staff/me') {
        const identity = JSON.parse(body)
        if (identity.success && identity.data) identity.data.accountScope = 'all'
        body = JSON.stringify(identity)
      }
      // 前回の調査で応答契約不足が判明した2経路。製品の失敗を隠さず、共有型どおりの空データを渡す。
      if (url.pathname === '/api/booking/admin/menus/photos') body = JSON.stringify({ success: true, data: { menus: [], staff: [], store: null } })
      if (url.pathname === '/api/operations/security-alerts') body = JSON.stringify({ success: true, data: {
        items: [], total: 0, offset: 0, limit: 200, windowMinutes: 5, thresholds: {}, configurationValid: true,
        monitor: { status: 'running', lastStartedAt: new Date().toISOString(), lastCompletedAt: new Date().toISOString(), configurationValid: true },
      } })
      return { ...response, body }
    }
    await stubApi(page, answer)
    async function observe(label, action, readyPath) {
      const id = String(results.length + 1).padStart(3, '0')
      await page.evaluate(() => window.permissionFrames?.reset()).catch(() => {})
      const start = Date.now(), errorStart = errors.length
      await action()
      if (readyPath) await page.waitForURL(url => url.pathname === new URL(readyPath, base).pathname)
      const shots = []
      for (const at of [100, 700]) {
        const left = at - (Date.now() - start)
        if (left > 0) await page.waitForTimeout(left)
        if (dir && (process.env.V8_GUARD_CAPTURE_FRAMES === 'all' || results.length < 3)) { const file = `${id}-${at}.png`; await page.screenshot({ path: join(dir, file) }); shots.push(file) }
      }
      // 遅延本人API・子のAPIが返った後も見る。採取を早く切り上げない。
      await page.waitForTimeout(delay + 500)
      // 題だけ先に出る画面もある。本文の文字と、見えている骨組みの終了まで採取する。
      let readinessError = null
      try {
        await waitForNavigationContent(page, pendingApi)
      } catch (error) {
        readinessError = error
        if (dir) {
          const file = `${id}-timeout.png`
          await page.screenshot({ path: join(dir, file) }).then(() => shots.push(file)).catch(() => {})
        }
      }
      const frames = await page.evaluate(() => window.permissionFrames.frames)
      const row = { id, label, url: page.url(), elapsed: Date.now() - start, frames, shots, errors: errors.slice(errorStart), readinessError: readinessError?.message ?? null }
      results.push(row)
      if (dir) writeFileSync(join(dir, `${id}.json`), JSON.stringify(row))
      assertNoPermissionFlash(frames)
      if (readinessError) throw readinessError
      assert.ok(await page.locator('main').innerText(), '到着先の本文が空ではない')
      assert.equal(await page.getByText('Application error:', { exact: false }).count(), 0)
      assert.equal(await page.getByRole('heading', { name: '画面を表示できませんでした', exact: true }).count(), 0)
    }
    const direct = path => observe(`初回 ${path}`, async () => {
      const response = await page.goto(base + path, { waitUntil: 'domcontentloaded' })
      assert.ok(response.ok(), `HTTP ${response.status()} ${path}`)
    })
    try {
      await direct('/templates')
      // 実際のSPAリンクを押す。リンクが無い場合は直接URLで代用しない。
      for (const path of ['/settings/customer-look']) {
        const link = page.locator(`a[href="${path}"]:visible`).first()
        await link.waitFor()
        await observe(`画面間 ${path}`, () => link.click(), path)
      }
      const visitedLinks = new Set()
      async function expandMenu() {
        const toggles = sidebar.locator('nav[data-sidebar-scroll] button[aria-expanded=false]:visible')
        for (let count = 0; count < 20 && await toggles.count(); count++) await toggles.first().click()
      }
      async function tabs(owner) {
        const items = await page.locator('main [role=tab]').evaluateAll(elements => elements
          .filter(element => element.getBoundingClientRect().height > 0 && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
          .map(element => {
            const group = element.closest('[role=tablist]')
            const allTabs = [...document.querySelectorAll('main [role=tab]')]
            return { label: element.textContent, id: element.id, href: element.getAttribute('href'), index: allTabs.indexOf(element), total: allTabs.length,
              group: group ? { index: [...document.querySelectorAll('main [role=tablist]')].indexOf(group), label: group.getAttribute('aria-label'),
                size: group.querySelectorAll('[role=tab]').length, indexInGroup: [...group.querySelectorAll('[role=tab]')].indexOf(element) } : null }
          }))
        for (const item of items) {
          let positional = page.locator('main [role=tab]').nth(item.index)
          // 件数が名前へ直接入る画面もある。位置の識別は、同じ名前・個数の段の中で行う。
          if (!item.id && !item.href) {
            if (item.group) {
              const group = page.locator('main [role=tablist]').nth(item.group.index)
              assert.equal(await group.getAttribute('aria-label'), item.group.label, '同じタブの段を押す')
              assert.equal(await group.locator('[role=tab]').count(), item.group.size, '段のタブが増減していない')
              positional = group.locator('[role=tab]').nth(item.group.indexInGroup)
            } else assert.equal(await page.locator('main [role=tab]').count(), item.total, '位置で指定するタブが増減していない')
          }
          const control = item.id ? page.locator(`[id=${JSON.stringify(item.id)}]`)
            : item.href ? page.locator(`main [role=tab][href=${JSON.stringify(item.href)}]`)
              : positional
          assert.equal(await control.count(), 1, `タブの指定 ${owner} ${item.label}`)
          if (!await control.isVisible()) continue
          const label = await control.textContent()
          const before = page.url()
          await observe(`タブ ${owner} ${label}`, () => control.click())
          const preparing = page.locator('[role="dialog"]:has([data-shared-part="preparing-dialog"]):visible')
          if (await preparing.count()) await observe(`案内を閉じる ${owner} ${label}`, () => preparing.getByRole('button', { name: '閉じる', exact: true }).click())
          if (new URL(page.url()).pathname !== new URL(before).pathname) {
            const declaredLink = item.href && page.url() === new URL(item.href, before).href
            const connectionSettings = new URL(before).pathname === '/chats' && ['Instagram', 'メール'].includes(label.trim()) && new URL(page.url()).pathname === '/settings/sns'
            assert.ok(declaredLink || connectionSettings, `予期しないタブの画面移動: ${before} ${label} → ${page.url()}`)
            await observe(`タブから戻る ${owner} ${label}`, () => declaredLink ? page.goto(before, { waitUntil: 'domcontentloaded' }) : page.goBack(), before)
            assert.equal(page.url(), before, '戻った後も元の画面と絞り込みを保つ')
          }
        }
      }
      for (const path of routes) {
        await expandMenu()
        const link = page.locator(`a[href=${JSON.stringify(path)}]:visible`).first()
        if (await link.count()) { await observe(`画面間 ${path}`, () => link.click()); visitedLinks.add(path) }
        else await direct(path)
        await tabs(path)
        // 一覧で実在する行の入口を読み、詳細・編集へ入り、戻る。IDを推測しない。
        const detail = page.locator('main tbody a[href^="/"],main [data-row-link][href^="/"]:visible').first()
        if (await detail.count() && await detail.isVisible()) {
          const href = await detail.getAttribute('href')
          await observe(`一覧から詳細 ${path} → ${href}`, () => detail.click())
          await observe(`詳細から戻る ${path}`, () => page.goBack())
        }
      }
      for (const next of ['standard', 'ec', 'restaurant', 'salon', 'consult', 'lesson']) {
        selectStyle(next)
        await direct('/')
        if (['restaurant', 'salon', 'consult', 'lesson'].includes(style)) await page.locator(`[data-design-node="style-${style}"]`).waitFor()
        else {
          await page.getByRole('heading', { name: 'ダッシュボード', exact: true }).first().waitFor()
          assert.equal(await page.locator('[data-style-dashboard]').count(), 0)
          if (style === 'ec') await page.getByRole('heading', { name: 'ECの状況', exact: true }).waitFor()
        }
        await tabs(`スタイル ${style}`)
        // EC専用の入口はECを選び済みのときだけ現れる。その条件で元の切り替えも見張る。
        if (style === 'ec') for (const path of ['/templates', '/settings/customer-look', '/ec-commerce']) {
          const link = page.locator(`a[href="${path}"]:visible`).first()
          await link.waitFor()
          await observe(`EC 画面間 ${path}`, () => link.click(), path)
        }
        await expandMenu()
        const links = await sidebar.locator('a[href^="/"]:visible').evaluateAll(elements => [...new Set(elements.map(element => element.getAttribute('href')))])
        assert.ok(links.includes('/') && links.includes('/templates'), `スタイル ${style} の管理メニューからホームとテンプレートを巡回できる`)
        // 各スタイルで少なくとも往復し、新しく出るメニューも全て巡回する。
        for (const path of links.filter(path => !visitedLinks.has(path) || path === '/templates' || path === '/')) {
          await expandMenu()
          const link = sidebar.locator(`a[href=${JSON.stringify(path)}]:visible`).first()
          if (!await link.count()) continue
          await observe(`スタイル ${style} 画面間 ${path}`, () => link.click())
          visitedLinks.add(path)
        }
      }
      assert.deepEqual(errors, [], '実画面の未処理エラーを合格扱いしない')
      assert.deepEqual(runtimeReports, [], 'エラー境界で捕まえた失敗も合格扱いしない')
    } catch (error) {
      failure = error.stack ?? String(error)
      throw error
    } finally {
      if (dir) writeFileSync(join(dir, 'summary.json'), JSON.stringify({ observation: 'content-and-api-ready', width, delay, routes, results: results.map(({ frames, ...row }) => ({ ...row, frameCount: frames.length, failures: frames.filter(frame => frame.messages.length) })), errors, runtimeReports, failure }, null, 2))
      selectStyle('standard')
      try {
        await context.close()
        if (dir && process.env.V8_GUARD_VIDEO === '1') {
          const file = join(dir, 'video', 'navigation.webm')
          await page.video().saveAs(file)
          assert.ok(statSync(file).size > 0, '動画を実ファイルへ保存した')
        }
      } finally { await browser.close() }
    }
  })
}
