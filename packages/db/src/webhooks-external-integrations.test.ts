/*
 * 外部連携の補強のDB層テスト。
 *
 * 削除は行を消さず deleted_at を立て、一覧・詳細・送り先解決からは見えなくなる。
 * 人が見つからなかった届物を箱へ置き、確認済みにできる。
 * 外部APIの鍵はハッシュだけを持ち、無効化・入れ替えで即座に使えなくなる。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIncomingWebhook,
  createOutgoingWebhook,
  deleteIncomingWebhook,
  deleteOutgoingWebhook,
  getActiveOutgoingWebhooksByEvent,
  getIncomingWebhookById,
  getIncomingWebhooks,
  getOutgoingWebhookById,
  getOutgoingWebhookDeliverySummaries,
  getOutgoingWebhooks,
  updateIncomingWebhook,
  recordIncomingWebhookUnmatched,
  listIncomingWebhookUnmatched,
  countIncomingWebhookUnmatched,
  getIncomingWebhookUnmatchedById,
  resolveIncomingWebhookUnmatched,
} from './webhooks.js';
import {
  createIntegrationApiToken,
  hashIntegrationApiToken,
  listIntegrationApiTokens,
  resolveIntegrationApiToken,
  revokeIntegrationApiToken,
  reactivateIntegrationApiToken,
  rotateIntegrationApiToken,
  tokenHasScope,
} from './integration-api-tokens.js';

const packageRoot = join(__dirname, '..');

function asD1(sqlite: Database.Database): D1Database {
  const normalize = (args: unknown[]) =>
    args.map((a) => {
      if (a === undefined) return null;
      if (typeof a === 'boolean') return a ? 1 : 0;
      return a;
    }) as never[];
  return {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async <T = unknown>() =>
          (sqlite.prepare(sql).get(...normalize(args)) as T) ?? null,
        all: async <T = unknown>() => ({
          results: sqlite.prepare(sql).all(...normalize(args)) as T[],
        }),
        run: async () => {
          const info = sqlite.prepare(sql).run(...normalize(args));
          return {
            success: true,
            meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
          };
        },
      }),
      first: async <T = unknown>() => (sqlite.prepare(sql).get() as T) ?? null,
      all: async <T = unknown>() => ({ results: sqlite.prepare(sql).all() as T[] }),
      run: async () => {
        const info = sqlite.prepare(sql).run();
        return { success: true, meta: { changes: info.changes } };
      },
    }),
    batch: async () => {
      throw new Error('not needed');
    },
  } as unknown as D1Database;
}

function insertAccount(sqlite: Database.Database, id: string): void {
  sqlite
    .prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_access_token, channel_secret)
       VALUES (?, ?, ?, 'token', 'secret')`,
    )
    .run(id, `channel-${id}`, id);
}

// LINE_CREDENTIAL_ENCRYPTION_KEY は base64 の32バイト鍵。
const ENC = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

describe('Webhookの受け口や送り先を削除すると対象から外れる', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(packageRoot, 'bootstrap.sql'), 'utf8'));
    insertAccount(sqlite, 'account-a');
    insertAccount(sqlite, 'account-b');
    db = asD1(sqlite);
  });

  it('WEB232 creates inactive rows without any activation window and preserves legacy creation', async () => {
    const outgoing = await createOutgoingWebhook(db, { lineAccountId: 'account-a', name: '下書き', url: 'https://example.com/hook', eventTypes: ['booking_created'], secret: 'a'.repeat(32), isActive: false }, ENC);
    const incoming = await createIncomingWebhook(db, { lineAccountId: 'account-a', name: '下書き', secret: 'a'.repeat(32), isActive: false }, ENC);
    expect(outgoing.is_active).toBe(0); expect(incoming.is_active).toBe(0);
    expect(await getActiveOutgoingWebhooksByEvent(db, 'booking_created', 'account-a')).toEqual([]);
    expect((await createIncomingWebhook(db, { lineAccountId: 'account-a', name: '旧呼び出し', secret: 'a'.repeat(32) }, ENC)).is_active).toBe(1);
  });

  it('受け口の削除は行を残し、一覧と詳細からは見えなくなる', async () => {
    const created = await createIncomingWebhook(db, {
      lineAccountId: 'account-a',
      name: 'EC基盤',
      secret: 'a'.repeat(32),
    }, ENC);

    await deleteIncomingWebhook(db, created.id, 'account-a', 'staff-1');

    // 行は残る（届物の受付履歴・監査を守る）。
    const rawRow = sqlite
      .prepare(`SELECT deleted_at FROM incoming_webhooks WHERE id = ?`)
      .get(created.id) as { deleted_at: string | null };
    expect(rawRow.deleted_at).not.toBeNull();

    expect(await getIncomingWebhookById(db, created.id, 'account-a')).toBeNull();
    expect(await getIncomingWebhooks(db, 'account-a')).toEqual([]);
    // 消した行は更新の対象にもならない。
    await updateIncomingWebhook(db, created.id, 'account-a', { name: '改名' });
    expect(
      (sqlite.prepare(`SELECT name FROM incoming_webhooks WHERE id = ?`).get(created.id) as { name: string }).name,
    ).toBe('EC基盤');
  });

  it('送り先の削除は行を残し、イベント送付の対象から外れる', async () => {
    const created = await createOutgoingWebhook(db, {
      lineAccountId: 'account-a',
      name: '倉庫通知',
      url: 'https://example.com/hook',
      eventTypes: ['message'],
      maxRetries: 2,
    });

    await deleteOutgoingWebhook(db, created.id, 'account-a', 'staff-1');

    const rawRow = sqlite
      .prepare(`SELECT deleted_at FROM outgoing_webhooks WHERE id = ?`)
      .get(created.id) as { deleted_at: string | null };
    expect(rawRow.deleted_at).not.toBeNull();

    expect(await getOutgoingWebhookById(db, created.id, 'account-a')).toBeNull();
    expect(await getOutgoingWebhooks(db, 'account-a')).toEqual([]);
    expect(await getActiveOutgoingWebhooksByEvent(db, 'message', 'account-a')).toEqual([]);
    expect(await getOutgoingWebhookDeliverySummaries(db, 'account-a')).toEqual([]);
  });

  it('消した送り先は二度目の削除で見つからない（再利用不能）', async () => {
    const created = await createOutgoingWebhook(db, {
      lineAccountId: 'account-a',
      name: '倉庫通知',
      url: 'https://example.com/hook',
      eventTypes: ['*'],
    });

    const first = await deleteOutgoingWebhook(db, created.id, 'account-a', 'staff-1');
    const second = await deleteOutgoingWebhook(db, created.id, 'account-a', 'staff-1');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe('未照合の届物を重複なく保存し担当アカウントで処理する', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let webhookId: string;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(packageRoot, 'bootstrap.sql'), 'utf8'));
    insertAccount(sqlite, 'account-a');
    insertAccount(sqlite, 'account-b');
    // resolved_friend_id は friends への外部キーなので、結び付け先を1人置く。
    sqlite.prepare(
      `INSERT INTO friends (id, line_user_id, display_name, line_account_id)
       VALUES ('friend-1', 'Ufriend-1', 'friend-1', 'account-a')`,
    ).run();
    db = asD1(sqlite);
    const webhook = await createIncomingWebhook(db, {
      lineAccountId: 'account-a',
      name: 'EC基盤',
      secret: 'a'.repeat(32),
    }, ENC);
    webhookId = webhook.id;
  });

  it('届物を箱へ置き、友だちへ結び付けて閉じられる', async () => {
    const recorded = await recordIncomingWebhookUnmatched(db, {
      webhookId,
      lineAccountId: 'account-a',
      sourceEventId: 'evt-1',
      kind: 'unmatched',
      identityAttempts: [{ kind: 'verified_email', path: '$.email', value: 'a@example.com' }],
      maskedShape: { fields: [{ path: '$.email', type: 'string', maskedValue: '••••' }] },
    });

    const listed = await listIncomingWebhookUnmatched(db, webhookId, 'account-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: recorded.id,
      kind: 'unmatched',
      status: 'pending',
      line_account_id: 'account-a',
      webhook_id: webhookId,
      source_event_id: 'evt-1',
      resolved_at: null,
    });
    expect(JSON.parse(listed[0]!.identity_attempts_json)).toEqual([
      { kind: 'verified_email', path: '$.email', value: 'a@example.com' },
    ]);
    expect(await countIncomingWebhookUnmatched(db, webhookId, 'account-a')).toBe(1);

    const ok = await resolveIncomingWebhookUnmatched(db, recorded.id, 'account-a', {
      action: 'link', friendId: 'friend-1',
    }, 'staff-9');
    expect(ok).toBe(true);

    expect(await countIncomingWebhookUnmatched(db, webhookId, 'account-a')).toBe(0);
    const after = await getIncomingWebhookUnmatchedById(db, recorded.id, 'account-a');
    expect(after).toMatchObject({
      status: 'resolved',
      resolved_friend_id: 'friend-1',
      resolved_by: 'staff-9',
    });
    // 処理済みの届物は二度閉じられない。
    expect(await resolveIncomingWebhookUnmatched(db, recorded.id, 'account-a', { action: 'dismiss' })).toBe(false);
  });

  it('「何もしないで閉じる」は dismissed になる', async () => {
    const recorded = await recordIncomingWebhookUnmatched(db, {
      webhookId, lineAccountId: 'account-a', sourceEventId: 'evt-d',
      kind: 'unmatched', identityAttempts: [],
    });
    expect(await resolveIncomingWebhookUnmatched(db, recorded.id, 'account-a', { action: 'dismiss' })).toBe(true);
    expect((await getIncomingWebhookUnmatchedById(db, recorded.id, 'account-a'))!.status).toBe('dismissed');
  });

  it('同じ届物を二度流しても重ならない（再送の冪等）', async () => {
    const first = await recordIncomingWebhookUnmatched(db, {
      webhookId, lineAccountId: 'account-a', sourceEventId: 'evt-dup',
      kind: 'unmatched', identityAttempts: [],
    });
    const second = await recordIncomingWebhookUnmatched(db, {
      webhookId, lineAccountId: 'account-a', sourceEventId: 'evt-dup',
      kind: 'unmatched', identityAttempts: [],
    });
    expect(second.id).toBe(first.id);
    expect(await countIncomingWebhookUnmatched(db, webhookId, 'account-a')).toBe(1);
  });

  it('「候補を作る」は kind=candidate で置く', async () => {
    await recordIncomingWebhookUnmatched(db, {
      webhookId, lineAccountId: 'account-a', sourceEventId: 'evt-c',
      kind: 'candidate', identityAttempts: [],
    });
    const listed = await listIncomingWebhookUnmatched(db, webhookId, 'account-a');
    expect(listed[0]!.kind).toBe('candidate');
  });

  it('別のアカウントの届物は見えない・閉じられない', async () => {
    const otherWebhook = await createIncomingWebhook(db, {
      lineAccountId: 'account-b', name: '別口', secret: 'a'.repeat(32),
    }, ENC);
    const recorded = await recordIncomingWebhookUnmatched(db, {
      webhookId: otherWebhook.id, lineAccountId: 'account-b', sourceEventId: 'evt-x',
      kind: 'unmatched', identityAttempts: [],
    });

    expect(await listIncomingWebhookUnmatched(db, webhookId, 'account-a')).toEqual([]);
    expect(await getIncomingWebhookUnmatchedById(db, recorded.id, 'account-a')).toBeNull();
    expect(await resolveIncomingWebhookUnmatched(db, recorded.id, 'account-a', { action: 'dismiss' })).toBe(false);
  });
});

describe('外部APIの鍵を安全に保存し無効化・再開する', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(packageRoot, 'bootstrap.sql'), 'utf8'));
    insertAccount(sqlite, 'account-a');
    db = asD1(sqlite);
  });

  it('発行した鍵はハッシュだけを持ち、提示された鍵で口を引ける', async () => {
    const issued = await createIntegrationApiToken(db, {
      lineAccountId: 'account-a',
      name: 'EC基盤',
      scopes: ['tags:read', 'tags:write'],
      createdBy: 'staff-1',
    });
    expect(issued.token).toMatch(/^lhp_[0-9a-f]{48}$/);

    const row = sqlite
      .prepare(`SELECT * FROM integration_api_tokens WHERE id = ?`)
      .get(issued.row.id) as Record<string, unknown>;
    expect(row.token_hash).toBe(await hashIntegrationApiToken(issued.token));
    expect(row.token_prefix).toBe(issued.token.slice(0, 12));
    // 平文はどの列にも残っていない。
    expect(Object.values(row)).not.toContain(issued.token);

    const resolved = await resolveIntegrationApiToken(db, issued.token);
    expect(resolved).toMatchObject({ id: issued.row.id, line_account_id: 'account-a' });
    expect(tokenHasScope(resolved!, 'tags:write')).toBe(true);
    expect(tokenHasScope(resolved!, 'unknown:scope' as never)).toBe(false);

    expect(await resolveIntegrationApiToken(db, 'lhp_' + 'f'.repeat(48))).toBeNull();
    expect(await resolveIntegrationApiToken(db, 'not-a-token')).toBeNull();
  });

  it('無効化した鍵は使えなくなり、入れ替えると古い鍵だけ止まる', async () => {
    const first = await createIntegrationApiToken(db, {
      lineAccountId: 'account-a', name: 'EC基盤', scopes: ['tags:read'], createdBy: 'staff-1',
    });
    const second = await createIntegrationApiToken(db, {
      lineAccountId: 'account-a', name: '倉庫', scopes: ['tags:write'], createdBy: 'staff-1',
    });

    const rotated = await rotateIntegrationApiToken(db, first.row.id, 'account-a', 'staff-2');
    // 同時再発行の当たり外れを区別するため、成否ではなく状態で返す。
    // 逐次の再発行が通ること・古い鍵だけ止まることの意図は変えない。
    if (rotated.status !== 'ok') throw new Error('rotate should succeed');
    expect(await resolveIntegrationApiToken(db, first.token)).toBeNull();
    const rotatedRow = await resolveIntegrationApiToken(db, rotated.token);
    expect(rotatedRow).toMatchObject({
      line_account_id: 'account-a',
      rotated_from_id: first.row.id,
    });
    // 別の鍵は生きている。
    expect(await resolveIntegrationApiToken(db, second.token)).not.toBeNull();
    // 失効済みは再入れ替えできない。
    expect((await rotateIntegrationApiToken(db, first.row.id, 'account-a')).status).toBe('not_found');

    expect(await revokeIntegrationApiToken(db, second.row.id, 'account-a', 'staff-1')).toBe(true);
    expect(await resolveIntegrationApiToken(db, second.token)).toBeNull();
    // 二度目の無効化は何も起きない。
    expect(await revokeIntegrationApiToken(db, second.row.id, 'account-a')).toBe(false);
  });

  it('止めた鍵は動かし直すと止める前の合言葉が使える', async () => {
    const issued = await createIntegrationApiToken(db, {
      lineAccountId: 'account-a', name: 'EC基盤', scopes: ['tags:read'], createdBy: 'staff-1',
    });
    expect(await revokeIntegrationApiToken(db, issued.row.id, 'account-a', 'staff-2')).toBe(true);
    expect(await resolveIntegrationApiToken(db, issued.token)).toBeNull();

    // 動いている鍵の動かし直しは何も起きない。
    const live = await createIntegrationApiToken(db, {
      lineAccountId: 'account-a', name: '生きている鍵', scopes: ['tags:read'],
    });
    expect(await reactivateIntegrationApiToken(db, live.row.id, 'account-a')).toBe(false);

    // 止めた鍵を動かし直すと、止める前の合言葉が使える。
    expect(await reactivateIntegrationApiToken(db, issued.row.id, 'account-a')).toBe(true);
    const resolved = await resolveIntegrationApiToken(db, issued.token);
    expect(resolved).toMatchObject({ id: issued.row.id, line_account_id: 'account-a' });
    // 二度目の動かし直しは何も起きない。別のアカウントでも効かない。
    expect(await reactivateIntegrationApiToken(db, issued.row.id, 'account-a')).toBe(false);
    expect(await reactivateIntegrationApiToken(db, issued.row.id, 'account-b')).toBe(false);
    expect(await reactivateIntegrationApiToken(db, 'no-such-id', 'account-a')).toBe(false);
  });

  it('一覧は生きている鍵だけを返し、平文は含まない', async () => {
    await createIntegrationApiToken(db, {
      lineAccountId: 'account-a', name: '生きている鍵', scopes: ['tags:read'],
    });
    const revoked = await createIntegrationApiToken(db, {
      lineAccountId: 'account-a', name: '止めた鍵', scopes: ['tags:read'],
    });
    await revokeIntegrationApiToken(db, revoked.row.id, 'account-a');

    const listed = await listIntegrationApiTokens(db, 'account-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe('生きている鍵');
    expect(Object.values(listed[0]!)).not.toContain(revoked.token);
  });
});
