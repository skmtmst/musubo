import test from 'node:test'
import assert from 'node:assert/strict'
import { connectGuardBrowser } from './browser-session.mjs'
import { openPage } from './browser-env.mjs'
import scan from './edge-inset-browser.mjs'
import { measurePage } from './layout-defects.mjs'

// 板（幅 1000）・題は左 24。帯・カード・知らせを板の直下に置き、内側の余白の有無で判定を確かめる。
const board = body => `<main style="font:16px/20px sans-serif"><div data-page-template="list" style="width:1000px;margin:0;padding:0;background:#fff">
  <header data-template-region="heading" style="padding:16px 24px;box-shadow:0 1px 0 #0001"><h1 data-page-title>タグ</h1></header>
  ${body}
</div></main>`
// Keep the fixture above the detector's 24px height threshold on every OS.
const band = style => `<div id="target" data-kpi-strip style="min-height:40px;display:grid;grid-auto-flow:column;border-block:1px solid #0001;${style}"><div>未使用 63件</div><div>付けている友だち 5人</div></div>`
const card = style => `<section id="target" style="border-radius:12px;box-shadow:0 0 0 1px #0001;height:80px;${style}">中身</section>`
const notice = style => `<div id="target" role="status" style="background:#fff7ed;height:40px;${style}">お知らせ</div>`

test('数の帯・カード・知らせが板の端にくっつくと落ち、題と同じ内側の余白に収めると通る', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
    for (const [name, part] of [['band', band], ['card', card], ['notice', notice]]) {
      await page.setContent(board(part('margin:0')))
      const broken = await page.evaluate(scan)
      assert.equal(broken.length, 1, name)
      assert.equal(broken[0].kind, 'edge-hug')
      assert.deepEqual(broken[0].measure, { left: 0, right: 0, inset: 24 })
      // 片側だけ（左はそろい、右だけ板の端）も落ちる。
      await page.setContent(board(part('margin:0 0 0 24px')))
      assert.deepEqual((await page.evaluate(scan)).map(f => f.measure.right), [0], name)
      await page.setContent(board(part('margin:0 24px')))
      assert.deepEqual(await page.evaluate(scan), [], name)
    }
  } finally { await browser.close() }
})

test('題も帯も一緒に12px・0pxへ縮める故障を見逃さない', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
    for (const inset of [12, 0]) {
      await page.setContent(board(band(`margin:0 ${inset}px`)).replace('padding:16px 24px', `padding:16px ${inset}px`))
      const findings = await page.evaluate(scan)
      assert.ok(findings.some(f => f.text === 'title'))
      assert.ok(findings.some(f => f.text === 'band'))
    }
  } finally { await browser.close() }
})

test('表の行の線・左の列・頭の線は端まで引いてよい', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
    await page.setContent(board(`<div style="display:flex"><nav data-template-region="folders" style="width:200px;border-right:1px solid #0001"><div style="border-radius:12px;box-shadow:0 0 0 1px #0001;height:40px;width:200px">すべて</div></nav>
      <table style="width:800px;border-collapse:collapse"><tr style="border-bottom:1px solid #0001"><td style="padding:12px 24px">EC顧客連携済み</td></tr></table></div>`))
    assert.deepEqual(await page.evaluate(scan), [])
    // 下に浮かせて置く追従の帯は決まった浮かせ方（12）なので数えない。
    await page.setContent(board('<div data-shared-part="sticky-bar" style="margin:0 12px;border-radius:12px;box-shadow:0 0 0 1px #0001;height:56px">保存する</div>'))
    assert.deepEqual(await page.evaluate(scan), [])
  } finally { await browser.close() }
})

test('題が印の分だけ右にある板でも、標準の内側の余白（24）を守るカードは通し、24 より端へ寄ると落ちる', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
    const avatarBoard = style => `<style>:root{--tpl-list-inset:24px}</style><main><div data-page-template="detail" style="width:1000px;background:#fff">
      <header data-template-region="heading" style="display:flex;gap:16px;padding:16px 24px"><span style="width:48px;height:48px"></span><h1 data-page-title>Kenta</h1></header>
      ${card(style)}</div></main>`
    await page.setContent(avatarBoard('margin:0 24px'))
    assert.deepEqual(await page.evaluate(scan), [])
    await page.setContent(avatarBoard('margin:0 16px'))
    assert.deepEqual((await page.evaluate(scan)).map(f => f.measure), [{ left: 16, right: 16, inset: 24 }])
  } finally { await browser.close() }
})

test('崩れの見張り（layout-defects）がこの判定を含む', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
    await page.setContent(board(band('margin:0')))
    assert.ok((await measurePage(page)).some(f => f.kind === 'edge-hug'))
    await page.setContent(board(band('margin:0 24px')))
    assert.ok(!(await measurePage(page)).some(f => f.kind === 'edge-hug'))
  } finally { await browser.close() }
})

test('表の線は端まで伸びても中身と道具には内側の余白が要る', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 600 } })
    await page.setContent(board('<div data-template-region="toolbar" style="height:40px">道具</div><table style="width:100%;border-collapse:collapse"><tr><td>名前</td></tr></table>'))
    assert.ok((await page.evaluate(scan)).some(f => f.text === 'toolbar'))
    assert.ok((await page.evaluate(scan)).some(f => f.text === 'table-content'))
    await page.locator('[data-template-region="toolbar"]').evaluate(el => { el.style.marginInline = '24px' })
    await page.locator('td').evaluate(el => { el.style.paddingInline = '24px' })
    assert.deepEqual(await page.evaluate(scan), [])
  } finally { await browser.close() }
})

test('横送りできる比較表は窓の内側の余白で測り、窓自体の右端越えは落とす', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 600 } })
    await page.setContent(board('<div id="scroll" style="width:952px;margin:0 24px;overflow-x:auto"><table style="width:1600px;border-collapse:collapse"><tr><td style="padding:12px 24px">比較の項目</td></tr></table></div>'))
    assert.deepEqual(await page.evaluate(scan), [])
    await page.locator('#scroll').evaluate(el => { el.style.width = '1000px' })
    assert.ok((await page.evaluate(scan)).some(f => f.text === 'table-content'))
  } finally { await browser.close() }
})

test('タグの数の帯は1024・1152・1440で題と道具の内側の端との差が0', async () => {
  const { openPage } = await import('./browser-env.mjs')
  const browser = await connectGuardBrowser()
  try {
    for (const width of [1024, 1152, 1440]) {
      const page = await openPage(browser, { baseUrl: process.env.V8_GUARD_BASE ?? 'http://127.0.0.1:4310', route: '/tags', width, stable: true })
      const measured = await page.evaluate(() => {
        const frame = document.querySelector('[data-page-template]')
        const heading = frame.querySelector('[data-template-region="heading"]')
        const band = frame.querySelector('[data-kpi-strip]')
        const tools = frame.querySelector('[data-template-region="toolbar"]')
        if (!heading || !band || !tools) throw new Error('題・帯・道具がありません')
        const h = heading.getBoundingClientRect(), b = band.getBoundingClientRect(), t = tools.getBoundingClientRect()
        return { left: b.left - h.left - parseFloat(getComputedStyle(heading).paddingLeft), right: t.right - parseFloat(getComputedStyle(tools).paddingRight) - b.right }
      })
      assert.deepEqual(measured, { left: 0, right: 0 }, String(width))
      await page.close()
    }
  } finally { await browser.close() }
})
