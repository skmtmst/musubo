/** 実際の崩れ・入力状態の矛盾を判定する。見本の座標や許可表は使わない。
 * node apps/web/scripts/v8-guard/layout-defects.mjs <baseUrl> [out.json]
 * --fixtures <json> は種類別のHTMLを1つのブラウザで順に検証する。
 * --fixture <html> は対照試験用（許可リストを使わず終了コードを確かめる）。
 * --compare-url <url> は同条件の統合先と比較し、新規の崩れだけを失敗にする。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTES, WIDTHS, openPage } from './browser-env.mjs'
import scanLayoutDefects from './layout-defects-browser.mjs'
import scanPendec2Rules from './pendec2-rules-browser.mjs'
import scanOwnerRules from './owner-rules-browser.mjs'
import scanControlOverlap from './control-overlap-browser.mjs'
import scanFormRules from './form-rules-browser.mjs'
import { collectReservationReading, assessReservationReading } from './reservation-reading-browser.mjs'
import scanB244Rules from './rules-browser.mjs'
import scanPolishRules from './polish-rules-browser.mjs'
import scanEdgeInset from './edge-inset-browser.mjs'
import scanControlRowHeights from './control-row-height-browser.mjs'
import scanStoreCompareLayout from './store-compare-layout-browser.mjs'
import scanRowCentering from './row-centering-browser.mjs'
import scanHoverReveal from './hover-reveal-browser.mjs'
import scanInsertTokenFit from './insert-token-fit-browser.mjs'
import { collectShortText, shortTextFindings } from './short-text-browser.mjs'
const GAP_ROUTES = JSON.parse(readFileSync(new URL('./layout-defects-routes.json',import.meta.url),'utf8'))

export const DEFECT_ROUTES = { ...ROUTES, tags: '/tags', affiliates: '/affiliates', 'inflow-links': '/inflow-links', conversions: '/affiliates?tab=points', ...Object.fromEntries(GAP_ROUTES.map(route=>[route,route])) }
/** A standalone scan still fails on every detected defect. */
export const assess = findings => ({ failures: [...findings], allowed: [] })
export function assessAgainstBase(findings, baseFindings) {
  const fingerprint = ({ targetIdentity, target, ...detail }) => JSON.stringify([targetIdentity || target, detail])
  const remainingBase = new Map()
  for (const finding of baseFindings) {
    const key = fingerprint(finding)
    remainingBase.set(key, (remainingBase.get(key) || 0) + 1)
  }
  const failures = [], existing = []
  for (const finding of findings) {
    const key = fingerprint(finding)
    const count = remainingBase.get(key) || 0
    if (count) {
      existing.push(finding)
      remainingBase.set(key, count - 1)
    } else failures.push(finding)
  }
  return { failures, allowed: [], existing, baseFindings }
}
/** 番号を無視してよいのは、DOMで一つと確認した外枠だけ。子の番号は保つ。 */
export function identifyStableTargets(findings) {
  findings = findings.map(({ targetIdentity, ...f }) => f)
  const workspaces = [...document.querySelectorAll('[class]')].filter(el => [...el.classList].some(name => name === 'app-shell_workspace' || name.startsWith('app-shell_workspace__')))
  if (workspaces.length !== 1) return findings
  return findings.map(f => /div\.app-shell_workspace:nth-of-type\(\d+\)/.test(f.target)
    ? { ...f, targetIdentity: f.target.replace(/div\.app-shell_workspace:nth-of-type\(\d+\)/, 'div.app-shell_workspace:unique') }
    : f)
}
export async function measurePage(page) {
  const shortText = shortTextFindings(await page.evaluate(collectShortText)).map(({ kind, selector, text, ...measure }) => ({ kind, target: selector, text, measure }))
  const reservationReading = assessReservationReading(await page.evaluate(collectReservationReading))
  const findings = [...await page.evaluate(scanLayoutDefects), ...await page.evaluate(scanOwnerRules), ...await page.evaluate(scanPendec2Rules), ...await page.evaluate(scanControlOverlap), ...await page.evaluate(scanFormRules), ...await page.evaluate(scanB244Rules), ...await page.evaluate(scanPolishRules), ...await page.evaluate(scanEdgeInset), ...await page.evaluate(scanControlRowHeights), ...await page.evaluate(scanStoreCompareLayout), ...await page.evaluate(scanRowCentering), ...await page.evaluate(scanHoverReveal), ...await page.evaluate(scanInsertTokenFit)]
  return await page.evaluate(identifyStableTargets, [...findings, ...reservationReading, ...shortText])
}
async function measureRoute(browser, baseUrl, route, width) {
  let page
  const errors = []
  try {
    page = await openPage(browser,{baseUrl,route,width,theme:'v8',stable:true,settleMs:0,onPageError:e=>errors.push(e.message),requireSuccess:true})
    await page.waitForSelector(route === '/login' ? 'form' : 'main')
    if (route !== '/login') await page.waitForFunction(() => document.querySelectorAll('main h1,main h2,main input,main [data-kpi-number]').length > 0)
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready.then(() => true))
    if (new URL(page.url()).pathname !== new URL(route,baseUrl).pathname || errors.length || (await page.locator('body').innerText()).includes('画面を表示できませんでした')) throw new Error(errors.join('; ') || '指定画面を開けませんでした')
    return await measurePage(page)
  } finally { await page?.close() }
}
async function run() {
  const { chromium } = await import('@playwright/test')
  const args = process.argv.slice(2)
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null
  const fixture = value('--fixture'), fixturesFile = value('--fixtures'), onlyRoute = value('--route'), compareUrl = value('--compare-url') || null
  if (args.includes('--record-allow')) throw new Error('許可表の採取は廃止しました')
  const [baseUrl='http://127.0.0.1:4310',out] = args.filter((a,i) => !a.startsWith('--') && (i === 0 || !args[i-1].startsWith('--')))
  if (fixture && fixturesFile) throw new Error('対照は --fixture か --fixtures の一方だけです')
  if (compareUrl && (fixture || fixturesFile)) throw new Error('統合先との比較は実画面の検査専用です')
  const fixtureCases = fixture ? { fixture: readFileSync(fixture,'utf8') } : fixturesFile ? JSON.parse(readFileSync(fixturesFile,'utf8')) : null
  if (fixtureCases && (!Object.keys(fixtureCases).length || Object.values(fixtureCases).some(v=>typeof v !== 'string'))) throw new Error('対照見本は名前とHTMLの対応表です')
  const routes = [...new Set(Object.values(DEFECT_ROUTES))].filter(route => !onlyRoute || route === onlyRoute)
  if (!fixtureCases && !routes.length) throw new Error('指定した画面が見張りの対象にありません')
  const browser = await chromium.launch(), results = {}
  let bad = 0
  try {
    for (const width of fixtureCases ? [1152] : WIDTHS) for (const route of fixtureCases ? Object.keys(fixtureCases).map(k=>'/fixture/'+k) : routes) {
      let page
      try {
        let findings
        if (fixtureCases) {
          page = await browser.newPage({viewport:{width,height:900}})
          await page.setContent(fixtureCases[route.slice('/fixture/'.length)])
          findings = await measurePage(page)
        } else {
          findings = await measureRoute(browser, baseUrl, route, width)
        }
        // 比べる相手を読めなければ測定失敗。空の基準として通してはいけない。
        const baseFindings = compareUrl ? await measureRoute(browser, compareUrl, route, width) : null
        const result = baseFindings ? assessAgainstBase(findings,baseFindings) : assess(findings)
        results[`${width} ${route}`] = result
        bad += result.failures.length
        console.log(`崩れ ${width} ${route}: 新規${result.failures.length}・許可${result.allowed.length}${baseFindings ? '・既存'+result.existing.length : ''}`)
        for (const f of result.failures) console.log(`  ${f.kind} ${f.target} ${JSON.stringify(f.measure)} ${f.text}`)
      } catch (error) { bad++; results[`${width} ${route}`] = {error:error.message}; console.error('測定失敗',width,route,error.message) }
      finally { await page?.close() }
    }
  } finally { await browser.close() }
  if (out) { mkdirSync(dirname(out),{recursive:true}); writeFileSync(out,JSON.stringify(results,null,2)+'\n') }
  if (bad) process.exitCode = 1
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await run()
