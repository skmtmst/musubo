import test from 'node:test'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connectGuardBrowser } from './browser-session.mjs'
import { compileUiStyles } from './compile-ui-styles.mjs'
import scan from './owner-rules-browser.mjs'
const require = createRequire(import.meta.url)
const fromVitest = createRequire(require.resolve('vitest/package.json'))
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')
const webRoot = fileURLToPath(new URL('../..', import.meta.url))
const sheets = []
const compiled = await build({
 stdin: {resolveDir:webRoot,loader:'tsx',contents:`
import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
import Dialog from './src/components/shared/dialog';
import Drawer from './src/components/shared/drawer';
import ActionMenu from './src/components/shared/action-menu';
import MultiSelect from './src/components/shared/multi-select';
import Combobox from './src/components/shared/combobox';
import DateField from './src/components/shared/date-field';
import ColorWell from './src/components/shared/color-well';
import FolderColorButton from './src/components/shared/folder-color-button';
import TooltipBubble from './src/components/shared/tooltip-bubble';
import CommandPalette from './src/components/shared/command-palette';
import {FilterPopover} from './src/components/shared/filter-popover';
import NotificationPanel from './src/components/shared/notification-panel';
import MessageInsertRow from './src/components/shared/message-insert-row';
function Fixture(){const [open,setOpen]=useState(''),actionAnchor=useRef(null),noticeAnchor=useRef(null);const close=()=>setOpen('');return <main>
<button onClick={()=>setOpen('dialog')}>窓を開く</button><button onClick={()=>setOpen('drawer')}>引出を開く</button>
<button ref={actionAnchor} onClick={()=>setOpen('action')}>操作を開く</button>
<button onClick={()=>setOpen('multi')}>複数を開く</button><button onClick={()=>setOpen('combo')}>連想を開く</button>
<button onClick={()=>setOpen('date')}>暦を開く</button><button onClick={()=>setOpen('color')}>色を開く</button>
<button onClick={()=>setOpen('foldercolor')}>箱色を開く</button><button onClick={()=>setOpen('palette')}>命令を開く</button>
<button onClick={()=>setOpen('filter')}>絞りを開く</button>
<button ref={noticeAnchor} onClick={()=>setOpen('notice')}>通知面を開く</button><button onClick={()=>setOpen('message')}>差込を開く</button>
<p>後ろの文字：作り直す・数のカード・設定</p>
<TooltipBubble id="guard-tip" text="検査の吹き出し" left={120} top={300} below={false} />
<CommandPalette items={[{id:'go',label:'検査へ行く',href:'#go'}]} />
<Dialog open={open==='dialog'} title="検査の窓" onCancel={close} footer={<button type="button" onClick={close}>閉じる</button>}>本文</Dialog>
<Drawer open={open==='drawer'} title="検査の引出" onClose={close}>本文</Drawer>
<ActionMenu open={open==='action'} items={[{id:'view',label:'見る',href:'#view'}]} anchorRef={actionAnchor} onClose={close} />
{open==='multi' ? <MultiSelect aria-label="複数検査" options={[{value:'a',label:'あ'}]} values={[]} onChange={()=>{}} defaultOpen /> : null}
{open==='combo' ? <Combobox aria-label="連想検査" options={[{value:'a',label:'あ'}]} value="" onChange={()=>{}} defaultOpen /> : null}
{open==='date' ? <DateField value="" onChange={()=>{}} aria-label="検査日" /> : null}
{open==='color' ? <ColorWell value="#ff0000" onChange={()=>{}} /> : null}
{open==='foldercolor' ? <FolderColorButton value={null} onChange={()=>{}} /> : null}
<FilterPopover open={open==='filter'} onClose={close} label="検査の絞り" trigger={<button type="button">絞る</button>} actions={<button type="button">決める</button>}>条件</FilterPopover>
<NotificationPanel open={open==='notice'} getAnchor={()=>noticeAnchor.current} onClose={close} items={[]} filters={[{id:'all',label:'すべて',count:null}]} activeFilter="all" unreadCount={0} onFilterChange={()=>{}} onMarkAllRead={()=>{}} />
{open==='message' ? <div data-message-body style={{width:'400px'}}><MessageInsertRow more={<button type="button">差1</button>}><button type="button">名</button></MessageInsertRow></div> : null}
</main>}
createRoot(document.getElementById('root')).render(<Fixture/>);`},
 bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',tsconfig: webRoot+'/tsconfig.json',define:{'process.env.NODE_ENV':'"production"','process.env.NEXT_PUBLIC_API_URL':'"http://127.0.0.1:8788"'},
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
/** 面自身に塗りが無ければ、最初に塗りを持つ子を面と見る（走査と同じ決め方）。 */
const MEASURE = (sel) => {
  const root = sel === ':tip' ? document.querySelector('[role="tooltip"]')
    : document.querySelector(sel)
  if (!root) return null
  const css = (el) => getComputedStyle(el)
  const seen = (el) => { const r = el.getBoundingClientRect(); const c = css(el); return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden' }
  const el = css(root).backgroundColor !== 'rgba(0, 0, 0, 0)' ? root
    : [...root.children].find((c) => seen(c) && css(c).backgroundColor !== 'rgba(0, 0, 0, 0)') ?? root
  const c = css(el), color = c.backgroundColor
  const alpha = color === 'transparent' ? 0 : color.startsWith('rgba(') ? Number(color.split(',').at(-1).replace(')', ''))
    : color.includes('/') ? Number(color.split('/').at(-1).replace(')', '').trim()) : 1
  let opacity = 1
  for (let p = el; p; p = p.parentElement) opacity *= Number(css(p).opacity)
  return { alpha, opacity, backdrop: c.backdropFilter, shadow: c.boxShadow }
}
/** MEASURE と同じ面を選ぶ（故障対照の壊し用。測りが透けを見れば選びが合っている証拠になる）。 */
const PICK = (sel) => {
  const root = sel === ':tip' ? document.querySelector('[role="tooltip"]')
    : document.querySelector(sel)
  if (!root) return null
  const css = (el) => getComputedStyle(el)
  const seen = (el) => { const r = el.getBoundingClientRect(); const c = css(el); return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden' }
  return css(root).backgroundColor !== 'rgba(0, 0, 0, 0)' ? root
    : [...root.children].find((c) => seen(c) && css(c).backgroundColor !== 'rgba(0, 0, 0, 0)') ?? root
}
test('全部の開く面は不透明な地と影で読み取れる（F2）', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' })
    for (const width of [1440, 1152]) {
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<html data-theme="v8"><style>${css}main{padding:32px}body{background:#f2f3f5}</style><div id="root"></div></html>`)
      await page.addScriptTag({ content: compiled.outputFiles[0].text })
      const steps = [
        ['窓を開く', '[role="dialog"]', null],
        ['引出を開く', '[role="dialog"]', null],
        ['操作を開く', '[data-menu-portal]', null],
        ['複数を開く', '[data-menu-portal]', null],
        ['連想を開く', '[data-menu-portal]', null],
        ['暦を開く', '[data-menu-portal]', '検査日'],
        ['色を開く', '[data-menu-portal]', '色を選ぶ'],
        ['箱色を開く', '[data-menu-portal]', 'フォルダの色'],
        ['命令を開く', '[role="dialog"]', ':palette'],
        ['絞りを開く', '[data-menu-portal]', null],
        ['通知面を開く', '[data-design-part="notification-panel"]', null],
        ['差込を開く', '[data-menu-portal]', 'その他'],
      ]
      for (const [name, selector, extra] of steps) {
        await page.getByRole('button', { name, exact: true }).click()
        if (extra === ':palette') await page.keyboard.press('Meta+k')
        else if (extra) await page.getByRole('button', { name: extra }).first().click()

        const surface = page.locator(selector === ':tip' ? '[role="tooltip"]' : selector)
        await surface.first().waitFor()
        if (await page.locator('[data-menu-portal]').count()) await page.locator('[data-menu-portal][data-ready="true"]').first().waitFor()
        // 開いた直後の一瞬（子の装着前）を避け、落ち着いた地を測る。透けたままなら落ちる。
        let look = null
        const deadline = Date.now() + 5000
        for (;;) {
          look = await page.evaluate(MEASURE, selector)
          if (look && look.alpha === 1 && look.opacity > 0.999) break
          if (Date.now() > deadline) break
          await page.waitForTimeout(50)
        }
        assert.ok(look, `${name}: 面が見つかる`)
        assert.equal(look.alpha, 1, `${name}: 地は不透明`)
        assert.ok(look.opacity > 0.999, `${name}: 透けなし`)
        assert.ok(!look.backdrop || look.backdrop === 'none', `${name}: すりガラスなし`)
        assert.notEqual(look.shadow, 'none', `${name}: 浮きの影あり`)
        assert.deepEqual((await page.evaluate(scan)).filter((item) => item.kind === 'floating-surface-transparency'), [], name)
        if (process.env.MUSE_SHOTS) { mkdirSync(process.env.MUSE_SHOTS, { recursive: true }); await page.screenshot({ path: `${process.env.MUSE_SHOTS}/floating-all-${width}-${name}.png` }) }
        // 故障対照：同じ取っ手を壊して戻す（選び直さないので選び違いがない）。
        // 走査の対象面は、走査が赤になることまで見る。
        const scanned = selector !== '[role="dialog"]'
        const handle = await page.evaluateHandle(PICK, selector)
        assert.ok(await handle.evaluate((el) => el !== null), `${name}: 故障対照の面が見つかる`)
        const turned = await handle.evaluate((el) => {
          const original = el.style.cssText
          el.style.setProperty('transition', 'none', 'important')
          el.style.setProperty('background', 'rgba(255,255,255,.6)', 'important')
          return original
        })
        const broken = await page.evaluate(MEASURE, selector)
        assert.ok(broken.alpha < 1, `${name}: 故障対照は透けとして測れる`)
        if (scanned) assert.ok((await page.evaluate(scan)).some((item) => item.kind === 'floating-surface-transparency'), `${name}: 故障対照は走査で赤になる`)
        await handle.evaluate((el, original) => { el.style.cssText = original }, turned)
        await handle.dispose()
        if (extra === ':palette') await page.keyboard.press('Meta+k')
        else if (name === '色を開く') await page.getByRole('button', { name: '色を選ぶ' }).first().click()
        else await page.keyboard.press('Escape')
      }
      // 吹き出しは常に出して測る（指し示し待ちの開閉は持たない）。
      const tip = await page.evaluate(MEASURE, ':tip')
      assert.ok(tip, '吹き出し: 面が見つかる')
      assert.equal(tip.alpha, 1, '吹き出し: 地は不透明')
      assert.notEqual(tip.shadow, 'none', '吹き出し: 浮きの影あり')
      assert.deepEqual((await page.evaluate(scan)).filter((item) => item.kind === 'floating-surface-transparency'), [], '吹き出し')
      const tipHandle = await page.evaluateHandle(PICK, ':tip')
      const tipOriginal = await tipHandle.evaluate((el) => {
        const original = el.style.cssText
        el.style.setProperty('transition', 'none', 'important')
        el.style.setProperty('background', 'rgba(255,255,255,.6)', 'important')
        return original
      })
      assert.ok((await page.evaluate(scan)).some((item) => item.kind === 'floating-surface-transparency'), '吹き出し: 故障対照は走査で赤になる')
      await tipHandle.evaluate((el, original) => { el.style.cssText = original }, tipOriginal)
      await tipHandle.dispose()
    }
  } finally { await browser.close() }
})
