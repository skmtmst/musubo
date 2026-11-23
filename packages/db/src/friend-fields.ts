import { logger } from '@line-crm/shared/server';
import { friendFieldReminderTargetStatements } from './reminders/index.js';
import { jstNow } from './utils.js';
import { ageFromBirthday, allergyValues, validateAllergyValues, DEFAULT_ALLERGY_OPTIONS } from '@line-crm/shared';

/** 移行前の情報欄を所属させる既定テナント。既存IDと値は変えない。 */
const LEGACY_TENANT_ID = '00000000-0000-4000-8000-000000000001';

export interface FriendFieldScope {
  tenantId: string;
  lineAccountId: string;
}

/**
 * 友だち情報欄。
 *
 * フォームの回答 → 情報欄 → 友だち詳細 → テンプレートの差し込み、が
 * 1本の線で繋がる。この線の起点で、v0.24.0 で一番影響範囲が広い。
 */

export const FRIEND_FIELD_TYPES = [
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
] as const;

export type FriendFieldType = (typeof FRIEND_FIELD_TYPES)[number];

export interface FriendField {
  id: string;
  folder_id: string | null;
  name: string;
  field_key: string;
  type: string;
  type_v6?: string | null;
  /** V8で追加した時刻。既存の型制約と値を保ったまま保存する（591）。 */
  type_v8?: 'time' | null;
  options_json: string | null;
  default_value: string | null;
  source: string;
  ec_field_path: string | null;
  ec_is_master: number;
  is_personal: number;
  is_starred: number;
  display_order: number;
  created_at: string;
  updated_at: string;
  status?: 'active' | 'read_only' | 'archived';
  version?: number;
  fixed_key?: import("@line-crm/shared").FixedFriendFieldKey | null;
  value_updated_at?: string | null;
  source_type?: string | null;
  source_id?: string | null;
  source_name?: string | null;
}

export interface ScopedFriendField extends FriendField {
  line_account_id: string | null;
  tenant_id: string;
  is_inherited: number;
}

export interface FriendFieldListSummary {
  total: number;
  inUse: number;
  registeredFriends: number;
  updatedThisMonth: number;
  formLinks: number | null;
  formLinksUnavailableReason?: string;
}

const SCOPED_FIELD_SELECT = `
  SELECT ff.*,
         ffs.line_account_id,
         COALESCE(ffs.tenant_id, '${LEGACY_TENANT_ID}') AS tenant_id,
         CASE WHEN ffs.field_id IS NULL OR ffs.line_account_id IS NULL THEN 1 ELSE 0 END AS is_inherited
    FROM friend_fields ff
    LEFT JOIN friend_field_scopes ffs ON ffs.field_id = ff.id`;

export interface FriendFieldValue {
  friend_id: string;
  field_id: string;
  value: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface FriendFieldMigrationSourceValue {
  friend_id: string;
  value: string;
}

export interface FriendFieldUsageTarget {
  kind: 'form' | 'reminder' | 'saved_search';
  fieldId: string;
  id: string;
  name: string;
  switchable: boolean;
}

function normalizeFriendField<T extends FriendField>(row: T): T {
  // DBの固定定義は不変。複数値は既存TEXTにJSONで保存し、読み取り側の型だけ補う。
  if (row.field_key === 'fixed_allergy') return { ...row, type: 'multi_select', options_json: row.options_json ?? JSON.stringify(DEFAULT_ALLERGY_OPTIONS) };
  return { ...row, type: row.type_v8 ?? row.type_v6 ?? row.type };
}

function legacyStoredType(type: FriendFieldType): string {
  return type === 'time' || type === 'datetime' || type === 'image' || type === 'pdf' ? 'text' : type;
}

/**
 * 差し込み変数として使える名前か。
 *
 * テンプレートで {key} として置換するので、日本語や記号を許すと
 * 置換の正規表現が壊れる。長さの上限も置く（32文字）。
 */
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * 予約語。既に別の意味で使っている差し込み名と衝突させない。
 *
 * 衝突を許すと「{name} を入れたのに友だちの表示名が出る」といった、
 * 設定と結果が食い違う形で表に出る。
 */
export const RESERVED_FIELD_KEYS = new Set([
  'name',
  'id',
  'tag',
  'tags',
  'url',
  'account',
  'today',
]);

export function validateFieldKey(key: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof key !== 'string' || !FIELD_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      error: '差し込み名は半角英小文字で始まり、英小文字・数字・下線のみ、32文字までです',
    };
  }
  if (RESERVED_FIELD_KEYS.has(key)) {
    return { ok: false, error: `「${key}」は既に別の意味で使われているため指定できません` };
  }
  return { ok: true };
}

export async function getFriendFields(
  db: D1Database,
  opts: { folderId?: string } = {},
): Promise<FriendField[]> {
  if (opts.folderId) {
    const result = await db
      .prepare(
        `SELECT * FROM friend_fields WHERE folder_id = ? ORDER BY display_order ASC, name ASC`,
      )
      .bind(opts.folderId)
      .all<FriendField>();
    return result.results.map(normalizeFriendField);
  }
  const result = await db
    .prepare(`SELECT * FROM friend_fields ORDER BY display_order ASC, name ASC`)
    .all<FriendField>();
  return result.results.map(normalizeFriendField);
}

/** 選択中のLINE公式アカウントから見える項目だけを返す。 */
export async function getFriendFieldsForScope(
  db: D1Database,
  scope: FriendFieldScope,
  opts: { folderId?: string; status?: 'active' | 'read_only' | 'archived' } = {},
): Promise<ScopedFriendField[]> {
  const folder = opts.folderId ? ' AND ff.folder_id = ?' : '';
  const status = opts.status ? ' AND ff.status = ?' : '';
  const binds: unknown[] = [LEGACY_TENANT_ID, scope.tenantId, scope.lineAccountId];
  if (opts.folderId) binds.push(opts.folderId);
  if (opts.status) binds.push(opts.status);
  const result = await db
    .prepare(
      `${SCOPED_FIELD_SELECT}
        WHERE COALESCE(ffs.tenant_id, ?) = ?
          AND (ffs.line_account_id = ? OR ffs.line_account_id IS NULL)${folder}${status}
        ORDER BY CASE WHEN ffs.line_account_id = ? THEN 0 ELSE 1 END,
                 ff.display_order ASC, ff.name ASC`,
    )
    .bind(...binds, scope.lineAccountId)
    .all<ScopedFriendField>();
  return result.results.map(normalizeFriendField);
}

/** ID直指定でも、担当外アカウントの項目を返さない。 */
export async function getFriendFieldByIdForScope(
  db: D1Database,
  id: string,
  scope: FriendFieldScope,
): Promise<ScopedFriendField | null> {
  const row = await db
    .prepare(
      `${SCOPED_FIELD_SELECT}
        WHERE ff.id = ?
          AND COALESCE(ffs.tenant_id, ?) = ?
          AND (ffs.line_account_id = ? OR ffs.line_account_id IS NULL)`,
    )
    .bind(id, LEGACY_TENANT_ID, scope.tenantId, scope.lineAccountId)
    .first<ScopedFriendField>();
  return row ? normalizeFriendField(row) : null;
}

export async function getFriendFieldById(
  db: D1Database,
  id: string,
): Promise<FriendField | null> {
  const row = await db.prepare(`SELECT * FROM friend_fields WHERE id = ?`).bind(id).first<FriendField>();
  return row ? normalizeFriendField(row) : null;
}

export interface CreateFriendFieldInput {
  name: string;
  fieldKey: string;
  type: FriendFieldType;
  folderId?: string | null;
  optionsJson?: string | null;
  defaultValue?: string | null;
  source?: 'manual' | 'form' | 'ec' | 'automation';
  ecFieldPath?: string | null;
  ecIsMaster?: boolean;
  isPersonal?: boolean;
  isStarred?: boolean;
  displayOrder?: number;
}

export async function createFriendField(
  db: D1Database,
  input: CreateFriendFieldInput,
): Promise<FriendField> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO friend_fields
         (id, folder_id, name, field_key, type, options_json, default_value,
          source, ec_field_path, ec_is_master, is_personal, is_starred,
          display_order, type_v6, type_v8, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.folderId ?? null,
      input.name,
      input.fieldKey,
      legacyStoredType(input.type),
      input.optionsJson ?? null,
      input.defaultValue ?? null,
      input.source ?? 'manual',
      input.ecFieldPath ?? null,
      input.ecIsMaster ? 1 : 0,
      input.isPersonal ? 1 : 0,
      input.isStarred ? 1 : 0,
      input.displayOrder ?? 0,
      input.type === 'time' ? 'text' : input.type,
      input.type === 'time' ? 'time' : null,
      now,
      now,
    )
    .run();
  return (await getFriendFieldById(db, id))!;
}

export class FriendFieldCreateError extends Error {
  constructor(public readonly code: 'idempotency_conflict', message: string) {
    super(message);
    this.name = 'FriendFieldCreateError';
  }
}

/**
 * 同じ要求キーの再送で二重に作らないための指紋。
 *
 * 名前・差し込み名・種類・所属・選択肢・既定値・各種の印が
 * 1つでも違えば別の要求とみなし、作らず止める。
 */
function friendFieldCreateFingerprint(input: CreateFriendFieldInput): string {
  return JSON.stringify({
    name: input.name,
    fieldKey: input.fieldKey,
    type: input.type,
    folderId: input.folderId ?? null,
    optionsJson: input.optionsJson ?? null,
    defaultValue: input.defaultValue ?? null,
    source: input.source ?? 'manual',
    ecFieldPath: input.ecFieldPath ?? null,
    ecIsMaster: input.ecIsMaster === true,
    isPersonal: input.isPersonal === true,
    isStarred: input.isStarred === true,
    displayOrder: input.displayOrder ?? 0,
  });
}

export interface FriendFieldCreateResult {
  field: ScopedFriendField;
  /** 同じ要求キーの再送で、保存済みの項目を返した。 */
  replayed: boolean;
}

/**
 * 要求キー付きで友だち情報欄を作る。
 *
 * 応答だけ失った再試行は、同じキー・同じ内容なら保存済みの項目を
 * 返す（作り直さない）。同じキーに異なる内容が来たら作らず止める。
 * 要求キーの行は本体と同じD1バッチで確定するため、同時に同じキーが
 * 送られても1件だけ残る（負けた側のバッチは巻き戻る）。
 * 対応マークの createSupportMarkIdempotent と同じ約束。
 */
export async function createFriendFieldIdempotent(
  db: D1Database,
  scope: FriendFieldScope,
  input: CreateFriendFieldInput,
  idempotencyKey: string,
): Promise<FriendFieldCreateResult> {
  const fingerprint = friendFieldCreateFingerprint(input);
  const findRequest = () => db.prepare(
    `SELECT field_id, request_fingerprint
       FROM friend_field_create_requests
      WHERE line_account_id = ? AND idempotency_key = ?`,
  ).bind(scope.lineAccountId, idempotencyKey).first<{
    field_id: string;
    request_fingerprint: string;
  }>();
  const previous = await findRequest();
  if (previous) {
    if (previous.request_fingerprint !== fingerprint) {
      throw new FriendFieldCreateError(
        'idempotency_conflict',
        '同じ要求キーに異なる内容が指定されました。一覧を確認してください',
      );
    }
    const field = await getFriendFieldByIdForScope(db, previous.field_id, scope);
    if (field) return { field, replayed: true };
    // 保存済みのはずの項目が無い。古い予約を消して作り直す。
    await db.prepare(
      `DELETE FROM friend_field_create_requests
        WHERE line_account_id = ? AND idempotency_key = ?`,
    ).bind(scope.lineAccountId, idempotencyKey).run();
  }
  const fieldId = crypto.randomUUID();
  try {
    const field = await createFriendFieldForScope(db, scope, input, fieldId, {
      key: idempotencyKey,
      fingerprint,
    });
    return { field, replayed: false };
  } catch (err) {
    // 同時に同じキーが確定した可能性がある。勝った側の結果に従い、
    // 勝者がいなければ元の失敗をそのまま返す（握りつぶさない）。
    const raced = await findRequest().catch(() => null);
    if (raced?.request_fingerprint === fingerprint) {
      const field = await getFriendFieldByIdForScope(db, raced.field_id, scope).catch(() => null);
      if (field) return { field, replayed: true };
    }
    throw err;
  }
}

/** 新規項目と所属を同じD1バッチで作る。 */
export async function createFriendFieldForScope(
  db: D1Database,
  scope: FriendFieldScope,
  input: CreateFriendFieldInput,
  fieldId: string = crypto.randomUUID(),
  idempotency?: { key: string; fingerprint: string },
): Promise<ScopedFriendField> {
  const id = fieldId;
  const now = jstNow();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO friend_fields
           (id, folder_id, name, field_key, type, options_json, default_value,
            source, ec_field_path, ec_is_master, is_personal, is_starred,
            display_order, type_v6, type_v8, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.folderId ?? null,
        input.name,
        input.fieldKey,
        legacyStoredType(input.type),
        input.optionsJson ?? null,
        input.defaultValue ?? null,
        input.source ?? 'manual',
        input.ecFieldPath ?? null,
        input.ecIsMaster ? 1 : 0,
        input.isPersonal ? 1 : 0,
        input.isStarred ? 1 : 0,
        input.displayOrder ?? 0,
        input.type === 'time' ? 'text' : input.type,
        input.type === 'time' ? 'time' : null,
        now,
        now,
      ),
    db
      .prepare(
        `INSERT INTO friend_field_scopes
           (field_id, tenant_id, line_account_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(id, scope.tenantId, scope.lineAccountId, now),
  ];
  if (idempotency) {
    // 要求キーの行も同じバッチで確定する。本体より後に積むため、
    // 外部キーのある環境でも制約に当たらない。同じキーの同時実行は
    // UNIQUE 制約で負けた側だけ巻き戻り、二重に残らない。
    statements.push(db.prepare(
      `INSERT INTO friend_field_create_requests
         (id, line_account_id, idempotency_key, request_fingerprint,
          field_id, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      scope.lineAccountId,
      idempotency.key,
      idempotency.fingerprint,
      id,
      JSON.stringify({ fieldId: id }),
      now,
    ));
  }
  await db.batch(statements);
  return (await getFriendFieldByIdForScope(db, id, scope))!;
}

export interface UpdateFriendFieldInput {
  expectedVersion?: number;
  name?: string;
  folderId?: string | null;
  optionsJson?: string | null;
  defaultValue?: string | null;
  ecFieldPath?: string | null;
  ecIsMaster?: boolean;
  isPersonal?: boolean;
  isStarred?: boolean;
  displayOrder?: number;
}

/**
 * 項目を更新する。
 *
 * type と field_key はここでは変えられない。type を変えると既に入っている
 * 値の意味が変わり（「犬」が数値項目になる等）、field_key を変えると
 * テンプレートの差し込みが黙って空になる。どちらも作り直してもらう。
 */
export async function updateFriendField(
  db: D1Database,
  id: string,
  input: UpdateFriendFieldInput,
): Promise<FriendField | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const put = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    values.push(v);
  };
  if (input.name !== undefined) put('name', input.name);
  if ('folderId' in input) put('folder_id', input.folderId ?? null);
  if ('optionsJson' in input) put('options_json', input.optionsJson ?? null);
  if ('defaultValue' in input) put('default_value', input.defaultValue ?? null);
  if ('ecFieldPath' in input) put('ec_field_path', input.ecFieldPath ?? null);
  if (input.ecIsMaster !== undefined) put('ec_is_master', input.ecIsMaster ? 1 : 0);
  if (input.isPersonal !== undefined) put('is_personal', input.isPersonal ? 1 : 0);
  if (input.isStarred !== undefined) put('is_starred', input.isStarred ? 1 : 0);
  if (input.displayOrder !== undefined) put('display_order', input.displayOrder);
  if (sets.length > 0) {
    sets.push('version = version + 1');
    sets.push('updated_at = ?');
    values.push(jstNow(), id);
    const versionClause = input.expectedVersion === undefined ? '' : ' AND version = ?';
    if (input.expectedVersion !== undefined) values.push(input.expectedVersion);
    const result = await db
      .prepare(`UPDATE friend_fields SET ${sets.join(', ')} WHERE id = ?${versionClause}`)
      .bind(...values)
      .run();
    if (input.expectedVersion !== undefined && Number(result.meta.changes ?? 0) === 0) return null;
  }
  return getFriendFieldById(db, id);
}

/** その項目に値が入っている友だちの数。削除前の確認に使う。 */
export async function countFriendFieldValues(db: D1Database, fieldId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM friend_field_values
        WHERE field_id = ? AND value IS NOT NULL AND value != ''`,
    )
    .bind(fieldId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/** 選択中アカウントにいる友だちだけを数える。 */
export async function countFriendFieldValuesForScope(
  db: D1Database,
  fieldId: string,
  scope: FriendFieldScope,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c
         FROM friend_field_values v
         JOIN friends f ON f.id = v.friend_id
        WHERE v.field_id = ? AND f.line_account_id = ?
          AND v.value IS NOT NULL AND v.value != ''`,
    )
    .bind(fieldId, scope.lineAccountId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/**
 * withUsage 一覧用。項目ごとの件数を1クエリでまとめて数える。
 *
 * 項目ごとに `countFriendFieldValuesForScope` を呼ぶと項目数ぶんの
 * クエリが走る(N+1)。`GROUP BY` で一括集計し、値は単体版と同じ条件。
 */
export async function countFriendFieldValuesForScopes(
  db: D1Database,
  fieldIds: string[],
  scope: FriendFieldScope,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (fieldIds.length === 0) return counts;
  const result = await db
    .prepare(
      `SELECT v.field_id AS field_id, COUNT(*) AS c
         FROM friend_field_values v
         JOIN friends f ON f.id = v.friend_id
        WHERE v.field_id IN (SELECT value FROM json_each(?)) AND f.line_account_id = ?
          AND v.value IS NOT NULL AND v.value != ''
        GROUP BY v.field_id`,
    )
    .bind(JSON.stringify(fieldIds), scope.lineAccountId)
    .all<{ field_id: string; c: number }>();
  for (const row of result.results ?? []) counts.set(row.field_id, Number(row.c ?? 0));
  return counts;
}

/** dry-run用。選択中アカウントの値だけを読み、値そのものは変更しない。 */
export async function getFriendFieldValuesForMigration(
  db: D1Database,
  fieldId: string,
  scope: FriendFieldScope,
): Promise<FriendFieldMigrationSourceValue[]> {
  const result = await db
    .prepare(
      `SELECT v.friend_id, v.value
         FROM friend_field_values v
         JOIN friends f ON f.id = v.friend_id
        WHERE v.field_id = ? AND f.line_account_id = ?
          AND v.value IS NOT NULL AND v.value != ''
        ORDER BY v.friend_id ASC`,
    )
    .bind(fieldId, scope.lineAccountId)
    .all<FriendFieldMigrationSourceValue>();
  return result.results;
}

/** 4-2 上部の4枚に使う、選択中アカウントだけの集計。 */
export async function getFriendFieldListSummary(
  db: D1Database,
  scope: FriendFieldScope,
): Promise<FriendFieldListSummary> {
  const monthStart = `${jstNow().slice(0, 7)}-01`;
  const fields = await getFriendFieldsForScope(db, scope);
  if (fields.length === 0) {
    return { total: 0, inUse: 0, registeredFriends: 0, updatedThisMonth: 0, formLinks: 0 };
  }
  const ids = fields.map((field) => field.id);
  const row = await db
    .prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN v.value IS NOT NULL AND v.value != '' THEN v.field_id END) AS in_use,
         COUNT(DISTINCT CASE WHEN v.value IS NOT NULL AND v.value != '' THEN v.friend_id END) AS friends,
         COUNT(CASE WHEN v.updated_at >= ? THEN 1 END) AS updated_this_month
       FROM friend_field_values v
       JOIN friends f ON f.id = v.friend_id
      WHERE f.line_account_id = ? AND v.field_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(monthStart, scope.lineAccountId, JSON.stringify(ids))
    .first<{ in_use: number; friends: number; updated_this_month: number }>();
  const base = {
    total: fields.length,
    inUse: Number(row?.in_use ?? 0),
    registeredFriends: Number(row?.friends ?? 0),
    updatedThisMonth: Number(row?.updated_this_month ?? 0),
  };
  try {
    const usages = await getFriendFieldUsageForScope(db, ids, scope);
    return {
      ...base,
      formLinks: new Set(usages.filter((usage) => usage.kind === 'form').map((usage) => usage.id)).size,
    };
  } catch (error) {
    logger.error("src_friend_fields_failed");
    return {
      ...base,
      formLinks: null,
      formLinksUnavailableReason: '回答フォームの使用数を確認できませんでした。再読み込みしてください。',
    };
  }
}

/** 回答フォーム・リマインダ・保存検索から、現在の実参照をアカウント範囲内で探す。 */
export async function getFriendFieldUsageForScope(
  db: D1Database,
  fieldIds: string[],
  scope: FriendFieldScope,
): Promise<FriendFieldUsageTarget[]> {
  if (fieldIds.length === 0) return [];
  const idsJson = JSON.stringify(fieldIds);
  const forms = await db.prepare(
    `WITH form_defs(id, name, fields, switchable) AS (
       SELECT f.id, f.name, f.fields, 1
         FROM forms f JOIN form_accounts fa ON fa.form_id = f.id
        WHERE fa.line_account_id = ? AND f.status = 'active'
       UNION ALL
       SELECT f.id, f.name, v.fields, 0
         FROM forms f
         JOIN form_accounts fa ON fa.form_id = f.id
         JOIN form_versions v ON v.id = f.current_published_version_id
        WHERE fa.line_account_id = ? AND f.status = 'active'
     )
     SELECT d.id, d.name, CAST(j.value AS TEXT) AS field_id,
            MIN(d.switchable) AS switchable
       FROM form_defs d
       JOIN json_tree(COALESCE(d.fields, '[]')) j ON j.key = 'friendFieldId'
      WHERE CAST(j.value AS TEXT) IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      GROUP BY d.id, d.name, CAST(j.value AS TEXT)
      ORDER BY d.name ASC`,
  ).bind(scope.lineAccountId, scope.lineAccountId, idsJson)
    .all<{ id: string; name: string; field_id: string; switchable: number }>();
  const reminders = await db.prepare(
    `SELECT DISTINCT id, name, trigger_field_id AS field_id FROM reminders
      WHERE line_account_id = ? AND trigger_field_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      ORDER BY name ASC`,
  ).bind(scope.lineAccountId, idsJson).all<{ id: string; name: string; field_id: string }>();
  const searches = await db.prepare(
    `SELECT DISTINCT s.id, s.name, CAST(j.value AS TEXT) AS field_id
       FROM saved_searches s
       JOIN json_tree(s.conditions_json) j
      WHERE s.line_account_id = ?
        AND CAST(j.value AS TEXT) IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      ORDER BY s.name ASC`,
  ).bind(scope.lineAccountId, idsJson).all<{ id: string; name: string; field_id: string }>();
  return [
    ...forms.results.map((row) => ({
      kind: 'form' as const,
      id: row.id,
      name: row.name,
      fieldId: row.field_id,
      // 公開版は不変なので、移行処理が下書きだけを書き換えても公開側は残る。
      switchable: Number(row.switchable) === 1,
    })),
    ...reminders.results.map((row) => ({ kind: 'reminder' as const, id: row.id, name: row.name, fieldId: row.field_id, switchable: true })),
    ...searches.results.map((row) => ({ kind: 'saved_search' as const, id: row.id, name: row.name, fieldId: row.field_id, switchable: false })),
  ];
}

/**
 * 画面から届いた「動かせる行だけの新しい順」を、届いていない行の位置を
 * 保ったまま全体の並びへ戻して、1回のバッチで書く。
 *
 * 行ごとの PATCH だと途中失敗で一部だけ新しい順位が残る。ここでは
 * 依頼されたIDを動かせる行に限って位置だけ入れ替える。
 * 共通項目（is_inherited=1）は他のアカウントの並びにも効くため触らない。
 */
export async function reorderFriendFields(
  db: D1Database,
  scope: FriendFieldScope,
  ids: string[],
): Promise<void> {
  const current = await getFriendFieldsForScope(db, scope);
  const movable = new Set(
    current.filter((field) => field.is_inherited !== 1).map((field) => field.id),
  );
  const requested = ids.filter((id) => movable.has(id));
  if (requested.length < 2) return;
  const requestedSet = new Set(requested);
  let index = 0;
  const nextOrder = current.map((field) =>
    requestedSet.has(field.id) ? requested[index++] : field.id);
  await db.batch(
    nextOrder.flatMap((id, position) =>
      movable.has(id)
        ? [db.prepare(`UPDATE friend_fields SET display_order = ? WHERE id = ?`).bind(position, id)]
        : []),
  );
}

export async function deleteFriendField(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM friend_fields WHERE id = ?`).bind(id).run();
}

/**
 * 1人ぶんの全項目と値。値が無い項目も含めて返す。
 *
 * 値がある項目だけを返すと、画面は「何を聞けるのか」が分からない。
 * 空欄も含めて出せてはじめて入力欄として使える。
 */
export async function getFriendFieldsWithValues(
  db: D1Database,
  friendId: string,
): Promise<Array<FriendField & { value: string | null; updated_by: string | null }>> {
  const result = await db
    .prepare(
      `SELECT f.*, v.value, v.updated_by, v.updated_at AS value_updated_at,
              fx.fixed_key, v.source_type, v.source_id, source_form.name AS source_name
         FROM friend_fields f
         LEFT JOIN friend_field_values v
           ON v.field_id = f.id AND v.friend_id = ?
         LEFT JOIN friend_fixed_fields fx ON fx.field_id = f.id
         LEFT JOIN forms source_form ON v.source_type = 'form' AND source_form.id = v.source_id
        ORDER BY f.display_order ASC, f.name ASC`,
    )
    .bind(friendId)
    .all<FriendField & { value: string | null; updated_by: string | null }>();
  return result.results.map(normalizeFriendField);
}

export interface FriendFieldValueCheckTarget {
  type: string;
  field_key?: string;
  options_json?: string | null;
}

/** 選択肢の持ち方は2通りある。文字列のままか、ID付きの形か。 */
function parseValueCheckOptions(optionsJson: string | null | undefined): Array<{ id: string; label: string }> {
  if (!optionsJson) return [];
  try {
    const parsed = JSON.parse(optionsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: Array<{ id: string; label: string }> = [];
    for (const option of parsed) {
      const id = typeof option === 'string'
        ? option.trim()
        : option && typeof option === 'object'
          ? String((option as { id?: unknown }).id ?? (option as { label?: unknown }).label ?? '').trim()
          : '';
      const label = typeof option === 'string'
        ? option.trim()
        : option && typeof option === 'object'
          ? String((option as { label?: unknown }).label ?? (option as { id?: unknown }).id ?? '').trim()
          : '';
      if (id && label) out.push({ id, label });
    }
    return out;
  } catch {
    return [];
  }
}

/** YYYY-MM-DDの形に加え、暦に存在する日かまで見る。 */
function isExistingCalendarDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

/**
 * 項目の型に合わせて保存値を検証・正規化する。
 *
 * 単票更新・一括更新・フォーム回答・自動化など、値の書き込み口は複数ある。
 * どれか1つでも型に合わない値を許すと、絞り込み配信の数値比較や
 * テンプレートの差し込みで矛盾・失敗が起きる。書き込む前にこの関数へ通し、
 * 通らなければ保存せず項目単位の422で返す。正規化した値を保存することで、
 * 後段（配信条件・差し込み・自動化）は同じ形の値だけを読む。
 *
 * 空（null・undefined・空文字）は「消す」扱いで value: null を返す。
 * setFriendFieldValue が空文字で行を消す動きと合わせている。
 */
/**
 * 保存値を受け付ける種類をここに列挙する。載っていない種類は fail-closed で止める。
 *
 * 項目の種類は作成時に FRIEND_FIELD_TYPES からしか選べないが、古い行や
 * 直接書き込みで想定外の種類が残っている可能性がある。未知の種類を
 * 無条件で通すと、不正値が波及する。
 */
const VALUE_CHECKABLE_TYPES = new Set<string>(FRIEND_FIELD_TYPES);

export function validateFriendFieldValue(
  field: FriendFieldValueCheckTarget,
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (field.field_key === 'fixed_allergy') {
    const checked = validateAllergyValues(raw);
    return checked.ok ? { ok: true, value: checked.values.length ? JSON.stringify(checked.values) : null } : checked;
  }
  const type = typeof field.type === 'string' ? field.type : '';
  if (!VALUE_CHECKABLE_TYPES.has(type)) {
    return { ok: false, error: 'この項目の種類では値を保存できません' };
  }
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null };

  if (field.field_key === 'fixed_age' && (!/^\d{1,3}$/.test(String(raw).trim()) || Number(raw) > 150)) {
    return { ok: false, error: '年齢は0〜150の整数で入力してください' };
  }
  if (field.field_key === 'fixed_birthday' && ageFromBirthday(String(raw).trim()) === null) {
    return { ok: false, error: '生年月日は過去の存在する日付で入力してください' };
  }

  if (type === 'checkbox') {
    if (raw === true || raw === '1' || (typeof raw === 'string' && raw.trim().toLowerCase() === 'true')) {
      return { ok: true, value: '1' };
    }
    if (raw === false || raw === '0' || (typeof raw === 'string' && raw.trim().toLowerCase() === 'false')) {
      return { ok: true, value: '0' };
    }
    return { ok: false, error: 'チェック項目ははい・いいえで入力してください' };
  }
  if (type === 'multi_select') {
    let items: unknown[];
    if (Array.isArray(raw)) {
      items = raw;
    } else if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown;
        items = Array.isArray(parsed) ? parsed : [raw];
      } catch {
        items = [raw];
      }
    } else {
      return { ok: false, error: '複数選択は選択肢から選んでください' };
    }
    const options = parseValueCheckOptions(field.options_json);
    const ids: string[] = [];
    for (const item of items) {
      const text = String(item ?? '').trim();
      if (!text) continue;
      const option = options.find((o) => o.id === text || o.label === text);
      if (!option) return { ok: false, error: '登録済みの選択肢から選んでください' };
      if (!ids.includes(option.id)) ids.push(option.id);
    }
    if (ids.length === 0) return { ok: true, value: null };
    return { ok: true, value: JSON.stringify(ids) };
  }
  if (type === 'select') {
    if (typeof raw !== 'string') return { ok: false, error: '登録済みの選択肢から選んでください' };
    const text = raw.trim();
    const option = parseValueCheckOptions(field.options_json).find((o) => o.id === text || o.label === text);
    return option
      ? { ok: true, value: option.id }
      : { ok: false, error: '登録済みの選択肢から選んでください' };
  }
  if (type === 'number') {
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim().replace(/,/g, '') : '';
    if (!text || !/^[-+]?(\d+(\.\d+)?|\.\d+)$/.test(text) || !Number.isFinite(Number(text))) {
      return { ok: false, error: '数値で入力してください' };
    }
    return { ok: true, value: text.startsWith('+') ? text.slice(1) : text };
  }
  if (type === 'date') {
    if (typeof raw !== 'string' || !isExistingCalendarDate(raw.trim())) {
      return { ok: false, error: 'YYYY-MM-DDの存在する日付で入力してください' };
    }
    return { ok: true, value: raw.trim() };
  }
  if (type === 'time') {
    if (typeof raw !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.trim())) {
      return { ok: false, error: 'HH:mmの時刻（00:00〜23:59）で入力してください' };
    }
    return { ok: true, value: raw.trim() };
  }
  if (type === 'datetime') {
    if (typeof raw !== 'string') return { ok: false, error: '日時形式で入力してください' };
    const text = raw.trim();
    if (Number.isNaN(Date.parse(text))) {
      return { ok: false, error: '日時形式で入力してください' };
    }
    /*
     * Date.parse は存在しない日（2026-02-31）を翌月へ読み替えて
     * 通してしまう。先頭が YYYY-MM-DD のときは暦に存在するかも見る。
     * 日付型と同じ判定にし、既定値・個別値で同じ結果にする。
     */
    const datePrefix = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (datePrefix && !isExistingCalendarDate(`${datePrefix[1]}-${datePrefix[2]}-${datePrefix[3]}`)) {
      return { ok: false, error: '存在する日時を日時形式で入力してください' };
    }
    return { ok: true, value: new Date(text).toISOString() };
  }
  if (type === 'email') {
    if (typeof raw !== 'string') return { ok: false, error: 'メールアドレス形式で入力してください' };
    const text = raw.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
      ? { ok: true, value: text }
      : { ok: false, error: 'メールアドレス形式で入力してください' };
  }
  if (type === 'tel') {
    if (typeof raw !== 'string') return { ok: false, error: '電話番号は数字10〜15桁で入力してください' };
    const text = raw.trim();
    /*
     * 記号だけの入力を避けるため、移行プレビュー・本人特定と同じく
     * 数字の桁数で見る。入力の見た目（ハイフン等）は
     * 残し、保存する形は変えない。
     */
    const digits = text.replace(/\D/g, '');
    const ok = /^\+?[0-9()\- ]{1,25}$/.test(text) && digits.length >= 10 && digits.length <= 15;
    return ok
      ? { ok: true, value: text }
      : { ok: false, error: '電話番号は数字10〜15桁で入力してください' };
  }
  if (type === 'url') {
    if (typeof raw !== 'string') return { ok: false, error: 'httpまたはhttpsのURLで入力してください' };
    const text = raw.trim();
    try {
      if (!['http:', 'https:'].includes(new URL(text).protocol)) throw new Error();
    } catch {
      return { ok: false, error: 'httpまたはhttpsのURLで入力してください' };
    }
    return { ok: true, value: text };
  }
  if (type === 'image' || type === 'pdf') {
    if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 2000) {
      return { ok: false, error: '画像・PDFの指定を確認してください' };
    }
    return { ok: true, value: raw.trim() };
  }
  if (type === 'text' || type === 'textarea') {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: String(raw) };
    if (typeof raw !== 'string') return { ok: false, error: '文字で入力してください' };
    const limit = type === 'textarea' ? 2000 : 200;
    const text = raw.trim();
    if (text.length > limit) return { ok: false, error: `${limit}文字以内で入力してください` };
    return { ok: true, value: text === '' ? null : text };
  }
  return { ok: false, error: 'この項目の種類では値を保存できません' };
}

/**
 * 値を書き込む中央の口。
 *
 * field（種類と選択肢）を渡すと、保存前に validateFriendFieldValue で
 * 検証・正規化し、正規化した値を保存する。通らない値は例外で止める。
 * 口（単票・一括など）は事前に検証して項目単位の422を返すのが役目で、
 * ここは「検証済みのはず」の安全網として働く。
 *
 * field が無い呼び出しは従来どおり素通しする。フォーム・シナリオ系の
 * 接続が終わるまでの暫定で、新しい接続は必ず field を渡す。
 *
 * 空文字は行を消す。「空欄にした」と「一度も入れていない」を分けても
 * 画面上は同じ見え方になり、分けた分だけ判定が増えるため。
 */
export function friendFieldValueStatements(
  db: D1Database,
  input: { friendId: string; fieldId: string; value: string | null; updatedBy: string; field?: FriendFieldValueCheckTarget; sourceType?: string; sourceId?: string },
): D1PreparedStatement[] {
  let value = input.value;
  if (input.field) {
    const checked = validateFriendFieldValue(input.field, value);
    if (!checked.ok) throw new Error(`invalid friend field value: ${checked.error}`);
    value = checked.value;
  }
  const now = jstNow();
  const statement = value === null || value === ''
    ? db.prepare(`DELETE FROM friend_field_values WHERE friend_id = ? AND field_id = ?`).bind(input.friendId, input.fieldId)
    : db.prepare(`INSERT INTO friend_field_values (friend_id, field_id, value, updated_by, updated_at, source_type, source_id)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(friend_id, field_id)
        DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at,
          source_type = excluded.source_type, source_id = excluded.source_id`)
        .bind(input.friendId,input.fieldId,value,input.updatedBy,now,input.sourceType ?? null,input.sourceId ?? null);
  return [statement, ...friendFieldReminderTargetStatements(db, [{ friendId: input.friendId, fieldId: input.fieldId, value }], now)];
}


export async function setFriendFieldValue(
  db: D1Database,
  input: Parameters<typeof friendFieldValueStatements>[1],
): Promise<void> {
  await db.batch(friendFieldValueStatements(db, input));
}

/**
 * 一括値を1回のD1 batchで書く。
 *
 * 値は呼び出し側で validate済みの正規化ずみを渡すこと。batchは原子的で、
 * 途中の1文が失敗したら永続変更は0件になる。空配列は呼ばないこと。
 */
export async function setFriendFieldValuesBulk(
  db: D1Database,
  input: {
    fieldId: string;
    entries: Array<{ friendId: string; value: string | null }>;
    updatedBy: string;
    now: string;
  },
): Promise<number> {
  const statements = input.entries.map((entry) =>
    entry.value === null || entry.value === ''
      ? db
          .prepare('DELETE FROM friend_field_values WHERE friend_id = ? AND field_id = ?')
          .bind(entry.friendId, input.fieldId)
      : db
          .prepare(
            `INSERT INTO friend_field_values (friend_id, field_id, value, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(friend_id, field_id)
             DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
                           updated_at = excluded.updated_at`,
          )
          .bind(entry.friendId, input.fieldId, entry.value, input.updatedBy, input.now),
  );
  await db.batch([...statements, ...friendFieldReminderTargetStatements(db,
    input.entries.map(entry => ({ ...entry, fieldId: input.fieldId })), input.now)]);
  return statements.length;
}

/**
 * M046: 1人の複数項目を1回のD1 batchで書く。
 *
 * 値は呼び出し側で validate済みの正規化ずみを渡すこと。batchは原子的で、
 * 途中の1文が失敗したら永続変更は0件になる。空配列は呼ばないこと。
 */
export async function setFriendFieldValuesForFriend(
  db: D1Database,
  input: {
    friendId: string;
    entries: Array<{ fieldId: string; value: string | null }>;
    updatedBy: string;
    now: string;
  },
): Promise<number> {
  const statements = input.entries.map((entry) =>
    entry.value === null || entry.value === ''
      ? db
          .prepare('DELETE FROM friend_field_values WHERE friend_id = ? AND field_id = ?')
          .bind(input.friendId, entry.fieldId)
      : db
          .prepare(
            `INSERT INTO friend_field_values (friend_id, field_id, value, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(friend_id, field_id)
             DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
                           updated_at = excluded.updated_at`,
          )
          .bind(input.friendId, entry.fieldId, entry.value, input.updatedBy, input.now),
  );
  await db.batch([...statements, ...friendFieldReminderTargetStatements(db,
    input.entries.map(entry => ({ ...entry, friendId: input.friendId })), input.now)]);
  return statements.length;
}

/**
 * テンプレートの差し込み用に、その友だちの値を key => value で返す。
 *
 * 値が無い項目は既定値で埋める。差し込みの結果が空文字になるより、
 * 「未設定」と書いてある方が受け取る側に伝わる、という判断は
 * 呼び出し側（差し込みエンジン）に委ねるので、ここでは既定値までを返す。
 */
export async function getFriendFieldMap(
  db: D1Database,
  friendId: string,
): Promise<Record<string, string>> {
  const result = await db
    .prepare(
      `SELECT f.field_key, COALESCE(f.type_v8, f.type_v6, f.type) AS field_type, f.options_json,
              COALESCE(v.value, f.default_value) AS value
         FROM friend_fields f
         LEFT JOIN friend_field_values v
           ON v.field_id = f.id AND v.friend_id = ?`,
    )
    .bind(friendId)
    .all<{ field_key: string; field_type: string; options_json: string | null; value: string | null }>();
  const out: Record<string, string> = {};
  for (const row of result.results) {
    if (row.field_key === 'fixed_allergy' && row.value != null) { out[row.field_key] = allergyValues(row.value).join('、'); continue; }
    if (row.value == null || row.field_type === 'image' || row.field_type === 'pdf') continue;
    if (row.field_type === 'select' || row.field_type === 'multi_select') {
      try {
        const options = JSON.parse(row.options_json ?? '[]') as Array<string | { id?: string; label?: string }>;
        const labels = new Map(options.map((option) => typeof option === 'string'
          ? [option, option]
          : [String(option.id ?? option.label ?? ''), String(option.label ?? '')]));
        if (row.field_type === 'multi_select') {
          const ids = JSON.parse(row.value) as unknown;
          if (Array.isArray(ids)) out[row.field_key] = ids.map((id) => labels.get(String(id)) ?? String(id)).join('、');
        } else {
          out[row.field_key] = labels.get(row.value) ?? row.value;
        }
      } catch {
        out[row.field_key] = row.value;
      }
      continue;
    }
    out[row.field_key] = row.value;
  }
  const derivedAge = ageFromBirthday(out.fixed_birthday);
  if (derivedAge !== null) out.fixed_age = String(derivedAge);
  return out;
}


/** 固定項目の対応は migration 623 だけが定義する。アカウント固有のIDは使わない。 */
export async function getFixedFriendField(
  db: D1Database, key: import("@line-crm/shared").FixedFriendFieldKey,
): Promise<FriendField | null> {
  const row = await db.prepare(`SELECT f.* FROM friend_fields f
    JOIN friend_fixed_fields fixed ON fixed.field_id = f.id WHERE fixed.fixed_key = ?`)
    .bind(key).first<FriendField>();
  return row ? normalizeFriendField(row) : null;
}
