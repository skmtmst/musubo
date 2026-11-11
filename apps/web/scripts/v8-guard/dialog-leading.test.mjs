import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { connectGuardBrowser } from './browser-session.mjs'
import { mockFetch } from './mock-local.mjs'
import { stubApi } from './speed-budget.mjs'
import { trackPendingApiRequests, waitForNavigationContent } from './navigation-content-ready.mjs'
import { scanLeadingActions } from './dialog-leading-browser.mjs'
import { PARITY_INIT } from '../../../../scripts/visual-qa/v8-parity.mjs'
import { styleDashboardMock } from '../../../../scripts/visual-qa/style-dashboard-mock.mjs'

const base = process.env.V8_GUARD_BASE || 'http://127.0.0.1:4310'
const button = (page, name) => page.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true }).first()
const menu = async (page, trigger, item) => { await button(page, trigger).click(); await page.getByRole('menuitem').filter({ has: page.getByText(item, { exact: true }) }).click() }
const rowMenu = async (page, item) => { await page.locator('main tbody button[aria-haspopup="menu"]').first().click(); await page.getByRole('menuitem', { name: item, exact: true }).click() }
const support = async page => { await page.getByRole('region', { name: 'チケットの一覧' }).locator('li button').first().click(); await page.getByRole('textbox', { name: '返信', exact: true }).waitFor() }

const menuStep = async page => {
  let dialog = page.getByRole('dialog', { name: '使い方のスタイルを選ぶ', exact: true })
  await dialog.getByRole('group', { name: '見るスタイル', exact: true }).getByRole('button', { name: /^飲食店/ }).click()
  const choose = dialog.getByRole('button', { name: 'このスタイルにする', exact: true })
  if (await choose.count()) await choose.click()
  await dialog.getByRole('button', { name: '次へ', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '最初のリッチメニューを選ぶ', exact: true })
  await dialog.waitFor()
}

const recipes = [
  { source: 'components/friends/bulk-run-dialog.tsx', path: '/friends', open: async page => { const checks = page.locator('main tbody input[type="checkbox"]'); await checks.nth(0).check(); await checks.nth(1).check(); await button(page, '操作を選ぶ').click() } },
  { source: 'v8/onboarding/wizard.tsx', index: 0, path: '/?setup=0', after: async page => { await page.getByRole('dialog', { name: '使い方のスタイルを選ぶ', exact: true }).getByRole('button', { name: '次のページ', exact: true }).click() }, open: async page => { const dialog = page.getByRole('dialog', { name: '使い方のスタイルを選ぶ', exact: true }); await dialog.waitFor(); await dialog.getByRole('button', { name: '詳しく見る', exact: true }).click() } },
  { source: 'v8/onboarding/wizard.tsx', index: 1, path: '/?setup=0', after: menuStep, open: async page => { await page.getByRole('dialog', { name: '使い方のスタイルを選ぶ', exact: true }).waitFor() } },
  { source: 'components/friend-fields/edit-tag-page-v4.tsx', path: '/tags/edit?id=tag-0', dependencyFailure: true, open: async page => { await button(page, 'タグを削除する').click() } },
  { source: 'components/friend-fields/tags-page-v4.tsx', path: '/tags', dependencyFailure: true, open: async page => { await rowMenu(page, '保管する') } },
  { source: 'v8/account-new/registration-style-dialog.tsx', index: 0, path: '/accounts/new', registration: true, after: async page => { await page.getByRole('dialog', { name: '使い方のスタイルを選ぶ', exact: true }).getByRole('button', { name: '次のページ', exact: true }).click() }, open: async page => { const dialog = page.getByRole('dialog', { name: '使い方のスタイルを選ぶ', exact: true }); await dialog.waitFor(); await dialog.getByRole('button', { name: '詳しく見る', exact: true }).click() } },
  { source: 'v8/account-new/registration-style-dialog.tsx', index: 1, path: '/accounts/new', registration: true, after: menuStep, open: async page => { await page.getByRole('dialog', { name: '使い方のスタイルを選ぶ', exact: true }).waitFor() } },
  { source: 'v8/hq/account-dialogs.tsx', path: '/hq', open: async page => { await button(page, /の設定$/).click() } },
  { source: 'v8/broadcasts/quick-send.tsx', path: '/broadcasts', dialogTitle: 'かんたんに送る', open: async page => { await menu(page, /^配信を作る/, 'かんたんに送る') }, fault: 'alignment' },
  { source: 'v8/ops/support.tsx', path: '/ops/support', open: async page => { await support(page); await page.getByRole('textbox', { name: '返信', exact: true }).fill('確認用の返信'); await button(page, '返信する').click() } },
  { source: 'v8/forms/list-dialogs.tsx', path: '/form-submissions', open: async page => { await rowMenu(page, 'アーカイブ') } },
  { source: 'v8/affiliates/dialogs.tsx', path: '/affiliates?tab=payment', open: async page => { await page.locator('main tbody button').first().click() } },
  { source: 'v8/hq-templates/saved-distribution-dialog.tsx', path: '/hq/templates?item=visual-hq-tpl-autumn&mode=edit', open: async page => { await page.getByRole('textbox', { name: 'テンプレート名', exact: true }).fill('操作帯の確認'); await button(page, '保存する').click() } },
  { source: 'v8/webhooks/interactions.tsx', path: '/webhooks?tab=interactions', after: async page => { await button(page, '技術的な記録を開く').click(); await button(page, '技術的な記録を閉じる').waitFor() }, open: async page => { await rowMenu(page, '中身を見る') } },
  { source: 'v8/restaurant/google/post-media-picker-dialog.tsx', path: '/restaurant-test/google?tab=posts&view=new&kind=standard', open: async page => { await button(page, '登録メディアから選ぶ').click() } },
  { source: 'v8/contents/media-upload-dialog.tsx', path: '/contents', open: async page => { await button(page, /メディアを登録|ファイルを入れる/).click() } },
  { source: 'v8/contents/list.tsx', path: '/contents', open: async page => { await page.locator('main [data-qa-open="YfTfJ"]').first().click(); await page.getByRole('menuitem', { name: '削除する', exact: true }).click() } },
  { source: 'v8/auto-replies/quick-create.tsx', path: '/auto-replies', open: async page => { await menu(page, /ルールを作る/, 'かんたんに作る') } },
]

// 呼び出し側が増えたら実画面の経路も必要。上限・例外の許可表にはしない。
test('every leadingAction caller has a browser recipe', () => {
  const root = join(process.cwd(), 'apps/web/src'), found = []
  const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (path.endsWith('.tsx') && !path.includes('.test.')) {
      let count = 0
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const visit = node => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'DialogActions' && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'leadingAction')) found.push(`${relative(root, path)}#${count++}`)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  } }
  walk(root)
  assert.deepEqual(recipes.map(row => `${row.source}#${row.index ?? 0}`).sort(), found.sort())
})

for (const width of [1152, 1440]) for (const recipe of recipes) test(`leading actions ${width} ${recipe.source}#${recipe.index ?? 0}`, async () => {
  styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style: 'standard' })
  const key = recipe.source.replaceAll('/', '-').replace('.tsx', '') + `-${recipe.index ?? 0}`
  const dir = join(process.env.V8_GUARD_ARTIFACT_DIR || '/tmp/v8-guard', 'dialog-leading', String(width), key)
  mkdirSync(dir, { recursive: true })
  const browser = await connectGuardBrowser(), context = await browser.newContext({ viewport: { width, height: 1080 }, locale: 'ja-JP', reducedMotion: 'reduce' }), page = await context.newPage()
  page.setDefaultTimeout(7000)
  const identity = JSON.parse((await mockFetch('GET', '/api/staff/me')).body).data
  const resumeKey = `musubo-registration-style:${encodeURIComponent(identity.tenantId)}:${encodeURIComponent(identity.id)}`
  await page.addInitScript(({ values, resumeKey, registration }) => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); if (registration) sessionStorage.setItem(resumeKey, 'visual-qa-account') }, { values: PARITY_INIT, resumeKey, registration: recipe.registration })
  const pending = trackPendingApiRequests(page), errors = []; let normal = null, changed = null, broken = null, restored = null, narrowBroken = null, centerBroken = null, failure = null
  page.on('pageerror', error => errors.push(error.message))
  await stubApi(page, async (method, path) => {
    if (recipe.dependencyFailure && /\/tags\/[^/]+\/dependencies/.test(new URL(path, base).pathname)) return { status: 200, body: JSON.stringify({ success: false, error: '影響を確認できませんでした' }) }
    const response = await mockFetch(method, path)
    if (recipe.source === 'v8/hq-templates/saved-distribution-dialog.tsx' && new URL(path, base).pathname === '/api/hq/templates/visual-hq-tpl-autumn' && method === 'GET') {
      const body = JSON.parse(response.body)
      body.data.definition = { schemaVersion: 1, template: { ...body.data.definition.template, messageType: 'text', messageContent: '操作帯を確認するための本文です。' }, media: [] }
      response.body = JSON.stringify(body)
    }
    if (new URL(path, base).pathname === '/api/staff/me') { const body = JSON.parse(response.body); body.data.accountScope = 'all'; response.body = JSON.stringify(body) }
    return response
  })
  if (recipe.source === 'v8/hq-templates/saved-distribution-dialog.tsx') await page.route('**/api/hq/templates/visual-hq-tpl-autumn', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    // 保存後の窓を本物の処理で開くため、元の型に合う模擬の保存結果を返す。
    const input = route.request().postDataJSON()
    const saved = JSON.parse((await mockFetch('GET', '/api/hq/templates/visual-hq-tpl-autumn')).body)
    saved.data.template = { ...saved.data.template, name: input.name, revision: input.expectedRevision + 1 }
    saved.data.definition = input.definition
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': route.request().headers().origin || base, 'access-control-allow-credentials': 'true' }, json: saved })
  })
  const capture = async name => { await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' }); return page.evaluate(scanLeadingActions) }
  try {
    assert.ok((await page.goto(base + recipe.path, { waitUntil: 'domcontentloaded' }))?.ok())
    await waitForNavigationContent(page, pending, 15000)
    await recipe.open(page)
    if (recipe.dialogTitle) await page.getByRole('dialog', { name: recipe.dialogTitle, exact: true }).waitFor()
    const dialogs = page.locator('[role="dialog"], [role="alertdialog"]').filter({ visible: true })
    await dialogs.last().waitFor()
    await dialogs.last().locator('[data-dialog-action-leading]').waitFor()
    assert.ok(await dialogs.last().locator('[data-dialog-action-leading]').count() > 0, '開いた窓そのものに補助操作がある')
    await page.locator('[data-dialog-action-leading]:visible').first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    normal = await capture('normal')
    assert.ok(normal.length > 0, '実際に補助操作のある帯を開いた')
    assert.deepEqual(normal.flatMap(row => row.errors), [])
    if (recipe.fault === 'overlap') assert.equal(normal[0].stacked, width === 1152, '実幅が足りない1152だけ段組にする')
    if (recipe.fault) {
      const css = recipe.fault === 'overlap' ? 'width: 500px !important; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) !important; align-items: center !important;' : 'align-items: center !important;'
      const injected = await page.addStyleTag({ content: `html:root [data-dialog-actions][data-dialog-action-pair]:has(> [data-dialog-action-leading]) { ${css} } html:root [data-dialog-action-leading] { align-self: auto !important; }` })
      broken = await capture('fault')
      assert.ok(broken.some(row => row.errors.includes(recipe.fault === 'overlap' ? '操作が重なる' : '最初のボタン行の中心がそろわない')), '旧配置の故障を赤にする')
      await injected.evaluate(node => node.remove())
      restored = await capture('restored')
      assert.deepEqual(restored.flatMap(row => row.errors), [])
      if (recipe.fault === 'overlap') {
        const narrow = await page.addStyleTag({ content: 'html:root [data-dialog-actions][data-padding="none"] { width: calc(var(--dialog-leading-min) + var(--dialog-leading-min) + 32px) !important; grid-template-columns: minmax(var(--dialog-leading-min), 1fr) minmax(0, auto) minmax(var(--dialog-leading-min), 1fr) !important; } html:root [data-dialog-actions][data-padding="none"] > [data-dialog-action-leading] + * { grid-column: 2 !important; }' })
        narrowBroken = await capture('fault-center-minimum')
        assert.ok(narrowBroken.some(row => row.errors.includes('主操作が中央の列からはみ出す')), '中央の最小幅を壊すと赤')
        await narrow.evaluate(node => node.remove())
        assert.deepEqual((await capture('restored-center-minimum')).flatMap(row => row.errors), [])
        const offCenter = await page.addStyleTag({ content: 'html:root [data-dialog-actions] > [data-dialog-action-leading] + * { justify-content: flex-start !important; }' })
        centerBroken = await capture('fault-main-alignment')
        assert.ok(centerBroken.some(row => row.errors.includes('主操作の行が中央にない')), '主操作の行を左へ寄せると赤')
        await offCenter.evaluate(node => node.remove())
        assert.deepEqual((await capture('restored-main-alignment')).flatMap(row => row.errors), [])
      }
    }
    if (recipe.after) {
      await recipe.after(page)
      changed = await capture('changed')
      assert.ok(changed.length > 0)
      assert.deepEqual(changed.flatMap(row => row.errors), [])
    }
    assert.deepEqual(errors, [], '画面の未処理エラー0')
  } catch (error) {
    failure = String(error.stack ?? error)
    await page.screenshot({ path: join(dir, 'failure.png'), animations: 'disabled' }).catch(() => {})
    writeFileSync(join(dir, 'body.txt'), await page.locator('body').innerText())
    throw error
  } finally {
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ width, source: recipe.source, index: recipe.index ?? 0, normal, changed, broken, restored, narrowBroken, centerBroken, errors, failure }, null, 2))
    styleDashboardMock('PUT', '/api/dashboard/style', new URLSearchParams(), { style: 'standard' })
    await context.close(); await browser.close()
  }
})
