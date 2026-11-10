import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createForm, getFormById, getCommonVarUsageImpact, getMediaDeleteImpactSnapshot, publishFormVersion, updateForm, retargetMediaUsageReference, getMediaById } from '@line-crm/db';
import { emptyLayout, type FormLayout } from '@line-crm/shared';
import { authMiddleware } from '../middleware/auth.js';
import { featureEnforcementMiddleware } from '../middleware/feature-enforcement.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import type { Env } from '../worker-env.js';
import { forms } from './forms.js';
import { scanSingleMediaUsage } from '../features/media/media-usage-scan/index.js';
import { unhandledWorkerError } from '../lib/unhandled-error.js';

vi.mock('../services/liff-auth.js', () => ({ verifyCallerLineIdentity: vi.fn(async (authorization?: string) =>
  authorization === 'Bearer line-a' ? { lineUserId: 'user-a', lineAccountId: 'a' }
    : authorization === 'Bearer line-b' ? { lineUserId: 'user-b', lineAccountId: 'b' } : null) }));
vi.mock('../services/event-bus.js', () => ({ fireEvent: vi.fn(), logOutgoingMessage: vi.fn() }));
vi.mock('../features/friends/friend-tag-attach.js', () => ({ attachTagAndFireSideEffects: vi.fn() }));
vi.mock('../lib/unhandled-error.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../lib/unhandled-error.js')>(), unhandledWorkerError: vi.fn() }));

let sql: SqliteD1;
let changedObject = false;
const get = vi.fn(async (_key: string, options?: { onlyIf?: { etagMatches: string } }) =>
  options?.onlyIf?.etagMatches === 'etag-one' && !changedObject
    ? { body: new TextEncoder().encode('fixed image bytes'), etag: 'etag-one' } : null);
const head = vi.fn(async () => ({ etag: changedObject ? 'different' : 'etag-one', size: 17 }));
const env = (): Env['Bindings'] => ({ DB: sql.db, IMAGES: { get, head } as unknown as R2Bucket, WORKER_URL: 'https://api.example.test' } as Env['Bindings']);
function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.use('*', featureEnforcementMiddleware);
  instance.route('/', forms);
  return instance;
}
const request = (path: string, init?: RequestInit) => app().request(path, init, env());
function image(id = 'image-a', account = 'a', versionNo = 1) {
  if (!sql.raw.prepare('SELECT id FROM media WHERE id=?').get(id)) {
    sql.raw.prepare(`INSERT INTO media(id,kind,filename,mime_type,size_bytes,r2_key,line_account_id,width,height)
      VALUES(?,'image','photo.png','image/png',17,?,?,600,400)`).run(id, `media/${account}/final/${id}.png`, account);
    sql.raw.prepare(`INSERT INTO media_file_scans(id,line_account_id,subject_kind,subject_id,media_id,filename,mime_type,size_bytes,status)
      VALUES(?,?,'media',?,?,'photo.png','image/png',17,'clean')`).run(`parent-${id}`, account, id, id);
  }
  const versionId = `version-${id}-${versionNo}`;
  sql.raw.prepare(`INSERT INTO media_versions(id,media_id,version_no,r2_key,mime_type,size_bytes,width,height,etag,scan_status,published_at)
    VALUES(?,?,?,?,'image/png',17,600,400,'etag-one','verified','2026-10-01')`).run(versionId, id, versionNo, `media/${account}/final/${id}-${versionNo}.png`);
  sql.raw.prepare(`INSERT INTO media_file_scans(id,line_account_id,subject_kind,subject_id,media_id,filename,mime_type,size_bytes,status)
    VALUES(?,?,'media_version',?,?,'photo.png','image/png',17,'clean')`).run(`scan-${versionId}`, account, versionId, id);
}
function layout(mediaId = 'image-a', versionNo = 1): FormLayout {
  const value = emptyLayout();
  value.header = [{ id: 'photo', kind: 'image', mediaUrl: 'https://origin.example.test/source-secret' }, { id: 'store', kind: 'text', text: 'not a public fallback' }];
  value.references = [
    { blockId: 'photo', kind: 'image', mediaId, versionNo, alt: 'お店の写真' },
    { blockId: 'store', kind: 'store_information', fields: { displayName: { varKey: 'public_name' }, hours: { varKey: 'public_hours' } } },
  ];
  return value;
}
async function form(value = layout(), accounts = ['a']) {
  return createForm(sql.db, { name: '公開フォーム', fields: '[]', layout: JSON.stringify(value), lineAccountIds: accounts });
}
async function definition(id: string, token?: string) {
  const response = await request(`/api/forms/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { response, data: (await response.json() as { data: Record<string, any> }).data };
}
beforeEach(() => {
  sql = createTestD1({ foreignKeys: true });
  sql.raw.prepare("INSERT INTO tenants(id,name) VALUES('public-tenant','試験用の統括')").run();
  for (const id of ['a', 'b']) sql.raw.prepare(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id)
    VALUES(?,?,?,'test-token','test-secret','public-tenant')`).run(id, `channel-${id}`, id);
  for (const [key, value] of [['public_name', '公開のお店'], ['public_hours', '10:00〜18:00'], ['private_note', '管理者だけのメモ']]) {
    sql.raw.prepare(`INSERT INTO common_vars(id,line_account_id,name,var_key,value,memo) VALUES(?,'a',?,?,?,'private audit note')`).run(key, key, key, value);
  }
  changedObject = false; get.mockClear(); head.mockClear();
  vi.mocked(unhandledWorkerError).mockClear();
  image();
});
afterEach(() => sql.raw.close());

describe('フォームの公開参照と固定画像', () => {
  test('保存APIは別店の画像・古い版・閲覧のみを拒否し、保存済みの入力と版を保つ', async () => {
    const created = await form(); image('foreign', 'b');
    for (const [id, access] of [['owner', 'full'], ['reader', 'read_only']]) sql.raw.prepare(`INSERT INTO staff_members(id,name,role,api_key,is_active,tenant_id,permission_keys,access_level)
      VALUES(?,?,'owner',?,1,'public-tenant','[]',?)`).run(id, id, `key-${id}`, access);
    const save = (token: string, value: FormLayout, expectedContentRevision: number) => request(`/api/forms/${created.id}?account_id=a`, {
      method: 'PUT', headers: { Authorization: `Bearer key-${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '未保存の入力', layout: value, expectedContentRevision }),
    });
    expect((await save('owner', layout('foreign'), 1)).status).toBe(422);
    expect((await save('owner', layout(), 9)).status).toBe(409);
    expect((await save('reader', layout(), 1)).status).toBe(403);
    expect(await getFormById(sql.db, created.id)).toMatchObject({ name: '公開フォーム', content_revision: 1, layout: created.layout });
  });
  test('匿名の単一所属で許可DTOだけを返し、外側の認証を通して同じ画像版を読む', async () => {
    const created = await form();
    const { response, data } = await definition(created.id);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(data.formVersionId).toBe(created.current_published_version_id);
    expect(data.references[0]).toMatchObject({ blockId: 'photo', kind: 'image', state: 'ready', content: { width: 600, height: 400, alt: 'お店の写真' } });
    expect(data.references[1]).toEqual({ blockId: 'store', kind: 'store_information', state: 'ready', content: { displayName: '公開のお店', hours: [{ label: '営業時間', text: '10:00〜18:00' }] } });
    const serialized = JSON.stringify(data);
    for (const secret of ['source-secret', 'private_note', 'private audit note', 'media/a/final', 'etag-one', 'public_hours', 'not a public fallback']) expect(serialized).not.toContain(secret);
    expect(data.layout.references).toBeUndefined();
    const url = new URL(data.references[0].content.url);
    const imageResponse = await request(url.pathname + url.search);
    expect(imageResponse.status).toBe(200);
    expect(await imageResponse.text()).toBe('fixed image bytes');
    expect(imageResponse.headers.get('Cache-Control')).toContain('no-store');
    expect(imageResponse.headers.get('Content-Type')).toBe('image/png');
    expect(get).toHaveBeenLastCalledWith('media/a/final/image-a-1.png', { onlyIf: { etagMatches: 'etag-one' } });
  });

  test('下書きの変更で公開版を差し替えず、再公開したら旧版のURLと使用先を外す', async () => {
    const created = await form(); const old = await definition(created.id);
    image('image-next');
    const next = layout('image-next');
    await updateForm(sql.db, created.id, { layout: JSON.stringify(next) }, 1);
    expect((await definition(created.id)).data.references[0].content.versionId).toBe('version-image-a-1');
    expect(sql.raw.prepare("SELECT COUNT(*) n FROM media_usages WHERE ref_kind='form'").get()).toEqual({ n: 2 });
    await publishFormVersion(sql.db, created.id, 2);
    expect((await definition(created.id)).data.references[0].content.versionId).toBe('version-image-next-1');
    const url = new URL(old.data.references[0].content.url);
    expect((await request(url.pathname + url.search)).status).toBe(404);
    const impact = await getMediaDeleteImpactSnapshot(sql.db, 'image-a', 'a', new Date().toISOString());
    expect(impact?.impact.canDelete).toBe(true);
    expect(sql.raw.prepare("SELECT media_id FROM media_usages WHERE ref_kind='form'").all()).toEqual([{ media_id: 'image-next' }]);
  });

  test('別店の画像を公開参照からも直接の画像GETからも返さない', async () => {
    image('foreign', 'b');
    // API保存口を通さず古い不正データを作る。公開済みの版は書き換えない。
    const created = await form(layout('foreign'));
    const { data } = await definition(created.id);
    expect(data.references[0]).toEqual({ blockId: 'photo', kind: 'image', state: 'unavailable' });
    expect((await request(`/api/forms/${created.id}/images/photo?formVersionId=${created.current_published_version_id}&account_id=b`)).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  test('共有フォームの店は本人から決め、queryや試し合言葉で代用しない', async () => {
    const created = await form(layout(), ['a', 'b']);
    const { data } = await definition(created.id);
    expect(data.references.every((reference: { state: string }) => reference.state === 'context_required')).toBe(true);
    const path = `/api/forms/${created.id}/images/photo?formVersionId=${created.current_published_version_id}`;
    expect((await request(path + '&account_id=a')).status).toBe(404);
    expect((await request(path, { headers: { Authorization: 'Bearer line-a' } })).status).toBe(200);
    expect((await request(path, { headers: { Authorization: 'Bearer line-b' } })).status).toBe(404);
    expect((await request(path + '&test_token=not-a-public-capability')).status).toBe(404);
    expect((await request(path, { method: 'POST' })).status).toBe(401);
    expect((await request('/api/media/image-a')).status).toBe(401);
    expect((await request('/media/image-a/content')).status).toBe(404);
  });

  test.each(['parent', 'version', 'archived', 'expired', 'changed_object', 'private_namespace', 'missing_version', 'unpublished_version', 'private_store_photo'])('%sなら画像を配らない', async (condition) => {
    const created = await form();
    if (condition === 'parent') sql.raw.prepare("UPDATE media_file_scans SET status='quarantined' WHERE subject_kind='media'").run();
    if (condition === 'version') sql.raw.prepare("UPDATE media_file_scans SET status='quarantined' WHERE subject_kind='media_version'").run();
    if (condition === 'archived') sql.raw.prepare("UPDATE media SET archived_at='2026-10-01'").run();
    if (condition === 'expired') sql.raw.prepare("UPDATE media SET usage_expires_at='2000-01-01'").run();
    if (condition === 'changed_object') changedObject = true;
    if (condition === 'private_namespace') sql.raw.prepare("UPDATE media_versions SET r2_key='form-uploads/friend/private.png'").run();
    if (condition === 'missing_version') sql.raw.prepare('DELETE FROM media_versions').run();
    if (condition === 'unpublished_version') sql.raw.prepare('UPDATE media_versions SET published_at=NULL').run();
    if (condition === 'private_store_photo') sql.raw.prepare("INSERT INTO booking_settings(id,line_account_id,store_photo_media_id) VALUES('bs','a','image-a')").run();
    const { data } = await definition(created.id);
    expect(data.references[0].state).toBe('unavailable');
    const imageResponse = await request(`/api/forms/${created.id}/images/photo?formVersionId=${created.current_published_version_id}`);
    expect(imageResponse.status).toBe(404); expect(get).not.toHaveBeenCalled();
  });

  test('フォームの停止・未採用ブロック・版違いには同じ404を返す', async () => {
    const created = await form();
    const prefix = `/api/forms/${created.id}/images/`;
    expect((await request(prefix + 'photo?formVersionId=other')).status).toBe(404);
    expect((await request(prefix + `not-adopted?formVersionId=${created.current_published_version_id}`)).status).toBe(404);
    await updateForm(sql.db, created.id, { isActive: false }, 1);
    expect((await request(prefix + `photo?formVersionId=${created.current_published_version_id}`)).status).toBe(404);
    expect((await definition(created.id)).data.references.every((reference: { state: string }) => reference.state === 'unavailable')).toBe(true);
  });

  test('表示ブロックが無い古い不正な採用も配信しない', async () => {
    const invalid = layout(); invalid.header = [];
    const created = await form(invalid);
    expect((await definition(created.id)).data.references[0].state).toBe('unavailable');
    expect((await request(`/api/forms/${created.id}/images/photo?formVersionId=${created.current_published_version_id}`)).status).toBe(404);
  });

  test('共通情報の最新値だけを読み、停止を空欄や旧値に言い換えず、使用先も数える', async () => {
    const created = await form();
    sql.raw.prepare("UPDATE common_vars SET value='新しい営業時間' WHERE var_key='public_hours'").run();
    expect((await definition(created.id)).data.references[1].content.hours[0].text).toBe('新しい営業時間');
    const impact = await getCommonVarUsageImpact(sql.db, 'public_hours', 'a');
    expect(impact.byKind.form).toBe(1); expect(impact.items.find(item => item.kind === 'form')?.source_id).toBe(created.id);
    sql.raw.prepare("UPDATE common_vars SET status='stopped' WHERE var_key='public_hours'").run();
    expect((await definition(created.id)).data.references[1]).toEqual({ blockId: 'store', kind: 'store_information', state: 'unavailable' });
  });

  test('共通情報の取得障害はemptyにせず、ほかの参照を残し共通のエラー記録へ渡す', async () => {
    const created = await form(); const prepare = sql.db.prepare.bind(sql.db);
    const spy = vi.spyOn(sql.db, 'prepare').mockImplementation(query => {
      if (query.includes('FROM common_vars')) throw new Error('test database unavailable');
      return prepare(query);
    });
    try {
      const { data } = await definition(created.id);
      expect(data.references[0].state).toBe('ready');
      expect(data.references[1]).toEqual({ blockId: 'store', kind: 'store_information', state: 'retryable_error' });
      expect(unhandledWorkerError).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  test('共通情報の空値と、未所属フォームの使用数も区別して守る', async () => {
    const created = await form();
    sql.raw.prepare("UPDATE common_vars SET value='' WHERE var_key IN ('public_name','public_hours')").run();
    expect((await definition(created.id)).data.references[1]).toEqual({ blockId: 'store', kind: 'store_information', state: 'empty' });
    sql.raw.prepare('DELETE FROM form_accounts WHERE form_id=?').run(created.id);
    const impact = await getCommonVarUsageImpact(sql.db, 'public_hours', 'a');
    expect(impact.unscopedFormTotal).toBe(1);
    expect(impact.items.filter(item => item.kind === 'form')).toEqual([]);
  });

  test('使用先を再走査で補修し、固定版の一括付替えは拒否して公開内容を保つ', async () => {
    const created = await form();
    sql.raw.prepare("DELETE FROM media_usages WHERE ref_kind='form'").run();
    await scanSingleMediaUsage(sql.db, new Date().toISOString(), { id: 'image-a', r2_key: 'media/a/final/image-a.png' });
    const impact = await getMediaDeleteImpactSnapshot(sql.db, 'image-a', 'a', new Date().toISOString());
    expect(impact?.impact.canDelete).toBe(false);
    expect(impact?.impact.references.find(reference => reference.kind === 'form')).toMatchObject({ name: '公開フォーム', href: `/form-submissions/edit?id=${created.id}`, state: 'available' });
    const media = (await getMediaById(sql.db, 'image-a', 'a'))!;
    await expect(retargetMediaUsageReference(sql.db, { media, lineAccountId: 'a', refKind: 'form', refId: created.id, target: { mode: 'live' } })).rejects.toThrow('media_reference_unsupported');
    expect((await getFormById(sql.db, created.id, { published: true }))?.layout).toBe(created.layout);
  });

  test('古い保存のCASと台帳の失敗で本文だけを確定しない', async () => {
    const created = await form();
    const result = await updateForm(sql.db, created.id, { name: '古い入力' }, 9);
    expect(result.kind).toBe('conflict');
    expect((await getFormById(sql.db, created.id))?.name).toBe('公開フォーム');
    sql.raw.exec("CREATE TRIGGER fail_form_media BEFORE INSERT ON media_usages WHEN NEW.ref_kind='form' BEGIN SELECT RAISE(ABORT,'test usage failure'); END;");
    await expect(updateForm(sql.db, created.id, { name: '保存されない名前' }, 1)).rejects.toThrow('test usage failure');
    expect((await getFormById(sql.db, created.id))?.name).toBe('公開フォーム');
    expect(sql.raw.prepare("SELECT COUNT(*) n FROM media_usages WHERE ref_kind='form'").get()).toEqual({ n: 1 });
  });

  test('公開版の画像が消えても下書きで外して公開し直せる', async () => {
    const created = await form();
    sql.raw.prepare("DELETE FROM media WHERE id='image-a'").run();
    expect((await definition(created.id)).data.references[0].state).toBe('unavailable');
    const saved = await updateForm(sql.db, created.id, { layout: JSON.stringify(emptyLayout()) }, 1);
    expect(saved.kind).toBe('updated');
    expect((await publishFormVersion(sql.db, created.id, 2)).kind).toBe('published');
    expect((await definition(created.id)).data.references).toEqual([]);
  });

  test('未適用DBでは参照入り保存を巻き戻し、migrationで旧行・索引・予約写真トリガーを保持する', async () => {
    const root = join(import.meta.dirname, '../../../../packages/db');
    const bootstrap = readFileSync(join(root, 'bootstrap.sql'), 'utf8');
    const currentTable = /CREATE TABLE ["`]?media_usages["`]? \([\s\S]*?\n\);/.exec(bootstrap)?.[0];
    if (!currentTable) throw new Error('usage schema fixture missing');
    const oldTable = currentTable.replace(/,\s*'form'/, '');
    if (oldTable === currentTable) throw new Error('old check fixture missing');
    const directory = mkdtempSync(join(tmpdir(), 'form-media-db-'));
    const file = join(directory, 'old.db');
    const database = new Database(file);
    database.exec(bootstrap.replace(currentTable, oldTable)); database.close();
    const old = createTestD1({ file, attach: true, foreignKeys: true });
    try {
      old.raw.prepare("INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','old-a','a','test','test')").run();
      old.raw.prepare("INSERT INTO media(id,kind,filename,mime_type,size_bytes,r2_key,line_account_id) VALUES('image-a','image','old.png','image/png',17,'media/a/final/old.png','a')").run();
      old.raw.prepare("INSERT INTO media_usages(media_id,ref_kind,ref_id,scanned_at) VALUES('image-a','template','legacy','old-stamp')").run();
      await expect(createForm(old.db, { name: 'before', fields: '[]', layout: JSON.stringify(layout()), lineAccountIds: ['a'] })).rejects.toThrow(/CHECK constraint/);
      expect(old.raw.prepare('SELECT COUNT(*) n FROM forms').get()).toEqual({ n: 0 });
      const triggers = old.raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%media_usages%' ORDER BY name").all();
      old.raw.exec(readFileSync(join(root, 'migrations/748_form_public_media_usages.sql'), 'utf8'));
      expect(old.raw.prepare("SELECT ref_kind,ref_id,scanned_at FROM media_usages WHERE ref_kind='template'").get()).toEqual({ ref_kind: 'template', ref_id: 'legacy', scanned_at: 'old-stamp' });
      expect(old.raw.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%media_usages%' ORDER BY name").all()).toEqual(triggers);
      expect(old.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_media_usages_media_scanned'").get()).toBeTruthy();
      const created = await createForm(old.db, { name: 'after', fields: '[]', layout: JSON.stringify(layout()), lineAccountIds: ['a'] });
      expect(old.raw.prepare("SELECT ref_id FROM media_usages WHERE ref_kind='form'").get()).toEqual({ ref_id: created.id });
      expect(old.raw.pragma('foreign_key_check')).toEqual([]);
      old.raw.prepare("INSERT INTO booking_settings(id,line_account_id,store_photo_media_id) VALUES('bs','a','image-a')").run();
      expect(old.raw.prepare("SELECT ref_id FROM media_usages WHERE ref_kind='booking_settings'").get()).toEqual({ ref_id: 'bs' });
    } finally { old.raw.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 20_000);
});
