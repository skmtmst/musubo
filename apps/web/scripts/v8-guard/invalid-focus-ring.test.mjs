import test from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connectGuardBrowser } from './browser-session.mjs'
import { compileUiStyles } from './compile-ui-styles.mjs'
const require = createRequire(import.meta.url)
const fromVitest = createRequire(require.resolve('vitest/package.json'))
const { PNG } = require('pngjs')
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')
const webRoot = fileURLToPath(new URL('../..', import.meta.url))
const sheets = []
const compiled = await build({
 stdin: {resolveDir:webRoot,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {TextField,TextArea} from './src/components/shared/text-field';
import Select from './src/components/shared/select';
import DateField from './src/components/shared/date-field';
import SearchField from './src/components/shared/search-field';
import Checkbox from './src/components/shared/checkbox';
import OtpInput from './src/components/shared/otp-input';
import InsertTextField from './src/components/shared/insert-text-field';
import Combobox from './src/components/shared/combobox';
import MultiSelect from './src/components/shared/multi-select';
import {EntityPickerSummary} from './src/components/shared/entity-picker';
import {TimeField} from './src/components/shared/date-time-field';
import TagPickerField from './src/components/shared/tag-picker-field';
import CheckCard from './src/components/shared/check-card';
import FileDropzone from './src/components/shared/file-drop';
import MediaSlot from './src/components/shared/media-slot';
import fsStyles from './src/components/shared/folder-select.module.css';
function Case({id,expect,ring,children}){return <div data-case={id} data-expect={expect} data-ring={ring} style={{margin:'8px 0',padding:'8px'}}>{children}</div>}
function Fixture(){return <main>
<Case id="tf-ok" expect="blue" ring="self"><TextField aria-label="姓" value="" onChange={()=>{}} /></Case>
<Case id="tf-bad" expect="red" ring="self"><TextField aria-label="名" value="" onChange={()=>{}} invalid /></Case>
<Case id="ta-ok" expect="blue" ring="self"><TextArea aria-label="備考" value="" onChange={()=>{}} /></Case>
<Case id="ta-bad" expect="red" ring="self"><TextArea aria-label="詳細" value="" onChange={()=>{}} invalid /></Case>
<Case id="sel-ok" expect="blue" ring="self"><Select aria-label="都道府県" value="tokyo" options={[{value:'tokyo',label:'東京'}]} onChange={()=>{}} /></Case>
<Case id="sel-bad" expect="red" ring="self"><Select aria-label="市区" value="x" options={[{value:'x',label:'渋谷'}]} onChange={()=>{}} invalid /></Case>
<Case id="date-ok" expect="blue" ring="self"><DateField value="" onChange={()=>{}} aria-label="開始日" /></Case>
<Case id="date-bad" expect="red" ring="self"><DateField value="" onChange={()=>{}} aria-label="終了日" invalid /></Case>
<Case id="search-ok" expect="blue" ring="search"><SearchField aria-label="探す" value="" onChange={()=>{}} /></Case>
<Case id="search-bad" expect="red" ring="search"><SearchField aria-label="絞る" value="" onChange={()=>{}} aria-invalid="true" /></Case>
<Case id="check-ok" expect="blue" ring="check"><Checkbox checked={false} onCheckedChange={()=>{}}>同意する</Checkbox></Case>
<Case id="check-bad" expect="red" ring="check"><Checkbox checked={false} onCheckedChange={()=>{}} invalid>確認した</Checkbox></Case>
<Case id="combo-ok" expect="blue" ring="combo"><Combobox aria-label="品目" options={[{value:'a',label:'あ'}]} value="" onChange={()=>{}} /></Case>
<Case id="combo-bad" expect="red" ring="combo"><Combobox aria-label="数量" options={[{value:'a',label:'あ'}]} value="" onChange={()=>{}} error="選んでください" /></Case>
<Case id="multi-ok" expect="blue" ring="combo"><MultiSelect aria-label="候補を複数選ぶ" options={[{value:'a',label:'あ'}]} values={[]} onChange={()=>{}} /></Case>
<Case id="multi-bad" expect="red" ring="combo"><MultiSelect aria-label="候補を選び直す" options={[{value:'a',label:'あ'}]} values={[]} onChange={()=>{}} error="選んでください" /></Case>
<Case id="entity-ok" expect="blue" ring="combo"><EntityPickerSummary label="送り先" noun="送り先" onOpen={()=>{}} /></Case>
<Case id="entity-bad" expect="red" ring="combo"><EntityPickerSummary label="送り先誤" noun="送り先" onOpen={()=>{}} invalid /></Case>
<Case id="time-ok" expect="blue" ring="combo"><TimeField aria-label="送る時刻" value="10:00" onChange={()=>{}} /></Case>
<Case id="time-bad" expect="red" ring="combo"><TimeField aria-label="送る時刻誤" value="10:00" onChange={()=>{}} invalid /></Case>
<Case id="raw-ok" expect="blue" ring="self"><input type="password" aria-label="パスワード" /></Case>
<Case id="raw-bad" expect="red" ring="self"><input type="password" aria-label="パスワード誤" aria-invalid="true" /></Case>
<Case id="tag-ok" expect="blue" ring="self"><TagPickerField label="札付け" value={[]} onChange={()=>{}} options={[{id:'t',name:'検'}]} accountId={null} /></Case>
<Case id="tag-bad" expect="red" ring="self"><TagPickerField label="札直し" value={[]} onChange={()=>{}} options={[{id:'t',name:'検'}]} accountId={null} invalid /></Case>
<Case id="card-ok" expect="blue" ring="card"><CheckCard checked={false} onChange={()=>{}} title="送る" /></Case>
<Case id="card-bad" expect="red" ring="card"><CheckCard checked={false} onChange={()=>{}} title="止める" invalid /></Case>
<Case id="cardwindow-ok" expect="blue" ring="card"><div data-window-body><CheckCard checked={false} onChange={()=>{}} title="窓で送る" /></div></Case>
<Case id="cardwindow-bad" expect="red" ring="card"><div data-window-body><CheckCard checked={false} onChange={()=>{}} title="窓で止める" invalid /></div></Case>
<Case id="drop-ok" expect="blue" ring="self"><FileDropzone variant="upload" aria-label="置く" onFiles={()=>{}} /></Case>
<Case id="drop-bad" expect="red" ring="self"><FileDropzone variant="upload" aria-label="足す" onFiles={()=>{}} invalid /></Case>
<Case id="composer-ok" expect="blue" ring="self"><FileDropzone variant="composer" title="ファイルを追加" aria-label="添付" onFiles={()=>{}} /></Case>
<Case id="composer-bad" expect="red" ring="self"><FileDropzone variant="composer" title="ファイルを追加" aria-label="添付誤" onFiles={()=>{}} invalid /></Case>
<Case id="media-ok" expect="blue" ring="input"><MediaSlot title="画像を追加" onFile={()=>{}} /></Case>
<Case id="media-bad" expect="red" ring="input"><MediaSlot title="画像を追加" onFile={()=>{}} invalid /></Case>
<Case id="otp-ok" expect="blue" ring="self"><OtpInput label="確認コード" value="123456" onChange={()=>{}} /></Case>
<Case id="otp-bad" expect="red" ring="self"><OtpInput label="確認コード誤" value="123456" onChange={()=>{}} invalid /></Case>
<Case id="insert-ok" expect="blue" ring="self"><InsertTextField aria-label="差し込み本文" value="本文" onValueChange={()=>{}} /></Case>
<Case id="insert-bad" expect="red" ring="self"><InsertTextField aria-label="差し込み本文誤" value="本文" onValueChange={()=>{}} aria-invalid="true" /></Case>
<Case id="insertcompact-ok" expect="blue" ring="self"><InsertTextField compact aria-label="短い本文" value="" onValueChange={()=>{}} /></Case>
<Case id="insertcompact-bad" expect="red" ring="self"><InsertTextField compact aria-label="短い本文誤" value="" onValueChange={()=>{}} aria-invalid="true" /></Case>
<Case id="fs-ok" expect="blue" ring="self"><input type="text" aria-label="箱名" className={fsStyles.field} defaultValue="" onChange={()=>{}} /></Case>
<Case id="fs-bad" expect="red" ring="self"><input type="text" aria-label="箱名誤" className={fsStyles.field} aria-invalid="true" defaultValue="" onChange={()=>{}} /></Case>
{['default','video'].map(variant=><div key={variant} data-static-drop={variant}><FileDropzone variant={variant} title="画像を追加" onFiles={()=>{}} invalid /></div>)}
{[false,true].map(invalid=><div key={String(invalid)} data-filled-media={invalid?'bad':'ok'}><MediaSlot title="画像" value="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/%3E" onFile={()=>{}} onUrl={()=>{}} invalid={invalid} /></div>)}
</main>}
createRoot(document.getElementById('root')).render(<Fixture/>);`},
 bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',tsconfig: webRoot+'/tsconfig.json',define:{'process.env.NODE_ENV':'"production"'},banner:{js:'var process=typeof process!=="undefined"?process:{env:{NODE_ENV:"production",NEXT_PUBLIC_API_URL:"http://127.0.0.1:8788"}};'},
  plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }))
    b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'navigation'
      ? 'export const useRouter=()=>({push(){},replace(){},prefetch(){}});export const usePathname=()=>"/fixture";export const useSearchParams=()=>new URLSearchParams();'
      : 'import React from "react";export default function Link(p){return React.createElement("a",p)}', resolveDir: webRoot }))
    b.onLoad({ filter: /\.module\.css$/ }, args => {
      const prefix = `fixture_${sheets.length}_`
      const names = {}
      const css = readFileSync(args.path, 'utf8').replace(/\.([A-Za-z][\w-]*)/g, (_, name) => {
        names[name] = prefix + name
        return `.${names[name]}`
      })
      sheets.push(css.replace(/:global\(([^()]+)\)/g, '$1'))
      return { contents: `export default ${JSON.stringify(names)}`, loader: 'js' }
    })
    b.onLoad({ filter: /\.css$/ }, async args => {
      sheets.push(await compileUiStyles(args.path))
      return { contents: '', loader: 'js' }
    })
  } }],
})
const css = [await compileUiStyles(fileURLToPath(new URL('../../src/app/globals.css',import.meta.url)),['fixed','min-w-0']),...sheets].join('\n')
const RED = 'rgb(185, 28, 28)'
const BLUE = 'rgb(37, 99, 235)'
/** 焦点の当たった欄の、輪を描く要素の輪郭を測る。 */
const RING = () => {
  const active = document.activeElement
  if (!active || active === document.body) return null
  const host = active.closest('[data-case]')
  if (!host) return null
  const kind = host.getAttribute('data-ring')
  const el = kind === 'search' ? active.closest('[data-search-field]')
    : kind === 'check' ? active.nextElementSibling
    : kind === 'combo' ? active.closest('[data-choice-field]')
    : kind === 'input' ? active.closest('[data-input-field]')
    : kind === 'card' ? active.closest('label')
    : active
  if (!el) return null
  document.querySelectorAll('[data-ring-probe]').forEach(item=>item.removeAttribute('data-ring-probe'))
  el.setAttribute('data-ring-probe','')
  const c = getComputedStyle(el)
  return { id: host.getAttribute('data-case'), expect: host.getAttribute('data-expect'), color: c.outlineColor, style: c.outlineStyle, width: c.outlineWidth, offset: c.outlineOffset, shadow: c.boxShadow, boxColor: kind === 'card' ? getComputedStyle(active.nextElementSibling).outlineColor : null, hitColor: active.hasAttribute('data-input-hit') ? getComputedStyle(active).outlineColor : null }
}
/** 直線の辺を画像で読む。色の線が枠から離れて2本になっていないかを確かめる。 */
async function paintedStroke(page, color) {
  await page.locator('[data-ring-probe]').scrollIntoViewIfNeeded()
  const rect = await page.locator('[data-ring-probe]').boundingBox()
  assert.ok(rect)
  const left = Math.floor(rect.x) - 6
  const top = Math.floor(rect.y + rect.height / 2) - 1
  const png = PNG.sync.read(await page.screenshot({ clip: { x: left, y: top, width: 16, height: 3 } }))
  const rgb = color === RED ? [185,28,28] : [37,99,235]
  const pixels = []
  for(let x=0;x<png.width;x++) {
    const at=(png.width+x)*4
    if(rgb.every((value,index)=>Math.abs(png.data[at+index]-value)<35)) pixels.push(left+x+0.5-rect.x)
  }
  return pixels
}
function assertSingleStroke(pixels, label) {
  assert.ok(pixels.length >= 1 && pixels.length <= 3, `${label}: 2pxの色の線が1本だけ見える: ${pixels}`)
  assert.ok(pixels.every(x=>x>=-0.6 && x<=2.6), `${label}: 線を枠の位置へ重ね、すき間を空けない: ${pixels}`)
  for(let i=1;i<pixels.length;i++) assert.ok(pixels[i]-pixels[i-1]<=1.1, `${label}: 線が分離しない`)
}
for (const width of [1152, 1440]) test(`誤りの欄の焦点は赤1本、誤りなしは青（invalid-focus） ${width}`, async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.log('PAGEERROR:', String(e && e.stack || e).slice(0, 800)))
    await page.setViewportSize({ width, height: 900 })
    await page.setContent(`<html data-theme="v8"><style>${css}main{padding:32px}body{background:#f2f3f5}</style><div id="root"></div></html>`)
    await page.addScriptTag({ content: compiled.outputFiles[0].text })
    await page.locator('[data-case]').first().waitFor()
    const total = await page.locator('[data-case]').count()
    const seen = []
    const offsets = new Map()
    for (let i = 0; i < total; i++) {
      // 同じ欄の2つ目以降の留まり（連想の開く印など）は飛ばし、未見の欄まで進む。
      let ring = null
      for (let skip = 0; skip < 6; skip++) {
        await page.keyboard.press('Tab')
        await page.waitForTimeout(120)
        ring = await page.evaluate(RING)
        if (ring && !seen.includes(ring.id)) break
      }
      assert.ok(ring && !seen.includes(ring.id), `Tab: 未見の欄に焦点が当たる`)
      // 輪の変わり目（120ms）の途中を避け、落ち着いた色を測る。
      const deadline = Date.now() + 3000
      for (;;) {
        ring = await page.evaluate(RING)
        if (ring && (ring.color === RED || ring.color === BLUE)) break
        if (Date.now() > deadline) break
        await page.waitForTimeout(50)
      }
      assert.ok(ring, `Tab ${i + 1}: 欄に焦点が当たる`)
      seen.push(ring.id)
      offsets.set(ring.id, ring.offset)
      if (process.env.MUSE_SHOTS && ['fs-ok', 'fs-bad', 'composer-bad', 'insert-ok', 'insert-bad', 'insertcompact-ok', 'insertcompact-bad', 'media-ok', 'media-bad'].includes(ring.id)) {
        mkdirSync(process.env.MUSE_SHOTS, { recursive: true })
        await page.locator(`[data-case="${ring.id}"]`).screenshot({ path: `${process.env.MUSE_SHOTS}/${ring.id}-${width}.png` })
      }
      if (ring.id.startsWith('card-') || ring.id.startsWith('cardwindow-')) assert.ok(ring.boxColor && ring.boxColor !== 'rgba(0, 0, 0, 0)', `${ring.id}: チェックの四角の枠を消さない`)
      const want = ring.expect === 'red' ? RED : BLUE
      assert.equal(ring.color, want, `${ring.id}: 輪は${ring.expect === 'red' ? '赤' : '青'}`)
      assert.equal(ring.style, 'solid', `${ring.id}: 輪は実線`)
      assert.equal(ring.width, '2px', `${ring.id}: 輪は2px`)
      if (ring.id.startsWith('card-')) assert.equal(ring.offset, '2px', 'カードの輪は共通の位置を使う')
      if (ring.id.startsWith('cardwindow-')) assert.equal(ring.offset, '-2px', '窓の中のカードは内側に輪を出す')
      if (ring.id.startsWith('media-')) {
        assert.match(ring.hitColor,/^rgba\(.+, 0\)$/,'画像追加面の中に2つ目の輪を出さない')
        assert.equal(await page.locator('[data-ring-probe]').evaluate(el=>getComputedStyle(el.parentElement).outlineStyle),'none','画像枠の外箱に誤りの線を重ねない')
      }
      if (!/^(check|card)/.test(ring.id)) assert.equal(ring.offset, '-2px', `${ring.id}: 入力欄は枠の上に重ねる`)
      if (ring.expect === 'red') assert.ok(!ring.shadow.includes('37, 99, 235'), `${ring.id}: 青を重ねない`)
      if (!/^(check|card)/.test(ring.id)) {
        assertSingleStroke(await paintedStroke(page,want), `${ring.id} focus`)
        if (ring.id === 'tf-ok') {
          await page.evaluate(()=>document.documentElement.style.setProperty('--polish-focus-input-offset','2px'))
          const brokenStroke = await paintedStroke(page,want)
          assert.throws(()=>assertSingleStroke(brokenStroke, '故障対照'))
          await page.evaluate(()=>document.documentElement.style.removeProperty('--polish-focus-input-offset'))
          assertSingleStroke(await paintedStroke(page,want), '復元後')
        }
        await page.evaluate(()=>document.activeElement.blur())
        await page.waitForTimeout(150)
        if (ring.expect === 'red') assertSingleStroke(await paintedStroke(page,RED), `${ring.id} error without focus`)
        else assert.equal((await paintedStroke(page,BLUE)).length,0, `${ring.id}: 普段は青い線を出さない`)
        if (ring.id.startsWith('media-') && process.env.MUSE_SHOTS) await page.locator(`[data-case="${ring.id}"]`).screenshot({path:`${process.env.MUSE_SHOTS}/${ring.id}-blur-${width}.png`})
        if (ring.id.startsWith('media-')) await page.locator(`[data-case="${ring.id}"] [data-input-hit]`).focus()
        else await page.locator('[data-ring-probe]').evaluate(el=>el.focus())
      }

    }
    for (const id of seen.filter(id => id.endsWith('-bad'))) assert.equal(offsets.get(id), offsets.get(id.replace(/-bad$/, '-ok')), `${id}: 青と赤で輪の位置を変えない`)
    assert.equal(new Set(seen).size, total, '全部の欄を1回ずつ回った')
    for (const variant of ['default','video']) {
      const host = page.locator(`[data-static-drop="${variant}"]`)
      const field = host.locator('[data-input-field]')
      await page.evaluate(()=>document.querySelectorAll('[data-ring-probe]').forEach(el=>el.removeAttribute('data-ring-probe')))
      await field.evaluate(el=>el.setAttribute('data-ring-probe',''))
      assertSingleStroke(await paintedStroke(page,RED), `${variant}: 誤りの追加面も赤1本`)
      const button = host.getByRole('button', {name:'ファイルを選択する'})
      await button.focus()
      const ring = await button.evaluate(el=>{const c=getComputedStyle(el);return {width:c.outlineWidth,offset:c.outlineOffset}})
      assert.deepEqual(ring,{width:'2px',offset:'2px'},`${variant}: 中の操作ボタンの輪は従来の位置`)
    }
    for (const state of ['ok','bad']) {
      const host = page.locator(`[data-filled-media="${state}"]`)
      await host.getByRole('button',{name:'差し替える'}).focus()
      const buttonRing = await host.getByRole('button',{name:'差し替える'}).evaluate(el=>{const c=getComputedStyle(el);return {width:c.outlineWidth,offset:c.outlineOffset}})
      assert.deepEqual(buttonRing,{width:'2px',offset:'2px'},'画像ありの補助ボタンは従来の外側の輪')
      const frame = host.locator('[data-media-slot]')
      const frameRing = await frame.evaluate(el=>{const c=getComputedStyle(el);return {color:c.outlineColor,style:c.outlineStyle}})
      assert.equal(frameRing.color===BLUE && frameRing.style==='solid',false,'補助ボタンの焦点を画像枠に重ねない')
      if (state==='bad') {
        await page.evaluate(()=>document.querySelectorAll('[data-ring-probe]').forEach(el=>el.removeAttribute('data-ring-probe')))
        await frame.evaluate(el=>el.setAttribute('data-ring-probe',''))
        assertSingleStroke(await paintedStroke(page,RED),'画像ありの誤りも枠へ赤1本')
      }
      if(process.env.MUSE_SHOTS) await host.screenshot({path:`${process.env.MUSE_SHOTS}/media-filled-${state}-${width}.png`})
    }
  } finally { await browser.close() }
})
