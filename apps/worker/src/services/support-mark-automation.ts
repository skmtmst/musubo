import { getSupportMarkById, jstNow, type SupportMarkScope } from '@line-crm/db';

import { buildSegmentWhere } from './segment-query.js';
import { type SegmentCondition } from '@line-crm/shared';

export const SUPPORT_MARK_RULE_EVENTS = [
  'message_received',
  'manual_reply_sent',
  'staff_assigned',
  'response_overdue',
  'condition_matched',
] as const;
export type SupportMarkRuleEvent = (typeof SUPPORT_MARK_RULE_EVENTS)[number];

export interface SupportMarkAutomationRule {
  id: string;
  name: string;
  markId: string;
  event: SupportMarkRuleEvent;
  condition: SegmentCondition | null;
  priority: number;
  manualProtectionMinutes: number;
  isActive: boolean;
  version: number;
  updatedAt: string;
}

export interface SaveSupportMarkAutomationRule {
  name: string;
  event: SupportMarkRuleEvent;
  condition?: SegmentCondition | null;
  priority: number;
  manualProtectionMinutes: number;
  isActive: boolean;
}

interface RuleRow {
  id: string;
  name: string;
  status: string;
  priority: number;
  updated_at: string;
  version_number: number;
  trigger_config: string;
  condition_config: string;
  action_config: string;
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseRule(row: RuleRow): SupportMarkAutomationRule | null {
  const trigger = parseObject(row.trigger_config);
  let actions: unknown;
  try {
    actions = JSON.parse(row.action_config);
  } catch {
    return null;
  }
  const action = Array.isArray(actions)
    ? actions.find((item) => item && typeof item === 'object'
      && (item as { type?: unknown }).type === 'set_support_mark') as Record<string, unknown> | undefined
    : undefined;
  const params = action && parseObject(JSON.stringify(action.params ?? null));
  const event = trigger?.event;
  const markId = params?.markId;
  if (!SUPPORT_MARK_RULE_EVENTS.includes(event as SupportMarkRuleEvent) || typeof markId !== 'string') {
    return null;
  }
  const conditionRaw = parseObject(row.condition_config);
  const condition = conditionRaw && Object.keys(conditionRaw).length > 0
    ? conditionRaw as unknown as SegmentCondition
    : null;
  return {
    id: row.id,
    name: row.name,
    markId,
    event: event as SupportMarkRuleEvent,
    condition,
    priority: row.priority,
    manualProtectionMinutes: Number(params?.manualProtectionMinutes ?? 0),
    isActive: row.status === 'active',
    version: row.version_number,
    updatedAt: row.updated_at,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * D035: 条件の形の検査。
 *
 * buildSegmentWhere は rules/groups が無い条件を「全員一致」(1=1)として通すため、
 * {bogus:true} のような未知の形も保存できてしまい、稼働後に意味をなさない
 * ルールが残る。ここでは SegmentCondition の骨組み（operator/rules/groups・
 * 各欄の値・入れ子の組）だけを確かめ、未知の鍵や変な値を 422 で止める。
 * 既知の種類ごとの中身の正しさは buildSegmentWhere が見る。
 */
function assertSegmentConditionShape(condition: unknown): void {
  if (!isPlainObject(condition)) throw new Error('rule_condition_invalid');
  for (const key of Object.keys(condition)) {
    if (key !== 'operator' && key !== 'rules' && key !== 'groups') {
      throw new Error('rule_condition_invalid');
    }
  }
  const { operator, rules, groups } = condition as {
    operator?: unknown; rules?: unknown; groups?: unknown;
  };
  if (operator !== undefined && operator !== 'AND' && operator !== 'OR') {
    throw new Error('rule_condition_invalid');
  }
  if (rules !== undefined && !Array.isArray(rules)) throw new Error('rule_condition_invalid');
  if (groups !== undefined && !Array.isArray(groups)) throw new Error('rule_condition_invalid');
  for (const rule of (rules as unknown[] | undefined) ?? []) {
    if (!isPlainObject(rule) || typeof rule.type !== 'string') {
      throw new Error('rule_condition_invalid');
    }
  }
  for (const group of (groups as unknown[] | undefined) ?? []) {
    assertSegmentConditionShape(group);
  }
}

export function validateSupportMarkAutomationRuleInput(
  input: SaveSupportMarkAutomationRule,
): void {
  if (!input.name.trim()) throw new Error('rule_name_required');
  if (!SUPPORT_MARK_RULE_EVENTS.includes(input.event)) throw new Error('rule_event_invalid');
  if (!Number.isInteger(input.priority) || input.priority < -1000 || input.priority > 1000) {
    throw new Error('rule_priority_invalid');
  }
  if (!Number.isInteger(input.manualProtectionMinutes)
    || input.manualProtectionMinutes < 0
    || input.manualProtectionMinutes > 10080) {
    throw new Error('manual_protection_invalid');
  }
  if (input.condition !== null && input.condition !== undefined) {
    assertSegmentConditionShape(input.condition);
    try {
      buildSegmentWhere(input.condition);
    } catch {
      throw new Error('rule_condition_invalid');
    }
  }
}

function versionPayload(markId: string, input: SaveSupportMarkAutomationRule) {
  return {
    triggerConfig: JSON.stringify({ kind: 'support_mark_rule', event: input.event }),
    conditionConfig: JSON.stringify(input.condition ?? {}),
    actionConfig: JSON.stringify([{
      id: 'set-support-mark',
      type: 'set_support_mark',
      params: { markId, manualProtectionMinutes: input.manualProtectionMinutes },
      onFailure: 'stop',
    }]),
  };
}

async function rowsForAccount(db: D1Database, lineAccountId: string): Promise<RuleRow[]> {
  const rows = await db.prepare(
    `SELECT d.id, d.name, d.status, d.priority, d.updated_at,
            v.version_number, v.trigger_config, v.condition_config, v.action_config
       FROM automation_definitions d
       JOIN automation_versions v ON v.id = d.current_published_version_id
      WHERE d.line_account_id = ? AND d.status != 'archived'
        AND v.status = 'published' AND v.trigger_type = 'support_mark_change'
      ORDER BY d.priority DESC, d.created_at ASC`,
  ).bind(lineAccountId).all<RuleRow>();
  return rows.results ?? [];
}

export async function listSupportMarkAutomationRules(
  db: D1Database,
  scope: SupportMarkScope,
  markId: string,
): Promise<SupportMarkAutomationRule[] | null> {
  if (!await getSupportMarkById(db, markId, scope)) return null;
  return (await rowsForAccount(db, scope.lineAccountId))
    .map(parseRule)
    .filter((item): item is SupportMarkAutomationRule => !!item && item.markId === markId);
}

export async function listSupportMarkAutomationRulesForAccount(
  db: D1Database,
  scope: SupportMarkScope,
): Promise<SupportMarkAutomationRule[]> {
  return (await rowsForAccount(db, scope.lineAccountId))
    .map(parseRule)
    .filter((item): item is SupportMarkAutomationRule => Boolean(item));
}

export class SupportMarkRuleCreateError extends Error {
  constructor(public readonly code: 'idempotency_conflict', message: string) {
    super(message);
    this.name = 'SupportMarkRuleCreateError';
  }
}

/**
 * D034: 同じ要求キーの再送で二重に作らないための指紋。
 *
 * 名前・出来事・条件・優先度・手動保護・有効状態が1つでも違えば
 * 別の要求とみなし、作らず止める（対応マーク作成のと同じ約束）。
 */
function supportMarkRuleCreateFingerprint(
  markId: string,
  input: SaveSupportMarkAutomationRule,
): string {
  return JSON.stringify({
    markId,
    name: input.name.trim(),
    event: input.event,
    condition: input.condition ?? null,
    priority: input.priority,
    manualProtectionMinutes: input.manualProtectionMinutes,
    isActive: input.isActive,
  });
}

export interface SupportMarkRuleCreateResult {
  rule: SupportMarkAutomationRule;
  /** 同じ要求キーの再送で、保存済みのルールを返した。 */
  replayed: boolean;
}

/**
 * D034: 要求キー付きで自動変更ルールを作る。
 *
 * 応答だけ失った再試行は、同じキー・同じ内容なら保存済みのルールを
 * 返す（作り直さない）。同じキーに異なる内容が来たら作らず止める。
 * 要求キーの行は本体と同じD1バッチで確定するため、同時に同じキーが
 * 送られても1件だけ残る（負けた側のバッチは巻き戻る）。
 */
export async function createSupportMarkAutomationRuleIdempotent(
  db: D1Database,
  scope: SupportMarkScope,
  markId: string,
  actorId: string,
  input: SaveSupportMarkAutomationRule,
  idempotencyKey: string,
): Promise<SupportMarkRuleCreateResult | null> {
  validateSupportMarkAutomationRuleInput(input);
  if (!await getSupportMarkById(db, markId, scope)) return null;
  const fingerprint = supportMarkRuleCreateFingerprint(markId, input);
  const findRequest = () => db.prepare(
    `SELECT rule_id, request_fingerprint
       FROM support_mark_rule_create_requests
      WHERE line_account_id = ? AND idempotency_key = ?`,
  ).bind(scope.lineAccountId, idempotencyKey).first<{
    rule_id: string;
    request_fingerprint: string;
  }>();
  const previous = await findRequest();
  if (previous) {
    if (previous.request_fingerprint !== fingerprint) {
      throw new SupportMarkRuleCreateError(
        'idempotency_conflict',
        '同じ要求キーに異なる内容が指定されました。一覧を確認してください',
      );
    }
    const rule = await currentRule(db, scope, previous.rule_id);
    if (rule) return { rule, replayed: true };
    // 保存済みのはずのルールが無い（保管済み等）。古い予約を消して作り直す。
    await db.prepare(
      `DELETE FROM support_mark_rule_create_requests
        WHERE line_account_id = ? AND idempotency_key = ?`,
    ).bind(scope.lineAccountId, idempotencyKey).run();
  }
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = jstNow();
  const payload = versionPayload(markId, input);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO automation_definitions
           (id, line_account_id, name, description, status, priority, created_by, created_at, updated_at)
         VALUES (?, ?, ?, '対応マークの自動変更', ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        scope.lineAccountId,
        input.name.trim(),
        input.isActive ? 'active' : 'stopped',
        input.priority,
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
        id,
        payload.triggerConfig,
        payload.conditionConfig,
        payload.actionConfig,
        actorId,
        now,
        now,
      ),
      db.prepare('UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, current_published_version_id = ? WHERE id = ?')
        .bind(versionId, id),
      db.prepare(
        `INSERT INTO support_mark_rule_create_requests
           (id, line_account_id, mark_id, idempotency_key, request_fingerprint,
            rule_id, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        scope.lineAccountId,
        markId,
        idempotencyKey,
        fingerprint,
        id,
        JSON.stringify({ ruleId: id }),
        now,
      ),
    ]);
  } catch (err) {
    // 同時に同じキーが確定した可能性がある。勝った側の結果に従い、
    // 勝者がいなければ元の失敗をそのまま返す（握りつぶさない）。
    const raced = await findRequest().catch(() => null);
    if (raced?.request_fingerprint === fingerprint) {
      const rule = await currentRule(db, scope, raced.rule_id).catch(() => null);
      if (rule) return { rule, replayed: true };
    }
    throw err;
  }
  const created = (await rowsForAccount(db, scope.lineAccountId)).map(parseRule)
    .find((item) => item?.id === id) ?? null;
  if (!created) return null;
  return { rule: created, replayed: false };
}

export async function createSupportMarkAutomationRule(
  db: D1Database,
  scope: SupportMarkScope,
  markId: string,
  actorId: string,
  input: SaveSupportMarkAutomationRule,
): Promise<SupportMarkAutomationRule | null> {
  validateSupportMarkAutomationRuleInput(input);
  if (!await getSupportMarkById(db, markId, scope)) return null;
  const id = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const now = jstNow();
  const payload = versionPayload(markId, input);
  await db.batch([
    db.prepare(
      `INSERT INTO automation_definitions
         (id, line_account_id, name, description, status, priority, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '対応マークの自動変更', ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      scope.lineAccountId,
      input.name.trim(),
      input.isActive ? 'active' : 'stopped',
      input.priority,
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
      id,
      payload.triggerConfig,
      payload.conditionConfig,
      payload.actionConfig,
      actorId,
      now,
      now,
    ),
    db.prepare('UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, current_published_version_id = ? WHERE id = ?')
      .bind(versionId, id),
  ]);
  return (await rowsForAccount(db, scope.lineAccountId)).map(parseRule)
    .find((item) => item?.id === id) ?? null;
}

async function currentRule(
  db: D1Database,
  scope: SupportMarkScope,
  ruleId: string,
): Promise<SupportMarkAutomationRule | null> {
  return (await rowsForAccount(db, scope.lineAccountId)).map(parseRule)
    .find((item) => item?.id === ruleId) ?? null;
}

export async function updateSupportMarkAutomationRule(
  db: D1Database,
  scope: SupportMarkScope,
  ruleId: string,
  actorId: string,
  expectedVersion: number,
  input: SaveSupportMarkAutomationRule,
): Promise<'not_found' | 'conflict' | SupportMarkAutomationRule> {
  validateSupportMarkAutomationRuleInput(input);
  const current = await currentRule(db, scope, ruleId);
  if (!current) return 'not_found';
  if (current.version !== expectedVersion) return 'conflict';
  const nextVersion = current.version + 1;
  const versionId = crypto.randomUUID();
  const now = jstNow();
  const payload = versionPayload(current.markId, input);
  const results = await db.batch([
    db.prepare(
      `INSERT INTO automation_versions
         (id, automation_id, version_number, status, trigger_type, trigger_config,
          condition_config, action_config, created_by, created_at, published_at)
       SELECT ?, id, ?, 'published', 'support_mark_change', ?, ?, ?, ?, ?, ?
         FROM automation_definitions
        WHERE id = ? AND line_account_id = ? AND current_published_version_id =
          (SELECT id FROM automation_versions WHERE automation_id = ? AND version_number = ?)`,
    ).bind(
      versionId,
      nextVersion,
      payload.triggerConfig,
      payload.conditionConfig,
      payload.actionConfig,
      actorId,
      now,
      now,
      ruleId,
      scope.lineAccountId,
      ruleId,
      expectedVersion,
    ),
    db.prepare(
      `UPDATE automation_definitions
          SET confirmation_revision = confirmation_revision + 1, name = ?, status = ?, priority = ?, current_published_version_id = ?, updated_at = ?
        WHERE id = ? AND line_account_id = ?
          AND EXISTS (SELECT 1 FROM automation_versions WHERE id = ? AND automation_id = ?)`,
    ).bind(
      input.name.trim(),
      input.isActive ? 'active' : 'stopped',
      input.priority,
      versionId,
      now,
      ruleId,
      scope.lineAccountId,
      versionId,
      ruleId,
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
    return 'conflict';
  }
  return await currentRule(db, scope, ruleId) ?? 'not_found';
}

export async function archiveSupportMarkAutomationRule(
  db: D1Database,
  scope: SupportMarkScope,
  ruleId: string,
  expectedVersion: number,
): Promise<'not_found' | 'conflict' | 'archived'> {
  const current = await currentRule(db, scope, ruleId);
  if (!current) return 'not_found';
  if (current.version !== expectedVersion) return 'conflict';
  const now = jstNow();
  const result = await db.prepare(
    `UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, status = 'archived', archived_at = ?, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND current_published_version_id =
        (SELECT id FROM automation_versions WHERE automation_id = ? AND version_number = ?)`,
  ).bind(now, now, ruleId, scope.lineAccountId, ruleId, expectedVersion).run();
  return (result.meta?.changes ?? 0) === 1 ? 'archived' : 'conflict';
}
