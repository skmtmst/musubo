/*
 * ③-2 第3波（G5 お客さまの分け方・会員ランク／G7 店の比較／G6 自動の LINE／B2 回数券・月謝）の撮影の見本。
 * 形は design/v8/review/API-CONTRACT-GAP3.md のとおり。保存はしない（書く道は固定の結果を返す）。
 * 絵（Pencil の板）と同じ数・同じ名前にして、左右を並べやすくしている。
 */
const ok = (data, status = 200) => [status, { success: true, data }]

const SEGMENT_NAMES = [
  ['新しい人', '育ち中', '常連の手前', '常連', 'いちばんの常連'],
  ['また来た', '育ち中', '常連の手前', '常連', 'いちばんの常連'],
  ['呼び戻し候補', '離れかけ', '離れかけ', '気をつけたい常連', '気をつけたい常連'],
  ['離れた', '離れた', '離れかけ', '眠っている常連', '眠っている常連'],
  ['1 回きり', '離れた', '離れた', '眠っている常連', '眠っている常連'],
]
const SEGMENT_COUNTS = [
  [42, 28, 15, 22, 18],
  [61, 40, 31, 44, 26],
  [88, 52, 39, 33, 12],
  [120, 64, 27, 19, 8],
  [210, 95, 22, 11, 6],
]
const SEGMENT_FRIENDS = [
  { id: 'f1', display_name: '見本 114', activity_count: 1, amount: 8400, last_activity_at: '2026-08-02T01:00:00.000Z' },
  { id: 'f2', display_name: '見本 165', activity_count: 1, amount: 4200, last_activity_at: '2026-07-28T01:00:00.000Z' },
  { id: 'f3', display_name: '見本 177', activity_count: 1, amount: 12600, last_activity_at: '2026-07-20T01:00:00.000Z' },
  { id: 'f4', display_name: '見本 47', activity_count: 1, amount: 8400, last_activity_at: '2026-07-18T01:00:00.000Z' },
]

const STORES = [
  ['大宮店', 540, 4, 3.8, 41, 12, 10, 6.2, 18],
  ['池袋店', 869, 11, 2.9, 48, 31, 28, 3.4, 9],
  ['横浜店', 1108, 18, 2.1, 55, 44, 40, 2.8, 8],
  ['新宿店', 2010, 42, 1.4, 62, 88, 81, 1.9, 6],
  ['渋谷店', 1284, 36, 1.2, 64, 72, 70, 1.5, 5],
  ['川口店', 702, 7, 2.6, 50, 20, 18, 4.1, 12],
  ['船橋店', 655, 5, 3.1, 44, 15, 12, 5.0, 15],
  ['立川店', 931, 12, 2.2, 52, 36, 33, 2.9, 10],
  ['町田店', 488, 2, 3.5, 39, 9, 7, 6.8, 22],
  ['川崎店', 1180, 22, 1.9, 58, 52, 49, 2.2, 7],
  ['千葉店', 760, 8, 2.4, 47, 24, 22, 3.6, 11],
  ['吉祥寺店', 842, 14, 2.0, 56, 40, 38, 2.5, 8],
]
const KEYS = ['friendChange', 'blockRate', 'clickRate', 'bookings', 'visits', 'noShowRate', 'responseMinutes']
const UNITS = { friendChange: '人', blockRate: '%', clickRate: '%', bookings: '件', visits: '件', noShowRate: '%', responseMinutes: '分' }
const mean = (index) => STORES.reduce((n, row) => n + row[index], 0) / STORES.length
const AVERAGE = { friendChange: mean(2), blockRate: mean(3), clickRate: mean(4), bookings: mean(5), visits: mean(6), noShowRate: mean(7), responseMinutes: mean(8) }

/* 最後の店は期間の途中から集計した店（30 日のうち 12 日分）。件数は日数が違うので差を出さない。 */
const COUNT_KEYS = new Set(['friendChange', 'bookings', 'visits'])
function storeRows() {
  return STORES.map((row, i) => {
    const values = { friendChange: row[2], blockRate: row[3], clickRate: row[4], bookings: row[5], visits: row[6], noShowRate: row[7], responseMinutes: row[8] }
    const coveredDays = i === STORES.length - 1 ? 12 : 30
    return {
      accountId: `store-${i + 1}`, name: row[0], style: null, computedAt: '2026-10-16T04:30:00.000Z', coveredDays, periodDays: 30,
      metrics: Object.fromEntries(KEYS.map((k) => [k, { value: values[k], diff: coveredDays < 30 && COUNT_KEYS.has(k) ? null : Math.round((values[k] - AVERAGE[k]) * 10) / 10, unit: UNITS[k], available: true }])),
    }
  })
}

const MESSAGE = [{ type: 'text', text: '{{name}} さま、カートに商品が残っています。' }]
const RULES = [
  { kind: 'cart', enabled: true, waitMinutes: 60, messages: MESSAGE, version: 3, testMode: true },
  { kind: 'browse', enabled: false, waitMinutes: 1440, messages: [], version: 1, testMode: true },
  { kind: 'restock', enabled: true, waitMinutes: 0, messages: [], version: 2, testMode: true },
]
const SENDS = { cart: 214, browse: 0, restock: 96 }

const PLANS = [
  { id: 'pp-1', kind: 'ticket', name: 'ヨガ 10 回券', price: 15000, count: 10, monthlyLimit: null, validDays: 180, menuIds: ['bm-1', 'bm-2'], allowWithoutPass: true, status: 'on_sale', version: 2 },
  { id: 'pp-2', kind: 'ticket', name: 'カット 5 回券', price: 20000, count: 5, monthlyLimit: null, validDays: 365, menuIds: ['bm-3'], allowWithoutPass: true, status: 'on_sale', version: 2 },
  { id: 'pp-3', kind: 'monthly', name: 'ヨガ 月 4 回', price: 9800, count: null, monthlyLimit: 4, validDays: 30, menuIds: ['bm-1', 'bm-2'], allowWithoutPass: false, status: 'on_sale', version: 2 },
  { id: 'pp-4', kind: 'ticket', name: 'お試し 3 回券', price: 3000, count: 3, monthlyLimit: null, validDays: 30, menuIds: ['bm-5'], allowWithoutPass: true, status: 'stopped', version: 3 },
]
const HOLDERS = { 'pp-1': 42, 'pp-2': 22, 'pp-3': 22, 'pp-4': 0 }

/**
 * 数の帯の比べる値（`GET /api/dashboard/comparisons`）。形は shared の DashboardComparisons。
 * 予約は先週より少ない（赤）、友だちは少ない（赤）、配信の失敗は少ない（緑）。月の数は前の月の記録が無い（null）。
 * 今の数は、同じ見本の帯・欄の数（予約 0・有効友だち 398・失敗 3）とそろえる（違うと画面は札を出さない）。
 */
const COMPARISON_WINDOW = { asOf: '2026-01-13T18:30:00+09:00', previousFrom: '2026-01-06T00:00:00+09:00', previousTo: '2026-01-07T00:00:00+09:00' }
const week = (current, previous, better) => ({ current, previous, better, basis: 'same_weekday_last_week', ...COMPARISON_WINDOW })
const DASHBOARD_COMPARISONS = {
  generatedAt: '2026-01-13T18:30:00+09:00',
  comparisons: { todayBookings: week(0, 2, 'high'), activeFriends: week(398, 402, 'high'), deliveryFailures: week(3, 5, 'low'), monthlySent: null, monthlyBroadcasts: null },
  skipped: { monthlySent: 'no_previous_record', monthlyBroadcasts: 'no_previous_record' },
}

export function gap3Respond(method, pathname, body = {}, query = new URLSearchParams()) {
  if (method === 'GET' && pathname === '/api/dashboard/comparisons') return ok(DASHBOARD_COMPARISONS)
  if (method === 'GET' && pathname === '/api/analytics/customer-segments') {
    const cells = []
    for (let r = 1; r <= 5; r += 1) for (let f = 1; f <= 5; f += 1) cells.push({ r, f, name: SEGMENT_NAMES[r - 1][f - 1], count: SEGMENT_COUNTS[r - 1][f - 1], optedOutCount: 0 })
    return ok({ cells, outside: { count: 312 }, total: 1284, computedAt: '2026-10-16T04:10:00.000Z', status: 'ready' })
  }
  const friendsHit = /^\/api\/analytics\/customer-segments\/cells\/(\d+)\/(\d+)\/friends$/.exec(pathname)
  if (method === 'GET' && friendsHit) return ok({ items: SEGMENT_FRIENDS, total: 88, optedOutCount: 6, nextCursor: '20' })
  if (/^\/api\/analytics\/customer-segments\/cells\//.test(pathname)) return ok({ id: 'ss-1' }, 201)

  if (method === 'GET' && pathname === '/api/member-ranks/program') {
    return ok({
      metric: 'visits', windowMonths: 12, status: 'stopped', version: 4, activatedAt: null, notificationsAvailable: false, simulationAvailable: true, testMode: true, notifyUpgrade: true, notifyDowngrade: true,
      tiers: [
        { id: 't-1', name: 'ブロンズ', threshold: 0, mileMultiplier: 1 },
        { id: 't-2', name: 'シルバー', threshold: 3, mileMultiplier: 1.2 },
        { id: 't-3', name: 'ゴールド', threshold: 8, mileMultiplier: 1.5 },
      ],
    })
  }
  if (method === 'POST' && pathname === '/api/member-ranks/preview') {
    return ok({ byTier: [{ tierId: 't-1', name: 'ブロンズ', count: 780 }, { tierId: 't-2', name: 'シルバー', count: 360 }, { tierId: 't-3', name: 'ゴールド', count: 144 }], wouldUpgrade: 504, wouldDowngrade: 0 })
  }
  if (pathname.startsWith('/api/member-ranks/')) return ok({ metric: 'visits', windowMonths: 12, status: 'active', version: 5, activatedAt: '2026-10-16T00:00:00.000Z', tiers: [], notificationsAvailable: false })

  if (method === 'POST' && pathname === '/api/hq/store-comparison/export') return ok({ id: 'ex-1', replayed: false })
  if (method === 'GET' && /^\/api\/hq\/store-comparison\/exports\/[^/]+$/.test(pathname)) return ok({ id: 'ex-1', status: 'completed', rowCount: 12, downloadUrl: null, errorCode: null })
  if (method === 'GET' && /^\/api\/friends\/[^/]+\/delivery-consents\/history$/.test(pathname)) {
    const side = (state, source) => ({ state, reason: '', source, updatedBy: null, updatedAt: '2026-10-12T05:05:00.000Z', version: 1 })
    return ok({ total: 3, nextCursor: null, items: [
      { id: 3, purpose: 'marketing', operation: 'update', before: side('granted', 'manual'), after: side('revoked', 'liff'), actor: { kind: 'self', id: null }, reason: '本人の操作', createdAt: '2026-10-12T05:05:00.000Z' },
      { id: 2, purpose: 'notice', operation: 'insert', before: null, after: side('granted', 'manual'), actor: { kind: 'store', id: 'Kenta' }, reason: '電話で了承', createdAt: '2026-10-01T01:00:00.000Z' },
    ] })
  }
  if (method === 'GET' && pathname === '/api/hq/store-comparison') {
    const size = Number(query.get('pageSize') ?? 20)
    const sort = query.get('sort') ?? 'bookings'
    const dir = query.get('order') === 'desc' ? -1 : 1
    const rows = storeRows().sort((a, b) => dir * (a.metrics[sort].value - b.metrics[sort].value))
    return ok({ rows: rows.slice(0, size), average: AVERAGE, total: rows.length, computedAt: '2026-10-16T04:30:00.000Z' })
  }
  const detail = /^\/api\/hq\/store-comparison\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && detail) {
    return ok({ accountId: detail[1], values: {}, style: null, computedAt: '2026-10-16T04:30:00.000Z', coveredDays: 30, periodDays: 30, trend: [], recentBroadcasts: [
      { id: 'b1', title: '秋の新メニュー', status: 'sent', sent_at: '2026-10-14T01:00:00.000Z' },
      { id: 'b2', title: '休業日のお知らせ', status: 'sent', sent_at: '2026-10-07T01:00:00.000Z' },
      { id: 'b3', title: 'クーポン', status: 'sent', sent_at: '2026-09-30T01:00:00.000Z' },
    ], attention: null })
  }

  if (method === 'GET' && /^\/api\/friends\/[^/]+\/member-rank$/.test(pathname)) {
    return ok({ current: { tier_id: 't-2', name: 'シルバー', threshold: 3 }, history: [
      { id: 'h1', from_tier_id: 't-1', to_tier_id: 't-2', reason: 'upgrade', at: '2026-10-12T05:05:00.000Z' },
      { id: 'h2', from_tier_id: null, to_tier_id: 't-1', reason: 'activated', at: '2026-10-01T01:00:00.000Z' },
    ] })
  }
  if (/^\/api\/friends\/[^/]+\/delivery-consents$/.test(pathname)) {
    const row = (purpose, state, source, version) => ({ purpose, state, reason: source === 'manual' ? '電話で了承' : '本人の操作', source, updatedBy: source === 'manual' ? 'Kenta' : null, updatedAt: '2026-10-12T05:05:00.000Z', version })
    return ok([row('transaction', 'granted', 'manual', 1), row('notice', 'granted', 'manual', 1), row('marketing', 'revoked', 'liff', 3)])
  }
  if (method === 'GET' && pathname === '/api/ec/auto-line/rules') return ok(RULES)
  if (method === 'GET' && pathname === '/api/ec/auto-line/sends') {
    const kind = query.get('kind') ?? ''
    return ok({ items: [], total: SENDS[kind] ?? 0 })
  }
  if (method === 'GET' && pathname === '/api/ec/auto-line/stats') return ok({ total: 310, simulated: 310, skipped: 12, sent: 0, clicks: null, purchases: null, testMode: true })
  if (/^\/api\/ec\/auto-line\/rules\/[^/]+(\/enable|\/test)?$/.test(pathname)) {
    const kind = pathname.split('/')[5]
    const rule = RULES.find((r) => r.kind === kind) ?? RULES[0]
    return ok(pathname.endsWith('/test') ? { preview: rule, sent: false, testMode: true } : { ...rule, ...body, version: rule.version + 1 })
  }

  if (method === 'GET' && pathname === '/api/booking/admin/pass-plans') {
    return ok({ items: PLANS, total: PLANS.length, summary: { onSale: 3, holders: 86, expiringIn30d: 9, billingFailed: null, billingStatus: 'unconfigured', billingSimulationFailed: 1, billingSimulationCancelled: 2 } })
  }
  const holders = /^\/api\/booking\/admin\/pass-plans\/([^/]+)\/holders$/.exec(pathname)
  if (method === 'GET' && holders) {
    const total = HOLDERS[holders[1]] ?? 0
    return ok({ items: SEGMENT_FRIENDS.slice(0, Math.min(3, total)).map((f, i) => ({ id: `e${i}`, friend_id: f.id, display_name: f.display_name, remaining: 4 - i, expires_at: '2026-12-31T00:00:00.000Z', status: 'active' })), total })
  }
  if (pathname.startsWith('/api/booking/admin/pass-plans')) return ok({ ...PLANS[0], ...body, id: 'pp-new', status: 'draft', version: 1 }, 201)
  return null
}
