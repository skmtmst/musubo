import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { gettingStartedGuidePaths } from './openapi/getting-started-guide-paths.js';

/*
  文書（OpenAPI）と実応答の形が同じかを、実際に経路を呼んで突き合わせる。
  coverage の検査は「書いてあるか」しか見ないので、包み方のずれを見つけられない。
  ここでは 200 応答の本文をスキーマに当てて確かめる。
*/

const row = {
  phase: 'active',
  step_key: 'hours',
  procedure_index: 2,
  updated_at: '2026-11-16T09:00:00+09:00',
};

const db = {
  getOnboardingGuideProgress: vi.fn(async () => row),
  saveOnboardingGuideProgress: vi.fn(async () => row),
  acknowledgeOnboardingWelcome: vi.fn(async () => row),
  hasSavedFeatureConfiguration: vi.fn(async () => false),
  hasFirstDeliveredMessage: vi.fn(async () => true),
  toJstString: (date: Date) => date.toISOString(),
};
vi.mock('@line-crm/db', () => db);

vi.mock('../services/account-access.js', () => ({
  getVisibleLineAccountScope: vi.fn(async () => ({
    allowedAccountIds: ['account-1'],
    accounts: [{ id: 'account-1' }],
    ids: ['account-1'],
    canSeeUnassigned: false,
    isAccountScoped: false,
  })),
}));

const { gettingStarted } = await import('./getting-started.js');

function app() {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '担当', role: 'owner', readOnly: false, permissionKeys: [] });
    return next();
  });
  instance.route('/', gettingStarted);
  return instance;
}

const environment = { DB: {} as D1Database } as Env['Bindings'];

/** 文書のスキーマに本文を当てる。足りない・余る・型違いはすべて差分として返す。 */
function mismatches(schema: Record<string, any>, value: unknown, path = '$'): string[] {
  const found: string[] = [];
  if (schema.nullable && value === null) return found;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    found.push(`${path}: ${JSON.stringify(value)} は ${JSON.stringify(schema.enum)} に入らない`);
    return found;
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      found.push(`${path}: オブジェクトでない（${typeof value}）`);
      return found;
    }
    const body = value as Record<string, unknown>;
    const properties: Record<string, any> = schema.properties ?? {};
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in body)) found.push(`${path}.${key}: 文書にあるが実応答にない`);
    }
    for (const key of Object.keys(body)) {
      if (!(key in properties)) {
        found.push(`${path}.${key}: 実応答にあるが文書にない`);
        continue;
      }
      if (key in body) found.push(...mismatches(properties[key], body[key], `${path}.${key}`));
    }
    return found;
  }
  if (schema.type === 'string' && typeof value !== 'string') found.push(`${path}: 文字列でない（${typeof value}）`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') found.push(`${path}: 真偽でない（${typeof value}）`);
  if (schema.type === 'integer' && !Number.isInteger(value)) found.push(`${path}: 整数でない（${JSON.stringify(value)}）`);
  if (schema.type === 'integer' && typeof schema.minimum === 'number' && (value as number) < schema.minimum) {
    found.push(`${path}: ${schema.minimum} 未満（${JSON.stringify(value)}）`);
  }
  return found;
}

function documented(method: 'get' | 'put') {
  const operation = (gettingStartedGuidePaths['/api/getting-started/guide'] as Record<string, any>)[method];
  return operation.responses['200'].content['application/json'].schema as Record<string, any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.getOnboardingGuideProgress.mockResolvedValue(row);
  db.saveOnboardingGuideProgress.mockResolvedValue(row);
});

it('GETの200応答が文書の形と一致する', async () => {
  const response = await app().fetch(
    new Request('https://example.com/api/getting-started/guide?account_id=account-1'),
    environment,
  );
  expect(response.status).toBe(200);
  expect(mismatches(documented('get'), await response.json())).toEqual([]);
});

it('PUTの200応答が文書の形と一致する', async () => {
  const response = await app().fetch(
    new Request('https://example.com/api/getting-started/guide?account_id=account-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase: 'active', stepKey: 'hours', procedureIndex: 2 }),
    }),
    environment,
  );
  expect(response.status).toBe(200);
  expect(mismatches(documented('put'), await response.json())).toEqual([]);
});

it('保存がまだ無い既定値も文書の形に収まる', async () => {
  db.getOnboardingGuideProgress.mockResolvedValue(null as unknown as typeof row);
  const response = await app().fetch(
    new Request('https://example.com/api/getting-started/guide?accountId=account-1'),
    environment,
  );
  const body = await response.json() as { data: { phase: string; stepKey: null; procedureIndex: number } };
  expect(body.data).toEqual({ phase: 'idle', stepKey: null, procedureIndex: 1, updatedAt: null });
  expect(mismatches(documented('get'), body)).toEqual([]);
});

it('文書は成功の包み（success と data）を必須にしている', () => {
  for (const method of ['get', 'put'] as const) {
    const schema = documented(method);
    expect(schema.required).toEqual(['success', 'data']);
    expect(schema.properties.data.required).toEqual(['phase', 'stepKey', 'procedureIndex', 'updatedAt']);
  }
});

it('包みの無い応答は差分として検出できる（検査自体の確かさ）', () => {
  expect(mismatches(documented('get'), { phase: 'idle', stepKey: null, procedureIndex: 1, updatedAt: null }).length)
    .toBeGreaterThan(0);
});

it('ウェルカムの確認結果は進行を書き換えず、既存の進み具合を返す', async () => {
  const response = await app().request('/api/getting-started/guide?account_id=account-1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phase: 'idle', stepKey: null, procedureIndex: 1, acknowledgeWelcome: true }),
  }, environment);
  expect(response.status).toBe(200);
  expect(db.acknowledgeOnboardingWelcome).toHaveBeenCalledWith(environment.DB, 'staff-1', 'account-1');
  expect(db.saveOnboardingGuideProgress).not.toHaveBeenCalled();
  expect(await response.json()).toMatchObject({ data: { phase: 'active', stepKey: 'hours', procedureIndex: 2 } });
});

it('ウェルカムの確認を通常の進行更新と組み合わせた場合は保存しない', async () => {
  const response = await app().request('/api/getting-started/guide?account_id=account-1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phase: 'active', stepKey: 'hours', procedureIndex: 2, acknowledgeWelcome: true }),
  }, environment);
  expect(response.status).toBe(400);
  expect(db.acknowledgeOnboardingWelcome).not.toHaveBeenCalled();
  expect(db.saveOnboardingGuideProgress).not.toHaveBeenCalled();
});
