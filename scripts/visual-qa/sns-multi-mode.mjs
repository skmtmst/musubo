/*
 * 設定›SNS連携を「2件つないだ状態」で見るための見本。
 *
 * `VISUAL_QA_SNS_MULTI=1` のときだけ mock-api.mjs がこの行を返す。既定の撮影
 * （絵との照合）は何も変わらない。既定では Google は1件、Instagram は未接続の
 * まま（絵の「まだつないでいません」）。
 *
 * 実データ・秘密値は持たない。合鍵（トークン）の列は画面の口に無いので、ここにも
 * 置かない。乱数も時刻も使わず、毎回まったく同じものを返す。
 */
import { GOOGLE_CONNECTION, GOOGLE_CONNECTION_DATA, GOOGLE_STORE } from './google-hours-profile-fixture.mjs'

export const SNS_MULTI_CONNECTIONS = process.env.VISUAL_QA_SNS_MULTI === '1'

/* `VISUAL_QA_SNS_EXPIRED=1` のときだけ、2行目を「接続の異常」にして
   行の中の［つなぎ直す］を見る（絵の F1 の2行目と同じ並び）。 */
const EXPIRED_SECOND_ROW = process.env.VISUAL_QA_SNS_EXPIRED === '1'

/* Google ビジネス：1行目は既定の1件ぶんと同じ店舗、2行目は別の場所。
   並びは画面と同じ（主連携が先、次に並び順）。 */
export const GOOGLE_CONNECTION_ROWS = [
  { id: 'gc-1', confirmationRevision: 1, ...GOOGLE_CONNECTION },
  {
    id: 'gc-2',
    confirmationRevision: 1,
    status: 'connected',
    googleAccountEmail: 'shop@example.com',
    locationName: 'locations/sample-shop-b',
    locationTitle: '見本 B店',
    locationMapsUrl: 'https://maps.google.com/?cid=sample-shop-b',
    connectedAt: '2026-10-05T11:30:00+09:00',
    disconnectedAt: null,
    lastSyncedAt: '2026-10-02T08:00:00+09:00',
    lastSyncError: null,
    averageRating: 4.5,
    totalReviewCount: 12,
  },
]

/* Instagram：2件とも接続済み。 */
export const INSTAGRAM_CONNECTION_ROWS = [
  {
    id: 'igc-1',
    state: 'connected',
    pageId: '100000000000001',
    instagramId: '170000000000001',
    pageName: '見本 A店',
    username: '見本 A店',
    expiresAt: '2027-01-10T10:20:00+09:00',
    dataAccessExpiresAt: '2027-01-10T10:20:00+09:00',
    version: 1,
    syncedAt: '2026-10-02T08:00:00+09:00',
  },
  {
    id: 'igc-2',
    state: EXPIRED_SECOND_ROW ? 'expired' : 'connected',
    pageId: '100000000000002',
    instagramId: '170000000000002',
    pageName: '見本 B店',
    username: '見本 B店',
    expiresAt: '2027-01-12T11:30:00+09:00',
    dataAccessExpiresAt: '2027-01-12T11:30:00+09:00',
    version: 1,
    syncedAt: '2026-10-02T08:00:00+09:00',
  },
]

/* 設定›SNS連携が読む4つの口。mock-api.mjs はこの表に当たったときだけ下の返事を使う。 */
export const SNS_CONNECTION_PATHS = new Set([
  '/api/restaurant-test/google/connection',
  '/api/instagram/connection',
  '/api/restaurant-test/google/connections',
  '/api/instagram/connections',
])

/* 1件ぶんの口（…/connection）は今までどおりの返事。接続一覧の口（…/connections）は
   既定だと1件ぶんと同じ中身にして、今までの撮影を変えない。 */
export function snsConnectionBody(pathname) {
  if (pathname === '/api/restaurant-test/google/connection') return GOOGLE_CONNECTION_DATA
  // SNS 連携（y3GGTs）の Instagram：まだつないでいない（絵の「まだつないでいません」）。汎用の一覧を返すと読み込み中のまま止まる。
  if (pathname === '/api/instagram/connection') return { success: true, data: { state: 'disconnected', replyEnabled: false } }
  if (pathname === '/api/restaurant-test/google/connections') {
    const connections = SNS_MULTI_CONNECTIONS ? GOOGLE_CONNECTION_ROWS : [{ id: 'gc-1', confirmationRevision: 1, ...GOOGLE_CONNECTION }]
    return { success: true, store: GOOGLE_STORE, connections }
  }
  return SNS_MULTI_CONNECTIONS
    ? { success: true, data: { state: 'connected', connections: INSTAGRAM_CONNECTION_ROWS } }
    : { success: true, data: { state: 'disconnected', connections: [] } }
}
