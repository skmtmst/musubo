import { jstCalendar as japanCalendar } from '@line-crm/shared';
export type { EventWaitlistOfferSender } from './event-waitlist-sender.js';
import type { EventWaitlistOfferSender } from './event-waitlist-sender.js';
import type { EventOccurrenceApplicants } from './event-waitlist-types.js';
export type { EventOccurrenceApplicants } from './event-waitlist-types.js';
import { eventModeRemaining } from './event-mode-capacity.js';
import { activeTenantLineAccountSql, resolveLineCredential, isOperationCapabilityStopped } from '@line-crm/db';
import { sha256 } from './event-waitlist-owner.js';
import { stoppedTenantLineAccountSql } from './tenant-runtime-status.js';
import { sendEventBookingNotification } from './event-booking-notifier.js';
import { prepareEventNotification } from './event-notification-plan.js';
import { prepareEventReminders } from './event-reminder-plan.js';
import { computeRemindersForBooking } from './event-reminder-schedule.js';
import { dispatchPendingEventWaitlistOffers, eventWaitlistDeliveryStatements } from './event-waitlist-delivery.js';
import { featureJobCanRun } from './feature-enforcement.js';
import type { EventWaitlistOfferDetail, EventWaitlistMine } from '@line-crm/shared';

const DEFAULT_OFFER_HOURS = 24;
const JOB_RETRY_MAX_MINUTES = 60;

interface OccurrenceRow {
  classroom_capacity:number|null;online_capacity:number|null;
  id: string;
  event_id: string;
  event_name: string;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  version: number;
  venue_name: string | null;
  venue_url: string | null;
}

interface WaitingRow {
  participation_mode: 'classroom'|'online';
  id: string;
  line_account_id: string;
  friend_id: string;
  party_size: number;
  version: number;
  created_at: string;
  event_snapshot_json: string | null;
}

interface BookingApplicantRow {
  id: string;
  friend_id: string;
  status: string;
  party_size: number;
  answer_snapshot_json: string | null;
  first_participation: number | null;
  first_participation_attended_count: number | null;
  first_participation_checked_at: string | null;
  requested_at: string;
  display_name: string | null;
  picture_url: string | null;
}

interface WaitlistApplicantRow {
  id: string;
  friend_id: string;
  status: string;
  party_size: number;
  answer_snapshot_json: string | null;
  first_participation: number | null;
  first_participation_attended_count: number | null;
  first_participation_checked_at: string | null;
  created_at: string;
  offered_at: string | null;
  offer_expires_at: string | null;
  display_name: string | null;
  picture_url: string | null;
}

export type EventWaitlistPromotionResult =
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentVersion: number }
  | {
      kind: 'noop';
      reason: 'no_waiting' | 'no_capacity' | 'offer_pending' | 'occurrence_started' | 'party_too_large' | 'applicant_ineligible' | 'emergency_stopped';
      occurrenceVersion: number;
      promoted: null;
    }
  | {
      kind: 'promoted';
      occurrenceVersion: number;
      promoted: {
        waitlistId: string;
        friendId: string;
        partySize: number;
        status: 'offered';
        offeredAt: string;
        expiresAt: string;
      };
    };

export type EventWaitlistAcceptanceResult =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'unavailable' }
  | {
      kind: 'accepted';
      newlyConverted: boolean;
      bookingId: string;
      lineAccountId: string;
      friendId: string;
      lineUserId: string;
      eventId: string;
      occurrenceId: string;
      eventName: string;
      startsAt: string;
      venueName: string | null;
      venueUrl: string | null;
      confirmationExtra: string | null;
      reminderDayBeforeEnabled: boolean;
      reminderHoursBefore: number | null;
    };

function parseSnapshot(value: string | null): unknown | null {
  if (value == null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function firstParticipation(
  flag: number | null,
  attendedCount: number | null,
  checkedAt: string | null,
): EventOccurrenceApplicants['applicants'][number]['firstParticipation'] {
  if (flag == null || checkedAt == null) {
    return { isFirst: null, attendedCount: null, checkedAt: null };
  }
  return {
    isFirst: flag === 1,
    attendedCount,
    checkedAt,
  };
}

async function loadOccurrence(
  db: D1Database,
  occurrenceId: string,
  lineAccountId: string,
): Promise<OccurrenceRow | null> {
  return db
    .prepare(
      `SELECT s.id, s.event_id, s.starts_at, s.ends_at, s.capacity, s.version, s.classroom_capacity,s.online_capacity,
              e.name AS event_name, e.venue_name, e.venue_url
         FROM event_slots s
         JOIN events e ON e.id = s.event_id
        WHERE s.id = ?
          AND s.deleted_at IS NULL
          AND e.deleted_at IS NULL
          AND (
            (e.target_type = 'single' AND e.line_account_id = ?)
            OR (e.target_type = 'multi-account-dedup'
                AND EXISTS (SELECT 1 FROM json_each(e.account_ids) WHERE value = ?))
          )`,
    )
    .bind(occurrenceId, lineAccountId, lineAccountId)
    .first<OccurrenceRow>();
}

export async function getEventOccurrenceUsedSeats(
  db: D1Database,
  occurrenceId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE((
           SELECT SUM(party_size) FROM event_bookings
            WHERE slot_id = ? AND status IN ('requested', 'confirmed')
         ), 0)
         + COALESCE((
           SELECT SUM(party_size) FROM event_waitlist
            WHERE slot_id = ? AND status IN ('offered', 'accepted')
         ), 0) AS seats`,
    )
    .bind(occurrenceId, occurrenceId)
    .first<{ seats: number }>();
  return row?.seats ?? 0;
}

export async function getEventOccurrenceApplicants(
  db: D1Database,
  params: { occurrenceId: string; lineAccountId: string },
): Promise<EventOccurrenceApplicants | null> {
  const occurrence = await loadOccurrence(db, params.occurrenceId, params.lineAccountId);
  if (!occurrence) return null;

  const [bookings, waitlist, activeSeats, attendanceRows, historyRows] = await Promise.all([
    db
      .prepare(
        `SELECT b.id, b.friend_id, b.status, b.party_size, b.answer_snapshot_json,
                b.first_participation, b.first_participation_attended_count,
                b.first_participation_checked_at, b.requested_at,
                f.display_name, f.picture_url
           FROM event_bookings b
           JOIN friends f ON f.id = b.friend_id AND f.line_account_id = ?
          WHERE b.slot_id = ? AND b.status IN ('requested', 'confirmed')
          ORDER BY b.requested_at ASC, b.id ASC`,
      )
      .bind(params.lineAccountId, params.occurrenceId)
      .all<BookingApplicantRow>(),
    db
      .prepare(
        `SELECT w.id, w.friend_id, w.status, w.party_size, w.answer_snapshot_json,
                w.first_participation, w.first_participation_attended_count,
                w.first_participation_checked_at, w.created_at, w.offered_at, w.offer_expires_at,
                f.display_name, f.picture_url
           FROM event_waitlist w
           JOIN friends f ON f.id = w.friend_id AND f.line_account_id = ?
          WHERE w.slot_id = ? AND w.status IN ('waiting', 'offered', 'accepted')
          ORDER BY w.sort_order ASC, w.created_at ASC, w.id ASC`,
      )
      .bind(params.lineAccountId, params.occurrenceId)
      .all<WaitlistApplicantRow>(),
    getEventOccurrenceUsedSeats(db, params.occurrenceId),
    // 当日受付。参加済・無断欠席は申込者一覧から外れるため、
    // 受付の結果が見えなくならないよう別ブロックで返す。
    db
      .prepare(
        `SELECT b.id, b.friend_id, b.status, b.party_size, b.updated_at,
                f.display_name
           FROM event_bookings b
           LEFT JOIN friends f ON f.id = b.friend_id AND f.line_account_id = ?
          WHERE b.slot_id = ? AND b.status IN ('attended', 'no_show')
          ORDER BY b.updated_at DESC, b.id ASC`,
      )
      .bind(params.lineAccountId, params.occurrenceId)
      .all<{
        id: string;
        friend_id: string;
        status: string;
        party_size: number;
        updated_at: string;
        display_name: string | null;
      }>(),
    /*
     * 繰上げ履歴。converted の予約IDは受諾時に
     * `event-waitlist:<待ちID>` で作る決まりなので、存在確認だけして返す。
     * 稼働中(waiting/offered/accepted)は applicants 側に出るため含めない。
     */
    db
      .prepare(
        `SELECT w.id, w.friend_id, w.status, w.party_size,
                w.created_at, w.offered_at, w.offer_expires_at, w.notified_at,
                w.updated_at, f.display_name,
                CASE WHEN w.status = 'converted' THEN cb.id ELSE NULL END AS converted_booking_id
           FROM event_waitlist w
           LEFT JOIN friends f ON f.id = w.friend_id AND f.line_account_id = ?
           LEFT JOIN event_bookings cb ON cb.id = 'event-waitlist:' || w.id
          WHERE w.slot_id = ? AND w.status IN ('converted', 'expired', 'cancelled')
          ORDER BY w.updated_at DESC, w.id ASC
          LIMIT 50`,
      )
      .bind(params.lineAccountId, params.occurrenceId)
      .all<{
        id: string;
        friend_id: string;
        status: string;
        party_size: number;
        created_at: string;
        offered_at: string | null;
        offer_expires_at: string | null;
        notified_at: string | null;
        updated_at: string;
        display_name: string | null;
        converted_booking_id: string | null;
      }>(),
  ]);

  const bookingApplicants = (bookings.results ?? []).map((row) => ({
    source: 'booking' as const,
    id: row.id,
    friendId: row.friend_id,
    displayName: row.display_name ?? null,
    pictureUrl: row.picture_url ?? null,
    status: row.status,
    partySize: row.party_size,
    appliedAt: row.requested_at,
    answers: parseSnapshot(row.answer_snapshot_json),
    firstParticipation: firstParticipation(
      row.first_participation,
      row.first_participation_attended_count,
      row.first_participation_checked_at,
    ),
    offeredAt: null,
    offerExpiresAt: null,
  }));
  const waitlistApplicants = (waitlist.results ?? []).map((row) => ({
    source: 'waitlist' as const,
    id: row.id,
    friendId: row.friend_id,
    displayName: row.display_name ?? null,
    pictureUrl: row.picture_url ?? null,
    status: row.status,
    partySize: row.party_size,
    appliedAt: row.created_at,
    answers: parseSnapshot(row.answer_snapshot_json),
    firstParticipation: firstParticipation(
      row.first_participation,
      row.first_participation_attended_count,
      row.first_participation_checked_at,
    ),
    offeredAt: row.offered_at,
    offerExpiresAt: row.offer_expires_at,
  }));
  const applicants = [...bookingApplicants, ...waitlistApplicants]
    .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.id.localeCompare(b.id));

  const seatsOf = (rows: Array<{ partySize: number }>): number =>
    rows.reduce((total, row) => total + row.partySize, 0);
  const confirmedSeats = seatsOf(bookingApplicants.filter((row) => row.status === 'confirmed'));
  const requestedSeats = seatsOf(bookingApplicants.filter((row) => row.status === 'requested'));
  const waitingSeats = seatsOf(waitlistApplicants.filter((row) => row.status === 'waiting'));
  const offeredSeats = seatsOf(
    waitlistApplicants.filter((row) => row.status === 'offered' || row.status === 'accepted'),
  );

  const attendanceEntries = (attendanceRows.results ?? []).map((row) => ({
    id: row.id,
    friendId: row.friend_id,
    displayName: row.display_name ?? null,
    status: row.status,
    partySize: row.party_size,
    markedAt: row.updated_at,
  }));

  return {
    occurrence: {
      id: occurrence.id,
      eventId: occurrence.event_id,
      startsAt: occurrence.starts_at,
      endsAt: occurrence.ends_at,
      capacity: occurrence.capacity,
      activeSeats,
      version: occurrence.version,
    },
    summary: {
      bookingCount: bookingApplicants.length,
      waitingCount: waitlistApplicants.filter((row) => row.status === 'waiting').length,
      activeSeats,
      confirmedSeats,
      requestedSeats,
      waitingSeats,
      offeredSeats,
      remainingSeats: occurrence.capacity == null
        ? null
        : occurrence.capacity==null?Infinity:Math.max(0, occurrence.capacity - activeSeats),
    },
    waitlistHistory: (historyRows.results ?? []).map((row) => ({
      id: row.id,
      friendId: row.friend_id,
      displayName: row.display_name ?? null,
      status: row.status,
      partySize: row.party_size,
      createdAt: row.created_at,
      offeredAt: row.offered_at,
      offerExpiresAt: row.offer_expires_at,
      notifiedAt: row.notified_at,
      updatedAt: row.updated_at,
      convertedBookingId: row.converted_booking_id,
    })),
    attendance: {
      attendedSeats: seatsOf(attendanceEntries.filter((row) => row.status === 'attended')),
      noShowSeats: seatsOf(attendanceEntries.filter((row) => row.status === 'no_show')),
      entries: attendanceEntries,
    },
    applicants,
  };
}

export async function enqueueEventWaitlistPromotion(
  db: D1Database,
  params: {
    lineAccountId: string;
    eventId: string;
    occurrenceId: string;
    sourceKey: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = (params.now ?? new Date()).toISOString();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO event_waitlist_promotion_jobs (
         id, line_account_id, event_id, slot_id, source_key,
         status, attempts, available_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      params.lineAccountId,
      params.eventId,
      params.occurrenceId,
      params.sourceKey,
      now,
      now,
      now,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

/** 期限切れと次の促進を同じ取引へ入れる。通知の結果不明も期限までは保持する。 */
async function expireEventWaitlistOffer(
  db: D1Database,
  offer: { id: string; version: number; slot_id: string; line_account_id: string; event_id: string },
  now: Date,
  occurrenceVersion?: number,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const sourceKey = `offer-expired:${offer.id}:${offer.version}`;
  const [expired] = await db.batch([
    db.prepare(`UPDATE event_waitlist SET status = 'expired', version = version + 1, updated_at = ?
      WHERE id = ? AND status = 'offered' AND version = ? AND offer_expires_at <= ?
        AND (? IS NULL OR (SELECT version FROM event_slots WHERE id = event_waitlist.slot_id) = ?)`)
      .bind(nowIso, offer.id, offer.version, nowIso, occurrenceVersion ?? null, occurrenceVersion ?? null),
    db.prepare(`UPDATE event_slots SET version = version + 1, updated_at = ? WHERE id = ? AND changes() = 1`)
      .bind(nowIso, offer.slot_id),
    db.prepare(`INSERT OR IGNORE INTO event_waitlist_promotion_jobs
      (id,line_account_id,event_id,slot_id,source_key,status,attempts,available_at,created_at,updated_at)
      SELECT ?,?,?,?,?,'pending',0,?,?,? WHERE EXISTS (
        SELECT 1 FROM event_waitlist WHERE id = ? AND status = 'expired' AND version = ?)`)
      .bind(crypto.randomUUID(), offer.line_account_id, offer.event_id, offer.slot_id,
        sourceKey, nowIso, nowIso, nowIso, offer.id, offer.version + 1),
  ]);
  return (expired.meta?.changes ?? 0) === 1;
}

/** 順番は管理者の並べ替えを含む、実際の繰上げ順と同じ。 */
export async function getMyEventWaitlist(
  db: D1Database,
  params: { lineAccountId: string; callerLineUserId: string; waitlistId?: string },
): Promise<EventWaitlistMine[]> {
  const rows = await db.prepare(`
    SELECT w.id, w.event_id, w.slot_id, w.status, w.party_size, w.created_at, w.offer_expires_at,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.eventName') ELSE e.name END AS event_name,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.eventImageUrl') ELSE e.image_url END AS event_image_url,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.venueName') ELSE e.venue_name END AS venue_name,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.venueAddress') ELSE e.venue_address END AS venue_address,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END AS slot_starts_at,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.slotEndsAt') ELSE s.ends_at END AS slot_ends_at,
           CASE WHEN w.status = 'waiting' THEN 1 + (
             SELECT COUNT(*) FROM event_waitlist ahead
              WHERE ahead.slot_id = w.slot_id AND ahead.status = 'waiting'
                AND (ahead.sort_order < w.sort_order
                  OR (ahead.sort_order = w.sort_order AND ahead.created_at < w.created_at)
                  OR (ahead.sort_order = w.sort_order AND ahead.created_at = w.created_at AND ahead.id < w.id))
           ) ELSE NULL END AS queue_position
      FROM event_waitlist w
      JOIN friends f ON f.id = w.friend_id AND f.line_account_id = w.line_account_id
      JOIN events e ON e.id = w.event_id AND e.deleted_at IS NULL
      JOIN event_slots s ON s.id = w.slot_id AND s.deleted_at IS NULL
     WHERE w.line_account_id = ? AND f.line_platform_user_id = ? AND (? IS NULL OR w.id = ?)
     ORDER BY slot_starts_at ASC, w.created_at ASC, w.id ASC
  `).bind(params.lineAccountId, params.callerLineUserId, params.waitlistId ?? null, params.waitlistId ?? null)
    .all<Omit<EventWaitlistMine, 'source' | 'customer_note' | 'venue_url' | 'cancel_deadline_hours_before'>>();
  return (rows.results ?? []).map(row => ({
    ...row, source: 'waitlist', customer_note: null, venue_url: null, cancel_deadline_hours_before: null,
  }));
}

/** 取り下げと席解放jobは同じtransactionで確定し、予約化との競争には版で負ける。 */
export async function cancelMyEventWaitlist(
  db: D1Database,
  params: { lineAccountId: string; callerLineUserId: string; waitlistId: string; now?: Date },
): Promise<'cancelled' | 'not_found' | 'conflict'> {
  const row = await db.prepare(`
    SELECT w.status, w.version FROM event_waitlist w
      JOIN friends f ON f.id = w.friend_id AND f.line_account_id = w.line_account_id
     WHERE w.id = ? AND w.line_account_id = ? AND f.line_platform_user_id = ?
  `).bind(params.waitlistId, params.lineAccountId, params.callerLineUserId)
    .first<{ status: string; version: number }>();
  if (!row) return 'not_found';
  if (row.status === 'cancelled') return 'cancelled';
  if (!['waiting', 'offered'].includes(row.status)) return 'conflict';
  const now = (params.now ?? new Date()).toISOString();
  const sourceKey = `waitlist:${params.waitlistId}:cancelled`;
  const changedRow = `SELECT 1 FROM event_waitlist w
    WHERE w.id = ? AND w.line_account_id = ? AND w.status = 'cancelled' AND w.version = ? AND w.updated_at = ?`;
  const jobId = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`UPDATE event_waitlist SET status = 'cancelled', version = version + 1, updated_at = ?
      WHERE id = ? AND line_account_id = ? AND version = ? AND status IN ('waiting', 'offered')
        AND EXISTS (SELECT 1 FROM friends f WHERE f.id = event_waitlist.friend_id
          AND f.line_account_id = event_waitlist.line_account_id AND f.line_platform_user_id = ?)`)
      .bind(now, params.waitlistId, params.lineAccountId, row.version, params.callerLineUserId),
    db.prepare(`INSERT OR IGNORE INTO event_waitlist_promotion_jobs
      (id, line_account_id, event_id, slot_id, source_key, status, attempts, available_at, created_at, updated_at)
      SELECT ?, w.line_account_id, w.event_id, w.slot_id, ?, 'pending', 0, ?, ?, ?
        FROM event_waitlist w WHERE w.id = ? AND EXISTS (${changedRow})`)
      .bind(jobId, sourceKey, now, now, now, params.waitlistId,
        params.waitlistId, params.lineAccountId, row.version + 1, now),
    db.prepare(`UPDATE event_slots SET version = version + 1, updated_at = ?
      WHERE id = (SELECT slot_id FROM event_waitlist WHERE id = ?)
        AND EXISTS (SELECT 1 FROM event_waitlist_promotion_jobs WHERE id = ?)`)
      .bind(now, params.waitlistId, jobId),
  ]);
  return (results[0].meta?.changes ?? 0) > 0 ? 'cancelled' : 'conflict';
}

export { getEventWaitlistOfferAccountId } from './event-waitlist-owner.js';

/** 案内の読み出しでは失効・予約化をしない。URLの所持と本人を両方照合する。 */
export async function getEventWaitlistOffer(
  db: D1Database,
  params: { token: string; callerLineUserId: string; now?: Date },
): Promise<EventWaitlistOfferDetail | null> {
  if (params.token.length < 32 || params.token.length > 256) return null;
  const row = await db.prepare(`
    SELECT w.id AS waitlistId, w.event_id AS eventId, w.slot_id AS slotId,
           w.party_size AS partySize, w.status, w.offer_expires_at AS expiresAt,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.eventName') ELSE e.name END AS eventName,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END AS startsAt,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.slotEndsAt') ELSE s.ends_at END AS endsAt,
           CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.venueName') ELSE e.venue_name END AS venueName
      FROM event_waitlist w
      JOIN friends f ON f.id = w.friend_id AND f.line_account_id = w.line_account_id
      JOIN events e ON e.id = w.event_id AND e.deleted_at IS NULL
      JOIN event_slots s ON s.id = w.slot_id AND s.deleted_at IS NULL
     WHERE w.offer_token_hash = ? AND f.line_platform_user_id = ?
     LIMIT 1
  `).bind(await sha256(params.token), params.callerLineUserId)
    .first<Omit<EventWaitlistOfferDetail, 'remainingSeconds' | 'canAccept'>>();
  if (!row) return null;
  const expires = row.expiresAt ? Date.parse(row.expiresAt) : NaN;
  const remainingMs = expires - (params.now ?? new Date()).getTime();
  return {
    ...row,
    remainingSeconds: Number.isFinite(remainingMs) ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0,
    canAccept: row.status === 'offered' && remainingMs > 0,
  };
}

interface WaitlistOfferAcceptanceRow {
  id: string;
  line_account_id: string;
  friend_id: string;
  line_user_id: string;
  event_id: string;
  slot_id: string;
  status: string;
  offer_expires_at: string | null;
  event_name: string;
  starts_at: string;
  venue_name: string | null;
  venue_url: string | null;
  confirmation_message_extra: string | null;
  reminder_day_before_enabled: number;
  reminder_hours_before: number | null;
}

/**
 * 期限付きの繰上げ案内を、本人の明示承諾で確定予約へ変換する。
 * token は保存せずハッシュだけ照合し、同じURLの再送は同じ予約を返す。
 */
export async function acceptEventWaitlistOffer(
  db: D1Database,
  params: { token: string; callerLineUserId: string; now?: Date },
): Promise<EventWaitlistAcceptanceResult> {
  if (params.token.length < 32 || params.token.length > 256) return { kind: 'not_found' };
  const tokenHash = await sha256(params.token);
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const offer = await db
    .prepare(
      `SELECT w.id, w.line_account_id, w.friend_id, f.line_platform_user_id AS line_user_id,
              w.event_id, w.slot_id, w.status, w.offer_expires_at,
              CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.eventName') ELSE e.name END AS event_name,
              CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.slotStartsAt') ELSE s.starts_at END AS starts_at,
              CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.venueName') ELSE e.venue_name END AS venue_name,
              CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.venueUrl') ELSE e.venue_url END AS venue_url,
              CASE WHEN w.event_snapshot_json IS NOT NULL THEN json_extract(w.event_snapshot_json, '$.confirmationMessageExtra') ELSE e.confirmation_message_extra END AS confirmation_message_extra,
              e.reminder_day_before_enabled,
              e.reminder_hours_before
         FROM event_waitlist w
         JOIN friends f ON f.id = w.friend_id AND f.line_account_id = w.line_account_id
         JOIN events e ON e.id = w.event_id AND e.deleted_at IS NULL
         JOIN event_slots s ON s.id = w.slot_id AND s.deleted_at IS NULL
        WHERE w.offer_token_hash = ? AND f.line_platform_user_id = ?
        LIMIT 1`,
    )
    .bind(tokenHash, params.callerLineUserId)
    .first<WaitlistOfferAcceptanceRow>();
  if (!offer) return { kind: 'not_found' };

  const bookingId = `event-waitlist:${offer.id}`;
  if (offer.status === 'offered' && (!offer.offer_expires_at || offer.offer_expires_at <= nowIso)) {
    const sourceKey = `waitlist:${offer.id}:offer-expired`;
    // 失効と次候補のjobを同じtransactionへ入れる。失効だけ成功すると、
    // 次の待ち人が永久に案内されないため、別々には確定しない。
    await db.batch([
      db.prepare(
        `UPDATE event_waitlist
            SET status = 'expired', version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'offered' AND offer_token_hash = ?
            AND (offer_expires_at IS NULL OR offer_expires_at <= ?)`,
      )
        .bind(nowIso, offer.id, tokenHash, nowIso),
      db.prepare(
        `INSERT OR IGNORE INTO event_waitlist_promotion_jobs (
           id, line_account_id, event_id, slot_id, source_key,
           status, attempts, available_at, created_at, updated_at
         )
         SELECT ?, line_account_id, event_id, slot_id, ?, 'pending', 0, ?, ?, ?
           FROM event_waitlist
          WHERE id = ? AND status = 'expired' AND offer_token_hash = ?`,
      ).bind(crypto.randomUUID(), sourceKey, nowIso, nowIso, nowIso, offer.id, tokenHash),
    ]);
    return { kind: 'expired' };
  }

  if (!['offered', 'accepted', 'converted'].includes(offer.status)) {
    return { kind: 'unavailable' };
  }

  const notificationPlan=await prepareEventNotification(db,{accountId:offer.line_account_id,
    operationId:`event-waitlist-accept:${bookingId}`,to:offer.line_user_id,kind:'received_confirmed',
    ctx:{eventName:offer.event_name,startsAtJst:formatJst(offer.starts_at),venueName:offer.venue_name,
      venueUrl:offer.venue_url,confirmationExtra:offer.confirmation_message_extra},
    subject:{bookingId,slotId:offer.slot_id,status:'confirmed',startsAt:offer.starts_at},now});
  const reminderPlans=prepareEventReminders(db,bookingId,computeRemindersForBooking({starts_at_utc:offer.starts_at,
    reminder_day_before_enabled:offer.reminder_day_before_enabled===1,reminder_hours_before:offer.reminder_hours_before,now}),true);
  const results = await db.batch([
    db.prepare(
      `UPDATE event_waitlist
          SET status = 'accepted', version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'offered' AND offer_token_hash = ?
          AND offer_expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM event_bookings b
             WHERE b.event_id = event_waitlist.event_id
               AND b.slot_id = event_waitlist.slot_id
               AND b.identity_key = event_waitlist.identity_key
               AND b.status IN ('requested','confirmed')
          )
          AND EXISTS (
            SELECT 1 FROM event_slots slot
             WHERE slot.id = event_waitlist.slot_id
               AND (slot.capacity IS NULL OR (
                 COALESCE((SELECT SUM(b.party_size) FROM event_bookings b
                   WHERE b.slot_id = slot.id AND b.status IN ('requested','confirmed')), 0)
                 + COALESCE((SELECT SUM(w.party_size) FROM event_waitlist w
                   WHERE w.slot_id = slot.id AND w.status IN ('offered','accepted')), 0)
               ) <= slot.capacity)
          )
          AND EXISTS (
            SELECT 1 FROM events e WHERE e.id = event_waitlist.event_id
              AND (e.max_bookings_per_friend IS NULL OR (
                (SELECT COUNT(*) FROM event_bookings b
                  WHERE b.event_id = e.id AND b.identity_key = event_waitlist.identity_key
                    AND b.status IN ('requested','confirmed'))
                + (SELECT COUNT(*) FROM event_waitlist held
                    WHERE held.event_id = e.id AND held.identity_key = event_waitlist.identity_key
                      AND held.status IN ('offered','accepted'))
              ) <= e.max_bookings_per_friend)
          )`,
    ).bind(nowIso, offer.id, tokenHash, nowIso),
    db.prepare(
      `INSERT OR IGNORE INTO event_bookings (
         id, line_account_id, event_id, slot_id, friend_id, status, requested_at,
         identity_key, party_size, answer_snapshot_json, first_participation,
         first_participation_attended_count, first_participation_checked_at,
         event_version_id, event_snapshot_json, approval_expires_at,
         created_at, updated_at, participation_mode
       )
       SELECT ?, w.line_account_id, w.event_id, w.slot_id, w.friend_id, 'confirmed', ?,
              w.identity_key, w.party_size, w.answer_snapshot_json, w.first_participation,
              w.first_participation_attended_count, w.first_participation_checked_at,
              w.event_version_id, w.event_snapshot_json, NULL, ?, ?, w.participation_mode
         FROM event_waitlist w
         JOIN friends f ON f.id = w.friend_id AND f.line_account_id = w.line_account_id
         JOIN events e ON e.id = w.event_id AND e.deleted_at IS NULL
         JOIN event_slots slot ON slot.id = w.slot_id AND slot.deleted_at IS NULL
        WHERE w.id = ? AND w.status = 'accepted' AND w.offer_token_hash = ?
          AND f.line_platform_user_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM event_bookings same_slot
             WHERE same_slot.event_id = w.event_id AND same_slot.slot_id = w.slot_id
               AND same_slot.identity_key = w.identity_key
               AND same_slot.status IN ('requested','confirmed')
          )
          AND (slot.capacity IS NULL OR (
            COALESCE((SELECT SUM(b.party_size) FROM event_bookings b
              WHERE b.slot_id = slot.id AND b.status IN ('requested','confirmed')), 0)
            + COALESCE((SELECT SUM(held.party_size) FROM event_waitlist held
              WHERE held.slot_id = slot.id AND held.id != w.id
                AND held.status IN ('offered','accepted')), 0)
            + w.party_size
          ) <= slot.capacity)
          AND (e.max_bookings_per_friend IS NULL OR (
            (SELECT COUNT(*) FROM event_bookings b
              WHERE b.event_id = e.id AND b.identity_key = w.identity_key
                AND b.status IN ('requested','confirmed'))
            + (SELECT COUNT(*) FROM event_waitlist held
                WHERE held.event_id = e.id AND held.identity_key = w.identity_key
                  AND held.id != w.id AND held.status IN ('offered','accepted'))
            + 1
          ) <= e.max_bookings_per_friend)`,
    ).bind(bookingId, nowIso, nowIso, nowIso, offer.id, tokenHash, params.callerLineUserId),
    db.prepare(
      `UPDATE event_waitlist
          SET status = 'converted', version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'accepted' AND offer_token_hash = ?
          AND EXISTS (SELECT 1 FROM event_bookings b WHERE b.id = ?)`,
    ).bind(nowIso, offer.id, tokenHash, bookingId),
    notificationPlan,...reminderPlans,
  ]);

  const converted = await db
    .prepare(
      `SELECT 1 AS found FROM event_waitlist w
        JOIN event_bookings b ON b.id = ? AND b.event_id = w.event_id
          AND b.slot_id = w.slot_id AND b.friend_id = w.friend_id
       WHERE w.id = ? AND w.status = 'converted' AND w.offer_token_hash = ?`,
    )
    .bind(bookingId, offer.id, tokenHash)
    .first<{ found: number }>();
  if (!converted) return { kind: 'unavailable' };

  return {
    kind: 'accepted',
    newlyConverted: (results[2]?.meta?.changes ?? 0) > 0,
    bookingId,
    lineAccountId: offer.line_account_id,
    friendId: offer.friend_id,
    lineUserId: offer.line_user_id,
    eventId: offer.event_id,
    occurrenceId: offer.slot_id,
    eventName: offer.event_name,
    startsAt: offer.starts_at,
    venueName: offer.venue_name,
    venueUrl: offer.venue_url,
    confirmationExtra: offer.confirmation_message_extra,
    reminderDayBeforeEnabled: offer.reminder_day_before_enabled === 1,
    reminderHoursBefore: offer.reminder_hours_before,
  };
}

export async function promoteEventWaitlist(
  db: D1Database,
  params: {
    occurrenceId: string;
    lineAccountId: string;
    expectedVersion?: number;
    now?: Date;
    offerHours?: number;
    sender: EventWaitlistOfferSender;
  },
): Promise<EventWaitlistPromotionResult> {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const occurrence = await loadOccurrence(db, params.occurrenceId, params.lineAccountId);
  if (!occurrence) return { kind: 'not_found' };
  if (params.expectedVersion != null && params.expectedVersion !== occurrence.version) {
    return { kind: 'conflict', currentVersion: occurrence.version };
  }
  if (new Date(occurrence.starts_at).getTime() <= now.getTime()) {
    return {
      kind: 'noop', reason: 'occurrence_started',
      occurrenceVersion: occurrence.version, promoted: null,
    };
  }

  // 期限切れの保留を履歴として残してから、次の待機者へ進む。
  let occurrenceVersion = occurrence.version;
  const dueOffer = await db
    .prepare(
      `SELECT id, version FROM event_waitlist
        WHERE slot_id = ? AND status = 'offered' AND offer_expires_at <= ?
        ORDER BY offer_expires_at ASC
        LIMIT 1`,
    )
    .bind(occurrence.id, nowIso)
    .first<{ id: string; version: number }>();
  if (dueOffer) {
    const expired = await expireEventWaitlistOffer(db, {
      ...dueOffer, slot_id: occurrence.id, event_id: occurrence.event_id, line_account_id: params.lineAccountId,
    }, now, occurrenceVersion);
    if (!expired) {
      const latest = await loadOccurrence(db, occurrence.id, params.lineAccountId);
      return { kind: 'conflict', currentVersion: latest?.version ?? occurrenceVersion };
    }
    occurrenceVersion++;

  }

  const pendingOffer = await db
    .prepare(
      `SELECT id FROM event_waitlist
        WHERE slot_id = ? AND status = 'offered' AND offer_expires_at > ?
          AND NOT EXISTS(SELECT 1 FROM event_slots s WHERE s.id=event_waitlist.slot_id AND (s.classroom_capacity IS NOT NULL OR s.online_capacity IS NOT NULL))
        LIMIT 1`,
    )
    .bind(occurrence.id, nowIso)
    .first<{ id: string }>();
  if (pendingOffer) {
    await dispatchPendingEventWaitlistOffers(db, { now, sender: params.sender, waitlistId: pendingOffer.id });
    return { kind: 'noop', reason: 'offer_pending', occurrenceVersion, promoted: null };
  }

  const waiting = await db
    .prepare(
      `SELECT id, line_account_id, friend_id, party_size, version, created_at,
              event_snapshot_json,participation_mode
         FROM event_waitlist
        WHERE slot_id = ? AND status = 'waiting'
          AND NOT EXISTS(SELECT 1 FROM event_slots s WHERE s.id=event_waitlist.slot_id AND (s.classroom_capacity IS NOT NULL OR s.online_capacity IS NOT NULL)
            AND CASE WHEN event_waitlist.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END IS NOT NULL
            AND COALESCE((SELECT SUM(b.party_size) FROM event_bookings b WHERE b.slot_id=s.id AND b.participation_mode=event_waitlist.participation_mode AND b.status IN('requested','confirmed')),0)
              + COALESCE((SELECT SUM(w.party_size) FROM event_waitlist w WHERE w.slot_id=s.id AND w.participation_mode=event_waitlist.participation_mode AND w.status IN('offered','accepted')),0) + event_waitlist.party_size>CASE WHEN event_waitlist.participation_mode='classroom' THEN s.classroom_capacity ELSE s.online_capacity END)
        ORDER BY sort_order ASC, created_at ASC, id ASC
        LIMIT 1`,
    )
    .bind(occurrence.id)
    .first<WaitingRow>();
  if (!waiting) {
    return { kind: 'noop', reason: 'no_waiting', occurrenceVersion, promoted: null };
  }

  if (occurrence.capacity == null && occurrence.classroom_capacity==null && occurrence.online_capacity==null) {
    return { kind: 'noop', reason: 'no_capacity', occurrenceVersion, promoted: null };
  }
  const activeSeats = await getEventOccurrenceUsedSeats(db, occurrence.id);
  const remaining = occurrence.capacity==null?Infinity:Math.max(0, occurrence.capacity - activeSeats);
  if (waiting.party_size > remaining) {
    return { kind: 'noop', reason: 'party_too_large', occurrenceVersion, promoted: null };
  }

  const modeRemaining=await eventModeRemaining(db,occurrence.id,waiting.participation_mode??'classroom');
  if(modeRemaining!==null&&waiting.party_size>modeRemaining)return {kind:'noop',reason:'party_too_large',occurrenceVersion,promoted:null};

  // 緊急停止 : reminder_dispatch 停止中は席の確保 (offered 化) と
  // 案内通知をしない。待機者は waiting のまま残り、復旧後に次の促進が届く。
  if (await isOperationCapabilityStopped(db, params.lineAccountId, 'reminder_dispatch')) {
    return { kind: 'noop', reason: 'emergency_stopped', occurrenceVersion, promoted: null };
  }

  const token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`;
  const tokenHash = await sha256(token);
  const expiresAt = new Date(
    now.getTime() + (params.offerHours ?? DEFAULT_OFFER_HOURS) * 3600_000,
  ).toISOString();
  const snapshot = parseSnapshot(waiting.event_snapshot_json) as Record<string, unknown> | null;
  const offer: Parameters<EventWaitlistOfferSender>[0] = {
    waitlistId: waiting.id, lineAccountId: waiting.line_account_id, friendId: waiting.friend_id,
    eventName: typeof snapshot?.eventName === 'string' ? snapshot.eventName : occurrence.event_name,
    startsAt: typeof snapshot?.slotStartsAt === 'string' ? snapshot.slotStartsAt : occurrence.starts_at,
    venueName: snapshot?.venueName === null || typeof snapshot?.venueName === 'string' ? snapshot.venueName : occurrence.venue_name,
    venueUrl: snapshot?.venueUrl === null || typeof snapshot?.venueUrl === 'string' ? snapshot.venueUrl : occurrence.venue_url,
    token, expiresAt,
  };
  // 事前SELECTの空席は他の予約・繰上げで変わる。人数分の容量確認と
  // offered（期限付き席保留）への遷移を、同じSQLの中で確定する。
  // 案内なし判定も再検査し、古い読取結果で次の待ちを追い越さない。
  const claimStatement = db
    .prepare(
      `UPDATE event_waitlist
          SET status = 'offered', offered_at = ?, offer_expires_at = ?,
              offer_token_hash = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'waiting' AND version = ?
          AND (SELECT version FROM event_slots WHERE id = event_waitlist.slot_id) = ?
          AND EXISTS (
            SELECT 1 FROM event_slots slot
             WHERE slot.id = event_waitlist.slot_id AND (slot.capacity IS NOT NULL OR slot.classroom_capacity IS NOT NULL OR slot.online_capacity IS NOT NULL) AND (slot.capacity IS NULL OR (COALESCE((SELECT SUM(b.party_size) FROM event_bookings b
                     WHERE b.slot_id = slot.id AND b.status IN ('requested','confirmed')), 0)
                 + COALESCE((SELECT SUM(held.party_size) FROM event_waitlist held
                     WHERE held.slot_id = slot.id AND held.status IN ('offered','accepted')), 0)
                 + event_waitlist.party_size <= slot.capacity))
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_waitlist pending
             WHERE pending.slot_id = event_waitlist.slot_id
               AND pending.status = 'offered' AND pending.offer_expires_at > ?
               AND (pending.participation_mode=event_waitlist.participation_mode OR NOT EXISTS(SELECT 1 FROM event_slots s WHERE s.id=pending.slot_id AND (s.classroom_capacity IS NOT NULL OR s.online_capacity IS NOT NULL)))
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_bookings b
             WHERE b.event_id = event_waitlist.event_id
               AND b.slot_id = event_waitlist.slot_id
               AND b.identity_key = event_waitlist.identity_key
               AND b.status IN ('requested','confirmed')
          )
          AND EXISTS (
            SELECT 1 FROM events e WHERE e.id = event_waitlist.event_id
              AND (e.max_bookings_per_friend IS NULL OR (
                (SELECT COUNT(*) FROM event_bookings b
                  WHERE b.event_id = e.id AND b.identity_key = event_waitlist.identity_key
                    AND b.status IN ('requested','confirmed'))
                + (SELECT COUNT(*) FROM event_waitlist held
                    WHERE held.event_id = e.id AND held.identity_key = event_waitlist.identity_key
                      AND held.id != event_waitlist.id AND held.status IN ('offered','accepted'))
              ) < e.max_bookings_per_friend)
          )`,
    )
    .bind(nowIso, expiresAt, tokenHash, nowIso, waiting.id, waiting.version, occurrenceVersion, nowIso);
  const [claimed] = await db.batch([
    claimStatement,
    db.prepare(`UPDATE event_slots SET version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND EXISTS (
        SELECT 1 FROM event_waitlist WHERE id = ? AND status = 'offered' AND offer_token_hash = ?)`)
      .bind(nowIso, occurrence.id, occurrenceVersion, waiting.id, tokenHash),
    ...eventWaitlistDeliveryStatements(db, offer, tokenHash, nowIso),
  ]);
  if ((claimed.meta?.changes ?? 0) === 0) {
    // 競合負けでは席も通知も確保しない。待ち順・版・申込内容を残す。
    // 以下の再読取は表示理由だけに使い、席の確保判断には使わない。
    const unchanged = await db
      .prepare(`SELECT id FROM event_waitlist WHERE id = ? AND status = 'waiting' AND version = ?`)
      .bind(waiting.id, waiting.version)
      .first<{ id: string }>();
    if (unchanged) {
      const pending = await db
        .prepare(`SELECT id FROM event_waitlist WHERE slot_id = ?
                    AND status = 'offered' AND offer_expires_at > ? LIMIT 1`)
        .bind(occurrence.id, nowIso)
        .first<{ id: string }>();
      if (pending) return { kind: 'noop', reason: 'offer_pending', occurrenceVersion, promoted: null };
      const latest = await loadOccurrence(db, occurrence.id, params.lineAccountId);
      if (latest?.capacity == null) {
        return { kind: 'noop', reason: 'no_capacity', occurrenceVersion, promoted: null };
      }
      if (waiting.party_size > latest.capacity - await getEventOccurrenceUsedSeats(db, occurrence.id)) {
        return { kind: 'noop', reason: 'party_too_large', occurrenceVersion, promoted: null };
      }
      return { kind: 'noop', reason: 'applicant_ineligible', occurrenceVersion, promoted: null };
    }
    const latest = await loadOccurrence(db, occurrence.id, params.lineAccountId);
    return { kind: 'conflict', currentVersion: latest?.version ?? occurrence.version };
  }

  await dispatchPendingEventWaitlistOffers(db, { now, sender: params.sender, waitlistId: waiting.id });

  return {
    kind: 'promoted',
    occurrenceVersion: occurrenceVersion + 1,
    promoted: {
      waitlistId: waiting.id,
      friendId: waiting.friend_id,
      partySize: waiting.party_size,
      status: 'offered',
      offeredAt: nowIso,
      expiresAt,
    },
  };
}

interface PromotionJobRow {
  id: string;
  line_account_id: string;
  event_id: string;
  slot_id: string;
  attempts: number;
}

export async function processEventWaitlistPromotionJobs(
  db: D1Database,
  params: {
    now?: Date;
    limit?: number;
    sender: EventWaitlistOfferSender;
  },
): Promise<{ processed: number; promoted: number; retried: number }> {
  const now = params.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));

  // 途中でWorkerが落ちたjobも次回に戻す。
  const staleAt = new Date(now.getTime() - 10 * 60_000).toISOString();
  await db
    .prepare(
      `UPDATE event_waitlist_promotion_jobs
          SET status = 'retryable_failed', available_at = ?, updated_at = ?,
              last_error = 'processing_timeout'
        WHERE status = 'processing' AND updated_at < ?`,
    )
    .bind(nowIso, nowIso, staleAt)
    .run();

  const dueOffers = await db
    .prepare(
      `SELECT id, line_account_id, event_id, slot_id, version
         FROM event_waitlist
        WHERE status = 'offered' AND offer_expires_at <= ?
        ORDER BY offer_expires_at ASC
        LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<{
      id: string;
      line_account_id: string;
      event_id: string;
      slot_id: string;
      version: number;
    }>();
  for (const offer of dueOffers.results ?? []) {
    await expireEventWaitlistOffer(db, offer, now);
  }

  // 旧版の expired だけ保存された中断も回収する。一意な source_key でjobを重ねない。
  await db.prepare(`INSERT OR IGNORE INTO event_waitlist_promotion_jobs
    (id,line_account_id,event_id,slot_id,source_key,status,attempts,available_at,created_at,updated_at)
    SELECT 'offer-expired-repair:' || w.id || ':' || (w.version - 1), w.line_account_id,
      w.event_id, w.slot_id, 'offer-expired:' || w.id || ':' || (w.version - 1), 'pending', 0, ?, ?, ?
    FROM event_waitlist w WHERE w.status = 'expired' AND w.offered_at IS NOT NULL
      AND w.offer_expires_at <= ? AND EXISTS (
        SELECT 1 FROM event_waitlist next WHERE next.slot_id = w.slot_id AND next.status = 'waiting')
      AND NOT EXISTS (SELECT 1 FROM event_waitlist_promotion_jobs j
        WHERE j.source_key = 'offer-expired:' || w.id || ':' || (w.version - 1))
    ORDER BY w.offer_expires_at, w.id LIMIT ?`)
    .bind(nowIso, nowIso, nowIso, nowIso, limit).run();

  await dispatchPendingEventWaitlistOffers(db, { now, sender: params.sender, limit });

  await db.prepare(
    `UPDATE event_waitlist_promotion_jobs
        SET status='completed', completed_at=?, updated_at=?, last_error='tenant_suspended'
      WHERE status IN ('pending','retryable_failed')
        AND available_at <= ?
        AND ${stoppedTenantLineAccountSql('event_waitlist_promotion_jobs.line_account_id')}`,
  ).bind(nowIso, nowIso, nowIso).run();

  const jobs = await db
    .prepare(
      `SELECT id, line_account_id, event_id, slot_id, attempts
         FROM event_waitlist_promotion_jobs
        WHERE status IN ('pending', 'retryable_failed') AND available_at <= ?
          AND ${activeTenantLineAccountSql('event_waitlist_promotion_jobs.line_account_id')}
        ORDER BY available_at ASC, created_at ASC
        LIMIT ?`,
    )
    .bind(nowIso, limit)
    .all<PromotionJobRow>();

  let processed = 0;
  let promoted = 0;
  let retried = 0;
  for (const job of jobs.results ?? []) {
    // 機能オフ中はclaimせずpendingのまま残す。再オンで再開する。
    if (job.line_account_id && !await featureJobCanRun(db, { accountId: job.line_account_id, featureId: 'events', job: 'event waitlist promotions' })) {
      continue;
    }
    // 緊急停止 : reminder_dispatch 停止中は claim せず pending の
    // まま残す。繰り上げ案内は復旧後の tick が届ける。
    if (await isOperationCapabilityStopped(db, job.line_account_id, 'reminder_dispatch')) {
      continue;
    }
    const claimed = await db
      .prepare(
        `UPDATE event_waitlist_promotion_jobs
            SET status = 'processing', attempts = attempts + 1, updated_at = ?, last_error = NULL
          WHERE id = ? AND status IN ('pending', 'retryable_failed')`,
      )
      .bind(nowIso, job.id)
      .run();
    if ((claimed.meta?.changes ?? 0) === 0) continue;
    processed++;
    try {
      const result = await promoteEventWaitlist(db, {
        occurrenceId: job.slot_id,
        lineAccountId: job.line_account_id,
        now,
        sender: params.sender,
      });
      if (result.kind === 'promoted') promoted++;
      if (result.kind === 'noop' && result.reason === 'emergency_stopped') {
        // 緊急停止と競合した分は完了にせず pending へ戻す。
        // 復旧後の tick が席の確保と案内をやり直す。
        await db
          .prepare(
            `UPDATE event_waitlist_promotion_jobs
                SET status = 'pending', updated_at = ?
              WHERE id = ? AND status = 'processing'`,
          )
          .bind(nowIso, job.id)
          .run();
        continue;
      }
      await db
        .prepare(
          `UPDATE event_waitlist_promotion_jobs
              SET status = 'completed', completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'processing'`,
        )
        .bind(nowIso, nowIso, job.id)
        .run();
    } catch (error) {
      retried++;
      const delayMinutes = Math.min(2 ** Math.min(job.attempts, 6), JOB_RETRY_MAX_MINUTES);
      const availableAt = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
      const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown_error';
      await db
        .prepare(
          `UPDATE event_waitlist_promotion_jobs
              SET status = 'retryable_failed', available_at = ?, last_error = ?, updated_at = ?
            WHERE id = ? AND status = 'processing'`,
        )
        .bind(availableAt, message, nowIso, job.id)
        .run();
    }
  }
  return { processed, promoted, retried };
}

function formatJst(utcIso: string): string {
  const jst = japanCalendar(new Date(utcIso)).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 16)}`;
}

// ----------------------------------------------------------------
// 待ちの手動操作（順番の変更・飛ばし）。どちらも理由が必須で、
// 適用口（route 側）が event_change_logs へ残す。
// 順番は sort_order 列で持ち、案内の取り出しも表示も
// (sort_order, created_at) の順に読む。既存行は 0 のままなので、
// 触っていない枠の「先に並んだ人から」は変わらない。
// ----------------------------------------------------------------

export type ReorderWaitlistResult =
  | { kind: 'reordered'; occurrenceVersion: number; order: string[] }
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'invalid'; error: string };

export async function reorderEventWaitlist(
  db: D1Database,
  params: {
    occurrenceId: string;
    lineAccountId: string;
    /** 先頭から順に並べた waiting 行の ID。枠の waiting 全件と一致すること。 */
    orderedIds: string[];
    expectedVersion?: number;
    now?: Date;
  },
): Promise<ReorderWaitlistResult> {
  const nowIso = (params.now ?? new Date()).toISOString();
  const occurrence = await loadOccurrence(db, params.occurrenceId, params.lineAccountId);
  if (!occurrence) return { kind: 'not_found' };
  if (params.expectedVersion != null && params.expectedVersion !== occurrence.version) {
    return { kind: 'conflict', currentVersion: occurrence.version };
  }
  if (!Array.isArray(params.orderedIds) || params.orderedIds.length === 0) {
    return { kind: 'invalid', error: 'ordered_ids_required' };
  }
  if (new Set(params.orderedIds).size !== params.orderedIds.length) {
    return { kind: 'invalid', error: 'duplicate_ids' };
  }
  const rows = await db
    .prepare(`SELECT id FROM event_waitlist WHERE slot_id = ? AND status = 'waiting'`)
    .bind(params.occurrenceId)
    .all<{ id: string }>();
  const current = new Set((rows.results ?? []).map((r) => r.id));
  if (current.size !== params.orderedIds.length
    || params.orderedIds.some((id) => !current.has(id))) {
    return { kind: 'invalid', error: 'ordered_ids_mismatch' };
  }
  /*
   * 版の突き合わせは読み取り時だけでなく、書き込みの条件にも入れる。
   * 読み取り後に別の操作が版を進めると、条件のないUPDATEが完了済みの
   * 順番を上書きし、両方が成功に見える。行の更新と枠の版上げの両方に
   * 同じ期待版を条件付けし、枠の更新が当たらなければ競合として返す。
   * 敗者の行更新も当たらないため、勝者の順番だけが残る。
   */
  const guardVersion = params.expectedVersion ?? null;
  const statements = params.orderedIds.map((id, index) =>
    guardVersion == null
      ? db
        .prepare(
          `UPDATE event_waitlist
              SET sort_order = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND status = 'waiting'`,
        )
        .bind(index + 1, nowIso, id)
      : db
        .prepare(
          `UPDATE event_waitlist
              SET sort_order = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND status = 'waiting'
              AND (SELECT version FROM event_slots WHERE id = ?) = ?`,
        )
        .bind(index + 1, nowIso, id, params.occurrenceId, guardVersion),
  );
  statements.push(
    guardVersion == null
      ? db
        .prepare(`UPDATE event_slots SET version = version + 1, updated_at = ? WHERE id = ?`)
        .bind(nowIso, params.occurrenceId)
      : db
        .prepare(`UPDATE event_slots SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
        .bind(nowIso, params.occurrenceId, guardVersion),
  );
  const results = await db.batch(statements);
  if (guardVersion != null) {
    const slotChanges = results[results.length - 1]?.meta?.changes ?? 0;
    if (slotChanges !== 1) {
      const latest = await loadOccurrence(db, params.occurrenceId, params.lineAccountId);
      return { kind: 'conflict', currentVersion: latest?.version ?? occurrence.version };
    }
  }
  const latest = await loadOccurrence(db, params.occurrenceId, params.lineAccountId);
  return {
    kind: 'reordered',
    occurrenceVersion: latest?.version ?? occurrence.version + 1,
    order: [...params.orderedIds],
  };
}

export type SkipWaitlistResult =
  | { kind: 'skipped'; occurrenceVersion: number; waitlistId: string }
  | { kind: 'not_found' }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'invalid'; error: string };

export async function skipEventWaitlist(
  db: D1Database,
  params: {
    occurrenceId: string;
    waitlistId: string;
    lineAccountId: string;
    expectedVersion?: number;
    now?: Date;
  },
): Promise<SkipWaitlistResult> {
  const nowIso = (params.now ?? new Date()).toISOString();
  const occurrence = await loadOccurrence(db, params.occurrenceId, params.lineAccountId);
  if (!occurrence) return { kind: 'not_found' };
  if (params.expectedVersion != null && params.expectedVersion !== occurrence.version) {
    return { kind: 'conflict', currentVersion: occurrence.version };
  }
  const target = await db
    .prepare(`SELECT id, version FROM event_waitlist
               WHERE id = ? AND slot_id = ? AND status = 'waiting'`)
    .bind(params.waitlistId, params.occurrenceId)
    .first<{ id: string; version: number }>();
  if (!target) return { kind: 'invalid', error: 'waitlist_not_waiting' };
  // 飛ばしは最後尾へ回す（行は消さない・取り消しは status の役目）。
  // 末尾の基準は今の最大値 + 1。並走する手動操作があっても順序が
  // 壊れないよう、条件付き更新で直列化する。
  const maxRow = await db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM event_waitlist WHERE slot_id = ?`)
    .bind(params.occurrenceId)
    .first<{ m: number }>();
  const tail = (maxRow?.m ?? 0) + 1;
  const moved = await db
    .prepare(
      `UPDATE event_waitlist
          SET sort_order = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'waiting' AND version = ?`,
    )
    .bind(tail, nowIso, params.waitlistId, target.version)
    .run();
  if ((moved.meta?.changes ?? 0) === 0) {
    const latest = await loadOccurrence(db, params.occurrenceId, params.lineAccountId);
    return { kind: 'conflict', currentVersion: latest?.version ?? occurrence.version };
  }
  await db
    .prepare(`UPDATE event_slots SET version = version + 1, updated_at = ? WHERE id = ?`)
    .bind(nowIso, params.occurrenceId)
    .run();
  const latest = await loadOccurrence(db, params.occurrenceId, params.lineAccountId);
  return {
    kind: 'skipped',
    occurrenceVersion: latest?.version ?? occurrence.version + 1,
    waitlistId: params.waitlistId,
  };
}

export function createEventWaitlistOfferSender(
  db: D1Database,
  options: { liffUrl?: string },
): EventWaitlistOfferSender {
  return async (offer) => {
    const row = await db
      .prepare(
        `SELECT la.channel_access_token, la.channel_access_token_encrypted, f.line_platform_user_id AS line_user_id
           FROM line_accounts la
           JOIN friends f ON f.id = ? AND f.line_account_id = la.id
          WHERE la.id = ?`,
      )
      .bind(offer.friendId, offer.lineAccountId)
      .first<{
        channel_access_token: string;
        channel_access_token_encrypted: string | null;
        line_user_id: string;
      }>();
    if (
      (!row?.channel_access_token && !row?.channel_access_token_encrypted)
      || !row.line_user_id
    ) {
      throw new Error('waitlist_notification_destination_missing');
    }
    const accessToken = await resolveLineCredential(
      row.channel_access_token_encrypted,
      row.channel_access_token,
      { lineAccountId: offer.lineAccountId, field: 'channel_access_token' },
    );
    const baseUrl = options.liffUrl?.trim();
    const offerUrl = baseUrl
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}eventWaitlistToken=${encodeURIComponent(offer.token)}`
      : null;
    await sendEventBookingNotification({
      delivery: { db, accountId: offer.lineAccountId, operationId: `event-offer:${offer.waitlistId}:${offer.retryKey}`,
        deadlineAt: Date.parse(offer.expiresAt) },
      channelAccessToken: accessToken,
      toLineUserId: row.line_user_id,
      kind: 'waitlist_offer',
      retryKey: offer.retryKey,
      ctx: {
        eventName: offer.eventName,
        startsAtJst: formatJst(offer.startsAt),
        venueName: offer.venueName,
        venueUrl: offer.venueUrl,
        offerExpiresAtJst: formatJst(offer.expiresAt),
        offerUrl,
      },
    });
  };
}
