import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { createMediaVersionFromUpload, verifyMediaUploadSession } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { authMiddleware } from '../middleware/auth.js';
import { fileScan } from './file-scan.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { runBuiltinScanAndStore, type FileScanRow } from '../services/file-scan.js';
import { claimFileDeletion, mediaDeletionLockId, releaseFileDeletion } from '../services/file-deletion-lock.js';

/**
 * 危険なファイルの検査の管理口。
 * 権限（owner/admin だけの一覧・消去・戻し）、範囲（別アカウントは404）、
 * 失敗（pending は通さない）、二重実行（再試行の連打は1行のまま）を見る。
 */

let testDb: SqliteD1;
let allowedPairs = 'example.com=FILE_SCAN_SECRET_PRIMARY';
const deletedObjects = vi.fn(async (_key: string | string[]): Promise<void> => {});

function insertAccount(id: string, tenantId: string = DEFAULT_TENANT_ID): void {
  testDb.raw.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
      id, `channel-${id}`, id, `token-${id}`, `secret-${id}`, tenantId,
    );
}

function insertStaff(id: string, role: string): void {
  testDb.raw.prepare(`INSERT INTO staff_members
    (id, name, role, api_key, is_active, tenant_id, permission_keys, access_level)
    VALUES (?, ?, ?, ?, 1, ?, '[]', 'full')`).run(
      id, id, role, `key-${id}`, DEFAULT_TENANT_ID,
    );
}

function insertScan(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `scan-${Math.random().toString(36).slice(2)}`,
    line_account_id: 'acc-1',
    subject_kind: 'media',
    subject_id: 'md-1',
    media_id: 'md-1',
    filename: 'a.png',
    mime_type: 'image/png',
    size_bytes: 100,
    status: 'quarantined',
    reason_code: 'trailing_data',
    reason_detail: '画像の後ろに別のデータがあります',
    attempts: 0,
    next_retry_at: null,
    scanned_at: '2026-09-25T10:00:00+09:00',
    quarantined_at: '2026-09-25T10:00:00+09:00',
    released_at: null,
    release_reason: null,
    released_by: null,
    created_at: '2026-09-25T10:00:00+09:00',
    updated_at: '2026-09-25T10:00:00+09:00',
    ...overrides,
  };
  testDb.raw.prepare(`INSERT INTO media_file_scans
    (id, line_account_id, subject_kind, subject_id, media_id, filename, mime_type,
     size_bytes, status, reason_code, reason_detail, attempts, next_retry_at,
     scanned_at, quarantined_at, released_at, release_reason, released_by,
     created_at, updated_at)
    VALUES (@id, @line_account_id, @subject_kind, @subject_id, @media_id, @filename,
     @mime_type, @size_bytes, @status, @reason_code, @reason_detail, @attempts,
     @next_retry_at, @scanned_at, @quarantined_at, @released_at, @release_reason,
     @released_by, @created_at, @updated_at)`).run(row);
  return row;
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.route('/', fileScan);
  return instance;
}

function environment(): Env['Bindings'] {
  return {
    DB: testDb.db,
    IMAGES: { delete: deletedObjects } as unknown as R2Bucket,
    WORKER_URL: 'https://api.example.com',
    API_KEY: 'env-key-unused',
    FILE_SCAN_ALLOWED_PAIRS: allowedPairs,
  } as Env['Bindings'];
}

async function call(path: string, staffId: string, init?: RequestInit): Promise<Response> {
  return app().request(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer key-${staffId}` },
  }, environment());
}

function get(path: string, staffId: string): Promise<Response> {
  return call(path, staffId, { method: 'GET' });
}

function putConfig(path: string, staffId: string, body: unknown): Promise<Response> {
  return call(path, staffId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function post(path: string, staffId: string, body: unknown): Promise<Response> {
  return call(path, staffId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  deletedObjects.mockClear();
  allowedPairs = 'example.com=FILE_SCAN_SECRET_PRIMARY';
  testDb = createTestD1({ loginPolicy: 'off' });
  insertAccount('acc-1');
  insertAccount('acc-2', 'tenant-B');
  insertStaff('owner-1', 'owner');
  insertStaff('admin-1', 'admin');
  // staff は登録メディア（/contents）の鍵を持つ。検査の状態確認に要る。
  testDb.raw.prepare(`INSERT INTO staff_members
    (id, name, role, api_key, is_active, tenant_id, permission_keys, access_level)
    VALUES ('staff-1', 'staff-1', 'staff', 'key-staff-1', 1, ?, '["/contents"]', 'full')`).run(
      DEFAULT_TENANT_ID,
    );
});

describe('ファイル検査の一覧', () => {
  it('確認後に版が変わった隔離ファイルは戻さず 409', async () => {
    const scan = insertScan();
    testDb.raw.prepare('UPDATE media_file_scans SET confirmation_revision=2 WHERE id=?').run(scan.id);
    const res = await post(`/api/file-scans/${scan.id}/release`, 'owner-1', { accountId: 'acc-1', reason: '誤検知', expectedConfirmationRevision: 1 });
    expect(res.status).toBe(409);
    expect((await res.json() as { current: { confirmationRevision: number } }).current.confirmationRevision).toBe(2);
    expect(testDb.raw.prepare('SELECT status FROM media_file_scans WHERE id=?').get(scan.id)).toEqual({ status: 'quarantined' });
    const current = await post(`/api/file-scans/${scan.id}/release`, 'owner-1', { accountId: 'acc-1', reason: '誤検知', expectedConfirmationRevision: 2 });
    expect(current.status).toBe(200);
    expect(testDb.raw.prepare('SELECT status,confirmation_revision FROM media_file_scans WHERE id=?').get(scan.id)).toEqual({ status: 'clean', confirmation_revision: 3 });
  });
  it('版なしの古い解除は従来どおり', async () => {
    const scan = insertScan();
    expect((await post(`/api/file-scans/${scan.id}/release`, 'owner-1', { accountId: 'acc-1', reason: '誤検知' })).status).toBe(200);
  });
  it('同じ確認で解除を二度実行しても一度だけ通る', async () => {
    const scan = insertScan();
    const body = { accountId: 'acc-1', reason: '誤検知', expectedConfirmationRevision: 1 };
    const responses = await Promise.all([post(`/api/file-scans/${scan.id}/release`, 'owner-1', body), post(`/api/file-scans/${scan.id}/release`, 'owner-1', body)]);
    expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
    expect(testDb.raw.prepare('SELECT status,confirmation_revision FROM media_file_scans WHERE id=?').get(scan.id)).toEqual({ status: 'clean', confirmation_revision: 2 });
  });
  it('消えた確認と他の統括の対象を区別せず 409、版なしの旧呼び出しは 404', async () => {
    const scan = insertScan({ line_account_id: 'acc-2' });
    const expected = { accountId: 'acc-1', reason: '誤検知', expectedConfirmationRevision: 1 };
    for (const id of [scan.id, 'missing-scan']) {
      const res = await post(`/api/file-scans/${id}/release`, 'owner-1', expected);
      expect(res.status).toBe(409);
      expect((await res.json() as { current: unknown }).current).toBeNull();
    }
    expect((await post('/api/file-scans/missing-scan/release', 'owner-1', { accountId: 'acc-1', reason: '誤検知' })).status).toBe(404);
  });
  it('owner は見られるが staff は見られない', async () => {
    insertScan();
    const ownerRes = await get('/api/file-scans?accountId=acc-1', 'owner-1');
    expect(ownerRes.status).toBe(200);
    const ownerBody = await ownerRes.json() as { data: { items: unknown[] } };
    expect(ownerBody.data.items).toHaveLength(1);

    const staffRes = await get('/api/file-scans?accountId=acc-1', 'staff-1');
    expect(staffRes.status).toBe(403);
  });

  it('別アカウントの範囲は404にする', async () => {
    insertScan({ line_account_id: 'acc-1' });
    const res = await get('/api/file-scans?accountId=acc-2', 'owner-1');
    expect(res.status).toBe(404);
  });

  it('ファイル名で絞れ、件数も同じ条件で数える (監査R132)', async () => {
    insertScan({ filename: 'invoice.pdf' });
    insertScan({ filename: 'photo.png' });
    const res = await get('/api/file-scans?accountId=acc-1&q=invoice', 'owner-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { items: { filename: string }[]; total: number } };
    expect(body.data.items.map((row) => row.filename)).toEqual(['invoice.pdf']);
    expect(body.data.total).toBe(1);
  });

  it('検索語は % や _ をそのままの文字として扱う (監査R132)', async () => {
    insertScan({ filename: '100%.png' });
    insertScan({ filename: 'a.png' });
    const res = await get('/api/file-scans?accountId=acc-1&q=' + encodeURIComponent('%'), 'owner-1');
    const body = await res.json() as { data: { items: { filename: string }[]; total: number } };
    expect(body.data.items.map((row) => row.filename)).toEqual(['100%.png']);
    expect(body.data.total).toBe(1);
  });

  it('staff は自分の上げた分の状態は見られる', async () => {
    const scan = insertScan({ status: 'pending', reason_code: null, reason_detail: null });
    const res = await get(
      `/api/file-scans/by-subject?kind=media&id=${scan.subject_id}&accountId=acc-1`, 'staff-1',
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { scan: { status: string } | null } };
    expect(body.data.scan?.status).toBe('pending');
  });
});

describe('誤りなので戻す', () => {
  it('理由がなければ戻せない', async () => {
    const scan = insertScan();
    const res = await post(`/api/file-scans/${scan.id}/release`, 'owner-1', { accountId: 'acc-1', reason: '' });
    expect(res.status).toBe(400);
  });

  it('しまったものだけ理由付きで戻せる', async () => {
    const scan = insertScan();
    const res = await post(`/api/file-scans/${scan.id}/release`, 'admin-1', {
      accountId: 'acc-1', reason: '社内の画像と確認できたため',
    });
    expect(res.status).toBe(200);
    const row = testDb.raw.prepare(`SELECT status, release_reason FROM media_file_scans WHERE id = ?`)
      .get(scan.id) as { status: string; release_reason: string };
    expect(row.status).toBe('clean');
    expect(row.release_reason).toBe('社内の画像と確認できたため');
  });

  it('しまっていないものは戻せない', async () => {
    const scan = insertScan({ status: 'rejected', reason_code: 'too_large' });
    const res = await post(`/api/file-scans/${scan.id}/release`, 'owner-1', {
      accountId: 'acc-1', reason: '理由',
    });
    expect(res.status).toBe(409);
  });
});

describe('消す', () => {
  it('古い確認では記録も実体も消さず 409、正しい版なら消す', async () => {
    const scan = insertScan({ subject_kind: 'generic_image', subject_id: 'fixture/test-image', media_id: null });
    testDb.raw.prepare('UPDATE media_file_scans SET confirmation_revision=2 WHERE id=?').run(scan.id);
    const stale = await call(`/api/file-scans/${scan.id}?accountId=acc-1&expectedConfirmationRevision=1`, 'owner-1', { method: 'DELETE' });
    expect(stale.status).toBe(409);
    expect(deletedObjects).not.toHaveBeenCalled();
    expect(testDb.raw.prepare('SELECT status FROM media_file_scans WHERE id=?').get(scan.id)).toEqual({ status: 'quarantined' });
    const fresh = await call(`/api/file-scans/${scan.id}?accountId=acc-1&expectedConfirmationRevision=2`, 'owner-1', { method: 'DELETE' });
    expect(fresh.status).toBe(200);
    expect(deletedObjects).toHaveBeenCalledTimes(1);
    expect(testDb.raw.prepare('SELECT id FROM media_file_scans WHERE id=?').get(scan.id)).toBeUndefined();
  });
  it('削除中の別操作と同じ確認の二重押しは通さない', async () => {
    const scan = insertScan({ subject_kind: 'generic_image', subject_id: 'fixture/locked-image', media_id: null });
    let finish!: () => void;
    deletedObjects.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const path = `/api/file-scans/${scan.id}?accountId=acc-1&expectedConfirmationRevision=1`;
    const first = call(path, 'owner-1', { method: 'DELETE' });
    await vi.waitFor(() => expect(deletedObjects).toHaveBeenCalledTimes(1));
    const retry = await post(`/api/file-scans/${scan.id}/retry`, 'owner-1', { accountId: 'acc-1' });
    expect(retry.status).toBe(409);
    expect((await call(path, 'owner-1', { method: 'DELETE' })).status).toBe(409);
    finish();
    expect((await first).status).toBe(200);
    expect(deletedObjects).toHaveBeenCalledTimes(1);
  });
  it('削除中は古い検査処理が使える状態を返さない', async () => {
    const row = insertScan({ subject_kind: 'generic_image', subject_id: 'fixture/scanner-race', media_id: null });
    const scan = testDb.raw.prepare('SELECT * FROM media_file_scans WHERE id=?').get(row.id) as FileScanRow;
    const lock = await claimFileDeletion(testDb.db, `file-scan-delete:scan:${row.id}`, 'owner-1', { id: row.id, accountId: 'acc-1', expected: 1 });
    expect(lock).not.toBeNull();
    try {
      const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0x0d,0x49,0x48,0x44,0x52,0,0,0,1,0,0,0,1,0,0,0,0,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82]);
      const result = await runBuiltinScanAndStore(testDb.db, { ...scan, status: 'pending' }, png, { filename: 'safe.png', mimeType: 'image/png', sizeBytes: png.length, width: 1, height: 1 });
      expect(result.status).toBe('quarantined');
      expect(testDb.raw.prepare('SELECT status FROM media_file_scans WHERE id=?').get(row.id)).toEqual({ status: 'quarantined' });
    } finally { await releaseFileDeletion(testDb.db, lock!); }
  });
  it('削除中は同じ素材の別削除とアップロード先の変更を受け付けない', async () => {
    testDb.raw.prepare("INSERT INTO media(id,line_account_id,kind,filename,mime_type,size_bytes,r2_key) VALUES ('lock-media','acc-1','image','a.png','image/png',100,'fixture/old')").run();
    testDb.raw.prepare("INSERT INTO media_upload_sessions(id,line_account_id,target_media_id,filename,kind,expected_mime,expected_size,r2_key,status,expires_at) VALUES ('lock-session','acc-1','lock-media','a.png','image','image/png',100,'fixture/staged','pending','2099-01-01')").run();
    const scan = insertScan({ subject_kind: 'upload_session', subject_id: 'lock-session', media_id: 'lock-media' });
    const lock = await claimFileDeletion(testDb.db, mediaDeletionLockId('lock-media'), 'owner-1', { id: scan.id, accountId: 'acc-1', expected: 1 });
    expect(lock).not.toBeNull();
    try {
      expect(await claimFileDeletion(testDb.db, mediaDeletionLockId('lock-media'), 'owner-1')).toBeNull();
      const session = await verifyMediaUploadSession(testDb.db, 'lock-session', 'acc-1', 'etag', null, false, 'fixture/new');
      expect(session?.status).toBe('pending');
      expect(session?.r2_key).toBe('fixture/staged');
    } finally { await releaseFileDeletion(testDb.db, lock!); }
  });
  it('削除中の素材差し替えを拒み、差し替え後は古い削除確認を拒む', async () => {
    testDb.raw.prepare("INSERT INTO media(id,line_account_id,kind,filename,mime_type,size_bytes,width,height,r2_key) VALUES ('version-media','acc-1','image','a.png','image/png',100,1,1,'fixture/version-old')").run();
    testDb.raw.prepare("INSERT INTO media_versions(id,media_id,version_no,r2_key,mime_type,size_bytes,width,height,published_at) VALUES ('version-old','version-media',1,'fixture/version-old','image/png',100,1,1,'now')").run();
    testDb.raw.prepare("INSERT INTO media_upload_sessions(id,line_account_id,target_media_id,filename,kind,expected_mime,expected_size,width,height,r2_key,status,expires_at) VALUES ('version-session','acc-1','version-media','a.png','image','image/png',100,1,1,'fixture/version-new','verified','2099-01-01')").run();
    const scan = insertScan({ subject_kind: 'media', subject_id: 'version-media', media_id: 'version-media' });
    const input = { mediaId: 'version-media', lineAccountId: 'acc-1', uploadSessionId: 'version-session', expectedVersionNo: 1, changeReason: '差し替え' };
    const lock = await claimFileDeletion(testDb.db, mediaDeletionLockId('version-media'), 'owner-1', { id: scan.id, accountId: 'acc-1', expected: 1 });
    expect(lock).not.toBeNull();
    try {
      await expect(createMediaVersionFromUpload(testDb.db, input)).rejects.toThrow();
      expect(testDb.raw.prepare("SELECT r2_key FROM media WHERE id='version-media'").get()).toEqual({ r2_key: 'fixture/version-old' });
    } finally { await releaseFileDeletion(testDb.db, lock!); }
    await createMediaVersionFromUpload(testDb.db, input);
    const stale = await call(`/api/file-scans/${scan.id}?accountId=acc-1&expectedConfirmationRevision=1`, 'owner-1', { method: 'DELETE' });
    expect(stale.status).toBe(409);
    expect(deletedObjects).not.toHaveBeenCalled();
  });
  it('実体の削除に失敗したら記録を残して読み直し後に再試行できる', async () => {
    const scan = insertScan({ subject_kind: 'generic_image', subject_id: 'fixture/retry-image', media_id: null });
    deletedObjects.mockRejectedValueOnce(new Error('fixture storage failure'));
    const path = `/api/file-scans/${scan.id}?accountId=acc-1&expectedConfirmationRevision=`;
    expect((await call(`${path}1`, 'owner-1', { method: 'DELETE' })).status).toBe(503);
    expect(testDb.raw.prepare('SELECT status,confirmation_revision FROM media_file_scans WHERE id=?').get(scan.id)).toEqual({ status: 'quarantined', confirmation_revision: 2 });
    expect((await call(`${path}2`, 'owner-1', { method: 'DELETE' })).status).toBe(200);
  });
  it('別アカウントの実体を参照している不正な記録では削除しない', async () => {
    testDb.raw.prepare("INSERT INTO media(id,line_account_id,kind,filename,mime_type,size_bytes,r2_key) VALUES ('foreign-media','acc-2','image','a.png','image/png',100,'fixture/foreign')").run();
    const scan = insertScan({ subject_kind: 'media', subject_id: 'foreign-media', media_id: 'foreign-media' });
    const res = await call(`/api/file-scans/${scan.id}?accountId=acc-1&expectedConfirmationRevision=1`, 'owner-1', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(deletedObjects).not.toHaveBeenCalled();
    expect(testDb.raw.prepare('SELECT confirmation_revision FROM media_file_scans WHERE id=?').get(scan.id)).toEqual({ confirmation_revision: 1 });
  });
  it('しまったものは消せる', async () => {
    const scan = insertScan();
    const res = await call(`/api/file-scans/${scan.id}?accountId=acc-1`, 'owner-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const row = testDb.raw.prepare(`SELECT id FROM media_file_scans WHERE id = ?`).get(scan.id);
    expect(row).toBeUndefined();
  });

  it('使えるものは消せない', async () => {
    const scan = insertScan({ status: 'clean', reason_code: null });
    const res = await call(`/api/file-scans/${scan.id}?accountId=acc-1`, 'owner-1', { method: 'DELETE' });
    expect(res.status).toBe(409);
  });
});

describe('再試行', () => {
  it('連打しても行は1つのまま pending に戻る', async () => {
    const scan = insertScan({ status: 'rejected', reason_code: 'unreadable' });
    for (let i = 0; i < 2; i += 1) {
      const res = await post(`/api/file-scans/${scan.id}/retry`, 'owner-1', { accountId: 'acc-1' });
      expect(res.status).toBe(200);
    }
    const rows = testDb.raw.prepare(`SELECT status FROM media_file_scans WHERE id = ?`).all(scan.id);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { status: string }).status).toBe('pending');
  });
});

describe('止まっている時の表示', () => {
  it('30分以上 pending のままなら止まっていると出す', async () => {
    insertScan({
      status: 'pending', reason_code: null, reason_detail: null, quarantined_at: null,
      created_at: '2026-09-25T08:00:00+09:00', updated_at: '2026-09-25T08:00:00+09:00',
    });
    const res = await get('/api/file-scans/health?accountId=acc-1', 'staff-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { stopped: boolean; pendingCount: number } };
    expect(body.data.stopped).toBe(true);
    expect(body.data.pendingCount).toBe(1);
  });

  it('何も止まっていなければ止まっていないと出す', async () => {
    const res = await get('/api/file-scans/health?accountId=acc-1', 'staff-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { stopped: boolean } };
    expect(body.data.stopped).toBe(false);
  });
});

describe('外の検査の設定', () => {
  it('古い確認の停止では外部検査の設定を変えず 409', async () => {
    const initial = { accountId: 'acc-1', externalProvider: 'example', externalEndpointUrl: 'https://example.com/scan', externalSecretRef: 'FILE_SCAN_SECRET_PRIMARY' };
    expect((await putConfig('/api/file-scans/config', 'owner-1', initial)).status).toBe(200);
    testDb.raw.prepare("UPDATE file_scan_configs SET confirmation_revision=2 WHERE line_account_id='acc-1'").run();
    const res = await putConfig('/api/file-scans/config', 'owner-1', { accountId: 'acc-1', externalProvider: null, externalEndpointUrl: null, externalSecretRef: null, expectedConfirmationRevision: 1 });
    expect(res.status).toBe(409);
    expect((await res.json() as { current: { confirmationRevision: number } }).current.confirmationRevision).toBe(2);
    expect(testDb.raw.prepare("SELECT external_provider FROM file_scan_configs WHERE line_account_id='acc-1'").get()).toEqual({ external_provider: 'example' });
    expect(testDb.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='file_scan.config.update'").get()).toEqual({ n: 1 });
    const fresh = await putConfig('/api/file-scans/config', 'owner-1', { accountId: 'acc-1', externalProvider: null, externalEndpointUrl: null, externalSecretRef: null, expectedConfirmationRevision: 2 });
    expect(fresh.status).toBe(200);
    expect(testDb.raw.prepare("SELECT external_provider,confirmation_revision FROM file_scan_configs WHERE line_account_id='acc-1'").get()).toEqual({ external_provider: null, confirmation_revision: 3 });
  });
  it('版なしの従来の設定変更も版を進めて保存する', async () => {
    const body = { accountId: 'acc-1', externalProvider: null, externalEndpointUrl: null, externalSecretRef: null };
    expect((await putConfig('/api/file-scans/config', 'owner-1', body)).status).toBe(200);
    expect((await putConfig('/api/file-scans/config', 'owner-1', body)).status).toBe(200);
    expect(testDb.raw.prepare("SELECT confirmation_revision FROM file_scan_configs WHERE line_account_id='acc-1'").get()).toEqual({ confirmation_revision: 2 });
  });
  it('同じ確認で停止を二度送っても一度だけ保存する', async () => {
    const body = { accountId: 'acc-1', externalProvider: null, externalEndpointUrl: null, externalSecretRef: null };
    expect((await putConfig('/api/file-scans/config', 'owner-1', body)).status).toBe(200);
    const responses = await Promise.all([putConfig('/api/file-scans/config', 'owner-1', { ...body, expectedConfirmationRevision: 1 }), putConfig('/api/file-scans/config', 'owner-1', { ...body, expectedConfirmationRevision: 1 })]);
    expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
    expect(testDb.raw.prepare("SELECT confirmation_revision FROM file_scan_configs WHERE line_account_id='acc-1'").get()).toEqual({ confirmation_revision: 2 });
  });
  it('http の宛先は断る', async () => {
    const res = await putConfig('/api/file-scans/config', 'owner-1', {
      accountId: 'acc-1',
      externalProvider: 'example',
      externalEndpointUrl: 'http://example.com/scan',
    });
    expect(res.status).toBe(400);
  });

  it('鍵は返さず名前だけ返す', async () => {
    const put = await putConfig('/api/file-scans/config', 'owner-1', {
      accountId: 'acc-1',
      externalProvider: 'example',
      externalEndpointUrl: 'https://example.com/scan',
      externalSecretRef: 'FILE_SCAN_SECRET_PRIMARY',
    });
    expect(put.status).toBe(200);
    const res = await get('/api/file-scans/config?accountId=acc-1', 'owner-1');
    const body = await res.json() as { data: { config: Record<string, unknown> } };
    expect(body.data.config.externalEndpointUrl).toBe('https://example.com/scan');
    expect(body.data.config.externalSecretRef).toBe('FILE_SCAN_SECRET_PRIMARY');
    expect(JSON.stringify(body.data.config)).not.toContain('secret-value');
  });
});

describe('S01 設定の保存境界と監査', () => {
  const valid = { accountId: 'acc-1', externalProvider: 'scanner', externalEndpointUrl: 'https://example.com/scan', externalSecretRef: 'FILE_SCAN_SECRET_PRIMARY' };
  it.each([
    ['ADMIN_API_KEY', 'https://example.com/scan', 'example.com=FILE_SCAN_SECRET_PRIMARY'],
    ['FILE_SCAN_SECRET_PRIMARY', 'https://evil.example.com/scan', 'example.com=FILE_SCAN_SECRET_PRIMARY'],
    ['FILE_SCAN_SECRET_PRIMARY', 'https://example.com/scan', ''],
  ])('古い設定や許可を外した設定は送信停止と返し鍵を読まない: %s / %s / %s', async (name, endpoint, hosts) => {
    allowedPairs = hosts;
    testDb.raw.prepare(`INSERT INTO file_scan_configs(line_account_id,external_provider,external_endpoint_url,external_secret_ref,updated_at) VALUES ('acc-1','scanner',?,?,'2026-10-12')`).run(endpoint, name);
    let reads = 0;
    const bindings = environment();
    Object.defineProperty(bindings, name, { get() { reads++; return 'synthetic-token'; } });
    const res = await app().request('/api/file-scans/config?accountId=acc-1', { headers: { Authorization: 'Bearer key-admin-1' } }, bindings);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { config: Record<string, unknown> } };
    expect(body.data.config.externalEnabled).toBe(false);
    expect(body.data.config.externalSecretRef).toBe(name);
    expect(body.data.config.updatedAt).toBe('2026-10-12');
    expect(reads).toBe(0);
  });
  it('鍵Aと許可済みホストBの混ぜ合わせは400で両欄を示し保存しない', async () => {
    allowedPairs = 'example.com=FILE_SCAN_SECRET_PRIMARY,other.example.com=FILE_SCAN_SECRET_OTHER';
    const res = await putConfig('/api/file-scans/config', 'admin-1', { ...valid, externalEndpointUrl: 'https://other.example.com/scan' });
    expect(res.status).toBe(400);
    const body = await res.json() as { fields: Record<string, string> };
    expect(body.fields.externalEndpointUrl).toContain('組');
    expect(body.fields.externalSecretRef).toContain('組');
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM file_scan_configs').get()).toEqual({ n: 0 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });
  it.each([
    'example.com=FILE_SCAN_SECRET_PRIMARY,other.example.com=FILE_SCAN_SECRET_PRIMARY',
    'example.com=FILE_SCAN_SECRET_PRIMARY,EXAMPLE.COM=FILE_SCAN_SECRET_OTHER',
    '',
  ])('競合または未設定の組では保存400、既存設定はGETで送信停止: %s', async pairs => {
    allowedPairs = pairs;
    const res = await putConfig('/api/file-scans/config', 'admin-1', valid);
    expect(res.status).toBe(400);
    testDb.raw.prepare("INSERT INTO file_scan_configs(line_account_id,external_provider,external_endpoint_url,external_secret_ref,updated_at) VALUES ('acc-1','scanner',?,?,'2026-10-12')").run(valid.externalEndpointUrl, valid.externalSecretRef);
    const body = await (await get('/api/file-scans/config?accountId=acc-1', 'admin-1')).json() as { data: { config: Record<string, unknown> } };
    expect(body.data.config.externalEnabled).toBe(false);
  });
  it('旧ホスト一覧だけでは保存400、既存設定は送信停止、旧変数も鍵も読まない', async () => {
    const bindings = environment();
    delete bindings.FILE_SCAN_ALLOWED_PAIRS;
    let reads = 0;
    for (const name of ['FILE_SCAN_ALLOWED_HOSTS', valid.externalSecretRef]) {
      Object.defineProperty(bindings, name, { get() { reads++; return 'example.com'; } });
    }
    const res = await app().request('/api/file-scans/config', { method: 'PUT', headers: { Authorization: 'Bearer key-admin-1', 'Content-Type': 'application/json' }, body: JSON.stringify(valid) }, bindings);
    expect(res.status).toBe(400);
    testDb.raw.prepare("INSERT INTO file_scan_configs(line_account_id,external_provider,external_endpoint_url,external_secret_ref,updated_at) VALUES ('acc-1','scanner',?,?,'2026-10-12')").run(valid.externalEndpointUrl, valid.externalSecretRef);
    const body = await (await app().request('/api/file-scans/config?accountId=acc-1', { headers: { Authorization: 'Bearer key-admin-1' } }, bindings)).json() as { data: { config: Record<string, unknown> } };
    expect(body.data.config.externalEnabled).toBe(false);
    expect(reads).toBe(0);
  });
  it.each(['ADMIN_API_KEY', 'LINE_CHANNEL_ACCESS_TOKEN', 'STRIPE_SECRET_KEY', 'CLOUDFLARE_API_TOKEN', 'FILE_SCAN_API_KEY', 'FILE_SCAN_SECRET_', 'FILE_SCAN_SECRET_lower', 'FILE_SCAN_SECRET_A-B', 'FILE_SCAN_SECRET_' + 'A'.repeat(120), null, 123])(
    '検査専用でない名前は400で欄を示し保存しない: %s', async (name) => {
      const res = await putConfig('/api/file-scans/config', 'admin-1', { ...valid, externalSecretRef: name });
      expect(res.status).toBe(400);
      const body = await res.json() as { fields: Record<string, string> };
      expect(body.fields.externalSecretRef).toBeTruthy();
      expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM file_scan_configs').get()).toEqual({ n: 0 });
    });
  it.each(['https://evil.example.com', 'https://user:password@example.com', 'https://example.com:8443', 'https://127.0.0.1', 'https://localhost', 'https://scanner.internal', 'https://example.com/' + 'a'.repeat(500), 123])(
    '不許可の宛先は400で宛先欄を示す: %s', async (endpoint) => {
      const res = await putConfig('/api/file-scans/config', 'admin-1', { ...valid, externalEndpointUrl: endpoint });
      expect(res.status).toBe(400);
      const body = await res.json() as { fields: Record<string, string> };
      expect(body.fields.externalEndpointUrl).toBeTruthy();
      expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM file_scan_configs').get()).toEqual({ n: 0 });
    });
  it('秘密値の存在を確認せず保存し、誰・いつ・店・ホストを監査へ残す', async () => {
    // 専用の秘密設定がない事実を、未認証の応答から漏らさない。
    const res = await putConfig('/api/file-scans/config', 'admin-1', { ...valid, externalEndpointUrl: 'https://example.com/scan?private=query' });
    expect(res.status).toBe(200);
    const audit = testDb.raw.prepare("SELECT actor_principal_id, line_account_id, after_json, created_at FROM audit_events WHERE action = 'file_scan.config.update'").get() as Record<string, string>;
    expect(audit?.actor_principal_id).toBe('admin-1');
    expect(audit?.line_account_id).toBe('acc-1');
    expect(JSON.parse(audit.after_json)).toEqual({ endpointHost: 'example.com' });
    expect(audit.created_at).toBeTruthy();
    const getRes = await get('/api/file-scans/config?accountId=acc-1', 'admin-1');
    const body = await getRes.json() as { data: { config: Record<string, unknown> } };
    expect(Object.keys(body.data.config).sort()).toEqual(['confirmationRevision', 'externalEndpointUrl', 'externalProvider', 'externalSecretRef', 'externalEnabled', 'externalTimeoutMs', 'maxBytesOverride', 'maxPixelsOverride', 'updatedAt'].sort());
    expect(body.data.config.externalEnabled).toBe(true);
    expect(body.data.config.updatedAt).toBe(audit.created_at);
  });
  it('外部検査の停止も監査へ残す', async () => {
    const res = await putConfig('/api/file-scans/config', 'owner-1', { accountId: 'acc-1', externalProvider: null, externalEndpointUrl: null, externalSecretRef: null });
    expect(res.status).toBe(200);
    const audit = testDb.raw.prepare("SELECT after_json FROM audit_events WHERE action = 'file_scan.config.update'").get() as { after_json: string };
    expect(JSON.parse(audit.after_json)).toEqual({ endpointHost: null });
  });
  it('環境に鍵があっても保存・GET・監査は値を読まず応答にも出さない', async () => {
    const token = crypto.randomUUID();
    let reads = 0;
    const bindings = environment();
    Object.defineProperty(bindings, valid.externalSecretRef, { get() { reads += 1; return token; } });
    const put = await app().request('/api/file-scans/config', {
      method: 'PUT', headers: { Authorization: 'Bearer key-admin-1', 'Content-Type': 'application/json' }, body: JSON.stringify(valid),
    }, bindings);
    expect(put.status).toBe(200);
    expect((await put.text()).includes(token)).toBe(false);
    const getRes = await app().request('/api/file-scans/config?accountId=acc-1', { headers: { Authorization: 'Bearer key-admin-1' } }, bindings);
    expect(getRes.status).toBe(200);
    expect((await getRes.text()).includes(token)).toBe(false);
    expect(reads).toBe(0);
    const audits = testDb.raw.prepare("SELECT * FROM audit_events WHERE action = 'file_scan.config.update'").all();
    expect(JSON.stringify(audits).includes(token)).toBe(false);
  });
  it.each(['a'.repeat(32) + '.example.com', Array(4).fill('a'.repeat(50)).join('.') + '.com', 'scan-01234567890.example.com', 'scan-81-1234-5678.example.com'])(
    '長い許可ホストも共通監査の保護を緩めず正確に記録する: %s', async (host) => {
      allowedPairs = host + '=FILE_SCAN_SECRET_PRIMARY';
      const res = await putConfig('/api/file-scans/config', 'admin-1', { ...valid, externalEndpointUrl: `https://${host}/scan` });
      expect(res.status).toBe(200);
      const audit = testDb.raw.prepare("SELECT after_json FROM audit_events WHERE action = 'file_scan.config.update'").get() as { after_json: string };
      expect(JSON.parse(audit.after_json).endpointHostParts.flat().join('')).toBe(host);
    });
});
