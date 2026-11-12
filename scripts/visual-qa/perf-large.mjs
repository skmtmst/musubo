/*
 * 件数の多い見本で、管理画面の重さを実際のブラウザで測る（2026-10-07）。
 *
 *   VISUAL_QA_LARGE=1 PORT=<api> node scripts/visual-qa/mock-api.mjs &
 *   node apps/web/scripts/v8-guard/serve-out.mjs apps/web/out <web> &
 *   node scripts/visual-qa/perf-large.mjs http://127.0.0.1:<web> http://127.0.0.1:<api> <結果json> [場面,…]
 *
 * 書き出し（next build の out）を配って測る。開発サーバーだと遅く出るため。
 *
 * 測るもの（場面ごと）:
 *   openMs   … 開く・切り替えてから中身が出るまで
 *   p95Ms    … スクロール中の requestAnimationFrame の間隔の 95 パーセンタイル
 *   heapMB   … JS のメモリ（GC 後の使用量）
 *   dom      … DOM の要素数
 *
 * 場面:
 *   inbox-list     一覧を開く→「さらに読み込む」で全件近くまで→一覧をスクロール→絞り込みを切り替える
 *   inbox-thread   会話を開く→「前のメッセージ」で 3,000 個まで遡る→上へスクロール
 *                  →新着が届く（下にいる時・読み返し中）→画像の読み込みで位置がずれないか→入力欄の反応
 *   inbox-switch   会話を 30 回切り替える（右の顧客情報を開いたまま）→前の会話のメモリが解放されるか
 *   inbox-idle     受信箱を開いたまま置く（IDLE_MIN 分。既定 3）。定期の取り直しでメモリが増え続けないか
 *   friends        友だち一覧（10,000 人）
 *   tags           タグ一覧（2,000 個）と、一斉配信の宛先のタグ選び
 *   tag-csv        タグの CSV 取り込みの確認（画面の上限 500 行。CSV_ROWS で変える）
 *   audit          監査の記録（5,000 件）。/staff?tab=audit の「入った記録」と行が出てから測る
 *
 * 準備の条件（perf-ready.mjs）を満たさない場面は速さを記録せず error にし、終わりの番号を 1 にする。
 */
import { writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { auditReady, waitUntilReady } from './perf-ready.mjs'

const [base, apiBase, outPath, onlyArg] = process.argv.slice(2)
if (!base || !apiBase) {
  console.error('使い方: perf-large.mjs <webBase> <apiBase> [結果json] [場面,…]')
  process.exit(1)
}
const ONLY = onlyArg ? new Set(onlyArg.split(',')) : null
const THREAD_TARGET = Number(process.env.THREAD_TARGET ?? 3000)
const LIST_TARGET = Number(process.env.LIST_TARGET ?? 10000)
const IDLE_MIN = Number(process.env.IDLE_MIN ?? 3)
const SWITCHES = Number(process.env.SWITCHES ?? 30)
// タグの CSV は画面が 500 行までで止める（それより多いと確認を押せない）。
const CSV_ROWS = Number(process.env.CSV_ROWS ?? 500)
const THREAD_TOTAL = Number(process.env.VISUAL_QA_LARGE_MESSAGES ?? 3000)

const SESSION = {
  lh_csrf: 'visual-qa-csrf',
  lh_staff_role: 'owner',
  lh_staff_name: 'K',
  lh_staff_permissions: '[]',
  lh_staff_view_permissions: '[]',
  lh_selected_account: 'visual-qa-account',
}

/* 1x1 より大きい画像を遅れて返す（読み込みで高さが変わるかを見るため）。 */
const IMG_240x160 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#9ab"/></svg>')

async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.addInitScript(([session]) => {
    try {
      for (const [k, v] of Object.entries(session)) localStorage.setItem(k, v)
      localStorage.setItem('lh_auth_selection_cleared', '1')
    } catch { /* 無ければ何もしない */ }
  }, [SESSION])
  await page.route(/^https:\/\/(large\.invalid|stickershop\.line-scdn\.net)\//, async (route) => {
    await new Promise((r) => setTimeout(r, 600))
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: IMG_240x160 })
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  return { page, cdp, context }
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  return v.length ? v[Math.floor(v.length / 2)] : null
}
const p95 = (xs) => {
  const v = xs.slice().sort((a, b) => a - b)
  return v.length ? Math.round(v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] * 10) / 10 : null
}

async function heapMB(cdp) {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
  const { metrics } = await cdp.send('Performance.getMetrics')
  const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
  return Math.round((used / 1048576) * 10) / 10
}
const domCount = (page) => page.evaluate(() => document.getElementsByTagName('*').length)

/* スクロールしながら rAF の間隔を集める。dir: 1=下へ -1=上へ。 */
async function scrollFrames(page, selectorFn, { dir = 1, steps = 60, px = 400 } = {}) {
  return page.evaluate(async ([fnSrc, dir, steps, px]) => {
    // eslint-disable-next-line no-new-func
    const el = new Function(`return (${fnSrc})()`)()
    if (!el) return { frames: [], note: 'no-scroller' }
    const frames = []
    let last = performance.now()
    let running = true
    const tick = (t) => { frames.push(t - last); last = t; if (running) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    for (let i = 0; i < steps; i += 1) {
      el.scrollTop += dir * px
      el.dispatchEvent(new Event('scroll'))
      await new Promise((r) => requestAnimationFrame(r))
    }
    await new Promise((r) => setTimeout(r, 200))
    running = false
    return { frames: frames.slice(1) }
  }, [selectorFn.toString(), dir, steps, px])
}

/* 画面の部品を探す（直す前・後の両方で動くように、印が無ければ形で探す）。 */
const LIST_SCROLLER = () => document.querySelector('[data-inbox-list-scroller]')
  ?? document.querySelector('[data-inbox-sort="fixed"]')?.nextElementSibling
const THREAD_SCROLLER = () => document.querySelector('[data-inbox-thread-scroller]')
  ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))

async function listRowCount(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-inbox-list-scroller]')
    if (scroller) return { rendered: scroller.querySelectorAll('[data-inbox-row]').length, total: Number(scroller.querySelector('[data-total]')?.getAttribute('data-total') ?? 0) }
    const s = document.querySelector('[data-inbox-sort="fixed"]')?.nextElementSibling
    const n = s ? [...s.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes('担当：')).length : 0
    return { rendered: n, total: n }
  })
}

/* 欄の中で、いま見えている行（吹き出し・会話）の数。空白になっていないかを見る。 */
async function visibleItems(page, scrollerSelectorFn) {
  return page.evaluate((src) => {
    // eslint-disable-next-line no-new-func
    const el = new Function(`return (${src})()`)()
    if (!el) return null
    const box = el.getBoundingClientRect()
    const items = el.querySelectorAll('[data-vw-key], [data-message-id], button')
    let n = 0
    for (const item of items) { const r = item.getBoundingClientRect(); if (r.bottom > box.top && r.top < box.bottom && r.height > 0) n += 1 }
    return n
  }, scrollerSelectorFn.toString())
}

async function clickByText(page, text, timeout = 15000) {
  const loc = page.getByRole('button', { name: text, exact: true }).first()
  await loc.waitFor({ state: 'visible', timeout })
  await loc.click()
}

async function gotoInbox(page) {
  const start = Date.now()
  await page.goto(`${base}/chats`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-inbox-list-scroller]') ?? document.querySelector('[data-inbox-sort="fixed"]')?.nextElementSibling
    return s && [...s.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('担当：'))
  }, null, { timeout: 30000 })
  return Date.now() - start
}

/* 一覧を「さらに読み込む」で増やす。仮想化後はスクロールで自動に読む形でもよいので両方に対応。 */
async function growList(page, target) {
  const clicks = []
  let stalls = 0
  for (let i = 0; i < 400; i += 1) {
    const { total } = await listRowCount(page)
    if (total >= target) break
    const more = page.getByRole('button', { name: 'さらに読み込む', exact: true })
    if (await more.count() === 0) break
    const before = total
    const t0 = Date.now()
    await more.first().click()
    // 押しても増えないことがある（直す前：定期の取り直しが続きの起点を1ページ目へ戻す）。
    // 4秒で増えなければ「空振り」と数えてもう一度押す。
    const grew = await page.waitForFunction((b) => {
      const scroller = document.querySelector('[data-inbox-list-scroller]')
      const own = scroller?.querySelector('[data-total]')
      if (own) return Number(own.getAttribute('data-total') ?? 0) > b
      const s = document.querySelector('[data-inbox-sort="fixed"]')?.nextElementSibling
      return s && [...s.querySelectorAll('button')].filter((x) => (x.textContent ?? '').includes('担当：')).length > b
    }, before, { timeout: 4000 }).then(() => true, () => false)
    if (!grew) { stalls += 1; continue }
    clicks.push(Date.now() - t0)
    if (process.env.PERF_DEBUG) process.stderr.write(`  more ${i}: ${before} ${Date.now() - t0}ms\n`)
  }
  clicks.stalls = stalls
  return clicks
}

async function scenarioInboxList(browser) {
  const { page, cdp, context } = await newPage(browser)
  const r = {}
  r.openMs = await gotoInbox(page)
  r.domAtOpen = await domCount(page)
  const clicks = await growList(page, LIST_TARGET)
  r.moreClicks = clicks.length
  r.moreStalls = clicks.stalls
  r.moreFirstMs = clicks[0] ?? null
  r.moreLastMs = clicks[clicks.length - 1] ?? null
  r.rows = await listRowCount(page)
  r.dom = await domCount(page)
  r.heapMB = await heapMB(cdp)
  const down = await scrollFrames(page, LIST_SCROLLER, { dir: 1, steps: 80, px: 600 })
  r.scrollP95Ms = p95(down.frames)
  r.scrollMaxMs = down.frames.length ? Math.round(Math.max(...down.frames)) : null
  await page.waitForTimeout(300)
  r.visibleAfterScroll = await visibleItems(page, LIST_SCROLLER)
  // 絞り込みの切り替え：対応状況（5つの切り替え）を順に押し、一覧が出るまで。
  const switchMs = []
  for (const name of ['未対応', '対応中', '対応済み', 'すべて']) {
    const radio = page.getByRole('radio', { name, exact: true }).first()
    if (await radio.count() === 0) continue
    const t0 = Date.now()
    await radio.click()
    await page.waitForFunction(() => !document.querySelector('[data-inbox-list-state="loading"]'), null, { timeout: 30000 })
    await page.waitForFunction(() => {
      const s = document.querySelector('[data-inbox-list-scroller]') ?? document.querySelector('[data-inbox-sort="fixed"]')?.nextElementSibling
      return s && [...s.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('担当：'))
    }, null, { timeout: 30000 })
    switchMs.push(Date.now() - t0)
  }
  r.filterSwitchMs = switchMs
  await context.close()
  return r
}

async function openFirstChat(page, index = 0) {
  const t0 = Date.now()
  const name = await page.evaluate((i) => {
    const s = document.querySelector('[data-inbox-list-scroller]') ?? document.querySelector('[data-inbox-sort="fixed"]')?.nextElementSibling
    const rows = [...s.querySelectorAll('button')].filter((b) => (b.textContent ?? '').includes('担当：'))
    const row = rows[i]
    const label = row?.querySelector('p')?.textContent ?? ''
    row?.click()
    return label
  }, index)
  // 見出しの名前が切り替わったら、同じ描画で吹き出しも切り替わっている。
  await page.waitForFunction((n) => {
    const header = [...document.querySelectorAll('button[title]')].some((b) => b.getAttribute('title') === n && b.hasAttribute('aria-expanded'))
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    return header && el && (el.querySelector('[data-message-id]') || (el.textContent ?? '').includes('（'))
  }, name, { timeout: 30000 })
  return Date.now() - t0
}

async function threadInfo(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    if (!el) return null
    const loaded = Number(el.querySelector('[data-loaded]')?.getAttribute('data-loaded') ?? 0) || el.querySelectorAll(':scope > div').length
    return {
      loaded,
      rendered: el.querySelectorAll('[data-message-id]').length || el.querySelectorAll(':scope > div').length,
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= 40,
    }
  })
}

/*
 * 見えている吹き出しのうち、いちばん上に全部見えている1つの位置。読み返し中に位置が飛ぶかを見る。
 * （真ん中の吹き出しで見ると、その上の画像が読めて伸びた分も「ずれ」に数えてしまう。
 *  画像が伸びるのは正しい動きなので、見ている先頭が動かないかで見る。）
 */
async function anchor(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    const box = el.getBoundingClientRect()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let best = null
    while (walker.nextNode()) {
      const n = walker.currentNode
      if (!/（\d+）$/.test(n.textContent ?? '')) continue
      const rect = n.parentElement.getBoundingClientRect()
      if (rect.top < box.top || rect.bottom > box.bottom) continue
      if (!best || rect.top < best.top) best = { text: n.textContent, top: rect.top }
    }
    return best ? { text: best.text, top: Math.round(best.top) } : null
  })
}
async function anchorTopOf(page, text) {
  return page.evaluate((t) => {
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) if (walker.currentNode.textContent === t) return Math.round(walker.currentNode.parentElement.getBoundingClientRect().top)
    return null
  }, text)
}

async function loadOlderUntil(page, target) {
  const clicks = []
  for (let i = 0; i < 400; i += 1) {
    const info = await threadInfo(page)
    if (!info || info.loaded >= target) break
    const btn = page.getByRole('button', { name: '前のメッセージ', exact: true })
    if (await btn.count() > 0) {
      const t0 = Date.now()
      await btn.first().click()
      await page.waitForFunction((b) => {
        const el = document.querySelector('[data-inbox-thread-scroller]')
          ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
        const loaded = Number(el?.querySelector('[data-loaded]')?.getAttribute('data-loaded') ?? 0) || el?.querySelectorAll(':scope > div').length || 0
        return loaded > b
      }, info.loaded, { timeout: 30000 })
      clicks.push(Date.now() - t0)
    } else {
      // 仮想化後：いちばん上へ寄せると自動で古い分を読む。
      await page.evaluate(() => { const el = document.querySelector('[data-inbox-thread-scroller]'); if (el) el.scrollTop = 0 })
      const t0 = Date.now()
      const ok = await page.waitForFunction((b) => Number(document.querySelector('[data-inbox-thread-scroller] [data-loaded]')?.getAttribute('data-loaded') ?? 0) > b, info.loaded, { timeout: 15000 }).then(() => true, () => false)
      if (!ok) break
      clicks.push(Date.now() - t0)
    }
  }
  return clicks
}

async function typingLatency(page) {
  const box = page.locator('textarea').first()
  if (await box.count() === 0) return null
  await box.click()
  const lat = []
  for (const ch of 'あいうえおかきくけこ') {
    const t = await page.evaluate(() => performance.now())
    await page.keyboard.insertText(ch)
    const done = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(performance.now()))))
    lat.push(done - t)
  }
  await box.fill('')
  return { medianMs: Math.round(median(lat)), maxMs: Math.round(Math.max(...lat)) }
}

async function push(chat, n = 1) {
  const res = await fetch(`${apiBase}/__large/push?chat=${chat}&n=${n}`, { method: 'POST' })
  return (await res.json()).data?.total ?? null
}

async function scenarioInboxThread(browser) {
  const { page, cdp, context } = await newPage(browser)
  const r = {}
  await gotoInbox(page)
  const heap0 = await heapMB(cdp)
  r.openChatMs = await openFirstChat(page, 0)
  await page.waitForTimeout(1500)
  r.domAtOpen = await domCount(page)
  r.typingAtOpen = await typingLatency(page)
  // 画像の読み込みで位置がずれないか（下に付いている時、最後まで見えているか）
  const firstInfo = await threadInfo(page)
  r.bottomAfterImages = firstInfo?.atBottom ?? null
  // 上へ遡って古い分を足したとき、見ていた吹き出しが同じ場所に残るか。
  await page.evaluate(() => {
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    el.scrollTop = 900
  })
  await page.waitForTimeout(1500)
  const pre = await anchor(page)
  const loadedPre = (await threadInfo(page))?.loaded ?? 0
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === '前のメッセージ')
    b?.click()
  })
  await page.waitForFunction((b) => {
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    const loaded = Number(el?.querySelector('[data-loaded]')?.getAttribute('data-loaded') ?? 0) || el?.querySelectorAll(':scope > div').length || 0
    return loaded > b
  }, loadedPre, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(800)
  r.prependShiftPx = pre ? Math.abs(((await anchorTopOf(page, pre.text)) ?? 9999) - pre.top) : null
  const clicks = await loadOlderUntil(page, THREAD_TARGET)
  r.olderClicks = clicks.length
  r.olderFirstMs = clicks[0] ?? null
  r.olderLastMs = clicks[clicks.length - 1] ?? null
  r.thread = await threadInfo(page)
  r.dom = await domCount(page)
  r.heapMB = await heapMB(cdp)
  r.heapDeltaMB = Math.round((r.heapMB - heap0) * 10) / 10
  r.typingAtFull = await typingLatency(page)
  // いちばん下から上へスクロール
  await page.evaluate(() => {
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    el.scrollTop = el.scrollHeight
  })
  await page.waitForTimeout(300)
  const up = await scrollFrames(page, THREAD_SCROLLER, { dir: -1, steps: 80, px: 500 })
  r.scrollUpP95Ms = p95(up.frames)
  r.scrollUpMaxMs = up.frames.length ? Math.round(Math.max(...up.frames)) : null
  await page.waitForTimeout(300)
  r.visibleAfterScroll = await visibleItems(page, THREAD_SCROLLER)
  // 読み返し中に新着：位置が飛ばないか
  await page.evaluate(() => {
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    el.scrollTop = el.scrollHeight / 2
  })
  await page.waitForTimeout(800)
  const a = await anchor(page)
  await push('lchat-000000', 3)
  await page.waitForTimeout(7000) // 定期の取り直し（5秒）を待つ
  r.readingNewMsgShiftPx = a ? Math.abs(((await anchorTopOf(page, a.text)) ?? 9999) - a.top) : null
  r.newBadge = await page.getByRole('button', { name: /新着 \d+ 件/ }).count()
  // 下にいる時に新着：下に付いたままか
  await page.evaluate(() => {
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    el.scrollTop = el.scrollHeight
  })
  await page.waitForTimeout(800)
  const totalAfter = await push('lchat-000000', 2)
  await page.waitForTimeout(7000)
  r.stuckToBottomAfterNew = (await threadInfo(page))?.atBottom ?? null
  const lastN = totalAfter ? totalAfter - THREAD_TOTAL : null
  r.sawNewest = lastN ? await page.evaluate((n) => document.body.innerText.includes(`新しく届いたメッセージ ${n}`), lastN) : null
  // 上へ遡って画像が後から読まれても位置が飛ばないか
  await page.evaluate(() => {
    const el = document.querySelector('[data-inbox-thread-scroller]')
      ?? [...document.querySelectorAll('div.overflow-y-auto')].find((d) => (d.getAttribute('style') ?? '').includes('surface-pearl'))
    el.scrollTop = Math.round(el.scrollHeight * 0.3)
  })
  await page.waitForTimeout(250) // 描き替わってから（画像はまだ読めていない：600ms 遅らせている）
  const b = await anchor(page)
  await page.waitForTimeout(1500)
  r.imageLoadShiftPx = b ? Math.abs(((await anchorTopOf(page, b.text)) ?? 9999) - b.top) : null
  await context.close()
  return r
}

async function scenarioInboxSwitch(browser) {
  const { page, cdp, context } = await newPage(browser)
  const r = {}
  await gotoInbox(page)
  await openFirstChat(page, 0)
  // 右の顧客情報を開く
  const toggle = page.locator('[data-inbox-v6="customer-info-toggle"]').first()
  if (await toggle.count()) {
    const expanded = await toggle.getAttribute('aria-expanded')
    if (expanded !== 'true') await toggle.click()
  }
  await page.waitForTimeout(1500)
  const heapStart = await heapMB(cdp)
  const times = []
  for (let i = 1; i <= SWITCHES; i += 1) times.push(await openFirstChat(page, i % 12))
  await page.waitForTimeout(1500)
  r.switchMedianMs = median(times)
  r.switchMaxMs = Math.max(...times)
  r.heapStartMB = heapStart
  r.heapEndMB = await heapMB(cdp)
  r.heapGrowMB = Math.round((r.heapEndMB - heapStart) * 10) / 10
  r.dom = await domCount(page)
  await context.close()
  return r
}

async function scenarioInboxIdle(browser) {
  const { page, cdp, context } = await newPage(browser)
  await gotoInbox(page)
  await openFirstChat(page, 0)
  await page.waitForTimeout(2000)
  const samples = []
  const t0 = Date.now()
  while (Date.now() - t0 < IDLE_MIN * 60_000) {
    samples.push({ min: Math.round((Date.now() - t0) / 6000) / 10, heapMB: await heapMB(cdp), dom: await domCount(page) })
    await page.waitForTimeout(30_000)
  }
  samples.push({ min: Math.round((Date.now() - t0) / 6000) / 10, heapMB: await heapMB(cdp), dom: await domCount(page) })
  await context.close()
  const first = samples[0]; const last = samples[samples.length - 1]
  return { minutes: IDLE_MIN, heapStartMB: first.heapMB, heapEndMB: last.heapMB, heapGrowMB: Math.round((last.heapMB - first.heapMB) * 10) / 10, domStart: first.dom, domEnd: last.dom, samples }
}

async function simplePage(browser, path, waitFn, scrollerFn) {
  const { page, cdp, context } = await newPage(browser)
  const t0 = Date.now()
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  // ROOT11: 準備待ちの失敗を捨てない。出ていない画面の時間を速さとして記録しない。
  try {
    await waitUntilReady(page, path, waitFn)
  } catch (error) {
    await context.close()
    throw error
  }
  const r = { openMs: Date.now() - t0 }
  await page.waitForTimeout(1000)
  r.dom = await domCount(page)
  r.heapMB = await heapMB(cdp)
  if (scrollerFn) {
    const s = await scrollFrames(page, scrollerFn, { dir: 1, steps: 60, px: 500 })
    r.scrollP95Ms = p95(s.frames)
  }
  return { page, cdp, context, r }
}

const DOC_SCROLLER = () => {
  const main = document.querySelector('main')
  const all = [document.scrollingElement, ...document.querySelectorAll('main, main *')]
  return all.filter(Boolean).filter((e) => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible').sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? main
}

async function scenarioFriends(browser) {
  const { context, r } = await simplePage(browser, '/friends', () => document.body.innerText.includes('見本 143 0'), DOC_SCROLLER)
  await context.close()
  return r
}

async function scenarioTags(browser) {
  const out = {}
  {
    const { context, r } = await simplePage(browser, '/tags', () => document.querySelectorAll('main table tr, main [role="row"]').length > 3, DOC_SCROLLER)
    out.tagsList = r
    await context.close()
  }
  {
    // 友だち一覧の「タグ：すべて」（2,000 個のタグから1つ選ぶ欄）を開く。
    const { page, cdp, context, r } = await simplePage(browser, '/friends', () => document.body.innerText.includes('見本 143 0'), null)
    const before = await domCount(page)
    const t0 = Date.now()
    await page.locator('main button', { hasText: 'タグ：すべて' }).first().click()
    await page.waitForSelector('[role="listbox"] [role="option"]', { timeout: 15000 })
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    r.pickerOpenMs = Date.now() - t0
    r.pickerDomAdded = (await domCount(page)) - before
    r.pickerOptionsRendered = await page.evaluate(() => document.querySelectorAll('[role="listbox"] [role="option"]').length)
    const s = await scrollFrames(page, () => document.querySelector('[data-menu-portal]'), { dir: 1, steps: 60, px: 600 })
    r.pickerScrollP95Ms = p95(s.frames)
    // キーボードで下へ 50 回動かしても、動かした先が見えているか
    for (let i = 0; i < 50; i += 1) await page.keyboard.press('ArrowDown')
    r.pickerActiveVisible = await page.evaluate(() => {
      const active = document.querySelector('[role="listbox"] [data-active="true"]')
      const panel = document.querySelector('[data-menu-portal]')
      if (!active || !panel) return false
      const a = active.getBoundingClientRect(); const p = panel.getBoundingClientRect()
      return a.top >= p.top - 1 && a.bottom <= p.bottom + 1
    })
    r.heapMB = await heapMB(cdp)
    out.friendsTagPicker = r
    await context.close()
  }
  return out
}

async function scenarioTagCsv(browser) {
  const { page, cdp, context, r } = await simplePage(browser, '/tags', () => document.querySelectorAll('main table tr, main [role="row"]').length > 3, null)
  const rows = ['タグ名,フォルダ,色']
  for (let i = 0; i < CSV_ROWS; i += 1) rows.push(`取り込みタグ ${i + 1},${['お問い合わせ', '予約', ''][i % 3]},${i % 50 === 0 ? 'あか' : '#06C755'}`)
  const csv = Buffer.from(rows.join('\n'), 'utf8')
  const importBtn = page.getByRole('button', { name: /CSV/ }).first()
  if (!(await importBtn.count())) { r.note = 'CSV の入口が見つからない'; await context.close(); return r }
  await importBtn.click()
  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles({ name: 'tags.csv', mimeType: 'text/csv', buffer: csv })
  await page.waitForTimeout(500)
  const t0 = Date.now()
  await clickByText(page, '取り込む内容を確認')
  try {
    await waitUntilReady(page, '/tags（CSV の確認）', () => document.body.innerText.includes('行を読み込みました'), { timeout: 60000 })
  } catch (error) {
    await context.close()
    throw error
  }
  r.previewMs = Date.now() - t0
  await page.waitForTimeout(500)
  r.dom = await domCount(page)
  r.heapMB = await heapMB(cdp)
  const s = await scrollFrames(page, () => {
    const d = document.querySelector('[role="dialog"]')
    const all = d ? [d, ...d.querySelectorAll('*')] : []
    return all.filter((e) => e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible').sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
  }, { dir: 1, steps: 60, px: 500 })
  r.scrollP95Ms = p95(s.frames)
  await context.close()
  return r
}

async function scenarioAudit(browser) {
  // ROOT11: 測るのは「入った記録」のタブ。タブと記録の行が出てから測る（main が出ただけでは測らない）。
  const { context, r } = await simplePage(browser, '/staff?tab=audit', auditReady, DOC_SCROLLER)
  await context.close()
  return r
}

const SCENARIOS = {
  'inbox-list': scenarioInboxList,
  'inbox-thread': scenarioInboxThread,
  'inbox-switch': scenarioInboxSwitch,
  'inbox-idle': scenarioInboxIdle,
  friends: scenarioFriends,
  tags: scenarioTags,
  'tag-csv': scenarioTagCsv,
  audit: scenarioAudit,
}

const browser = await chromium.launch({ args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] })
const result = { base, at: new Date().toISOString(), threadTarget: THREAD_TARGET, listTarget: LIST_TARGET, scenarios: {} }
for (const [name, fn] of Object.entries(SCENARIOS)) {
  if (ONLY && !ONLY.has(name)) continue
  if (!ONLY && name === 'inbox-idle') continue
  process.stderr.write(`[perf-large] ${name} …\n`)
  try {
    result.scenarios[name] = await fn(browser)
  } catch (error) {
    result.scenarios[name] = { error: String(error?.message ?? error).slice(0, 400) }
  }
  process.stderr.write(`[perf-large] ${name} ${JSON.stringify(result.scenarios[name]).slice(0, 600)}\n`)
}
await browser.close()
// 準備できなかった場面は失敗として残し、終わりの番号でも知らせる（速さの値として採らない）。
result.failed = Object.entries(result.scenarios).filter(([, value]) => value && typeof value === 'object' && 'error' in value).map(([name]) => name)
if (result.failed.length > 0) process.exitCode = 1
if (outPath) writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`)
else console.log(JSON.stringify(result, null, 2))
