import { expect, type Page, type Route, test } from '@playwright/test'

const BASE = process.env.WEBHOOK_RUNTIME_BASE ?? 'http://127.0.0.1:3101'

type ToggleResponse = { success: true; data: Record<string, never> } | { success: false; error: string }
type PendingUpdate = { id: string; respond: (body: ToggleResponse) => void }

async function prepareSession(page: Page) {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('lh_auth_selection_cleared', '1')
    window.localStorage.setItem('lh_selected_account', 'visual-qa-account')
  })
}

/*
  `route.fetch` はテスト側からモックAPIへ別途TCPを張る。稀に ECONNRESET の
  ような一時切断で、画面とは無関係に契約試験が落ちる（#826）。

  HTTP応答（4xx/5xx）やJSONの形は従来どおり失敗させたまま、**接続が張れ
  なかった場合だけ**上限3回まで取り直す。応答を握り替えたりHTTPエラーを
  隠したりしない。
*/
const TRANSIENT_FETCH_ERRORS = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED']

async function fetchWithTransientRetry(route: Route, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await route.fetch()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const transient = TRANSIENT_FETCH_ERRORS.some((code) => message.includes(code))
      if (!transient || attempt === maxAttempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('unreachable')
}

async function provideSecondAccount(page: Page) {
  await page.route((url) => url.pathname === '/api/line-accounts', async (route) => {
    const response = await fetchWithTransientRetry(route)
    const body = await response.json() as { success: boolean; data: Array<Record<string, unknown>> }
    const first = body.data[0]
    await route.fulfill({
      response,
      json: {
        ...body,
        data: [
          first,
          { ...first, id: 'visual-qa-account-2', channelId: '0000000001', name: '画面確認アカウント2', displayName: '画面確認アカウント2' },
        ],
      },
    })
  })
}

async function openWebhooks(page: Page, path = '/webhooks?tab=outgoing') {
  await prepareSession(page)
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  await expect(page).toHaveURL(new RegExp(`${path.split('?')[0].replace('/', '\\/')}`))
}

async function holdOutgoingUpdates(page: Page): Promise<PendingUpdate[]> {
  const pending: PendingUpdate[] = []
  await page.route('**/api/webhooks/outgoing/*', async (route: Route) => {
    const request = route.request()
    if (request.method() !== 'PUT') {
      await route.continue()
      return
    }
    const id = new URL(request.url()).pathname.split('/').at(-1) ?? ''
    const body = await new Promise<ToggleResponse>((resolve) => {
      pending.push({ id, respond: resolve })
    })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })
  return pending
}

async function openRowMenu(page: Page, name: string) {
  const row = page.getByRole('row').filter({ hasText: name })
  // V8 の狭い幅では「…」、広い幅では「設定」。メニューは portal で行の外に出る。
  await row.getByRole('button', { name: new RegExp(`「${name}」の(設定|操作)`) }).click()
  return page.getByRole('menu', { name: new RegExp(`「${name}」の(設定|操作)`) })
}

async function toggleRow(page: Page, name: string) {
  const menu = await openRowMenu(page, name)
  await menu.getByRole('menuitem', { name: '止める', exact: true }).click()
}

async function switchAccount(page: Page) {
  await page.getByRole('button', { name: 'アカウントを切り替える', exact: true }).click()
  await page.getByRole('menu', { name: 'LINEアカウントの切り替え', exact: true })
    .getByRole('menuitemradio', { name: '画面確認アカウント2', exact: true }).click()
  await expect(page.getByRole('banner')).toContainText('画面確認アカウント2')
}

const failureNotice = (page: Page) => page.getByRole('status', { name: '知らせ', exact: true })
  .locator('[data-toast]').filter({ hasText: 'Googleスプレッドシート ／ 顧客台帳' })

function updateById(pending: PendingUpdate[], id: string): PendingUpdate {
  const update = pending.find((item) => item.id === id)
  if (!update) throw new Error(`${id} の更新要求がありません`)
  return update
}

test('見本リンクの選択を初回読込後も保ち、実アカウント切替時だけ消す', async ({ page }) => {
  await provideSecondAccount(page)
  await openWebhooks(page, '/webhooks?tab=incoming&source=booking')
  const dialog = page.getByRole('dialog', { name: '受け取る設定を追加', exact: true })
  await expect(dialog.getByRole('button', { name: 'どこから来るか', exact: true })).toContainText('予約サービス')
  await dialog.getByRole('textbox', { name: '名前', exact: true }).fill('切替前の下書き')
  await dialog.getByRole('textbox', { name: 'シークレット', exact: true }).fill('a'.repeat(32))

  // V8 はモーダルなので、背面のヘッダーを操作する前に窓を閉じる。
  // 開いたままの実アカウント切替は webhooks.test.tsx でも守る。
  await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
  await page.getByRole('dialog', { name: '入力を破棄しますか？', exact: true })
    .getByRole('button', { name: '破棄する', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(url => !url.searchParams.has('source'))
  await switchAccount(page)
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '受け取り口を作る', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'どこから来るか', exact: true })).toContainText('LINE公式アカウント')
  await expect(dialog.getByRole('textbox', { name: '名前', exact: true })).toHaveValue('')
  // V8 はアカウント切替後に窓を開くと新しい鍵を作る。前の店の鍵を引き継がない。
  const secret = dialog.getByRole('textbox', { name: 'シークレット', exact: true })
  await expect(secret).not.toHaveValue('a'.repeat(32))
  await expect(secret).toHaveValue(/^[a-f0-9]{32,}$/)
})

test('同じ行を続けて操作しても更新は1回だけ送る', async ({ page }) => {
  const pending = await holdOutgoingUpdates(page)
  await openWebhooks(page)
  const name = 'Googleスプレッドシート ／ 顧客台帳'
  await toggleRow(page, name)
  await expect.poll(() => pending.length).toBe(1)
  await expect(page.getByRole('row').filter({ hasText: name })).toContainText('切り替え中')

  // V8 は押すとメニューを閉じる。再度開いて操作し、二重送信防止を実際に通す。
  // 押せなくして1要求になっただけでは合格にしない。
  const menu = await openRowMenu(page, name)
  const toggle = menu.getByRole('menuitem', { name: '動かす', exact: true })
  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(page.getByRole('status', { name: '知らせ', exact: true }))
    .toContainText('返事が来るまでお待ちください')
  expect(pending).toHaveLength(1)

  const reloaded = page.waitForResponse((response) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/webhooks/outgoing',
  )
  pending[0].respond({ success: true, data: {} })
  await reloaded
  await expect(page.getByRole('row').filter({ hasText: name })).not.toContainText('切り替え中')
  await expect(page.getByRole('status', { name: '知らせ', exact: true }).getByRole('button', { name: '元に戻す' })).toHaveCount(0)
})

for (const order of ['failure-first', 'success-first'] as const) {
  test(`別行の失敗案内を別行の成功で消さない（${order}）`, async ({ page }) => {
    const pending = await holdOutgoingUpdates(page)
    await openWebhooks(page)
    await toggleRow(page, 'Slack ／ #注文チャンネル')
    await toggleRow(page, 'Googleスプレッドシート ／ 顧客台帳')
    await expect.poll(() => pending.length).toBe(2)

    const failed = updateById(pending, 'owh-sheets')
    const succeeded = updateById(pending, 'owh-slack-order')
    const failureAlert = failureNotice(page)

    if (order === 'failure-first') {
      failed.respond({ success: false, error: 'テスト用の失敗' })
      await expect(failureAlert).toContainText('状態は変わっていません')
    }

    const reloaded = page.waitForResponse((response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/webhooks/outgoing',
    )
    succeeded.respond({ success: true, data: {} })
    await reloaded

    if (order === 'success-first') {
      failed.respond({ success: false, error: 'テスト用の失敗' })
    }
    await expect(failureAlert).toContainText('Googleスプレッドシート ／ 顧客台帳')
    await expect(failureAlert).toContainText('もう一度お試しください')
  })
}

test('アカウント切替前の遅い失敗応答を切替後の画面へ出さない', async ({ page }) => {
  await provideSecondAccount(page)
  const pending = await holdOutgoingUpdates(page)
  await openWebhooks(page)
  await toggleRow(page, 'Googleスプレッドシート ／ 顧客台帳')
  await expect.poll(() => pending.length).toBe(1)

  await switchAccount(page)
  const replied = page.waitForResponse((response) => response.request().method() === 'PUT')
  pending[0].respond({ success: false, error: '切替前の遅い失敗' })
  await replied
  await page.waitForTimeout(100)
  await expect(failureNotice(page)).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: 'Googleスプレッドシート ／ 顧客台帳' })).not.toContainText('切り替え中')
})

for (const role of ['admin', 'staff'] as const) {
  test(`${role} は現在の役割で許可された操作だけを使える`, async ({ page }) => {
    const changes: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/webhooks/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) changes.push(request.method())
    })
    await page.route('**/api/staff/me', (route) => route.fulfill({ json: { success: true, data: { id: 'staff-test', role, permissionKeys: [], permissionViewKeys: ['/webhooks'] } } }))
    await openWebhooks(page)
    const name = 'Googleスプレッドシート ／ 顧客台帳'
    if (role === 'admin') {
      await expect(page.getByRole('link', { name: '送り先を作る', exact: true })).toBeVisible()
      const menu = await openRowMenu(page, name)
      for (const action of ['止める', '編集する', '試しに送る']) {
        await expect(menu.getByRole('menuitem', { name: action, exact: true })).toBeEnabled()
      }
      for (const action of ['鍵を作り直す', '削除する']) {
        await expect(menu.getByRole('menuitem', { name: action, exact: true })).toBeDisabled()
      }
    } else {
      await expect(page.getByText('この画面の変える操作は、オーナーか管理者だけができます。', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '送り先を作る', exact: true })).toBeDisabled()
      const menu = await openRowMenu(page, name)
      for (const action of ['止める', '編集する', '鍵を作り直す', '削除する']) {
        await expect(menu.getByRole('menuitem', { name: action, exact: true })).toBeDisabled()
      }
      await expect(menu.getByRole('menuitem', { name: '試しに送る', exact: true })).toHaveCount(0)
    }
    expect(changes).toEqual([])
  })
}

test('権限不足で切替が断られたら、元の状態と理由を出す', async ({ page }) => {
  await page.route('**/api/webhooks/outgoing/*', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    await route.fulfill({ status: 403, json: { success: false, error: 'Forbidden' } })
  })
  await openWebhooks(page)
  const name = 'Googleスプレッドシート ／ 顧客台帳'
  await toggleRow(page, name)
  await expect(page.getByRole('status', { name: '知らせ', exact: true }))
    .toContainText('この操作の権限がありません。オーナーか管理者に頼んでください。')
  // 広い幅では状態の同じセルに最終日時も出る。
  await expect(page.getByRole('row').filter({ hasText: name }).getByRole('cell', { name: /^有効(?:\s|$)/ })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: name })).not.toContainText('切り替え中')
})
