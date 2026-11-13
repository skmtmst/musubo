import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import scanLayoutDefects from './layout-defects-browser.mjs'
import scanControlOverlap from './control-overlap-browser.mjs'
import { scanLayoutOverflow } from './layout-overflow.mjs'
import { connectGuardBrowser } from './browser-session.mjs'

const require = createRequire(import.meta.url)
const fromVitest = createRequire(require.resolve('vitest/package.json'))
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')

const webRoot = fileURLToPath(new URL('../..', import.meta.url))
const sheets = new Set()
const compiled = await build({
  stdin: { resolveDir: webRoot, loader: 'tsx', contents: `
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {EntityPickerField} from './src/components/shared/entity-picker';
    import {Field} from './src/components/shared/form-controls';
    import Notice from './src/components/shared/notice';
    import Button from './src/components/shared/button';
    import Select from './src/components/shared/select';
    import TruncatedText from './src/components/shared/truncated-text';
    import {DataTable,TableHeadRow,Th,Tr,Td} from './src/components/shared/table';
    import compareStyles from './src/v8/friends/compare/compare.module.css';
    import SurfaceLayoutFixture from './scripts/v8-guard/surface-layout-fixture';

    function Fixture(){const [value,setValue]=useState('one');
      if(window.comparisonFixture)return <main id="comparison-fixture"><DataTable><colgroup><col className={compareStyles.colItem}/><col/><col/><col className={compareStyles.colUse}/></colgroup><thead><TableHeadRow presentation="embedded">{['項目','候補A','候補B','使う値'].map(label=><Th key={label}>{label}</Th>)}</TableHeadRow></thead><tbody>{[
        ['LINE表示名','見本 161','見本 171','画面確認アカウント・見本 161：見本 161'],
        ['メール','ta***@example.com','ta***@example.com','画面確認アカウント・見本 161：ta***@example.com'],
        ['ステータスメッセージ','予約受付中','受付中','A：予約受付中'],
        ['last_purchase_date','2026-10-01','2026-10-02','A：2026-10-01'],
        ['a'.repeat(100),'登録済み','登録なし','A：登録済み'],
      ].map(([label,left,right,choice])=><Tr key={label}><Td><TruncatedText className={compareStyles.itemName} value={label}/></Td><Td>{left}</Td><Td>{right}</Td><Td><Select aria-label={label+'に使う値'} size="full" value="left" onChange={()=>{}} options={[{value:'left',label:choice}]}/></Td></Tr>)}</tbody></DataTable></main>;
      if(window.noticeFixture)return <main id="notice-fixtures">{['body','heading','compact','compact-info','help','danger','success'].flatMap(kind=>['action','close','none'].map(operation=><Notice key={kind+operation} data-notice-fixture={kind} tone={kind==='compact-info'?'info':kind==='danger'?'danger':kind==='success'?'success':'warn'} compact={kind.startsWith('compact')} title={kind==='compact-info'?'長い案内の全文':undefined} heading={kind==='heading'||kind==='help'?<>保存の状態を確認してください。長い題が折り返しても最初の行に点をそろえます。</>:undefined} help={kind==='help'?'確認する内容の説明':undefined} action={operation==='action'?<Button>内容を見る</Button>:undefined} onClose={operation==='close'?()=>{}:undefined}>{kind==='body'?<p>一覧を読み直してください。文章が長い時も最初の文字に点をそろえて表示します。</p>:kind==='compact-info'?'長い案内の内容をここに表示します。全文は省略しても確認できます。表示しきれない時だけ省略します。':'入力は残っています。'}</Notice>))}</main>;
      if(window.surfaceFixture)return <main><SurfaceLayoutFixture/></main>;
      return <main>
        <section id="controls"><EntityPickerField label="使うテンプレート" noun="テンプレート" value={value} onChange={setValue} items={[{id:'one',name:'予約案内'},{id:'two',name:'来店のお礼'}]}/>
          <EntityPickerField label="空の選択" noun="テンプレート" value="" onChange={()=>{}} items={[]}/>
          {[undefined,'compact','input'].map((density,i)=><Field key={i} label={'名前'+i} htmlFor={'name'+i} density={density} required note="入力値を保持"><input id={'name'+i} defaultValue="保存前の内容"/></Field>)}
        </section>
      </main>;
    }createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  tsconfig: `${webRoot}/tsconfig.json`, define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1:8788"' },
  plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }))
    b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'navigation'
      ? 'export const useRouter=()=>({push(){},replace(){},prefetch(){}});export const usePathname=()=>"/fixture";export const useSearchParams=()=>new URLSearchParams();'
      : 'import React from "react";export default function Link(p){return React.createElement("a",p)}', resolveDir: webRoot }))
    b.onLoad({ filter: /\.module\.css$/ }, args => {
      let css = readFileSync(args.path, 'utf8')
      const globals = []
      css = css.replace(/:global\(([^()]*)\)/g, (_, selector) => `GLOBAL_SELECTOR_${globals.push(selector) - 1}`)
      const names = Object.fromEntries([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => [m[1], m[1]]))
      const prefix = `fixture_${sheets.size}_`
      for (const name of Object.keys(names)) names[name] = prefix + name
      css = css.replace(/\.([A-Za-z][\w-]*)/g, (_, name) => `.${names[name]}`)
        .replace(/GLOBAL_SELECTOR_(\d+)/g, (_, index) => globals[Number(index)])
      sheets.add(css)
      return { contents: `export default ${JSON.stringify(names)}`, loader: 'js' }
    })
    b.onLoad({ filter: /\.css$/ }, args => { sheets.add(readFileSync(args.path, 'utf8')); return { contents: '', loader: 'js' } })
  } }],
})
const globals = readFileSync(new URL('../../src/app/globals.css', import.meta.url), 'utf8').replace(/@theme\s*\{/g, ':root {')
const css = [globals, ...sheets].join('\n').replace(/:global\(([^()]*)\)/g, '$1')

/** 点は知らせ全体ではなく、題（無い時は本文）の最初の文字にそろえる。 */
function noticeDotOffsets(notices) {
  return notices.map(notice => {
    const dot = notice.querySelector('[data-notice-dot]').getBoundingClientRect()
    const content = notice.querySelector('[data-notice-heading]') ?? notice.querySelector('[data-notice-message]')
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    let text
    while ((text = walker.nextNode()) && !text.textContent.trim()) { /* 最初の文字まで進む。 */ }
    if (!text) throw new Error('知らせの最初の文字がありません')
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 1)
    const first = range.getBoundingClientRect()
    return { offset: Math.abs(dot.top + dot.height / 2 - first.top - first.height / 2), width: dot.width, height: dot.height }
  })
}

for (const width of [1152, 1440]) test(`知らせの点は題・本文の1行目にそろう（操作・閉じる・小さい帯・説明付き、${width}px）`, async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width, height: 1800 } })
    await page.setContent(`<html data-theme="v8"><style>${css}@layer base{*{box-sizing:border-box;margin:0}}#notice-fixtures{width:420px;margin:24px auto}</style><div id="root"></div></html>`)
    await page.evaluate(() => { window.noticeFixture = true })
    await page.addScriptTag({ content: compiled.outputFiles[0].text })
    const notices = page.locator('#notice-fixtures [data-design-part="notice"]')
    await notices.last().waitFor()
    const measure = () => notices.evaluateAll(noticeDotOffsets)
    const assertAligned = rows => {
      assert.equal(rows.length, 21)
      assert.ok(rows.every(row => row.offset <= 1 && row.width === 8 && row.height === 8), JSON.stringify(rows))
    }
    assertAligned(await measure())
    const colorPairs = await notices.evaluateAll(nodes => nodes.map(node => {
      const tokens = { warn: '--color-status-warn', danger: '--color-status-danger', info: '--color-status-info', success: '--color-success' }
      const probe = document.createElement('span')
      probe.style.cssText = `position:fixed;color:var(${tokens[node.dataset.tone]})`
      document.body.append(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      return { actual: getComputedStyle(node.querySelector('[data-notice-dot]')).backgroundColor, expected }
    }))
    assert.ok(colorPairs.every(pair => pair.actual === pair.expected), JSON.stringify(colorPairs))
    const compact = await page.locator('[data-notice-fixture="compact"], [data-notice-fixture="compact-info"]').evaluateAll(nodes => nodes.map(node => ({
      kind: node.dataset.noticeFixture, close: !!node.querySelector('[aria-label="通知を閉じる"]'),
      action: !!node.querySelector('[data-shared-button]'), height: node.getBoundingClientRect().height,
      cut: node.querySelector('[data-notice-message]').scrollWidth > node.querySelector('[data-notice-message]').clientWidth,
      whiteSpace: getComputedStyle(node.querySelector('[data-notice-message]')).whiteSpace,
      title: node.title,
    })))
    for (const row of compact.filter(row => !row.action)) assert.equal(row.height, 36, JSON.stringify(row))
    for (const row of compact.filter(row => row.kind === 'compact-info')) {
      assert.equal(row.whiteSpace, 'nowrap')
      assert.ok(row.cut && row.title, JSON.stringify(row))
    }
    await notices.first().locator('[data-notice-dot]').evaluate(dot => { dot.style.transform = 'translateY(2px)' })
    const broken = await measure()
    assert.throws(() => assertAligned(broken))
    assert.ok(broken.some(row => row.offset > 1))
    await notices.first().locator('[data-notice-dot]').evaluate(dot => dot.style.removeProperty('transform'))
    assertAligned(await measure())
  } finally { await browser.close() }
})

test('選択窓をキャンセルしても、別の入力欄に入れた内容を保つ', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    for (const width of [1440,1152,1920]) {
      await page.setViewportSize({width,height:1128})
      await page.setContent(`<html data-theme="v8"><style>${css}*{box-sizing:border-box}body{margin:0}main{width:80vw;margin:1em auto}input{width:100%}</style><div id="root"></div></html>`)
      await page.addScriptTag({content:compiled.outputFiles[0].text})
      await page.getByRole('button',{name:'使うテンプレート：変える'}).click()
      const dialog=page.getByRole('dialog',{name:'テンプレートを選ぶ'})
      await dialog.waitFor();await dialog.getByRole('button',{name:'キャンセル',exact:true}).click()
      for(const input of await page.locator('#controls input').all())assert.equal(await input.inputValue(),'保存前の内容')

    }
  } finally { await browser.close() }
})

// globals.css の @import は展開しないため、Tailwind Preflight の余白リセットも再現する。
async function openSurfaces(page, width) {
  await page.setViewportSize({ width, height: 1128 })
  await page.setContent(`<html data-theme="v8"><style>${css}*{box-sizing:border-box;margin:0}body{margin:0}main{width:calc(100vw - 276px);margin:0 auto}main>section{margin-bottom:24px}</style><div id="root"></div></html>`)
  await page.evaluate(() => { window.surfaceFixture = true })
  await page.addScriptTag({ content: compiled.outputFiles[0].text })
  await page.locator('#flat').waitFor()
  await page.evaluate(() => document.fonts.ready)
}

/** カードに見える線（border・outline・外側の1pxの影）を拾う。入れ子の内側の面（inset・muted・ring・danger）は数えない。 */
function cardEdgeIssues(cards) {
  const visible = color => color !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(color)
  return cards.flatMap(card => {
    if (card.matches('[data-card-surface="inset"], [data-card-surface="muted"], [data-card-surface="danger"], [data-card-frame="ring"]')) return []
    const style = getComputedStyle(card)
    const issues = []
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      if (parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none' && visible(style[`border${side}Color`])) issues.push(`border-${side.toLowerCase()}`)
    }
    if (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none' && visible(style.outlineColor)) issues.push('outline')
    // 外側の 0 0 0 1px は線に見える。色が透明なら数えない。内側（inset）の線は入れ子の面だけが持つ。
    for (const layer of style.boxShadow.split(/,(?![^(]*\))/)) {
      if (/^\s*(?:rgba?\([^)]*\)\s*)?0px 0px 0px 1px/.test(layer) && !/inset/.test(layer) && visible((layer.match(/rgba?\([^)]*\)/) ?? ['transparent'])[0])) issues.push('1px shadow edge')
    }
    return issues.length ? [`${card.id || card.className}: ${issues.join(' ')}`] : []
  })
}

/** 見出し・段・道具は製品の型が描く。画面固有のAPIや文言はこの検査の対象外。 */
function surfaceDistances() {
  const distance = (from, to) => Math.round((to.getBoundingClientRect().top - from.getBoundingClientRect().bottom) * 100) / 100
  const firstTool = id => document.querySelector(`#${id} [data-template-region="toolbar"]`).firstElementChild
  const title = id => document.querySelector(`#${id} [data-template-region="heading"] h1`)
  const step = id => document.querySelector(`#${id} [data-template-region="steps"]`)
  const content = id => document.querySelector(`#${id} [data-template-region="content"] [data-design-part="card"]`)
  const folders = document.querySelector('#common-vars [data-template-region="folders"]')
  return {
    hq: distance(title('hq'), firstTool('hq')),
    contents: distance(firstTool('contents'), content('contents')),
    banners: distance(firstTool('banners'), content('banners')),
    'common-vars': folders.offsetWidth ? distance(folders.firstElementChild, folders.lastElementChild) : null,
    'reminder-detail': distance(document.querySelector('#reminder-detail [data-template-region="heading"] p'), document.querySelector('#reminder-detail [data-template-region="heading-tabs"]')),
    ...Object.fromEntries(['auto-reply','reminder','hq-broadcast','scenario','rich-menu'].map(id => [id, distance(title(id), step(id))])),
  }
}

for (const width of [1440, 1152]) test(`共通の面と10画面の型は${width}pxで余白が重ならず、はみ出し・重なりがない`, async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await openSurfaces(page, width)
    const distances = await page.evaluate(surfaceDistances)
    console.log(JSON.stringify({ width, distances }))
    assert.deepEqual(distances, { hq: 8, contents: 14, banners: 14, 'common-vars': width === 1440 ? 8 : null, 'reminder-detail': 6, 'auto-reply': 8, reminder: 8, 'hq-broadcast': 2, scenario: 8, 'rich-menu': 8 })
    for (const id of ['contents', 'banners']) {
      const gap = await page.locator('#' + id).evaluate(el => el.querySelector('[data-template-region="toolbar"]').firstElementChild.getBoundingClientRect().top - el.querySelector('h1').getBoundingClientRect().bottom)
      assert.equal(gap, 8)
    }
    const sectionGaps = await page.evaluate(() => {
      const tools = document.querySelector('#section-with-tools [data-template-region="toolbar"]')
      const text = document.querySelector('#section-with-tools [data-template-region="content"] p')
      const noTools = document.querySelector('#section-without-tools')
      return [text.getBoundingClientRect().top - tools.firstElementChild.getBoundingClientRect().bottom,
        noTools.querySelector('p').getBoundingClientRect().top - noTools.querySelector('h1, h2').getBoundingClientRect().bottom,
        document.querySelector('#section-with-tools [data-page-template]').getBoundingClientRect().bottom - text.getBoundingClientRect().bottom]
    })
    assert.deepEqual(sectionGaps, [14, 8, 24])
    // カードは1つの定義（白地＋影だけ・線なし）。平らなカードは無く、どの口から作っても同じ影になる。
    assert.deepEqual(await page.locator('[data-design-part="card"]').evaluateAll(cardEdgeIssues), [])
    const raised = await page.locator('#raised').evaluate(el => ({ shadow: getComputedStyle(el).boxShadow, padding: getComputedStyle(el).padding }))
    assert.notEqual(raised.shadow, 'none')
    assert.equal(await page.locator('#flat').evaluate(el => getComputedStyle(el).padding), raised.padding)
    assert.equal(await page.locator('#raised').evaluate(el => el.getBoundingClientRect().height), await page.locator('#flat').evaluate(el => el.getBoundingClientRect().height))
    for (const id of ['flat', 'flat-form', 'flat-bordered', 'flat-outlined', 'selected-flat']) {
      assert.equal(await page.locator('#' + id).evaluate(el => getComputedStyle(el).boxShadow), raised.shadow, id)
    }
    // 入れ子の内側の面だけは影を持たず、内側の細い線で分ける。
    assert.notEqual(await page.locator('#flat-inset').evaluate(el => getComputedStyle(el).boxShadow), raised.shadow)
    const fonts = await page.locator('#surfaces [data-part="create-summary"] dd').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).fontWeight))
    // 要約の値は 14px 以下の UI 文字なので 500（太字の 600 にはしない）。
    assert.deepEqual(fonts, ['500', '500'])
    for (const th of await page.locator('thead th').all()) assert.equal(await th.evaluate(el => getComputedStyle(el).fontWeight), '500')
    const heading = await page.locator('#hq h1').evaluate(el => {
      const style = getComputedStyle(el)
      return { size: style.fontSize, weight: style.fontWeight }
    })
    assert.deepEqual(heading, { size: '32px', weight: '600' })
    const iconColor = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-ink-secondary').trim())
    // 色の表記（hex/rgb）を同じ実CSSの計算結果へそろえて比較する。
    const neutral = await page.evaluate(color => { const el = document.createElement('span'); el.style.color = color; document.body.append(el); const result = getComputedStyle(el).color; el.remove(); return result }, iconColor)
    for (const target of ['[data-avatar="initials"]', '[data-avatar="icon"]', '[data-media-thumbnail]', '[data-dialog-choice-cards] a > span:first-child']) {
      assert.equal(await page.locator('#surfaces ' + target).evaluate(el => getComputedStyle(el).color), neutral, target)
    }
    assert.notEqual(await page.locator('#selected-flat').evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('#flat').evaluate(el => getComputedStyle(el).backgroundColor))
    assert.equal(await page.locator('#surfaces button').evaluate(el => getComputedStyle(el).fontWeight), '600')
    assert.notEqual(await page.locator('#surfaces button').evaluate(el => getComputedStyle(el).backgroundColor), await page.locator('#flat').evaluate(el => getComputedStyle(el).backgroundColor))
    assert.deepEqual(await page.evaluate(scanLayoutDefects), [])
    assert.deepEqual(await page.evaluate(scanControlOverlap), [])
    assert.deepEqual(await page.evaluate(scanLayoutOverflow), { pageX: false, overflow: [], outOfMain: [], noTitle: [], accountName: [], narrowColumn: [], cutAlert: [] })
  } finally { await browser.close() }
})

test('詳細タブに子の余白を戻す故障を実寸で見つけ、復元後に通る', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await openSurfaces(page, 1440)
    const tabs = page.locator('#reminder-detail [data-template-region="heading-tabs"]')
    assert.equal((await page.evaluate(surfaceDistances))['reminder-detail'], 6)
    await tabs.evaluate(el => { el.style.marginTop = '8px' })
    const broken = await page.evaluate(surfaceDistances)
    assert.throws(() => assert.equal(broken['reminder-detail'], 6))
    assert.equal(broken['reminder-detail'], 14)
    await tabs.evaluate(el => el.style.removeProperty('margin-top'))
    assert.equal((await page.evaluate(surfaceDistances))['reminder-detail'], 6)
  } finally { await browser.close() }
})

test('題の下へ古い余白を戻す故障を実寸で見つけ、復元後に通る', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await openSurfaces(page, 1440)
    const toolbar = page.locator('#hq [data-template-region="toolbar"]')
    assert.equal((await page.evaluate(surfaceDistances)).hq, 8)
    await toolbar.evaluate(el => { el.style.marginTop = '8px' })
    const broken = await page.evaluate(surfaceDistances)
    assert.equal(broken.hq, 16)
    assert.throws(() => assert.equal(broken.hq, 8))
    await toolbar.evaluate(el => el.style.removeProperty('margin-top'))
    assert.equal((await page.evaluate(surfaceDistances)).hq, 8)
  } finally { await browser.close() }
})

test('カードの影へ1pxの線を戻す故障を実寸で見つけ、元に戻すと通る', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await openSurfaces(page, 1440)
    const cards = page.locator('[data-design-part="card"]')
    assert.deepEqual(await cards.evaluateAll(cardEdgeIssues), [])
    const original = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--card-shadow'))
    await page.evaluate(() => document.documentElement.style.setProperty('--card-shadow', '0 0 0 1px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(16, 24, 40, 0.06)'))
    const broken = await cards.evaluateAll(cardEdgeIssues)
    assert.ok(broken.some(issue => issue.includes('1px shadow edge')), JSON.stringify(broken))
    await page.evaluate(() => document.documentElement.style.removeProperty('--card-shadow'))
    await page.evaluate(() => { document.querySelector('#raised').style.outline = '1px solid #c9ced6' })
    assert.ok((await cards.evaluateAll(cardEdgeIssues)).some(issue => issue.startsWith('raised: ') && issue.includes('outline')))
    await page.evaluate(() => document.querySelector('#raised').style.removeProperty('outline'))
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--card-shadow')), original)
    assert.deepEqual(await cards.evaluateAll(cardEdgeIssues), [])
  } finally { await browser.close() }
})

// 実画面の1152幅で表は802px、1440幅で1090px。共有の表・選ぶ欄と、画面のcolgroupの定義をそのまま使う。
for (const width of [1152, 1440]) test(`比較の使う値は出所・名前・値を保ち、省略する前に列の空きを配る（${width}px）`, async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.setContent(`<html lang="ja" data-theme="v8"><style>${css}@layer base{*{box-sizing:border-box;margin:0}body{font-family:Arial,sans-serif;font-size:13px}}#comparison-fixture{width:calc(100vw - 350px);margin:24px auto}</style><div id="root"></div></html>`)
    await page.evaluate(() => { window.comparisonFixture = true })
    await page.addScriptTag({ content: compiled.outputFiles[0].text })
    await page.locator('#comparison-fixture [data-select-value]').last().waitFor()
    const check = async () => {
      const measured = await page.locator('#comparison-fixture').evaluate(root => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        values: [...root.querySelectorAll('[data-select-value]')].map(value => ({ text: value.textContent, title: value.title, client: value.clientWidth, scroll: value.scrollWidth })),
        cells: [...root.querySelectorAll('td')].map(cell => ({ client: cell.clientWidth, scroll: cell.scrollWidth })),
        labels: [...root.querySelectorAll('tbody tr td:first-child [data-truncated-text]')].map(label => { const range = document.createRange(); range.selectNodeContents(label); const style = getComputedStyle(label); return { text: label.textContent, title: label.title, lines: new Set([...range.getClientRects()].map(rect => rect.top)).size, whiteSpace: style.whiteSpace, ellipsis: style.textOverflow, client: label.clientWidth, scroll: label.scrollWidth } }),
      }))
      assert.equal(measured.overflow, false, JSON.stringify(measured))
      assert.equal(measured.values.length, 5)
      for (const value of measured.values) {
        assert.equal(value.text, value.title)
        assert.ok(value.scroll <= value.client, `comparison value cut: ${JSON.stringify(value)}`)
      }
      assert.ok(measured.cells.every(cell => cell.scroll <= cell.client + 1), JSON.stringify(measured.cells))
      assert.equal(measured.labels.length, 5)
      assert.ok(measured.labels.some(label => label.text === 'ステータスメッセージ'))
      assert.ok(measured.labels.some(label => label.text.length === 100))
      for (const label of measured.labels) {
        assert.equal(label.lines, 1, JSON.stringify(label))
        assert.equal(label.title, label.text)
        assert.equal(label.whiteSpace, 'nowrap')
        assert.equal(label.ellipsis, 'ellipsis')
        if (width === 1440 && label.text === 'ステータスメッセージ') assert.ok(label.scroll <= label.client, `comparison item cut: ${JSON.stringify(label)}`)
      }
    }
    await check()
    await page.evaluate(() => document.documentElement.style.setProperty('--tpl-fr-cmp-col-use', '208px'))
    await assert.rejects(check, /comparison value cut:/)
    await page.evaluate(() => document.documentElement.style.removeProperty('--tpl-fr-cmp-col-use'))
    await check()
    if (width === 1440) {
      await page.evaluate(() => document.documentElement.style.setProperty('--tpl-fr-cmp-col-item', '112px'))
      await assert.rejects(check, /comparison item cut:.*ステータスメッセージ/)
      await page.evaluate(() => document.documentElement.style.removeProperty('--tpl-fr-cmp-col-item'))
      await check()
    }
  } finally { await browser.close() }
})
