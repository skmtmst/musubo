/* 直接試験: 実route＋実SQLite。回答フォームの箱の作成・名前変更・削除・移動。 */
import { Hono } from 'hono';
import { expect, test } from 'vitest';

const { createTestD1 } = await import('../test-utils/d1-sqlite.js');
const { forms } = await import('./forms.js');
const { friendAttributes } = await import('./friend-attributes.js');
const { authMiddleware } = await import('../middleware/auth.js');
const { DEFAULT_TENANT_ID } = await import('@line-crm/shared');

function setup() {
  const t = createTestD1({ loginPolicy: 'off', foreignKeys: true });
  const raw = t.raw;
  for (const id of ['acc-a', 'acc-b']) {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
       VALUES (?, ?, ?, 't', 's', 1, ?)`,
    ).run(id, `ch-${id}`, id, DEFAULT_TENANT_ID);
  }
  raw.prepare(
    `INSERT INTO staff_members (id, name, role, access_level, api_key, permission_keys, account_scope, tenant_id)
     VALUES ('owner-1', 'o', 'owner', 'full', 'key-owner', '[]', 'all', ?),
            ('scoped-1', 's', 'admin', 'full', 'key-scoped', '[]', 'accounts', ?),
            ('staff-1', 't', 'staff', 'full', 'key-staff', '[]', 'all', ?)`,
  ).run(DEFAULT_TENANT_ID, DEFAULT_TENANT_ID, DEFAULT_TENANT_ID);
  raw.prepare(
    `INSERT INTO staff_account_scopes (staff_id, line_account_id, created_at)
     VALUES ('scoped-1', 'acc-a', '2026-01-01')`,
  ).run();
  raw.prepare(
    `INSERT INTO folders (id, kind, name, account_id) VALUES
       ('fol-a', 'form', 'A箱', 'acc-a'),
       ('fol-b', 'form', 'B箱', 'acc-b'),
       ('fol-tag', 'tag', 'タグ箱', 'acc-a')`,
  ).run();
  const form = (id: string, folder: string | null, account: string) => {
    raw.prepare(`INSERT INTO forms (id, name, fields, folder_id, content_revision) VALUES (?, ?, '[]', ?, 3)`).run(id, id, folder);
    raw.prepare(`INSERT INTO form_accounts (form_id, line_account_id) VALUES (?, ?)`).run(id, account);
  };
  form('f-a1', 'fol-a', 'acc-a');
  form('f-a2', null, 'acc-a');

  const app = new Hono<any>();
  app.use('*', authMiddleware);
  app.route('/', friendAttributes);
  app.route('/', forms);
  const env = { DB: t.db } as any;
  const call = (path: string, key: string, method = 'GET', body?: unknown): Response | Promise<Response> =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
  const folderOf = (id: string): string | null =>
    (raw.prepare(`SELECT folder_id FROM forms WHERE id = ?`).get(id) as { folder_id: string | null }).folder_id;
  const revisionOf = (id: string): number =>
    (raw.prepare(`SELECT content_revision FROM forms WHERE id = ?`).get(id) as { content_revision: number }).content_revision;
  return { t, call, folderOf, revisionOf };
}

test('R25 箱は選んだアカウントに付けて作る。無い・権限外は作らせない', async () => {
  const { t, call } = setup();
  const created = await call('/api/folders', 'key-owner', 'POST', { kind: 'form', name: ' 新箱 ', accountId: 'acc-a' });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as any;
  expect(createdBody.data.accountId).toBe('acc-a');
  expect(createdBody.data.name).toBe('新箱');

  // 箱の持ち主を付けない要求は、未割当が見える統括でも箱の種類が違えば断る
  expect((await call('/api/folders', 'key-owner', 'POST', { kind: 'unknown-kind', name: 'x' })).status).toBe(400);
  // 範囲外のアカウントには作らせない
  expect((await call('/api/folders', 'key-scoped', 'POST', { kind: 'form', name: 'よそ', accountId: 'acc-b' })).status).toBe(404);
  // 担当者（staff）は作らせない
  expect((await call('/api/folders', 'key-staff', 'POST', { kind: 'form', name: 'staff箱', accountId: 'acc-a' })).status).toBe(403);
  t.raw.close();
});

test('R25 箱の名前は直せる。空には戻せない。担当者は直せない', async () => {
  const { t, call } = setup();
  const renamed = await call('/api/folders/fol-a', 'key-owner', 'PATCH', { name: 'A箱・改' });
  expect(renamed.status).toBe(200);
  expect(((await renamed.json()) as any).data.name).toBe('A箱・改');
  expect((await call('/api/folders/fol-a', 'key-owner', 'PATCH', { name: '  ' })).status).toBe(400);
  expect((await call('/api/folders/fol-a', 'key-staff', 'PATCH', { name: 'staff改' })).status).toBe(403);
  t.raw.close();
});

test('R25 箱を消しても中のフォームは未分類に残る', async () => {
  const { t, call, folderOf } = setup();
  expect((await call('/api/folders/fol-a', 'key-owner', 'DELETE')).status).toBe(200);
  expect(folderOf('f-a1')).toBe(null);
  // 消した箱での絞り込みは fail-closed
  expect((await call('/api/forms?account_id=acc-a&folder_id=fol-a', 'key-owner')).status).toBe(404);
  t.raw.close();
});

test('R25 フォームの移動は版の確認なしでできる。版は動かない', async () => {
  const { t, call, folderOf, revisionOf } = setup();
  const moved = await call('/api/forms/f-a2?account_id=acc-a', 'key-owner', 'PUT', { folderId: 'fol-a' });
  expect(moved.status).toBe(200);
  expect(folderOf('f-a2')).toBe('fol-a');
  expect(revisionOf('f-a2')).toBe(3);
  // 未分類へ戻す
  expect((await call('/api/forms/f-a2?account_id=acc-a', 'key-owner', 'PUT', { folderId: null })).status).toBe(200);
  expect(folderOf('f-a2')).toBe(null);
  t.raw.close();
});

test('R25 消えた箱・別用途の箱・別アカウントの箱へは移さない', async () => {
  const { t, call, folderOf } = setup();
  for (const folderId of ['ghost', 'fol-tag', 'fol-b']) {
    const res = await call('/api/forms/f-a2?account_id=acc-a', 'key-owner', 'PUT', { folderId });
    expect(res.status).toBe(422);
  }
  expect(folderOf('f-a2')).toBe(null);
  // 担当者は移せない
  expect((await call('/api/forms/f-a2?account_id=acc-a', 'key-staff', 'PUT', { folderId: 'fol-a' })).status).toBe(403);
  expect(folderOf('f-a2')).toBe(null);
  t.raw.close();
});

test('R25 中身の更新は今までどおり版の確認が要る。混ぜた要求は確認なしでは何も変えない', async () => {
  const { t, call, folderOf, revisionOf } = setup();
  // 名前だけの更新に版が無ければ 400（一覧の名前変更は版を取ってから送る）
  expect((await call('/api/forms/f-a2?account_id=acc-a', 'key-owner', 'PUT', { name: '新名' })).status).toBe(400);
  // 版つきの名前変更は通る
  expect((await call('/api/forms/f-a2?account_id=acc-a', 'key-owner', 'PUT', { name: '新名', expectedContentRevision: 3 })).status).toBe(200);
  // 移動＋名前を版なしで混ぜたら 400 で、移動だけが残らない
  expect((await call('/api/forms/f-a2?account_id=acc-a', 'key-owner', 'PUT', { folderId: 'fol-a', name: '混ぜ名' })).status).toBe(400);
  expect(folderOf('f-a2')).toBe(null);
  expect(revisionOf('f-a2')).toBe(4);
  t.raw.close();
});
