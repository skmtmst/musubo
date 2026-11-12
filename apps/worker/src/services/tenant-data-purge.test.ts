import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { processTenantDataPurge } from './tenant-data-purge.js';
import { logger } from '@line-crm/shared/server';

/*
 * 退会後の顧客データ削除（★36-2）。
 *
 * 「消える」だけでなく「消えてはいけないものが残る」ことまで確かめる。
 * 条件は SQL そのものが仕様なので、手書きのモックではなく本物のSQLiteに当てる。
 */

const DAY = 24 * 60 * 60 * 1000;

function jst(offsetDays: number): string {
  // 2026-06-01 09:00 JST を基準にした相対時刻。実時刻に依らず結果が決まる。
  const base = Date.parse('2026-06-01T00:00:00.000Z');
  return new Date(base + offsetDays * DAY).toISOString();
}

/** 今回の実行時刻。保存期限(90日)の判定はここを基準にする。 */
const NOW = jst(0);

function createR2() {
  return { delete: vi.fn(async () => {}) } as unknown as R2Bucket & { delete: ReturnType<typeof vi.fn> };
}

describe('tenant data retention purge', () => {
  let sqlite: SqliteD1;

  beforeEach(() => {
    sqlite = createTestD1();
  });

  function seedTenant(
    id: string,
    retention: { anchor?: string | null; requested?: string | null; planStatus?: string; trialEndsAt?: string | null },
  ): void {
    sqlite.raw
      .prepare(
        `INSERT INTO tenants (id, name, plan_status, trial_ends_at, retention_anchor_at, purge_requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `統括 ${id}`,
        retention.planStatus ?? 'canceled',
        retention.trialEndsAt ?? null,
        retention.anchor ?? null,
        retention.requested ?? null,
      );
    sqlite.raw
      .prepare(
        `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
         VALUES (?, ?, ?, 'token', 'secret', ?)`,
      )
      .run(`acc-${id}`, `channel-${id}`, `アカウント ${id}`, id);
  }

  function seedFriends(tenantId: string, count: number, prefix = 'u'): void {
    const insert = sqlite.raw.prepare(
      'INSERT INTO friends (id, line_user_id, line_account_id) VALUES (?, ?, ?)',
    );
    const many = sqlite.raw.transaction((total: number) => {
      for (let index = 0; index < total; index += 1) {
        insert.run(`${prefix}-${tenantId}-${index}`, `line-${prefix}-${tenantId}-${index}`, `acc-${tenantId}`);
      }
    });
    many(count);
  }

  function seedMedia(tenantId: string, r2Key: string): void {
    sqlite.raw
      .prepare(
        `INSERT INTO media (id, kind, filename, mime_type, size_bytes, r2_key, line_account_id)
         VALUES (?, 'image', 'a.png', 'image/png', 10, ?, ?)`,
      )
      .run(`media-${tenantId}`, r2Key, `acc-${tenantId}`);
  }

  /** 監査・支払の記録。削除対象に入れてはいけない。 */
  function seedInvoice(tenantId: string): void {
    sqlite.raw
      .prepare(
        `INSERT INTO billing_invoices (id, tenant_id, synced_at, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(`inv-${tenantId}`, tenantId, NOW, NOW);
  }

  function count(table: string, where: string, ...args: unknown[]): number {
    const row = sqlite.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args as never[]);
    return (row as { n: number }).n;
  }

  test('契約終了の統括は保護されたテンプレートも消し、許可を残さない', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    sqlite.raw.prepare("INSERT INTO hq_templates (id, tenant_id, template_type, name) VALUES ('h1', 't1', 'tag', 'test')").run();
    expect(() => sqlite.raw.prepare("DELETE FROM hq_templates WHERE id = 'h1'").run()).toThrow('HQ_TEMPLATE_USE_LOGICAL_ARCHIVE');
    const result = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });
    expect(result.completed).toBe(1);
    expect(count('hq_templates', 'id = ?', 'h1')).toBe(0);
    expect(count('tenant_purge_guard', '1 = 1')).toBe(0);
  });

  test('期限切れの試用は保護表を消せるが、契約中は削除要請があっても保護表を消せない', async () => {
    seedTenant('trial', { planStatus: 'trialing', trialEndsAt: jst(-100), anchor: jst(-99) });
    seedTenant('active', { planStatus: 'active', requested: jst(-1) });
    seedTenant('future-trial', { planStatus: 'trialing', trialEndsAt: jst(1), requested: jst(-1) });
    sqlite.raw.prepare("INSERT INTO hq_templates (id, tenant_id, template_type, name) VALUES ('trial-h', 'trial', 'tag', 'test'), ('active-h', 'active', 'tag', 'test'), ('future-h', 'future-trial', 'tag', 'test')").run();
    const result = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });
    expect(result.completed).toBe(1);
    expect(result.failedTenants).toBe(0);
    expect(result.tenants).toBe(1);
    expect(count('hq_templates', 'id = ?', 'trial-h')).toBe(0);
    expect(count('hq_templates', 'id = ?', 'active-h')).toBe(1);
    expect(count('hq_templates', 'id = ?', 'future-h')).toBe(1);
    expect(count('tenant_purge_guard', '1 = 1')).toBe(0);
  });

  test('保護表の削除が別の理由で失敗しても許可は残らない', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    sqlite.raw.prepare("INSERT INTO hq_templates (id, tenant_id, template_type, name) VALUES ('h1', 't1', 'tag', 'test')").run();
    sqlite.raw.exec("CREATE TRIGGER test_purge_guard_failure BEFORE DELETE ON hq_templates BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const result = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });
    expect(result.failedTenants).toBe(1);
    expect(count('tenant_purge_guard', '1 = 1')).toBe(0);
    expect(count('hq_templates', 'id = ?', 'h1')).toBe(1);
  });

  test('失敗が続く3統括より未処理の統括を優先し、次の回に削除する', async () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      seedTenant(id, { anchor: jst(-100) });
      sqlite.raw.prepare("INSERT INTO hq_templates (id, tenant_id, template_type, name) VALUES (?, ?, 'tag', 'test')").run(`h-${id}`, id);
    }
    sqlite.raw.exec("CREATE TRIGGER test_failure BEFORE DELETE ON hq_templates WHEN OLD.tenant_id <> 'd' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    const first = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });
    expect(first.failedTenants).toBe(3);
    const next = new Date(Date.parse(NOW) + 6 * 60 * 60 * 1000).toISOString();
    const second = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: next });
    expect(second.completed).toBe(1);
    expect(count('hq_templates', 'tenant_id = ?', 'd')).toBe(0);
    expect(count('hq_templates', "tenant_id IN ('a','b','c')")).toBe(3);
  });

  test('予期しない失敗でも統括と削除済み件数を安全なコードで記録する', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    seedFriends('t1', 1);
    seedMedia('t1', 'private-object-key');
    const DB = new Proxy(sqlite.db, { get(target, prop) {
      if (prop === 'prepare') return (sql: string) => {
        if (/^SELECT media\./.test(sql)) throw new Error('private-object-key secret-error');
        return target.prepare(sql);
      };
      return Reflect.get(target, prop);
    }});
    const result = await processTenantDataPurge({ DB, IMAGES: createR2() }, { now: NOW });
    expect(result.failedTenants).toBe(1);
    const audit = sqlite.raw.prepare("SELECT tenant_id, after_json FROM audit_events WHERE action='tenant_data.purge_failed'").get() as { tenant_id: string; after_json: string };
    expect(audit.tenant_id).toBe('t1');
    expect(JSON.parse(audit.after_json)).toMatchObject({ failureCode: 'unexpected_failure', deletedRows: 1 });
    expect(audit.after_json).not.toContain('private-object-key');
    expect(audit.after_json).not.toContain('secret-error');
    expect(result.deletedRows).toBe(1);
  });

  test.each(['status', 'deadline'] as const)('削除中に対象の%sが変われば保護表の許可を発行しない', async (changed) => {
    seedTenant('t1', { anchor: jst(-91) });
    let changedState = false;
    const DB = new Proxy(sqlite.db, { get(target, prop) {
      if (prop === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!changedState) {
          changedState = true;
          if (changed === 'status') sqlite.raw.prepare("UPDATE tenants SET plan_status='active' WHERE id='t1'").run();
          else sqlite.raw.prepare("UPDATE tenants SET retention_anchor_at=? WHERE id='t1'").run(jst(-1));
        }
        return target.batch(statements);
      };
      return Reflect.get(target, prop);
    }});
    const result = await processTenantDataPurge({ DB, IMAGES: createR2() }, { now: NOW });
    expect(changedState).toBe(true);
    expect(result.failedTenants).toBe(1);
    expect(result.completed).toBe(0);
    expect(count('tenant_purge_guard', '1 = 1')).toBe(0);
  });

  test('退会した統括のパスキーと所属だけを親より先に消し、期限切れの所属不明チャレンジも掃除する', async () => {
    seedTenant('retired', { anchor: jst(-91) });
    seedTenant('active', { planStatus: 'active' });
    const addStaff = sqlite.raw.prepare('INSERT INTO staff_members (id,name,api_key,role,tenant_id) VALUES (?,?,?,\'owner\',?)');
    addStaff.run('staff-retired', '退会', 'key-retired', 'retired');
    addStaff.run('staff-active', '利用中', 'key-active', 'active');
    const addKey = sqlite.raw.prepare("INSERT INTO staff_passkeys(credential_id,staff_id,public_key,device_type,created_at) VALUES (?,?, 'public', 'singleDevice', ?)");
    addKey.run('key-retired', 'staff-retired', NOW);
    addKey.run('key-active', 'staff-active', NOW);
    const addMembership = sqlite.raw.prepare('INSERT INTO line_account_hq_admin_memberships(line_account_id,staff_id) VALUES (?,?)');
    addMembership.run('acc-retired', 'staff-retired');
    addMembership.run('acc-retired', 'staff-active');
    addMembership.run('acc-active', 'staff-active');
    const addChallenge = sqlite.raw.prepare("INSERT INTO staff_passkey_challenges(token_hash,challenge,purpose,staff_id,expires_at,created_at) VALUES (?, 'challenge', 'login', ?, ?, ?)");
    addChallenge.run('retired', 'staff-retired', jst(2), NOW);
    addChallenge.run('active', 'staff-active', jst(2), NOW);
    addChallenge.run('orphan-expired', null, NOW, jst(-2));
    addChallenge.run('orphan-current', null, jst(1), NOW);

    expect((await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: '2026-06-01T09:00:00+09:00' })).completed).toBe(1);
    expect(sqlite.raw.prepare('SELECT credential_id FROM staff_passkeys').all()).toEqual([{ credential_id: 'key-active' }]);
    expect(sqlite.raw.prepare('SELECT line_account_id FROM line_account_hq_admin_memberships').all()).toEqual([{ line_account_id: 'acc-active' }]);
    expect(sqlite.raw.prepare('SELECT token_hash FROM staff_passkey_challenges ORDER BY token_hash').all()).toEqual([
      { token_hash: 'active' }, { token_hash: 'orphan-current' },
    ]);
    const audit = sqlite.raw.prepare('SELECT deleted_rows_by_table FROM tenant_data_purge_audit WHERE tenant_id=?').get('retired') as { deleted_rows_by_table: string };
    expect(JSON.parse(audit.deleted_rows_by_table)).toMatchObject({ staff_passkeys: 1, staff_passkey_challenges: 1, line_account_hq_admin_memberships: 2 });

    await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: jst(1) });
    expect(sqlite.raw.prepare('SELECT token_hash FROM staff_passkey_challenges').all()).toEqual([{ token_hash: 'active' }]);
  });

  test('期限切れの所属不明チャレンジが多い場合も上限を守って次回に掃除する', async () => {
    const add = sqlite.raw.prepare("INSERT INTO staff_passkey_challenges(token_hash,challenge,purpose,staff_id,expires_at,created_at) VALUES (?, 'challenge', 'login', NULL, ?, ?)");
    for (let i = 0; i < 201; i++) add.run(`orphan-${i}`, jst(-1), jst(-2));
    expect((await processTenantDataPurge({ DB: sqlite.db }, { now: NOW })).tenants).toBe(0);
    expect(count('staff_passkey_challenges', '1=1')).toBe(1);
    await processTenantDataPurge({ DB: sqlite.db }, { now: NOW });
    expect(count('staff_passkey_challenges', '1=1')).toBe(0);
  });

  test('チャレンジの掃除が失敗しても統括の削除を続け、固定の理由コードを記録する', async () => {
    seedTenant('retired', { anchor: jst(-91) });
    seedFriends('retired', 1);
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const db = { ...sqlite.db, prepare(sql: string) {
      if (sql.includes('WHERE expires_at <= ?')) throw new Error('private challenge detail');
      return sqlite.db.prepare(sql);
    } } as D1Database;
    try {
      const result = await processTenantDataPurge({ DB: db, IMAGES: createR2() }, { now: NOW });
      expect(result.completed).toBe(1);
      expect(count('friends', 'line_account_id = ?', 'acc-retired')).toBe(0);
      expect(logged).toHaveBeenCalledWith('tenant_data_purge.passkey_challenge_cleanup_failed');
      expect(JSON.stringify(logged.mock.calls)).not.toContain('private challenge detail');
    } finally { logged.mockRestore(); }
  });

  test('UTCの期限が現在時刻ちょうどなら掃除し、1ミリ秒後のものは残す', async () => {
    const add = sqlite.raw.prepare("INSERT INTO staff_passkey_challenges(token_hash,challenge,purpose,staff_id,expires_at,created_at) VALUES (?, 'challenge', 'login', NULL, ?, ?)");
    add.run('boundary', '2026-06-01T00:00:00.000Z', '2026-05-31T23:55:00.000Z');
    add.run('future', '2026-06-01T00:00:00.001Z', '2026-05-31T23:55:00.000Z');
    await processTenantDataPurge({ DB: sqlite.db }, { now: '2026-06-01T09:00:00+09:00' });
    expect(sqlite.raw.prepare('SELECT token_hash FROM staff_passkey_challenges').all()).toEqual([{ token_hash: 'future' }]);
  });

  test('保存期限(90日)が過ぎた統括の顧客データとR2画像を消し、支払の記録は残す', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    seedFriends('t1', 3);
    seedMedia('t1', 'images/t1.png');
    seedInvoice('t1');

    const IMAGES = createR2();
    const result = await processTenantDataPurge({ DB: sqlite.db, IMAGES }, { now: NOW });

    expect(result.tenants).toBe(1);
    expect(result.completed).toBe(1);
    expect(count('friends', 'line_account_id = ?', 'acc-t1')).toBe(0);
    expect(count('media', 'line_account_id = ?', 'acc-t1')).toBe(0);
    // 支払の記録は retain。統括に紐づいていても消さない。
    expect(count('billing_invoices', 'tenant_id = ?', 't1')).toBe(1);
    // R2の実体も消す。
    expect(IMAGES.delete).toHaveBeenCalledWith(['images/t1.png']);
    expect(result.deletedObjects).toBe(1);
  });

  test('削除の実績が監査表に残り、統括に削除済みの印が付く', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    seedFriends('t1', 2);

    await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });

    const audit = sqlite.raw
      .prepare('SELECT * FROM tenant_data_purge_audit WHERE tenant_id = ?')
      .get('t1') as {
        reason: string;
        finished_at: string | null;
        deleted_rows: number;
        deleted_rows_by_table: string;
      };
    expect(audit.reason).toBe('expired');
    expect(audit.finished_at).not.toBeNull();
    expect(audit.deleted_rows).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(audit.deleted_rows_by_table).friends).toBe(2);

    const tenant = sqlite.raw.prepare('SELECT data_purged_at FROM tenants WHERE id = ?').get('t1') as {
      data_purged_at: string | null;
    };
    expect(tenant.data_purged_at).not.toBeNull();
  });

  test('保存期限内の統括は消さない', async () => {
    seedTenant('t1', { anchor: jst(-89) });
    seedFriends('t1', 2);

    const result = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });

    expect(result.tenants).toBe(0);
    expect(count('friends', 'line_account_id = ?', 'acc-t1')).toBe(2);
  });

  test('早期削除の要請があれば90日を待たずに消し、理由をimmediateで残す', async () => {
    seedTenant('t1', { anchor: jst(-3), requested: jst(-1) });
    seedFriends('t1', 2);

    const result = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });

    expect(result.completed).toBe(1);
    expect(count('friends', 'line_account_id = ?', 'acc-t1')).toBe(0);
    const audit = sqlite.raw
      .prepare('SELECT reason FROM tenant_data_purge_audit WHERE tenant_id = ?')
      .get('t1') as { reason: string };
    expect(audit.reason).toBe('immediate');
  });

  test('1回の行数に上限があり、途中で止まっても次の回が続きから消す', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    // 1回の上限(5000行)を超える量。1回目では消し切れない。
    seedFriends('t1', 5001);

    const first = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });
    expect(first.deletedRows).toBe(5000);
    expect(first.completed).toBe(0);
    expect(count('friends', 'line_account_id = ?', 'acc-t1')).toBe(1);
    // 消し終えていないので印は付かず、次の回も同じ統括が対象になる。
    const midway = sqlite.raw.prepare('SELECT data_purged_at FROM tenants WHERE id = ?').get('t1') as {
      data_purged_at: string | null;
    };
    expect(midway.data_purged_at).toBeNull();
    const midAudit = sqlite.raw
      .prepare('SELECT finished_at FROM tenant_data_purge_audit WHERE tenant_id = ?')
      .get('t1') as { finished_at: string | null };
    expect(midAudit.finished_at).toBeNull();

    const second = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });
    expect(second.completed).toBe(1);
    expect(count('friends', 'line_account_id = ?', 'acc-t1')).toBe(0);
  });

  test('無料体験が終わったままの統括に、体験終了の時刻を起点として入れる', async () => {
    const trialEndsAt = jst(-10);
    seedTenant('t1', { planStatus: 'trialing', trialEndsAt, anchor: null });

    const result = await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });

    expect(result.anchoredTrials).toBe(1);
    const tenant = sqlite.raw.prepare('SELECT retention_anchor_at FROM tenants WHERE id = ?').get('t1') as {
      retention_anchor_at: string | null;
    };
    // 点検した時刻ではなく、実際に体験が終わった時刻を起点にする。
    expect(tenant.retention_anchor_at).toBe(trialEndsAt);
    // まだ90日経っていないので削除はしない。
    expect(result.tenants).toBe(0);
  });

  test('他の統括のデータは消さない', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    seedFriends('t1', 2);
    seedTenant('t2', { anchor: null, planStatus: 'active' });
    seedFriends('t2', 2);

    await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });

    expect(count('friends', 'line_account_id = ?', 'acc-t1')).toBe(0);
    expect(count('friends', 'line_account_id = ?', 'acc-t2')).toBe(2);
  });

  test('削除を拒まれた統括は記録して再試行し、別の統括は完了する', async () => {
    seedTenant('t1', { anchor: jst(-93) }); seedMedia('t1', 'private/t1.png');
    seedTenant('t2', { anchor: jst(-92) }); seedFriends('t2', 1);
    sqlite.raw.exec(`CREATE TRIGGER fixture_retention_delete_guard BEFORE DELETE ON media
      WHEN OLD.id = 'media-t1' BEGIN SELECT RAISE(ABORT, 'HQ_TEMPLATE_USE_LOGICAL_ARCHIVE'); END`);
    const IMAGES = createR2();
    const result = await processTenantDataPurge({ DB: sqlite.db, IMAGES }, { now: NOW });
    expect(result.completed).toBe(1);
    expect(count('friends', 'line_account_id = ?', 'acc-t2')).toBe(0);
    expect(count('media', 'id = ?', 'media-t1')).toBe(1);
    expect(IMAGES.delete).toHaveBeenCalledWith(['private/t1.png']);
    expect(sqlite.raw.prepare('SELECT data_purged_at FROM tenants WHERE id=?').get('t1')).toEqual({ data_purged_at: null });
    const audit = sqlite.raw.prepare("SELECT after_json FROM audit_events WHERE tenant_id=? AND action='tenant_data.purge_failed'").get('t1') as { after_json: string };
    expect(JSON.parse(audit.after_json)).toMatchObject({ table: 'media', failureCode: 'logical_archive_only', r2DeletedBeforeFailure: 1 });
    expect(audit.after_json).not.toContain('private/t1.png');
    const retry = await processTenantDataPurge({ DB: sqlite.db, IMAGES }, { now: NOW });
    expect(retry.tenants).toBe(1);
    expect(retry.completed).toBe(0);
  });

  /*
   * タグ未設定のフォームも削除対象へ含めるため、利用アカウントから所属を解決する。
   * 別の統括でも共有しているフォームや所属不明のフォームは、他者のデータを消さないよう保持する。
   */
  function seedTag(id: string, accountId: string): void {
    sqlite.raw
      .prepare(`INSERT INTO tags (id, name, line_account_id) VALUES (?, ?, ?)`)
      .run(id, `タグ ${id}`, accountId);
  }

  function seedForm(id: string, tagId: string | null, accountIds: string[]): void {
    // 公開版は INSERT のトリガが作る（手で足すと版番号が重なる）。
    sqlite.raw
      .prepare(`INSERT INTO forms (id, name, on_submit_tag_id) VALUES (?, ?, ?)`)
      .run(id, `フォーム ${id}`, tagId);
    const link = sqlite.raw.prepare(`INSERT INTO form_accounts (form_id, line_account_id) VALUES (?, ?)`);
    for (const accountId of accountIds) link.run(id, accountId);
  }

  function formCount(where: string, ...args: unknown[]): number {
    return count('forms', where, ...args);
  }

  test('タグを付けていないフォームも消える（子の版も一緒に）', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    seedForm('f1', null, ['acc-t1']);

    await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });

    expect(formCount('id = ?', 'f1')).toBe(0);
    expect(count('form_versions', 'form_id = ?', 'f1')).toBe(0);
    expect(count('form_accounts', 'form_id = ?', 'f1')).toBe(0);
  });

  test('タグを付けているフォームも今までどおり消える', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    seedTag('tag-1', 'acc-t1');
    seedForm('f1', 'tag-1', ['acc-t1']);

    await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });

    expect(formCount('id = ?', 'f1')).toBe(0);
  });

  test('ほかの店のフォームは消えない', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    seedTenant('t2', { anchor: null, planStatus: 'active' });
    seedForm('f1', null, ['acc-t1']);
    seedForm('f2', null, ['acc-t2']);

    await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });

    expect(formCount('id = ?', 'f1')).toBe(0);
    expect(formCount('id = ?', 'f2')).toBe(1);
  });

  test('統括をまたいで使うフォームはどちらの削除でも消さない', async () => {
    seedTenant('t1', { anchor: jst(-91) });
    seedTenant('t2', { anchor: null, planStatus: 'active' });
    // 両方の統括の店で使う1つのフォーム。
    seedForm('shared', null, ['acc-t1', 'acc-t2']);

    await processTenantDataPurge({ DB: sqlite.db, IMAGES: createR2() }, { now: NOW });

    // 本体は残る。t1 側の利用だけ外れ、t2 側の利用は残る。
    expect(formCount('id = ?', 'shared')).toBe(1);
    expect(count('form_accounts', 'form_id = ? AND line_account_id = ?', 'shared', 'acc-t1')).toBe(0);
    expect(count('form_accounts', 'form_id = ? AND line_account_id = ?', 'shared', 'acc-t2')).toBe(1);
  });

  function seedDocument(tenantId: string) {
    seedFriends(tenantId, 1); seedForm(`f-${tenantId}`, null, [`acc-${tenantId}`]);
    sqlite.raw.prepare(`INSERT INTO form_submissions(id,form_id,friend_id,data) VALUES (?, ?, ?, '{}')`).run(`answer-${tenantId}`, `f-${tenantId}`, `u-${tenantId}-0`);
    sqlite.raw.prepare(`INSERT INTO form_submission_files(id,line_account_id,form_id,block_id,friend_id,submission_id,file_kind,side,r2_key,filename,mime_type,size_bytes,scan_id,created_at)
      VALUES (?, ?, ?, 'b', ?, ?, 'pdf', 'single', ?, 'a.pdf', 'application/pdf', 10, 'scan', ?)`)
      .run(`doc-${tenantId}`, `acc-${tenantId}`, `f-${tenantId}`, `u-${tenantId}-0`, `answer-${tenantId}`, `private/form-documents/${tenantId}.pdf`, NOW);
  }
  test.each(['expired', 'requested'])('書類は%sの削除で実体まで消し、別の統括は守る', async reason => {
    seedTenant('t1', reason === 'expired' ? { anchor: jst(-91) } : { requested: jst(-1) }); seedDocument('t1');
    seedTenant('t2', { planStatus: 'active' }); seedDocument('t2');
    const IMAGES = createR2();
    expect((await processTenantDataPurge({ DB: sqlite.db, IMAGES }, { now: NOW })).completed).toBe(1);
    expect(count('form_submission_files', 'id = ?', 'doc-t1')).toBe(0);
    expect(count('form_submission_files', 'id = ?', 'doc-t2')).toBe(1);
    expect(IMAGES.delete).toHaveBeenCalledWith(['private/form-documents/t1.pdf']);
  });
  test('書類をR2から消せない時は行と親を残し、次回に消し直す', async () => {
    seedTenant('t1', { requested: jst(-1) }); seedDocument('t1');
    const IMAGES = createR2(); IMAGES.delete.mockRejectedValueOnce(new Error('R2 offline'));
    const first = await processTenantDataPurge({ DB: sqlite.db, IMAGES }, { now: NOW });
    expect(first.completed).toBe(0); expect(first.failedObjects).toBe(1);
    expect(count('form_submission_files', 'id = ?', 'doc-t1')).toBe(1);
    expect(count('form_submissions', 'id = ?', 'answer-t1')).toBe(1);
    expect(count('friends', 'id = ?', 'u-t1-0')).toBe(1);
    expect((await processTenantDataPurge({ DB: sqlite.db, IMAGES }, { now: NOW })).completed).toBe(1);
    expect(count('form_submission_files', 'id = ?', 'doc-t1')).toBe(0);
    expect(IMAGES.delete).toHaveBeenCalledTimes(2);
  });
});
