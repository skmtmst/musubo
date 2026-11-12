/*
 * お金まわり（③-1・）の見本。絵 f4bLF の列：
 * T91bV（お支払い：つないだ後）・UteeA（つなぐ前と届いた知らせ）・FY8HC（お支払いの記録）・
 * mauOC（コースのお支払い）・XFRyO（クラスのお支払い）・QJMoY（担当の割り当て方）・
 * jmVYJ（卓の割り当て方）・t7AmhL（回数券を手で入れる）・XrfOE（回数券の履歴）。
 * 記録・知らせ・つなぎの状態・コース／クラスの支払いは、現在のAPIの形
 * （apps/web/src/lib/api-booking-payment-admin.ts）に合わせて返す。
 */

export const PAYMENT_CONFIG = { mode: 'online', provider: 'stripe', holdMinutes: 10, keyConfigured: true, testMode: true }

export const PAYMENT_CONNECTION = {
  connected: true, testMode: true, accountIdTail: '3kPq', connectedAt: '2026-10-16T00:12:00.000Z',
  dashboardUrl: 'https://dashboard.stripe.com/test/payments',
}

export const MENU_PAYMENT_OVERRIDES = { menus: [{ menuId: 'bm-2', mode: 'online' }, { menuId: 'bm-3', mode: 'onsite' }] }

const paymentRecord = (row) => ({ refundedAmount: 0, actorLabel: null, reason: null, ...row })

export const PAYMENT_RECORDS = {
  summary: { paidAmount: 128400, paidCount: 42, refundedAmount: 8800, refundedCount: 2, expiredCount: 3, pendingCount: 2, holdMinutes: 10 },
  total: 5,
  items: [
    paymentRecord({ id: 'pay-1', bookingId: 'bk-1', friendId: 'friend-yamada', friendName: '見本 143', bookingStartsAt: '2026-10-18T09:00:00.000Z', bookingLabel: '10/18 18:00 ディナー 2名', bookingNote: 'コース先払い', amount: 8800, status: 'paid', method: 'online', createdAt: '2026-10-15T12:52:00.000Z', receiptUrl: 'https://pay.stripe.com/receipts/test' }),
    paymentRecord({ id: 'pay-2', bookingId: 'bk-2', friendId: 'friend-takahashi', friendName: '見本 29', bookingStartsAt: '2026-10-16T03:00:00.000Z', bookingLabel: '10/16 12:00 ランチ 3名', bookingNote: null, amount: 6600, status: 'pending', method: null, createdAt: '2026-10-15T11:31:00.000Z', receiptUrl: null }),
    paymentRecord({ id: 'pay-3', bookingId: 'bk-3', friendId: 'friend-sato', friendName: '見本 114', bookingStartsAt: '2026-10-16T10:00:00.000Z', bookingLabel: '10/16 19:00 ディナー 1名', bookingNote: null, amount: 4400, status: 'refunded', refundedAmount: 4400, method: 'online', createdAt: '2026-10-15T10:10:00.000Z', receiptUrl: 'https://pay.stripe.com/receipts/test', actorLabel: '自動・10 分を過ぎた' }),
    paymentRecord({ id: 'pay-4', bookingId: 'bk-4', friendId: 'friend-suzuki', friendName: '見本 176', bookingStartsAt: '2026-10-16T09:30:00.000Z', bookingLabel: '10/16 18:30 ディナー 2名', bookingNote: null, amount: 8800, status: 'expired', method: null, createdAt: '2026-10-15T09:02:00.000Z', receiptUrl: null }),
    paymentRecord({ id: 'pay-5', bookingId: 'bk-5', friendId: 'friend-ito', friendName: '見本 33', bookingStartsAt: '2026-10-14T03:30:00.000Z', bookingLabel: '10/14 12:30 ランチ 2名', bookingNote: null, amount: 3960, status: 'onsite', method: 'onsite', createdAt: '2026-10-14T03:15:00.000Z', receiptUrl: null }),
  ],
}

export const PAYMENT_EVENTS = {
  total: 5,
  items: [
    { id: 'pe-1', receivedAt: '2026-10-15T12:52:00.000Z', kind: 'paid', amount: 8800, repeat: false, bookingId: 'bk-1', bookingLabel: '10/18 見本 143', note: null, result: 'applied' },
    { id: 'pe-2', receivedAt: '2026-10-15T12:52:00.000Z', kind: 'paid', amount: null, repeat: true, bookingId: 'bk-1', bookingLabel: '10/18 見本 143', note: '同じ知らせが届いた', result: 'duplicate' },
    { id: 'pe-3', receivedAt: '2026-10-15T10:10:00.000Z', kind: 'refunded', amount: 4400, repeat: false, bookingId: 'bk-3', bookingLabel: '10/16 見本 114', note: null, result: 'applied' },
    { id: 'pe-4', receivedAt: '2026-10-15T09:02:00.000Z', kind: 'expired', amount: null, repeat: false, bookingId: 'bk-4', bookingLabel: '10/16 見本 176', note: null, result: 'applied' },
    { id: 'pe-5', receivedAt: '2026-10-14T02:30:00.000Z', kind: 'paid', amount: null, repeat: false, bookingId: null, bookingLabel: null, note: '予約が見つからない', result: 'failed' },
  ],
}

export const STAFF_ASSIGNMENT = {
  method: 'balanced', balancePeriod: 'day', version: 3, storageReady: true, effectiveMethod: 'balanced',
  resources: [
    { resourceId: 'bs-1', priority: 'preferred', dailyLimit: 8, sortOrder: 0 },
    { resourceId: 'bs-3', priority: 'normal', dailyLimit: null, sortOrder: 1 },
    { resourceId: 'bs-2', priority: 'low', dailyLimit: 4, sortOrder: 2 },
  ],
}

export function tableAssignment(tables) {
  const priority = ['preferred', 'normal', 'low', 'normal']
  return {
    method: 'balanced', balancePeriod: 'day', version: 2, storageReady: true, effectiveMethod: 'balanced',
    resources: tables.map((table, index) => ({ resourceId: table.id, priority: priority[index % priority.length], dailyLimit: index === 2 ? 2 : null, sortOrder: index })),
  }
}

const day = (iso) => iso
export const ENTITLEMENTS = [
  { id: 'ent-cut10', line_account_id: 'visual-qa-account', friend_id: 'friend-yamada', menu_id: null, kind: 'ticket', name: 'カット 10回券', remaining: 4, monthly_limit: null, valid_from: day('2026-09-01T00:00:00.000Z'), expires_at: day('2026-12-31T14:59:59.000Z'), status: 'active', version: 4, created_at: '2026-09-01T01:00:00.000Z', updated_at: '2026-10-12T05:00:00.000Z', monthUsed: 2, monthAllowance: null, monthRemaining: null, periodStart: '2026-09-30T15:00:00.000Z', periodEnd: '2026-10-31T15:00:00.000Z' },
  { id: 'ent-monthly', line_account_id: 'visual-qa-account', friend_id: 'friend-yamada', menu_id: null, kind: 'monthly', name: '月謝（月4回）', remaining: null, monthly_limit: 4, valid_from: day('2026-08-01T00:00:00.000Z'), expires_at: day('2027-03-31T14:59:59.000Z'), status: 'active', version: 1, created_at: '2026-08-01T01:00:00.000Z', updated_at: '2026-08-01T01:00:00.000Z', monthUsed: 3, monthAllowance: 4, monthRemaining: 1, periodStart: '2026-09-30T15:00:00.000Z', periodEnd: '2026-10-31T15:00:00.000Z' },
]

const ev = (id, action, at, before, after, reason, actor, actorType = 'staff', extra = {}) => ({
  id, entitlement_id: 'ent-cut10', action, reason, actor_type: actorType, actor_id: actor,
  before_json: before === null ? null : JSON.stringify({ remaining: before }), after_json: JSON.stringify({ remaining: after }),
  request_json: JSON.stringify(extra), created_at: at,
})
export const ENTITLEMENT_HISTORY = [
  ev('ee-5', 'adjust', '2026-10-15T12:30:00.000Z', 4, 9, '店頭で現金で買った', '店長 田中'),
  ev('ee-4', 'consume', '2026-10-12T05:00:00.000Z', 5, 4, '10/12 カット', 'booking', 'system', { bookingId: 'bk-1012' }),
  ev('ee-3', 'consume', '2026-10-02T02:00:00.000Z', 6, 5, '10/02 カット', 'booking', 'system', { bookingId: 'bk-1002' }),
  ev('ee-2', 'adjust', '2026-09-20T09:10:00.000Z', 5, 6, '予約の取り消し', 'booking', 'system', { bookingId: 'bk-0920' }),
  ev('ee-1', 'grant', '2026-09-01T01:00:00.000Z', null, 6, '紙の回数券の引き継ぎ', '店長 田中'),
]

/* ③-2 第1波（B1・B5・B7）の見本。gap1 の口と、口の案（api-gap-draft）の形。 */
export const CANCELLATION_POLICY = { enabled: true, tiers: [{ beforeHours: 24, percent: 0 }, { beforeHours: 0, percent: 50 }], noShowPercent: 100, version: 2 }
export const CANCELLATION_OPTIONS = { cardRequiredFor: 'all', chargeMode: 'manual', version: 1 }
export const DEPOSIT_RULE = { kind: 'percent', value: 30, conditions: { always: true, minPeople: null, weekdays: null, timeBand: null }, version: 1 }
export const CALENDAR_SWITCH = { readEnabled: true, writeEnabled: false, version: 3, effectiveReadEnabled: true, effectiveWriteEnabled: false, connected: true, futureEventCount: 12 }

/** GET の口。返す物が無い道は undefined。 */
export function paymentGet(pathname, query, { restaurantTables = [] } = {}) {
  if (pathname === '/api/booking/admin/cancellation-policy') return { success: true, data: CANCELLATION_POLICY }
  if (pathname === '/api/booking/admin/cancellation-options') return { success: true, data: CANCELLATION_OPTIONS }
  if (pathname === '/api/booking/admin/deposit-rules') return { success: true, data: DEPOSIT_RULE }
  if (/^\/api\/booking\/admin\/menus\/[^/]+\/deposit$/.test(pathname)) return { success: true, data: { ...DEPOSIT_RULE, inherit: false, conditions: { always: false, minPeople: 4, weekdays: [5, 6], timeBand: 'dinner' } } }
  if (/^\/api\/booking\/admin\/bookings\/[^/]+\/charges$/.test(pathname)) {
    const id = pathname.split('/')[5]
    const quote = { freeUntil: '2026-11-19T05:00:00.000Z', feeNow: 4200, feeNoShow: 8400, text: '24 時間前まで無料・以降 50%・無断 100%', policyAcceptedRequired: true }
    const charge = (status, extra = {}) => ({ id: `chg-${id}`, booking_id: id, line_account_id: 'visual-qa-account', kind: 'cancellation_fee', amount: 4200, status, version: 1, actor_staff_id: null, reason: null, test_mode: 1, ...extra })
    const charges = id === 'bk-1' ? [charge('pending')] : id === 'bk-2' ? [charge('succeeded', { actor_staff_id: 'staff-1' })] : []
    return { success: true, data: { testMode: true, quote, charges } }
  }
  if (/^\/api\/booking\/admin\/bookings\/[^/]+\/payment-method$/.test(pathname)) return { success: true, data: { brand: 'Visa', last4: '4242', registeredAt: '2026-11-02T01:00:00.000Z' } }
  if (/^\/api\/booking\/admin\/bookings\/[^/]+\/group$/.test(pathname)) return pathname.split('/')[5] !== 'bk-3' ? { success: true, data: null } : { success: true, data: { ownerName: '見本 143', members: [
    { bookingId: 'bk-g1', personName: 'チョコ', menuName: '爪切り', staffName: 'Kenta', startsAt: '2026-10-01T04:30:00.000Z', endsAt: '2026-10-01T04:45:00.000Z', status: 'confirmed' },
    { bookingId: 'bk-g2', personName: 'マロン', menuName: 'トリミング（中型犬）', staffName: '佐々木', startsAt: '2026-10-01T04:00:00.000Z', endsAt: '2026-10-01T05:30:00.000Z', status: 'confirmed' },
  ] } }
  if (pathname === '/api/booking/admin/calendar-sync' || /^\/api\/booking\/admin\/staff\/[^/]+\/calendar-sync$/.test(pathname)) return { success: true, data: CALENDAR_SWITCH }
  if (/^\/api\/booking\/admin\/(staff|menus)\/[^/]+\/meeting-url$/.test(pathname)) return { success: true, data: { url: pathname.includes('/staff/') ? 'https://meet.google.com/abc-defg-hij' : 'https://zoom.us/j/81234567890', version: 1 } }
  if (pathname === '/api/booking/admin/payment-config') return { success: true, data: PAYMENT_CONFIG }
  if (pathname === '/api/booking/admin/payments/export') return { __csv: '\uFEFF記録ID,予約ID,お客さま,予約日時,メニュー,金額,状態,方法,作成日時\npay-1,bk-1,見本 143,2026-10-18 18:00,ディナー,8800,paid,online,2026-10-15 21:52\n' }
  if (pathname === '/api/booking/admin/payment-connection') return { success: true, data: PAYMENT_CONNECTION }
  if (pathname === '/api/booking/admin/menu-payments') return { success: true, data: MENU_PAYMENT_OVERRIDES }
  if (pathname === '/api/booking/admin/payments') return { success: true, data: PAYMENT_RECORDS }
  if (pathname === '/api/booking/admin/payment-events') return { success: true, data: PAYMENT_EVENTS }
  if (/^\/api\/booking\/payments\/[^/]+\/refunds$/.test(pathname)) return { success: true, data: { items: [] } }
  if (pathname === '/api/booking/admin/assignment-settings') return { success: true, data: STAFF_ASSIGNMENT }
  if (pathname === '/api/restaurant-test/assignment-settings') return { success: true, data: tableAssignment(restaurantTables) }
  if (/^\/api\/restaurant-test\/menus\/[^/]+\/payment$/.test(pathname)) return { success: true, data: { mode: 'online', version: 2 } }
  if (/^\/api\/events\/admin\/events\/[^/]+\/payment$/.test(pathname)) return { success: true, data: { mode: 'online', version: 1 } }
  if (/^\/api\/events\/admin\/events\/[^/]+\/price$/.test(pathname)) return { success: true, data: { unitPrice: 2200, version: 1 } }
  if (pathname === '/api/booking/admin/staff/today-counts') return { success: true, data: { items: [{ staffId: 'bs-1', todayCount: 3 }, { staffId: 'bs-3', todayCount: 2 }, { staffId: 'bs-2', todayCount: 1 }], date: '2026-10-16', timezone: 'Asia/Tokyo' } }
  if (pathname === '/api/booking/admin/entitlements') {
    const friendId = query.get('friend_id')
    void friendId; return { success: true, data: ENTITLEMENTS }
  }
  if (/^\/api\/booking\/admin\/entitlements\/[^/]+\/history$/.test(pathname)) return { success: true, data: ENTITLEMENT_HISTORY }
  return undefined
}

/** 書き込みの口（保存はしない。送った値を当てて返す）。 */
export function paymentWrite(method, pathname, body) {
  if (method === 'PUT' && pathname === '/api/booking/admin/cancellation-policy') return { success: true, data: { ...CANCELLATION_POLICY, ...body, version: (body?.expectedVersion ?? 0) + 1 } }
  if (method === 'PUT' && pathname === '/api/booking/admin/cancellation-options') return { success: true, data: { ...CANCELLATION_OPTIONS, ...body, version: (body?.expectedVersion ?? 0) + 1 } }
  if (method === 'PUT' && (pathname === '/api/booking/admin/deposit-rules' || /\/deposit$/.test(pathname))) return { success: true, data: { ...DEPOSIT_RULE, ...body, version: (body?.expectedVersion ?? 0) + 1 } }
  if (method === 'POST' && /^\/api\/booking\/admin\/bookings\/[^/]+\/charges$/.test(pathname)) return { success: true, data: { id: 'chg-1', booking_id: 'bk-1', line_account_id: 'visual-qa-account', kind: 'cancellation_fee', amount: body?.amount ?? 4200, status: 'succeeded', version: 2, actor_staff_id: 'staff-1', reason: null, test_mode: 1 } }
  if (method === 'POST' && /^\/api\/booking\/admin\/charges\/[^/]+\/(waive|refund)$/.test(pathname)) return { success: true, data: { id: 'chg-1', status: pathname.endsWith('waive') ? 'waived' : 'refunded', version: 3 } }
  if (method === 'POST' && /\/group\/cancel$/.test(pathname)) return { success: true, data: { cancelled: 2 } }
  if (method === 'PUT' && (pathname === '/api/booking/admin/calendar-sync' || /\/calendar-sync$/.test(pathname))) return { success: true, data: { ...CALENDAR_SWITCH, ...body, version: (body?.expectedVersion ?? 0) + 1 } }
  if (method === 'PUT' && /\/meeting-url$/.test(pathname)) return { success: true, data: { url: body?.url ?? null, version: (body?.expectedVersion ?? 0) + 1 } }
  if (method === 'PUT' && pathname === '/api/booking/admin/payment-config') return { success: true, data: { ...PAYMENT_CONFIG, ...body } }
  if ((method === 'PUT' || method === 'DELETE') && /^\/api\/booking\/admin\/menus\/[^/]+\/payment$/.test(pathname)) return { success: true, data: method === 'DELETE' ? { cleared: true } : { ...PAYMENT_CONFIG, ...body } }
  if (method === 'PUT' && /^\/api\/(restaurant-test\/menus|events\/admin\/events)\/[^/]+\/payment$/.test(pathname)) return { success: true, data: { mode: body?.mode ?? null, version: (body?.expectedVersion ?? 0) + 1 } }
  if (method === 'PUT' && /^\/api\/events\/admin\/events\/[^/]+\/price$/.test(pathname)) return { success: true, data: { unitPrice: body?.unitPrice ?? 0, version: (body?.expectedVersion ?? 0) + 1 } }
  if (method === 'POST' && /^\/api\/booking\/admin\/payments\/[^/]+\/send-link$/.test(pathname)) return { success: true, data: { paymentId: pathname.split('/')[5], checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_visualqa', sent: false, simulation: true } }
  if (method === 'POST' && /^\/api\/booking\/payments\/[^/]+\/refund$/.test(pathname)) {
    const record = PAYMENT_RECORDS.items.find((item) => item.id === pathname.split('/')[4])
    if (!record) return undefined
    return { success: true, data: {
      payment: { status: 'refunded' }, duplicate: false, simulation: true, sent: false,
      refund: {
        id: 'refund-qa', amount: body?.amount ?? record.amount,
        reason: body?.reason ?? '見本の返金', actorLabel: '店長 田中', createdAt: '2026-10-15T12:52:00.000Z',
        notifyLine: Boolean(body?.notifyLine), notificationStatus: body?.notifyLine ? 'simulated' : 'not_requested',
        simulation: true, sent: false,
      },
    } }
  }
  if (method === 'POST' && /^\/api\/booking\/admin\/payment-events\/[^/]+\/replay$/.test(pathname)) return { success: true, data: { ...PAYMENT_EVENTS.items[4], result: 'applied' } }
  if (method === 'PUT' && (pathname === '/api/booking/admin/assignment-settings' || pathname === '/api/restaurant-test/assignment-settings')) {
    return { success: true, data: { ...STAFF_ASSIGNMENT, ...body, version: (body?.expectedVersion ?? 0) + 1 } }
  }
  if (method === 'POST' && pathname === '/api/booking/admin/entitlements') return { success: true, data: { ...ENTITLEMENTS[0], id: 'ent-new', ...body }, replayed: false }
  if (method === 'POST' && /^\/api\/booking\/admin\/entitlements\/[^/]+\/operations$/.test(pathname)) return { success: true, data: { ...ENTITLEMENTS[0], remaining: body?.remaining ?? ENTITLEMENTS[0].remaining, version: ENTITLEMENTS[0].version + 1 }, replayed: false }
  return undefined
}
