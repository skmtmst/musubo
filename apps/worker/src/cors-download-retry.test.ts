import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './worker-env.js';

const response = vi.hoisted(() => ({ retryAfter: '60' as string | null }));
vi.mock('./middleware/rate-limit.js', () => ({
  rateLimitMiddleware: (c: { json: (body: unknown, init: unknown) => Response }) => c.json(
    { success: false, error: 'Too many requests. Please try again later.' },
    { status: 429, headers: response.retryAfter === null ? {} : { 'Retry-After': response.retryAfter } },
  ),
  authenticatedRateLimitMiddleware: (_c: unknown, next: () => Promise<void>) => next(),
}));
import { app, ADMIN_REQUEST_HEADERS } from './index.js';

const origin = 'https://liff.fixture.test';
const paths = [
  ['明細の再発行', '/api/liff/affiliate/statements/synthetic/download?issue=1'],
  ['明細の本体', '/api/liff/affiliate/statements/synthetic/download?expires=1&signature=synthetic'],
  ['添付の再発行', '/api/liff/files/synthetic/download'],
  ['添付の本体', '/images/chat-attachments/synthetic?expires=1&signature=synthetic'],
];
const db = { prepare: vi.fn(() => { throw new Error('Database access is outside this fixture'); }) };
const env = { ADMIN_ORIGIN: origin, WORKER_URL: 'https://api.fixture.test', DB: db } as unknown as Env['Bindings'];
function request(path: string, from = origin, method = 'GET') {
  return app.request(`https://api.fixture.test${path}`, { method, headers: {
    Origin: from, Authorization: 'Bearer synthetic-not-a-secret',
    ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization' } : {}),
  } }, env);
}
beforeEach(() => { response.retryAfter = '60'; });

describe('取得の待ち時間と実WorkerのCORS', () => {
  it.each(paths)('%sの429で許可された送信元に待ち時間を公開する', async (_name, path) => {
    const result = await request(path);
    expect(result.status).toBe(429);
    expect(result.headers.get('Retry-After')).toBe('60');
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(result.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(result.headers.get('Access-Control-Expose-Headers')?.split(',').map(x => x.trim().toLowerCase())).toEqual([
      'content-disposition', 'x-exported-by', 'x-exported-at', 'x-csv-total-count',
      'x-csv-returned-count', 'x-csv-truncated', 'x-request-id', 'server-timing', 'retry-after',
    ]);
    expect(db.prepare).not.toHaveBeenCalled();
  });
  it.each(paths)('%sは許可されない送信元へCORSの許可を返さない', async (_name, path) => {
    const result = await request(path, 'https://untrusted.fixture.test');
    expect(result.status).toBe(429);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });
  it.each([null, 'invalid', '0', '-1'])('待ち時間 %s を新しい値へ補わない', async value => {
    response.retryAfter = value;
    const result = await request(paths[0][1]);
    expect(result.status).toBe(429);
    expect(result.headers.get('Retry-After')).toBe(value);
  });
  it('事前確認のメソッド・要求ヘッダー・Cookieの許可条件を保つ', async () => {
    const result = await request(paths[0][1], origin, 'OPTIONS');
    expect(result.status).toBe(204);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(result.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(result.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS');
    expect(result.headers.get('Access-Control-Allow-Headers')?.split(',')).toEqual([...ADMIN_REQUEST_HEADERS]);
    expect(result.headers.get('Access-Control-Max-Age')).toBe('600');
    expect(db.prepare).not.toHaveBeenCalled();
  });
  it('登録メディアの名前変更・フォルダ移動の事前確認で If-Match を許す', async () => {
    const result = await app.request('https://api.fixture.test/api/media/synthetic?accountId=synthetic', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'content-type,if-match,x-csrf-token',
      },
    }, env);
    expect(result.status).toBe(204);
    expect(result.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(result.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    const allowedHeaders = result.headers.get('Access-Control-Allow-Headers')?.toLowerCase().split(',');
    expect(allowedHeaders).toEqual(expect.arrayContaining(['content-type', 'if-match', 'x-csrf-token']));
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
