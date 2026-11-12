/*
 * 成果承認の競合・権限・一括結果。
 *
 * 実DB（better-sqlite3 + bootstrap.sql）に実物の conversions ルートを当てる。
 * モックは LINE 通知と staff の注入だけ。保存・判定・境界の経路は本物のまま通す。
 *   - expectedStatusなし/不正は400で、行は動かない
 *   - 同じ未判断を見た2主体は片方だけ通り、もう片方は409で上書きしない
 *   - 同じ判断の再送は冪等成功（反対仕訳の二重起票なし）
 *   - 権限ありstaffだけ通り、権限なし・別アカウント・別tenantは拒否
 *   - 一括は成功/競合/拒否/失敗を分けて返し、途中失敗を全成功と表示しない
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { setConversionApproval } from '@line-crm/db';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';

const notifyAffiliateApproval = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/affiliate-notifier.js', () => ({ notifyAffiliateApproval }));

const { conversions } = await import('./conversions.js');

let sqlite: SqliteD1;

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: '統括1のオーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};
const keyStaff: AuthenticatedStaff = {
  id: 'staff-key', name: '承認権あり', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: ['/conversions', 'conversion.approval.edit'],
};
const halfKeyStaff: AuthenticatedStaff = {
  id: 'staff-half', name: '利用権のみ', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: ['/conversions'],
};
const noKeyStaff: AuthenticatedStaff = {
  id: 'staff-none', name: '権限なし', role: 'staff', readOnly: false, tenantId: 'tenant-1',
  permissionKeys: [],
};
const scopedAdmin: AuthenticatedStaff = {
  id: 'admin-scoped', name: '店1だけの管理者', role: 'admin', readOnly: false, tenantId: 'tenant-1',
};
const otherTenantOwner: AuthenticatedStaff = {
  id: 'owner-2', name: '統括2のオーナー', role: 'owner', readOnly: false, tenantId: 'tenant-2',
};

function app(staff: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: sqlite.db } as Env['Bindings'];
    c.set('staff', staff);
    await next();
  });
  instance.route('/', conversions);
  return instance;
}

function patch(eventId: string, body: unknown, staff: AuthenticatedStaff = owner) {
  return app(staff).request(`/api/conversions/events/${eventId}/approval`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function bulk(items: unknown, staff: AuthenticatedStaff = owner) {
  return app(staff).request('/api/conversions/approvals/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
}

function statusOf(eventId: string): string | null {
  const row = sqlite.raw.prepare(
    `SELECT approval_status FROM conversion_events WHERE id = ?`,
  ).get(eventId) as { approval_status: string | null } | undefined;
  return row?.approval_status ?? null;
}

function seed(): void {
  const raw = sqlite.raw;
  raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1')`).run();
  raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-2', '統括2')`).run();
  for (const [id, tenant] of [['acc-1', 'tenant-1'], ['acc-2', 'tenant-1'], ['acc-3', 'tenant-2']] as const) {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES (?, ?, ?, 'token', 'secret', 1, ?)`,
    ).run(id, `channel-${id}`, id, tenant);
  }
  const staffRows = [
    ['owner-1', '統括1のオーナー', 'owner', 'key-owner-1', 'tenant-1', 'all', '[]'],
    ['owner-2', '統括2のオーナー', 'owner', 'key-owner-2', 'tenant-2', 'all', '[]'],
    ['staff-key', '承認権あり', 'staff', 'key-staff', 'tenant-1', 'all', '["/conversions","conversion.approval.edit"]'],
    ['staff-half', '利用権のみ', 'staff', 'key-half', 'tenant-1', 'all', '["/conversions"]'],
    ['staff-none', '権限なし', 'staff', 'key-none', 'tenant-1', 'all', '[]'],
    ['admin-scoped', '店1だけの管理者', 'admin', 'key-scoped', 'tenant-1', 'accounts', '[]'],
  ] as const;
  for (const [id, name, role, key, tenant, scope, keys] of staffRows) {
    raw.prepare(
      `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope, permission_keys)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, role, key, tenant, scope, keys);
  }
  raw.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('admin-scoped', 'acc-1', '2026-09-01T00:00:00.000Z')`,
  ).run();
  raw.prepare(`INSERT INTO conversion_points (id, name, event_type, line_account_id) VALUES ('cp-1', '購入', 'purchase', 'acc-1')`).run();
  raw.prepare(`INSERT INTO conversion_points (id, name, event_type, line_account_id) VALUES ('cp-2', '購入', 'purchase', 'acc-2')`).run();
  raw.prepare(`INSERT INTO conversion_points (id, name, event_type, line_account_id) VALUES ('cp-3', '購入', 'purchase', 'acc-3')`).run();
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id) VALUES ('fr-1', 'U-1', '利用者1', 'acc-1')`,
  ).run();
  raw.prepare(
    `INSERT INTO affiliates (id, name, code, tenant_id, line_account_id) VALUES ('aff-1', '紹介者1', 'CODE1', 'tenant-1', 'acc-1')`,
  ).run();
}

function seedEvent(id: string, pointId: string, status: string | null): void {
  if (status === null) {
    sqlite.raw.prepare(
      `INSERT INTO conversion_events (id, conversion_point_id, friend_id, affiliate_id, created_at)
       VALUES (?, ?, 'fr-1', 'aff-1', '2026-09-01T00:00:00.000Z')`,
    ).run(id, pointId);
  } else {
    sqlite.raw.prepare(
      `INSERT INTO conversion_events (id, conversion_point_id, friend_id, affiliate_id, approval_status, approved_at, created_at)
       VALUES (?, ?, 'fr-1', 'aff-1', ?, '2026-09-02T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(id, pointId, status);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = createTestD1();
  seed();
});

describe('PATCH 承認の版契約(N-208)', () => {
  test('版列の有無に応じて一覧・承認・確認付き取消を処理する', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    sqlite.raw.exec('ALTER TABLE conversion_events DROP COLUMN approval_revision');
    seedEvent('ev-1', 'cp-1', 'approved');
    const events = () => app(owner).request('/api/conversions/definitions/cp-1/events');
    const before = await events();
    expect(before.status).toBe(200);
    const body = await before.json() as { data: { items: Array<{ approvalRevision: number | null }> } };
    expect(body.data.items[0].approvalRevision).toBeNull();
    expect((await patch('ev-1', {status:'rejected', expectedStatus:'approved'})).status).toBe(200);
    expect(await setConversionApproval(sqlite.db, 'ev-1', 'approved')).toBe(true);
    const cancel = (expectedApprovalStatus: string) => app(owner).request('/api/conversions/events/ev-1/reversals', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({kind:'reverse', reason:'確認済み', expectedReversalId:null, expectedApprovalStatus, expectedCancelled:false, expectedApprovalRevision:123}),
    });
    expect((await cancel('rejected')).status).toBe(409);
    expect((await cancel('approved')).status).toBe(200);
    sqlite.raw.exec('ALTER TABLE conversion_events ADD COLUMN approval_revision INTEGER NOT NULL DEFAULT 1');
    expect((await patch('ev-1', {status:'rejected', expectedStatus:'approved'})).status).toBe(200);
    expect(sqlite.raw.prepare("SELECT approval_revision FROM conversion_events WHERE id='ev-1'").get()).toEqual({approval_revision:2});
    const after = await (await events()).json() as { data: { items: Array<{ approvalRevision: number | null }> } };
    expect(after.data.items[0].approvalRevision).toBe(2);
    expect(warn).toHaveBeenCalledWith('conversion_approval_revision_unavailable');
    warn.mockRestore();
  });
  test('承認が変わって戻ったら古い成果取消の確認は効かず、新しい版なら取消できる', async () => {
    seedEvent('ev-1', 'cp-1', 'approved');
    const version=()=>sqlite.raw.prepare("SELECT approval_revision FROM conversion_events WHERE id='ev-1'").get() as {approval_revision:number};
    expect(version().approval_revision).toBe(1);
    expect((await patch('ev-1',{status:'rejected',expectedStatus:'approved'})).status).toBe(200);
    expect((await patch('ev-1',{status:'rejected',expectedStatus:'rejected'})).status).toBe(200);
    expect(version().approval_revision).toBe(2);
    expect((await patch('ev-1',{status:'approved',expectedStatus:'rejected'})).status).toBe(200);
    expect(version().approval_revision).toBe(3);
    const cancel=(revision:number)=>app(owner).request('/api/conversions/events/ev-1/reversals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'reverse',reason:'確認済み',expectedReversalId:null,expectedApprovalStatus:'approved',expectedCancelled:false,expectedApprovalRevision:revision})});
    expect((await cancel(1)).status).toBe(409);
    expect(sqlite.raw.prepare("SELECT COUNT(*) n FROM conversion_event_reversals WHERE conversion_event_id='ev-1'").get()).toEqual({n:0});
    expect((await cancel(3)).status).toBe(200);
  });
  test('旧承認経路でも状態変更だけ版が進み、同じ判断の再送は増えない', async () => {
    seedEvent('ev-1','cp-1','approved');
    const version=()=>sqlite.raw.prepare("SELECT approval_revision FROM conversion_events WHERE id='ev-1'").get() as {approval_revision:number};
    expect(await setConversionApproval(sqlite.db,'ev-1','rejected')).toBe(true);expect(version().approval_revision).toBe(2);
    expect(await setConversionApproval(sqlite.db,'ev-1','rejected')).toBe('already_set');expect(version().approval_revision).toBe(2);
    expect(await setConversionApproval(sqlite.db,'ev-1','approved')).toBe(true);expect(version().approval_revision).toBe(3);
  });
  test('取消のINSERT直前に承認が往復しても古い版では追記しない', async () => {
    seedEvent('ev-1','cp-1','approved');const prepare=sqlite.db.prepare.bind(sqlite.db);let intercepted=false;
    vi.spyOn(sqlite.db,'prepare').mockImplementation(sql=>{
      const stmt=prepare(sql);if(intercepted||!sql.includes('INSERT INTO conversion_event_reversals'))return stmt;intercepted=true;
      return new Proxy(stmt,{get(target,key){if(key==='bind')return (...args:unknown[])=>{
        const bound=target.bind(...args);return new Proxy(bound,{get(item,prop){if(prop==='run')return async()=>{
          expect((await patch('ev-1',{status:'rejected',expectedStatus:'approved'})).status).toBe(200);
          expect((await patch('ev-1',{status:'approved',expectedStatus:'rejected'})).status).toBe(200);
          return item.run();
        };const value=Reflect.get(item,prop);return typeof value==='function'?value.bind(item):value;}});
      };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    });
    const response=await app(owner).request('/api/conversions/events/ev-1/reversals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'reverse',reason:'確認済み',expectedReversalId:null,expectedApprovalStatus:'approved',expectedCancelled:false,expectedApprovalRevision:1})});
    expect(intercepted).toBe(true);expect(response.status).toBe(409);
    expect(sqlite.raw.prepare("SELECT COUNT(*) n FROM conversion_event_reversals WHERE conversion_event_id='ev-1'").get()).toEqual({n:0});
  });
  test('expectedStatusなしは400で、行は動かない', async () => {
    seedEvent('ev-1', 'cp-1', null);
    const res = await patch('ev-1', { status: 'approved' });
    expect(res.status).toBe(400);
    expect(statusOf('ev-1')).toBeNull();
  });

  test('不正なexpectedStatusは400で、行は動かない', async () => {
    seedEvent('ev-1', 'cp-1', null);
    for (const expectedStatus of ['v1', 1, null, '']) {
      const res = await patch('ev-1', { status: 'approved', expectedStatus });
      expect(res.status).toBe(400);
    }
    expect(statusOf('ev-1')).toBeNull();
  });

  test('一致すれば承認でき、版（承認時スナップショット）が作られる', async () => {
    seedEvent('ev-1', 'cp-1', null);
    const res = await patch('ev-1', { status: 'approved', expectedStatus: 'pending' });
    expect(res.status).toBe(200);
    expect(statusOf('ev-1')).toBe('approved');
    const snap = sqlite.raw.prepare(
      `SELECT id FROM affiliate_reward_calculations WHERE conversion_event_id = 'ev-1'`,
    ).get();
    expect(snap).toBeTruthy();
  });

  test('同じ未判断を見た2主体は片方だけ通り、もう片方は409で上書きしない', async () => {
    seedEvent('ev-1', 'cp-1', null);
    // AもBも未判断を見て同時に承認する。
    const first = await patch('ev-1', { status: 'approved', expectedStatus: 'pending' }, owner);
    const second = await patch('ev-1', { status: 'rejected', expectedStatus: 'pending' }, owner);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string; data: { currentStatus: string } };
    expect(body.code).toBe('approval_conflict');
    expect(body.data.currentStatus).toBe('approved');
    // 後勝ちの上書きは起きず、最初の判断が残る。
    expect(statusOf('ev-1')).toBe('approved');
  });

  test('承認ずみの却下（expectedStatus=pending）は409で、承認が残る', async () => {
    seedEvent('ev-1', 'cp-1', 'approved');
    const res = await patch('ev-1', { status: 'rejected', expectedStatus: 'pending' });
    expect(res.status).toBe(409);
    expect(statusOf('ev-1')).toBe('approved');
  });

  test('同じ判断の再送は冪等成功し、反対仕訳を二重に起こさない', async () => {
    seedEvent('ev-1', 'cp-1', 'rejected');
    const before = sqlite.raw.prepare(
      `SELECT COUNT(*) AS n FROM affiliate_reward_entries WHERE conversion_event_id = 'ev-1'`,
    ).get() as { n: number };
    const res = await patch('ev-1', { status: 'rejected', expectedStatus: 'rejected' });
    expect(res.status).toBe(200);
    const after = sqlite.raw.prepare(
      `SELECT COUNT(*) AS n FROM affiliate_reward_entries WHERE conversion_event_id = 'ev-1'`,
    ).get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(statusOf('ev-1')).toBe('rejected');
  });

  test('存在しない成果・帰属なしは404', async () => {
    seedEvent('ev-1', 'cp-1', null);
    const missing = await patch('nope', { status: 'approved', expectedStatus: 'pending' });
    expect(missing.status).toBe(404);
    sqlite.raw.prepare(
      `INSERT INTO conversion_events (id, conversion_point_id, friend_id, created_at)
       VALUES ('ev-plain', 'cp-1', 'fr-1', '2026-09-01T00:00:00.000Z')`,
    ).run();
    const plain = await patch('ev-plain', { status: 'approved', expectedStatus: 'pending' });
    expect(plain.status).toBe(404);
    expect(statusOf('ev-plain')).toBeNull();
  });
});

describe('PATCH 承認の権限(N-209)', () => {
  test('承認keyありstaffは通る', async () => {
    seedEvent('ev-1', 'cp-1', null);
    const res = await patch('ev-1', { status: 'approved', expectedStatus: 'pending' }, keyStaff);
    expect(res.status).toBe(200);
    expect(statusOf('ev-1')).toBe('approved');
  });

  test('keyなしstaff・利用権のみstaffは403で、行は動かない', async () => {
    seedEvent('ev-1', 'cp-1', null);
    seedEvent('ev-2', 'cp-1', null);
    const denied = await patch('ev-1', { status: 'approved', expectedStatus: 'pending' }, noKeyStaff);
    const half = await patch('ev-2', { status: 'approved', expectedStatus: 'pending' }, halfKeyStaff);
    expect(denied.status).toBe(403);
    expect(half.status).toBe(403);
    expect(statusOf('ev-1')).toBeNull();
    expect(statusOf('ev-2')).toBeNull();
  });

  test('担当外アカウントの管理者は404で、行は動かない', async () => {
    seedEvent('ev-1', 'cp-2', null);
    const res = await patch('ev-1', { status: 'approved', expectedStatus: 'pending' }, scopedAdmin);
    expect(res.status).toBe(404);
    expect(statusOf('ev-1')).toBeNull();
  });

  test('別tenantのオーナーは他統括の成果に404で、行は動かない', async () => {
    // acc-1はtenant-1。tenant-2のオーナーには見えない。
    seedEvent('ev-1', 'cp-1', null);
    const res = await patch('ev-1', { status: 'approved', expectedStatus: 'pending' }, otherTenantOwner);
    expect(res.status).toBe(404);
    expect(statusOf('ev-1')).toBeNull();
  });
});

describe('POST 一括承認の結果区分(N-213)', () => {
  test('成功・競合・拒否・失敗を分けて返し、途中失敗を全成功としない', async () => {
    seedEvent('ev-ok', 'cp-1', null);
    seedEvent('ev-taken', 'cp-1', 'approved');
    seedEvent('ev-other', 'cp-2', null);
    const res = await bulk([
      { id: 'ev-ok', status: 'approved', expectedStatus: 'pending' },
      // すでに承認ずみを古い未判断のまま送る → 競合
      { id: 'ev-taken', status: 'rejected', expectedStatus: 'pending' },
      // 担当外（scoped管理者には見えない） → 拒否
      { id: 'ev-other', status: 'approved', expectedStatus: 'pending' },
      // 版なし → 失敗（全体400にはしない）
      { id: 'ev-ok', status: 'approved' },
    ], scopedAdmin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: {
      succeeded: string[];
      conflicted: Array<{ id: string; currentStatus: string }>;
      denied: string[];
      failed: Array<{ id: string; error: string }>;
    } };
    expect(body.data.succeeded).toEqual(['ev-ok']);
    expect(body.data.conflicted).toEqual([{ id: 'ev-taken', currentStatus: 'approved' }]);
    expect(body.data.denied).toEqual(['ev-other']);
    expect(body.data.failed).toEqual([{ id: 'ev-ok', error: 'expectedStatus must be pending, approved, or rejected' }]);
    // 成功分だけ通り、競合・拒否分は動かない。
    expect(statusOf('ev-ok')).toBe('approved');
    expect(statusOf('ev-taken')).toBe('approved');
    expect(statusOf('ev-other')).toBeNull();
  });

  test('空・101件は400で、何も保存しない', async () => {
    seedEvent('ev-ok', 'cp-1', null);
    const empty = await bulk([]);
    expect(empty.status).toBe(400);
    const tooMany = await bulk(
      Array.from({ length: 101 }, (_, i) => ({ id: `ev-${i}`, status: 'approved', expectedStatus: 'pending' })),
    );
    expect(tooMany.status).toBe(400);
    expect(statusOf('ev-ok')).toBeNull();
  });

  test('keyなしstaffの一括は403', async () => {
    seedEvent('ev-ok', 'cp-1', null);
    const res = await bulk([{ id: 'ev-ok', status: 'approved', expectedStatus: 'pending' }], noKeyStaff);
    expect(res.status).toBe(403);
    expect(statusOf('ev-ok')).toBeNull();
  });
});
