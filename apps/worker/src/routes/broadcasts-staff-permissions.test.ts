/*
 * 一斉配信の staff 個別権限キー（-06 §6 の6キー）を効かせる。
 *
 * 要件の表：下書き作成・編集=definition.edit／テスト送信=test.send／
 * 予約・即時送信=definition.publish／緊急停止=job.stop／失敗再送=job.retry／
 * CSV=result.export。owner/admin は従来どおり通す。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';

const mocks = vi.hoisted(() => ({
  getBroadcastById: vi.fn(),
  deleteBroadcast: vi.fn(),
  createBroadcast: vi.fn(),
  countBroadcastLedger: vi.fn(),
  previewAudience: vi.fn(),
  hasRecentSimilar: vi.fn(),
  resolveBoundaries: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  getBroadcasts: vi.fn(),
  getBroadcastById: mocks.getBroadcastById,
  createBroadcast: mocks.createBroadcast,
  updateBroadcast: vi.fn(),
  deleteBroadcast: mocks.deleteBroadcast,
  getVersionedAccountSetting: vi.fn(),
  saveVersionedAccountSetting: vi.fn(),
  requestBroadcastStop: vi.fn(),
  resumeBroadcastSending: vi.fn(),
  beginBroadcastRetryAttempt: vi.fn(),
  closeClaimsForStop: vi.fn(),
  reopenFailedClaims: vi.fn(),
  getRetryableRecipientIds: vi.fn(),
  countBroadcastLedger: mocks.countBroadcastLedger,
  recordAuditEvent: vi.fn(),
  maskAuditIp: (value: string) => value,
  auditDeviceFamily: vi.fn(),
  getLineAccountById: vi.fn(async () => null),
  isOperationCapabilityStopped: vi.fn(async () => false),
  INSIGHT_MIN_AUDIENCE: 20,
}));
vi.mock('../services/account-access.js', () => ({
  getVisibleLineAccountScope: vi.fn(),
  canAccessAllLineAccounts: vi.fn(async () => true),
}));
vi.mock('@line-crm/line-sdk', () => ({ LineClient: vi.fn() }));
vi.mock('../features/broadcasts/broadcast-preflight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/broadcasts/broadcast-preflight.js')>()),
  previewAudience: mocks.previewAudience,
  hasRecentSimilarBroadcast: mocks.hasRecentSimilar,
}));
vi.mock('../services/request-boundary.js', () => ({
  resolveRequestBoundaries: mocks.resolveBoundaries,
}));

const { broadcasts } = await import('./broadcasts.js');

const owner: AuthenticatedStaff = {
  id: 'owner-1', name: 'オーナー', role: 'owner', readOnly: false, tenantId: 'tenant-1',
};

function staffWith(...keys: string[]): AuthenticatedStaff {
  return {
    id: 'staff-1', name: '担当者', role: 'staff', readOnly: false, tenantId: 'tenant-1',
    permissionKeys: keys,
  };
}

function app(actor: AuthenticatedStaff) {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => ({ success: true, meta: { changes: 1 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        }),
      } as unknown as D1Database,
    } as unknown as Env['Bindings'];
    c.set('staff', actor);
    await next();
  });
  instance.route('/', broadcasts);
  return instance;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'broadcast-1', title: 'お知らせ', message_type: 'text', message_content: '本文',
    message_bubbles_json: null, target_type: 'tag', target_tag_id: null, status: 'draft',
    scheduled_at: null, sent_at: null, total_count: 0, success_count: 0,
    created_at: '2026-09-25T00:00:00+09:00', account_ids: null, dedup_priority: null,
    failed_account_ids: null, track_links: 1, line_account_id: 'account-1',
    folder_id: null, measure_opens: 0, stopped_at: null, lock_version: 1,
    ...overrides,
  };
}

function json(method: string, body: unknown) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countBroadcastLedger.mockResolvedValue({ sent: 0, failed: 0, unknown: 0, claimed: 0 });
  mocks.previewAudience.mockResolvedValue({
    matched: 1, sendable: 1, evaluatedAt: '2026-09-25T00:00:00+09:00',
    representatives: [], exclusions: { hidden: 0 },
  });
  mocks.hasRecentSimilar.mockResolvedValue(false);
  mocks.resolveBoundaries.mockResolvedValue({ allowed: true });
  mocks.createBroadcast.mockImplementation(async (_db: unknown, input: { title: string }) =>
    row({ title: input.title }));
});

describe('一斉配信の staff 個別権限キー', () => {
  it('緊急停止の鍵を持つ staff は止められる（鍵なし staff は403）', async () => {
    mocks.getBroadcastById.mockResolvedValue(row({ status: 'sending', stopped_at: '2026-09-25T01:00:00+09:00' }));

    const allowed = await app(staffWith('/broadcasts', 'broadcast.job.stop'))
      .request('/api/broadcasts/broadcast-1/stop', json('POST', { expectedVersion: 1 }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ success: true, alreadyStopped: true });

    const denied = await app(staffWith('/broadcasts'))
      .request('/api/broadcasts/broadcast-1/stop', json('POST', { expectedVersion: 1 }));
    expect(denied.status).toBe(403);
  });

  it('版が古くても配信取消の権限を先に確認する', async () => {
    mocks.getBroadcastById.mockResolvedValue(row({ status: 'scheduled', scheduled_at: '2099-01-01T00:00:00Z', lock_version: 3 }));
    const denied = await app(staffWith('/broadcasts')).request('/api/broadcasts/broadcast-1/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'expectedVersion=2',
    });
    expect(denied.status).toBe(403);
    expect(mocks.getBroadcastById).not.toHaveBeenCalled();
  });

  it('送信の鍵を持つ staff は予約を取り消せる（鍵なし staff は403）', async () => {
    mocks.getBroadcastById.mockResolvedValue(row({ status: 'scheduled', scheduled_at: '2026-09-26T10:00:00+09:00' }));

    const allowed = await app(staffWith('/broadcasts', 'broadcast.definition.publish'))
      .request('/api/broadcasts/broadcast-1/cancel', json('POST', {}));
    expect(allowed.status).toBe(200);

    const denied = await app(staffWith('/broadcasts'))
      .request('/api/broadcasts/broadcast-1/cancel', json('POST', {}));
    expect(denied.status).toBe(403);
  });

  it('送信の鍵を持つ staff は送信前確認ができる（鍵なし staff は403）', async () => {
    const allowed = await app(staffWith('/broadcasts', 'broadcast.definition.publish'))
      .request('/api/broadcasts/preflight', json('POST', { targetType: 'all' }));
    expect(allowed.status).toBe(200);

    const denied = await app(staffWith('/broadcasts'))
      .request('/api/broadcasts/preflight', json('POST', { targetType: 'all' }));
    expect(denied.status).toBe(403);
  });

  it('作成の鍵を持つ staff は下書きを作れる（鍵なし staff は403）', async () => {
    const draft = { saveAsDraft: true, title: '下書き', messageType: 'text', messageContent: '', targetType: 'all' };
    const allowed = await app(staffWith('/broadcasts', 'broadcast.definition.edit'))
      .request('/api/broadcasts', json('POST', draft));
    expect(allowed.status).toBe(201);

    const denied = await app(staffWith('/broadcasts'))
      .request('/api/broadcasts', json('POST', draft));
    expect(denied.status).toBe(403);
  });

  it('作成の鍵を持つ staff は下書きを消せる（鍵なし staff は403）', async () => {
    mocks.getBroadcastById.mockResolvedValue(row({ status: 'draft' }));
    mocks.deleteBroadcast.mockResolvedValue(true);

    const allowed = await app(staffWith('/broadcasts', 'broadcast.definition.edit'))
      .request('/api/broadcasts/broadcast-1', { method: 'DELETE' });
    expect(allowed.status).toBe(200);
    expect(mocks.deleteBroadcast).toHaveBeenCalled();

    mocks.deleteBroadcast.mockClear();
    const denied = await app(staffWith('/broadcasts'))
      .request('/api/broadcasts/broadcast-1', { method: 'DELETE' });
    expect(denied.status).toBe(403);
    expect(mocks.deleteBroadcast).not.toHaveBeenCalled();
  });

  it('D026: 送信中・送信済みは鍵があっても409で消さない', async () => {
    mocks.deleteBroadcast.mockResolvedValue(false);

    mocks.getBroadcastById.mockResolvedValue(row({ status: 'sending' }));
    const sending = await app(staffWith('/broadcasts', 'broadcast.definition.edit'))
      .request('/api/broadcasts/broadcast-1', { method: 'DELETE' });
    expect(sending.status).toBe(409);
    expect(await sending.json()).toMatchObject({ success: false });

    mocks.getBroadcastById.mockResolvedValue(row({ status: 'sent' }));
    const sent = await app(staffWith('/broadcasts', 'broadcast.definition.edit'))
      .request('/api/broadcasts/broadcast-1', { method: 'DELETE' });
    expect(sent.status).toBe(409);
    expect(await sent.json()).toMatchObject({ success: false });

    expect(mocks.deleteBroadcast).not.toHaveBeenCalled();
  });

  it('owner は鍵なしで従来どおり通る', async () => {
    mocks.getBroadcastById.mockResolvedValue(row({ status: 'sending', stopped_at: '2026-09-25T01:00:00+09:00' }));
    const stopped = await app(owner)
      .request('/api/broadcasts/broadcast-1/stop', json('POST', { expectedVersion: 1 }));
    expect(stopped.status).toBe(200);

    mocks.getBroadcastById.mockResolvedValue(row({ status: 'draft' }));
    mocks.deleteBroadcast.mockResolvedValue(true);
    const deleted = await app(owner)
      .request('/api/broadcasts/broadcast-1', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
  });
});
