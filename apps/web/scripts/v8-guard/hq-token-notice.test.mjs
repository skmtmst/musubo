import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { connectGuardBrowser } from './browser-session.mjs'
import { openPage } from './browser-env.mjs'
import { stubApi } from './speed-budget.mjs'
import { mockFetch } from './mock-local.mjs'

/*
 * 統括のアカウントのトークンの知らせ（hq-token-notice）。
 * カードは共通の知らせ1つ（素の期限の文字なし）、表は状態の札＋期限の札、
 * 数の帯の補足＋行き先は1行。同じ意味の知らせの重複と素の期限切れを見張る。
 */
const EXPIRED_LABEL = 'トークンの期限が切れています'
const EXPIRING_LABEL = 'トークンの期限が近づいています'

async function hqTokenFetch(method, path) {
  const answered = await mockFetch(method, path)
  const rewrite = (mutate) => {
    try {
      const json = JSON.parse(answered.body)
      if (json?.data) mutate(json.data)
      return { ...answered, body: JSON.stringify(json) }
    } catch { return answered }
  }
  if (method === 'GET' && path === '/api/line-accounts') {
    return rewrite((data) => {
      if (!Array.isArray(data) || data.length < 5) return
      data[0].tokenExpiry = { status: 'expired', label: EXPIRED_LABEL, daysLeft: null }
      data[1].tokenExpiry = { status: 'expiring', label: EXPIRING_LABEL, daysLeft: 7 }
      delete data[2].tokenExpiry
      data[4].connection = undefined
    })
  }
  if (method === 'GET' && path.startsWith('/api/staff/me')) {
    return rewrite((data) => { data.accountScope = 'all' })
  }
  return answered
}

function bandDetailState() {
  const cards = [...document.querySelectorAll('[data-kpi-strip][data-kpi-presentation="band"] > [data-design-version]')]
  const target = cards.find((card) => card.textContent.includes('接続に問題'))
  if (!target) return null
  const detail = target.querySelector('[data-kpi-detail]')
  const note = detail?.querySelector('[role="note"]')
  const valueRow = target.querySelector('[data-kpi-fit]')
  const number = valueRow?.querySelector('p')
  const action = target.querySelector('[data-kpi-action-slot] a[href*="/hq/attention"]')
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, height: b.height, left: b.left, right: b.right } }
  return {
    card: r(target),
    detail: detail ? r(detail) : null,
    clipped: note ? note.scrollWidth > note.clientWidth + 1 : null,
    number: number ? r(number) : null,
    textRight: Math.max(...[...valueRow.querySelectorAll('[data-kpi-number], [data-kpi-unit]')].map(el => el.getBoundingClientRect().right)),
    action: action ? { ...r(action), href: action.getAttribute('href') } : null,
  }
}

function cardNoticeState([expired, expiring]) {
  return [...document.querySelectorAll('article')].map((card) => ({
    notices: card.querySelectorAll('[data-design-part="notice"]').length,
    bare: [expired, expiring].filter((label) => card.querySelector(`[title="${label}"]`)),
  }))
}

function tableTokenState() {
  return [...document.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '')
}

/* 表の期限の札（全文の title を持つ札）の切れ。 */
function tableBadgeClip([expired, expiring]) {
  return [expired, expiring].map((label) => {
    const badge = document.querySelector(`tbody tr [title="${label}"]`)
    const text = badge?.querySelector('[data-truncated-text]')
    if (!badge || !text) return { label, found: false, clipped: false }
    return { label, found: true, clipped: text.scrollWidth > text.clientWidth + 1 }
  })
}

function checkBand(band) {
  assert.ok(band?.detail, '接続に問題のカードの補足行がある')
  assert.ok(band.detail.height <= 20, `補足は1行に収まる（行の高さ ${band.detail.height}）`)
  assert.equal(band.clipped, false, '補足は切らない')
  assert.ok(band.action, '共通の行き先が値の行にある')
  assert.equal(band.action.href, '/hq/attention?kind=connections', '接続の絞り込みへ進む')
  assert.ok(band.action.right <= band.card.right + 1, '行き先はカードの右端以内')
  assert.ok(Number.isFinite(band.textRight) && band.textRight <= band.action.left + 1, '数字と行き先は重ならない')
  assert.ok(band.number && band.action.top >= band.number.top - 1 && band.action.top < band.number.bottom,
    '行き先は数字の行の中にある')
}

function checkCards(cards) {
  assert.ok(cards.length > 0, 'カードがある')
  for (const card of cards) {
    assert.ok(card.notices <= 1, '知らせは1つまで')
    assert.deepEqual(card.bare, [], '素の期限の文字は無い')
  }
}

function checkTable(rows) {
  assert.ok(rows.length > 0, '表の行がある')
  for (const text of rows) assert.ok(!text.includes(EXPIRED_LABEL) && !text.includes(EXPIRING_LABEL), '素の期限の文字は無い')
  assert.ok(rows.some(text => text.includes('期限切れ')), '期限切れの札がある')
  assert.ok(rows.some(text => text.includes('期限が近い')), '期限が近い札がある')
}

function checkClips(clips) {
  for (const clip of clips) {
    assert.equal(clip.found, true, `全文を持つ札がある（${clip.label}）`)
    assert.equal(clip.clipped, false, `札は切らない（${clip.label}）`)
  }
}

async function photograph(page, name, width) {
  if (!process.env.MUSE_SHOTS) return
  await mkdir(process.env.MUSE_SHOTS, { recursive: true })
  await page.screenshot({ path: `${process.env.MUSE_SHOTS}/${name}-${width}.png`, fullPage: true })
}

for (const width of [1152, 1440]) test(`統括のアカウントは知らせの重複と素の期限切れを出さない ${width}`, async () => {
  const browser = await connectGuardBrowser()
  let page
  const labels = [EXPIRED_LABEL, EXPIRING_LABEL]
  try {
    const adapter = { newPage: async options => { const page = await browser.newPage(options); await stubApi(page, hqTokenFetch); return page } }
    page = await openPage(adapter, { baseUrl: process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310', route: '/hq', width, stable: true, requireSuccess: true })
    await page.locator('[data-kpi-strip][data-kpi-presentation="band"]').first().waitFor()
    await page.locator('article').first().waitFor()
    checkBand(await page.evaluate(bandDetailState))
    checkCards(await page.evaluate(cardNoticeState, labels))
    await photograph(page, 'cards', width)

    const connectionCard = page.locator('[data-kpi-strip][data-kpi-presentation="band"] > [data-design-version]').filter({ hasText: '接続に問題' })
    const number = connectionCard.locator('[data-kpi-number]').first()
    const originalNumber = await number.textContent()
    await number.evaluate(el => { el.textContent = '1234'; el.closest('[data-kpi-fit]').style.setProperty('--kpi-fit-chars', '4') })
    console.log('four-digit-layout', width, await page.evaluate(bandDetailState))
    await photograph(page, 'four-digits', width)
    checkBand(await page.evaluate(bandDetailState))
    await number.evaluate(el => el.style.setProperty('font-size', '100px'))
    const unshrunkBand = await page.evaluate(bandDetailState)
    assert.throws(() => checkBand(unshrunkBand), /重ならない/, '数の字が箱を越えて重なったら赤')
    await number.evaluate(el => el.style.removeProperty('font-size'))
    checkBand(await page.evaluate(bandDetailState))
    await number.evaluate((el, text) => { el.textContent = text; el.closest('[data-kpi-fit]').style.setProperty('--kpi-fit-chars', String(text.length)) }, originalNumber)

    // 本体と同じ検査へ壊した実測値を渡し、復元後の緑まで確かめる。
    const actionSlot = connectionCard.locator('[data-kpi-action-slot]')
    await actionSlot.evaluate(el => { el.style.position = 'relative'; el.style.top = '100px' })
    const brokenBand = await page.evaluate(bandDetailState)
    assert.throws(() => checkBand(brokenBand), /数字の行/, '行き先が落ちたら赤')
    await actionSlot.evaluate(el => { el.style.removeProperty('position'); el.style.removeProperty('top') })
    checkBand(await page.evaluate(bandDetailState))
    await actionSlot.evaluate(el => { el.style.position = 'relative'; el.style.left = '100px' })
    const overflowBand = await page.evaluate(bandDetailState)
    assert.throws(() => checkBand(overflowBand), /カードの右端/, '行き先が右端を越えたら赤')
    await actionSlot.evaluate(el => { el.style.removeProperty('left') })
    const beforeOverlap = await page.evaluate(bandDetailState)
    await actionSlot.evaluate((el, offset) => { el.style.left = `${offset}px` }, beforeOverlap.textRight - beforeOverlap.action.left - 5)
    const overlapBand = await page.evaluate(bandDetailState)
    assert.throws(() => checkBand(overlapBand), /重ならない/, '数と重なったら赤')
    await actionSlot.evaluate(el => { el.style.removeProperty('position'); el.style.removeProperty('left') })
    checkBand(await page.evaluate(bandDetailState))

    await page.evaluate(() => {
      const first = document.querySelector('article')
      const clone = first.querySelector('[data-design-part="notice"]').cloneNode(true)
      clone.setAttribute('data-notice-fault', '')
      first.appendChild(clone)
    })
    const duplicate = await page.evaluate(cardNoticeState, labels)
    assert.throws(() => checkCards(duplicate), /知らせは1つ/, '重複したら赤')
    await page.locator('[data-notice-fault]').evaluate(el => el.remove())
    await page.evaluate(expired => {
      const bare = document.createElement('span')
      bare.title = expired; bare.textContent = expired; bare.dataset.bareFault = ''
      document.querySelector('article').appendChild(bare)
    }, EXPIRED_LABEL)
    const bareCard = await page.evaluate(cardNoticeState, labels)
    assert.throws(() => checkCards(bareCard), /素の期限/, '素の期限文字が出たら赤')
    await page.locator('[data-bare-fault]').evaluate(el => el.remove())
    checkCards(await page.evaluate(cardNoticeState, labels))

    await page.locator('button[aria-label="表"]').click()
    await page.locator('tbody tr').first().waitFor()
    checkTable(await page.evaluate(tableTokenState))
    checkClips(await page.evaluate(tableBadgeClip, labels))
    await photograph(page, 'table', width)

    const badge = page.locator(`tbody tr [title="${EXPIRED_LABEL}"]`).first()
    await badge.evaluate(el => { el.style.maxWidth = '20px'; el.style.overflow = 'hidden' })
    const brokenClips = await page.evaluate(tableBadgeClip, labels)
    assert.throws(() => checkClips(brokenClips), /札は切らない/, '札が切れたら赤')
    await badge.evaluate(el => { el.style.removeProperty('max-width'); el.style.removeProperty('overflow') })
    checkClips(await page.evaluate(tableBadgeClip, labels))

    await page.evaluate(expired => {
      const bare = document.createElement('span')
      bare.textContent = expired; bare.dataset.bareFault = ''
      document.querySelector('tbody tr').appendChild(bare)
    }, EXPIRED_LABEL)
    const bareTable = await page.evaluate(tableTokenState)
    assert.throws(() => checkTable(bareTable), /素の期限/, '表に素の期限文字が出たら赤')
    await page.locator('[data-bare-fault]').evaluate(el => el.remove())
    checkTable(await page.evaluate(tableTokenState))
  } finally { await page?.close(); await browser.close() }
})
