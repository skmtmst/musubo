/*
 *  「検証済みメアド・電話」の照合には検証の裏付けが要る。
 *
 * ここで止めたい崩れ方:
 *   - users.email / users.phone は「その人のものと確認した」記録を持たない。
 *     その値だけで「検証済み」として結び付けると、名乗っただけの外部の届物を
 *     本物の友だちへ誤って結び付ける。
 *   - 検証の裏付けは、統合ユーザー機能で運用者が「確認済み」と印を付けた
 *     採用値（user_profile_values.verified_at が立っている行）だけ。
 *
 * 実 SQLite（本物の bootstrap.sql）に当てる。JOIN そのものが仕様なので
 * 手書きモックでは意味がない。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestD1, insertFriend, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { executeIncomingWebhookActions, previewIncomingWebhook } from './incoming-webhook-actions.js';

const ACCOUNT = 'account-1';
const NOW = '2026-11-02T03:00:00.000Z';

function seed(db: SqliteD1): void {
  db.raw.prepare(
    `INSERT INTO tenants (id, name) VALUES ('tenant-1', '本部')`,
  ).run();
  db.raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
     VALUES ('${ACCOUNT}', 'channel-1', '店舗1', 'token-1', 'secret-1', 1, 'tenant-1')`,
  ).run();
  db.raw.prepare(
    `INSERT INTO incoming_webhooks (id, name, line_account_id, is_active, created_at, updated_at)
     VALUES ('iwh-1', 'EC基盤', '${ACCOUNT}', 1, '${NOW}', '${NOW}')`,
  ).run();
}

function addUser(
  db: SqliteD1,
  id: string,
  attrs: { email?: string | null; phone?: string | null; externalId?: string | null } = {},
): void {
  db.raw.prepare(
    `INSERT INTO users (id, email, phone, external_id, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'tenant-1', '${NOW}', '${NOW}')`,
  ).run(id, attrs.email ?? null, attrs.phone ?? null, attrs.externalId ?? null);
}

/**
 * 統合ユーザーの採用値。verifiedAt を渡すと「運用者が確認済み」の印が付く
 * （merged-person の画面で出る「確認済み」と同じ場所）。
 */
function addProfileValue(
  db: SqliteD1,
  input: { userId: string; fieldKey: string; value: string; verifiedAt?: string | null },
): void {
  db.raw.prepare(
    `INSERT INTO user_profile_values (
       id, tenant_id, user_id, field_key, field_label, value_json, value_preview,
       source_type, source_label, selected_by_name, selected_at, update_mode,
       is_active, verified_at, created_at, updated_at
     ) VALUES (?, 'tenant-1', ?, ?, ?, ?, ?, 'manual', '手で登録', '担当者', ?, 'fixed', 1, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), input.userId, input.fieldKey, input.fieldKey,
    JSON.stringify(input.value), input.value, NOW, input.verifiedAt ?? null, NOW, NOW,
  );
}

async function resolveViaWebhook(
  db: SqliteD1,
  kind: 'harness_friend_id' | 'external_customer_id' | 'verified_email' | 'verified_phone',
  path: string,
  payload: unknown,
): Promise<{ matchedFriendId: string | null; matchStatus: string }> {
  // actions は空でも「見つからなかったら箱へ置く」にすると照合が走る。
  return executeIncomingWebhookActions(db.db, {
    lineAccountId: ACCOUNT,
    webhookId: 'iwh-1',
    sourceEventId: crypto.randomUUID(),
    payload,
    identityMatching: { methods: [{ kind, path }], onNotFound: 'unmatched_box' },
    actions: [],
  });
}

describe('N-377: 検証済みメアド・電話の照合には検証の裏付けが要る', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    seed(testDb);
  });

  it('確認済みの採用値がある人にはメールアドレスで結び付く', async () => {
    addUser(testDb, 'user-1', { email: 'owner@example.com' });
    insertFriend(testDb.raw, 'friend-1', { line_account_id: ACCOUNT, user_id: 'user-1' });
    addProfileValue(testDb, {
      userId: 'user-1', fieldKey: 'email', value: 'Owner@example.com', verifiedAt: NOW,
    });

    const result = await resolveViaWebhook(
      testDb, 'verified_email', '$.email', { email: 'owner@example.com' },
    );
    expect(result.matchedFriendId).toBe('friend-1');
  });

  it('users.email だけ一致しても検証の裏付けが無ければ結び付けない', async () => {
    // 旧来の照合はこれで結び付いていた。裏付けのない値は「検証済み」を名乗れない。
    addUser(testDb, 'user-1', { email: 'owner@example.com' });
    insertFriend(testDb.raw, 'friend-1', { line_account_id: ACCOUNT, user_id: 'user-1' });

    const result = await resolveViaWebhook(
      testDb, 'verified_email', '$.email', { email: 'owner@example.com' },
    );
    expect(result.matchedFriendId).toBeNull();
    // 黙って捨てず、人が確かめる箱へ届く。
    expect(
      testDb.raw.prepare(`SELECT COUNT(*) AS n FROM incoming_webhook_unmatched_events`).get(),
    ).toEqual({ n: 1 });
  });

  it('採用値があっても未確認（verified_at なし）なら結び付けない', async () => {
    addUser(testDb, 'user-1', { email: 'owner@example.com' });
    insertFriend(testDb.raw, 'friend-1', { line_account_id: ACCOUNT, user_id: 'user-1' });
    addProfileValue(testDb, {
      userId: 'user-1', fieldKey: 'email', value: 'owner@example.com', verifiedAt: null,
    });

    const result = await resolveViaWebhook(
      testDb, 'verified_email', '$.email', { email: 'owner@example.com' },
    );
    expect(result.matchedFriendId).toBeNull();
  });

  it('確認済みの電話番号は表記揺れ（+81/0始まり）を揃えて結び付く', async () => {
    addUser(testDb, 'user-1', { phone: '09000005678' });
    insertFriend(testDb.raw, 'friend-1', { line_account_id: ACCOUNT, user_id: 'user-1' });
    addProfileValue(testDb, {
      userId: 'user-1', fieldKey: 'phone', value: '+81-90-0000-5678', verifiedAt: NOW,
    });

    const result = await resolveViaWebhook(
      testDb, 'verified_phone', '$.tel', { tel: '090-0000-5678' },
    );
    expect(result.matchedFriendId).toBe('friend-1');
  });

  it('users.phone だけ一致しても裏付けが無ければ結び付けない', async () => {
    addUser(testDb, 'user-1', { phone: '09000005678' });
    insertFriend(testDb.raw, 'friend-1', { line_account_id: ACCOUNT, user_id: 'user-1' });

    const result = await resolveViaWebhook(
      testDb, 'verified_phone', '$.tel', { tel: '09000005678' },
    );
    expect(result.matchedFriendId).toBeNull();
  });

  it('外部サービスのお客様IDは従来どおり users.external_id で結び付く', async () => {
    // external_customer_id は「検証済み」を名乗らない照合なので挙動は変えない。
    addUser(testDb, 'user-1', { externalId: 'ec-123' });
    insertFriend(testDb.raw, 'friend-1', { line_account_id: ACCOUNT, user_id: 'user-1' });

    const result = await resolveViaWebhook(
      testDb, 'external_customer_id', '$.customerId', { customerId: 'ec-123' },
    );
    expect(result.matchedFriendId).toBe('friend-1');
  });
});

/*
 * S ( 機能26): 同じ値の友だちが2人以上いたら自動では動かさない。
 * 先頭だけ選んで実行すると別人へ処理が届くため、箱へ保留して人が選ぶ。
 */
describe('S: 複数一致は自動実行せず箱へ保留する', () => {
  let testDb: SqliteD1;

  beforeEach(() => {
    testDb = createTestD1();
    seed(testDb);
  });

  it('同じ検証済みメアドの友だちが2人いると実行せず ambiguous で箱へ置く', async () => {
    addUser(testDb, 'user-1', { email: 'owner@example.com' });
    addUser(testDb, 'user-2', { email: 'owner@example.com' });
    insertFriend(testDb.raw, 'friend-1', { line_account_id: ACCOUNT, user_id: 'user-1' });
    insertFriend(testDb.raw, 'friend-2', { line_account_id: ACCOUNT, user_id: 'user-2' });
    addProfileValue(testDb, {
      userId: 'user-1', fieldKey: 'email', value: 'owner@example.com', verifiedAt: NOW,
    });
    addProfileValue(testDb, {
      userId: 'user-2', fieldKey: 'email', value: 'owner@example.com', verifiedAt: NOW,
    });

    const result = await executeIncomingWebhookActions(testDb.db, {
      lineAccountId: ACCOUNT,
      webhookId: 'iwh-1',
      sourceEventId: crypto.randomUUID(),
      payload: { email: 'owner@example.com' },
      identityMatching: {
        methods: [{ kind: 'verified_email', path: '$.email' }],
        // 「何もしない」を選んでいても、複数一致は必ず保留する(0件扱いではない)。
        onNotFound: 'do_nothing',
      },
      actions: [{ refKind: 'tag', refId: 'tag-1', refVersionId: null }],
    });
    expect(result.matchStatus).toBe('ambiguous');
    expect(result.matchedFriendId).toBeNull();
    expect(result.executed).toBe(0);

    const row = testDb.raw.prepare(
      `SELECT kind, candidate_friend_ids_json FROM incoming_webhook_unmatched_events`,
    ).get() as { kind: string; candidate_friend_ids_json: string };
    expect(row.kind).toBe('ambiguous');
    expect(JSON.parse(row.candidate_friend_ids_json).sort()).toEqual(['friend-1', 'friend-2']);
  });

  it('同じ外部IDの友だちが2人いると ambiguous になる', async () => {
    addUser(testDb, 'user-1', { externalId: 'ec-123' });
    addUser(testDb, 'user-2', { externalId: 'ec-123' });
    insertFriend(testDb.raw, 'friend-1', { line_account_id: ACCOUNT, user_id: 'user-1' });
    insertFriend(testDb.raw, 'friend-2', { line_account_id: ACCOUNT, user_id: 'user-2' });

    const result = await resolveViaWebhook(
      testDb, 'external_customer_id', '$.customerId', { customerId: 'ec-123' },
    );
    expect(result.matchedFriendId).toBeNull();
    expect(result.matchStatus).toBe('ambiguous');
  });

  it('受け取りの試しは照合と組み立てだけで箱にも実行履歴にも残さない', async () => {
    addUser(testDb, 'user-1', { externalId: 'ec-123' });
    insertFriend(testDb.raw, 'friend-1', { line_account_id: ACCOUNT, user_id: 'user-1' });
    testDb.raw.prepare(
      `INSERT INTO tags (id, line_account_id, name, created_at, updated_at)
       VALUES ('tag-1', '${ACCOUNT}', '購入者', '${NOW}', '${NOW}')`,
    ).run();

    const preview = await previewIncomingWebhook(testDb.db, {
      lineAccountId: ACCOUNT,
      payload: { customerId: 'ec-123' },
      identityMatching: {
        methods: [{ kind: 'external_customer_id', path: '$.customerId' }],
        onNotFound: 'unmatched_box',
      },
      actions: [{ refKind: 'tag', refId: 'tag-1', refVersionId: null }],
    });
    expect(preview.match).toEqual({ status: 'matched', friendId: 'friend-1' });
    expect(preview.actions[0]).toMatchObject({ ok: true, plan: [{ type: 'add_tag' }] });
    // 試しは副作用を持たない。箱にも友だちのタグにも何も書かない。
    expect(
      testDb.raw.prepare(`SELECT COUNT(*) AS n FROM incoming_webhook_unmatched_events`).get(),
    ).toEqual({ n: 0 });
    expect(
      testDb.raw.prepare(`SELECT COUNT(*) AS n FROM friend_tags`).get(),
    ).toEqual({ n: 0 });
  });
});
