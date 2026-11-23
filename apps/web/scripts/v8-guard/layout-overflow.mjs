/*
 * V8のページを1024・1152・1440・1920で開き、崩れを数える。1つでもあれば終了コード1。
 * 電話の専用の画面（/m）だけは 390・430 で開き、押せる所 44px・入力欄 16px・下のタブとの重なりも数える。
 *
 *   node apps/web/scripts/v8-guard/layout-overflow.mjs <baseUrl> [out.json]
 *
 * 数えるもの（管理画面 で崩れたのは 1152 付近。絵の幅の数字をそのまま写したため）
 *   page-x     : ページ全体が横に送れる（AGENTS.md：PC は原則横スクロールなし）
 *   overflow   : 中身が枠からはみ出している（… でも横送りでもない）
 *   out-of-main: 白い板（main）の右端より外へ出た部品
 *   no-title   : … で切っているのに title も aria-label も無い（全文を確かめられない）
 *   narrow-col : 文字のある表の列が 24px より細く、中身が折り返すかはみ出す（1 文字ずつ縦に折り返す。834px の「対応が要るもの」）
 *   cut-alert  : 警告・失敗の文（role=alert・注意と危険の知らせ）が … や行数の制限で切れている。
 *                ボタン・リンクの短い文字は数えない（短い名前の 1 行省略の決まりはそのまま）
 * 数えないもの
 *   main より内側の横送りの枠（overflow-x: auto/scroll か [data-scroll-x]）の中。
 *   main 自体は縦スクロールの枠なので含めない（含めると全部が除外されて 0 になる。
 *   わざと壊した部品を差し込む対照試験で発覚した）
 *   読み上げ専用の sr-only（1px）
 * STRESS=1 を付けると、開いたあと main の中の短い文字を長く・数を大きくしてから測る（報告だけ。終了コードは変えない）
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { MOBILE_ROUTES, MOBILE_VIEWPORTS, ROUTES, WIDTHS, openPage } from './browser-env.mjs'

const [baseUrl = 'http://127.0.0.1:4310', out] = process.argv.slice(2)
const STRESS = process.env.STRESS === '1'

export const scanLayoutOverflow = () => {
  const main = document.querySelector('main') || document.body
  const mr = main.getBoundingClientRect()
  const label = (e) => {
    const t = (e.getAttribute('aria-label') || e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30)
    const c = typeof e.className === 'string' ? e.className.split(' ')[0].replace(/__[A-Za-z0-9_-]{5}$/, '') : ''
    return `${e.tagName.toLowerCase()}${c ? `.${c}` : ''}「${t}」`
  }
  const inScroll = (e) => {
    for (let p = e.parentElement; p && p !== main && p !== document.body; p = p.parentElement) {
      if (p.hasAttribute('data-scroll-x')) return true
      const ox = getComputedStyle(p).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
    return false
  }
  /*
   * 上の帯のアカウント名は、長い名前で帯を混ませないよう最大 260px で
   * 「…」に収める。文字を固定せず、描いた結果の幅で見る。
   */
  const accountName = []
  for (const e of document.querySelectorAll('[data-part="account-name"]')) {
    const cs = getComputedStyle(e)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    if (cs.maxWidth !== '260px' || cs.textOverflow !== 'ellipsis') {
      accountName.push(`${label(e)} max-width=${cs.maxWidth} text-overflow=${cs.textOverflow}`)
    }
  }
  /* 細い列でも、中身が 1 行で収まっていれば崩れではない（「55」だけの数の列など）。 */
  const squeezedOk = (e) => {
    if (e.scrollWidth > e.clientWidth + 1) return false
    const range = document.createRange()
    range.selectNodeContents(e)
    const tops = new Set([...range.getClientRects()].filter((q) => q.width > 0 && q.height > 0).map((q) => Math.round(q.top / 4)))
    return tops.size <= 1
  }
  const res = { pageX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, overflow: [], outOfMain: [], noTitle: [], accountName, narrowColumn: [], cutAlert: [] }
  const alertSelector = '[role="alert"],[data-design-part="notice"]:is([data-tone="warn"],[data-tone="danger"])'
  for (const e of main.querySelectorAll('*')) {
    const r = e.getBoundingClientRect()
    if (r.width <= 1 || r.height <= 1) continue
    const cs = getComputedStyle(e)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    if (e.matches('th,td,[role="columnheader"],[role="cell"],[role="gridcell"]') && r.width < 24 && (e.innerText || '').trim().length >= 2 && !squeezedOk(e)) {
      res.narrowColumn.push(`${label(e)} ${Math.round(r.width)}px`)
    }
    if (e.closest(alertSelector) && !e.closest('button,a,[role="button"]')) {
      const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none'
      if ((cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1) || (clamp && e.scrollHeight > e.clientHeight + 1)) res.cutAlert.push(label(e))
    }
    if (inScroll(e)) continue
    if (cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1) {
      if (!e.title && !e.getAttribute('aria-label') && !e.closest('[title]')) res.noTitle.push(label(e))
      continue
    }
    const ox = cs.overflowX
    if ((ox === 'visible' || ox === 'hidden' || ox === 'clip') && e.scrollWidth > e.clientWidth + 1 && e.children.length === 0) {
      res.overflow.push(`${label(e)} ${e.scrollWidth}/${e.clientWidth}`)
    }
    if (r.right > mr.right + 1 && cs.position !== 'fixed') res.outOfMain.push(`${label(e)} +${Math.round(r.right - mr.right)}`)
  }
  for (const k of ['overflow', 'outOfMain', 'noTitle', 'accountName', 'narrowColumn', 'cutAlert']) res[k] = [...new Set(res[k])]
  return res
}

/*
 * 電話の画面（/m）だけの 3 つの決まり。
 *   small-target : 押せる所（リンク・ボタン・欄・タブ）が 44px 未満
 *   small-input  : 入力欄の文字が 16px 未満（iPhone が入力時に画面を拡大する）
 *   tab-overlap  : 一番下まで送った時に、本文が下のタブ・返信欄の下に隠れる
 */
export const scanMobileRules = () => {
  const MIN_HIT = 44
  const MIN_INPUT = 16
  const label = (e) => {
    const t = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 30)
    return `${e.tagName.toLowerCase()}「${t}」`
  }
  const shown = (e) => {
    const r = e.getBoundingClientRect()
    if (r.width <= 1 || r.height <= 1) return false
    const cs = getComputedStyle(e)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[aria-hidden="true"],.sr-only')
  }
  const res = { smallTarget: [], smallInput: [], tabOverlap: [] }
  for (const e of document.querySelectorAll('a[href],button,[role="button"],[role="tab"],input:not([type="hidden"]),select,textarea')) {
    if (!shown(e)) continue
    // 欄の中の飾りの部品（選ぶ欄の中の小さな×など）は、欄そのものが 44 を持つので数えない。
    if (e.matches('input[type="checkbox"],input[type="radio"]') && e.closest('label')) continue
    const r = e.getBoundingClientRect()
    if (Math.round(r.height) < MIN_HIT || Math.round(r.width) < MIN_HIT) res.smallTarget.push(`${label(e)} ${Math.round(r.width)}x${Math.round(r.height)}`)
  }
  for (const e of document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),select,textarea')) {
    if (!shown(e)) continue
    const size = parseFloat(getComputedStyle(e).fontSize)
    if (size < MIN_INPUT) res.smallInput.push(`${label(e)} ${size}px`)
  }
  const main = document.querySelector('main')
  const bottomBars = [...document.querySelectorAll('nav[aria-label="電話のメニュー"],[data-phone-footer-part]')].filter(shown)
  if (main && bottomBars.length) {
    window.scrollTo(0, document.documentElement.scrollHeight)
    const top = Math.min(...bottomBars.map((bar) => bar.getBoundingClientRect().top))
    let last = null
    for (const e of main.querySelectorAll('*')) {
      if (!shown(e) || e.children.length) continue
      const r = e.getBoundingClientRect()
      if (!last || r.bottom > last.r.bottom) last = { e, r }
    }
    if (last && last.r.bottom > top + 1) res.tabOverlap.push(`${label(last.e)} 下端 ${Math.round(last.r.bottom)} > ${Math.round(top)}`)
    window.scrollTo(0, 0)
  }
  for (const k of Object.keys(res)) res[k] = [...new Set(res[k])]
  return res
}

const stress = () => {
  const m = document.querySelector('main')
  if (!m) return
  const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT)
  const ns = []
  while (w.nextNode()) ns.push(w.currentNode)
  for (const n of ns) {
    const t = n.textContent ?? ''
    const tr = t.trim()
    if (!tr || tr.length > 40) continue
    const pe = n.parentElement
    if (!pe || pe.closest('script,style,svg,[aria-hidden=true]')) continue
    if (/^[\d,.%+−-]+[人件枠通円%]?$/.test(tr)) n.textContent = t.replace(/\d[\d,]*/, '1,234,567')
    else if (tr.length >= 2) n.textContent = t.replace(tr, `${tr}とても長い名前のサンプルです${tr}`)
  }
}

async function run() {
const browser = await chromium.launch()
const res = {}
let bad = 0
for (const theme of ['v8']) {
  for (const width of WIDTHS) {
    for (const [name, route] of Object.entries(ROUTES)) {
      const page = await openPage(browser, { baseUrl, route, width, theme })
      if (STRESS) { await page.evaluate(stress); await page.waitForTimeout(300) }
      const r = await page.evaluate(scanLayoutOverflow)
      await page.close()
      res[`${theme} ${width} ${name}`] = r
      const n = (r.pageX ? 1 : 0) + r.overflow.length + r.outOfMain.length + r.noTitle.length + r.accountName.length + r.narrowColumn.length + r.cutAlert.length
      if (n) {
        bad += n
        console.log(`崩れ ${theme} ${width} ${route}`, JSON.stringify({ pageX: r.pageX, overflow: r.overflow.slice(0, 5), outOfMain: r.outOfMain.slice(0, 5), noTitle: r.noTitle.slice(0, 5), accountName: r.accountName.slice(0, 5), narrowColumn: r.narrowColumn.slice(0, 5), cutAlert: r.cutAlert.slice(0, 5) }))
      }
    }
  }
}
// 電話の専用の画面（/m）だけを 390・430 で。PC の崩れに加えて電話だけの 3 つを数える。
for (const { width, height } of MOBILE_VIEWPORTS) {
  for (const [name, route] of Object.entries(MOBILE_ROUTES)) {
    const page = await openPage(browser, { baseUrl, route, width, height, mobile: true })
    if (STRESS) { await page.evaluate(stress); await page.waitForTimeout(300) }
    const r = await page.evaluate(scanLayoutOverflow)
    const m = await page.evaluate(scanMobileRules)
    await page.close()
    res[`mobile ${width} ${name}`] = { ...r, ...m }
    const n = (r.pageX ? 1 : 0) + r.overflow.length + r.outOfMain.length + r.noTitle.length + r.accountName.length + r.narrowColumn.length + r.cutAlert.length + m.smallTarget.length + m.smallInput.length + m.tabOverlap.length
    if (n) {
      bad += n
      console.log(`崩れ mobile ${width} ${route}`, JSON.stringify({ pageX: r.pageX, overflow: r.overflow.slice(0, 5), outOfMain: r.outOfMain.slice(0, 5), noTitle: r.noTitle.slice(0, 5), narrowColumn: r.narrowColumn.slice(0, 5), cutAlert: r.cutAlert.slice(0, 5), smallTarget: m.smallTarget.slice(0, 8), smallInput: m.smallInput.slice(0, 5), tabOverlap: m.tabOverlap.slice(0, 5) }))
    }
  }
}
await browser.close()
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(res, null, 1)) }
console.log(`${STRESS ? '長いデータで ' : ''}崩れの合計 ${bad}`)
if (bad && !STRESS) process.exit(1)

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run()
