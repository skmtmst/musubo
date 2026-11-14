/*
 * V8 の画面の見張り（layout-overflow・shots）で共通に使う、ブラウザの準備。
 *
 * - 画面確認用のモックAPI（scripts/visual-qa/mock-api.mjs）に向けて書き出した
 *   `out` を開く前提。ログインと選択中アカウントは localStorage で与える
 * - 見た目は現在のV8固定。ブラウザの保存値で選ばない。
 * - 撮影を毎回同じ絵にするため、時計を固定し、動きを止め、カーソルの点滅を消す。
 *   同じ版を2回撮って差が出たのを確かめてから入れた（2026-10-01、時刻表示と動きの途中）
 */
export const ROUTES = {
  dashboard: '/',
  friends: '/friends',
  'friend-detail': '/friends/detail?id=friend-1',
  'scenario-detail': '/scenarios/detail?id=scenario-0-paused',
  inbox: '/chats',
  'broadcast-new': '/broadcasts/new',
  'broadcast-audience': '/broadcasts/new?step=audience',
  'broadcast-message': '/broadcasts/new?step=message',
  'broadcast-schedule': '/broadcasts/new?step=schedule',
  'broadcast-confirm': '/broadcasts/new?step=confirm',
  booking: '/booking/bookings',
  conversions: '/affiliates?tab=points',
  login: '/login',
  'hq-attention': '/hq/attention',
}

/** iPad 横（1024px）まで崩れないことを見張る。 */
export const WIDTHS = [1024, 1152, 1440, 1920]

/*
 * 電話の専用の画面（/m）だけを電話の幅で見る。全機能の管理画面（ROUTES）は 390 で点検しない決まりのまま。
 * ROUTES に /m を入れない・MOBILE_ROUTES に PC の住所を入れない（layout-overflow.test.mjs が守る）。
 */
export const MOBILE_ROUTES = {
  'mobile-talk': '/m/chats',
  'mobile-thread': '/m/chats?friend=friend-1',
  'mobile-todo': '/m/todo',
}

/** iPhone の 390×844 と 430×932。 */
export const MOBILE_VIEWPORTS = [{ width: 390, height: 844 }, { width: 430, height: 932 }]

const SESSION = {
  lh_csrf: 'visual-qa-csrf',
  lh_staff_role: 'owner',
  lh_staff_name: 'K',
  lh_staff_permissions: '[]',
  lh_staff_view_permissions: '[]',
  lh_selected_account: 'visual-qa-account',
}

export async function openPage(browser, { baseUrl, route, width, height = 900, mobile = false, stable = false, settleMs = 2500, onPageError, requireSuccess = false }) {
  const page = await browser.newPage({
    viewport: { width, height },
    // 電話の画面は指で触る端末として開く（押せる所 44px・入力欄 16px の決まりが効く形）。
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
    ...(stable ? { reducedMotion: 'reduce' } : {}),
  })
  try {
    if (process.env.V8_GUARD_STUB_API === '1') {
      const { stubApi } = await import('./speed-budget.mjs')
      const { mockFetch } = await import('./mock-local.mjs')
      await stubApi(page, mockFetch)
    }
    if (onPageError) page.on('pageerror', onPageError)
    if (stable) await page.clock.setFixedTime(new Date('2026-10-01T05:00:00Z'))
    await page.addInitScript((session) => {
      for (const [k, v] of Object.entries(session)) localStorage.setItem(k, v)
      localStorage.setItem('lh_auth_selection_cleared', '1')
    }, SESSION)
    const response = await page.goto(new URL(route, baseUrl).toString())
    if (requireSuccess && (!response || !response.ok())) throw new Error(`指定画面のHTTP応答が正常ではありません: ${response?.status() ?? 'なし'}`)
    if (stable) {
      await page.addStyleTag({
        /*
         * タブ帯の「続きがある」ぼかし（`data-scroll-hint`・`data-tab-fade`）は、
         * はみ出しの実測で出る・出ないが決まる。タブ名の幅が書体で1px前後
         * するため、撮る時刻で出たり出なかったりし、管理画面 友だち詳細の右上だけ
         * 違う誤検知になっていた（c-base/c-head）。飾りで判定に要らないので
         * 比較撮影では隠す。はみ出し自体の見張りは layout-overflow が担う。
         */
        content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}[data-scroll-hint],[data-tab-fade]{display:none!important}',
      })
    }
    await page.waitForTimeout(settleMs)
    // Webフォントの読み込み待ち。来る前と来た後で文字の濃さが変わり、
    // 画素比べがぶれる（管理画面 友だち詳細の右上の「マイ」など時々違う）。
    try {
      await page.evaluate(() => document.fonts.ready.then(() => true))
    } catch {
      /* フォントなし環境では待たない */
    }
    return page
  } catch (error) {
    await page.close()
    throw error
  }
}
