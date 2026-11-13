import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shortTextFindings } from './short-text-browser.mjs'

test('short names, times, counts and dates fail if clipped, even when a title exists', () => {
  const records = ['09 : 00', '10月1日', '有効 5', '見本 110', '対象外 12 回'].map(text => ({text, clipped:true, lines:1, title:text}))
  assert.equal(shortTextFindings(records).length,records.length)
  assert.ok(shortTextFindings(records).every(item=>item.kind==='short-text-clipped'))
})
test('a short date split over two lines fails and restoration passes', () => {
  const record={text:'10月1日',clipped:false,lines:2}
  assert.equal(shortTextFindings([record])[0].kind,'short-text-wrapped')
  assert.deepEqual(shortTextFindings([{...record,lines:1}]),[])
})

test('rendered time, count and short-name clipping is detected and restoration clears it', async () => {
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const { collectShortText } = await import('./short-text-browser.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<main><input inputmode="numeric" value="09:00" style="width:20px;font:16px monospace;padding:0;border:0"><div title="対象外 12 回" style="width:20px;overflow:hidden;white-space:nowrap">対象外 12 回</div><strong style="display:block;width:24px">10月1日</strong></main>')
    const broken = shortTextFindings(await page.evaluate(collectShortText))
    assert.ok(broken.some(item => item.text === '09:00' && item.clipped))
    assert.ok(broken.some(item => item.text === '対象外 12 回' && item.clipped))
    assert.ok(broken.some(item => item.text === '10月1日' && item.lines > 1))
    await page.locator('main').evaluate(main => { for (const el of main.children) el.style.width = '240px' })
    assert.deepEqual(shortTextFindings(await page.evaluate(collectShortText)), [])
    const time = (await page.evaluate(collectShortText)).find(item => item.text === '09:00')
    await page.locator('input').evaluate((input, width) => { input.style.width = `${width}px` }, time.required - 0.25)
    assert.ok(shortTextFindings(await page.evaluate(collectShortText)).some(item => item.text === '09:00'))
    await page.locator('input').evaluate((input, width) => { input.style.width = `${width}px` }, time.required + 1)
    assert.deepEqual(shortTextFindings(await page.evaluate(collectShortText)), [])
  } finally { await browser.close() }
})

test('booking table columns follow the page contract through a narrower shared table', async () => {
  const { readFileSync } = await import('node:fs')
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const css = ['../../src/app/globals.css', '../../src/components/shared/data-table.module.css'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/:global\(([^)]+)\)/g, '$1')).join('\n')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`<html data-theme="v8"><style>${css}*{box-sizing:border-box}.table{width:100%}</style><main style="width:1140px;container-type:inline-size;container-name:v8-page"><section style="width:700px"><div class="frame" data-shared-part="list-table" data-column-layout data-collapse-scope="page"><table class="table"><thead><tr data-table-layout="columns"><th>名前</th><th data-cell-collapse="narrow">担当</th><th data-cell-collapse="narrow">30日</th></tr></thead><tbody><tr data-table-layout="columns"><td>初回相談</td><td data-cell-collapse="narrow">佐々木</td><td data-cell-collapse="narrow">12件</td></tr></tbody></table></div></section></main></html>`)
    const columnsVisible = () => page.locator('[data-cell-collapse]').evaluateAll(cells => cells.every(cell => cell.getBoundingClientRect().width > 0))
    assert.equal(await columnsVisible(), true, 'a narrow table in a wide page keeps optional columns')
    await page.locator('.frame').evaluate(frame => frame.removeAttribute('data-collapse-scope'))
    assert.equal(await columnsVisible(), false, 'the former nearest-container fault hides columns at the wide page')
    await page.locator('.frame').evaluate(frame => frame.setAttribute('data-collapse-scope', 'page'))
    assert.equal(await columnsVisible(), true)
    await page.locator('main').evaluate(main => { main.style.width = '852px' })
    assert.equal(await columnsVisible(), false)
    await page.locator('[data-cell-collapse]').evaluateAll(cells => cells.forEach(cell => { cell.setAttribute('data-optional-column', ''); cell.removeAttribute('data-cell-collapse') }))
    assert.equal(await page.locator('[data-optional-column]').evaluateAll(cells => cells.every(cell => cell.getBoundingClientRect().width > 0)), true, 'missing collapse metadata restores the narrow-page defect')
    await page.locator('[data-optional-column]').evaluateAll(cells => cells.forEach(cell => cell.setAttribute('data-cell-collapse', 'narrow')))
    assert.equal(await columnsVisible(), false)
  } finally { await browser.close() }
})

test('the product layout entry reports short-text defects and restoration clears them', async () => {
  const { measurePage } = await import('./layout-defects.mjs')
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<main><strong style="display:block;width:20px;overflow:hidden;white-space:nowrap">対象外 12 回</strong></main>')
    assert.ok((await measurePage(page)).some(item => item.kind === 'short-text-clipped'))
    await page.locator('strong').evaluate(el => { el.style.width = '200px' })
    assert.equal((await measurePage(page)).some(item => item.kind.startsWith('short-text-')), false)
  } finally { await browser.close() }
})

test('narrow time fields preserve coarse touch targets and reserve space before the clock', async () => {
  const { readFileSync } = await import('node:fs')
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const css = ['choice-field', 'time-field-v8'].map(name => readFileSync(new URL(`../../src/components/shared/${name}.module.css`, import.meta.url), 'utf8')).join('\n')
  const { collectShortText } = await import('./short-text-browser.mjs')
  const browser = await connectGuardBrowser()
  try {
    const measurements = []
    for (const fieldWidth of [84, 88]) for (const hasTouch of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1152, height: 900 }, hasTouch })
      await page.setContent(`<style>:root{--control-h:36px;--space-4:4px;--space-8:8px;--space-24:24px;--polish-space-field:12px;--polish-icon-control:16px;--tpl-toolbar-gap:8px;--choice-ring:1px;--font-sans:Arial;--polish-control-text:13px;--polish-control-weight:500;--text-body--line-height:20px}${css}</style><main style="width:${fieldWidth}px"><div class="root"><div class="field frame" data-choice-field data-choice-time><input inputmode="numeric" class="input" role="combobox" data-choice-trigger value="09 : 00"><button class="open" data-choice-action><svg></svg></button></div></div></main>`)
      const geometry = await page.evaluate(() => {
        const button = document.querySelector('button').getBoundingClientRect()
        return { coarse: matchMedia('(pointer:coarse)').matches, width: button.width, height: button.height, inputRight: document.querySelector('input').getBoundingClientRect().right, iconLeft: document.querySelector('svg').getBoundingClientRect().left }
      })
      assert.equal(geometry.coarse, hasTouch)
      assert.equal(geometry.width, hasTouch ? 44 : 24)
      assert.equal(geometry.height, hasTouch ? 44 : 24)
      assert.ok(geometry.inputRight <= geometry.iconLeft)
      const records = await page.evaluate(collectShortText)
      measurements.push({fieldWidth,hasTouch,records,findings:shortTextFindings(records)})
      await page.close()
    }
    console.info('narrow-time-measurements',JSON.stringify(measurements))
    assert.deepEqual(measurements.filter(row => row.findings.length), [])
  } finally { await browser.close() }
})

test('popup field values retain their title/ellipsis contract while ordinary action labels still fail', async () => {
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const { collectShortText } = await import('./short-text-browser.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<main><button data-input-field aria-haspopup="dialog" title="2026年10月31日（土）" style="width:60px;overflow:hidden;white-space:nowrap">2026年10月31日（土）</button><button title="対象外 12 回" style="width:20px;overflow:hidden;white-space:nowrap">対象外 12 回</button></main>')
    const findings = shortTextFindings(await page.evaluate(collectShortText))
    assert.equal(findings.some(row => row.text.includes('2026')), false)
    assert.equal(findings.some(row => row.text === '対象外 12 回'), true)
  } finally { await browser.close() }
})

test('content tables reserve readable main names before long supplemental text without shrinking controls', async () => {
  const { readFileSync } = await import('node:fs')
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const { fitListColumns } = await import('../../src/components/shared/list-column-sizing.mjs')
  const css = readFileSync(new URL('../../src/components/shared/data-table.module.css', import.meta.url), 'utf8').replace(/:global\(([^)]+)\)/g, '$1')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    for (const nameTag of ['a', 'button']) {
      await page.setContent(`<style>${css}*{box-sizing:border-box}.frame{width:640px;--table-column-gap:12px;--table-column-padding:0;--table-head-padding:0;--table-head-height:40px;--table-row-height:56px;--table-head-text-size:13px;--table-body-text-size:13px;font:13px sans-serif}.table{width:100%}th,td{font:inherit}.text{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.name{padding:0;border:0;max-width:100%;font:inherit;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.action{width:36px;flex:none}.state{width:70px;flex:none}</style><main><div class="frame" data-column-layout data-column-sizing="content"><table class="table"><thead><tr data-table-layout="columns"><th data-cell-grow>流入元名</th><th>補足</th><th>次の操作</th><th>件数</th><th>状態</th><th>操作</th></tr></thead><tbody><tr data-table-layout="columns"><td data-cell-grow><${nameTag} class="name" ${nameTag === 'a' ? 'href="#" data-row-link' : 'data-part="row-name"'} title="Google広告 夏キャンペーン">Google広告 夏キャンペーン</${nameTag}></td><td><span class="text" title="友だちになっても何も起きない">友だちになっても何も起きない</span></td><td><span class="text" title="初回のご案内メッセージを配信する">初回のご案内メッセージを配信する</span></td><td data-list-number>1,284件</td><td><button class="state">受付中</button></td><td><button class="action">…</button></td></tr></tbody></table></div></main>`)
      await page.locator('.frame').evaluate(fitListColumns)
      const good = await page.locator('tbody').evaluate(body => {
        const name = body.querySelector('.name'), range = document.createRange(); range.selectNodeContents(name)
        return { nameWidth: name.getBoundingClientRect().width, textWidth: range.getBoundingClientRect().width, controls: [...body.querySelectorAll('.state,.action')].map(button => ({width:button.getBoundingClientRect().width,room:button.closest('td').getBoundingClientRect().width})), overflow: document.documentElement.scrollWidth > innerWidth }
      })
      assert.ok(good.textWidth <= good.nameWidth, JSON.stringify({nameTag,good}))
      assert.ok(good.controls.every(button => button.width <= button.room))
      assert.equal(good.overflow, false)
    }
  } finally { await browser.close() }
})

test('supplemental note paragraphs may wrap while clipped notes and atomic labels still fail', async () => {
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const { collectShortText } = await import('./short-text-browser.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<main><span role="note" title="補足は複数行で読みます" style="display:block;width:60px">補足は複数行で読みます</span><span role="note" title="対象外 12 回" style="display:block;width:20px;overflow:hidden;white-space:nowrap">対象外 12 回</span><strong style="display:block;width:20px">10月1日</strong></main>')
    const records = await page.evaluate(collectShortText), findings = shortTextFindings(records)
    assert.ok(records.some(row => row.text === '補足は複数行で読みます' && row.lines > 1 && row.allowWrap))
    assert.equal(findings.some(row => row.text === '補足は複数行で読みます'), false)
    assert.ok(findings.some(row => row.text === '対象外 12 回' && row.clipped))
    assert.ok(findings.some(row => row.text === '10月1日' && row.lines > 1))
  } finally { await browser.close() }
})

test('split numeric text and units stay on one line after content columns are fitted', async () => {
  const { readFileSync } = await import('node:fs')
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const { collectShortText } = await import('./short-text-browser.mjs')
  const { fitListColumns } = await import('../../src/components/shared/list-column-sizing.mjs')
  const css = readFileSync(new URL('../../src/components/shared/data-table.module.css', import.meta.url), 'utf8').replace(/:global\(([^)]+)\)/g, '$1')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${css}*{box-sizing:border-box}.frame{width:640px;--table-column-gap:12px;--table-column-padding:0;--table-head-padding:0;--table-head-height:40px;--table-row-height:auto;--table-head-text-size:13px;--table-body-text-size:13px;font:13px sans-serif}.table{width:100%}th,td{font:inherit}.amount{font-variant-numeric:tabular-nums;letter-spacing:1px}</style><main><div class="frame" data-column-layout data-column-sizing="content"><table class="table"><thead><tr data-table-layout="columns"><th data-cell-grow>メニュー</th><th>時間</th><th>操作</th></tr></thead><tbody><tr data-table-layout="columns"><td data-cell-grow>初回相談</td><td data-list-number><span class="amount">105<!-- -->分</span></td><td><button>…</button></td></tr></tbody></table></div><strong style="display:block;width:20px">10<!-- -->月31<!-- -->日</strong></main>`)
    await page.locator('[data-list-number]').evaluate(cell => { cell.style.setProperty('--list-content-column-width', '20px'); cell.setAttribute('data-content-support-column', '') })
    assert.ok(shortTextFindings(await page.evaluate(collectShortText)).some(row => row.text === '105分' && row.lines > 1))
    assert.ok(shortTextFindings(await page.evaluate(collectShortText)).some(row => row.text === '10月31日' && row.lines > 1))
    await page.locator('strong').evaluate(el => { el.style.width = '160px' })
    await page.locator('.frame').evaluate(fitListColumns)
    assert.deepEqual(shortTextFindings(await page.evaluate(collectShortText)), [])
    const measurement = await page.locator('.amount').evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el)
      return { textWidth: range.getBoundingClientRect().width, cellWidth: el.closest('td').getBoundingClientRect().width }
    })
    assert.ok(measurement.textWidth <= measurement.cellWidth, JSON.stringify(measurement))
  } finally { await browser.close() }
})

test('reservation toolbar keeps date and controls inside its own column at both widths', async () => {
  const { readFileSync } = await import('node:fs')
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const css = readFileSync(new URL('../../src/components/shared/reservation-board.module.css', import.meta.url), 'utf8')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    for (const width of [840, 1140]) {
      await page.setContent(`<style>:root{--space-6:6px;--tpl-toolbar-gap:8px;--radius-md:12px;--color-border:#ddd;--color-canvas:#fff}${css}*{box-sizing:border-box}.board{width:${width}px}.toolbar{font:14px sans-serif}.toolbar button{flex-shrink:0;white-space:nowrap;padding:8px 12px}.axis{width:320px;flex-shrink:0}.select{width:148px}</style><main><div class="board" data-kind="people"><div class="toolbar" data-control-row><button>前へ</button><strong>10月26日〜11月1日</strong><button>次へ</button><button>今日</button><div class="axis">時間×スタッフ　一覧　月</div><button class="select">担当：すべて</button><button class="select">予約元：すべて</button><button>印刷</button></div></div></main>`)
      const outside = () => page.locator('[data-control-row]').evaluate(row => {
        const box = row.getBoundingClientRect()
        return [...row.children].filter(el => { const child = el.getBoundingClientRect(); return child.left < box.left || child.right > box.right }).map(el => el.textContent)
      })
      assert.deepEqual(await outside(), [], `toolbar width ${width}`)
      if (width === 840) {
        await page.locator('[data-control-row]').evaluate(row => { row.style.flexWrap = 'nowrap' })
        assert.ok((await outside()).length > 0, 'the former nowrap rule must reproduce the overflow')
        await page.locator('[data-control-row]').evaluate(row => { row.style.removeProperty('flex-wrap') })
        assert.deepEqual(await outside(), [])
      }
    }
  } finally { await browser.close() }
})

test('an entity selector cannot extend into the adjacent checkbox hit area', async () => {
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const { collectShortText } = await import('./short-text-browser.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<main style="display:flex;gap:8px"><span id="wrapper" style="width:176px;flex:none"><button data-entity-picker-field style="width:192px;height:36px">Account</button></span><label><input type="checkbox">Multiple accounts</label></main>')
    assert.ok(shortTextFindings(await page.evaluate(collectShortText)).some(row => row.overlap === 'checkbox'))
    await page.locator('#wrapper').evaluate(wrapper => { wrapper.style.width = '192px' })
    assert.deepEqual(shortTextFindings(await page.evaluate(collectShortText)), [])
  } finally { await browser.close() }
})

test('content sizing combines split block labels and preserves short auxiliary text beside long names', async () => {
  const { readFileSync } = await import('node:fs')
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const { collectShortText } = await import('./short-text-browser.mjs')
  const { fitListColumns } = await import('../../src/components/shared/list-column-sizing.mjs')
  const css = readFileSync(new URL('../../src/components/shared/data-table.module.css', import.meta.url), 'utf8').replace(/:global\(([^)]+)\)/g, '$1')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    for (const width of [640, 920]) {
      await page.setContent(`<style>${css}*{box-sizing:border-box}.frame{width:${width}px;--table-column-gap:12px;--table-column-padding:0;--table-head-padding:0;--table-head-height:40px;--table-row-height:auto;--table-head-text-size:13px;--table-body-text-size:13px;font:13px sans-serif}.table{width:100%}th,td{font:inherit}.sub{display:block}.long{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:100%}</style><main><div class="frame" data-shared-part="list-table" data-column-layout data-column-sizing="content"><table class="table"><thead><tr data-table-layout="columns"><th data-cell-grow>名前</th><th>担当</th><th>接続</th><th>件数</th><th>操作</th></tr></thead><tbody><tr data-table-layout="columns"><td data-cell-grow><a href="#" data-row-link class="long" title="長い名前を省略しても短い補助の項目を押しつぶさないことを確かめる">長い名前を省略しても短い補助の項目を押しつぶさないことを確かめる</a><span class="long">長い説明が何段分もあっても短い文字の幅を先に確保するための見本です</span></td><td><span class="sub">佐々木・高田</span></td><td><span class="sub">ログイン：<!-- -->ひも付けなし</span></td><td data-list-number>12<!-- -->件</td><td><button>…</button></td></tr></tbody></table></div></main>`)
      await page.locator('td:nth-child(3)').evaluate(cell => { cell.setAttribute('data-content-support-column', ''); cell.style.setProperty('--list-content-column-width', '72px') })
      assert.ok(shortTextFindings(await page.evaluate(collectShortText)).some(row => row.text === 'ログイン：ひも付けなし' && row.lines > 1))
      await page.locator('.frame').evaluate(fitListColumns)
      assert.deepEqual(shortTextFindings(await page.evaluate(collectShortText)), [])
      const measurements = await page.locator('tbody td:not(:first-child)').evaluateAll(cells => cells.map(cell => ({width:cell.getBoundingClientRect().width, text:cell.textContent})))
      assert.ok(measurements.every(cell => cell.width > 0))
    }
  } finally { await browser.close() }
})

test('short table cell labels cannot overflow into their neighbours even when overflow is visible', async () => {
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const { collectShortText } = await import('./short-text-browser.mjs')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<main><div data-shared-part="list-table" role="table"><div role="row"><span role="cell" style="display:block;width:20px;white-space:nowrap">Connected account</span></div></div></main>')
    assert.ok(shortTextFindings(await page.evaluate(collectShortText)).some(row => row.clipped && row.clipper === 'CELL'))
    await page.locator('[role="cell"]').evaluate(cell => { cell.style.width = '240px' })
    assert.deepEqual(shortTextFindings(await page.evaluate(collectShortText)), [])
  } finally { await browser.close() }
})

test('short labels remain measurable when a badge shrinks its inner text to zero width', async () => {
  const { readFileSync } = await import('node:fs')
  const { connectGuardBrowser } = await import('./browser-session.mjs')
  const { collectShortText } = await import('./short-text-browser.mjs')
  const { fitListColumns } = await import('../../src/components/shared/list-column-sizing.mjs')
  const css = readFileSync(new URL('../../src/components/shared/data-table.module.css', import.meta.url), 'utf8').replace(/:global\(([^)]+)\)/g, '$1')
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>${css}*{box-sizing:border-box}.frame{width:640px;--table-column-gap:12px;--table-column-padding:0;--table-head-padding:0;--table-head-height:40px;--table-row-height:auto;--table-head-text-size:13px;--table-body-text-size:13px;font:13px sans-serif}.table{width:100%}th,td{font:inherit}.name{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.badge{display:inline-flex;align-items:center;gap:8px;padding:4px 8px;max-width:100%}.badge:before{content:'';width:6px;height:6px;flex:none;background:green}.label{display:block;min-width:0;overflow:hidden;white-space:nowrap}</style><main><div class="frame" data-shared-part="list-table" data-column-layout data-column-sizing="content"><table class="table"><thead><tr class="row" data-table-layout="columns"><th class="headCell" data-cell-grow>名前</th><th class="headCell">状態</th><th class="headCell">操作</th></tr></thead><tbody><tr class="row" data-table-layout="columns"><td class="bodyCell" data-cell-grow><a data-row-link class="name" href="#" title="長い名前でも状態を色の点だけにしないことを確かめます">長い名前でも状態を色の点だけにしないことを確かめます</a></td><td class="bodyCell"><span class="badge"><span class="label">計測済</span></span></td><td class="bodyCell"><button>…</button></td></tr></tbody></table></div></main>`)
    await page.locator('tbody td:nth-child(2)').evaluate(cell => { cell.setAttribute('data-content-support-column', ''); cell.style.setProperty('--list-content-column-width', '24px') })
    assert.equal(await page.locator('.label').evaluate(el => el.getBoundingClientRect().width), 0)
    assert.ok(shortTextFindings(await page.evaluate(collectShortText)).some(row => row.text === '計測済' && row.clipped))
    await page.locator('.frame').evaluate(fitListColumns)
    assert.deepEqual(shortTextFindings(await page.evaluate(collectShortText)), [])
    assert.ok(await page.locator('.label').evaluate(el => el.clientWidth >= el.scrollWidth && el.clientWidth > 0))
  } finally { await browser.close() }
})
