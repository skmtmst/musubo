import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

import { inspectPosts, readOnlyRequest } from './verify-staging-instagram-cross-post.js';
import { readVerificationTarget } from './verify-staging-operational-path.js';

const script = readFileSync(
  new URL('./verify-staging-instagram-cross-post.ts', import.meta.url),
  'utf8',
);
const stagingConfig = readFileSync(
  new URL('../../apps/worker/wrangler.staging.toml', import.meta.url),
  'utf8',
);
const crossPostRoute = readFileSync(
  new URL('../../apps/worker/src/routes/restaurant-google-posts.ts', import.meta.url),
  'utf8',
);
const workflow = readFileSync(
  new URL('../../.github/workflows/migrate-d1.yml', import.meta.url),
  'utf8',
);

const target = { accountId: 'account', databaseId: 'database', workerUrl: 'https://stg-api.musubo.jp' };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

/** migration 611 の前から画面が使っていた形（既定値のまま）の 1 行。 */
function legacyPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1', kind: 'standard', origin: 'app', summary: 'おしらせ', title: null,
    schedule: null, cta: null, offer: null, media: [], publishMode: 'now',
    status: 'published', googleState: 'live', searchUrl: null, staffName: null, error: null,
    createdAt: '2026-10-01T00:00:00.000Z', sentAt: null, publishedAt: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    instagram: { enabled: false, caption: null, status: 'none', permalink: null, error: null },
    ...overrides,
  };
}

describe('staging Instagram cross-post verification safety', () => {
  test('targets only the dedicated staging Worker and D1, and rejects production or delivery cron', () => {
    // 対象の決め方は既に検証済みの共通処理へ委ねる。
    expect(script).toContain("const CONFIG_PATH = 'apps/worker/wrangler.staging.toml'");
    expect(script).toContain('readVerificationTarget(readFileSync(CONFIG_PATH');
    expect(script).toContain("process.env.VERIFY_ENVIRONMENT !== 'staging'");

    expect(readVerificationTarget(stagingConfig)).toMatchObject({
      workerUrl: 'https://stg-api.musubo.jp',
    });
    expect(() => readVerificationTarget(
      stagingConfig.replace('name = "nen-line-stg"', 'name = "production"'),
    )).toThrow('Only the staging Worker is allowed');
    expect(() => readVerificationTarget(
      stagingConfig.replace('database_name = "nen-line-stg"', 'database_name = "nen-line"'),
    )).toThrow('Only the staging D1 database is allowed');
    expect(() => readVerificationTarget(
      stagingConfig.replace('WORKER_PUBLIC_URL = "https://stg-api.musubo.jp"', 'WORKER_PUBLIC_URL = "https://api.musubo.jp"'),
    )).toThrow('Unexpected staging Worker URL');
    expect(() => readVerificationTarget(
      `${stagingConfig}\n[triggers]\ncrons = ["* * * * *"]`,
    )).toThrow('may only schedule LINE token renewal');
  });

  test('runs only from the staging workflow entry, so no secret is needed on a laptop', () => {
    // 手元に秘密値を置かずに走らせる唯一の入口。staging と codex/development に限る。
    expect(workflow).toContain("inputs.operation == 'verify-instagram-cross-post'");
    expect(workflow).toContain('scripts/verification/verify-staging-instagram-cross-post.ts');
    expect(workflow).toContain("inputs.environment == 'staging'");
    expect(workflow).toContain("github.repository == 'skmtmst/line-harness-oss'");
    expect(workflow).toContain("github.ref == 'refs/heads/codex/development'");
    expect(workflow).toContain('VERIFY_ENVIRONMENT: staging');
    expect(workflow).toContain('group: verify-staging-instagram-cross-post');
    expect(workflow).toContain('set -o pipefail');
    expect(workflow).not.toMatch(/\bset\s+-x\b/);
    // 集計だけを出す。秘密値や個別の識別子をサマリーへ流さない。
    expect(workflow).toContain('tail -n 1 "$RUNNER_TEMP/instagram-verification.json"');
    expect(workflow).not.toMatch(/CLOUDFLARE_API_TOKEN[^\n]*GITHUB_STEP_SUMMARY/);
  });

  test('calls only the read-only endpoints with an expiring session, never a write verb', async () => {
    const allowed = fakeFetch(200, { success: true, data: { state: 'unconfigured' } });
    const result = await readOnlyRequest(
      target,
      'token-value',
      '/api/instagram/connection?lineAccountId=account-1',
      allowed,
    );
    expect(result).toMatchObject({ status: 200 });
    const [url, init] = allowed.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://stg-api.musubo.jp/api/instagram/connection?lineAccountId=account-1');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer lh_session:token-value');

    const blocked = fakeFetch(200, { success: true });
    await expect(readOnlyRequest(target, 'token-value', '/api/instagram/connect', blocked)).rejects.toThrow(
      'may only call the read-only',
    );
    await expect(readOnlyRequest(target, 'token-value', '/api/notifications/rules', blocked)).rejects.toThrow(
      'may only call the read-only',
    );
    expect(blocked).not.toHaveBeenCalled();

    expect(script).toContain('const SESSION_TTL_MINUTES = 15');
    expect(script).toContain('DELETE FROM admin_sessions WHERE token_hash = ?');
    // 自分が作った一時行だけを消す。期限切れの他行を一括削除する道を作らない。
    expect(script).not.toContain('expires_at <=');
    expect(script).not.toMatch(/DELETE FROM admin_sessions WHERE(?! token_hash = \?)/);
    expect(script).toContain("method: 'GET'");
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(script).not.toContain(`method: '${verb}'`);
    }
    // 配信や接続のやり直しは呼ばない。
    for (const forbidden of ['/webhook', 'pushMessage', 'multicast', 'INSERT INTO rt_google_posts', 'UPDATE rt_google_posts']) {
      expect(script).not.toContain(forbidden);
    }
    expect(script).not.toMatch(/console\.(?:log|error)\([^\n]*(?:sessionToken|apiToken|staff_id|line_account_id)/);
  });

  test('requires the unconfigured Instagram state and keeps existing post fields', () => {
    expect(script).toContain("status?.state !== 'unconfigured'");
    expect(script).toContain('Expected Instagram state unconfigured');

    expect(inspectPosts([legacyPost(), legacyPost({ id: 'post-2' })])).toEqual({
      checked: 2,
      missingFields: [],
      instagramEnabled: 0,
      unexpectedStatus: [],
    });

    const { instagram: _dropped, ...withoutInstagram } = legacyPost();
    const broken = legacyPost({ summary: undefined, instagram: { enabled: true, status: 'pending' } });
    delete (broken as Record<string, unknown>).summary;
    expect(inspectPosts([withoutInstagram, broken])).toEqual({
      checked: 2,
      missingFields: ['instagram', 'instagram.caption', 'instagram.error', 'instagram.permalink', 'summary'],
      instagramEnabled: 1,
      unexpectedStatus: ['pending'],
    });
  });

  test('records that the Instagram image conversion cannot be reached while unconfigured', () => {
    // 未接続では同時投稿の入口が止まるので、Images を触る経路へ届かない。
    const unconfigured = crossPostRoute.indexOf("InstagramError('instagram_unconfigured', 503)");
    const notConnected = crossPostRoute.indexOf("InstagramError('instagram_not_connected', 409)");
    const imageUrl = crossPostRoute.indexOf('instagramImageUrl(');
    expect(unconfigured).toBeGreaterThan(-1);
    expect(notConnected).toBeGreaterThan(unconfigured);
    expect(imageUrl).toBeGreaterThan(notConnected);

    expect(script).toContain('imageConversionReachable: false');
    expect(script).toContain('imageConversionsRun: 0');
    // 変換を自分で起こさない（根拠として名前を書くだけで、呼び出さない）。
    expect(script).not.toContain('CF_IMAGES');
    expect(script).not.toContain('instagramImageUrl(');
    expect(script).not.toContain('crossPostToInstagram(');
  });
});
