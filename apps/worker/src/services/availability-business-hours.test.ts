// 店舗の営業時間（週次）が、空き枠の開閉と定員に効くこと。
//
// 監査  の再現はこうだった。営業 10:00-17:00・勤務 09:00-18:00 の店で
//   出た枠の開始時刻 = ["09:00","09:30","10:00", … "16:30","17:00"]
// 開店前の 09:00・09:30 が出て、17:00-18:00 まではみ出していた。
// あわせて、営業時間の「定員」も勤務がはみ出していると丸ごと無視されていた
// （勤務区間を完全に含む行しか見ていなかったため）。
//
// 実 SQLite に bootstrap.sql を流し、`getAvailability` を実物のまま呼ぶ。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getAvailability, getStoreCapacitySnapshot } from './availability.js';

function asD1(sqlite: Database.Database): D1Database {
  const db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      const bound = (params: unknown[]): D1PreparedStatement => ({
        bind: (...next: unknown[]) => bound(next),
        all: async <T>() => ({ success: true, results: statement.all(...params) as T[], meta: {} }),
        first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
        run: async <T>() => {
          const result = statement.run(...params);
          return { success: true, results: [], meta: { changes: result.changes } } as T;
        },
        raw: async () => [],
      } as unknown as D1PreparedStatement);
      return bound([]);
    },
  };
  return db as unknown as D1Database;
}

/** 2026-09-14 は月曜（weekday=1）。 */
const MONDAY = '2026-09-14';
const NOW = new Date('2026-09-01T00:00:00+09:00');

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(join(process.cwd(), '../../packages/db/bootstrap.sql'), 'utf8'));
  sqlite.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'ch-1', '店', 'token', 'secret');
    INSERT INTO booking_settings (id, line_account_id, timezone)
    VALUES ('bs-1', 'acc-1', 'Asia/Tokyo');
    INSERT INTO menus (id, line_account_id, name, duration_minutes, base_price, concurrent_capacity)
    VALUES ('menu-1', 'acc-1', 'カット', 60, 3000, 5);
    INSERT INTO staff (id, line_account_id, name, display_name)
    VALUES ('st-1', 'acc-1', '山田', '山田');
    INSERT INTO staff_menus (staff_id, menu_id, is_offered) VALUES ('st-1', 'menu-1', 1);
    INSERT INTO friends (id, line_user_id, display_name, line_account_id)
    VALUES ('fr-1', 'U-1', '予約者', 'acc-1');
    -- 勤務は月曜 09:00-18:00（営業時間より広い）
    INSERT INTO staff_availability_rules (id, staff_id, weekday, start_time, end_time, is_active)
    VALUES ('sr-1', 'st-1', 1, '09:00', '18:00', 1);
  `);
  db = asD1(sqlite);
});

afterEach(() => sqlite.close());

/** 曜日1（月）の営業時間を1行足す。 */
function businessHour(id: string, start: string, end: string, capacity = 1): void {
  sqlite.prepare(
    `INSERT INTO booking_business_hours (id, booking_settings_id, weekday, start_time, end_time, capacity)
     VALUES (?, 'bs-1', 1, ?, ?, ?)`,
  ).run(id, start, end, capacity);
}

function connectGoogleHours(specialHours: unknown[] = []): void {
  sqlite.exec(`
    INSERT INTO rt_organizations(id,account_id,name,status) VALUES('org-1','acc-1','サロン','active');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store-1','org-1','サロン','S1','acc-1');
    INSERT INTO rt_google_connections(id,store_id,line_account_id,location_name,status)
      VALUES('gc-1','store-1','acc-1','accounts/111/locations/222','connected');
  `);
  const profile = {
    profile: { name: 'locations/222', openStatus: 'OPEN', regularHours: {
      SUNDAY: [], MONDAY: [{ open: '11:00', close: '16:00' }], TUESDAY: [], WEDNESDAY: [],
      THURSDAY: [], FRIDAY: [], SATURDAY: [],
    }, specialHours },
  };
  sqlite.prepare(`INSERT INTO rt_google_profiles(store_id,location_name,profile_json,fingerprint,fetched_at)
    VALUES('store-1','accounts/111/locations/222',?,'fp','2026-09-01T00:00:00Z')`).run(JSON.stringify(profile));
}

test('Google営業時間へ移行しても時間帯ごとの既存定員を保持する', async () => {
  businessHour('morning', '10:00', '12:00', 2);
  businessHour('afternoon', '12:00', '15:00', 1);
  connectGoogleHours();
  const snapshot = await getStoreCapacitySnapshot(db, 'acc-1',
    new Date(`${MONDAY}T00:00:00+09:00`), new Date(`${MONDAY}T23:59:00+09:00`));
  expect(snapshot.windows.map(window => [window.start.slice(11, 16), window.end.slice(11, 16), window.capacity]))
    .toEqual([['02:00', '03:00', 2], ['03:00', '06:00', 1], ['06:00', '07:00', 1]]);
});

function booking(id: string, startsAt: string, endsAt: string): void {
  sqlite.prepare(
    `INSERT INTO bookings
       (id, line_account_id, friend_id, staff_id, menu_id, starts_at, ends_at, block_ends_at,
        status, price_at_booking, requested_at)
     VALUES (?, 'acc-1', 'fr-1', 'st-1', 'menu-1', ?, ?, ?, 'confirmed', 3000, '2026-09-01T00:00:00.000Z')`,
  ).run(id, startsAt, endsAt, endsAt);
}

async function slots(): Promise<Array<{ start: string; end: string }>> {
  const result = await getAvailability(db, {
    lineAccountId: 'acc-1', menuId: 'menu-1', from: MONDAY, to: MONDAY,
    now: NOW, minLeadTimeMinutes: 0,
  });
  return (result.by_staff[0]?.slots ?? []) as Array<{ start: string; end: string }>;
}

describe('営業時間が枠の開閉に効く（#748 / N-403）', () => {
  test('サロンもGoogleの通常営業時間を使い、手入力の営業時間は予約枠を広げない', async () => {
    businessHour('bh-1', '09:00', '18:00');
    connectGoogleHours();
    const starts = (await slots()).map(slot => slot.start);
    expect(starts[0]).toBe('11:00');
    expect(starts.at(-1)).toBe('15:00');
  });

  test('Googleの特別休業日は、手入力の営業曜日でも枠を閉じる', async () => {
    businessHour('bh-1', '09:00', '18:00');
    connectGoogleHours([{ date: MONDAY, closed: true, periods: [] }]);
    expect(await slots()).toEqual([]);
  });

  test('営業 10:00-17:00・勤務 09:00-18:00 なら、営業時間の外に枠を出さない', async () => {
    businessHour('bh-1', '10:00', '17:00');
    const list = await slots();
    const starts = list.map((s) => s.start);
    expect(starts.filter((t) => t < '10:00'), '開店前の枠を出さない').toEqual([]);
    expect(list.filter((s) => s.end > '17:00'), '閉店後へはみ出す枠を出さない').toEqual([]);
    // 60分のメニューなので、最後に始められるのは 16:00。
    expect(starts[0]).toBe('10:00');
    expect(starts[starts.length - 1]).toBe('16:00');
  });

  test('閉店時刻ちょうどに終わる枠は出す。またぐ枠は出さない（境界）', async () => {
    businessHour('bh-1', '10:00', '17:00');
    const list = await slots();
    expect(list.some((s) => s.start === '16:00' && s.end === '17:00'), '16:00-17:00 は出す').toBe(true);
    expect(list.some((s) => s.start === '16:30'), '16:30 開始（17:30 終了）は出さない').toBe(false);
    expect(list.some((s) => s.start === '17:00'), '閉店時刻ちょうど開始は出さない').toBe(false);
  });

  test('同じ曜日に複数行あれば、その間（昼休み）は閉じる', async () => {
    businessHour('bh-1', '10:00', '13:00');
    businessHour('bh-2', '14:00', '18:00');
    const starts = (await slots()).map((s) => s.start);
    expect(starts.includes('12:00'), '12:00-13:00 は営業内なので出す').toBe(true);
    expect(starts.some((t) => t >= '13:00' && t < '14:00'), '昼休みは出さない').toBe(false);
    expect(starts.includes('14:00'), '午後の営業は出す').toBe(true);
  });

  test('その曜日の営業時間が1件も無ければ、制限しない（既存の店を塞がない）', async () => {
    // 火曜だけ入れる。月曜には行が無い。
    sqlite.prepare(
      `INSERT INTO booking_business_hours (id, booking_settings_id, weekday, start_time, end_time, capacity)
       VALUES ('bh-tue', 'bs-1', 2, '10:00', '17:00', 1)`,
    ).run();
    const starts = (await slots()).map((s) => s.start);
    expect(starts[0], '勤務どおり 09:00 から出す').toBe('09:00');
    expect(starts[starts.length - 1], '勤務どおり 17:00 まで出す').toBe('17:00');
  });

  test('営業時間を明示設定した後は、0行の曜日を定休日として閉じる', async () => {
    sqlite.exec(`UPDATE booking_settings SET business_hours_configured = 1 WHERE id = 'bs-1'`);
    expect(await slots(), '月曜を0行で保存したので枠を出さない').toEqual([]);
  });

  test('臨時営業（例外日の open）は営業時間で切らない', async () => {
    businessHour('bh-1', '10:00', '17:00');
    sqlite.prepare(
      `INSERT INTO booking_availability_exceptions
         (id, line_account_id, scope_kind, scope_id, date_from, date_to, kind, hours_json)
       VALUES ('ex-1', 'acc-1', 'store', NULL, ?, ?, 'open', '[{"start":"18:00","end":"20:00"}]')`,
    ).run(MONDAY, MONDAY);
    const starts = (await slots()).map((s) => s.start);
    expect(starts.includes('18:00'), '日付を指定した臨時営業は営業時間の外でも出す').toBe(true);
    expect(starts.includes('09:00'), '通常の勤務のはみ出しは切る').toBe(false);
  });
});

describe('営業時間の定員が効く（#748）', () => {
  test('午前3・午後1は候補ごとに判定し、午後の定員で午前を消さない', async () => {
    businessHour('morning', '10:00', '13:00', 3);
    businessHour('afternoon', '13:00', '18:00', 1);
    booking('am', '2026-09-14T11:00:00+09:00', '2026-09-14T12:00:00+09:00');
    booking('pm', '2026-09-14T14:00:00+09:00', '2026-09-14T15:00:00+09:00');
    const result = await getAvailability(db, { lineAccountId: 'acc-1', menuId: 'menu-1',
      from: MONDAY, to: MONDAY, now: NOW, minLeadTimeMinutes: 0 });
    expect(result.by_staff[0].slots.find(s => s.start === '11:00')).toMatchObject({ capacity: 3, remaining: 2 });
    expect(result.by_staff[0].slots.some(s => s.start === '14:00')).toBe(false);
  });

  test('担当指定でも店舗定員は別担当・別メニューの予約を合算する', async () => {
    businessHour('store', '10:00', '17:00', 1);
    sqlite.exec(`INSERT INTO staff (id,line_account_id,name,display_name) VALUES ('st-2','acc-1','別担当','別担当');
      INSERT INTO menus (id,line_account_id,name,duration_minutes,base_price) VALUES ('menu-2','acc-1','別メニュー',60,1000);`);
    booking('other', '2026-09-14T11:00:00+09:00', '2026-09-14T12:00:00+09:00');
    sqlite.exec(`UPDATE bookings SET staff_id='st-2',menu_id='menu-2' WHERE id='other'`);
    const result = await getAvailability(db, { lineAccountId: 'acc-1', menuId: 'menu-1', staffId: 'st-1',
      from: MONDAY, to: MONDAY, now: NOW, minLeadTimeMinutes: 0 });
    expect(result.by_staff[0].slots.some(s => s.start === '11:00')).toBe(false);
    expect(result.by_staff[0].slots.some(s => s.start === '12:00')).toBe(true);
  });

  test('後片付けだけ午後の定員1に触れる候補も、午後の既存予約を避ける', async () => {
    businessHour('morning', '10:00', '13:00', 3);
    businessHour('afternoon', '13:00', '18:00', 1);
    sqlite.exec(`UPDATE menus SET buffer_after_minutes=30;
      INSERT INTO staff (id,line_account_id,name,display_name) VALUES ('st-2','acc-1','別担当','別担当');`);
    booking('other', '2026-09-14T13:00:00+09:00', '2026-09-14T14:00:00+09:00');
    sqlite.exec(`UPDATE bookings SET staff_id='st-2' WHERE id='other'`);
    expect((await slots()).some(s => s.start === '12:00')).toBe(false);
    expect((await slots()).some(s => s.start === '11:30')).toBe(true);
  });

  test('勤務が営業時間からはみ出していても、店舗の定員が効く', async () => {
    // 店舗の定員1、メニューの同時受付は5。勤務 09:00-18:00 は営業 10:00-17:00 をはみ出す。
    businessHour('bh-1', '10:00', '17:00', 1);
    booking('bk-1', '2026-09-14T11:00:00+09:00', '2026-09-14T12:00:00+09:00');
    const starts = (await slots()).map((s) => s.start);
    expect(starts.includes('11:00'), '定員1なら1件入った時点で 11:00 は消える').toBe(false);
  });

  test('定員2なら、1件入っても残る', async () => {
    businessHour('bh-1', '10:00', '17:00', 2);
    booking('bk-1', '2026-09-14T11:00:00+09:00', '2026-09-14T12:00:00+09:00');
    const starts = (await slots()).map((s) => s.start);
    expect(starts.includes('11:00'), '定員2なら1件では塞がらない').toBe(true);
  });

  test('曜日ごとに複数行あるときは、重なる行のうちいちばん厳しい定員を採る', async () => {
    businessHour('bh-1', '10:00', '13:00', 3);
    businessHour('bh-2', '13:00', '18:00', 1);
    booking('bk-1', '2026-09-14T14:00:00+09:00', '2026-09-14T15:00:00+09:00');
    const starts = (await slots()).map((s) => s.start);
    expect(starts.includes('14:00'), '午後は定員1なので1件で塞がる').toBe(false);
  });
});
