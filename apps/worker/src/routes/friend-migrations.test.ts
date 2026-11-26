import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';

const db = {
  UID_EVIDENCE_TYPES: ['same_provider', 'line_login', 'signed_customer_id', 'verified_contact', 'operator_csv', 'manual'],
  countUidMigrationItemDecisions: vi.fn(),
  countUidMigrationItems: vi.fn(),
  createUidMigrationRun: vi.fn(),
  getUidMigrationRun: vi.fn(),
  listUidMigrationItems: vi.fn(),
  listUidMigrationRuns: vi.fn(),
  protectCsvCell: vi.fn((value: string | null) => value ?? ''),
};
vi.mock('@line-crm/db', async (importOriginal) => ({ ...await importOriginal<typeof import('@line-crm/db')>(), ...db }));

const accountAccess = { canAccessAllLineAccounts: vi.fn(), getVisibleLineAccountScope: vi.fn() };
vi.mock('../services/account-access.js', () => accountAccess);

const { friendMigrations } = await import('./friend-migrations.js');
const run = vi.fn();
const first = vi.fn();
const all = vi.fn(async (): Promise<{ results: Array<Record<string, unknown>> }> => ({ results: [] }));
const bind = vi.fn(() => ({ run, first, all }));
const prepare = vi.fn((_sql: string) => ({ bind }));
const env = { DB: { prepare, batch: vi.fn() } as unknown as D1Database };

const RUN = {
  id: 'run-1', from_account_id: 'from', to_account_id: 'to', purpose: '移行', source_kind: 'csv',
  source_filename: 'map.csv', source_checksum: 'sum', status: 'ready', dry_run_revision: 1,
  total_count: 1, auto_count: 1, review_count: 0, unmatched_count: 0, conflict_count: 0,
  applied_count: 0, failed_count: 0, created_by: 'owner-1', approved_by: null,
  created_at: '2026-09-06T00:00:00Z', reviewed_at: null, executed_at: null,
  completed_at: null, rolled_back_at: null, failure_reason: null,
};

function appFor(staff: AuthenticatedStaff = { id: 'owner-1', name: '作成者', role: 'owner', readOnly: false }) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => { c.set('staff', staff); await next(); });
  app.route('/', friendMigrations);
  return app;
}

function post(path: string, body: unknown) {
  return new Request(`https://example.com${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  accountAccess.canAccessAllLineAccounts.mockResolvedValue(true);
  accountAccess.getVisibleLineAccountScope.mockResolvedValue({ allowedAccountIds: ['from', 'to'] });
  db.getUidMigrationRun.mockResolvedValue(RUN);
  db.listUidMigrationItems.mockResolvedValue([]);
  db.countUidMigrationItems.mockResolvedValue(0);
  db.countUidMigrationItemDecisions.mockResolvedValue({ pending: 0, link: 0, create: 0, exclude: 0 });
  db.listUidMigrationRuns.mockResolvedValue([RUN]);
  db.createUidMigrationRun.mockResolvedValue(RUN);
  run.mockResolvedValue({ meta: { changes: 1 } });
  vi.mocked(env.DB.batch).mockResolvedValue([]);
});

describe('UID移行API', () => {
  it('配信停止の引き継ぎは照合できない間、0やずれなしにしない', async () => {
    const response=await appFor().request('/api/friends/migrations/run-1',{},env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({data:{suppressionReconciliation:{status:'unavailable',transferredCount:null,mismatchCount:null,reason:'delivery_consent_snapshot_missing'}}});
  });
  it('dry-runは対象アカウントの権限を確認する', async () => {
    accountAccess.canAccessAllLineAccounts.mockResolvedValue(false);
    const response = await appFor().fetch(post('/api/friends/migrations', {
      fromAccountId: 'from', toAccountId: 'to', purpose: '移行',
      mappings: [{ oldUid: 'old', newUid: 'new', evidenceType: 'operator_csv' }],
    }), env);
    expect(response.status).toBe(404);
    expect(db.createUidMigrationRun).not.toHaveBeenCalled();
  });

  it('dry-runは元のfriendsを書き換えない', async () => {
    const response = await appFor().fetch(post('/api/friends/migrations', {
      fromAccountId: 'from', toAccountId: 'to', purpose: '移行',
      mappings: [{ oldUid: 'old', newUid: 'new', evidenceType: 'operator_csv' }],
    }), env);
    expect(response.status).toBe(201);
    expect(db.createUidMigrationRun).toHaveBeenCalled();
    expect(prepare.mock.calls.some(([sql]) => /UPDATE\s+friends/i.test(String(sql)))).toBe(false);
  });

  it('作成者本人だけでは本移行できない', async () => {
    const response = await appFor().fetch(post('/api/friends/migrations/run-1/execute', {}), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('別のowner') });
  });

  it('staffは本移行できない', async () => {
    const response = await appFor({ id: 'staff-1', name: '担当者', role: 'staff', readOnly: false })
      .fetch(post('/api/friends/migrations/run-1/execute', {}), env);
    expect(response.status).toBe(403);
  });

  it('一致先のない行にcreateは選べない', async () => {
    first.mockReset();
    first.mockResolvedValue({ id: 'item-1', old_friend_id: 'f-old', new_friend_id: null });
    const response = await appFor().fetch(new Request('https://example.com/api/friends/migrations/run-1/items/item-1', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'create' }),
    }), env);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('新規作成できません') });
  });
});

describe('対応表のページ送り', () => {
  const ITEM = {
    id: 'item-1', old_uid: 'old-1', new_uid: 'new-1', candidate_name: '候補',
    evidence_type: 'operator_csv', classification: 'review', conflict_reason: null,
    decision: 'pending', result: 'pending', error_message: null,
  };

  it('件数と未判断数をそろえて返す', async () => {
    db.listUidMigrationItems.mockResolvedValue([ITEM]);
    db.countUidMigrationItems.mockResolvedValueOnce(25).mockResolvedValueOnce(3);
    const response = await appFor().fetch(new Request('https://example.com/api/friends/migrations/run-1'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        itemTotal: 25, itemLimit: 20, itemOffset: 0, unresolved: 3,
        items: [{ id: 'item-1', oldUid: 'old-1', newUid: 'new-1', decision: 'pending' }],
      },
    });
    expect(db.listUidMigrationItems).toHaveBeenCalledWith(
      expect.anything(), 'run-1',
      { classifications: undefined, pendingOnly: undefined },
      { limit: 20, offset: 0 },
    );
  });

  it('分類と未判断のみを受け付ける', async () => {
    await appFor().fetch(
      new Request('https://example.com/api/friends/migrations/run-1?limit=5&offset=10&classification=review&pendingOnly=1'),
      env,
    );
    expect(db.listUidMigrationItems).toHaveBeenCalledWith(
      expect.anything(), 'run-1',
      { classifications: ['review'], pendingOnly: true },
      { limit: 5, offset: 10 },
    );
    expect(db.countUidMigrationItems).toHaveBeenCalledWith(
      expect.anything(), 'run-1', { classifications: ['review'], pendingOnly: true },
    );
  });

  it('知らない分類は断る', async () => {
    const response = await appFor().fetch(
      new Request('https://example.com/api/friends/migrations/run-1?classification=maybe'),
      env,
    );
    expect(response.status).toBe(400);
    expect(db.listUidMigrationItems).not.toHaveBeenCalled();
  });
});

describe('取り込みの競合検出と実行', () => {
  const VALUES = { displayName: '表示', realName: null, systemDisplayName: null };

  it('対象アカウントのUIDだけを見る', async () => {
    first.mockReset();
    await appFor().fetch(post('/api/friends/imports', {
      accountId: 'acc-1', sourceFilename: 'in.csv', sourceChecksum: 'sum-1',
      rows: [{ lineUid: 'U1', ...VALUES }],
    }), env);
    const statements = prepare.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => /FROM friends/.test(sql))).toEqual([
      expect.stringMatching(/line_account_id = \? AND line_platform_user_id = \?/),
    ]);
  });

  it('別アカウントにもいる利用者を取り込み、対象の実UIDを書き出す', async () => {
    const { db: realDb, raw } = createTestD1({ foreignKeys: true });
    try {
      raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES
        ('acc-1','1001','対象','fixture','fixture'),('acc-2','1002','別店','fixture','fixture');
        INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES ('elsewhere','U9','acc-2','別店の履歴');`);
      const app = appFor();
      const vars = { DB: realDb };
      const response = await app.fetch(post('/api/friends/imports', {
        accountId: 'acc-1', sourceFilename: 'in.csv', sourceChecksum: 'sum-2',
        rows: [{ lineUid: 'U9', ...VALUES }],
      }), vars);
      expect(response.status).toBe(201);
      const preview = await response.json() as { data: { id: string; result: { rows: Array<{ kind: string }> } } };
      expect(preview.data.result.rows[0].kind).toBe('add');
      const execution = await app.fetch(post(`/api/friends/imports/${preview.data.id}/execute`, {}), vars);
      expect(execution.status).toBe(200);
      expect(raw.prepare(`SELECT line_account_id,display_name FROM friends WHERE line_platform_user_id=? ORDER BY line_account_id`).all('U9'))
        .toEqual([{ line_account_id: 'acc-1', display_name: '表示' }, { line_account_id: 'acc-2', display_name: '別店の履歴' }]);
      const exportResponse = await app.fetch(post('/api/friends/exports', { accountId: 'acc-1' }), vars);
      expect(exportResponse.status).toBe(201);
      const requestedExport = await exportResponse.json() as { data: { downloadUrl: string } };
      const csv = await (await app.request(requestedExport.data.downloadUrl, {}, vars)).text();
      expect(csv).toContain('U9,表示');
      expect(csv).not.toContain('musubo-scope:');
      expect(csv).not.toContain('別店の履歴');
    } finally { raw.close(); }
  });

  it('旧ルールで止まったファイルは同じデータを再確認できる', async () => {
    first.mockReset();
    first.mockResolvedValueOnce({ id: 'legacy', status: 'previewed', rows_json: JSON.stringify([{ lineUid: 'U9', ...VALUES }]),
      result_json: JSON.stringify({ rows: [{ kind: 'conflict', reason: '別のLINEアカウントに同じUIDがあります' }] }) })
      .mockResolvedValueOnce(null);
    const response = await appFor().fetch(post('/api/friends/imports', {
      accountId: 'acc-1', sourceFilename: 'in.csv', sourceChecksum: 'legacy-sum',
      rows: [{ lineUid: 'changed', ...VALUES }],
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: 'legacy',
      result: { rows: [{ lineUid: 'U9', kind: 'add' }] }, duplicate: false } });
    expect(prepare.mock.calls.some(([sql]) => /UPDATE friend_import_jobs/.test(sql))).toBe(true);
  });

  it('確認後に同じアカウントで友だちが増えたときは取り込みを部分適用しない', async () => {
    const { db: realDb, raw } = createTestD1({ foreignKeys: true });
    try {
      raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret)
        VALUES ('acc-1','1001','対象','fixture','fixture')`);
      const app = appFor();
      const vars = { DB: realDb };
      const response = await app.fetch(post('/api/friends/imports', {
        accountId: 'acc-1', sourceFilename: 'in.csv', sourceChecksum: 'scope-race',
        rows: [{ lineUid: 'U1', ...VALUES }, { lineUid: 'U2', ...VALUES }],
      }), vars);
      const preview = await response.json() as { data: { id: string } };
      raw.exec(`INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES ('received','U2','acc-1','受信した名前')`);
      const execute = await app.fetch(post(`/api/friends/imports/${preview.data.id}/execute`, {}), vars);
      expect(execute.status).toBe(409);
      expect(raw.prepare(`SELECT line_platform_user_id,display_name FROM friends WHERE line_account_id='acc-1'`).all())
        .toEqual([{ line_platform_user_id: 'U2', display_name: '受信した名前' }]);
      expect(raw.prepare(`SELECT status FROM friend_import_jobs WHERE id=?`).get(preview.data.id)).toEqual({ status: 'previewed' });
    } finally { raw.close(); }
  });

  it('競合が残る実行は409で止める', async () => {
    first.mockReset();
    first.mockResolvedValue({
      id: 'job-1', line_account_id: 'acc-1', status: 'previewed',
      result_json: JSON.stringify({ rows: [{ lineUid: 'U1', kind: 'conflict', values: VALUES }] }),
    });
    const response = await appFor().fetch(post('/api/friends/imports/job-1/execute', {}), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('競合') });
    const statements = prepare.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /INSERT INTO friends|UPDATE friend_import_jobs/.test(sql))).toBe(false);
  });

  it('入力不備が残る実行は422で止める', async () => {
    first.mockReset();
    first.mockResolvedValue({
      id: 'job-2', line_account_id: 'acc-1', status: 'previewed',
      result_json: JSON.stringify({ rows: [{ lineUid: '', kind: 'error', values: VALUES }] }),
    });
    const response = await appFor().fetch(post('/api/friends/imports/job-2/execute', {}), env);
    expect(response.status).toBe(422);
    const statements = prepare.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /INSERT INTO friends|UPDATE friend_import_jobs/.test(sql))).toBe(false);
  });

  it('きれいな確認ずみは反映できる', async () => {
    first.mockReset();
    first.mockResolvedValue({
      id: 'job-3', line_account_id: 'acc-1', status: 'previewed',
      result_json: JSON.stringify({ rows: [{ lineUid: 'U1', kind: 'add', values: VALUES }] }),
    });
    const response = await appFor().fetch(post('/api/friends/imports/job-3/execute', {}), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { status: 'completed' } });
  });
});

it('同じプロバイダーのUID移行確認で移行元と移行先を別の行として解決する', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
  const { db: realDb, raw } = createTestD1({ foreignKeys: true });
  try {
    raw.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES
      ('from','1001','移行元','fixture','fixture'),('to','1002','移行先','fixture','fixture');
      INSERT INTO friends(id,line_user_id,line_account_id) VALUES
      ('old-friend','U-shared','from'),('new-friend','musubo-scope:new-friend:U-shared','to');`);
    const migration = await actual.createUidMigrationRun(realDb, {
      fromAccountId: 'from', toAccountId: 'to', purpose: '確認', sourceKind: 'verified_api',
      mappings: [{ oldUid: 'U-shared', newUid: 'U-shared', evidenceType: 'same_provider' }], createdBy: 'owner-1',
    });
    const items = await actual.listUidMigrationItems(realDb, migration.id);
    expect(items).toMatchObject([{ old_friend_id: 'old-friend', new_friend_id: 'new-friend', classification: 'auto' }]);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM friends WHERE user_id IS NOT NULL`).get()).toEqual({ count: 0 });
  } finally { raw.close(); }
});

/**
 * 一部失敗の切り戻し・移行後変更の照合・
 * 二重実行の抑止。実Honoルートに模擬DBを当てる。
 */
const APPLIED_ITEM = {
  id: 'item-1', run_id: 'run-1', old_uid: 'UOLD-1', new_uid: 'UNEW-1',
  old_friend_id: 'f-old', new_friend_id: 'f-new', candidate_name: '候補',
  evidence_type: 'operator_csv', evidence_json: '{}', classification: 'auto',
  conflict_reason: null, decision: 'link', decided_by: 'owner-1', decided_at: '2026-09-20T01:00:00Z',
  result: 'applied',
  before_json: JSON.stringify({ oldUserId: 'user-a', newUserId: null }),
  after_json: JSON.stringify({ userId: 'user-merged' }),
  error_message: null, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-20T02:00:00Z',
};

describe('切り戻しの可否と照合（FRIEND-34/35/36）', () => {
  it('実行前の移行は切り戻せない', async () => {
    db.getUidMigrationRun.mockResolvedValue({ ...RUN, status: 'review' });
    const response = await appFor().fetch(post('/api/friends/migrations/run-1/rollback', {}), env);
    expect(response.status).toBe(409);
    expect(prepare.mock.calls.some(([sql]) => /UPDATE\s+friends/i.test(String(sql)))).toBe(false);
  });

  it('切り戻し済みへの二重実行は何も書かない', async () => {
    db.getUidMigrationRun.mockResolvedValue({ ...RUN, status: 'rolled_back' });
    const response = await appFor().fetch(post('/api/friends/migrations/run-1/rollback', {}), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('すでに切り戻し済み') });
    expect(prepare.mock.calls.some(([sql]) => /UPDATE\s+friends/i.test(String(sql)))).toBe(false);
    expect(env.DB.batch).not.toHaveBeenCalled();
  });

  it('失敗0件の移行は切り戻せない', async () => {
    db.getUidMigrationRun.mockResolvedValue({ ...RUN, status: 'failed', applied_count: 0, failed_count: 2 });
    const response = await appFor().fetch(post('/api/friends/migrations/run-1/rollback', {}), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('切り戻す対象がありません') });
  });

  it('一部失敗（failed かつ applied>0）でも反映済みの行だけ切り戻せる', async () => {
    const partial = { ...RUN, status: 'failed', applied_count: 1, failed_count: 1 };
    db.getUidMigrationRun.mockResolvedValueOnce(partial).mockResolvedValue({ ...partial, status: 'rolled_back' });
    db.listUidMigrationItems.mockResolvedValue([
      APPLIED_ITEM,
      { ...APPLIED_ITEM, id: 'item-2', result: 'failed', before_json: null, after_json: null },
    ]);
    all.mockResolvedValue({ results: [
      { id: 'f-old', user_id: 'user-merged' },
      { id: 'f-new', user_id: 'user-merged' },
    ] });
    // ペア2件の書き戻しは1文で2件一致する。
    run.mockResolvedValue({ meta: { changes: 2 } });
    vi.mocked(env.DB.batch).mockResolvedValue([{ meta: { changes: 2 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }] as never);
    const response = await appFor().fetch(post('/api/friends/migrations/run-1/rollback', {}), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { status: string; rolledBack: number; rollbackable: boolean } };
    expect(body.data.status).toBe('rolled_back');
    expect(body.data.rolledBack).toBe(1);
    expect(body.data.rollbackable).toBe(false);
    // 現在値をWHERE条件に含む書き戻し（照合と書込みの二重防御）。
    // ペア2件は1文（CASE）で同時に戻し、部分復旧を出さない。
    const sqls = prepare.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((sql) => /UPDATE friends\s+SET user_id = CASE/i.test(sql))).toBe(true);
    expect(sqls.some((sql) => /user_id IS \?/.test(sql))).toBe(true);
    // 失敗行（item-2）へは何も書かない。
    expect(env.DB.batch).toHaveBeenCalledTimes(2);
    // 友だちの復元と配信停止・同意の復元は同一batch。
    expect(vi.mocked(env.DB.batch).mock.calls[0][0]).toHaveLength(2);
  });

  it('移行後に統合ユーザーが変わった行は1件も書き戻さず競合を返す', async () => {
    db.getUidMigrationRun.mockResolvedValue({ ...RUN, status: 'completed', applied_count: 1 });
    db.listUidMigrationItems.mockResolvedValue([APPLIED_ITEM]);
    all.mockResolvedValue({ results: [
      { id: 'f-old', user_id: 'user-other' },
      { id: 'f-new', user_id: 'user-merged' },
    ] });
    const response = await appFor().fetch(post('/api/friends/migrations/run-1/rollback', {}), env);
    expect(response.status).toBe(409);
    const body = await response.json() as { data: { conflicts: Array<{ itemId: string; reason: string }> } };
    expect(body.data.conflicts).toHaveLength(1);
    expect(body.data.conflicts[0].itemId).toBe('item-1');
    expect(prepare.mock.calls.some(([sql]) => /UPDATE\s+friends/i.test(String(sql)))).toBe(false);
    expect(env.DB.batch).not.toHaveBeenCalled();
  });

  it('前回の切り戻しが途中で止まった行は冪等に rolled_back へ寄せる', async () => {
    db.getUidMigrationRun.mockResolvedValueOnce({ ...RUN, status: 'completed', applied_count: 1 })
      .mockResolvedValue({ ...RUN, status: 'rolled_back', applied_count: 1 });
    db.listUidMigrationItems.mockResolvedValue([APPLIED_ITEM]);
    // friends はすでに移行前の状態（user-a / null）へ戻っている。
    all.mockResolvedValue({ results: [
      { id: 'f-old', user_id: 'user-a' },
      { id: 'f-new', user_id: null },
    ] });
    const response = await appFor().fetch(post('/api/friends/migrations/run-1/rollback', {}), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { status: string; rolledBack: number } };
    expect(body.data.status).toBe('rolled_back');
    expect(body.data.rolledBack).toBe(1);
    // friends への UPDATE は発行せず、項目の result だけ寄せる。
    expect(prepare.mock.calls.some(([sql]) => /UPDATE\s+friends/i.test(String(sql)))).toBe(false);
    const sqls = prepare.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((sql) => /UPDATE uid_migration_items SET result = 'rolled_back'/.test(sql))).toBe(true);
  });

  it('staffは切り戻せない', async () => {
    const response = await appFor({ id: 'staff-1', name: '担当者', role: 'staff', readOnly: false })
      .fetch(post('/api/friends/migrations/run-1/rollback', {}), env);
    expect(response.status).toBe(403);
  });
});

describe('一部失敗からの再実行（FRIEND-34）', () => {
  it('未判断の残っていない失敗履歴は再実行でき、反映済みの行は触らない', async () => {
    const partial = { ...RUN, status: 'failed', applied_count: 1, failed_count: 1 };
    db.getUidMigrationRun.mockResolvedValueOnce(partial).mockResolvedValue({ ...partial, status: 'completed' });
    db.countUidMigrationItems.mockResolvedValue(0);
    db.listUidMigrationItems.mockResolvedValue([
      APPLIED_ITEM,
      { ...APPLIED_ITEM, id: 'item-2', result: 'failed', old_friend_id: 'f-o2', new_friend_id: 'f-n2' },
    ]);
    all.mockResolvedValue({ results: [
      { id: 'f-o2', user_id: null, display_name: '旧2' },
      { id: 'f-n2', user_id: 'user-x', display_name: '新2' },
    ] });
    // recountMigrationResults の集計。
    first.mockResolvedValue({ applied: 2, failed: 0 });
    const response = await appFor({ id: 'owner-2', name: '別のowner', role: 'owner', readOnly: false })
      .fetch(post('/api/friends/migrations/run-1/execute', {}), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { status: string } };
    expect(body.data.status).toBe('completed');
    // applied 済みの item-1 は再適用しない。書き込みは item-2 の1件分だけ。
    expect(env.DB.batch).toHaveBeenCalledTimes(1);
  });

  it('完了済みの移行は再実行しない', async () => {
    db.getUidMigrationRun.mockResolvedValue({ ...RUN, status: 'completed' });
    const response = await appFor({ id: 'owner-2', name: '別のowner', role: 'owner', readOnly: false })
      .fetch(post('/api/friends/migrations/run-1/execute', {}), env);
    expect(response.status).toBe(409);
  });

  it('失敗した移行でも判断を直せる', async () => {
    db.getUidMigrationRun.mockResolvedValue({ ...RUN, status: 'failed', applied_count: 1, failed_count: 1 });
    first.mockReset();
    first.mockResolvedValueOnce({ id: 'item-2', run_id: 'run-1', old_friend_id: 'f-o2', new_friend_id: 'f-n2', decision: 'link' })
      .mockResolvedValue({ count: 0 });
    const response = await appFor().fetch(new Request('https://example.com/api/friends/migrations/run-1/items/item-2', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'exclude' }),
    }), env);
    expect(response.status).toBe(200);
  });

  it('判断別の件数を対応表の応答へ載せる（FRIEND-33）', async () => {
    db.countUidMigrationItemDecisions.mockResolvedValue({ pending: 0, link: 3, create: 0, exclude: 2 });
    const response = await appFor().fetch(new Request('https://example.com/api/friends/migrations/run-1'), env);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { decisionCounts: { link: number; exclude: number } } };
    expect(body.data.decisionCounts).toMatchObject({ link: 3, exclude: 2 });
  });
});

describe('友だちの書き出しは対応する項目だけを選べる', () => {
  it('未対応の項目は作らせず理由を返す', async () => {
    for (const columns of [['basic', 'tags_fields'], ['support'], ['basic', 'tags_fields', 'support']]) {
      const response = await appFor().fetch(post('/api/friends/exports', {
        accountId: 'from', columns, encoding: 'utf-8',
      }), env);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('まだ使えません') });
    }
  });

  it('基本だけは作れる', async () => {
    first.mockResolvedValue({ count: 3 });
    const response = await appFor().fetch(post('/api/friends/exports', {
      accountId: 'from', columns: ['basic'], encoding: 'utf-8',
    }), env);
    expect(response.status).toBe(201);
    const body = await response.json() as { success: boolean; data: { rowCount: number } };
    expect(body.data.rowCount).toBe(3);
  });
});
