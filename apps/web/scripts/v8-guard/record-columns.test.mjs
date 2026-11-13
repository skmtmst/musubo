import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { connectGuardBrowser } from './browser-session.mjs'
import { fitListColumns } from '../../src/components/shared/list-column-sizing.mjs'
import scanColumns from './table-column-alignment-browser.mjs'
import scanLayout from './layout-defects-browser.mjs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = path => read(path).replace(/:global\(([^)]+)\)/g, '$1')

test('record tracks align all four columns and detect the former stacked layout at every desktop width', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    for (const width of [1152, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<html><style>${read('../../src/app/globals.css')}${css('../../src/components/shared/data-table.module.css')}${css('../../src/components/shared/table.module.css')}
        *{box-sizing:border-box}.frame{width:calc(100vw - 660px)}.badge{display:inline-flex;padding:2px 8px;white-space:nowrap}td[data-cell-grow]{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        </style><main><div class="frame" data-table-density="records" data-column-sizing="content" style="--table-columns:repeat(4,minmax(0,1fr))"><table class="table" aria-label="同期の記録"><thead><tr class="headRow"><th class="cell">日時</th><th class="cell">きっかけ</th><th class="cell" data-cell-grow>書き出したもの</th><th class="cell">結果</th></tr></thead><tbody>${['9/30 03:00', '9/29 15:42'].map(date => `<tr class="row"><td class="bodyCell">${date}</td><td class="bodyCell">定期</td><td class="bodyCell" data-cell-grow>友だち 1,284・フォーム回答 312</td><td class="bodyCell"><span class="badge" data-design-node="xRvDB">一部だけ完了</span></td></tr>`).join('')}</tbody></table></div></main></html>`)
      await page.locator('.frame').evaluate(fitListColumns)
      const good = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('tr')].map(row => [...row.children].map(cell => {
          const box = cell.getBoundingClientRect()
          return { x: box.x, width: box.width, top: box.top, bottom: box.bottom }
        }))
        return { rows, overflow: document.documentElement.scrollWidth - innerWidth }
      })
      const alignment = await page.evaluate(scanColumns)
      assert.equal(alignment.findings.length, 0)
      assert.equal(alignment.coverage[0].rows, 3, 'head and both data rows must actually be measured')
      assert.equal(good.overflow, 0)
      for (const row of good.rows.slice(1)) for (const [index, cell] of row.entries()) {
        assert.ok(Math.abs(cell.x - good.rows[0][index].x) < 1, JSON.stringify({ width, good }))
        assert.ok(Math.abs(cell.width - good.rows[0][index].width) < 1)
      }
      for (let repeat = 0; repeat < 5; repeat++) await page.locator('.frame').evaluate(fitListColumns)
      assert.equal((await page.evaluate(scanColumns)).findings.length, 0)
      await page.locator('.frame').evaluate(frame => {
        frame.style.removeProperty('--table-columns')
        frame.style.removeProperty('--table-content-columns')
      })
      assert.ok((await page.evaluate(scanColumns)).findings.length > 0, 'the missing-track fault must be detected')
    }
  } finally { await browser.close() }
})


test('late calendar data refreshes flex column widths and keeps every row aligned', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    for (const width of [1152, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<style>${read('../../src/app/globals.css')}${css('../../src/components/shared/data-table.module.css')}${css('../../src/components/shared/table.module.css')}
        *{box-sizing:border-box}.frame{width:calc(100vw - 280px)}.table tr{display:flex}.table tr>th,.table tr>td{flex:0 1 auto;white-space:nowrap}.calendar{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        </style><main><div class="frame" data-column-layout data-column-sizing="content" style="--table-column-gap:12px;--table-column-padding:0 24px;--table-head-padding:0 24px;--table-head-height:40px;--table-row-height:56px"><table class="table"><thead><tr data-table-layout="columns"><th data-cell-grow>スタッフ</th><th>カレンダー</th><th>状態</th></tr></thead><tbody>${['見本 18', '見本 30'].map(name => `<tr data-table-layout="columns"><td data-cell-grow>${name}</td><td><span class="calendar">—</span></td><td>つながっている</td></tr>`).join('')}</tbody></table></div></main>`)
      await page.locator('.frame').evaluate(fitListColumns)
      const before = await page.locator('tbody tr').first().locator('td').nth(1).evaluate(cell => cell.getBoundingClientRect().width)
      await page.locator('tbody .calendar').evaluateAll(nodes => nodes.forEach(node => { node.textContent = 'staff@example.com' }))
      await page.locator('.frame').evaluate(fitListColumns)
      const after = await page.locator('tbody tr').first().locator('td').nth(1).evaluate(cell => cell.getBoundingClientRect().width)
      assert.ok(after > before, `late value must grow its column: ${before} -> ${after}`)
      const clipping = await page.locator('tbody .calendar').evaluateAll(nodes => nodes.some(node => node.scrollWidth > node.clientWidth + 1))
      assert.equal(clipping, false, `calendar is readable at ${width}`)
      const positions = await page.locator('tr').evaluateAll(rows => rows.map(row => [...row.children].map(cell => cell.getBoundingClientRect().x)))
      for (const row of positions.slice(1)) for (const [index, x] of row.entries()) assert.ok(Math.abs(x - positions[0][index]) <= 1)
      for (let repeat = 0; repeat < 3; repeat++) await page.locator('.frame').evaluate(fitListColumns)
      assert.equal(await page.locator('tbody tr').first().locator('td').nth(1).evaluate(cell => cell.getBoundingClientRect().width), after)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0)
    }
  } finally { await browser.close() }
})

test('内容幅の表は長い名前の列を縮めても日付・数値・リンクの読み取り幅を守る', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } })
    await page.setContent('<style>*{box-sizing:border-box}main{width:500px}table{width:100%;table-layout:fixed;border-collapse:collapse}th,td{padding:0 8px;font:14px Arial}span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style><main><div class="frame" data-column-sizing="content"><table><thead><tr><th>日時</th><th>件数</th><th data-cell-grow>担当者</th><th>操作</th></tr></thead><tbody><tr><td><span data-list-date-time>2026/10/26 23:59</span></td><td data-list-number>12,345</td><td data-cell-grow><span>long.member.name@example-company.test</span></td><td><a href="#">詳しく見る</a></td></tr><tr><td><span data-list-date-time>2026/10/25 18:30</span></td><td data-list-number>9,876</td><td data-cell-grow><span>another.long.name@example-company.test</span></td><td><a href="#">詳しく見る</a></td></tr></tbody></table></div></main>')
    await page.locator('.frame').evaluate(fitListColumns)
    const protectedCells = await page.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.children].slice(0, 2).map(cell => ({ width: cell.getBoundingClientRect().width, scroll: cell.scrollWidth, client: cell.clientWidth }))))
    for (const row of protectedCells) for (const cell of row) assert.ok(cell.width > 0 && cell.client >= cell.scroll - 1, JSON.stringify({ row, protectedCells }))
    const email = await page.locator('tbody tr:first-child td:nth-child(3) span').evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }))
    assert.ok(email.scroll > email.client, 'long text may be ellipsized in the flexible name cell')
  } finally { await browser.close() }
})

test('内容に合わせてメールを広げ、短い状態列を縮める。固定の等分割の故障は見つかる', async () => {
  const { fitGridContentColumns } = await import('../../src/components/shared/grid-content-columns.mjs')
  const scanOwner = (await import('./owner-rules-browser.mjs')).default
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    for (const width of [1024, 1152, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.setContent('<style>*{box-sizing:border-box}.table{width:calc(100vw - 280px);font:14px Arial}.row{display:grid;grid-template-columns:var(--grid-table-content-columns,repeat(4,minmax(0,1fr)));gap:16px;padding:0 24px}.text{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style><main><div class="table" role="table"><div class="row" role="row"><span role="columnheader">名前</span><span role="columnheader">メールアドレス</span><span role="columnheader">状態</span><span role="columnheader">最終ログイン</span></div><div class="row" role="row"><span>担当者</span><span><span class="text" title="long.member.name@example-company.test">long.member.name@example-company.test</span></span><span>有効</span><span>10/26 12:00</span></div></div></main>')
      assert.ok((await page.evaluate(scanOwner)).some(f => f.kind === 'table-unused-space'))
      await page.locator('.table').evaluate(fitGridContentColumns)
      assert.deepEqual(await page.evaluate(scanOwner), [])
      const widths = await page.locator('.row').last().locator(':scope > span').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width))
      assert.ok(widths[1] > widths[2])
      const initial = await page.locator('.table').getAttribute('style')
      await page.locator('.table').evaluate(fitGridContentColumns)
      assert.equal(await page.locator('.table').getAttribute('style'), initial)
    }
  } finally { await browser.close() }
})

test('狭くても操作列は縮めず、幅を往復し短い内容に変えても同じ配分へ戻る', async () => {
  const { fitGridContentColumns } = await import('../../src/components/shared/grid-content-columns.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<style>*{box-sizing:border-box}.table{width:420px;font:14px Arial}.row{display:grid;grid-template-columns:var(--grid-table-content-columns,repeat(3,1fr));gap:12px}.text{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}button{width:112px}</style><main><div class="table" role="table"><div class="row" role="row"><span>名前</span><span>メール</span><span>操作</span></div><div class="row" role="row"><span class="text">とても長い担当者の名前</span><span class="text">long.member@example-company.test</span><span><button>権限を変更する</button></span></div></div></main>')
    await page.locator('.table').evaluate(fitGridContentColumns)
    const first = await page.locator('.table').getAttribute('style')
    for (const width of [720, 420]) {
      await page.locator('.table').evaluate((el, width) => { el.style.width = `${width}px` }, width)
      await page.locator('.table').evaluate(fitGridContentColumns)
      assert.equal(await page.locator('button').evaluate(el => el.getBoundingClientRect().width <= el.parentElement.getBoundingClientRect().width), true)
    }
    const after = await page.locator('.table').evaluate(el => el.style.getPropertyValue('--grid-table-content-columns'))
    assert.ok(first.includes(after))
    await page.locator('.text').last().evaluate(el => { el.textContent = 'a@b.test' })
    await page.locator('.table').evaluate(fitGridContentColumns)
    assert.notEqual(await page.locator('.table').evaluate(el => el.style.getPropertyValue('--grid-table-content-columns')), after)
  } finally { await browser.close() }
})

test('札の印・余白まで本来の幅で測り、状態の札を省略しない', async () => {
  const { fitGridContentColumns } = await import('../../src/components/shared/grid-content-columns.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<style>*{box-sizing:border-box}.table{width:760px;font:14px Arial}.row{display:grid;grid-template-columns:var(--grid-table-content-columns,repeat(3,minmax(0,1fr)));gap:16px}.pill{display:inline-flex;align-items:center;max-width:100%;padding:2px 10px;border-radius:99px;background:#eee}.pill::before{content:"";flex:none;width:8px;height:8px;margin-right:6px;border-radius:50%;background:green}.text{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style><main><div class="table" role="table"><div class="row" role="row"><span>名前</span><span>メール</span><span>状態</span></div><div class="row" role="row"><span>担当者</span><span><span class="text">member@example.test</span></span><span><span class="pill"><span class="text">有効</span></span></span></div></div></main>')
    await page.locator('.table').evaluate(fitGridContentColumns)
    const pill = await page.locator('.pill .text').evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    assert.ok(pill.scroll <= pill.client, JSON.stringify(pill))
  } finally { await browser.close() }
})

test('印の無い表の操作・入力の実幅はcontent計測でも狭めない', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<style>*{box-sizing:border-box}table{width:400px;table-layout:fixed}th,td{padding:0;font:14px Arial}button,input{width:160px}</style><main><div data-column-sizing="content"><table><thead><tr><th data-cell-grow>名前</th><th>操作</th><th>入力</th></tr></thead><tbody><tr><td data-cell-grow>担当者</td><td><button>担当を変更する</button></td><td><input aria-label="名前"></td></tr></tbody></table></div></main>')
    await page.locator('main > div').evaluate(fitListColumns)
    const widths = await page.locator('tbody td').evaluateAll(cells => cells.slice(1).map(cell => parseFloat(cell.style.getPropertyValue('--list-content-column-width'))))
    assert.ok(widths.every(width => width >= 160), JSON.stringify(widths))
    assert.equal(await page.locator('[data-content-stacked]').count(), 0)
  } finally { await browser.close() }
})

test('Grid内容列は見出し幅を守り、境界で既存段組みへ戻して全列・操作を残す', async () => {
  const { fitGridContentColumns } = await import('../../src/components/shared/grid-content-columns.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${css('../../src/components/shared/grid-table.module.css')}*{box-sizing:border-box}:root{--tpl-list-inset:24px;--polish-table-row:56px;--polish-table-head:40px;--polish-space-row:8px;--space-4:4px}.table{--grid-table-columns:minmax(0,1fr) 180px 140px;--grid-table-rest-columns:180px 140px;--grid-table-gap:16px;--grid-table-row-padding:0 24px;font:14px Arial}.text{display:block;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}button{width:140px}</style><main><div class="table" role="table"><div class="row" role="row"><span class="cell">名前</span><span class="cell">メールアドレス</span><span class="cell">操作</span></div><div class="row" role="row"><span class="cell text" title="長い担当者の名前">長い担当者の名前</span><span class="cell text" title="long.member@example.test">long.member@example.test</span><span class="cell"><button>担当を変更する</button></span></div></div></main>`)
    for (const width of [1152, 1440, 320, 1440]) {
      await page.setViewportSize({ width, height: 800 })
      await page.locator('.table').evaluate((el, width) => { el.style.width = `${width < 400 ? width - 16 : width - 280}px` }, width)
      await page.locator('.table').evaluate(fitGridContentColumns)
      const measured = await page.locator('.table').evaluate(frame => ({
        stacked: frame.hasAttribute('data-stacked'),
        widths: [...frame.querySelectorAll('[role="row"]:last-child > *')].map(el => el.getBoundingClientRect().width),
        overflow: frame.scrollWidth - frame.clientWidth,
        buttonRight: frame.querySelector('button').getBoundingClientRect().right - frame.getBoundingClientRect().right,
      }))
      assert.equal(measured.stacked, width === 320, JSON.stringify(measured))
      assert.ok(measured.widths.every(size => size > 0), JSON.stringify(measured))
      assert.equal(measured.overflow, 0, JSON.stringify(measured))
      assert.ok(measured.buttonRight <= 0, JSON.stringify(measured))
      assert.equal(await page.getByRole('button', { name: '担当を変更する' }).count(), 1)
    }
    const batching = await page.locator('.table').evaluate(frame => {
      const original = Element.prototype.getBoundingClientRect
      const counts = []
      Element.prototype.getBoundingClientRect = function () {
        if (this.hasAttribute('data-column-probe')) counts.push(frame.querySelectorAll('[data-column-probe]').length)
        return original.call(this)
      }
      window.gridProbeCounts = counts
      window.restoreGridProbe = () => { Element.prototype.getBoundingClientRect = original }
      return frame.querySelectorAll('[role="row"] > *').length
    })
    await page.locator('.table').evaluate(fitGridContentColumns)
    const counts = await page.evaluate(() => { window.restoreGridProbe(); return window.gridProbeCounts })
    assert.ok(counts.length > 0 && counts.every(count => count === batching), JSON.stringify(counts))
    assert.equal(await page.locator('[data-column-probe]').count(), 0)
  } finally { await browser.close() }
})

test('Gridの計測がradioの選択・入力値・独自要素の接続回数を変えない', async () => {
  const { fitGridContentColumns, clearGridContentColumns } = await import('../../src/components/shared/grid-content-columns.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<style>.table{width:200px}.row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.row input{width:120px}</style><div class="table" role="table" style="--grid-table-rest-columns:old-value"><div class="row" role="row"><span>名前</span><span>選ぶ</span><span>入力</span></div><div class="row" role="row"><span>担当者</span><span><input type="radio" name="choice" checked><test-connected></test-connected></span><span><input name="memo" value="入力を残す"></span></div></div>')
    await page.evaluate(() => { window.connectCount = 0; customElements.define('test-connected', class extends HTMLElement { connectedCallback() { window.connectCount++ } }) })
    const before = await page.evaluate(() => ({ checked: document.querySelector('[type="radio"]').checked, value: document.querySelector('[name="memo"]').value, connected: window.connectCount }))
    await page.locator('.table').evaluate(fitGridContentColumns)
    const after = await page.evaluate(() => ({ checked: document.querySelector('[type="radio"]').checked, value: document.querySelector('[name="memo"]').value, connected: window.connectCount }))
    assert.deepEqual(after, before)
    assert.equal(await page.locator('[data-column-probe]').count(), 0)
    await page.locator('.table').evaluate(clearGridContentColumns)
    assert.equal(await page.locator('.table').getAttribute('data-stacked'), null)
    assert.equal(await page.locator('.table').evaluate(el => el.style.getPropertyValue('--grid-table-rest-columns')), 'old-value')
    assert.equal(await page.locator('.table').evaluate(el => el.style.getPropertyValue('--grid-table-content-rest-columns')), '')
    await page.locator('.table').evaluate(el => { el.dataset.stacked = '' })
    await page.locator('.table').evaluate(fitGridContentColumns)
    await page.locator('.table').evaluate(clearGridContentColumns)
    assert.equal(await page.locator('.table').getAttribute('data-stacked'), '')
  } finally { await browser.close() }
})

test('Gridは通信要素を複製せず、現在の選択と入力を写し、append途中の例外でもprobeを残さない', async () => {
  const { fitGridContentColumns } = await import('../../src/components/shared/grid-content-columns.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.route('http://fixture.invalid/**', route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>' }))
    await page.setContent('<style>.table{width:800px}.row{display:grid;grid-template-columns:repeat(3,1fr)}</style><div class="table"><div class="row" role="row"><span>名前</span><span>選択</span><span>内容</span></div><div class="row" role="row"><span><embed src="http://fixture.invalid/embed"><video><source src="http://fixture.invalid/video"></video><input type="image" src="http://fixture.invalid/input"><svg><image href="http://fixture.invalid/image"/><use href="http://fixture.invalid/use#x"/></svg></span><span><select><option value="a">初期</option><option value="b">変更後</option></select></span><span><textarea>初期値</textarea></span></div></div>')
    await page.evaluate(() => {
      document.querySelector('select').value = 'b'
      document.querySelector('textarea').value = '保持する最新入力'
      window.probeValues = []
      window.resourceClones = 0
      const append = Element.prototype.append, rect = Element.prototype.getBoundingClientRect
      Element.prototype.append = function (...nodes) {
        for (const node of nodes) if (node.hasAttribute?.('data-column-probe')) window.resourceClones += node.querySelectorAll('embed,source,input[type="image"],svg,image,use').length
        return append.apply(this, nodes)
      }
      Element.prototype.getBoundingClientRect = function () {
        if (this.hasAttribute('data-column-probe')) window.probeValues.push({ selected: this.querySelector('select')?.value, text: this.querySelector('textarea')?.value })
        return rect.call(this)
      }
      window.restoreProbeMethods = () => { Element.prototype.append = append; Element.prototype.getBoundingClientRect = rect }
    })
    let requests = 0
    page.on('request', () => requests++)
    await page.locator('.table').evaluate(fitGridContentColumns)
    const result = await page.evaluate(() => {
      window.restoreProbeMethods()
      return { clones: window.resourceClones, values: window.probeValues, selected: document.querySelector('select').value, text: document.querySelector('textarea').value }
    })
    assert.equal(result.clones, 0)
    assert.equal(requests, 0)
    assert.ok(result.values.some(row => row.selected === 'b'))
    assert.ok(result.values.some(row => row.text === '保持する最新入力'))
    assert.equal(result.selected, 'b')
    assert.equal(result.text, '保持する最新入力')
    await page.evaluate(() => {
      const append = Element.prototype.append
      let rows = 0
      Element.prototype.append = function (...nodes) {
        const result = append.apply(this, nodes)
        if (nodes.some(node => node.hasAttribute?.('data-column-probe')) && ++rows === 2) throw new Error('append failed after insertion')
        return result
      }
      window.restoreProbeAppend = () => { Element.prototype.append = append }
    })
    await assert.rejects(page.locator('.table').evaluate(fitGridContentColumns), /append failed/)
    await page.evaluate(() => window.restoreProbeAppend())
    assert.equal(await page.locator('[data-column-probe]').count(), 0)
    await page.locator('.table').evaluate(fitGridContentColumns)
    assert.equal(await page.locator('[data-column-probe]').count(), 0)
  } finally { await browser.close() }
})

test('列型の内容表もgapを含む境界で段組みと復元を行い、操作と値を残す', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${css('../../src/components/shared/data-table.module.css')}*{box-sizing:border-box}:root{--polish-space-row:8px}.frame{width:800px;--table-column-gap:12px;--table-column-padding:0 24px;--table-head-padding:0 24px;--table-head-height:40px;--table-row-height:56px;--table-head-text-size:14px;--table-body-text-size:14px;font:14px Arial}.table{width:100%}.table tr[data-table-layout='columns']{display:flex}.text{display:block;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}button{width:112px}</style><main><div class="frame" data-column-layout data-column-sizing="content"><table class="table"><thead><tr data-table-layout="columns"><th data-cell-grow>名前</th><th>メールアドレス</th><th>操作</th></tr></thead><tbody><tr data-table-layout="columns"><td data-cell-grow><span class="text" title="長い担当者の名前">長い担当者の名前</span></td><td><span class="text" title="long.member@example.test">long.member@example.test</span></td><td><button>担当を変更する</button></td></tr></tbody></table></div></main>`)
    for (const width of [872, 1160, 304, 1160]) {
      await page.locator('.frame').evaluate((el, width) => { el.style.width = `${width}px` }, width)
      await page.locator('.frame').evaluate(fitListColumns)
      const state = await page.locator('.frame').evaluate(frame => ({
        stacked: frame.hasAttribute('data-content-stacked'), overflow: frame.scrollWidth - frame.clientWidth,
        widths: [...frame.querySelectorAll('tbody td')].map(cell => cell.getBoundingClientRect().width),
        buttonRight: frame.querySelector('button').getBoundingClientRect().right - frame.getBoundingClientRect().right,
      }))
      assert.equal(state.stacked, width === 304, JSON.stringify(state))
      assert.equal(state.overflow, 0, JSON.stringify(state))
      assert.ok(state.widths.every(width => width > 0), JSON.stringify(state))
      assert.ok(state.buttonRight <= 0, JSON.stringify(state))
    }
  } finally { await browser.close() }
})
