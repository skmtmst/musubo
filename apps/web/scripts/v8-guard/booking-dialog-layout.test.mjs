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
import ReservationBoard from './src/components/shared/reservation-board';
import Dialog from './src/components/shared/dialog';
import {CalendarSlotButton} from './src/components/shared/calendar-parts';
import ConfirmDialog from './src/components/shared/confirm-dialog';
import Drawer from './src/components/shared/drawer';
import Button from './src/components/shared/button';
const statuses=['requested','confirmed','confirmed','no_show'];
const entries=statuses.map((status,i)=>({id:String(i),kind:'seats',version:1,scopeId:'s',startsAt:'2026-09-03T09:00:00Z',endsAt:'2026-09-03T10:30:00Z',status,customerName:['承認を待つ予約','期限付きの仮押さえ','確定した予約','無断キャンセル'][i],guestCount:2,resourceIds:['t'+i],resourceLabel:'卓'+i,source:'phone',courseName:null,note:null,dining:null,currentAllergy:i===1?'そば・小麦':null,holdExpiresAt:i===1?'2026-09-03T10:00:00Z':null}));
function Fixture(){const [kind,setKind]=useState(''),[lines,setLines]=useState(1),[opened,setOpened]=useState('');const description=lines===1?'説明の文です。':<>説明の一行目です。<br/>説明の二行目です。</>;return <main>
<ReservationBoard entries={entries} resources={entries.map(e=>({id:e.resourceIds[0],label:e.resourceLabel,active:true,capacity:2}))} dates={['2026-09-03']} onOpen={setOpened}/><output>{opened}</output>
{['confirm','send','cancel','stacked','long-confirm','create','drawer','inset'].map(k=><button key={k} onClick={()=>setKind(k)}>{k}</button>)}
<button onClick={()=>setLines(lines===1?2:1)}>説明を切り替える</button>
{['confirm','send','cancel','stacked'].includes(kind)?<ConfirmDialog open designLayout={kind==='stacked'?'stacked':undefined} title={kind==='confirm'?'削除しますか？':kind==='send'?'送信しますか？':'取り消しますか？'} description={description} destructive={kind==='confirm'} confirmLabel={kind==='confirm'?'削除する':kind==='send'?'送る':'取り消す'} onCancel={()=>setKind('')} onConfirm={()=>setKind('')}/>:kind==='drawer'?<Drawer open title="引き出しの題" description={description} onClose={()=>setKind('')} footer={<Button onClick={()=>setKind('')}>保存する</Button>}>{Array.from({length:40},(_,i)=><p key={i}>本文{i}</p>)}</Drawer>:<Dialog open={!!kind} layout={kind==='inset'?'inset':undefined} title={kind==='create'?'作る窓の題':'確認の題'} description={description} steps={kind==='create'?<span>手順</span>:undefined} confirmation={kind==='long-confirm'} onCancel={()=>setKind('')} onConfirm={()=>setKind('')} confirmLabel="保存する">{kind==='long-confirm'?<div>{Array.from({length:40},(_,i)=><div key={i}><input aria-label={'入力'+i}/></div>)}</div>:kind==='create'?<input aria-label="名前"/>:null}</Dialog>}
</main>}
function SlotFixture(){const [selected,setSelected]=useState('');const resources=[{id:'staff',label:'担当',active:true,capacity:1}];const slots=[{resourceId:'staff',startsAt:'2026-09-03T01:00:00Z'}];return <main>
<section aria-label="横の空き枠"><ReservationBoard kind="people" entries={[]} resources={resources} dates={['2026-09-03']} slots={slots} canWrite onOpen={()=>{}} onSlot={()=>setSelected('horizontal')}/></section>
<section aria-label="縦の空き枠"><ReservationBoard kind="people" timeDirection="vertical" entries={[]} resources={resources} dates={['2026-09-03']} slots={slots} canWrite onOpen={()=>{}} onSlot={()=>setSelected('vertical')}/></section>
<section aria-label="カレンダーの空き枠"><CalendarSlotButton onClick={()=>setSelected('calendar')}>＋ 予約を入れる</CalendarSlotButton></section><output>{selected}</output>
</main>}
createRoot(document.getElementById('root')).render(globalThis.slotFixture?<SlotFixture/>:<Fixture/>);
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
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const css = [await compileUiStyles(fileURLToPath(new URL('../../src/app/globals.css', import.meta.url))), ...sheets].join('\n')

async function mount(page, width, slots = false) {
  await page.setViewportSize({width,height:1000})
  await page.clock.setFixedTime(new Date('2026-09-03T09:24:00Z'))
  await page.setContent(`<html data-theme="v8"><style>${css}main{padding:24px}</style><div id="root"></div></html>`)
  await page.evaluate(value => { globalThis.slotFixture = value }, slots)
  await page.addScriptTag({content:compiled.outputFiles[0].text})
  await page.getByRole('button',{name:slots?'＋ 予約を入れる':'confirm',exact:true}).waitFor()
}

for (const width of [1152,1440]) test(`予約と窓の文字が切れず、状態と操作が保たれる ${width}`, async () => {
  const browser = await connectGuardBrowser()
  const page = await browser.newPage({deviceScaleFactor:2,reducedMotion:'reduce'})
  try {
    await mount(page,width)
    if (process.env.FAULT_BOOKING_LAYOUT) await page.addStyleTag({content:'[data-placement="timeline"]{max-height:24px!important}'})
    const metrics = await page.evaluate(() => {
      const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}}
      const cards=[...document.querySelectorAll('button[data-placement="timeline"]')].map(e=>{
        const b=box(e),s=getComputedStyle(e),texts=[e.firstElementChild,e.lastElementChild.firstElementChild,...e.lastElementChild.lastElementChild.children].map(t=>({text:t.textContent,box:box(t),scroll:t.scrollHeight,client:t.clientHeight,title:t.title,warning:t.hasAttribute('data-booking-warning')}))
        return {state:e.dataset.bookingState,box:b,border:parseFloat(s.borderTopWidth),menu:box(e.lastElementChild.firstElementChild),meta:box(e.lastElementChild.lastElementChild),description:e.getAttribute('aria-description'),texts}
      })
      const now=document.querySelector('[data-booking-now]'),label=box(now.firstElementChild)
      const ticks=[...document.querySelectorAll('[class*="timeHead"]>span')].map(e=>{const r=document.createRange();r.selectNodeContents(e);return box(r)})
      const legend=[...document.querySelectorAll('[aria-label="予約の状態"] [role="listitem"]')].map(e=>e.textContent)
      return {cards,label,ticks,legend,overflow:document.documentElement.scrollWidth-innerWidth}
    })
    assert.equal(metrics.overflow,0)
    assert.equal(metrics.cards.length,4)
    assert.equal(new Set(metrics.cards.map(c=>c.box.h)).size,1)
    for (const card of metrics.cards) {
      assert.equal(card.texts.length,card.state==='hold'?6:card.state==='confirmed'?4:5,'名前と時刻・メニュー・電話・人数、未確定だけ状態、注意は印と全文で表示する')
      assert.equal(card.texts.filter(t=>t.text==='2名').length,1,'飲食の人数も省かない')
      assert.ok(card.menu.w>0 && card.menu.right<=card.meta.x,'メニューと札の領域を分け、メニューを消さない')
      if(card.state==='hold'){assert.ok(card.description.includes('そば・小麦'));assert.equal(card.texts.find(t=>t.warning).title,'⚠ そば・小麦')}
      for (const t of card.texts) {
        assert.ok(t.box.h>=16 && t.client>=t.scroll,JSON.stringify(t))
        assert.ok(t.box.y>=card.box.y+card.border && t.box.bottom<=card.box.bottom-card.border,JSON.stringify({card,t}))
        assert.ok(t.box.x>=card.box.x+card.border && t.box.right<=card.box.right-card.border,JSON.stringify({card,t}))
      }
      assert.deepEqual(card.texts.slice(0,3).map(t=>Math.round(t.box.y-card.box.y)),metrics.cards[0].texts.slice(0,3).map(t=>Math.round(t.box.y-metrics.cards[0].box.y)))
    }
    const accessibility = await page.context().newCDPSession(page)
    try {
      const tree = await accessibility.send('Accessibility.getFullAXTree')
      const hold = tree.nodes.find(node=>node.role?.value==='button' && node.name?.value?.includes('期限付きの仮押さえ'))
      assert.ok(hold?.description?.value?.includes('注意：そば・小麦'),'焦点で注意の全文を読み上げる')
      assert.equal((hold.description.value.match(/電話/g)||[]).length,1,'電話は読み上げでも1回だけ')
    } finally { await accessibility.detach() }
    const metaOverlap = () => page.locator('button[data-placement="timeline"]').first().evaluate(card=>{
      const menu=card.lastElementChild.firstElementChild.getBoundingClientRect(),meta=card.lastElementChild.lastElementChild.getBoundingClientRect()
      return Math.min(menu.right,meta.right)-Math.max(menu.left,meta.left)>0.5
    })
    assert.equal(await metaOverlap(),false)
    await page.locator('button[data-placement="timeline"]').first().evaluate(card=>{
      const menu=card.lastElementChild.firstElementChild.getBoundingClientRect(),meta=card.lastElementChild.lastElementChild,rect=meta.getBoundingClientRect()
      meta.style.transition='none';meta.style.setProperty('transform',`translateX(-${rect.left-menu.right+Math.min(menu.width,rect.width)/2}px)`,'important')
    })
    await paint(page)
    assert.equal(await metaOverlap(),true,JSON.stringify(await page.locator('button[data-placement="timeline"]').first().evaluate(card=>{const m=card.lastElementChild.lastElementChild;return {message:'札をメニューへ重ねる故障を検知する',display:getComputedStyle(m).display,transform:getComputedStyle(m).transform,menu:card.lastElementChild.firstElementChild.getBoundingClientRect().toJSON(),meta:m.getBoundingClientRect().toJSON()}})))
    await page.locator('button[data-placement="timeline"]').first().evaluate(card=>{card.lastElementChild.lastElementChild.style.removeProperty('transform')})
    await paint(page)
    assert.equal(await metaOverlap(),false,JSON.stringify(await page.locator('button[data-placement="timeline"]').first().evaluate(card=>{const menu=card.lastElementChild.firstElementChild,m=card.lastElementChild.lastElementChild;return {message:'配置を戻すと重なりも解消する',transform:getComputedStyle(m).transform,style:m.getAttribute('style'),metaAnimations:m.getAnimations().length,cardAnimations:card.getAnimations().length,menu:menu.getBoundingClientRect().toJSON(),meta:m.getBoundingClientRect().toJSON()}})))
    await page.locator('button[data-placement="timeline"]').first().evaluate(card=>{card.lastElementChild.lastElementChild.style.removeProperty('transition')})
    for(const tick of metrics.ticks) assert.ok(metrics.label.bottom<=tick.y || metrics.label.y>=tick.bottom || metrics.label.right<=tick.x || metrics.label.x>=tick.right,'今の時刻と時刻の見出しが重ならない')
    // 色の見本は表に出ている状態だけ。重なりの無い日は「重なり」を出さず、全部は「印の見方」で読む。
    assert.deepEqual(metrics.legend,['確定','仮押さえ','要対応（承認待ち）','無断キャンセル'])
    const legendHelp=page.getByRole('button',{name:'予約の印の見方',exact:true})
    await legendHelp.click()
    assert.equal(await legendHelp.getAttribute('aria-expanded'),'true')
    const all=await page.locator('[aria-label="予約の印の見方"] [role="listitem"]').allTextContents()
    assert.equal(all.length,9)
    assert.ok(all.includes('重なり・受付数超過'))
    assert.equal(all.filter(x=>x.startsWith('要対応')).length,1)
    await page.keyboard.press('Escape')
    assert.equal(await legendHelp.getAttribute('aria-expanded'),'false')
    await page.getByRole('button',{name:/承認を待つ予約/}).click()
    assert.equal(await page.locator('output').textContent(),'0')
    for (const kind of ['confirm','send','cancel','stacked','long-confirm','create','drawer','inset']) for (const lines of [1,2]) {
      await page.getByRole('button',{name:kind,exact:true}).click()
      const panel=page.locator('[data-design-part="dialog"],[data-design-part="drawer"]')
      await panel.waitFor()
      // Drawer は初回マウント後に portal へ移る。接続先が確定してから寸法を測る。
      await paint(page)
      const gap=await panel.evaluate(e=>{
        const desc=document.getElementById(e.getAttribute('aria-describedby')),header=desc.closest('header,[class*="headerRow"]')
        const h=(header??desc).getBoundingClientRect(),d=desc.getBoundingClientRect()
        return {gap:h.bottom-(header?parseFloat(getComputedStyle(header).borderBottomWidth):0)-d.bottom,lineCount:d.height/parseFloat(getComputedStyle(desc).lineHeight)}
      })
      assert.equal(gap.gap,['inset','confirm','send','cancel','stacked','long-confirm'].includes(kind)?0:24,`${kind} ${lines}行`)
      assert.equal(gap.lineCount,lines)
      const actionGap=await panel.evaluate(e=>{
        const actions=e.querySelector('[data-dialog-actions]')??e.querySelector('[data-window-actions]'),button=actions?.querySelector('button,a')
        if(!button)return null
        const b=actions.getBoundingClientRect(),r=button.getBoundingClientRect()
        return r.top-b.top-parseFloat(getComputedStyle(actions).borderTopWidth)
      })
      if(actionGap!==null)assert.equal(actionGap,kind==='stacked'?0:24,`${kind} 操作の上余白`)
      const footerMetrics=await panel.evaluate(e=>{
        const a=e.querySelector('[data-dialog-actions]')??e.querySelector('[data-window-actions]'),b=a.querySelector('button,a').getBoundingClientRect(),d=document.getElementById(e.getAttribute('aria-describedby')).getBoundingClientRect(),p=e.getBoundingClientRect();
        return {border:parseFloat(getComputedStyle(a).borderTopWidth),gap:b.top-d.bottom,bottom:p.bottom-b.bottom}
      })
      assert.equal(footerMetrics.border,['confirm','send','cancel','stacked'].includes(kind)?0:1,`${kind} 区切り線`)
      if(['confirm','send','cancel','stacked'].includes(kind)){
        assert.equal(footerMetrics.gap,24,'説明から操作まで24px')
        assert.equal(footerMetrics.bottom,24,'操作の下余白は24pxのまま')
        await panel.locator('[data-dialog-actions]').evaluate(e=>e.style.borderTop='1px solid black')
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-dialog-actions]')).borderTopWidth==='1px')
        const broken=await panel.locator('[data-dialog-actions]').evaluate(e=>parseFloat(getComputedStyle(e).borderTopWidth))
        assert.throws(()=>assert.equal(broken,0),'線の復活を検出する')
        await panel.locator('[data-dialog-actions]').evaluate(e=>e.style.removeProperty('border-top'))
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-dialog-actions]')).borderTopWidth==='0px')
        assert.equal(await panel.locator('[data-dialog-actions]').evaluate(e=>parseFloat(getComputedStyle(e).borderTopWidth)),0)
      }
      if(kind==='long-confirm'||kind==='drawer'){
        const before=await panel.locator('[data-window-actions]').boundingBox()
        const scrolled=await panel.locator(kind==='drawer'?'[class*="body"]':'[class*="content"]').first().evaluate(e=>{e.scrollTop=e.scrollHeight;return e.scrollTop})
        assert.ok(scrolled>0,'長い中身は本文で送る')
        const after=await panel.locator('[data-window-actions]').boundingBox()
        assert.equal(after.y,before.y,'本文を送っても下の操作は動かない')
      }
      if(process.env.LAYOUT_SHOTS){const fs=await import('node:fs');fs.mkdirSync(process.env.LAYOUT_SHOTS,{recursive:true});await panel.screenshot({path:`${process.env.LAYOUT_SHOTS}/${kind}-${lines}line-${width}-2x.png`})}
      await panel.getByRole('button',{name:'閉じる',exact:true}).click()
      await panel.waitFor({state:'hidden'})
      await page.getByRole('button',{name:'説明を切り替える',exact:true}).click()
    }
    if(process.env.LAYOUT_SHOTS) await page.screenshot({path:`${process.env.LAYOUT_SHOTS}/booking-states-fixture-${width}-2x.png`})
  } finally { await page.close(); await browser.close() }
})

for (const touch of [false, true]) test(`予約の空き枠は操作領域を保ち、焦点とタッチでも案内を出す touch=${touch}`, async () => {
  const browser = await connectGuardBrowser()
  const page = await browser.newPage({ viewport: { width: 1152, height: 1000 }, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce' })
  try {
    await mount(page, 1152, true)
    const variants = [['横の空き枠', 'horizontal'], ['縦の空き枠', 'vertical'], ['カレンダーの空き枠', 'calendar']]
    const opacity = locator => locator.evaluate(button => {
      const label = button.querySelector('[class*="slotLabel"]')
      const target = label || button
      return Number(getComputedStyle(target).opacity)
    })
    for (const [name, selected] of variants) {
      const button = page.getByRole('region', { name }).getByRole('button', { name: /予約を入れる/ }).last()
      await button.scrollIntoViewIfNeeded()
      const before = await button.boundingBox()
      assert.ok(before.width > 0 && before.height > 0, '案内が無い時も押せる広さを保つ')
      const region = await page.getByRole('region', { name }).boundingBox()
      assert.ok(before.x>=region.x && before.y>=region.y && before.x+before.width<=region.x+region.width && before.y+before.height<=region.y+region.height, `${name}: 空き枠は担当領域の中 ${JSON.stringify({before,region})}`)
      if (selected === 'vertical') {
        const inside = () => button.evaluate(el => {
          const b=el.getBoundingClientRect(),r=el.closest('section').getBoundingClientRect()
          return b.left>=r.left && b.top>=r.top && b.right<=r.right && b.bottom<=r.bottom
        })
        await button.evaluate(el => { el.style.position='absolute' })
        await paint(page)
        assert.equal(await inside(),false,'縦の空き枠がセルを離れる故障を検知する')
        await button.evaluate(el => { el.style.removeProperty('position') })
        await paint(page)
        assert.equal(await inside(),true,'縦の空き枠をセルの配置へ戻すと領域内に戻る')
      }
      if (touch) {
        const visiblePlus = await button.evaluate(button => {
          const plus = button.querySelector('[class*="touchPlus"]')
          return plus ? getComputedStyle(plus).display !== 'none' && plus.textContent === '＋' : getComputedStyle(button, '::before').content.includes('＋')
        })
        assert.ok(visiblePlus, `${name}: タッチでは小さな＋を常時出す`)
        await button.tap()
      } else {
        await page.mouse.move(0, 0)
        await page.evaluate(() => document.activeElement?.blur())
        await paint(page)
        assert.equal(await opacity(button), 0, `${name}: 通常は案内を隠す`)
        await button.hover()
        await paint(page)
        assert.equal(await opacity(button), 1, `${name}: 乗せると案内が出る`)
        await page.mouse.move(0, 0)
        await page.keyboard.press('Tab')
        await button.focus()
        await paint(page)
        const focused = await button.evaluate(el=>({active:document.activeElement===el,focus:el.matches(':focus'),focusVisible:el.matches(':focus-visible'),within:el.parentElement.matches(':focus-within'),className:el.className,opacity:getComputedStyle(el).opacity,tabIndex:el.tabIndex,disabled:el.disabled}))
        assert.equal(await opacity(button), 1, `${name}: 焦点でも案内が出る ${JSON.stringify(focused)}`)
        const after = await button.boundingBox()
        assert.deepEqual(after, before, '案内の出し入れで操作領域を変えない')
        await page.keyboard.press('Enter')
      }
      assert.equal(await page.locator('output').textContent(), selected, `${name}: 予約操作を保つ`)
    }
  } finally { await page.close(); await browser.close() }
})
