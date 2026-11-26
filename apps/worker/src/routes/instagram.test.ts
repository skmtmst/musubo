import { Hono } from 'hono';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { instagram } from './instagram.js';
import { featureEnforcementMiddleware } from '../middleware/feature-enforcement.js';
import {
  verifyInstagramSignature,
  purgeInstagramTransientData,
  instagramConfig,
  instagramUrlDetail,
  instagramUrlScopes,
} from '../services/instagram.js';
let db: SqliteD1;
const admin: AuthenticatedStaff = {
  id: 'staff',
  name: '管理者',
  role: 'admin',
  readOnly: false,
  tenantId: 't1',
  permissionKeys: [],
};
const config = {
  // Webhook の署名照合に使う Facebook アプリ側の値。接続には使わない。
  META_APP_ID: '100',
  META_APP_SECRET: 'secret_mock',
  // 接続（Instagram直接ログイン）で使う Instagram アプリ側の値。番号は Facebook とは別。
  INSTAGRAM_APP_ID: '200',
  INSTAGRAM_APP_SECRET: 'ig_secret_mock',
  META_REDIRECT_URI: 'https://worker.test/api/instagram/oauth/callback',
  META_GRAPH_API_VERSION: 'v24.0',
  META_TOKEN_ENCRYPTION_KEY: btoa('x'.repeat(32)),
  META_WEBHOOK_VERIFY_TOKEN: 'verify_mock',
};
function app(staff = admin, configured = true, enforceFeatures = false) {
  const a = new Hono<Env>();
  a.use('*', async (c, next) => {
    c.env = { DB: db.db, ...(configured ? config : {}) } as Env['Bindings'];
    c.set('staff', staff);
    await next();
  });
  if (enforceFeatures) a.use('/api/*', featureEnforcementMiddleware);
  a.route('/', instagram);
  return a;
}
function req(
  path: string,
  body?: unknown,
  method = 'POST',
  staff = admin,
  configured = true,
) {
  return app(staff, configured).request(
    path + (path.includes('?') ? '&' : '?') + 'lineAccountId=a1',
    {
      method: body === undefined ? 'GET' : method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}
type Payload = {
  data: {
    url: string;
    state: string;
    connection: { version: number; id: string };
    connections: { id: string; instagramId: string; state: string; version: number }[];
    version: number;
    connected: boolean;
    value: unknown;
    messages: unknown[];
    total: number;
  };
};
const read = async (r: Response) => (await r.json()) as Payload;
beforeEach(() => {
  db = createTestD1();
  db.raw.exec(
    "INSERT INTO tenants(id,name) VALUES('t1','1'),('t2','2'); INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a1','1','1','','','t1'),('a2','2','2','','','t2');",
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string) => {
      const u = new URL(String(url)),
        path = u.pathname;
      // `/oauth/access_token` を `/access_token` より先に見る。後者は前者にも当たるため、
      // 順番を逆にすると認可コードの引き換えが長期の合鍵の形で返ってしまう。
      const result = path.endsWith('/oauth/access_token')
        ? {
            // 認可コードの引き換え（api.instagram.com）。許可された権限と投稿先のIDは
            // この応答にしか入っていない。
            data: [
              {
                access_token: 'short_mock',
                user_id: '20',
                permissions:
                  'instagram_business_basic,instagram_business_content_publish',
              },
            ],
          }
        : path.endsWith('/access_token') ||
            path.endsWith('/refresh_access_token')
          ? // 長期の合鍵への交換と、その期限延ばし（graph.instagram.com、版を付けない）
            { access_token: 'long_mock', expires_in: 60 * 86400 }
          : path.endsWith('/subscribed_apps')
            ? { success: true }
            : path.endsWith('/media')
              ? { data: [{ id: 'post1', caption: '新着' }] }
              : { id: '20', username: 'test_ig' };
      return Response.json(result);
    }),
  );
});
afterEach(() => {
  db.raw.close();
  vi.unstubAllGlobals();
});
/**
 * 接続を途中で終わらせないよう、Instagram の認可から戻るだけで保存を完了し、ページ選択を挟まず設定の SNS 連携へ戻す。
 */
async function connect() {
  const start = await read(await req('/api/instagram/oauth/start', {}));
  const url = new URL(start.data.url);
  // Facebookページを介さない Instagram 直接ログイン。認可画面も Instagram 側に出る。
  expect(url.origin + url.pathname).toBe(
    'https://www.instagram.com/oauth/authorize',
  );
  expect(url.searchParams.get('client_id')).toBe(config.INSTAGRAM_APP_ID);
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('scope')).toContain(
    'instagram_business_content_publish',
  );
  // 前につないだことのあるアカウントだと、Instagram は許可の一覧を出さず短い確認だけで
  // 戻すことがある。そのとき後から足した許可は渡されず接続が必ず失敗するため、
  // 毎回ログインと許可の一覧からやり直させる。
  expect(url.searchParams.get('force_reauth')).toBe('true');
  const state = url.searchParams.get('state')!;
  const callback = await req(
    '/api/instagram/oauth/callback?' +
      new URLSearchParams({ state, code: 'mock_code' }),
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toContain(
    '/settings/sns?instagram=connected',
  );
  return state;
}
async function connectAccount(lineAccountId: string, staff = admin) {
  const start = await app(staff).request(`/api/instagram/oauth/start?lineAccountId=${lineAccountId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const state = new URL(((await start.json()) as Payload).data.url).searchParams.get('state')!;
  const response = await app(staff).request('/api/instagram/oauth/callback?' + new URLSearchParams({ state, code: 'mock_code' }));
  return new URL(response.headers.get('location')!);
}
it('設定なしは未設定。Metaへ接続せず画面の読取を返す', async () => {
  expect(
    (
      await read(
        await req('/api/instagram/connection', undefined, 'GET', admin, false),
      )
    ).data.state,
  ).toBe('unconfigured');
  expect(
    (await req('/api/instagram/oauth/start', {}, 'POST', admin, false)).status,
  ).toBe(503);
  expect(fetch).not.toHaveBeenCalled();
});
it('Instagramログイン→暗号化保存→更新→新着同期→切断をモックで通す', async () => {
  await connect();
  const row = db.raw
    .prepare(
      'SELECT page_token_encrypted,user_token_encrypted FROM instagram_connections',
    )
    .get() as Record<string, string>;
  expect(row.page_token_encrypted).toMatch(/^v1\./);
  expect(JSON.stringify(row)).not.toContain('long_mock');
  expect(JSON.stringify(row)).not.toContain('short_mock');
  const status = await read(await req('/api/instagram/connection'));
  expect(status.data.connection.version).toBe(1);
  expect(JSON.stringify(status)).not.toContain('token');
  expect((await req('/api/instagram/refresh', {})).status).toBe(200);
  expect((await req('/api/instagram/sync', {})).status).toBe(200);
  expect((await read(await req('/api/instagram/posts'))).data.value).toEqual([
    { id: 'post1', caption: '新着' },
  ]);
  expect(
    (await req('/api/instagram/connection', { expectedVersion: 1 }, 'DELETE'))
      .status,
  ).toBe(409);
  expect(
    (await req('/api/instagram/connection', { expectedVersion: 2 }, 'DELETE'))
      .status,
  ).toBe(200);
  expect(
    db.raw.prepare('SELECT COUNT(*) n FROM instagram_connections').get(),
  ).toEqual({ n: 0 });
});
it('接続確認で保存済みの誤った投稿先IDを正確なプロフィールIDへ戻す', async () => {
  await connect();
  db.raw.prepare("UPDATE instagram_connections SET page_id='21',instagram_id='21'").run();
  expect((await req('/api/instagram/refresh', {})).status).toBe(200);
  expect(db.raw.prepare('SELECT page_id,instagram_id FROM instagram_connections').get()).toEqual({
    page_id: '20', instagram_id: '20',
  });
});
it('接続一覧は同じLINEアカウントの接続を全件、既定と同じ並びで返す', async () => {
  await connect();
  addSecondConnection();

  const list = await read(await req('/api/instagram/connections', undefined, 'GET'));
  expect(list.data.state).toBe('connected');
  expect(list.data.connections.map((row: { instagramId: string }) => row.instagramId)).toEqual(['20', '21']);
  // 先頭は接続IDを省いたときに読まれる1件と同じ。画面はこの順で行を並べる。
  const single = await read(await req('/api/instagram/connection', undefined, 'GET'));
  expect(list.data.connections[0].id).toBe(single.data.connection.id);
  expect(list.data.connections[1].id).toBe('igc-2');
  expect(list.data.connections[1].version).toBe(7);
  // 合鍵は行ごとにも出さない。
  expect(JSON.stringify(list)).not.toContain('token');
  expect(JSON.stringify(list)).not.toContain('encrypted');
});
it('機能停止中も実middlewareを通って接続2件を読め、別統括の接続は読めない', async () => {
  await connect();
  addSecondConnection();
  db.raw.prepare('INSERT INTO account_settings(id,line_account_id,key,value) VALUES(?,?,?,?)')
    .run('ig-disabled', 'a1', 'feature.external_integrations', JSON.stringify({ enabled: false }));
  const original = db.raw.prepare('SELECT * FROM instagram_connections ORDER BY id').all();
  vi.mocked(fetch).mockClear();

  const response = await app(admin, true, true).request('/api/instagram/connections?lineAccountId=a1');
  expect(response.status).toBe(200);
  const list = await read(response);
  expect(list.data.connections.map((row) => row.instagramId)).toEqual(['20', '21']);
  expect(JSON.stringify(list)).not.toMatch(/token|encrypted/);
  expect((await app({ ...admin, tenantId: 't2' }, true, true)
    .request('/api/instagram/connections?lineAccountId=a1')).status).toBe(404);
  expect(db.raw.prepare('SELECT * FROM instagram_connections ORDER BY id').all()).toEqual(original);
  expect(fetch).not.toHaveBeenCalled();
});
it('接続一覧は行ごとに期限を見て、1件が切れても他の行は使えるままにする', async () => {
  await connect();
  addSecondConnection();
  db.raw.prepare("UPDATE instagram_connections SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='igc-2'").run();

  const list = await read(await req('/api/instagram/connections', undefined, 'GET'));
  expect(list.data.connections.map((row: { state: string }) => row.state)).toEqual(['connected', 'expired']);
  expect(list.data.state).toBe('connected');
});
it('接続一覧に別の統括・権限の無いLINEアカウントの接続は出ない', async () => {
  await connect();
  addSecondConnection();
  const otherStaff = { ...admin, tenantId: 't2' };

  // 別統括のstaffからは、こちらのLINEアカウントそのものが見えない。
  expect((await app(otherStaff).request('/api/instagram/connections?lineAccountId=a1')).status).toBe(404);
  // 自分の側のLINEアカウントを見ても、こちらの接続は混ざらない。
  const own = await read(await app(otherStaff).request('/api/instagram/connections?lineAccountId=a2'));
  expect(own.data).toEqual({ state: 'disconnected', connections: [] });
});
it('設定なしの配備先では接続一覧も未設定を返し、Metaへ出て行かない', async () => {
  const list = await read(await req('/api/instagram/connections', undefined, 'GET', admin, false));
  expect(list.data).toEqual({ state: 'unconfigured', connections: [] });
  expect(fetch).not.toHaveBeenCalled();
});
it('同じ統括の2つのLINEアカウントへ同じInstagramを接続でき、別統括には共有しない', async () => {
  db.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a3','3','3','','','t1')");
  await connect();
  const back = await connectAccount('a3');

  expect(back.searchParams.get('instagram')).toBe('connected');
  expect(db.raw.prepare('SELECT COUNT(*) n FROM instagram_connections WHERE instagram_id=?').get('20')).toEqual({ n: 2 });
  const otherStaff = { ...admin, tenantId: 't2' };
  const otherBack = await connectAccount('a2', otherStaff);
  expect(otherBack.searchParams.get('instagram')).toBe('failed');
  expect(otherBack.searchParams.get('instagram_code')).toBe('instagram_account_other_organization');
  expect(db.raw.prepare('SELECT COUNT(*) n FROM instagram_connections').get()).toEqual({ n: 2 });
  expect(() => db.raw.prepare("INSERT INTO instagram_connections(line_account_id,page_id,instagram_id,page_name,page_token_encrypted,user_token_encrypted,expires_at,refreshed_at,connected_by) VALUES('a2','20','20','other','encrypted','encrypted','2030-01-01','2026-01-01','staff')").run()).toThrow('instagram_cross_tenant');
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM instagram_oauth_states').get()).toEqual({ n: 0 });
});
it('別のInstagramアカウントも別のLINEアカウントへ接続できる', async () => {
  db.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a3','3','3','','','t1')");
  await connect();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/oauth/access_token')) return Response.json({ data: [{
      access_token: 'other_short', user_id: '21',
      permissions: 'instagram_business_basic,instagram_business_content_publish',
    }] });
    if (path.endsWith('/me')) return Response.json({ id: '21', username: 'other_ig' });
    return original(url, init);
  }));
  expect((await connectAccount('a3')).searchParams.get('instagram')).toBe('connected');
  expect(db.raw.prepare('SELECT line_account_id,instagram_id FROM instagram_connections ORDER BY line_account_id').all()).toEqual([
    { line_account_id: 'a1', instagram_id: '20' },
    { line_account_id: 'a3', instagram_id: '21' },
  ]);
});
it('認可応答の数値IDが丸められても、プロフィールの正確な文字列IDで接続する', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/oauth/access_token')) return Response.json({ data: [{
      access_token: 'short_mock', user_id: 39493407693639108,
      permissions: 'instagram_business_basic,instagram_business_content_publish',
    }] });
    if (path.endsWith('/me')) return Response.json({ id: '39493407693639108', username: 'test_ig' });
    return original(url, init);
  }));

  expect((await connectAccount('a1')).searchParams.get('instagram')).toBe('connected');
  expect(db.raw.prepare('SELECT instagram_id FROM instagram_connections').get()).toEqual({
    instagram_id: '39493407693639108',
  });
});
it('正確な文字列IDが取れないときは、丸めた数値IDを保存しない', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/oauth/access_token')) return Response.json({ data: [{
      access_token: 'short_mock', user_id: 39493407693639108,
      permissions: 'instagram_business_basic,instagram_business_content_publish',
    }] });
    if (path.endsWith('/me')) return Response.json({ username: 'test_ig' });
    return original(url, init);
  }));

  const back = await connectAccount('a1');
  expect(back.searchParams.get('instagram_code')).toBe('instagram_business_account_required');
  expect(db.raw.prepare('SELECT COUNT(*) AS n FROM instagram_connections').get()).toEqual({ n: 0 });
});
it('閲覧のみ・別アカウント・偽state・再利用・期限切れを拒否する', async () => {
  expect(
    (
      await req('/api/instagram/oauth/start', {}, 'POST', {
        ...admin,
        readOnly: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (await app().request('/api/instagram/connection?lineAccountId=a2')).status,
  ).toBe(404);
  // 折り返しは画面へ戻す口なので、失敗の中身は出さずに instagram=failed だけを伝える。
  const wrong = await req('/api/instagram/oauth/callback?state=wrong&code=mock');
  expect(wrong.status).toBe(302);
  expect(wrong.headers.get('location')).toContain(
    '/settings/sns?instagram=failed',
  );
  const state = await connect();
  const reused = await req(
    '/api/instagram/oauth/callback?' +
      new URLSearchParams({ state, code: 'mock' }),
  );
  expect(reused.status).toBe(302);
  expect(reused.headers.get('location')).toContain(
    '/settings/sns?instagram=failed',
  );
  db.raw.exec("UPDATE instagram_connections SET expires_at='2000-01-01'");
  expect((await read(await req('/api/instagram/connection'))).data.state).toBe(
    'expired',
  );
  expect((await req('/api/instagram/sync', {})).status).toBe(409);
});
it('同時投稿の許可が無い古い接続は認可切れにして取り直させる', async () => {
  await connect();
  db.raw.exec(
    "UPDATE instagram_connections SET scopes='instagram_business_basic'",
  );
  expect((await read(await req('/api/instagram/connection'))).data.state).toBe(
    'expired',
  );
  // 期限内でも投稿できないので、更新ではなく接続のやり直しへ回す。
  expect((await req('/api/instagram/refresh', {})).status).toBe(409);
});
/** 折り返しを1回通し、画面へ戻すURLを読む。 */
async function callback(query: Record<string, string>) {
  const start = await read(await req('/api/instagram/oauth/start', {}));
  const state = new URL(start.data.url).searchParams.get('state')!;
  const res = await req(
    '/api/instagram/oauth/callback?' +
      new URLSearchParams({ state, ...query }),
  );
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}
it('投稿に使えるIDが返らなければ保存せず失敗を返す', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      // 投稿先の利用者IDが返らない＝プロアカウントになっていない状態。
      if (path.endsWith('/oauth/access_token'))
        return Response.json({
          data: [
            {
              access_token: 'short_mock',
              permissions:
                'instagram_business_basic,instagram_business_content_publish',
            },
          ],
        });
      // プロフィール側のIDも数字で返らない。
      if (path.endsWith('/me')) return Response.json({ username: 'test_ig' });
      return original(url, init);
    }),
  );
  const back = await callback({ code: 'mock_code' });
  // 画面が見る値は従来どおり failed だけ（帯の文言は変わらない）。
  expect(back.pathname).toBe('/settings/sns');
  expect(back.searchParams.get('instagram')).toBe('failed');
  // サーバー記録が読めない場合でも原因が分かるよう、戻り先URLに手がかりを添える。
  expect(back.searchParams.get('instagram_code')).toBe(
    'instagram_business_account_required',
  );
  expect(back.searchParams.get('instagram_scopes')).toContain(
    'instagram_business_content_publish',
  );
  expect(
    db.raw.prepare('SELECT COUNT(*) n FROM instagram_connections').get(),
  ).toEqual({ n: 0 });
  // 使い切りの state は捨てて、もう一度ログインからやり直せるようにする。
  expect(
    db.raw.prepare('SELECT COUNT(*) n FROM instagram_oauth_states').get(),
  ).toEqual({ n: 0 });
});
it('同時投稿の許可を外されたまま戻ってきたら保存しない', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      // 認可画面で同時投稿の許可だけ外された場合を模す。
      if (new URL(String(url)).pathname.endsWith('/oauth/access_token'))
        return Response.json({
          data: [
            {
              access_token: 'short_mock',
              user_id: '20',
              permissions: 'instagram_business_basic',
            },
          ],
        });
      return original(url, init);
    }),
  );
  const back = await callback({ code: 'mock_code' });
  expect(back.searchParams.get('instagram')).toBe('failed');
  expect(back.searchParams.get('instagram_code')).toBe(
    'instagram_publish_not_granted',
  );
  expect(back.searchParams.get('instagram_scopes')).toBe(
    'instagram_business_basic',
  );
  // 投稿できない合鍵は長期化もせず保存もしない。
  expect(
    db.raw.prepare('SELECT COUNT(*) n FROM instagram_connections').get(),
  ).toEqual({ n: 0 });
});
it('引き換えの失敗が素の形で返っても、種別と番号だけを手がかりに残す', async () => {
  const synthetic = 'ZZtest_only_not_a_secretZZ';
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      // 認可コードの引き換えの口だけは、Graph の入れ子ではなく素の形でエラーを返す。
      if (new URL(String(url)).pathname.endsWith('/oauth/access_token'))
        return Response.json(
          {
            error_type: 'OAuthException',
            code: 400,
            error_message: `secret=${synthetic}`,
          },
          { status: 400 },
        );
      return original(url, init);
    }),
  );
  const logged: string[] = [];
  const spy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  let back: URL;
  try {
    back = await callback({ code: 'mock_code' });
  } finally {
    spy.mockRestore();
  }
  expect(back.searchParams.get('instagram')).toBe('failed');
  expect(back.searchParams.get('instagram_code')).toBe('meta_request_failed');
  // 入れ子の形しか読めないと `status=400` だけが残り、原因が分からなくなる。
  expect(back.searchParams.get('instagram_detail')).toBe(
    'POST api/oauth/access_token status=400 type=OAuthException code=400',
  );
  // 上流の自由文（`error_message`）は記録にも戻り先URLにも出さない。
  const returned = `${back}\n${decodeURIComponent(String(back))}`;
  expect(logged.join('\n')).not.toContain(synthetic);
  expect(returned).not.toContain(synthetic);
});
it('許可名が一覧（配列）で返っても読み取り、接続できる', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      // 手引きの例はカンマ区切りの文字列だが、実際には一覧で返ることがある。
      if (new URL(String(url)).pathname.endsWith('/oauth/access_token'))
        return Response.json({
          data: [
            {
              access_token: 'short_mock',
              user_id: '20',
              permissions: [
                'instagram_business_basic',
                'instagram_business_content_publish',
              ],
            },
          ],
        });
      return original(url, init);
    }),
  );
  const back = await callback({ code: 'mock_code' });
  expect(back.searchParams.get('instagram')).toBe('connected');
  expect(
    db.raw.prepare('SELECT COUNT(*) n FROM instagram_connections').get(),
  ).toEqual({ n: 1 });
});
it('許可名がどこにも入っていなければ、許可済みとみなさず接続に失敗する', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      // 項目名が変わった・項目自体が無い場合。公式ドキュメント上、成功応答には
      // 許可名（permissions）が必ず入る前提なので、読めない＝応答の形が想定外とみなし、
      // 「要求した許可で接続済み」と推定しない（実際に許可されていない接続を通してしまうため）。
      if (new URL(String(url)).pathname.endsWith('/oauth/access_token'))
        return Response.json({
          data: [{ access_token: 'short_mock', user_id: '20' }],
        });
      return original(url, init);
    }),
  );
  const back = await callback({ code: 'mock_code' });
  expect(back.searchParams.get('instagram')).toBe('failed');
  expect(back.searchParams.get('instagram_code')).toBe(
    'instagram_publish_not_granted',
  );
  expect(
    db.raw.prepare('SELECT COUNT(*) n FROM instagram_connections').get(),
  ).toEqual({ n: 0 });
});
it('認可画面で断られたときはMetaへ問い合わせず、やり直しへ回す', async () => {
  const before = vi.mocked(fetch).mock.calls.length;
  const back = await callback({
    error: 'access_denied',
    error_reason: 'user_denied',
    error_description: 'The user denied your request',
  });
  expect(back.searchParams.get('instagram')).toBe('failed');
  expect(back.searchParams.get('instagram_code')).toBe(
    'instagram_login_denied',
  );
  // 断られた時点で打ち切る。Meta への問い合わせは1回も増えない。
  expect(vi.mocked(fetch).mock.calls).toHaveLength(before);
  // Instagram 側の説明文はそのまま外へ出さない。
  expect(back.search).not.toContain('denied your request');
  expect(
    db.raw.prepare('SELECT COUNT(*) n FROM instagram_oauth_states').get(),
  ).toEqual({ n: 0 });
});
it('戻り先URLの末尾に付く `#_` を落として認可コードを引き換える', async () => {
  // Instagram は成功時の戻り先に `#_` を足して返す。そのまま渡すと引き換えが失敗する。
  const back = await callback({ code: 'mock_code#_' });
  expect(back.searchParams.get('instagram')).toBe('connected');
  const exchange = vi
    .mocked(fetch)
    .mock.calls.find(([url]) =>
      String(url).includes('/oauth/access_token'),
    )![1] as RequestInit;
  expect((exchange.body as URLSearchParams).get('code')).toBe('mock_code');
});
async function signed(raw: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.META_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const h = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(raw),
  );
  return (
    'sha256=' +
    Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, '0')).join(
      '',
    )
  );
}
it('Webhookの確認・署名・宛先・重複を検査し、審査前の返信は送らない', async () => {
  await connect();
  const publicApp = app({ ...admin, role: 'staff', permissionKeys: [] });
  expect(
    (
      await publicApp.request(
        '/api/instagram/webhook?' +
          new URLSearchParams({
            'hub.mode': 'subscribe',
            'hub.verify_token': 'verify_mock',
            'hub.challenge': 'challenge',
          }),
      )
    ).status,
  ).toBe(200);
  const raw = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: '20',
        messaging: [
          {
            sender: { id: '30' },
            recipient: { id: '20' },
            timestamp: Date.now(),
            message: { mid: 'mid1', text: 'こんにちは' },
          },
          {
            sender: { id: '30' },
            recipient: { id: 'other' },
            timestamp: Date.now(),
            message: { mid: 'mid2', text: '別' },
          },
        ],
      },
    ],
  });
  const signature = await signed(raw);
  expect(
    await verifyInstagramSignature(
      raw + ' ',
      signature,
      config.META_APP_SECRET,
    ),
  ).toBe(false);
  expect(
    (
      await publicApp.request('/api/instagram/webhook', {
        method: 'POST',
        body: raw,
      })
    ).status,
  ).toBe(401);
  for (let i = 0; i < 2; i++)
    expect(
      (
        await publicApp.request('/api/instagram/webhook', {
          method: 'POST',
          headers: { 'X-Hub-Signature-256': signature },
          body: raw,
        })
      ).status,
    ).toBe(200);
  const messages = await read(await req('/api/instagram/messages'));
  expect(messages.data.total).toBe(1);
  const previous = vi.mocked(fetch).mock.calls.length;
  expect(
    (await req('/api/instagram/messages/mid1/reply', { text: '返信' })).status,
  ).toBe(403);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(previous);
  db.raw.exec("UPDATE instagram_messages SET created_at='2000-01-01'");
  await purgeInstagramTransientData(db.db);
  expect(
    db.raw.prepare('SELECT COUNT(*) n FROM instagram_messages').get(),
  ).toEqual({ n: 0 });
});

it('共有したInstagramのWebhookを同じ統括の各アカウントへ保存し、解除もそれぞれ独立する', async () => {
  db.raw.exec("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a3','3','3','','','t1')");
  await connect();
  await connectAccount('a3');
  const raw = JSON.stringify({ object: 'instagram', entry: [{ id: '20', messaging: [{
    sender: { id: '30' }, recipient: { id: '20' }, timestamp: Date.now(),
    message: { mid: 'shared-mid', text: '共通の受信' },
  }] }] });
  const response = await app().request('/api/instagram/webhook', {
    method: 'POST', body: raw,
    headers: { 'X-Hub-Signature-256': await signed(raw) },
  });
  expect(response.status).toBe(200);
  expect(db.raw.prepare('SELECT line_account_id FROM instagram_messages ORDER BY line_account_id').all()).toEqual([
    { line_account_id: 'a1' }, { line_account_id: 'a3' },
  ]);
  const disconnect = await app().request('/api/instagram/connection?lineAccountId=a3', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  expect(disconnect.status).toBe(200);
  expect(db.raw.prepare('SELECT line_account_id FROM instagram_connections').all()).toEqual([{ line_account_id: 'a1' }]);
  expect(db.raw.prepare('SELECT line_account_id FROM instagram_messages').all()).toEqual([{ line_account_id: 'a1' }]);
});

it('壊れた設定・署名済みの壊れた本文・期限切れのstateを外へ進めない', async () => {
  expect(
    instagramConfig({
      ...config,
      META_TOKEN_ENCRYPTION_KEY: 'broken',
    } as Env['Bindings']),
  ).toBe(null);
  for (const raw of [
    'null',
    '{',
    '{"object":"instagram","entry":[null,{"id":"20","messaging":{}}]}',
  ]) {
    const r = await app().request('/api/instagram/webhook', {
      method: 'POST',
      body: raw,
      headers: { 'X-Hub-Signature-256': await signed(raw) },
    });
    expect(r.status).toBe(raw === '{' ? 400 : 200);
  }
  // 期限切れの state では Meta へ一度も問い合わせず、画面へ失敗だけ返す。
  const start = await read(await req('/api/instagram/oauth/start', {})),
    state = new URL(start.data.url).searchParams.get('state')!;
  db.raw.exec("UPDATE instagram_oauth_states SET expires_at='2000-01-01'");
  const calls = vi.mocked(fetch).mock.calls.length;
  const expired = await req(
    '/api/instagram/oauth/callback?' +
      new URLSearchParams({ state, code: 'mock' }),
  );
  expect(expired.status).toBe(302);
  expect(expired.headers.get('location')).toContain('instagram=failed');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});

/**
 * Meta のエラー説明文（`error.message`）は Meta が書く自由な文章で、こちらが送った値
 * （合鍵・アプリシークレット・認可コード）がそのまま、あるいは URL エンコード・二重エンコード
 * など様々な形で混ざって返ることがある。表現の形を網羅して伏せ字にするやり方は新しい形が
 * 見つかるたびに後追いになるため、`message` 自体を記録に出さないようにした。
 * どんな形で秘密値が混ざっていても記録に一切残らないこと、原因調べに使う種別・番号
 * （`status` / `type` / `code` / `subcode`）は残ることを確かめる。
 */
it('Metaのエラー説明文は、秘密値がどんな形で混ざっていても一切サーバー記録に出さない', async () => {
  const longToken = 'EAAI9x+9ZaOp/ZBdBO1234567890ABCDEFG=';
  const doubleEncoded = encodeURIComponent(encodeURIComponent(longToken));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string) =>
      Response.json(
        {
          error: {
            type: 'OAuthException',
            code: 100,
            error_subcode: 33,
            // Meta がこちらの送った値を、そのまま・URLエンコード・二重エンコードと
            // 混在した形で返してきた最悪の場合を模す。
            message:
              `Invalid request: ${String(url)} ` +
              `client_secret=${config.INSTAGRAM_APP_SECRET} code=mock_code ` +
              `access_token=${longToken} ` +
              `access_token_encoded=${doubleEncoded}`,
          },
        },
        { status: 400 },
      ),
    ),
  );
  const logged: string[] = [];
  const spy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  let location = '';
  try {
    const start = await read(await req('/api/instagram/oauth/start', {})),
      state = new URL(start.data.url).searchParams.get('state')!;
    const callback = await req(
      '/api/instagram/oauth/callback?' +
        new URLSearchParams({ state, code: 'mock_code' }),
    );
    expect(callback.status).toBe(302);
    location = callback.headers.get('location') ?? '';
    expect(location).toContain('instagram=failed');
  } finally {
    spy.mockRestore();
  }
  const record = logged.find((line) =>
    line.includes('instagram_oauth_callback_failed'),
  );
  expect(record).toBeDefined();
  expect(JSON.parse(record!)).toEqual({ code: 'instagram_oauth_callback_failed', timestamp: expect.any(String), level: 'error', requestId: null, invocationId: null, source: 'background' });
  // 説明文（message）自体を記録に出さないため、どの表現も残らない。
  expect(record).not.toContain('message=');
  for (const secret of [
    config.INSTAGRAM_APP_SECRET,
    config.META_APP_SECRET,
    'mock_code',
    longToken,
    encodeURIComponent(longToken),
    doubleEncoded,
    config.META_TOKEN_ENCRYPTION_KEY,
  ])
    expect(logged.join('\n')).not.toContain(secret);
  // 戻り先URLにも同じ手がかりを添えるので、そこにも秘密値が移らないことを確かめる。
  // URLは値をエンコードして持つため、元に戻した形でも照合する。
  const returned = `${location}\n${decodeURIComponent(location)}`;
  expect(location).toContain('instagram_detail=');
  for (const secret of [
    config.INSTAGRAM_APP_SECRET,
    config.META_APP_SECRET,
    'mock_code',
    longToken,
    encodeURIComponent(longToken),
    doubleEncoded,
    config.META_TOKEN_ENCRYPTION_KEY,
  ])
    expect(returned).not.toContain(secret);
});

/**
 * 戻り先URLは利用者に見える場所なので、Meta の応答から来る値をそのまま置かない。
 * Meta は応答の中身（`error.type` や引き換え応答の権限名）を自由に決められるため、
 * 「自由文ではない項目」という理由だけでは守れない。ここでは**英小文字32文字**という、
 * 合鍵のような見た目でありながら名前の形としては通ってしまう試験用の値を混ぜて、
 * 形での見分けではなく**許可一覧**が効いていることを確かめる。実在する秘密値は使わない。
 */
it('模擬応答の種別名・権限名に秘密値のような値が混ざっても、記録と戻り先URLのどちらにも出さない', async () => {
  // 実在しない試験用の値。英小文字だけなので「ありそうな名前の形」には当てはまる。
  const synthetic = 'abcdefabcdefabcdefabcdefabcdefab';
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      // 許可された権限の名前に試験用の値が混ざった場合を模す。
      if (path.endsWith('/oauth/access_token'))
        return Response.json({
          data: [
            {
              access_token: 'short_mock',
              user_id: '20',
              permissions: `instagram_business_basic,${synthetic},instagram_business_content_publish`,
            },
          ],
        });
      // 種別名・番号に試験用の値が混ざった場合を模す（番号は整数ですらない）。
      if (path.endsWith('/access_token'))
        return Response.json(
          {
            error: {
              type: synthetic,
              code: `100${synthetic}`,
              error_subcode: synthetic,
              message: `secret=${synthetic}`,
            },
          },
          { status: 400 },
        );
      return original(url, init);
    }),
  );
  const logged: string[] = [];
  const spy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  let location = '';
  try {
    const start = await read(await req('/api/instagram/oauth/start', {})),
      state = new URL(start.data.url).searchParams.get('state')!;
    const callback = await req(
      '/api/instagram/oauth/callback?' +
        new URLSearchParams({ state, code: 'mock_code' }),
    );
    expect(callback.status).toBe(302);
    location = callback.headers.get('location') ?? '';
  } finally {
    spy.mockRestore();
  }
  const back = new URL(location);
  expect(back.searchParams.get('instagram')).toBe('failed');
  // 失敗の種類名はこちらが決めた固定の文言。
  expect(back.searchParams.get('instagram_code')).toBe('meta_request_failed');
  // 許可一覧に無い種別名は中身を出さず `other` に置き換える。検査を通らない番号は落とす。
  expect(back.searchParams.get('instagram_detail')).toBe(
    'GET graph/access_token status=400 type=other',
  );
  // 許可一覧に無い権限名も中身を出さず、件数だけを添える。
  expect(back.searchParams.get('instagram_scopes')).toBe(
    'instagram_business_basic,instagram_business_content_publish,other1',
  );
  // 記録と戻り先URL（元に戻した形も）のどちらにも試験用の値は出ない。
  const returned = `${location}\n${decodeURIComponent(location)}`;
  expect(logged.join('\n')).not.toContain(synthetic);
  expect(returned).not.toContain(synthetic);
  // 絞り込みは境目でも二重に効く。仮に手がかりへ自由文が入り込んでも通さない。
  expect(
    instagramUrlDetail(
      `GET graph/access_token status=400 type=${synthetic} code=${synthetic}`,
    ),
  ).toBe('GET graph/access_token status=400 type=other');
  expect(instagramUrlScopes(`instagram_business_basic,${synthetic}`)).toBe(
    'instagram_business_basic,other1',
  );
});

/**
 * Meta から応答が返らなかった場合。これまでは `meta_unavailable` だけで、
 * **どの要求で止まったのか**も**時間切れなのか接続不可なのか**も分からなかった。
 * 要求の宛先と呼び名を残す（呼び名は許可一覧のみ。自由文の `message` は読まない）。
 */
it.each([
  // 時間切れ（Meta が遅い／通信が出られない）
  ['TimeoutError', 'TimeoutError'],
  // つなげなかった（名前が引けない・接続できない・許していない転送）
  ['TypeError', 'TypeError'],
  // 許可一覧に無い呼び名は中身を出さない
  ['abcdefabcdefabcdefabcdefabcdefab', 'other'],
])(
  '折り返しの最初の要求で応答が返らないとき、どの要求で止まったかと呼び名（%s）を戻り先URLへ残す',
  async (thrownName, expected) => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (new URL(String(url)).pathname.endsWith('/oauth/access_token')) {
          // 応答を返さず投げる。自由文には秘密値のような値を入れておく。
          const e = new Error(`secret=${thrownName}`);
          e.name = thrownName;
          throw e;
        }
        return original(url, init);
      }),
    );
    const logged: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    let location = '';
    try {
      const start = await read(await req('/api/instagram/oauth/start', {})),
        state = new URL(start.data.url).searchParams.get('state')!;
      const callback = await req(
        '/api/instagram/oauth/callback?' +
          new URLSearchParams({ state, code: 'mock_code' }),
      );
      expect(callback.status).toBe(302);
      location = callback.headers.get('location') ?? '';
    } finally {
      spy.mockRestore();
    }
    const back = new URL(location);
    expect(back.searchParams.get('instagram')).toBe('failed');
    expect(back.searchParams.get('instagram_code')).toBe('meta_unavailable');
    expect(back.searchParams.get('instagram_detail')).toBe(
      `POST api/oauth/access_token fetch=${expected}`,
    );
    // 自由文（`message`）は記録にも戻り先URLにも出さない。
    const returned = `${location}\n${decodeURIComponent(location)}`;
    expect(logged.join('\n')).not.toContain('secret=');
    expect(returned).not.toContain('secret');
    // 境目でも同じ許可一覧で絞り直す。
    expect(
      instagramUrlDetail(
        'POST api/oauth/access_token fetch=abcdefabcdefabcdefabcdefabcdefab',
      ),
    ).toBe('POST api/oauth/access_token fetch=other');
  },
);

/**
 * Workers の実行環境は転送の扱いに `follow` と `manual` しか受け付けず、`error` を渡すと
 * **通信する前に** TypeError で弾かれる（転送が起きたかに関係ない）。
 * 試験のここでの `fetch` は実行環境の検査をしないため、指定そのものを確かめる。
 */
it('Metaへの要求は転送の扱いに manual を指定する（error は実行環境が受け付けない）', async () => {
  await connect();
  const redirects = vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => (init as RequestInit | undefined)?.redirect);
  expect(redirects.length).toBeGreaterThan(0);
  expect(redirects).not.toContain('error');
  expect(new Set(redirects)).toEqual(new Set(['manual']));
});

/**
 * 転送は追わない。追えば合鍵・アプリシークレット・認可コードを Meta 以外の宛先へ
 * 渡してしまう。転送先（`Location`）は戻り先URLにも記録にも出さず、状態番号だけ残す。
 */
it('転送応答は失敗にし、転送先URLは戻り先URLと記録へ出さない', async () => {
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      if (new URL(String(url)).pathname.endsWith('/oauth/access_token'))
        return new Response(null, {
          status: 302,
          // 転送先に秘密値のような値を入れておく。
          headers: { location: 'https://example.invalid/x?secret=abcdef' },
        });
      return original(url, init);
    }),
  );
  const logged: string[] = [];
  const spy = vi
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  let location = '';
  try {
    const start = await read(await req('/api/instagram/oauth/start', {})),
      state = new URL(start.data.url).searchParams.get('state')!;
    const callback = await req(
      '/api/instagram/oauth/callback?' +
        new URLSearchParams({ state, code: 'mock_code' }),
    );
    expect(callback.status).toBe(302);
    location = callback.headers.get('location') ?? '';
  } finally {
    spy.mockRestore();
  }
  const back = new URL(location);
  expect(back.searchParams.get('instagram')).toBe('failed');
  expect(back.searchParams.get('instagram_code')).toBe('meta_request_failed');
  expect(back.searchParams.get('instagram_detail')).toBe(
    'POST api/oauth/access_token redirect=302',
  );
  const returned = `${location}\n${decodeURIComponent(location)}`;
  expect(`${returned}\n${logged.join('\n')}`).not.toContain('example.invalid');
  expect(`${returned}\n${logged.join('\n')}`).not.toContain('secret');
  // 境目でも状態番号だけに絞り直す。
  expect(
    instagramUrlDetail(
      'POST api/oauth/access_token redirect=302 location=https://example.invalid/x',
    ),
  ).toBe('POST api/oauth/access_token redirect=302');
});

it('写真DMと受信時刻の順、別アカウントのカーソルを守る', async () => {
  await connect();
  const messages = [
    { mid: 'z-old', text: '古い' },
    {
      mid: 'a-new',
      attachments: [
        {
          type: 'image',
          payload: { url: 'https://cdn.example.test/photo.jpg' },
        },
        { type: 'image', payload: { url: 'javascript:alert(1)' } },
      ],
    },
  ];
  const raw = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: '20',
        messaging: messages.map((message, i) => ({
          sender: { id: '30' },
          recipient: { id: '20' },
          timestamp: Date.now() + i,
          message,
        })),
      },
    ],
  });
  expect(
    (
      await app().request('/api/instagram/webhook', {
        method: 'POST',
        body: raw,
        headers: { 'X-Hub-Signature-256': await signed(raw) },
      })
    ).status,
  ).toBe(200);
  const res = await req('/api/instagram/messages?limit=1');
  const result = (await res.json()) as {
    data: {
      messages: Array<{
        id: string;
        attachments: Array<{ url: string | null }>;
      }>;
    };
  };
  expect(result.data.messages[0]).toMatchObject({
    id: 'a-new',
    attachments: [{ url: 'https://cdn.example.test/photo.jpg' }, { url: null }],
  });
  expect(
    (await read(await req('/api/instagram/messages?beforeId=a-new'))).data
      .messages,
  ).toMatchObject([{ id: 'z-old' }]);
  expect((await req('/api/instagram/messages?beforeId=foreign')).status).toBe(
    404,
  );
});

/*
 * ここから下は「同じLINEアカウントに接続が2件あるとき」の決めごと（受入条件4）。
 * 772 で1つのLINEアカウントに複数の接続を持てるようにしたので、書き換えの口が
 * 既定の1件（並び順の先頭）へ落ちると、2件目を押したのに先頭を消す・繋ぎ直す取り違えになる。
 */

/**
 * いまの接続をそのまま写して2件目を作る。合鍵はそのまま使えるので、
 * つなぎ直し・確認・解除がどちらの行を触ったかだけを見られる。
 * 並び順を後ろにして「既定の1件」にはならないようにする。
 */
function addSecondConnection() {
  db.raw
    .prepare(
      `INSERT INTO instagram_connections
         (id,line_account_id,page_id,instagram_id,page_name,username,page_token_encrypted,user_token_encrypted,
          expires_at,data_access_expires_at,profile_json,posts_json,refreshed_at,synced_at,connected_by,version,scopes,sort_order)
       SELECT 'igc-2',line_account_id,'21','21',page_name,'nen_cafe_2',page_token_encrypted,user_token_encrypted,
              expires_at,data_access_expires_at,profile_json,posts_json,refreshed_at,synced_at,connected_by,7,scopes,1
         FROM instagram_connections WHERE line_account_id='a1' ORDER BY sort_order, id LIMIT 1`,
    )
    .run();
  const first = db.raw
    .prepare("SELECT id,version FROM instagram_connections WHERE id<>'igc-2'")
    .get() as { id: string; version: number };
  return first;
}

it('接続が2件あるとき、解除は接続IDの指定が無ければ断る（先頭を消さない）', async () => {
  await connect();
  const first = addSecondConnection();

  const res = await req(
    '/api/instagram/connection',
    { expectedVersion: first.version },
    'DELETE',
  );
  expect(res.status).toBe(400);
  expect(await res.text()).toContain('connection_required');
  // 2件とも残る。版の指定が先頭と一致していても消さない。
  expect(
    db.raw.prepare('SELECT COUNT(*) n FROM instagram_connections').get(),
  ).toEqual({ n: 2 });
});

it('接続が2件あるとき、解除は指定した接続だけを消す', async () => {
  await connect();
  const first = addSecondConnection();

  // 2件目の版は7。先頭の版を渡しても消えない。
  expect(
    (
      await req(
        '/api/instagram/connection?connectionId=igc-2',
        { expectedVersion: first.version },
        'DELETE',
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await req(
        '/api/instagram/connection?connectionId=igc-2',
        { expectedVersion: 7 },
        'DELETE',
      )
    ).status,
  ).toBe(200);
  expect(
    db.raw.prepare('SELECT id FROM instagram_connections').all(),
  ).toEqual([{ id: first.id }]);
});

it('接続が2件あるとき、接続確認は指定した接続だけを更新する', async () => {
  await connect();
  const first = addSecondConnection();

  // 指定が無ければ断る（先頭の合鍵を勝手に延ばさない）。
  const vague = await req('/api/instagram/refresh', {});
  expect(vague.status).toBe(400);
  expect(await vague.text()).toContain('connection_required');

  // 2件目は別のInstagramアカウント。接続確認は `/me` の正確なIDへ直すので、
  // ここだけ2件目の相手（21）を返させる。先頭（20）と同じIDにはなり得ない。
  const upstream = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL | string, init?: RequestInit) =>
      new URL(String(url)).pathname.endsWith('/me')
        ? Response.json({ id: '21', username: 'nen_cafe_2' })
        : upstream(url as RequestInfo, init),
    ),
  );

  expect((await req('/api/instagram/refresh?connectionId=igc-2', {})).status).toBe(200);
  // 版が上がるのは2件目だけ。先頭は触らない。
  expect(
    db.raw.prepare('SELECT id,version FROM instagram_connections ORDER BY id').all(),
  ).toEqual([{ id: 'igc-2', version: 8 }, { id: first.id, version: first.version }]);
});

it('接続が2件あるとき、つなぎ直しは指定した接続を宛先として預ける', async () => {
  await connect();
  addSecondConnection();
  db.raw.prepare('DELETE FROM instagram_oauth_states').run();

  // 指定が無ければ断る（どちらを繋ぎ直すのか決まらない）。
  const vague = await req('/api/instagram/oauth/start', {});
  expect(vague.status).toBe(400);
  expect(await vague.text()).toContain('connection_required');

  expect(
    (await req('/api/instagram/oauth/start?connectionId=igc-2', {})).status,
  ).toBe(200);
  expect(
    db.raw.prepare('SELECT connection_id FROM instagram_oauth_states').all(),
  ).toEqual([{ connection_id: 'igc-2' }]);
});

it('接続を増やすときは宛先を持たず、接続IDの同時指定は断る', async () => {
  await connect();
  addSecondConnection();
  db.raw.prepare('DELETE FROM instagram_oauth_states').run();

  // 「増やす」と「この接続を繋ぎ直す」は両立しない。
  const both = await req('/api/instagram/oauth/start?mode=add&connectionId=igc-2', {});
  expect(both.status).toBe(400);
  expect(await both.text()).toContain('connection_target_conflict');

  expect((await req('/api/instagram/oauth/start?mode=add', {})).status).toBe(200);
  // 増やす途中なので、まだどの接続にも結び付かない。
  expect(
    db.raw.prepare('SELECT connection_id FROM instagram_oauth_states').all(),
  ).toEqual([{ connection_id: null }]);
});

it.each([1, 2])('既存接続が%i件あっても、追加の認可完了では既存行を変えず別の接続を保存する', async (existingCount) => {
  await connect();
  db.raw.prepare('UPDATE instagram_connections SET sort_order=7').run();
  if (existingCount === 2) addSecondConnection();
  const existing = db.raw.prepare('SELECT * FROM instagram_connections ORDER BY id').all();
  const existingOrder = db.raw.prepare('SELECT instagram_id FROM instagram_connections ORDER BY sort_order,id').all();
  const upstream = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init?: RequestInit) =>
    new URL(String(url)).pathname.endsWith('/me')
      ? Response.json({ id: '22', username: 'another_cafe' })
      : upstream(url as RequestInfo, init),
  ));

  const start = await read(await req('/api/instagram/oauth/start?mode=add', {}));
  const state = new URL(start.data.url).searchParams.get('state')!;
  const response = await req('/api/instagram/oauth/callback?' + new URLSearchParams({ state, code: 'mock_code' }));
  const back = new URL(response.headers.get('location')!);
  expect(back.searchParams.get('instagram')).toBe('connected');
  expect(db.raw.prepare("SELECT * FROM instagram_connections WHERE instagram_id<>'22' ORDER BY id").all()).toEqual(existing);
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM instagram_connections').get()).toEqual({ count: existingCount + 1 });
  expect(db.raw.prepare('SELECT instagram_id FROM instagram_connections ORDER BY sort_order,id').all()).toEqual([
    ...existingOrder, { instagram_id: '22' },
  ]);
  expect(db.raw.prepare("SELECT instagram_id,username,version FROM instagram_connections WHERE instagram_id='22'").get()).toEqual({
    instagram_id: '22', username: 'another_cafe', version: 1,
  });
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM instagram_oauth_states').get()).toEqual({ count: 0 });
});

it('追加で同じInstagramを認可しても、既存接続を上書きせず重複として返す', async () => {
  await connect();
  const existing = db.raw.prepare('SELECT * FROM instagram_connections').all();
  const start = await read(await req('/api/instagram/oauth/start?mode=add', {}));
  const state = new URL(start.data.url).searchParams.get('state')!;
  const response = await req('/api/instagram/oauth/callback?' + new URLSearchParams({ state, code: 'mock_code' }));
  const back = new URL(response.headers.get('location')!);
  expect(back.searchParams.get('instagram')).toBe('failed');
  expect(back.searchParams.get('instagram_code')).toBe('instagram_account_already_connected');
  expect(db.raw.prepare('SELECT * FROM instagram_connections').all()).toEqual(existing);
  expect(db.raw.prepare('SELECT COUNT(*) AS count FROM instagram_oauth_states').get()).toEqual({ count: 0 });
});

it('別のLINEアカウントの接続IDを渡しても見つからない扱いにする', async () => {
  await connect();
  addSecondConnection();
  // a2（別の統括）の接続としてもう1件作る。
  db.raw
    .prepare(
      `INSERT INTO instagram_connections
         (id,line_account_id,page_id,instagram_id,page_name,username,page_token_encrypted,user_token_encrypted,
          expires_at,data_access_expires_at,refreshed_at,connected_by,version,scopes,sort_order)
       SELECT 'igc-other','a2','99','99',page_name,'other',page_token_encrypted,user_token_encrypted,
              expires_at,data_access_expires_at,refreshed_at,connected_by,1,scopes,0
         FROM instagram_connections WHERE id='igc-2'`,
    )
    .run();

  // 読み取りは行が無い扱い、書き換えは 404。どちらも他の統括の行を触らない。
  expect(
    (await read(await req('/api/instagram/connection?connectionId=igc-other')))
      .data.state,
  ).toBe('disconnected');
  expect(
    (await req('/api/instagram/refresh?connectionId=igc-other', {})).status,
  ).toBe(404);
  expect(
    db.raw.prepare("SELECT version FROM instagram_connections WHERE id='igc-other'").get(),
  ).toEqual({ version: 1 });
});
