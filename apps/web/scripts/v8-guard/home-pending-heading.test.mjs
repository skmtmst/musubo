import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectGuardBrowser } from './browser-session.mjs'
import { mockFetch } from './mock-local.mjs'
import { stubApi } from './speed-budget.mjs'
import { trackPendingApiRequests, waitForNavigationContent } from './navigation-content-ready.mjs'
import { PARITY_INIT } from '../../../../scripts/visual-qa/v8-parity.mjs'
import { styleDashboardMock } from '../../../../scripts/visual-qa/style-dashboard-mock.mjs'

const base = process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310'
const output = process.env.V8_GUARD_ARTIFACT_DIR || '/tmp/v8-guard/home-pending-heading'
const styles = process.env.HOME_STYLES?.split(',') ?? ['standard', 'ec', 'restaurant', 'salon', 'consult', 'lesson']
const widths = process.env.HOME_WIDTHS?.split(',').map(Number) ?? [1152, 1440]
const delays = process.env.HOME_DELAYS?.split(',').map(Number) ?? [0, 600]
const fault = process.env.V8_GUARD_HOME_HEADING_FAULT === '1'
const rows = []
mkdirSync(output, { recursive: true })
after(() => writeFileSync(join(output, 'summary.json'), JSON.stringify(rows, null, 2)))

for (const width of widths) for (const delay of delays) for (const style of styles) test(`${style} ${width} ${delay}`, async () => {
  styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style })
  const browser = await connectGuardBrowser()
  const dir = join(output, `${style}-${width}-${delay}`)
  mkdirSync(dir, { recursive: true })
  const video = process.env.V8_GUARD_VIDEO === '1'
  const context = await browser.newContext({ viewport: { width, height: 1080 }, locale: 'ja-JP', ...(video ? { recordVideo: { dir: join(dir, 'video'), size: { width, height: 1080 } } } : {}) })
  const page = await context.newPage(), pending = trackPendingApiRequests(page), errors = []
  let failure = null
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value) }, PARITY_INIT)
  await page.addInitScript(injectFault => {
    window.homeHeadingFrames = []
    let styledFrameSeen = false
    const record = () => {
      const authPending = document.querySelector('[data-auth-pending]')
      if (authPending) {
        window.homeHeadingFrames.push({ t: performance.now(), hasFrame: false, stage: 'auth', headings: [], x: null, y: null, height: null, hasSidebar: Boolean(document.querySelector('aside, [data-sidebar]')) })
        requestAnimationFrame(record)
        return
      }
      const scope = document.querySelector('main')
      const frame = scope?.querySelector('[data-page-template]')
      if (injectFault && document.head && !document.querySelector('[data-home-heading-fault]')) { const style = document.createElement('style'); style.setAttribute('data-home-heading-fault', ''); style.textContent = '[data-page-template]:has([data-page-pending]) h1 { visibility: hidden !important; }'; document.head.append(style) }
      // 外側の板とCSSが届いてから、認証前も含めて毎フレーム記録する。
      styledFrameSeen ||= Boolean(frame && getComputedStyle(frame).display === 'flex')
      if (styledFrameSeen) {
        const headings = [...(scope?.querySelectorAll('h1') ?? [])].filter(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden')
        const r = headings[0]?.getBoundingClientRect()
        if (!headings.length && !window.homeHeadingMissing) window.homeHeadingMissing = { scope: scope?.outerHTML.slice(0, 20000), headings: [...document.querySelectorAll('h1')].map(node => { const ancestors = []; for (let parent = node; parent; parent = parent.parentElement) ancestors.push({ tag: parent.tagName, class: parent.className, style: parent.getAttribute('style'), display: getComputedStyle(parent).display, width: parent.getBoundingClientRect().width }); return { text: node.textContent, ancestors } }) }
        window.homeHeadingFrames.push({ t: performance.now(), hasFrame: Boolean(frame), stage: scope ? scope.querySelector('[data-page-pending]')?.getAttribute('data-page-pending') ?? 'ready' : 'none', headings: headings.map(node => node.textContent.trim()), x: r?.x ?? null, y: r?.y ?? null, height: r?.height ?? null })
      }
      requestAnimationFrame(record)
    }
    requestAnimationFrame(record)
  }, fault)
  await stubApi(page, async (method, path) => {
    if (new URL(path, base).pathname.startsWith('/api/')) await new Promise(done => setTimeout(done, delay))
    const response = await mockFetch(method, path)
    if (method === 'GET' && new URL(path, base).pathname === '/api/dashboard/style') {
      const body = JSON.parse(response.body)
      body.data.styleSelected = true; body.data.styleMode = 'configured'
      response.body = JSON.stringify(body)
    }
    return response
  })
  try {
    assert.ok((await page.goto(base + '/', { waitUntil: 'domcontentloaded' }))?.ok())
    await page.waitForTimeout(100)
    await page.screenshot({ path: join(dir, 'pending.png') })
    await waitForNavigationContent(page, pending, 15000)
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(dir, 'ready.png') })
    const frames = await page.evaluate(() => window.homeHeadingFrames)
    assert.ok(frames.length > 2, '切り替え途中のフレームを記録した')
    assert.ok(frames.some(frame => frame.stage === 'ready'), '実画面まで到着した')
    if (delay) assert.ok(frames.some(frame => frame.stage === 'auth'), '認証前の待機も観察した')
    for (const frame of frames.filter(frame => frame.stage === 'auth')) {
      assert.deepEqual(frame.headings, [], '認証中に通常画面の見出しを出さない')
      assert.equal(frame.hasSidebar, false, '認証中に通常サイドバーを出さない')
    }
    const pageFrames = frames.filter(frame => frame.stage !== 'auth')
    for (const frame of pageFrames) {
      assert.ok(frame.hasFrame, `待機の型が消えた: ${JSON.stringify(frame)}`)
      assert.deepEqual(frame.headings, ['ダッシュボード'], `見出しが途中から現れた: ${JSON.stringify(frame)}`)
    }
    for (const axis of ['x', 'y', 'height']) assert.ok(Math.max(...pageFrames.map(frame => frame[axis])) - Math.min(...pageFrames.map(frame => frame[axis])) <= 8, `見出しの${axis}が動いた`)
    assert.equal(new URL(page.url()).pathname, '/')
    assert.deepEqual(errors, [])
  } catch (error) { failure = error.stack ?? String(error); throw error }
  finally {
    const frames = await page.evaluate(() => window.homeHeadingFrames ?? []).catch(() => [])
    const row = { width, delay, style, fault, frames: frames.length, stages: [...new Set(frames.map(frame => frame.stage))], errors, failure }
    rows.push(row)
    writeFileSync(join(dir, 'frames.json'), JSON.stringify({ ...row, samples: frames }))
    writeFileSync(join(dir, 'missing-heading.json'), JSON.stringify(await page.evaluate(() => window.homeHeadingMissing ?? null)))
    try {
      await context.close()
      if (video) { const file = join(dir, 'navigation.webm'); await page.video().saveAs(file); assert.ok(statSync(file).size > 0) }
    } finally { await browser.close() }
  }
})
