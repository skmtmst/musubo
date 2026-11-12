import './contents-media-test-mocks.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

class MockCommonVarVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('conflict');
  }
}

class MockMediaVersionConflictError extends Error {
  constructor(readonly currentVersionNo: number) {
    super('conflict');
  }
}

class MockCommonVarFolderError extends Error {
  constructor() {
    super('folder');
  }
}

class MockCommonVarKeyConflictError extends Error {
  constructor() {
    super('key conflict');
  }
}

class MockMediaUsageReferenceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const mocks = {
  recordAuditEvent: vi.fn(async () => undefined),
  getStaffNameMap: vi.fn(async () => new Map()),
  getMedia: vi.fn(),
  countMedia: vi.fn(),
  getMediaById: vi.fn(),
  getFolderById: vi.fn(),
  updateMedia: vi.fn(),
  deleteMedia: vi.fn(),
  getMediaVersionKeys: vi.fn(async () => []),
  archiveMedia: vi.fn(),
  restoreMedia: vi.fn(),
  getMediaUsages: vi.fn(),
  countMediaUsages: vi.fn(),
  getMediaDeleteImpact: vi.fn(),
  getMediaDeleteImpactSnapshot: vi.fn(),
  getMediaReplacementPlan: vi.fn(),
  applyMediaReplacementPlan: vi.fn(),
  getMediaStorageQuota: vi.fn(),
  getMediaVersionList: vi.fn(),
  getMediaVersionByNo: vi.fn(),
  getMediaLiveTarget: vi.fn(),
  getMediaUsageReferenceStates: vi.fn(),
  retargetMediaUsageReference: vi.fn(),
  MediaUsageReferenceError: MockMediaUsageReferenceError,
  MEDIA_REF_KINDS: [
    'template',
    'broadcast',
    'rich_menu',
    'scenario_step',
    'nen_column',
    'event',
    'webinar',
  ],
  createMediaUploadSession: vi.fn(),
  getMediaUploadSession: vi.fn(),
  failMediaUploadSession: vi.fn(),
  verifyMediaUploadSession: vi.fn(),
  completeNewMediaUpload: vi.fn(),
  createMediaVersionFromUpload: vi.fn(),
  getCurrentMediaVersionNo: vi.fn(),
  getLatestMediaVersion: vi.fn(),
  backfillMediaVersionMetadata: vi.fn(),
  MediaVersionConflictError: MockMediaVersionConflictError,
  jstNow: vi.fn(() => '2026-08-31T10:00:00.000+09:00'),
  getCommonVars: vi.fn(),
  countCommonVars: vi.fn(),
  COMMON_VARS_LIST_LIMIT: 200,
  CommonVarFolderError: MockCommonVarFolderError,
  CommonVarKeyConflictError: MockCommonVarKeyConflictError,
  getCommonVarUsageSummaries: vi.fn(),
  getCommonVarById: vi.fn(),
  getCommonVarByIdIncludingArchived: vi.fn(),
  createCommonVar: vi.fn(),
  updateCommonVar: vi.fn(),
  deleteCommonVar: vi.fn(),
  getCommonVarUsageImpact: vi.fn(),
  getCommonVarVersions: vi.fn(),
  getCommonVarReplacementCandidates: vi.fn(),
  getCommonVarReplacementPlan: vi.fn(),
  applyCommonVarReplacementPlan: vi.fn(),
  CommonVarVersionConflictError: MockCommonVarVersionConflictError,
  getCommonVarSchedules: vi.fn(),
  createCommonVarSchedule: vi.fn(),
  deleteCommonVarSchedule: vi.fn(),
  COMMON_VAR_TYPES: ['text', 'url', 'image', 'number', 'long_text', 'date', 'datetime', 'boolean'],
  // 形だけの正規表現では2月30日や24時を通すため、DB と同じ暦日の往復検査を試験用の正規化にも含め、実 Hono 入口を通す。
  normalizeCommonVarValue: (type: string, value: string) => {
    if (type === 'long_text') return value.length <= 10_000 ? value : null;
    if (type === 'boolean') return value === 'true' || value === 'false' ? value : null;
    if (type === 'image') {
      if (value === '') return value;
      return value.length <= 200 && /^https:\/\/\S+$/.test(value) ? value : null;
    }
    if (type === 'url') {
      if (value === '') return value;
      return value.length <= 200 && /^https?:\/\/\S+$/.test(value) ? value : null;
    }
    if (type === 'date' || type === 'datetime') {
      const match = type === 'date'
        ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
        : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
      if (!match) return null;
      const [year, month, day, hour = '00', minute = '00'] = match.slice(1);
      const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
      return at.getUTCFullYear() === Number(year) && at.getUTCMonth() === Number(month) - 1
        && at.getUTCDate() === Number(day) && at.getUTCHours() === Number(hour)
        && at.getUTCMinutes() === Number(minute) ? value : null;
    }
    return value.length <= 200 ? value : null;
  },
  normalizeCommonVarValidityAt: (value: unknown) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') return null;
    const source = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00+09:00` : value;
    const at = new Date(source);
    return Number.isFinite(at.getTime()) ? at.toISOString() : null;
  },
  validateFieldKey: (key: unknown) =>
    typeof key === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(key) && key !== 'name'
      ? { ok: true as const }
      : { ok: false as const, error: 'bad key' },
};
// 純粋な判定ロジック（evaluateMediaVersionCompat やエラークラス）は実物を使い、
// DBへ触る関数だけモックにする。互換判定を形だけのモックにすると、
// ルートが本当に拒否できるか検証できないため。
vi.mock('@line-crm/db', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');
  return { ...actual, ...mocks };
});
const accessMocks = { canAccessAllLineAccounts: vi.fn(async () => true) };
vi.mock('../services/account-access.js', () => accessMocks);
const scanMocks = { scanSingleMediaUsage: vi.fn() };
vi.mock('../features/media/media-usage-scan.js', () => scanMocks);
const signingMocks = { createR2PresignedPutUrl: vi.fn() };
vi.mock('../services/r2-presigned-upload.js', () => signingMocks);
// 門番はここでは空DB向けに差し替え、file-scan-gate.test.tsで実物を見る。
const fileScanServiceMocks = {
  checkMediaGate: vi.fn(async () => ({ allowed: true })),
  getFileScanBySubject: vi.fn(async () => ({ status: 'clean' })),
  getMediaGateInfo: vi.fn(async () => ({ lineAccountId: 'acc-1', sizeBytes: 100, width: 1, height: 1 })),
  runScanForStoredObject: vi.fn(async (_db: unknown, _store: unknown, scan: { id: string }) => scan),
};
vi.mock('../services/file-scan.js', () => fileScanServiceMocks);
vi.mock('./file-scan.js', () => ({
  ensureFileScanForUpload: vi.fn(async () => ({ id: 'scan-test-1' })),
}));

const { contents } = await import('./contents.js');
// 実物のエラークラス（モックは actual を引き継ぐので本物の instanceof が効く）
const { MediaVersionIncompatibleError } = await import('@line-crm/db');

// R2 の put/delete は実装の .catch に合わせて Promise を返す。
const put = vi.fn().mockResolvedValue(undefined);
const del = vi.fn().mockResolvedValue(undefined);
const head = vi.fn();
const get = vi.fn();
const env = {
  DB: { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 1 } }) }) }), batch: async () => [] } as unknown as D1Database,
  IMAGES: { put, delete: del, head, get } as unknown as R2Bucket,
  WORKER_URL: 'https://api.example.com',
  CF_ACCOUNT_ID: 'cf-account',
  MEDIA_R2_ACCESS_KEY_ID: 'access-key',
  MEDIA_R2_SECRET_ACCESS_KEY: 'secret-key',
  MEDIA_R2_BUCKET_NAME: 'media-bucket',
};

function makeApp(role: 'owner' | 'admin' | 'staff' | null = 'owner') {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (role) c.set('staff', { id: 'u-1', name: 'テスト', role, readOnly: false });
    return next();
  });
  app.route('/', contents);
  return app;
}

function req(
  path: string,
  method: string,
  body?: unknown,
  role: 'owner' | 'admin' | 'staff' | null = 'owner',
  ifMatch: string | null = '1',
) {
  return makeApp(role).fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(ifMatch && method === 'PATCH' && path.startsWith('/api/media/') ? { 'If-Match': ifMatch } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env as unknown as Env['Bindings'],
  );
}

const MEDIA = {
  id: 'md-1',
  line_account_id: 'account-1',
  folder_id: null,
  kind: 'image',
  filename: 'a.png',
  mime_type: 'image/png',
  size_bytes: 100,
  width: 100,
  height: 50,
  duration_ms: null,
  r2_key: 'media/xxx.png',
  public_url: null,
  uploaded_by: 'u-1',
  created_at: '2026-08-16',
  usage_count: 3,
};

const QUOTA = {
  usageBytes: 100,
  reservedBytes: 0,
  limitBytes: 1000,
  remainingBytes: 900,
  usageRate: 0.1,
  state: 'normal',
};

const UPLOAD_SESSION = {
  id: 'upload-1',
  line_account_id: 'account-1',
  target_media_id: null,
  result_media_id: null,
  folder_id: null,
  filename: 'a.png',
  kind: 'image',
  expected_mime: 'image/png',
  expected_size: 8,
  r2_key: 'media/account-1/final/a.png',
  status: 'pending',
  failure_code: null,
  etag: null,
  width: 100,
  height: 50,
  duration_ms: null,
  page_count: null,
  codec: null,
  expires_at: '2099-01-01T00:00:00.000Z',
  created_by: 'u-1',
  created_at: '2026-09-07T00:00:00.000Z',
  completed_at: null,
};

const DELETE_IMPACT = {
  media: { id: 'md-1', filename: 'a.png', kind: 'image' },
  usageCount: 0,
  references: [],
  checkedAt: '2026-08-31T10:00:00.000',
  lastScannedAt: null,
  canDelete: true,
  recommendedAction: 'delete',
};

const REPLACEMENT_PLAN = {
  source: MEDIA,
  replacement: {
    ...MEDIA,
    id: 'md-2',
    filename: 'b.png',
    r2_key: 'media/yyy.png',
  },
  usages: [{
    media_id: 'md-1',
    ref_kind: 'template',
    ref_id: 'template-1',
    scanned_at: '2026-08-31T10:00:00.000',
  }],
  impact: {
    source: { id: 'md-1', filename: 'a.png', kind: 'image' },
    replacement: { id: 'md-2', filename: 'b.png', kind: 'image' },
    usageCount: 1,
    replaceableCount: 1,
    references: [{
      kind: 'template',
      name: '来店後のご案内',
      href: '/templates/edit?id=template-1',
      state: 'available',
      scannedAt: '2026-08-31T10:00:00.000',
      replaceable: true,
      blocker: null,
      reason: null,
    }],
    blockers: [],
    canReplace: true,
    canPartiallyReplace: true,
    blockedCount: 0,
    blockedByKind: {},
    checkedAt: '2026-08-31T10:00:00.000+09:00',
  },
};

const VAR = {
  id: 'cv-1',
  line_account_id: 'account-1',
  folder_id: null,
  name: '営業時間',
  var_key: 'shop_hours',
  type: 'text',
  value: '10-19',
  memo: '店舗共通の営業時間',
  version: 3,
  updated_by: 'u-1',
  archived_at: null,
  replacement_run_id: null,
  created_at: '2026-08-16',
  updated_at: '2026-08-16',
};

const EMPTY_COMMON_VAR_IMPACT = {
  total: 0,
  blockingTotal: 0,
  historicalTotal: 0,
  sendingFixedTotal: 0,
  unscopedFormTotal: 0,
  byKind: {
    template: 0,
    broadcast: 0,
    scenario: 0,
    reminder: 0,
    auto_reply: 0,
    form: 0,
    automation: 0,
    friend_add: 0,
    common_action: 0,
  },
  items: [],
};

/** 1x1 の PNG。中身は問わないので短い base64 で足りる。 */
const TINY_PNG = 'iVBORw0KGgo=';

/** 640x480 の PNG 先頭（シグネチャ＋IHDR）。寸法の実測に使う。 */
const PNG_640x480_PREFIX = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x02, 0x80, 0x00, 0x00, 0x01, 0xe0,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue(undefined);
  del.mockResolvedValue(undefined);
  head.mockResolvedValue({
    size: 8,
    etag: 'etag-1',
    httpMetadata: { contentType: 'image/png' },
    customMetadata: {
      'line-account-id': 'account-1',
      'upload-session-id': 'upload-1',
    },
  });
  get.mockResolvedValue({
    body: new Blob([PNG_640x480_PREFIX]).stream(),
    arrayBuffer: async () => PNG_640x480_PREFIX.buffer.slice(0),
  });
  accessMocks.canAccessAllLineAccounts.mockResolvedValue(true);
  scanMocks.scanSingleMediaUsage.mockResolvedValue({ scanned: 1, matched: 0, pruned: 0 });
  mocks.getMedia.mockResolvedValue([MEDIA]);
  mocks.countMedia.mockResolvedValue(1);
  mocks.getMediaById.mockResolvedValue(MEDIA);
  mocks.getFolderById.mockResolvedValue({
    id: 'folder-1', kind: 'media', account_id: 'account-1', name: '配信用',
  });
  mocks.updateMedia.mockResolvedValue(MEDIA);
  mocks.countMediaUsages.mockResolvedValue(0);
  mocks.getMediaUsages.mockResolvedValue([]);
  mocks.getMediaDeleteImpact.mockResolvedValue(DELETE_IMPACT);
  mocks.getMediaDeleteImpactSnapshot.mockResolvedValue({ impact: DELETE_IMPACT, usages: [] });
  mocks.getMediaReplacementPlan.mockResolvedValue(REPLACEMENT_PLAN);
  mocks.applyMediaReplacementPlan.mockResolvedValue({
    changedRows: 1,
    appliedUsageCount: 1,
    skippedUsageCount: 0,
    mode: 'all',
  });
  mocks.getMediaStorageQuota.mockResolvedValue(QUOTA);
  mocks.getMediaVersionList.mockResolvedValue([]);
  mocks.getLatestMediaVersion.mockResolvedValue(null);
  mocks.backfillMediaVersionMetadata.mockResolvedValue(undefined);
  mocks.getMediaUsageReferenceStates.mockResolvedValue([]);
  mocks.getMediaLiveTarget.mockResolvedValue(null);
  mocks.retargetMediaUsageReference.mockResolvedValue({
    changed: true,
    state: { mode: 'live', versionNo: null },
  });
  mocks.createMediaUploadSession.mockResolvedValue(UPLOAD_SESSION);
  mocks.getMediaUploadSession.mockResolvedValue(UPLOAD_SESSION);
  mocks.verifyMediaUploadSession.mockResolvedValue({
    ...UPLOAD_SESSION, status: 'verified', etag: 'etag-1',
  });
  mocks.completeNewMediaUpload.mockResolvedValue(MEDIA);
  mocks.createMediaVersionFromUpload.mockResolvedValue({
    id: 'version-2', media_id: 'md-1', version_no: 2,
    mime_type: 'image/png', size_bytes: 8, change_reason: 'ロゴを更新',
    created_at: '2026-09-07T00:00:00.000Z',
  });
  mocks.getCurrentMediaVersionNo.mockResolvedValue(1);
  signingMocks.createR2PresignedPutUrl.mockResolvedValue({
    url: 'https://r2.example.com/upload?signature=hidden',
    headers: {
      'Content-Type': 'image/png',
      'x-amz-meta-line-account-id': 'account-1',
      'x-amz-meta-upload-session-id': 'upload-1',
    },
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  mocks.getCommonVars.mockResolvedValue([VAR]);
  mocks.countCommonVars.mockResolvedValue(1);
  mocks.getCommonVarUsageSummaries.mockResolvedValue(new Map([['shop_hours', {
    total: 3,
    byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, template: 2, broadcast: 1 },
  }]]));
  mocks.getCommonVarById.mockImplementation(async (_db: D1Database, id: string) =>
    id === 'cv-2'
      ? { ...VAR, id: 'cv-2', name: '新営業時間', var_key: 'new_hours', value: '11-20', version: 1 }
      : VAR);
  mocks.getCommonVarByIdIncludingArchived.mockImplementation(
    async (_db: D1Database, id: string) => id === 'missing' ? null : VAR,
  );
  mocks.createCommonVar.mockResolvedValue(VAR);
  mocks.updateCommonVar.mockResolvedValue(VAR);
  mocks.getCommonVarUsageImpact.mockResolvedValue(EMPTY_COMMON_VAR_IMPACT);
  mocks.getCommonVarVersions.mockResolvedValue([{
    id: 'cv-1-v3', common_var_id: 'cv-1', version_no: 3,
    name: '営業時間', value: '10-19', memo: '店舗共通の営業時間',
    change_reason: '営業時間を更新', actor_id: 'u-1', actor_name: '見本 145', created_at: '2026-08-16',
  }]);
  mocks.getCommonVarReplacementCandidates.mockResolvedValue([{
    ...VAR, id: 'cv-2', name: '新営業時間', var_key: 'new_hours', value: '11-20', version: 1,
  }]);
  mocks.getCommonVarReplacementPlan.mockResolvedValue({
    source: VAR,
    replacement: { ...VAR, id: 'cv-2', name: '新営業時間', var_key: 'new_hours', version: 1 },
    targets: [{
      table: 'templates', id: 'template-1', kind: 'template',
      columns: { message_content: '{{var.new_hours}}' },
      originalColumns: { message_content: '{{var.shop_hours}}' },
      fingerprint: '{{var.shop_hours}}',
    }],
    usageTotal: 1,
    replaceableTotal: 1,
    blockedTotal: 0,
    historicalTotal: 0,
    unscopedFormTotal: 0,
  });
  mocks.applyCommonVarReplacementPlan.mockResolvedValue({
    runId: 'replace-1', replacedUsageCount: 1, archivedVersion: 4,
  });
  mocks.createCommonVarSchedule.mockResolvedValue({
    id: 'sc-1',
    var_id: 'cv-1',
    effective_from: '2099-01-01T00:00',
    value: 'x',
    applied_at: null,
  });
});

describe('メディアのアップロード', () => {
  it('詳細URL用の1件取得はaccount条件を付けてメディアと分類名を返す', async () => {
    mocks.getMediaById.mockResolvedValueOnce({ ...MEDIA, folder_id: 'folder-1' });
    const res = await req('/api/media/md-1?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(mocks.getMediaById).toHaveBeenCalledWith(env.DB, 'md-1', 'account-1');
    expect(await res.json()).toMatchObject({
      data: {
        item: { id: 'md-1', lineAccountId: 'account-1', filename: 'a.png' },
        folderName: '配信用',
      },
    });
  });

  it.each(['unknown-id', 'deleted-id'])('%s の詳細は同じ404で安全に拒否する', async (id) => {
    mocks.getMediaById.mockResolvedValueOnce(null);
    const res = await req(`/api/media/${id}?accountId=account-1`, 'GET');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'Not found' });
  });

  it('別accountの実在IDと架空IDは同じ404になり、行の内容を返さない', async () => {
    mocks.getMediaById.mockResolvedValue(null);
    const crossAccount = await req('/api/media/account-2-media?accountId=account-1', 'GET');
    const unknown = await req('/api/media/unknown?accountId=account-1', 'GET');
    expect(crossAccount.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await crossAccount.json()).toEqual(await unknown.json());
    expect(mocks.getMediaById).toHaveBeenNthCalledWith(1, env.DB, 'account-2-media', 'account-1');
    expect(mocks.getMediaById).toHaveBeenNthCalledWith(2, env.DB, 'unknown', 'account-1');
  });

  it('閲覧範囲外accountはメディアを探す前に404へそろえる', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const res = await req('/api/media/md-1?accountId=account-2', 'GET');
    expect(res.status).toBe(404);
    expect(mocks.getMediaById).not.toHaveBeenCalled();
  });

  it('staffは管理詳細を取得できず、メディアを探さない', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'GET', undefined, 'staff');
    expect(res.status).toBe(403);
    expect(mocks.getMediaById).not.toHaveBeenCalled();
  });

  it('一覧に使用先件数を含める', async () => {
    const res = await req('/api/media?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ usageCount: number }>; total: number } };
    expect(body.data.items[0]?.usageCount).toBe(3);
    expect(body.data.total).toBe(1);
    expect(mocks.getMedia).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-1',
      kind: undefined,
      folderId: undefined,
      excludeId: undefined,
      query: undefined,
      unusedOnly: false,
      nearLimitOnly: false,
      sort: 'newest',
      limit: 20,
      offset: 0,
    });
  });

  it('R35: 一覧は入れた人の表示名を添え、IDをそのまま出さない', async () => {
    mocks.getStaffNameMap.mockResolvedValueOnce(new Map([['u-1', '見本 145']]));
    const res = await req('/api/media?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Array<{ uploadedBy: string; uploadedByName: string | null }> };
    };
    expect(body.data.items[0]?.uploadedBy).toBe('u-1');
    expect(body.data.items[0]?.uploadedByName).toBe('見本 145');
  });

  it('R35: 退職・削除済みで引けない入れた人は null で返し、画面が言葉にする', async () => {
    mocks.getStaffNameMap.mockResolvedValueOnce(new Map());
    const res = await req('/api/media/md-1?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { item: { uploadedBy: string; uploadedByName: string | null } } };
    expect(body.data.item.uploadedBy).toBe('u-1');
    expect(body.data.item.uploadedByName).toBeNull();
  });

  it('LINEアカウントを指定しない一覧取得は止める', async () => {
    const res = await req('/api/media', 'GET');
    expect(res.status).toBe(400);
    expect(mocks.getMedia).not.toHaveBeenCalled();
  });

  it('権限のないLINEアカウントは存在も返さない', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValue(false);
    const res = await req('/api/media?accountId=other', 'GET');
    expect(res.status).toBe(404);
    expect(mocks.getMedia).not.toHaveBeenCalled();
  });

  it('未使用のbase64登録口は閉じ、直接アップロード口だけを残す', async () => {
    const res = await req('/api/media', 'POST', {
      accountId: 'account-1', filename: 'a.png', mimeType: 'image/png', data: TINY_PNG,
    });
    expect(res.status).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });

  it('未使用の単独使用先口は閉じ、削除影響口へ一本化する', async () => {
    const res = await req('/api/media/md-1/usages?accountId=account-1', 'GET');
    expect(res.status).toBe(404);
    expect(mocks.getMediaUsages).not.toHaveBeenCalled();
  });
});

describe('メディアの容量・直接アップロード・版', () => {
  it.each([
    ['normal', 0.5],
    ['notice', 0.8],
    ['warning', 0.9],
    ['full', 1],
  ])('容量の%s状態を固定値にせず返す', async (state, usageRate) => {
    mocks.getMediaStorageQuota.mockResolvedValueOnce({ ...QUOTA, state, usageRate });
    const res = await req('/api/media/quota?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { state, usageRate, limitBytes: 1000 } });
  });

  it('最大20件のR2直接PUT用セッションを作る', async () => {
    mocks.getMediaStorageQuota.mockResolvedValueOnce({
      ...QUOTA, limitBytes: 1024 * 1024 * 1024, remainingBytes: 1024 * 1024 * 1024,
    });
    const res = await req('/api/media/upload-sessions', 'POST', {
      accountId: 'account-1',
      files: [{ filename: 'movie.mp4', mimeType: 'video/mp4', sizeBytes: 200 * 1024 * 1024 }],
    }, 'staff');
    expect(res.status).toBe(201);
    expect(mocks.createMediaUploadSession).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      lineAccountId: 'account-1', kind: 'video', sizeBytes: 200 * 1024 * 1024,
    }));
    expect(await res.json()).toMatchObject({
      data: { sessions: [{ method: 'PUT', uploadUrl: expect.stringContaining('https://') }] },
    });
  });

  it('容量超過はR2セッションを作らず409にする', async () => {
    mocks.getMediaStorageQuota.mockResolvedValueOnce({ ...QUOTA, remainingBytes: 7 });
    const res = await req('/api/media/upload-sessions', 'POST', {
      accountId: 'account-1',
      files: [{ filename: 'a.png', mimeType: 'image/png', sizeBytes: 8 }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'media_quota_exceeded' });
    expect(mocks.createMediaUploadSession).not.toHaveBeenCalled();
  });

  it('担当者情報がなければアップロードと版追加を403で止める', async () => {
    expect((await req('/api/media/upload-sessions', 'POST', {
      accountId: 'account-1',
      files: [{ filename: 'a.png', mimeType: 'image/png', sizeBytes: 8 }],
    }, null)).status).toBe(403);
    expect((await req('/api/media/md-1/versions', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1', previewToken: 'preview-1',
      changeReason: '更新',
    }, null)).status).toBe(403);
  });

  it('R2実体をHEAD・メタデータ・シグネチャで確認して新規登録する', async () => {
    const res = await req('/api/media/upload-sessions/upload-1/complete', 'POST', {
      accountId: 'account-1', etag: '"etag-1"',
    });
    expect(res.status).toBe(201);
    expect(head).toHaveBeenCalledWith('private/media-uploads/upload-1');
    expect(get).toHaveBeenCalledWith('private/media-uploads/upload-1', {
      range: { offset: 0, length: 256 * 1024 }, onlyIf: { etagMatches: 'etag-1' },
    });
    expect(mocks.verifyMediaUploadSession).toHaveBeenCalledWith(
      env.DB, 'upload-1', 'account-1', 'etag-1',
      { width: 640, height: 480 }, true, expect.stringMatching(/^media\/account-1\/final\//),
    );
    expect(mocks.completeNewMediaUpload).toHaveBeenCalled();
  });

  it('R2実体がセッションと違えば公開済みコピーを削除せず409にする', async () => {
    head.mockResolvedValueOnce({
      size: 9,
      etag: 'etag-1',
      httpMetadata: { contentType: 'image/png' },
      customMetadata: {
        'line-account-id': 'account-1',
        'upload-session-id': 'upload-1',
      },
    });
    const res = await req('/api/media/upload-sessions/upload-1/complete', 'POST', {
      accountId: 'account-1', etag: 'etag-1',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'media_upload_mismatch' });
    expect(mocks.failMediaUploadSession).toHaveBeenCalledWith(
      env.DB, 'upload-1', 'account-1', 'object_mismatch',
    );
    expect(del).not.toHaveBeenCalled();
  });

  it('既存メディア用は確認済みで止め、版APIで不変の次版を作る', async () => {
    mocks.getMediaUploadSession.mockResolvedValueOnce({
      ...UPLOAD_SESSION, target_media_id: 'md-1',
    });
    mocks.verifyMediaUploadSession.mockResolvedValueOnce({
      ...UPLOAD_SESSION, target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
    });
    const complete = await req('/api/media/upload-sessions/upload-1/complete', 'POST', {
      accountId: 'account-1', etag: 'etag-1',
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({
      data: { status: 'verified', targetMediaId: 'md-1' },
    });
    expect(mocks.completeNewMediaUpload).not.toHaveBeenCalled();

    mocks.getMediaUploadSession.mockResolvedValue({
      ...UPLOAD_SESSION, target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
    });
    const previewResponse = await req('/api/media/md-1/replacement-preview', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
    });
    const preview = (await previewResponse.json()) as { data: { previewToken: string } };
    expect(previewResponse.status).toBe(200);
    expect(preview.data.previewToken).toMatch(/^[0-9a-f]{64}$/);

    const version = await req('/api/media/md-1/versions', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1', previewToken: preview.data.previewToken,
      changeReason: 'ロゴを更新',
    });
    expect(version.status).toBe(201);
    expect(await version.json()).toMatchObject({ data: { mediaId: 'md-1', versionNo: 2 } });
  });

  it('版が先に進んでいれば現在版を添えて409にする', async () => {
    mocks.getMediaUploadSession.mockResolvedValue({
      ...UPLOAD_SESSION, target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
    });
    const previewResponse = await req('/api/media/md-1/replacement-preview', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
    });
    const preview = (await previewResponse.json()) as { data: { previewToken: string } };
    mocks.createMediaVersionFromUpload.mockRejectedValueOnce(new MockMediaVersionConflictError(3));
    const res = await req('/api/media/md-1/versions', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1', previewToken: preview.data.previewToken,
      changeReason: 'ロゴを更新',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'media_version_conflict', currentVersionNo: 3,
    });
  });

  it('予約へ内容情報を載せ、形式の合わない値は400で拒否する', async () => {
    const ok = await req('/api/media/upload-sessions', 'POST', {
      accountId: 'account-1',
      files: [{
        filename: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 100,
        metadata: { durationMs: 5000, codec: 'avc1' },
      }],
    });
    expect(ok.status).toBe(201);
    expect(mocks.createMediaUploadSession).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      metadata: {
        width: null, height: null, duration_ms: 5000, page_count: null, codec: 'avc1',
      },
    }));

    const bad = await req('/api/media/upload-sessions', 'POST', {
      accountId: 'account-1',
      files: [{
        filename: 'a.mp4', mimeType: 'video/mp4', sizeBytes: 100,
        metadata: { durationMs: '5秒' },
      }],
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'media_file_invalid' });
  });

  it('寸法が違う差し替えはプレビューで拒否し、理由と内容情報を返す', async () => {
    mocks.getMediaUploadSession.mockResolvedValue({
      ...UPLOAD_SESSION,
      target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
      width: 200, height: 100,
    });
    const res = await req('/api/media/md-1/replacement-preview', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        canReplace: boolean;
        blockers: string[];
        currentMetadata: { width: number | null };
        incomingMetadata: { width: number | null };
        previewToken: string;
      };
    };
    expect(body.data.canReplace).toBe(false);
    expect(body.data.blockers).toContain('incompatible_dimensions');
    expect(body.data.currentMetadata).toMatchObject({ width: 100, height: 50 });
    expect(body.data.incomingMetadata).toMatchObject({ width: 200, height: 100 });

    // 拒否されたプレビューのトークンでは版を作れない
    const version = await req('/api/media/md-1/versions', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
      previewToken: body.data.previewToken, changeReason: '差し替え',
    });
    expect(version.status).toBe(409);
    expect(mocks.createMediaVersionFromUpload).not.toHaveBeenCalled();
  });

  it('判定材料が足りない差し替えは互換とみなさず明示的に拒否する', async () => {
    mocks.getMediaUploadSession.mockResolvedValue({
      ...UPLOAD_SESSION,
      target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
      width: null, height: null,
    });
    const res = await req('/api/media/md-1/replacement-preview', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
    });
    const body = await res.json() as { data: { canReplace: boolean; blockers: string[] } };
    expect(body.data.canReplace).toBe(false);
    expect(body.data.blockers).toContain('metadata_missing');
  });

  it('内容情報の無い旧メディアは実体から寸法を測って補い、互換なら版を作れる', async () => {
    // 旧データ: メディアにも版にも寸法が記録されていない
    mocks.getMediaById.mockResolvedValue({ ...MEDIA, width: null, height: null });
    mocks.getMediaUploadSession.mockResolvedValue({
      ...UPLOAD_SESSION,
      target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
      width: 640, height: 480,
    });
    const res = await req('/api/media/md-1/replacement-preview', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
    });
    const body = await res.json() as { data: { canReplace: boolean; blockers: string[] } };
    // 保存済みオブジェクトの先頭から 640x480 を実測して補完する
    expect(get).toHaveBeenCalledWith(MEDIA.r2_key, {
      range: { offset: 0, length: 256 * 1024 },
    });
    expect(mocks.backfillMediaVersionMetadata).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ id: 'md-1' }),
      null,
      { width: 640, height: 480 },
    );
    expect(body.data.blockers).toEqual([]);
    expect(body.data.canReplace).toBe(true);
  });

  it('実体からも測れない旧メディアは判定材料不足で拒否する', async () => {
    mocks.getMediaById.mockResolvedValue({ ...MEDIA, width: null, height: null });
    get.mockResolvedValueOnce({
      arrayBuffer: async () => new Uint8Array([0x89, 0x50]).buffer,
    });
    mocks.getMediaUploadSession.mockResolvedValue({
      ...UPLOAD_SESSION,
      target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
      width: 640, height: 480,
    });
    const res = await req('/api/media/md-1/replacement-preview', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
    });
    const body = await res.json() as { data: { canReplace: boolean; blockers: string[] } };
    expect(body.data.canReplace).toBe(false);
    expect(body.data.blockers).toContain('metadata_missing');
    expect(mocks.backfillMediaVersionMetadata).not.toHaveBeenCalled();
  });

  it('プレビュー後に内容情報が変わるとトークンが無効になり版を作れない', async () => {
    mocks.getMediaUploadSession.mockResolvedValue({
      ...UPLOAD_SESSION, target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
    });
    const previewResponse = await req('/api/media/md-1/replacement-preview', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
    });
    const preview = (await previewResponse.json()) as {
      data: { canReplace: boolean; previewToken: string };
    };
    expect(preview.data.canReplace).toBe(true);

    // プレビュー後に別ファイルへすり替わったセッションを再現する。
    // duration_ms は画像の互換判定に効かないため、トークンへ内容情報を
    // 混ぜていなければ古いトークンが通ってしまう。
    mocks.getMediaUploadSession.mockResolvedValue({
      ...UPLOAD_SESSION, target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
      duration_ms: 1234,
    });
    const res = await req('/api/media/md-1/versions', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
      previewToken: preview.data.previewToken, changeReason: '差し替え',
    });
    expect(res.status).toBe(409);
    expect(mocks.createMediaVersionFromUpload).not.toHaveBeenCalled();
  });

  it('プレビューを飛ばした書き込み側の互換拒否も409で理由を返す', async () => {
    mocks.getMediaUploadSession.mockResolvedValue({
      ...UPLOAD_SESSION, target_media_id: 'md-1', status: 'verified', etag: 'etag-1',
    });
    const previewResponse = await req('/api/media/md-1/replacement-preview', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
    });
    const preview = (await previewResponse.json()) as { data: { previewToken: string } };
    mocks.createMediaVersionFromUpload.mockRejectedValueOnce(
      new MediaVersionIncompatibleError(['incompatible_dimensions']),
    );
    const res = await req('/api/media/md-1/versions', 'POST', {
      accountId: 'account-1', uploadSessionId: 'upload-1',
      previewToken: preview.data.previewToken, changeReason: '差し替え',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'media_replacement_blocked',
      data: { blockers: ['incompatible_dimensions'] },
    });
  });
});

describe('メディアの削除', () => {
  it('影響確認は使用先の名前と導線を返す', async () => {
    mocks.getMediaDeleteImpactSnapshot.mockResolvedValue({ impact: {
      ...DELETE_IMPACT,
      usageCount: 1,
      canDelete: false,
      recommendedAction: 'review_references',
      lastScannedAt: '2026-08-31T10:00:00.000',
      references: [{
        kind: 'broadcast',
        name: '来店後のご案内',
        href: '/broadcasts/detail?id=broadcast-1',
        state: 'available',
        scannedAt: '2026-08-31T10:00:00.000',
      }],
    }, usages: [{ media_id: 'md-1', ref_kind: 'broadcast', ref_id: 'broadcast-1', scanned_at: '2026-08-31T10:00:00.000' }] });
    const res = await req('/api/media/md-1/delete-impact?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        usageCount: 1,
        references: [{ name: '来店後のご案内' }],
        canDelete: false,
        verified: true,
      },
    });
  });
  it('R34: 表が無い読み口があっても503にせず、未確認として返す', async () => {
    scanMocks.scanSingleMediaUsage.mockResolvedValueOnce({ scanned: 1, matched: 0, pruned: 0, skippedTables: ['webinars'] });
    mocks.getMediaDeleteImpactSnapshot.mockResolvedValueOnce({ impact: DELETE_IMPACT, usages: [] });
    const res = await req('/api/media/md-1/delete-impact?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        usageCount: 0,
        verified: false,
        canDelete: false,
        recommendedAction: 'review_references',
      },
    });
  });
  it('走査が途中で使用先を更新しても、同じsnapshotのIDだけを一覧へ結合する', async () => {
    mocks.getMediaDeleteImpactSnapshot.mockResolvedValue({
      impact: {
        ...DELETE_IMPACT,
        usageCount: 1,
        canDelete: false,
        references: [{
          kind: 'template', name: '固定された参照先', href: '/templates/edit?id=template-stable',
          state: 'available', scannedAt: '2026-08-31T10:00:00.000',
        }],
      },
      usages: [{
        media_id: 'md-1', ref_kind: 'template', ref_id: 'template-stable',
        scanned_at: '2026-08-31T10:00:00.000',
      }],
    });
    // 旧実装なら二度目の読込でこの別IDをindex結合してしまう。
    mocks.getMediaUsages.mockResolvedValue([{ media_id: 'md-1', ref_kind: 'broadcast', ref_id: 'newer-row' }]);
    mocks.getMediaUsageReferenceStates.mockResolvedValue([{ mode: 'pinned', versionNo: 1 }]);
    const res = await req('/api/media/md-1/delete-impact?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { references: [{ refKind: 'template', refId: 'template-stable' }] },
    });
    expect(mocks.getMediaUsages).not.toHaveBeenCalled();
  });
  it('影響を取得できないときは0件を作らず503', async () => {
    scanMocks.scanSingleMediaUsage.mockRejectedValueOnce(new Error('D1 unavailable'));
    const res = await req('/api/media/md-1/delete-impact?accountId=account-1', 'GET');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      error: '削除したときの影響を確認できませんでした',
    });
  });

  it('使われていれば最新の影響を返して止める', async () => {
    mocks.getMediaDeleteImpactSnapshot.mockResolvedValue({
      impact: {
        ...DELETE_IMPACT,
        usageCount: 5,
        canDelete: false,
        recommendedAction: 'review_references',
      },
      usages: [],
    });
    const res = await req('/api/media/md-1?accountId=account-1', 'DELETE');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; data: { usageCount: number; verified: boolean } };
    expect(body.code).toBe('media_delete_blocked');
    expect(body.data.usageCount).toBe(5);
    expect(body.data.verified).toBe(true);
    expect(mocks.deleteMedia).not.toHaveBeenCalled();
  });

  it('force=1 を付けても使用中は消さない', async () => {
    mocks.getMediaDeleteImpactSnapshot.mockResolvedValue({
      impact: {
        ...DELETE_IMPACT,
        usageCount: 5,
        canDelete: false,
        recommendedAction: 'review_references',
      },
      usages: [],
    });
    const res = await req('/api/media/md-1?accountId=account-1&force=1', 'DELETE');
    expect(res.status).toBe(409);
    expect(mocks.deleteMedia).not.toHaveBeenCalled();
  });

  it('R34: 読み残しがあるときは未確認として止め、確かめられないものは消さない', async () => {
    scanMocks.scanSingleMediaUsage.mockResolvedValueOnce({ scanned: 1, matched: 0, pruned: 0, skippedTables: ['webinars'] });
    mocks.getMediaDeleteImpactSnapshot.mockResolvedValueOnce({ impact: DELETE_IMPACT, usages: [] });
    const res = await req('/api/media/md-1?accountId=account-1', 'DELETE');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; data: { verified: boolean; canDelete: boolean } };
    expect(body.code).toBe('media_delete_unverified');
    expect(body.data.verified).toBe(false);
    expect(body.data.canDelete).toBe(false);
    expect(mocks.deleteMedia).not.toHaveBeenCalled();
  });

  it('削除時に影響を読み直せなければ削除しない', async () => {
    scanMocks.scanSingleMediaUsage.mockRejectedValueOnce(new Error('D1 unavailable'));
    const res = await req('/api/media/md-1?accountId=account-1', 'DELETE');
    expect(res.status).toBe(503);
    expect(mocks.deleteMedia).not.toHaveBeenCalled();
  });

  it('実体の削除後に、占有した操作としてDBの行を消す', async () => {
    await req('/api/media/md-1?accountId=account-1', 'DELETE');
    expect(mocks.deleteMedia).toHaveBeenCalledWith(env.DB, 'md-1', 'account-1', expect.objectContaining({ lockId: 'file-scan-delete:media:md-1', r2Key: MEDIA.r2_key }));
    expect(del.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteMedia.mock.invocationCallOrder[0]);
  });
  it('検査ファイルの削除と競合した素材は保管庫に触れない', async () => {
    const batch = vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('malformed JSON'));
    const res = await req('/api/media/md-1?accountId=account-1', 'DELETE'); batch.mockRestore();
    expect(res.status).toBe(409); expect(del).not.toHaveBeenCalled(); expect(mocks.deleteMedia).not.toHaveBeenCalled();
  });
});

describe('#550 M6 メディアの名前・フォルダ変更の検証', () => {
  it('空のファイル名は保存しない', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: '   ' });
    expect(res.status).toBe(400);
    expect(mocks.updateMedia).not.toHaveBeenCalled();
  });

  it('255文字を超えるファイル名は保存しない', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: `${'あ'.repeat(256)}.png` });
    expect(res.status).toBe(400);
    expect(mocks.updateMedia).not.toHaveBeenCalled();
  });

  it('制御文字を含むファイル名は保存しない', async () => {
    // 垂直タブ(制御文字)が1文字入っている。
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: 'a' + String.fromCharCode(11) + 'b.png' });
    expect(res.status).toBe(400);
    expect(mocks.updateMedia).not.toHaveBeenCalled();
  });

  it('存在しないフォルダは保存しない', async () => {
    mocks.getFolderById.mockResolvedValueOnce(null);
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { folderId: 'folder-gone' });
    expect(res.status).toBe(400);
    expect(mocks.updateMedia).not.toHaveBeenCalled();
  });

  it('別種のフォルダは保存しない', async () => {
    mocks.getFolderById.mockResolvedValueOnce({ id: 'folder-tag', kind: 'tag', name: '分類' });
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { folderId: 'folder-tag' });
    expect(res.status).toBe(400);
    expect(mocks.updateMedia).not.toHaveBeenCalled();
  });

  it('他アカウントのメディアは存在も返さない', async () => {
    mocks.getMediaById.mockResolvedValueOnce(null);
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: 'b.png' });
    expect(res.status).toBe(404);
    expect(mocks.updateMedia).not.toHaveBeenCalled();
  });

  it('正しい名前とメディア用フォルダは通る', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: 'b.png', folderId: 'folder-1' });
    expect(res.status).toBe(200);
    expect(mocks.updateMedia).toHaveBeenCalledWith(env.DB, 'md-1', 'account-1', { expectedRevision: 1,
      filename: 'b.png',
      folderId: 'folder-1',
    });
  });

  it('フォルダを外す（未分類へ戻す）は通る', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { folderId: null });
    expect(res.status).toBe(200);
    expect(mocks.updateMedia).toHaveBeenCalledWith(env.DB, 'md-1', 'account-1', { expectedRevision: 1, folderId: null });
  });
});

describe('#667 N-197 編集・削除のAPIはowner/adminのみ', () => {
  it('staffの名前変更は403で止める', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: 'b.png' }, 'staff');
    expect(res.status).toBe(403);
    expect(mocks.updateMedia).not.toHaveBeenCalled();
  });

  it('staffの削除は403で止める', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'DELETE', undefined, 'staff');
    expect(res.status).toBe(403);
    expect(mocks.deleteMedia).not.toHaveBeenCalled();
  });

  it('staffの影響確認は403で止める', async () => {
    const res = await req('/api/media/md-1/delete-impact?accountId=account-1', 'GET', undefined, 'staff');
    expect(res.status).toBe(403);
    expect(mocks.getMediaDeleteImpact).not.toHaveBeenCalled();
  });

  it('staffの一括差し替えは403で止める', async () => {
    const res = await req(
      '/api/media/md-1/replace-usages?accountId=account-1',
      'POST',
      { replacementMediaId: 'md-2', previewToken: 'rev-1' },
      'staff',
    );
    expect(res.status).toBe(403);
    expect(mocks.applyMediaReplacementPlan).not.toHaveBeenCalled();
  });

  it('adminの名前変更は通る', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: 'b.png' }, 'admin');
    expect(res.status).toBe(200);
    expect(mocks.updateMedia).toHaveBeenCalled();
  });

  it('adminの削除は通る（使われていなければ）', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'DELETE', undefined, 'admin');
    expect(res.status).toBe(200);
    expect(mocks.deleteMedia).toHaveBeenCalled();
  });

  it('ownerの名前変更は通る', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: 'b.png' }, 'owner');
    expect(res.status).toBe(200);
    expect(mocks.updateMedia).toHaveBeenCalled();
  });

  it('ownerの削除は通る（使われていなければ）', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'DELETE', undefined, 'owner');
    expect(res.status).toBe(200);
    expect(mocks.deleteMedia).toHaveBeenCalled();
  });

  it('ownerの影響確認は通る', async () => {
    const res = await req('/api/media/md-1/delete-impact?accountId=account-1', 'GET', undefined, 'owner');
    expect(res.status).toBe(200);
    expect(mocks.getMediaDeleteImpactSnapshot).toHaveBeenCalled();
  });

  /* 読める操作まで取り上げない。読取権限と編集権限を混同しないための一行。 */
  it('staffでも一覧は読める', async () => {
    const res = await req('/api/media?accountId=account-1', 'GET', undefined, 'staff');
    expect(res.status).toBe(200);
  });
});

describe('#637 N-195 メディアのダウンロードは認証済み口だけ', () => {
  it('有効な利用者は実体を受け取れる', async () => {
    get.mockResolvedValueOnce({
      body: 'PNGDATA',
      httpMetadata: { contentType: 'image/png' },
    });
    const res = await req('/api/media/md-1/download?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toContain(encodeURIComponent('a.png'));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.text()).toBe('PNGDATA');
    expect(mocks.getMediaById).toHaveBeenCalledWith(env.DB, 'md-1', 'account-1');
    expect(get).toHaveBeenCalledWith('media/xxx.png');
  });

  it('権限のない担当者は403で止める', async () => {
    const res = await req('/api/media/md-1/download?accountId=account-1', 'GET', undefined, null);
    expect(res.status).toBe(403);
    expect(mocks.getMediaById).not.toHaveBeenCalled();
  });

  it('他アカウントのメディアは存在も返さない', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const res = await req('/api/media/md-1/download?accountId=account-2', 'GET');
    expect(res.status).toBe(404);
    expect(mocks.getMediaById).not.toHaveBeenCalled();
  });

  it('存在しないメディアは404にする', async () => {
    mocks.getMediaById.mockResolvedValueOnce(null);
    const res = await req('/api/media/gone/download?accountId=account-1', 'GET');
    expect(res.status).toBe(404);
  });

  it('R2実体がなければ404にする', async () => {
    get.mockResolvedValueOnce(null);
    const res = await req('/api/media/md-1/download?accountId=account-1', 'GET');
    expect(res.status).toBe(404);
  });
});

describe('#637 指摘2 管理画面の表示は認証付きのcontent口だけ', () => {
  it('有効な利用者は表示用の中身を受け取れる', async () => {
    get.mockResolvedValueOnce({
      body: 'PNGDATA',
      httpMetadata: { contentType: 'image/png' },
    });
    const res = await req('/api/media/md-1/content?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toContain('inline');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.text()).toBe('PNGDATA');
  });

  it('権限のない担当者は403で止める', async () => {
    const res = await req('/api/media/md-1/content?accountId=account-1', 'GET', undefined, null);
    expect(res.status).toBe(403);
    expect(mocks.getMediaById).not.toHaveBeenCalled();
  });

  it('他アカウントの表示は存在も返さない', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const res = await req('/api/media/md-1/content?accountId=account-2', 'GET');
    expect(res.status).toBe(404);
    expect(mocks.getMediaById).not.toHaveBeenCalled();
  });

  it('一覧が返すurlは配信用の公開URLの形のままである', async () => {
    const res = await req('/api/media?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ url: string }> } };
    // 配信本文に埋めてLINEが取りに行く公開URL。秘密値は含めない。
    expect(body.data.items[0]?.url).toBe('https://api.example.com/images/media/xxx.png');
  });
});

/*
 *  登録メディア。
 * 既知の利用期限・同意情報を詳細へ出す記録口と、版ごとの実体を
 * 取り戻すダウンロード口。記録されていない値は推測で埋めない。
 */
describe('IDEA-15 メディアの利用期限・同意の記録', () => {
  it('記録した期限と同意メモを保存し、serializeで返す', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', {
      usageExpiresAt: '2027-03-31',
      usageConsentNote: '出演者の同意書を確認済み',
    });
    expect(res.status).toBe(200);
    expect(mocks.updateMedia).toHaveBeenCalledWith(env.DB, 'md-1', 'account-1', { expectedRevision: 1,
      usageExpiresAt: '2027-03-31',
      usageConsentNote: '出演者の同意書を確認済み',
    });
    expect(await res.json()).toMatchObject({
      data: { usageExpiresAt: null, usageConsentNote: null },
    });
  });

  it('空の値は記録を消して「不明」へ戻す', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', {
      usageExpiresAt: null,
      usageConsentNote: '',
    });
    expect(res.status).toBe(200);
    expect(mocks.updateMedia).toHaveBeenCalledWith(env.DB, 'md-1', 'account-1', { expectedRevision: 1,
      usageExpiresAt: null,
      usageConsentNote: null,
    });
  });

  it.each(['2027-13-01', '2027-02-30', '来月末', '2027/03/31'])(
    '実在しない・形式の違う日付 %s は書き込まない',
    async (value) => {
      const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', { usageExpiresAt: value });
      expect(res.status).toBe(400);
      expect(mocks.updateMedia).not.toHaveBeenCalled();
    },
  );

  it('同意メモは500文字まで。超過は書き込まない', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', {
      usageConsentNote: 'あ'.repeat(501),
    });
    expect(res.status).toBe(400);
    expect(mocks.updateMedia).not.toHaveBeenCalled();
  });

  it('staffは記録を書き換えられない', async () => {
    const res = await req('/api/media/md-1?accountId=account-1', 'PATCH', {
      usageExpiresAt: '2027-03-31',
    }, 'staff');
    expect(res.status).toBe(403);
    expect(mocks.updateMedia).not.toHaveBeenCalled();
  });
});

describe('IDEA-15 版ごとのダウンロード（元ファイルの取り戻し）', () => {
  const VERSION_1 = {
    id: 'version-1',
    media_id: 'md-1',
    version_no: 1,
    r2_key: 'media/account-1/original.png',
    mime_type: 'image/png',
    size_bytes: 100,
    width: 100,
    height: 50,
    duration_ms: null,
    page_count: null,
    codec: null,
    content_hash: null,
    etag: null,
    scan_status: 'verified',
    scan_result: null,
    scanned_at: '2026-08-16',
    change_reason: null,
    uploaded_by: 'u-1',
    created_at: '2026-08-16',
    published_at: '2026-08-16',
  };

  beforeEach(() => {
    mocks.getMediaVersionByNo.mockResolvedValue(VERSION_1);
  });

  it('指定した版の実体を添付として返す。第1版は登録時の元ファイル', async () => {
    get.mockResolvedValueOnce({ body: 'ORIGINAL-PNG' });
    const res = await req('/api/media/md-1/versions/1/download?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(mocks.getMediaVersionByNo).toHaveBeenCalledWith(env.DB, 'md-1', 'account-1', 1);
    expect(get).toHaveBeenCalledWith('media/account-1/original.png');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toContain(encodeURIComponent('a-v1.png'));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.text()).toBe('ORIGINAL-PNG');
  });

  it('staffも版を取り出せる（ダウンロードと同じ権限）', async () => {
    get.mockResolvedValueOnce({ body: 'ORIGINAL-PNG' });
    const res = await req('/api/media/md-1/versions/1/download?accountId=account-1', 'GET', undefined, 'staff');
    expect(res.status).toBe(200);
  });

  it.each(['0', '-1', '1.5', 'latest'])('版番号 %s は404', async (versionNo) => {
    const res = await req(`/api/media/md-1/versions/${versionNo}/download?accountId=account-1`, 'GET');
    expect(res.status).toBe(404);
    expect(mocks.getMediaVersionByNo).not.toHaveBeenCalled();
  });

  it('存在しない版は404にする', async () => {
    mocks.getMediaVersionByNo.mockResolvedValueOnce(null);
    const res = await req('/api/media/md-1/versions/9/download?accountId=account-1', 'GET');
    expect(res.status).toBe(404);
  });

  it('他アカウントのメディアは存在も返さず、版を探さない', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const res = await req('/api/media/md-1/versions/1/download?accountId=account-2', 'GET');
    expect(res.status).toBe(404);
    expect(mocks.getMediaVersionByNo).not.toHaveBeenCalled();
  });

  it('権限のない担当者は403で止める', async () => {
    const res = await req('/api/media/md-1/versions/1/download?accountId=account-1', 'GET', undefined, null);
    expect(res.status).toBe(403);
    expect(mocks.getMediaVersionByNo).not.toHaveBeenCalled();
  });
});

describe('メディア使用先の一括差し替え', () => {
  async function currentRevision(): Promise<string> {
    const response = await req(
      '/api/media/md-1/replacement-impact?accountId=account-1&replacementId=md-2',
      'GET',
    );
    const body = (await response.json()) as { data: { revision: string } };
    return body.data.revision;
  }

  it('内部IDを返さず、差し替え可否と改版値を返す', async () => {
    const response = await req(
      '/api/media/md-1/replacement-impact?accountId=account-1&replacementId=md-2',
      'GET',
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { revision: string; references: unknown[] } };
    expect(body.data.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(body.data.references).toEqual([
      expect.objectContaining({ name: '来店後のご案内', replaceable: true }),
    ]);
    expect(body.data.references[0]).not.toHaveProperty('refId');
  });

  it('影響確認後に使用先が変わったら409で最新の影響を返す', async () => {
    const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
      replacementMediaId: 'md-2',
      expectedRevision: 'old',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'media_replacement_changed',
      data: { usageCount: 1 },
    });
    expect(mocks.applyMediaReplacementPlan).not.toHaveBeenCalled();
  });

  it('共有など差し替え不能の使用先が1件でもあれば全体を止める', async () => {
    mocks.getMediaReplacementPlan.mockResolvedValueOnce({
      ...REPLACEMENT_PLAN,
      impact: {
        ...REPLACEMENT_PLAN.impact,
        canReplace: false,
        replaceableCount: 0,
        blockers: ['shared_reference'],
      },
    });
    const revision = await currentRevision();
    mocks.getMediaReplacementPlan.mockResolvedValueOnce({
      ...REPLACEMENT_PLAN,
      impact: {
        ...REPLACEMENT_PLAN.impact,
        canReplace: false,
        replaceableCount: 0,
        blockers: ['shared_reference'],
      },
    });
    const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
      replacementMediaId: 'md-2',
      expectedRevision: revision,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'media_replacement_blocked' });
    expect(mocks.applyMediaReplacementPlan).not.toHaveBeenCalled();
  });

  it('実行直前に同じ改版値を照合してからD1の差し替えを呼ぶ', async () => {
    const revision = await currentRevision();
    const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
      replacementMediaId: 'md-2',
      expectedRevision: revision,
    });
    expect(response.status).toBe(200);
    expect(mocks.applyMediaReplacementPlan).toHaveBeenCalledWith(
      env.DB, REPLACEMENT_PLAN, 'account-1', { scope: 'all' },
    );
    expect(await response.json()).toMatchObject({
      data: {
        mode: 'all',
        replacedUsageCount: 1,
        skippedUsageCount: 0,
        remainingUsageCount: 0,
        verification: 'verified',
      },
    });
  });

  it('差し替えを実行したら監査ログへ残す', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const revision = await currentRevision();
      const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
        replacementMediaId: 'md-2',
        expectedRevision: revision,
      });
      expect(response.status).toBe(200);
      expect(mocks.recordAuditEvent).toHaveBeenCalledWith(env.DB, expect.objectContaining({ action: 'media.replace_usages', targetId: 'md-1' }));
      expect(logSpy.mock.calls.flat().join(' ')).not.toContain('md-1');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('置換可能な箇所だけの部分実行は scope=replaceable で明示して選べる', async () => {
    const partialPlan = {
      ...REPLACEMENT_PLAN,
      usages: [
        ...REPLACEMENT_PLAN.usages,
        { media_id: 'md-1', ref_kind: 'webinar', ref_id: 'webinar-1', scanned_at: '2026-08-31T10:00:00.000' },
      ],
      impact: {
        ...REPLACEMENT_PLAN.impact,
        usageCount: 2,
        replaceableCount: 1,
        blockedCount: 1,
        blockedByKind: { webinar: 1 },
        canReplace: false,
        canPartiallyReplace: true,
        blockers: ['unsupported_reference'],
        references: [
          ...REPLACEMENT_PLAN.impact.references,
          {
            kind: 'webinar',
            name: '講座',
            href: '/webinars/edit?id=webinar-1',
            state: 'available',
            scannedAt: '2026-08-31T10:00:00.000',
            replaceable: false,
            blocker: 'unsupported_reference',
            reason: 'ウェビナー動画は配信用の一式を持つため、このファイルだけを差し替えられません。',
          },
        ],
      },
    };
    mocks.getMediaReplacementPlan.mockResolvedValue(partialPlan);
    mocks.applyMediaReplacementPlan.mockResolvedValue({
      changedRows: 1,
      appliedUsageCount: 1,
      skippedUsageCount: 1,
      mode: 'partial',
    });
    // 残存1件（置換不可のウェビナー）が元メディアを指し続ける。
    mocks.getMediaUsages.mockResolvedValue([
      { media_id: 'md-1', ref_kind: 'webinar', ref_id: 'webinar-1', scanned_at: '2026-08-31T10:00:00.000' },
    ]);

    const revision = await currentRevision();
    const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
      replacementMediaId: 'md-2',
      expectedRevision: revision,
      scope: 'replaceable',
    });
    expect(response.status).toBe(200);
    expect(mocks.applyMediaReplacementPlan).toHaveBeenCalledWith(
      env.DB, partialPlan, 'account-1', { scope: 'replaceable' },
    );
    expect(await response.json()).toMatchObject({
      data: {
        mode: 'partial',
        replacedUsageCount: 1,
        skippedUsageCount: 1,
        remainingUsageCount: 1,
        verification: 'verified',
      },
    });
  });

  it('scopeを付けない従来の要求は全件実行として、置換不可があれば止める', async () => {
    const blockedPlan = {
      ...REPLACEMENT_PLAN,
      impact: {
        ...REPLACEMENT_PLAN.impact,
        canReplace: false,
        canPartiallyReplace: true,
        replaceableCount: 1,
        blockedCount: 1,
        blockedByKind: { webinar: 1 },
        blockers: ['unsupported_reference'],
      },
    };
    mocks.getMediaReplacementPlan.mockResolvedValue(blockedPlan);
    const revision = await currentRevision();
    const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
      replacementMediaId: 'md-2',
      expectedRevision: revision,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'media_replacement_blocked' });
    expect(mocks.applyMediaReplacementPlan).not.toHaveBeenCalled();
  });

  it('置換可能な使用先が0件なら部分実行も409で止める', async () => {
    const blockedPlan = {
      ...REPLACEMENT_PLAN,
      impact: {
        ...REPLACEMENT_PLAN.impact,
        canReplace: false,
        canPartiallyReplace: false,
        replaceableCount: 0,
        blockedCount: 1,
        blockedByKind: { webinar: 1 },
        blockers: ['unsupported_reference'],
      },
    };
    mocks.getMediaReplacementPlan.mockResolvedValue(blockedPlan);
    const revision = await currentRevision();
    const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
      replacementMediaId: 'md-2',
      expectedRevision: revision,
      scope: 'replaceable',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'media_replacement_blocked' });
    expect(mocks.applyMediaReplacementPlan).not.toHaveBeenCalled();
  });

  it('scopeの不正値は400で止める', async () => {
    const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
      replacementMediaId: 'md-2',
      expectedRevision: 'rev-1',
      scope: 'everything',
    });
    expect(response.status).toBe(400);
    expect(mocks.getMediaReplacementPlan).not.toHaveBeenCalled();
  });

  it('本文が16KiBを超えたら読む前後の両方で413', async () => {
    const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
      replacementMediaId: 'md-2',
      expectedRevision: 'x'.repeat(17 * 1024),
    });
    expect(response.status).toBe(413);
    expect(mocks.getMediaReplacementPlan).not.toHaveBeenCalled();
  });

  it('確認の再走査に失敗したとき0件を作らない', async () => {
    const revision = await currentRevision();
    scanMocks.scanSingleMediaUsage
      .mockResolvedValueOnce({ scanned: 1, matched: 1, pruned: 0 })
      .mockRejectedValueOnce(new Error('D1 unavailable'))
      .mockResolvedValueOnce({ scanned: 1, matched: 1, pruned: 0 });
    const response = await req('/api/media/md-1/replace-usages?accountId=account-1', 'POST', {
      replacementMediaId: 'md-2',
      expectedRevision: revision,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { remainingUsageCount: null, verification: 'unavailable' },
    });
  });
});

describe('共通情報', () => {
  it('LINEアカウントを指定しない一覧取得は止める', async () => {
    const res = await req('/api/common-vars', 'GET');
    expect(res.status).toBe(400);
    expect(mocks.getCommonVars).not.toHaveBeenCalled();
  });

  it('権限のないLINEアカウントは存在も返さない', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValue(false);
    const res = await req('/api/common-vars?accountId=other', 'GET');
    expect(res.status).toBe(404);
    expect(mocks.getCommonVars).not.toHaveBeenCalled();
  });

  it('一覧は選択中のLINEアカウントで絞る', async () => {
    const res = await req('/api/common-vars?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(mocks.getCommonVars).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-1',
      folderId: undefined,
      limit: 200,
    });
    expect(mocks.getCommonVarUsageSummaries).toHaveBeenCalledWith(
      env.DB,
      ['shop_hours'],
      'account-1',
    );
    const body = (await res.json()) as {
      data: Array<{ usageCount: number; usageByKind: { template: number } }>;
      meta: { total: number; limited: boolean; limit: number };
    };
    expect(body.data[0]?.usageCount).toBe(3);
    expect(body.data[0]?.usageByKind.template).toBe(2);
    expect(body).toMatchObject({
      meta: { total: 1, limited: false, limit: 200 },
    });
  });

  it('使用先件数を確認できないときは0件と見せず一覧取得を止める', async () => {
    mocks.getCommonVarUsageSummaries.mockRejectedValueOnce(new Error('D1 unavailable'));
    const res = await req('/api/common-vars?accountId=account-1', 'GET');
    expect(res.status).toBe(500);
  });

  it('詳細は社内メモ・版・使用先先頭15件・変更履歴を実データで返す', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 1,
      blockingTotal: 1,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, template: 1 },
      items: [{
        kind: 'template', source_id: 'template-1', source_parent_id: null,
        source_name: '予約案内', source_status: 'active',
        source_content: '営業時間は{{var.shop_hours}}です', is_historical: 0,
      }],
    });
    const res = await req('/api/common-vars/cv-1?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        id: 'cv-1', memo: '店舗共通の営業時間', version: 3,
        usageCount: 1, usageByKind: { template: 1 },
        usages: [{ name: '予約案内', currentPreview: '営業時間は10-19です' }],
        usagePage: { total: 1, shown: 1, hasMore: false, unavailableCount: 0 },
        history: [{ version: 3, changeReason: '営業時間を更新', actorName: '見本 145' }],
      },
    });
  });

  it('詳細の使用先が空なら0件と空配列を区別して返す', async () => {
    mocks.getCommonVarVersions.mockResolvedValue([]);
    const res = await req('/api/common-vars/cv-1?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { usageCount: 0, usages: [], history: [], usagePage: { total: 0, hasMore: false } },
    });
  });

  it('アーカイブ済みの詳細は履歴を返し、同じ差し込み名の使用先を再走査しない', async () => {
    mocks.getCommonVarByIdIncludingArchived.mockResolvedValue({
      ...VAR, archived_at: '2026-09-08T10:00:00.000+09:00', version: 4,
    });
    const res = await req('/api/common-vars/cv-1?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        id: 'cv-1', archivedAt: '2026-09-08T10:00:00.000+09:00',
        usageCount: 0, usages: [], history: [{ version: 3 }],
      },
    });
    expect(mocks.getCommonVarUsageImpact).not.toHaveBeenCalled();
    expect(mocks.getCommonVarVersions).toHaveBeenCalledWith(env.DB, 'cv-1', 'account-1', 20);
  });

  it('詳細の所属外は404、走査失敗は0件にせず503', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    expect((await req('/api/common-vars/cv-1?accountId=other', 'GET')).status).toBe(404);
    mocks.getCommonVarUsageImpact.mockRejectedValueOnce(new Error('D1 unavailable'));
    expect((await req('/api/common-vars/cv-1?accountId=account-1', 'GET')).status).toBe(503);
  });

  it('差し込み名の形が違えば422', async () => {
    const res = await req('/api/common-vars', 'POST', { accountId: 'account-1', name: 'x', varKey: '営業時間' });
    expect(res.status).toBe(422);
    expect(mocks.createCommonVar).not.toHaveBeenCalled();
  });

  it('差し込み名の決まりは友だち情報欄と同じ', async () => {
    // 片方だけ緩めると「情報欄では使えないのに共通情報では使える名前」ができる。
    const res = await req('/api/common-vars', 'POST', { accountId: 'account-1', name: 'x', varKey: 'name' });
    expect(res.status).toBe(422);
  });

  it('重複したら409', async () => {
    mocks.createCommonVar.mockRejectedValue(new MockCommonVarKeyConflictError());
    const res = await req('/api/common-vars', 'POST', { accountId: 'account-1', name: 'x', varKey: 'dup' });
    expect(res.status).toBe(409);
  });

  it('所属外アカウントの重複有無を調べず404にする', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const res = await req('/api/common-vars', 'POST', {
      accountId: 'other-account', name: 'x', varKey: 'dup',
    });
    expect(res.status).toBe(404);
    expect(mocks.createCommonVar).not.toHaveBeenCalled();
  });

  it('差し込み名は変えられない', async () => {
    const res = await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', { varKey: 'other' });
    expect(res.status).toBe(422);
    expect(mocks.updateCommonVar).not.toHaveBeenCalled();
  });

  it('値だけの変更は確認値つきで通る', async () => {
    // 保存には影響確認の確認値が要る。確認口で発行した値を添える。
    const preview = await req('/api/common-vars/cv-1/impact-preview?accountId=account-1', 'POST', {
      accountId: 'account-1', nextValue: '11-20',
    });
    expect(preview.status).toBe(200);
    const { impactProof } = (await preview.json() as { data: { impactProof: string } }).data;
    const res = await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', { expectedVersion: 3, value: '11-20', impactProof, changeReason: '理由' });
    expect(res.status).toBe(200);
  });

  it('#544 N2 上限を超える指定は200件に丸め、切ったら総件数を返す', async () => {
    mocks.countCommonVars.mockResolvedValueOnce(250);
    const res = await req('/api/common-vars?accountId=account-1&limit=500', 'GET');
    expect(res.status).toBe(200);
    expect(mocks.getCommonVars).toHaveBeenCalledWith(env.DB, {
      lineAccountId: 'account-1',
      folderId: undefined,
      limit: 200,
    });
    expect(await res.json()).toMatchObject({
      meta: { total: 250, limited: true, limit: 200 },
    });
  });

  it('#544 N4 長すぎる名前・値・メモは登録も更新も止める', async () => {
    const longValue = 'あ'.repeat(201);
    const longMemo = 'あ'.repeat(1001);
    expect((await req('/api/common-vars', 'POST', {
      accountId: 'account-1', name: 'x', varKey: 'ok_key', value: longValue,
    })).status).toBe(400);
    expect((await req('/api/common-vars', 'POST', {
      accountId: 'account-1', name: 'x', varKey: 'ok_key', memo: longMemo,
    })).status).toBe(400);
    expect((await req('/api/common-vars', 'POST', {
      accountId: 'account-1', name: 'あ'.repeat(201), varKey: 'ok_key',
    })).status).toBe(400);
    expect(mocks.createCommonVar).not.toHaveBeenCalled();
    expect((await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', { value: longValue })).status).toBe(400);
    expect((await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', { memo: longMemo })).status).toBe(400);
    expect(mocks.updateCommonVar).not.toHaveBeenCalled();
  });

  it('#544 N5 空の名前は更新でも止め、不正な種別は登録で止める', async () => {
    expect((await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', { name: '  ' })).status).toBe(400);
    expect(mocks.updateCommonVar).not.toHaveBeenCalled();
    expect((await req('/api/common-vars', 'POST', {
      accountId: 'account-1', name: 'x', varKey: 'ok_key', type: 'bogus',
    })).status).toBe(400);
    expect(mocks.createCommonVar).not.toHaveBeenCalled();
  });

  it('N-187 追加4型をPOST/PATCHの本番routeで型ごとに保存し、境界外はDBへ渡さない', async () => {
    const longText = '案内'.repeat(5_000);
    const postCases = [
      ['long_text', longText],
      ['date', '2028-02-29'],
      ['datetime', '2028-02-29T23:59'],
      ['boolean', 'true'],
      // 既存型も新しい分岐で退行していない。
      ['text', 'これまでの文字列'],
      ['url', 'https://example.com/shop'],
    ] as const;

    for (const [type, value] of postCases) {
      const response = await req('/api/common-vars', 'POST', {
        accountId: 'account-1', name: `${type}の項目`, varKey: `${type}_value`, type, value,
      });
      expect(response.status).toBe(201);
    }
    expect(mocks.createCommonVar).toHaveBeenCalledTimes(postCases.length);
    for (const [index, [type, value]] of postCases.entries()) {
      expect(mocks.createCommonVar.mock.calls[index]?.[1]).toMatchObject({ type, value });
    }

    const rejectedCreates = [
      ['long_text', 'あ'.repeat(10_001)],
      ['date', '2026-02-30'],
      ['datetime', '2026-02-30T24:00'],
      ['boolean', 'yes'],
      // R36: URL型にURLでない文章は登録させない。
      ['url', 'これはURLではありません'],
    ] as const;
    for (const [type, value] of rejectedCreates) {
      const response = await req('/api/common-vars', 'POST', {
        accountId: 'account-1', name: `${type}の不正値`, varKey: `${type}_invalid`, type, value,
      });
      expect(response.status).toBe(400);
    }
    expect(mocks.createCommonVar).toHaveBeenCalledTimes(postCases.length);

    mocks.getCommonVarById
      .mockResolvedValueOnce({ ...VAR, type: 'boolean', value: 'false' })
      .mockResolvedValueOnce({ ...VAR, type: 'boolean', value: 'false' });
    const preview = await req('/api/common-vars/cv-1/impact-preview?accountId=account-1', 'POST', {
      accountId: 'account-1', nextValue: 'true', expectedVersion: 3,
    });
    const { impactProof } = (await preview.json() as { data: { impactProof: string } }).data;
    const patched = await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', {
      value: 'true', expectedVersion: 3, impactProof, changeReason: '理由',
    });
    expect(patched.status).toBe(200);
    expect(mocks.updateCommonVar).toHaveBeenLastCalledWith(env.DB, 'cv-1', 'account-1', expect.objectContaining({
      value: 'true', expectedVersion: 3,
    }));

    // VAR-03: 画像型は https URL だけを受ける。URLでない文字列は理由つきの400で止める。
    const imageOk = await req('/api/common-vars', 'POST', {
      accountId: 'account-1', name: 'ロゴ', varKey: 'logo_url', type: 'image',
      value: 'https://cdn.example.com/logo.png',
    });
    expect(imageOk.status).toBe(201);
    const imageBad = await req('/api/common-vars', 'POST', {
      accountId: 'account-1', name: 'ロゴ', varKey: 'logo_bad', type: 'image',
      value: 'not-an-image',
    });
    expect(imageBad.status).toBe(400);
    expect(await imageBad.json()).toMatchObject({
      error: '画像には https:// からはじまるURLを入力してください',
    });

    // 保存済みの型で検証し、偽造した確認票があっても不正な暦日を影響確認や更新まで進めない。
    mocks.getCommonVarById.mockResolvedValueOnce({ ...VAR, type: 'date' });
    const invalidPatch = await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', {
      value: '2026-02-30', impactProof: 'forged', expectedVersion: 3,
    });
    expect(invalidPatch.status).toBe(400);

    // R36: URL型は新規・編集・予約のすべてで http/https のURLだけを受ける。
    const urlBad = await req('/api/common-vars', 'POST', {
      accountId: 'account-1', name: '店舗リンク', varKey: 'shop_link', type: 'url',
      value: 'これはURLではありません',
    });
    expect(urlBad.status).toBe(400);
    expect(await urlBad.json()).toMatchObject({
      error: 'URLの値は http:// または https:// からはじまる形で入力してください',
    });
    mocks.getCommonVarById.mockResolvedValueOnce({ ...VAR, type: 'url', value: 'https://example.com/old' });
    const urlBadPatch = await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', {
      value: 'これはURLではありません', impactProof: 'forged', expectedVersion: 3,
    });
    expect(urlBadPatch.status).toBe(400);
    expect(await urlBadPatch.json()).toMatchObject({
      error: 'URLの値は http:// または https:// からはじまる形で入力してください',
    });
    // 直前の正常な更新の1回きりで、URLでない値はDBへ渡さない。
    expect(mocks.updateCommonVar).toHaveBeenCalledTimes(1);
    // 代替値も同じ確かめを通る。
    const urlBadFallback = await req('/api/common-vars', 'POST', {
      accountId: 'account-1', name: '店舗リンク2', varKey: 'shop_link2', type: 'url',
      value: 'https://example.com/shop',
      expiryBehavior: 'fallback', fallbackValue: 'これはURLではありません',
    });
    expect(urlBadFallback.status).toBe(400);
    mocks.getCommonVarById.mockResolvedValueOnce({ ...VAR, type: 'url', value: 'https://example.com/old' });
    const urlBadSchedule = await req('/api/common-vars/cv-1/schedules?accountId=account-1', 'POST', {
      effectiveFrom: '2099-01-01T00:00',
      value: 'これはURLではありません',
    });
    expect(urlBadSchedule.status).toBe(400);
    expect(mocks.createCommonVarSchedule).not.toHaveBeenCalled();

    // 項目の種類によらず、書込前にアカウント権限と古い版を拒むことを確かめる。
    accessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const otherAccount = await req('/api/common-vars/cv-1?accountId=other-account', 'PATCH', {
      value: 'true', impactProof: 'forged', expectedVersion: 3,
    });
    expect(otherAccount.status).toBe(404);
    mocks.getCommonVarById.mockResolvedValueOnce({ ...VAR, type: 'boolean' });
    const stale = await req('/api/common-vars/cv-1/impact-preview?accountId=account-1', 'POST', {
      accountId: 'account-1', nextValue: 'true', expectedVersion: 2,
    });
    expect(stale.status).toBe(409);

    // プレビュー後の版更新は DB の楽観ロックを競合応答へ変換し、上書きしない。
    mocks.getCommonVarById
      .mockResolvedValueOnce({ ...VAR, type: 'boolean', value: 'false' })
      .mockResolvedValueOnce({ ...VAR, type: 'boolean', value: 'false' });
    const conflictPreview = await req('/api/common-vars/cv-1/impact-preview?accountId=account-1', 'POST', {
      accountId: 'account-1', nextValue: 'true', expectedVersion: 3,
    });
    const { impactProof: conflictProof } = (await conflictPreview.json() as { data: { impactProof: string } }).data;
    mocks.updateCommonVar.mockRejectedValueOnce(new MockCommonVarVersionConflictError(4));
    const conflict = await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', {
      value: 'true', expectedVersion: 3, impactProof: conflictProof, changeReason: '理由',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'common_var_version_conflict', currentVersion: 4 });
  });

  it('版番号なしの上書きを断る', async () => {
    // 影響の確認値があっても、読み込んだ版を欠く保存は通さない。
    const preview = await req('/api/common-vars/cv-1/impact-preview?accountId=account-1', 'POST', {
      accountId: 'account-1', nextValue: '11-20',
    });
    const { impactProof } = (await preview.json() as { data: { impactProof: string } }).data;
    const res = await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', { value: '11-20', impactProof, changeReason: '理由' });
    expect(res.status).toBe(400);
    expect(mocks.updateCommonVar).not.toHaveBeenCalled();
  });

  it('#544 N6 存在しない・別種別のフォルダは登録も更新も止める', async () => {
    mocks.createCommonVar.mockRejectedValueOnce(new MockCommonVarFolderError());
    expect((await req('/api/common-vars', 'POST', {
      accountId: 'account-1', name: 'x', varKey: 'ok_key', folderId: 'other-folder',
    })).status).toBe(400);
    mocks.updateCommonVar.mockRejectedValueOnce(new MockCommonVarFolderError());
    // フォルダ検査まで進めるため確認値を添える。
    const preview = await req('/api/common-vars/cv-1/impact-preview?accountId=account-1', 'POST', {
      accountId: 'account-1', nextValue: '10-19',
    });
    const { impactProof } = (await preview.json() as { data: { impactProof: string } }).data;
    expect((await req('/api/common-vars/cv-1?accountId=account-1', 'PATCH', { folderId: 'other-folder', impactProof, changeReason: '理由' })).status)
      .toBe(400);
  });

  it('削除影響は運用者向けの名前と導線を返し、内部IDの専用項目を作らない', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 1,
      blockingTotal: 1,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, template: 1 },
      items: [{
        kind: 'template',
        source_id: 'template-1',
        source_parent_id: null,
        source_name: '来店後のご案内',
        source_status: 'active',
        source_content: '営業時間は{{var.shop_hours}}です',
        is_historical: 0,
      }],
    });
    const res = await req('/api/common-vars/cv-1/delete-impact?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> & { items: Record<string, unknown>[] } };
    expect(body.data).toMatchObject({
      variable: { id: 'cv-1', name: '営業時間', varKey: 'shop_hours' },
      total: 1,
      blockingTotal: 1,
      canDelete: false,
      recommendedAction: 'review_references',
      items: [{
        kindLabel: 'テンプレート',
        name: '来店後のご案内',
        href: '/templates/edit?id=template-1',
        currentPreview: '営業時間は10-19です',
      }],
    });
    expect(body.data.checkedAt).toEqual(expect.any(String));
    expect(body.data.items[0]).not.toHaveProperty('sourceId');
    expect(mocks.getCommonVarUsageImpact).toHaveBeenCalledWith(
      env.DB,
      'shop_hours',
      'account-1',
    );
  });

  it('未知の種別の使用先リンクは一覧へ戻し、画面を壊さない（#578 L6）', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 1,
      blockingTotal: 1,
      items: [{
        kind: 'future_kind',
        source_id: 'x-1',
        source_parent_id: null,
        source_name: '将来の機能',
        source_status: 'active',
        source_content: '{{var.shop_hours}}',
        is_historical: 0,
      }],
    });
    const res = await req('/api/common-vars/cv-1/delete-impact?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ href: string }> } };
    expect(body.data.items[0]?.href).toBe('/contents/vars');
  });

  it('共通情報を変更する操作は内部JSONを表示しない', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 1,
      blockingTotal: 1,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, friend_add: 1 },
      items: [{
        kind: 'friend_add',
        source_id: 'friend-add-setting',
        source_parent_id: null,
        source_name: '友だち追加時の設定',
        source_status: 'active',
        source_content: '{"actionType":"common_var","config":{"varKey":"shop_hours"}}',
        is_historical: 0,
      }],
    });

    const res = await req('/api/common-vars/cv-1/delete-impact?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<Record<string, unknown>> } };
    expect(body.data.items[0]).toMatchObject({
      kindLabel: '友だち追加時の配信',
      href: '/friend-add-settings',
      currentPreview: 'この設定の中で使われています',
    });
    expect(JSON.stringify(body.data.items[0])).not.toContain('varKey');
    expect(JSON.stringify(body.data.items[0])).not.toContain('shop_hours');
  });

  it('所属不明の古いフォームは名前を返さず、件数だけで削除を止める', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 1,
      blockingTotal: 1,
      unscopedFormTotal: 1,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, form: 1 },
    });
    const res = await req('/api/common-vars/cv-1/delete-impact?accountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        canDelete: false,
        items: [],
        unavailableReferences: [{ kind: 'form', count: 1 }],
      },
    });
  });

  it('影響を取得できないときは0件を作らず503', async () => {
    mocks.getCommonVarUsageImpact.mockRejectedValueOnce(new Error('D1 unavailable'));
    const res = await req('/api/common-vars/cv-1/delete-impact?accountId=account-1', 'GET');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      success: false,
      error: '使用先を確認できないため削除できません',
    });
  });

  it('変更前後の文と遷移先を、選択中アカウントの使用先だけで返す', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 2,
      blockingTotal: 1,
      historicalTotal: 1,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, template: 1, broadcast: 1 },
      items: [
        {
          kind: 'template', source_id: 'template-1', source_parent_id: null,
          source_name: '予約案内', source_status: 'active',
          source_content: JSON.stringify({ text: '受付は{{var.shop_hours}}です', secret: '画面へ出さない' }),
          is_historical: 0,
        },
        {
          kind: 'broadcast', source_id: 'broadcast-1', source_parent_id: null,
          source_name: '配信済み', source_status: 'sent',
          source_content: '{{var.shop_hours}}でした', is_historical: 1,
        },
      ],
    });

    const res = await req('/api/common-vars/cv-1/impact-preview', 'POST', {
      accountId: 'account-1', nextValue: '11-20',
    });

    expect(res.status).toBe(200);
    expect(mocks.getCommonVarUsageImpact).toHaveBeenCalledWith(env.DB, 'shop_hours', 'account-1');
    const text = await res.text();
    expect(text).not.toContain('画面へ出さない');
    expect(JSON.parse(text)).toMatchObject({
      data: {
        canSave: true,
        items: [
          {
            name: '予約案内', href: '/templates/edit?id=template-1',
            status: '使われています', changesOnSave: true,
            currentPreview: '受付は10-19です', nextPreview: '受付は11-20です',
          },
          {
            name: '配信済み', status: '送信済み・変わりません',
            changesOnSave: false, currentPreview: '10-19でした', nextPreview: '10-19でした',
          },
        ],
      },
    });
  });

  it.each([
    ['accountId不足', { nextValue: '11-20' }, 'LINE公式アカウントを選んでください。'],
    ['nextValue不足', { accountId: 'account-1' }, '変更後の値を入力してください'],
  ])('%sは400で返し、使用先を走査しない', async (_case, body, error) => {
    const res = await req('/api/common-vars/cv-1/impact-preview', 'POST', body);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error , fields: expect.any(Object) });
    expect(mocks.getCommonVarUsageImpact).not.toHaveBeenCalled();
  });

  it('対象の共通情報が存在しないときは404で返し、使用先を走査しない', async () => {
    mocks.getCommonVarById.mockResolvedValue(null);

    const res = await req('/api/common-vars/missing/impact-preview', 'POST', {
      accountId: 'account-1', nextValue: '11-20',
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'Not found' });
    expect(mocks.getCommonVarUsageImpact).not.toHaveBeenCalled();
  });

  it('変更後の空値とLINE文字数超過をエラーとして返す', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 1,
      blockingTotal: 1,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, template: 1 },
      items: [{
        kind: 'template', source_id: 'template-1', source_parent_id: null,
        source_name: '長い案内', source_status: 'active',
        source_content: '{{var.shop_hours}}', is_historical: 0,
      }],
    });

    const tooLong = await req('/api/common-vars/cv-1/impact-preview', 'POST', {
      accountId: 'account-1', nextValue: 'あ'.repeat(5_001),
    });
    expect(await tooLong.json()).toMatchObject({
      data: {
        canSave: false,
        errorTotal: 1,
        recommendedAction: 'fix_errors',
        items: [{
          nextCharacterCount: 5_001,
          characterLimit: 5_000,
          exceedsCharacterLimit: true,
        }],
      },
    });

    const empty = await req('/api/common-vars/cv-1/impact-preview', 'POST', {
      accountId: 'account-1', nextValue: '',
    });
    expect(await empty.json()).toMatchObject({
      data: { canSave: false, items: [{ errors: ['変更後の値が空になります'] }] },
    });
  });

  it('変更影響も権限外アカウントの存在と使用先を返さない', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValue(false);
    const res = await req('/api/common-vars/cv-1/impact-preview', 'POST', {
      accountId: 'other', nextValue: '11-20',
    });
    expect(res.status).toBe(404);
    expect(mocks.getCommonVarById).not.toHaveBeenCalled();
    expect(mocks.getCommonVarUsageImpact).not.toHaveBeenCalled();
  });

  it('変更影響は予約中・公開中・種類別件数とrevisionを返す', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 2,
      blockingTotal: 2,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, broadcast: 1, form: 1 },
      items: [
        { kind: 'broadcast', source_id: 'b-1', source_parent_id: null, source_name: '予約配信', source_status: 'scheduled', source_content: '{{var.shop_hours}}', is_historical: 0 },
        { kind: 'form', source_id: 'f-1', source_parent_id: null, source_name: '予約フォーム', source_status: 'active', source_content: '{{var.shop_hours}}', is_historical: 0 },
      ],
    });
    const res = await req('/api/common-vars/cv-1/impact-preview', 'POST', {
      accountId: 'account-1', nextValue: '11-20', expectedVersion: 3,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        version: 3,
        usageByKind: { broadcast: 1, form: 1 },
        scheduledUsageCount: 1,
        publishedUsageCount: 1,
        usageRevision: expect.any(String),
      },
    });
  });

  /*
    送信開始時の値で固定済みの配信は、保存してもその配信の
    文は変わらない。「変わる場所」に入れると説明と処理がずれるので、
    状態名・changesOnSave・件数のすべてで分ける。
  */
  it('固定済みの配信中は変わらない側へ数え、公開中はその名で返す', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 3,
      blockingTotal: 2,
      sendingFixedTotal: 1,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, broadcast: 2, scenario: 1 },
      items: [
        { kind: 'broadcast', source_id: 'b-fix', source_parent_id: null, source_name: '送信中の配信', source_status: 'sending_fixed', source_content: '{{var.shop_hours}}です', is_historical: 0 },
        { kind: 'broadcast', source_id: 'b-sch', source_parent_id: null, source_name: '予約配信', source_status: 'scheduled', source_content: '{{var.shop_hours}}です', is_historical: 0 },
        { kind: 'scenario', source_id: 's-1', source_parent_id: null, source_name: '公開中シナリオ', source_status: 'published', source_content: '{{var.shop_hours}}', is_historical: 0 },
      ],
    });
    const res = await req('/api/common-vars/cv-1/impact-preview', 'POST', {
      accountId: 'account-1', nextValue: '11-20',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        sendingFixedTotal: 1,
        sendingFixedUsageCount: 1,
        scheduledUsageCount: 1,
        publishedUsageCount: 1,
        items: [
          {
            name: '送信中の配信', status: '配信中（送信開始時の値で固定済み）',
            changesOnSave: false, blocksDeletion: false,
          },
          { name: '予約配信', status: '配信予約中', changesOnSave: true },
          { name: '公開中シナリオ', status: '公開中', changesOnSave: true },
        ],
      },
    });
  });

  it('固定済みの配信中だけなら、履歴を残したまま削除できる', async () => {
    // 写しを持つ配信は、消してもその配信の文は変わらない。
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 1,
      sendingFixedTotal: 1,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, broadcast: 1 },
      items: [{
        kind: 'broadcast', source_id: 'b-fix', source_parent_id: null,
        source_name: '送信中の配信', source_status: 'sending_fixed',
        source_content: '{{var.shop_hours}}です', is_historical: 0,
      }],
    });
    const res = await req('/api/common-vars/cv-1?accountId=account-1&reason=%E9%81%8B%E7%94%A8%E7%B5%82%E4%BA%86', 'DELETE');
    expect(res.status).toBe(200);
    expect(mocks.deleteCommonVar).toHaveBeenCalled();
  });

  it('変更影響の古い版は409で再読込を求める', async () => {
    const res = await req('/api/common-vars/cv-1/impact-preview', 'POST', {
      accountId: 'account-1', nextValue: '11-20', expectedVersion: 2,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'common_var_version_conflict', currentVersion: 3,
    });
    expect(mocks.getCommonVarUsageImpact).not.toHaveBeenCalled();
  });

  it('スタッフ権限では変更影響の本文を返さない', async () => {
    const res = await req('/api/common-vars/cv-1/impact-preview', 'POST', {
      accountId: 'account-1', nextValue: '11-20',
    }, 'staff');
    expect(res.status).toBe(403);
    expect(mocks.getCommonVarById).not.toHaveBeenCalled();
    expect(mocks.getCommonVarUsageImpact).not.toHaveBeenCalled();
  });

  it('変更影響の走査失敗を0件にせず503で返す', async () => {
    mocks.getCommonVarUsageImpact.mockRejectedValueOnce(new Error('D1 unavailable'));
    const res = await req('/api/common-vars/cv-1/impact-preview', 'POST', {
      accountId: 'account-1', nextValue: '11-20',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: '影響する場所を確認できませんでした' });
  });

  it('使用中の共通情報はAPIを直接呼んでも削除できない', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 3,
      blockingTotal: 3,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, template: 2, broadcast: 1 },
    });
    const res = await req('/api/common-vars/cv-1?accountId=account-1&reason=%E9%81%8B%E7%94%A8%E7%B5%82%E4%BA%86', 'DELETE');
    expect(res.status).toBe(409);
    expect(mocks.deleteCommonVar).not.toHaveBeenCalled();
    expect(mocks.getCommonVarUsageImpact).toHaveBeenCalledWith(env.DB, 'shop_hours', 'account-1');
    expect(await res.json()).toMatchObject({
      code: 'common_var_delete_blocked',
      data: { total: 3, canDelete: false },
    });
  });

  it('使用先を確認できないときは0件扱いせず削除を止める', async () => {
    mocks.getCommonVarUsageImpact.mockRejectedValue(new Error('D1 unavailable'));
    const res = await req('/api/common-vars/cv-1?accountId=account-1&reason=%E9%81%8B%E7%94%A8%E7%B5%82%E4%BA%86', 'DELETE');
    expect(res.status).toBe(503);
    expect(mocks.deleteCommonVar).not.toHaveBeenCalled();
  });

  it('未使用なら影響確認後に削除できる', async () => {
    const res = await req('/api/common-vars/cv-1?accountId=account-1&reason=%E9%81%8B%E7%94%A8%E7%B5%82%E4%BA%86', 'DELETE');
    expect(res.status).toBe(200);
    expect(mocks.deleteCommonVar).toHaveBeenCalledWith(env.DB, 'cv-1', 'account-1', 'u-1', '運用終了');
  });

  it('差し替え候補は専用APIから取得できる', async () => {
    const res = await req('/api/common-vars/cv-1/replace', 'POST', { accountId: 'account-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        source: { id: 'cv-1', version: 3 },
        candidates: [{ id: 'cv-2', varKey: 'new_hours', version: 1 }],
      },
    });
  });

  it('差し替えはプレビューrevisionを再照合してから実行する', async () => {
    const previewResponse = await req('/api/common-vars/cv-1/replace', 'POST', {
      accountId: 'account-1', replacementId: 'cv-2',
    });
    const preview = (await previewResponse.json()) as { data: { revision: string } };
    expect(previewResponse.status).toBe(200);
    expect(preview.data).toMatchObject({ replaceableTotal: 1, blockedTotal: 0, canReplace: true });

    const stale = await req('/api/common-vars/cv-1/replace', 'POST', {
      accountId: 'account-1', replacementId: 'cv-2', apply: true,
      expectedVersion: 3, expectedRevision: 'old-revision',
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'common_var_usage_changed' });
    expect(mocks.applyCommonVarReplacementPlan).not.toHaveBeenCalled();

    const applied = await req('/api/common-vars/cv-1/replace', 'POST', {
      accountId: 'account-1', replacementId: 'cv-2', apply: true,
      expectedVersion: 3, expectedRevision: preview.data.revision,
      changeReason: '旧キーの統廃合',
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      data: {
        runId: 'replace-1', sourceId: 'cv-1', replacementId: 'cv-2',
        replacedUsageCount: 1, remainingUsageCount: 0, verification: 'verified',
      },
    });
  });

  it('差し替えはスタッフ権限と所属外アカウントをサーバで止める', async () => {
    expect((await req('/api/common-vars/cv-1/replace', 'POST', {
      accountId: 'account-1', replacementId: 'cv-2',
    }, 'staff')).status).toBe(403);
    accessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    expect((await req('/api/common-vars/cv-1/replace', 'POST', {
      accountId: 'other', replacementId: 'cv-2',
    })).status).toBe(404);
    expect(mocks.getCommonVarReplacementPlan).not.toHaveBeenCalled();
  });

  it('送信済み配信だけなら履歴を残したまま削除できる', async () => {
    mocks.getCommonVarUsageImpact.mockResolvedValue({
      ...EMPTY_COMMON_VAR_IMPACT,
      total: 1,
      historicalTotal: 1,
      byKind: { ...EMPTY_COMMON_VAR_IMPACT.byKind, broadcast: 1 },
      items: [{
        kind: 'broadcast', source_id: 'broadcast-1', source_parent_id: null,
        source_name: '過去のお知らせ', source_status: 'sent',
        source_content: '{{var.shop_hours}}でした', is_historical: 1,
      }],
    });
    const res = await req('/api/common-vars/cv-1?accountId=account-1&reason=%E9%81%8B%E7%94%A8%E7%B5%82%E4%BA%86', 'DELETE');
    expect(res.status).toBe(200);
    expect(mocks.deleteCommonVar).toHaveBeenCalled();
  });
});

describe('日付での切り替え', () => {
  it('未来の日時なら予約できる', async () => {
    const res = await req('/api/common-vars/cv-1/schedules?accountId=account-1', 'POST', {
      effectiveFrom: '2099-01-01T00:00',
      value: '新しい値',
    });
    expect(res.status).toBe(201);
  });

  it('過去の日時は受け付けない', async () => {
    // 入れた瞬間に次のCronで当たり、「予約したつもりが今すぐ変わった」になる。
    const res = await req('/api/common-vars/cv-1/schedules?accountId=account-1', 'POST', {
      effectiveFrom: '2020-01-01T00:00',
      value: 'x',
    });
    expect(res.status).toBe(400);
    expect(mocks.createCommonVarSchedule).not.toHaveBeenCalled();
  });

  it('VAR-06: 予約の値も種別の型検査を通し、合わない値は理由つきで止める', async () => {
    // ここを素通りさせると Cron が型に合わない値をそのまま書き込む。
    mocks.getCommonVarById
      .mockResolvedValueOnce({ ...VAR, type: 'boolean' })
      .mockResolvedValueOnce({ ...VAR, type: 'boolean' });
    const bad = await req('/api/common-vars/cv-1/schedules?accountId=account-1', 'POST', {
      effectiveFrom: '2099-01-01T00:00',
      value: 'yes',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: '更新後の値は種別に合う値を入力してください',
    });
    expect(mocks.createCommonVarSchedule).not.toHaveBeenCalled();

    const ok = await req('/api/common-vars/cv-1/schedules?accountId=account-1', 'POST', {
      effectiveFrom: '2099-01-01T00:00',
      value: 'true',
    });
    expect(ok.status).toBe(201);
  });

  it('日時の形が違えば弾く', async () => {
    const res = await req('/api/common-vars/cv-1/schedules?accountId=account-1', 'POST', {
      effectiveFrom: '2099年1月1日',
      value: 'x',
    });
    expect(res.status).toBe(400);
  });

  it.each(['2099-13-01T00:00', '2099-02-30T10:00', '2099-01-01T24:00'])(
    '実在しない日時は受け付けない（%s）',
    async (effectiveFrom) => {
      const res = await req('/api/common-vars/cv-1/schedules?accountId=account-1', 'POST', {
        effectiveFrom,
        value: 'x',
      });
      expect(res.status).toBe(400);
      expect(mocks.createCommonVarSchedule).not.toHaveBeenCalled();
    },
  );

  it('うるう日の2月29日は受け付ける', async () => {
    const res = await req('/api/common-vars/cv-1/schedules?accountId=account-1', 'POST', {
      effectiveFrom: '2096-02-29T10:00',
      value: 'x',
    });
    expect(res.status).toBe(201);
  });

  it('大きすぎる送信は読む前に413で断る（#578 L10）', async () => {
    const res = await req('/api/common-vars/cv-1/schedules?accountId=account-1', 'POST', {
      effectiveFrom: '2099-01-01T00:00',
      value: 'x'.repeat(20 * 1024),
    });
    expect(res.status).toBe(413);
    expect(mocks.createCommonVarSchedule).not.toHaveBeenCalled();
  });
});

describe('メディアのアーカイブと復元', () => {
  const archivedMedia = { ...MEDIA, archived_at: '2026-09-07T01:00:00.000Z', archived_by: 'u-1', archive_reason: '整理' };

  it('owner/adminは理由付きで退避でき、実行者とアカウントをdbへ渡す', async () => {
    mocks.archiveMedia.mockResolvedValue({ status: 'archived', media: archivedMedia });
    const res = await req('/api/media/md-1/archive', 'POST', { accountId: 'account-1', reason: '古い素材' }, 'admin');
    expect(res.status).toBe(200);
    expect(mocks.archiveMedia).toHaveBeenCalledWith(env.DB, {
      id: 'md-1', lineAccountId: 'account-1', actorId: 'u-1', reason: '古い素材',
    });
    const json = await res.json() as { data: { archivedAt: string | null; archiveReason: string | null } };
    expect(json.data.archivedAt).toBe('2026-09-07T01:00:00.000Z');
    expect(json.data.archiveReason).toBe('整理');
  });

  it('owner/adminは理由付きで一覧へ戻せる', async () => {
    mocks.restoreMedia.mockResolvedValue({ status: 'restored', media: MEDIA });
    const res = await req('/api/media/md-1/restore', 'POST', { accountId: 'account-1', reason: '再び使う' });
    expect(res.status).toBe(200);
    expect(mocks.restoreMedia).toHaveBeenCalledWith(env.DB, {
      id: 'md-1', lineAccountId: 'account-1', actorId: 'u-1', reason: '再び使う',
    });
  });

  it.each(['archive', 'restore'])('staffは%sできず403で止まり、dbを触らない', async (action) => {
    const res = await req(`/api/media/md-1/${action}`, 'POST', { accountId: 'account-1', reason: 'x' }, 'staff');
    expect(res.status).toBe(403);
    expect(mocks.archiveMedia).not.toHaveBeenCalled();
    expect(mocks.restoreMedia).not.toHaveBeenCalled();
  });

  it.each(['archive', 'restore'])('理由なしの%sは400で止まり、dbを触らない', async (action) => {
    const res = await req(`/api/media/md-1/${action}`, 'POST', { accountId: 'account-1' });
    expect(res.status).toBe(400);
    const json = await res.json() as { code?: string };
    expect(json.code).toBe('media_reason_required');
    expect(mocks.archiveMedia).not.toHaveBeenCalled();
    expect(mocks.restoreMedia).not.toHaveBeenCalled();
  });

  it.each(['archive', 'restore'])('空文字だけの理由も%sを受け付けない', async (action) => {
    const res = await req(`/api/media/md-1/${action}`, 'POST', { accountId: 'account-1,', reason: '   ' });
    expect(res.status).toBe(400);
  });

  it('存在しない・別アカウントのメディアは404', async () => {
    mocks.archiveMedia.mockResolvedValue({ status: 'not_found' });
    const res = await req('/api/media/md-x/archive', 'POST', { accountId: 'account-1', reason: 'x' });
    expect(res.status).toBe(404);
  });

  it('アカウントへのアクセス権がなければ404で、dbを触らない', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValueOnce(false);
    const res = await req('/api/media/md-1/archive', 'POST', { accountId: 'account-9', reason: 'x' });
    expect(res.status).toBe(404);
    expect(mocks.archiveMedia).not.toHaveBeenCalled();
  });

  it.each([
    ['archive', 'already_archived'],
    ['restore', 'already_active'],
  ])('既に目的側の状態なら%sは409で引き返す', async (action, status) => {
    mocks.archiveMedia.mockResolvedValue({ status: 'already_archived' });
    mocks.restoreMedia.mockResolvedValue({ status: 'already_active' });
    const res = await req(`/api/media/md-1/${action}`, 'POST', { accountId: 'account-1', reason: 'x' });
    expect(res.status).toBe(409);
    const json = await res.json() as { code?: string };
    expect(json.code).toBe(status);
  });

  it.each(['archive', 'restore'])('文字列でない理由・accountIdは500ではなく400で弾く（%s）', async (action) => {
    const res = await req(`/api/media/md-1/${action}`, 'POST', { accountId: 123, reason: 456 });
    expect(res.status).toBe(400);
    expect(mocks.archiveMedia).not.toHaveBeenCalled();
    expect(mocks.restoreMedia).not.toHaveBeenCalled();
  });

  it('一覧は既定で退避済みを外し、archived=only でだけ退避済みを返す', async () => {
    mocks.getMedia.mockResolvedValue([]);
    mocks.countMedia.mockResolvedValue(0);
    await req('/api/media?accountId=account-1', 'GET');
    expect(mocks.getMedia).toHaveBeenLastCalledWith(env.DB,
      expect.not.objectContaining({ archived: expect.anything() }));
    await req('/api/media?accountId=account-1&archived=only', 'GET');
    expect(mocks.getMedia).toHaveBeenLastCalledWith(env.DB,
      expect.objectContaining({ archived: 'only' }));
  });

  it('archivedに変な値を渡しても既定（非アーカイブ）のまま', async () => {
    mocks.getMedia.mockResolvedValue([]);
    mocks.countMedia.mockResolvedValue(0);
    const res = await req('/api/media?accountId=account-1&archived=yes', 'GET');
    expect(res.status).toBe(200);
    expect(mocks.getMedia).toHaveBeenLastCalledWith(env.DB,
      expect.not.objectContaining({ archived: expect.anything() }));
  });
});

describe('公開配信の安全ヘッダ', () => {
  it('画像の公開配信は nosniff を付け、そのまま表示する', async () => {
    mocks.getMediaLiveTarget.mockResolvedValueOnce({ ...MEDIA });
    get.mockResolvedValueOnce({ body: 'PNGDATA', etag: 'etag-1' });
    const res = await req('/media/md-1/content', 'GET', undefined, null);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toContain('inline');
  });

  it('PDFの公開配信は nosniff を付け、添付として渡す', async () => {
    mocks.getMediaLiveTarget.mockResolvedValueOnce({
      ...MEDIA, mime_type: 'application/pdf', filename: 'doc.pdf', r2_key: 'media/doc.pdf',
    });
    get.mockResolvedValueOnce({ body: 'PDFDATA', etag: 'etag-2' });
    const res = await req('/media/md-1/content', 'GET', undefined, null);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
  });
});


it('メディアは版の指定なし・古い版で保存しない', async () => {
  const missing = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: 'b.png' }, 'owner', null);
  expect(missing.status).toBe(400);
  const stale = await req('/api/media/md-1?accountId=account-1', 'PATCH', { filename: 'b.png' }, 'owner', '999');
  expect(stale.status).toBe(409);
  expect(mocks.updateMedia).not.toHaveBeenCalled();
});
it('保管庫の削除に失敗したら記録を消さず再試行できる', async () => {
  vi.mocked(env.IMAGES.delete).mockRejectedValueOnce(new Error('R2 unavailable'));
  const response = await req('/api/media/md-1?accountId=account-1', 'DELETE');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'MEDIA_STORAGE_DELETE_FAILED' });
  expect(mocks.deleteMedia).not.toHaveBeenCalled();
});
