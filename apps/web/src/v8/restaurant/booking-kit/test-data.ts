import { formatYmd } from '@/lib/format'

/*
 * 飲食店テスト（在庫・予約台帳・座席・メニュー）の試験で使う固定データ。
 * restaurantTestApi.snapshot が返す形。
 */
export const store = { id: 'store-1', organization_id: 'org-1', name: '渋谷店', code: 'SHIBUYA', area: null, capacity: 26, timezone: 'Asia/Tokyo', status: 'active', line_status: 'connected', google_status: 'unconfigured', line_account_id: 'account-1', line_account_name: '渋谷' }

export const tables = [
  { id: 't1', store_id: 'store-1', code: 'T1', label: '2人卓', seat_type: 'table', min_capacity: 1, max_capacity: 2, floor_x: 0, floor_y: 0, join_group: null, is_active: 1 },
  { id: 't2', store_id: 'store-1', code: 'T2', label: '2人卓', seat_type: 'table', min_capacity: 1, max_capacity: 2, floor_x: 1, floor_y: 0, join_group: 'A', is_active: 1 },
  { id: 't3', store_id: 'store-1', code: 'T3', label: '窓側4人卓', seat_type: 'table', min_capacity: 2, max_capacity: 4, floor_x: 2, floor_y: 0, join_group: 'A', is_active: 1 },
  { id: 't4', store_id: 'store-1', code: 'T4', label: '4人卓', seat_type: 'table', min_capacity: 2, max_capacity: 4, floor_x: 0, floor_y: 1, join_group: null, is_active: 1 },
  { id: 'pa', store_id: 'store-1', code: '個室A', label: '個室', seat_type: 'private_room', min_capacity: 4, max_capacity: 8, floor_x: 1, floor_y: 1, join_group: null, is_active: 1 },
  { id: 'pb', store_id: 'store-1', code: '個室B', label: '個室', seat_type: 'private_room', min_capacity: 4, max_capacity: 6, floor_x: 2, floor_y: 1, join_group: null, is_active: 0 },
]

export const menuItems = [
  { id: 'm1', confirmation_revision: 1, store_id: 'store-1', kind: 'course', name: '秋の鹿肉コース', price: 8800, tax_mode: 'included', allergens_json: '["小麦","乳"]', service_periods_json: '["dinner"]', duration_minutes: 120, status: 'active' },
  { id: 'm2', confirmation_revision: 1, store_id: 'store-1', kind: 'a_la_carte', name: '鹿肉のロースト', price: 2400, tax_mode: 'included', allergens_json: '[]', service_periods_json: '["lunch","dinner"]', duration_minutes: null, status: 'active' },
  { id: 'm3', confirmation_revision: 1, store_id: 'store-1', kind: 'course', name: '夏の冷製コース', price: 6600, tax_mode: 'included', allergens_json: '["小麦"]', service_periods_json: '["dinner"]', duration_minutes: 120, status: 'archived' },
  { id: 'm4', confirmation_revision: 1, store_id: 'store-1', kind: 'course', name: '春の下書きコース', price: 5000, tax_mode: 'included', allergens_json: '[]', service_periods_json: '["dinner"]', duration_minutes: 90, status: 'draft' },
]

const at = (dayOffset: number, hour: number, minute = 0) => {
  const d = new Date(`${formatYmd(new Date())}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dayOffset)
  const day = d.toISOString().slice(0, 10)
  return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`).toISOString()
}

export function reservation(id: string, over: Record<string, unknown>) {
  return { id, store_id: 'store-1', store_name: '渋谷店', source: 'line', external_id: null, customer_name: '見本 114', customer_phone: null, line_uid: null, guest_count: 2, starts_at: at(1, 18), ends_at: at(1, 20), table_id: 't1', table_label: '2人卓', course_id: null, course_name: null, status: 'confirmed', allergy_note: null, note: null, sync_direction: 'inbound_only', ...over }
}

export { at }

export function snapshotOf(over: Record<string, unknown> = {}) {
  return {
    environment: 'staging_test', integrationPolicy: 'inbound_only',
    organization: { id: 'org-1', account_id: 'account-1', tenant_id: null, tenant_name: null, name: 'テスト組織', status: 'active' },
    stores: [store], memberships: [{ id: 'mem-2', store_id: 'store-1', staff_name: '見本 30', email: null, role: 'store_manager', line_uid: null, google_email: null, status: 'active' }],
    tables, menuItems, reservations: [], reservationTotal: 0, inventory: [],
    approvals: [{ id: 'a1', store_id: 'store-1', kind: 'menu_change', title: '価格改定', status: 'pending', requested_by: null, review_comment: null, payload_json: null }],
    connectors: [], reviews: [], posts: [], lineFlows: [],
    ...over,
  }
}
