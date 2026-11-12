import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connectGuardBrowser } from './browser-session.mjs'
import { compileUiStyles } from './compile-ui-styles.mjs'

const require = createRequire(import.meta.url)
const fromVitest = createRequire(require.resolve('vitest/package.json'))
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')
const webRoot = fileURLToPath(new URL('../..', import.meta.url))
const sheets = []
const compiled = await build({
  stdin: { resolveDir: webRoot, loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import Button from './src/components/shared/button';
import {RowStatusActions} from './src/components/shared/row-actions';
import SegmentedControl from './src/components/shared/segmented';
import Pagination from './src/components/shared/pagination';
import KpiCard from './src/components/shared/kpi-card';
import KpiBand from './src/components/shared/kpi-band';
import Select from './src/components/shared/select';
import {BookingLegend} from './src/components/shared/booking-presentation';
import StatusBadge from './src/components/shared/status-badge';
import StatusPill from './src/components/shared/status-pill';
import Dialog from './src/components/shared/dialog';
import Drawer from './src/components/shared/drawer';
import InlineEdit from './src/components/shared/inline-edit';
import {SettingsPage} from './src/components/templates/settings-page';
import {RowNameButton} from './src/components/shared/table';
function Fixture(){const[value,setValue]=useState('graph');const[window,setWindow]=useState('');const[count,setCount]=useState(0);return <main>
<section data-measure-status-actions>{[false,true].map(alert=><div key={String(alert)}><RowStatusActions status={<StatusBadge tone={alert?'warning':'neutral'}>{alert?'未設定':'あとで'}</StatusBadge>}><Button presentation="row-action" textTone={alert?'accent':'ink'} onClick={()=>setCount(count+1)}>{alert?'決まりを入れる':'選ぶ'}</Button></RowStatusActions></div>)}<RowStatusActions status={<StatusBadge>設定済み</StatusBadge>}><Button presentation="row-action" href="/settings">中身を見る</Button></RowStatusActions><output aria-label="行の操作回数">{count}</output></section>
<Button variant="secondary">副操作</Button><Button variant="secondary" filterActive>絞り込み中</Button>
<Button variant="secondary" presentation="restaurant">店の副操作</Button><Button>主操作</Button>
<Pagination page={1} pageCount={3} onPageChange={()=>{}}/>
<KpiCard title="要対応" value={3} help="対応が必要な件数です" helpDisplay="question" valueAction={{label:'数の内訳',expanded:false,onClick:()=>{}}}/>
<RowNameButton>行の名前</RowNameButton>
<Button aria-label="その他操作"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"/></svg></Button>
<SegmentedControl aria-label="表示" value={value} onChange={setValue} options={[{value:'graph',label:'グラフ'},{value:'table',label:'表'}]}/>
<SegmentedControl aria-label="選択札" appearance="choices" value="one" onChange={()=>{}} options={[{value:'one',label:'候補'}]}/>
<SegmentedControl aria-label="表示アイコン" value="cards" onChange={()=>{}} options={[{value:'cards',label:<svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"/></svg>,ariaLabel:'カード'}]}/>
<section data-measure-select><Select aria-label="表示の条件" value="a" onChange={()=>{}} options={[{value:"a",label:"すべて"},{value:"b",label:"正常"}]}/></section>
<section data-measure-booking><BookingLegend/></section>
<section data-measure-wide-band style={{width:760,flex:"none",containerType:"inline-size",containerName:"v8-page"}}><KpiBand>{[1234567890,987654321,99.9,100].map((value,i)=><KpiCard key={i} title={i===2?"割合":"売上"} value={value} unit={i===2?"%":"円"}/>)}</KpiBand></section>
<section data-measure-range style={{width:760,flex:"none"}}><KpiBand density="compact"><KpiCard title="記録" value={28}/><KpiCard title="体重" value={null} valueRange={{from:9.8,to:9.2}} unit="kg"/><KpiCard title="呼吸" value={24}/><KpiCard title="心拍" value={96}/></KpiBand></section>
<section data-measure-fraction style={{width:760,flex:"none"}}><KpiBand><KpiCard title="今月の通知" valueText="1,041 / 5,000"/>{[0,1,2].map(value=><KpiCard key={value} title="配信" value={value} unit="通"/>)}</KpiBand></section>
<section data-measure-band><KpiBand><KpiCard title="集計" value={42}/></KpiBand></section>
<section data-measure-label-help><KpiCard title="電話ボタンのクリック" help="押された回数です" value={3}/></section>
<section data-measure-badges>{['neutral','success','info','warning','danger'].flatMap(tone=>[<StatusBadge key={'badge-'+tone} tone={tone}>{tone}</StatusBadge>,<StatusPill key={'pill-'+tone} tone={tone}>{tone}</StatusPill>])}</section>
<Button onClick={()=>setWindow('dialog')}>作る窓を開く</Button><Button onClick={()=>setWindow('drawer')}>引き出しを開く</Button>
<Button onClick={()=>setWindow('editable-drawer')}>名前を直せる引き出しを開く</Button>
<Dialog open={window==='dialog'} onCancel={()=>setWindow('')} title="作る窓" description="説明の行数が増えても、題の左の丸い印が最初の行の高さにそろうことを確かめます。説明は題から独立した本文です。"><p>本文</p></Dialog>
<Drawer open={window==='drawer'} onClose={()=>setWindow('')} title="引き出し" description="説明の行数が増えても、題の左の丸い印が最初の行の高さにそろうことを確かめます。説明は題から独立した本文です。"><p>本文</p></Drawer>
<Drawer open={window==='editable-drawer'} onClose={()=>setWindow('')} title="紹介者の詳細" layout="inset" heading={<InlineEdit value="見本 168" label="紹介者の名前を直す" onSave={async()=>{}}/>} description="説明が2行に増えても、名前を直す操作のある題に丸い印がそろうことを確かめます。"><p>本文</p></Drawer>
<Button onClick={()=>setWindow('settings')}>設定の間隔を見る</Button>
{window==='settings'?<section data-measure-settings>{['accounts','wide-nav','narrow-nav','account-handover'].map(layout=><SettingsPage key={layout} layout={layout} title={layout} navigation={null}><div>最初の段</div><div>次の段</div></SettingsPage>)}</section>:null}
</main>}
function PaginationFixture(){const[page,setPage]=useState(1);return <main style={{flexDirection:"column",alignItems:"stretch"}}><Pagination page={page} pageCount={3} range={{total:25,first:(page-1)*10+1,last:Math.min(page*10,25)}} onPageChange={setPage}/><Pagination page={1} pageCount={1} ariaLabel="1ページの送り" range={{total:1,first:1,last:1}} onPageChange={()=>{}}/><Pagination page={1} pageCount={3} ariaLabel="停止中の送り" disabled onPageChange={()=>setPage(99)}/><output>{page}</output></main>}
createRoot(document.getElementById('root')).render(globalThis.paginationFixture?<PaginationFixture/>:<Fixture/>);` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  tsconfig: `${webRoot}/tsconfig.json`, define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1:8788"' },
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
const css = [await compileUiStyles(fileURLToPath(new URL('../../src/app/globals.css', import.meta.url))), ...sheets].join('\n')
async function mount(page, pagination = false) {
  await page.setContent(`<html${pagination?' data-theme="v8"':''}><style>${css}body{color:var(--color-ink)}main{display:flex;gap:16px;align-items:center;padding:24px}</style><div id="root"></div></html>`)
  await page.evaluate(value=>{globalThis.paginationFixture=value},pagination)
  await page.addScriptTag({content:compiled.outputFiles[0].text})
  await page.getByRole(pagination?'navigation':'button',{name:pagination?'ページ送り':'副操作',exact:true}).waitFor()
}
const focusedRing = page => page.evaluate(() => {
  const control=document.activeElement,style=getComputedStyle(control)
  return control.matches(':focus-visible') && style.outlineStyle!=='none' && parseFloat(style.outlineWidth)>=2
})

test('塗りと絞り込み状態があってもキーボードの焦点を見失わない', async () => {
  const browser=await connectGuardBrowser()
  try {
    const page=await browser.newPage({reducedMotion:'reduce'})
    await mount(page)
    await page.getByRole('button',{name:'副操作',exact:true}).focus()
    await page.keyboard.press('Shift+Tab')
    for(const name of ['副操作','絞り込み中','店の副操作','主操作']){
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(()=>document.activeElement.textContent),name)
      assert.equal(await focusedRing(page),true,name)
    }
    for(const name of ['1ページ目へ','2ページ目へ','次のページ','数の内訳','行の名前']){
      await page.getByRole('button',{name,exact:true}).press('Shift')
      assert.equal(await focusedRing(page),true,name)
    }
    // 輪郭を消す故障を実際の描画へ入れ、同じ検査が見逃さないことを確かめる。
    const fault=await page.addStyleTag({content:'button:focus-visible{outline:none!important}'})
    assert.equal(await focusedRing(page),false)
    await fault.evaluate(el=>el.remove())
    assert.equal(await focusedRing(page),true)
  } finally { await browser.close() }
})

test('表示切替は白いつまみで追従し、クリック・矢印と動きを減らす設定を保つ', async () => {
  const browser=await connectGuardBrowser()
  try {
    for(const reducedMotion of ['reduce','no-preference']){
      const page=await browser.newPage({reducedMotion})
      await mount(page)
      const icon=page.getByRole('group',{name:'表示アイコン'}).getByRole('button',{name:'カード'})
      assert.equal(await icon.evaluate(el=>{const box=el.getBoundingClientRect(),svg=el.querySelector('svg').getBoundingClientRect();return svg.y+svg.height/2-box.y-box.height/2}),0)
      const group=page.getByRole('group',{name:'表示',exact:true})
      const graph=group.getByRole('button',{name:'グラフ',exact:true})
      const table=group.getByRole('button',{name:'表',exact:true})
      await table.click()
      assert.equal(await table.getAttribute('aria-pressed'),'true')
      await page.waitForFunction(()=>{
        const group=document.querySelector('[aria-label="表示"]'),thumb=group.querySelector('[aria-hidden="true"]'),selected=group.querySelector('[aria-pressed="true"]')
        return Math.abs(thumb.getBoundingClientRect().left-selected.getBoundingClientRect().left)<1 && Math.abs(thumb.getBoundingClientRect().width-selected.getBoundingClientRect().width)<1
      })
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('[aria-label="表示"] [aria-pressed="true"]')).color===getComputedStyle(document.body).color)
      const surface=await group.evaluate(el=>({
        thumb:getComputedStyle(el.querySelector('[aria-hidden="true"]')).backgroundColor,
        ink:getComputedStyle(el.querySelector('[aria-pressed="true"]')).color,
        expected:getComputedStyle(document.body).color,
      }))
      assert.equal(surface.thumb,'rgb(255, 255, 255)')
      assert.equal(surface.ink,surface.expected)
      await table.press('ArrowLeft')
      assert.equal(await graph.getAttribute('aria-pressed'),'true')
      assert.equal(await page.getByRole('group',{name:'選択札',exact:true}).getByRole('button').getAttribute('aria-pressed'),'true')
      await page.close()
    }
  } finally { await browser.close() }
})


test('数の帯と窓は共通の値で描かれ、状態札の文字は読める濃さを保つ', async () => {
  const browser=await connectGuardBrowser()
  try {
    const page=await browser.newPage({reducedMotion:'reduce'})
    await mount(page)
    const numbers=page.locator('[data-measure-band] [data-kpi-number]')
    const metric=await numbers.evaluate(el=>{const s=getComputedStyle(el);return{size:s.fontSize,line:s.lineHeight,weight:s.fontWeight}})
    assert.deepEqual(metric,{size:'34px',line:'36px',weight:'500'})
    const amounts=await page.locator('[data-measure-wide-band] [data-kpi-number],[data-measure-range] [data-kpi-number],[data-measure-fraction] [data-kpi-number]').evaluateAll(els=>els.map(el=>{const range=document.createRange();range.selectNodeContents(el);const r=range.getBoundingClientRect(),cell=el.closest('[data-design-version]'),c=cell.getBoundingClientRect(),s=getComputedStyle(cell),unit=el.parentElement.querySelector('[data-kpi-unit]');return{excess:Math.max(0,r.right-c.right+parseFloat(s.paddingRight)),unitExcess:unit?Math.max(0,unit.getBoundingClientRect().right-c.right+parseFloat(s.paddingRight)):0,font:getComputedStyle(el).fontSize,pad:s.paddingTop,top:Math.round(c.top),band:el.closest('section').getAttributeNames().find(n=>n.startsWith('data-measure')),text:el.textContent}}))
    // 範囲・使用数／上限・大きな金額があっても、帯は2段に逃がさず横一列。入りきらない数だけ字を小さくし、はみ出さない（省略しない）。
    for(const amount of amounts){assert.equal(amount.excess,0);assert.equal(amount.unitExcess,0);assert.equal(amount.pad,'16px');assert.ok(parseFloat(amount.font)<=34&&parseFloat(amount.font)>=12,JSON.stringify(amount))}
    for(const amount of amounts.filter(a=>a.text.length<=4))assert.equal(amount.font,'34px',JSON.stringify(amount))
    for(const band of ['data-measure-range','data-measure-fraction'])assert.equal(new Set(amounts.filter(a=>a.band===band).map(a=>a.top)).size,1,band)

    const help=page.getByRole('button',{name:'電話ボタンのクリックの説明',exact:true})
    assert.equal(await help.evaluate(el=>el.getBoundingClientRect().height),18)
    for(const name of ['その他操作','要対応の説明']){
      const control=page.getByRole('button',{name,exact:true})
      assert.equal(await control.evaluate(el=>{const box=el.getBoundingClientRect(),svg=el.querySelector('svg').getBoundingClientRect();return svg.y+svg.height/2-box.y-box.height/2}),0)
    }
    const ratios=await page.locator('[data-measure-badges] > span').evaluateAll(els=>els.map(el=>{
      const s=getComputedStyle(el),rgb=value=>value.match(/[0-9.]+/g).slice(0,3).map(Number)
      const light=channels=>channels.map(c=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4}).reduce((sum,c,i)=>sum+c*[0.2126,0.7152,0.0722][i],0)
      const a=light(rgb(s.color)),b=light(rgb(s.backgroundColor))
      return{tone:el.textContent,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)}
    }))
    assert.equal(ratios.length,10)
    for(const result of ratios)assert.ok(result.ratio>=4.5,JSON.stringify(result))
    for(const name of ['作る窓を開く','引き出しを開く','名前を直せる引き出しを開く']){
      await page.getByRole('button',{name,exact:true}).click()
      const panel=page.getByRole('dialog')
      await panel.waitFor()
      const shadows=await panel.evaluate(el=>{const s=getComputedStyle(el),probe=document.createElement('div');probe.style.boxShadow=el.dataset.layout==='inset'?'var(--tpl-af-dr-shadow)':'var(--polish-window-shadow)';el.append(probe);const expected=getComputedStyle(probe).boxShadow;probe.remove();return{actual:s.boxShadow,expected}})
      assert.equal(shadows.actual,shadows.expected)
      assert.notEqual(shadows.actual,'none')
      const offset=await panel.locator('h2').evaluate(el=>{const icon=el.querySelector('[aria-hidden]'),text=el.lastElementChild,i=icon.getBoundingClientRect(),t=text.getBoundingClientRect();return i.y+i.height/2-t.y-parseFloat(getComputedStyle(el).lineHeight)/2})
      assert.ok(Math.abs(offset)<0.5,`最初の題行と印の中心差 ${offset}px`)
      await page.keyboard.press('Escape')
      await panel.waitFor({state:'hidden'})
    }
    await numbers.evaluate(el=>el.closest('[data-kpi-strip]').style.setProperty('--tpl-band-number-size','22px'))
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-measure-band] [data-kpi-number]')).fontSize!=='34px')
    assert.notEqual(await numbers.evaluate(el=>getComputedStyle(el).fontSize),'34px')
    await numbers.evaluate(el=>el.closest('[data-kpi-strip]').style.removeProperty('--tpl-band-number-size'))
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-measure-band] [data-kpi-number]')).fontSize==='34px')
    assert.equal(await numbers.evaluate(el=>getComputedStyle(el).fontSize),'34px')
  } finally { await browser.close() }
})

test('設定の型を切り替えても段間を16pxに保つ', async () => {
  const browser=await connectGuardBrowser()
  try {
    const page=await browser.newPage({reducedMotion:'reduce'})
    await mount(page)
    await page.getByRole('button',{name:'設定の間隔を見る',exact:true}).click()
    const contents=page.locator('[data-measure-settings] [data-template-region="content"]')
    await contents.first().waitFor()
    const gaps=()=>contents.evaluateAll(els=>els.map(el=>getComputedStyle(el).gap))
    assert.deepEqual(await gaps(),['16px','16px','16px','16px'])
    const headings=await page.locator('[data-measure-settings] [data-template-region="heading"] h1').evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el);return{size:s.fontSize,weight:s.fontWeight,line:s.lineHeight}}))
    assert.deepEqual(headings,Array.from({length:4},()=>({size:'32px',weight:'600',line:'40px'})))
    const headingInsets=await page.locator('[data-measure-settings] [data-template-region="heading"]').evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el);return{top:s.paddingTop,bottom:s.paddingBottom}}))
    assert.deepEqual(headingInsets,Array.from({length:4},()=>({top:'16px',bottom:'8px'})))

    const frame=page.locator('[data-measure-settings] [data-template-layout="accounts"]')
    await frame.evaluate(el=>el.style.setProperty('--tpl-sa-gap','14px'))
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-measure-settings] [data-template-layout="accounts"] [data-template-region="content"]')).gap==='14px',{},{timeout:2000})
    assert.equal((await gaps())[0],'14px')
    await frame.evaluate(el=>el.style.removeProperty('--tpl-sa-gap'))
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-measure-settings] [data-template-layout="accounts"] [data-template-region="content"]')).gap==='16px',{},{timeout:2000})
    assert.deepEqual(await gaps(),['16px','16px','16px','16px'])
  } finally { await browser.close() }
})

// 色名の文字列ではなく、実際に描かれた面・枠と操作を確かめる。
test('白い選択欄と予約の線を実描画で見分け、選択操作を保つ', async () => {
  const browser=await connectGuardBrowser()
  try {
    const page=await browser.newPage({reducedMotion:'reduce'})
    await mount(page)
    const select=page.getByRole('button',{name:'表示の条件',exact:true})
    const surface=await select.evaluate(el=>{const s=getComputedStyle(el);return{background:s.backgroundColor,outline:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor,shadow:s.boxShadow}})
    // 線ではなく影で浮かせる。透明の輪郭は見えない線として扱う。
    assert.equal(surface.background,'rgb(255, 255, 255)')
    assert.ok(surface.color==='rgba(0, 0, 0, 0)'||surface.color==='transparent', `outline color: ${surface.color}`)
    assert.ok(surface.width==='0px'||surface.width==='1px', `outline width: ${surface.width}`)
    assert.notEqual(surface.shadow,'none')
    await select.press('ArrowDown')
    await page.getByRole('option',{name:'正常',exact:true}).getByRole('button').click()
    assert.equal(await page.getByRole('listbox').count(),0)
    const lines=await page.locator('[data-measure-booking] [data-booking-state]').evaluateAll(els=>Object.fromEntries(els.map(el=>{const s=getComputedStyle(el);return[el.dataset.bookingState,{style:s.borderTopStyle,width:s.borderTopWidth,color:s.borderTopColor}]})))
    assert.equal(lines.pending.style,'dashed');assert.equal(lines.pending.width,'2px')
    assert.equal(lines.hold.style,'dashed');assert.notEqual(lines.pending.color,lines.hold.color)
    assert.equal(lines.no_show.style,'solid');assert.equal(lines.no_show.width,'2px');assert.equal(lines.no_show.color,lines.pending.color)
    await page.close()
  } finally { await browser.close() }
})

for(const width of [1152,1440])test(`設定行の札と操作を区別でき、両幅で操作できる ${width}`,async()=>{
  const browser=await connectGuardBrowser(),page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'})
  try{
    await mount(page)
    const section=page.locator('[data-measure-status-actions]')
    const rows=await section.locator('[data-shared-part="row-status-actions"]').evaluateAll(elements=>elements.map(e=>{
      const badge=e.firstElementChild,button=e.lastElementChild.firstElementChild,s=getComputedStyle(button),bs=getComputedStyle(badge),b=badge.getBoundingClientRect(),a=button.getBoundingClientRect()
      return {bg:s.backgroundColor,badgeBg:bs.backgroundColor,badgeShadow:bs.boxShadow,border:s.borderTopWidth,shadow:s.boxShadow,color:s.color,center:b.y+b.height/2-a.y-a.height/2,width:a.width,height:a.height}
    }))
    assert.equal(new Set(rows.map(r=>r.width)).size,1)
    for(const row of rows){assert.equal(row.bg,'rgb(255, 255, 255)');assert.equal(row.border,'0px');assert.notEqual(row.shadow,'none');assert.equal(row.height,36);assert.ok(Math.abs(row.center)<1)}
    // 影を消す故障が同じ描画検査で検出され、復旧後に通ることを確かめる。
    const target=section.getByRole('button',{name:'選ぶ',exact:true})
    await target.evaluate(e=>{e.style.setProperty('transition','none','important');e.style.setProperty('box-shadow','none','important')})
    const broken=await target.evaluate(e=>getComputedStyle(e).boxShadow)
    assert.throws(()=>assert.notEqual(broken,'none'))
    await target.evaluate(e=>{e.style.removeProperty('box-shadow');e.style.removeProperty('transition')})
    assert.notEqual(await target.evaluate(e=>getComputedStyle(e).boxShadow),'none')
    assert.notEqual(rows[0].badgeShadow,rows[0].shadow)
    assert.notEqual(rows[0].color,rows[1].color)
    assert.equal(await section.getByRole('link',{name:'中身を見る'}).getAttribute('href'),'/settings')
    await section.getByRole('button',{name:'選ぶ',exact:true}).click()
    await section.getByRole('button',{name:'決まりを入れる',exact:true}).press('Enter')
    assert.equal(await page.getByLabel('行の操作回数').textContent(),'2')
    assert.equal(await focusedRing(page),true)
    const secondary=await page.getByRole('button',{name:'副操作',exact:true}).evaluate(e=>{const s=getComputedStyle(e);return{background:s.backgroundColor,shadow:s.boxShadow}})
    assert.equal(secondary.background,'rgb(255, 255, 255)')
    assert.notEqual(secondary.shadow,'none')
  }finally{await page.close();await browser.close()}
})

for(const width of [1152,1440])test(`数の帯の余白と数字を実寸で守り、古い間隔の故障を検出する ${width}`,async()=>{
  const browser=await connectGuardBrowser(),page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'})
  try{
    await mount(page)
    const band=page.locator('[data-measure-band] [data-kpi-strip]')
    const measure=()=>band.evaluate(e=>[...e.children].map(cell=>{
      const n=cell.querySelector('[data-kpi-number]'),s=getComputedStyle(cell),v=getComputedStyle(n)
      return{gap:s.gap,top:s.paddingTop,bottom:s.paddingBottom,left:s.paddingLeft,right:s.paddingRight,size:v.fontSize,line:v.lineHeight,weight:v.fontWeight}
    }))
    const expected={gap:'4px',top:'16px',bottom:'16px',left:'24px',right:'24px',size:'34px',line:'36px',weight:'500'}
    const normal=await measure()
    assert.ok(normal.length>0)
    for(const dimensions of normal)assert.deepEqual(dimensions,expected)
    const fault=await page.addStyleTag({content:'[data-measure-band] [data-design-version]{gap:8px!important}'})
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-measure-band] [data-design-version]')).gap==='8px')
    const broken=await measure()
    assert.equal(broken[0].gap,'8px')
    assert.throws(()=>assert.deepEqual(broken[0],expected))
    await fault.evaluate(el=>el.remove())
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-measure-band] [data-design-version]')).gap==='4px')
    assert.deepEqual(await measure(),normal)
  }finally{await page.close();await browser.close()}
})


for(const width of [1152,1440])test(`ページ送りowner正式版の灰・焦点・境界と件数 ${width}`,async()=>{
  const browser=await connectGuardBrowser(),page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'})
  const paint=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  try{
    await mount(page,true)
    const pager=page.getByRole('navigation',{name:'ページ送り',exact:true}),current=pager.locator('[aria-current="page"]')
    const look=el=>el.evaluate(el=>{const s=getComputedStyle(el);return {bg:s.backgroundColor,weight:s.fontWeight,outline:s.outlineColor,shadow:s.boxShadow,border:s.borderTopWidth,opacity:Number(s.opacity)}})
    await paint();const normal=await look(current)
    assert.equal(normal.bg,'rgb(247, 247, 245)');assert.equal(normal.weight,'700');assert.equal(normal.outline,'rgba(0, 0, 0, 0)');assert.equal(normal.shadow,'none');assert.equal(normal.border,'0px')
    const other=pager.getByRole('button',{name:'2ページ目へ'}),otherLook=await look(other)
    assert.equal(otherLook.outline,'rgba(0, 0, 0, 0)');assert.equal(otherLook.shadow,'none')
    assert.equal(await pager.getByRole('button',{name:'前のページ'}).isDisabled(),true)
    assert.ok((await look(pager.getByRole('button',{name:'前のページ'}))).opacity<1)
    assert.ok((await pager.textContent()).includes('25件中 1〜10件'))
    await current.evaluate(el=>{el.style.outlineColor='rgb(20, 20, 20)'});await paint();assert.notEqual((await look(current)).outline,normal.outline,'黒い枠の再発を検知する')
    await current.evaluate(el=>{el.style.removeProperty('outline-color')});await paint();assert.equal((await look(current)).outline,normal.outline)
    await page.keyboard.press('Tab');await current.focus();await paint();assert.equal((await look(current)).outline,'rgb(37, 99, 235)')
    await other.click();assert.equal(await page.locator('output').textContent(),'2');assert.ok((await pager.textContent()).includes('25件中 11〜20件'))
    await pager.getByRole('button',{name:'次のページ'}).click();assert.equal(await page.locator('output').textContent(),'3');assert.equal(await pager.getByRole('button',{name:'次のページ'}).isDisabled(),true)
    assert.ok((await pager.textContent()).includes('25件中 21〜25件'))
    const disabled=page.getByRole('navigation',{name:'停止中の送り'});assert.ok((await disabled.getByRole('button').evaluateAll(buttons=>buttons.map(b=>b.disabled))).every(Boolean))
    assert.equal(await page.getByRole('navigation',{name:'1ページの送り'}).count(),0);assert.ok(await page.getByText('1件中 1〜1件',{exact:true}).isVisible())
    await page.mouse.move(0,0)
    await page.waitForFunction(bg=>{const el=document.querySelector('nav[aria-label="ページ送り"] [aria-current="page"]');return el?.textContent==='3'&&getComputedStyle(el).backgroundColor===bg},normal.bg)
    const finalCurrent=await look(current);assert.equal(finalCurrent.bg,normal.bg);assert.equal(finalCurrent.weight,'700')
    if(process.env.PAGINATION_TARGET_OUT){const fs=await import('node:fs');fs.mkdirSync(process.env.PAGINATION_TARGET_OUT,{recursive:true});fs.writeFileSync(`${process.env.PAGINATION_TARGET_OUT}/pagination-${width}.json`,JSON.stringify({normal,other:otherLook,finalCurrent,finalPage:await page.locator('output').textContent()},null,2)+'\n');await page.screenshot({path:`${process.env.PAGINATION_TARGET_OUT}/pagination-${width}.png`})}
  }finally{await page.close();await browser.close()}
})
