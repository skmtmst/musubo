/** テスト送信先は送る前に表示し、未設定と無効を区別する。実 route・認証・SQLite を使い、LINE の送信だけを差し替える。 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { authMiddleware } from '../middleware/auth.js';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const line = vi.hoisted(() => ({ pushMessageWithRequestId: vi.fn() }));
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushMessageWithRequestId = line.pushMessageWithRequestId;
  },
}));

const TENANT = 'tenant-1';
const ACC_A = 'acc-a';
const ACC_B = 'acc-b';
const KEY_OWNER = 'key-owner-aaa';
const KEY_STAFF_A = 'key-staff-aaa';
const KEY_STAFF_B = 'key-staff-bbb';
const KEY_STAFF_NOPERM = 'key-staff-noperm';
const KEY_ADMIN_A = 'key-admin-aaa';

const REMINDER_A = 'reminder-a';
const REMINDER_B = 'reminder-b';
const VERSION_A = 'version-a';
const VERSION_B = 'version-b';
const FRIEND_A = 'friend-a';
const FRIEND_B = 'friend-b';
const FRIEND_UNFOLLOWED = 'friend-unfollowed';
// REMINDER-12: 本人対応ありのadmin。友だち行はアカウントごと。
const FRIEND_SELF = 'friend-self';
const FRIEND_SELF_OTHER_ACCOUNT = 'friend-self-other-account';
const FRIEND_SELF_BLOCKED = 'friend-self-blocked';
const FRIEND_A2 = 'friend-a2';
const KEY_ADMIN_SELF = 'key-admin-self';
const KEY_ADMIN_SELF_OTHER = 'key-admin-self-other';
const KEY_ADMIN_SELF_BLOCKED = 'key-admin-self-blocked';

const IDEMPOTENCY_KEY = '123e4567-e89b-42d3-a456-426614174000';

function settingsSnapshot(lineAccountId: string): string {
  return JSON.stringify({
    name: '予約前のお知らせ',
    description: null,
    lineAccountId,
    triggerType: 'manual',
    deliveryMode: 'time',
    triggerFieldId: null,
    triggerEventId: null,
    repeatYearly: false,
    triggerOffsetMinutes: null,
    sendAtTime: null,
    targetTagId: null,
    folderId: null,
    stopConditions: {
      bookingCancelled: false,
      supportMarkCompleted: false,
      daysAfterTarget: null,
      friendBlocked: false,
    },
    steps: [
      {
        stableStepId: 'step-1',
        offsetMinutes: 0,
        messageType: 'text',
        messageContent: 'テスト本文です',
        offsetDays: null,
        sendAtTime: null,
        templateId: null,
        targetCondition: {},
        action: {},
      },
    ],
  });
}

function seed(sqlite: SqliteD1['raw']) {
  sqlite.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  for (const id of [ACC_A, ACC_B]) {
    sqlite.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
       VALUES (?, ?, ?, 'token', 'secret', 'tenant-1')`,
    ).run(id, `channel-${id}`, id);
  }
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
     VALUES ('owner-1', 'オーナー', 'owner', ?, 'tenant-1', 'all')`,
  ).run(KEY_OWNER);
  // /reminders 権限を持つ現場staff。見られるのは acc-a だけ。
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
     VALUES ('staff-a', '担当A', 'staff', ?, 'tenant-1', 'accounts', '["/reminders"]')`,
  ).run(KEY_STAFF_A);
  sqlite.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('staff-a', ?, '2026-09-01T00:00:00.000Z')`,
  ).run(ACC_A);
  // 同じ権限だが acc-b だけを見られるstaff。
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
     VALUES ('staff-b', '担当B', 'staff', ?, 'tenant-1', 'accounts', '["/reminders"]')`,
  ).run(KEY_STAFF_B);
  sqlite.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('staff-b', ?, '2026-09-01T00:00:00.000Z')`,
  ).run(ACC_B);
  // リマインダ権限を持たないstaff。認証middlewareの fail-closed が効くはず。
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
     VALUES ('staff-noperm', '権限なし', 'staff', ?, 'tenant-1', 'all')`,
  ).run(KEY_STAFF_NOPERM);
  // acc-a だけを見られる admin。requireRole は通るがアカウント範囲は狭い。
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
     VALUES ('admin-a', '管理A', 'admin', ?, 'tenant-1', 'accounts')`,
  ).run(KEY_ADMIN_A);
  sqlite.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('admin-a', ?, '2026-09-01T00:00:00.000Z')`,
  ).run(ACC_A);

  insertFriend(sqlite, FRIEND_A, { line_account_id: ACC_A, display_name: '見本 167' });
  insertFriend(sqlite, FRIEND_B, { line_account_id: ACC_B, display_name: '別アカウントの人' });
  insertFriend(sqlite, FRIEND_UNFOLLOWED, {
    line_account_id: ACC_A,
    display_name: 'ブロックした人',
    is_following: 0,
  });
  // REMINDER-12: LINE連携済みadminと、その本人の友だち行。
  insertFriend(sqlite, FRIEND_SELF, {
    line_account_id: ACC_A,
    line_user_id: 'U-self-linked',
    display_name: '連携済みの本人',
  });
  insertFriend(sqlite, FRIEND_SELF_OTHER_ACCOUNT, {
    line_account_id: ACC_B,
    line_user_id: 'U-self-other',
    display_name: '別アカウントの本人',
  });
  insertFriend(sqlite, FRIEND_SELF_BLOCKED, {
    line_account_id: ACC_A,
    line_user_id: 'U-self-blocked',
    display_name: 'ブロックした本人',
    is_following: 0,
  });
  insertFriend(sqlite, FRIEND_A2, { line_account_id: ACC_A, display_name: '登録宛先その2' });
  // 本人対応あり/別アカウントの本人/ブロック済みの本人の3通りを用意する。
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, line_user_id)
     VALUES ('admin-self', '本人管理', 'admin', ?, 'tenant-1', 'all', 'U-self-linked')`,
  ).run(KEY_ADMIN_SELF);
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, line_user_id)
     VALUES ('admin-self-other', '別店の本人', 'admin', ?, 'tenant-1', 'all', 'U-self-other')`,
  ).run(KEY_ADMIN_SELF_OTHER);
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, line_user_id)
     VALUES ('admin-self-blocked', 'ブロック本人', 'admin', ?, 'tenant-1', 'all', 'U-self-blocked')`,
  ).run(KEY_ADMIN_SELF_BLOCKED);

  for (const [id, versionId, accountId] of [
    [REMINDER_A, VERSION_A, ACC_A],
    [REMINDER_B, VERSION_B, ACC_B],
  ] as const) {
    sqlite.prepare(
      `INSERT INTO reminders (id, name, line_account_id, trigger_type, lifecycle_status, current_draft_version_id)
       VALUES (?, ?, ?, 'manual', 'draft', ?)`,
    ).run(id, `リマインダ${id}`, accountId, versionId);
    sqlite.prepare(
      `INSERT INTO reminder_versions
        (id, reminder_id, version_number, status, settings_snapshot, created_at, updated_at)
       VALUES (?, ?, 1, 'draft', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(versionId, id, settingsSnapshot(accountId));
    sqlite.prepare(
      `INSERT INTO reminder_version_steps
        (id, reminder_version_id, stable_step_id, position, offset_minutes,
         message_type, message_content, created_at)
       VALUES (?, ?, 'step-1', 0, 0, 'text', 'テスト本文です', '2026-09-01T00:00:00.000Z')`,
    ).run(`vstep-${id}`, versionId);
  }
}

function setTestRecipients(sqlite: SqliteD1['raw'], accountId: string, friendIds: string[]) {
  sqlite.prepare(`DELETE FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`)
    .run(accountId);
  if (friendIds.length > 0) {
    sqlite.prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value)
       VALUES (?, ?, 'test_recipients', ?)`,
    ).run(`setting-${accountId}`, accountId, JSON.stringify(friendIds));
  }
}

let sqlite: SqliteD1;
let remindersRoute: Awaited<typeof import('./reminders.js')>['reminders'];

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', remindersRoute);
  return instance;
}

const env = () => ({ DB: sqlite.db }) as unknown as Env['Bindings'];

function getRecipient(reminderId: string, apiKey: string) {
  return app().request(`/api/reminders/${reminderId}/test-recipient`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, env());
}

function testSend(reminderId: string, apiKey: string, key = IDEMPOTENCY_KEY) {
  return app().request(`/api/reminders/${reminderId}/test-send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Idempotency-Key': key },
  }, env());
}

beforeEach(async () => {
  line.pushMessageWithRequestId.mockReset().mockResolvedValue({ requestId: 'req-1' });
  sqlite = createTestD1({ loginPolicy: 'off' });
  seed(sqlite.raw);
  ({ reminders: remindersRoute } = await import('./reminders.js'));
});

describe('テスト送信先の事前表示 (N-070)', () => {
  test('未設定なら unset を返す', async () => {
    const res = await getRecipient(REMINDER_A, KEY_OWNER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { state: 'unset', recipient: null, recipientKind: null },
    });
  });

  test('設定済みの送信先を名前つきで返す', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_A]);
    const res = await getRecipient(REMINDER_A, KEY_OWNER);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { state: string; recipient: { id: string; displayName: string }; recipientKind: string };
    };
    expect(body.data.state).toBe('ready');
    expect(body.data.recipient).toMatchObject({ id: FRIEND_A, displayName: '見本 167' });
    // owner は LINE未連携なので、届くのは「登録済みテスト宛先」。
    expect(body.data.recipientKind).toBe('registered');
  });

  test('設定先が別アカウントの友だちなら unavailable を返す', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_B]);
    const res = await getRecipient(REMINDER_A, KEY_OWNER);
    const body = await res.json() as { data: { state: string; recipient: unknown } };
    expect(body.data.state).toBe('unavailable');
    expect(body.data.recipient).toBeNull();
  });

  test('設定先がブロック済みなら unavailable を返す', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_UNFOLLOWED]);
    const res = await getRecipient(REMINDER_A, KEY_OWNER);
    const body = await res.json() as { data: { state: string } };
    expect(body.data.state).toBe('unavailable');
  });

  test('存在しない下書きは 404', async () => {
    const res = await getRecipient('missing', KEY_OWNER);
    expect(res.status).toBe(404);
  });

  test('アカウント範囲外の下書きは送信先を返さない', async () => {
    setTestRecipients(sqlite.raw, ACC_B, [FRIEND_B]);
    // staff-a は acc-a しか見られない。acc-b の下書きを指しても 404。
    const res = await getRecipient(REMINDER_B, KEY_STAFF_A);
    expect(res.status).toBe(404);
    // acc-a の自分の範囲なら読める。
    const own = await getRecipient(REMINDER_A, KEY_STAFF_A);
    expect(own.status).toBe(200);
  });

  test('下書きの設定が別アカウントを指すときは、そのアカウントの送信先を返さない', async () => {
    // reminder行はacc-aだが、下書きスナップショットの送信先アカウントがacc-b。
    // requireVisibleReminder は reminder行しか見ないので、設定側の境界は
    // このルート自身が守る。
    setTestRecipients(sqlite.raw, ACC_B, [FRIEND_B]);
    sqlite.raw.prepare(
      `UPDATE reminder_versions SET settings_snapshot = ? WHERE id = ?`,
    ).run(settingsSnapshot(ACC_B), VERSION_A);
    // acc-aだけ見られる admin-a は、acc-b の送信先を読めない。
    const res = await getRecipient(REMINDER_A, KEY_ADMIN_A);
    expect(res.status).toBe(404);
    // 全アカウントを見られる owner なら読める（acc-b の送信先が返る）。
    const visible = await getRecipient(REMINDER_A, KEY_OWNER);
    expect(visible.status).toBe(200);
    const body = await visible.json() as { data: { state: string } };
    expect(body.data.state).toBe('ready');
  });

  test('/reminders 権限のない staff には開かない', async () => {
    const res = await getRecipient(REMINDER_A, KEY_STAFF_NOPERM);
    expect(res.status).toBe(403);
  });
});

describe('テスト送信の失敗と回復 (N-070)', () => {
  test('未設定での送信は未設定として区別できる 422 を返す', async () => {
    const res = await testSend(REMINDER_A, KEY_OWNER);
    expect(res.status).toBe(422);
    const body = await res.json() as { success: boolean; code: string };
    expect(body.success).toBe(false);
    expect(body.code).toBe('TEST_RECIPIENT_NOT_CONFIGURED');
  });

  test('設定先が届かないときは別の code の 422 を返す', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_B]);
    const res = await testSend(REMINDER_A, KEY_OWNER);
    expect(res.status).toBe(422);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('TEST_RECIPIENT_NOT_AVAILABLE');
  });

  test('設定後は同じ口から送信でき、同じキーの再送は再生扱いになる', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_A]);
    const first = await testSend(REMINDER_A, KEY_OWNER);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { data: { replayed: boolean; recipientName: string } };
    expect(firstBody.data.replayed).toBe(false);
    expect(firstBody.data.recipientName).toBe('見本 167');
    expect(line.pushMessageWithRequestId).toHaveBeenCalledTimes(1);

    // 同じ Idempotency-Key の再送は二重送信せず再生として返す。
    const second = await testSend(REMINDER_A, KEY_OWNER);
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { data: { replayed: boolean } };
    expect(secondBody.data.replayed).toBe(true);
    expect(line.pushMessageWithRequestId).toHaveBeenCalledTimes(1);
  });

  test.each(['unknown','in_progress'])('SEND-S02仲間: %sの古い試し送りはLINEへ進まない', async status => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_A]);
    expect((await testSend(REMINDER_A, KEY_OWNER)).status).toBe(200);
    sqlite.raw.prepare("UPDATE outbound_send_requests SET status=?,response_id=NULL,created_at='2020-01-01T00:00:00Z',lease_token='lost',failure_code='DELIVERY_UNKNOWN',last_failed_at='2020-01-01T00:00:00Z'").run(status);
    const recovered = await testSend(REMINDER_A, KEY_OWNER);
    expect(recovered.status).toBeGreaterThanOrEqual(400);
    expect(line.pushMessageWithRequestId).toHaveBeenCalledTimes(1);
  });

  test('アカウント範囲外の下書きへは送信できない', async () => {
    setTestRecipients(sqlite.raw, ACC_B, [FRIEND_B]);
    // 編集権限があっても担当外アカウントは隠す。
    const staffDenied = await testSend(REMINDER_B, KEY_STAFF_A);
    expect(staffDenied.status).toBe(404);
    // acc-a だけの admin は role を通っても acc-b の下書きには届かない。
    const outOfScope = await testSend(REMINDER_B, KEY_ADMIN_A);
    expect(outOfScope.status).toBe(404);
    expect(line.pushMessageWithRequestId).not.toHaveBeenCalled();
  });
});

/*
 * REMINDER-12: 「自分のLINEへ」と案内しながら登録済みテスト宛先へ
 * 送っていた取り違えの回帰。
 * - LINE連携済みの操作者だけが本人宛て（self）になる。
 * - 連携が無い・別アカウント・ブロック済みなら本人を名乗らず登録宛先へ倒す。
 * - 画面に出した届け先と実際にPushした line_user_id が必ず一致する。
 */
describe('本人宛てと登録宛先の区別 (REMINDER-12)', () => {
  test('LINE連携済みの操作者には登録宛先より本人を優先して返す', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_A]);
    const res = await getRecipient(REMINDER_A, KEY_ADMIN_SELF);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { state: string; recipientKind: string; recipient: { id: string; displayName: string } };
    };
    expect(body.data.state).toBe('ready');
    expect(body.data.recipientKind).toBe('self');
    expect(body.data.recipient).toMatchObject({ id: FRIEND_SELF, displayName: '連携済みの本人' });
  });

  test('本人対応が別アカウントにあるだけなら本人を名乗らず登録宛先を使う', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_A]);
    const res = await getRecipient(REMINDER_A, KEY_ADMIN_SELF_OTHER);
    const body = await res.json() as { data: { recipientKind: string; recipient: { id: string } } };
    expect(body.data.recipientKind).toBe('registered');
    expect(body.data.recipient.id).toBe(FRIEND_A);
  });

  test('本人がこのアカウントをブロック中なら本人宛てを無効化し登録宛先を使う', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_A]);
    const res = await getRecipient(REMINDER_A, KEY_ADMIN_SELF_BLOCKED);
    const body = await res.json() as { data: { recipientKind: string; recipient: { id: string } } };
    expect(body.data.recipientKind).toBe('registered');
    expect(body.data.recipient.id).toBe(FRIEND_A);
  });

  test('LINE未連携の操作者は本人を名乗れず、登録宛先が複数あっても先頭だけを使う', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_A, FRIEND_A2]);
    const res = await getRecipient(REMINDER_A, KEY_OWNER);
    const body = await res.json() as {
      data: { recipientKind: string; recipient: { id: string; displayName: string } };
    };
    expect(body.data.recipientKind).toBe('registered');
    expect(body.data.recipient).toMatchObject({ id: FRIEND_A, displayName: '見本 167' });
  });

  test('本人連携がある操作者のテスト送信は本人のline_user_idへ届く', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_A]);
    const res = await testSend(REMINDER_A, KEY_ADMIN_SELF);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { recipientName: string; recipientKind: string; replayed: boolean };
    };
    expect(body.data).toMatchObject({
      recipientName: '連携済みの本人',
      recipientKind: 'self',
      replayed: false,
    });
    // 表示した届け先と実際のPush先が一致する。
    expect(line.pushMessageWithRequestId.mock.calls[0][0]).toBe('U-self-linked');
  });

  test('登録宛先へのテスト送信は事前表示した宛先と同じline_user_idへ届く', async () => {
    setTestRecipients(sqlite.raw, ACC_A, [FRIEND_A]);
    const preview = await getRecipient(REMINDER_A, KEY_OWNER);
    const shown = (await preview.json() as {
      data: { recipientKind: string; recipient: { id: string } };
    }).data;
    const res = await testSend(REMINDER_A, KEY_OWNER);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { recipientName: string; recipientKind: string } };
    expect(body.data.recipientKind).toBe('registered');
    expect(body.data.recipientName).toBe('見本 167');
    // 事前表示で返した友だちと同じ line_user_id にPushされた。
    expect(shown.recipient.id).toBe(FRIEND_A);
    expect(line.pushMessageWithRequestId.mock.calls[0][0]).toBe(`U${FRIEND_A}`);
  });
});
