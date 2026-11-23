export { getMileageHistoryPeriodSummary } from './history-summary.js';
import { getActionScoreBands } from '../action-score-rules';
import { publishedRuleContentFromDraft } from './rules.js';
import type { SegmentCondition } from '@line-crm/shared';
import { jstMonthStartString, jstNow } from '../utils.js';

const CONDITION_TYPES = new Set([
  'tag_exists', 'tag_not_exists', 'tag_all', 'tag_not_all',
  'metadata_equals', 'metadata_not_equals', 'ref_code', 'is_following',
  'scenario_subscribed', 'name', 'private_memo', 'status_message',
  'registered_at', 'support_mark', 'is_hidden', 'friend_field',
  'scenario_state', 'form_answered', 'last_reaction_at', 'reaction_state',
  'score_range',
]);

export class MileageV6Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'MileageV6Error';
  }
}

export interface MileageTargetCondition {
  operator: 'AND' | 'OR';
  rules: Array<{ type: string; value: unknown }>;
  groups?: MileageTargetCondition[];
}

export interface MileageEarningRuleDraft {
  name: string;
  eventType: string;
  source: string | null;
  amount: number;
  initialStatus: 'available' | 'pending';
  validFrom: string | null;
  validUntil: string | null;
  expiresAfterDays: number | null;
  cancellationEventTypes: string[];
  targetConditions: MileageTargetCondition | null;
  sortOrder: number;
  notification: {
    enabled: boolean;
    messageTemplate: string;
  };
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new MileageV6Error('date_invalid', `${field}の日時を確認してください`, 422, field);
  }
  return new Date(value).toISOString();
}

function validateTargetCondition(value: unknown): MileageTargetCondition | null {
  if (value === null || value === undefined) return null;
  let count = 0;
  const visit = (candidate: unknown, depth: number): MileageTargetCondition => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || depth > 3) {
      throw new MileageV6Error('target_conditions_invalid', '対象条件を確認してください', 422, 'targetConditions');
    }
    const raw = candidate as Record<string, unknown>;
    if (raw.operator !== 'AND' && raw.operator !== 'OR') {
      throw new MileageV6Error('target_conditions_invalid', '対象条件の結び方を確認してください', 422, 'targetConditions');
    }
    if (!Array.isArray(raw.rules)) {
      throw new MileageV6Error('target_conditions_invalid', '対象条件の一覧を確認してください', 422, 'targetConditions');
    }
    const rules = raw.rules.map((rule) => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        throw new MileageV6Error('target_conditions_invalid', '対象条件を確認してください', 422, 'targetConditions');
      }
      const typed = rule as Record<string, unknown>;
      if (typeof typed.type !== 'string' || !CONDITION_TYPES.has(typed.type)) {
        throw new MileageV6Error('target_condition_type_invalid', '利用できない対象条件があります', 422, 'targetConditions');
      }
      count += 1;
      if (count > 15) {
        throw new MileageV6Error('target_conditions_too_many', '対象条件は15件までです', 422, 'targetConditions');
      }
      return { type: typed.type, value: typed.value };
    });
    const groups = raw.groups === undefined
      ? undefined
      : Array.isArray(raw.groups) ? raw.groups.map((group) => visit(group, depth + 1)) : null;
    if (groups === null) {
      throw new MileageV6Error('target_conditions_invalid', '対象条件のグループを確認してください', 422, 'targetConditions');
    }
    return { operator: raw.operator, rules, ...(groups ? { groups } : {}) };
  };
  const parsed = visit(value, 0);
  if (JSON.stringify(parsed).length > 16_384) {
    throw new MileageV6Error('target_conditions_too_large', '対象条件が長すぎます', 422, 'targetConditions');
  }
  return parsed;
}

export function validateMileageEarningRuleDraft(value: unknown): MileageEarningRuleDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MileageV6Error('draft_required', '下書きの内容が必要です', 422, 'draft');
  }
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const eventType = typeof raw.eventType === 'string' ? raw.eventType.trim() : '';
  const source = raw.source === null || raw.source === undefined || raw.source === ''
    ? null
    : typeof raw.source === 'string' ? raw.source.trim() : '';
  const amount = Number(raw.amount);
  const initialStatus = raw.initialStatus === 'pending' ? 'pending' : raw.initialStatus === 'available' ? 'available' : null;
  if (!name || name.length > 120) throw new MileageV6Error('name_invalid', 'ルール名を確認してください', 422, 'name');
  if (!eventType || eventType.length > 100) throw new MileageV6Error('event_type_invalid', 'きっかけを確認してください', 422, 'eventType');
  if (source === '' || (source && source.length > 100)) throw new MileageV6Error('source_invalid', '出どころを確認してください', 422, 'source');
  if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) {
    throw new MileageV6Error('amount_invalid', '付与マイルは1〜1,000,000の整数で指定してください', 422, 'amount');
  }
  if (!initialStatus) throw new MileageV6Error('initial_status_invalid', '付与状態を確認してください', 422, 'initialStatus');
  const validFrom = optionalDate(raw.validFrom, 'validFrom');
  const validUntil = optionalDate(raw.validUntil, 'validUntil');
  if (validFrom && validUntil && validFrom >= validUntil) {
    throw new MileageV6Error('valid_period_invalid', '終了日時は開始日時より後にしてください', 422, 'validUntil');
  }
  const expiresAfterDays = raw.expiresAfterDays === null || raw.expiresAfterDays === undefined
    ? null
    : Number(raw.expiresAfterDays);
  if (expiresAfterDays !== null && (!Number.isInteger(expiresAfterDays) || expiresAfterDays < 1 || expiresAfterDays > 3650)) {
    throw new MileageV6Error('expiration_invalid', '失効期間は1〜3650日で指定してください', 422, 'expiresAfterDays');
  }
  const cancellationEventTypes = Array.isArray(raw.cancellationEventTypes)
    ? [...new Set(raw.cancellationEventTypes.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean))]
    : [];
  if (cancellationEventTypes.length > 10 || cancellationEventTypes.some((item) => item.length > 100)) {
    throw new MileageV6Error('cancellation_events_invalid', '取消イベントは10件までです', 422, 'cancellationEventTypes');
  }
  const sortOrder = raw.sortOrder === undefined ? 0 : Number(raw.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) {
    throw new MileageV6Error('sort_order_invalid', '並び順を確認してください', 422, 'sortOrder');
  }
  const rawNotification = raw.notification && typeof raw.notification === 'object' && !Array.isArray(raw.notification)
    ? raw.notification as Record<string, unknown>
    : null;
  const notificationEnabled = rawNotification?.enabled === true;
  const messageTemplate = typeof rawNotification?.messageTemplate === 'string'
    ? rawNotification.messageTemplate.trim()
    : '';
  if (notificationEnabled && !messageTemplate) {
    throw new MileageV6Error('notification_message_required', '自動通知の本文を入力してください', 422, 'notification.messageTemplate');
  }
  if (messageTemplate.length > 1000) {
    throw new MileageV6Error('notification_message_too_long', '自動通知の本文は1000文字以内で入力してください', 422, 'notification.messageTemplate');
  }
  return {
    name,
    eventType,
    source,
    amount,
    initialStatus,
    validFrom,
    validUntil,
    expiresAfterDays,
    cancellationEventTypes,
    targetConditions: validateTargetCondition(raw.targetConditions),
    sortOrder,
    notification: { enabled: notificationEnabled, messageTemplate },
  };
}

type DraftRow = {
  rule_id: string;
  line_account_id: string;
  version: number;
  draft_json: string;
  updated_at: string;
};

function mapDraft(row: DraftRow) {
  return {
    ruleId: row.rule_id,
    lineAccountId: row.line_account_id,
    version: Number(row.version),
    draft: JSON.parse(row.draft_json) as MileageEarningRuleDraft,
    updatedAt: row.updated_at,
  };
}

export async function saveMileageEarningRuleDraft(
  db: D1Database,
  input: {
    ruleId: string;
    lineAccountId: string;
    expectedVersion: number | null;
    draft: unknown;
    updatedByStaffId?: string | null;
  },
) {
  const draft = validateMileageEarningRuleDraft(input.draft);
  const rule = await db.prepare(`SELECT id, line_account_id FROM mileage_rules WHERE id = ?`).bind(input.ruleId)
    .first<{ id: string; line_account_id: string | null }>();
  if (!rule || (rule.line_account_id != null && rule.line_account_id !== input.lineAccountId)) {
    throw new MileageV6Error('rule_not_found', '付与ルールが見つかりません', 404);
  }
  const current = await db.prepare(
    `SELECT rule_id, line_account_id, version, draft_json, updated_at
       FROM mileage_earning_rule_drafts WHERE rule_id = ?`,
  ).bind(input.ruleId).first<DraftRow>();
  if (current && current.line_account_id !== input.lineAccountId) {
    throw new MileageV6Error('rule_not_found', '付与ルールが見つかりません', 404);
  }
  const now = new Date().toISOString();
  if (!current) {
    if (input.expectedVersion !== null && input.expectedVersion !== 0) {
      throw new MileageV6Error('version_conflict', '下書きを読み直してください', 409);
    }
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO mileage_earning_rule_drafts
         (rule_id, line_account_id, version, draft_json, updated_by_staff_id, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).bind(
      input.ruleId, input.lineAccountId, JSON.stringify(draft), input.updatedByStaffId ?? null, now, now,
    ).run();
    if ((inserted.meta?.changes ?? 0) !== 1) {
      throw new MileageV6Error('version_conflict', '下書きを読み直してください', 409);
    }
  } else {
    if (input.expectedVersion !== current.version) {
      throw new MileageV6Error('version_conflict', '下書きを読み直してください', 409);
    }
    const updated = await db.prepare(
      `UPDATE mileage_earning_rule_drafts
          SET version = version + 1, draft_json = ?, updated_by_staff_id = ?, updated_at = ?
        WHERE rule_id = ? AND line_account_id = ? AND version = ?`,
    ).bind(
      JSON.stringify(draft), input.updatedByStaffId ?? null, now,
      input.ruleId, input.lineAccountId, current.version,
    ).run();
    if ((updated.meta?.changes ?? 0) !== 1) {
      throw new MileageV6Error('version_conflict', '下書きを読み直してください', 409);
    }
  }
  const saved = await db.prepare(
    `SELECT rule_id, line_account_id, version, draft_json, updated_at
       FROM mileage_earning_rule_drafts WHERE rule_id = ? AND line_account_id = ?`,
  ).bind(input.ruleId, input.lineAccountId).first<DraftRow>();
  if (!saved) throw new MileageV6Error('save_failed', '下書きを保存できませんでした', 500);
  return mapDraft(saved);
}

/**
 * 「たまる決めごと」の並び順を全件まとめて保存する。
 *
 * 並び順は下書きJSONの sortOrder に入っている。1件ずつ下書きPATCHを
 * 並列に投げると途中失敗で一部だけ反映され得るため、アカウントの
 * 決めごと全件と一致する並びだけを1トランザクションで書く。
 * 一覧とずれた要求(別アカウント混入・件数不足・重複)はまるごと拒否し、
 * 部分適用しない。版を上げるので、保存前に開いた古い版の下書き保存は
 * 競合として止まり、並び順を黙って戻す取りこぼしが起きない。
 */
export async function reorderMileageEarningRules(
  db: D1Database,
  input: { lineAccountId: string; ids: string[]; updatedByStaffId?: string | null },
): Promise<void> {
  if (!input.ids.length || new Set(input.ids).size !== input.ids.length
    || input.ids.some((id) => typeof id !== 'string' || !id)) {
    throw new MileageV6Error('invalid_order', '並び順を確認してください', 422);
  }
  const existing = await db.prepare(
    `SELECT rule_id FROM mileage_earning_rule_drafts WHERE line_account_id = ?`,
  ).bind(input.lineAccountId).all<{ rule_id: string }>();
  if (existing.results.length !== input.ids.length
    || existing.results.some((row) => !input.ids.includes(row.rule_id))) {
    throw new MileageV6Error('invalid_order', '最新の決めごと一覧と一致しません。読み直してください', 409);
  }
  const now = new Date().toISOString();
  await db.batch(input.ids.map((id, index) => db.prepare(
    `UPDATE mileage_earning_rule_drafts
        SET version = version + 1,
            draft_json = json_set(draft_json, '$.sortOrder', ?),
            updated_by_staff_id = ?, updated_at = ?
      WHERE rule_id = ? AND line_account_id = ?`,
  ).bind(index, input.updatedByStaffId ?? null, now, id, input.lineAccountId)));
}

export async function getMileageEarningRulesV6(
  db: D1Database,
  input: { lineAccountId: string; limit: number; offset: number },
) {
  const [rows, counts] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.name, r.event_type, r.source, r.amount, r.initial_status,
              r.is_active, r.valid_from, r.valid_until, r.created_at, r.updated_at,
              r.published_version_number,
              d.version, d.draft_json, d.updated_at AS draft_updated_at,
              (SELECT COUNT(*) FROM engagement_events ee
                JOIN friends ef ON ef.id = ee.actor_friend_id
               WHERE ef.line_account_id = ? AND ee.event_type = r.event_type
                 AND (r.source IS NULL OR r.source = ee.source)
                 AND ee.occurred_at >= datetime('now', '-30 days')) AS eligible_30d,
              (SELECT COUNT(*) FROM mileage_ledger ml
                JOIN friends lf ON lf.id = ml.beneficiary_friend_id
               WHERE lf.line_account_id = ? AND ml.mileage_rule_id = r.id
                 AND ml.entry_type = 'grant' AND ml.occurred_at >= datetime('now', '-30 days')) AS granted_30d,
              /*
               * R53: 回数ではなく台帳の実額を合計する。下書き金額を
               * 後から変えても、過ぎた付与の額は変わらない。
               */
              (SELECT COALESCE(SUM(ml.amount), 0) FROM mileage_ledger ml
                JOIN friends lf ON lf.id = ml.beneficiary_friend_id
               WHERE lf.line_account_id = ? AND ml.mileage_rule_id = r.id
                 AND ml.entry_type = 'grant' AND ml.occurred_at >= datetime('now', '-30 days')) AS granted_miles_30d
         FROM mileage_earning_rule_drafts d
         JOIN mileage_rules r ON r.id = d.rule_id
        WHERE d.line_account_id = ?
        ORDER BY COALESCE(json_extract(d.draft_json, '$.sortOrder'), 0), r.created_at, r.id
        LIMIT ? OFFSET ?`,
    ).bind(input.lineAccountId, input.lineAccountId, input.lineAccountId, input.lineAccountId, input.limit, input.offset).all<Record<string, unknown>>(),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM mileage_earning_rule_drafts WHERE line_account_id = ?) AS total,
         (SELECT COUNT(*) FROM mileage_rules r
           WHERE NOT EXISTS (SELECT 1 FROM mileage_earning_rule_drafts d WHERE d.rule_id = r.id)) AS unassigned_legacy_count`,
    ).bind(input.lineAccountId).first<{ total: number; unassigned_legacy_count: number }>(),
  ]);
  return {
    items: rows.results.map((row) => {
      const eligible = Number(row.eligible_30d ?? 0);
      const granted = Number(row.granted_30d ?? 0);
      const grantedMiles = Number(row.granted_miles_30d ?? 0);
      return {
        id: String(row.id),
        published: {
          name: String(row.name), eventType: String(row.event_type), source: row.source ?? null,
          amount: Number(row.amount), initialStatus: row.initial_status,
          validFrom: row.valid_from ?? null, validUntil: row.valid_until ?? null,
          status: Number(row.is_active) ? 'published' : 'stopped', updatedAt: row.updated_at,
        },
        draft: JSON.parse(String(row.draft_json)) as MileageEarningRuleDraft,
        draftVersion: Number(row.version),
        draftUpdatedAt: row.draft_updated_at,
        // いま公開中の版。null は未公開。
        publishedVersion: row.published_version_number === null || row.published_version_number === undefined
          ? null
          : Number(row.published_version_number),
        metrics30d: { eligible, granted, grantedMiles, excluded: Math.max(0, eligible - granted) },
      };
    }),
    pagination: { total: Number(counts?.total ?? 0), limit: input.limit, offset: input.offset },
    unassignedLegacyCount: Number(counts?.unassigned_legacy_count ?? 0),
    measuredAt: new Date().toISOString(),
  };
}

export async function getMileageFriendsV6(
  db: D1Database,
  input: {
    lineAccountId: string; visibleAccountIds: string[]; search: string; limit: number; offset: number;
    /** V6R-CX-e: 1人の友だちだけを返す。名前で探して100件から拾うと、同名が多いとこぼれる。 */
    friendId?: string;
  },
) {
  const rankRows = await db.prepare(
    `SELECT r.id, r.name, v.required_miles
       FROM mileage_rewards r
       JOIN mileage_reward_versions v ON v.id = r.current_published_version_id
      WHERE r.line_account_id = ? AND r.reward_kind = 'rank'
        AND r.status = 'published' AND v.status = 'published'
      ORDER BY v.required_miles, r.sort_order, r.id`,
  ).bind(input.lineAccountId).all<{ id: string; name: string; required_miles: number }>();
  const ranks = rankRows.results.map((row) => ({
    id: row.id, name: row.name, threshold: Number(row.required_miles),
  }));
  /*
   * 残高・失効・今月の増減は名寄せした本人（beneficiary_key）単位で集計する。
   * 明細APIの財布スコープ（FRIEND_WALLET_SCOPE_SQL）と同じ意味に揃え、
   * 同じ本人に複数プロフィールがあっても合計を二度足さない。
   * 理由・実行者など記録ごとの中身はここには出さず、明細側が権限で伏せる。
   * 一覧の数字は共通残高として一貫させる。
   */
  /*
   * SQLite の datetime('now','start of month') は UTC の月初を返し、
   * 日本時間の月初 0〜9 時に前月の記録を今月へ混ぜていた。JST の月初を
   * こちらで計算し、JST 表記の occurred_at と同じ形の文字列で渡す。
   */
  const monthStart = jstMonthStartString();
  const ctes = `WITH selected AS (
    SELECT f.id AS friend_id, f.user_id, f.display_name, f.picture_url, f.line_account_id,
           la.name AS line_account_name,
           CASE WHEN f.user_id IS NOT NULL THEN 'user:' || f.user_id ELSE 'friend:' || f.id END AS beneficiary_key
      FROM friends f JOIN line_accounts la ON la.id = f.line_account_id
     WHERE f.line_account_id = ?
  /*
   * 同じ本人へ複数プロフィールが結ばれていると selected に同じ beneficiary_key の
   * 行が並び、そのまま台帳へJOINすると1人の記録がプロフィール数だけ重複して
   * 足される（R386）。まず本人キーへ一意化してから集計する。
   */
  ), keys AS (
    SELECT beneficiary_key, MAX(user_id) AS user_id, MIN(friend_id) AS friend_id
      FROM selected GROUP BY beneficiary_key
  ), ledger AS (
    SELECT k.beneficiary_key,
           SUM(CASE WHEN ml.status = 'available' THEN ml.amount ELSE 0 END) AS available,
           SUM(CASE WHEN ml.status = 'pending' THEN ml.amount ELSE 0 END) AS pending,
           SUM(CASE WHEN ml.entry_type = 'grant' AND ml.amount > 0 THEN ml.amount ELSE 0 END) AS lifetime_earned,
           ABS(SUM(CASE WHEN ml.entry_type = 'spend' AND ml.amount < 0 THEN ml.amount ELSE 0 END)) AS spent,
           SUM(CASE WHEN ml.occurred_at >= ? THEN ml.amount ELSE 0 END) AS month_change,
           MAX(ml.occurred_at) AS last_changed_at
      FROM keys k
      LEFT JOIN mileage_ledger ml ON ml.program_id = 'default' AND (
        (k.user_id IS NOT NULL AND (
          ml.beneficiary_user_id = k.user_id
          OR ml.beneficiary_friend_id IN (
            SELECT lf.id FROM friends lf WHERE lf.user_id = k.user_id
          )
        ))
        OR (k.user_id IS NULL AND ml.beneficiary_friend_id = k.friend_id)
      )
     GROUP BY k.beneficiary_key
  ), expiring AS (
    SELECT k.beneficiary_key,
           SUM(CASE WHEN datetime(l.expires_at) <= datetime('now', '+30 days')
                    THEN l.remaining_amount ELSE 0 END) AS amount,
           COUNT(*) AS lot_count,
           MIN(l.expires_at) AS next_expires_at
      FROM keys k JOIN mileage_grant_lots l ON l.program_id = 'default' AND l.beneficiary_key = k.beneficiary_key
     WHERE l.status = 'available' AND l.remaining_amount > 0 AND l.expires_at IS NOT NULL
       AND datetime(l.expires_at) > datetime('now')
     GROUP BY k.beneficiary_key
  )`;
  const binds = [input.lineAccountId, monthStart];
  const rows = await db.prepare(
    `${ctes}
     SELECT s.*, COALESCE(l.available, 0) AS available, COALESCE(l.pending, 0) AS pending,
            COALESCE(l.lifetime_earned, 0) AS lifetime_earned, COALESCE(l.spent, 0) AS spent,
            COALESCE(l.month_change, 0) AS month_change, l.last_changed_at,
            e.amount AS expiring_amount, e.lot_count, e.next_expires_at,
            (SELECT json_object('name',ml.reason,'amount',ml.amount,'occurredAt',ml.occurred_at,'entryType',ml.entry_type,'status',ml.status)
               FROM mileage_ledger ml LEFT JOIN friends lf ON lf.id=ml.beneficiary_friend_id
              WHERE ml.program_id='default'
                AND ((s.user_id IS NOT NULL AND (ml.beneficiary_user_id=s.user_id OR lf.user_id=s.user_id))
                  OR (s.user_id IS NULL AND ml.beneficiary_friend_id=s.friend_id))
                AND (lf.line_account_id IN (SELECT value FROM json_each(?))
                  OR (ml.beneficiary_friend_id IS NULL AND ml.beneficiary_user_id IS NOT NULL AND EXISTS(
                    SELECT 1 FROM friends vf WHERE vf.user_id=ml.beneficiary_user_id AND vf.line_account_id IN (SELECT value FROM json_each(?)))))
              ORDER BY datetime(ml.occurred_at) DESC,datetime(ml.created_at) DESC,ml.id DESC LIMIT 1) AS last_action_json
       FROM selected s LEFT JOIN ledger l ON l.beneficiary_key = s.beneficiary_key
       LEFT JOIN expiring e ON e.beneficiary_key = s.beneficiary_key
      WHERE (? = '' OR s.display_name LIKE '%' || ? || '%')
        AND (? = '' OR s.friend_id = ?)
      ORDER BY available DESC, s.display_name, s.friend_id LIMIT ? OFFSET ?`,
  ).bind(...binds, JSON.stringify(input.visibleAccountIds), JSON.stringify(input.visibleAccountIds), input.search, input.search, input.friendId ?? '', input.friendId ?? '', input.limit, input.offset).all<Record<string, unknown>>();
  /*
   * 合計は beneficiary_key（本人）単位で足す。同じ本人へ複数プロフィールが
   * 結ばれていても、ledger/expiring はキーごとに1行なので二重計上しない。
   * 友だちの人数だけは行（プロフィール）数で数える。
   */
  const summary = await db.prepare(
    `${ctes}
     SELECT (SELECT COUNT(*) FROM selected) AS total_members,
            (SELECT COUNT(*) FROM selected s
              WHERE (? = '' OR s.display_name LIKE '%' || ? || '%')
                AND (? = '' OR s.friend_id = ?)) AS filtered_members,
            (SELECT COUNT(*) FROM ledger WHERE available > 0 OR pending > 0) AS with_balance_count,
            (SELECT COALESCE(SUM(available), 0) FROM ledger) AS available,
            (SELECT COALESCE(SUM(pending), 0) FROM ledger) AS pending,
            (SELECT COALESCE(SUM(month_change), 0) FROM ledger) AS month_change,
            (SELECT COALESCE(SUM(amount), 0) FROM expiring) AS expiring_amount,
            (SELECT COALESCE(SUM(lot_count), 0) FROM expiring) AS expiring_lot_count,
            (SELECT MIN(next_expires_at) FROM expiring) AS next_expires_at`,
  ).bind(...binds, input.search, input.search, input.friendId ?? '', input.friendId ?? '').first<Record<string, unknown>>();
  const rankPopulation = await db.prepare(
    `${ctes}
     SELECT COALESCE(l.available, 0) AS available, COUNT(*) AS friend_count
       FROM ledger l GROUP BY COALESCE(l.available, 0)`,
  ).bind(...binds).all<{ available: number; friend_count: number }>();
  const rankFor = (available: number) => [...ranks].reverse().find((rank) => available >= rank.threshold) ?? null;
  const rankCounts = ranks.map((rank) => ({
    rewardId: rank.id,
    rankName: rank.name,
    requiredMiles: rank.threshold,
    friendCount: rankPopulation.results.reduce((count, group) =>
      count + (rankFor(Number(group.available))?.id === rank.id ? Number(group.friend_count) : 0), 0),
  }));
  return {
    summary: {
      totalMembers: Number(summary?.total_members ?? 0),
      withBalanceCount: Number(summary?.with_balance_count ?? 0),
      available: Number(summary?.available ?? 0),
      pending: Number(summary?.pending ?? 0),
      monthChange: Number(summary?.month_change ?? 0),
      rankCounts,
      // 有効な期限つきロットが1つでもあれば null ではなく数値を返す。
      // 30日内は0でも先に失効があるなら 0 と次の失効日で伝え、「なし（null）」と区別する。
      expiringMiles30d: Number(summary?.expiring_lot_count ?? 0) > 0
        ? Number(summary?.expiring_amount ?? 0) : null,
      nextExpiringAt: summary?.next_expires_at == null ? null : String(summary.next_expires_at),
    },
    items: rows.results.map((row) => {
      const available = Number(row.available ?? 0);
      const rank = rankFor(available);
      const nextRank = ranks.find((candidate) => candidate.threshold > available) ?? null;
      return ({
      friendId: row.friend_id,
      displayName: row.display_name || '名前未設定',
      pictureUrl: row.picture_url ?? null,
      rank: rank?.name ?? null,
      rankReason: ranks.length === 0 ? '公開中のランクがありません' : rank ? `${rank.threshold.toLocaleString('ja-JP')}マイル以上` : '最初のランクに届いていません',
      rankThreshold: rank?.threshold ?? null,
      nextRank: nextRank?.name ?? null,
      nextRankThreshold: nextRank?.threshold ?? null,
      milesToNextRank: nextRank ? Math.max(0, nextRank.threshold - available) : null,
      monthChange: Number(row.month_change ?? 0),
      available: Number(row.available ?? 0),
      pending: Number(row.pending ?? 0),
      // summary と同じく「期限つきロットが存在するか」で null/0 を分け、
      // 30日より先にしか失効がない人も「0 + 直近の失効日」で表せるようにする。
      expiringMiles30d: Number(row.lot_count ?? 0) > 0 ? Number(row.expiring_amount ?? 0) : null,
      nextExpiringAt: row.next_expires_at == null ? null : String(row.next_expires_at),
      lifetimeEarned: Number(row.lifetime_earned ?? 0),
      spent: Number(row.spent ?? 0),
      lastChangedAt: row.last_changed_at ?? null,
      lastAction: row.last_action_json == null ? null : JSON.parse(String(row.last_action_json)) as {
        name: string; amount: number; occurredAt: string; entryType: string; status: string;
      },
      walletScope: row.user_id ? 'verified_user' : 'friend',
      lineAccount: { id: row.line_account_id, name: row.line_account_name },
    })}),
    pagination: {
      total: Number(summary?.filtered_members ?? 0), limit: input.limit, offset: input.offset,
    },
    measuredAt: new Date().toISOString(),
  };
}

export async function getMileageRewardReachMetrics(db: D1Database, lineAccountId: string) {
  const rows = await db.prepare(
    `SELECT r.id, r.name, CASE WHEN EXISTS (SELECT 1 FROM mileage_handgift_rewards h WHERE h.reward_id = r.id) THEN 'handgift' ELSE r.reward_kind END AS reward_kind, v.required_miles,
            COUNT(DISTINCT CASE WHEN w.available >= v.required_miles THEN w.beneficiary_key END) AS reachable_count,
            COUNT(DISTINCT CASE WHEN mr.status = 'succeeded' THEN mr.beneficiary_key END) AS redeemed_friend_count
       FROM mileage_rewards r
       JOIN mileage_reward_versions v ON v.id = COALESCE(r.current_published_version_id, r.current_draft_version_id)
       LEFT JOIN mileage_wallets w ON w.program_id = r.program_id AND EXISTS (
         SELECT 1 FROM friends f WHERE f.line_account_id = ? AND (
           (w.beneficiary_user_id IS NOT NULL AND f.user_id = w.beneficiary_user_id)
           OR (w.beneficiary_friend_id IS NOT NULL AND f.id = w.beneficiary_friend_id)
         )
       )
       LEFT JOIN mileage_redemptions mr ON mr.reward_id = r.id
      WHERE r.line_account_id = ?
      GROUP BY r.id, r.name, r.reward_kind, v.required_miles ORDER BY r.sort_order, r.id`,
  ).bind(lineAccountId, lineAccountId).all<{
    id: string; name: string; reward_kind: string; required_miles: number;
    reachable_count: number; redeemed_friend_count: number;
  }>();
  return rows.results.map((row) => {
    const reachable = Number(row.reachable_count ?? 0);
    const redeemed = Number(row.redeemed_friend_count ?? 0);
    return {
      rewardId: row.id,
      rewardName: row.name,
      rewardKind: row.reward_kind,
      requiredMiles: Number(row.required_miles),
      reachableFriendCount: reachable,
      redeemedFriendCount: redeemed,
      exchangeRate: reachable > 0 ? redeemed / reachable : null,
    };
  });
}

export async function getActionScoreBandOverview(db: D1Database, lineAccountId: string) {
  const bands = await getActionScoreBands(db, lineAccountId);
  const rows = await db.prepare(
    `SELECT CASE WHEN f.score >= ? THEN 'high' WHEN f.score >= ? THEN 'normal' ELSE 'low' END AS band,
            COUNT(*) AS friend_count,
            COALESCE(SUM(recent.change_30d), 0) AS change_30d
       FROM friends f
       LEFT JOIN (
         SELECT friend_id, SUM(score_change) AS change_30d FROM friend_scores
          WHERE created_at >= datetime('now', '-30 days') GROUP BY friend_id
       ) recent ON recent.friend_id = f.id
      WHERE f.line_account_id = ? GROUP BY band`,
  ).bind(bands.highMin, bands.normalMin, lineAccountId).all<{
    band: 'low' | 'normal' | 'high'; friend_count: number; change_30d: number;
  }>();
  const reasons = await db.prepare(
    `WITH reason_counts AS (
       SELECT CASE WHEN f.score >= ? THEN 'high' WHEN f.score >= ? THEN 'normal' ELSE 'low' END AS band,
              COALESCE(fs.reason, '理由未登録') AS reason, COUNT(*) AS count
         FROM friend_scores fs JOIN friends f ON f.id = fs.friend_id
        WHERE f.line_account_id = ? AND fs.created_at >= datetime('now', '-30 days')
        GROUP BY band, reason
     ), ranked AS (
       SELECT band, reason, count,
              ROW_NUMBER() OVER (PARTITION BY band ORDER BY count DESC, reason) AS position
         FROM reason_counts
     )
     SELECT band, reason, count FROM ranked WHERE position <= 3 ORDER BY band, position`,
  ).bind(bands.highMin, bands.normalMin, lineAccountId).all<{
    band: 'low' | 'normal' | 'high'; reason: string; count: number;
  }>();
  const order = ['low', 'normal', 'high'] as const;
  return {
    ...bands,
    bandSummaries: order.map((band) => {
      const row = rows.results.find((item) => item.band === band);
      return {
        band,
        friendCount: Number(row?.friend_count ?? 0),
        change30d: Number(row?.change_30d ?? 0),
        topReasons: reasons.results.filter((item) => item.band === band)
          .map((item) => ({ reason: item.reason, count: Number(item.count) })),
      };
    }),
    measuredAt: new Date().toISOString(),
  };
}

export type MileageAdjustmentNotificationStatus = 'pending' | 'sent' | 'failed';

export interface MileageAdjustmentNotification {
  id: string;
  lineAccountId: string;
  friendId: string;
  ledgerEntryId: string;
  status: MileageAdjustmentNotificationStatus;
  attemptCount: number;
  lineRequestId: string | null;
  errorCode: string | null;
  sentAt: string | null;
}

type NotificationRow = {
  id: string; line_account_id: string; friend_id: string; ledger_entry_id: string;
  status: MileageAdjustmentNotificationStatus; attempt_count: number;
  line_request_id: string | null; error_code: string | null; sent_at: string | null;
};

function mapNotification(row: NotificationRow): MileageAdjustmentNotification {
  return {
    id: row.id, lineAccountId: row.line_account_id, friendId: row.friend_id,
    ledgerEntryId: row.ledger_entry_id, status: row.status, attemptCount: Number(row.attempt_count),
    lineRequestId: row.line_request_id, errorCode: row.error_code, sentAt: row.sent_at,
  };
}

export async function reserveMileageAdjustmentNotification(
  db: D1Database,
  input: { lineAccountId: string; friendId: string; ledgerEntryId: string; idempotencyKey: string; message: string },
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT OR IGNORE INTO mileage_adjustment_notifications
       (id, line_account_id, friend_id, ledger_entry_id, idempotency_key, message_text, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    id, input.lineAccountId, input.friendId, input.ledgerEntryId, input.idempotencyKey,
    input.message, now, now,
  ).run();
  const row = await db.prepare(
    `SELECT id, line_account_id, friend_id, ledger_entry_id, status, attempt_count,
            line_request_id, error_code, sent_at
       FROM mileage_adjustment_notifications WHERE ledger_entry_id = ?`,
  ).bind(input.ledgerEntryId).first<NotificationRow>();
  if (!row) throw new MileageV6Error('notification_reserve_failed', '通知の送信記録を作れませんでした', 500);
  return mapNotification(row);
}

export async function markMileageAdjustmentNotification(
  db: D1Database,
  input: { id: string; status: 'sent' | 'failed'; lineRequestId?: string | null; errorCode?: string | null },
) {
  const now = new Date().toISOString();
  /*
   * 同じ通知へ並行して届いた遅い失敗で、確定済みの sent・受理IDを
   * 戻さない。一度 sent になった行は failed へ更新しない（受理IDと送信日時を保持）。
   * failed → sent の回復は引き続き許す。
   */
  await db.prepare(
    `UPDATE mileage_adjustment_notifications
        SET status = ?, attempt_count = attempt_count + 1, line_request_id = ?, error_code = ?,
            first_failed_at = CASE WHEN ? = 'failed' THEN COALESCE(first_failed_at, ?) ELSE first_failed_at END,
            sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, updated_at = ?
      WHERE id = ? AND (status <> 'sent' OR ? = 'sent')`,
  ).bind(
    input.status, input.lineRequestId ?? null, input.errorCode ?? null,
    input.status, now, input.status, now, now, input.id, input.status,
  ).run();
  const row = await db.prepare(
    `SELECT id, line_account_id, friend_id, ledger_entry_id, status, attempt_count,
            line_request_id, error_code, sent_at
       FROM mileage_adjustment_notifications WHERE id = ?`,
  ).bind(input.id).first<NotificationRow>();
  if (!row) throw new MileageV6Error('notification_not_found', '通知の送信記録が見つかりません', 404);
  return mapNotification(row);
}

/**
 * 通知の再送に必要な保存済みの中身（本文・送信キー・宛先）を返す。
 * 一覧表示用の mapNotification とは別に、生の記録を返す。
 */
export async function getMileageAdjustmentNotificationRecord(
  db: D1Database,
  input: { lineAccountId: string; ledgerEntryId: string },
): Promise<{
  id: string;
  lineAccountId: string;
  friendId: string;
  ledgerEntryId: string;
  idempotencyKey: string;
  messageText: string;
  status: MileageAdjustmentNotificationStatus;
} | null> {
  const row = await db.prepare(
    `SELECT id, line_account_id, friend_id, ledger_entry_id, idempotency_key, message_text, status
       FROM mileage_adjustment_notifications
      WHERE line_account_id = ? AND ledger_entry_id = ?`,
  ).bind(input.lineAccountId, input.ledgerEntryId).first<{
    id: string; line_account_id: string; friend_id: string; ledger_entry_id: string;
    idempotency_key: string; message_text: string; status: MileageAdjustmentNotificationStatus;
  }>();
  if (!row) return null;
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    friendId: row.friend_id,
    ledgerEntryId: row.ledger_entry_id,
    idempotencyKey: row.idempotency_key,
    messageText: row.message_text,
    status: row.status,
  };
}

export interface PendingMileageGrantNotification {
  id: string;
  lineAccountId: string;
  friendId: string;
  ledgerEntryId: string;
  idempotencyKey: string;
  message: string;
  attemptCount: number;
}

/**
 * m22o: まだ送っていない付与の通知だけを古い順に返す。
 * 手動調整の通知と同じ表に載るが、台帳の entry_type が grant の行だけを
 * 拾う。調整の通知は調整の口がその場で送るので、ここでは触らない。
 */
export async function listPendingMileageGrantNotifications(
  db: D1Database,
  input: { limit?: number } = {},
): Promise<PendingMileageGrantNotification[]> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 20));
  const rows = await db.prepare(
    `SELECT n.id, n.line_account_id, n.friend_id, n.ledger_entry_id,
            n.idempotency_key, n.message_text, n.attempt_count
       FROM mileage_adjustment_notifications n
       JOIN mileage_ledger ml ON ml.id = n.ledger_entry_id
      WHERE n.status = 'pending' AND ml.entry_type = 'grant'
      ORDER BY n.created_at, n.id
      LIMIT ?`,
  ).bind(limit).all<{
    id: string; line_account_id: string; friend_id: string; ledger_entry_id: string;
    idempotency_key: string; message_text: string; attempt_count: number;
  }>();
  return rows.results.map((row) => ({
    id: row.id,
    lineAccountId: row.line_account_id,
    friendId: row.friend_id,
    ledgerEntryId: row.ledger_entry_id,
    idempotencyKey: row.idempotency_key,
    message: row.message_text,
    attemptCount: Number(row.attempt_count ?? 0),
  }));
}

export interface MileageEarningRulePublishResult {
  ruleId: string;
  versionId: string;
  versionNumber: number;
  publishedAt: string;
}

/**
 * 公開。下書きを不変の公開版として固定し、実行項目へ写す。
 *
 * 1回の batch で次をまとめて行う。増えるのは公開版の行だけで、
 * 既存の台帳・残高には触らない。
 * 1. 下書きから公開版を作る(初公開だけ v0=公開前の live も残す)
 * 2. 以前の公開版を履歴扱いにする
 * 3. live の実行項目を公開版の内容へ写す(停止・再開と実行条件は変えない)
 * 4. 現在の公開版ポインタを更新する
 */
export async function publishMileageEarningRule(
  db: D1Database,
  input: {
    ruleId: string;
    lineAccountId: string;
    expectedVersion: number;
    staffId?: string | null;
    idempotencyKey: string;
  },
): Promise<MileageEarningRulePublishResult> {
  const draftRow = await db.prepare(
    `SELECT rule_id, line_account_id, version, draft_json, updated_at
       FROM mileage_earning_rule_drafts WHERE rule_id = ?`,
  ).bind(input.ruleId).first<DraftRow>();
  if (!draftRow || draftRow.line_account_id !== input.lineAccountId) {
    throw new MileageV6Error('draft_not_found', '公開する下書きが見つかりません', 404);
  }
  if (Number(draftRow.version) !== input.expectedVersion) {
    throw new MileageV6Error('version_conflict', '下書きを読み直してください', 409);
  }
  const live = await db.prepare(
    `SELECT id, name, event_type, source, amount, initial_status, conditions,
            line_account_id, is_active, valid_from, valid_until, published_version_number
       FROM mileage_rules WHERE id = ?`,
  ).bind(input.ruleId).first<{
    id: string; name: string; event_type: string; source: string | null; amount: number;
    initial_status: string; conditions: string | null; line_account_id: string | null;
    is_active: number; valid_from: string | null; valid_until: string | null;
    published_version_number: number | null;
  }>();
  if (!live || live.line_account_id !== input.lineAccountId) {
    throw new MileageV6Error('rule_not_found', '付与ルールが見つかりません', 404);
  }

  const replayed = await db.prepare(
    `SELECT id, version_number, published_at
       FROM mileage_earning_rule_published_versions
      WHERE rule_id = ? AND publish_idempotency_key = ?`,
  ).bind(input.ruleId, input.idempotencyKey)
    .first<{ id: string; version_number: number; published_at: string }>();
  if (replayed) {
    return {
      ruleId: input.ruleId,
      versionId: replayed.id,
      versionNumber: Number(replayed.version_number),
      publishedAt: replayed.published_at,
    };
  }

  const draft = JSON.parse(draftRow.draft_json) as MileageEarningRuleDraft;
  const content = publishedRuleContentFromDraft(
    {
      name: draft.name,
      eventType: draft.eventType,
      source: draft.source,
      amount: draft.amount,
      initialStatus: draft.initialStatus,
      validFrom: draft.validFrom,
      validUntil: draft.validUntil,
      /*
       * 下書きの対象条件を公開版へ載せる。載せないと公開版だけ
       * 条件が消え、対象外へ付与される。保存時に型を絞ってあるので
       * 絞り込み部品の形と一致する。
       */
      targetConditions: draft.targetConditions as SegmentCondition | null,
      /*
       * m22o: 期限・取消・通知も公開版へ載せる。載せないと画面の設定が
       * 実際の付与に効かない。公開版の設定だけを使い、下書きは見ない。
       */
      expiresAfterDays: draft.expiresAfterDays,
      cancellationEventTypes: draft.cancellationEventTypes,
      notification: draft.notification,
    },
    live.conditions,
  );
  const contentJson = JSON.stringify(content);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nextRow = await db.prepare(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
         FROM mileage_earning_rule_published_versions WHERE rule_id = ?`,
    ).bind(input.ruleId).first<{ version_number: number }>();
    const versionNumber = Number(nextRow?.version_number ?? 1);
    // 同時公開で先に初公開が入ったら v0 を重ねない。毎回読み直す。
    const pointer = await db.prepare(
      `SELECT published_version_number FROM mileage_rules WHERE id = ?`,
    ).bind(input.ruleId).first<{ published_version_number: number | null }>();
    const firstPublish = pointer?.published_version_number === null
      || pointer?.published_version_number === undefined;
    const now = jstNow();
    const versionId = crypto.randomUUID();
    try {
      const statements: D1PreparedStatement[] = [db.prepare(
        `SELECT json(CASE WHEN EXISTS (
           SELECT 1 FROM mileage_earning_rule_drafts
            WHERE rule_id = ? AND line_account_id = ? AND version = ?
              AND draft_json = ? AND updated_at = ?
         ) THEN 'null' ELSE 'stale_draft' END)`
      ).bind(input.ruleId, input.lineAccountId, draftRow.version, draftRow.draft_json, draftRow.updated_at)];
      if (firstPublish) {
        // 初公開だけ、公開前の live を v0 として残す。公開前に受け付けた行は
        // 旧版(v0)で処理する。なおさないと公開前の行が新版で付与される。
        statements.push(db.prepare(
          `INSERT INTO mileage_earning_rule_published_versions
             (id, rule_id, version_number, content_json, status,
              publish_idempotency_key, published_at, published_by_staff_id, created_at)
           VALUES (?, ?, 0, ?, 'retired', NULL, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), input.ruleId,
          JSON.stringify({
            name: live.name, event_type: live.event_type, source: live.source,
            amount: live.amount, initial_status: live.initial_status,
            conditions: live.conditions, valid_from: live.valid_from, valid_until: live.valid_until,
            // m22o: v0 は公開の仕組みができる前の live 写し。期限・取消・通知は持たない。
            expires_after_days: null, cancellation_event_types: [],
            notification: { enabled: false, messageTemplate: '' },
          }),
          now, input.staffId ?? null, now,
        ));
      }
      statements.push(db.prepare(
        `INSERT INTO mileage_earning_rule_published_versions
           (id, rule_id, version_number, content_json, status,
            publish_idempotency_key, published_at, published_by_staff_id, created_at)
         VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?)`,
      ).bind(
        versionId, input.ruleId, versionNumber, contentJson,
        input.idempotencyKey, now, input.staffId ?? null, now,
      ));
      statements.push(db.prepare(
        `UPDATE mileage_earning_rule_published_versions
            SET status = 'retired'
          WHERE rule_id = ? AND status = 'published' AND id != ?`,
      ).bind(input.ruleId, versionId));
      statements.push(db.prepare(
        `UPDATE mileage_rules
            SET name = ?, event_type = ?, source = ?, amount = ?,
                initial_status = ?, valid_from = ?, valid_until = ?,
                published_version_number = ?, updated_at = ?
          WHERE id = ? AND line_account_id = ?`,
      ).bind(
        content.name, content.event_type, content.source, content.amount,
        content.initial_status, content.valid_from, content.valid_until,
        versionNumber, now, input.ruleId, input.lineAccountId,
      ));
      await db.batch(statements);
      return { ruleId: input.ruleId, versionId, versionNumber, publishedAt: now };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/malformed JSON/i.test(message)) {
        throw new MileageV6Error('version_conflict', '下書きを読み直してください', 409);
      }
      if (/UNIQUE constraint failed/i.test(message) && message.includes('publish_idempotency_key')) {
        const raced = await db.prepare(
          `SELECT id, version_number, published_at
             FROM mileage_earning_rule_published_versions
            WHERE rule_id = ? AND publish_idempotency_key = ?`,
        ).bind(input.ruleId, input.idempotencyKey)
          .first<{ id: string; version_number: number; published_at: string }>();
        if (raced) {
          return {
            ruleId: input.ruleId,
            versionId: raced.id,
            versionNumber: Number(raced.version_number),
            publishedAt: raced.published_at,
          };
        }
        throw new MileageV6Error('publish_conflict', '同時公開が競合しました。もう一度公開してください', 409);
      }
      if (/UNIQUE constraint failed/i.test(message) && message.includes('version_number')) continue;
      throw error;
    }
  }
  throw new MileageV6Error('publish_conflict', '同時公開が競合しました。もう一度公開してください', 409);
}
