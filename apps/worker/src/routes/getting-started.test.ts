import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const db = {
  activeTenantLineAccountSql: () => '1',
  hasSavedFeatureConfiguration: vi.fn(async () => false),
  resolveLineCredential: vi.fn(async () => 'token'),
  hasFirstDeliveredMessage: vi.fn(async () => true),
  getOnboardingGuideProgress: vi.fn(async () => null),
  firstDeliveredMessageAt: vi.fn(async () => null),
  toJstString: (date: Date) => date.toISOString(),
};
vi.mock('@line-crm/db', () => db);

const accountAccess = {
  getVisibleLineAccountScope: vi.fn(async () => ({
    allowedAccountIds: ['account-1'],
    accounts: [{ id: 'account-1' }],
    ids: ['account-1'],
    canSeeUnassigned: false,
    isAccountScoped: false,
  })),
};
vi.mock('../services/account-access.js', () => accountAccess);

const webhook = {
  expectedWebhookUrl: vi.fn(() => 'https://worker.example.com/webhook'),
  fetchWebhookEndpoint: vi.fn(async (): Promise<{
    expectedUrl: string; actualUrl: string | null; active: boolean | null;
    status: 'matched' | 'mismatched' | 'unconfigured' | 'unknown';
  }> => ({ expectedUrl: '', actualUrl: null, active: null, status: 'matched' })),
};
vi.mock('../lib/webhook-endpoint.js', () => webhook);

const state = {
  tags: 1,
  fields: 0,
  anyRule: true,
  scenarios: 1,
  linkedScenario: true,
  dismissedAt: null as string | null,
  rules: [{
    is_unknown_route_fallback: 1,
    definition_snapshot: JSON.stringify({ scenarioId: 'scenario-1', actions: [] }),
  }],
};

let accountRows = [{
  id: 'account-1',
  is_active: 1,
  style: null as string | null,
  webhook_ready: null as number | null,
  channel_access_token: 'token',
  channel_access_token_encrypted: null,
  channel_secret: 'secret',
  channel_secret_encrypted: null,
}];

function database(): D1Database {
  return {
    prepare(sql: string) {
      const make = (bindings: unknown[]) => ({
        bind: (...next: unknown[]) => make(next),
        async all<T>() {
          if (sql.includes('FROM line_accounts')) return { results: accountRows as T[] };
          if (sql.includes('FROM friend_add_rules r')) return { results: state.rules as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('FROM tags')) return { c: state.tags } as T;
          if (sql.includes('FROM friend_fields')) return { c: state.fields } as T;
          if (sql.includes('FROM friend_add_rules') && !sql.includes(' r')) {
            return (state.anyRule ? { hit: 1 } : null) as T | null;
          }
          if (sql.includes('COUNT(*) AS c FROM scenarios')) return { c: state.scenarios } as T;
          if (sql.includes('SELECT 1 AS hit FROM scenarios')) {
            expect(bindings[0]).toBe('account-1');
            return (state.linkedScenario ? { hit: 1 } : null) as T | null;
          }
          if (sql.includes('FROM staff_members')) {
            return { dismissed_at: state.dismissedAt } as T | null;
          }
          return null;
        },
        async run() {
          if (sql.includes('UPDATE staff_members') && sql.includes('getting_started_dismissed_at')) {
            state.dismissedAt = '2026-09-28T12:00:00+09:00';
          }
          return { meta: { changes: 1 } } as D1Result;
        },
      });
      return make([]);
    },
  } as unknown as D1Database;
}

const { gettingStarted } = await import('./getting-started.js');

function makeApp(role: 'owner' | 'admin' | 'staff' = 'owner', permissionKeys: string[] = [], hqRole?: 'operator', readOnly = false) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '担当', role, readOnly, permissionKeys, hqRole });
    return next();
  });
  app.route('/', gettingStarted);
  return app;
}

it('最初の1通はガイドと同じ操作権限と対象アカウントを確認する', async () => {
  const request = (app: Hono<Env>, accountId: string, action = '', method = 'GET') =>
    app.request(`/api/getting-started/first-message${action}?account_id=${accountId}`, { method }, { DB: database() });
  const editor = makeApp('staff', ['/chats']);
  expect((await request(editor, 'account-1')).status).toBe(200);
  expect((await request(editor, 'other', '/send', 'POST')).status).toBe(404);
  expect((await request(makeApp('staff'), 'account-1', '/identity', 'POST')).status).toBe(403);
  expect((await request(makeApp('staff', ['/chats'], undefined, true), 'account-1', '/send', 'POST')).status).toBe(403);
});

beforeEach(() => {
  vi.clearAllMocks();
  accountRows = [{
    id: 'account-1', is_active: 1, style: null, webhook_ready: null, channel_access_token: 'token',
    channel_access_token_encrypted: null, channel_secret: 'secret', channel_secret_encrypted: null,
  }];
  state.tags = 1;
  state.dismissedAt = null;
  state.fields = 0;
  state.anyRule = true;
  state.scenarios = 1;
  state.linkedScenario = true;
  state.rules = [{
    is_unknown_route_fallback: 1,
    definition_snapshot: JSON.stringify({ scenarioId: 'scenario-1', actions: [] }),
  }];
  db.hasFirstDeliveredMessage.mockResolvedValue(true);
  webhook.fetchWebhookEndpoint.mockResolvedValue({
    expectedUrl: 'https://worker.example.com/webhook',
    actualUrl: 'https://worker.example.com/webhook',
    active: true,
    status: 'matched',
  });
  accountAccess.getVisibleLineAccountScope.mockResolvedValue({
    allowedAccountIds: ['account-1'],
    accounts: [{ id: 'account-1' }],
    ids: ['account-1'],
    canSeeUnassigned: false,
    isAccountScoped: false,
  });
});

describe('GET /api/getting-started', () => {
  it('5段を選択アカウントの実データから毎回計算する', async () => {
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { doneCount: number; allDone: boolean; steps: Array<{ state: string }> } };
    expect(body.data.doneCount).toBe(5);
    expect(body.data.allDone).toBe(true);
    expect(body.data.steps.map((step) => step.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it.each([[0, 1, 'stalled'], [1, 0, 'stalled'], [1, null, 'unknown'], [1, 1, 'done']])(
    '飲食店の初回設定は稼働状態 %s と確認結果 %s から %s を返す',
    async (active, webhookReady, status) => {
      Object.assign(accountRows[0], { style: 'restaurant', is_active: active, webhook_ready: webhookReady });
      const response = await makeApp().fetch(new Request('https://example.com/api/getting-started?account_id=account-1&version=v8'), { DB: database() });
      const result = await response.json() as { data: { steps: Array<{key: string; state: string; reason: string | null}> } };
      const entry = result.data.steps.find(step => step.key === 'accounts');
      expect(entry?.state).toBe(status);
      if (status !== 'done') expect(entry?.reason).toContain('確認');
      expect(webhook.fetchWebhookEndpoint).not.toHaveBeenCalled();
    },
  );

  it('登録済みならLINE側のWebhookを確認できなくても完了にする', async () => {
    webhook.fetchWebhookEndpoint.mockRejectedValue(new Error('temporary'));
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    const body = await response.json() as { data: { steps: Array<{ key: string; state: string }> } };
    expect(body.data.steps.find((step) => step.key === 'accounts')?.state).toBe('done');
    expect(webhook.fetchWebhookEndpoint).not.toHaveBeenCalled();
  });

  it('登録済みならLINE側のWebhook利用がオフでも完了にする', async () => {
    webhook.fetchWebhookEndpoint.mockResolvedValue({
      expectedUrl: 'https://worker.example.com/webhook',
      actualUrl: 'https://worker.example.com/webhook',
      active: false,
      status: 'matched',
    });
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    const body = await response.json() as {
      data: {
        steps: Array<{ key: string; state: string; reason: string | null; webhook?: unknown }>;
      };
    };
    const accounts = body.data.steps.find((step) => step.key === 'accounts');
    expect(accounts?.state).toBe('done');
    expect(accounts?.reason).toBeNull();
    expect(accounts?.webhook).toBeUndefined();
  });

  it('登録済みなら停止中のアカウントも段1は完了にする', async () => {
    accountRows[0].is_active = 0;
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    const body = await response.json() as { data: { steps: Array<{ key: string; state: string }> } };
    expect(body.data.steps.find((step) => step.key === 'accounts')?.state).toBe('done');
  });

  it('アカウント未登録なら段1は未完了にする', async () => {
    accountRows = [];
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    const body = await response.json() as { data: { steps: Array<{ key: string; state: string }> } };
    expect(body.data.steps.find((step) => step.key === 'accounts')?.state).toBe('todo');
  });

  it('設定が空なら未完了と理由を返す', async () => {
    state.tags = 0;
    state.fields = 0;
    state.anyRule = false;
    state.scenarios = 0;
    state.linkedScenario = false;
    state.rules = [];
    db.hasFirstDeliveredMessage.mockResolvedValue(false);
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    const body = await response.json() as {
      data: { doneCount: number; allDone: boolean; steps: Array<{ key: string; state: string }> };
    };
    expect(body.data.doneCount).toBe(1);
    expect(body.data.allDone).toBe(false);
    expect(body.data.steps.slice(1).map((step) => step.state)).toEqual([
      'todo', 'todo', 'todo', 'todo',
    ]);
  });

  it('権限のないスタッフには未完了段のボタンを返さない', async () => {
    state.tags = 0;
    state.fields = 0;
    const response = await makeApp('staff').fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    const body = await response.json() as {
      data: { steps: Array<{ key: string; state: string; href: string | null }> };
    };
    expect(body.data.steps.find((step) => step.key === 'attributes')).toMatchObject({
      state: 'forbidden', href: null,
    });
  });

  it('統括の業務担当には店舗設定につながる未完了段を返す', async () => {
    state.tags = 0;
    const response = await makeApp('staff', [], 'operator').fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    const body = await response.json() as { data: { steps: Array<{ key: string; state: string; href: string | null }> } };
    expect(body.data.steps.find(step => step.key === 'attributes')).toMatchObject({ state: 'todo', href: '/tags?tab=tags' });
  });

  it('担当外アカウントは存在を隠して404にする', async () => {
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started?account_id=account-2'),
      { DB: database() },
    );
    expect(response.status).toBe(404);
    expect(db.hasFirstDeliveredMessage).not.toHaveBeenCalledWith(expect.anything(), 'account-2');
  });

  it('閉じていなければ dismissed=false を返す', async () => {
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    const body = await response.json() as { data: { dismissed: boolean } };
    expect(body.data.dismissed).toBe(false);
  });

  it('閉じた本人には dismissed=true を返す', async () => {
    state.dismissedAt = '2026-09-28T12:00:00+09:00';
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started?account_id=account-1'),
      { DB: database() },
    );
    const body = await response.json() as { data: { dismissed: boolean } };
    expect(body.data.dismissed).toBe(true);
  });
});

describe('POST /api/getting-started/dismiss', () => {
  it('本人の「閉じた」日時を記録する', async () => {
    const response = await makeApp().fetch(
      new Request('https://example.com/api/getting-started/dismiss', { method: 'POST' }),
      { DB: database() },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { dismissed: boolean } };
    expect(body.data.dismissed).toBe(true);
    expect(state.dismissedAt).not.toBeNull();
  });
});

 it('V8 inserts saved feature configuration as step 2 and keeps delivery as step 6', async () => {
  db.hasSavedFeatureConfiguration.mockResolvedValue(false);
  const request = () => makeApp().request('/api/getting-started?account_id=account-1&version=v8', {}, { DB: database() });
  const first = await (await request()).json() as {data:{steps:Array<{key:string;state:string}>;total:number;allDone:boolean}};
  expect(first.data.total).toBe(6); expect(first.data.steps[1]).toMatchObject({key:'featureSet',state:'todo'});
  expect(first.data.allDone).toBe(false);
  db.hasSavedFeatureConfiguration.mockResolvedValue(true);
  db.hasFirstDeliveredMessage.mockResolvedValue(false);
  const saved = await (await request()).json() as typeof first;
  expect(saved.data.steps[1].state).toBe('done'); expect(saved.data.steps[5]).toMatchObject({key:'firstMessage',state:'todo'});
 });
