/** A dedicated fixture API keeps browser suites independent of other worktrees. */
const CLOSE_SETTLE_MS = 500
const CLOSE_POLL_MS = 50

export async function routeLocalApi({ page }) {
  const mock = process.env.VISUAL_QA_MOCK
  if (!mock) return
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    try {
      await route.fulfill({ response: await route.fetch({ url: `${mock}${url.pathname}${url.search}` }) })
    } catch (error) {
      // 画面の確認が終わった後も続く背景の取得は、ページが閉じると応答が破棄される。
      // その取り違えで撮影を失敗にしないよう、ページが実際に閉じている場合の破棄だけ無視する。
      // ページが開いているのに disposed 系のメッセージが出た場合は、本当の異常なので再送出する。
      // 閉じる直前の破棄では isClosed() がまだ false のことがあるため、短い間だけ閉鎖の確定を待つ。
      const message = error instanceof Error ? error.message : String(error)
      if (/^route\.fetch: Test ended\.(?:\r?\n|$)/.test(message)) return
      const disposedLike = /disposed|Target (page|closed)|has been closed|Request context disposed/i.test(message)
      if (!disposedLike) throw error
      for (let waited = 0; !page.isClosed() && waited < CLOSE_SETTLE_MS; waited += CLOSE_POLL_MS) {
        await new Promise(resolve => setTimeout(resolve, CLOSE_POLL_MS))
      }
      if (!page.isClosed()) throw error
    }
  })
}
