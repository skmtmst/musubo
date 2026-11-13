import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({ send: vi.fn(async () => {}) }));
vi.mock('../services/plain-mail.js', () => ({ sendPlainMail: mail.send }));

const { opsAnnouncements } = await import('./ops-announcements.js');

/*
 * （お知らせ作成の二重押し）・（お知らせ更新の同時保存）を
 * 実SQLiteで見る。
 *
 * 作成は Idempotency-Key を行IDに使い、二重押しでも1件だけにする。
 * 同じキーで内容が違う再送は409で取り違えを止める。
 * 更新は版（expectedUpdatedAt）を持たせ、古い画面からの保存は409で止め、
 * 最新の内容を data.latest で返す。
 */

let testDb: SqliteD1;

const master: AuthenticatedStaff = { id: 'master-1', name: '見本 25', role: 'owner', readOnly: false, tenantId: null };

function app() {
  const instance = new Hono<any>();
  instance.use('*', async (c, next) => {
    c.set('staff', master);
    c.env = { DB: testDb.db, ADMIN_PUBLIC_URL: 'https://admin.example.com', CONTACT_EMAIL: 'ops@example.com' };
    await next();
  });
  instance.route('/', opsAnnouncements);
  return instance;
}

function post(body: unknown, headers?: Record<string, string>) {
  return app().request('/api/ops/announcements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
  });
}

function put(id: string, body: unknown) {
  return app().request(`/api/ops/announcements/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const KEY = '123e4567-e89b-42d3-a456-426614174002';

function draftBody(subject: string) {
  return {
    subject, body: '本文です', audienceKind: 'all', audiencePlans: [], audienceTenantIds: [],
    channels: ['screen'], publishAt: null, mode: 'draft',
  };
}

function announcementCount(): number {
  return (testDb.raw.prepare(`SELECT COUNT(*) AS n FROM platform_announcements`).get() as { n: number }).n;
}

beforeEach(() => {
  testDb = createTestD1();
  testDb.raw.prepare(`INSERT INTO staff_members (id, name, role, api_key, tenant_id) VALUES ('master-1', '見本 25', 'owner', 'k0', NULL)`).run();
  testDb.raw.prepare(`INSERT INTO platform_admins (staff_id, is_active) VALUES ('master-1', 1)`).run();
  mail.send.mockReset();
});

describe('M512 お知らせ作成の二重押しは同じ再実行キーで1件だけ', () => {
  it('同じキー・同じ内容の再送は2件目を作らず保存済みを返す', async () => {
    const first = await post(draftBody('お知らせ'), { 'Idempotency-Key': KEY });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { success: boolean; data: { id: string } };

    const retry = await post(draftBody('お知らせ'), { 'Idempotency-Key': KEY });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { success: boolean; duplicate: boolean; data: { id: string } };
    expect(retryBody.duplicate).toBe(true);
    expect(retryBody.data.id).toBe(firstBody.data.id);
    expect(announcementCount()).toBe(1);
  });

  it('同じキーで内容が違う再送は取り違えとして409で止める', async () => {
    const first = await post(draftBody('お知らせ'), { 'Idempotency-Key': KEY });
    expect(first.status).toBe(201);
    const conflict = await post(draftBody('別のお知らせ'), { 'Idempotency-Key': KEY });
    expect(conflict.status).toBe(409);
    expect(announcementCount()).toBe(1);
  });

  it('キーにならない文字列は400で作らない', async () => {
    const response = await post(draftBody('お知らせ'), { 'Idempotency-Key': 'short' });
    expect(response.status).toBe(400);
    expect(announcementCount()).toBe(0);
  });

  it('キーが無い従来の呼び出しはそのまま作る', async () => {
    const response = await post(draftBody('お知らせ'));
    expect(response.status).toBe(201);
  });
});

describe('M513 お知らせ更新の同時保存は古い画面からを409で止める', () => {
  async function createDraft(subject: string): Promise<{ id: string; updatedAt: string }> {
    const response = await post(draftBody(subject));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { success: boolean; data: { id: string; updatedAt: string } };
    return { id: body.data.id, updatedAt: body.data.updatedAt };
  }

  it('合っている版は保存でき、古い版は最新の件名つきで409になる', async () => {
    const created = await createDraft('最初の件名');
    const first = await put(created.id, { ...draftBody('先の件名'), expectedUpdatedAt: created.updatedAt });
    expect(first.status).toBe(200);
    const saved = (await first.json()) as { success: boolean; data: { subject: string; updatedAt: string } };

    const stale = await put(created.id, { ...draftBody('古い画面の件名'), expectedUpdatedAt: created.updatedAt });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as {
      success: boolean; code: string; data: { latest: { subject: string; updatedAt: string } };
    };
    expect(body.code).toBe('VERSION_CONFLICT');
    expect(body.data.latest.subject).toBe(saved.data.subject);
    expect(body.data.latest.updatedAt).toBe(saved.data.updatedAt);
  });

  it('無いお知らせは409ではなく404のまま', async () => {
    const response = await put('no-such-id', { ...draftBody('件名'), expectedUpdatedAt: '2026-09-01T00:00:00.000+09:00' });
    expect(response.status).toBe(404);
  });

  it('送り始めたお知らせの更新は配信済みの理由で409のまま', async () => {
    const created = await createDraft('送る件名');
    testDb.raw.prepare(`UPDATE platform_announcements SET status = 'sent' WHERE id = ?`).run(created.id);
    const response = await put(created.id, { ...draftBody('直す'), expectedUpdatedAt: created.updatedAt });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { success: boolean; error: string };
    expect(body.error).toContain('配信済み');
  });
});
