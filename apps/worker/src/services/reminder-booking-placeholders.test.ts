import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { buildReminderStepMessage } from './reminder-delivery.js';
import { validateReminderDraft } from './reminder-draft.js';
import type { ReminderDraftSettings, ReminderStepRow, ReminderVersionRow } from '@line-crm/db';

/*
 * F10: リマインダの差し込みに予約日時・Google Meet URLを足す。
 * 送る側で置き換え、公開前に「差し込みの値が空の人」を検査する。
 * 既存のF6・Meet送信版・lease・日時変更/取消ガードには触らない。
 */
const MEET_URL = 'https://meet.google.com/xxx-yyyy-zzz';
const STARTS_AT = '2026-10-10T10:00:00+09:00';

function seedBase(raw: SqliteD1['raw']): void {
  raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('account-1', 'channel-1', '店舗1', '', '', 1, 'tenant-1')`,
  ).run();
  insertFriend(raw, 'friend-10a', { line_account_id: 'account-1', display_name: '見本 141' });
  insertFriend(raw, 'friend-10b', { line_account_id: 'account-1', display_name: '見本 181' });
  raw.prepare(
    `INSERT INTO meet_consultations
      (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status)
     VALUES ('meet-1', 'event-1', 'friend-10a', '個別相談',
             '2026-10-10T01:00:00.000Z', '2026-10-10T01:30:00.000Z', ?, 'confirmed')`,
  ).run(MEET_URL);
}

function settingsWith(content: string, overrides: { lineAccountId?: string; targetTagId?: string } = {}): ReminderDraftSettings {
  return {
    name: '予約前のお知らせ',
    lineAccountId: overrides.lineAccountId ?? 'account-1',
    targetTagId: overrides.targetTagId ?? null,
    triggerType: 'booking',
    deliveryMode: 'time',
    stopConditions: {
      bookingCancelled: true,
      supportMarkCompleted: false,
      daysAfterTarget: null,
      friendBlocked: false,
    },
    steps: [{
      stableStepId: 'step-1',
      offsetDays: 1,
      sendAtTime: '10:00',
      offsetMinutes: 0,
      messageType: 'text',
      messageContent: content,
      templateId: null,
      targetCondition: {},
      action: {},
    }],
  } as unknown as ReminderDraftSettings;
}

const version = {
  id: 'version-10',
  reminder_id: 'reminder-10',
  version_number: 1,
  status: 'draft',
  settings_snapshot: '{}',
  last_test_status: 'succeeded',
  last_tested_at: '2026-10-01T10:00:00.000Z',
  last_tested_by_staff_id: 'staff-1',
  published_at: null,
  published_by_staff_id: null,
  created_at: '2026-10-01T09:00:00.000Z',
  updated_at: '2026-10-01T10:00:00.000Z',
} as unknown as ReminderVersionRow;

function stepRow(content: string): ReminderStepRow {
  return {
    id: 'step-10',
    reminder_id: 'reminder-10',
    offset_minutes: -60,
    message_type: 'text',
    message_content: content,
    created_at: '2026-10-01T09:00:00.000Z',
    offset_days: 1,
    send_at_time: '10:00',
    template_id: null,
  };
}

async function friendRow(db: D1Database, id: string) {
  const { getFriendById } = await import('@line-crm/db');
  const friend = await getFriendById(db, id);
  if (!friend) throw new Error(`friend not found: ${id}`);
  return friend;
}

describe('F10: 予約日時・Meet URLの差し込み', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    seedBase(testDb.raw);
  });

  it('送る側で予約日時とMeet URLに置き換わる', async () => {
    const built = await buildReminderStepMessage(
      testDb.db,
      stepRow('ご予約は{{reservation_datetime}}です。こちらから{{meet_url}}'),
      await friendRow(testDb.db, 'friend-10a'),
      new Date('2026-10-09T10:00:00+09:00'),
      'reminder',
    );
    expect(built.messageContent).toContain('10月10日');
    expect(built.messageContent).toContain('10:00');
    expect(built.messageContent).toContain(MEET_URL);
    expect(built.messageContent).not.toContain('{{');
  });

  it('予定が無い人には空で送りプレースホルダは残らない', async () => {
    const built = await buildReminderStepMessage(
      testDb.db,
      stepRow('ご予約は{{reservation_datetime}}です。こちらから{{meet_url}}'),
      await friendRow(testDb.db, 'friend-10b'),
      new Date('2026-10-09T10:00:00+09:00'),
      'reminder',
    );
    expect(built.messageContent).not.toContain('{{');
    expect(built.messageContent).not.toContain(MEET_URL);
  });

  it('公開前チェックは差し込みが空の人を落とす', async () => {
    const result = await validateReminderDraft(
      testDb.db,
      settingsWith('ご予約は{{reservation_datetime}}です。こちらから{{meet_url}}'),
      version,
    );
    expect(result.valid).toBe(false);
    const booking = result.checks.find((item) => item.key === 'booking_placeholders');
    expect(booking?.status).toBe('failed');
    expect(booking?.message).toContain('1人');
  });

  it('差し込みを使わなければ公開前チェックは通る', async () => {
    const result = await validateReminderDraft(
      testDb.db,
      settingsWith('予約の前日です'),
      version,
    );
    expect(result.valid).toBe(true);
  });

  it('全員に予定があれば公開前チェックは通る', async () => {
    testDb.raw.prepare(
      `INSERT INTO meet_consultations
        (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status)
       VALUES ('meet-2', 'event-2', 'friend-10b', '個別相談',
               '2026-10-11T01:00:00.000Z', '2026-10-11T01:30:00.000Z', ?, 'confirmed')`,
    ).run(MEET_URL);
    const result = await validateReminderDraft(
      testDb.db,
      settingsWith('ご予約は{{reservation_datetime}}です'),
      version,
    );
    expect(result.valid).toBe(true);
  });

  it('取消済みの予定は空扱いになる', async () => {
    testDb.raw.prepare(`UPDATE meet_consultations SET status = 'cancelled' WHERE id = 'meet-1'`).run();
    const built = await buildReminderStepMessage(
      testDb.db,
      stepRow('ご予約は{{reservation_datetime}}です'),
      await friendRow(testDb.db, 'friend-10a'),
      new Date('2026-10-09T10:00:00+09:00'),
      'reminder',
    );
    expect(built.messageContent).not.toContain('{{');
    expect(built.messageContent).not.toContain('10月10日');
  });

  it('公開前検査は無効な日時を持つ行を空扱いにする', async () => {
    // 直接書かれた壊れた行（正規登録では起きないが既存行に混ざりうる）。
    // もう1人は有効な予定を持つので、数えられるのは壊れた行の人だけになる。
    testDb.raw.prepare(`UPDATE meet_consultations SET starts_at = 'not-a-date' WHERE id = 'meet-1'`).run();
    testDb.raw.prepare(
      `INSERT INTO meet_consultations
        (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status)
       VALUES ('meet-2', 'event-2', 'friend-10b', '個別相談',
               '2026-10-11T01:00:00.000Z', '2026-10-11T01:30:00.000Z', ?, 'confirmed')`,
    ).run(MEET_URL);
    const result = await validateReminderDraft(
      testDb.db,
      settingsWith('ご予約は{{reservation_datetime}}です。こちらから{{meet_url}}'),
      version,
    );
    expect(result.valid).toBe(false);
    const booking = result.checks.find((item) => item.key === 'booking_placeholders');
    expect(booking?.status).toBe('failed');
  });

  it('公開前検査は空のMeet URLを行ごとに見る', async () => {
    testDb.raw.prepare(`UPDATE meet_consultations SET meet_url = '' WHERE id = 'meet-1'`).run();
    testDb.raw.prepare(
      `INSERT INTO meet_consultations
        (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status)
       VALUES ('meet-2', 'event-2', 'friend-10b', '個別相談',
               '2026-10-11T01:00:00.000Z', '2026-10-11T01:30:00.000Z', ?, 'confirmed')`,
    ).run(MEET_URL);
    // 両方の差し込みを使うときは空として数える。
    const both = await validateReminderDraft(
      testDb.db,
      settingsWith('ご予約は{{reservation_datetime}}です。こちらから{{meet_url}}'),
      version,
    );
    expect(both.valid).toBe(false);
    // 日時だけ使うときは空にならない（日時自体は有効）。
    const dateOnly = await validateReminderDraft(
      testDb.db,
      settingsWith('ご予約は{{reservation_datetime}}です'),
      version,
    );
    expect(dateOnly.valid).toBe(true);
  });

  it('送る側は無効な日時を飛ばし有効な予定を選ぶ', async () => {
    testDb.raw.prepare(
      `INSERT INTO meet_consultations
        (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status)
       VALUES ('meet-bad', 'event-bad', 'friend-10a', '壊れた予定',
               'not-a-date', 'not-a-date', '', 'confirmed')`,
    ).run();
    const built = await buildReminderStepMessage(
      testDb.db,
      stepRow('ご予約は{{reservation_datetime}}です。こちらから{{meet_url}}'),
      await friendRow(testDb.db, 'friend-10a'),
      new Date('2026-10-09T10:00:00+09:00'),
      'reminder',
    );
    expect(built.messageContent).toContain('10月10日');
    expect(built.messageContent).toContain(MEET_URL);
  });

  it('タグ絞りではタグの付いた人だけを数える', async () => {
    // friend-10b にタグを付ける（予定なし）。friend-10a は予定ありだがタグなし。
    testDb.raw.prepare(`INSERT INTO tags (id, name) VALUES ('tag-1', '会員')`).run();
    testDb.raw.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-10b', 'tag-1')`).run();
    const result = await validateReminderDraft(
      testDb.db,
      settingsWith('ご予約は{{reservation_datetime}}です', { targetTagId: 'tag-1' }),
      version,
    );
    expect(result.valid).toBe(false);
    const booking = result.checks.find((item) => item.key === 'booking_placeholders');
    expect(booking?.status).toBe('failed');
    expect(booking?.message).toContain('1人');
  });

  it('タグ絞りで全員に予定があれば通る', async () => {
    testDb.raw.prepare(`INSERT INTO tags (id, name) VALUES ('tag-1', '会員')`).run();
    testDb.raw.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-10b', 'tag-1')`).run();
    testDb.raw.prepare(
      `INSERT INTO meet_consultations
        (id, external_event_id, friend_id, title, starts_at, ends_at, meet_url, status)
       VALUES ('meet-2', 'event-2', 'friend-10b', '個別相談',
               '2026-10-11T01:00:00.000Z', '2026-10-11T01:30:00.000Z', ?, 'confirmed')`,
    ).run(MEET_URL);
    const result = await validateReminderDraft(
      testDb.db,
      settingsWith('ご予約は{{reservation_datetime}}です', { targetTagId: 'tag-1' }),
      version,
    );
    expect(result.valid).toBe(true);
  });

  it('タグ絞りでは別アカウントの人を数えない', async () => {
    testDb.raw.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES ('account-2', 'channel-2', '店舗2', '', '', 1, 'tenant-1')`,
    ).run();
    insertFriend(testDb.raw, 'friend-10c', { line_account_id: 'account-2', display_name: '他店の人' });
    testDb.raw.prepare(`INSERT INTO tags (id, name) VALUES ('tag-1', '会員')`).run();
    // 別アカウントの人にも同じタグを付ける（予定なし）。
    testDb.raw.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-10c', 'tag-1')`).run();
    // account-1 のタグ付きは予定ありの friend-10a だけにする。
    testDb.raw.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-10a', 'tag-1')`).run();
    const result = await validateReminderDraft(
      testDb.db,
      settingsWith('ご予約は{{reservation_datetime}}です', { targetTagId: 'tag-1' }),
      version,
    );
    // account-1 の届け先は予定ありだけなので通る（別アカウントは数えない）。
    expect(result.valid).toBe(true);
  });

  it('送る側は空のMeet URLを空文字にする', async () => {
    testDb.raw.prepare(`UPDATE meet_consultations SET meet_url = '' WHERE id = 'meet-1'`).run();
    const built = await buildReminderStepMessage(
      testDb.db,
      stepRow('ご予約は{{reservation_datetime}}です。こちらから[{{meet_url}}]'),
      await friendRow(testDb.db, 'friend-10a'),
      new Date('2026-10-09T10:00:00+09:00'),
      'reminder',
    );
    expect(built.messageContent).toContain('10月10日');
    expect(built.messageContent).toContain('こちらから[]');
    expect(built.messageContent).not.toContain('{{');
  });
});
