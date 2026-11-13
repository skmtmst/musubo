import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { inputError, inputJsonBoundary } from '../../lib/input-errors.js';
import { requireRole } from '../../middleware/role-guard.js';
import { finishExpiredWaitlists, promoteBookingWaitlist } from '../../features/booking/booking-waitlist/index.js';
import { resolveAccountIdAdmin } from './identity.js';
import { insertWaitlistEntry, WAITLIST_ERROR_STATUS, WaitlistEntryLike } from './waitlist-input.js';

export function registerWaitlistAdmin(booking: Hono<Env>): void {
booking.post('/api/booking/admin/waitlist', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return inputError(c, { error: 'invalid_json' }, 400, []);
  const result = await insertWaitlistEntry(c.env.DB, {
    lineAccountId: accountId,
    staffId: typeof body.staff_id === 'string' ? body.staff_id : '',
    menuId: typeof body.menu_id === 'string' ? body.menu_id : '',
    startsAt: typeof body.starts_at === 'string' ? body.starts_at : '',
    friendId: typeof body.friend_id === 'string' && body.friend_id.trim() ? body.friend_id.trim() : null,
    bookingCustomerId: typeof body.booking_customer_id === 'string' && body.booking_customer_id.trim()
      ? (body.booking_customer_id as string).trim()
      : null,
  });
  if (!result.ok) return inputError(c, { error: result.error }, WAITLIST_ERROR_STATUS[result.error] as 400 | 404 | 409, []);
  const entry = await c.env.DB
    .prepare(`SELECT * FROM booking_waitlist WHERE id = ?`)
    .bind(result.id)
    .first();
  return c.json({ waitlist: entry }, 201);
});

booking.get('/api/booking/admin/waitlist', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  await finishExpiredWaitlists(c.env.DB,accountId);
  const conditions = ['w.line_account_id = ?'];
  const values: unknown[] = [accountId];
  const staffId = c.req.query('staff_id')?.trim();
  if (staffId) { conditions.push('w.staff_id = ?'); values.push(staffId); }
  const startsAt = c.req.query('starts_at')?.trim();
  if (startsAt) {
    const startsAtMs = Date.parse(startsAt);
    if (Number.isNaN(startsAtMs)) return c.json({ error: 'invalid_starts_at' }, 400);
    conditions.push('w.starts_at = ?');
    values.push(new Date(startsAtMs).toISOString());
  }
  const status = c.req.query('status')?.trim();
  if (status && ['waiting', 'invited', 'converted', 'cancelled','finished'].includes(status)) {
    conditions.push('w.status = ?'); values.push(status);
  }
  const rows = await c.env.DB
    .prepare(
      `SELECT w.*, CASE WHEN w.status='waiting' THEN (SELECT count(*) FROM booking_waitlist older WHERE older.line_account_id=w.line_account_id AND older.staff_id=w.staff_id AND julianday(older.starts_at)=julianday(w.starts_at) AND older.status='waiting' AND (older.created_at<w.created_at OR older.created_at=w.created_at AND older.id<=w.id)) ELSE NULL END AS position, m.name AS menu_name, s.display_name AS staff_name,
              COALESCE(f.display_name, bc.display_name) AS customer_name
         FROM booking_waitlist w
         INNER JOIN menus m ON m.id = w.menu_id
         INNER JOIN staff s ON s.id = w.staff_id
         LEFT JOIN friends f ON f.id = w.friend_id
         LEFT JOIN booking_customers bc ON bc.id = w.booking_customer_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY w.starts_at ASC, w.created_at ASC LIMIT 100`,
    )
    .bind(...values)
    .all();
  const slots=await c.env.DB.prepare(`SELECT staff_id,starts_at,SUM(status='waiting') waiting,SUM(status='invited') invited,SUM(status IN ('finished','converted','cancelled')) finished FROM booking_waitlist WHERE line_account_id=? GROUP BY staff_id,starts_at ORDER BY starts_at DESC LIMIT 100`).bind(accountId).all();
  const seats=await c.env.DB.prepare(`SELECT w.store_id,w.starts_at,SUM(w.status='waiting') waiting,SUM(w.status='invited') invited,SUM(w.status IN ('finished','converted','cancelled')) finished FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id WHERE s.line_account_id=? GROUP BY w.store_id,w.starts_at ORDER BY w.starts_at DESC LIMIT 100`).bind(accountId).all();
  return c.json({waitlist:rows.results,slots:slots.results,seatSlots:seats.results,seatWaitlist:(await c.env.DB.prepare(`SELECT w.*,s.name store_name FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id WHERE s.line_account_id=? ORDER BY w.starts_at DESC,w.created_at LIMIT 100`).bind(accountId).all()).results});
});

booking.delete('/api/booking/admin/waitlist/:id', requireRole('owner', 'admin', 'staff'), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const id = c.req.param('id');
  if(c.req.query('kind')==='seat'){
   const result=await c.env.DB.prepare(`UPDATE rt_seat_waitlist SET confirmation_revision=confirmation_revision+1, status='cancelled',updated_at=? WHERE id=? AND status IN ('waiting','invited') AND store_id IN (SELECT id FROM rt_stores WHERE line_account_id=?)`).bind(new Date().toISOString(),id,accountId).run();
   return result.meta.changes?c.json({status:'cancelled'}):c.json({error:'not_found'},404);
  }

  const entry = await c.env.DB
    .prepare(`SELECT staff_id, starts_at, status FROM booking_waitlist
      WHERE id = ? AND line_account_id = ?`)
    .bind(id, accountId)
    .first<{ staff_id: string; starts_at: string; status: string }>();
  if (!entry) return c.json({ error: 'not_found' }, 404);
  if (entry.status !== 'waiting' && entry.status !== 'invited') {
    return c.json({ error: 'already_closed' }, 409);
  }
  const wasInvited = entry.status === 'invited';
  const updated = await c.env.DB
    .prepare(`UPDATE booking_waitlist SET status = 'cancelled',
                  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
      WHERE id = ? AND status IN ('waiting', 'invited')`)
    .bind(id)
    .run();
  if ((updated.meta?.changes ?? 0) === 0) return c.json({ error: 'already_closed' }, 409);
  if (wasInvited) {
    try {
      await promoteBookingWaitlist(c.env.DB, {
        lineAccountId: accountId,
        staffId: entry.staff_id,
        startsAt: entry.starts_at,
      }, undefined, c.env.LIFF_URL ?? '',c.env);
    } catch {
      logger.error("booking.promote_waitlist_failed");
    }
  }
  return c.json({ status: 'cancelled' });
});

/**
 * 招待ずみの人が予約を取ったとき、待ちを「予約になった」へ進める。
 * 同じ枠・同じ人の予約だけ受け付ける。
 */
booking.post('/api/booking/admin/waitlist/:id/convert', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const id = c.req.param('id');
  const body = await c.req.json<{ booking_id?: unknown }>().catch(() => null);
  const bookingId = typeof body?.booking_id === 'string' ? body.booking_id : '';
  if (!bookingId) return inputError(c, { error: 'missing_booking_id' }, 400, ["booking_id"]);
  const entry = await c.env.DB
    .prepare(`SELECT * FROM booking_waitlist WHERE id = ? AND line_account_id = ?`)
    .bind(id, accountId)
    .first<WaitlistEntryLike>();
  if (!entry) return c.json({ error: 'not_found' }, 404);
  if(entry.status!=='invited'||!entry.hold_expires_at||Date.parse(entry.hold_expires_at)<=Date.now()) {
    return c.json({ error: 'already_closed' }, 409);
  }
  const booking = await c.env.DB
    .prepare(`SELECT staff_id,menu_id, starts_at, friend_id, booking_customer_id FROM bookings
      WHERE id = ? AND line_account_id = ? AND status NOT IN ('cancelled', 'rejected', 'expired')`)
    .bind(bookingId, accountId)
    .first<{ staff_id: string; menu_id:string; starts_at: string; friend_id: string | null; booking_customer_id: string | null }>();
  if (!booking
    || booking.menu_id !== entry.menu_id
    || booking.staff_id !== entry.staff_id
    || booking.starts_at !== entry.starts_at
    || booking.friend_id !== entry.friend_id
    || booking.booking_customer_id !== entry.booking_customer_id) {
    return c.json({ error: 'booking_mismatch' }, 409);
  }
  const updated=await c.env.DB
    .prepare(`UPDATE booking_waitlist SET status = 'converted',
                  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
      WHERE id = ? AND status='invited' AND julianday(hold_expires_at)>julianday('now')`)
    .bind(id)
    .run();
  if(!updated.meta.changes)return c.json({error:'offer_expired'},409);
  return c.json({ status: 'converted' });
});
}
