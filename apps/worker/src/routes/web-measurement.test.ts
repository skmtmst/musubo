import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { webMeasurement } from './web-measurement.js';
import { conversions } from './conversions.js';

/*
 * Web計測の公開口。
 * - 許可ドメイン以外からの成果は数えない(件数と最後の来た先だけ残す)
 * - 同意が無い送信は数えない
 * - 友だちと結び付かない成果は地点の「匿名を数える」設定のときだけ日別集計
 * - 取り消しは追記型の台帳(元の成果は消えない)
 */

const NOW = '2026-09-21T00:00:00+09:00';

function staff(
  id: string,
  tenantId: string,
  role: AuthenticatedStaff['role'] = 'owner',
  permissionKeys: string[] = [],
): AuthenticatedStaff {
  return { id, name: id, role, readOnly: false, tenantId, permissionKeys };
}

function app(current: AuthenticatedStaff | null) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    if (current) c.set('staff', current);
    await next();
  });
  instance.route('/', webMeasurement);
  instance.route('/', conversions);
  return instance;
}

function seed(testDb: SqliteD1): void {
  testDb.raw.prepare(`INSERT INTO tenants (id, name) VALUES ('tenant-1', '統括1'), ('tenant-2', '統括2')`).run();
  for (const [id, tenant] of [['a1', 'tenant-1'], ['b1', 'tenant-2']] as const) {
    testDb.raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES (?, ?, ?, 'token', 'secret', 1, ?)`,
    ).run(id, `channel-${id}`, id, tenant);
  }
  testDb.raw.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, tenant_id, account_scope)
     VALUES ('owner-1', 'owner-1', 'owner', 'key-1', 'tenant-1', 'all'),
            ('staff-1', 'staff-1', 'staff', 'key-2', 'tenant-1', 'all'),
            ('owner-2', 'owner-2', 'owner', 'key-3', 'tenant-2', 'all')`,
  ).run();
  // affiliates は既定でオフなので、公開口の検査を通るよう有効化する。
  testDb.raw.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value) VALUES ('s1', 'a1', 'feature.affiliates', 'true')`,
  ).run();
  // url_reach の成果地点。source モードで金額は申告値を採る。
  testDb.raw.prepare(
    `INSERT INTO conversion_points
      (id, name, event_type, measure_method, target_url, value_mode,
       line_account_id, tenant_id, status, count_anonymous, created_at)
     VALUES ('point-web', '購入完了', 'purchase', 'url_reach', 'https://example.com/thanks',
             'source', 'a1', 'tenant-1', 'active', 0, ?),
            ('point-anon', '到達(匿名可)', 'visit', 'url_reach', 'https://example.com/lp',
             'none', 'a1', 'tenant-1', 'active', 1, ?),
            ('point-query', '申込完了', 'form_submitted', 'url_reach', 'https://example.com/entry?utm_source=seed',
             'none', 'a1', 'tenant-1', 'active', 0, ?)`,
  ).run(NOW, NOW, NOW);
  testDb.raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id)
     VALUES ('f1', 'U-f1', '友だち1', 'a1')`,
  ).run();
  // 訪問者 → 友だちの結び付き。未結び付きの 'visitor-none' も置く。
  testDb.raw.prepare(
    `INSERT INTO site_visitors (id, line_account_id, friend_id, consent_state)
     VALUES ('a1:visitor-1', 'a1', 'f1', 'granted'),
            ('a1:visitor-none', 'a1', NULL, 'granted')`,
  ).run();
}

function seedSite(testDb: SqliteD1, host = 'example.com'): string {
  const siteId = 'site_'.padEnd(5, 'a').padEnd(37, 'a');
  testDb.raw.prepare(
    `INSERT INTO measurement_sites (id, line_account_id, label, created_at, updated_at)
     VALUES (?, 'a1', '公式ショップ', ?, ?)`,
  ).run(siteId, NOW, NOW);
  testDb.raw.prepare(
    `INSERT INTO measurement_site_domains (site_id, host, created_at) VALUES (?, ?, ?)`,
  ).run(siteId, host, NOW);
  return siteId;
}

function postConversion(db: SqliteD1, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app(null).fetch(
    new Request('https://worker.example/api/public/web-conversions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { DB: db.db } as unknown as Env['Bindings'],
  );
}

async function req(handler: Hono<Env>, db: SqliteD1, path: string, init?: RequestInit): Promise<Response> {
  return handler.fetch(
    new Request(`https://example.com${path}`, init),
    { DB: db.db } as unknown as Env['Bindings'],
  );
}

function eventCount(db: SqliteD1): number {
  // `.get as T` の直後に `.n` を書くとトランスパイルでプロパティ参照が落ちるため、一度変数に置く。
  const row = db.raw.prepare('SELECT COUNT(*) AS n FROM conversion_events').get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

describe('POST /api/public/web-conversions', () => {
  it('許可ドメイン・同意・友だち結び付きの成果を数える', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    const res = await postConversion(testDb, {
      siteId,
      visitorId: 'visitor-1',
      host: 'example.com',
      path: '/thanks',
      value: 1500,
      consent: 'granted',
    });
    expect(res.status).toBe(204);
    const row = testDb.raw.prepare(
      `SELECT friend_id, value_snapshot, conversion_point_id FROM conversion_events`,
    ).get() as { friend_id: string; value_snapshot: number; conversion_point_id: string };
    expect(row.friend_id).toBe('f1');
    expect(row.value_snapshot).toBe(1500);
    expect(row.conversion_point_id).toBe('point-web');
  });

  it('許可にないドメインは数えず、件数と最後の来た先だけ残す', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    const res = await postConversion(testDb, {
      siteId, host: 'evil.example.org', path: '/thanks', consent: 'granted',
    });
    expect(res.status).toBe(204);
    expect(eventCount(testDb)).toBe(0);
    const rejection = testDb.raw.prepare(
      `SELECT host, rejected_count FROM measurement_domain_rejections WHERE site_id = ?`,
    ).get(siteId) as { host: string; rejected_count: number };
    expect(rejection).toEqual({ host: 'evil.example.org', rejected_count: 1 });
  });

  it('同意が無い送信は数えない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    await postConversion(testDb, {
      siteId, visitorId: 'visitor-1', host: 'example.com', path: '/thanks', consent: 'unset',
    });
    expect(eventCount(testDb)).toBe(0);
  });

  it('知らないサイトID・壊れた形は黙って捨てる', async () => {
    const testDb = createTestD1();
    seed(testDb);
    seedSite(testDb);
    const res = await postConversion(testDb, {
      siteId: 'site_0000000000000000000000000000ff', host: 'example.com', path: '/thanks', consent: 'granted',
    });
    expect(res.status).toBe(204);
    const bad = await postConversion(testDb, { siteId: 'not-a-site-id' });
    expect(bad.status).toBe(204);
    expect(eventCount(testDb)).toBe(0);
  });

  it('友だちと結び付かない成果は「匿名を数える」地点の日別集計にだけ入る', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    // point-web は匿名を数えない → 何も残らない
    await postConversion(testDb, {
      siteId, visitorId: 'visitor-none', host: 'example.com', path: '/thanks', consent: 'granted',
    });
    expect(eventCount(testDb)).toBe(0);
    expect(
      testDb.raw.prepare('SELECT COUNT(*) AS n FROM conversion_anonymous_days').get() as { n: number },
    ).toEqual({ n: 0 });
    // point-anon は匿名を数える → 日別の合計へ
    await postConversion(testDb, {
      siteId, visitorId: 'visitor-none', host: 'example.com', path: '/lp', consent: 'granted',
    });
    const day = testDb.raw.prepare(
      `SELECT conversion_point_id, anonymous_count FROM conversion_anonymous_days`,
    ).get() as { conversion_point_id: string; anonymous_count: number };
    expect(day.conversion_point_id).toBe('point-anon');
    expect(day.anonymous_count).toBe(1);
    expect(eventCount(testDb)).toBe(0);
  });

  it('sourceEventId の再送は1件に潰れる', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    const body = {
      siteId, visitorId: 'visitor-1', host: 'example.com', path: '/thanks',
      value: 500, consent: 'granted', sourceEventId: 'ext-1',
    };
    await postConversion(testDb, body);
    await postConversion(testDb, body);
    expect(eventCount(testDb)).toBe(1);
  });

  it('R282: 保存側・受信側のクエリと#以降を外して判定する', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    // 保存値に ?utm_source=seed が残っていても、同じページに当たる。
    // 受信のクエリ違い・ページ内位置が付いても当たる。
    await postConversion(testDb, {
      siteId, visitorId: 'visitor-1', host: 'example.com', path: '/entry?x=1#sec', consent: 'granted',
    });
    const row = testDb.raw.prepare(
      `SELECT conversion_point_id FROM conversion_events`,
    ).get() as { conversion_point_id: string } | undefined;
    expect(row?.conversion_point_id).toBe('point-query');
  });

  it('R282: _ を含む保存値は別文字へ広げない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    testDb.raw.prepare(
      `INSERT INTO conversion_points
        (id, name, event_type, measure_method, target_url, value_mode,
         line_account_id, tenant_id, status, count_anonymous, created_at)
       VALUES ('point-under', '完了', 'visit', 'url_reach', 'https://example.com/order_done',
               'none', 'a1', 'tenant-1', 'active', 0, ?)`,
    ).run(NOW);
    expect(eventCount(testDb)).toBe(0);
    await postConversion(testDb, {
      siteId, visitorId: 'visitor-1', host: 'example.com', path: '/orderXdone', consent: 'granted',
    });
    expect(eventCount(testDb)).toBe(0);
    await postConversion(testDb, {
      siteId, visitorId: 'visitor-1', host: 'example.com', path: '/order_done', consent: 'granted',
    });
    expect(eventCount(testDb)).toBe(1);
  });

  it('Origin ヘッダのドメインも許可判定に使う', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    const res = await postConversion(
      testDb,
      { siteId, visitorId: 'visitor-1', path: '/thanks', consent: 'granted' },
      { Origin: 'https://example.com' },
    );
    expect(res.status).toBe(204);
    expect(eventCount(testDb)).toBe(1);
  });
});

describe('計測サイトの管理口', () => {
  it('GET はサイトと許可ドメイン・拒否数を返す', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    await postConversion(testDb, { siteId, host: 'bad.example.org', path: '/thanks', consent: 'granted' });
    const res = await req(app(staff('owner-1', 'tenant-1')), testDb, '/api/measurement-sites?account_id=a1');
    expect(res.status).toBe(200);
    const body = await res.json() as { success: true; data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(siteId);
    expect(body.data[0].domains).toEqual(['example.com']);
    expect(body.data[0].rejectedCount).toBe(1);
    expect(body.data[0].lastRejectedHost).toBe('bad.example.org');
  });

  it('別統括のアカウントは指定できない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    seedSite(testDb);
    const res = await req(app(staff('owner-2', 'tenant-2')), testDb, '/api/measurement-sites?account_id=a1');
    expect(res.status).toBe(400);
  });

  it('POST は owner/admin だけ。作成したサイトが一覧に出る', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const denied = await req(app(staff('staff-1', 'tenant-1', 'staff', ['/conversions'])), testDb, '/api/measurement-sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'a1', label: 'LP', domains: ['lp.example.com'] }),
    });
    expect(denied.status).toBe(403);
    const res = await req(app(staff('owner-1', 'tenant-1')), testDb, '/api/measurement-sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'a1', label: 'LP', domains: ['https://lp.example.com/'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; domains: string[] } };
    expect(body.data.id).toMatch(/^site_[a-f0-9]{32}$/);
    expect(body.data.domains).toEqual(['lp.example.com']);
  });

  it('PATCH で許可ドメインを差し替えられる', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);
    const res = await req(app(staff('owner-1', 'tenant-1')), testDb, `/api/measurement-sites/${siteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domains: ['new.example.com'] }),
    });
    expect(res.status).toBe(200);
    const hosts = testDb.raw.prepare(
      'SELECT host FROM measurement_site_domains WHERE site_id = ?',
    ).all(siteId) as Array<{ host: string }>;
    expect(hosts.map((h) => h.host)).toEqual(['new.example.com']);
    // 差し替え後は旧ドメインからの送信を数えない
    await postConversion(testDb, { siteId, host: 'example.com', path: '/thanks', consent: 'granted' });
    expect(eventCount(testDb)).toBe(0);
  });
});

describe('計測サイトの停止・再開 (R275)', () => {
  function stop(testDb: SqliteD1, siteId: string, body: Record<string, unknown> = { reason: 'サイトを閉じたため' }) {
    return req(app(staff('owner-1', 'tenant-1')), testDb, `/api/measurement-sites/${siteId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('停止すると一覧に状態と理由が出て、公開口は以後の成果を数えない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);

    const res = await stop(testDb, siteId);
    expect(res.status).toBe(200);

    const list = await req(app(staff('owner-1', 'tenant-1')), testDb, '/api/measurement-sites?account_id=a1');
    const body = await list.json() as { data: Array<{ stoppedAt: string | null; stoppedReason: string | null }> };
    expect(body.data[0].stoppedAt).toBeTruthy();
    expect(body.data[0].stoppedReason).toBe('サイトを閉じたため');

    // 停止後の受付は数えない。許可外ドメイン扱いにもしない(拒否集計に入れない)。
    const res204 = await postConversion(testDb, {
      siteId, visitorId: 'visitor-1', host: 'example.com', path: '/thanks', consent: 'granted',
    });
    expect(res204.status).toBe(204);
    expect(eventCount(testDb)).toBe(0);
    expect(
      testDb.raw.prepare('SELECT COUNT(*) AS n FROM measurement_domain_rejections').get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('再開すると受付が戻る。停止していないサイトの再開は409', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);

    const early = await req(app(staff('owner-1', 'tenant-1')), testDb, `/api/measurement-sites/${siteId}/resume`, { method: 'POST' });
    expect(early.status).toBe(409);

    await stop(testDb, siteId);
    const resumed = await req(app(staff('owner-1', 'tenant-1')), testDb, `/api/measurement-sites/${siteId}/resume`, { method: 'POST' });
    expect(resumed.status).toBe(200);

    await postConversion(testDb, {
      siteId, visitorId: 'visitor-1', host: 'example.com', path: '/thanks', consent: 'granted',
    });
    expect(eventCount(testDb)).toBe(1);
  });

  it('理由なし・二重の停止・係員・別統括は受け付けない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const siteId = seedSite(testDb);

    expect((await stop(testDb, siteId, {})).status).toBe(400);
    expect((await stop(testDb, siteId)).status).toBe(200);
    expect((await stop(testDb, siteId)).status).toBe(409);

    const denied = await req(app(staff('staff-1', 'tenant-1', 'staff', ['/conversions'])), testDb, `/api/measurement-sites/${siteId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'x' }),
    });
    expect(denied.status).toBe(403);

    // 別統括のサイトには404(存在を明かさない)
    const otherSite = 'site_'.padEnd(5, 'b').padEnd(37, 'b');
    testDb.raw.prepare(
      `INSERT INTO measurement_sites (id, line_account_id, label, created_at, updated_at)
       VALUES (?, 'b1', '別統括', ?, ?)`,
    ).run(otherSite, NOW, NOW);
    expect((await stop(testDb, otherSite)).status).toBe(404);
  });
});

describe('成果の取消・取消の取消', () => {
  async function seedEvent(testDb: SqliteD1): Promise<string> {
    const siteId = seedSite(testDb);
    await postConversion(testDb, {
      siteId, visitorId: 'visitor-1', host: 'example.com', path: '/thanks', value: 800, consent: 'granted',
    });
    return (testDb.raw.prepare('SELECT id FROM conversion_events').get() as { id: string }).id;
  }

  it('理由つきで取り消し、履歴が残り、元の成果は消えない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const eventId = await seedEvent(testDb);
    const res = await req(app(staff('owner-1', 'tenant-1')), testDb, `/api/conversions/events/${eventId}/reversals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'reverse', reason: '重複して届いたため' }),
    });
    expect(res.status).toBe(200);
    // 閲覧は機能の「見る」権限があればよい（staff でも履歴を読める）
    const history = await req(
      app(staff('staff-1', 'tenant-1', 'staff', ['/conversions'])),
      testDb,
      `/api/conversions/events/${eventId}/reversals`,
    );
    expect(history.status).toBe(200);
    const body = await history.json() as { data: Array<{ kind: string; reason: string }> };
    expect(body.data[0]).toMatchObject({ kind: 'reverse', reason: '重複して届いたため' });
    expect(eventCount(testDb)).toBe(1);
  });

  it('二重取消は409、取消を戻すと再び取り消せる', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const eventId = await seedEvent(testDb);
    const reverse = () => req(app(staff('owner-1', 'tenant-1')), testDb, `/api/conversions/events/${eventId}/reversals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'reverse', reason: '取り消し' }),
    });
    expect((await reverse()).status).toBe(200);
    expect((await reverse()).status).toBe(409);
    const restore = await req(app(staff('owner-1', 'tenant-1')), testDb, `/api/conversions/events/${eventId}/reversals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'restore', reason: '確認したら正しかった' }),
    });
    expect(restore.status).toBe(200);
    expect((await reverse()).status).toBe(200);
  });

  it('確認時の取消履歴が変わったら、状態が元に戻っても古い確認を拒否する', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const eventId = await seedEvent(testDb);
    const send = (kind: 'reverse' | 'restore', expectedReversalId: string | null) => req(app(staff('owner-1', 'tenant-1')), testDb, `/api/conversions/events/${eventId}/reversals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, reason: '確認した内容', expectedReversalId, expectedApprovalStatus: null, expectedCancelled: kind === 'restore' }),
    });
    const point = testDb.raw.prepare('SELECT conversion_point_id FROM conversion_events WHERE id = ?').get(eventId) as { conversion_point_id: string };
    const events = () => req(app(staff('owner-1', 'tenant-1')), testDb, `/api/conversions/definitions/${point.conversion_point_id}/events`);
    const before = await (await events()).json() as { data: { items: Array<{ id: string; latestReversalId: string | null; approvalRevision:number }> } };
    expect(before.data.items.find(item => item.id === eventId)?.latestReversalId).toBeNull();
    expect(before.data.items.find(item => item.id === eventId)?.approvalRevision).toBe(1);
    const first = await send('reverse', null);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { data: { id: string } };
    const after = await (await events()).json() as { data: { items: Array<{ id: string; latestReversalId: string | null }> } };
    expect(after.data.items.find(item => item.id === eventId)?.latestReversalId).toBe(firstBody.data.id);
    expect((await send('restore', firstBody.data.id)).status).toBe(200);
    expect((await send('reverse', null)).status).toBe(409);
    expect((testDb.raw.prepare('SELECT COUNT(*) AS n FROM conversion_event_reversals').get() as { n: number }).n).toBe(2);
  });

  it('確認後に成果の承認状態が変わったら取り消さない', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const eventId = await seedEvent(testDb);
    testDb.raw.prepare("UPDATE conversion_events SET approval_status = 'pending' WHERE id = ?").run(eventId);
    const response = await req(app(staff('owner-1', 'tenant-1')), testDb, `/api/conversions/events/${eventId}/reversals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'reverse', reason: '確認した内容', expectedReversalId: null, expectedApprovalStatus: null, expectedCancelled: false }),
    });
    expect(response.status).toBe(409);
    expect((testDb.raw.prepare('SELECT COUNT(*) AS n FROM conversion_event_reversals').get() as { n: number }).n).toBe(0);
  });

  it('不正な版や確認情報を欠いた版付き取消は400で追記しない', async () => {
    const testDb=createTestD1();seed(testDb);const eventId=await seedEvent(testDb);
    for (const fields of [{expectedApprovalRevision:0},{expectedApprovalRevision:'1'},{expectedApprovalRevision:1}]) {
      const response=await req(app(staff('owner-1','tenant-1')),testDb,`/api/conversions/events/${eventId}/reversals`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'reverse',reason:'確認済み',...fields}),
      });expect(response.status).toBe(400);
    }
    expect(testDb.raw.prepare('SELECT COUNT(*) n FROM conversion_event_reversals').get()).toEqual({n:0});
  });

  it('確認後に成果報酬側で取消されたら、古い確認を拒否する', async () => {
    const testDb = createTestD1({ foreignKeys: false });
    seed(testDb);
    const eventId = await seedEvent(testDb);
    testDb.raw.prepare(`INSERT INTO affiliate_reward_entries (id, organization_id, line_account_id, affiliate_id, conversion_event_id, entry_type, amount_minor, status, idempotency_key) VALUES ('reward', 'tenant-1', 'a1', 'affiliate', ?, 'credit', 100, 'approved', 'reward-key')`).run(eventId);
    testDb.raw.prepare(`INSERT INTO affiliate_adjustments (id, organization_id, line_account_id, affiliate_id, source_entry_id, amount_minor, reason_type, reason, actor_id, idempotency_key) VALUES ('adjustment', 'tenant-1', 'a1', 'affiliate', 'reward', -100, 'cancel', '取消', 'actor', 'adjustment-key')`).run();
    const response = await req(app(staff('owner-1', 'tenant-1')), testDb, `/api/conversions/events/${eventId}/reversals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'reverse', reason: '確認した内容', expectedReversalId: null, expectedApprovalStatus: null, expectedCancelled: false }),
    });
    expect(response.status).toBe(409);
    expect((testDb.raw.prepare('SELECT COUNT(*) AS n FROM conversion_event_reversals').get() as { n: number }).n).toBe(0);
  });

  it('staff は取り消せない・理由なしは400', async () => {
    const testDb = createTestD1();
    seed(testDb);
    const eventId = await seedEvent(testDb);
    const denied = await req(app(staff('staff-1', 'tenant-1', 'staff', ['/conversions'])), testDb, `/api/conversions/events/${eventId}/reversals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'reverse', reason: 'x' }),
    });
    expect(denied.status).toBe(403);
    const noReason = await req(app(staff('owner-1', 'tenant-1')), testDb, `/api/conversions/events/${eventId}/reversals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'reverse', reason: '  ' }),
    });
    expect(noReason.status).toBe(400);
  });
});

it('サイトごとの同意済み受信時刻を返し、対象外送信では書き換えない', async () => {
 const testDb = createTestD1();
 try {
  seed(testDb); const siteId = seedSite(testDb);
  const read = () => testDb.raw.prepare('SELECT last_received_at FROM measurement_sites WHERE id=?').get(siteId) as {last_received_at:string|null};
  await postConversion(testDb,{siteId,host:'example.com',path:'/not-a-conversion',consent:'granted'});
  const accepted = read().last_received_at;
  expect(accepted).toBeTruthy();
  await postConversion(testDb,{siteId,host:'bad.example.org',consent:'granted'});
  await postConversion(testDb,{siteId,host:'example.com',consent:'declined'});
  expect(read().last_received_at).toBe(accepted);
  const list = await req(app(staff('owner-1','tenant-1')),testDb,'/api/measurement-sites?accountId=a1');
  expect((await list.json() as any).data[0].lastReceivedAt).toBe(accepted);
 } finally { testDb.raw.close(); }
});
