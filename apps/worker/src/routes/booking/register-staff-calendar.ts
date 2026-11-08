import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { inputError, inputJsonBoundary } from '../../lib/input-errors.js';
import { verifyStaffCalendarConnection } from '../../features/booking/booking-calendar-sync/index.js';
import { requireOwnBookingStaffOrAdmin, resolveAccountIdAdmin, assertStaffInAccount } from './identity.js';
import { googleCredentials, isValidShiftDate, isValidTimeRange } from './availability.js';

export function registerStaffCalendar(booking: Hono<Env>): void {
booking.get('/api/booking/admin/staff/:id/google-calendar', requireOwnBookingStaffOrAdmin(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const staffId = c.req.param('id');
  if (!(await assertStaffInAccount(c.env.DB, staffId, accountId))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  const connection = await c.env.DB
    .prepare(
      `SELECT id, calendar_id, auth_type, is_active, last_verified_at, last_error
         FROM google_calendar_connections
        WHERE line_account_id = ? AND staff_id = ? AND is_active = 1
        LIMIT 1`,
    )
    .bind(accountId, staffId)
    .first();
  return c.json({
    connection,
    service_account: {
      configured: Boolean(
        c.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && c.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      ),
      email: c.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null,
    },
  });
});

booking.put('/api/booking/admin/staff/:id/google-calendar', requireOwnBookingStaffOrAdmin(), inputJsonBoundary({"calendar_id":["string"]}), async (c) => {
  if(c.get('impersonation'))return c.json({error:'IMPERSONATION_WRITE_BLOCKED'},403);
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const staffId = c.req.param('id');
  if (!(await assertStaffInAccount(c.env.DB, staffId, accountId))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  const body = await c.req.json<{ calendar_id?: string }>();
  const calendarId = body.calendar_id?.trim();
  if (!calendarId || calendarId.length > 1024 || /[\r\n]/.test(calendarId)) {
    return inputError(c, { error: 'invalid_calendar_id' }, 422, ["calendar_id"]);
  }
  const existing = await c.env.DB
    .prepare(
      `SELECT id FROM google_calendar_connections
        WHERE line_account_id = ? AND staff_id = ? LIMIT 1`,
    )
    .bind(accountId, staffId)
    .first<{ id: string }>();
  const connectionId = existing?.id ?? crypto.randomUUID();
  try {
    await verifyStaffCalendarConnection({
      id: connectionId,
      calendar_id: calendarId,
      auth_type: 'service_account',
      access_token: null,
    }, googleCredentials(c.env), {db:c.env.DB,accountId});
  } catch (error) {
    logger.error("booking.admin_staff_by_id_google_calendar_update_failed");
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'google_service_account_not_configured' ? 503 : 422;
    return inputError(c, { error: status === 503 ? 'service_account_not_configured' : 'calendar_not_accessible' }, status, []);
  }
  const now = new Date().toISOString();
  if (existing) {
    await c.env.DB
      .prepare(
        `UPDATE google_calendar_connections
            SET calendar_id = ?, auth_type = 'service_account', is_active = 1,
                last_verified_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND line_account_id = ? AND staff_id = ?`,
      )
      .bind(calendarId, now, now, connectionId, accountId, staffId)
      .run();
  } else {
    await c.env.DB
      .prepare(
        `INSERT INTO google_calendar_connections
          (id, calendar_id, line_account_id, staff_id, auth_type, is_active,
           last_verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'service_account', 1, ?, ?, ?)`,
      )
      .bind(connectionId, calendarId, accountId, staffId, now, now, now)
      .run();
  }
  return c.json({ ok: true, calendar_id: calendarId, last_verified_at: now });
});

booking.delete('/api/booking/admin/staff/:id/google-calendar', requireOwnBookingStaffOrAdmin(), async (c) => {
  if(c.get('impersonation'))return c.json({error:'IMPERSONATION_WRITE_BLOCKED'},403);
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const staffId = c.req.param('id');
  if (!(await assertStaffInAccount(c.env.DB, staffId, accountId))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  await c.env.DB
    .prepare(
      `UPDATE google_calendar_connections
          SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE line_account_id = ? AND staff_id = ? AND is_active = 1`,
    )
    .bind(accountId, staffId)
    .run();
  return c.json({ ok: true });
});

booking.get('/api/booking/admin/staff/:id/shifts', requireOwnBookingStaffOrAdmin(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const staffId = c.req.param('id');
  if (!(await assertStaffInAccount(c.env.DB, staffId, accountId))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  const from = c.req.query('from');
  const to = c.req.query('to');
  const sql = from && to
    ? `SELECT id, work_date, start_time, end_time, is_responsible
         FROM staff_shifts
        WHERE staff_id = ? AND work_date BETWEEN ? AND ?
        ORDER BY work_date ASC`
    : `SELECT id, work_date, start_time, end_time, is_responsible
         FROM staff_shifts
        WHERE staff_id = ?
        ORDER BY work_date ASC`;
  const stmt = c.env.DB.prepare(sql);
  const rows = await (from && to ? stmt.bind(staffId, from, to) : stmt.bind(staffId)).all();
  return c.json({ shifts: rows.results });
});

booking.put('/api/booking/admin/staff/:id/shifts', requireOwnBookingStaffOrAdmin(), inputJsonBoundary({"shifts":["array"]}), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const staffId = c.req.param('id');
  if (!(await assertStaffInAccount(c.env.DB, staffId, accountId))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  const b = await c.req.json<{
    shifts?: Array<{ work_date: string; start_time: string; end_time: string; is_responsible?: boolean }>;
  }>().catch(() => null);
  if (!b || !Array.isArray(b.shifts)) return inputError(c, { error: 'shifts_must_be_an_array' }, 400, ["shifts"]);
  if(b.shifts.some(s=>s.is_responsible!==undefined&&typeof s.is_responsible!=='boolean'))return inputError(c, {error:'責任者の指定を確認してください'}, 400, ["shifts"]);
  if(b.shifts.some(s=>s.is_responsible!==undefined)&&!['owner','admin'].includes(c.get('staff')?.role??'')&&c.get('staff')?.hqRole!=='operator')return c.json({error:'責任者を指定できるのは管理者か統括の担当者です'},403);
  if (b.shifts.length > 366) return inputError(c, { error: 'too_many_shifts' }, 400, ["shifts"]);
  const invalid = b.shifts.find((shift) => (
    !isValidShiftDate(shift.work_date)
    || !isValidTimeRange(shift.start_time, shift.end_time)
  ));
  if (invalid) return inputError(c, { error: 'invalid_shift_date_or_time' }, 400, ["shifts"]);

  const statements = b.shifts.map((s) => (
    c.env.DB.prepare(
        `INSERT INTO staff_shifts (id, staff_id, work_date, start_time, end_time, is_responsible)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(staff_id, work_date) DO UPDATE
            SET start_time = excluded.start_time,
                end_time = excluded.end_time,
                is_responsible = CASE WHEN ? IS NULL THEN staff_shifts.is_responsible ELSE excluded.is_responsible END,
                updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')`,
      )
      .bind(crypto.randomUUID(), staffId, s.work_date, s.start_time, s.end_time,Number(s.is_responsible??false),s.is_responsible===undefined?null:Number(s.is_responsible))
  ));
  if (statements.length > 0) await c.env.DB.batch(statements);
  return c.json({ ok: true, count: b.shifts.length });
});

booking.delete('/api/booking/admin/staff/:id/shifts/:shiftId', requireOwnBookingStaffOrAdmin(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const staffId = c.req.param('id');
  if (!(await assertStaffInAccount(c.env.DB, staffId, accountId))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  const shiftId = c.req.param('shiftId');
  await c.env.DB
    .prepare(`DELETE FROM staff_shifts WHERE id = ? AND staff_id = ?`)
    .bind(shiftId, staffId)
    .run();
  return c.json({ ok: true });
});

booking.post('/api/booking/admin/staff/:id/shifts/generate', requireOwnBookingStaffOrAdmin(), inputJsonBoundary({"weekly_template":["object"]}), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const staffId = c.req.param('id');
  if (!(await assertStaffInAccount(c.env.DB, staffId, accountId))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  const b = await c.req.json<{
    from_date?: unknown;
    weeks?: unknown;
    weekly_template?: Record<
      'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat',
      { start: string; end: string } | null
    >;
  }>().catch(() => null);
  if (!b || !isValidShiftDate(b.from_date) || !Number.isInteger(b.weeks)
    || Number(b.weeks) < 1 || Number(b.weeks) > 12 || !b.weekly_template
    || typeof b.weekly_template !== 'object' || Array.isArray(b.weekly_template)) {
    return inputError(c, { error: 'missing_params' }, 400, ["from_date","weeks","weekly_template"]);
  }
  const weeklyTemplate = b.weekly_template;
  const dayKeys: Array<keyof typeof weeklyTemplate> = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  for (const day of dayKeys) {
    const template = weeklyTemplate[day];
    if (template !== null && template !== undefined
      && (!template || typeof template !== 'object'
        || !isValidTimeRange(template.start, template.end))) {
      return inputError(c, { error: 'invalid_weekly_template' }, 400, ["weekly_template"]);
    }
  }
  const start = new Date(`${b.from_date}T00:00:00Z`);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < Number(b.weeks) * 7; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const tpl = weeklyTemplate[dayKeys[d.getUTCDay()]];
    if (!tpl) continue;
    stmts.push(
      c.env.DB
        .prepare(
          `INSERT INTO staff_shifts (id, staff_id, work_date, start_time, end_time)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(staff_id, work_date) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), staffId, d.toISOString().slice(0, 10), tpl.start, tpl.end),
    );
  }
  if (stmts.length === 0) return c.json({ inserted: 0 });
  const results = await c.env.DB.batch(stmts);
  return c.json({ inserted: results.reduce((count, result) => count + Number(result.meta?.changes ?? 0), 0) });
});
}
