import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  verifyIdentity: vi.fn(),
  getFriend: vi.fn(),
  jstNow: vi.fn(() => '2026-08-28 02:00:00'),
}));
vi.mock('../services/liff-auth.js', () => ({ verifyCallerLineIdentity: mocks.verifyIdentity }));
vi.mock('@line-crm/db', async original => ({
  ...await original<typeof import('@line-crm/db')>(),
  getFriendByLineUserIdForAccount: mocks.getFriend,
  jstNow: mocks.jstNow,
  resolveLineCredential: vi.fn(),
}));
vi.mock('../services/nen-tag-sync.js', () => ({
  refreshAllNenTags: vi.fn(), syncNenHealthTags: vi.fn(),
  syncNenPetTags: vi.fn(), syncNenPhotoTags: vi.fn(),
}));

const { nenMembers } = await import('./nen-members.js');

function harness() {
  const statements: Array<{ query: string; bindings: unknown[] }> = [];
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.env = {
      DB: {
        prepare(query: string) {
          const entry = { query, bindings: [] as unknown[] };
          statements.push(entry);
          const statement = {
            bind(...bindings: unknown[]) { entry.bindings = bindings; return statement; },
            async first() {
              if (query.includes('FROM friends f') && query.includes('channel_access_token')) {
                return {
                  id: 'friend-1', line_user_id: 'U1', display_name: '利用者', user_id: null,
                  line_account_id: 'account-a', channel_access_token: null,
                  channel_access_token_encrypted: null,
                };
              }
              if (query.includes('SELECT id, status FROM nen_photo_submissions')) {
                return { id: 'photo-1', status: 'pending' };
              }
              return null;
            },
            async all() {
              if (query.includes('WHERE ps.friend_id = ?')) {
                return { results: [
                  { id: 'photo-pending', status: 'pending', public_pet_name: 0 },
                  { id: 'photo-adopted', status: 'adopted', public_pet_name: 0 },
                  { id: 'photo-rejected', status: 'rejected', public_pet_name: 0 },
                ] };
              }
              return { results: [] };
            },
            async run() { return { success: true, meta: { changes: 1 } }; },
          };
          return statement;
        },
      },
    };
    await next();
  });
  app.route('/', nenMembers);
  return { app, statements };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyIdentity.mockResolvedValue({ lineUserId: 'U1', lineAccountId: 'account-a' });
  mocks.getFriend.mockResolvedValue({ id: 'friend-1', is_following: 1 });
});

describe('NEN photo privacy boundaries', () => {
  it('returns all three review states only for the current friend in the LIFF member response', async () => {
    const { app, statements } = harness();
    const response = await app.request('/api/liff/nen/member', {
      headers: { Authorization: 'Bearer liff-token' },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { photos: Array<{ status: string }> } };
    expect(body.data.photos.map((photo) => photo.status)).toEqual(['pending', 'adopted', 'rejected']);

    const photoQuery = statements.find((entry) => entry.query.includes('WHERE ps.friend_id = ?'));
    expect(photoQuery?.query).toContain('ps.friend_id = ?');
    expect(photoQuery?.query).not.toContain("ps.status = 'adopted'");
    expect(photoQuery?.bindings).toEqual(['friend-1']);
  });

  it('does not expose an unscoped public gallery', async () => {
    const { app, statements } = harness();
    expect((await app.request('/api/public/nen/adopted-photos')).status).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it('requires the same account and active publication consent in the public gallery', async () => {
    const { app, statements } = harness();
    expect((await app.request('/api/public/nen/adopted-photos?lineAccountId=account-a')).status).toBe(200);
    const query = statements[0];
    expect(query.query).toContain('ps.line_account_id = ? AND f.line_account_id = ?');
    expect(query.query).toContain('ps.publication_consent_at IS NOT NULL');
    expect(query.query).toContain('ps.publication_withdrawn_at IS NULL');
    expect(query.bindings).toEqual(['account-a', 'account-a']);
  });

  it('records and withdraws consent only for the current friend and account', async () => {
    const { app, statements } = harness();
    const consent = await app.request('/api/liff/nen/photos/photo-1/publication-consent', {
      method: 'PUT',
      headers: { Authorization: 'Bearer liff-token', 'content-type': 'application/json' },
      body: JSON.stringify({ consent: true, consentVersion: 'photo-public-v1', showPetName: false }),
    });
    expect(consent.status).toBe(200);
    expect(statements.find((entry) => entry.query.includes('SELECT id, status FROM nen_photo_submissions'))?.bindings)
      .toEqual(['photo-1', 'friend-1', 'account-a']);
    expect(statements.find((entry) => entry.query.includes('publication_consent_version = ?'))?.bindings)
      .toEqual(['photo-public-v1', '2026-08-28 02:00:00', 0, '2026-08-28 02:00:00', 'photo-1', 'friend-1', 'account-a']);

    statements.length = 0;
    const withdraw = await app.request('/api/liff/nen/photos/photo-1/publication-consent', {
      method: 'PUT',
      headers: { Authorization: 'Bearer liff-token', 'content-type': 'application/json' },
      body: JSON.stringify({ consent: false }),
    });
    expect(withdraw.status).toBe(200);
    expect(statements.find((entry) => entry.query.includes('publication_withdrawn_at = ?'))?.bindings)
      .toEqual(['2026-08-28 02:00:00', '2026-08-28 02:00:00', 'photo-1', 'friend-1', 'account-a']);
  });
});
