import { expect, test } from '@playwright/test'

const BASE = process.env.EC_685_BASE ?? 'http://127.0.0.1:3151'

const ACCOUNT_A = 'visual-qa-account'
const ACCOUNT_B = 'visual-qa-account-b'

const summary = {
  pending: 0,
  processing: 0,
  succeeded: 21,
  skipped: 0,
  retryable_failed: 0,
  permanent_failed: 0,
}

function record(index, eventType = 'ec.order.confirmed') {
  const suffix = String(index).padStart(2, '0')
  return {
    id: `action-${suffix}`,
    eventId: `event-${suffix}`,
    eventType,
    eventLabel: eventType === 'ec.order.confirmed' ? '注文完了' : eventType,
    actionType: 'line_notification',
    ruleVersion: 'v1',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    lastAttemptedAt: '2026-09-09T00:00:30.000Z',
    nextRetryAt: null,
    version: 1,
    receivedAt: '2026-09-09T00:00:30.000Z',
    orderNumber: `NEN-${suffix}`,
    customerName: '見本 171',
    friendId: 'friend-a',
    retryAvailable: false,
    order: {
      id: `order-${suffix}`,
      lineAccountId: 'visual-qa-account',
      externalOrderId: `NEN-${suffix}`,
      orderNumber: `NEN-${suffix}`,
      customerId: `customer-${suffix}`,
      friendId: 'friend-a',
      customerName: '見本 171',
      status: 'current',
      providerStatus: 'paid',
      currency: 'JPY',
      totalAmount: index * 100,
      refundedAmount: null,
      orderedAt: '2026-09-09T00:00:00.000Z',
      detailUrl: null,
      version: 1,
      orderLines: [{
        id: `line-${suffix}`,
        productId: `product-${suffix}`,
        productName: `商品${index}`,
        quantity: 1,
        unitAmount: index * 100,
        lineAmount: index * 100,
        productUrl: null,
      }],
    },
  }
}

const overview = {
  success: true,
  data: {
    total: 21,
    processed: 21,
    identityPending: 0,
    failed: 0,
    skipped: 0,
    last24h: 21,
    lastReceivedAt: '2026-09-09T00:00:30.000Z',
    averageDeliverySeconds: 30,
    latencySampleCount: 21,
    byType: [{ eventType: 'ec.order.confirmed', label: '注文完了', count: 20 }],
  },
}

/*
 * 共通レイアウト(トップバー・サイドバー)が呼ぶ、この試験の対象外のAPI。
 * モックしないと実ネットワークへ到達を試み、ローカルのwrangler devポートや
 * CI環境のステージング到達性に依存してしまい、`waitUntil: 'networkidle'` が
 * 到達しない(#685実装ノードで実際に発生・原因特定済み)。空応答で即終わらせる。
 */
async function stubUnrelatedApis(page) {
  const paths = [
    '**/admin/version',
    '**/api/public/brand',
    '**/api/inbox/unanswered/count',
    '**/api/nen-members/overview',
    '**/api/accounts/health-summary',
    '**/api/ec-commerce/identity-candidates*',
    '**/api/ec-commerce/subscriptions*',
  ]
  for (const path of paths) {
    await page.route(path, (route) => route.fulfill({ status: 404, json: { success: false, error: 'not_mocked' } }))
  }
}

/*
 * `networkidle` は使わない。Next.jsの静的出力はプリフェッチ等でネットワークが
 * 完全に静まらないことがあり、Playwright公式でも非推奨とされている。
 * 実際にこの試験でも、共通レイアウトの未対象APIを個別モックしてもなお
 * `networkidle` へ到達しないことを確認済み(#685実装ノードで原因特定済み)。
 * 各テストはこの後 `expect(...).toBeVisible` で実データの出現を待つので、
 * `domcontentloaded` で十分。
 */
async function openEc(page, waitFor = 'domcontentloaded') {
  await stubUnrelatedApis(page)
  await page.route('**/api/dashboard/style*', (route) => route.fulfill({ json: { success: true, data: { style: 'ec', styleSelected: true } } }))
  await page.route('**/api/staff/me', (route) => route.fulfill({ json: {
    success: true, data: { id: 'owner-1', name: '管理者', role: 'owner', permissionKeys: [] },
  } }))
  await page.route('**/api/settings/features*', (route) => route.fulfill({ json: {
    success: true, data: { features: { ec_commerce: true }, sidebarOrder: null, sidebarItemOrder: null, parentChildMode: false, specializedFeatureKeys: [], version: 1 },
  } }))
  await page.route('**/api/auth/session', (route) => route.fulfill({
    json: {
      success: true,
      data: { id: 'owner-1', name: '管理者', role: 'owner', permissionKeys: [] },
      csrfToken: 'test-csrf',
    },
  }))
  await page.route('**/api/line-accounts/*/follower-import', (route) => route.fulfill({ json: { success: true, data: { phase: 'complete' } } }))
  await page.route('**/api/line-accounts', (route) => route.fulfill({
    json: {
      success: true,
      data: [
        {
          id: ACCOUNT_A,
          channelId: 'channel-a',
          name: '本店',
          isActive: true,
          country: 'JP',
          role: null,
          displayOrder: 0,
        },
        {
          id: ACCOUNT_B,
          channelId: 'channel-b',
          name: '支店',
          isActive: true,
          country: 'JP',
          role: null,
          displayOrder: 1,
        },
      ],
    },
  }))
  await page.addInitScript(() => {
    window.sessionStorage.setItem('lh_auth_selection_cleared', '1')
    window.localStorage.setItem('lh_selected_account', 'visual-qa-account')
  })
  await page.goto(`${BASE}/ec-commerce.html`, { waitUntil: waitFor })
  await expect(page).toHaveURL(/\/ec-commerce\.html/)
}

/* 集計の返事。件数を変えて「どのアカウントの値か」を画面の数字で見分ける。 */
function overviewFor(count) {
  return {
    success: true,
    data: {
      total: count,
      processed: count,
      identityPending: count,
      failed: count,
      skipped: 0,
      last24h: count,
      lastReceivedAt: '2026-09-09T00:00:30.000Z',
      averageDeliverySeconds: 30,
      latencySampleCount: count,
      byType: [{ eventType: 'ec.order.confirmed', label: '注文完了', count }],
    },
  }
}

function accountOf(route) {
  return new URL(route.request().url()).searchParams.get('lineAccountId')
}

/* V8の集計は「すべて」の件数と下段の「今日」。一覧由来のKPIは取得済みなら残す。 */
async function expectNoOverviewNumbers(page) {
  await expect(page.getByRole('button', { name: 'すべて', exact: true })).toBeVisible()
  await expect(page.getByText(/今日 —件/)).toBeVisible()
}

const overviewNumbers = (page, count) => page.getByRole('button', { name: `すべて ${count}`, exact: true })

async function switchAccount(page, accountId) {
  await page.getByRole('button', { name: 'アカウントを切り替える', exact: true }).click()
  await page.getByRole('menu', { name: 'LINEアカウントの切り替え', exact: true })
    .getByRole('menuitemradio', { name: accountId === ACCOUNT_A ? '本店' : '支店', exact: true }).click()
}

test('21件目の商品、未知種別、サーバ検索を実際の画面操作で確認する', async ({ page }) => {
  const requestUrls = []
  await page.route('**/api/ec-commerce/overview*', (route) => route.fulfill({ json: overview }))
  await page.route('**/api/ec-commerce/events*', (route) => {
    const url = new URL(route.request().url())
    requestUrls.push(url.toString())
    const searched = url.searchParams.get('query') === '商品21'
    const secondPage = url.searchParams.get('offset') === '20'
    const item = searched || secondPage ? record(21, 'ec.partner.custom_event') : record(1)
    return route.fulfill({
      json: { success: true, data: { items: [item], total: searched ? 1 : 21, summary } },
    })
  })

  await openEc(page)
  await expect(page.getByText('商品1 × 1')).toBeVisible()
  await page.getByRole('button', { name: '次のページ' }).click()
  await expect(page.getByText('商品21 × 1')).toBeVisible()
  // V8では区切り記号を置かず、同じ行の最初のセルに出来事の生キーを出す。
  const row21 = page.locator('tr').filter({ hasText: '商品21 × 1' })
  await expect(row21.getByRole('cell').first().getByText('ec.partner.custom_event', { exact: true })).toBeVisible()
  await expect(page.getByText('ECの出来事', { exact: true })).toHaveCount(0)

  await page.getByRole('searchbox', { name: '取り込みの記録を探す' }).fill('商品21')
  await expect.poll(() => requestUrls.some((url) => new URL(url).searchParams.get('query') === '商品21')).toBe(true)
  await expect(page.getByText('商品21 × 1')).toBeVisible()
})

test('集計だけ失敗しても一覧を残し、画面の再読み込み操作で集計を戻す', async ({ page }) => {
  let overviewFails = true
  await page.route('**/api/ec-commerce/overview*', (route) => {
    if (overviewFails) {
      return route.fulfill({ status: 500, json: { success: false, error: '集計に失敗' } })
    }
    return route.fulfill({ json: overview })
  })
  await page.route('**/api/ec-commerce/events*', (route) => route.fulfill({
    json: { success: true, data: { items: [record(1)], total: 1, summary } },
  }))

  await openEc(page)
  await expect(page.getByText('商品1 × 1')).toBeVisible()
  await expect(page.getByText('集計だけを読み込めませんでした。一覧は取得できた範囲で表示しています。')).toBeVisible()
  await expectNoOverviewNumbers(page)
  // 同時要求の共有数によらず、再読み込みを押す前にAPIを回復させる。
  overviewFails = false
  await page.getByRole('button', { name: '集計をもう一度読む' }).click()
  await expect(overviewNumbers(page, 21)).toBeVisible()
  await expect(page.getByText(/今日 21件/)).toBeVisible()
  await expect(page.getByText('商品1 × 1')).toBeVisible()
  await expect(page.getByText('集計だけを読み込めませんでした。一覧は取得できた範囲で表示しています。')).toHaveCount(0)
})

/*
 * 差し戻し(2026-09-09): アカウントAで集計111件を出したあとBへ切り替え、Bの集計が
 * 500になると、Aの111件がBの数字として残っていた。切替の時点で消えることを見る。
 */
test('アカウントを切り替えて集計が500になっても、前のアカウントの数字を残さない', async ({ page }) => {
  let overviewFailsForB = true
  await page.route('**/api/ec-commerce/overview*', (route) => {
    if (accountOf(route) === ACCOUNT_A) return route.fulfill({ json: overviewFor(111) })
    return overviewFailsForB
      ? route.fulfill({ status: 500, json: { success: false, error: '集計に失敗' } })
      : route.fulfill({ json: overviewFor(7) })
  })
  await page.route('**/api/ec-commerce/events*', (route) => route.fulfill({
    json: {
      success: true,
      data: {
        items: [record(accountOf(route) === ACCOUNT_A ? 1 : 77)],
        total: 1,
        summary,
      },
    },
  }))

  await openEc(page)
  await expect(overviewNumbers(page, 111)).toBeVisible()
  await expect(page.getByText('商品1 × 1')).toBeVisible()

  await switchAccount(page, ACCOUNT_B)
  await expect(page.getByText('集計だけを読み込めませんでした。一覧は取得できた範囲で表示しています。')).toBeVisible()
  await expect(overviewNumbers(page, 111)).toHaveCount(0)
  await expectNoOverviewNumbers(page)
  /* 一覧はBの取得ぶんへ入れ替わっている。 */
  await expect(page.getByText('商品77 × 1')).toBeVisible()
  await expect(page.getByText('商品1 × 1')).toHaveCount(0)

  /* 取得済みの値を残してよいのは、同じアカウントの取り直しだけ。 */
  overviewFailsForB = false
  await page.getByRole('button', { name: '集計をもう一度読む' }).click()
  await expect(overviewNumbers(page, 7)).toBeVisible()
  await expect(overviewNumbers(page, 111)).toHaveCount(0)
})

test('アカウントを切り替えて集計が403になっても、前のアカウントの数字を残さない', async ({ page }) => {
  await page.route('**/api/ec-commerce/overview*', (route) => (
    accountOf(route) === ACCOUNT_A
      ? route.fulfill({ json: overviewFor(111) })
      : route.fulfill({ status: 403, json: { success: false, error: 'forbidden' } })
  ))
  await page.route('**/api/ec-commerce/events*', (route) => route.fulfill({
    json: {
      success: true,
      data: {
        items: [record(accountOf(route) === ACCOUNT_A ? 1 : 77)],
        total: 1,
        summary,
      },
    },
  }))

  await openEc(page)
  await expect(overviewNumbers(page, 111)).toBeVisible()

  await switchAccount(page, ACCOUNT_B)
  await expect(page.getByRole('status').filter({ hasText: 'この操作の権限がありません。オーナーか管理者に頼んでください。' })).toBeVisible()
  await expect(overviewNumbers(page, 111)).toHaveCount(0)
  await expectNoOverviewNumbers(page)
  /* 権限が無いので取り直しは出さない。 */
  await expect(page.getByRole('button', { name: '集計をもう一度読む' })).toHaveCount(0)
  await expect(page.getByText('商品77 × 1')).toBeVisible()
})

test('切替後に届いた前のアカウントの遅い返事を、新しいアカウントの値にしない', async ({ page }) => {
  await page.route('**/api/ec-commerce/overview*', async (route) => {
    if (accountOf(route) !== ACCOUNT_A) return route.fulfill({ json: overviewFor(7) })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    return route.fulfill({ json: overviewFor(111) })
  })
  await page.route('**/api/ec-commerce/events*', async (route) => {
    if (accountOf(route) !== ACCOUNT_A) {
      return route.fulfill({ json: { success: true, data: { items: [record(77)], total: 1, summary } } })
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
    return route.fulfill({ json: { success: true, data: { items: [record(1)], total: 1, summary } } })
  })

  await openEc(page)
  /* Aの返事はまだ届いていない。 */
  await expect(page.getByRole('button', { name: 'アカウントを切り替える', exact: true })).toBeVisible()
  await expect(overviewNumbers(page, 111)).toHaveCount(0)

  await switchAccount(page, ACCOUNT_B)
  await expect(overviewNumbers(page, 7)).toBeVisible()
  await expect(page.getByText('商品77 × 1')).toBeVisible()

  /* Aの遅い返事が届いたあとも、Bの値のまま。 */
  await page.waitForTimeout(4000)
  await expect(overviewNumbers(page, 111)).toHaveCount(0)
  await expect(page.getByText('商品1 × 1')).toHaveCount(0)
  await expect(overviewNumbers(page, 7)).toBeVisible()
  await expect(page.getByText('商品77 × 1')).toBeVisible()
})

/*
 * 差し戻し(2026-09-09 2回目): Aで再試行を始め、応答が返る前にBへ切り替えると、
 * retryが抱えたA向けのloadRecords(false)が共有listLoadSeqを進め、Bの正常な
 * 一覧応答をseq不一致で捨てていた。Bは読み込み中のまま固まる。
 * accountIdRefで古いクロージャの呼び出しを共有seqへ触れる前に止めることを見る。
 */
test('Aで再試行の応答を待つ間にBへ切り替えても、Bの一覧が読み込み中のまま固まらない', async ({ page }) => {
  const failedRecord = {
    ...record(1),
    status: 'retryable_failed',
    retryAvailable: true,
    version: 1,
    attemptCount: 1,
    errorMessage: '送信に失敗しました',
  }
  let retryRequested = false
  let retryResolved = false
  let releaseRetry
  const retryGate = new Promise((resolve) => { releaseRetry = resolve })

  await page.route('**/api/ec-commerce/overview*', (route) => (
    accountOf(route) === ACCOUNT_A ? route.fulfill({ json: overviewFor(111) }) : route.fulfill({ json: overviewFor(7) })
  ))
  await page.route('**/api/ec-commerce/events*', (route) => (
    accountOf(route) === ACCOUNT_A
      ? route.fulfill({ json: { success: true, data: { items: [failedRecord], total: 1, summary } } })
      : route.fulfill({ json: { success: true, data: { items: [record(77)], total: 1, summary } } })
  ))
  await page.route('**/api/ec-commerce/action-executions/*/retry', async (route) => {
    retryRequested = true
    /* Bへ切り替わったあとに届く、遅いAの再試行応答を模す。 */
    await retryGate
    retryResolved = true
    return route.fulfill({
      json: { success: true, data: { ...failedRecord, status: 'pending', retryAvailable: false, version: 2 } },
    })
  })

  await openEc(page)
  await expect(overviewNumbers(page, 111)).toBeVisible()
  // #641: 「もう一度やる」は行の「・・・」メニューの中にある
  await page.getByRole('button', { name: 'この行のその他操作' }).click()
  await page.getByRole('menuitem', { name: 'もう一度やる' }).click()
  await expect.poll(() => retryRequested).toBe(true)
  /* : 操作名はそのまま、処理中は押せないことを確かめる。 */
  await expect(page.getByRole('menu')).toBeHidden()
  await page.getByRole('button', { name: 'この行のその他操作' }).click()
  await expect(page.getByRole('menuitem', { name: 'もう一度やる' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'もう一度やる' })).toBeDisabled()
  await page.keyboard.press('Escape')

  /* Aの再試行応答(2秒後)が届く前にBへ切り替える。 */
  await switchAccount(page, ACCOUNT_B)
  /* Bの一覧・集計は遅延なしで返るので、読み込み中で固まらず短時間で表示されるはず。 */
  await expect(page.getByText('商品77 × 1')).toBeVisible({ timeout: 1500 })
  await expect(overviewNumbers(page, 7)).toBeVisible({ timeout: 1500 })
  await expect(page.getByText('取り込みの記録を読み込めませんでした')).toHaveCount(0)

  /* Aの遅い再試行応答が届いたあとも、Bの表示は崩れない。 */
  releaseRetry()
  await expect.poll(() => retryResolved).toBe(true)
  await expect(page.getByText('商品77 × 1')).toBeVisible()
  await expect(overviewNumbers(page, 7)).toBeVisible()
  await expect(overviewNumbers(page, 111)).toHaveCount(0)
  await expect(page.getByText('商品1 × 1')).toHaveCount(0)
})
