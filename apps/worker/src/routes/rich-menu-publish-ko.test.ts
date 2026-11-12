import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * K 公開の手順と照合・O 公開前の確認の受け入れ試験。
 *
 * - 実SQLite: packages/db/bootstrap.sql から作る（新台帳 480/481/509/510 含む）。
 * - 実route: 本物の richMenuGroups ハンドラを通す。DB 関数は差し替えない。
 * - 差し替えるのは LINE への fetch と R2 だけ（外部副作用）。
 */

vi.mock('../services/account-access.js', () => ({
  canAccessAllLineAccounts: async () => true,
}));

const { richMenuGroups } = await import('./rich-menu-groups.js');

const BOOTSTRAP_SQL = readFileSync(
  join(import.meta.dirname, '../../../../packages/db/bootstrap.sql'),
  'utf8',
);

function setupSqlite() {
  const sqlite = new Database(':memory:');
  sqlite.exec(BOOTSTRAP_SQL);
  sqlite.prepare(
    `INSERT INTO line_accounts (id, name, channel_id, channel_access_token, channel_secret)
     VALUES ('acc-1', 'アカウント', 'ch-1', 'token', 'secret')`,
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

type Staff = { id: string; role: 'owner' | 'admin' | 'staff' };

type TestEnv = {
  Variables: { staff: Staff };
  Bindings: { DB: D1Database; IMAGES: R2Bucket };
};

function setupApp(db: D1Database, r2: R2Bucket, staff: Staff = { id: 'st-1', role: 'owner' }) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: db, IMAGES: r2 };
    c.set('staff', staff);
    await next();
  });
  app.route('/', richMenuGroups);
  return app;
}

type LineStubOpts = {
  menus?: Array<{ richMenuId: string; name?: string }>;
  defaultId?: string | null;
  validateStatus?: number;
  failAlias?: boolean;
};

function stubLine(opts: LineStubOpts = {}) {
  const created: Array<{ richMenuId: string; payload: unknown }> = [];
  let counter = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === 'https://api.line.me/v2/bot/richmenu/validate' && method === 'POST') {
      const status = opts.validateStatus ?? 200;
      return new Response(status === 200 ? '{}' : 'bad areas', { status });
    }
    if (url === 'https://api.line.me/v2/bot/richmenu' && method === 'POST') {
      counter += 1;
      const id = `rm-new-${counter}`;
      created.push({ richMenuId: id, payload: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ richMenuId: id }), { status: 200 });
    }
    if (url === 'https://api.line.me/v2/bot/richmenu/list') {
      const richmenus = [...(opts.menus ?? []), ...created.map((c) => ({ richMenuId: c.richMenuId }))];
      return new Response(JSON.stringify({ richmenus }), { status: 200 });
    }
    if (url.startsWith('https://api-data.line.me/v2/bot/richmenu/') && url.endsWith('/content')) {
      return new Response('', { status: 200 });
    }
    if (url.startsWith('https://api.line.me/v2/bot/richmenu/alias/') && method === 'POST') {
      if (opts.failAlias) return new Response('alias unavailable', { status: 503 });
      return new Response('', { status: 200 });
    }
    if (url.startsWith('https://api.line.me/v2/bot/user/all/richmenu/') && method === 'POST') {
      return new Response('', { status: 200 });
    }
    if (url === 'https://api.line.me/v2/bot/user/all/richmenu') {
      return opts.defaultId
        ? new Response(JSON.stringify({ richMenuId: opts.defaultId }), { status: 200 })
        : new Response('not found', { status: 404 });
    }
    if (url.startsWith('https://api.line.me/v2/bot/richmenu/') && method === 'DELETE') {
      return new Response('', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { created, fetchMock };
}

let sqlite: Database.Database;
let db: D1Database;
let r2: ReturnType<typeof makeR2Stub>;

beforeEach(() => {
  sqlite = setupSqlite();
  db = asD1(sqlite);
  r2 = makeR2Stub();
});

function insertGroup(id = 'g1') {
  sqlite.prepare(
    `INSERT INTO rich_menu_groups (id, account_id, name, status, size, chat_bar_text, is_default_for_all)
     VALUES (?, 'acc-1', 'メニュー', 'draft', 'large', 'menu', 0)`,
  ).run(id);
}

function insertPage(groupId: string, id: string, orderIndex: number) {
  sqlite.prepare(
    `INSERT INTO rich_menu_pages (id, group_id, order_index, name, alias_id, image_r2_key, image_content_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, groupId, orderIndex, `ページ${orderIndex + 1}`, `lhx-${groupId}-${orderIndex}`, `img/${id}.png`, 'image/png');
  r2.store.set(`img/${id}.png`, new Uint8Array([1, 2, 3]));
}

function insertArea(
  pageId: string,
  id: string,
  opts: { actionType?: string; actionData?: Record<string, unknown>; intent?: string | null; label?: string | null } = {},
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
    opts.intent === undefined ? 'url' : opts.intent,
    opts.label === undefined ? 'リンクを開く' : opts.label,
  );
}

function setupBasicMenu() {
  insertGroup('g1');
  insertPage('g1', 'p1', 0);
  insertArea('p1', 'a1');
}

async function confirmDevice() {
  const res = await setupApp(db, r2).request('/api/rich-menu-groups/g1/device-confirm', { method: 'POST' });
  expect(res.status).toBe(200);
}

async function publish(key: string) {
  return setupApp(db, r2).request('/api/rich-menu-groups/g1/publish', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
  });
}

function tableCount(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function groupStatus(): string {
  return (sqlite.prepare(`SELECT status AS s FROM rich_menu_groups WHERE id = 'g1'`).get() as { s: string }).s;
}

// ---------------------------------------------------------------------------
// 実機で見た門番
// ---------------------------------------------------------------------------

describe('O: 実機で見た確認が無いと公開できない', () => {
  test('確認なしの公開は409で、前のメニューのまま。台帳に失敗が残る', async () => {
    setupBasicMenu();
    stubLine();

    const res = await publish('ko-no-confirm-1');
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('実機で見た');
    expect(groupStatus()).toBe('draft');
    expect(tableCount('rich_menu_versions')).toBe(1);
    const run = sqlite.prepare(`SELECT status AS s, last_error_code AS c FROM rich_menu_publish_runs`).get() as { s: string; c: string };
    expect(run.s).toBe('failed');
    expect(run.c).toBe('device_confirm_missing');
  });

  test('確認してから公開すると通る。下書きを変えると確認は無効になる', async () => {
    setupBasicMenu();
    stubLine();
    await confirmDevice();

    const first = await publish('ko-confirm-1');
    expect(first.status).toBe(200);

    sqlite.prepare(`UPDATE rich_menu_areas SET label = ? WHERE id = 'a1'`).run('別の呼び名');
    const second = await publish('ko-confirm-2');
    expect(second.status).toBe(409);
  });

  test('staffは確認を押せない（owner/admin限定）', async () => {
    setupBasicMenu();
    const res = await setupApp(db, r2, { id: 'st-9', role: 'staff' })
      .request('/api/rich-menu-groups/g1/device-confirm', { method: 'POST' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// LINEの検査・公開前の確認口
// ---------------------------------------------------------------------------

describe('O: LINEの検査APIと公開前の確認口', () => {
  test('自前の不備はLINEを呼ばずに返す', async () => {
    setupBasicMenu();
    sqlite.prepare(`UPDATE rich_menu_areas SET label = '' WHERE id = 'a1'`).run();
    const { fetchMock } = stubLine();

    const res = await setupApp(db, r2).request('/api/rich-menu-groups/g1/validate', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { checks: Array<{ key: string; ok: boolean; message: string }> } };
    expect(body.data.checks).toHaveLength(1);
    expect(body.data.checks[0]).toMatchObject({ key: 'self', ok: false });
    expect(body.data.checks[0].message).toContain('ボタン名');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('LINEが400ならページ名つきで返す', async () => {
    setupBasicMenu();
    stubLine({ validateStatus: 400 });

    const res = await setupApp(db, r2).request('/api/rich-menu-groups/g1/validate', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { checks: Array<{ key: string; ok: boolean; message: string }> } };
    expect(body.data.checks).toEqual([
      { key: 'self', ok: true, message: '自前の検査を通りました。' },
      expect.objectContaining({ key: 'line', ok: false }),
    ]);
    expect(body.data.checks[1].message).toContain('ページ1');
  });

  test('両方通れば公開できる', async () => {
    setupBasicMenu();
    stubLine();
    await confirmDevice();

    const check = await setupApp(db, r2).request('/api/rich-menu-groups/g1/validate', { method: 'POST' });
    const checkBody = await check.json() as { data: { checks: Array<{ ok: boolean }> } };
    expect(checkBody.data.checks.every((c) => c.ok)).toBe(true);

    const res = await publish('ko-validate-ok-1');
    expect(res.status).toBe(200);
  });

  test('公開前の確認口は自前検査・実機・版をまとめて返す', async () => {
    setupBasicMenu();
    stubLine();

    const before = await setupApp(db, r2).request('/api/rich-menu-groups/g1/prepublish-check');
    expect(before.status).toBe(200);
    const beforeBody = await before.json() as { data: {
      pageCount: number; maxPages: number; selfCheck: { ok: boolean };
      deviceConfirmed: boolean; versionNumber: number | null;
    } };
    expect(beforeBody.data).toMatchObject({
      pageCount: 1, maxPages: 10, deviceConfirmed: false, versionNumber: null,
    });
    expect(beforeBody.data.selfCheck.ok).toBe(true);

    await confirmDevice();
    const after = await setupApp(db, r2).request('/api/rich-menu-groups/g1/prepublish-check');
    const afterBody = await after.json() as { data: { deviceConfirmed: boolean } };
    expect(afterBody.data.deviceConfirmed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10ページ上限と新しいボタンの動き
// ---------------------------------------------------------------------------

describe('O: 10ページ上限と新しいボタンの動き', () => {
  test('11ページの保存は400。10ページは通る', async () => {
    setupBasicMenu();
    const pages = Array.from({ length: 11 }, (_, i) => ({
      name: `p${i}`, orderIndex: i, areas: [],
    }));
    const res = await setupApp(db, r2).request('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, pages }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('10');

    // 10ページちょうどは通る（境界値）
    const okPatch = await setupApp(db, r2).request('/api/rich-menu-groups/g1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, pages: pages.slice(0, 10) }),
    });
    expect(okPatch.status).toBe(200);
  });

  test('日時を選ぶ・コピーするボタンで公開できる。LINEには本来の動きで届く', async () => {
    setupBasicMenu();
    insertArea('p1', 'a2', {
      actionType: 'postback', intent: 'datetime', label: '日時を選ぶ',
      actionData: { mode: 'date', initial: '2026-10-01', min: '2026-09-01', max: '2026-12-31' },
    });
    insertArea('p1', 'a3', {
      actionType: 'postback', intent: 'clipboard', label: '合言葉をコピー',
      actionData: { text: 'あいことば' },
    });
    const { created } = stubLine();
    await confirmDevice();

    const res = await publish('ko-new-intents-1');
    expect(res.status).toBe(200);
    expect(created).toHaveLength(1);
    const areas = (created[0].payload as { areas: Array<{ action: { type: string; mode?: string; text?: string } }> }).areas;
    expect(areas.map((a) => a.action.type).sort()).toEqual(['clipboard', 'datetimepicker', 'uri']);
    expect(areas.find((a) => a.action.type === 'datetimepicker')!.action.mode).toBe('date');
    expect(areas.find((a) => a.action.type === 'clipboard')!.action.text).toBe('あいことば');
  });

  test('日時の種類が無い・形が違う・コピーが空なら400', async () => {
    setupBasicMenu();
    insertArea('p1', 'a2', {
      actionType: 'postback', intent: 'datetime', label: '日時を選ぶ',
      actionData: { mode: 'year' },
    });
    stubLine();
    await confirmDevice();

    const res = await publish('ko-datetime-bad-1');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('日時の種類');

    sqlite.prepare(`UPDATE rich_menu_areas SET action_data = ? WHERE id = 'a2'`)
      .run(JSON.stringify({ mode: 'date', initial: '10時' }));
    const res2 = await publish('ko-datetime-bad-2');
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as { error: string }).error).toContain('形');

    sqlite.prepare(`UPDATE rich_menu_areas SET intent = 'clipboard', action_data = ? WHERE id = 'a2'`)
      .run(JSON.stringify({ text: '' }));
    const res3 = await publish('ko-clipboard-bad-1');
    expect(res3.status).toBe(400);
    expect(((await res3.json()) as { error: string }).error).toContain('コピーする文字');
  });
});

// ---------------------------------------------------------------------------
// 公開の進み（4段）と版・実行・ページ台帳
// ---------------------------------------------------------------------------

describe('K: 公開の進みと台帳', () => {
  test('成功すると版が公開版になり、4段が全部済みになる', async () => {
    setupBasicMenu();
    stubLine();
    await confirmDevice();

    const res = await publish('ko-progress-ok-1');
    expect(res.status).toBe(200);

    const version = sqlite.prepare(`SELECT status AS s, version_number AS n FROM rich_menu_versions`).get() as { s: string; n: number };
    expect(version).toMatchObject({ s: 'published', n: 1 });
    const run = sqlite.prepare(`SELECT status AS s FROM rich_menu_publish_runs`).get() as { s: string };
    expect(run.s).toBe('succeeded');
    const steps = sqlite.prepare(
      `SELECT create_status AS c, image_status AS i, alias_status AS a, cleanup_status AS cl
         FROM rich_menu_publish_run_pages`,
    ).get() as { c: string; i: string; a: string; cl: string };
    // 初公開で旧メニューが無いページの片付けは「しない」
    expect(steps).toMatchObject({ c: 'succeeded', i: 'succeeded', a: 'succeeded', cl: 'skipped' });

    const progress = await setupApp(db, r2).request('/api/rich-menu-groups/g1/publish-progress');
    expect(progress.status).toBe(200);
    const body = await progress.json() as { data: {
      run: { status: string }; steps: Array<{ key: string; label: string; status: string }>; message: string | null;
    } };
    expect(body.data.run.status).toBe('succeeded');
    expect(body.data.steps).toEqual([
      { key: 'image', label: '画像をLINEに上げる', status: 'done' },
      { key: 'menu', label: 'メニューを作る', status: 'done' },
      { key: 'assign', label: '友だちに割り当てる', status: 'done' },
      { key: 'cleanup', label: '前のメニューを片付ける', status: 'skipped' },
    ]);
    expect(body.data.message).toBeNull();
  });

  test('割り当て失敗はその段だけ失敗にし、前のメニューのまま。直して再試行できる', async () => {
    setupBasicMenu();
    stubLine({ failAlias: true });
    await confirmDevice();

    const failed = await publish('ko-progress-fail-1');
    expect(failed.status).toBe(500);
    expect(groupStatus()).toBe('draft');

    const progress = await setupApp(db, r2).request('/api/rich-menu-groups/g1/publish-progress');
    const body = await progress.json() as { data: {
      steps: Array<{ key: string; status: string }>; message: string | null;
    } };
    expect(body.data.steps).toEqual([
      expect.objectContaining({ key: 'image', status: 'done' }),
      expect.objectContaining({ key: 'menu', status: 'done' }),
      expect.objectContaining({ key: 'assign', status: 'failed' }),
      expect.objectContaining({ key: 'cleanup', status: 'pending' }),
    ]);
    expect(body.data.message).toContain('前のメニューのまま');

    // 直して同じ鍵で再試行すると完走する（作り直さない）
    stubLine();
    const retry = await setupApp(db, r2).request('/api/rich-menu-groups/g1/publish-runs/req-retry/retry', { method: 'POST' });
    expect(retry.status).toBe(404);
    const retrySameKey = await publish('ko-progress-fail-1');
    expect(retrySameKey.status).toBe(200);
    expect(groupStatus()).toBe('published');
  });

  test('まだ公開していなければ「まだ公開していません」', async () => {
    setupBasicMenu();
    stubLine();
    const progress = await setupApp(db, r2).request('/api/rich-menu-groups/g1/publish-progress');
    const body = await progress.json() as { data: { run: null; message: string } };
    expect(body.data.run).toBeNull();
    expect(body.data.message).toContain('まだ公開していません');
  });
});

// ---------------------------------------------------------------------------
// 照合（LINEにだけあるメニュー・直し方・記録）
// ---------------------------------------------------------------------------

describe('K: LINE側との照合', () => {
  test('LINEにだけあるメニューは取り込み候補として出る。直し方は1つ', async () => {
    setupBasicMenu();
    stubLine({ menus: [{ richMenuId: 'rm-external-1', name: '別で作ったメニュー' }] });

    const res = await setupApp(db, r2).request('/api/rich-menu-groups/g1/reconcile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { dryRun: boolean; diffs: Array<{
      kind: string; richMenuId?: string; fix: { label: string; action: string };
    }> } };
    const external = body.data.diffs.filter((d) => d.kind === 'external_only');
    expect(external).toHaveLength(1);
    expect(external[0].richMenuId).toBe('rm-external-1');
    expect(external[0].fix).toEqual({ label: 'こちらに取り込む', action: 'import-external' });
  });

  test('直すと記録が残る。取り込み候補は運用者に残す', async () => {
    setupBasicMenu();
    stubLine({ menus: [{ richMenuId: 'rm-external-1' }] });

    const res = await setupApp(db, r2).request('/api/rich-menu-groups/g1/reconcile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: {
      dryRun: boolean; applied: number; runId: string;
      unapplied: Array<{ diff: { kind: string } }>; diffs: Array<{ kind: string; fix: { label: string } }>;
    } };
    expect(body.data.dryRun).toBe(false);
    // ずれの種類ごとに直し方が1つある
    for (const d of body.data.diffs) expect(d.fix.label).toBeTruthy();
    // 取り込み候補は自動で直さず残す
    expect(body.data.unapplied.map((u) => u.diff.kind)).toEqual(['external_only']);
    // 実行台帳に残る
    const run = sqlite.prepare(`SELECT mode AS m, status AS s FROM rich_menu_publish_runs WHERE id = ?`)
      .get(body.data.runId) as { m: string; s: string };
    expect(run).toMatchObject({ m: 'reconcile', s: 'succeeded' });
  });

  test('取り下げも台帳に残る', async () => {
    setupBasicMenu();
    stubLine();

    const res = await setupApp(db, r2).request('/api/rich-menu-groups/g1/unpublish', { method: 'POST' });
    expect(res.status).toBe(200);
    const run = sqlite.prepare(`SELECT mode AS m, status AS s FROM rich_menu_publish_runs`).get() as { m: string; s: string };
    expect(run).toMatchObject({ m: 'unpublish', s: 'succeeded' });
  });
});
