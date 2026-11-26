import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { bumpAuthThrottle } from './auth-email.js';
import { sqlIdSet } from './id-queries.js';
import { jstNow, nextVersionToken } from './utils.js';

/**
 * 運営からのお知らせ配信 ★37-7 と契約者専用LINE（migration 429）。
 */

export const ANNOUNCEMENT_AUDIENCES = ['all', 'plan', 'tenants'] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];
export const ANNOUNCEMENT_CHANNELS = ['line', 'screen', 'email'] as const;
export type AnnouncementChannel = (typeof ANNOUNCEMENT_CHANNELS)[number];
export const ANNOUNCEMENT_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed'] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];
export const ANNOUNCEMENT_PLANS = ['light', 'standard', 'pro', 'trial'] as const;
export type AnnouncementPlan = (typeof ANNOUNCEMENT_PLANS)[number];

export const ANNOUNCEMENT_STATUS_LABELS: Record<AnnouncementStatus, string> = {
  draft: '下書き', scheduled: '予約済み', sending: '配信中', sent: '配信済み', failed: '失敗',
};
export const ANNOUNCEMENT_CHANNEL_LABELS: Record<AnnouncementChannel, string> = {
  line: '契約者専用LINE', screen: '画面のお知らせ', email: 'メール',
};

export interface PlatformAnnouncement {
  id: string;
  subject: string;
  body: string;
  audience_kind: AnnouncementAudience;
  audience_plans: string;
  audience_tenant_ids: string;
  channels: string;
  status: AnnouncementStatus;
  publish_at: string | null;
  sent_at: string | null;
  recipients_total: number;
  line_sent: number;
  line_failed: number;
  mail_sent: number;
  mail_failed: number;
  last_error: string | null;
  created_by_staff_id: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementRecipient {
  id: string;
  announcement_id: string;
  tenant_id: string;
  staff_id: string;
  channels: string;
  line_sent_at: string | null;
  line_error: string | null;
  mail_sent_at: string | null;
  mail_error: string | null;
  screen_read_at: string | null;
  created_at: string;
}

export function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

export async function getPlatformSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setPlatformSetting(db: D1Database, key: string, value: string | null, updatedBy: string): Promise<void> {
  if (value === null) {
    await db.prepare('DELETE FROM platform_settings WHERE key = ?').bind(key).run();
    return;
  }
  await db
    .prepare(`INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(key, value, updatedBy, jstNow())
    .run();
}

export const NOTICE_LINE_ACCOUNT_KEY = 'notice_line_account_id';

// ---------------------------------------------------------------------------
// お知らせ
// ---------------------------------------------------------------------------

export async function listPlatformAnnouncements(db: D1Database, limit = 100): Promise<PlatformAnnouncement[]> {
  const { results } = await db
    .prepare(`SELECT * FROM platform_announcements
              ORDER BY CASE status WHEN 'draft' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'sending' THEN 2 ELSE 3 END,
                       COALESCE(sent_at, publish_at, created_at) DESC
              LIMIT ?`)
    .bind(Math.min(Math.max(limit, 1), 500))
    .all<PlatformAnnouncement>();
  return results ?? [];
}

export async function getPlatformAnnouncement(db: D1Database, id: string): Promise<PlatformAnnouncement | null> {
  return db.prepare('SELECT * FROM platform_announcements WHERE id = ?').bind(id).first<PlatformAnnouncement>();
}

export interface AnnouncementInput {
  subject: string;
  body: string;
  audienceKind: AnnouncementAudience;
  audiencePlans: string[];
  audienceTenantIds: string[];
  channels: AnnouncementChannel[];
  publishAt: string | null;
}

export async function createPlatformAnnouncement(
  db: D1Database,
  input: AnnouncementInput & {
    status: 'draft' | 'scheduled'; createdByStaffId: string; createdByName: string;
    /*
     * M512: 二重押し止めの再実行キーをそのまま行IDにする（broadcasts と同じ
     * 決めごと）。省略時は従来どおり採番する。migration なしで冪等にする。
     */
    id?: string;
  },
): Promise<PlatformAnnouncement> {
  const id = input.id ?? crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(`INSERT INTO platform_announcements
                (id, subject, body, audience_kind, audience_plans, audience_tenant_ids, channels, status, publish_at,
                 created_by_staff_id, created_by_name, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.subject, input.body, input.audienceKind, JSON.stringify(input.audiencePlans), JSON.stringify(input.audienceTenantIds),
      JSON.stringify(input.channels), input.status, input.publishAt, input.createdByStaffId, input.createdByName, now, now)
    .run();
  return (await getPlatformAnnouncement(db, id))!;
}

export async function updatePlatformAnnouncement(
  db: D1Database,
  id: string,
  input: AnnouncementInput & { status: 'draft' | 'scheduled' },
  /*
   * M513: 古い画面からの保存を止める版。渡されたときだけ updated_at の一致
   * も条件に入れる。当たらなければ null を返し、呼び出し側が読み直して
   * 404・配信済み・競合を区別する。省略時は従来どおり。
   */
  expectedUpdatedAt?: string | null,
): Promise<PlatformAnnouncement | null> {
  const result = await db
    .prepare(`UPDATE platform_announcements
                 SET subject = ?, body = ?, audience_kind = ?, audience_plans = ?, audience_tenant_ids = ?, channels = ?,
                     status = ?, publish_at = ?, updated_at = ?
               WHERE id = ? AND status IN ('draft', 'scheduled')
                 AND (? IS NULL OR updated_at = ?)`)
    .bind(input.subject, input.body, input.audienceKind, JSON.stringify(input.audiencePlans), JSON.stringify(input.audienceTenantIds),
      JSON.stringify(input.channels), input.status, input.publishAt, nextVersionToken(expectedUpdatedAt), id,
      expectedUpdatedAt ?? null, expectedUpdatedAt ?? null)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return null;
  return getPlatformAnnouncement(db, id);
}

export async function deletePlatformAnnouncement(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM platform_announcements WHERE id = ? AND status IN ('draft', 'scheduled')`)
    .bind(id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** cron が拾う。sending に切り替えられた 1 件だけを返す（二重送信を防ぐ）。 */
export async function claimDueAnnouncement(db: D1Database, now: string): Promise<PlatformAnnouncement | null> {
  const due = await db
    .prepare(`SELECT id FROM platform_announcements WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= ?
              ORDER BY publish_at ASC LIMIT 1`)
    .bind(now)
    .first<{ id: string }>();
  if (!due) return null;
  const claimed = await db
    .prepare(`UPDATE platform_announcements SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'scheduled'`)
    .bind(jstNow(), due.id)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) return null;
  return getPlatformAnnouncement(db, due.id);
}

export async function markAnnouncementSending(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE platform_announcements SET status = 'sending', updated_at = ? WHERE id = ? AND status IN ('draft', 'scheduled')`)
    .bind(jstNow(), id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function finishAnnouncement(
  db: D1Database,
  id: string,
  stats: { recipientsTotal: number; lineSent: number; lineFailed: number; mailSent: number; mailFailed: number; lastError: string | null; failed: boolean },
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(`UPDATE platform_announcements
                 SET status = ?, sent_at = ?, recipients_total = ?, line_sent = ?, line_failed = ?, mail_sent = ?, mail_failed = ?,
                     last_error = ?, updated_at = ?
               WHERE id = ?`)
    .bind(stats.failed ? 'failed' : 'sent', now, stats.recipientsTotal, stats.lineSent, stats.lineFailed, stats.mailSent, stats.mailFailed,
      stats.lastError, now, id)
    .run();
}

// ---------------------------------------------------------------------------
// 宛先
// ---------------------------------------------------------------------------

export interface AudienceStaffRow {
  staff_id: string;
  staff_name: string;
  staff_email: string | null;
  tenant_id: string;
  tenant_name: string;
  plan_key: string | null;
  plan_status: string;
  notice_friend_id: string | null;
  line_user_id: string | null;
}

/** 宛先になる権限者（有効・運営会社と保管済みの契約先を除く）。LINE の userId は契約者専用LINEの友だちから引く。 */
export async function resolveAnnouncementAudience(
  db: D1Database,
  input: { excludeTenantId: string; audienceKind: AnnouncementAudience; plans: string[]; tenantIds: string[] },
): Promise<AudienceStaffRow[]> {
  const where: string[] = ['sm.is_active = 1', 't.id <> ?', "t.status <> 'archived'"];
  const binds: unknown[] = [input.excludeTenantId];
  if (input.audienceKind === 'plan') {
    const plans = input.plans.filter((p) => (ANNOUNCEMENT_PLANS as readonly string[]).includes(p));
    if (plans.length === 0) return [];
    const parts: string[] = [];
    if (plans.includes('trial')) parts.push("t.plan_status = 'trialing'");
    const paid = plans.filter((p) => p !== 'trial');
    if (paid.length > 0) {
      parts.push(`(t.plan_status IN ('active', 'past_due') AND t.plan_key IN (${paid.map(() => '?').join(',')}))`);
      binds.push(...paid);
    }
    where.push(`(${parts.join(' OR ')})`);
  } else if (input.audienceKind === 'tenants') {
    if (input.tenantIds.length === 0) return [];
    where.push(`t.id IN (${sqlIdSet(input.tenantIds).sql})`);
    binds.push(...(input.tenantIds.length ? sqlIdSet(input.tenantIds).binds : []));
  }
  const { results } = await db
    .prepare(`SELECT sm.id AS staff_id, sm.name AS staff_name, sm.email AS staff_email, t.id AS tenant_id, t.name AS tenant_name,
                     t.plan_key, t.plan_status, sm.notice_friend_id, f.line_platform_user_id AS line_user_id
                FROM staff_members sm
                JOIN tenants t ON t.id = sm.tenant_id
                LEFT JOIN friends f ON f.id = sm.notice_friend_id AND f.is_following = 1
               WHERE ${where.join(' AND ')}
               ORDER BY t.name, sm.name`)
    .bind(...binds)
    .all<AudienceStaffRow>();
  return results ?? [];
}

export async function insertAnnouncementRecipients(
  db: D1Database,
  announcementId: string,
  rows: Array<{ tenantId: string; staffId: string; channels: AnnouncementChannel[] }>,
): Promise<void> {
  if (rows.length === 0) return;
  const now = jstNow();
  const stmts = rows.map((r) =>
    db.prepare(`INSERT OR IGNORE INTO platform_announcement_recipients (id, announcement_id, tenant_id, staff_id, channels, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), announcementId, r.tenantId, r.staffId, JSON.stringify(r.channels), now));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

export async function markRecipientDelivery(
  db: D1Database,
  announcementId: string,
  staffId: string,
  patch: { lineSentAt?: string; lineError?: string; mailSentAt?: string; mailError?: string },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.lineSentAt !== undefined) { sets.push('line_sent_at = ?'); binds.push(patch.lineSentAt); }
  if (patch.lineError !== undefined) { sets.push('line_error = ?'); binds.push(patch.lineError); }
  if (patch.mailSentAt !== undefined) { sets.push('mail_sent_at = ?'); binds.push(patch.mailSentAt); }
  if (patch.mailError !== undefined) { sets.push('mail_error = ?'); binds.push(patch.mailError); }
  if (sets.length === 0) return;
  binds.push(announcementId, staffId);
  await db.prepare(`UPDATE platform_announcement_recipients SET ${sets.join(', ')} WHERE announcement_id = ? AND staff_id = ?`).bind(...binds).run();
}

/** 統括の管理画面に出す未読のお知らせ（screen を含み、まだ読んでいないもの）。 */
export async function listUnreadScreenNotices(
  db: D1Database,
  staffId: string,
): Promise<Array<{ id: string; subject: string; body: string; sentAt: string | null }>> {
  const { results } = await db
    .prepare(`SELECT a.id, a.subject, a.body, a.sent_at
                FROM platform_announcement_recipients r
                JOIN platform_announcements a ON a.id = r.announcement_id
               WHERE r.staff_id = ? AND r.screen_read_at IS NULL AND a.status = 'sent'
                 AND r.channels LIKE '%"screen"%'
               ORDER BY a.sent_at DESC LIMIT 20`)
    .bind(staffId)
    .all<{ id: string; subject: string; body: string; sent_at: string | null }>();
  return (results ?? []).map((r) => ({ id: r.id, subject: r.subject, body: r.body, sentAt: r.sent_at }));
}

export async function markScreenNoticeRead(db: D1Database, announcementId: string, staffId: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE platform_announcement_recipients SET screen_read_at = ? WHERE announcement_id = ? AND staff_id = ? AND screen_read_at IS NULL`)
    .bind(jstNow(), announcementId, staffId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function countScreenReads(db: D1Database, announcementId: string): Promise<{ read: number; total: number }> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN screen_read_at IS NOT NULL THEN 1 ELSE 0 END) AS read
                FROM platform_announcement_recipients WHERE announcement_id = ? AND channels LIKE '%"screen"%'`)
    .bind(announcementId)
    .first<{ total: number; read: number | null }>();
  return { read: row?.read ?? 0, total: row?.total ?? 0 };
}

// ---------------------------------------------------------------------------
// 契約者専用LINE の紐づけ
// ---------------------------------------------------------------------------

function randomCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

/** 権限者の確認コード。有効なものがあれば使い回す。 */
export async function issueStaffLineLinkCode(db: D1Database, staffId: string, ttlMs = 24 * 60 * 60 * 1000): Promise<{ code: string; expiresAt: string }> {
  const now = jstNow();
  const existing = await db
    .prepare(`SELECT code, expires_at FROM staff_line_link_codes WHERE staff_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`)
    .bind(staffId, now)
    .first<{ code: string; expires_at: string }>();
  if (existing) return { code: existing.code, expiresAt: existing.expires_at };
  const expiresAt = japanCalendar(new Date(Date.now() + ttlMs)).toISOString().replace('Z', '+09:00');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    try {
      await db
        .prepare(`INSERT INTO staff_line_link_codes (code, staff_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
        .bind(code, staffId, expiresAt, now)
        .run();
      return { code, expiresAt };
    } catch {
      // 衝突したら引き直す
    }
  }
  throw new Error('link code unavailable');
}

/** LINE で送られた 6 桁を照合し、権限者と友だちを結ぶ。 */
export async function consumeStaffLineLinkCode(
  db: D1Database,
  input: { code: string; friendId: string },
): Promise<{ staffId: string; staffName: string } | null> {
  const senderAttempts = await bumpAuthThrottle(db, `notice-link:friend:${input.friendId}`, 15 * 60_000);
  const globalAttempts = await bumpAuthThrottle(db, 'notice-link:global', 15 * 60_000);
  if (senderAttempts > 5 || globalAttempts > 25) return null;
  const now = jstNow();
  const row = await db
    .prepare(`SELECT c.code, c.staff_id, sm.name FROM staff_line_link_codes c JOIN staff_members sm ON sm.id = c.staff_id
               WHERE c.code = ? AND c.used_at IS NULL AND c.expires_at > ? AND sm.is_active = 1`)
    .bind(input.code, now)
    .first<{ code: string; staff_id: string; name: string }>();
  if (!row) return null;
  const results = await db.batch([
    db.prepare(`UPDATE staff_line_link_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?`).bind(now, row.code, now),
    db.prepare(`UPDATE staff_members SET notice_friend_id = ?, notice_linked_at = ? WHERE id = ? AND changes() = 1`).bind(input.friendId, now, row.staff_id),
  ]);
  return results[0].meta.changes === 1 ? { staffId: row.staff_id, staffName: row.name } : null;
}

export async function countNoticeLinkedStaff(db: D1Database, excludeTenantId: string): Promise<{ linked: number; total: number }> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN sm.notice_friend_id IS NOT NULL THEN 1 ELSE 0 END) AS linked
                FROM staff_members sm JOIN tenants t ON t.id = sm.tenant_id
               WHERE sm.is_active = 1 AND t.id <> ? AND t.status <> 'archived'`)
    .bind(excludeTenantId)
    .first<{ total: number; linked: number | null }>();
  return { linked: row?.linked ?? 0, total: row?.total ?? 0 };
}
