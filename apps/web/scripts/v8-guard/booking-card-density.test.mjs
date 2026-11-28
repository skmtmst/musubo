import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connectGuardBrowser } from './browser-session.mjs'
import { compileUiStyles } from './compile-ui-styles.mjs'
import scanPolishRules from './polish-rules-browser.mjs'

const require = createRequire(import.meta.url), fromVitest = createRequire(require.resolve('vitest/package.json'))
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')
const webRoot = fileURLToPath(new URL('../..', import.meta.url)), sheets = []
const compiled = await build({
  stdin: { resolveDir: webRoot, loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import ReservationBoard from './src/components/shared/reservation-board';
import {StaffBoard} from './src/v8/style-dashboard/staff-board';
import {CalendarTimeEntries} from './src/components/shared/calendar-parts';
const statuses=['confirmed','seated','completed','pending','requested','no_show','cancelled','rejected','expired','late','expiring'];
const menus=['カット＋カラー','縮毛矯正','ネイル','ジェルネイル','カット','パーマ','ヘッドスパ','カット＋ケア'];
function Fixture(){const [opened,setOpened]=useState('');const compact=globalThis.fixtureMode==='compact';
const entries=statuses.map((status,i)=>({id:String(i),kind:'seats',version:1,scopeId:'s',startsAt:'2026-09-03T01:00:00Z',endsAt:compact?'2026-09-03T01:01:00Z':'2026-09-03T05:00:00Z',status,customerName:'予約者'+i,guestCount:i===1?1200:2,resourceIds:['r'+i],resourceLabel:'卓'+i,source:'phone',courseName:'長いコースの正式な名前',note:null,dining:null,currentAllergy:i%2===0?'そば・小麦':null,holdExpiresAt:i===3?'2026-09-03T12:00:00Z':null}));
const columns=Array.from({length:4},(_,i)=>({id:'c'+i,name:'担当'+i,count:2,next:'空きあり'}));const board={from:'09:00',to:'20:00',columns,free:[],entries:[...menus.map((menu,i)=>({id:String(i),columnId:'c'+i%4,start:i<4?'10:00':'13:00',end:i<4?'12:00':'15:00',name:'予約者'+i,menu,state:i===6?'pending':i%2?'active':'done',stateLabel:i===6?'承認待ち':i%2?'施術中':'来店済み'})),{id:'rest',columnId:'c3',start:'16:00',end:'20:00',name:'休み',menu:'予約は止めています',state:'off',stateLabel:'休み'}]};
return <main>{globalThis.fixtureMode==='boundaries'?<><section aria-label='cell boundary'><ReservationBoard kind='people' timeDirection='vertical' entries={[{...entries[0],kind:'people'}]} resources={[{id:'r0',label:'担当',active:true,capacity:1}]} dates={['2026-09-03']} onOpen={setOpened}/></section><section aria-label='calendar boundary'><CalendarTimeEntries days={['2026-09-03']} entries={[{id:'calendar',day:'2026-09-03',start:'10:00',end:'11:00',name:'予約者',title:'カット',source:'phone',state:'pending'}]} free={[]} canWrite={false} position={()=>({insetBlockStart:0,blockSize:100,inlineSize:240})} onOpen={setOpened} onSlot={()=>{}}/></section></>:globalThis.fixtureMode==='salon'?<StaffBoard board={board} search='' onSearch={()=>{}} canWrite={false} entryItems={()=>[]} onSlot={()=>{}}/>:<ReservationBoard entries={entries} resources={entries.map(e=>({id:e.resourceIds[0],label:e.resourceLabel,active:true,capacity:2}))} dates={['2026-09-03']} onOpen={setOpened}/>}<output>{opened}</output></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: `${webRoot}/tsconfig.json`,
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1:8788"' },
  plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }))
    b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path==='navigation'?'export const useRouter=()=>({push(){},replace(){},prefetch(){}});export const usePathname=()=>"/fixture";export const useSearchParams=()=>new URLSearchParams();':'import React from "react";export default function Link(p){return React.createElement("a",p)}', resolveDir: webRoot }))
    b.onLoad({ filter: /\.module\.css$/ }, args => {
      const prefix=`density_${sheets.length}_`,names={}
      const css=readFileSync(args.path,'utf8').replace(/\.([A-Za-z][\w-]*)/g,(_,name)=>{names[name]=prefix+name;return `.${names[name]}`})
      sheets.push(css.replace(/:global\(([^()]+)\)/g,'$1'))
      return { contents:`export default ${JSON.stringify(names)}`,loader:'js' }
    })
    b.onLoad({ filter: /\.css$/ }, async args => {
      sheets.push(await compileUiStyles(args.path))
      return { contents: '', loader: 'js' }
    })
  } }],
})
const css=[await compileUiStyles(fileURLToPath(new URL('../../src/app/globals.css',import.meta.url)),['sr-only']),...sheets].join('\n')
const paint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
async function mount(page,width,mode){
  await page.setViewportSize({width,height:1600});await page.clock.setFixedTime(new Date('2026-09-03T09:24:00Z'))
  await page.setContent(`<html data-theme="v8"><style>${css}main{margin-left:240px;padding:24px;min-width:0}*,*::before,*::after{transition:none!important;animation:none!important}</style><div id="root"></div></html>`)
  await page.evaluate(value=>{globalThis.fixtureMode=value},mode);await page.addScriptTag({content:compiled.outputFiles[0].text})
  await page.locator(mode==='salon'?'[aria-label="台帳の盤"]':mode==='boundaries'?'button[data-placement="cell"]':'button[data-placement="timeline"]').first().waitFor();await paint(page)
}
function facts(){return [...document.querySelectorAll('button[data-placement="timeline"]')].map(card=>{
  const box=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
  const visible=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&r.width>0&&r.height>0}
  const count=card.querySelector('[data-booking-count]'),ellipsis=card.querySelector('[data-booking-count-overflow]'),warning=card.querySelector('[data-booking-warning-mark]')
  const b=box(card),s=getComputedStyle(card),inner={left:b.left+parseFloat(s.borderLeftWidth),right:b.right-parseFloat(s.borderRightWidth),top:b.top+parseFloat(s.borderTopWidth),bottom:b.bottom-parseFloat(s.borderBottomWidth)}
  const marks=[count,ellipsis,warning].filter(el=>el&&visible(el)).map(el=>({kind:el===count?'count':el===ellipsis?'ellipsis':'warning',text:el.textContent,box:box(el),fontSize:getComputedStyle(el).fontSize}))
  const bad=marks.filter(m=>m.box.left<inner.left-.1||m.box.right>inner.right+.1||m.box.top<inner.top-.1||m.box.bottom>inner.bottom+.1)
  return {box:b,inner,title:card.title,name:card.getAttribute('aria-label'),description:card.getAttribute('aria-description'),count:count.textContent,marks,bad}
})}
async function record(page,name,values){if(!process.env.BOOKING_TARGET_OUT)return;mkdirSync(process.env.BOOKING_TARGET_OUT,{recursive:true});writeFileSync(`${process.env.BOOKING_TARGET_OUT}/${name}.json`,JSON.stringify(values,null,2)+'\n');await page.screenshot({path:`${process.env.BOOKING_TARGET_OUT}/${name}.png`,fullPage:true})}

for(const width of [1440,1152,1024])test(`予約の通常幅・最小幅・複数桁・注意を保つ ${width}`,async()=>{
  const browser=await connectGuardBrowser(),page=await browser.newPage({deviceScaleFactor:2,reducedMotion:'reduce'})
  try{
    await mount(page,width,'normal');const normal=await page.evaluate(facts)
    assert.ok(normal.every(r=>r.title.includes('長いコースの正式な名前')&&r.title.includes(`${r.count}名`)))
    assert.deepEqual((await page.evaluate(scanPolishRules)).filter(f=>f.kind==='badge-overlap'),[],'電話札を隣の文字へ重ねない')
    await record(page,`normal-${width}`,normal)
    await mount(page,width,'compact');const compact=await page.evaluate(facts)
    assert.ok(compact.every(r=>r.box.width<24),'既存の最小時間幅を引き延ばさない')
    assert.deepEqual(compact.filter(r=>r.bad.length).map(r=>({inner:r.inner,bad:r.bad})),[],'人数・明確な省略・注意印は内枠に収まる')
    const actual=['確定','来店中・進行中','終了・来店済み','仮押さえ','要対応（承認待ち）','無断キャンセル','キャンセル','拒否','期限切れ','注意','注意']
    compact.forEach((r,i)=>{
      assert.ok(r.description.includes(actual[i]),'すべての実状態をAX説明に保持')
      assert.equal(r.marks.some(m=>m.kind==='count'),i!==1,'1桁は実数、複数桁を切って別人数に見せない')
      assert.equal(r.marks.some(m=>m.kind==='ellipsis'),i===1,'複数桁は明確な省略表示')
      assert.equal(r.marks.some(m=>m.kind==='warning'),i%2===0,'注意の有無を可視で保持')
      if(i!==1)assert.ok(Number.parseFloat(r.marks.find(m=>m.kind==='count').fontSize)>=12,'人数の字を極端に小さくしない')
    })
    const cards=page.locator('button[data-placement="timeline"]')
    const ax=await page.context().newCDPSession(page)
    try{for(let i=0;i<compact.length;i++){
      await cards.nth(i).focus();const tree=await ax.send('Accessibility.getFullAXTree'),node=tree.nodes.find(n=>n.role?.value==='button'&&n.name?.value?.includes(`予約者${i} `))
      assert.ok(node?.description?.value?.includes('長いコースの正式な名前'))
      assert.ok(node.description.value.includes(`${compact[i].count}名`))
      assert.equal((node.description.value.match(/電話/g)||[]).length,1)
      if(i%2===0)assert.ok(node.description.value.includes('注意：そば・小麦'))
      await page.keyboard.press('Enter');assert.equal(await page.locator('output').textContent(),String(i),'既存詳細操作を保つ')
    }}finally{await ax.detach()}
    await record(page,`compact-${width}`,compact)
    const count=cards.first().locator('[data-booking-count]');await count.evaluate(el=>{el.style.display='inline-block'; el.style.transition='none'; el.style.transform='translateX(24px)' });await paint(page)
    const forced = await page.evaluate(facts)
    assert.ok(forced.some(r=>r.bad.length),`人数を箱外へ出す故障を検知する ${JSON.stringify(forced[0])}`)
    await count.evaluate(el=>{el.style.removeProperty('transform'); el.style.removeProperty('display'); el.style.removeProperty('transition')});await paint(page);assert.deepEqual((await page.evaluate(facts)).flatMap(r=>r.bad),[],'復元すると内枠へ戻る')
  }finally{await page.close();await browser.close()}
})

for(const width of [1440,1152,1024])test(`サロン共通盤の省略全文と休みの可視/AX ${width}`,async()=>{
  const browser=await connectGuardBrowser(),page=await browser.newPage({deviceScaleFactor:2,reducedMotion:'reduce'})
  try{
    await mount(page,width,'salon');const board=page.getByRole('region',{name:'台帳の盤'})
    const missing=await board.evaluate(board=>[...board.querySelectorAll('span,strong')].filter(el=>getComputedStyle(el).textOverflow==='ellipsis'&&el.scrollWidth>el.clientWidth+1).filter(el=>!(el.title||el.closest('[title]')?.title)?.includes(el.textContent)).map(el=>el.textContent))
    assert.deepEqual(missing,[])
    for(const menu of ['カット＋カラー','縮毛矯正','ネイル','ジェルネイル','カット','パーマ','ヘッドスパ','カット＋ケア'])assert.equal(await board.getByText(menu,{exact:true}).first().getAttribute('title'),menu)
    const rest=board.getByTitle(/予約は止めています/);assert.equal(await rest.count(),1);assert.ok((await rest.ariaSnapshot()).includes('予約は止めています'))
    const hidden=await rest.locator('.sr-only').evaluate(el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height,position:getComputedStyle(el).position}})
    assert.ok(hidden.width<=1&&hidden.height<=1&&hidden.position==='absolute')
    assert.equal(await rest.evaluate(el=>!!el.closest('button,a,[role="button"]')),false)
    const isolation=await board.locator('button[data-placement="board"]').evaluateAll(cards=>cards.map(el=>({type:getComputedStyle(el).containerType,name:getComputedStyle(el).containerName,timeShrink:getComputedStyle(el.querySelector('[class*="cardHeading"]>span')).flexShrink})))
    assert.ok(isolation.every(s=>s.type==='normal'&&s.name==='none'&&s.timeShrink==='0'),'StaffBoardへ新しいtimeline縮退を広げない')
    await record(page,`salon-${width}`,{missing,hidden,reading:await rest.ariaSnapshot()})
    const target=board.getByText('カット＋カラー',{exact:true}).first();await target.evaluate(el=>{el.style.maxWidth='8px';el.removeAttribute('title')});await paint(page)
    const broken=await target.evaluate(el=>el.scrollWidth>el.clientWidth+1&&!el.title);assert.ok(broken,'狭いメニューのtitle不足を検知する')
  }finally{await page.close();await browser.close()}
})


test('cell/calendarの正の予約部品へtimelineの縮退を広げない',async()=>{
  const browser=await connectGuardBrowser(),page=await browser.newPage({reducedMotion:'reduce'})
  try{
    await mount(page,1152,'boundaries')
    for(const placement of ['cell','calendar']){
      const card=page.locator(`button[data-placement="${placement}"]`)
      const styles=await card.evaluate(el=>({type:getComputedStyle(el).containerType,name:getComputedStyle(el).containerName,timeShrink:getComputedStyle(el.querySelector('[class*="cardHeading"]>span')).flexShrink}))
      assert.deepEqual(styles,{type:'normal',name:'none',timeShrink:'0'})
      assert.equal(await card.getByText('電話',{exact:true}).count(),1)
    }
  }finally{await page.close();await browser.close()}
})

for(const width of [1152,1440])test(`省略した注意文を電話札の重なりと混同せず、実重なりは検出する ${width}`,async()=>{
  const browser=await connectGuardBrowser(),page=await browser.newPage({viewport:{width,height:1600},reducedMotion:'reduce'})
  try{
    await mount(page,width,'normal')
    const overlaps=async()=>(await page.evaluate(scanPolishRules)).filter(f=>f.kind==='badge-overlap')
    assert.deepEqual(await overlaps(),[],'省略されて見えない文字を重なりと判定しない')
    const card = page.locator('button[data-placement="timeline"]').filter({ has: page.locator('[data-booking-warning]') }).first()
    await card.evaluate(card => {
      const badge = card.querySelector('[data-booking-source]')
      const warning = card.querySelector('[data-booking-warning]')
      const text = warning.querySelector('[data-booking-warning-text]')
      badge.style.display = 'inline-flex'
      warning.style.overflow = 'visible'
      text.style.display = 'inline-block'
      text.style.position = 'relative'
      const badgeBox = badge.getBoundingClientRect(), textBox = text.getBoundingClientRect()
      text.style.left = `${badgeBox.left - textBox.left}px`
      text.style.top = `${badgeBox.top - textBox.top}px`
    })
    assert.ok((await overlaps()).length>0,'省略を壊して実際に電話札へ重ねると必ず検出する')
    await card.evaluate(card => {
      for (const selector of ['[data-booking-source]', '[data-booking-warning]', '[data-booking-warning-text]']) card.querySelector(selector).removeAttribute('style')
    })
    assert.deepEqual(await overlaps(),[],'元の省略表示へ戻すと解消する')
  }finally{await page.close();await browser.close()}
})
