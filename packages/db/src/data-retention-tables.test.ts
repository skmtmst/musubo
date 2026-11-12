import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  RETENTION_R2_KEY_COLUMNS,
  RETENTION_TABLES,
  purgeTablesChildFirst,
  tenantScopeCondition,
} from './data-retention-tables.js';

/*
 * ★36-2 退会後の顧客データ削除。
 *
 * 表を1つ足して分類を書き忘れると、その表の顧客データだけが消えずに残る。
 * 設計書を読み直さないと気づけないので、ここで bootstrap.sql と分類表を
 * 突き合わせて落とす。条件式も実際の SQLite に通して、列名の打ち間違いを
 * 本番の削除処理より先に見つける。
 */

const packageRoot = join(import.meta.dirname, '..');

let sqlite: Database.Database;
/** bootstrap.sql に実在する表の名前。 */
let schemaTables: Set<string>;

beforeAll(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(packageRoot, 'bootstrap.sql'), 'utf8'));
  schemaTables = new Set(
    sqlite
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => row.name),
  );
});

function columnsOf(table: string): Set<string> {
  const rows = sqlite.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}

describe('保存期限の分類表', () => {
  it('店舗の統括管理者の所属は担当者への依存が深くなっても先に消す', () => {
    const original = RETENTION_TABLES.staff_members;
    RETENTION_TABLES.test_retention_parent = { category: 'purge', scope: { by: 'tenant', column: 'tenant_id' } };
    RETENTION_TABLES.test_retention_middle = { category: 'purge', scope: { by: 'parent', column: 'parent_id', parent: 'test_retention_parent', parentColumn: 'id' } };
    RETENTION_TABLES.staff_members = { category: 'purge', scope: { by: 'parent', column: 'parent_id', parent: 'test_retention_middle', parentColumn: 'id' } };
    try {
      const order = purgeTablesChildFirst();
      expect(order.indexOf('line_account_hq_admin_memberships')).toBeLessThan(order.indexOf('staff_members'));
      expect(order.indexOf('line_account_hq_admin_memberships')).toBeLessThan(order.indexOf('line_accounts'));
    } finally {
      RETENTION_TABLES.staff_members = original;
      delete RETENTION_TABLES.test_retention_parent;
      delete RETENTION_TABLES.test_retention_middle;
    }
  });
  it('パスキーと統括管理者の所属を分類し、参照する親より先に消す', () => {
    const expected = {
      staff_passkeys: { category: 'purge', scope: { by: 'parent', column: 'staff_id', parent: 'staff_members', parentColumn: 'id' } },
      staff_passkey_challenges: { category: 'purge', scope: { by: 'parent', column: 'staff_id', parent: 'staff_members', parentColumn: 'id' } },
      line_account_hq_admin_memberships: { category: 'purge', scope: { by: 'lineAccount', column: 'line_account_id' } },
    };
    const missing = [...schemaTables].filter(name => !RETENTION_TABLES[name]);
    const order = purgeTablesChildFirst();
    for (const [table, entry] of Object.entries(expected)) {
      expect(RETENTION_TABLES[table]).toEqual(entry);
      expect(missing).not.toContain(table);
      expect(order.indexOf(table)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(table)).toBeLessThan(order.indexOf('staff_members'));
    }
    expect(order.indexOf('line_account_hq_admin_memberships')).toBeLessThan(order.indexOf('line_accounts'));
  });
  it('統括のテスト票と保存した検索は参照先を消す前に消す', () => {
    const order = purgeTablesChildFirst();
    expect(order.indexOf('hq_form_test_tokens')).toBeLessThan(order.indexOf('hq_template_versions'));
    expect(order.indexOf('hq_form_test_tokens')).toBeLessThan(order.indexOf('staff_members'));
    expect(order.indexOf('hq_broadcast_saved_views')).toBeLessThan(order.indexOf('staff_members'));
    expect(order.indexOf('hq_template_saved_views')).toBeLessThan(order.indexOf('staff_members'));
    expect(tenantScopeCondition('hq_form_test_tokens')).toContain('hq_form_test_tokens.tenant_id = ?');
    expect(tenantScopeCondition('hq_broadcast_saved_views')).toContain('hq_broadcast_saved_views.tenant_id = ?');
    expect(tenantScopeCondition('hq_template_saved_views')).toContain('hq_template_saved_views.tenant_id = ?');
  });
  it('bootstrap.sql の表がすべて分類されている', () => {
    const missing = [...schemaTables].filter((name) => !RETENTION_TABLES[name]).sort();
    expect(
      missing,
      `分類されていない表があります。packages/db/src/data-retention-tables.json に ` +
        `purge(顧客データ) / retain(監査・支払・審査) / global(統括に紐づかない) のどれかを足してください: ` +
        missing.join(', '),
    ).toEqual([]);
  });

  it('分類表に、もう無くなった表が残っていない', () => {
    const stale = Object.keys(RETENTION_TABLES)
      .filter((name) => !schemaTables.has(name))
      .sort();
    expect(stale, `bootstrap.sql に無い表が分類表に残っています: ${stale.join(', ')}`).toEqual([]);
  });

  it('紐づけに使う列が実在する', () => {
    const broken: string[] = [];
    for (const [table, entry] of Object.entries(RETENTION_TABLES)) {
      if (!entry.scope) continue;
      if (!columnsOf(table).has(entry.scope.column)) {
        broken.push(`${table}.${entry.scope.column}`);
      }
      if (entry.scope.by === 'parent') {
        const parent = RETENTION_TABLES[entry.scope.parent];
        if (!parent) broken.push(`${table} -> 親 ${entry.scope.parent} が分類表に無い`);
        else if (!parent.scope) broken.push(`${table} -> 親 ${entry.scope.parent} が統括に紐づかない`);
        else if (!columnsOf(entry.scope.parent).has(entry.scope.parentColumn)) {
          broken.push(`${entry.scope.parent}.${entry.scope.parentColumn}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('global の表には紐づけが無く、purge/retain の表には紐づけがある', () => {
    const wrong: string[] = [];
    for (const [table, entry] of Object.entries(RETENTION_TABLES)) {
      if (entry.category === 'global' && entry.scope) wrong.push(`${table}: global なのに紐づけがある`);
      if (entry.category === 'purge' && !entry.scope) wrong.push(`${table}: purge なのに紐づけが無い`);
    }
    expect(wrong).toEqual([]);
  });

  it('監査・支払・審査の表は purge に入っていない', () => {
    // 分類を間違えて消してしまうと取り戻せない。名前で分かる分だけでも止める。
    const mustRetain = [
      'audit_events',
      'billing_events',
      'billing_invoices',
      'stripe_events',
      'platform_audit_logs',
      'login_audit',
      'pii_reveal_logs',
      'tenant_data_purge_audit',
      'nen_photo_review_events',
      'site_consent_days',
    ];
    for (const table of mustRetain) {
      expect(RETENTION_TABLES[table]?.category, `${table} は消してはいけない`).toBe('retain');
    }
  });
});

describe('削除する行を選ぶ条件', () => {
  it('purge の全表で、実際の SQLite が条件式を受け付ける', () => {
    const failures: string[] = [];
    for (const table of purgeTablesChildFirst()) {
      const sql = `SELECT COUNT(*) AS n FROM ${table} WHERE ${tenantScopeCondition(table)}`;
      try {
        // 行は無くてよい。列名と表名が実在することを SQLite 自身に確かめさせる。
        sqlite.prepare(sql).get('tenant-not-found');
      } catch (error) {
        failures.push(`${table}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('統括IDを入れる場所がちょうど1つになる', () => {
    for (const table of purgeTablesChildFirst()) {
      const marks = tenantScopeCondition(table).split('?').length - 1;
      expect(marks, `${table} の条件式`).toBe(1);
    }
  });

  it('公開受信の記録は種類と統括を両方照合し、両方の親より先に消す', () => {
    sqlite.exec('SAVEPOINT ingress_retention');
    try {
      sqlite.exec(`
        INSERT INTO tenants(id,name) VALUES('ingress-a','A'),('ingress-b','B');
        INSERT INTO line_accounts(id,tenant_id,name,channel_id,channel_access_token,channel_secret)
          VALUES('ingress-account-a','ingress-a','A','ingress-channel-a','test','test'),
                ('ingress-account-b','ingress-b','B','ingress-channel-b','test','test');
        INSERT INTO conversion_points(id,name,event_type,tenant_id)
          VALUES('ingress-point-a','A','manual','ingress-a'),('ingress-point-b','B','manual','ingress-b');
        INSERT INTO measurement_sites(id,line_account_id,label)
          VALUES('ingress-point-b','ingress-account-a','A'),('ingress-point-a','ingress-account-b','B');
        INSERT INTO public_ingress_receipts(kind,scope_id,receipt_key,received_at)
          VALUES('conversion_nonce','ingress-point-a','one','2026-10-16'),
                ('conversion_nonce','ingress-point-b','two','2026-10-16'),
                ('site_event','ingress-point-b','three','2026-10-16'),
                ('site_event','ingress-point-a','four','2026-10-16');
      `);
      const predicate = tenantScopeCondition('public_ingress_receipts');
      sqlite.prepare(`DELETE FROM public_ingress_receipts WHERE ${predicate}`).run('ingress-a');
      expect(sqlite.prepare('SELECT kind,scope_id FROM public_ingress_receipts ORDER BY kind').all()).toEqual([
        { kind: 'conversion_nonce', scope_id: 'ingress-point-b' },
        { kind: 'site_event', scope_id: 'ingress-point-a' },
      ]);
      const order = purgeTablesChildFirst();
      for (const parent of ['conversion_points', 'measurement_sites', 'line_accounts']) {
        expect(order.indexOf('public_ingress_receipts')).toBeLessThan(order.indexOf(parent));
      }
      expect(order.indexOf('incoming_webhook_queue')).toBeLessThan(order.indexOf('incoming_webhooks'));
      expect(order.indexOf('operator_notification_occurrences')).toBeLessThan(order.indexOf('notification_instances'));
    } finally {
      sqlite.exec('ROLLBACK TO ingress_retention; RELEASE ingress_retention');
    }
  });

  it('子の表が親より先に消される順番で返る', () => {
    const order = purgeTablesChildFirst();
    const position = new Map(order.map((name, index) => [name, index]));
    for (const table of order) {
      const scope = RETENTION_TABLES[table].scope;
      if (scope?.by !== 'parent') continue;
      const parentIndex = position.get(scope.parent);
      // 親が retain / global なら順番の対象外。
      if (parentIndex === undefined) continue;
      expect(position.get(table), `${table} は親 ${scope.parent} より先`).toBeLessThan(parentIndex);
    }
  });
});

describe('画像(R2)の鍵を持つ列', () => {
  it('列が実在し、その表が purge に入っているか retain として除かれている', () => {
    for (const { table, column } of RETENTION_R2_KEY_COLUMNS) {
      expect(schemaTables.has(table), `${table} が bootstrap.sql に無い`).toBe(true);
      expect(columnsOf(table).has(column), `${table}.${column} が無い`).toBe(true);
      expect(RETENTION_TABLES[table]).toBeDefined();
    }
  });

  it('bootstrap.sql にある画像の鍵の列を取りこぼしていない', () => {
    // 新しい表が R2 の鍵を持ったのに一覧へ足し忘れると、行だけ消えて画像が残る。
    const known = new Set(RETENTION_R2_KEY_COLUMNS.map(({ table, column }) => `${table}.${column}`));
    const found: string[] = [];
    for (const table of schemaTables) {
      for (const column of columnsOf(table)) {
        if (!/(^|_)(r2_key|object_key)$/.test(column)) continue;
        const key = `${table}.${column}`;
        if (!known.has(key)) found.push(key);
      }
    }
    expect(
      found.sort(),
      `画像の鍵らしい列が一覧にありません。RETENTION_R2_KEY_COLUMNS へ足すか、消さない理由を確かめてください: ${found.join(', ')}`,
    ).toEqual([]);
  });
});


describe('共有の工程記録の退会後削除', () => {
  it('同じ統括の直接記録とLINE記録だけを選び、アカウントより先に消す', () => {
    sqlite.exec("SAVEPOINT workflow_retention_test");
    try {
      sqlite.exec("INSERT INTO tenants(id,name) VALUES('workflow-tenant-a','A'),('workflow-tenant-b','B')");
      sqlite.exec("INSERT INTO line_accounts(id,tenant_id,name,channel_id,channel_access_token,channel_secret) VALUES('workflow-account-a','workflow-tenant-a','A','workflow-channel-a','test','test'),('workflow-account-b','workflow-tenant-b','B','workflow-channel-b','test','test')");
      const scopes=['tenant:workflow-tenant-a','line:workflow-account-a','tenant:workflow-tenant-b','line:workflow-account-b'];
      const insert=sqlite.prepare(`INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,retry_key,created_at,updated_at) VALUES(?,'test','retention','test','key',0,0)`);
      for(const scope of scopes)insert.run(scope);
      const rows=sqlite.prepare(`SELECT scope_id FROM workflow_steps WHERE ${tenantScopeCondition('workflow_steps')} ORDER BY scope_id`).all('workflow-tenant-a');
      expect(rows).toEqual([{scope_id:'line:workflow-account-a'},{scope_id:'tenant:workflow-tenant-a'}]);
      const order=purgeTablesChildFirst();
      expect(order.indexOf('workflow_steps')).toBeLessThan(order.indexOf('line_accounts'));
    } finally {sqlite.exec("ROLLBACK TO workflow_retention_test; RELEASE workflow_retention_test");}
  });
});


describe('認証と統括メンバーの保存期限', () => {
  it('期限切れの統括だけを選び、別の統括と未ログインのチャレンジを残す', () => {
    sqlite.exec('SAVEPOINT auth_retention');
    try {
      sqlite.exec(`
        INSERT INTO tenants(id,name) VALUES('auth-retention-a','A'),('auth-retention-b','B');
        INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES
          ('auth-staff-a','A','admin','auth-key-a','auth-retention-a'),
          ('auth-staff-b','B','admin','auth-key-b','auth-retention-b');
        INSERT INTO line_accounts(id,tenant_id,name,channel_id,channel_access_token,channel_secret) VALUES
          ('auth-account-a','auth-retention-a','A','auth-channel-a','test','test'),
          ('auth-account-b','auth-retention-b','B','auth-channel-b','test','test');
        INSERT INTO line_account_hq_admin_memberships(line_account_id,staff_id) VALUES
          ('auth-account-a','auth-staff-a'),('auth-account-b','auth-staff-b');
        INSERT INTO staff_passkeys(credential_id,staff_id,public_key,device_type,backed_up,created_at) VALUES
          ('credential-a','auth-staff-a','test','singleDevice',0,'2026-11-04'),
          ('credential-b','auth-staff-b','test','singleDevice',0,'2026-11-04');
        INSERT INTO staff_passkey_challenges(token_hash,challenge,purpose,staff_id,expires_at,created_at) VALUES
          ('challenge-a','test','register','auth-staff-a','2026-11-05','2026-11-04'),
          ('challenge-b','test','register','auth-staff-b','2026-11-05','2026-11-04'),
          ('challenge-login','test','login',NULL,'2026-11-05','2026-11-04');
      `);
      for (const table of ['line_account_hq_admin_memberships','staff_passkey_challenges','staff_passkeys']) {
        sqlite.prepare(`DELETE FROM ${table} WHERE ${tenantScopeCondition(table)}`).run('auth-retention-a');
      }
      expect(sqlite.prepare('SELECT staff_id FROM staff_passkeys').all()).toEqual([{staff_id:'auth-staff-b'}]);
      expect(sqlite.prepare('SELECT staff_id FROM line_account_hq_admin_memberships').all()).toEqual([{staff_id:'auth-staff-b'}]);
      expect(sqlite.prepare('SELECT token_hash FROM staff_passkey_challenges ORDER BY token_hash').all())
        .toEqual([{token_hash:'challenge-b'},{token_hash:'challenge-login'}]);
    } finally { sqlite.exec('ROLLBACK TO auth_retention; RELEASE auth_retention'); }
  });
  it('申込の審査記録は削除対象へ含めず、認証の子は担当者より先に処理する', () => {
    const order=purgeTablesChildFirst();
    expect(RETENTION_TABLES.registration_applications.category).toBe('retain');
    expect(order).not.toContain('registration_applications');
    for(const table of ['staff_passkey_challenges','staff_passkeys']) {
      expect(order.indexOf(table)).toBeLessThan(order.indexOf('staff_members'));
    }
  });
});
