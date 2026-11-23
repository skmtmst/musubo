import test from 'node:test'
import assert from 'node:assert/strict'
import { connectGuardBrowser } from './browser-session.mjs'
import scan from './menu-color-browser.mjs'

test('メニュー項目の緑を検出し、普通の色と危険色を許す', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<div role="menu"><button role="menuitem" style="color:rgb(30,30,30)"><svg style="color:rgb(110,110,110)"></svg>編集</button><button role="menuitem" style="color:rgb(190,20,20)">削除</button></div>')
    assert.deepEqual(await page.evaluate(scan), [])
    await page.locator('svg').evaluate(el => { el.style.color = 'rgb(0,128,60)' })
    assert.equal((await page.evaluate(scan)).length, 1)
    await page.locator('svg').evaluate(el => { el.style.color = '' })
    await page.locator('button').first().evaluate(el => { el.style.setProperty('transition', 'none', 'important'); el.style.setProperty('color', 'rgb(0,128,60)', 'important') })
    assert.equal((await page.evaluate(scan)).length, 1)
  } finally { await browser.close() }
})

test('飲食店ダッシュボードのメニューは緑でなく、緑に戻すと検出する', { skip: !process.env.V8_GUARD_URL }, async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(() => { localStorage.setItem('lh_selected_account', 'visual-qa-account'); sessionStorage.setItem('lh_auth_selection_cleared', '1'); localStorage.setItem('lh:v8:first-run-popup-dismissed:visual-qa-account', '1') })
    await page.goto(`${process.env.V8_GUARD_URL}/restaurant-test/dashboard`)
    const later = page.getByRole('button', { name: 'あとで' })
    if (await later.isVisible().catch(() => false)) await later.click()
    await page.getByRole('button', { name: 'その他の操作' }).click()
    await page.getByRole('menuitem', { name: 'LINE を送る' }).waitFor()
    assert.deepEqual(await page.evaluate(scan), [])
    await page.getByRole('menuitem', { name: 'LINE を送る' }).evaluate(el => { el.style.setProperty('transition', 'none', 'important'); el.style.setProperty('color', 'rgb(0,128,60)', 'important') })
    assert.equal((await page.evaluate(scan)).length, 1)
  } finally { await browser.close() }
})
