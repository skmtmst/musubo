import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { authMiddleware } from '../middleware/auth.js';

/**
 *   の受け入れ試験。
 *
 * - 実SQLite: packages/db/bootstrap.sql からそのまま作る。手書きの写しにすると
 *   列ズレで route が別理由で落ち、ガードの有無と区別がつかなくなる。
 * - 実route: 本物の richMenuGroups ハンドラを通す。
 * - 実auth: authMiddleware → getStaffByApiKey(実DB) → requireRole →
 *   canAccessAllLineAccounts(実DB) を通す。権限判定は差し替えない。
 * - 差し替えるのは LINE への fetch と R2 だけ(外部副作用)。
 *
 * 逆変異の担保: 各ガードを実装から外すと対応する試験が赤になる。
 */
const { richMenuGroups } = await import('./rich-menu-groups.js');

const BOOTSTRAP_SQL = readFileSync(
  join(import.meta.dirname, '../../../../packages/db/bootstrap.sql'),
  'utf8',
);

const OWNER_KEY = 'test-owner-key';
const SCOPED_ADMIN_KEY = 'test-scoped-admin-key';

function setupSqlite() {
  const sqlite = new Database(':memory:');
  sqlite.exec(BOOTSTRAP_SQL);
  // 対象の権限検査まで到達させるため、MFA は明示的に無効の fixture とする。
  sqlite.exec("INSERT OR REPLACE INTO platform_settings(key,value) SELECT 'auth.mfa.required:'||id,'false' FROM tenants");
  sqlite.prepare(
    `INSERT INTO line_accounts (id, name, channel_id, channel_access_token, channel_secret)
     VALUES ('acc-1', 'アカウント', 'ch-1', 'token', 'secret'),
            ('acc-other', '別アカウント', 'ch-2', 'token2', 'secret2')`,
  ).run();
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, is_active)
     VALUES ('st-owner', 'オーナー', 'owner', ?, 1),
            ('st-scoped', '限定管理者', 'admin', ?, 1)`,
  ).run(OWNER_KEY, SCOPED_ADMIN_KEY);
  // 限定管理者は acc-other だけ見える。acc-1 は越境扱いになる。
  sqlite.prepare(`UPDATE staff_members SET account_scope = 'accounts' WHERE id = 'st-scoped'`).run();
  sqlite.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('st-scoped', 'acc-other', '2026-01-01T00:00:00.000')`,
  ).run();
  return sqlite;
}

function asD1(sqlite: Database.Database): D1Database {
  return {
    prepare(query: string) {
      const build = (...params: unknown[]) => {
        const stmt = sqlite.prepare(query);
        return {
          async run() {
            const info = stmt.run(...params);
            return { success: true, meta: { changes: info.changes } };
          },
          async first<T>() {
            return (stmt.reader ? (stmt.get(...params) as T) : null) ?? null;
          },
          async all<T>() {
            return { results: stmt.all(...params) as T[], success: true, meta: {} };
          },
        };
      };
      return {
        bind: (...params: unknown[]) => build(...params),
        run: () => build().run(),
        first: <T,>() => build().first<T>(),
        all: <T,>() => build().all<T>(),
      };
    },
    batch: async (stmts: unknown[]) => {
      const results = [];
      for (const stmt of stmts as Array<{ run: () => Promise<unknown> }>) results.push(await stmt.run());
      return results;
    },
  } as unknown as D1Database;
}

function makeR2Stub() {
  const store = new Map<string, Uint8Array>();
  const bucket = {
    store,
    async put(key: string, value: Uint8Array) {
      store.set(key, value);
      return {};
    },
    async get(key: string) {
      const body = store.get(key);
      return body ? { body, httpMetadata: {} } : null;
    },
  };
  return bucket as unknown as R2Bucket & { store: Map<string, Uint8Array> };
}

function setupApp(db: D1Database, r2: R2Bucket) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.env = { DB: db, IMAGES: r2 } as never;
    await next();
  });
  app.use('*', authMiddleware as never);
  app.route('/', richMenuGroups);
  return app;
}

function authed(path: string, init: RequestInit = {}, key: string | null = OWNER_KEY) {
  const headers = new Headers(init.headers);
  if (key) headers.set('Authorization', `Bearer ${key}`);
  return { path, init: { ...init, headers } };
}

let sqlite: Database.Database;
let db: D1Database;
let r2: ReturnType<typeof makeR2Stub>;
let lineFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sqlite = setupSqlite();
  db = asD1(sqlite);
  r2 = makeR2Stub();
  // LINE への呼び出しは全部成功したことにする。createRichMenu だけ ID を返す。
  lineFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://api.line.me/v2/bot/richmenu') {
      return new Response(JSON.stringify({ richMenuId: 'rm-new-1' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', lineFetch);
});

function insertGroup(id: string, status: 'draft' | 'published') {
  sqlite.prepare(
    `INSERT INTO rich_menu_groups (id, account_id, name, status, size, chat_bar_text, is_default_for_all)
     VALUES (?, 'acc-1', 'メニュー', ?, 'large', 'menu', 0)`,
  ).run(id, status);
}

function insertPage(groupId: string, id: string, orderIndex: number, withImage = false) {
  sqlite.prepare(
    `INSERT INTO rich_menu_pages (id, group_id, order_index, name, alias_id, image_r2_key, image_content_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    groupId,
    orderIndex,
    `ページ${orderIndex + 1}`,
    `lhx-${groupId}-${orderIndex}`,
    withImage ? `img/${id}.png` : null,
    withImage ? 'image/png' : null,
  );
  if (withImage) r2.store.set(`img/${id}.png`, new Uint8Array([1, 2, 3]));
}

function insertArea(
  pageId: string,
  id: string,
  opts: {
    actionType?: string;
    actionData?: Record<string, unknown>;
    intent?: string | null;
    label?: string | null;
  } = {},
) {
  sqlite.prepare(
    `INSERT INTO rich_menu_areas
       (id, page_id, bounds_x, bounds_y, bounds_width, bounds_height, action_type, action_data, intent, label)
     VALUES (?, ?, 0, 0, 100, 100, ?, ?, ?, ?)`,
  ).run(
    id,
    pageId,
    opts.actionType ?? 'uri',
    JSON.stringify(opts.actionData ?? { uri: 'https://example.com' }),
    opts.intent ?? null,
    opts.label === undefined ? 'リンクを開く' : opts.label,
  );
}

function groupStatus(id: string): string {
  return (sqlite.prepare(`SELECT status AS s FROM rich_menu_groups WHERE id = ?`).get(id) as { s: string }).s;
}

function areaCount(groupId: string): number {
  return (sqlite.prepare(
    `SELECT COUNT(*) AS n FROM rich_menu_areas a
       JOIN rich_menu_pages p ON p.id = a.page_id WHERE p.group_id = ?`,
  ).get(groupId) as { n: number }).n;
}

const PNG_2500x1686 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x09, 0xc4, 0x00, 0x00, 0x06, 0x96,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const VALID_AREA = {
  boundsX: 0, boundsY: 0, boundsWidth: 100, boundsHeight: 100,
  actionType: 'uri', actionData: { uri: 'https://example.com' }, label: 'リンクを開く',
};

// ---------------------------------------------------------------------------
// 公開中定義の直接上書きを更新口で拒否する
// ---------------------------------------------------------------------------

describe('N-158: 公開中グループへの定義上書き拒否 (PATCH)', () => {
  test('公開中に pages を送ると 409 で、定義は変わらない', async () => {
    insertGroup('g1', 'published');
    insertPage('g1', 'p1', 0);
    insertArea('p1', 'a1');

    const { path, init } = authed('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, pages: [{ name: 'p1', orderIndex: 0, areas: [VALID_AREA] }] }),
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(409);
    expect(areaCount('g1')).toBe(1); // 上書きされていない
    expect(groupStatus('g1')).toBe('published');
  });

  test('公開中に chatBarText だけでも 409 (LINEに出る文言なので定義の一部)', async () => {
    insertGroup('g1', 'published');
    insertPage('g1', 'p1', 0);

    const { path, init } = authed('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, chatBarText: 'かえたい' }),
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(409);
    const row = sqlite.prepare(`SELECT chat_bar_text AS t FROM rich_menu_groups WHERE id = 'g1'`).get() as { t: string };
    expect(row.t).toBe('menu');
  });

  test('公開中に isDefaultForAll だけでも 409', async () => {
    insertGroup('g1', 'published');
    insertPage('g1', 'p1', 0);

    const { path, init } = authed('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, isDefaultForAll: true }),
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(409);
  });

  test('公開中でも名前・出し分け条件など管理側の情報は従来どおり更新できる', async () => {
    insertGroup('g1', 'published');
    insertPage('g1', 'p1', 0);

    const { path, init } = authed('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, name: '新しい名前', targetingPriority: 5 }),
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(200);
    const row = sqlite.prepare(`SELECT name AS n FROM rich_menu_groups WHERE id = 'g1'`).get() as { n: string };
    expect(row.n).toBe('新しい名前');
  });

  test('下書きへの pages 更新は従来どおり通る', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0);

    const { path, init } = authed('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, pages: [{ name: 'p1', orderIndex: 0, areas: [VALID_AREA, { ...VALID_AREA, boundsY: 100 }] }] }),
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(200);
    expect(areaCount('g1')).toBe(2);
  });
});

describe('N-158: 公開中グループへの画像差し替え拒否', () => {
  test('公開中ページへの画像アップロードは 409 で R2 にも書かない', async () => {
    insertGroup('g1', 'published');
    insertPage('g1', 'p1', 0);

    const { path, init } = authed('/api/rich-menu-groups/g1/pages/p1/image', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: PNG_2500x1686,
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(409);
    expect(r2.store.size).toBe(0); // R2 への副作用なし
    const row = sqlite.prepare(`SELECT image_r2_key AS k FROM rich_menu_pages WHERE id = 'p1'`).get() as { k: string | null };
    expect(row.k).toBeNull();
  });

  test('下書きページへの画像アップロードは従来どおり通る', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0);

    const { path, init } = authed('/api/rich-menu-groups/g1/pages/p1/image', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: PNG_2500x1686,
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(200);
    expect(r2.store.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 到達可能な行き先が1つも無い定義の公開を拒否する
// ---------------------------------------------------------------------------

describe('N-159: 有効な行き先ゼロの公開拒否', () => {
  test('エリアが1つも無いグループは公開を拒否し、LINE を呼ばない', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0, true);

    const { path, init } = authed('/api/rich-menu-groups/g1/publish', {
      method: 'POST', headers: { 'Idempotency-Key': 'mixed-switch-destination-0001' },
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled(); // LINE 側の副作用なし
    expect(groupStatus('g1')).toBe('draft');
  });

  test('ページ切替だけのグループは、自分自身を回るだけなので公開を拒否する', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0, true);
    insertPage('g1', 'p2', 1, true);
    insertArea('p1', 'a1', {
      actionType: 'richmenuswitch',
      actionData: { targetPageId: 'p2' },
      intent: 'switch',
      label: '次のページ',
    });
    insertArea('p2', 'a2', {
      actionType: 'richmenuswitch',
      actionData: { targetPageId: 'p1' },
      intent: 'switch',
      label: '前のページ',
    });

    const { path, init } = authed('/api/rich-menu-groups/g1/publish', {
      method: 'POST', headers: { 'Idempotency-Key': 'label-boundary-20chars-0001' },
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled();
    expect(groupStatus('g1')).toBe('draft');
  });

  test('存在しないページへの切替だけのグループも拒否する', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0, true);
    insertArea('p1', 'a1', {
      actionType: 'richmenuswitch',
      actionData: { targetPageId: 'missing-page' },
      intent: 'switch',
      label: 'どこかへ',
    });

    const { path, init } = authed('/api/rich-menu-groups/g1/publish', {
      method: 'POST', headers: { 'Idempotency-Key': 'mixed-switch-destination-0001' },
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled();
    expect(groupStatus('g1')).toBe('draft');
  });

  test('切替ボタンと行き先ボタンが混在していれば公開できる', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0, true);
    insertPage('g1', 'p2', 1, true);
    insertArea('p1', 'a1', {
      actionType: 'richmenuswitch',
      actionData: { targetPageId: 'p2' },
      intent: 'switch',
      label: '2ページ目へ',
    });
    insertArea('p2', 'a2', { label: 'サイトを開く' });

    // 実機で見た確認が無いと公開できない門番。先に押してから公開する。
    const app = setupApp(db, r2);
    const confirm = authed('/api/rich-menu-groups/g1/device-confirm', { method: 'POST' });
    const confirmRes = await app.request(confirm.path, confirm.init);
    expect(confirmRes.status).toBe(200);

    const { path, init } = authed('/api/rich-menu-groups/g1/publish', {
      method: 'POST', headers: { 'Idempotency-Key': 'label-boundary-20chars-0001' },
    });
    const res = await app.request(path, init);

    expect(res.status).toBe(200);
    expect(groupStatus('g1')).toBe('published');
    const page = sqlite.prepare(`SELECT line_richmenu_id AS v FROM rich_menu_pages WHERE id = 'p1'`).get() as { v: string | null };
    expect(page.v).toBe('rm-new-1');
  });
});

// ---------------------------------------------------------------------------
// 読み上げラベル必須・20文字以下をサーバー側で保証する
// ---------------------------------------------------------------------------

describe('N-155: 読み上げラベルの必須化と20字上限', () => {
  test('ラベル無しのボタンを含むグループは公開できない', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0, true);
    insertArea('p1', 'a1', { label: null });

    const { path, init } = authed('/api/rich-menu-groups/g1/publish', {
      method: 'POST', headers: { 'Idempotency-Key': 'label-boundary-20chars-0001' },
    });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled();
    expect(groupStatus('g1')).toBe('draft');
  });

  test('空白だけのラベルも公開できない', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0, true);
    insertArea('p1', 'a1', { label: '   ' });

    const { path, init } = authed('/api/rich-menu-groups/g1/publish', { method: 'POST' });
    const res = await setupApp(db, r2).request(path, init);

    expect(res.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled();
  });

  test('21文字のラベルは保存口でも公開口でも拒否する', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0, true);

    // 保存口 (PATCH): 21字は書き込めない
    const label21 = 'あ'.repeat(21);
    const patch = authed('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pages: [{ name: 'p1', orderIndex: 0, areas: [{ ...VALID_AREA, label: label21 }] }],
      }),
    });
    const patchRes = await setupApp(db, r2).request(patch.path, patch.init);
    expect(patchRes.status).toBe(400);
    expect(areaCount('g1')).toBe(0);

    // 公開口: DB に直接入った 21字ラベルも弾く (既存行の防御)
    insertArea('p1', 'a1', { label: label21 });
    const pub = authed('/api/rich-menu-groups/g1/publish', { method: 'POST' });
    const pubRes = await setupApp(db, r2).request(pub.path, pub.init);
    expect(pubRes.status).toBe(400);
    expect(lineFetch).not.toHaveBeenCalled();
  });

  test('ちょうど20文字のラベルは公開できる (境界値)', async () => {
    insertGroup('g1', 'draft');
    insertPage('g1', 'p1', 0, true);
    insertArea('p1', 'a1', { label: 'あ'.repeat(20) });

    // 実機で見た確認を先に済ませる。
    const app = setupApp(db, r2);
    const confirm = authed('/api/rich-menu-groups/g1/device-confirm', { method: 'POST' });
    expect((await app.request(confirm.path, confirm.init)).status).toBe(200);

    const { path, init } = authed('/api/rich-menu-groups/g1/publish', {
      method: 'POST', headers: { 'Idempotency-Key': 'label-boundary-20chars-0001' },
    });
    const res = await app.request(path, init);

    expect(res.status).toBe(200);
    expect(groupStatus('g1')).toBe('published');
  });
});

// ---------------------------------------------------------------------------
// 実authの確認: 上記のガードは実の認証・認可を通った先にある
// ---------------------------------------------------------------------------

describe('実auth: 認証・認可の境界', () => {
  test('認証無しは 401', async () => {
    insertGroup('g1', 'draft');
    const res = await setupApp(db, r2).request('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  test('存在しない API キーは 401', async () => {
    insertGroup('g1', 'draft');
    const { path, init } = authed('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    }, 'no-such-key');
    const res = await setupApp(db, r2).request(path, init);
    expect(res.status).toBe(401);
  });

  test('担当アカウント外のグループは 404 (canAccessAllLineAccounts が実DBを見る)', async () => {
    insertGroup('g1', 'draft');
    const { path, init } = authed('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    }, SCOPED_ADMIN_KEY);
    const res = await setupApp(db, r2).request(path, init);
    expect(res.status).toBe(404);
  });
});
