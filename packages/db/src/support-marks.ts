import { supportMarkImpactRevision } from './support-mark-impact-revision.js';
import type { SupportMark } from './support-mark-types.js';
import type { SupportMarkWithUsage } from './support-mark-impact-revision.js';
export { supportMarkImpactRevision } from './support-mark-impact-revision.js';
export type { SupportMark, SupportMarkWithUsage } from './support-mark-impact-revision.js';
import { parseSupportMarkLocations, type SupportMarkLocation } from '@line-crm/shared';

import { recordOperation } from './operation-audit.js';
import { jstNow } from './utils.js';

/** 移行前の対応マークを所属させる既定テナント。既存IDは変えない。 */
const LEGACY_TENANT_ID = '00000000-0000-4000-8000-000000000001';

export interface SupportMarkScope {
  tenantId: string;
  lineAccountId: string;
}

export interface SupportMarkArchiveImpact {
  mark: SupportMarkWithUsage;
  revision: string;
  canArchive: boolean;
  checkedAt: string;
}

const MARK_SELECT = `
  SELECT sm.id, sm.name, sm.color, sm.is_default, sm.auto_on_inbound,
         sm.display_order, sm.display_locations_json, sm.created_at, sm.archived_at, sm.version,
         COALESCE(sm.updated_at, sm.created_at) AS updated_at,
         sm.created_by, sm.updated_by,
         sms.line_account_id,
         COALESCE(sms.tenant_id, '${LEGACY_TENANT_ID}') AS tenant_id,
         CASE WHEN sms.mark_id IS NULL OR sms.line_account_id IS NULL THEN 1 ELSE 0 END AS is_inherited
    FROM support_marks sm
    LEFT JOIN support_mark_scopes sms ON sms.mark_id = sm.id`;

/**
 * 初期の3マークを用意する。
 *
 * マイグレーション100の固定3件は既存環境にだけ残る。新規環境では
 * 選択中アカウント専用の3件を作り、別アカウントとIDも設定も共有しない。
 * INSERT OR IGNORE とアカウントを含む固定IDなので、何度呼んでも増えない。
 */
export async function ensureDefaultSupportMarks(
  db: D1Database,
  scope: SupportMarkScope,
): Promise<void> {
  const visible = await db
    .prepare(
      `${MARK_SELECT}
        WHERE sm.archived_at IS NULL
          AND COALESCE(sms.tenant_id, ?) = ?
          AND (sms.line_account_id = ? OR sms.line_account_id IS NULL)
        LIMIT 1`,
    )
    .bind(LEGACY_TENANT_ID, scope.tenantId, scope.lineAccountId)
    .first<SupportMark>();
  if (visible) return;

  const rows = [
    { suffix: 'untouched', name: '未対応', color: '#F59E0B', default: 1, inbound: 1, order: 0 },
    { suffix: 'working', name: '対応中', color: '#3B82F6', default: 0, inbound: 0, order: 1 },
    { suffix: 'done', name: '解決済', color: '#10B981', default: 0, inbound: 0, order: 2 },
  ];
  const statements = [];
  for (const row of rows) {
    const id = `mark_${row.suffix}_${scope.lineAccountId}`;
    const now = jstNow();
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO support_marks
             (id, name, color, is_default, auto_on_inbound, display_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, row.name, row.color, row.default, row.inbound, row.order, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO support_mark_scopes
             (mark_id, tenant_id, line_account_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(id, scope.tenantId, scope.lineAccountId, now),
    );
  }
  await db.batch(statements);
}

export async function getSupportMarks(
  db: D1Database,
  scope: SupportMarkScope,
): Promise<SupportMark[]> {
  await ensureDefaultSupportMarks(db, scope);
  const result = await db
    .prepare(
      `${MARK_SELECT}
        WHERE sm.archived_at IS NULL
          AND COALESCE(sms.tenant_id, ?) = ?
          AND (sms.line_account_id = ? OR sms.line_account_id IS NULL)
        ORDER BY CASE WHEN sms.line_account_id = ? THEN 0 ELSE 1 END,
                 sm.display_order ASC, sm.created_at ASC`,
    )
    .bind(LEGACY_TENANT_ID, scope.tenantId, scope.lineAccountId, scope.lineAccountId)
    .all<SupportMark>();
  const hasAccountDefault = result.results.some(
    (mark) => mark.line_account_id === scope.lineAccountId && mark.is_default === 1,
  );
  return result.results.map((mark) =>
    hasAccountDefault && mark.line_account_id === null && mark.is_default === 1
      ? { ...mark, is_default: 0 }
      : mark,
  );
}

/**
 * 一覧用の対応マークと参照数を1回で読む。
 *
 * 画面で「配信・自動応答」と固定表示すると、実際には使っていないマークまで
 * 使用中に見える。逆に1件ずつ数えるとN+1になるため、JSON条件も含めて
 * 相関サブクエリでまとめて返す。実行履歴は現在の使用先ではないため数えない。
 */
export async function getSupportMarksWithUsage(
  db: D1Database,
  scope: SupportMarkScope,
  includeArchived = false,
): Promise<SupportMarkWithUsage[]> {
  await ensureDefaultSupportMarks(db, scope);
  const result = await db.prepare(
    `WITH visible_marks AS (
       ${MARK_SELECT}
        WHERE ${includeArchived ? '1 = 1' : 'sm.archived_at IS NULL'}
          AND COALESCE(sms.tenant_id, ?) = ?
          AND (sms.line_account_id = ? OR sms.line_account_id IS NULL)
     )
     SELECT sm.*,
       (SELECT COUNT(*) FROM friends f
         WHERE f.support_mark_id = sm.id AND f.line_account_id = ?) AS friend_count,
       (SELECT COUNT(*) FROM broadcasts b WHERE b.line_account_id = ? AND EXISTS (
          SELECT 1 FROM json_tree(CASE WHEN json_valid(b.segment_conditions)
                                       THEN b.segment_conditions ELSE 'null' END) j
           WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
        )) AS broadcasts,
       (SELECT COUNT(DISTINCT a.scenario_id)
          FROM scenario_actions a
          JOIN scenarios sc ON sc.id = a.scenario_id
         WHERE sc.line_account_id = ? AND (
          (a.action_type = 'support_mark' AND EXISTS (
            SELECT 1 FROM json_tree(CASE WHEN json_valid(a.config_json)
                                         THEN a.config_json ELSE 'null' END) j
             WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
          )) OR EXISTS (
            SELECT 1 FROM json_tree(CASE WHEN json_valid(a.condition_json)
                                         THEN a.condition_json ELSE 'null' END) j
             WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
          )
        )) AS scenarios,
       (SELECT COUNT(*) FROM auto_replies a WHERE a.line_account_id = ? AND a.deleted_at IS NULL AND (EXISTS (
          SELECT 1 FROM json_tree(CASE WHEN json_valid(a.actions_json)
                                       THEN a.actions_json ELSE 'null' END) j
           WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
        ) OR EXISTS (
          SELECT 1 FROM json_tree(CASE WHEN json_valid(a.friend_conditions_json)
                                       THEN a.friend_conditions_json ELSE 'null' END) j
           WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
        ))) AS auto_replies,
       (SELECT COUNT(*) FROM saved_searches s WHERE s.line_account_id = ? AND EXISTS (
          SELECT 1 FROM json_tree(CASE WHEN json_valid(s.conditions_json)
                                       THEN s.conditions_json ELSE 'null' END) j
           WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
        )) AS saved_searches,
       ((SELECT COUNT(*) FROM automations a WHERE a.line_account_id = ? AND (EXISTS (
          SELECT 1 FROM json_tree(CASE WHEN json_valid(a.conditions)
                                       THEN a.conditions ELSE 'null' END) j
           WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
        ) OR EXISTS (
          SELECT 1 FROM json_tree(CASE WHEN json_valid(a.actions)
                                       THEN a.actions ELSE 'null' END) j
           WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
        ))) +
        (SELECT COUNT(DISTINCT v.automation_id)
           FROM automation_versions v
           JOIN automation_definitions d ON d.id = v.automation_id
          WHERE v.status = 'published' AND d.line_account_id = ? AND (
          EXISTS (
            SELECT 1 FROM json_tree(CASE WHEN json_valid(v.condition_config)
                                         THEN v.condition_config ELSE 'null' END) j
             WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
          ) OR EXISTS (
            SELECT 1 FROM json_tree(CASE WHEN json_valid(v.action_config)
                                         THEN v.action_config ELSE 'null' END) j
             WHERE j.type = 'text' AND CAST(j.value AS TEXT) = sm.id
          )
        ))) AS automations
       FROM visible_marks sm
      ORDER BY CASE WHEN sm.line_account_id = ? THEN 0 ELSE 1 END,
               sm.display_order ASC, sm.created_at ASC`,
  )
    .bind(
      LEGACY_TENANT_ID,
      scope.tenantId,
      scope.lineAccountId,
      scope.lineAccountId,
      scope.lineAccountId,
      scope.lineAccountId,
      scope.lineAccountId,
      scope.lineAccountId,
      scope.lineAccountId,
      scope.lineAccountId,
      scope.lineAccountId,
    )
    .all<SupportMarkWithUsage>();

  const hasAccountDefault = result.results.some(
    (mark) => mark.line_account_id === scope.lineAccountId && mark.is_default === 1,
  );
  return result.results.map((mark) =>
    hasAccountDefault && mark.line_account_id === null && mark.is_default === 1
      ? { ...mark, is_default: 0 }
      : mark,
  );
}

export async function getSupportMarkArchiveImpact(
  db: D1Database,
  scope: SupportMarkScope,
  markId: string,
): Promise<SupportMarkArchiveImpact | null> {
  const mark = (await getSupportMarksWithUsage(db, scope)).find((item) => item.id === markId);
  if (!mark) return null;
  const referenceCount = Number(mark.broadcasts)
    + Number(mark.scenarios)
    + Number(mark.auto_replies)
    + Number(mark.saved_searches)
    + Number(mark.automations);
  return {
    mark,
    revision: supportMarkImpactRevision(mark),
    canArchive: mark.is_default !== 1 && mark.is_inherited !== 1 && referenceCount === 0,
    checkedAt: jstNow(),
  };
}

export async function getSupportMarkById(
  db: D1Database,
  id: string,
  scope: SupportMarkScope,
): Promise<SupportMark | null> {
  return db
    .prepare(
      `${MARK_SELECT}
        WHERE sm.id = ?
          AND sm.archived_at IS NULL
          AND COALESCE(sms.tenant_id, ?) = ?
          AND (sms.line_account_id = ? OR sms.line_account_id IS NULL)`,
    )
    .bind(id, LEGACY_TENANT_ID, scope.tenantId, scope.lineAccountId)
    .first<SupportMark>();
}

/**
 * 既定のマーク。新しい友だちに最初に付く。
 *
 * is_default が複数ある場合は並び順の先頭を採る。1行だけにする決まりだが、
 * 壊れていても動きが止まらない方がよい。
 */
export async function getDefaultSupportMark(
  db: D1Database,
  scope: SupportMarkScope,
): Promise<SupportMark | null> {
  await ensureDefaultSupportMarks(db, scope);
  return db
    .prepare(
      `${MARK_SELECT}
        WHERE sm.is_default = 1
          AND sm.archived_at IS NULL
          AND COALESCE(sms.tenant_id, ?) = ?
          AND (sms.line_account_id = ? OR sms.line_account_id IS NULL)
        ORDER BY CASE WHEN sms.line_account_id = ? THEN 0 ELSE 1 END,
                 sm.display_order ASC
        LIMIT 1`,
    )
    .bind(LEGACY_TENANT_ID, scope.tenantId, scope.lineAccountId, scope.lineAccountId)
    .first<SupportMark>();
}

export async function createSupportMark(
  db: D1Database,
  scope: SupportMarkScope,
  input: {
    name: string;
    color?: string;
    isDefault?: boolean;
    autoOnInbound?: boolean;
    displayOrder?: number;
  },
): Promise<SupportMark> {
  return createSupportMarkWithAutomationRules(db, scope, input, null, []);
}

export interface NewSupportMarkAutomationRule {
  name: string;
  event: string;
  condition?: unknown;
  priority: number;
  manualProtectionMinutes: number;
  isActive: boolean;
}

export class SupportMarkCreateError extends Error {
  constructor(public readonly code: 'idempotency_conflict', message: string) {
    super(message);
    this.name = 'SupportMarkCreateError';
  }
}

/**
 * 同じ要求キーの再送で二重に作らないための指紋。
 *
 * 名前・色・並び順・初期値・受信時自動付与・自動変更ルールが
 * 1文字でも違えば別の要求とみなし、作らず止める。
 */
function supportMarkCreateFingerprint(
  input: {
    name: string;
    color?: string;
    isDefault?: boolean;
    autoOnInbound?: boolean;
    displayOrder?: number;
  },
  automationRules: NewSupportMarkAutomationRule[],
): string {
  return JSON.stringify({
    name: input.name,
    color: input.color ?? '#94A3B8',
    isDefault: input.isDefault === true,
    autoOnInbound: input.autoOnInbound === true,
    displayOrder: input.displayOrder ?? 0,
    automationRules,
  });
}

export interface SupportMarkCreateResult {
  mark: SupportMark;
  /** 同じ要求キーの再送で、保存済みのマークを返した。 */
  replayed: boolean;
}

/**
 * 要求キー付きで対応マークを作る。
 *
 * 応答だけ失った再試行は、同じキー・同じ内容なら保存済みのマークを
 * 返す（作り直さない）。同じキーに異なる内容が来たら作らず止める。
 * 要求キーの行は本体と同じD1バッチで確定するため、同時に同じキーが
 * 送られても1件だけ残る（負けた側のバッチは巻き戻る）。
 */
export async function createSupportMarkIdempotent(
  db: D1Database,
  scope: SupportMarkScope,
  input: {
    name: string;
    color?: string;
    isDefault?: boolean;
    autoOnInbound?: boolean;
    displayOrder?: number;
  },
  actorId: string | null,
  automationRules: NewSupportMarkAutomationRule[],
  idempotencyKey: string,
): Promise<SupportMarkCreateResult> {
  const fingerprint = supportMarkCreateFingerprint(input, automationRules);
  const findRequest = () => db.prepare(
    `SELECT mark_id, request_fingerprint
       FROM support_mark_create_requests
      WHERE line_account_id = ? AND idempotency_key = ?`,
  ).bind(scope.lineAccountId, idempotencyKey).first<{
    mark_id: string;
    request_fingerprint: string;
  }>();
  const previous = await findRequest();
  if (previous) {
    if (previous.request_fingerprint !== fingerprint) {
      throw new SupportMarkCreateError(
        'idempotency_conflict',
        '同じ要求キーに異なる内容が指定されました。一覧を確認してください',
      );
    }
    const mark = await getSupportMarkById(db, previous.mark_id, scope);
    if (mark) return { mark, replayed: true };
    // 保存済みのはずのマークが無い（保管済み等）。古い予約を消して作り直す。
    await db.prepare(
      `DELETE FROM support_mark_create_requests
        WHERE line_account_id = ? AND idempotency_key = ?`,
    ).bind(scope.lineAccountId, idempotencyKey).run();
  }
  const markId = crypto.randomUUID();
  try {
    const mark = await createSupportMarkWithAutomationRules(
      db, scope, input, actorId, automationRules, markId,
      { key: idempotencyKey, fingerprint },
    );
    return { mark, replayed: false };
  } catch (err) {
    // 同時に同じキーが確定した可能性がある。勝った側の結果に従い、
    // 勝者がいなければ元の失敗をそのまま返す（握りつぶさない）。
    const raced = await findRequest().catch(() => null);
    if (raced?.request_fingerprint === fingerprint) {
      const mark = await getSupportMarkById(db, raced.mark_id, scope).catch(() => null);
      if (mark) return { mark, replayed: true };
    }
    throw err;
  }
}

/** マーク本体と自動変更ルールを同じD1バッチで確定する。 */
export async function createSupportMarkWithAutomationRules(
  db: D1Database,
  scope: SupportMarkScope,
  input: {
    name: string;
    color?: string;
    isDefault?: boolean;
    autoOnInbound?: boolean;
    displayOrder?: number;
  },
  actorId: string | null,
  automationRules: NewSupportMarkAutomationRule[],
  markId: string = crypto.randomUUID(),
  idempotency?: { key: string; fingerprint: string },
): Promise<SupportMark> {
  const id = markId;
  const now = jstNow();
  const statements: D1PreparedStatement[] = [];
  if (input.isDefault) {
    statements.push(db.prepare(
        `UPDATE support_marks SET is_default = 0
          WHERE id IN (
            SELECT mark_id FROM support_mark_scopes
             WHERE tenant_id = ? AND line_account_id = ?
          )`,
      ).bind(scope.tenantId, scope.lineAccountId));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO support_marks
           (id, name, color, is_default, auto_on_inbound, display_order, created_at,
            version, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        id,
        input.name,
        input.color ?? '#94A3B8',
        input.isDefault ? 1 : 0,
        input.autoOnInbound ? 1 : 0,
        input.displayOrder ?? 0,
        now,
        now,
        actorId,
        actorId,
      ),
    db
      .prepare(
        `INSERT INTO support_mark_scopes (mark_id, tenant_id, line_account_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(id, scope.tenantId, scope.lineAccountId, now),
  );
  for (const rule of automationRules) {
    const automationId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    statements.push(
      db.prepare(
        `INSERT INTO automation_definitions
           (id, line_account_id, name, description, status, priority, created_by, created_at, updated_at)
         VALUES (?, ?, ?, '対応マークの自動変更', ?, ?, ?, ?, ?)`,
      ).bind(
        automationId,
        scope.lineAccountId,
        rule.name.trim(),
        rule.isActive ? 'active' : 'stopped',
        rule.priority,
        actorId,
        now,
        now,
      ),
      db.prepare(
        `INSERT INTO automation_versions
           (id, automation_id, version_number, status, trigger_type, trigger_config,
            condition_config, action_config, created_by, created_at, published_at)
         VALUES (?, ?, 1, 'published', 'support_mark_change', ?, ?, ?, ?, ?, ?)`,
      ).bind(
        versionId,
        automationId,
        JSON.stringify({ kind: 'support_mark_rule', event: rule.event }),
        JSON.stringify(rule.condition ?? {}),
        JSON.stringify([{
          id: 'set-support-mark',
          type: 'set_support_mark',
          params: { markId: id, manualProtectionMinutes: rule.manualProtectionMinutes },
          onFailure: 'stop',
        }]),
        actorId,
        now,
        now,
      ),
      db.prepare(
        'UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, current_published_version_id = ? WHERE id = ?',
      ).bind(versionId, automationId),
    );
  }
  statements.push(db.prepare(
    `INSERT INTO operation_audit
       (id, target_kind, target_id, action, actor_id, friend_id, detail_json)
     VALUES (?, 'support_mark', ?, 'created', ?, NULL, ?)`,
  ).bind(
    crypto.randomUUID(),
    id,
    actorId,
    JSON.stringify({ lineAccountId: scope.lineAccountId, automationRuleCount: automationRules.length }),
  ));
  if (idempotency) {
    // 要求キーの行も同じバッチで確定する。本体より後に積むため、
    // 外部キーのある環境でも制約に当たらない。同じキーの同時実行は
    // UNIQUE 制約で負けた側だけ巻き戻り、二重に残らない。
    statements.push(db.prepare(
      `INSERT INTO support_mark_create_requests
         (id, line_account_id, idempotency_key, request_fingerprint,
          mark_id, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      scope.lineAccountId,
      idempotency.key,
      idempotency.fingerprint,
      id,
      JSON.stringify({ markId: id }),
      now,
    ));
  }
  await db.batch(statements);
  return (await getSupportMarkById(db, id, scope))!;
}

/**
 * 読んだときの版（expectedVersion）と違えば、ほかの担当者が
 * 先に変えている。黙って上書きせず 'conflict' を返す。
 */
export async function updateSupportMark(
  db: D1Database,
  id: string,
  scope: SupportMarkScope,
  input: {
    name?: string;
    color?: string;
    isDefault?: boolean;
    autoOnInbound?: boolean;
    displayOrder?: number;
    displayLocations?: SupportMarkLocation[];
    actorId?: string | null;
    expectedVersion?: number;
  },
): Promise<SupportMark | null | 'conflict'> {
  if(input.displayLocations!==undefined)input.displayLocations=parseSupportMarkLocations(input.displayLocations);
  const existing = await getSupportMarkById(db, id, scope);
  if (!existing) return null;
  if (input.expectedVersion !== undefined
    && Number(existing.version ?? 1) !== input.expectedVersion) {
    return 'conflict';
  }

  // 移行前の共通マークは選択中アカウントへ複製し、そのアカウントの
  // 友だちだけを付け替える。他アカウントの表示や設定は変えない。
  if (existing.is_inherited === 1) {
    /*
     * D031: 版を送った複製は、元の版を1つ進める要求で取り合う。
     * 同じ版の同時実行は負けた側が409になり、複製の二重作成を防ぐ。
     * 版を送らない古い呼び出しは従来どおり作る（後方互換）。
     */
    if (input.expectedVersion !== undefined) {
      const claimed = await db
        .prepare(
          `UPDATE support_marks SET version = version + 1, updated_at = ?, updated_by = ?
            WHERE id = ? AND version = ?`,
        )
        .bind(jstNow(), input.actorId ?? null, id, input.expectedVersion)
        .run();
      if (Number(claimed.meta.changes ?? 0) !== 1) {
        const latest = await getSupportMarkById(db, id, scope);
        if (!latest) return null;
        return 'conflict';
      }
    }
    /*
     * D033: 複製の作成と友だちの付け替えを同じ取引（D1バッチ）で確定する。
     * 付け替えで失敗したら複製も戻り、送り直しで孤児の複製が増えない。
     */
    const cloneId = crypto.randomUUID();
    const now = jstNow();
    const cloneStatements: D1PreparedStatement[] = [];
    const cloneIsDefault = input.isDefault ?? Boolean(existing.is_default);
    if (cloneIsDefault) {
      cloneStatements.push(db.prepare(
        `UPDATE support_marks SET is_default = 0
          WHERE id IN (
            SELECT mark_id FROM support_mark_scopes
             WHERE tenant_id = ? AND line_account_id = ?
          )`,
      ).bind(scope.tenantId, scope.lineAccountId));
    }
    cloneStatements.push(
      db
        .prepare(
          `INSERT INTO support_marks
             (id, name, color, is_default, auto_on_inbound, display_order, created_at,
              version, updated_at, created_by, updated_by, display_locations_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .bind(
          cloneId,
          input.name ?? existing.name,
          input.color ?? existing.color,
          cloneIsDefault ? 1 : 0,
          (input.autoOnInbound ?? Boolean(existing.auto_on_inbound)) ? 1 : 0,
          input.displayOrder ?? existing.display_order,
          now,
          now,
          input.actorId ?? null,
          input.actorId ?? null,
          JSON.stringify(input.displayLocations ?? JSON.parse(existing.display_locations_json)),
        ),
      db
        .prepare(
          `INSERT INTO support_mark_scopes (mark_id, tenant_id, line_account_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(cloneId, scope.tenantId, scope.lineAccountId, now),
      db.prepare(
        `INSERT INTO operation_audit
           (id, target_kind, target_id, action, actor_id, friend_id, detail_json)
         VALUES (?, 'support_mark', ?, 'created', ?, NULL, ?)`,
      ).bind(
        crypto.randomUUID(),
        cloneId,
        input.actorId ?? null,
        JSON.stringify({ lineAccountId: scope.lineAccountId, automationRuleCount: 0 }),
      ),
      db
        .prepare(
          `UPDATE friends SET support_mark_id = ?
            WHERE support_mark_id = ? AND line_account_id = ?`,
        )
        .bind(cloneId, existing.id, scope.lineAccountId),
    );
    await db.batch(cloneStatements);
    return getSupportMarkById(db, cloneId, scope);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  const put = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    values.push(v);
  };
  if (input.name !== undefined) put('name', input.name);
  if (input.color !== undefined) put('color', input.color);
  if (input.isDefault !== undefined) put('is_default', input.isDefault ? 1 : 0);
  if (input.autoOnInbound !== undefined) put('auto_on_inbound', input.autoOnInbound ? 1 : 0);
  if (input.displayOrder !== undefined) put('display_order', input.displayOrder);
  if (input.displayLocations !== undefined) put('display_locations_json', JSON.stringify(input.displayLocations));
  if (sets.length > 0) {
    sets.push('version = version + 1');
    put('updated_at', jstNow());
    put('updated_by', input.actorId ?? null);
    values.push(id, scope.tenantId, scope.lineAccountId);
    let where = `WHERE id = ? AND id IN (
            SELECT mark_id FROM support_mark_scopes
             WHERE tenant_id = ? AND line_account_id = ?
          )`;
    if (input.expectedVersion !== undefined) {
      /*
       * D031: 版の照合を更新文自体に入れる。読んでから書くまでの隙に
       * 別の担当者が変えていても、後勝ちで上書きしない。
       */
      where += ' AND version = ?';
      values.push(input.expectedVersion);
    }
    const updated = await db
      .prepare(`UPDATE support_marks SET ${sets.join(', ')} ${where}`)
      .bind(...values)
      .run();
    if (input.expectedVersion !== undefined && Number(updated.meta.changes ?? 0) !== 1) {
      const latest = await getSupportMarkById(db, id, scope);
      if (!latest) return null;
      return 'conflict';
    }
  }
  /*
   * D031: 既定の付け替えは本体の確定後に回す。版が進んでいて止まるときに、
   * 既定だけ外れる半端な状態を作らない。
   */
  if (input.isDefault === true) {
    await db
      .prepare(
        `UPDATE support_marks SET is_default = 0
          WHERE id != ? AND id IN (
            SELECT mark_id FROM support_mark_scopes
             WHERE tenant_id = ? AND line_account_id = ?
          )`,
      )
      .bind(id, scope.tenantId, scope.lineAccountId)
      .run();
  }
  return getSupportMarkById(db, id, scope);
}

/**
 * 画面から届いた「動かせる行だけの新しい順」を、届いていない行の位置を
 * 保ったまま全体の並びへ戻して、1回のバッチで書く。
 *
 * 共有マーク（is_inherited=1）は触らない。`updateSupportMark` に流すと
 * 複製＋付け替えが走るため、並び替えからは必ず外す。
 */
export async function reorderSupportMarks(
  db: D1Database,
  scope: SupportMarkScope,
  ids: string[],
): Promise<void> {
  const current = await getSupportMarks(db, scope);
  const movable = new Set(
    current.filter((mark) => mark.is_inherited !== 1).map((mark) => mark.id),
  );
  const requested = ids.filter((id) => movable.has(id));
  if (requested.length < 2) return;
  const requestedSet = new Set(requested);
  let index = 0;
  const nextOrder = current.map((mark) =>
    requestedSet.has(mark.id) ? requested[index++] : mark.id);
  await db.batch(
    nextOrder.flatMap((id, position) =>
      movable.has(id)
        ? [db.prepare(`UPDATE support_marks SET display_order = ? WHERE id = ?`).bind(position, id)]
        : []),
  );
}

/**
 * 対応マークを置換してから保管する。
 *
 * 公開済みの配信条件などは古いマークIDを参照し続けるため、物理削除しない。
 * 友だちの置換・友だちごとの履歴・保管記録を D1 の1バッチにまとめる。
 */
export async function replaceAndArchiveSupportMark(
  db: D1Database,
  markId: string,
  replacementMarkId: string,
  scope: SupportMarkScope,
  actorId?: string | null,
): Promise<number> {
  if (markId === replacementMarkId) {
    throw new Error('Replacement support mark must be different');
  }
  const [mark, replacement] = await Promise.all([
    getSupportMarkById(db, markId, scope),
    getSupportMarkById(db, replacementMarkId, scope),
  ]);
  // 削除対象は選択中アカウント専用だけ。置換先も同じアカウントから
  // 見えるマークに限定し、別アカウントのIDを直接指定しても更新しない。
  if (!mark || mark.is_inherited === 1 || !replacement) return 0;
  const usage = (await getSupportMarksWithUsage(db, scope)).find((row) => row.id === markId);
  const referenceCount = usage
    ? Number(usage.broadcasts)
      + Number(usage.scenarios)
      + Number(usage.auto_replies)
      + Number(usage.saved_searches)
      + Number(usage.automations)
    : 0;
  if (referenceCount > 0) {
    throw new Error('Referenced support mark cannot be archived');
  }

  const detail = JSON.stringify({
    previousMarkId: markId,
    replacementMarkId,
    reason: 'deleted_mark_replacement',
  });
  const archivedAt = jstNow();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO operation_audit
           (id, target_kind, target_id, action, actor_id, friend_id, detail_json)
         SELECT lower(hex(randomblob(16))), 'support_mark', ?, 'changed', ?, id, ?
           FROM friends
          WHERE support_mark_id = ? AND line_account_id = ?`,
      )
      .bind(replacementMarkId, actorId ?? null, detail, markId, scope.lineAccountId),
    db
      .prepare(
        `UPDATE friends SET support_mark_id = ?
          WHERE support_mark_id = ? AND line_account_id = ?`,
      )
      .bind(replacementMarkId, markId, scope.lineAccountId),
    db
      .prepare(
        `UPDATE support_marks
            SET archived_at = ?, is_default = 0, auto_on_inbound = 0,
                version = version + 1, updated_at = ?, updated_by = ?
          WHERE id = ? AND archived_at IS NULL`,
      )
      .bind(archivedAt, archivedAt, actorId ?? null, markId),
    db
      .prepare(
        `INSERT INTO operation_audit
           (id, target_kind, target_id, action, actor_id, friend_id, detail_json)
         VALUES (lower(hex(randomblob(16))), 'support_mark', ?, 'archived', ?, NULL, ?)`,
      )
      .bind(
        markId,
        actorId ?? null,
        JSON.stringify({ replacementMarkId, reason: 'stop_new_use' }),
      ),
  ]);

  return Number(results[1]?.meta?.changes ?? 0);
}

export type SupportMarkArchiveErrorCode =
  | 'not_found'
  | 'default_mark'
  | 'inherited_mark'
  | 'referenced'
  | 'replacement_invalid'
  | 'version_conflict'
  | 'impact_changed'
  | 'idempotency_conflict';

export class SupportMarkArchiveError extends Error {
  constructor(public readonly code: SupportMarkArchiveErrorCode, message: string) {
    super(message);
    this.name = 'SupportMarkArchiveError';
  }
}

export interface SupportMarkArchiveResult {
  archived: true;
  markId: string;
  replacementMarkId: string | null;
  replacedFriendCount: number;
  version: number;
}

/**
 * の確認版に一致する場合だけ、友だちの置換と保管を一括で行う。
 * 同じIdempotency-Keyの再送は保存済み結果を返す。
 *
 * 使っている友だちが0人のときは置換先なし（null）で保管できる。
 * 0人でも置換先を必須にすると、独自マーク1件だけのアカウントでは候補が
 * 空（共有マークは除外・自身も除外）になり保管できない。友だちが
 * いるのに置換先が無い要求は `replacement_invalid` で止める。使用中・
 * 参照ありの保護（canArchive）と初期値・共有の禁止は変えない。
 */
export async function archiveSupportMarkWithReplacement(
  db: D1Database,
  scope: SupportMarkScope,
  input: {
    markId: string;
    replacementMarkId: string | null;
    expectedVersion: number;
    impactRevision: string;
    idempotencyKey: string;
    actorId: string | null;
  },
): Promise<SupportMarkArchiveResult> {
  const fingerprint = JSON.stringify({
    markId: input.markId,
    replacementMarkId: input.replacementMarkId,
    expectedVersion: input.expectedVersion,
    impactRevision: input.impactRevision,
  });
  const previous = await db.prepare(
    `SELECT request_fingerprint, response_json
       FROM support_mark_archive_requests
      WHERE line_account_id = ? AND idempotency_key = ?`,
  ).bind(scope.lineAccountId, input.idempotencyKey).first<{
    request_fingerprint: string;
    response_json: string;
  }>();
  if (previous) {
    if (previous.request_fingerprint !== fingerprint) {
      throw new SupportMarkArchiveError(
        'idempotency_conflict',
        '同じ処理IDに異なる保管内容が指定されました',
      );
    }
    return JSON.parse(previous.response_json) as SupportMarkArchiveResult;
  }

  if (input.replacementMarkId !== null && input.markId === input.replacementMarkId) {
    throw new SupportMarkArchiveError('replacement_invalid', '置換先は別のマークを指定してください');
  }
  const [impact, replacement] = await Promise.all([
    getSupportMarkArchiveImpact(db, scope, input.markId),
    input.replacementMarkId === null
      ? Promise.resolve(null)
      : getSupportMarkById(db, input.replacementMarkId, scope),
  ]);
  if (!impact) throw new SupportMarkArchiveError('not_found', '対応マークが見つかりません');
  if (input.replacementMarkId === null) {
    // 置換先なしは0人のときだけ。友だちがいるのに置換先が無いと付け替え先を失う。
    if (Number(impact.mark.friend_count) !== 0) {
      throw new SupportMarkArchiveError('replacement_invalid', '使っている友だちがいるため置換先を指定してください');
    }
  } else if (!replacement || replacement.archived_at) {
    throw new SupportMarkArchiveError('replacement_invalid', '置換先の対応マークが見つかりません');
  }
  if (impact.mark.is_default === 1) {
    throw new SupportMarkArchiveError('default_mark', '初期値の対応マークは保管できません');
  }
  if (impact.mark.is_inherited === 1) {
    throw new SupportMarkArchiveError('inherited_mark', '共通の対応マークは保管できません');
  }
  if (Number(impact.mark.version ?? 1) !== input.expectedVersion) {
    throw new SupportMarkArchiveError('version_conflict', 'ほかの担当者が先に変更しました');
  }
  if (impact.revision !== input.impactRevision) {
    throw new SupportMarkArchiveError('impact_changed', '確認後に使用状況が変わりました');
  }
  if (!impact.canArchive) {
    throw new SupportMarkArchiveError('referenced', '使用先を外してから保管してください');
  }

  const archivedAt = jstNow();
  const result: SupportMarkArchiveResult = {
    archived: true,
    markId: input.markId,
    replacementMarkId: input.replacementMarkId,
    replacedFriendCount: Number(impact.mark.friend_count),
    version: input.expectedVersion + 1,
  };
  const guard = `EXISTS (
    SELECT 1 FROM support_marks guarded
     WHERE guarded.id = ? AND guarded.archived_at = ?
  )`;
  const detail = JSON.stringify({
    previousMarkId: input.markId,
    replacementMarkId: input.replacementMarkId,
    reason: input.replacementMarkId === null ? 'archived_mark_no_replacement' : 'archived_mark_replacement',
  });
  // 置換先なし（0人のときだけ）は友だちの付け替え文を積まない。
  const replacementStatements = input.replacementMarkId === null ? [] : [
    db.prepare(
      `INSERT INTO operation_audit
         (id, target_kind, target_id, action, actor_id, friend_id, detail_json)
       SELECT lower(hex(randomblob(16))), 'support_mark', ?, 'changed', ?, id, ?
         FROM friends
        WHERE support_mark_id = ? AND line_account_id = ? AND ${guard}`,
    ).bind(
      input.replacementMarkId,
      input.actorId,
      detail,
      input.markId,
      scope.lineAccountId,
      input.markId,
      archivedAt,
    ),
    db.prepare(
      `UPDATE friends SET support_mark_id = ?
        WHERE support_mark_id = ? AND line_account_id = ? AND ${guard}`,
    ).bind(
      input.replacementMarkId,
      input.markId,
      scope.lineAccountId,
      input.markId,
      archivedAt,
    ),
  ];
  const results = await db.batch([
    db.prepare(
      `UPDATE support_marks
          SET archived_at = ?, is_default = 0, auto_on_inbound = 0,
              version = version + 1, updated_at = ?, updated_by = ?
        WHERE id = ? AND archived_at IS NULL AND version = ?
          AND (SELECT COUNT(*) FROM friends
                WHERE support_mark_id = ? AND line_account_id = ?) = ?`,
    ).bind(
      archivedAt,
      archivedAt,
      input.actorId,
      input.markId,
      input.expectedVersion,
      input.markId,
      scope.lineAccountId,
      impact.mark.friend_count,
    ),
    ...replacementStatements,
    db.prepare(
      `INSERT INTO operation_audit
         (id, target_kind, target_id, action, actor_id, friend_id, detail_json)
       SELECT lower(hex(randomblob(16))), 'support_mark', ?, 'archived', ?, NULL, ?
        WHERE ${guard}`,
    ).bind(input.markId, input.actorId, detail, input.markId, archivedAt),
    db.prepare(
      `INSERT OR IGNORE INTO support_mark_archive_requests
         (id, line_account_id, mark_id, idempotency_key, request_fingerprint,
          response_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`,
    ).bind(
      crypto.randomUUID(),
      scope.lineAccountId,
      input.markId,
      input.idempotencyKey,
      fingerprint,
      JSON.stringify(result),
      archivedAt,
      input.markId,
      archivedAt,
    ),
  ]);

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    const raced = await db.prepare(
      `SELECT request_fingerprint, response_json
         FROM support_mark_archive_requests
        WHERE line_account_id = ? AND idempotency_key = ?`,
    ).bind(scope.lineAccountId, input.idempotencyKey).first<{
      request_fingerprint: string;
      response_json: string;
    }>();
    if (raced?.request_fingerprint === fingerprint) {
      return JSON.parse(raced.response_json) as SupportMarkArchiveResult;
    }
    throw new SupportMarkArchiveError('version_conflict', 'ほかの担当者が先に変更しました');
  }
  return result;
}

/** そのマークが付いている友だちの数。削除前の確認に使う。 */
export async function countFriendsWithMark(
  db: D1Database,
  markId: string,
  scope: SupportMarkScope,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM friends
        WHERE support_mark_id = ? AND line_account_id = ?`,
    )
    .bind(markId, scope.lineAccountId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

export async function setFriendSupportMark(
  db: D1Database,
  friendId: string,
  markId: string | null,
  scope: SupportMarkScope,
  actorId?: string | null,
  detail?: Record<string, unknown> | null,
): Promise<boolean> {
  if (markId && !(await getSupportMarkById(db, markId, scope))) return false;
  const before = await db
    .prepare(`SELECT support_mark_id FROM friends WHERE id = ? AND line_account_id = ?`)
    .bind(friendId, scope.lineAccountId)
    .first<{ support_mark_id: string | null }>();
  if (!before) return false;
  if (before.support_mark_id === markId) return true;
  const result = await db
    .prepare(
      `UPDATE friends SET support_mark_id = ?
        WHERE id = ? AND line_account_id = ?`,
    )
    .bind(markId, friendId, scope.lineAccountId)
    .run();
  if (Number(result.meta?.changes ?? 0) === 0) return false;

  // いつ変わったかを残す（110）。friends.support_mark_id は現在値しか
  // 持たないので、これが無いと設計の「過去7日で対応済にした人数」が出せない。
  await recordOperation(db, {
    targetKind: 'support_mark',
    targetId: markId,
    action: 'changed',
    actorId: actorId ?? null,
    friendId,
    detail: {
      beforeMarkId: before.support_mark_id,
      afterMarkId: markId,
      ...(detail ?? {}),
    },
  });
  return true;
}

/**
 * 複数人にまとめて付ける。
 *
 * 1件ずつ UPDATE を投げると人数ぶん往復する。D1 は IN 句で1回に収まる。
 */
export async function setFriendSupportMarkBulk(
  db: D1Database,
  friendIds: string[],
  markId: string | null,
  scope: SupportMarkScope,
): Promise<number> {
  if (friendIds.length === 0) return 0;
  if (markId && !(await getSupportMarkById(db, markId, scope))) return 0;
  let changes = 0;
  for (let offset = 0; offset < friendIds.length; offset += 90) {
    const chunk = friendIds.slice(offset, offset + 90);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db
      .prepare(
        `UPDATE friends SET support_mark_id = ?
          WHERE line_account_id = ? AND id IN (${placeholders})`,
      )
      .bind(markId, scope.lineAccountId, ...chunk)
      .run();
    changes += result.meta?.changes ?? 0;
  }
  return changes;
}

/**
 * 受信したときに自動で付けるマークへ寄せる。
 *
 * 設定が無ければ何もしない。「受信したら必ず未対応に戻す」を既定に
 * すると、解決済みにしたそばから戻ってしまう運用もあるため、
 * auto_on_inbound を立てたマークがあるときだけ動かす。
 */
export async function applyInboundSupportMark(
  db: D1Database,
  friendId: string,
): Promise<boolean> {
  const friendScope = await db
    .prepare(
      `SELECT f.line_account_id AS lineAccountId, la.tenant_id AS tenantId
         FROM friends f
         JOIN line_accounts la ON la.id = f.line_account_id
        WHERE f.id = ?`,
    )
    .bind(friendId)
    .first<{ lineAccountId: string; tenantId: string }>();
  if (!friendScope) return false;
  const scope = { tenantId: friendScope.tenantId, lineAccountId: friendScope.lineAccountId };
  await ensureDefaultSupportMarks(db, scope);
  const mark = await db
    .prepare(
      `${MARK_SELECT}
        WHERE sm.auto_on_inbound = 1
          AND sm.archived_at IS NULL
          AND COALESCE(sms.tenant_id, ?) = ?
          AND (sms.line_account_id = ? OR sms.line_account_id IS NULL)
        ORDER BY CASE WHEN sms.line_account_id = ? THEN 0 ELSE 1 END,
                 sm.display_order ASC
        LIMIT 1`,
    )
    .bind(LEGACY_TENANT_ID, scope.tenantId, scope.lineAccountId, scope.lineAccountId)
    .first<SupportMark>();
  if (!mark) return false;
  return setFriendSupportMark(db, friendId, mark.id, scope);
}
