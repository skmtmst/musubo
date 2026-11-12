import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';

const mocks = {
  getFriendFields: vi.fn(),
  getVersionedAccountSetting: vi.fn(async()=>null),
  getFriendFieldsForScope: vi.fn(),
  getFriendFieldById: vi.fn(),
  getFriendFieldByIdForScope: vi.fn(),
  createFriendField: vi.fn(),
  createFriendFieldForScope: vi.fn(),
  createFriendFieldIdempotent: vi.fn(),
  FriendFieldCreateError: class FriendFieldCreateError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  updateFriendField: vi.fn(),
  reorderFriendFields: vi.fn(),
  deleteFriendField: vi.fn(),
  countFriendFieldValues: vi.fn(),
  countFriendFieldValuesForScope: vi.fn(),
  countFriendFieldValuesForScopes: vi.fn(),
  getFriendFieldListSummary: vi.fn(),
  getFriendFieldUsageForScope: vi.fn(),
  getFriendFieldValuesForMigration: vi.fn(),
  createFieldMigrationPreview: vi.fn(),
  getFieldMigrationRun: vi.fn(),
  getFieldMigrationRunByToken: vi.fn(),
  getFieldMigrationRunByIdempotencyKey: vi.fn(),
  getFieldMigrationItems: vi.fn(),
  queueFieldMigration: vi.fn(),
  markFieldMigrationStale: vi.fn(),
  executeFieldMigration: vi.fn(),
  getFriendFieldsWithValues: vi.fn(),
  getFriendById: vi.fn(),
  setFriendFieldValue: vi.fn(),
  setFriendFieldValuesBulk: vi.fn(),
  // 単票 PUT は1件ずつ書かず、1人の複数項目を1回の batch で書く。
  setFriendFieldValuesForFriend: vi.fn(),
  jstNow: () => '2026-09-14T00:00:00.000+09:00',
  recordLoginAudit: vi.fn(),
  validateFriendFieldValue: vi.fn(),
  validateFieldKey: (key: unknown) =>
    typeof key === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(key) && key !== 'name'
      ? { ok: true as const }
      : { ok: false as const, error: 'bad key' },
  FRIEND_FIELD_TYPES: [
    'text',
    'textarea',
    'number',
    'date',
    'datetime',
    'time',
    'select',
    'multi_select',
    'checkbox',
    'url',
    'tel',
    'email',
    'image',
    'pdf',
  ],
  getFolderById: vi.fn(),
};
vi.mock('@line-crm/db', () => mocks);
const accountMocks = {
  getVisibleLineAccountScope: vi.fn().mockResolvedValue({ allowedAccountIds: ['account-1'] }),
  canAccessAllLineAccounts: vi.fn().mockResolvedValue(true),
};
vi.mock('../services/account-access.js', () => ({
  getVisibleLineAccountScope: accountMocks.getVisibleLineAccountScope,
  canAccessAllLineAccounts: accountMocks.canAccessAllLineAccounts,
}));

const { friendFields } = await import('./friend-fields.js');

// 口の契約テストは本物の検証関数で動かす。検証のすり替えでは
// 「型違いを422で止める」契約を証明できないため。
const { validateFriendFieldValue: realValidateFriendFieldValue } =
  await vi.importActual<typeof import('@line-crm/db')>('@line-crm/db');

function makeApp(
  role: 'owner' | 'admin' | 'staff' = 'owner',
  tenantId: string | null = 'tenant-1',
  permissionKeys: string[] = [],
  viewPermissionKeys: string[] = [],
) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'u-1', name: 'テスト', role, readOnly: false, tenantId, permissionKeys, viewPermissionKeys });
    return next();
  });
  app.route('/', friendFields);
  return app;
}

const env = { DB: {} as D1Database };

function req(
  app: ReturnType<typeof makeApp>,
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.fetch(
    new Request(`https://example.com${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

/** 項目作成の口を叩く。で要求キーが必須になったため、鍵を付けて送る。 */
function createReq(app: ReturnType<typeof makeApp>, body: unknown, key = 'field-key-1') {
  return req(app, '/api/friend-fields?lineAccountId=account-1', 'POST', body, {
    'Idempotency-Key': key,
  });
}

const FIELD = {
  id: 'ff-1',
  folder_id: null,
  name: 'ペットの名前',
  field_key: 'pet_name',
  type: 'text',
  options_json: null,
  default_value: null,
  source: 'manual',
  ec_field_path: null,
  ec_is_master: 0,
  is_personal: 0,
  is_starred: 0,
  display_order: 0,
  created_at: '2026-08-16',
  updated_at: '2026-08-16',
  status: 'active',
  version: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  accountMocks.getVisibleLineAccountScope.mockResolvedValue({ allowedAccountIds: ['account-1'] });
  accountMocks.canAccessAllLineAccounts.mockResolvedValue(true);
  mocks.getFriendById.mockResolvedValue({ id: 'f-1', line_account_id: 'account-1' });
  mocks.getFriendFields.mockResolvedValue([FIELD]);
  mocks.getFriendFieldsForScope.mockImplementation(async()=>[...await mocks.getFriendFields(),...await mocks.getFriendFieldsWithValues()]);
  mocks.getFriendFieldById.mockResolvedValue(FIELD);
  mocks.getFriendFieldByIdForScope.mockResolvedValue({ ...FIELD, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 });
  mocks.createFriendField.mockResolvedValue(FIELD);
  mocks.createFriendFieldForScope.mockResolvedValue({ ...FIELD, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 });
  mocks.createFriendFieldIdempotent.mockResolvedValue({
    field: { ...FIELD, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 },
    replayed: false,
  });
  mocks.updateFriendField.mockResolvedValue(FIELD);
  mocks.reorderFriendFields.mockResolvedValue(undefined);
  mocks.countFriendFieldValues.mockResolvedValue(0);
  mocks.countFriendFieldValuesForScope.mockResolvedValue(0);
  mocks.countFriendFieldValuesForScopes.mockResolvedValue(new Map());
  mocks.getFriendFieldListSummary.mockResolvedValue({ total: 1, inUse: 0, registeredFriends: 0, formLinks: null, updatedThisMonth: 0 });
  mocks.getFriendFieldUsageForScope.mockResolvedValue([]);
  mocks.getFriendFieldValuesForMigration.mockResolvedValue([]);
  mocks.createFieldMigrationPreview.mockResolvedValue(undefined);
  mocks.getFieldMigrationRun.mockResolvedValue(null);
  mocks.getFieldMigrationRunByToken.mockResolvedValue(null);
  mocks.getFieldMigrationRunByIdempotencyKey.mockResolvedValue(null);
  mocks.getFieldMigrationItems.mockResolvedValue([]);
  mocks.queueFieldMigration.mockResolvedValue(true);
  mocks.markFieldMigrationStale.mockResolvedValue(undefined);
  mocks.executeFieldMigration.mockResolvedValue(undefined);
  mocks.getFolderById.mockResolvedValue({ id: 'folder-1', kind: 'friend_field' });
  mocks.getFriendFieldsWithValues.mockResolvedValue([{ ...FIELD, value: null, updated_by: null }]);
  mocks.validateFriendFieldValue.mockImplementation(realValidateFriendFieldValue);
});

describe('項目の作成', () => {
  it('差し込み名の形が正しければ作れる', async () => {
    const res = await createReq(makeApp(), {
      name: 'ペットの名前',
      fieldKey: 'pet_name',
      type: 'text',
    });
    expect(res.status).toBe(201);
    expect(mocks.createFriendFieldIdempotent).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({ name: 'ペットの名前', fieldKey: 'pet_name' }),
      'field-key-1',
    );
  });

  it('R515: 要求キーなしの作成は実行しない', async () => {
    const res = await req(makeApp(), '/api/friend-fields?lineAccountId=account-1', 'POST', {
      name: 'ペットの名前',
      fieldKey: 'pet_name',
      type: 'text',
    });
    expect(res.status).toBe(400);
    expect(mocks.createFriendFieldIdempotent).not.toHaveBeenCalled();
  });

  it('R515: 同じ要求キーの再送は保存済みを200で返す', async () => {
    mocks.createFriendFieldIdempotent.mockResolvedValue({
      field: { ...FIELD, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 },
      replayed: true,
    });
    const res = await createReq(makeApp(), { name: 'ペットの名前', fieldKey: 'pet_name', type: 'text' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { id: 'ff-1' } });
  });

  it('R515: 同じ要求キーに異なる内容は409で止める', async () => {
    mocks.createFriendFieldIdempotent.mockRejectedValue(
      new mocks.FriendFieldCreateError('idempotency_conflict', '同じ要求キーに異なる内容が指定されました'),
    );
    const res = await createReq(makeApp(), { name: '別の名前', fieldKey: 'other_key', type: 'text' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'idempotency_conflict' });
  });

  it('差し込み名の形が違えば422', async () => {
    const res = await createReq(makeApp(), {
      name: 'x',
      fieldKey: 'ペット',
      type: 'text',
    });
    expect(res.status).toBe(422);
    expect(mocks.createFriendFieldIdempotent).not.toHaveBeenCalled();
  });

  it('知らない種類は422', async () => {
    const res = await createReq(makeApp(), {
      name: 'x',
      fieldKey: 'x',
      type: 'rating',
    });
    expect(res.status).toBe(422);
  });

  it('選択肢は文字列の配列だけ', async () => {
    const res = await createReq(makeApp(), {
      name: 'x',
      fieldKey: 'x',
      type: 'select',
      options: [1, 2],
    });
    expect(res.status).toBe(422);
  });

  it('差し込み名が重複したら409', async () => {
    mocks.createFriendFieldIdempotent.mockRejectedValue(new Error('UNIQUE constraint failed'));
    const res = await createReq(makeApp(), {
      name: 'x',
      fieldKey: 'dup',
      type: 'text',
    });
    expect(res.status).toBe(409);
  });

  it.each(['datetime', 'time', 'image', 'pdf'])('%s項目を作れる', async (type) => {
    const res = await createReq(makeApp(), {
      name: type,
      fieldKey: `field_${type}`,
      type,
    });
    expect(res.status).toBe(201);
    expect(mocks.createFriendFieldIdempotent).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({ type }),
      expect.anything(),
    );
  });

describe('R181 既定値は個別値と同じ物差しで検証する', () => {
  async function createDefault(type: string, defaultValue: unknown) {
    return createReq(makeApp(), {
      name: '検査項目', fieldKey: `check_${type}`, type, defaultValue,
    });
  }

  it('存在しない日付の既定値は422', async () => {
    const res = await createDefault('date', '2026-02-31');
    expect(res.status).toBe(422);
    expect(mocks.createFriendFieldIdempotent).not.toHaveBeenCalled();
  });

  it('うるう日の既定値は作れる', async () => {
    const res = await createDefault('date', '2028-02-29');
    expect(res.status).toBe(201);
  });

  it('存在しない日時の既定値は422', async () => {
    const res = await createDefault('datetime', '2026-02-31T10:00:00+09:00');
    expect(res.status).toBe(422);
    expect(mocks.createFriendFieldIdempotent).not.toHaveBeenCalled();
  });

  it('数字のない電話番号の既定値は422', async () => {
    const res = await createDefault('tel', '--------');
    expect(res.status).toBe(422);
    expect(mocks.createFriendFieldIdempotent).not.toHaveBeenCalled();
  });

  it('正しい電話番号の既定値は作れる', async () => {
    const res = await createDefault('tel', '090-0000-5678');
    expect(res.status).toBe(201);
  });

  it('個別値でも存在しない日時・数字なし電話番号は422', async () => {
    mocks.getFriendFields.mockResolvedValue([
      { ...FIELD, id: 'ff-dt', field_key: 'at', type: 'datetime' },
      { ...FIELD, id: 'ff-tel', field_key: 'tel', type: 'tel' },
    ]);
    for (const values of [{ 'ff-dt': '2026-02-31T10:00:00+09:00' }, { 'ff-tel': '--------' }]) {
      const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', { values });
      expect(res.status).toBe(422);
    }
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  });
});

  it('選択肢を不変ID付きで保存する', async () => {
    const res = await createReq(makeApp(), {
      name: '都道府県', fieldKey: 'prefecture', type: 'select', options: ['東京', '大阪'], defaultValue: '東京',
    });
    expect(res.status).toBe(201);
    const input = mocks.createFriendFieldIdempotent.mock.calls.at(-1)?.[2] as { optionsJson: string; defaultValue: string };
    const options = JSON.parse(input.optionsJson) as Array<{ id: string; label: string }>;
    expect(options.map((item) => item.label)).toEqual(['東京', '大阪']);
    expect(options.every((item) => item.id.length > 0)).toBe(true);
    expect(input.defaultValue).toBe(options[0].id);
  });

  it('画像・PDFの既定値と本文差し込みを拒否する', async () => {
    const res = await createReq(makeApp(), {
      name: '本人確認', fieldKey: 'identity_file', type: 'pdf', defaultValue: 'media-1', allowTextInsertion: true,
    });
    expect(res.status).toBe(422);
    expect(mocks.createFriendFieldIdempotent).not.toHaveBeenCalled();
  });

  it('staffは定義を作れない', async () => {
    const res = await req(makeApp('staff'), '/api/friend-fields?lineAccountId=account-1', 'POST', {
      name: '項目', fieldKey: 'field', type: 'text',
    });
    expect(res.status).toBe(403);
  });
});

describe('LINEアカウントの境界', () => {
  it('選択中アカウントが無ければ一覧を返さない', async () => {
    const res = await req(makeApp(), '/api/friend-fields', 'GET');
    expect(res.status).toBe(400);
    expect(mocks.getFriendFieldsForScope).not.toHaveBeenCalled();
  });

  it('担当外アカウントは存在を明かさず404', async () => {
    const res = await req(makeApp(), '/api/friend-fields?lineAccountId=account-2', 'GET');
    expect(res.status).toBe(404);
    expect(mocks.getFriendFieldsForScope).not.toHaveBeenCalled();
  });

  it('使用人数・回答フォーム数・使用先を実データから返す', async () => {
    mocks.countFriendFieldValuesForScopes.mockResolvedValue(new Map([['ff-1', 3]]));
    mocks.getFriendFieldUsageForScope.mockResolvedValue([
      { kind: 'form', id: 'form-1', name: '申込フォーム', fieldId: 'ff-1', switchable: true },
      { kind: 'reminder', id: 'reminder-1', name: '誕生日通知', fieldId: 'ff-1', switchable: true },
    ]);
    const res = await req(makeApp(), '/api/friend-fields?lineAccountId=account-1&withUsage=1', 'GET');
    const body = await res.json() as { data: Array<{ usageCount: number; formUsageCount: number; displayTargets: string[] }> };
    expect(body.data[0]).toMatchObject({
      usageCount: 3, formUsageCount: 1, displayTargets: ['申込フォーム', '誕生日通知'],
    });
    /* 件数は一括集計の1回だけ。項目ごとの count は呼ばない(N+1にしない)。 */
    expect(mocks.countFriendFieldValuesForScopes).toHaveBeenCalledTimes(1);
    expect(mocks.countFriendFieldValuesForScope).not.toHaveBeenCalled();
  });
});

describe('項目の更新', () => {
  it('種類は変えられない', async () => {
    // 既に入っている値の意味が変わる（「犬」が数値項目になる等）。
    const res = await req(makeApp(), '/api/friend-fields/ff-1?lineAccountId=account-1', 'PATCH', { type: 'number' });
    expect(res.status).toBe(422);
    expect(mocks.updateFriendField).not.toHaveBeenCalled();
  });

  it('差し込み名も変えられない', async () => {
    // テンプレートの差し込みが黙って空になる。
    const res = await req(makeApp(), '/api/friend-fields/ff-1?lineAccountId=account-1', 'PATCH', { fieldKey: 'other' });
    expect(res.status).toBe(422);
  });

  it('同じ値を送るぶんには通る', async () => {
    const res = await req(makeApp(), '/api/friend-fields/ff-1?lineAccountId=account-1', 'PATCH', {
      type: 'text',
      fieldKey: 'pet_name',
      name: '新しい名前',
    });
    expect(res.status).toBe(200);
  });

  it('保存中にversionが変わったら409', async () => {
    mocks.updateFriendField.mockResolvedValue(null);
    const res = await req(makeApp(), '/api/friend-fields/ff-1?lineAccountId=account-1', 'PATCH', {
      version: 1, name: '新しい名前',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('R517: 版の衝突では最新の内容を付けて返す', async () => {
    mocks.updateFriendField.mockResolvedValue(null);
    mocks.getFriendFieldByIdForScope.mockResolvedValue({
      ...FIELD, id: 'ff-1', name: 'Bの名前', version: 2,
      line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0,
    });
    const res = await req(makeApp(), '/api/friend-fields/ff-1?lineAccountId=account-1', 'PATCH', {
      version: 1, name: 'Aの名前',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'VERSION_CONFLICT',
      data: { latest: { id: 'ff-1', name: 'Bの名前', version: 2 } },
    });
  });
});

describe('項目の削除', () => {
  it('値が入っていれば人数を返して止める', async () => {
    mocks.countFriendFieldValuesForScope.mockResolvedValue(12);
    const res = await req(makeApp(), '/api/friend-fields/ff-1?lineAccountId=account-1', 'DELETE');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { usageCount: number; code: string };
    expect(body).toMatchObject({ usageCount: 12, code: 'IN_USE' });
    expect(mocks.deleteFriendField).not.toHaveBeenCalled();
  });

  it('force=1 でも値があれば消さない', async () => {
    mocks.countFriendFieldValuesForScope.mockResolvedValue(12);
    const res = await req(makeApp(), '/api/friend-fields/ff-1?lineAccountId=account-1&force=1', 'DELETE');
    expect(res.status).toBe(409);
    expect(mocks.deleteFriendField).not.toHaveBeenCalled();
  });

  it('使われていなければそのまま消せる', async () => {
    const res = await req(makeApp(), '/api/friend-fields/ff-1?lineAccountId=account-1', 'DELETE');
    expect(res.status).toBe(200);
  });
});

describe('項目移行の事前確認', () => {
  it('選択中アカウントの値だけを種類に合わせて数える', async () => {
    mocks.getFriendFieldValuesForMigration.mockResolvedValue([
      { friend_id: 'friend-1', value: '090-0000-5678' },
      { friend_id: 'friend-2', value: '電話なし' },
      { friend_id: 'friend-3', value: '' },
    ]);
    const res = await req(
      makeApp(),
      '/api/friend-fields/ff-1/migration-preview?lineAccountId=account-1',
      'POST',
      { targetType: 'tel' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        summary: { total: number; convertible: number; review: number; invalid: number };
        rows: Array<{ friendId: string; status: string }>;
      };
    };
    expect(body.data.summary).toEqual({ total: 3, convertible: 1, review: 1, invalid: 1 });
    expect(body.data.rows).toEqual([
      expect.objectContaining({ friendId: 'friend-2', status: 'review' }),
      expect.objectContaining({ friendId: 'friend-3', status: 'invalid' }),
    ]);
    expect(mocks.getFriendFieldValuesForMigration).toHaveBeenCalledWith(
      env.DB,
      'ff-1',
      { tenantId: 'tenant-1', lineAccountId: 'account-1' },
    );
  });

  it('存在しない種類は422で止める', async () => {
    const res = await req(
      makeApp(),
      '/api/friend-fields/ff-1/migration-preview?lineAccountId=account-1',
      'POST',
      { targetType: 'rating' },
    );
    expect(res.status).toBe(422);
    expect(mocks.getFriendFieldValuesForMigration).not.toHaveBeenCalled();
  });

  it('実在しない日付を自動変換しない', async () => {
    mocks.getFriendFieldValuesForMigration.mockResolvedValue([
      { friend_id: 'friend-1', value: '2026-02-31' },
    ]);
    const res = await req(
      makeApp(),
      '/api/friend-fields/ff-1/migration-preview?lineAccountId=account-1',
      'POST',
      { targetType: 'date' },
    );
    const body = (await res.json()) as { data: { summary: { review: number }; rows: Array<{ reason: string }> } };
    expect(body.data.summary.review).toBe(1);
    expect(body.data.rows[0].reason).toContain('存在する日付');
  });

  it('実在する移行先を指定すると期限付きtokenと使用先を保存する', async () => {
    const target = { ...FIELD, id: 'ff-2', field_key: 'pet_name_new', type: 'tel', version: 2 };
    mocks.getFriendFieldByIdForScope.mockImplementation(async (_db: unknown, id: string) =>
      id === 'ff-2' ? target : { ...FIELD, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 });
    mocks.getFriendFieldValuesForMigration.mockResolvedValue([{ friend_id: 'friend-1', value: '090-0000-5678' }]);
    mocks.getFriendFieldUsageForScope.mockResolvedValue([
      { kind: 'form', id: 'form-1', name: '申込フォーム', fieldId: 'ff-1', switchable: true },
    ]);
    const res = await req(makeApp(), '/api/friend-fields/ff-1/migration-preview?lineAccountId=account-1', 'POST', {
      targetFieldId: 'ff-2',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { runId: string; previewToken: string; usageTargets: unknown[] } };
    expect(body.data.runId).toBeTruthy();
    expect(body.data.previewToken).toBeTruthy();
    expect(body.data.usageTargets).toHaveLength(1);
    expect(mocks.createFieldMigrationPreview).toHaveBeenCalledWith(env.DB, expect.objectContaining({
      sourceFieldId: 'ff-1', targetFieldId: 'ff-2', targetVersion: 2,
    }));
  });
});

describe('項目移行の実行と照会', () => {
  const RUN = {
    id: 'run-1', tenant_id: 'tenant-1', line_account_id: 'account-1',
    source_field_id: 'ff-1', target_field_id: 'ff-2', source_version: 1, target_version: 1,
    preview_token_hash: 'hash', preview_snapshot_hash: 'snapshot',
    preview_expires_at: '2999-01-01T00:00:00.000Z', idempotency_key: null, status: 'previewed',
    usage_targets_json: '[]', total_count: 1, convertible_count: 1, review_count: 0, invalid_count: 0,
    processed_count: 0, succeeded_count: 0, failed_count: 0, error_message: null,
    created_by: 'u-1', created_at: '2026-09-07', started_at: null, completed_at: null,
    rollback_deadline: null, updated_at: '2026-09-07',
  };

  it('Idempotency-Keyなしでは実行しない', async () => {
    const res = await req(makeApp(), '/api/friend-fields/ff-1/migrations?lineAccountId=account-1', 'POST', {
      previewToken: 'token',
    });
    expect(res.status).toBe(422);
    expect(mocks.queueFieldMigration).not.toHaveBeenCalled();
  });

  it('同じ冪等キーは同じrunIdを返す', async () => {
    mocks.getFieldMigrationRunByIdempotencyKey.mockResolvedValue(RUN);
    const app = makeApp();
    const res = await app.fetch(new Request(
      'https://example.com/api/friend-fields/ff-1/migrations?lineAccountId=account-1',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'same-key' }, body: JSON.stringify({ previewToken: 'token' }) },
    ), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ data: { runId: 'run-1' } });
  });

  it('担当外の実行履歴は404にする', async () => {
    const res = await req(makeApp(), '/api/field-migrations/run-1?lineAccountId=account-1', 'GET');
    expect(res.status).toBe(404);
  });

  it('staffは移行を実行できない', async () => {
    const app = makeApp('staff');
    const res = await app.fetch(new Request(
      'https://example.com/api/friend-fields/ff-1/migrations?lineAccountId=account-1',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key' }, body: JSON.stringify({ previewToken: 'token' }) },
    ), env);
    expect(res.status).toBe(403);
  });

  it('プレビュー後に値が変わったら409にする', async () => {
    mocks.getFieldMigrationRunByToken.mockResolvedValue(RUN);
    mocks.getFriendFieldByIdForScope.mockImplementation(async (_db: unknown, id: string) => ({
      ...FIELD, id, field_key: id === 'ff-2' ? 'target' : 'pet_name', type: id === 'ff-2' ? 'number' : 'text',
      line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0,
    }));
    mocks.getFriendFieldValuesForMigration.mockResolvedValue([{ friend_id: 'friend-new', value: '99' }]);
    const app = makeApp();
    const res = await app.fetch(new Request(
      'https://example.com/api/friend-fields/ff-1/migrations?lineAccountId=account-1',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'new-key' }, body: JSON.stringify({ previewToken: 'token' }) },
    ), env);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PREVIEW_STALE' });
    expect(mocks.markFieldMigrationStale).toHaveBeenCalledWith(env.DB, 'run-1');
  });

  it('進捗・行別理由・切戻し期限を返す', async () => {
    mocks.getFieldMigrationRun.mockResolvedValue({ ...RUN, status: 'partial', rollback_deadline: '2026-10-07T00:00:00.000Z' });
    mocks.getFieldMigrationItems.mockResolvedValue([{ run_id: 'run-1', friend_id: 'friend-1', source_value: '不明', converted_value: null, status: 'review', reason: '数値として確認できません', migrated_at: null }]);
    const res = await req(makeApp(), '/api/field-migrations/run-1?lineAccountId=account-1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: {
      runId: 'run-1', status: 'partial', rollbackDeadline: '2026-10-07T00:00:00.000Z',
      rows: [{ friendId: 'friend-1', reason: '数値として確認できません' }],
    } });
  });
});

describe('個人情報の項目', () => {
  const personal = { ...FIELD, id: 'ff-2', name: '電話番号', is_personal: 1, value: '090' };

  it('スタッフには返さない', async () => {
    mocks.getFriendFieldsWithValues.mockResolvedValue([
      { ...FIELD, value: null, updated_by: null },
      { ...personal, updated_by: null },
    ]);
    const res = await req(makeApp('staff'), '/api/friends/f-1/fields', 'GET');
    const body = (await res.json()) as {
      data: { items: Array<{ id: string }>; hiddenPersonalCount: number };
    };
    expect(body.data.items.map((i) => i.id)).toEqual(['ff-1']);
    // 「見えない項目がある」ことは伝える。何があるかは伝えない。
    expect(body.data.hiddenPersonalCount).toBe(1);
    expect(mocks.recordLoginAudit).not.toHaveBeenCalled();
  });

  it('管理者には返し、見たことを記録する', async () => {
    mocks.getFriendFieldsWithValues.mockResolvedValue([{ ...personal, updated_by: null }]);
    const res = await req(makeApp('admin'), '/api/friends/f-1/fields', 'GET');
    const body = (await res.json()) as { data: { items: Array<{ id: string }> } };
    expect(body.data.items).toHaveLength(1);
    expect(mocks.recordLoginAudit).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ action: 'view_personal', adminUserId: 'u-1', lineAccountId: 'account-1' }),
    );
  });

  it('値が空なら記録しない', async () => {
    // 「項目があること」を見ただけでは閲覧にあたらない。
    mocks.getFriendFieldsWithValues.mockResolvedValue([
      { ...personal, value: null, updated_by: null },
    ]);
    await req(makeApp('admin'), '/api/friends/f-1/fields', 'GET');
    expect(mocks.recordLoginAudit).not.toHaveBeenCalled();
  });
});

describe('友だちのLINEアカウント境界', () => {
  it.each(['GET', 'PUT'] as const)('担当外の友だちへ %s で到達できない', async (method) => {
    mocks.getFriendById.mockResolvedValue({ id: 'f-other', line_account_id: 'account-2' });
    accountMocks.canAccessAllLineAccounts.mockResolvedValue(false);
    const res = await req(
      makeApp('admin'),
      '/api/friends/f-other/fields',
      method,
      method === 'PUT' ? { values: { 'ff-1': '秘密' } } : undefined,
    );
    expect(res.status).toBe(404);
    expect(mocks.getFriendFieldsWithValues).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesForFriend).not.toHaveBeenCalled();
  });
});

describe('値のまとめて更新', () => {
  it('EC が正の項目は書き換えず、理由を返す', async () => {
    // 黙って無視すると「保存したのに戻る」という形で表に出る。
    mocks.getFriendFields.mockResolvedValue([{ ...FIELD, id: 'ff-9', ec_is_master: 1, name: '本名' }]);
    const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', {
      values: { 'ff-9': 'テスト' },
    });
    const body = (await res.json()) as { data: { updated: number }; warnings: string[] };
    expect(body.data.updated).toBe(0);
    expect(body.warnings[0]).toContain('本名');
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  });

  it('知らない項目は無視して続ける', async () => {
    const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', {
      values: { 'ff-1': 'ポチ', 'ghost': 'x' },
    });
    const body = (await res.json()) as { data: { updated: number }; warnings: string[] };
    expect(body.data.updated).toBe(1);
    expect(body.warnings).toHaveLength(1);
  });
});

describe('一括変更', () => {
  it('対象アカウントの指定がなければ400', async () => {
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      friendIds: ['f-1'],
      fieldId: 'ff-1',
      value: 'x',
    });
    expect(res.status).toBe(400);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
  });

  it('対象が空なら400', async () => {
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: [],
      fieldId: 'ff-1',
      value: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('1000人を超えたら422', async () => {
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: Array.from({ length: 1001 }, (_, i) => `f-${i}`),
      fieldId: 'ff-1',
      value: 'x',
    });
    expect(res.status).toBe(422);
  });

  it('EC が正の項目は一括でも変えられない', async () => {
    mocks.getFriendFieldByIdForScope.mockResolvedValue({ ...FIELD, ec_is_master: 1 });
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: ['f-1'],
      fieldId: 'ff-1',
      value: 'x',
    });
    expect(res.status).toBe(409);
  });

  it('通常の項目は人数ぶん書き込む', async () => {
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: ['f-1', 'f-2'],
      fieldId: 'ff-1',
      value: 'ポチ',
    });
    expect(res.status).toBe(200);
    // 書き込みは1回のbatchにまとめる。
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).toHaveBeenCalledTimes(1);
    expect(mocks.setFriendFieldValuesBulk).toHaveBeenCalledWith(expect.anything(), {
      fieldId: 'ff-1',
      entries: [
        { friendId: 'f-1', value: 'ポチ' },
        { friendId: 'f-2', value: 'ポチ' },
      ],
      updatedBy: 'u-1',
      now: '2026-09-14T00:00:00.000+09:00',
    });
  });
});

describe('一括変更のアカウント境界（N-043）', () => {
  const FRIEND_OF = (id: string, line_account_id: string | null) => ({ id, line_account_id });

  function useAccountBoundary(allowedAccountIds: string[] = ['account-1']) {
    mocks.getFriendById.mockImplementation(async (_db: unknown, id: string) => {
      if (id === 'f-ghost') return null;
      if (id === 'f-other' || id === 'f-other-2') return FRIEND_OF(id, 'account-2');
      return FRIEND_OF(id, 'account-1');
    });
    accountMocks.getVisibleLineAccountScope.mockResolvedValue({ allowedAccountIds });
  }

  it('同一アカウントのみなら成功する', async () => {
    useAccountBoundary();
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: ['f-1', 'f-2'],
      fieldId: 'ff-1',
      value: 'ポチ',
    });
    expect(res.status).toBe(200);
    expect(mocks.setFriendFieldValuesBulk).toHaveBeenCalledTimes(1);
    expect(accountMocks.getVisibleLineAccountScope).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ id: 'u-1' }),
    );
    expect(mocks.getFriendFieldByIdForScope).toHaveBeenCalledWith(
      env.DB,
      'ff-1',
      { tenantId: 'tenant-1', lineAccountId: 'account-1' },
    );
  });

  it('同一・他アカウント混在は部分更新せず404で、存在と値を漏らさない', async () => {
    useAccountBoundary();
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: ['f-1', 'f-other'],
      fieldId: 'ff-1',
      value: '秘密の値',
    });
    expect(res.status).toBe(404);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
    const text = await res.text();
    expect(text).not.toContain('account-2');
    expect(text).not.toContain('秘密の値');
  });

  it('双方のアカウントへアクセスできても指定外の混在は404で拒否する', async () => {
    useAccountBoundary(['account-1', 'account-2']);
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: ['f-1', 'f-other'],
      fieldId: 'ff-1',
      value: '秘密の値',
    });
    expect(res.status).toBe(404);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
    const text = await res.text();
    expect(text).not.toContain('account-2');
    expect(text).not.toContain('秘密の値');
  });

  it('双方のアカウントへアクセスできても指定と完全一致なら成功する', async () => {
    useAccountBoundary(['account-1', 'account-2']);
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: ['f-1', 'f-2'],
      fieldId: 'ff-1',
      value: 'ポチ',
    });
    expect(res.status).toBe(200);
    expect(mocks.setFriendFieldValuesBulk).toHaveBeenCalledTimes(1);
  });

  it('全部が他アカウントでも404で更新しない', async () => {
    useAccountBoundary();
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: ['f-other', 'f-other-2'],
      fieldId: 'ff-1',
      value: '秘密の値',
    });
    expect(res.status).toBe(404);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
    const text = await res.text();
    expect(text).not.toContain('account-2');
  });

  it('対象アカウントの権限がなければ404で更新しない', async () => {
    useAccountBoundary(['account-1']);
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-2',
      friendIds: ['f-other'],
      fieldId: 'ff-1',
      value: '秘密の値',
    });
    expect(res.status).toBe(404);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
    expect(mocks.getFriendFieldByIdForScope).not.toHaveBeenCalled();
  });

  it('対象スコープ外の項目は404で更新しない', async () => {
    useAccountBoundary();
    mocks.getFriendFieldByIdForScope.mockResolvedValue(null);
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: ['f-1'],
      fieldId: 'ff-ghost',
      value: 'ポチ',
    });
    expect(res.status).toBe(404);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
  });

  it('存在しない友だち混じりは404で更新しない', async () => {
    useAccountBoundary();
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1',
      friendIds: ['f-1', 'f-ghost'],
      fieldId: 'ff-1',
      value: 'ポチ',
    });
    expect(res.status).toBe(404);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
    const text = await res.text();
    expect(text).not.toContain('f-ghost');
  });

  it('同じ一括更新を二重実行しても可視なら2回とも成功する', async () => {
    useAccountBoundary();
    const body = { lineAccountId: 'account-1', friendIds: ['f-1', 'f-2'], fieldId: 'ff-1', value: 'ポチ' };
    const first = await req(makeApp(), '/api/friend-fields/bulk', 'POST', body);
    const second = await req(makeApp(), '/api/friend-fields/bulk', 'POST', body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.setFriendFieldValuesBulk).toHaveBeenCalledTimes(2);
  });
});

const NUMBER_FIELD = {
  ...FIELD,
  id: 'ff-num',
  name: '頭数',
  field_key: 'head_count',
  type: 'number',
};

const SELECT_FIELD = {
  ...FIELD,
  id: 'ff-sel',
  name: '犬種',
  field_key: 'breed',
  type: 'select',
  options_json: JSON.stringify([
    { id: 'opt-1', label: '柴犬', color: null, status: 'active', displayOrder: 0 },
    { id: 'opt-2', label: '猫', color: null, status: 'active', displayOrder: 1 },
  ]),
};

const DATE_FIELD = {
  ...FIELD,
  id: 'ff-date',
  name: '誕生日',
  field_key: 'birthday',
  type: 'date',
};

describe('値の型検証（N-042 単票）', () => {
  it('数値項目に文字列は422で何も保存しない', async () => {
    mocks.getFriendFields.mockResolvedValue([NUMBER_FIELD]);
    const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', {
      values: { 'ff-num': 'たくさん' },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      code: string;
      errors: Array<{ fieldId: string; message: string }>;
    };
    expect(body.code).toBe('FIELD_VALUE_INVALID');
    expect(body.errors[0].fieldId).toBe('ff-num');
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  });

  it('正しい項目が混ざっても部分保存しない', async () => {
    mocks.getFriendFields.mockResolvedValue([FIELD, NUMBER_FIELD]);
    const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', {
      values: { 'ff-1': 'ポチ', 'ff-num': 'たくさん' },
    });
    expect(res.status).toBe(422);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  });

  it('通った値は正規化して保存する', async () => {
    mocks.getFriendFields.mockResolvedValue([NUMBER_FIELD, SELECT_FIELD]);
    const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', {
      values: { 'ff-num': '1,000', 'ff-sel': '柴犬' },
    });
    expect(res.status).toBe(200);
    // 1件ずつ書かず、正規化ずみを1回の batch にまとめる。
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesForFriend).toHaveBeenCalledTimes(1);
    expect(mocks.setFriendFieldValuesForFriend).toHaveBeenCalledWith(expect.anything(), {
      friendId: 'f-1',
      entries: [
        { fieldId: 'ff-num', value: '1000' },
        { fieldId: 'ff-sel', value: 'opt-1' },
      ],
      updatedBy: 'u-1',
      now: '2026-09-14T00:00:00.000+09:00',
    });
  });

  it('選択肢外は422で保存しない', async () => {
    mocks.getFriendFields.mockResolvedValue([SELECT_FIELD]);
    const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', {
      values: { 'ff-sel': 'ドラゴン' },
    });
    expect(res.status).toBe(422);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  });

  it('曖昧な日付と存在しない日付は422で保存しない', async () => {
    mocks.getFriendFields.mockResolvedValue([DATE_FIELD]);
    for (const value of ['2026/9/1', '2026-02-30', '昨日']) {
      const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', {
        values: { 'ff-date': value },
      });
      expect(res.status).toBe(422);
    }
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  });

  it('NaN・Infinity・真偽値は数値として422で保存しない', async () => {
    mocks.getFriendFields.mockResolvedValue([NUMBER_FIELD]);
    for (const value of ['NaN', 'Infinity', true, {}]) {
      const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', {
        values: { 'ff-num': value },
      });
      expect(res.status).toBe(422);
    }
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
  });

  it('同じ値を2回保存しても2回とも残る', async () => {
    mocks.getFriendFields.mockResolvedValue([NUMBER_FIELD]);
    const body = { values: { 'ff-num': '1,000' } };
    const first = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', body);
    const second = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesForFriend).toHaveBeenCalledTimes(2);
    expect(mocks.setFriendFieldValuesForFriend).toHaveBeenLastCalledWith(expect.anything(), {
      friendId: 'f-1',
      entries: [{ fieldId: 'ff-num', value: '1000' }],
      updatedBy: 'u-1',
      now: '2026-09-14T00:00:00.000+09:00',
    });
  });

  it('空文字は消す扱いで保存する', async () => {
    mocks.getFriendFields.mockResolvedValue([FIELD]);
    const res = await req(makeApp(), '/api/friends/f-1/fields', 'PUT', {
      values: { 'ff-1': '' },
    });
    expect(res.status).toBe(200);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesForFriend).toHaveBeenCalledWith(expect.anything(), {
      friendId: 'f-1',
      entries: [{ fieldId: 'ff-1', value: null }],
      updatedBy: 'u-1',
      now: '2026-09-14T00:00:00.000+09:00',
    });
  });
});

describe('値の型検証（N-042 一括）', () => {
  const bulk = (fieldId: string, value: unknown) => ({
    lineAccountId: 'account-1',
    friendIds: ['f-1', 'f-2'],
    fieldId,
    value,
  });

  it('型違いは422で誰にも保存しない', async () => {
    mocks.getFriendFieldByIdForScope.mockResolvedValue({ ...NUMBER_FIELD, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 });
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', bulk('ff-num', 'たくさん'));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('FIELD_VALUE_INVALID');
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
  });

  it('通った値は正規化して人数ぶん保存する', async () => {
    mocks.getFriendFieldByIdForScope.mockResolvedValue({ ...NUMBER_FIELD, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 });
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', bulk('ff-num', '1,000'));
    expect(res.status).toBe(200);
    // 正規化ずみを1回のbatchにまとめる。
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).toHaveBeenCalledTimes(1);
    expect(mocks.setFriendFieldValuesBulk).toHaveBeenCalledWith(expect.anything(), {
      fieldId: 'ff-num',
      entries: [
        { friendId: 'f-1', value: '1000' },
        { friendId: 'f-2', value: '1000' },
      ],
      updatedBy: 'u-1',
      now: '2026-09-14T00:00:00.000+09:00',
    });
  });

  it('選択肢の表示名はIDへ直して保存する', async () => {
    mocks.getFriendFieldByIdForScope.mockResolvedValue({ ...SELECT_FIELD, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 });
    const res = await req(makeApp(), '/api/friend-fields/bulk', 'POST', bulk('ff-sel', '柴犬'));
    expect(res.status).toBe(200);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).toHaveBeenCalledWith(expect.anything(), {
      fieldId: 'ff-sel',
      entries: [
        { friendId: 'f-1', value: 'opt-1' },
        { friendId: 'f-2', value: 'opt-1' },
      ],
      updatedBy: 'u-1',
      now: '2026-09-14T00:00:00.000+09:00',
    });
  });

  it('所属がなければ403で保存しない', async () => {
    const res = await req(makeApp('owner', null), '/api/friend-fields/bulk', 'POST', bulk('ff-1', 'ポチ'));
    expect(res.status).toBe(403);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
  });
});

describe('個人情報の個別権限（N-045）', () => {
  const personal = { ...FIELD, id: 'ff-2', name: '電話番号', field_key: 'phone', is_personal: 1, value: '090' };

  it('view キーを持つ staff は個人情報を読め、見たことが記録される', async () => {
    mocks.getFriendFieldsWithValues.mockResolvedValue([{ ...personal, updated_by: null }]);
    const res = await req(
      makeApp('staff', 'tenant-1', [], ['attribute.personal_info.view']),
      '/api/friends/f-1/fields', 'GET',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ id: string }>; hiddenPersonalCount: number } };
    expect(body.data.items.map((i) => i.id)).toEqual(['ff-2']);
    expect(body.data.hiddenPersonalCount).toBe(0);
    expect(mocks.recordLoginAudit).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ action: 'view_personal', adminUserId: 'u-1', lineAccountId: 'account-1' }),
    );
  });

  it('edit キーだけを持つ staff も個人情報を読める（読めないのに書ける状態にしない）', async () => {
    mocks.getFriendFieldsWithValues.mockResolvedValue([
      { ...FIELD, value: null, updated_by: null },
      { ...personal, updated_by: null },
    ]);
    const res = await req(
      makeApp('staff', 'tenant-1', ['attribute.personal_info.edit']),
      '/api/friends/f-1/fields', 'GET',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((i) => i.id).sort()).toEqual(['ff-1', 'ff-2']);
  });

  it('鍵の無い staff は個人情報を読めない', async () => {
    mocks.getFriendFieldsWithValues.mockResolvedValue([
      { ...FIELD, value: null, updated_by: null },
      { ...personal, updated_by: null },
    ]);
    const res = await req(makeApp('staff'), '/api/friends/f-1/fields', 'GET');
    const body = (await res.json()) as { data: { items: Array<{ id: string }>; hiddenPersonalCount: number } };
    expect(body.data.items.map((i) => i.id)).toEqual(['ff-1']);
    expect(body.data.hiddenPersonalCount).toBe(1);
  });

  it('鍵の無い staff は値を保存できない', async () => {
    const res = await req(makeApp('staff'), '/api/friends/f-1/fields', 'PUT', {
      values: { 'ff-1': 'ポチ' },
    });
    expect(res.status).toBe(403);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesForFriend).not.toHaveBeenCalled();
  });

  it('view キーだけでは保存できない', async () => {
    const res = await req(
      makeApp('staff', 'tenant-1', [], ['attribute.personal_info.view']),
      '/api/friends/f-1/fields', 'PUT',
      { values: { 'ff-2': '080' } },
    );
    expect(res.status).toBe(403);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesForFriend).not.toHaveBeenCalled();
  });

  it('edit キーを持つ staff は個人情報の項目を保存できる', async () => {
    mocks.getFriendFields.mockResolvedValue([FIELD, personal]);
    const res = await req(
      makeApp('staff', 'tenant-1', ['attribute.personal_info.edit']),
      '/api/friends/f-1/fields', 'PUT',
      { values: { 'ff-2': '080-0000-0000' } },
    );
    expect(res.status).toBe(200);
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesForFriend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      friendId: 'f-1',
      entries: [{ fieldId: 'ff-2', value: '080-0000-0000' }],
    }));
  });

  it('edit キーを持つ staff が個人情報でない項目を送っても保存せず理由を返す', async () => {
    mocks.getFriendFields.mockResolvedValue([FIELD, personal]);
    const res = await req(
      makeApp('staff', 'tenant-1', ['attribute.personal_info.edit']),
      '/api/friends/f-1/fields', 'PUT',
      { values: { 'ff-1': 'ポチ', 'ff-2': '080-0000-0000' } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { updated: number }; warnings: string[] };
    expect(body.data.updated).toBe(1);
    expect(body.warnings[0]).toContain('ペットの名前');
    expect(mocks.setFriendFieldValue).not.toHaveBeenCalled();
    expect(mocks.setFriendFieldValuesForFriend).toHaveBeenCalledTimes(1);
    expect(mocks.setFriendFieldValuesForFriend).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      friendId: 'f-1',
      entries: [{ fieldId: 'ff-2', value: '080-0000-0000' }],
    }));
  });

  it('一括変更: edit キーを持つ staff は個人情報の項目だけ実行できる', async () => {
    mocks.getFriendFieldByIdForScope.mockResolvedValue({ ...personal, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 });
    const res = await req(
      makeApp('staff', 'tenant-1', ['attribute.personal_info.edit']),
      '/api/friend-fields/bulk', 'POST',
      { lineAccountId: 'account-1', friendIds: ['f-1'], fieldId: 'ff-2', value: '080' },
    );
    expect(res.status).toBe(200);
    expect(mocks.setFriendFieldValuesBulk).toHaveBeenCalledTimes(1);
  });

  it('一括変更: staff は個人情報でない項目を変えられない', async () => {
    mocks.getFriendFieldByIdForScope.mockResolvedValue({ ...FIELD, line_account_id: 'account-1', tenant_id: 'tenant-1', is_inherited: 0 });
    const res = await req(
      makeApp('staff', 'tenant-1', ['attribute.personal_info.edit']),
      '/api/friend-fields/bulk', 'POST',
      { lineAccountId: 'account-1', friendIds: ['f-1'], fieldId: 'ff-1', value: 'ポチ' },
    );
    expect(res.status).toBe(403);
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
  });

  it('一括変更: 鍵の無い staff は403', async () => {
    const res = await req(makeApp('staff'), '/api/friend-fields/bulk', 'POST', {
      lineAccountId: 'account-1', friendIds: ['f-1'], fieldId: 'ff-1', value: 'ポチ',
    });
    expect(res.status).toBe(403);
    expect(mocks.setFriendFieldValuesBulk).not.toHaveBeenCalled();
  });
});

describe('項目の並び替え（#1014 ATTR-02/03/04）', () => {
  it('並び替えは1回の呼び出しでまとめて保存される', async () => {
    const res = await req(makeApp(), '/api/friend-fields/reorder?lineAccountId=account-1', 'PATCH', { ids: ['ff-2', 'ff-1'] });
    expect(res.status).toBe(200);
    expect(mocks.reorderFriendFields).toHaveBeenCalledTimes(1);
    expect(mocks.reorderFriendFields).toHaveBeenCalledWith(env.DB,
      expect.objectContaining({ tenantId: 'tenant-1', lineAccountId: 'account-1' }),
      ['ff-2', 'ff-1']);
    expect(mocks.updateFriendField).not.toHaveBeenCalled();
  });

  it('idsが配列でなければ400', async () => {
    const res = await req(makeApp(), '/api/friend-fields/reorder?lineAccountId=account-1', 'PATCH', { ids: 'ff-1' });
    expect(res.status).toBe(400);
    expect(mocks.reorderFriendFields).not.toHaveBeenCalled();
  });

  it('lineAccountIdが無ければ400', async () => {
    const res = await req(makeApp(), '/api/friend-fields/reorder', 'PATCH', { ids: ['ff-1', 'ff-2'] });
    expect(res.status).toBe(400);
    expect(mocks.reorderFriendFields).not.toHaveBeenCalled();
  });

  it('見えないアカウントの項目は並び替えられない', async () => {
    const res = await req(makeApp(), '/api/friend-fields/reorder?lineAccountId=account-other', 'PATCH', { ids: ['ff-1', 'ff-2'] });
    expect(res.status).toBe(404);
    expect(mocks.reorderFriendFields).not.toHaveBeenCalled();
  });

  it('staffは項目を並び替えられない', async () => {
    const res = await req(makeApp('staff'), '/api/friend-fields/reorder?lineAccountId=account-1', 'PATCH', { ids: ['ff-1', 'ff-2'] });
    expect(res.status).toBe(403);
    expect(mocks.reorderFriendFields).not.toHaveBeenCalled();
  });
});
