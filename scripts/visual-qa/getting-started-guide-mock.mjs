/*
  開店準備ガイドの進み具合（撮影用）。

  本物は staff×LINEアカウントでD1に1件持ち、GET/PUT /api/getting-started/guide で
  { phase, stepKey, procedureIndex, updatedAt } の器を返す（apps/worker の
  getting-started.ts）。撮影用はこの場の控えだけに持ち、同じ器を返す。

  この口が無いと GET が一覧の既定（items 0件）で success を返し、
  画面側が毎回 idle にしてガイドが進まない。PUT を返さないと進行が取り消される。
*/

const GUIDE_STATE = new Map()
const DEFAULT_KEY = 'visual-qa-account'
/* 時刻は固定。毎回同じ絵になるようにする（このファイルの約束）。 */
const SAVED_AT = '2026-11-15T09:00:00.000Z'

function keyOf(accountId) {
  return accountId || DEFAULT_KEY
}

/** まだ始めていない時は本物と同じ既定を返す。 */
export function gettingStartedGuideState(accountId) {
  return GUIDE_STATE.get(keyOf(accountId)) ?? { phase: 'idle', stepKey: null, procedureIndex: 1, updatedAt: null }
}

/** 送られた値をそのまま控えに置き、本物と同じ形で返す。 */
export function gettingStartedGuideSave(accountId, body) {
  const next = {
    phase: typeof body?.phase === 'string' ? body.phase : 'idle',
    stepKey: typeof body?.stepKey === 'string' ? body.stepKey : null,
    procedureIndex: Number.isInteger(body?.procedureIndex) && body.procedureIndex >= 1 ? body.procedureIndex : 1,
    updatedAt: SAVED_AT,
  }
  GUIDE_STATE.set(keyOf(accountId), next)
  return next
}

/** 読み取りの口。当てはまらない時は null を返して他の口に譲る。 */
export function gettingStartedGuideRead(method, pathname, query) {
  if (method !== 'GET' || pathname !== '/api/getting-started/guide') return null
  return { success: true, data: gettingStartedGuideState(query?.get('accountId')) }
}

/**
 * 保存の口。受け持った時だけ true を返す（応答はこの中で終える）。
 * ガイドだけはこの場の控えに書く。保存できないと画面側が進行を取り消す。
 */
export function gettingStartedGuideWrite(method, url, req, res) {
  if (method !== 'PUT' || url.pathname !== '/api/getting-started/guide') return false
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    let parsed = null
    try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = null }
    res.writeHead(200).end(
      JSON.stringify({ success: true, data: gettingStartedGuideSave(url.searchParams.get('accountId'), parsed) }),
    )
  })
  return true
}
