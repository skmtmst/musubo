/*
 * #678 LINE通知画面の実ブラウザ検査。再実行できる形で残す。
 *
 *   pnpm --filter web build            # apps/web/out を作る
 *   node apps/web/src/app/line-notifications/line-notifications-browser-behavior.mjs
 *
 * 実物のChromeで、実物のCSSと実物のReactを動かして次を確かめる。
 *   1. 375px級で、編集画面の主要操作が画面の外へ出ないこと（寸法検査）
 *   2. 保存中に足した入力が、古い応答で端末の控えごと消えないこと（競合1）
 *   3. A保存中→B→A→再編集のあとに古いAの応答が返っても消えないこと（競合2）
 *   4. B選択直後・Bの一覧がまだ読み込み中のうちに古いAの応答が返っても
 *      消えないこと（競合3）
 *
 * 【競合3について、確かめたことと確かめていないこと】
 * loadGeneration は load の useEffect の中でしか進まない、という
 * コードの作りそのものは、実装の詳細（Reactの副作用が「いつ」実行される
 * かはAPIとして保証されていない）に頼っている点で脆い。そこで、選択中
 * accountを描画の境界で同期反映する ref（selectedAccountRef）を作り、
 * guard がそれも見るようにした（page.tsx の isStale）。
 *
 * account照合の必要性そのものは、実物の LineNotificationsPage を
 * mountした試験（line-notifications-n678-contract.test.tsx の「実物の
 * LineNotificationsPageをmountし、layout境界（Bへコミット直後・loadの
 * useEffect発火前）で…」）で確定的に固定している。account context の
 * 切替を act を経由しない生の setState として起こし、同じ木に置いた
 * useLayoutEffect の探針で「Bへコミットした・loadの useEffect はまだ
 * 一度も発火していない」瞬間を検出して、そこで旧Aの保存応答を解放する。
 * レイアウトeffectは同じコミット内の受動effectより必ず先に走るという
 * Reactの保証に基づくため、タイミングの偶然に頼っていない。
 * account照合を外す逆変異でこの試験は確実に落ちる（Aの下書きが
 * 元の内容へ巻き戻ることを確認済み）。
 *
 * 一方、ここ（実ブラウザ）では、この画面の実際の挙動として
 * loadGeneration の更新がアカウント切替の描画と「事実上ほぼ同時」に
 * 起きることを確認しており（settings 等のfetchをすべて足止めしても
 * generation は即座に進む）、旧Aの応答をどれだけ遅らせても
 * loadGeneration 単体の照合で既に検知できてしまう——つまりこの実ブラウザ
 * 試験は「Bへ切り替わった直後・Bの一覧がまだ何も出ていない」という
 * 状態を実物のブラウザで再現し、その状態でもAの控えが守られることを
 * 確かめるものであり、account照合だけを外す逆変異を単体でこの試験だけに
 * かけても、この試験は落ちない（generationの照合が既に十分なため）。
 *
 * apps/web/src/app/automations/automation-browser-behavior.mjs と同じ作りにしている。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from '@playwright/test'

let lastPage

const outDir = join(process.cwd(), 'apps/web/out')
if (!existsSync(outDir)) {
  throw new Error('apps/web/out がありません。先に pnpm --filter web build を実行してください。')
}

function contentType(path) {
  return ({
    '.css': 'text/css',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
  })[extname(path)] ?? 'application/octet-stream'
}

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
  const relative = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\//, '')
  const plain = join(outDir, relative || 'index.html')
  const candidates = extname(plain) ? [plain] : [`${plain}.html`, join(plain, 'index.html')]
  const file = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  if (!file) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  response.writeHead(200, { 'content-type': contentType(file) })
  createReadStream(file).pipe(response)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('テスト用サーバのポートを取得できません')
const baseUrl = `http://127.0.0.1:${address.port}`

const accounts = [
  { id: 'account-a', channelId: 'channel-a', name: 'A店', displayName: 'A店', isActive: true, country: 'JP', role: null, displayOrder: 0 },
  { id: 'account-b', channelId: 'channel-b', name: 'B店', displayName: 'B店', isActive: true, country: 'JP', role: null, displayOrder: 1 },
]

// ECイベントの正名。worker の event_type・定義の source_event_type と同じ値。
const EVENT_TYPE = 'ec.order.confirmed'

const ACCOUNT_LOAD_PATHS = new Set([
  '/api/line-notifications/operator-rules',
  '/api/ec-commerce/settings',
  '/api/ec-commerce/overview',
  '/api/line-notifications/customer-definitions',
  '/api/line-notifications/metrics',
  '/api/line-notifications/send-counts',
])

function notificationSetting(accountId) {
  return {
    eventType: EVENT_TYPE,
    label: '注文受付',
    isEnabled: true,
    title: `${accountId === 'account-b' ? 'B店' : 'A店'}の注文受付`,
    introText: `${accountId === 'account-b' ? 'B店' : 'A店'}の本文`,
    outroText: '結びの文章',
    category: 'order',
    buttonLabel: '注文を見る',
    buttonUrl: '',
    imageUrl: '',
    displayOrder: 0,
    fixedFields: ['注文番号', '商品名'],
    fixedPreview: '',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

function customerDefinition(accountId) {
  return {
    id: `definition-${accountId}`,
    lineAccountId: accountId,
    name: '注文受付',
    category: 'order',
    sourceEventType: EVENT_TYPE,
    status: 'published',
    version: 4,
    currentVersionNumber: 3,
    draft: {
      title: `${accountId === 'account-b' ? 'B店' : 'A店'}の注文受付`,
      introText: `${accountId === 'account-b' ? 'B店' : 'A店'}の本文`,
      outroText: '結びの文章',
      buttonLabel: '注文を見る',
      buttonUrl: '',
      imageUrl: '',
      fixedFields: ['注文番号', '商品名'],
    },
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

function operatorRule(id) {
  return {
    id,
    lineAccountId: 'account-a',
    name: '新しい予約が入りました',
    eventType: 'reservation.created',
    conditions: {
      threshold: 'one',
      importance: 'normal',
      recipientIds: ['staff-1'],
      recipientLabel: '1人',
      schedule: 'anytime',
      scheduleLabel: 'いつでも',
      dedupeMinutes: 10,
      onlyAvailable: false,
    },
    channels: ['dashboard', 'line'],
    status: 'published',
    recipientCount: 1,
    occurredToday: 0,
    version: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

async function openHarness(browser) {
  const state = { draftSaves: [], saveDelayMs: 0, holdSave: null, holdAccountLoad: {}, operatorItems: [] }
  const context = await browser.newContext()
  await context.addInitScript(() => {
    localStorage.setItem('lh_selected_account', 'account-a')
    sessionStorage.setItem('lh_auth_selection_cleared', '1')
  })
  const page = await context.newPage()
  lastPage = page
  page.on('pageerror', (error) => console.error('browser page error:', error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('browser console:', message.text())
  })
  await page.route('**/admin/version', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ version: '0.24.0', worker_hash: 'test', admin_hash: 'test', liff_hash: 'test' }),
  }))
  await page.route('**/admin/manifest', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ latest: '0.24.0', releases: [] }),
  }))
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const accountId = url.searchParams.get('lineAccountId') ?? 'account-a'
    const json = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(body),
    })
    /*
     * 競合3（B選択直後・Bのloadが完了する前）の再現に使う。settings/overview/
     * operator-rules/customer-definitions/metrics のいずれも、この account
     * 向けの応答をここで足止めできる——Bへ切り替えた直後、Bの一覧がまだ
     * 何も出ていない「読み込み中」のうちに、旧Aの応答を通す窓を作る。
     */
    const holdForAccount = state.holdAccountLoad[accountId]
    if (holdForAccount && ACCOUNT_LOAD_PATHS.has(path)) await holdForAccount

    if (path === '/api/auth/session') {
      return json({ success: true, data: { name: 'owner利用者', role: 'owner', permissionKeys: [] }, csrfToken: 'test-csrf' })
    }
    if (path === '/api/staff/me') {
      return json({ success: true, data: { id: 'staff-me', name: 'owner利用者', role: 'owner', permissions: [], viewPermissions: [] } })
    }
    if (path === '/api/line-accounts') return json({ success: true, data: accounts })
    const entryAccount = /^\/api\/line-accounts\/([^/]+)\/follower-import$/.exec(path)
    if (request.method() === 'GET' && entryAccount && url.searchParams.get('entry') === '1') {
      return accounts.some(account => account.id === decodeURIComponent(entryAccount[1]))
        ? json({ success: true, data: { destination: 'dashboard', canResume: false } })
        : json({ success: false, code: 'LINE_ACCOUNT_NOT_FOUND' }, 404)
    }
    if (path === '/api/dashboard/style') return json({ success: true, data: { style: 'standard', styleSelected: true } })
    if (path === '/api/settings/features') {
      return json({ success: true, data: { features: {}, sidebarOrder: null, sidebarItemOrder: null, parentChildMode: false, specializedFeatureKeys: [], version: 1 } })
    }
    if (path === '/api/line-notifications/operator-rules') {
      return json({ success: true, data: { items: state.operatorItems, summary: { total: 7, published: 7, stopped: 0, missingRecipients: 0, recipients: 3, acceptedToday: 0, excludedToday: 0 } } })
    }
    /*
     * NOTIFY-04 の行き先。一覧の名前は ?id= 付きで開き直すので、
     * idでの読み直しと宛先プレビューも実形で返す。
     */
    if (path === '/api/line-notifications/operator-rules/recipients-preview') {
      return json({ success: true, data: { items: [{ id: 'staff-1', name: '店長 一郎', channels: { dashboard: true, line: true, email: false } }] } })
    }
    if (path.startsWith('/api/line-notifications/operator-rules/')) {
      const rule = state.operatorItems.find((item) => path === `/api/line-notifications/operator-rules/${encodeURIComponent(item.id)}`)
      return rule ? json({ success: true, data: rule }) : json({ success: false, error: 'not found' }, 404)
    }
    if (path === '/api/ec-commerce/settings') return json({ success: true, data: [notificationSetting(accountId)] })
    if (path === '/api/ec-commerce/overview') {
      return json({ success: true, data: { last24h: 3, failed: 0, byType: [{ eventType: EVENT_TYPE, label: '注文受付', count: 3 }] } })
    }
    if (path === '/api/line-notifications/customer-definitions') {
      return json({ success: true, data: [customerDefinition(accountId)] })
    }
    if (path === '/api/line-notifications/metrics') return json({ success: true, data: { items: [] } })
    /*
     * この枝で足した送信件数の口（今日・この30日）の見本。
     * 無いと画面側が undefined のまま .map して落ちる。
     */
    if (path === '/api/line-notifications/send-counts') {
      return json({
        success: true,
        data: {
          sentToday: 3,
          sentLast30d: 12,
          byEventType: [{ eventType: EVENT_TYPE, today: 3, last30d: 12 }],
          period: { today: '2026-09-01', from30d: '2026-08-03', to: '2026-09-01' },
        },
      })
    }
    if (/\/customer-definitions\/[^/]+\/draft$/.test(path) && request.method() === 'PATCH') {
      const body = request.postDataJSON()
      state.draftSaves.push(body?.draft?.introText ?? null)
      // 保存を握る。試験の側で「返す時刻」を決められるようにする。
      if (state.holdSave) await state.holdSave
      if (state.saveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.saveDelayMs))
      return json({ success: true, data: { ...customerDefinition(body?.lineAccountId ?? 'account-a'), version: 5, draft: body?.draft ?? {} } })
    }
    return json({ success: true, data: [] })
  })
  return { context, page, state }
}

async function openEditor(page) {
  await page.goto(`${baseUrl}/line-notifications`)
  await openCurrentEditor(page)
}

async function openCurrentEditor(page) {
  const editRow = page.getByRole('button', { name: '内容を編集' })
  await editRow.first().waitFor({ timeout: 15_000 })
  await editRow.first().click()
  await page.getByRole('textbox', { name: 'ご案内文', exact: true }).waitFor({ timeout: 15_000 })
}

const introBox = (page) => page.getByRole('textbox', { name: 'ご案内文', exact: true })
const draftKey = (accountId) => `line-notifications:draft:v1:${accountId}:${EVENT_TYPE}`

async function switchAccount(page, accountId) {
  const account = accounts.find((item) => item.id === accountId)
  assert.ok(account, '切り替えるアカウントを用意している')
  await page.getByRole('button', { name: 'アカウントを切り替える', exact: true }).click()
  await page.getByRole('menu', { name: 'LINEアカウントの切り替え', exact: true })
    .getByRole('menuitemradio', { name: account.name, exact: true }).click()
}

const browser = await chromium.launch({ headless: true })
try {
  {
    /*
     * 1. 375px級の寸法検査。
     * 主要操作のボタンが1つでも画面の右端を越えたら、その幅では押せない。
     */
    const { context, page } = await openHarness(browser)
    await openEditor(page)
    await introBox(page).fill('寸法検査用の下書き')
    const widths = [375, 390, 768, 1440, 1920]
    for (const width of widths) {
      await page.setViewportSize({ width, height: 812 })
      await page.waitForTimeout(150)
      const measured = await page.evaluate(() => {
        const actions = document.querySelector('[data-template-region="footer"] [data-sticky-actions]')
        const footer = document.querySelector('[data-template-region="footer"]')
        const footerStyle = getComputedStyle(footer)
        const buttons = [...document.querySelector('[data-design-node="Q55bb"]').querySelectorAll('[data-dialog-actions] button, [data-sticky-actions] button')].map((button) => {
          const rect = button.getBoundingClientRect()
          const style = getComputedStyle(button)
          const probe = document.createElement('span')
          probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;'
          // `style.font` は font-variant-numeric などが入ると空文字になり、本文の書体で
          // 測ってしまう（ボタンの余白が戻った 2026-10-02 に、収まっている文字を誤検知）。
          // 書体の値は1つずつ写す。
          probe.style.fontFamily = style.fontFamily
          probe.style.fontSize = style.fontSize
          probe.style.fontWeight = style.fontWeight
          probe.style.fontStyle = style.fontStyle
          probe.style.fontVariantNumeric = style.fontVariantNumeric
          probe.style.letterSpacing = style.letterSpacing
          probe.textContent = button.textContent
          document.body.appendChild(probe)
          const needs = probe.getBoundingClientRect().width
            + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
            + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
          probe.remove()
          const overflows = button.scrollWidth > button.clientWidth
          return { text: button.textContent.trim(), right: rect.right, width: rect.width, needs, overflows }
        })
        return {
          viewport: window.innerWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          actionsWidth: actions.getBoundingClientRect().width,
          footerHeight: footer.getBoundingClientRect().height,
          footerPosition: footerStyle.position,
          footerBottom: footerStyle.bottom,
          rows: new Set(buttons.map((button) => Math.round(button.right - button.width))).size,
          rightmost: Math.max(...buttons.map((button) => button.right)),
          squeezed: buttons.filter((button) => button.overflows || button.needs > button.width + 1).map((button) => button.text),
        }
      })
      console.log(`  ${width}px 操作列 ${Math.round(measured.actionsWidth)}px / 右端 ${Math.round(measured.rightmost)}px / フッタ ${Math.round(measured.footerHeight)}px / 追従 ${measured.footerPosition}`)
      assert.ok(measured.rightmost <= width + 1, `${width}px で主要操作が画面の外へ出ている（右端 ${Math.round(measured.rightmost)}px）`)
      assert.deepEqual(measured.squeezed, [], `${width}px でボタンの文字が枠に収まっていない`)
      assert.ok(measured.documentScrollWidth <= width + 1, `${width}px でページが横スクロールする`)
      assert.equal(measured.footerPosition, 'sticky', `${width}px で保存帯が本文の共通の追従位置を失っている`)
      assert.notEqual(measured.footerBottom, 'auto', `${width}px で保存帯の追従位置がない`)
    }
    await context.close()
    console.log('375px 寸法検査: PASS')
  }

  {
    /*
     * 2. 競合1: 保存中の追加入力。
     * 保存を押したあとに書き足し、その後で古い保存応答を返す。
     * 端末の控えが消えず、再読込でも書き足した分が残ることを見る。
     */
    const { context, page, state } = await openHarness(browser)
    await openEditor(page)
    const intro = introBox(page)
    await intro.fill('保存を押した時点の本文')
    await page.waitForTimeout(100)

    let releaseSave = () => {}
    state.holdSave = new Promise((resolve) => { releaseSave = resolve })
    await page.getByRole('button', { name: '下書きを保存する', exact: true }).click()
    await page.waitForFunction(() => document.body.innerText.includes('未保存の変更があります'))

    // 保存の応答を止めたまま書き足す。
    await intro.fill('保存を押した時点の本文＋あとから足した一文')
    await page.waitForTimeout(100)
    releaseSave()
    await page.waitForTimeout(800)

    assert.deepEqual(state.draftSaves, ['保存を押した時点の本文'], '保存APIへ送ったのは押した時点の文面')
    const stored = await page.evaluate((key) => localStorage.getItem(key), draftKey('account-a'))
    assert.ok(stored, '保存中に足した入力の控えが端末から消えている')
    assert.ok(JSON.parse(stored).introText.includes('あとから足した一文'), '控えが古い文面へ戻っている')
    assert.ok(
      await page.getByText('未保存の変更があります').count() > 0,
      '書き足した分が未保存のままなのに、保存済みと表示している',
    )

    // 再読込しても書き足した分が残る。
    await page.reload()
    await page.getByRole('button', { name: '内容を編集' }).first().waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '内容を編集' }).first().click()
    await introBox(page).waitFor()
    assert.equal(
      await introBox(page).inputValue(),
      '保存を押した時点の本文＋あとから足した一文',
      '再読込で、保存中に足した入力が消えている',
    )
    await context.close()
    console.log('競合1（保存中の追加入力）: PASS')
  }

  {
    /*
     * 3. 競合2: A保存中 → B → A → 再編集 → 古いAの応答。
     * 戻ってから書き直した文面を、古い応答が消さないことを見る。
     */
    const { context, page, state } = await openHarness(browser)
    await openEditor(page)
    await introBox(page).fill('Aで保存を押した時点の本文')
    await page.waitForTimeout(100)

    let releaseSave = () => {}
    state.holdSave = new Promise((resolve) => { releaseSave = resolve })
    await page.getByRole('button', { name: '下書きを保存する', exact: true }).click()
    await page.waitForFunction(() => document.body.innerText.includes('未保存の変更があります'))

    // アカウントの切り替えでは編集を閉じ、切り替え先の編集を開き直す。
    const introValue = () => page.evaluate(() => {
      const box = document.querySelector('#customer-notification-intro')
      return box ? box.value : null
    })
    const waitForIntro = async (expected) => {
      await openCurrentEditor(page)
      await page.waitForFunction((want) => {
        const box = document.querySelector('#customer-notification-intro')
        return Boolean(box) && box.value === want
      }, expected, { timeout: 15_000 })
    }

    await switchAccount(page, 'account-b')          // A → B
    await waitForIntro('B店の本文')
    await switchAccount(page, 'account-a')          // B → A
    // Aへ戻ると、端末に残した控えが復元される。
    await waitForIntro('Aで保存を押した時点の本文')
    assert.equal(await introValue(), 'Aで保存を押した時点の本文')
    await introBox(page).fill('Aへ戻って書き直した本文')
    await page.waitForTimeout(100)

    releaseSave()                                          // ここで古いAの応答が返る
    await page.waitForTimeout(800)

    const stored = await page.evaluate((key) => localStorage.getItem(key), draftKey('account-a'))
    assert.ok(stored, '戻ってから書き直した控えが、古い応答で消えている')
    assert.equal(JSON.parse(stored).introText, 'Aへ戻って書き直した本文', '控えが古い文面へ戻っている')
    assert.equal(await introBox(page).inputValue(), 'Aへ戻って書き直した本文', '画面の文面が古い応答で戻っている')
    assert.ok(
      await page.getByText('未保存の変更があります').count() > 0,
      '書き直した分が未保存のままなのに、保存済みと表示している',
    )
    await context.close()
    console.log('競合2（A保存中→B→A→再編集）: PASS')
  }

  {
    /*
     * 4. 競合3（司令塔の独立再審査REJECT、2026-09-09）。
     *
     * loadGeneration は load の useEffect の中でしか進まない。従来の
     * 実ブラウザ試験（競合2）は、Bの読み込みが終わり、さらにAへ戻って
     * 再読み込みも終わったあとで旧Aの応答を解放していた——「Bを選んだ
     * 直後・Bの一覧がまだ何も出ていない」窓を一度も通していなかった。
     *
     * ここではBの一覧読み込み（settings/overview/operator-rules/
     * customer-definitions/metrics）をすべて足止めしたうえで、Bへ切り替えた
     * 直後・その足止めが解けるより前に、旧Aの保存応答を解放する。
     * Bへ切り替わった描画そのもの（アカウント選択欄の表示・URLの状態）は
     * 済んでいるが、Bの一覧はまだ「読み込み中」のまま——という、
     * 指摘された隙間の中で旧Aの応答を通す。
     */
    const { context, page, state } = await openHarness(browser)
    await openEditor(page)
    await introBox(page).fill('Aで保存を押した時点の本文')
    await page.waitForTimeout(100)

    let releaseA = () => {}
    state.holdSave = new Promise((resolve) => { releaseA = resolve })
    await page.getByRole('button', { name: '下書きを保存する', exact: true }).click()
    await page.waitForFunction(() => document.body.innerText.includes('未保存の変更があります'))

    // Bの一覧読み込みを足止めする。切り替えても、Bの中身はまだ何も出ない。
    let releaseB = () => {}
    state.holdAccountLoad['account-b'] = new Promise((resolve) => { releaseB = resolve })

    await switchAccount(page, 'account-b')
    // Bへ切り替わった描画（アカウント選択欄）は済んでいるが、
    // 一覧はまだ「読み込み中」——ここが指摘された窓。見つからなければ
    // 窓を通せていないということなので、握り潰さず試験自体を落とす。
    await page.waitForSelector('[data-list-state="loading"]', { timeout: 15_000 })
    await page.waitForTimeout(150)

    // まさにこの窓のうちに、古いAの応答を返す。
    releaseA()
    await page.waitForTimeout(300)

    // Bの読み込みを再開させ、普通に終わらせる（隙間を通したことの裏取り）。
    releaseB()
    await openCurrentEditor(page)
    await page.waitForFunction(() => {
      const box = document.querySelector('#customer-notification-intro')
      return Boolean(box) && box.value === 'B店の本文'
    }, undefined, { timeout: 15_000 })

    const stored = await page.evaluate((key) => localStorage.getItem(key), draftKey('account-a'))
    assert.ok(stored, 'Bの一覧がまだ読み込み中のうちに返った旧Aの応答で、Aの控えが消えている')
    assert.equal(JSON.parse(stored).introText, 'Aで保存を押した時点の本文', '控えの中身が変わっている')

    // Aへ戻ると、消されていない控えが復元され、未保存の印も戻る。
    await switchAccount(page, 'account-a')
    await openCurrentEditor(page)
    await page.waitForFunction(() => {
      const box = document.querySelector('#customer-notification-intro')
      return Boolean(box) && box.value === 'Aで保存を押した時点の本文'
    }, undefined, { timeout: 15_000 })
    assert.ok(
      await page.getByText('未保存の変更があります').count() > 0
        || await page.getByText(/未保存の編集を.*件復元しました/).count() > 0,
      'Bの一覧がまだ読み込み中のうちに返った旧Aの応答で、未保存の印が消えている',
    )
    await context.close()
    console.log('競合3（B選択直後・Bの一覧が読み込み中のうちに旧Aの応答が返る）: PASS')
  }

  {
    /*
     * 5. NOTIFY-04: 運用者一覧の名前から編集画面へ戻る。
     *
     * 監査で「名前を押しても動かない」が挙がった。名前は
     * /line-notifications/operator/new?id=<id> への実リンクなので、
     * 実ブラウザで押して URL が進むこと、戻っても一覧と他タブが
     * そのまま使えることを確かめる。id に空白を含めるのは、
     * encodeURIComponent が外れると別の通知を開いてしまうため。
     */
    const { context, page, state } = await openHarness(browser)
    state.operatorItems = [operatorRule('rule-abc 123')]
    await page.goto(`${baseUrl}/line-notifications?tab=operator`)
    const nameLink = page.getByRole('link', { name: '新しい予約が入りました' })
    await nameLink.waitFor({ timeout: 15_000 })
    await nameLink.click()
    await page.waitForFunction(() => location.pathname === '/line-notifications/operator/new', undefined, { timeout: 15_000 })
    assert.equal(new URL(page.url()).searchParams.get('id'), 'rule-abc 123')
    // 開き直した編集画面は、保存ずみのお知らせを読み直して名前まで戻す。
    await page.waitForFunction(() => {
      const input = document.querySelector('#operator-name')
      return Boolean(input) && input.value === '新しい予約が入りました'
    }, undefined, { timeout: 15_000 })

    // 一覧へ戻っても名前のリンクと他タブはそのまま動く。
    await page.goBack()
    await nameLink.waitFor({ timeout: 15_000 })
    // タブは #708 で role="tab" へ変わった（nav>button ではなく tablist/tab）。
    await page.getByRole('tab', { name: /顧客へのお知らせ/ }).first().click()
    const customerRow = page.getByRole('row').filter({ hasText: '注文が確定したとき' })
    await customerRow.getByRole('button', { name: /の内容を編集$/ }).waitFor({ timeout: 15_000 })
    await context.close()
    console.log('NOTIFY-04（一覧の名前から編集画面へ戻る）: PASS')
  }

  console.log('line notifications browser behavior: PASS')
} catch (error) {
  console.error('browser current URL:', lastPage.url())
  console.error('browser body:', (await lastPage.locator('body').innerText()).slice(0, 4000))
  throw error
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
