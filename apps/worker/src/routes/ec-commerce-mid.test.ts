import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';

const access = vi.hoisted(() => vi.fn());

vi.mock('../services/account-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/account-access.js')>();
  return { ...actual, canAccessAllLineAccounts: access };
});

const { ecCommerce } = await import('./ec-commerce.js');

function fakeDb() {
  return {
    prepare(_sql: string) {
      const statement = {
        bind(..._bindings: unknown[]) {
          return statement;
        },
        all: async () => ({ results: [] }),
        first: async () => ({ id: 'account-1', channel_access_token: null }),
      };
      return statement;
    },
  };
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', {
      id: 'owner-a', name: '管理者', role: 'owner', readOnly: false, tenantId: 'tenant-a',
    });
    await next();
  });
  instance.route('/', ecCommerce);
  return instance;
}

describe('点検・中: テスト送信の連打防止', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.mockResolvedValue(true);
  });

  it('中10: 同じ店・種別の連続テスト送信は2回目を429で断る', async () => {
    const target = app();
    const db = fakeDb() as unknown as D1Database;
    const payload = {
      eventType: 'ec.order.confirmed',
      accountId: 'account-1',
      title: '注文のお知らせ',
      introText: 'ご注文ありがとうございます',
      outroText: 'またのご利用をお待ちしています',
      buttonLabel: '注文を見る',
      buttonUrl: 'https://example.co.jp/orders/1',
      imageUrl: 'https://example.co.jp/images/1.png',
    };
    const send = () => target.request('/api/ec-commerce/test-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { DB: db } as Env['Bindings']);

    // アカウント未設定で400になるが、クールダウンは刻まれる。
    const first = await send();
    expect(first.status).toBe(400);

    const second = await send();
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ success: false });
  });
});

describe('テスト送信先の確認', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('確認後に宛先が変わったら送信しない', async () => {
    access.mockResolvedValue(true);
    const external = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', external);
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind: (..._values: unknown[]) => stmt,
          first: async () => sql.includes('account_settings')
            ? { value: '["new-friend"]' }
            : { id: 'different-account', channel_access_token: 'test-token' },
          all: async () => ({ results: [{ id: 'new-friend', line_user_id: 'Ufake' }] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return stmt;
      },
    } as unknown as D1Database;
    const res = await app().request('/api/ec-commerce/test-send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'ec.order.confirmed', accountId: 'different-account', title: 'テスト', introText: '', outroText: '', buttonLabel: '', buttonUrl: '', imageUrl: '', expectedRecipientIds: ['old-friend'] }),
    }, { DB: db } as Env['Bindings']);
    expect(res.status).toBe(409);
    expect(external).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('送信の準備中に宛先が変わったらLINEへ送らない', async () => {
    access.mockResolvedValue(true);
    const external = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', external);
    let reads = 0;
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind: (..._values: unknown[]) => stmt,
          first: async () => sql.includes('account_settings')
            ? { value: ++reads === 1 ? '["first"]' : '["second"]' }
            : { id: 'another-account', channel_access_token: 'test-token' },
          all: async () => ({ results: [{ id: reads === 1 ? 'first' : 'second', line_user_id: 'Ufake' }] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
        return stmt;
      },
    } as unknown as D1Database;
    const res = await app().request('/api/ec-commerce/test-send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'ec.order.confirmed', accountId: 'another-account', title: 'テスト', introText: '', outroText: '', buttonLabel: '', buttonUrl: '', imageUrl: '', expectedRecipientIds: ['first'] }),
    }, { DB: db } as Env['Bindings']);
    expect(res.status).toBe(409);
    expect(external).not.toHaveBeenCalled();
  });

});

describe('テスト送信先の版', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([1, undefined])('版 %s の正しい呼び出しは従来どおり送信する', async (expectedConfirmationRevision) => {
    access.mockResolvedValue(true);
    const external = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', external);
    const accountId = `valid-${String(expectedConfirmationRevision)}`;
    const db = { prepare(sql: string) {
      const stmt = { bind: (..._values: unknown[]) => stmt,
        first: async () => sql.includes('account_settings')
          ? { value: '["friend"]', confirmation_revision: 1 }
          : { id: accountId, channel_access_token: 'test-token' },
        all: async () => ({ results: [{ id: 'friend', line_user_id: 'Ufake' }] }),
        run: async () => ({ meta: { changes: 1 } }),
      }; return stmt;
    } } as unknown as D1Database;
    const res = await app().request('/api/ec-commerce/test-send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'ec.order.confirmed', accountId, title: 'テスト', introText: '', outroText: '', buttonLabel: '', buttonUrl: '', imageUrl: '', expectedRecipientIds: ['friend'], expectedConfirmationRevision }),
    }, { DB: db } as Env['Bindings']);
    expect(res.status).toBe(200);
    expect(external).toHaveBeenCalledOnce();
  });
  it.each([0, 1])('宛先が同じでも読み取り %s 回目に版が変われば送信しない', async (changedAt) => {
    access.mockResolvedValue(true);
    const external = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', external);
    let reads = 0;
    let friendReads = 0;
    const db = { prepare(sql: string) {
      const stmt = {
        bind: (..._values: unknown[]) => stmt,
        first: async () => sql.includes('account_settings')
          ? { value: '["friend"]', confirmation_revision: reads++ >= changedAt ? 2 : 1 }
          : { id: `revision-${changedAt}`, channel_access_token: 'test-token' },
        all: async () => { friendReads++; return { results: [{ id: 'friend', line_user_id: 'Ufake' }] }; },
        run: async () => ({ meta: { changes: 1 } }),
      };
      return stmt;
    } } as unknown as D1Database;
    const res = await app().request('/api/ec-commerce/test-send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'ec.order.confirmed', accountId: `revision-${changedAt}`, title: 'テスト', introText: '', outroText: '', buttonLabel: '', buttonUrl: '', imageUrl: '', expectedRecipientIds: ['friend'], expectedConfirmationRevision: 1 }),
    }, { DB: db } as Env['Bindings']);
    expect(res.status).toBe(409);
    expect(external).not.toHaveBeenCalled();
    if (changedAt === 0) expect(friendReads).toBe(0);
  });
});
