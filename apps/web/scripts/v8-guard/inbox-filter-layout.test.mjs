import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { compile } from 'tailwindcss'
import { expect } from '@playwright/test'
import { connectGuardBrowser } from './browser-session.mjs'

const require = createRequire(import.meta.url)
const fromVitest = createRequire(require.resolve('vitest/package.json'))
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')
const webRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const sheets = new Set()
const candidates = new Set()
const compiled = await build({
  stdin: { resolveDir: webRoot, loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import InboxFilterPanel from './src/components/chats/inbox-filter-panel';
import {InboxFilterControls,InboxFilterSlot,InboxSortSlot,InboxListName} from './src/components/shared/inbox-list';
import Button from './src/components/shared/button';
import SearchField from './src/components/shared/search-field';
import Select from './src/components/shared/select';
import InboxRulesPopover from './src/v8/inbox-chat/rules-popover';
function Fixture(){
 const [value,setValue]=useState({status:'all',assignee:'all',channel:'all',unreadOnly:false,quickFilter:'all'});
 const [open,setOpen]=useState(false),[query,setQuery]=useState('');
 return <main><section id="tools"><InboxFilterControls>
  <SearchField aria-label="名前を検索" value={query} onChange={setQuery} placeholder="名前・内容で探す"/>
  <InboxFilterSlot data-filter-slot><Button onClick={()=>setOpen(true)}>絞り込み</Button></InboxFilterSlot>
  <InboxSortSlot changed={false} data-sort-slot><Select aria-label="並び" value="latest" onChange={()=>{}} options={[{value:'latest',label:'最新順'}]}/></InboxSortSlot>
 </InboxFilterControls></section>
 <InboxFilterPanel open={open} value={value} operators={[{id:'a',name:'担当者A'}]} unassignedUnreadCount={27}
  auxiliaryActions={<InboxRulesPopover accountId={null}/>}
  onChange={setValue} onReset={()=>setValue({status:'all',assignee:'all',channel:'all',unreadOnly:false,quickFilter:'all'})} onClose={()=>setOpen(false)}/>
 <InboxListName id="unread-name" name="未読のお客さま" unread/>
 <InboxListName id="read-name" name="既読のお客さま" unread={false}/>
 <output>{JSON.stringify(value)}</output></main>
}createRoot(document.getElementById('root')).render(<Fixture/>);
` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  tsconfig: `${webRoot}/tsconfig.json`,
  define: { 'process.env': '{}', 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1:8788"' },
  plugins: [{ name: 'inbox-fixture', setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }))
    builder.onResolve({ filter: /^@\/contexts\/account-context$/ }, () => ({ path: 'account', namespace: 'fixture' }))
    builder.onResolve({ filter: /^next\/link$|^@\/components\/shared\/list-navigation$/ }, () => ({ path: 'link', namespace: 'fixture' }))
    builder.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: 'dynamic', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'navigation'
      ? 'export const useRouter=()=>({push(){},replace(){},prefetch(){}});export const usePathname=()=>"/chats";export const useSearchParams=()=>new URLSearchParams();'
      : path === 'account' ? 'export const useOptionalAccount=()=>null;export const useAccount=()=>({selectedAccountId:null,selectedAccount:null});'
        : path === 'dynamic' ? 'export default function dynamic(){return ()=>null}'
          : 'import React from "react";export default function Link(p){return React.createElement("a",p)}', resolveDir: webRoot }))
    builder.onLoad({ filter: /\.[jt]sx?$/ }, ({ path }) => {
      if (path.startsWith(`${webRoot}/src/`)) {
        for (const token of readFileSync(path, 'utf8').split(/[\s"'`<>{}]+/)) candidates.add(token)
      }
    })
    builder.onLoad({ filter: /\.module\.css$/ }, ({ path }) => {
      let css = readFileSync(path, 'utf8')
      const globals = []
      css = css.replace(/:global\(([^()]*)\)/g, (_, selector) => `GLOBAL_SELECTOR_${globals.push(selector) - 1}`)
      const names = Object.fromEntries([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map(match => [match[1], `inbox_${sheets.size}_${match[1]}`]))
      css = css.replace(/\.([A-Za-z][\w-]*)/g, (_, name) => `.${names[name]}`)
        .replace(/GLOBAL_SELECTOR_(\d+)/g, (_, index) => globals[Number(index)])
      sheets.add(css)
      return { contents: `export default ${JSON.stringify(names)}`, loader: 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, ({ path }) => { sheets.add(readFileSync(path, 'utf8')); return { contents: '', loader: 'js' } })
  } }],
})
const globalsPath = `${webRoot}/src/app/globals.css`
async function globalStyles(tokens) {
  const compiler = await compile(readFileSync(globalsPath, 'utf8').replace('@theme {', '@theme static {'), {
  base: dirname(globalsPath),
  loadStylesheet: async (id, base) => {
    const path = id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : resolve(base, id)
    return { path, base: dirname(path), content: readFileSync(path, 'utf8') }
  },
  })
  return compiler.build(tokens)
}
const [globalsCss, noCandidatesCss] = await Promise.all([globalStyles([...candidates]), globalStyles([])])
const css = [...sheets].join('\n').replace(/:global\(([^()]*)\)/g, '$1')

for (const width of [1152, 1440]) {
  test(`受信箱の内容幅と期限窓・補助操作を保つ ${width}`, async () => {
    const browser = await connectGuardBrowser()
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
      const errors = []
      page.on('pageerror', error => { errors.push(error.message); console.error('inbox fixture:', error.message) })
      await page.route('http://127.0.0.1:8788/**', route => route.fulfill({ json: { success: true, data: { role: 'viewer', readOnly: true } } }))
      await page.setContent(`<html data-theme="v8"><style id="fixture-globals">${globalsCss}</style><style>${css}body{margin:0}main{padding:24px}#tools{width:480px}output{display:block;margin-top:24px}</style><div id="root"></div></html>`)
      await page.addScriptTag({ content: compiled.outputFiles[0].text })
      const filter = page.getByRole('button', { name: '絞り込み', exact: true })
      await expect(filter).toBeVisible()
      const measure = () => page.locator('[data-filter-slot]').evaluate(slot => {
        const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height } }
        return { slot: rect(slot), button: rect(slot.querySelector('button')), row: rect(slot.parentElement), children: [...slot.parentElement.children].map(rect) }
      })
      const healthy = row => Math.abs(row.slot.width - row.button.width) <= 1
        && row.children.every(child => child.width > 0 && child.right <= row.row.right + 1)
        && row.children.slice(1).every((child, index) => child.left >= row.children[index].right)
      const layout = await measure()
      assert.ok(healthy(layout), JSON.stringify(layout))
      const weights = () => page.evaluate(() => ({
        unread: getComputedStyle(document.getElementById('unread-name')).fontWeight,
        read: getComputedStyle(document.getElementById('read-name')).fontWeight,
        regular: getComputedStyle(document.documentElement).getPropertyValue('--polish-weight-body').trim(),
      }))
      const nameWeights = await weights()
      assert.equal(nameWeights.unread, '700')
      assert.equal(nameWeights.read, nameWeights.regular)
      await page.locator('#unread-name').evaluate(async name => {
        name.style.setProperty('--tpl-inbox-unread-weight', 'initial')
        await new Promise(requestAnimationFrame)
      })
      const readBrokenWeight = () => page.locator('#unread-name').evaluate(name => ({
        weight: getComputedStyle(name).fontWeight,
        variable: getComputedStyle(name).getPropertyValue('--tpl-inbox-unread-weight'),
        inline: name.style.cssText,
        parentWeight: getComputedStyle(name.parentElement).fontWeight,
        transitionProperty: getComputedStyle(name).transitionProperty,
        transitionDuration: getComputedStyle(name).transitionDuration,
        rules: [...document.styleSheets].flatMap(sheet => {
          const matching = rules => [...rules].flatMap(rule => [
            ...(rule.selectorText && name.matches(rule.selectorText) && (rule.style.fontWeight || rule.style.getPropertyValue('--tpl-inbox-unread-weight'))
              ? [{ selector: rule.selectorText, weight: rule.style.fontWeight, variable: rule.style.getPropertyValue('--tpl-inbox-unread-weight') }] : []),
            ...(rule.cssRules ? matching(rule.cssRules) : []),
          ])
          return matching(sheet.cssRules)
        }),
      }))
      const immediateWeight = await readBrokenWeight()
      console.log(JSON.stringify({ width, nameWeights, immediateWeight }))
      await expect.poll(async () => (await readBrokenWeight()).weight).toBe(nameWeights.read)
      const brokenWeight = await readBrokenWeight()
      assert.notEqual(brokenWeight.weight, '700', JSON.stringify({ nameWeights, brokenWeight }))
      await page.locator('#unread-name').evaluate(async name => {
        name.style.removeProperty('--tpl-inbox-unread-weight')
        await new Promise(requestAnimationFrame)
      })
      await expect.poll(async () => (await weights()).unread).toBe('700')
      assert.equal((await weights()).unread, '700')
      // 内容幅を壊すと、同じ測定が違反を検出する。
      await page.locator('[data-filter-slot]').evaluate(slot => { slot.style.flex = '1 1 0' })
      await expect.poll(async () => healthy(await measure())).toBe(false)
      const brokenLayout = await measure()
      assert.equal(healthy(brokenLayout), false)
      await page.locator('[data-filter-slot]').evaluate(slot => { slot.style.removeProperty('flex') })
      await expect.poll(async () => healthy(await measure())).toBe(true)
      const restoredLayout = await measure()
      assert.ok(healthy(restoredLayout))
      await filter.click()
      const panel = page.getByRole('dialog', { name: '絞り込み', exact: true })
      await expect(panel).toBeVisible()
      await expect(panel).toHaveCSS('position', 'fixed')
      await expect(panel).toHaveCSS('display', 'flex')
      await expect.poll(async () => Math.abs((await panel.boundingBox()).width - 420) <= 1).toBe(true)
      const measurePanelStyle = () => panel.evaluate(element => ({
        position: getComputedStyle(element).position,
        display: getComputedStyle(element).display,
        width: element.getBoundingClientRect().width,
      }))
      const styled = value => value.position === 'fixed' && value.display === 'flex' && Math.abs(value.width - 420) <= 1
      const panelStyle = await measurePanelStyle()
      await page.locator('#fixture-globals').evaluate((style, value) => { style.textContent = value }, noCandidatesCss)
      await expect.poll(async () => styled(await measurePanelStyle())).toBe(false)
      const noCandidatesStyle = await measurePanelStyle()
      assert.equal(styled(noCandidatesStyle), false)
      await page.locator('#fixture-globals').evaluate((style, value) => { style.textContent = value }, globalsCss)
      await expect.poll(async () => styled(await measurePanelStyle())).toBe(true)
      const restoredStyle = await measurePanelStyle()
      assert.deepEqual(restoredStyle, panelStyle)
      await panel.getByRole('button', { name: '期限で絞り込む' }).click()
      await page.getByRole('option', { name: '1時間以上待ち', exact: true }).getByRole('button').click()
      await expect(page.locator('output')).toContainText('"quickFilter":"overdue"')
      await panel.getByRole('button', { name: '担当者で絞り込む' }).click()
      const picker = page.getByRole('dialog').last()
      await expect(picker.getByText('未読 27件', { exact: true })).toBeVisible()
      await picker.getByRole('radio', { name: '未割り当て', exact: true }).check()
      await picker.getByRole('button', { name: '選択する', exact: true }).click()
      await expect(page.locator('output')).toContainText('"assignee":"unassigned"')
      await panel.getByRole('button', { name: '対応ルール', exact: true }).click()
      const rules = page.getByRole('dialog', { name: '対応ルール', exact: true })
      await expect(rules).toBeVisible()
      await rules.getByRole('link').focus()
      await page.keyboard.press('Escape')
      await expect(rules).toHaveCount(0)
      await expect(panel).toBeVisible()
      const rect = await panel.boundingBox()
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= 900)
      assert.equal(await panel.evaluate(el => el.scrollWidth - el.clientWidth), 0)
      const outputDir = process.env.INBOX_FILTER_SHOTS
      if (outputDir) {
        mkdirSync(outputDir, { recursive: true })
        await page.screenshot({ path: resolve(outputDir, `inbox-filter-${width}.png`) })
        writeFileSync(resolve(outputDir, `inbox-filter-${width}.json`), JSON.stringify({ width, layout, nameWeights, immediateWeight, brokenWeight, brokenLayout, restoredLayout, panelStyle, noCandidatesStyle, restoredStyle, panel: rect, errors }, null, 2))
      }
      await panel.getByRole('button', { name: '絞り込みを閉じる', exact: true }).click()
      await expect(panel).toHaveCount(0)
      await expect(filter).toBeFocused()
      assert.deepEqual(errors, [])
    } finally { await browser.close() }
  })
}
