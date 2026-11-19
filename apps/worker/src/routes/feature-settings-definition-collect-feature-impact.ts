import type { Context } from 'hono';
import { getAccountSetting } from '@line-crm/db';
import { type FeatureId } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { type FeatureImpactCoverageEntry, BROADCAST_ACCOUNT_SCOPE, FORM_ACCOUNT_SCOPE, type ToggleableFeature, type FeatureImpactItemWithIds, IMPACT_IDS_LIMIT, isToggleable, type OffConfirmation, OFF_CONFIRM_KEY, type FeatureImpact } from './feature-settings-definition-is-toggleable.js';

export const FEATURE_IMPACT_COVERAGE: Readonly<Record<FeatureId, FeatureImpactCoverageEntry>> = {
  broadcasts: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '予約済みの配信',
        fromWhere: `FROM broadcasts b WHERE b.status = 'scheduled' AND ${BROADCAST_ACCOUNT_SCOPE}`,
        idColumn: 'b.id',
        params: 2,
      },
      {
        kind: 'published',
        targetType: '送信中の配信',
        fromWhere: `FROM broadcasts b WHERE b.status = 'sending' AND ${BROADCAST_ACCOUNT_SCOPE}`,
        idColumn: 'b.id',
        params: 2,
      },
    ],
  },
  scenarios: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '公開中のシナリオ',
        fromWhere: `FROM scenarios WHERE is_active = 1 AND line_account_id = ?`,
        idColumn: 'scenarios.id',
        params: 1,
      },
      {
        kind: 'dependent',
        targetType: '回答後にシナリオへつなぐフォーム',
        fromWhere: `FROM forms f WHERE f.on_submit_scenario_id IS NOT NULL AND f.is_active = 1 AND ${FORM_ACCOUNT_SCOPE}`,
        idColumn: 'f.id',
        params: 1,
      },
      {
        kind: 'dependent',
        targetType: 'シナリオを使う紹介オファー',
        fromWhere: `FROM affiliate_offers WHERE scenario_id IS NOT NULL AND is_active = 1 AND line_account_id = ?`,
        idColumn: 'affiliate_offers.id',
        params: 1,
      },
    ],
  },
  templates: {
    scope: 'counted',
    sources: [
      {
        kind: 'dependent',
        targetType: 'テンプレートを使う自動応答',
        fromWhere: `FROM auto_replies WHERE template_id IS NOT NULL AND is_active = 1 AND deleted_at IS NULL AND (line_account_id IS NULL OR line_account_id = ?)`,
        idColumn: 'auto_replies.id',
        params: 1,
      },
    ],
  },
  reminders: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '有効なリマインド設定',
        fromWhere: `FROM reminders WHERE is_active = 1 AND deleted_at IS NULL AND line_account_id = ?`,
        idColumn: 'reminders.id',
        params: 1,
      },
      {
        kind: 'scheduled',
        targetType: '送信待ちのリマインド',
        fromWhere: `FROM friend_reminders fr
         JOIN reminders r ON r.id = fr.reminder_id AND r.is_active = 1 AND r.deleted_at IS NULL AND r.line_account_id = ?
         WHERE fr.status = 'active'`,
        idColumn: 'fr.id',
        params: 1,
      },
    ],
  },
  auto_replies: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '有効な自動応答',
        fromWhere: `FROM auto_replies WHERE is_active = 1 AND deleted_at IS NULL AND (line_account_id IS NULL OR line_account_id = ?)`,
        idColumn: 'auto_replies.id',
        params: 1,
      },
    ],
  },
  rich_menus: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '利用中のリッチメニュー',
        fromWhere: `FROM rich_menu_assignments WHERE line_account_id = ?`,
        idColumn: 'rich_menu_assignments.id',
        params: 1,
      },
    ],
  },
  inflow_tracking: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '公開中の計測リンク',
        fromWhere: `FROM tracked_links WHERE is_active = 1 AND line_account_id = ?`,
        idColumn: 'tracked_links.id',
        params: 1,
      },
      {
        kind: 'published',
        targetType: '公開中の流入経路',
        fromWhere: `FROM entry_routes WHERE is_active = 1 AND line_account_id = ?`,
        idColumn: 'entry_routes.id',
        params: 1,
      },
    ],
  },
  forms: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '公開中の回答フォーム',
        fromWhere: `FROM forms f WHERE f.is_active = 1 AND ${FORM_ACCOUNT_SCOPE}`,
        idColumn: 'f.id',
        params: 1,
      },
    ],
  },
  photo_review: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '審査待ちの写真',
        fromWhere: `FROM nen_photo_submissions WHERE status = 'pending' AND line_account_id = ?`,
        idColumn: 'nen_photo_submissions.id',
        params: 1,
      },
    ],
  },
  automations: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '実行待ち・実行中の自動処理',
        fromWhere: `FROM automation_runs
         WHERE status IN ('queued', 'running', 'waiting') AND is_test = 0 AND line_account_id = ?`,
        idColumn: 'automation_runs.id',
        params: 1,
      },
    ],
  },
  external_integrations: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '有効な受信Webhook',
        fromWhere: `FROM incoming_webhooks WHERE is_active = 1 AND line_account_id = ? AND deleted_at IS NULL`,
        idColumn: 'incoming_webhooks.id',
        params: 1,
      },
    ],
  },
  friend_add_routing: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '公開中の振り分けルール',
        fromWhere: `FROM friend_add_rules WHERE status = 'published' AND line_account_id = ?`,
        idColumn: 'friend_add_rules.id',
        params: 1,
      },
    ],
  },
  multi_store_hierarchy: {
    scope: 'none',
    reason: '店舗束の構成設定で、待ち行を持たない',
  },
  friend_fields: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '実行中の属性移行',
        fromWhere: `FROM field_migration_runs WHERE status IN ('queued', 'running') AND line_account_id = ?`,
        idColumn: 'field_migration_runs.id',
        params: 1,
      },
    ],
  },
  support_marks: {
    scope: 'none',
    reason: '付け替え申請は状態を持たない記録で、待ち行でない',
  },
  saved_searches: {
    scope: 'none',
    reason: '保存条件と利用履歴で、待ち行を持たない',
  },
  media: {
    scope: 'counted',
    sources: [
      {
        kind: 'dependent',
        targetType: '素材への利用参照',
        fromWhere: `FROM media m WHERE m.line_account_id = ? AND (EXISTS (SELECT 1 FROM media_usages u WHERE u.media_id = m.id) OR m.id IN (SELECT image_media_id FROM rt_menu_items WHERE image_media_id IS NOT NULL))`,
        idColumn: 'm.id',
        params: 1,
      },
    ],
  },
  common_vars: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '反映待ちの共通変数変更',
        fromWhere: `FROM common_var_schedules s
         JOIN common_vars v ON v.id = s.var_id AND v.archived_at IS NULL AND v.line_account_id = ?
         WHERE s.applied_at IS NULL`,
        idColumn: 's.id',
        params: 1,
      },
    ],
  },
  analytics: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '有効なレポート予約',
        fromWhere: `FROM analytics_report_schedules WHERE status = 'active' AND line_account_id = ?`,
        idColumn: 'analytics_report_schedules.id',
        params: 1,
      },
    ],
  },
  site_tracking: {
    scope: 'none',
    reason: '計測ログは履歴で、待ち行を持たない',
  },
  webinars: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '公開中のウェビナー',
        fromWhere: `FROM webinars WHERE status = 'active' AND account_id = ?`,
        idColumn: 'webinars.id',
        params: 1,
      },
      {
        kind: 'scheduled',
        targetType: '送信待ちのウェビナー通知',
        fromWhere: `FROM webinar_notification_jobs j
         JOIN webinars w ON w.id = j.webinar_id AND w.account_id = ?
         WHERE j.status IN ('queued', 'claimed', 'retry_wait')`,
        idColumn: 'j.id',
        params: 1,
      },
    ],
  },
  events: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '公開中のイベント',
        fromWhere: `FROM events WHERE is_published = 1 AND deleted_at IS NULL AND line_account_id = ?`,
        idColumn: 'events.id',
        params: 1,
      },
      {
        kind: 'scheduled',
        targetType: '受付中のイベント予約',
        fromWhere: `FROM event_bookings WHERE status IN ('requested', 'confirmed') AND line_account_id = ?`,
        idColumn: 'event_bookings.id',
        params: 1,
      },
      {
        kind: 'scheduled',
        targetType: '送信待ちのイベントリマインド',
        fromWhere: `FROM event_booking_reminders ebr
         JOIN event_bookings eb ON eb.id = ebr.booking_id AND eb.line_account_id = ?
         WHERE ebr.status = 'pending'`,
        idColumn: 'ebr.id',
        params: 1,
      },
    ],
  },
  booking: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '受付中の予約',
        fromWhere: `FROM bookings WHERE status IN ('requested', 'confirmed') AND line_account_id = ?`,
        idColumn: 'bookings.id',
        params: 1,
      },
      {
        kind: 'scheduled',
        targetType: '送信待ちの予約リマインド',
        fromWhere: `FROM booking_reminders br
         JOIN bookings b ON b.id = br.booking_id AND b.line_account_id = ?
         WHERE br.status = 'pending'`,
        idColumn: 'br.id',
        params: 1,
      },
    ],
  },
  affiliates: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '受付中の紹介オファー',
        fromWhere: `FROM affiliate_offers WHERE is_active = 1 AND line_account_id = ?`,
        idColumn: 'affiliate_offers.id',
        params: 1,
      },
      {
        kind: 'scheduled',
        targetType: '精算待ちの支払い',
        fromWhere: `FROM affiliate_payout_batches
         WHERE state IN ('created', 'approved') AND line_account_id = ?`,
        idColumn: 'affiliate_payout_batches.id',
        params: 1,
      },
    ],
  },
  mileage: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '処理中のマイル交換',
        fromWhere: `FROM mileage_redemptions
         WHERE status IN ('reserved', 'delivering') AND anonymized_at IS NULL AND line_account_id = ?`,
        idColumn: 'mileage_redemptions.id',
        params: 1,
      },
      {
        kind: 'dependent',
        targetType: 'マイル特典を使う紹介オファー',
        fromWhere: `FROM affiliate_offers
         WHERE mileage_program_id IS NOT NULL AND is_active = 1 AND line_account_id = ?`,
        idColumn: 'affiliate_offers.id',
        params: 1,
      },
    ],
  },
  ec_commerce: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '処理中のEC注文',
        fromWhere: `FROM ec_orders
         WHERE normalized_status = 'current' AND line_account_id = ?`,
        idColumn: 'ec_orders.id',
        params: 1,
      },
    ],
  },
  line_notifications: {
    scope: 'counted',
    sources: [
      {
        kind: 'published',
        targetType: '有効な通知ルール',
        fromWhere: `FROM notification_rules WHERE is_active = 1 AND line_account_id = ?`,
        idColumn: 'notification_rules.id',
        params: 1,
      },
      {
        kind: 'scheduled',
        targetType: '送信待ちの通知',
        fromWhere: `FROM notification_deliveries
         WHERE status IN ('pending', 'provider_accepted', 'retry_wait')
         AND execution_mode != 'test' AND line_account_id = ?`,
        idColumn: 'notification_deliveries.id',
        params: 1,
      },
    ],
  },
  nen_campaigns: {
    scope: 'counted',
    sources: [
      {
        kind: 'scheduled',
        targetType: '送信待ちのNEN配信',
        fromWhere: `FROM nen_delivery_jobs
         WHERE status IN ('pending', 'processing') AND line_account_id = ?`,
        idColumn: 'nen_delivery_jobs.id',
        params: 1,
      },
    ],
  },
  visit_stamps: {
    scope:'counted',sources:[
      {kind:'published',targetType:'有効な来店スタンプカード',fromWhere:'FROM visit_stamp_cards c JOIN visit_stamp_card_accounts ca ON ca.card_id=c.id WHERE c.active=1 AND ca.line_account_id=?',idColumn:'c.id',params:1},
      {kind:'scheduled',targetType:'確認待ちの紙カード申請',fromWhere:"FROM visit_stamp_paper_requests p WHERE p.status='pending' AND p.line_account_id=?",idColumn:'p.id',params:1},
    ],
  },
  restaurant_test: {
    scope: 'none',
    reason: '検証用のため、本番の稼働対象としない',
  },
};

export async function collectFeatureImpact(
  db: D1Database,
  accountId: string,
  feature: ToggleableFeature,
): Promise<FeatureImpactItemWithIds[]> {
  const entry = FEATURE_IMPACT_COVERAGE[feature];
  if (!entry) {
    throw new Error(`影響の数え先が未定義です: ${String(feature)}`);
  }
  if (entry.scope === 'none') return [];
  const items: FeatureImpactItemWithIds[] = [];
  for (const source of entry.sources) {
    const params = source.params === 2 ? [accountId, accountId] : [accountId];
    /*
     * 対象IDは上限なしの1回の読取で全件そろえ、件数もその全IDから数える。
     *
     * COUNT(*) とID読取を別々に投げると、間に1件増えただけで
     * 「件数はN、照合はN+1件分」という食い違いが起きる。結合を含む
     * 数え先ではCOUNT(*)が重複を数えることもある。数える対象と
     * 照合する対象は必ず同じ全IDにする。
     */
    const rows = await db
      .prepare(
        `SELECT ${source.idColumn} AS id ${source.fromWhere} ORDER BY ${source.idColumn}`,
      )
      .bind(...params)
      .all<{ id: string }>();
    const fingerprintIds = [...new Set(rows.results.map((row) => String(row.id)))].sort();
    if (fingerprintIds.length === 0) continue;
    items.push({
      kind: source.kind,
      targetType: source.targetType,
      count: fingerprintIds.length,
      ids: fingerprintIds.slice(0, IMPACT_IDS_LIMIT),
      truncated: fingerprintIds.length > IMPACT_IDS_LIMIT,
      fingerprintIds,
    });
  }
  return items;
}

export /** 保存案の実効値。無効環境の飲食店テストは保存時と同じく無効に倒す。 */
function effectiveFeatures(
  current: Record<string, boolean>,
  incoming: Record<string, unknown> | undefined,
  restaurantEnabled: boolean,
): Record<string, boolean> {
  const next = { ...current };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    next[key] = key === 'restaurant_test' && !restaurantEnabled ? false : (value as boolean);
  }
  return next;
}

export /** 有効→無効に変わる機能だけが影響確認の対象。 */
function offTransitions(
  current: Record<string, boolean>,
  next: Record<string, boolean>,
): ToggleableFeature[] {
  return (Object.keys(next) as ToggleableFeature[]).filter(
    (key) => isToggleable(key) && current[key] === true && next[key] === false,
  );
}

export async function impactFingerprint(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function readOffConfirmation(db: D1Database, accountId: string): Promise<OffConfirmation | null> {
  const raw = await getAccountSetting(db, accountId, OFF_CONFIRM_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OffConfirmation>;
    if (typeof parsed.token !== 'string' || typeof parsed.impactHash !== 'string'
      || typeof parsed.version !== 'number' || typeof parsed.expiresAt !== 'number') {
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      await db.prepare('DELETE FROM account_settings WHERE line_account_id = ? AND key = ?')
        .bind(accountId, OFF_CONFIRM_KEY).run();
      return null;
    }
    return parsed as OffConfirmation;
  } catch {
    return null;
  }
}

export async function deleteOffConfirmation(db: D1Database, accountId: string): Promise<void> {
  await db.prepare('DELETE FROM account_settings WHERE line_account_id = ? AND key = ?')
    .bind(accountId, OFF_CONFIRM_KEY).run();
}

export type FeatureImpactItemPublic = Omit<FeatureImpactItemWithIds, 'fingerprintIds'>;

export type PublicImpact = {
  feature: ToggleableFeature;
  blocking: boolean;
  items: FeatureImpactItemPublic[];
};

export /**
 * 応答用の影響表示。fingerprintIds は照合専用のため落とす。
 * 全IDを応答に載せると件数が多いときに巨大になる。
 */
function toPublicImpacts(impacts: FeatureImpact[]): PublicImpact[] {
  return impacts.map((impact) => ({
    feature: impact.feature,
    blocking: impact.blocking,
    items: impact.items.map((item) => ({
      kind: item.kind,
      targetType: item.targetType,
      count: item.count,
      ids: item.ids,
      truncated: item.truncated,
    })),
  }));
}

export /** 変更案の影響を数える。保存はしない。 */
async function buildImpacts(
  db: D1Database,
  accountId: string,
  offs: ToggleableFeature[],
): Promise<FeatureImpact[]> {
  const impacts: FeatureImpact[] = [];
  for (const feature of offs) {
    const items = await collectFeatureImpact(db, accountId, feature);
    impacts.push({ feature, items, blocking: items.length > 0 });
  }
  return impacts;
}

export /**
 * アカウントを決める。
 *
 * 機能のオン／オフはアカウントごとに持つ。店舗ごとに使う機能が違うため。
 * 指定が無ければ 400 を返す。既定のアカウントへ黙って書くと、
 * 別の店の設定を変えてしまう。
 */
function getAccountId(c: Context<Env>): string | null {
  return c.req.query('account_id') || null;
}

export function cleanStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const values = raw.filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (values.length !== raw.length || new Set(values).size !== values.length) return null;
  return values;
}

export function cleanItemOrder(raw: unknown): Record<string, string[]> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cleaned: Record<string, string[]> = {};
  for (const [sectionId, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!sectionId) return null;
    const values = cleanStringArray(ids);
    if (!values) return null;
    cleaned[sectionId] = values;
  }
  return cleaned;
}
