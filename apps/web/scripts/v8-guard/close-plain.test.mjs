import test from 'node:test'
import assert from 'node:assert/strict'
import { connectGuardBrowser } from './browser-session.mjs'
import scan from './close-plain-browser.mjs'

test('閉じるボタンの通常時の枠・地・影を検出する', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent('<button data-close-control aria-label="閉じる" style="border:0;background:transparent;box-shadow:none;outline:0">×</button>')
    assert.deepEqual(await page.evaluate(scan), [])
    for (const style of ['border: 1px solid #ccc', 'outline: 1px solid #ccc', 'box-shadow: 0 1px 2px #aaa', 'background: white']) {
      await page.locator('button').evaluate((el, css) => { el.style.cssText = 'border:0;background:transparent;box-shadow:none;outline:0;' + css }, style)
      assert.equal((await page.evaluate(scan)).length, 1, style)
    }
  } finally { await browser.close() }
})

test('共通の窓と右欄の閉じる操作は枠なしで、枠を付けると検出する', { skip: !process.env.V8_GUARD_URL }, async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.addInitScript(() => { localStorage.setItem('lh_selected_account', 'visual-qa-account'); sessionStorage.setItem('lh_auth_selection_cleared', '1'); localStorage.setItem('lh:v8:first-run-popup-dismissed:visual-qa-account', '1') })
    await page.goto(`${process.env.V8_GUARD_URL}/restaurant-test/dashboard`)
    const later = page.getByRole('button', { name: 'あとで' })
    if (await later.isVisible().catch(() => false)) await later.click()
    await page.getByRole('button', { name: '予約を入れる' }).click()
    const button = page.locator('[data-close-control]').first()
    await button.waitFor()
    await page.mouse.move(0, 0)
    assert.deepEqual(await page.evaluate(scan), [])
    await button.evaluate(el => { el.style.border = '1px solid black' })
    assert.equal((await page.evaluate(scan)).length, 1)
    await button.evaluate(el => { el.style.border = '' })
    await button.click()
    await page.getByRole('dialog', { name: '電話予約を入れる' }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'ウォークイン' }).click()
    await page.getByRole('dialog', { name: 'ウォークインを入れる' }).locator('[data-close-control]').waitFor()
    await page.mouse.move(0, 0)
    assert.deepEqual(await page.evaluate(scan), [])
  } finally { await browser.close() }
})
