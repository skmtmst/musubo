/*
 * 一覧・集計・ページ送りで契約を取り落とさないよう、友だち600人の契約900件を実 SQLite に入れ、全件への到達と件数を確かめる。
 * アカウント可視範囲の判定だけを差し替え、SQL と集計は実処理を通す。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const mocks = vi.hoisted(() => ({ canAccess: vi.fn(), scope: vi.fn() }));
vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: mocks.canAccess,
  getVisibleLineAccountScope: mocks.scope,
}));

const { ecCommerce } = await import('./ec-commerce.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = readFileSync(join(HERE, '..', '..', '..', '..', 'packages', 'db', 'bootstrap.sql'), 'utf8');

let sqlite: Database.Database;

/** better-sqlite3 を D1 の口にかぶせる。SQL はそのまま流す。 */
function asD1(): D1Database {
  function prepare(query: string): D1PreparedStatement {
    const make = (params: unknown[]): D1PreparedStatement => ({
      bind: (...next: unknown[]) => make(next),
      async all<T>() { return { results: sqlite.prepare(query).all(...params) as T[], success: true, meta: {} }; },
      async first<T>() { return (sqlite.prepare(query).get(...params) as T | undefined) ?? null; },
      async run() { const info = sqlite.prepare(query).run(...params); return { meta: { changes: info.changes } }; },
      raw: async () => [],
    } as unknown as D1PreparedStatement);
    return make([]);
  }
  return { prepare } as unknown as D1Database;
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = { DB: asD1() } as never;
    c.set('staff', {
      id: 'staff-1', name: '担当', role: 'owner', readOnly: false, permissionKeys: [],
      tenantId: 'tenant-a', assignedLineAccountId: null, canAccessDescendantAccounts: true,
    } as never);
    return next();
  });
  instance.route('/', ecCommerce);
  return instance;
}

async function get(path: string) {
  const res = await app().request(path);
  return { status: res.status, warning: res.headers.get('Warning'), body: await res.json() as Record<string, never> };
}

/** 友だち `count` 人。偶数番の人は契約2件、奇数番は1件。合計 count*1.5 件。 */
function seedContracts(count: number): void {
  const insF = sqlite.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id, created_at, updated_at)
     VALUES (?, ?, ?, 'account-a', '2026-01-01', '2026-01-01')`,
  );
  const insS = sqlite.prepare(
    `INSERT INTO nen_ec_member_snapshots (friend_id, subscription_json, synced_at) VALUES (?, ?, ?)`,
  );
  const tx = sqlite.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const id = `f${String(i).padStart(4, '0')}`;
      insF.run(id, `U${i}`, `友だち${i}`);
      const contracts: Record<string, unknown>[] = [{
        id: `c${i}a`, status_code: i % 5 === 0 ? 'cancelled' : 'active', amount: 1000,
        next_shipping_date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
      }];
      if (i % 2 === 0) contracts.push({ id: `c${i}b`, status_code: 'paused', amount: 500 });
      insS.run(id, JSON.stringify({ contracts }), `2026-09-${String((i % 28) + 1).padStart(2, '0')}`);
    }
  });
  tx();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAccess.mockResolvedValue(true);
  mocks.scope.mockResolvedValue({ allowedAccountIds: ['account-a'], canSeeUnassigned: false });
  sqlite = new Database(':memory:');
  sqlite.exec(BOOTSTRAP);
  sqlite.prepare(
    `INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token, created_at, updated_at)
     VALUES ('account-a', 'A', 'ch', 's', 't', '2026-01-01', '2026-01-01')`,
  ).run();
});

describe('#731 定期便の一覧と集計', () => {
  test('契約900件が900件として数えられる(直す前は744件だった)', async () => {
    seedContracts(600);
    const first = await get('/api/ec-commerce/subscriptions?lineAccountId=account-a&limit=100&offset=0');
    expect(first.status).toBe(200);
    const summary = (first.body as never as { data: { summary: { total: number; active: number; paused: number; cancelled: number } } }).data.summary;
    console.log('AUDIT-731 summary.total =', summary.total, ' 状態別 =', JSON.stringify(summary));
    expect(summary.total).toBe(900);
    // 600人のうち5人に1人が cancelled、偶数番の300人が paused をもう1件持つ。
    expect(summary.cancelled).toBe(120);
    expect(summary.paused).toBe(300);
    expect(summary.active).toBe(480);
    expect(summary.active + summary.paused + summary.cancelled).toBe(900);
  });

  test('801件目以降へページ送りで到達できる', async () => {
    seedContracts(600);
    const page = await get('/api/ec-commerce/subscriptions?lineAccountId=account-a&limit=5&offset=800');
    const body = page.body as never as { data: { items: Array<{ id: string }> }; pagination: { total: number; offset: number } };
    console.log('AUDIT-731 801件目から =', JSON.stringify(body.data.items.map((i) => i.id)));
    console.log('AUDIT-731 pagination =', JSON.stringify(body.pagination));
    expect(body.data.items).toHaveLength(5);
    expect(body.pagination.total).toBe(900);
    expect(body.pagination.offset).toBe(800);
    // 最後の1件まで行けること。
    const last = await get('/api/ec-commerce/subscriptions?lineAccountId=account-a&limit=5&offset=899');
    expect((last.body as never as { data: { items: unknown[] } }).data.items).toHaveLength(1);
  });

  test('形の違うスナップショットがあっても落ちず、弾いた数を残す', async () => {
    seedContracts(4);
    // `contracts` が配列でない行。JS 側は try/catch と Array.isArray で弾いていた。
    sqlite.prepare(
      `INSERT INTO friends (id, line_user_id, display_name, line_account_id, created_at, updated_at)
       VALUES ('broken', 'Ubroken', '壊れた人', 'account-a', '2026-01-01', '2026-01-01')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO nen_ec_member_snapshots (friend_id, subscription_json, synced_at)
       VALUES ('broken', '{"contracts":"not-an-array"}', '2026-09-01')`,
    ).run();

    const res = await get('/api/ec-commerce/subscriptions?lineAccountId=account-a&limit=10&offset=0');
    const body = res.body as never as {
      data: { summary: { total: number }; skipped: { malformedSnapshots: number } };
    };
    console.log('AUDIT-731 壊れた行あり status =', res.status,
      ' total =', body.data.summary.total, ' skipped =', JSON.stringify(body.data.skipped));
    expect(res.status).toBe(200);
    expect(body.data.summary.total).toBe(6); // 4人 → 契約6件。壊れた行は数えない
    expect(body.data.skipped.malformedSnapshots).toBe(1); // 黙って落とさない
  });

  test('ページ送りを指定しない呼び出しには Warning を返す', async () => {
    seedContracts(4);
    const without = await get('/api/ec-commerce/subscriptions?lineAccountId=account-a');
    const withPaging = await get('/api/ec-commerce/subscriptions?lineAccountId=account-a&limit=10&offset=0');
    console.log('AUDIT-731 Warning(指定なし) =', without.warning);
    console.log('AUDIT-731 Warning(指定あり) =', withPaging.warning);
    expect(without.warning).toBe(
      '299 - "non-paginated subscriptions are limited to 100 rows; use limit/offset"',
    );
    expect(withPaging.warning).toBeNull();
  });

  test('タブの件数は overview から取れ、行を展開しない', async () => {
    seedContracts(600);
    const res = await get('/api/ec-commerce/overview?lineAccountId=account-a');
    const data = (res.body as never as { data: { subscriptions: number } }).data;
    console.log('AUDIT-731 overview.subscriptions =', data.subscriptions);
    expect(data.subscriptions).toBe(900);
  });

  test('絞り込みは総数にも効く(集計は絞り込み前のまま)', async () => {
    seedContracts(600);
    const paused = await get('/api/ec-commerce/subscriptions?lineAccountId=account-a&status=paused&limit=10&offset=0');
    const body = paused.body as never as {
      data: { items: Array<{ status: string }>; summary: { total: number; paused: number } };
      pagination: { total: number };
    };
    console.log('AUDIT-731 絞り込み paused: pagination.total =', body.pagination.total,
      ' summary.total =', body.data.summary.total);
    expect(body.pagination.total).toBe(300);   // 絞り込みに合う数
    expect(body.data.summary.total).toBe(900); // 集計は全体のまま(元の実装と同じ)
    expect(body.data.items.every((item) => item.status === 'paused')).toBe(true);
  });

  /** 保存済みの定期便と同じ応答値を返すことを確かめる。 */
  test('1件の契約の中身と集計は、直す前と同じに返す', async () => {
    sqlite.prepare(
      `INSERT INTO friends (id, line_user_id, display_name, line_account_id, created_at, updated_at)
       VALUES ('friend-a', 'Ua', '見本 16', 'account-a', '2026-01-01', '2026-01-01')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO nen_pet_profiles (id, friend_id, name, created_at, updated_at)
       VALUES ('pet-a', 'friend-a', 'もも', '2026-01-01', '2026-01-01')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO nen_ec_member_snapshots (friend_id, subscription_json, synced_at)
       VALUES ('friend-a', ?, '2026-09-06T10:00:00+09:00')`,
    ).run(JSON.stringify({ contracts: [{
      contract_number: 'SUB-100', status: 'payment_failed', amount: 4280,
      next_shipping_date: '2026-09-20', continued_count: 4,
      items: [{ name: '鹿肉フード', quantity: 2 }],
    }] }));

    const res = await get('/api/ec-commerce/subscriptions?lineAccountId=account-a&limit=10&offset=0');
    const body = res.body as never as {
      data: {
        items: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
        risk: { predictiveScoreAvailable: boolean };
      };
    };
    console.log('AUDIT-731 1件の中身 =', JSON.stringify(body.data.items[0]));
    expect(body.data.items[0]).toMatchObject({
      contractNumber: 'SUB-100', status: 'at_risk', amount: 4280,
      items: '鹿肉フード × 2', riskReason: '定期便のお支払いを確認できませんでした',
      ownerName: '見本 16', petName: 'もも', continuedCount: 4,
    });
    expect(body.data.summary).toMatchObject({ total: 1, atRisk: 1, monthlyAmount: 4280 });
    expect(body.data.summary.startedThisMonth).toBe(0);
    expect(body.data.summary.cancelledThisMonth).toBe(0);
    expect(body.data.summary.monthlyStats).toEqual([]);
    expect(body.data.risk.predictiveScoreAvailable).toBe(false);
  });
});


afterEach(() => vi.useRealTimers());
test.each(['2026-09-30T15:00:00Z', '2026-09-30T23:59:59Z'])('日本時間の月初の朝に今月の定期便開始・取消を数える: %s', async (at) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at));
  seedContracts(2);
  sqlite.prepare('UPDATE nen_ec_member_snapshots SET subscription_json=? WHERE friend_id=?').run(JSON.stringify({ contracts: [
    { id: 'current', status_code: 'cancelled', amount: 1000, started_at: '2026-10-01', cancelled_at: '2026-10-01' },
    { id: 'previous', status_code: 'cancelled', amount: 1000, started_at: '2026-09-01', cancelled_at: '2026-09-30' },
    { id: 'previous-2', status_code: 'cancelled', amount: 500, started_at: '2026-09-15', cancelled_at: '2026-09-30' },
  ] }), 'f0000');
  const res = await app().request('/api/ec-commerce/subscriptions?lineAccountId=account-a&limit=10');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ data: { summary: { startedThisMonth: 1, cancelledThisMonth: 1 } } });
});
