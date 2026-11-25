import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { chromium } from '@playwright/test'
import { openPage, ROUTES } from './browser-env.mjs'
import { GAP_ROUTES } from './blank-gap.mjs'
import { scanInheritedFont } from './inherited-font-browser.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const map = JSON.parse(readFileSync(join(root, 'scripts/visual-qa/v8-design-map.json'), 'utf8'))
// 許可は画面・部品・文字・サイズまで一致するものに限る。親要素全体は除外しない。
const allowances = JSON.parse(readFileSync(join(import.meta.dirname, 'inherited-font-allowances.json'), 'utf8'))
const routes = [...new Set(Object.values(map.boards).filter(x => x.app !== 'liff' && x.width && x.url && x.url !== '/no-such-page').map(x => x.url))]
for (const route of [...Object.values(ROUTES), ...Object.values(GAP_ROUTES)]) if (!routes.includes(route)) routes.push(route)
function pages(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const part = `${prefix}/${entry.name}`, file = join(dir, entry.name)
    if (entry.isDirectory()) return pages(file, part)
    return entry.name === 'page.tsx' ? [prefix || '/'] : []
  })
}
for (const route of pages(join(root, 'apps/web/src/app'))) {
  // /ops は画面ではなく /ops/tenants への転送。
  if (route === '/ops' || route === '/m' || route.startsWith('/m/') || route.startsWith('/visual-qa/') || route.includes('[')) continue
  if (!routes.some(value => value.split('?')[0] === route)) routes.push(route)
}
export async function runInheritedFontPatrol(baseUrl, targetRoutes = routes) {
  const browser = await chromium.launch()
  const errors = [], findings = []
  try {
    for (const [index, route] of targetRoutes.entries()) {
      let page
      try {
        page = await openPage(browser, { baseUrl, route, width: 1440, stable: true, settleMs: 0, requireSuccess: true })
        if (new URL(page.url()).pathname !== new URL(route, baseUrl).pathname) throw new Error(`画面が移動しました: ${page.url()}`)
        await page.waitForFunction(() => { const main = document.querySelector('main'); return main?.innerText.trim() && !main.querySelector('[aria-busy="true"],[data-list-state="loading"]') }, null, { timeout: 20000 })
        await page.waitForLoadState('networkidle', { timeout: 15000 })
        await page.waitForFunction(() => {
          const main = document.querySelector('main')
          return main?.innerText.trim() && !main.querySelector('[aria-busy="true"],[data-list-state="loading"]') && !/読み込み中|読み込んでいます/.test(main.innerText)
        }, null, { timeout: 20000 })
        for (const finding of await page.evaluate(scanInheritedFont)) {
          if (!allowances.some(a => a.route === route && a.node === finding.node && a.tag === finding.tag && a.text === finding.text && a.px === finding.px)) findings.push({ route, ...finding })
        }
      } catch (error) { errors.push({ route, error: error.message }) }
      finally { await page?.close() }
      if ((index + 1) % 25 === 0) console.log(`文字サイズの確認 ${index + 1}/${targetRoutes.length}`)
    }
  } finally { await browser.close() }
  return { routes: targetRoutes.length, errors, findings }
}

/*
 * 手で回す：node apps/web/scripts/v8-guard/inherited-font-patrol.mjs <管理画面の URL>
 * CI の巡回にはまだつながない（別にもう一周するので CI が延び、データの文言で揺れるため。
 * 既存の巡回に相乗りさせて速く・安定させてからつなぐ）。
 */
if (import.meta.url === `file://${process.argv[1]}` && process.argv[2]) {
  const result = await runInheritedFontPatrol(process.argv[2])
  console.log(JSON.stringify({ routes: result.routes, errors: result.errors.length, findings: result.findings }, null, 2))
  if (result.findings.length) process.exitCode = 1
}
