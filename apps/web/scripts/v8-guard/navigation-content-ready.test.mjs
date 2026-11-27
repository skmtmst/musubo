import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connectGuardBrowser } from './browser-session.mjs'
import { trackPendingApiRequests, waitForNavigationContent } from './navigation-content-ready.mjs'

async function scenario(run, { trackAfterLoad = false } = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/next' }); res.end()
    } else if (req.url === '/current') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<main>新しい画面</main><script>fetch("/api/current").catch(()=>{})</script>')
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<main>本文</main><a href="/next">次の画面</a>')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await connectGuardBrowser()
  let release = () => {}, signalRoute
  const routeStarted = new Promise(resolve => { signalRoute = resolve })
  try {
    const page = await browser.newPage()
    if (trackAfterLoad) await page.goto(base + '/start')
    const pending = trackPendingApiRequests(page)
    await page.route('**/api/**', async route => {
      await new Promise(resolve => { release = resolve; signalRoute() })
      try { await route.fulfill({ status: 200, body: '{}' }) } catch { /* 文書が破棄された場合 */ }
    })
    if (!trackAfterLoad) await page.goto(base + '/start')
    await run({ page, pending, base, release: () => release(), routeStarted })
  } finally {
    release()
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}

async function startRequest(page, path) {
  const request = page.waitForRequest(url => new URL(url.url()).pathname === path)
  await page.evaluate(path => { void fetch(path).catch(() => {}) }, path)
  return request
}
async function mustStillWait(page, pending) {
  await assert.rejects(waitForNavigationContent(page, pending, 700), /本文の準備が終わりません/)
}
function unresolvedOldRequest(page) {
  // 破棄時に requestfinished/requestfailed が届かなかった既知の状態を固定する。
  const request = { url: () => 'http://127.0.0.1/api/old', isNavigationRequest: () => false }
  page.emit('request', request)
  return request
}

test('現在の文書の未完了APIは本文の準備待ちを失敗させる', async () => scenario(async ({ page, pending, release, routeStarted }) => {
  await startRequest(page, '/api/hold')
  await routeStarted
  await mustStillWait(page, pending)
  release()
  await waitForNavigationContent(page, pending, 5000)
}))

test('同一文書の pushState と hash 遷移では未完了APIを待ち続ける', async () => scenario(async ({ page, pending, base, release, routeStarted }) => {
  await startRequest(page, '/api/hold')
  await routeStarted
  await page.evaluate(() => history.pushState({}, '', '/same-document'))
  await mustStillWait(page, pending)
  await page.goto(base + '/same-document#section')
  await mustStillWait(page, pending)
  release()
  await waitForNavigationContent(page, pending, 5000)
}))

test('前の文書だけの終了通知が欠けたAPIは診断へ分け、新文書の準備を通す', async () => scenario(async ({ page, pending, base }) => {
  const old = unresolvedOldRequest(page)
  assert.ok(pending.has(old))
  await page.goto(base + '/next')
  await waitForNavigationContent(page, pending, 1500)
  assert.equal(pending.has(old), false)
  assert.ok(pending.orphans.some(entry => entry.path === '/api/old'))
}))

test('読み込み済みの文書で追跡を始めても前の文書の要求を分ける', async () => scenario(async ({ page, pending, base }) => {
  const old = unresolvedOldRequest(page)
  await page.goto(base + '/next')
  await waitForNavigationContent(page, pending, 1500)
  assert.equal(pending.has(old), false)
  assert.ok(pending.orphans.some(entry => entry.path === '/api/old'))
}, { trackAfterLoad: true }))

test('文書移動後に始まったAPIを前の文書の要求と一緒に消さない', async () => scenario(async ({ page, pending, base, release, routeStarted }) => {
  unresolvedOldRequest(page)
  const request = page.waitForRequest(url => new URL(url.url()).pathname === '/api/current')
  await page.goto(base + '/current', { waitUntil: 'domcontentloaded' })
  await request
  await routeStarted
  await mustStillWait(page, pending)
  assert.ok([...pending].some(item => new URL(item.url()).pathname === '/api/current'))
  release()
  await waitForNavigationContent(page, pending, 5000)
}))

test('中止された文書移動では元の文書の未完了APIを消さない', async () => scenario(async ({ page, pending, base }) => {
  const old = unresolvedOldRequest(page)
  await page.route('**/abort', route => route.abort())
  await assert.rejects(page.goto(base + '/abort'))
  assert.ok(pending.has(old))
}))

test('文書移動の開始後、応答前に前画面から始まったAPIも診断へ分ける', async () => scenario(async ({ page, pending, base }) => {
  let finishNavigation, intercepted
  const routed = new Promise(resolve => { intercepted = resolve })
  await page.route('**/slow-document', async route => {
    await new Promise(resolve => { finishNavigation = resolve; intercepted() })
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>新しい画面</main>' })
  })
  const request = page.waitForRequest(req => new URL(req.url()).pathname === '/slow-document')
  const navigation = page.goto(base + '/slow-document')
  await request
  await routed
  const old = unresolvedOldRequest(page)
  finishNavigation()
  await navigation
  assert.equal(pending.has(old), false)
  assert.ok(pending.orphans.some(entry => entry.path === '/api/old'))
  await waitForNavigationContent(page, pending, 1500)
}))

test('新文書の応答後から文書確定までのAPIは安全側で待つ', async () => scenario(async ({ page, pending, base }) => {
  const old = unresolvedOldRequest(page)
  const current = { url: () => 'http://127.0.0.1/api/ambiguous', isNavigationRequest: () => false }
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/next') page.emit('request', current)
  })
  await page.goto(base + '/next')
  assert.equal(pending.has(old), false)
  assert.equal(pending.has(current), true)
  await mustStillWait(page, pending)
}))

test('通常のリンクで文書が変わった場合も前の要求を診断へ分ける', async () => scenario(async ({ page, pending }) => {
  const old = unresolvedOldRequest(page)
  await page.getByRole('link', { name: '次の画面' }).click()
  await waitForNavigationContent(page, pending, 1500)
  assert.equal(pending.has(old), false)
  assert.ok(pending.orphans.some(entry => entry.path === '/api/old'))
}))

test('別の移動の応答待ち中に同じURLへ pushState しても、同一文書の要求を消さない', async () => scenario(async ({ page, pending, base }) => {
  const old = unresolvedOldRequest(page)
  // 文書移動の応答と同一文書内のURL変更が前後する競合を再現する。
  const navigation = { url: () => base + '/same-document-race', isNavigationRequest: () => true, frame: () => page.mainFrame(), redirectedFrom: () => null }
  page.emit('request', navigation)
  page.emit('response', { request: () => navigation, status: () => 200, url: () => base + '/same-document-race' })
  await page.evaluate(() => history.pushState({}, '', '/same-document-race'))
  assert.equal(pending.has(old), true)
  await mustStillWait(page, pending)
}))


test('新文書の直後に replaceState しても前文書の要求を分ける', async () => scenario(async ({ page, pending, base }) => {
  const old = unresolvedOldRequest(page)
  const frame = page.mainFrame(), evaluate = frame.evaluate.bind(frame)
  let release, started, first = true
  const paused = new Promise(resolve => { started = resolve })
  frame.evaluate = async (...args) => {
    if (first && String(args[0]).includes('performance.timeOrigin')) {
      first = false
      started()
      await new Promise(resolve => { release = resolve })
    }
    return evaluate(...args)
  }
  const moving = page.goto(base + '/next')
  await paused
  await page.evaluate(() => history.replaceState({}, '', '/replaced'))
  await new Promise(resolve => setTimeout(resolve, 50))
  release()
  await moving
  assert.equal(pending.has(old), false)
  await waitForNavigationContent(page, pending, 1500)
}))

test('前文書の時刻照会が遅れても同じ文書の要求を消さない', async () => scenario(async ({ page, pending, base }) => {
  const frame = page.mainFrame(), evaluate = frame.evaluate.bind(frame)
  let release, started, first = true
  const paused = new Promise(resolve => { started = resolve })
  frame.evaluate = async (...args) => {
    if (first && String(args[0]).includes('performance.timeOrigin')) {
      first = false
      started()
      await new Promise(resolve => { release = resolve })
    }
    return evaluate(...args)
  }
  const moving = page.goto(base + '/next')
  await paused
  const current = unresolvedOldRequest(page)
  const navigation = { url: () => base + '/same-race', isNavigationRequest: () => true, frame: () => frame, redirectedFrom: () => null }
  page.emit('request', navigation)
  page.emit('response', { request: () => navigation, status: () => 200, url: () => base + '/same-race' })
  await page.evaluate(() => history.pushState({}, '', '/same-race'))
  release()
  await moving
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(pending.has(current))
  await mustStillWait(page, pending)
}))

test('文書識別が時間切れなら遅れて返った結果で要求を消さない', async () => scenario(async ({ page, pending, base }) => {
  const old = unresolvedOldRequest(page)
  const frame = page.mainFrame(), evaluate = frame.evaluate.bind(frame)
  let release, started
  const paused = new Promise(resolve => { started = resolve })
  frame.evaluate = async (...args) => {
    if (String(args[0]).includes('performance.timeOrigin')) {
      started()
      await new Promise(resolve => { release = resolve })
    }
    return evaluate(...args)
  }
  const moving = page.goto(base + '/next')
  await paused
  await moving
  assert.ok(pending.has(old))
  release()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(pending.has(old))
  await mustStillWait(page, pending)
}))

test('リダイレクトを伴う文書移動でも前の要求を診断へ分ける', async () => scenario(async ({ page, pending, base }) => {
  const old = unresolvedOldRequest(page)
  await page.goto(base + '/redirect')
  await waitForNavigationContent(page, pending, 1500)
  assert.equal(pending.has(old), false)
  assert.ok(pending.orphans.some(entry => entry.path === '/api/old'))
}))

test('再読込で文書が変わった場合も前の要求を診断へ分ける', async () => scenario(async ({ page, pending }) => {
  const old = unresolvedOldRequest(page)
  await page.reload()
  await waitForNavigationContent(page, pending, 1500)
  assert.equal(pending.has(old), false)
  assert.ok(pending.orphans.some(entry => entry.path === '/api/old'))
}))


test('本物の遅いAPIが旧文書で中断されても新しい文書の準備を待てる', async () => scenario(async ({ page, pending, base, release, routeStarted }) => {
  await startRequest(page, '/api/hold')
  await routeStarted
  await page.goto(base + '/next')
  release()
  await waitForNavigationContent(page, pending, 1500)
  assert.equal(pending.size, 0)
}))
