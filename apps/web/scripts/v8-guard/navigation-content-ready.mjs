export function trackPendingApiRequests(page) {
  const pending = new Set()
  // 保存するのは path のみ。破棄された文書の未完了要求を診断に残す。
  const orphans = []
  Object.defineProperty(pending, 'orphans', { value: orphans })
  let navigation = null, documentOrigin = null
  const bounded = (check, onTimeout) => new Promise(resolve => {
    const timer = setTimeout(() => { onTimeout(); resolve() }, 1000)
    void check.finally(() => { clearTimeout(timer); resolve() })
  })
  // 読み込み済みの文書で追跡を始めた場合にも、移動前の文書を識別する。
  let initialExpired = false
  let documentChecks = bounded(page.mainFrame().evaluate(() => performance.timeOrigin).then(origin => {
    if (!initialExpired && documentOrigin === null && navigation === null) documentOrigin = origin
  }).catch(() => {}), () => { initialExpired = true })
  const goto = page.goto.bind(page)
  page.goto = async (...args) => {
    // 前の文書の識別を済ませてから次の遷移を始める。
    await documentChecks
    const response = await goto(...args)
    await documentChecks
    return response
  }
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      const previous = request.redirectedFrom()
      const snapshot = previous && navigation?.request === previous ? navigation.snapshot : new Set(pending)
      navigation = { request, snapshot, responseUrl: null }
    }
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      pending.add(request)
      // 新しい文書の応答前は、まだ前の文書からの要求である。
      if (navigation && !navigation.responseUrl) navigation.snapshot.add(request)
    }
  })
  page.on('response', response => {
    if (navigation?.request !== response.request()) return
    // リダイレクトは最終的な文書の response まで待つ。
    if (response.status() >= 300 && response.status() < 400) return
    navigation.responseUrl = response.url()
  })
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return
    const candidate = navigation, frameUrl = frame.url(), previousOrigin = documentOrigin
    // 確認が終わるまで時刻は不明扱いにする。古い時刻で同一文書を誤判定しない。
    documentOrigin = null
    const url = value => { const parsed = new URL(value); parsed.hash = ''; return parsed.href }
    const responseMatches = candidate?.responseUrl && url(frameUrl) === url(candidate.responseUrl)
    // URL の一致はイベント時点で確かめる。直後の replaceState は文書の変更ではない。
    let expired = false
    const check = frame.evaluate(() => performance.timeOrigin).then(origin => {
      if (expired || navigation !== candidate) return
      documentOrigin = origin
      if (!responseMatches || previousOrigin === null || origin === previousOrigin) return
      // 移動先の応答後に始まった API は安全側で待ち続ける。
      for (const request of candidate.snapshot) {
        if (pending.delete(request)) {
          const path = new URL(request.url()).pathname
          orphans.push({ path, reason: 'previous-document' })
          console.log(`[v8-guard] 前の文書の未完了要求: ${path}`)
        }
      }
      navigation = null
    }).catch(() => { console.log('[v8-guard] 文書を識別できません。未完了要求を保持します。') })
    // 識別できなければ要求を残して従来どおり失敗させる。照会の停止で遷移を無期限に止めない。
    documentChecks = Promise.all([documentChecks, bounded(check, () => {
      expired = true
      documentOrigin = null
      console.log('[v8-guard] 文書識別の時間切れ。未完了要求を保持します。')
    })]).then(() => {})
  })
  page.on('requestfinished', request => pending.delete(request))
  page.on('requestfailed', request => {
    pending.delete(request)
    if (navigation?.request === request) navigation = null
  })
  return pending
}

export async function waitForNavigationContent(page, pending, timeout = 5000) {
  const start = Date.now()
  let readySince = null, state
  while (Date.now() - start < timeout) {
    state = await page.evaluate(() => {
      const main = document.querySelector('main')
      return {
        text: Boolean(main?.innerText.trim()),
        busy: Boolean(main && [...main.querySelectorAll('[aria-busy="true"]')]
          .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')),
      }
    })
    if (state.text && !state.busy && pending.size === 0) {
      readySince ??= Date.now()
      // 親の応答後に子が問い合わせを始める時間も見張る。
      if (Date.now() - readySince >= 200) return
    } else readySince = null
    await page.waitForTimeout(50)
  }
  const paths = [...pending].slice(0, 3).map(request => new URL(request.url()).pathname)
  throw new Error(`本文の準備が終わりません: text=${state?.text} busy=${state?.busy} pendingApi=${pending.size} paths=${JSON.stringify(paths)}`)
}
