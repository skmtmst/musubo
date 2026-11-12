import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { sha256Hex } from '../middleware/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { jstIso, opsDashboard, resolvePeriod } from './ops-dashboard.js';

/** 最初の10分の全アカウントのまとめ。運営だけが数だけを読む。 */

let testDb: SqliteD1;

function app(staff: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => { c.set('staff', staff); return next(); });
  instance.route('/', opsDashboard);
  return {
    request: (path: string, headers: Record<string, string> = {}) =>
      instance.request(path, { headers }, { DB: testDb.db } as Env['Bindings']),
  };
}

const master: AuthenticatedStaff = { id: 'master-1', name: '見本 25', role: 'owner', readOnly: false, tenantId: null };
const readOnlyMaster: AuthenticatedStaff = { ...master, readOnly: true };
const tenantOwner: AuthenticatedStaff = { id: 'owner-1', name: '見本 141', role: 'owner', readOnly: false, tenantId: 'tenant-a' };

type Funnel = {
  accounts: number;
  stages: Array<{ key: string; count: number; percent: number }>;
  minutesToFirstMessage: { median: number | null; p75: number | null; reached: number };
  withinTenMinutesPercent: number;
  allStepsDone: { count: number; percent: number };
};

/** 今月の頭から 1 時間後を起点に、分を足した日本時間。 */
const base = Date.parse(resolvePeriod('month').from) + 60 * 60 * 1000;
const at = (minutes: number) => jstIso(base + minutes * 60_000);
const atUtc = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

function account(id: string, createdAt: string, extra: { tenantId?: string | null; archived?: boolean } = {}) {
  testDb.raw.prepare(`INSERT INTO line_accounts (id, name, channel_id, channel_secret, channel_access_token, tenant_id, created_at, archived_at)
    VALUES (?, ?, ?, 's', 't', ?, ?, ?)`)
    .run(id, `店 ${id}`, `ch-${id}`, extra.tenantId === undefined ? 'tenant-a' : extra.tenantId, createdAt, extra.archived ? createdAt : null);
}

function friend(accountId: string) {
  testDb.raw.prepare(`INSERT OR IGNORE INTO friends (id, line_user_id, display_name, line_account_id) VALUES (?, ?, '友だち', ?)`)
    .run(`f-${accountId}`, `U-${accountId}`, accountId);
}

function firstMessage(accountId: string, createdAt: string, id = `m-${accountId}`) {
  friend(accountId);
  testDb.raw.prepare(`INSERT INTO messages_log (id, friend_id, line_account_id, direction, message_type, content, source, created_at)
    VALUES (?, ?, ?, 'outgoing', 'text', '本文', 'friend_add_routing', ?)`).run(id, `f-${accountId}`, accountId, createdAt);
}

function follow(accountId: string, receivedAt: string, id = `ev-${accountId}`) {
  testDb.raw.prepare(`INSERT INTO line_webhook_events (webhook_event_id, line_account_id, event_type, status, received_at)
    VALUES (?, ?, 'follow', 'succeeded', ?)`).run(id, accountId, receivedAt);
}

function allSteps(accountId: string) {
  testDb.raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value) VALUES (?, ?, 'feature.settings_bundle_v1', ?)`)
    .run(`set-${accountId}`, accountId, JSON.stringify({ version: 1, data: { features: { booking: true } } }));
  testDb.raw.prepare(`INSERT INTO tags (id, name, line_account_id) VALUES (?, '見込み', ?)`).run(`tag-${accountId}`, accountId);
  testDb.raw.prepare(`INSERT INTO scenarios (id, name, trigger_type, is_active, line_account_id) VALUES (?, 'はじめの案内', 'friend_add', 1, ?)`)
    .run(`sc-${accountId}`, accountId);
  testDb.raw.prepare(`INSERT INTO friend_add_rules (id, line_account_id, friend_kind, name, priority, is_unknown_route_fallback, status)
    VALUES (?, ?, 'first_time', '受け皿', 1, 1, 'published')`).run(`rule-${accountId}`, accountId);
  testDb.raw.prepare(`INSERT INTO friend_add_rule_versions (id, rule_id, version_number, definition_snapshot, status) VALUES (?, ?, 1, ?, 'published')`)
    .run(`rv-${accountId}`, `rule-${accountId}`, JSON.stringify({ actions: [{ type: 'start_scenario', scenarioId: `sc-${accountId}` }] }));
}

beforeEach(() => {
  testDb = createTestD1();
  testDb.raw.prepare(`INSERT INTO tenants (id, name, status, plan_status, created_at) VALUES ('tenant-a', '株式会社サンプル', 'active', 'trialing', ?)`).run(at(0));
  testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id) VALUES ('master-1', '見本 25', 'owner', 'k1', NULL)`).run();
  testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active) VALUES ('master-1', 1)`).run();
});

async function read(staff: AuthenticatedStaff = master, query = '') {
  const res = await app(staff).request(`/api/ops/dashboard/first-run${query}`);
  return { res, body: res.status === 200 ? (await res.json() as { data: Funnel & { periodLabel: string } }).data : null };
}

describe('最初の10分のまとめ', () => {
  it('各段まで進んだ数・分の中央値と75%点・10分以内・6段の全部を数える', async () => {
    // 全部終えた店：4 分で最初の1通。
    account('la-1', at(0));
    testDb.raw.prepare(`INSERT INTO account_styles (line_account_id, style, selected_at, updated_at, first_selected_at, first_starter_at) VALUES ('la-1', 'salon', ?, ?, ?, ?)`).run(at(1), at(1), at(1), at(1));
    testDb.raw.prepare(`INSERT INTO style_starter_items (line_account_id, style, item_key, kind, target_id, set_version, applied_at)
      VALUES ('la-1', 'salon', 'k1', 'automation', 'x', 1, ?)`).run(at(1));
    follow('la-1', at(3));
    firstMessage('la-1', at(4));
    allSteps('la-1');
    // 時刻が Z の形で保存された店：30 分で最初の1通。スタイルは選んだが初期セット・友だち追加は無い。
    account('la-2', atUtc(0));
    testDb.raw.prepare(`INSERT INTO account_styles (line_account_id, style, selected_at, updated_at, first_selected_at) VALUES ('la-2', 'restaurant', ?, ?, ?)`).run(at(2), at(2), at(2));
    firstMessage('la-2', at(30));
    // 作っただけの店。「あとで」を選んだスタイルは数えない。
    account('la-3', at(0));
    testDb.raw.prepare(`INSERT INTO account_styles (line_account_id, style, selected_at, updated_at, selection_mode) VALUES ('la-3', 'standard', ?, ?, 'later')`).run(at(1), at(1));
    // 数えない：先月の店・運営自身の店・保管した店。
    account('la-old', jstIso(Date.parse(resolvePeriod('prev_month').from) + 3_600_000));
    firstMessage('la-old', at(1));
    account('la-default', at(0), { tenantId: DEFAULT_TENANT_ID });
    firstMessage('la-default', at(1));
    account('la-null', at(0), { tenantId: null });
    account('la-archived', at(0), { archived: true });

    const { res, body } = await read();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      periodLabel: '今月',
      accounts: 3,
      // その段まで来た数は前の地点が全部そろったお店だけ。la-2 は初期セットが無いので、1 通が出ていても 3 段目で止まる。
      stages: [
        { key: 'started', count: 3, percent: 100, fromPrevious: null, minutesFromPrevious: null },
        { key: 'style', count: 2, percent: 66.7, fromPrevious: 66.7, minutesFromPrevious: 1 },
        { key: 'starter', count: 1, percent: 33.3, fromPrevious: 50, minutesFromPrevious: 0 },
        { key: 'follow', count: 1, percent: 33.3, fromPrevious: 100, minutesFromPrevious: 2 },
        { key: 'firstMessage', count: 1, percent: 33.3, fromPrevious: 100, minutesFromPrevious: 1 },
      ],
      biggestDrop: { key: 'starter', fromPrevious: 50, lost: 1 },
      minutesToFirstMessage: { median: 4, p75: 30, reached: 2 },
      withinTenMinutesPercent: 33.3,
      allStepsDone: { count: 1, percent: 33.3 },
    });
  });

  it('名前・友だち・本文は返さない', async () => {
    account('la-1', at(0));
    firstMessage('la-1', at(4));
    const res = await app(master).request('/api/ops/dashboard/first-run');
    const text = await res.text();
    for (const secret of ['店 la-1', 'la-1', '友だち', '本文', 'U-la-1']) expect(text).not.toContain(secret);
  });

  it('6段のどれかが欠けたら全部とは数えない', async () => {
    account('la-1', at(0));
    firstMessage('la-1', at(4));
    allSteps('la-1');
    expect((await read()).body?.allStepsDone.count).toBe(1);
    const missing: Array<[string, string, string]> = [
      ['止めたアカウント', `UPDATE line_accounts SET is_active = 0`, `UPDATE line_accounts SET is_active = 1`],
      ['シークレットが無い', `UPDATE line_accounts SET channel_secret = ''`, `UPDATE line_accounts SET channel_secret = 's'`],
      ['機能の束が空', `UPDATE account_settings SET value = '{"version":1,"data":{"features":{}}}'`, `UPDATE account_settings SET value = '{"version":1,"data":{"features":{"booking":true}}}'`],
      ['分け方が無い', `UPDATE tags SET status = 'archived'`, `UPDATE tags SET status = 'active'`],
      ['受け皿が無い', `UPDATE friend_add_rules SET is_unknown_route_fallback = 0`, `UPDATE friend_add_rules SET is_unknown_route_fallback = 1`],
      ['止めたシナリオ', `UPDATE scenarios SET is_active = 0`, `UPDATE scenarios SET is_active = 1`],
      ['振り分けから始まらないシナリオ', `UPDATE scenarios SET id = 'sc-other'`, `UPDATE scenarios SET id = 'sc-la-1'`],
      ['最初の1通が無い', `UPDATE messages_log SET direction = 'incoming'`, `UPDATE messages_log SET direction = 'outgoing'`],
    ];
    for (const [label, breakIt, restore] of missing) {
      testDb.raw.prepare(breakIt).run();
      expect({ label, count: (await read()).body?.allStepsDone.count }).toEqual({ label, count: 0 });
      testDb.raw.prepare(restore).run();
      expect({ label, count: (await read()).body?.allStepsDone.count }).toEqual({ label, count: 1 });
    }
  });

  it('10分ちょうどは10分以内、10分を少しでも過ぎたら入れない', async () => {
    account('la-1', at(0));
    firstMessage('la-1', at(10));
    account('la-2', at(0));
    firstMessage('la-2', jstIso(base + 10 * 60_000 + 1_000));
    expect((await read()).body).toMatchObject({ minutesToFirstMessage: { median: 10, p75: 11, reached: 2 }, withinTenMinutesPercent: 50 });
  });

  it('期間に店が無い時は 0 と空の分を返す', async () => {
    const { body } = await read(master, '?period=prev_month');
    expect(body).toMatchObject({ periodLabel: '先月', accounts: 0, biggestDrop: null, minutesToFirstMessage: { median: null, p75: null, reached: 0 }, withinTenMinutesPercent: 0 });
  });

  it('アカウント 1,000 の作り物でも 3 秒以内に数える', async () => {
    const insertMessages = testDb.raw.transaction(() => {
      for (let i = 0; i < 1000; i += 1) {
        const id = `la-${i}`;
        account(id, at(i % 600));
        friend(id);
        for (let j = 0; j < 20; j += 1) {
          testDb.raw.prepare(`INSERT INTO messages_log (id, friend_id, line_account_id, direction, message_type, content, source, created_at)
            VALUES (?, ?, ?, 'outgoing', 'text', '本文', ?, ?)`).run(`m-${i}-${j}`, `f-${id}`, id, j % 4 === 0 ? 'friend_add_routing' : 'broadcast', at((i % 600) + j));
          follow(id, at((i % 600) + j), `ev-${i}-${j}`);
        }
      }
    });
    insertMessages();
    const started = performance.now();
    const { body } = await read();
    const elapsed = performance.now() - started;
    expect(body?.accounts).toBe(1000);
    expect(body?.minutesToFirstMessage.reached).toBe(1000);
    expect(elapsed).toBeLessThan(3000);
    // 作り物を入れる時間は測らない。3 秒は数える部分だけで見る。
  }, 30_000);
});

describe('見られる人', () => {
  it('店の人・閲覧のみの運営は 403', async () => {
    expect((await read(tenantOwner)).res.status).toBe(403);
    expect((await read(readOnlyMaster)).res.status).toBe(403);
  });

  it('代理ログイン中は 403。終われば読める', async () => {
    const hash = await sha256Hex('ops-fixture');
    testDb.raw.prepare('INSERT INTO admin_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)')
      .run(hash, 'master-1', new Date(Date.now() + 3_600_000).toISOString());
    testDb.raw.prepare(`INSERT INTO impersonation_sessions (id, staff_id, tenant_id, mode) VALUES ('imp-1', 'master-1', 'tenant-a', 'read')`).run();
    testDb.raw.prepare(`INSERT INTO platform_settings (key, value) VALUES ('auth.impersonation.session:imp-1', ?)`).run(hash);
    const headers = { Authorization: 'Bearer lh_session:ops-fixture' };
    expect((await app(master).request('/api/ops/dashboard/first-run', headers)).status).toBe(403);
    testDb.raw.prepare(`UPDATE impersonation_sessions SET ended_at = ? WHERE id = 'imp-1'`).run(at(0));
    expect((await app(master).request('/api/ops/dashboard/first-run', headers)).status).toBe(200);
  });
});

it('uses first selection and starter timestamps for per-stage minutes after later changes', async () => {
  account('la-first', at(0));
  testDb.raw.prepare(`INSERT INTO account_styles (line_account_id,style,selected_at,first_selected_at,first_starter_at,updated_at)
    VALUES ('la-first','salon',?,?,?,?)`).run(at(8),at(1),at(2),at(8));
  testDb.raw.prepare(`INSERT INTO style_starter_items (line_account_id,style,item_key,kind,target_id,set_version,applied_at)
    VALUES ('la-first','salon','k','automation','x',1,?)`).run(at(9));
  follow('la-first', at(3));
  firstMessage('la-first', at(4));
  const {body} = await read();
  expect(body?.stages).toMatchObject([
    {key:'started'}, {key:'style',minutesFromPrevious:1}, {key:'starter',minutesFromPrevious:1},
    {key:'follow',minutesFromPrevious:1}, {key:'firstMessage',minutesFromPrevious:1},
  ]);
});
