/** 管理画面の全入口を3幅で読み、左右余白・操作配置・フォルダの丸を記録する。 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { openPage } from './browser-env.mjs'
import { assess, assessAgainstBase } from './layout-defects.mjs'
import scanEdges from './edge-inset-browser.mjs'
import scanOwner from './owner-rules-browser.mjs'

const args = process.argv.slice(2)
const [baseUrl, out] = args
const compareUrl = (args.includes('--compare-url') ? args[args.indexOf('--compare-url') + 1] : null) || null
if (!baseUrl || !out) throw new Error('presentation-audit.mjs <baseUrl> <outDir> [--compare-url <url>]')
mkdirSync(out, { recursive: true })
const map = JSON.parse(readFileSync(new URL('../../../../scripts/visual-qa/v8-design-map.json', import.meta.url)))
const known = [...new Set(Object.values(map.boards).filter(b => b.app !== 'liff' && !b.state?.manual).map(b => b.url || b.route).filter(r => r?.startsWith('/')))]
const pages = []
function walk(dir, parts = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name), [...parts, entry.name])
    else if (entry.name === 'page.tsx' && !parts.some(p => p.startsWith('['))) pages.push('/' + parts.filter(p => !p.startsWith('(')).join('/'))
  }
}
walk(fileURLToPath(new URL('../../src/app', import.meta.url)))
// 各入口は既存の固定URL（idを含む）で開く。まだ地図にない入口も省かない。
// 電話専用の入口はPC管理画面と分け、既存の390/430pxの見張りで検査する。
const routes = [...known, ...pages.filter(path => !known.some(r => r.split('?')[0] === path))].filter(route => !/^\/m(?:\/|\?|$)/.test(route))
const selected = process.env.PRESENTATION_ROUTES?.split(',') ?? routes
const browser = await chromium.launch()
const rows = []
async function inspect(url, route, width, capture) {
  let page
  const errors = []
  try {
    page = await openPage(browser, { baseUrl: url, route, width, stable: true, settleMs: 0, requireSuccess: true, onPageError: e => errors.push(e.message) })
    await page.waitForFunction(() => document.querySelector('main h1,main h2') || /画面を表示できませんでした/.test(document.body.innerText), undefined, { timeout: 5000 })
    await page.waitForLoadState('networkidle')
    const pageFailure = await page.evaluate(() => /画面を表示できませんでした/.test(document.body.innerText) || [...document.querySelectorAll('main h1,main h2')].some(el => el.textContent?.trim() === 'ページが見つかりません'))
    if (pageFailure) throw new Error('画面のエラー境界を表示しています')
    const loadFailure = await page.evaluate(() => Boolean(document.querySelector('[data-list-state="error"]')) || [...document.querySelectorAll('[role="alert"]')].some(el => /読み込めません|読み込みに失敗|取得できません|取得に失敗/.test(el.textContent ?? '')))
    if (loadFailure) throw new Error('取得失敗の状態を表示しています')
    if (/^\/(login|403|404)(\/|$)/.test(new URL(page.url()).pathname) && !/^\/(login|403|404)(\/|$)/.test(route.split('?')[0])) throw new Error('予定外の認証/エラー画面へ移りました')
    const inventory = await page.evaluate(() => {
      const main = document.querySelector('main')
      const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden],[inert]')
      const text = el => (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ')
      const all = selector => [...(main ?? document).querySelectorAll(selector)].filter(visible)
      const names = all('[data-list-folders="true"] [data-list-name]')
      return {
        title: all('[data-template-region="heading"] h1,[data-template-region="heading"] h2,[data-page-title]')[0]?.textContent ?? null,
        bands: all('[data-kpi-strip]').length, cards: all('[data-design-part="card"]').length, tables: all('table').length,
        notices: all('[role="alert"],[data-design-part="notice"]').length, tools: all('[data-template-region="toolbar"]').length,
        folders: all('[data-list-folders="true"]').length,
        names: names.length, missingDots: names.filter(el => !el.querySelector('[data-folder-dot]')).map(text),
        filedDots: all('[data-folder-dot="filed"]').length, unfiledDots: all('[data-folder-dot="unfiled"]').length,
        headingActions: all('[data-template-region="heading"] [data-page-heading-actions]').map(el => text(el)),
        footerActions: all('[data-sticky-actions]').map(el => [...el.querySelectorAll('button,a')].filter(visible).map(text)),
        empty: /読み込めません|見つかりません|選んでください/.test(main?.textContent ?? ''),
      }
    })
    const findings = [...await page.evaluate(scanEdges), ...await page.evaluate(scanOwner)]
    if (capture && /^\/(tags|accounts|templates|friends|booking|bookings|webhooks|nen-members|hq\/store-comparison)(\/|\?|$)/.test(route)) {
      const slug = route.slice(1).replaceAll('/', '-').replace(/[?=&]/g, '-')
      await page.screenshot({ path: join(out, `${width}-${slug}.png`), fullPage: true })
    }
    return { width, route, finalPath: new URL(page.url()).pathname, ...inventory, errors, findings }
  } catch (error) {
    return { width, route, error: error.message, errors }
  } finally { await page?.close() }
}
const problems = row => [
  ...row.findings,
  ...row.missingDots.map(name => ({ kind: 'missing-folder-dot', target: name, text: name, measure: {} })),
]
try {
  for (const width of [1024, 1152, 1440]) for (const route of selected) {
    const head = await inspect(baseUrl, route, width, true)
    const base = compareUrl ? await inspect(compareUrl, route, width, false) : null
    const headError = head.error || head.errors.join('; ') || null
    const baseError = base ? base.error || base.errors.join('; ') || null : null
    if (headError && headError === baseError) {
      rows.push({ width, route, existingError: headError, errors: [], newFindings: [], existingFindings: [] })
      console.log(`${width} ${route} : 既存の測定失敗 ${headError}`)
    } else if (headError) {
      rows.push({ width, route, error: headError, errors: [], newFindings: [], existingFindings: [] })
      console.error(width, route, headError)
    } else {
      const result = base && !baseError ? assessAgainstBase(problems(head), problems(base)) : assess(problems(head))
      rows.push({ ...head, baseError, newFindings: result.failures, existingFindings: result.existing ?? [], baselineFindings: base && !baseError ? problems(base) : null })
      console.log(`${width} ${route} : ${head.title ?? '題なし'} / 新規${result.failures.length} / 既存${result.existing?.length ?? 0}`)
    }
    writeFileSync(join(out, 'presentation.json'), JSON.stringify(rows, null, 2) + '\n')
  }
} finally { await browser.close() }
writeFileSync(join(out, 'presentation.md'), '| 幅 | 画面 | 帯/カード/表/知らせ/道具 | 新規/既存の指摘 | 名前/丸の不足 |\n|---|---|---|---|---|\n' + rows.map(r => `| ${r.width} | ${r.route} | ${r.error ? '測定失敗' : r.existingError ? '既存の測定失敗' : [r.bands,r.cards,r.tables,r.notices,r.tools].join('/')} | ${r.error ?? r.existingError ?? `${r.newFindings.length}/${r.existingFindings.length}`} | ${r.names ?? '—'}/${r.missingDots?.length ?? '—'} |`).join('\n') + '\n')
if (rows.some(r => r.error || r.errors.length || r.newFindings.length)) process.exitCode = 1
