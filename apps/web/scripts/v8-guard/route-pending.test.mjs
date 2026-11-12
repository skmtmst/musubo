import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { connectGuardBrowser } from './browser-session.mjs'
import { mockFetch } from './mock-local.mjs'
import { stubApi } from './speed-budget.mjs'
import { trackPendingApiRequests, waitForNavigationContent } from './navigation-content-ready.mjs'
import { PARITY_INIT } from '../../../../scripts/visual-qa/v8-parity.mjs'
import { styleDashboardMock } from '../../../../scripts/visual-qa/style-dashboard-mock.mjs'

const source = ts.transpileModule(readFileSync(new URL('../../src/lib/route-pending.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { ROUTE_PENDING_LAYOUTS } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const paths = process.env.ROUTE_PENDING_PATHS?.split(',')
const recipes = Object.entries(ROUTE_PENDING_LAYOUTS).filter(([path]) => path !== '/booking/staff/shifts' && (!paths || paths.includes(path))).map(([path, value]) => ({ path, ...value }))
if (!paths) recipes.push(
  { path: '/password/reset?token=guard', title: '新しいパスワードを設定', publicAuth: true },
  { path: '/register/complete?token=guard', title: '本登録', finalTitle: '利用開始の設定', publicAuth: true },
  { path: '/booking/staff/shifts', title: '勤務を開いています', destination: '/booking/menus', finalTitle: '予約設定' },
)
assert.ok(recipes.length > 0, '題を確かめる入口がある')
const base = process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310'
const output = join(process.env.V8_GUARD_ARTIFACT_DIR || '/tmp/v8-guard', 'route-pending')
const fault = process.env.V8_GUARD_ROUTE_PENDING_FAULT === '1', results = []
mkdirSync(output, { recursive: true })
after(() => { styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style: 'standard' }); writeFileSync(join(output, 'summary.json'), JSON.stringify(results, null, 2)) })

for (const width of [1152, 1440]) test(`route pending and fixed headings ${width}`, async () => {
  const browser = await connectGuardBrowser(), context = await browser.newContext({ viewport: { width, height: 1080 }, locale: 'ja-JP' }), page = await context.newPage()
  const pending = trackPendingApiRequests(page), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, PARITY_INIT)
  await page.addInitScript(broken => {
    window.routePendingFrames = []
    const record = () => {
      if (broken && document.head && !document.querySelector('[data-route-pending-fault]')) { const style = document.createElement('style'); style.dataset.routePendingFault = ''; style.textContent = '[data-page-template]:has([data-page-pending]) h1 { visibility:hidden!important }'; document.head.append(style) }
      const scope = document.querySelector('[data-auth-pending]') ?? document.querySelector('main') ?? document.body
      const headings = [...(scope?.querySelectorAll('h1') ?? [])].filter(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden').map(node => node.textContent.trim())
      const authPending = scope?.hasAttribute('data-auth-pending')
      window.routePendingFrames.push({ t: performance.now(), path: location.pathname, stage: authPending ? 'auth' : scope?.querySelector('[data-page-pending]')?.getAttribute('data-page-pending') ?? null, headings, hasSidebar: authPending ? Boolean(document.querySelector('aside, [data-sidebar]')) : null })
      requestAnimationFrame(record)
    }
    requestAnimationFrame(record)
  }, fault)
  await stubApi(page, async (method, path) => {
    await new Promise(done => setTimeout(done, 600))
    const pathname = new URL(path, base).pathname
    if (pathname === '/api/auth/password/reset/check' || pathname === '/api/auth/register/check') return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ success: true, data: { email: 'guard@example.test', companyName: '確認用の会社', contactName: '確認用の担当者', trialDays: 30 } }) }
    const response = await mockFetch(method, path)
    if (pathname === '/api/staff/me') { const body = JSON.parse(response.body); body.data.accountScope = 'all'; response.body = JSON.stringify(body) }
    if (pathname === '/api/dashboard/style') { const body = JSON.parse(response.body); body.data.styleSelected = true; body.data.styleMode = 'configured'; response.body = JSON.stringify(body) }
    return response
  })
  try {
    for (const [index, recipe] of recipes.entries()) {
      styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style: recipe.path === '/restaurant-test/dashboard' ? 'restaurant' : 'standard' })
      const row = { width, ...recipe, fault, errors: [], failure: null }, dir = join(output, `${width}-${index}`)
      mkdirSync(dir, { recursive: true }); results.push(row)
      const errorStart = errors.length
      try {
        assert.ok((await page.goto(base + recipe.path, { waitUntil: 'domcontentloaded' }))?.ok())
        await page.waitForTimeout(150)
        await page.screenshot({ animations: 'disabled', path: join(dir, 'pending.png') })
        await waitForNavigationContent(page, pending, 15000)
        const headings = await page.locator('main h1:visible, [data-auth-card] h1:visible').allTextContents()
        const actual = headings.length ? headings.map(value => value.trim()) : await page.getByRole('heading', { level: 1 }).allTextContents()
        if (recipe.fixedTitle || recipe.publicAuth || recipe.finalTitle) assert.deepEqual(actual, [recipe.finalTitle ?? recipe.title], '到着後の題も同じ画面の名前')
        row.finalHeadings = actual
        assert.equal(new URL(page.url()).pathname, recipe.destination ?? new URL(recipe.path, base).pathname)
        const frames = await page.evaluate(() => window.routePendingFrames)
        if (!recipe.publicAuth) {
          const authFrames = frames.filter(frame => frame.stage === 'auth')
          assert.ok(authFrames.length > 0, '認証前の待機を観察した')
          for (const frame of authFrames) {
            assert.deepEqual(frame.headings, [], '認証中に通常画面の題を出さない')
            assert.equal(frame.hasSidebar, false, '認証中に通常サイドバーを出さない')
          }
          for (const frame of frames.filter(frame => frame.stage !== null && frame.stage !== 'auth')) {
            const expected = ROUTE_PENDING_LAYOUTS[frame.path]?.title
            assert.ok(expected, `待機中の道の題を定義した: ${frame.path}`)
            assert.deepEqual(frame.headings, [expected], `全ての待機段で題が欠けない: ${frame.path} ${frame.stage}`)
          }
        }
        row.frames = frames.length
        writeFileSync(join(dir, 'frames.json'), JSON.stringify(frames))
        await page.screenshot({ animations: 'disabled', path: join(dir, 'ready.png') })
        row.errors = errors.slice(errorStart); assert.deepEqual(row.errors, [])
      } catch (error) {
        row.failure = error.stack ?? String(error); row.errors = errors.slice(errorStart)
        writeFileSync(join(dir, 'frames.json'), JSON.stringify(await page.evaluate(() => window.routePendingFrames ?? [])))
        await page.screenshot({ animations: 'disabled', path: join(dir, 'failure.png') }); throw error
      }
    }
  } finally { await context.close(); await browser.close() }
})
