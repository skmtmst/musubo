import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectGuardBrowser } from './browser-session.mjs'
import { stubApi } from './speed-budget.mjs'
import { mockFetch } from './mock-local.mjs'
import { PARITY_INIT } from '../../../../scripts/visual-qa/v8-parity.mjs'
import { AUTOMATION_RUNS } from '../../../../scripts/visual-qa/fixtures.mjs'
import { detailSurfaceCases } from './detail-surface-cases.mjs'
import scanDetailSurfaces from './detail-surface-browser.mjs'

const root = process.env.V8_GUARD_DETAIL_OUT ? resolve(process.env.V8_GUARD_DETAIL_OUT) : fileURLToPath(new URL('../../out/', import.meta.url))
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
async function fixture(method, path, screen) {
  if (method === 'OPTIONS') return {status: 204, body: ''}
  if (!['GET','HEAD'].includes(method)) throw new Error(`詳細の見張りで書き込みはしない: ${method} ${path}`)
  const pathname = path.split('?')[0]
  if (screen === 'restaurant-line-followup' && method === 'GET') {
    const match = pathname.match(/^\/api\/restaurant-test\/followups\/([^/]+)(\/engines|\/reservation-form)?$/)
    if (match?.[2] === '/engines') {
      const page = JSON.parse((await mockFetch(method, `/api/restaurant-test/followups/${match[1]}`)).body).data
      const legacyContents = page.rows.map(row => ({trigger:row.trigger,content:{timing:{mode:'countdown',offsetMinutes:row.default_offset_minutes},messageParts:[{messageType:'text',messageContent:row.initial_message}]}}))
      return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify({success:true,data:{engines:[],legacyContents,testRecipient:{state:'ready',recipientKind:'self',recipient:{id:'self',displayName:'本人',pictureUrl:null}}}})}
    }
    if (match?.[2] === '/reservation-form') {
      const fields = [['name','お名前'],['dateTime','日にち・時間'],['guestCount','人数'],['phone','電話番号'],['allergy','アレルギー'],['note','ご要望']].map(([id,label],index)=>({id,label,enabled:true,required:index<3}))
      return {status:200,headers:{'content-type':'application/json'},body:JSON.stringify({success:true,data:{version:0,definition:{title:'ご予約',completionMessage:'ご予約を受け付けました。',fields}}})}
    }
  }
  const answer = await mockFetch(method,path)
  if (!answer.body?.trim().startsWith('{')) return answer
  const data = JSON.parse(answer.body)
  if (['/api/staff/me','/api/auth/session'].includes(pathname)) data.data = {...data.data,id:'detail-owner',name:'画面確認のオーナー',tenantId:'visual-tenant-1',role:'owner',readOnly:false,accountScope:'all',impersonation:null,permissionKeys:[],permissionViewKeys:[],viewPermissionKeys:[]}
  if (/^\/api\/automation-runs\/run-[0-9]+$/.test(pathname)) {
    const row = AUTOMATION_RUNS.items.find(row => row.id === pathname.split('/').pop()) ?? AUTOMATION_RUNS.items[0]
    data.data = {...row,friendId:'friend-1',friendName:row.subject,automationVersionId:'fixture-version',isTest:row.isTest??false,canCancel:row.canCancel??false,holdReason:null,isCurrentVersion:true,currentVersionNumber:row.versionNumber,steps:[]}
  }
  if (pathname === '/api/dashboard/style' && ['ec-orders','identity-candidates'].includes(screen)) data.data = {...data.data,style:'ec',styleSelected:true}
  if (pathname === '/api/booking/admin/entitlements') data.data = [{id:'detail-ticket',line_account_id:'visual-qa-account',friend_id:'friend-1',menu_id:null,kind:'ticket',name:'見本の回数券',remaining:3,monthly_limit:null,valid_from:'2026-10-01T00:00:00+09:00',expires_at:'2026-12-31T23:59:59+09:00',status:'active',version:1,created_at:'2026-10-01T00:00:00+09:00',updated_at:'2026-10-01T00:00:00+09:00',monthUsed:0,monthAllowance:null,monthRemaining:null,periodStart:'2026-10-01',periodEnd:'2026-10-31'}]
  if (pathname === '/api/booking/admin/entitlements/detail-ticket/history') data.data = []
  return {...answer,body:JSON.stringify(data)}
}

// 編集窓の LINE 見本は詳細本文ではないため、実際の見本と窓の境界を測る。
function scanFollowupPreview() {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].find(el => el.querySelector('aside[aria-label="届き方"]'))
  const aside = dialog?.querySelector('aside[aria-label="届き方"]')
  const phone = aside?.querySelector('[data-line-preview-part="phone"]')
  const frame = phone?.querySelector('[data-line-preview-part="device-frame"]')
  const talk = phone?.querySelector('[data-line-preview-part="talk"]')
  const footer = dialog?.querySelector('[data-window-actions]')
  const errors = []
  if (!dialog || !aside || !phone || !frame || !talk) return ['missing']
  const box = frame.getBoundingClientRect(), talkBox = talk.getBoundingClientRect(), area = aside.getBoundingClientRect(), windowBox = dialog.getBoundingClientRect()
  if (!box.width || !box.height || !talkBox.width || !talkBox.height || getComputedStyle(frame).visibility !== 'visible' || getComputedStyle(talk).visibility !== 'visible' || !talk.innerText.includes('ご予約ありがとうございます。')) errors.push('missing')
  if (box.left < area.left - 1 || box.right > area.right + 1 || box.left < windowBox.left - 1 || box.right > windowBox.right + 1 || box.bottom > area.bottom + 1) errors.push('overflow')
  if (!footer) errors.push('missing-footer')
  else {
    const bar = footer.getBoundingClientRect()
    if (box.right > bar.left && box.left < bar.right && box.bottom > bar.top + 1 && box.top < bar.bottom) errors.push('footer-overlap')
  }
  return errors
}
async function checkFollowupPreview(page, width) {
  const dialog = page.getByRole('dialog', {name:'予約したときを変える'})
  const aside = dialog.locator('aside[aria-label="届き方"]')
  await aside.waitFor({state:'attached'})
  const id = await aside.getAttribute('id')
  if (!(await aside.isVisible())) await dialog.locator(`button[aria-controls="${id}"]`).click()
  await aside.waitFor({state:'visible'})
  const phone = aside.locator('[data-line-preview-part="phone"]')
  await phone.waitFor({state:'visible'})
  await page.waitForFunction(()=>document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).every(a=>a.playState!=='running'))
  assert.equal(await page.evaluate(()=>localStorage.getItem('lh_staff_role')),'owner')
  assert.deepEqual(await page.evaluate(scanDetailSurfaces), [], `共通詳細の見張り ${width}`)
  const frame = phone.locator('[data-line-preview-part="device-frame"]')
  const talk = phone.locator('[data-line-preview-part="talk"]')
  const footer = dialog.locator('[data-window-actions]')
  const check = () => page.evaluate(scanFollowupPreview)
  assert.deepEqual(await check(), [], `見本 ${width}`)
  const measureTalk = () => talk.evaluate(el => el.scrollWidth > el.clientWidth + 1)
  assert.equal(await measureTalk(), false, `本文のはみ出しなし ${width}`)
  const wide = await talk.evaluateHandle(el=>{const child=document.createElement('div');child.style.width='3000px';child.textContent='はみ出す故障';el.append(child);return child})
  assert.equal(await measureTalk(), true, `本文のはみ出し故障 ${width}`)
  await wide.evaluate(el=>el.remove())
  assert.equal(await measureTalk(), false, `本文の幅を復元 ${width}`)

  await talk.evaluate(el => { for (const child of [...el.children].slice(1)) { child.dataset.guardOldDisplay=child.style.display;child.style.display='none' } })
  assert.ok((await check()).includes('missing'), `見本が消えた故障 ${width}`)
  await talk.evaluate(el => { for (const child of [...el.children].slice(1)) { child.style.display=child.dataset.guardOldDisplay;delete child.dataset.guardOldDisplay } })
  assert.deepEqual(await check(), [], `見本を復元 ${width}`)
  await frame.evaluate(el => { el.dataset.guardOldStyle=el.getAttribute('style')??'';el.style.setProperty('transition','none','important');el.style.setProperty('transform','translateX(1000px)','important') })
  assert.ok((await check()).includes('overflow'), `見本のはみ出し ${width}`)
  await frame.evaluate(el => { const old=el.dataset.guardOldStyle;el.setAttribute('style',old);el.style.setProperty('transition','none','important');el.dataset.guardOldStyle=old })
  assert.deepEqual(await check(), [], `幅を復元 ${width}`)
  await frame.evaluate(el => { el.setAttribute('style',el.dataset.guardOldStyle);delete el.dataset.guardOldStyle })
  const bounds = await frame.boundingBox()
  await footer.evaluate((el,box) => { el.dataset.guardOldStyle=el.getAttribute('style')??'';el.style.setProperty('transition','none','important');el.style.setProperty('transform',`translateY(${box.y + 10 - el.getBoundingClientRect().top}px)`,'important') }, bounds)
  assert.ok((await check()).includes('footer-overlap'), `操作帯に隠れる故障 ${width}`)
  await footer.evaluate(el => { el.setAttribute('style',el.dataset.guardOldStyle);el.style.setProperty('transition','none','important');delete el.dataset.guardOldStyle })
  assert.deepEqual(await check(), [], `操作帯を復元 ${width}`)
  await page.setViewportSize({width,height:720})
  await page.waitForFunction(()=>document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).every(a=>a.playState!=='running'))
  const body = dialog.locator('[data-window-body]')
  const lowCheck = () => page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(el=>el.querySelector('aside[aria-label="届き方"]'))
    const body=dialog.querySelector('[data-window-body]'), frame=dialog.querySelector('aside[aria-label="届き方"] [data-line-preview-part="device-frame"]'), bar=dialog.querySelector('[data-window-actions]')
    const b=body.getBoundingClientRect(), f=frame.getBoundingClientRect(), a=bar.getBoundingClientRect(), d=dialog.getBoundingClientRect()
    const errors=[]
    if (!['auto','scroll'].includes(getComputedStyle(body).overflowY) || body.scrollHeight <= body.clientHeight || body.scrollTop < body.scrollHeight-body.clientHeight-1) errors.push('scroll')
    if (!a.width || !a.height || a.top < d.top-1 || a.bottom > d.bottom+1 || a.bottom > innerHeight+1 || d.top < -1) errors.push('footer')
    if (f.bottom > b.bottom+1 || f.bottom > a.top+1 || f.bottom < b.top || !frame.contains(document.elementFromPoint((f.left+f.right)/2,f.bottom-5))) errors.push('preview-clipped')
    return errors
  })
  await body.evaluate(el=>{el.style.scrollBehavior='auto';el.scrollTop=el.scrollHeight})
  assert.deepEqual(await lowCheck(), [], `低い画面で下まで見える ${width}`)
  await body.evaluate(el=>{el.dataset.guardOldOverflow=el.style.overflowY;el.style.overflowY='hidden'})
  assert.ok((await lowCheck()).includes('scroll'), `スクロールできない故障 ${width}`)
  await body.evaluate(el=>{el.style.overflowY=el.dataset.guardOldOverflow;delete el.dataset.guardOldOverflow;el.scrollTop=el.scrollHeight})
  assert.deepEqual(await lowCheck(), [], `スクロール復元 ${width}`)
  await footer.evaluate(el=>{el.dataset.guardOldStyle=el.getAttribute('style')??'';el.style.setProperty('transition','none','important');el.style.setProperty('transform',`translateY(${innerHeight-el.getBoundingClientRect().top+10}px)`,'important')})
  assert.ok((await lowCheck()).includes('footer'), `操作帯が画面外の故障 ${width}`)
  await footer.evaluate(el=>{el.setAttribute('style',el.dataset.guardOldStyle);el.style.setProperty('transition','none','important');delete el.dataset.guardOldStyle})
  assert.deepEqual(await lowCheck(), [], `画面内の操作帯を復元 ${width}`)
  const frameBottom = (await frame.boundingBox()).y + (await frame.boundingBox()).height
  await footer.evaluate((el,bottom)=>{el.dataset.guardOldStyle=el.getAttribute('style')??'';el.style.setProperty('transition','none','important');el.style.setProperty('transform',`translateY(${bottom-10-el.getBoundingClientRect().top}px)`,'important')},frameBottom)
  assert.ok((await lowCheck()).includes('preview-clipped'), `操作帯が見本に重なる故障 ${width}`)
  await footer.evaluate(el=>{el.setAttribute('style',el.dataset.guardOldStyle);el.style.setProperty('transition','none','important');delete el.dataset.guardOldStyle})
  assert.deepEqual(await lowCheck(), [], `見本と操作帯を復元 ${width}`)
  await aside.evaluate(el=>{el.dataset.guardOldStyle=el.getAttribute('style')??'';el.style.maxHeight='300px';el.style.overflow='hidden'})
  assert.ok((await lowCheck()).includes('preview-clipped'), `見本が途中で切れる故障 ${width}`)
  await aside.evaluate(el=>{el.setAttribute('style',el.dataset.guardOldStyle);el.style.setProperty('transition','none','important');delete el.dataset.guardOldStyle})
  await body.evaluate(el=>{el.scrollTop=el.scrollHeight})
  assert.deepEqual(await lowCheck(), [], `見本の切れを復元 ${width}`)
  await page.setViewportSize({width,height:1100})
}

for (const width of [1152,1440]) test(`実際の詳細面と届き方プレビューを測る ${width}`, async () => {

  assert.ok(existsSync(join(root,'version.json')), 'AIと飲食店の検査用フラグを有効にした本番形式buildが必要')
  const server = createServer((req,res) => {
    const path = resolve(root, `.${new URL(req.url,'http://localhost').pathname}`)
    const file = [path,`${path}.html`,join(path,'index.html')].find(file => file.startsWith(root) && existsSync(file) && statSync(file).isFile())
    if (!file) {res.writeHead(404);res.end();return}
    res.writeHead(200,{'content-type':mime[extname(file)]??'application/octet-stream'});res.end(readFileSync(file))
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const browser = await connectGuardBrowser()
  try {
    for (const item of detailSurfaceCases) {
      const page = await browser.newPage({viewport:{width,height:1100},reducedMotion:'reduce'})
      try {
        await stubApi(page,(method,path)=>fixture(method,path,item.key))
        await page.addInitScript(init => {
          for (const [key,value] of Object.entries(init)) localStorage.setItem(key,value)
          const original = window.fetch.bind(window);window.__detailPending=0
          window.fetch=async(...args)=>{window.__detailPending++;try{return await original(...args)}finally{window.__detailPending--}}
        },PARITY_INIT)
        assert.ok((await page.goto(base+item.path))?.ok(),item.key)
        const ready = async () => { await page.waitForFunction(()=>window.__detailPending===0 && document.fonts.status==='loaded' && document.querySelector('main')) }
        await ready()
        for (const action of item.actions??[]) {await (typeof action === 'string' ? page.locator(action) : page.getByRole(action.role,{name:action.name,exact:true})).click();await ready()}
        if (item.kind === 'MessagePreview') {
          await checkFollowupPreview(page, width)
          console.log(`detail surface ${item.key} ${width}: preview healthy / missing, overflow and footer overlap rejected / restored`)
          continue
        }
        const selector = item.selector??'[data-design-part="detail-panel"],[data-design-part="drawer"]'
        const panel=page.locator(selector).first();await panel.waitFor({state:'attached'})
        await ready()
        const toggle = await panel.evaluate(el => el.getBoundingClientRect().width===0 ? [...document.querySelectorAll('button[aria-controls]')].find(button => button.getAttribute('aria-controls')===el.id)?.getAttribute('aria-controls') : null)
        if (toggle) await page.locator(`button[aria-controls="${toggle}"]`).click()
        await panel.waitFor({state:'visible'})
        await page.waitForFunction(()=>document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).every(a=>a.playState!=='running'))
        assert.equal(await page.evaluate(()=>localStorage.getItem('lh_staff_role')),'owner',item.key)
        assert.deepEqual(await page.evaluate(scanDetailSurfaces),[],`${item.key} ${width}`)
        if (item.key==='staff-calendar') {
          await panel.getByRole('textbox',{name:'固定の会議の URL'}).fill('https://meet.example.invalid/changed')
          await panel.getByRole('button',{name:'保存する',exact:true}).waitFor()
          assert.deepEqual(await page.evaluate(scanDetailSurfaces),[],`URL変更中 ${width}`)
        }
        const footer=panel.locator(':scope > footer,[data-detail-preview] > footer').first()
        if (await footer.count()) {
          const actions=await footer.locator('[data-detail-actions]').elementHandle()
          await actions.evaluate(el=>el.removeAttribute('data-detail-actions'))
          assert.ok((await page.evaluate(scanDetailSurfaces)).some(error=>error.kind==='detail-footer'),`${item.key} 自由な帯へ戻す故障`)
          await actions.evaluate(el=>el.setAttribute('data-detail-actions',''))
          assert.deepEqual(await page.evaluate(scanDetailSurfaces),[],`${item.key} 帯の復元`)
        }
        const body=await panel.locator('[data-detail-content]').first().elementHandle()
        const injected=await body.evaluateHandle(el=>{const button=document.createElement('button');button.dataset.sharedButton='';button.dataset.variant='primary';button.textContent='本文の主操作';el.append(button);return button})
        assert.ok((await page.evaluate(scanDetailSurfaces)).some(error=>error.kind==='detail-body-action'),`${item.key} 本文の主操作の故障`)
        await injected.evaluate(el=>el.remove());assert.deepEqual(await page.evaluate(scanDetailSurfaces),[],`${item.key} 主操作の復元`)
        const saved=await body.getAttribute('data-detail-content')
        await body.evaluate(el=>el.removeAttribute('data-detail-content'))
        assert.ok((await page.evaluate(scanDetailSurfaces)).some(error=>error.kind==='detail-content'),`${item.key} 共通の本文を外す故障`)
        await body.evaluate((el,value)=>el.setAttribute('data-detail-content',value??''),saved)
        assert.deepEqual(await page.evaluate(scanDetailSurfaces),[],`${item.key} 復元`)
        console.log(`detail surface ${item.key} ${width}: healthy / missing body rejected / restored`)
      } catch (error) {
        const dir=fileURLToPath(new URL('../../test-results/detail-surfaces/',import.meta.url));mkdirSync(dir,{recursive:true})
        await page.screenshot({path:join(dir,`${width}-${item.key}.png`)}).catch(()=>{})
        writeFileSync(join(dir,`${width}-${item.key}.json`),JSON.stringify({url:page.url(),error:String(error),text:await page.locator('body').innerText().catch(()=>null)},null,2))
        throw error
      } finally {await page.close()}
    }
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
})
