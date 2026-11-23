import { seedExistingRestaurantFollowup } from './restaurant-followup-fixture.js';
import type { SqliteD1 } from './d1-sqlite.js';

/** HTTPで公開しない、ルート試験専用の最小データ。 */
export function seedRestaurantFixture(testDb: SqliteD1, {
  accountId = 'account-1',
  tenantId = '00000000-0000-4000-8000-000000000001',
  name = '飲食店LAB',
}: {
  accountId?: string;
  tenantId?: string;
  name?: string;
} = {}): void {
  const columns = testDb.raw.prepare('PRAGMA table_info(rt_reservations)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'allergies_json')) {
    testDb.raw.exec("ALTER TABLE rt_reservations ADD COLUMN allergies_json TEXT CHECK(allergies_json IS NULL OR json_valid(allergies_json)); CREATE TRIGGER rt_reservation_allergies_legacy_update AFTER UPDATE OF allergy_note ON rt_reservations WHEN NEW.allergy_note IS NOT OLD.allergy_note AND NEW.allergies_json IS OLD.allergies_json BEGIN UPDATE rt_reservations SET allergies_json = NULL WHERE id = NEW.id; END;");
  }
  // 統括ゲート（飲食店機能パック）。このAPI群はゲートの内側を検証する
  // フィクスチャなので、対象の統括には常にパックを付けておく。
  // ゲート自体の検証（無し→404）は別のdescribeで明示的に行う。
  testDb.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = ?`)
    .run(tenantId);
  testDb.raw.prepare(
    'INSERT INTO rt_organizations (id, account_id, tenant_id, name) VALUES (?, ?, ?, ?)',
  ).run('org-fixture', accountId, tenantId, name);
  testDb.raw.prepare(
    'INSERT INTO rt_stores (id, organization_id, name, code, area, capacity, line_account_id, google_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('store-ginza', 'org-fixture', '銀座店', 'GINZA', '東京', 32, 'account-2', 'connected');
  testDb.raw.prepare(
    'INSERT INTO rt_stores (id, organization_id, name, code, area, capacity, line_account_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('store-yokohama', 'org-fixture', '横浜店', 'YOKOHAMA', '神奈川', 24, 'account-3');
  testDb.raw.prepare(
    'INSERT INTO rt_tables (id, store_id, code, label, seat_type, min_capacity, max_capacity) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('table-ginza', 'store-ginza', 'T-01', 'テーブル1', 'table', 1, 4);
  testDb.raw.prepare(
    'INSERT INTO rt_menu_items (id, store_id, kind, name, price) VALUES (?, ?, ?, ?, ?)',
  ).run('menu-ginza', 'store-ginza', 'course', 'テストコース', 8800);
  testDb.raw.prepare(
    'INSERT INTO rt_reservations (id, store_id, source, external_id, customer_name, guest_count, starts_at, ends_at, table_id, course_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'reservation-ginza',
    'store-ginza',
    'restaurant_board',
    'RB-FIXTURE',
    '検証 太郎',
    2,
    '2026-08-25T09:00:00.000Z',
    '2026-08-25T11:00:00.000Z',
    'table-ginza',
    'menu-ginza',
  );
  for (const [index, flowType] of [
    'reservation_24h',
    'reservation_2h',
    'post_visit',
    'review_request',
    'member_card',
    'one_tap_booking',
  ].entries()) {
    testDb.raw.prepare(
      'INSERT INTO rt_line_flows (id, organization_id, store_id, flow_type, title, body) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`flow-${index}`, 'org-fixture', 'store-ginza', flowType, `テスト${index}`, 'テスト本文');
  }
  seedExistingRestaurantFollowup(testDb,'store-ginza');
  seedExistingRestaurantFollowup(testDb,'store-yokohama');
}
