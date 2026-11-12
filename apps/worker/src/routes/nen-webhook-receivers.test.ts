/** 5系統のうち受信処理が小さい3口を実ルートで確認。配達とEC連携は既存DB試験も実行する。 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const mocks = vi.hoisted(() => ({
  ingest: vi.fn(), storeEmail: vi.fn(), getSecret: vi.fn(), prepare: vi.fn(),
}));
vi.mock('./ec-connector-secret.js', () => ({ getConnectorSecret: mocks.getSecret }));
vi.mock('../features/ec-commerce/ec-auto-line.js', async (load) => ({
  ...await load<typeof import('../features/ec-commerce/ec-auto-line.js')>(), ingestBehavior: mocks.ingest,
}));
vi.mock('../services/support-email.js', async (load) => ({
  ...await load<typeof import('../services/support-email.js')>(), storeSupportEmail: mocks.storeEmail,
}));
const { ecAutoLine } = await import('./ec-auto-line.js');
const { nenCampaigns } = await import('./nen-campaigns.js');
const { supportInbox } = await import('./support-inbox.js');
const secret = 'receiver-test-secret-with-more-than-32-characters';
const now = 1_792_200_000;
const timestamp = String(now);
const sign = (body: string, time = timestamp) => createHmac('sha256', secret).update(`${time}.${body}`).digest('hex');
const routes = [
  { name: 'auto-line', path: '/api/ec/events', body: { eventId: 'e', type: 'cart_add', productId: 'p' }, limit: 65536, status: 202 },
  { name: 'columns', path: '/api/integrations/eccube/columns', body: { slug: 'test', title: '題', article_url: 'https://example.test/c' }, limit: 262144, status: 200 },
  { name: 'coupon-usage', path: '/api/integrations/eccube/coupon-usages', body: { code: 'test-code' }, limit: 262144, status: 200 },
  { name: 'support', path: '/webhooks/xserver/support-email', body: { raw: btoa('From: Test <test@example.test>\r\nTo: contact@example.com\r\nSubject: Test\r\n\r\nHello') }, limit: null, status: 200 },
];
function app() {
  const a = new Hono<Env>();
  for (const route of [ecAutoLine, nenCampaigns, supportInbox]) a.route('/', route);
  return a;
}
const db = { prepare: mocks.prepare } as unknown as D1Database;
function request(route: typeof routes[number], body = JSON.stringify(route.body), headers: Record<string, string> = {}) {
  return app().request(route.path, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-line-account-id': 'a', 'x-nen-timestamp': timestamp, 'x-nen-signature': sign(body), ...headers },
  }, { DB: db, ECCUBE_WEBHOOK_SECRET: secret, XSERVER_RELAY_SECRET: secret } as Env['Bindings']);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now * 1000);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('external_forbidden'); }));
  mocks.getSecret.mockImplementation(async (_db, account: string) => account === 'a' ? secret : 'other-account-secret');
  mocks.ingest.mockResolvedValue({ accepted: true, matched: false, duplicate: false });
  mocks.storeEmail.mockResolvedValue({ duplicate: false });
  mocks.prepare.mockImplementation((sql: string) => {
    const statement = {
      bind: () => statement,
      first: async () => sql.includes('count(*)') ? { n: 0 }
        : sql.includes("t.status='active'") ? { id: 'connector' } : null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    };
    return statement;
  });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.useRealTimers(); });

for (const route of routes) describe(route.name, () => {
  it('既存の署名で受理し、処理まで進む', async () => {
    const response = await request(route);
    expect(response.status).toBe(route.status);
    expect(await response.json()).toMatchObject({ success: true });
    if (route.name === 'auto-line') expect(mocks.ingest).toHaveBeenCalledWith(db, 'a', route.body);
    if (route.name === 'support') expect(mocks.storeEmail).toHaveBeenCalledOnce();
  });
  it('改ざん・不正形式・期限外を処理前に断る', async () => {
    const body = JSON.stringify(route.body);
    const cases: Array<Record<string, string>> = [
      { 'x-nen-signature': sign(body + ' ') },
      { 'x-nen-signature': 'z'.repeat(64) },
      { 'x-nen-signature': sign(body).slice(1) },
      { 'x-nen-signature': '' },
      { 'x-nen-timestamp': String(now - 301), 'x-nen-signature': sign(body, String(now - 301)) },
      { 'x-nen-timestamp': String(now + 301), 'x-nen-signature': sign(body, String(now + 301)) },
    ];
    for (const headers of cases) {
      expect((await request(route, body, headers)).status).toBe(401);
    }
    expect(mocks.ingest).not.toHaveBeenCalled(); expect(mocks.storeEmail).not.toHaveBeenCalled();
    expect(mocks.prepare.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql))).toBe(false);
  });
  it('sha256前置きの既存の許可/拒否を保つ', async () => {
    const body = JSON.stringify(route.body);
    for (const prefix of ['sha256=', 'SHA256=']) {
      const valid = route.name !== 'support' && (prefix === 'sha256=' || route.name !== 'auto-line');
      const response = await request(route, body, { 'x-nen-signature': prefix + sign(body).toUpperCase() });
      expect(response.status).toBe(valid ? route.status : 401);
    }
  });
  if (route.limit !== null) it('本文のUTF-8上限ちょうどは受理、1byte超過は従来の応答で断る', async () => {
    const base = JSON.stringify(route.body);
    // JSONの外の空白は元の本文のまま署名する。文字数ではbyte数を判定する。
    const body = base + ' '.repeat(route.limit! - new TextEncoder().encode(base).length);
    expect((await request(route, body)).status).toBe(route.status);
    const response = await request(route, body + ' ', { 'content-length': '1' });
    expect(response.status).toBe(route.name === 'auto-line' ? 400 : 413);
    expect(await response.json()).toMatchObject({ success: false, error: route.name === 'auto-line' ? 'body_too_large' : 'Payload too large' });
  });
});
it('自動LINEは別accountの鍵へ広げず、所属する鍵だけを使う', async () => {
  const response = await request(routes[0], undefined, { 'x-line-account-id': 'b' });
  expect(response.status).toBe(401); expect(mocks.ingest).not.toHaveBeenCalled();
});
it('メールは署名対象全体のバイト上限へ変更せず、既存のbase64長上限を保つ', async () => {
  const body = JSON.stringify({ raw: 'a'.repeat(14 * 1024 * 1024 + 1) });
  const response = await request(routes[3], body);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'Invalid email payload' });
  expect(mocks.storeEmail).not.toHaveBeenCalled();
});
