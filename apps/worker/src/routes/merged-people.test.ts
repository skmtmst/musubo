import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const personMocks = vi.hoisted(() => {
  class TestMergedPersonError extends Error {
    constructor(
      public readonly status: 400 | 403 | 404 | 409 | 422,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    getMergedPerson: vi.fn(),
    listMergedPeople: vi.fn(),
    mergedPersonAccountIds: vi.fn(),
    unlinkMergedPersonFriend: vi.fn(),
    updateMergedPerson: vi.fn(),
    updateMergedPersonDeliveryPriorities: vi.fn(),
    MergedPersonError: TestMergedPersonError,
  };
});

const accessMocks = vi.hoisted(() => ({
  canAccessAllLineAccounts: vi.fn(),
  getVisibleLineAccountScope: vi.fn(),
}));

const profileMocks = vi.hoisted(() => ({
  getFriendProfileCandidates: vi.fn(),
  resolveProfileCandidateSelections: vi.fn(),
}));

vi.mock('../services/merged-people.js', () => personMocks);
vi.mock('../services/account-access.js', () => accessMocks);
vi.mock('../features/friends/friend-profile-candidates.js', () => profileMocks);

const { mergedPeople } = await import('./merged-people.js');

const detail = {
  id: 'user-a', status: 'active', revision: 1, primaryDisplayName: '見本 171',
  linkedFriends: [{
    friendId: 'friend-a', displayName: '見本 171', lineAccountId: 'account-a',
    lineAccountName: '本店', isFollowing: true, linkedAt: '2026-08-30',
    linkMethod: 'operator_review', confidence: 92, candidateId: 'candidate-a', candidateVersion: 2,
  }],
  profileValues: [{
    fieldKey: 'email', fieldLabel: 'メール', valuePreview: 'ta***@example.com',
    sourceType: 'form', sourceLabel: '来店アンケート', sourceFriendId: 'friend-a',
    verifiedAt: null, selectedByName: '担当者', selectedAt: '2026-08-30', updateMode: 'fixed',
  }],
  deliveryPriorities: [], history: [], createdAt: '2026-08-30', updatedAt: '2026-08-30', archivedAt: null,
};

function harness(options?: { role?: 'owner' | 'admin' | 'staff'; permissions?: string[] }) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.env = { DB: {} as D1Database } as Env['Bindings'];
    c.set('staff', {
      id: 'staff-a', name: '担当者', role: options?.role ?? 'owner', readOnly: false,
      tenantId: 'tenant-a', permissionKeys: options?.permissions ?? ['/friends'],
      assignedLineAccountId: null, canAccessDescendantAccounts: false,
    });
    await next();
  });
  app.route('/', mergedPeople);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  personMocks.getMergedPerson.mockResolvedValue(detail);
  personMocks.listMergedPeople.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
  personMocks.mergedPersonAccountIds.mockResolvedValue(['account-a']);
  personMocks.updateMergedPerson.mockResolvedValue({ ...detail, revision: 2 });
  personMocks.updateMergedPersonDeliveryPriorities.mockResolvedValue({ ...detail, revision: 2 });
  personMocks.unlinkMergedPersonFriend.mockResolvedValue({
    personId: 'user-a', friendId: 'friend-a', revision: 2, unlinkedAt: '2026-08-31',
  });
  accessMocks.canAccessAllLineAccounts.mockResolvedValue(true);
  accessMocks.getVisibleLineAccountScope.mockResolvedValue({ allowedAccountIds: ['account-a'] });
  profileMocks.getFriendProfileCandidates.mockResolvedValue({
    profileCandidates: [], tagCandidates: [],
  });
  profileMocks.resolveProfileCandidateSelections.mockResolvedValue([{
    fieldKey: 'display_name', fieldLabel: 'LINE表示名', value: '見本 171',
    valuePreview: '見本 171', sourceType: 'friend', sourceId: 'friend-a',
    sourceLabel: '見本 171', sourceFriendId: 'friend-a', verifiedAt: null,
    updateMode: 'fixed',
  }]);
});

describe('merged person HTTP contract', () => {
  it.each(['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=100001', 'offset=abc'])(
    'ページ指定%sを400で断り、一覧を取得しない', async (query) => {
      const response = await harness().request(`/api/friends/people?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'INVALID_PAGINATION' });
      expect(personMocks.listMergedPeople).not.toHaveBeenCalled();
    },
  );

  it('returns the normal detail shape only after every linked account is authorized', async () => {
    const response = await harness({ role: 'staff' }).request('/api/friends/people/user-a');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true, data: { ...detail, profileCandidates: [], tagCandidates: [] },
    });
    expect(accessMocks.canAccessAllLineAccounts).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ id: 'staff-a' }), ['account-a'],
    );
  });

  it('does not load or leak profile details outside the visible account scope', async () => {
    accessMocks.canAccessAllLineAccounts.mockResolvedValue(false);
    const response = await harness({ role: 'staff' }).request('/api/friends/people/user-a');
    expect(response.status).toBe(403);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain('田中');
    expect(body).not.toContain('ta***@example.com');
    expect(personMocks.getMergedPerson).not.toHaveBeenCalled();
  });

  it('requires owner or admin for profile changes and parses the expected revision', async () => {
    const denied = await harness({ role: 'staff' }).request('/api/friends/people/user-a', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, primaryDisplayName: '新しい名前' }),
    });
    expect(denied.status).toBe(403);

    const accepted = await harness({ role: 'admin' }).request('/api/friends/people/user-a', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, primaryDisplayName: '新しい名前' }),
    });
    expect(accepted.status).toBe(200);
    expect(personMocks.updateMergedPerson).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'staff-a', name: '担当者', tenantId: 'tenant-a' },
      'user-a',
      { expectedRevision: 1, primaryDisplayName: '新しい名前' },
    );
  });

  it('returns 400 for malformed JSON and 409 for a stale revision', async () => {
    const malformed = await harness().request('/api/friends/people/user-a', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ success: false, code: 'INVALID_JSON' });

    personMocks.updateMergedPerson.mockRejectedValue(
      new personMocks.MergedPersonError(
        409, 'STALE_PERSON', '別の人が先に変更しました。最新の状態を読み直してください',
      ),
    );
    const stale = await harness().request('/api/friends/people/user-a', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, primaryDisplayName: '新しい名前' }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ success: false, code: 'STALE_PERSON' });
  });

  it('rejects raw profile values on the generic update endpoint', async () => {
    const response = await harness({ role: 'admin' }).request('/api/friends/people/user-a', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        profileSelections: [{
          fieldKey: 'display_name', fieldLabel: 'LINE表示名', value: '平文の値',
          valuePreview: '平文の値', sourceType: 'manual', sourceId: null,
          sourceLabel: '手入力', sourceFriendId: null, verifiedAt: null, updateMode: 'fixed',
        }],
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      success: false, code: 'PROFILE_CANDIDATE_REQUIRED',
    });
    expect(personMocks.updateMergedPerson).not.toHaveBeenCalled();
  });

  it('adopts a profile candidate by candidate id without receiving the raw value', async () => {
    const candidateId = `pc_${'a'.repeat(64)}`;
    const denied = await harness({ role: 'staff' }).request(
      '/api/friends/people/user-a/profile-values',
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          selections: [{ fieldKey: 'display_name', candidateId, updateMode: 'fixed' }],
        }),
      },
    );
    expect(denied.status).toBe(403);
    expect(profileMocks.resolveProfileCandidateSelections).not.toHaveBeenCalled();

    const accepted = await harness({ role: 'admin' }).request(
      '/api/friends/people/user-a/profile-values',
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          selections: [{ fieldKey: 'display_name', candidateId, updateMode: 'fixed' }],
        }),
      },
    );
    expect(accepted.status).toBe(200);
    expect(profileMocks.resolveProfileCandidateSelections).toHaveBeenCalledWith(
      expect.anything(), ['friend-a'],
      [{ fieldKey: 'display_name', candidateId, updateMode: 'fixed' }],
    );
    expect(personMocks.updateMergedPerson).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'staff-a', name: '担当者', tenantId: 'tenant-a' },
      'user-a',
      expect.objectContaining({ expectedRevision: 1, profileSelections: expect.any(Array) }),
    );
  });

  it('returns 409 when the selected profile candidate changed after it was displayed', async () => {
    profileMocks.resolveProfileCandidateSelections.mockRejectedValue(
      new Error('PROFILE_CANDIDATE_STALE'),
    );
    const response = await harness({ role: 'admin' }).request(
      '/api/friends/people/user-a/profile-values',
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 1,
          selections: [{
            fieldKey: 'display_name', candidateId: `pc_${'b'.repeat(64)}`, updateMode: 'fixed',
          }],
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false, code: 'STALE_PROFILE_CANDIDATE',
    });
    expect(personMocks.updateMergedPerson).not.toHaveBeenCalled();
  });

  it('accepts an explicit empty priority list instead of turning it into missing data', async () => {
    const response = await harness().request(
      '/api/friends/people/user-a/delivery-priorities',
      {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1, priorities: [] }),
      },
    );
    expect(response.status).toBe(200);
    expect(personMocks.updateMergedPersonDeliveryPriorities).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'user-a', { expectedRevision: 1, priorities: [] },
    );
  });

  it('returns an empty people list and passes the visible account scope', async () => {
    const response = await harness({ role: 'staff' }).request('/api/friends/people');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true, data: { items: [], total: 0, limit: 20, offset: 0,
        sort: [{ field: 'updatedAt', direction: 'desc' }, { field: 'id', direction: 'asc' }] },
    });
    expect(personMocks.listMergedPeople).toHaveBeenCalledWith(
      expect.anything(), 'tenant-a', ['account-a'], 20, 0,
    );
  });

  it('requires admin and a current revision for non-destructive unlink', async () => {
    const denied = await harness({ role: 'staff' }).request(
      '/api/friends/people/user-a/links/friend-a',
      { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(denied.status).toBe(403);

    const accepted = await harness({ role: 'admin' }).request(
      '/api/friends/people/user-a/links/friend-a',
      {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1, reason: '本人から別人と確認しました' }),
      },
    );
    expect(accepted.status).toBe(200);
    expect(personMocks.unlinkMergedPersonFriend).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'staff-a', name: '担当者', tenantId: 'tenant-a' },
      'user-a', 'friend-a',
      { expectedRevision: 1, reason: '本人から別人と確認しました' },
    );
  });
});
