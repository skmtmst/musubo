/*
 * 未保存の入力があるときの、ブラウザの戻る・進む（実ブラウザ）。
 *
 * 共通の番兵（useUnsavedGuard）の受け口は、戻る・進むを Next のルーターより先に受け止め、元の履歴の位置へ戻してから
 * 既存の離脱確認を出す。Next のルーターが先に前の画面を描くと、確認を出す前に入力ごと画面が消える。
 *
 * - 本番形式の出力（`out`）と画面確認用のモックAPIを開く前提（V8_GUARD_BASE）。開発サーバーにも向けられる。
 * - 舞台は「タグを作る」（作成の型の番兵）。一覧から画面の中の移動で入り、戻るを同じ文書の中の移動にする。
 * - 戻る・進むの試験は、Navigation API がある場合と、無いブラウザ（window.navigation を消す）の両方で回す。
 * - 故障対照（受け口を Next のルーターの後ろへ回す）で、この試験が入力の消える不具合を見分けることも毎回確かめる。
 *   V8_GUARD_HISTORY_FAULT=1 は全部の試験に故障を入れる切り替え。赤（0 以外で終わる）になることを手元で確かめる。
 * - V8_GUARD_HISTORY_ENGINE=webkit|firefox は、手元でほかのブラウザを直に開く切り替え（CI は Chromium）。
 *
 *   node apps/web/scripts/v8-guard/browser-host.mjs --test --test-concurrency=1 apps/web/scripts/v8-guard/unsaved-history.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { firefox, webkit } from '@playwright/test'
import { connectGuardBrowser } from './browser-session.mjs'

const base = process.env.V8_GUARD_BASE ?? 'http://127.0.0.1:4310'
const FAULT = process.env.V8_GUARD_HISTORY_FAULT === '1'
const ENGINE = process.env.V8_GUARD_HISTORY_ENGINE
const SESSION = {
  lh_csrf: 'visual-qa-csrf',
  lh_staff_role: 'owner',
  lh_staff_name: 'K',
  lh_staff_permissions: '[]',
  lh_staff_view_permissions: '[]',
  lh_selected_account: 'visual-qa-account',
}
const TYPED = '戻る前の入力'
const MODES = [
  { name: 'Navigation API あり', navigation: true },
  { name: 'Navigation API なし', navigation: false },
]

/** 故障対照：番兵の受け口（window の捕捉段の popstate）を、Next のルーターが付けた後ろへ付け直す。 */
function lateHistoryListeners() {
  const add = EventTarget.prototype.addEventListener
  const remove = EventTarget.prototype.removeEventListener
  const waiting = new Map()
  const deferred = (target, type, options) => target === window && type === 'popstate' && typeof options === 'object' && options !== null && options.capture === true
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!deferred(this, type, options)) return add.call(this, type, listener, options)
    waiting.set(listener, setTimeout(() => { waiting.delete(listener); add.call(window, type, listener, options) }, 0))
  }
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (deferred(this, type, options) && waiting.has(listener)) { clearTimeout(waiting.get(listener)); waiting.delete(listener); return }
    return remove.call(this, type, listener, options)
  }
}

/** Navigation API の無いブラウザ（Safari 26.2 より古い・Firefox 147 より古いなど）と同じにする。 */
function withoutNavigationApi() {
  Object.defineProperty(window, 'navigation', { configurable: true, get: () => undefined })
}

async function openBrowser() {
  if (ENGINE === 'webkit') return webkit.launch()
  if (ENGINE === 'firefox') return firefox.launch()
  return connectGuardBrowser()
}

async function withPage(options, run) {
  const browser = await openBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.addInitScript(session => {
      for (const [key, value] of Object.entries(session)) localStorage.setItem(key, value)
      localStorage.setItem('lh_auth_selection_cleared', '1')
    }, SESSION)
    if (options.navigation === false) await page.addInitScript(withoutNavigationApi)
    if (FAULT || options.fault) await page.addInitScript(lateHistoryListeners)
    await run(page)
  } finally { await browser.close() }
}

const pathOf = page => new URL(page.url()).pathname + new URL(page.url()).search
const nameField = page => page.locator('[data-page-template] input[type="text"], [data-page-template] input:not([type])').first()
const leaveAsk = page => page.getByRole('button', { name: '編集を続ける', exact: true })
const discardAndLeave = page => page.getByRole('button', { name: '保存せずに移る', exact: true })
const navLink = (page, name) => page.getByRole('link', { name, exact: true }).first()

/** 再読み込み・タブを閉じる確認が働く（＝番兵が入力を見ている）ことを待つ。 */
async function waitGuardArmed(page, armed = true) {
  await page.waitForFunction(expected => {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented === expected
  }, armed, { timeout: 10_000 })
}

/** 一覧から画面の中の移動で「タグを作る」へ入る。 */
async function openForm(page) {
  await page.goto(`${base}/tags`)
  const create = page.getByRole('link', { name: /タグを作る/ }).first()
  await create.waitFor({ timeout: 60_000 })
  await create.click()
  await page.waitForURL(/\/tags\/new/, { timeout: 60_000 })
  await nameField(page).waitFor({ timeout: 60_000 })
}

async function typeName(page) {
  await nameField(page).fill(TYPED)
  await waitGuardArmed(page)
}

async function openTypedForm(page) {
  await openForm(page)
  await typeName(page)
}

/** 確認が出て、画面と入力が残っていることを確かめる。 */
async function expectStayedWithInput(page, path = '/tags/new') {
  await leaveAsk(page).waitFor({ timeout: 10_000 })
  await page.waitForFunction(expected => location.pathname + location.search === expected, path, { timeout: 10_000 })
  assert.equal(await nameField(page).inputValue(), TYPED)
}

/** 画面の中の移動で次の画面へ進み、着くまで待つ。 */
async function follow(page, name, pathname) {
  await navLink(page, name).click()
  await page.waitForURL(url => url.pathname === pathname, { timeout: 60_000 })
}

for (const mode of MODES) {
  test(`${mode.name}：戻ると確認を出し、「編集を続ける」は留まって入力を残し、「保存せずに移る」で戻る`, () => withPage(mode, async page => {
    await openTypedForm(page)
    await page.evaluate(() => history.back())
    await expectStayedWithInput(page)
    await leaveAsk(page).click()
    await leaveAsk(page).waitFor({ state: 'detached', timeout: 10_000 })
    assert.equal(pathOf(page), '/tags/new')
    assert.equal(await nameField(page).inputValue(), TYPED)
    await page.evaluate(() => history.back())
    await expectStayedWithInput(page)
    await discardAndLeave(page).click()
    await page.waitForURL(url => url.pathname === '/tags', { timeout: 30_000 })
    await page.getByRole('link', { name: /タグを作る/ }).first().waitFor({ timeout: 30_000 })
  }))

  test(`${mode.name}：進むでも確認を出し、行き過ぎずに元の位置へ戻して入力を残す`, () => withPage(mode, async page => {
    await openForm(page)
    // 作成 → 友だち → タグ一覧と進めてから2つ戻り、進む先が2件ある作成画面で入力する。
    await follow(page, '友だち', '/friends')
    await follow(page, 'タグ', '/tags')
    await page.evaluate(() => history.back())
    await page.waitForURL(url => url.pathname === '/friends', { timeout: 60_000 })
    await page.evaluate(() => history.back())
    await page.waitForURL(/\/tags\/new/, { timeout: 60_000 })
    await nameField(page).waitFor({ timeout: 60_000 })
    await typeName(page)
    const length = await page.evaluate(() => history.length)
    await page.evaluate(() => history.forward())
    await expectStayedWithInput(page)
    await page.waitForTimeout(500)
    assert.equal(pathOf(page), '/tags/new')
    assert.equal(await page.evaluate(() => history.length), length)
    await leaveAsk(page).click()
    await page.evaluate(() => history.forward())
    await expectStayedWithInput(page)
    await discardAndLeave(page).click()
    await page.waitForURL(url => url.pathname === '/friends', { timeout: 30_000 })
    // 進む先は友だち一覧のまま。行き過ぎていない（その先のタグ一覧へは進めば着く）。
    await page.evaluate(() => history.forward())
    await page.waitForURL(url => url.pathname === '/tags', { timeout: 30_000 })
  }))

  test(`${mode.name}：何件か前へ飛んでも確認を出し、元の位置へ戻して入力を残す`, () => withPage(mode, async page => {
    await page.goto(`${base}/tags`)
    await navLink(page, '友だち').waitFor({ timeout: 60_000 })
    await follow(page, '友だち', '/friends')
    await follow(page, 'タグ', '/tags')
    const create = page.getByRole('link', { name: /タグを作る/ }).first()
    await create.waitFor({ timeout: 60_000 })
    await create.click()
    await page.waitForURL(/\/tags\/new/, { timeout: 60_000 })
    await nameField(page).waitFor({ timeout: 60_000 })
    await typeName(page)
    await page.evaluate(() => history.go(-2))
    await expectStayedWithInput(page)
    await page.waitForTimeout(500)
    assert.equal(pathOf(page), '/tags/new')
    await discardAndLeave(page).click()
    await page.waitForURL(url => url.pathname === '/friends', { timeout: 30_000 })
  }))

  test(`${mode.name}：同じ URL の履歴どうしの戻るは画面を離れないので確認せず、その先の戻るで確認する`, () => withPage(mode, async page => {
    await openTypedForm(page)
    await page.evaluate(() => history.pushState(history.state, '', location.href))
    await page.evaluate(() => history.back())
    await page.waitForTimeout(800)
    assert.equal(await leaveAsk(page).count(), 0)
    assert.equal(pathOf(page), '/tags/new')
    assert.equal(await nameField(page).inputValue(), TYPED)
    await page.evaluate(() => history.back())
    await expectStayedWithInput(page)
  }))

  test(`${mode.name}：見出しへの移動（# だけ変わる履歴）とその戻るは確認せず、その先の戻るで確認する`, () => withPage(mode, async page => {
    await openTypedForm(page)
    await page.evaluate(() => { location.hash = 'unsaved-history-heading' })
    await page.waitForFunction(() => location.hash === '#unsaved-history-heading')
    await page.evaluate(() => history.back())
    await page.waitForFunction(() => location.hash === '')
    await page.waitForTimeout(800)
    assert.equal(await leaveAsk(page).count(), 0)
    assert.equal(pathOf(page), '/tags/new')
    assert.equal(await nameField(page).inputValue(), TYPED)
    await page.evaluate(() => history.back())
    await expectStayedWithInput(page)
  }))

  test(`${mode.name}：戻るを続けて押しても確認は1つで、元の位置と入力を保つ`, () => withPage(mode, async page => {
    await openTypedForm(page)
    for (let i = 0; i < 3; i += 1) { await page.evaluate(() => history.back()); await page.waitForTimeout(30) }
    await expectStayedWithInput(page)
    await page.waitForTimeout(800)
    assert.equal(await leaveAsk(page).count(), 1)
    assert.equal(pathOf(page), '/tags/new')
  }))

  test(`${mode.name}：入力を元へ戻した画面は、確認せずに戻る`, () => withPage(mode, async page => {
    await openTypedForm(page)
    await nameField(page).fill('')
    await waitGuardArmed(page, false)
    await page.evaluate(() => history.back())
    await page.waitForURL(url => url.pathname === '/tags', { timeout: 30_000 })
    assert.equal(await leaveAsk(page).count(), 0)
  }))

  test(`${mode.name}：同じ画面の中の段の移動（samePage）は、戻る・進むで確認せず画面へ届き、入力を残す`, () => withPage(mode, async page => {
    // ウェビナーの一覧から、名前のリンク（画面の中の移動）で編集画面へ入る。段の移動は画面が履歴を積む。
    await page.goto(`${base}/webinars`)
    const open = page.locator('a[href^="/webinars/edit?id=webinar-1&"]').first()
    await open.waitFor({ timeout: 60_000 })
    await open.click()
    const title = page.locator('#webinar-basic-title')
    await title.waitFor({ timeout: 60_000 })
    await title.fill(TYPED)
    await waitGuardArmed(page)
    // 段の札（済みの段へ移る）は保存せずに段だけ移り、画面が履歴を1つ積む。
    await page.getByRole('button', { name: '動画に戻る', exact: true }).click()
    await page.waitForFunction(() => new URLSearchParams(location.search).get('pane') === 'video', undefined, { timeout: 10_000 })
    await title.waitFor({ state: 'hidden', timeout: 10_000 })
    await page.evaluate(() => history.back())
    await page.waitForFunction(() => location.pathname === '/webinars/edit' && !new URLSearchParams(location.search).has('pane'), undefined, { timeout: 10_000 })
    await title.waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await title.inputValue(), TYPED)
    await page.evaluate(() => history.forward())
    await page.waitForFunction(() => new URLSearchParams(location.search).get('pane') === 'video', undefined, { timeout: 10_000 })
    await title.waitFor({ state: 'hidden', timeout: 10_000 })
    await page.waitForTimeout(500)
    assert.equal(await leaveAsk(page).count(), 0)
    // 画面の外（ウェビナーの一覧）へ戻るときは、これまでどおり確認して元の段に留まる。
    await page.evaluate(() => history.go(-2))
    await leaveAsk(page).waitFor({ timeout: 10_000 })
    await page.waitForTimeout(500)
    assert.equal(new URL(page.url()).pathname, '/webinars/edit')
    assert.equal(new URLSearchParams(new URL(page.url()).search).get('pane'), 'video')
    await leaveAsk(page).click()
    await leaveAsk(page).waitFor({ state: 'detached', timeout: 10_000 })
    assert.equal(new URLSearchParams(new URL(page.url()).search).get('pane'), 'video')
  }))

  test(`${mode.name}：保存したあとは確認せずに戻れ、もう一度入力すると戻るでまた確認する`, () => withPage(mode, async page => {
    await page.route(url => url.pathname === '/api/tags', async route => {
      if (route.request().method() !== 'POST') return route.fallback()
      const response = await route.fetch()
      await route.fulfill({ response, status: 200, json: { success: true, data: { tag: { id: 'unsaved-history-tag', name: TYPED }, automation: null } } })
    })
    await openTypedForm(page)
    // 「保存して続けて作る」は作成の型の「その他の操作」の中にある。保存すると同じ画面で入力が空に戻り、URL に作った名前が付く。
    await page.getByRole('button', { name: '作成・編集のその他の操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '保存して続けて作る', exact: true }).click()
    await page.waitForURL(url => url.pathname === '/tags/new' && url.searchParams.has('created'), { timeout: 30_000 })
    await page.waitForFunction(() => document.querySelector('[data-page-template] input:not([type]), [data-page-template] input[type="text"]')?.value === '')
    await waitGuardArmed(page, false)
    const saved = pathOf(page)
    await page.evaluate(() => history.back())
    await page.waitForURL(url => url.pathname === '/tags/new' && !url.searchParams.has('created'), { timeout: 30_000 })
    await page.waitForTimeout(500)
    assert.equal(await leaveAsk(page).count(), 0)
    await page.evaluate(() => history.forward())
    await page.waitForURL(url => url.searchParams.has('created'), { timeout: 30_000 })
    await typeName(page)
    await page.evaluate(() => history.back())
    await expectStayedWithInput(page, saved)
  }))
}

test('画面内のリンクと再読み込みの確認は、これまでどおり働く', () => withPage({}, async page => {
  await openTypedForm(page)
  await navLink(page, '友だち').click()
  await expectStayedWithInput(page)
  await leaveAsk(page).click()
  const dialogs = []
  page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss() })
  await page.reload({ timeout: 5_000 }).catch(() => {})
  await page.waitForTimeout(500)
  assert.deepEqual(dialogs, ['beforeunload'])
  assert.equal(pathOf(page), '/tags/new')
  assert.equal(await nameField(page).inputValue(), TYPED)
}))

/*
 * 別の文書への戻る・進むは popstate にならず、ブラウザの離脱確認（beforeunload）が守る。Firefox は人が触った
 * ページでだけ確認を出すので、入力は欄を押してキーボードで打つ。
 */
const otherOrigin = () => {
  const other = new URL(base)
  other.hostname = other.hostname === 'localhost' ? '127.0.0.1' : 'localhost'
  return other.origin
}
const crossDocumentCases = [
  { name: '別の文書（about:blank）', previous: () => 'about:blank', skip: false },
  {
    name: '別のオリジン',
    previous: () => `${otherOrigin()}/tags`,
    skip: ENGINE === 'webkit' ? 'WebKit は別のオリジンの前の文書へ戻るとき、beforeunload の確認を出さずに移る（ページからは止められない）' : false,
  },
]
for (const entry of crossDocumentCases) {
  test(`${entry.name}への戻るは、ブラウザの離脱確認に任せて入力を守る`, { skip: entry.skip }, () => withPage({}, async page => {
    await page.goto(entry.previous())
    await page.goto(`${base}/tags/new`)
    await nameField(page).waitFor({ timeout: 60_000 })
    await nameField(page).click()
    await page.keyboard.type(TYPED)
    await waitGuardArmed(page)
    const dialogs = []
    page.on('dialog', dialog => { dialogs.push(dialog.type()); void dialog.dismiss() })
    await page.goBack({ timeout: 5_000 }).catch(() => {})
    await page.waitForTimeout(500)
    assert.deepEqual(dialogs, ['beforeunload'])
    assert.equal(pathOf(page), '/tags/new')
    assert.equal(await nameField(page).inputValue(), TYPED)
    assert.equal(await leaveAsk(page).count(), 0)
  }))
}

/*
 * 故障対照は Chromium だけで起きる。Chromium は window 宛ての受け口を付けた順に呼ぶが、WebKit・Firefox は捕捉段の
 * 受け口を先に呼ぶので、付ける順が遅れても番兵が先に受ける。
 */
const controlSkip = FAULT ? '全部の試験に故障を入れている' : ENGINE ? 'WebKit・Firefox は捕捉段の受け口を先に呼ぶので、付ける順の故障は起きない' : false
test('故障対照：受け口が Next のルーターより後ろだと、戻るで確認が出ずに入力ごと前の画面へ移る', { skip: controlSkip }, () => withPage({ fault: true }, async page => {
  await openTypedForm(page)
  await page.evaluate(() => history.back())
  await page.waitForURL(url => url.pathname === '/tags', { timeout: 30_000 })
  await page.getByRole('link', { name: /タグを作る/ }).first().waitFor({ timeout: 30_000 })
  assert.equal(await leaveAsk(page).count(), 0)
}))
