/** A dedicated fixture API keeps browser suites independent of other worktrees. */
export async function routeLocalApi({ page }) {
  const mock = process.env.VISUAL_QA_MOCK
  if (!mock) return
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    try {
      await route.fulfill({ response: await route.fetch({ url: `${mock}${url.pathname}${url.search}` }) })
    } catch (error) {
      // 画面の確認が終わった後も続く背景の取得は、ページが閉じると応答が破棄される。
      // その取り違えで撮影を失敗にしないよう、閉じた後の破棄だけ無視する。
      const message = error instanceof Error ? error.message : String(error)
      const closed = /disposed|Target (page|closed)|has been closed|Request context disposed/i.test(message)
      if (!closed) throw error
    }
  })
}
