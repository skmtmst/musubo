import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';

const db = vi.hoisted(() => ({
  archiveFriendAddRule: vi.fn(),
  createFriendAddRuleDraft: vi.fn(),
  ensureFriendAddFallbackRules: vi.fn(),
  getFriendAddRule: vi.fn(),
  listFriendAddRules: vi.fn(),
  listFriendAddRulesPage: vi.fn(),
  publishFriendAddRule: vi.fn(),
  recordFriendAddRuleTest: vi.fn(),
  saveFriendAddRuleDraft: vi.fn(),
  stopFriendAddRule: vi.fn(),
}));

const access = vi.hoisted(() => ({ getVisibleLineAccountScope: vi.fn() }));

vi.mock('@line-crm/db', async (importOriginal) => {
  // segment-conditions は純粋関数。実体は packages/db にあり、
  // services/segment-query.js から再公開される。ここで潰すと条件の
  // 検証・評価が undefined になるため、5つだけ実物を使う。
  const real = await importOriginal<typeof import('@line-crm/db')>();
  return {
    buildPublicSegmentQuery: real.buildPublicSegmentQuery,
    buildSegmentQuery: real.buildSegmentQuery,
    buildSegmentWhere: real.buildSegmentWhere,
    matchesCondition: real.matchesCondition,
    parseCondition: real.parseCondition,
    ...db,
  };
});
vi.mock('../services/account-access.js', () => access);

const { friendAddRules } = await import('./friend-add-rules.js');

function makeApp(staff: AuthenticatedStaff) {
  const result = new Hono<Env>();
  result.use('*', async (c, next) => {
    c.set('staff', staff);
    await next();
  });
  result.route('/', friendAddRules);
  return result;
}

const app = makeApp({
  id: 'staff-1', name: '担当者', role: 'admin', readOnly: false,
  tenantId: 'tenant-1', permissionKeys: ['/friend-add-settings'],
});

const definition = {
  routeIds: ['route-1'],
  scenarioId: 'scenario-1',
  messageType: 'text' as const,
  messageText: 'はじめまして',
  timing: 'immediate' as const,
  actions: [],
  friendCondition: '',
  activeFrom: null,
  activeUntil: null,
};

const rule = {
  id: 'rule-1', line_account_id: 'account-1', friend_kind: 'first_time' as const,
  name: '紹介QR', folder_name: null, priority: 1, is_unknown_route_fallback: 0,
  status: 'draft' as const, current_version_id: null, archived_at: null,
  created_at: '2026-09-06T00:00:00', updated_at: '2026-09-06T00:00:00',
  version_id: 'version-1', version_number: 1, version_status: 'draft' as const,
  definition_snapshot: JSON.stringify(definition), last_test_status: null,
  last_tested_at: null, last_tested_by_staff_id: null, last_tested_by_staff_name: null,
  published_at: null, matched_last_7_days: null,
  lock_version: 1,
};

function makeEnv() {
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn(() => ({
      // 「別アカウントの持ち物か」を見る問い合わせは、このアカウントの
      // 持ち物しか無い前提で空を返す。ここを一律に返すと、自分のタグを
      // 越境扱いにしてしまう。
      all: vi.fn().mockResolvedValue(sql.includes('line_account_id != ') || sql.includes('tenant_id != ')
        ? { results: [] }
        : sql.includes('entry_routes')
          ? { results: [{ id: 'route-1', name: '紹介QR', kind: 'QR' }] }
          : sql.includes('scenarios')
            ? { results: [{ id: 'scenario-1', name: '初回案内' }] }
            : sql.includes('tags')
              ? { results: [{ id: 'tag-1', name: '紹介' }] }
              : { results: [] }),
      first: vi.fn().mockResolvedValue(sql.includes('FROM scenarios')
        ? { id: 'scenario-1' }
        : { today: 1, captured: 1, unknown_route: 0, delivered: 1, failed: 0 }),
      run: vi.fn().mockResolvedValue({ success: true }),
    })),
  }));
  return { DB: { prepare } as unknown as D1Database } as Env['Bindings'];
}

beforeEach(() => {
  vi.clearAllMocks();
  access.getVisibleLineAccountScope.mockResolvedValue({ ids: ['account-1'] });
  db.listFriendAddRules.mockResolvedValue([rule]);
  db.listFriendAddRulesPage.mockResolvedValue({ items: [rule], total: 1, nextCursor: null });
  db.getFriendAddRule.mockResolvedValue(rule);
  db.createFriendAddRuleDraft.mockResolvedValue(rule);
  db.publishFriendAddRule.mockResolvedValue({ ...rule, version_status: 'published', published_at: '2026-09-06T00:01:00' });
});

describe('friend add rules API', () => {
  test('選択できないLINEアカウントの設定を返さない', async () => {
    const response = await app.request('/api/friend-add-rules?account_id=account-2&kind=first_time', {}, makeEnv());
    expect(response.status).toBe(404);
    expect(db.listFriendAddRules).not.toHaveBeenCalled();
  });

  test('一覧はLINEアカウントと判定する人で絞る', async () => {
    const response = await app.request('/api/friend-add-rules?account_id=account-1&kind=first_time', {}, makeEnv());
    expect(response.status).toBe(200);
    expect(db.listFriendAddRulesPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineAccountId: 'account-1', friendKind: 'first_time',
    }));
    const body = await response.json() as { data: { items: Array<{ id: string }> } };
    expect(body.data.items).toEqual([expect.objectContaining({ id: 'rule-1' })]);
  });

  test('参照先を確認して同じLINEアカウントの下書きを作る', async () => {
    const response = await app.request('/api/friend-add-rules/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'friend-rule-create-0001' },
      body: JSON.stringify({ accountId: 'account-1', friendKind: 'first_time', name: '紹介QR', priority: 1, definition }),
    }, makeEnv());
    expect(response.status).toBe(201);
    expect(db.createFriendAddRuleDraft).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineAccountId: 'account-1', friendKind: 'first_time',
    }));
  });

  test('テストは実データを更新せず、成功した下書きに印だけを残す', async () => {
    const response = await app.request('/api/friend-add-rules/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1', ruleId: 'rule-1' }),
    }, makeEnv());
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { stateChanged: boolean; matched: boolean } };
    expect(body.data).toMatchObject({ stateChanged: false, matched: true });
    expect(db.recordFriendAddRuleTest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineAccountId: 'account-1', ruleId: 'rule-1', staffId: 'staff-1', succeeded: true,
    }));
  });

  test('スタッフは機能権限があるときだけテストでき、実施者を記録する', async () => {
    const allowed = makeApp({
      id: 'staff-allowed', name: 'テスト担当', role: 'staff', readOnly: false,
      tenantId: 'tenant-1', permissionKeys: ['/friend-add-settings'],
    });
    const denied = makeApp({
      id: 'staff-denied', name: '権限なし', role: 'staff', readOnly: false,
      tenantId: 'tenant-1', permissionKeys: [],
    });
    const request = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1', ruleId: 'rule-1' }),
    };

    expect((await allowed.request('/api/friend-add-rules/test', request, makeEnv())).status).toBe(200);
    expect(db.recordFriendAddRuleTest).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      staffId: 'staff-allowed',
    }));

    db.recordFriendAddRuleTest.mockClear();
    expect((await denied.request('/api/friend-add-rules/test', request, makeEnv())).status).toBe(403);
    expect(db.recordFriendAddRuleTest).not.toHaveBeenCalled();
    expect((await denied.request('/api/friend-add-rules/rule-1/publish?account_id=account-1', {
      method: 'POST', headers: { 'Idempotency-Key': 'friend-rule-publish-0001' },
    }, makeEnv())).status).toBe(403);
  });

  test('壊れた時間帯（非配列）も保存させない', async () => {
    const response = await app.request('/api/friend-add-rules/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'friend-rule-create-0003' },
      body: JSON.stringify({
        accountId: 'account-1', friendKind: 'first_time', name: '紹介QR', priority: 1,
        definition: { ...definition, timeWindows: 'oops' },
      }),
    }, makeEnv());
    expect(response.status).toBe(400);
    expect(db.createFriendAddRuleDraft).not.toHaveBeenCalled();
  });

  test('不正な時間帯（99:99など）は保存させない', async () => {
    const response = await app.request('/api/friend-add-rules/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'friend-rule-create-0002' },
      body: JSON.stringify({
        accountId: 'account-1', friendKind: 'first_time', name: '紹介QR', priority: 1,
        definition: { ...definition, timeWindows: [{ start: '09:00', end: '99:99' }] },
      }),
    }, makeEnv());
    expect(response.status).toBe(400);
    expect(db.createFriendAddRuleDraft).not.toHaveBeenCalled();
  });

  test('入れ子グループの operator が抜けた友だち条件は保存させない', async () => {
    const nested = JSON.stringify({
      operator: 'AND',
      rules: [],
      // 入れ子側に operator が無い。実行時に既定の OR へ読み替わり、
      // 「両方を満たす人」で絞ったつもりが全体へ広がる。
      groups: [{ rules: [{ type: 'tag_exists', value: 'tag-1' }] }],
    });
    const response = await app.request('/api/friend-add-rules/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'friend-rule-create-0004' },
      body: JSON.stringify({
        accountId: 'account-1', friendKind: 'first_time', name: '紹介QR', priority: 1,
        definition: { ...definition, friendCondition: nested },
      }),
    }, makeEnv());
    expect(response.status).toBe(400);
    expect(db.createFriendAddRuleDraft).not.toHaveBeenCalled();
  });

  test('値の足りない友だち条件は保存させない', async () => {
    const response = await app.request('/api/friend-add-rules/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'friend-rule-create-0005' },
      body: JSON.stringify({
        accountId: 'account-1', friendKind: 'first_time', name: '紹介QR', priority: 1,
        definition: {
          ...definition,
          friendCondition: JSON.stringify({ operator: 'AND', rules: [{ type: 'tag_exists', value: '' }] }),
        },
      }),
    }, makeEnv());
    expect(response.status).toBe(400);
    expect(db.createFriendAddRuleDraft).not.toHaveBeenCalled();
  });

  test('正しい入れ子の友だち条件は保存できる', async () => {
    const nested = JSON.stringify({
      operator: 'AND',
      rules: [],
      groups: [{ operator: 'OR', rules: [{ type: 'tag_exists', value: 'tag-1' }] }],
    });
    const response = await app.request('/api/friend-add-rules/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'friend-rule-create-0006' },
      body: JSON.stringify({
        accountId: 'account-1', friendKind: 'first_time', name: '紹介QR', priority: 1,
        definition: { ...definition, friendCondition: nested },
      }),
    }, makeEnv());
    expect(response.status).toBe(201);
  });

  test('R30: シナリオ未選択の未完成でも下書きは作れる', async () => {
    const response = await app.request('/api/friend-add-rules/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'friend-rule-create-r30' },
      body: JSON.stringify({
        accountId: 'account-1', friendKind: 'first_time', name: '仮の案内', priority: 1,
        definition: { ...definition, routeIds: [], scenarioId: null },
      }),
    }, makeEnv());
    expect(response.status).toBe(201);
    expect(db.createFriendAddRuleDraft).toHaveBeenCalled();
  });

  test('R30: シナリオ未選択の未完成でも下書きへ上書き保存できる', async () => {
    db.saveFriendAddRuleDraft.mockResolvedValue(rule);
    const response = await app.request('/api/friend-add-rules/rule-1/draft?account_id=account-1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'friend-rule-save-r30' },
      body: JSON.stringify({
        accountId: 'account-1', friendKind: 'first_time', name: '仮の案内', priority: 1, version: 1,
        definition: { ...definition, routeIds: [], scenarioId: null },
      }),
    }, makeEnv());
    expect(response.status).toBe(200);
    expect(db.saveFriendAddRuleDraft).toHaveBeenCalled();
  });

  test('R30: 使えない参照先を入れた下書きは作らせない', async () => {
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    }));
    const env = { DB: { prepare } } as unknown as Env['Bindings'];
    const response = await app.request('/api/friend-add-rules/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'friend-rule-create-r30-foreign' },
      body: JSON.stringify({
        accountId: 'account-1', friendKind: 'first_time', name: 'よその持ち物', priority: 1,
        definition,
      }),
    }, env);
    expect(response.status).toBe(400);
    expect(db.createFriendAddRuleDraft).not.toHaveBeenCalled();
  });

  test('R30: 未完成の下書きはテストで理由付きで失敗する（公開ゲート）', async () => {
    db.getFriendAddRule.mockResolvedValueOnce({
      ...rule,
      definition_snapshot: JSON.stringify({ ...definition, routeIds: [], scenarioId: null }),
    });
    const response = await app.request('/api/friend-add-rules/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1', ruleId: 'rule-1' }),
    }, makeEnv());
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { matched: boolean; reasons: string[] } };
    expect(body.success).toBe(false);
    expect(body.data.matched).toBe(false);
    expect(body.data.reasons.join('\n')).toContain('シナリオ');
    expect(db.recordFriendAddRuleTest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ruleId: 'rule-1', succeeded: false,
    }));
  });

  /*
   * 経路未選択・期限切れは設定の欠陥として拒む。曜日・時間帯・経路の不一致は理由付きで非選択と返す。
   * 公開のために曜日を待たせないよう、時間の不一致だけではテスト失敗にしない。
   */
  test('R262: 流入リンク未選択・期限切れはテストで止まる', async () => {
    db.getFriendAddRule.mockResolvedValueOnce({
      ...rule,
      definition_snapshot: JSON.stringify({ ...definition, routeIds: [], activeUntil: '2020-01-01T00:00' }),
    });
    const response = await app.request('/api/friend-add-rules/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1', ruleId: 'rule-1' }),
    }, makeEnv());
    const body = await response.json() as { success: boolean; data: { matched: boolean; reasons: string[] } };
    expect(body.success).toBe(false);
    expect(body.data.matched).toBe(false);
    expect(body.data.reasons).toEqual(expect.arrayContaining([
      '対象の流入リンクが選ばれていません。流入条件で1つ以上選んでください。',
      '有効期間の終了時刻が過ぎています。終了を延ばすか、この設定を消してください。',
    ]));
  });

  test('R262: 対象外の曜日・経路では「選ばれない」と理由を返す', async () => {
    db.getFriendAddRule.mockResolvedValueOnce({
      ...rule,
      definition_snapshot: JSON.stringify({ ...definition, weekdays: [0] }),
    });
    // 2026-09-28（月）10:00 JST は weekdays:[0]（日曜のみ）の外側。
    const response = await app.request('/api/friend-add-rules/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-1', ruleId: 'rule-1',
        routeId: 'route-9', expectedAt: '2026-09-28T10:00',
      }),
    }, makeEnv());
    const body = await response.json() as { success: boolean; data: { matched: boolean; reasons: string[] } };
    expect(body.success).toBe(true);
    expect(body.data.matched).toBe(false);
    expect(body.data.reasons).toEqual(expect.arrayContaining([
      'この曜日は配信対象ではありません。',
      '試した流入リンクはこの設定の対象ではありません。',
    ]));
    // 曜日の不一致は設定の欠陥ではないため、テスト成功（公開の鍵）は残す。
    expect(db.recordFriendAddRuleTest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ruleId: 'rule-1', succeeded: true,
    }));
  });

  test('R31: 一覧のまとめは直近7日にそろえ、送信は実際に送った数で数える', async () => {
    const env = makeEnv();
    const response = await app.request('/api/friend-add-rules?account_id=account-1&kind=first_time', {}, env);
    expect(response.status).toBe(200);
    const statements = (env.DB.prepare as unknown as { mock: { calls: Array<[string]> } })
      .mock.calls.map((args) => String(args[0]));
    const summarySql = statements.find((sql) => sql.includes('recent_adds'));
    expect(summarySql).toBeDefined();
    const weekly = summarySql!.match(/occurred_at >= strftime\('%Y-%m-%dT%H:%M:%f', 'now', '\+9 hours', '-7 days'\)/g) ?? [];
    expect(weekly.length).toBeGreaterThanOrEqual(5);
    expect(summarySql).toContain('delivery_count');
    expect(summarySql).toContain('partial_failed');
  });

  test('公開は冪等キーをDB処理へ渡す', async () => {
    const response = await app.request('/api/friend-add-rules/rule-1/publish?account_id=account-1', {
      method: 'POST', headers: { 'Idempotency-Key': 'friend-rule-publish-0001' },
    }, makeEnv());
    expect(response.status).toBe(200);
    expect(db.publishFriendAddRule).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      idempotencyKey: 'friend-rule-publish-0001',
    }));
  });

  describe('M007/M008 存在しない設定の削除・公開', () => {
    test('M007: 存在しない設定の削除は404（受け皿の409と混ぜない）', async () => {
      db.getFriendAddRule.mockResolvedValue(null);
      const response = await app.request('/api/friend-add-rules/gone?account_id=account-1', {
        method: 'DELETE',
      }, makeEnv());
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        success: false, error: '見つかりません（一覧を読み直してください）',
      });
      expect(db.archiveFriendAddRule).not.toHaveBeenCalled();
    });

    test('M007: 共通あいさつ（受け皿）の削除は409のまま', async () => {
      db.getFriendAddRule.mockResolvedValue({ ...rule, is_unknown_route_fallback: 1 });
      const response = await app.request('/api/friend-add-rules/rule-1?account_id=account-1', {
        method: 'DELETE',
      }, makeEnv());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        success: false, error: '経路が分からなかった人の設定は削除できません',
      });
      expect(db.archiveFriendAddRule).not.toHaveBeenCalled();
    });

    test('M007: ある設定の削除は成功する', async () => {
      db.archiveFriendAddRule.mockResolvedValue(undefined);
      const response = await app.request('/api/friend-add-rules/rule-1?account_id=account-1', {
        method: 'DELETE',
      }, makeEnv());
      expect(response.status).toBe(200);
      expect(db.archiveFriendAddRule).toHaveBeenCalledWith(expect.anything(), { lineAccountId: 'account-1', ruleId: 'rule-1' });
    });

    test('確認した版と状態を条件付き保管に渡す', async () => {
      db.archiveFriendAddRule.mockResolvedValue(undefined);
      const response = await app.request('/api/friend-add-rules/rule-1?account_id=account-1&expected_version=1&expected_status=draft', { method: 'DELETE' }, makeEnv());
      expect(response.status).toBe(200);
      expect(db.archiveFriendAddRule).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: 1, expectedStatus: 'draft' }));
    });
    test('保管の版が食い違う時は409にする', async () => {
      db.archiveFriendAddRule.mockRejectedValue(new Error('FRIEND_ADD_RULE_VERSION_CONFLICT'));
      const response = await app.request('/api/friend-add-rules/rule-1?account_id=account-1&expected_version=1&expected_status=draft', { method: 'DELETE' }, makeEnv());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ success: false, code: 'VERSION_CONFLICT' });
    });
    test('版だけの不完全な指定は保管しない', async () => {
      const response = await app.request('/api/friend-add-rules/rule-1?account_id=account-1&expected_version=1', { method: 'DELETE' }, makeEnv());
      expect(response.status).toBe(400);
      expect(db.archiveFriendAddRule).not.toHaveBeenCalled();
    });

    test('M008: 存在しない設定の公開は404（500にしない）', async () => {
      db.getFriendAddRule.mockResolvedValue(null);
      db.publishFriendAddRule.mockRejectedValue(new Error('FRIEND_ADD_RULE_DRAFT_NOT_FOUND'));
      const response = await app.request('/api/friend-add-rules/gone/publish?account_id=account-1', {
        method: 'POST', headers: { 'Idempotency-Key': 'friend-rule-publish-0002' },
      }, makeEnv());
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        success: false, error: '見つかりません（一覧を読み直してください）',
      });
    });

    test('M008: 下書きの無い既存設定の公開は409', async () => {
      db.publishFriendAddRule.mockRejectedValue(new Error('FRIEND_ADD_RULE_DRAFT_NOT_FOUND'));
      const response = await app.request('/api/friend-add-rules/rule-1/publish?account_id=account-1', {
        method: 'POST', headers: { 'Idempotency-Key': 'friend-rule-publish-0003' },
      }, makeEnv());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        success: false, error: '公開できる下書きがありません。最新の状態を読み直してください',
      });
    });
  });
});
