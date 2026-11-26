import test from 'node:test'
import assert from 'node:assert/strict'
import { connectGuardBrowser } from './browser-session.mjs'
import { stubApi } from './speed-budget.mjs'
import { mockFetch } from './mock-local.mjs'
import scan from './viewport-footer-browser.mjs'

test('保存帯付きの在庫は本文だけが送り、旧高さの故障を検出して復元する', async () => {
  const browser = await connectGuardBrowser()
  try {
    for (const [width, height] of [[1152, 900], [1440, 900], [1024, 900], [1152, 600]]) {
      const baseUrl = process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310'
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
      try {
        await stubApi(page, mockFetch)
        await page.addInitScript(() => {
          for (const [key, value] of Object.entries({ lh_csrf: 'visual-qa-csrf', lh_staff_role: 'owner', lh_staff_name: 'K', lh_staff_permissions: '[]', lh_staff_view_permissions: '[]', lh_selected_account: 'visual-qa-account', lh_auth_selection_cleared: '1' })) localStorage.setItem(key, value)
        })
        const response = await page.goto(new URL('/restaurant-test/inventory', baseUrl).href)
        assert.ok(response?.ok(), 'built inventory must exist')
        await page.getByRole('switch', { name: '月曜日に予約を受ける', exact: true }).click()
        await page.getByRole('button', { name: '開ける時間を保存', exact: true }).waitFor()
        const frame = page.locator('main#main-content > [data-design-shell] > [data-page-template="restaurant"][data-standalone][data-has-footer][data-frame-height="viewport"]')
        await frame.locator('button[data-part="row-name"]').first().waitFor()
        await page.evaluate(() => document.fonts.ready)
        assert.equal(await frame.count(), 1)
        assert.deepEqual(await page.evaluate(scan), [])
        const before = await frame.evaluate(element => {
          const main = element.parentElement.parentElement, body = element.querySelector(':scope > [data-template-region="body"]')
          const footer = element.querySelector(':scope > [data-template-region="footer"]')
          const scrollable = body.scrollHeight > body.clientHeight + 1
          const top = footer.getBoundingClientRect().top
          body.scrollTop = body.scrollHeight
          return { scrollable, bodyScroll: body.scrollTop, mainScroll: main.scrollTop, footerTop: footer.getBoundingClientRect().top, initialFooterTop: top, style: element.getAttribute('style') }
        })
        assert.ok(before.scrollable && before.bodyScroll > 0, 'long inventory body must actually scroll')
        assert.equal(before.mainScroll, 0)
        assert.equal(before.footerTop, before.initialFooterTop)
        assert.deepEqual(await page.evaluate(scan), [])
        await frame.evaluate(element => { element.style.setProperty('height', 'calc(100dvh - 74px)', 'important'); element.style.setProperty('flex', 'none', 'important') })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const heightFault = await page.evaluate(scan)
        console.log(JSON.stringify({ width, height, faultGeometry: await frame.evaluate(element => ({ style: element.getAttribute('style'), computedHeight: getComputedStyle(element).height, computedFlex: getComputedStyle(element).flex, frame: element.getBoundingClientRect().toJSON(), main: element.parentElement.parentElement.getBoundingClientRect().toJSON(), mainClient: element.parentElement.parentElement.clientHeight, mainScroll: element.parentElement.parentElement.scrollHeight })), heightFault }))
        assert.ok(heightFault.some(finding => finding.kind === 'viewport-footer-frame-overflow' || finding.kind === 'viewport-footer-outer-scroll'), 'same guard must reject the previous double height allocation')
        await frame.evaluate((element, style) => { if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style); element.querySelector(':scope > [data-template-region="body"]').scrollTop = 0; element.parentElement.parentElement.scrollTop = 0 }, before.style)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert.deepEqual(await page.evaluate(scan), [])
        assert.equal(await frame.getAttribute('style'), before.style)
        const footer = frame.locator(':scope > [data-template-region="footer"]')
        const footerStyle = await footer.getAttribute('style')
        await footer.evaluate(element => element.style.setProperty('transform', `translateY(-${element.getBoundingClientRect().height}px)`, 'important'))
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const overlapFault = await page.evaluate(scan)
        assert.ok(overlapFault.some(finding => finding.kind === 'viewport-footer-body-overlap'), 'same guard must reject a footer moved over body controls')
        await footer.evaluate((element, style) => { if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style) }, footerStyle)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert.deepEqual(await page.evaluate(scan), [])
        assert.equal(await footer.getAttribute('style'), footerStyle)
        console.log(JSON.stringify({ width, height, bodyScroll: before.bodyScroll, mainScroll: before.mainScroll, heightFault: heightFault.map(finding => finding.kind), overlapFault: overlapFault.map(finding => finding.kind), restored: true }))
      } finally { await page.close() }
    }
  } finally { await browser.close() }
})
