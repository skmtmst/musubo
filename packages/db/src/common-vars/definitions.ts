import { jstNow } from '../utils.js';
import { type CommonVar, type CommonVarUsageKind, type CommonVarExpiryBehavior } from './record-types.js';
import { type CommonVarUsageImpact, type CommonVarUsageItem } from './types.js';
import { COMMON_VAR_USAGE_QUERIES } from './usage-queries.js';
import { type CommonVarType } from './resolution-types.js';


/**
 * 一覧の総件数。件数上限で切ったときに「絞り込み誘導」を出すために使う。
 *
 * 未取得を0件と見せない規則と同じく、切ったことを黙らない。
 */
export async function countCommonVars(
  db: D1Database,
  opts: { folderId?: string; ungrouped?: boolean; lineAccountId: string },
): Promise<number> {
  const row = opts.folderId
    ? await db.prepare(`SELECT COUNT(*) AS total FROM common_vars WHERE line_account_id = ? AND archived_at IS NULL AND folder_id = ?`)
      .bind(opts.lineAccountId, opts.folderId).first<{ total: number }>()
    : opts.ungrouped
      ? await db.prepare(`SELECT COUNT(*) AS total FROM common_vars WHERE line_account_id = ? AND archived_at IS NULL AND folder_id IS NULL`)
        .bind(opts.lineAccountId).first<{ total: number }>()
      : await db.prepare(`SELECT COUNT(*) AS total FROM common_vars WHERE line_account_id = ? AND archived_at IS NULL`)
        .bind(opts.lineAccountId).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/** 一覧の1回の上限。件数に比例して使用先の走査が重くなるため、上限と絞り込み誘導で守る。 */
export const COMMON_VARS_LIST_LIMIT = 200;

export async function getCommonVars(
  db: D1Database,
  opts: { folderId?: string; lineAccountId: string; limit?: number },
): Promise<CommonVar[]> {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? COMMON_VARS_LIST_LIMIT), COMMON_VARS_LIST_LIMIT));
  const overview = `,
    (SELECT s.effective_from FROM common_var_schedules s
      WHERE s.var_id = common_vars.id AND s.applied_at IS NULL
      ORDER BY s.effective_from ASC, s.id ASC LIMIT 1) AS next_effective_from,
    (SELECT s.value FROM common_var_schedules s
      WHERE s.var_id = common_vars.id AND s.applied_at IS NULL
      ORDER BY s.effective_from ASC, s.id ASC LIMIT 1) AS next_value,
    (SELECT COUNT(*) FROM common_var_schedules s
      WHERE s.var_id = common_vars.id AND s.applied_at IS NULL) AS pending_schedule_count`;
  if (opts.folderId) {
    const result = await db
      .prepare(`SELECT common_vars.* ${overview} FROM common_vars WHERE line_account_id = ? AND archived_at IS NULL AND folder_id = ? ORDER BY name ASC LIMIT ?`)
      .bind(opts.lineAccountId, opts.folderId, limit)
      .all<CommonVar>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT common_vars.* ${overview} FROM common_vars WHERE line_account_id = ? AND archived_at IS NULL ORDER BY name ASC LIMIT ?`)
    .bind(opts.lineAccountId, limit)
    .all<CommonVar>();
  return result.results;
}

/**
 * 従来キーの差し込みを厳密なトークン単位で数える。
 * LIKEはアンダースコアをワイルドカード扱いするため使わない。
 * 1種類でも走査できなければ例外にし、削除を安全側に止める。
 */
export async function getCommonVarUsageImpact(
  db: D1Database,
  varKey: string,
  lineAccountId: string,
): Promise<CommonVarUsageImpact> {
  const token = `{{var.${varKey}}}`;
  const byKind = Object.fromEntries(
    COMMON_VAR_USAGE_QUERIES.map((source) => [source.kind, 0]),
  ) as Record<CommonVarUsageKind, number>;
  const items: CommonVarUsageItem[] = [];

  for (const source of COMMON_VAR_USAGE_QUERIES) {
    const result = await db.prepare(source.sql)
      .bind(...source.values(varKey, token, lineAccountId))
      .all<Omit<CommonVarUsageItem, 'kind'>>();
    const found = result.results.map((item) => ({ ...item, kind: source.kind }));
    items.push(...found);
    byKind[source.kind] = found.length;
  }

  // 送信中の写しから、このアカウント・このキーの版だけを読む。
  // 古い写しや壊れた写しは不明とし、現在の版で代用しない。
  for (const item of items) {
    if (item.source_table !== 'broadcasts' || item.source_status !== 'sending_fixed') continue;
    const row = await db.prepare('SELECT common_var_snapshot FROM broadcasts WHERE id = ?')
      .bind(item.source_id).first<{ common_var_snapshot: string | null }>();
    item.fixed_version = null;
    try {
      const parsed = JSON.parse(row?.common_var_snapshot ?? 'null') as {
        accounts?: Record<string, { entries?: Array<{ varKey?: string; version?: unknown }> }>;
      } | null;
      const version = parsed?.accounts?.[lineAccountId]?.entries?.find((entry) => entry.varKey === varKey)?.version;
      if (typeof version === 'number' && Number.isSafeInteger(version) && version > 0) item.fixed_version = version;
    } catch { /* 版を確かめられない写しは不明とする。 */ }
  }

  // form_accounts が1件も無い古いフォームだけは、どのアカウントのものか
  // 確定できない。名前や本文は返さず、件数だけ残して削除を安全側に止める。
  const unscopedForms = await db.prepare(
    `SELECT COUNT(*) AS count FROM forms f
      LEFT JOIN form_versions v ON v.id = f.current_published_version_id
      CROSS JOIN (SELECT ? AS token, ? AS var_key) target
      WHERE NOT EXISTS (SELECT 1 FROM form_accounts fa WHERE fa.form_id = f.id)
        AND (instr(coalesce(f.on_submit_message_content, ''), target.token) > 0
          OR instr(coalesce(f.fields, ''), target.token) > 0
          OR instr(coalesce(f.layout, ''), target.token) > 0
          OR instr(coalesce(v.on_submit_message_content, ''), target.token) > 0
          OR instr(coalesce(v.fields, ''), target.token) > 0
          OR instr(coalesce(v.layout, ''), target.token) > 0 OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(f.layout) THEN f.layout ELSE 'null' END,'$.references') j WHERE j.key='varKey' AND CAST(j.value AS TEXT)=target.var_key) OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(v.layout) THEN v.layout ELSE 'null' END,'$.references') j WHERE j.key='varKey' AND CAST(j.value AS TEXT)=target.var_key))`,
  ).bind(token,varKey).first<{ count: number }>();
  const unscopedFormTotal = Number(unscopedForms?.count ?? 0);
  byKind.form += unscopedFormTotal;

  const historicalTotal = items.reduce(
    (sum, item) => sum + (item.is_historical === 1 ? 1 : 0),
    0,
  );
  // 送信開始時の値で固定済みの配信中は、値を変えても消してもその配信は
  // 変わらない（写しを持つ）。変わる・壊れる件数には入れない。
  const sendingFixedTotal = items.reduce(
    (sum, item) => sum + (item.source_status === 'sending_fixed' ? 1 : 0),
    0,
  );
  const total = items.length + unscopedFormTotal;
  return {
    total,
    blockingTotal: total - historicalTotal - sendingFixedTotal,
    historicalTotal,
    sendingFixedTotal,
    unscopedFormTotal,
    byKind,
    items,
  };
}

export async function getCommonVarById(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<CommonVar | null> {
  return db.prepare(`SELECT * FROM common_vars WHERE id = ? AND line_account_id = ? AND archived_at IS NULL`)
    .bind(id, lineAccountId).first<CommonVar>();
}

/** 履歴表示専用。更新・削除の判定には使わず、アーカイブ済みも参照できる。 */
export async function getCommonVarByIdIncludingArchived(
  db: D1Database,
  id: string,
  lineAccountId: string,
): Promise<CommonVar | null> {
  return db.prepare(`SELECT * FROM common_vars WHERE id = ? AND line_account_id = ?`)
    .bind(id, lineAccountId).first<CommonVar>();
}

export class CommonVarVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('Common variable version conflict');
  }
}

export class CommonVarFolderError extends Error {
  constructor() {
    super('Common variable folder not found or wrong kind');
  }
}

export class CommonVarKeyConflictError extends Error {
  constructor() {
    super('Common variable key already exists in this account');
  }
}

export class CommonVarReasonRequiredError extends Error {
  constructor() {
    super('Common variable change reason is required');
  }
}

export class CommonVarStatusTransitionError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`Common variable cannot move from ${from} to ${to}`);
  }
}

/**
 * フォルダの存在と種別を確認する。
 *
 * 違う画面のフォルダIDを指定されると、絞り込み表示が想定外になる。
 * 共通情報以外のフォルダ・存在しないフォルダは受け付けない。
 */
export async function assertCommonVarFolder(db: D1Database, folderId: string): Promise<void> {
  const row = await db.prepare(`SELECT id FROM folders WHERE id = ? AND kind = 'common_var'`)
    .bind(folderId).first<{ id: string }>();
  if (!row) throw new CommonVarFolderError();
}

export async function createCommonVar(
  db: D1Database,
  input: {
    name: string;
    lineAccountId: string;
    varKey: string;
    value?: string;
    type?: CommonVarType;
    folderId?: string | null;
    memo?: string;
    actorId?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    fallbackValue?: string | null;
    expiryBehavior?: CommonVarExpiryBehavior;
    /** 下書きとして作るとき 'draft'。省略は従来どおり 'active'（すぐ使える）。 */
    status?: 'draft' | 'active';
  },
): Promise<CommonVar> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const memo = input.memo ?? '';
  const value = input.value ?? '';
  const status = input.status ?? 'active';
  if (input.folderId) await assertCommonVarFolder(db, input.folderId);
  const duplicate = await db.prepare(
    `SELECT id FROM common_vars
      WHERE line_account_id = ? AND var_key = ?
      LIMIT 1`,
  ).bind(input.lineAccountId, input.varKey).first<{ id: string }>();
  if (duplicate) throw new CommonVarKeyConflictError();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO common_vars
           (id, line_account_id, folder_id, name, var_key, type, value, memo, version,
            updated_by, created_at, updated_at, valid_from, valid_until, fallback_value,
            expiry_behavior, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id, input.lineAccountId, input.folderId ?? null, input.name, input.varKey,
        input.type ?? 'text', value, memo, input.actorId ?? null, now, now,
        input.validFrom ?? null, input.validUntil ?? null, input.fallbackValue ?? null,
        input.expiryBehavior ?? 'stop', status,
      ),
      db.prepare(
        `INSERT INTO common_var_versions
           (id, common_var_id, version_no, name, value, memo, change_reason, actor_id, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), id, input.name, value, memo,
        status === 'draft' ? '下書きとして作成' : '作成', input.actorId ?? null, now,
      ),
    ]);
  } catch (error) {
    if (error instanceof Error
      && error.message.includes('UNIQUE constraint failed: common_vars.line_account_id, common_vars.var_key')) {
      throw new CommonVarKeyConflictError();
    }
    throw error;
  }
  return (await getCommonVarById(db, id, input.lineAccountId))!;
}
