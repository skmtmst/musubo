/**
 *  回帰テスト (5件目): イベント枠の日程変更は、枠更新より先に を移す。
 *
 * 枠を先に更新すると、の初回 batch 失敗後の同一リクエスト再送で
 * 旧起点が分からなくなり (old === new で reschedule を飛ばす)、
 * 移行前の行が旧日の active のまま残る。先行なら失敗時は枠が untouched
 * のまま 500 になるため、再送がそのまま回復になる。
 *
 * 本物の SQLite (createTestD1) に Hono ルートを載せて確かめる。
 * 外部 LINE・Calendar へは送らない。
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../worker-env.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';

const accountAccessMocks = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(async () => true),
}));
vi.mock('../services/account-access.js', () => accountAccessMocks);

// 通知の外部送信は抑える (連動の検証が目的)。
const notifierMocks = vi.hoisted(() => ({ sendEventBookingNotification: vi.fn(async () => {}) }));
vi.mock('../services/event-booking-notifier.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../services/event-booking-notifier.js')>(), ...notifierMocks }));

const { default: events } = await import('./events.js');

const OLD_STARTS_AT = '2026-09-20T01:00:00.000Z';
const OLD_ENDS_AT = '2026-09-20T02:00:00.000Z';
const NEW_STARTS_AT = '2026-09-20T03:00:00.000Z';
const NEW_ENDS_AT = '2026-09-20T04:00:00.000Z';

function seed(raw: import('better-sqlite3').Database): void {
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('account-1', 'channel-1', '本店', 'token', 'secret')`,
  ).run();
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following)
     VALUES ('friend-1', 'U-friend-1', '田中さくら', 'account-1', 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO events (id, line_account_id, name, target_type)
     VALUES ('ev-1', 'account-1', '体験会', 'single')`,
  ).run();
  raw.prepare(
    `INSERT INTO event_slots (id, event_id, starts_at, ends_at)
     VALUES ('slot-1', 'ev-1', ?, ?)`,
  ).run(OLD_STARTS_AT, OLD_ENDS_AT);
  raw.prepare(
    `INSERT INTO event_bookings
       (id, line_account_id, event_id, slot_id, friend_id, status, requested_at)
     VALUES ('eb-1', 'account-1', 'ev-1', 'slot-1', 'friend-1', 'confirmed', '2026-09-01T00:00:00.000Z')`,
  ).run();
  raw.prepare(
    `INSERT INTO reminders
       (id, name, line_account_id, is_active, trigger_type, delivery_mode, lifecycle_status)
     VALUES ('rule-event-1', 'rule', 'account-1', 1, 'event', 'countdown', 'published')`,
  ).run();
  raw.prepare(
    `INSERT INTO reminder_steps
       (id, reminder_id, offset_minutes, message_type, message_content)
     VALUES ('step-rule-event-1', 'rule-event-1', -60, 'text', 'お待ちしています')`,
  ).run();
  // 移行前の行 (source 未記録)。旧起点のまま残ると旧日程で送られる。
  raw.prepare(
    `INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status)
     VALUES ('legacy-1', 'friend-1', 'rule-event-1', ?, 'active')`,
  ).run(OLD_STARTS_AT);
}

function seedTwoBookings(raw: import('better-sqlite3').Database): void {
  seed(raw);
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following)
     VALUES ('friend-2', 'U-friend-2', '佐藤たろう', 'account-1', 1)`,
  ).run();
  raw.prepare(
    `INSERT INTO event_bookings
       (id, line_account_id, event_id, slot_id, friend_id, status, requested_at)
     VALUES ('eb-2', 'account-1', 'ev-1', 'slot-1', 'friend-2', 'confirmed', '2026-09-01T00:00:00.000Z')`,
  ).run();
  raw.prepare(
    `INSERT INTO friend_reminders (id, friend_id, reminder_id, target_date, status)
     VALUES ('legacy-2', 'friend-2', 'rule-event-1', ?, 'active')`,
  ).run(OLD_STARTS_AT);
}

function makeApp(db: D1Database) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '担当者', role: 'owner', readOnly: false });
    return next();
  });
  app.route('/', events);
  return { app, env: { DB: db } };
}

async function putSlot(app: Hono<Env>, env: { DB: D1Database }) {
  return app.request('/api/events/admin/events/ev-1/slots/slot-1?account_id=account-1', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ starts_at: NEW_STARTS_AT, ends_at: NEW_ENDS_AT, expected_version: 1 }),
  }, env);
}

describe('イベント枠の日程変更の再送可能性', () => {
  it('イベント予約の承認・取消・編集では確認版がそれぞれ1進む', async () => {
    const { db, raw } = createTestD1(); seed(raw); const { app, env } = makeApp(db);
    raw.prepare("UPDATE event_bookings SET status='requested' WHERE id='eb-1'").run();
    const url='/api/events/admin/events/ev-1/bookings/eb-1';
    const revision=()=>(raw.prepare("SELECT confirmation_revision FROM event_bookings WHERE id='eb-1'").get() as {confirmation_revision:number}).confirmation_revision;
    const before=revision();
    expect((await app.request(url+'/decide?account_id=account-1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'confirm'})},env)).status).toBe(200);
    expect(revision()).toBe(before+1);
    expect((await app.request(url+'?account_id=account-1',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({internal_note:'変更'})},env)).status).toBe(200);
    expect(revision()).toBe(before+2);
    expect((await app.request(url+'/cancel?account_id=account-1',{method:'POST'},env)).status).toBe(200);
    expect(revision()).toBe(before+3);
  });

  it('初回失敗では枠を変えず、同一リクエスト再送でlegacy行も新日時へ直る', async () => {
    const { db, raw } = createTestD1();
    seed(raw);
    const { app, env } = makeApp(db);

    // の書き込みだけ落とす失敗注入 (枠更新は通る状態)。
    raw.exec(
      `CREATE TRIGGER v6_update_fail BEFORE UPDATE ON friend_reminders
       BEGIN SELECT RAISE(ABORT, 'injected-v6-failure'); END;`,
    );
    const failed = await putSlot(app, env);
    expect(failed.status).toBe(500);

    // 枠は untouched のまま (再送で旧起点が分かる)。
    expect(
      raw.prepare(`SELECT starts_at FROM event_slots WHERE id = 'slot-1'`).get(),
    ).toEqual({ starts_at: OLD_STARTS_AT });
    expect(
      raw.prepare(`SELECT target_date, status FROM friend_reminders WHERE id = 'legacy-1'`).get(),
    ).toEqual({ target_date: OLD_STARTS_AT, status: 'active' });

    // 同じリクエストの再送で回復する。
    raw.exec(`DROP TRIGGER v6_update_fail`);
    const retried = await putSlot(app, env);
    expect(retried.status).toBe(200);
    expect(
      raw.prepare(`SELECT starts_at FROM event_slots WHERE id = 'slot-1'`).get(),
    ).toEqual({ starts_at: NEW_STARTS_AT });
    expect(
      raw.prepare(`SELECT target_date, status FROM friend_reminders WHERE id = 'legacy-1'`).get(),
    ).toEqual({ target_date: NEW_STARTS_AT, status: 'active' });
  });

  it('落選ずみへの却下の再送は修復を受け付けて200 (N-065)', async () => {
    const { db, raw } = createTestD1();
    seed(raw);
    const { app, env } = makeApp(db);

    // 状態だけ先に落選ずみで、が旧起点に残った壊れ方 (初回の 失敗相当)。
    raw.prepare(`UPDATE event_bookings SET status = 'rejected', decided_at = ? WHERE id = 'eb-1'`)
      .run('2026-09-01T00:00:00.000Z');

    // 却下の再送は修復を受け付ける (従来は decided ずみで 409 のまま)。
    const repaired = await app.request(
      '/api/events/admin/events/ev-1/bookings/eb-1/decide?account_id=account-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject' }),
      },
      env,
    );
    expect(repaired.status).toBe(200);
    // 未送信予定だけ止まり、日付は動かさない。
    expect(
      raw.prepare(`SELECT target_date, status FROM friend_reminders WHERE id = 'legacy-1'`).get(),
    ).toEqual({ target_date: OLD_STARTS_AT, status: 'cancelled' });

    // 落選ずみへの承認は競合敗北として 409 (200 で成功に見せない)。
    const conflicted = await app.request(
      '/api/events/admin/events/ev-1/bookings/eb-1/decide?account_id=account-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm' }),
      },
      env,
    );
    expect(conflicted.status).toBe(409);
  });

  it('却下の送信権貸出中は状態を巻き戻して409にし、再試行で落選できる', async () => {
    const { db, raw } = createTestD1();
    seed(raw);
    raw.prepare(`UPDATE event_bookings SET status = 'requested' WHERE id = 'eb-1'`).run();
    // 送信権の貸出中 (この予約の通知の送信が動いている)。
    raw.prepare(
      `INSERT INTO friend_reminders
         (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id)
       VALUES ('src-1', 'friend-1', 'rule-event-1', ?, 'active', 'event', 'eb-1', 'eb-1')`,
    ).run(OLD_STARTS_AT);
    raw.prepare(
      `INSERT INTO reminder_delivery_runs (
         id, line_account_id, reminder_id, friend_reminder_id, friend_id,
         reminder_step_id, scheduled_at, idempotency_key, line_retry_key,
         status, lease_expires_at, created_at, updated_at
       ) VALUES (
         'RUN-ev-1','account-1','rule-event-1','src-1','friend-1',
         'step-rule-event-1',?,'idem-ev-1','retry-ev-1',
         'claimed','2099-01-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'
       )`,
    ).run(OLD_STARTS_AT);
    const { app, env } = makeApp(db);
    const decide = () => app.request(
      '/api/events/admin/events/ev-1/bookings/eb-1/decide?account_id=account-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject' }),
      },
      env,
    );
    // 貸出中は落選を確定させず 409。状態も巻き戻る (取消確定後の送信を起こさない)。
    const conflicted = await decide();
    expect(conflicted.status).toBe(409);
    expect(raw.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-1'`).get()).toEqual({
      status: 'requested',
    });
    expect(raw.prepare(`SELECT status FROM friend_reminders WHERE id = 'src-1'`).get()).toEqual({
      status: 'active',
    });
    // 送信が終われば再試行で落選し、未送信予定が止まる。
    raw.prepare(
      `UPDATE reminder_delivery_runs SET status = 'succeeded', lease_expires_at = NULL WHERE id = 'RUN-ev-1'`,
    ).run();
    const retried = await decide();
    expect(retried.status).toBe(200);
    expect(raw.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-1'`).get()).toEqual({
      status: 'rejected',
    });
    expect(raw.prepare(`SELECT status FROM friend_reminders WHERE id = 'src-1'`).get()).toEqual({
      status: 'cancelled',
    });
  });

  it('取消の送信権貸出中は状態を巻き戻して409にし、再試行で取消せる', async () => {
    const { db, raw } = createTestD1();
    seed(raw);
    raw.prepare(
      `INSERT INTO friend_reminders
         (id, friend_id, reminder_id, target_date, status, source_kind, source_id, source_event_id)
       VALUES ('src-1', 'friend-1', 'rule-event-1', ?, 'active', 'event', 'eb-1', 'eb-1')`,
    ).run(OLD_STARTS_AT);
    raw.prepare(
      `INSERT INTO reminder_delivery_runs (
         id, line_account_id, reminder_id, friend_reminder_id, friend_id,
         reminder_step_id, scheduled_at, idempotency_key, line_retry_key,
         status, lease_expires_at, created_at, updated_at
       ) VALUES (
         'RUN-ev-1','account-1','rule-event-1','src-1','friend-1',
         'step-rule-event-1',?,'idem-ev-1','retry-ev-1',
         'claimed','2099-01-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z'
       )`,
    ).run(OLD_STARTS_AT);
    const { app, env } = makeApp(db);
    const cancel = () => app.request(
      '/api/events/admin/events/ev-1/bookings/eb-1/cancel?account_id=account-1',
      { method: 'POST' },
      env,
    );
    const conflicted = await cancel();
    expect(conflicted.status).toBe(409);
    expect(raw.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-1'`).get()).toEqual({
      status: 'confirmed',
    });
    expect(raw.prepare(`SELECT status FROM friend_reminders WHERE id = 'src-1'`).get()).toEqual({
      status: 'active',
    });
    raw.prepare(
      `UPDATE reminder_delivery_runs SET status = 'succeeded', lease_expires_at = NULL WHERE id = 'RUN-ev-1'`,
    ).run();
    const retried = await cancel();
    expect(retried.status).toBe(200);
    expect(raw.prepare(`SELECT status FROM event_bookings WHERE id = 'eb-1'`).get()).toEqual({
      status: 'cancelled',
    });
    expect(raw.prepare(`SELECT status FROM friend_reminders WHERE id = 'src-1'`).get()).toEqual({
      status: 'cancelled',
    });
  });

  it('2件目の失敗では1件目を旧起点へ戻し、枠は変えず再送で全件直る', async () => {
    const { db, raw } = createTestD1();
    seedTwoBookings(raw);
    const { app, env } = makeApp(db);

    // 2件目の行だけ落とす失敗注入 (1件目は通る)。
    raw.exec(
      `CREATE TRIGGER v6_second_fail BEFORE UPDATE ON friend_reminders
       WHEN OLD.id = 'legacy-2'
       BEGIN SELECT RAISE(ABORT, 'injected-second-failure'); END;`,
    );
    const failed = await putSlot(app, env);
    expect(failed.status).toBe(500);

    // 枠は untouched、1件目は補償で旧起点へ戻り、2件目も旧日のまま。
    expect(
      raw.prepare(`SELECT starts_at FROM event_slots WHERE id = 'slot-1'`).get(),
    ).toEqual({ starts_at: OLD_STARTS_AT });
    expect(
      raw.prepare(`SELECT target_date, status FROM friend_reminders WHERE id = 'legacy-1'`).get(),
    ).toEqual({ target_date: OLD_STARTS_AT, status: 'active' });
    expect(
      raw.prepare(`SELECT target_date, status FROM friend_reminders WHERE id = 'legacy-2'`).get(),
    ).toEqual({ target_date: OLD_STARTS_AT, status: 'active' });

    // 同じリクエストの再送で両件とも新日時へ直る。
    raw.exec(`DROP TRIGGER v6_second_fail`);
    const retried = await putSlot(app, env);
    expect(retried.status).toBe(200);
    expect(
      raw.prepare(`SELECT starts_at FROM event_slots WHERE id = 'slot-1'`).get(),
    ).toEqual({ starts_at: NEW_STARTS_AT });
    expect(
      raw.prepare(`SELECT target_date FROM friend_reminders WHERE id IN ('legacy-1', 'legacy-2') ORDER BY id`).all(),
    ).toEqual([
      { target_date: NEW_STARTS_AT },
      { target_date: NEW_STARTS_AT },
    ]);
  });
});
