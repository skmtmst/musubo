/*
 * QRダイアログの生成・ダウンロードを実ブラウザで確かめる（#689）。
 *
 * `/api/qr` は Worker 本体の受け口関数（`normalizeQrSize` / `normalizeQrFormat` /
 * `isQrDataAllowed` / `qrResponseHeaders`）をそのまま読み込んで組み立てる。
 * 画面側で同じ数字を書き写して確かめると、Worker が上限を変えたときに気づけない。
 *
 * 画像そのものは Worker と同じ上流（api.qrserver.com）から取る。作り物の画像を
 * 返すと、選んだ形式で本当に保存できるのかが確かめられない。
 *
 * 実行（Node 22.18 以上。Worker の .ts をそのまま読むため）:
 *   NEXT_PUBLIC_API_URL=http://127.0.0.1:3158 pnpm --filter web build
 *   node --import tsx apps/web/src/components/dashboard/qr-browser-behavior.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from '@playwright/test'
import {
  isQrDataAllowed,
  normalizeQrFormat,
  normalizeQrSize,
  qrResponseHeaders,
} from '../../../../worker/src/lib/qr-response.ts'

const PORT = 3158
const outDir = join(process.cwd(), 'apps/web/out')

function contentType(path) {
  return ({
    '.css': 'text/css',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
  })[extname(path)] ?? 'application/octet-stream'
}

/** Worker の `app.get('/api/qr')` と同じ順番・同じ判定で応える。 */
async function handleQr(url, response) {
  const send = (status, body, headers = { 'content-type': 'text/plain; charset=utf-8' }) => {
    response.writeHead(status, headers)
    response.end(body)
  }
  const data = url.searchParams.get('data')
  if (!data) return send(400, 'Missing data param')
  if (!isQrDataAllowed(data)) return send(400, 'Data param too long')
  const size = normalizeQrSize(url.searchParams.get('size') ?? undefined)
  if (!size) return send(400, 'Invalid size')
  const format = normalizeQrFormat(url.searchParams.get('format') ?? undefined)
  const upstream = `https://api.qrserver.com/v1/create-qr-code/?size=${encodeURIComponent(size)}&format=${format}&data=${encodeURIComponent(data)}`
  const res = await fetch(upstream, { signal: AbortSignal.timeout(8_000) }).catch(() => null)
  if (!res) return send(504, 'QR generation timed out')
  if (!res.ok) return send(502, 'QR generation failed')
  const bytes = Buffer.from(await res.arrayBuffer())
  const upstreamType = res.headers.get('Content-Type')
  if (!upstreamType?.toLowerCase().startsWith('image/')) return send(502, 'Invalid QR response')
  const headers = qrResponseHeaders(
    upstreamType,
    url.searchParams.get('download') === '1',
    url.searchParams.get('filename') || 'referral-link-qr',
    format,
  )
  response.writeHead(200, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])))
  response.end(bytes)
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname === '/api/qr') {
    void handleQr(url, response).catch(() => {
      response.writeHead(500)
      response.end('qr handler failed')
    })
    return
  }
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\//, '')
  const plain = join(outDir, relative || 'index.html')
  const candidates = extname(plain) ? [plain] : [`${plain}.html`, join(plain, 'index.html')]
  const file = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  if (!file) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  response.writeHead(200, { 'content-type': contentType(file) })
  createReadStream(file).pipe(response)
})

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${PORT}`

const accounts = [
  { id: 'account-a', channelId: 'channel-a', name: 'A店', displayName: 'A店', basicId: '@nen-a', isActive: true, country: 'JP', role: null, displayOrder: 0 },
]

async function openDashboard(browser) {
  const context = await browser.newContext({ acceptDownloads: true })
  await context.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'account-a')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error('browser page error:', error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('browser console:', message.text())
  })
  await page.route('**/admin/version', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: '0.24.0', worker_hash: 'test', admin_hash: 'test', liff_hash: 'test' }),
  }))
  await page.route('**/admin/manifest', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ latest: '0.24.0', releases: [] }),
  }))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    // QRだけは本物の受け口へ通す。ここを差し替えると何も確かめられない。
    if (url.pathname === '/api/qr') {
      const response = await route.fetch({ url: `${baseUrl}${url.pathname}${url.search}` })
      return route.fulfill({ response })
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/auth/session') {
      return json({ success: true, data: { id: 'viewer', name: '管理者', role: 'owner', permissionKeys: [] }, csrfToken: 'test-csrf' })
    }
    if (url.pathname === '/api/staff/me') return json({ success: true, data: { id: 'viewer', name: '管理者', role: 'owner', permissionKeys: [] } })
    if (url.pathname === '/api/line-accounts') return json({ success: true, data: accounts })
    const accountEntry = url.pathname.match(/^\/api\/line-accounts\/([^/]+)\/follower-import$/)
    if (route.request().method() === 'GET' && accountEntry && url.searchParams.get('entry') === '1') {
      if (!accounts.some(account => account.id === accountEntry[1])) {
        return json({ success: false, error: 'LINE_ACCOUNT_NOT_FOUND' }, 404)
      }
      return json({ success: true, data: { destination: 'dashboard', canResume: false } })
    }
    if (url.pathname === '/api/entry-routes') {
      return json({ success: true, data: [{ id: 'route-1', name: '店頭POP', refCode: 'pop2026', isActive: true }] })
    }
    if (url.pathname === '/api/settings/features') {
      return json({ success: true, data: { features: {}, sidebarOrder: null, sidebarItemOrder: null, parentChildMode: false, specializedFeatureKeys: [], version: 1 } })
    }
    /*
     * ここで確かめたいのはQRの作成・保存だけ。他の口は「取れなかった」で返す。
     * 形の違う作り物を返すと、画面がその作り物で壊れて本題まで届かない。
     */
    return json({ success: false, error: 'この試験では返さない口' })
  })
  return { context, page }
}

/** 保存されたファイルが、選んだ形式の中身になっているか。 */
function looksLike(format, bytes) {
  if (format === 'png') return bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  if (format === 'jpg') return bytes[0] === 0xff && bytes[1] === 0xd8
  return bytes.toString('utf8', 0, 300).includes('<svg')
}

const browser = await chromium.launch({ headless: true })
try {
  const { context, page } = await openDashboard(browser)
  await page.goto(baseUrl)
  await page.getByRole('button', { name: 'QRを表示' }).click()
  const dialog = page.getByRole('dialog', { name: '友だち追加のQRコード' })
  await dialog.waitFor()

  // 既定は「大」。1200pxの案内が残っていたら、押しても保存できない人が出る。
  // 「画像の大きさ」は共通 Select（button＋listbox）なので、値ではなく
  // 開く前の釦の文字で見る。
  const sizeSelect = dialog.getByLabel('画像の大きさ')
  assert.ok((await sizeSelect.innerText()).includes('大（1024px）'), '既定の大きさがWorker上限を超えている')
  const dialogText = await dialog.innerText()
  assert.ok(!dialogText.includes('1200px'), '画面に届かない大きさの案内が残っている')
  assert.ok(dialogText.includes('大（1024px）'), '「大」の表示が1024pxになっていない')

  // 選べる大きさ全てが、実際の受け口で200になる。
  // 候補は一覧を開いたときだけ出るので、開いて名前を読み、閉じる。
  // 一覧は画面の最上層に出るので、画面全体から探す。
  await sizeSelect.click()
  const sizeNames = await page.getByRole('listbox').getByRole('button').allTextContents()
  await sizeSelect.click()
  const sizes = sizeNames.map((name) => {
    const match = name.match(/(\d+)px/)
    assert.ok(match, `大きさの候補が読めません: ${name}`)
    return `${match[1]}x${match[1]}`
  })
  assert.deepEqual(sizes, ['1024x1024', '600x600', '300x300'])
  for (const size of sizes) {
    const probe = await page.request.get(`${baseUrl}/api/qr?size=${size}&format=png&data=${encodeURIComponent('https://line.me/R/ti/p/@nen-a')}`)
    assert.equal(probe.status(), 200, `${size} が200にならない`)
    assert.ok((probe.headers()['content-type'] ?? '').startsWith('image/'), `${size} が画像で返らない`)
  }

  /*
   * 直した理由の裏取り。旧既定値のダウンロードURLは今も400で、
   * 「大」を選んだ人だけが保存できないままだった。
   */
  const oldHref = `${baseUrl}/api/qr?size=1200x1200&format=png&data=${encodeURIComponent('https://line.me/R/ti/p/@nen-a')}&download=1&filename=qr-friend-add`
  const old = await page.request.get(oldHref)
  assert.equal(old.status(), 400, '1200pxが400でないなら直す理由が変わる')
  assert.equal(await old.text(), 'Invalid size')

  // 1024pxで PNG / JPG / SVG の作成・表示・ダウンロードが通る。
  for (const [label, format] of [['PNG', 'png'], ['JPG', 'jpg'], ['SVG', 'svg']]) {
    await dialog.getByRole('button', { name: label, exact: true }).click()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('link', { name: '画像をダウンロード' }).click(),
    ])
    assert.equal(download.suggestedFilename(), `qr-friend-add.${format}`, `${label} の保存名が形式と合わない`)
    const path = await download.path()
    const bytes = readFileSync(path)
    assert.ok(bytes.byteLength > 200, `${label} の保存ファイルが空に近い`)
    assert.ok(looksLike(format, bytes), `${label} の中身が形式と合わない`)
  }

  // 経路を選ぶと保存名と対象URLがその経路になる（既存の動きを壊していない）。
  // 「発行中の追加URL」は共通の選択窓で選び、確定する。
  // 作り物の経路 route-1 の名前は「店頭POP」。
  await dialog.getByRole('button', { name: 'PNG', exact: true }).click()
  await dialog.getByRole('button', { name: '発行中の追加URL', exact: true }).click()
  const picker = page.getByRole('dialog').filter({ has: page.getByRole('radio', { name: '店頭POP', exact: true }) })
  await picker.getByRole('radio', { name: '店頭POP', exact: true }).check()
  await picker.getByRole('button', { name: '選ぶ', exact: true }).click()
  const [routeDownload] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('link', { name: '画像をダウンロード' }).click(),
  ])
  assert.equal(routeDownload.suggestedFilename(), 'qr-pop2026.png')

  // 表示中の画像も壊れていない（QRの絵が読み込めている）。
  const imageOk = await dialog.getByRole('img', { name: '友だち追加QRコード' }).evaluate((node) => node.complete && node.naturalWidth > 0)
  assert.ok(imageOk, 'ダイアログのQR画像が表示できていない')

  await context.close()
  console.log('qr dialog browser behavior: PASS')
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
