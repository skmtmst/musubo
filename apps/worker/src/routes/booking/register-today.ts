import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { isCalendarDate as isExistingCalendarDate } from '@line-crm/shared';
import { inputError, inputJsonBoundary } from '../../lib/input-errors.js';
import { requireRole } from '../../middleware/role-guard.js';
import { canTransition, nextStatus } from '../../features/booking/booking-state/index.js';
import { type BookingStatus } from '../../features/booking/booking-types/index.js';
import { recordBookingAudit } from '@line-crm/db';
import { resolveAccountIdAdmin } from './identity.js';
import { jstDateString, getTodaySeatReservations, VISIT_KINDS, VisitKind } from './today-data.js';

export function registerToday(booking: Hono<Env>): void {
booking.get('/api/booking/admin/today', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const rawDate = c.req.query('date')?.trim() || jstDateString(new Date());
  if (!isExistingCalendarDate(rawDate)) {
    return c.json({ error: 'invalid_date' }, 400);
  }
  const mode = c.req.query('mode')?.trim() === 'seat' ? 'seat'
    : c.req.query('mode')?.trim() === 'both' ? 'both' : 'staff';
  // 週・月の席は期間で取る（from/to は店の暦日。無ければ date の1日）。
  const rawFrom = c.req.query('from')?.trim() || null;
  const rawTo = c.req.query('to')?.trim() || null;
  if ((rawFrom && !isExistingCalendarDate(rawFrom)) || (rawTo && !isExistingCalendarDate(rawTo))) {
    return c.json({ error: 'invalid_date' }, 400);
  }
  const rangeStart = rawFrom ?? rawDate;
  const rangeEndExclusive = rawTo ?? rawDate;
  const startIso = new Date(`${rangeStart}T00:00:00+09:00`).toISOString();
  const endIso = new Date(Date.parse(`${rangeEndExclusive}T00:00:00+09:00`) + 86_400_000).toISOString();
  if (Date.parse(endIso) <= Date.parse(startIso)
    || Date.parse(endIso) - Date.parse(startIso) > 35 * 86_400_000) {
    return c.json({ error: 'invalid_date' }, 400);
  }
  const conditions = ['b.line_account_id = ?', 'b.starts_at >= ?', 'b.starts_at < ?'];
  const dayStart = startIso;
  const dayEnd = endIso;
  const values: unknown[] = [accountId, dayStart, dayEnd];
  const status = c.req.query('status')?.trim();
  if (status && ['requested', 'confirmed', 'completed', 'no_show', 'cancelled'].includes(status)) {
    conditions.push('b.status = ?');
    values.push(status);
  } else if (!status) {
    conditions.push(`b.status NOT IN ('cancelled', 'rejected', 'expired')`);
  }
  const staffId = c.req.query('staff_id')?.trim();
  if (staffId) { conditions.push('b.staff_id = ?'); values.push(staffId); }
  const rows = mode === 'seat' ? { results: [] } : await c.env.DB
    .prepare(
      `SELECT b.id, b.line_account_id, b.lock_version, b.starts_at, b.ends_at, b.status, b.price_at_booking,
              b.friend_id, b.booking_customer_id,
              m.id AS menu_id, m.name AS menu_name,
              s.id AS staff_id, s.display_name AS staff_name,
              COALESCE(f.display_name, bc.display_name) AS customer_name
         FROM bookings b
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         LEFT JOIN friends f ON f.id = b.friend_id
         LEFT JOIN booking_customers bc ON bc.id = b.booking_customer_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY b.starts_at ASC LIMIT 200`,
    )
    .bind(...values)
    .all<{
      id: string;
      starts_at: string;
      ends_at: string;
      status: string;
      price_at_booking: number;
      friend_id: string | null;
      booking_customer_id: string | null;
      menu_id: string;
      menu_name: string;
      staff_id: string;
      staff_name: string;
      customer_name: string | null;
    }>();
  const bookings = rows.results ?? [];
  // 最新の印を1件ずつ付ける（だれがいつ付けたか）。
  const marks = new Map<string, {
    kind: string; late_minutes: number | null;
    marked_by_name: string | null; marked_at: string;
  }>();
  if (bookings.length > 0) {
    const marksRows = await c.env.DB
      .prepare(
        `SELECT booking_id, kind, late_minutes, marked_by_name, marked_at
           FROM booking_visit_marks
          WHERE line_account_id = ? AND booking_id IN (${sqlIdSet(bookings.map(booking => booking.id)).sql})
          ORDER BY marked_at DESC`,
      )
      .bind(accountId, ...sqlIdSet(bookings.map(booking => booking.id)).binds)
      .all<{
        booking_id: string;
        kind: string;
        late_minutes: number | null;
        marked_by_name: string | null;
        marked_at: string;
      }>();
    for (const mark of marksRows.results ?? []) {
      if (!marks.has(mark.booking_id)) {
        marks.set(mark.booking_id, {
          kind: mark.kind,
          late_minutes: mark.late_minutes,
          marked_by_name: mark.marked_by_name,
          marked_at: mark.marked_at,
        });
      }
    }
  }
  const staffTimeline = bookings.map((booking) => ({
    kind: 'staff' as const,
    ...booking,
    visit_mark: marks.get(booking.id) ?? null,
  }));
  // 席は飲食店の店だけ（結び付きが無ければ空）。
  const storeId = c.req.query('store_id')?.trim() || null;
  const seatTimeline = mode === 'staff'
    ? []
    : await getTodaySeatReservations(c.env.DB, accountId, dayStart, dayEnd, storeId);
  const timeline = [...staffTimeline, ...seatTimeline]
    .sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0))
    .slice(0, 200);
  // 席の切り替えを出すか（結び付きのある店だけ）。
  const seatStore = await c.env.DB
    .prepare(`SELECT 1 AS ok FROM rt_stores
      WHERE line_account_id = ? AND status = 'active' LIMIT 1`)
    .bind(accountId)
    .first<{ ok: number }>();
  return c.json({
    date: rawDate,
    mode,
    has_seat_stores: Boolean(seatStore?.ok),
    bookings: staffTimeline,
    seats: seatTimeline,
    timeline,
  });
});

/**
 * 今日の予約に印を付ける。「来店した」→完了、「来なかった」→無断、
 * 「遅れる」→状態は変えず遅れ分数だけ残す。だれがいつ付けたか残す。
 */
booking.post('/api/booking/admin/bookings/:id/visit', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const id = c.req.param('id');
  const body = await c.req.json<{ kind?: unknown; late_minutes?: unknown }>().catch(() => null);
  const kind = typeof body?.kind === 'string' && (VISIT_KINDS as readonly string[]).includes(body.kind)
    ? (body.kind as VisitKind)
    : null;
  if (!kind) return inputError(c, { error: 'invalid_kind' }, 400, ["kind"]);
  const lateMinutes = body?.late_minutes === undefined || body?.late_minutes === null
    ? null
    : Number(body.late_minutes);
  if (kind === 'late') {
    if (!Number.isInteger(lateMinutes) || (lateMinutes as number) < 1 || (lateMinutes as number) > 1440) {
      return inputError(c, { error: 'invalid_late_minutes' }, 400, ["late_minutes"]);
    }
  } else if (lateMinutes !== null) {
    return inputError(c, { error: 'late_minutes_not_needed' }, 400, ["late_minutes"]);
  }
  const row = await c.env.DB
    .prepare(`SELECT id, status FROM bookings WHERE id = ? AND line_account_id = ?`)
    .bind(id, accountId)
    .first<{ id: string; status: BookingStatus }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const action = kind === 'visited' ? 'complete' : kind === 'no_show' ? 'no_show' : null;
  let next = row.status;
  if (action) {
    if (!canTransition(row.status, action)) {
      return c.json({ error: 'invalid_transition' }, 409);
    }
    next = nextStatus(row.status, action);
    const updated = await c.env.DB
      .prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status = ?, decided_at = ?, lock_version = lock_version + 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE id = ? AND status = ?`)
      .bind(next, new Date().toISOString(), id, row.status)
      .run();
    if ((updated.meta?.changes ?? 0) === 0) {
      return c.json({ error: 'concurrent_update' }, 409);
    }
  } else if (row.status === 'cancelled' || row.status === 'rejected' || row.status === 'expired'
    || row.status === 'completed' || row.status === 'no_show') {
    return c.json({ error: 'already_closed' }, 409);
  }
  const me = c.get('staff') as { id?: string; name?: string } | undefined;
  const markedAt = new Date().toISOString();
  const markId = crypto.randomUUID();
  await c.env.DB
    .prepare(`INSERT INTO booking_visit_marks
      (id, booking_id, line_account_id, kind, late_minutes,
       marked_by_staff_id, marked_by_name, marked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, id, accountId, kind, lateMinutes,
      typeof me?.id === 'string' ? me.id : null,
      typeof me?.name === 'string' ? me.name : null,
      markedAt)
    .run();
  await recordBookingAudit(c.env.DB, {
    bookingId: id,
    lineAccountId: accountId,
    action: 'visit_marked',
    before: { status: row.status },
    after: { status: next, visit_kind: kind, late_minutes: lateMinutes },
    reason: 'today_visit_mark',
    actorType: 'staff',
    actorId: typeof me?.id === 'string' ? me.id : null,
    actorName: typeof me?.name === 'string' ? me.name : null,
    occurredAt: markedAt,
  });
  return c.json({
    status: next,
    visit_mark: {
      id: markId,
      kind,
      late_minutes: lateMinutes,
      marked_by_name: typeof me?.name === 'string' ? me.name : null,
      marked_at: markedAt,
    },
  });
});

/**
 * 今日の予約の印を取り消す（「取り消す」・知らせの「元に戻す」）。
 *
 * 最新の印を1件消す。印が状態を変えていた（来店→完了・来なかった→無断）
 * ときは確定へ戻す。遅れるは印を消すだけ。
 */
booking.delete('/api/booking/admin/bookings/:id/visit', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const id = c.req.param('id');
  const mark = await c.env.DB
    .prepare(`SELECT id, kind FROM booking_visit_marks
      WHERE booking_id = ? AND line_account_id = ?
      ORDER BY marked_at DESC LIMIT 1`)
    .bind(id, accountId)
    .first<{ id: string; kind: string }>();
  if (!mark) return c.json({ error: 'not_found' }, 404);
  const row = await c.env.DB
    .prepare(`SELECT status FROM bookings WHERE id = ? AND line_account_id = ?`)
    .bind(id, accountId)
    .first<{ status: BookingStatus }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  let next = row.status;
  if (mark.kind === 'visited' && row.status === 'completed') next = 'confirmed';
  else if (mark.kind === 'no_show' && row.status === 'no_show') next = 'confirmed';
  else if (mark.kind !== 'late') return c.json({ error: 'status_changed' }, 409);
  if (next !== row.status) {
    const updated = await c.env.DB
      .prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status = ?, lock_version = lock_version + 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE id = ? AND status = ?`)
      .bind(next, id, row.status)
      .run();
    if ((updated.meta?.changes ?? 0) === 0) {
      return c.json({ error: 'concurrent_update' }, 409);
    }
  }
  await c.env.DB
    .prepare(`DELETE FROM booking_visit_marks WHERE id = ?`)
    .bind(mark.id)
    .run();
  const me = c.get('staff') as { id?: string; name?: string } | undefined;
  await recordBookingAudit(c.env.DB, {
    bookingId: id,
    lineAccountId: accountId,
    action: 'visit_unmarked',
    before: { status: row.status, visit_kind: mark.kind },
    after: { status: next },
    reason: 'today_visit_unmark',
    actorType: 'staff',
    actorId: typeof me?.id === 'string' ? me.id : null,
    actorName: typeof me?.name === 'string' ? me.name : null,
    occurredAt: new Date().toISOString(),
  });
  return c.json({ status: next });
});
}
