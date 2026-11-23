import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { gapWrite, GapError } from '../../services/gap-common.js';
import { inputError, inputJsonBoundary } from '../../lib/input-errors.js';
import { parseBookingStaffInput, BOOKING_SETTINGS_KEY, BOOKING_MENUS_KEY } from '@line-crm/shared';
import { requirePermission } from '../../middleware/role-guard.js';
import { resolveAccountIdAdmin, assertStaffInAccount } from './identity.js';
import { staffMenusReplaceStatements, StaffMenuAssignment } from './staff-input.js';
import { queueDeletedMeetingConnections,queueDeletedGoogleCalendars } from '@line-crm/db';

export function registerStaff(booking: Hono<Env>): void {
booking.get('/api/booking/admin/staff', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const rows = await c.env.DB
    .prepare(
      `SELECT id, name, display_name, role, profile_image_url, bio,
              sort_order, is_designation_optional, is_active, staff_member_id,nomination_fee
         FROM staff
        WHERE line_account_id = ? AND deleted_at IS NULL
        ORDER BY sort_order ASC, id ASC`,
    )
    .bind(accountId)
    .all();
  return c.json({ staff: rows.results });
});

//  本人勤務: ログイン中のスタッフに紐づく予約スタッフを返す。
// account_id 指定時はそのアカウントの1件、省略時は紐づく全件。
booking.get('/api/booking/admin/staff/me', async (c) => {
  const me = c.get('staff');
  if (!me) return c.json({ error: 'Unauthorized' }, 401);
  const accountId = c.req.query('account_id')?.trim() || null;
  const rows = accountId
    ? await c.env.DB
        .prepare(
          `SELECT id, name, display_name, role, profile_image_url, bio,
                  sort_order, is_designation_optional, is_active,nomination_fee
             FROM staff
            WHERE line_account_id = ? AND staff_member_id = ? AND deleted_at IS NULL
            ORDER BY sort_order ASC, id ASC`,
        )
        .bind(accountId, me.id)
        .all()
    : await c.env.DB
        .prepare(
          `SELECT id, line_account_id, name, display_name, role, profile_image_url, bio,
                  sort_order, is_designation_optional, is_active
             FROM staff
            WHERE staff_member_id = ? AND deleted_at IS NULL
            ORDER BY sort_order ASC, id ASC`,
        )
        .bind(me.id)
        .all();
  return c.json({ staff: rows.results });
});

booking.post('/api/booking/admin/staff', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const raw = await c.req.json<unknown>().catch(() => null);
  if (raw === null) return inputError(c, { error: 'invalid_json' }, 400, []);
  const parsed = parseBookingStaffInput(raw, 'create');
  if (!parsed.ok) {
    return inputError(c, {
      code: 'booking_staff_validation_failed',
      error: parsed.error,
      field: parsed.field,
    }, 422, []);
  }
  const b = parsed.value;
  if(b.nominationFee!==undefined)gapWrite(c,{admin:true});
  if (b.staff_member_id) {
    const member = await c.env.DB
      .prepare(`SELECT 1 AS ok FROM staff_members WHERE id = ? AND is_active = 1`)
      .bind(b.staff_member_id)
      .first<{ ok: number }>();
    if (!member) {
      return inputError(c, {
        code: 'booking_staff_validation_failed',
        error: '紐づけるログインユーザーが見つかりません',
        field: 'staff_member_id',
      }, 422, ["staff_member_id"]);
    }
  }
  const id = crypto.randomUUID();
  await c.env.DB
    .prepare(
      `INSERT INTO staff
        (id, line_account_id, name, display_name, role, profile_image_url, bio,
         sort_order, is_designation_optional, is_active, staff_member_id,nomination_fee)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id,
      accountId,
      b.name!,
      b.display_name!,
      b.role!,
      b.profile_image_url!,
      b.bio!,
      b.sort_order!,
      b.is_designation_optional!,
      b.is_active!,
      b.staff_member_id ?? null,
      b.nominationFee??0,
    )
    .run();
  return c.json({ id }, 201);
});

booking.put('/api/booking/admin/staff/:id', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const id = c.req.param('id');
  const raw = await c.req.json<unknown>().catch(() => null);
  if (raw === null) return inputError(c, { error: 'invalid_json' }, 400, []);
  const parsed = parseBookingStaffInput(raw, 'update');
  if (!parsed.ok) {
    return inputError(c, {
      code: 'booking_staff_validation_failed',
      error: parsed.error,
      field: parsed.field,
    }, 422, []);
  }
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  const fee=(raw as Record<string,unknown>).nominationFee;
  if(fee!==undefined){gapWrite(c,{admin:true});if(!Number.isSafeInteger(fee)||Number(fee)<0||Number(fee)>10000000)throw new GapError('invalid_nomination_fee');updates.push('nomination_fee = ?');values.push(Number(fee));}
  for (const [field, column] of [
    ['name', 'name'],
    ['display_name', 'display_name'],
    ['role', 'role'],
    ['profile_image_url', 'profile_image_url'],
    ['bio', 'bio'],
    ['sort_order', 'sort_order'],
    ['is_designation_optional', 'is_designation_optional'],
    ['is_active', 'is_active'],
    ['staff_member_id', 'staff_member_id'],
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(parsed.value, field)) {
      updates.push(`${column} = ?`);
      values.push(parsed.value[field]!);
    }
  }
  if (parsed.value.staff_member_id) {
    const member = await c.env.DB
      .prepare(`SELECT 1 AS ok FROM staff_members WHERE id = ? AND is_active = 1`)
      .bind(parsed.value.staff_member_id)
      .first<{ ok: number }>();
    if (!member) {
      return inputError(c, {
        code: 'booking_staff_validation_failed',
        error: '紐づけるログインユーザーが見つかりません',
        field: 'staff_member_id',
      }, 422, []);
    }
  }
  const result = await c.env.DB.prepare(
    `UPDATE staff
        SET ${updates.join(', ')},
            updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
      WHERE id = ? AND line_account_id = ?`,
  ).bind(...values, id, accountId).run();
  if (result.meta.changes === 0) return c.json({ error: 'staff_not_found' }, 404);
  return c.json({ ok: true });
});

booking.delete('/api/booking/admin/staff/:id', requirePermission(BOOKING_SETTINGS_KEY), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const id = c.req.param('id');
  await c.env.DB.batch([
    queueDeletedMeetingConnections(c.env.DB,{whereSql:"c.line_account_id=? AND c.staff_id=? AND EXISTS(SELECT 1 FROM staff s WHERE s.id=c.staff_id AND s.line_account_id=c.line_account_id AND s.deleted_at IS NULL)",params:[accountId,id],source:'staff'}),
    queueDeletedGoogleCalendars(c.env.DB,{whereSql:"c.line_account_id=? AND c.staff_id=? AND EXISTS(SELECT 1 FROM staff s WHERE s.id=c.staff_id AND s.line_account_id=c.line_account_id AND s.deleted_at IS NULL)",params:[accountId,id],source:'staff'}),
    c.env.DB.prepare("UPDATE google_calendar_connections SET is_active=0,access_token=NULL,refresh_token=NULL,api_key=NULL WHERE line_account_id=? AND staff_id=? AND EXISTS(SELECT 1 FROM staff WHERE id=? AND line_account_id=? AND deleted_at IS NULL)").bind(accountId,id,id,accountId),
    c.env.DB.prepare(
      `UPDATE staff
          SET deleted_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
        WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`,
    )
    .bind(id, accountId),
  ]);
  return c.json({ ok: true });
});

// ---- staff_menus matrix ----

booking.get('/api/booking/admin/staff/:id/menus', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const staffId = c.req.param('id');
  if (!(await assertStaffInAccount(c.env.DB, staffId, accountId))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  const rows = await c.env.DB
    .prepare(
      `SELECT m.id AS menu_id, m.name,
              COALESCE(sm.is_offered, 0) AS is_offered,
              sm.override_duration_minutes,
              sm.override_price
         FROM menus m
         LEFT JOIN staff_menus sm ON sm.staff_id = ?2 AND sm.menu_id = m.id
        WHERE m.line_account_id = ?1 AND m.deleted_at IS NULL
        ORDER BY m.sort_order ASC`,
    )
    .bind(accountId, staffId)
    .all();
  return c.json({ matrix: rows.results });
});

booking.put('/api/booking/admin/staff/:id/menus', requirePermission(BOOKING_MENUS_KEY), inputJsonBoundary({"menus":["array"]}), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const staffId = c.req.param('id');
  if (!(await assertStaffInAccount(c.env.DB, staffId, accountId))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  const b = await c.req.json<{
    menus: Array<{
      menu_id: string;
      is_offered: boolean;
      override_duration_minutes?: number | null;
      override_price?: number | null;
    }>;
  }>();
  // menu_id も同 account のものに限定。account 外の menu_id は無視。
  const validMenuIds = new Set(
    (
      await c.env.DB
        .prepare(`SELECT id FROM menus WHERE line_account_id = ? AND deleted_at IS NULL`)
        .bind(accountId)
        .all<{ id: string }>()
    ).results.map((r) => r.id),
  );
  if (!Array.isArray(b.menus)) return inputError(c, { error: 'invalid_menus' }, 400, ["menus"]);
  const filtered = b.menus.filter((m) => validMenuIds.has(m.menu_id));
  // DELETE と INSERT を同一 batch に入れて原子化する。分けると INSERT 側の
  // 失敗で割り当てが全消えする。
  await c.env.DB.batch(
    staffMenusReplaceStatements(c.env.DB, staffId, filtered),
  );
  return c.json({ ok: true });
});

// 担当割り当ての一括読み取り。マトリクス画面は全スタッフ分を
// 1行ずつ GET していた（N+1）。staff×menus の CROSS JOIN 1本で
// 全員分を返す。応答は一括PUTと同じ `{ staff: [{ staff_id, matrix }] }` の形。
booking.get('/api/booking/admin/staff-menus', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const rows = await c.env.DB
    .prepare(
      `SELECT s.id AS staff_id, m.id AS menu_id, m.name,
              COALESCE(sm.is_offered, 0) AS is_offered,
              sm.override_duration_minutes,
              sm.override_price
         FROM staff s
         CROSS JOIN menus m
         LEFT JOIN staff_menus sm
           ON sm.staff_id = s.id AND sm.menu_id = m.id
        WHERE s.line_account_id = ?1 AND s.deleted_at IS NULL
          AND m.line_account_id = ?1 AND m.deleted_at IS NULL
        ORDER BY s.sort_order ASC, m.sort_order ASC`,
    )
    .bind(accountId)
    .all<{
      staff_id: string;
      menu_id: string;
      name: string;
      is_offered: number;
      override_duration_minutes: number | null;
      override_price: number | null;
    }>();
  // メニューが0件のアカウントでは CROSS JOIN が行を返さず、スタッフだけが
  // 取りこぼされる。画面は matrix をメニュー一覧へ写すだけなので空でよいが、
  // 応答にスタッフ自体は含めておく（単独GETと同じ器を期待する呼び出し向け）。
  const staffRows = await c.env.DB
    .prepare(
      `SELECT id FROM staff
        WHERE line_account_id = ? AND deleted_at IS NULL
        ORDER BY sort_order ASC`,
    )
    .bind(accountId)
    .all<{ id: string }>();
  const byStaff = new Map<string, Array<{
    menu_id: string;
    name: string;
    is_offered: number;
    override_duration_minutes: number | null;
    override_price: number | null;
  }>>();
  for (const staff of staffRows.results) byStaff.set(staff.id, []);
  for (const row of rows.results) {
    byStaff.get(row.staff_id)?.push({
      menu_id: row.menu_id,
      name: row.name,
      is_offered: row.is_offered,
      override_duration_minutes: row.override_duration_minutes,
      override_price: row.override_price,
    });
  }
  return c.json({
    staff: [...byStaff.entries()].map(([staff_id, matrix]) => ({ staff_id, matrix })),
  });
});

// 画面の一括保存を1要求で受ける口。全担当者分を1 batch で適用する。
// staff_id / menu_id が1件でも別account・不存在なら全体を拒否する
// （単独PUTと違い、menu_id の黙っての取りこぼしはしない）。
booking.put('/api/booking/admin/staff-menus', requirePermission(BOOKING_MENUS_KEY), inputJsonBoundary({"staff":["array"]}), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const b = await c.req.json<{
    staff: Array<{ staff_id: string; menus: StaffMenuAssignment[] }>;
  }>();
  if (!Array.isArray(b.staff)) return inputError(c, { error: 'invalid_staff' }, 400, ["staff"]);
  const seen = new Set<string>();
  for (const entry of b.staff) {
    if (typeof entry.staff_id !== 'string' || !Array.isArray(entry.menus)) {
      return inputError(c, { error: 'invalid_staff' }, 400, ["staff"]);
    }
    if (seen.has(entry.staff_id)) return inputError(c, { error: 'duplicate_staff_id' }, 422, ["staff"]);
    seen.add(entry.staff_id);
  }
  if (b.staff.length === 0) return c.json({ ok: true });
  const validStaffIds = new Set(
    (
      await c.env.DB
        .prepare(`SELECT id FROM staff WHERE line_account_id = ? AND deleted_at IS NULL`)
        .bind(accountId)
        .all<{ id: string }>()
    ).results.map((r) => r.id),
  );
  if (b.staff.some((entry) => !validStaffIds.has(entry.staff_id))) {
    return c.json({ error: 'staff_not_found_in_account' }, 404);
  }
  const validMenuIds = new Set(
    (
      await c.env.DB
        .prepare(`SELECT id FROM menus WHERE line_account_id = ? AND deleted_at IS NULL`)
        .bind(accountId)
        .all<{ id: string }>()
    ).results.map((r) => r.id),
  );
  for (const entry of b.staff) {
    if (entry.menus.some((m) => !validMenuIds.has(m.menu_id))) {
      return c.json({ error: 'menu_not_found_in_account' }, 404);
    }
  }
  await c.env.DB.batch(
    b.staff.flatMap((entry) =>
      staffMenusReplaceStatements(c.env.DB, entry.staff_id, entry.menus),
    ),
  );
  return c.json({ ok: true });
});
}
