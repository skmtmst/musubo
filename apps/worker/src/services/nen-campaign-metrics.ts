import { getLineAccountById, jstNow } from '@line-crm/db';

import { getNenCampaign, nenCampaignFormIssue } from './nen-engagement.js';

import { EXTERNAL_DELIVERY_MAX_ATTEMPTS as MAX_DELIVERY_ATTEMPTS } from './external-delivery-retry.js';
const DAY_MS = 86_400_000;

export class NenCampaignMetricsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'NenCampaignMetricsError';
  }
}

export type NenMetricsRange = {
  days: number;
  from: string;
  to: string;
  fromSql: string;
  toSql: string;
};

function sqliteTimestamp(date: Date): string {
  return date.toISOString();
}

export function nenMetricsRange(daysValue: unknown, now = new Date()): NenMetricsRange {
  const days = daysValue === undefined || daysValue === null || daysValue === ''
    ? 30
    : Number(daysValue);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new NenCampaignMetricsError('days_invalid', '期間は1〜365日で指定してください', 400, 'days');
  }
  const to = new Date(now);
  const from = new Date(to.getTime() - days * DAY_MS);
  return {
    days,
    from: from.toISOString(),
    to: to.toISOString(),
    fromSql: sqliteTimestamp(from),
    toSql: sqliteTimestamp(to),
  };
}

export function nenDeliveryRange(
  input: { from?: unknown; to?: unknown; days?: unknown },
  now = new Date(),
): NenMetricsRange {
  if (input.from === undefined && input.to === undefined) return nenMetricsRange(input.days, now);
  if (typeof input.from !== 'string' || typeof input.to !== 'string') {
    throw new NenCampaignMetricsError('range_required', '開始日時と終了日時を両方指定してください', 400, 'from');
  }
  const from = new Date(input.from);
  const to = new Date(input.to);
  const duration = to.getTime() - from.getTime();
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())
    || duration <= 0 || duration > 365 * DAY_MS) {
    throw new NenCampaignMetricsError('range_invalid', '開始より後の終了日時を365日以内で指定してください', 400, 'from');
  }
  return {
    days: Math.max(1, Math.ceil(duration / DAY_MS)),
    from: from.toISOString(),
    to: to.toISOString(),
    fromSql: sqliteTimestamp(from),
    toSql: sqliteTimestamp(to),
  };
}

const unavailable = (reason: string) => ({
  value: null,
  state: 'unavailable' as const,
  reason,
});

type FlowAggregateRow = {
  campaign_key: string;
  planned: number;
  sent: number;
  failed: number;
  skipped: number;
};

type ConversionAggregateRow = { campaign_key: string; total: number; amount: number };

export async function getNenFlowMetrics(
  db: D1Database,
  lineAccountId: string,
  range: NenMetricsRange,
) {
  const keys = await db.prepare(
    `SELECT campaign_key FROM nen_campaign_settings ORDER BY rowid`,
  ).all<{ campaign_key: string }>();
  const campaigns = (await Promise.all(
    (keys.results ?? []).map((row) => getNenCampaign(db, row.campaign_key, lineAccountId)),
  )).filter((row): row is NonNullable<typeof row> => Boolean(row));
  const aggregates = await db.prepare(
    `SELECT campaign_key,
            COUNT(*) AS planned,
            SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
       FROM nen_delivery_jobs
      WHERE line_account_id = ?
        AND datetime(scheduled_at) >= datetime(?) AND datetime(scheduled_at) < datetime(?)
      GROUP BY campaign_key`,
  ).bind(lineAccountId, range.fromSql, range.toSql).all<FlowAggregateRow>();
  const conversions = await db.prepare(
    `WITH attributed AS (
       SELECT j.campaign_key, ce.id AS conversion_id,
              MAX(COALESCE(ce.value_snapshot, 0)) AS amount
         FROM nen_delivery_jobs j
         JOIN conversion_events ce ON ce.friend_id = j.friend_id
          AND datetime(ce.created_at) >= datetime(j.sent_at)
          AND datetime(ce.created_at) < datetime(j.sent_at, '+7 days')
         JOIN conversion_points cp ON cp.id = ce.conversion_point_id AND cp.line_account_id = ?
        WHERE j.line_account_id = ? AND j.status = 'sent' AND j.sent_at IS NOT NULL
          AND datetime(j.sent_at) >= datetime(?) AND datetime(j.sent_at) < datetime(?)
        GROUP BY j.campaign_key, ce.id
     )
     SELECT campaign_key, COUNT(*) AS total, COALESCE(SUM(amount), 0) AS amount
       FROM attributed GROUP BY campaign_key`,
  ).bind(lineAccountId, lineAccountId, range.fromSql, range.toSql).all<ConversionAggregateRow>();
  const byKey = new Map((aggregates.results ?? []).map((row) => [row.campaign_key, row]));
  const conversionsByKey = new Map((conversions.results ?? []).map((row) => [row.campaign_key, {
    count: Number(row.total ?? 0), amount: Number(row.amount ?? 0),
  }]));
  const flows = campaigns.map((campaign) => {
    const aggregate = byKey.get(campaign.campaign_key);
    return {
      campaignKey: campaign.campaign_key,
      label: campaign.label,
      category: campaign.category,
      isEnabled: campaign.is_enabled === 1,
      planned: Number(aggregate?.planned ?? 0),
      sent: Number(aggregate?.sent ?? 0),
      failed: Number(aggregate?.failed ?? 0),
      skipped: Number(aggregate?.skipped ?? 0),
      openRate: unavailable('LINEはNEN配信の個人開封を提供していません'),
      associatedConversions: conversionsByKey.get(campaign.campaign_key)?.count ?? 0,
      associatedConversionAmount: conversionsByKey.get(campaign.campaign_key)?.amount ?? 0,
      attribution: '送信後7日以内の関連成果であり、配信が原因とは断定しません',
    };
  });
  return {
    range: { days: range.days, from: range.from, to: range.to },
    summary: {
      active: flows.filter((flow) => flow.isEnabled).length,
      paused: flows.filter((flow) => !flow.isEnabled).length,
      planned: flows.reduce((sum, flow) => sum + flow.planned, 0),
      sent: flows.reduce((sum, flow) => sum + flow.sent, 0),
      associatedConversions: flows.reduce((sum, flow) => sum + flow.associatedConversions, 0),
      associatedConversionAmount: flows.reduce((sum, flow) => sum + flow.associatedConversionAmount, 0),
    },
    flows,
  };
}

type ColumnMetricRow = {
  id: string;
  title: string;
  category: string | null;
  delivery_status: string;
  published_at: string | null;
  delivery_at: string | null;
  article_url: string;
  targeted: number;
  sent: number;
  pending: number;
  failed: number;
  first_scheduled_at: string | null;
  last_sent_at: string | null;
  tracking_links: number;
  opened: number;
  read_opened: number;
  read_completed: number;
};

export async function getNenColumnMetrics(
  db: D1Database,
  lineAccountId: string,
  range: NenMetricsRange,
) {
  const rows = await db.prepare(
    `SELECT c.id, c.title, c.category, c.delivery_status, c.published_at, c.delivery_at,
            c.article_url,
            COUNT(DISTINCT j.id) AS targeted,
            COUNT(DISTINCT CASE WHEN j.status = 'sent' THEN j.id END) AS sent,
            COUNT(DISTINCT CASE WHEN j.status IN ('pending', 'processing') THEN j.id END) AS pending,
            COUNT(DISTINCT CASE WHEN j.status = 'failed' THEN j.id END) AS failed,
            MIN(j.scheduled_at) AS first_scheduled_at,
            MAX(j.sent_at) AS last_sent_at,
            COUNT(DISTINCT tl.id) AS tracking_links,
            COUNT(DISTINCT CASE WHEN lc.friend_id = j.friend_id THEN lc.friend_id END) AS opened,
            (SELECT COUNT(DISTINCT re.friend_id) FROM nen_column_read_events re
              WHERE re.line_account_id = c.line_account_id AND re.column_id = c.id
                AND re.event_kind = 'opened' AND datetime(re.occurred_at) >= datetime(?)
                AND datetime(re.occurred_at) < datetime(?)) AS read_opened,
            (SELECT COUNT(DISTINCT re.friend_id) FROM nen_column_read_events re
              WHERE re.line_account_id = c.line_account_id AND re.column_id = c.id
                AND re.event_kind = 'completed' AND datetime(re.occurred_at) >= datetime(?)
                AND datetime(re.occurred_at) < datetime(?)) AS read_completed
       FROM nen_columns c
       LEFT JOIN nen_delivery_jobs j ON j.line_account_id = c.line_account_id
        AND j.source_key = 'column:' || c.id
        AND datetime(j.scheduled_at) >= datetime(?) AND datetime(j.scheduled_at) < datetime(?)
       LEFT JOIN tracked_links tl ON tl.line_account_id = c.line_account_id
        AND tl.original_url = c.article_url AND tl.is_active = 1
       LEFT JOIN link_clicks lc ON lc.tracked_link_id = tl.id
        AND datetime(lc.clicked_at) >= datetime(?) AND datetime(lc.clicked_at) < datetime(?)
      WHERE c.line_account_id = ?
      GROUP BY c.id
      ORDER BY COALESCE(c.published_at, c.created_at) DESC, c.id DESC`,
  ).bind(
    range.fromSql, range.toSql, range.fromSql, range.toSql,
    range.fromSql, range.toSql, range.fromSql, range.toSql, lineAccountId,
  ).all<ColumnMetricRow>();
  const conversions = await db.prepare(
    `WITH attributed AS (
       SELECT substr(j.source_key, 8) AS column_id, ce.id AS conversion_id,
              MAX(COALESCE(ce.value_snapshot, 0)) AS amount
         FROM nen_delivery_jobs j
         JOIN conversion_events ce ON ce.friend_id = j.friend_id
          AND datetime(ce.created_at) >= datetime(j.sent_at)
          AND datetime(ce.created_at) < datetime(j.sent_at, '+7 days')
         JOIN conversion_points cp ON cp.id = ce.conversion_point_id AND cp.line_account_id = ?
        WHERE j.line_account_id = ? AND j.campaign_key = 'column' AND j.status = 'sent'
          AND j.source_key LIKE 'column:%'
          AND datetime(j.sent_at) >= datetime(?) AND datetime(j.sent_at) < datetime(?)
        GROUP BY substr(j.source_key, 8), ce.id
     )
     SELECT column_id, COUNT(*) AS total, COALESCE(SUM(amount), 0) AS amount
       FROM attributed GROUP BY column_id`,
  ).bind(lineAccountId, lineAccountId, range.fromSql, range.toSql)
    .all<{ column_id: string; total: number; amount: number }>();
  const conversionByColumn = new Map(
    (conversions.results ?? []).map((row) => [row.column_id, {
      count: Number(row.total ?? 0), amount: Number(row.amount ?? 0),
    }]),
  );
  const columns = (rows.results ?? []).map((row) => {
    const targeted = Number(row.targeted ?? 0);
    const sent = Number(row.sent ?? 0);
    const opened = Number(row.opened ?? 0);
    const trackingAvailable = Number(row.tracking_links ?? 0) > 0;
    const readOpened = Number(row.read_opened ?? 0);
    const readCompleted = Number(row.read_completed ?? 0);
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      deliveryStatus: row.delivery_status,
      publishedAt: row.published_at,
      deliveryAt: row.delivery_at,
      period: { from: row.first_scheduled_at, to: row.last_sent_at ?? row.delivery_at },
      targeted,
      sent,
      pending: Number(row.pending ?? 0),
      failed: Number(row.failed ?? 0),
      articleOpened: trackingAvailable
        ? { value: opened, rate: sent > 0 ? opened / sent : 0, state: 'available' as const, reason: null }
        : { value: null, rate: null, state: 'unavailable' as const, reason: 'この記事URLの計測台帳がありません' },
      unread: trackingAvailable ? Math.max(sent - opened, 0) : null,
      completionRate: {
        value: readCompleted,
        rate: readOpened > 0 ? readCompleted / readOpened : 0,
        state: 'available' as const,
        reason: null,
      },
      associatedConversions: conversionByColumn.get(row.id)?.count ?? 0,
      associatedConversionAmount: conversionByColumn.get(row.id)?.amount ?? 0,
      attribution: '送信後7日以内の関連成果',
    };
  });
  return {
    range: { days: range.days, from: range.from, to: range.to },
    summary: {
      total: columns.length,
      sent: columns.filter((column) => column.deliveryStatus === 'sent').length,
      drafts: columns.filter((column) => column.deliveryStatus === 'draft').length,
      scheduled: columns.filter((column) => ['scheduled', 'queued'].includes(column.deliveryStatus)).length,
      unread: columns.some((column) => column.unread !== null)
        ? columns.reduce((sum, column) => sum + (column.unread ?? 0), 0)
        : null,
      associatedConversions: columns.reduce((sum, column) => sum + column.associatedConversions, 0),
      associatedConversionAmount: columns.reduce((sum, column) => sum + column.associatedConversionAmount, 0),
    },
    columns,
  };
}

type PetMetricRow = {
  id: string;
  name: string;
  animal_type: string;
  breed: string | null;
  birthday: string | null;
  friend_id: string;
  owner_name: string;
  delivery_count: number;
  last_delivery_at: string | null;
  coupon_issued: number;
  coupon_used: number;
};

export async function getNenPetMetrics(
  db: D1Database,
  lineAccountId: string,
  range: NenMetricsRange,
) {
  const [friendCounts, petCounts, couponCounts, breeds, rows, birthdayEngagement] = await Promise.all([
    db.prepare(
      `SELECT COUNT(DISTINCT f.id) AS total,
              COUNT(DISTINCT CASE WHEN p.id IS NULL THEN f.id END) AS unregistered
         FROM friends f
         LEFT JOIN nen_pet_profiles p ON p.friend_id = f.id AND p.archived_at IS NULL
        WHERE f.line_account_id = ? AND f.is_following = 1`,
    ).bind(lineAccountId).first<{ total: number; unregistered: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN birthday IS NOT NULL AND birthday != '' THEN 1 ELSE 0 END) AS birthday_registered,
              SUM(CASE WHEN birthday IS NULL OR birthday = '' THEN 1 ELSE 0 END) AS birthday_missing,
              COUNT(DISTINCT CASE
                WHEN substr(p.birthday, -5, 2) = strftime('%m', 'now', '+9 hours') THEN p.id
              END) AS birthday_this_month
         FROM nen_pet_profiles p
         JOIN friends f ON f.id = p.friend_id
        WHERE p.archived_at IS NULL AND f.line_account_id = ?`,
    ).bind(lineAccountId).first<{
      total: number; birthday_registered: number; birthday_missing: number; birthday_this_month: number;
    }>(),
    db.prepare(
      `SELECT COUNT(DISTINCT ci.id) AS issued,
              COUNT(DISTINCT CASE WHEN ci.used_at IS NOT NULL THEN ci.id END) AS used
         FROM nen_coupon_issues ci
         JOIN friends f ON f.id = ci.friend_id AND f.line_account_id = ?`,
    ).bind(lineAccountId).first<{ issued: number; used: number }>(),
    db.prepare(
      `SELECT COALESCE(NULLIF(TRIM(p.breed), ''), '未登録') AS breed, COUNT(*) AS total
         FROM nen_pet_profiles p JOIN friends f ON f.id = p.friend_id
        WHERE p.archived_at IS NULL AND f.line_account_id = ? GROUP BY COALESCE(NULLIF(TRIM(p.breed), ''), '未登録')
        ORDER BY total DESC, breed`,
    ).bind(lineAccountId).all<{ breed: string; total: number }>(),
    db.prepare(
      `SELECT p.id, p.name, p.animal_type, p.breed, p.birthday, p.friend_id,
              f.display_name AS owner_name,
              COUNT(DISTINCT j.id) AS delivery_count,
              MAX(j.sent_at) AS last_delivery_at,
              COUNT(DISTINCT ci.id) AS coupon_issued,
              COUNT(DISTINCT CASE WHEN ci.used_at IS NOT NULL THEN ci.id END) AS coupon_used
         FROM nen_pet_profiles p
         JOIN friends f ON f.id = p.friend_id AND f.line_account_id = ?
         LEFT JOIN nen_delivery_jobs j ON j.friend_id = p.friend_id AND j.line_account_id = ?
          AND datetime(j.scheduled_at) >= datetime(?) AND datetime(j.scheduled_at) < datetime(?)
         LEFT JOIN nen_coupon_issues ci ON ci.pet_id = p.id
        GROUP BY p.id ORDER BY p.updated_at DESC, p.id DESC LIMIT 200`,
    ).bind(lineAccountId, lineAccountId, range.fromSql, range.toSql).all<PetMetricRow>(),
    db.prepare(
      `SELECT COUNT(DISTINCT j.id) AS targeted,
              COUNT(DISTINCT CASE WHEN j.status = 'sent' THEN j.id END) AS reached,
              COUNT(DISTINCT lc.friend_id) AS clicked
         FROM nen_delivery_jobs j
         LEFT JOIN tracked_links tl ON tl.line_account_id = j.line_account_id
          AND tl.original_url = json_extract(j.campaign_snapshot, '$.button_url')
         LEFT JOIN link_clicks lc ON lc.tracked_link_id = tl.id AND lc.friend_id = j.friend_id
        WHERE j.line_account_id = ? AND j.campaign_key = 'birthday_coupon'
          AND datetime(j.scheduled_at) >= datetime(?) AND datetime(j.scheduled_at) < datetime(?)`,
    ).bind(lineAccountId, range.fromSql, range.toSql).first<{ targeted: number; reached: number; clicked: number }>(),
  ]);
  const pets = (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    animalType: row.animal_type,
    breed: row.breed,
    birthday: row.birthday,
    friendId: row.friend_id,
    ownerName: row.owner_name,
    ownerDeliveryHistory: {
      count: Number(row.delivery_count ?? 0),
      lastSentAt: row.last_delivery_at,
    },
    coupons: { issued: Number(row.coupon_issued ?? 0), used: Number(row.coupon_used ?? 0) },
  }));
  const coupons = {
    issued: Number(couponCounts?.issued ?? 0),
    used: Number(couponCounts?.used ?? 0),
  };
  return {
    range: { days: range.days, from: range.from, to: range.to },
    summary: {
      pets: Number(petCounts?.total ?? 0),
      birthdayRegistered: Number(petCounts?.birthday_registered ?? 0),
      birthdayMissing: Number(petCounts?.birthday_missing ?? 0),
      birthdayThisMonth: Number(petCounts?.birthday_this_month ?? 0),
      friends: Number(friendCounts?.total ?? 0),
      friendsWithoutPet: Number(friendCounts?.unregistered ?? 0),
      birthdayOpenRate: unavailable('LINEは誕生日配信の個人開封を提供していません'),
      birthdayReachRate: Number(birthdayEngagement?.targeted ?? 0) > 0
        ? Number(birthdayEngagement?.reached ?? 0) / Number(birthdayEngagement?.targeted ?? 0) : 0,
      birthdayClickRate: Number(birthdayEngagement?.reached ?? 0) > 0
        ? Number(birthdayEngagement?.clicked ?? 0) / Number(birthdayEngagement?.reached ?? 0) : 0,
      coupons: {
        ...coupons,
        usageRate: coupons.issued > 0 ? coupons.used / coupons.issued : 0,
      },
    },
    breeds: (breeds.results ?? []).map((row) => ({ name: row.breed, count: Number(row.total ?? 0) })),
    pets,
  };
}

const DELIVERY_STATUSES = new Set(['pending', 'processing', 'sent', 'skipped', 'failed', 'cancelled']);

// 絞り込みは複数状態を受け付ける(カンマ区切り)。
// failed と skipped は単一状態の別チップで絞り、「これから」チップだけが
// pending,processing の複数状態で絞る。processing は配信処理中のごく短い
// 一時状態で、そこだけを見たい場面がないため、ほぼ常に 0 のチップを
// 増やさないよう1つのまま合算する。failed と skipped はどちらも溜まり続け、
// 運用者のやることが違う(接続設定の見直し・配信のオン戻し等)ため分ける。
export function normalizeDeliveryStatus(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new NenCampaignMetricsError('status_invalid', '配信状態が正しくありません', 400, 'status');
  }
  const statuses = [...new Set(
    value.split(',').map((part) => part.trim()).filter((part) => part !== ''),
  )];
  if (statuses.length === 0) return undefined;
  for (const status of statuses) {
    if (!DELIVERY_STATUSES.has(status)) {
      throw new NenCampaignMetricsError('status_invalid', '配信状態が正しくありません', 400, 'status');
    }
  }
  return statuses.join(',');
}

export const NEN_SKIPPED_REASONS = [
  'friend_unavailable',
  'recipient_changed',
  'line_account_unavailable',
  'line_account_mismatch',
  'campaign_snapshot_missing',
  'campaign_disabled',
  'campaign_form_already_submitted',
  'campaign_form_unavailable',
  'frequency_suppressed',
  'order_cancelled',
  'order_refunded',
] as const;

export type NenSkippedReason = (typeof NEN_SKIPPED_REASONS)[number];

// skipped のうち運用で直せるもの。line_account_unavailable は
// LINE公式アカウントの接続設定のやり直し、campaign_disabled は配信を
// オンに戻すことで解消する。残り4つは友だち側の事情かデータ不整合か
// 回答済みで運用操作では直せない。line_account_mismatch は要調査のため含めない。
// 直せる2理由だけ手動再送できる。前提の再確認は retryNenDelivery が行う。
export const NEN_SKIPPED_FIXABLE_REASONS: ReadonlySet<string> = new Set([
  'line_account_unavailable',
  'campaign_disabled',
  // つなぐ回答フォームを選び直せば再送できる。
  'campaign_form_unavailable',
]);

// 画面の出し分け用に理由コードを返す。last_error は送信失敗時に
// 上流の生文(秘密値を含むことがある)が入るため、既知の6理由のどれかに
// 一致する時だけそのまま返し、それ以外は出さない。
function safeReasonCode(status: string, error: string | null): string | null {
  if (status !== 'skipped' || error === null) return null;
  return (NEN_SKIPPED_REASONS as readonly string[]).includes(error) ? error : null;
}

function safeFailureReason(status: string, error: string | null, attempts: number): string | null {
  if (status !== 'failed' && status !== 'skipped') return null;
  const known: Record<string, string> = {
    friend_unavailable: '友だちが配信対象ではありません',
    recipient_changed: '確認したLINE宛先が変わったため送りません',
    line_account_unavailable: 'LINE公式アカウントの送信設定を確認できません',
    line_account_mismatch: '友だちと配信元のLINE公式アカウントが一致しません',
    campaign_snapshot_missing: '予約時の配信内容を確認できません',
    campaign_disabled: '配信の決めごとが停止中です',
    campaign_form_already_submitted: 'すでに回答済みのため送りません',
    campaign_form_unavailable: 'つなぐ回答フォームが使えなくなっているため送りません',
    frequency_suppressed: '近い時期に同じ配信があるため送りません',
    order_cancelled: '注文が取り消されたため送りません',
    order_refunded: '注文が返金になったため送りません',
  };
  if (error && known[error]) return known[error];
  return attempts >= MAX_DELIVERY_ATTEMPTS
    ? '最大回数まで送信に失敗しました'
    : '送信処理でエラーが起きました';
}

type DeliveryListRow = {
  id: string;
  campaign_key: string;
  label: string;
  friend_id: string;
  friend_name: string;
  account_name: string;
  scheduled_at: string;
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
  updated_at: string;
  version: number;
};

export async function listNenDeliveries(
  db: D1Database,
  input: {
    lineAccountId: string;
    range: NenMetricsRange;
    status?: string;
    /** 宛先名・配信名で絞る。画面の読み込み済み行だけでなく履歴全体を探す。 */
    q?: string;
    cursor: number;
    limit: number;
  },
) {
  const statuses = input.status
    ? [...new Set(input.status.split(',').map((part) => part.trim()).filter((part) => part !== '') )]
    : [];
  const statusSql = statuses.length > 0
    ? ` AND j.status IN (${statuses.map(() => '?').join(', ')})`
    : '';
  const statusBinds = statuses;
  const query = (input.q ?? '').trim();
  const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const qSql = query
    ? ` AND (f.display_name LIKE ? ESCAPE '\\' OR s.label LIKE ? ESCAPE '\\')`
    : '';
  const qBinds = query ? [like, like] : [];
  const baseBinds = [input.lineAccountId, input.range.fromSql, input.range.toSql, ...statusBinds];
  const summaryRows = await db.prepare(
    `SELECT j.status, COUNT(*) AS total FROM nen_delivery_jobs j
      WHERE j.line_account_id = ?
        AND datetime(j.scheduled_at) >= datetime(?) AND datetime(j.scheduled_at) < datetime(?)
      GROUP BY j.status`,
  ).bind(input.lineAccountId, input.range.fromSql, input.range.toSql)
    .all<{ status: string; total: number }>();
  // failed 側の分類は触らない(文字列一致のまま)。skipped は
  // 5つの理由コードのどれも block/unfollow 等の語を含まないため、
  // 従来はすべて other に落ちていた。skipped は対象外にして、
  // 内訳は下の理由コード集計(skippedReasons)で出す。
  const unmetRows = await db.prepare(
    `SELECT CASE
              WHEN lower(COALESCE(last_error, '')) LIKE '%block%' THEN 'blocked'
              WHEN lower(COALESCE(last_error, '')) LIKE '%unfollow%'
                OR lower(COALESCE(last_error, '')) LIKE '%unsubscribe%' THEN 'unfollowed'
              ELSE 'other'
            END AS reason, COUNT(*) AS total
       FROM nen_delivery_jobs
      WHERE line_account_id = ? AND status = 'failed'
        AND datetime(scheduled_at) >= datetime(?) AND datetime(scheduled_at) < datetime(?)
      GROUP BY reason`,
  ).bind(input.lineAccountId, input.range.fromSql, input.range.toSql)
    .all<{ reason: 'blocked' | 'unfollowed' | 'other'; total: number }>();
  // skipped の内訳は理由コードそのままで数える。文字列一致は使わない。
  // 理由は NEN_SKIPPED_REASONS と同じ集合。last_error に上流の生文
  // (秘密値を含むことがある)が入るため、既知の理由以外は unknown にまとめ、
  // 生文をキーとして出さない。
  const skippedRows = await db.prepare(
    `SELECT CASE WHEN last_error IN (
              'friend_unavailable', 'recipient_changed', 'line_account_unavailable', 'line_account_mismatch',
              'campaign_snapshot_missing', 'campaign_disabled', 'campaign_form_already_submitted',
              'frequency_suppressed', 'order_cancelled', 'order_refunded'
            ) THEN last_error ELSE 'unknown' END AS reason, COUNT(*) AS total
       FROM nen_delivery_jobs
      WHERE line_account_id = ? AND status = 'skipped'
        AND datetime(scheduled_at) >= datetime(?) AND datetime(scheduled_at) < datetime(?)
      GROUP BY reason`,
  ).bind(input.lineAccountId, input.range.fromSql, input.range.toSql)
    .all<{ reason: string; total: number }>();
  const totalRow = await db.prepare(
    `SELECT COUNT(*) AS total FROM nen_delivery_jobs j
       JOIN nen_campaign_settings s ON s.campaign_key = j.campaign_key
       JOIN friends f ON f.id = j.friend_id
      WHERE j.line_account_id = ?
        AND datetime(j.scheduled_at) >= datetime(?) AND datetime(j.scheduled_at) < datetime(?)${statusSql}${qSql}`,
  ).bind(...baseBinds, ...qBinds).first<{ total: number }>();
  const rows = await db.prepare(
    `SELECT j.id, j.campaign_key, s.label, j.friend_id, f.display_name AS friend_name,
            la.name AS account_name, j.scheduled_at, j.status, j.attempts, j.last_error,
            j.sent_at, j.updated_at, j.version
       FROM nen_delivery_jobs j
       JOIN nen_campaign_settings s ON s.campaign_key = j.campaign_key
       JOIN friends f ON f.id = j.friend_id AND f.line_account_id = ?
       JOIN line_accounts la ON la.id = j.line_account_id
      WHERE j.line_account_id = ?
        AND datetime(j.scheduled_at) >= datetime(?) AND datetime(j.scheduled_at) < datetime(?)${statusSql}${qSql}
      ORDER BY j.scheduled_at DESC, j.id DESC LIMIT ? OFFSET ?`,
  ).bind(
    input.lineAccountId, input.lineAccountId, input.range.fromSql, input.range.toSql,
    ...statusBinds, ...qBinds, input.limit, input.cursor,
  ).all<DeliveryListRow>();
  const summary = { pending: 0, processing: 0, sent: 0, skipped: 0, failed: 0, cancelled: 0 };
  for (const row of summaryRows.results ?? []) {
    if (row.status in summary) summary[row.status as keyof typeof summary] = Number(row.total ?? 0);
  }
  const total = Number(totalRow?.total ?? 0);
  return {
    range: { days: input.range.days, from: input.range.from, to: input.range.to },
    summary: {
      ...summary,
      retryRequired: await countRetryRequired(db, input.lineAccountId, input.range),
      unmetReasons: Object.fromEntries((unmetRows.results ?? []).map((row) => [row.reason, Number(row.total ?? 0)])),
      skippedReasons: Object.fromEntries(
        (skippedRows.results ?? []).map((row) => [row.reason === '' ? 'unknown' : row.reason, Number(row.total ?? 0)]),
      ),
    },
    deliveries: (rows.results ?? []).map((row) => ({
      id: row.id,
      campaignKey: row.campaign_key,
      label: row.label,
      friendId: row.friend_id,
      friendName: row.friend_name,
      lineAccountName: row.account_name,
      scheduledAt: row.scheduled_at,
      sentAt: row.sent_at,
      status: row.status,
      attempts: Number(row.attempts ?? 0),
      unmetReason: safeFailureReason(row.status, row.last_error, Number(row.attempts ?? 0)),
      // 画面が直せる理由か判断できるよう、既知の理由コードだけ返す。
      unmetReasonCode: safeReasonCode(row.status, row.last_error),
      reaction: unavailable('この配信記録に対応する個人の反応は取得できません'),
      version: Number(row.version),
      updatedAt: row.updated_at,
    })),
    pagination: {
      total,
      limit: input.limit,
      cursor: String(input.cursor),
      nextCursor: input.cursor + input.limit < total ? String(input.cursor + input.limit) : null,
    },
  };
}

async function countRetryRequired(
  db: D1Database,
  lineAccountId: string,
  range: NenMetricsRange,
): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total FROM nen_delivery_jobs
      WHERE line_account_id = ? AND status = 'failed' AND attempts >= ?
        AND datetime(scheduled_at) >= datetime(?) AND datetime(scheduled_at) < datetime(?)`,
  ).bind(lineAccountId, MAX_DELIVERY_ATTEMPTS, range.fromSql, range.toSql)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

function parseSnapshot(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function getNenDeliveryDetail(
  db: D1Database,
  id: string,
  lineAccountId: string,
) {
  const row = await db.prepare(
    `SELECT j.id, j.campaign_key, s.label, j.friend_id, f.display_name AS friend_name,
            la.name AS account_name, j.scheduled_at, j.status, j.attempts, j.last_error,
            j.sent_at, j.updated_at, j.version, j.campaign_snapshot
       FROM nen_delivery_jobs j
       JOIN nen_campaign_settings s ON s.campaign_key = j.campaign_key
       JOIN friends f ON f.id = j.friend_id AND f.line_account_id = ?
       JOIN line_accounts la ON la.id = j.line_account_id
      WHERE j.id = ? AND j.line_account_id = ?`,
  ).bind(lineAccountId, id, lineAccountId).first<DeliveryListRow & { campaign_snapshot: string | null }>();
  if (!row) throw new NenCampaignMetricsError('not_found', '配信記録が見つかりません', 404);
  const snapshot = parseSnapshot(row.campaign_snapshot);
  const text = (key: string) => typeof snapshot?.[key] === 'string' ? snapshot[key] as string : null;
  return {
    id: row.id,
    campaignKey: row.campaign_key,
    label: row.label,
    friendId: row.friend_id,
    friendName: row.friend_name,
    lineAccountName: row.account_name,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    unmetReason: safeFailureReason(row.status, row.last_error, Number(row.attempts ?? 0)),
    // 詳細画面の再送ボタン出し分け用。既知の理由コードだけ返す。
    unmetReasonCode: safeReasonCode(row.status, row.last_error),
    trigger: triggerLabel(row.campaign_key),
    content: snapshot ? {
      title: text('title'),
      bodyText: text('body_text'),
      buttonLabel: text('button_label'),
      buttonUrl: text('button_url'),
      imageUrl: text('image_url'),
      state: 'available' as const,
      reason: null,
    } : {
      title: null,
      bodyText: null,
      buttonLabel: null,
      buttonUrl: null,
      imageUrl: null,
      state: 'unavailable' as const,
      reason: '予約時の配信内容が保存されていません',
    },
    version: Number(row.version),
    updatedAt: row.updated_at,
  };
}

function triggerLabel(campaignKey: string): string {
  const labels: Record<string, string> = {
    order_confirmed: '注文が確定',
    shipping_confirmed: '発送を登録',
    arrival_check: '発送後の到着確認',
    review_request: '発送後の口コミ依頼',
    cross_sell: '発送後のご案内',
    column: 'コラムの予約',
    birthday_coupon: 'ペットの誕生日',
  };
  return labels[campaignKey] ?? '配信の決めごと';
}

// 再送できない記録へ、何を直す必要があるかを返す。failed 側の
// 従来文言は変えない。skipped の直せない4理由は理由ごとに止める。
function skippedRetryBlockedMessage(status: string, lastError: string | null): string {
  if (status === 'skipped') {
    switch (lastError) {
      case 'friend_unavailable':
        return '友だちが配信対象ではないため、この記録は再送できません';
      case 'recipient_changed':
        return '確認したLINE宛先が変わったため、この記録は再送できません';
      case 'campaign_snapshot_missing':
        return '予約時の配信内容を確認できないため、この記録は再送できません';
      case 'line_account_mismatch':
        return '友だちと配信元のアカウントが一致しないため、この記録は再送できません';
      case 'campaign_form_already_submitted':
        return 'すでに回答済みのため、この記録は再送しません';
      default:
        return 'この理由の記録は再送できません';
    }
  }
  return '最大回数まで失敗した配信だけ、手動で再送できます';
}

// 送信時と同じ見方で前提を再確認する。送信側は
// getLineAccountById の channel_access_token を使うため、同じ getter で見る。
async function hasUsableLineAccountToken(
  db: D1Database,
  lineAccountId: string | null,
): Promise<boolean> {
  if (!lineAccountId) return false;
  const account = await getLineAccountById(db, lineAccountId);
  return Boolean(account?.channel_access_token);
}

// 送信時と同じ見方で決めごとの有効を確認する。送信側は
// getNenCampaign(db, key, accountId) の is_enabled を使うため、同じ呼び方で見る。
async function isNenCampaignEnabled(
  db: D1Database,
  campaignKey: string,
  lineAccountId: string | null,
): Promise<boolean> {
  const campaign = await getNenCampaign(db, campaignKey, lineAccountId);
  return campaign?.is_enabled === 1;
}

// 「つなぐ回答フォームが使えない」で止まった記録は、編集画面で
// フォームを選び直してから再送できる。判定は job 生成時と同じ見方で確かめる。
async function isNenCampaignFormUsable(
  db: D1Database,
  campaignKey: string,
  lineAccountId: string | null,
): Promise<boolean> {
  if (!lineAccountId) return false;
  const campaign = await getNenCampaign(db, campaignKey, lineAccountId);
  if (!campaign) return false;
  return (await nenCampaignFormIssue(db, campaign, lineAccountId)) === null;
}

export async function retryNenDelivery(
  db: D1Database,
  input: {
    id: string;
    lineAccountId: string;
    expectedVersion: number;
    reason: string;
    staffId: string;
  },
) {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new NenCampaignMetricsError('version_invalid', '現在の版を指定してください', 400, 'expectedVersion');
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) {
    throw new NenCampaignMetricsError('reason_invalid', '再送理由を1〜500文字で入力してください', 400, 'reason');
  }
  const current = await db.prepare(
    `SELECT id, campaign_key, line_account_id, status, attempts, last_error, version, retry_generation
       FROM nen_delivery_jobs WHERE id = ? AND line_account_id = ?`,
  ).bind(input.id, input.lineAccountId).first<{
    id: string; campaign_key: string; line_account_id: string | null; status: string;
    attempts: number; last_error: string | null; version: number; retry_generation: number;
  }>();
  if (!current) throw new NenCampaignMetricsError('not_found', '配信記録が見つかりません', 404);
  const attempts = Number(current.attempts ?? 0);
  const skippedFixable = current.status === 'skipped'
    && current.last_error !== null && NEN_SKIPPED_FIXABLE_REASONS.has(current.last_error);
  if (!(current.status === 'failed' && attempts >= MAX_DELIVERY_ATTEMPTS) && !skippedFixable) {
    throw new NenCampaignMetricsError(
      'retry_unavailable',
      skippedRetryBlockedMessage(current.status, current.last_error),
      409,
    );
  }
  // skipped の再送は運用で直した前提が今も直っているか確かめ直す。
  // 判定は送信時と同じ getter・同じ見方で行う(getter本体は触らない)。
  if (skippedFixable) {
    const recovered = current.last_error === 'line_account_unavailable'
      ? await hasUsableLineAccountToken(db, current.line_account_id)
      : current.last_error === 'campaign_form_unavailable'
        ? await isNenCampaignFormUsable(db, current.campaign_key, current.line_account_id)
        : await isNenCampaignEnabled(db, current.campaign_key, current.line_account_id);
    if (!recovered) {
      throw new NenCampaignMetricsError(
        'retry_precondition_unmet',
        current.last_error === 'line_account_unavailable'
          ? 'LINE公式アカウントの送信設定を直してから再送してください'
          : current.last_error === 'campaign_form_unavailable'
            ? 'つなぐ回答フォームを選び直してから再送してください'
            : '配信の決めごとをオンに戻してから再送してください',
        409,
      );
    }
  }
  const now = jstNow();
  // skipped は attempts を問わず、直せる2理由のままの行だけ戻す。
  // 確認後に状態・理由・版のどれかが変わった行は1件も更新されず409になる。
  const result = await db.prepare(
    `UPDATE nen_delivery_jobs
        SET status = 'pending', attempts = 0, next_attempt_at = NULL, claim_token = NULL, scheduled_at = ?, last_error = NULL,
            retry_generation = retry_generation + 1, version = version + 1,
            last_retry_reason = ?, last_retry_requested_by = ?, last_retry_requested_at = ?,
            updated_at = ?
      WHERE id = ? AND line_account_id = ?
        AND ((status = 'failed' AND attempts >= ?)
          OR (status = 'skipped' AND last_error IN (?, ?, ?)))
        AND version = ?`,
  ).bind(
    now, reason, input.staffId, now, now, input.id, input.lineAccountId,
    MAX_DELIVERY_ATTEMPTS, 'line_account_unavailable', 'campaign_disabled',
    'campaign_form_unavailable', input.expectedVersion,
  ).run();
  if (Number(result.meta.changes ?? 0) === 0) {
    throw new NenCampaignMetricsError(
      'version_conflict',
      'ほかの担当者が先に再送しました。読み直してください',
      409,
    );
  }
  return {
    id: input.id,
    status: 'pending' as const,
    attempts: 0,
    retryGeneration: Number(current.retry_generation ?? 0) + 1,
    version: input.expectedVersion + 1,
    scheduledAt: now,
  };
}
