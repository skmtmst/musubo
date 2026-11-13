import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { bad } from '../../services/event-input-error.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { requireRole } from '../../middleware/role-guard.js';
import { buildOffsetListResponse, parseOffsetPaging } from '../../lib/list-paging.js';
import { getEventOccurrenceUsedSeats } from '../../services/event-waitlist.js';
import { getAccountId } from './input.js';
import { ownsEvent } from './slot-input.js';

export function registerAdminBookings(events: Hono<Env>): void {
events.delete('/api/events/admin/events/:id/slots/:slotId', requireRole('owner', 'admin'), async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400, []);
  const event_id = c.req.param('id');
  const slot_id = c.req.param('slotId');
  if (!(await ownsEvent(c.env.DB, event_id, account_id))) return bad(c, 'not_found', 404);
  const slot = await c.env.DB
    .prepare(`SELECT id FROM event_slots WHERE id = ? AND event_id = ? AND deleted_at IS NULL`)
    .bind(slot_id, event_id)
    .first<{ id: string }>();
  if (!slot) return bad(c, 'not_found', 404);
  const usedSeats = await getEventOccurrenceUsedSeats(c.env.DB, slot_id);
  if (usedSeats > 0) return bad(c, 'slot_has_bookings', 409);
  const now = new Date().toISOString();
  await c.env.DB
    .prepare(`UPDATE event_slots SET version = version + 1, deleted_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, slot_id)
    .run();
  return new Response(null, { status: 204 });
});

// ============================================================
// Admin: bookings management
// ============================================================

events.get('/api/events/admin/events/notifications/pending', async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400);
  const row = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS c
         FROM event_bookings
        WHERE line_account_id = ? AND status = 'requested'`,
    )
    .bind(account_id)
    .first<{ c: number }>();
  return c.json({ count: row?.c ?? 0 });
});

events.get('/api/events/admin/events/:id/bookings', async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400);
  const event_id = c.req.param('id');
  if (!(await ownsEvent(c.env.DB, event_id, account_id))) return bad(c, 'not_found', 404);
  const status = c.req.query('status');
  const slot_id = c.req.query('slot_id');
  const conditions = ['b.event_id = ?'];
  const params: unknown[] = [event_id];
  if (status) {
    conditions.push('b.status = ?');
    params.push(status);
  }
  if (slot_id) {
    conditions.push('b.slot_id = ?');
    params.push(slot_id);
  }
  // 申込が増えても一覧が重くならないよう、共通一覧契約(offset方式)で切る。
  // 並びは固定し、同刻は id で一意にする。
  const paging = parseOffsetPaging(
    { page: c.req.query('page'), limit: c.req.query('limit') },
    { defaultLimit: 200, maxLimit: 200 },
  );
  const fromWhere = `FROM event_bookings b
         JOIN event_slots s ON s.id = b.slot_id
         LEFT JOIN friends f ON f.id = b.friend_id
        WHERE ${conditions.join(' AND ')}`;
  const counted = await c.env.DB
    .prepare(`SELECT COUNT(*) AS c ${fromWhere}`)
    .bind(...params)
    .first<{ c: number }>();
  const { results } = await c.env.DB
    .prepare(
      `SELECT b.*,
              s.starts_at AS slot_starts_at, s.ends_at AS slot_ends_at,
              f.display_name AS friend_display_name, f.line_user_id AS friend_line_user_id
         ${fromWhere}
        ORDER BY b.requested_at DESC, b.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...params, paging.limit, paging.offset)
    .all<{ id: string } & Record<string, unknown>>();
  // 各予約に紐づく通知予定 (前日・開始前) を同じ応答で返す。
  // 開催回の移動や取消で止まった分も status で返し、変更前後と残存を
  // 画面から確かめられるようにする。表示中のページ分だけを1回で取る。
  const bookingIds = (results ?? []).map((row) => row.id);
  const remindersByBooking = new Map<string, Array<{
    kind: string;
    scheduled_at: string;
    sent_at: string | null;
    status: string;
  }>>();
  if (bookingIds.length > 0) {
    const reminderRows = await c.env.DB
      .prepare(
        `SELECT booking_id, kind, scheduled_at, sent_at, status
           FROM event_booking_reminders
          WHERE booking_id IN (${sqlIdSet(bookingIds).sql})
          ORDER BY scheduled_at ASC`,
      )
      .bind(...(bookingIds.length ? sqlIdSet(bookingIds).binds : []))
      .all<{
        booking_id: string;
        kind: string;
        scheduled_at: string;
        sent_at: string | null;
        status: string;
      }>();
    for (const reminder of reminderRows.results ?? []) {
      const list = remindersByBooking.get(reminder.booking_id) ?? [];
      list.push({
        kind: reminder.kind,
        scheduled_at: reminder.scheduled_at,
        sent_at: reminder.sent_at,
        status: reminder.status,
      });
      remindersByBooking.set(reminder.booking_id, list);
    }
  }
  return c.json(buildOffsetListResponse({
    items: (results ?? []).map((row) => ({
      ...row,
      reminders: remindersByBooking.get(row.id) ?? [],
    })),
    total: counted?.c ?? 0,
    paging,
    sort: [
      { field: 'requested_at', direction: 'desc' },
      { field: 'id', direction: 'desc' },
    ],
  }));
});

events.get('/api/events/admin/events/:id/bookings/summary', async (c) => {
  const account_id = getAccountId(c);
  if (!account_id) return bad(c, 'account_id_required', 400);
  const event_id = c.req.param('id');
  if (!(await ownsEvent(c.env.DB, event_id, account_id))) return bad(c, 'not_found', 404);

  const bookingCounts = await c.env.DB
    .prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'requested' THEN 1 ELSE 0 END) AS requested_count,
      SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired_count,
      SUM(CASE WHEN status = 'attended' THEN 1 ELSE 0 END) AS attended_count,
      SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS no_show_count,
      /*
       * IDEA-29: 人数(party_size)の内訳。行数だと複数人申込で
       * 定員の残りと食い違うため、席を消費する単位でも返す。
       */
      COALESCE(SUM(CASE WHEN status = 'requested' THEN party_size ELSE 0 END), 0) AS requested_seats,
      COALESCE(SUM(CASE WHEN status = 'confirmed' THEN party_size ELSE 0 END), 0) AS confirmed_seats
      FROM event_bookings WHERE event_id = ?`)
    .bind(event_id)
    .first<Record<string, number | null>>();
  const waitlist = await c.env.DB
    .prepare(`SELECT
      COUNT(*) AS c,
      COALESCE(SUM(CASE WHEN status = 'waiting' THEN party_size ELSE 0 END), 0) AS waiting_seats,
      COALESCE(SUM(CASE WHEN status IN ('offered','accepted') THEN party_size ELSE 0 END), 0) AS offered_seats
      FROM event_waitlist WHERE event_id = ? AND status IN ('waiting','offered','accepted')`)
    .bind(event_id)
    .first<{ c: number; waiting_seats: number; offered_seats: number }>();
  const capacity = await c.env.DB
    .prepare(`SELECT
      COUNT(*) AS slot_count,
      SUM(CASE WHEN capacity IS NULL THEN 1 ELSE 0 END) AS uncapped_count,
      SUM(capacity) AS total_capacity
      FROM event_slots WHERE event_id = ? AND deleted_at IS NULL AND is_active = 1`)
    .bind(event_id)
    .first<{ slot_count: number; uncapped_count: number; total_capacity: number | null }>();

  return c.json({
    total: bookingCounts?.total ?? 0,
    requested: bookingCounts?.requested_count ?? 0,
    confirmed: bookingCounts?.confirmed_count ?? 0,
    rejected: bookingCounts?.rejected_count ?? 0,
    cancelled: bookingCounts?.cancelled_count ?? 0,
    expired: bookingCounts?.expired_count ?? 0,
    attended: bookingCounts?.attended_count ?? 0,
    noShow: bookingCounts?.no_show_count ?? 0,
    waitlist: waitlist?.c ?? 0,
    requestedSeats: bookingCounts?.requested_seats ?? 0,
    confirmedSeats: bookingCounts?.confirmed_seats ?? 0,
    waitingSeats: waitlist?.waiting_seats ?? 0,
    offeredSeats: waitlist?.offered_seats ?? 0,
    // 席を消費中の人数 = 申込(requested/confirmed) + 保留中の案内(offered/accepted)。
    // 待機中は席を消費しないので残席の計算に入れない。
    activeSeats: (bookingCounts?.requested_seats ?? 0)
      + (bookingCounts?.confirmed_seats ?? 0)
      + (waitlist?.offered_seats ?? 0),
    totalCapacity: !capacity?.slot_count || capacity.uncapped_count > 0
      ? null
      : capacity.total_capacity,
  });
});
}
