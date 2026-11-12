import { starterCatalogRuntime } from './style-starter-runtime.js';
import { restaurantEffectivelyEnabledForTenant } from '../services/tenant-features.js';
import { Hono } from 'hono';

import type { Env } from '../worker-env.js';

import { hasStaffPermission } from '../middleware/role-guard.js';
import { StyleError } from '../services/style-setup.js';

import { ensureStyleStarterItems } from '../services/style-starter-ensure.js';
import { base, account, json, edit, text } from './styles-common.js';
export const styles = new Hono<Env>();

/** 初期セットの入れ直し。足りない物だけを止めた状態で入れ、スタイルの版は上げない。 */
styles.post(base + '/starter-items/ensure', async (c) => {
  edit(c);
  const a = await account(c);
  return c.json({
    success: true,
    data: await ensureStyleStarterItems(
      c.env.DB,
      a,
      c.get('staff').tenantId ?? null,
      c.get('staff').id,
      await json(c),
      c.env.IMAGES,
      starterCatalogRuntime(c),
    ),
  });
});

styles.get(base + '/menus/:id', async (c) => {
  const a = await account(c);
  if (!hasStaffPermission(c, '/booking/menus'))
    throw new StyleError('forbidden', 403);
  const item = await c.env.DB.prepare(
    'SELECT id,name,version,meeting_mode meetingMode,meeting_location location,is_active isActive FROM menus WHERE id=? AND line_account_id=?',
  )
    .bind(c.req.param('id'), a)
    .first();
  if (!item) throw new StyleError('not_found', 404);
  return c.json({ success: true, data: item });
});

styles.get(base + '/bookings/:id', async (c) => {
  const a = await account(c);
  if (!hasStaffPermission(c, '/booking/bookings'))
    throw new StyleError('forbidden', 403);
  const item = await c.env.DB.prepare(
    'SELECT id,staff_id staffId,lock_version version,meeting_mode meetingMode,meeting_url meetingUrl,meeting_location location,consultation_outcome outcome,outcome_recorded_at outcomeRecordedAt,outcome_recorded_by outcomeRecordedBy,cancellation_reason cancellationReason,designation,entry_point entryPoint FROM bookings WHERE id=? AND line_account_id=?',
  )
    .bind(c.req.param('id'), a)
    .first<{ staffId: string }>();
  if (!item) throw new StyleError('not_found', 404);
  if (
    c.get('staff').role === 'staff' &&
    !(await c.env.DB.prepare(
      'SELECT id FROM staff WHERE id=? AND staff_member_id=?',
    )
      .bind(item.staffId, c.get('staff').id)
      .first())
  )
    throw new StyleError('forbidden', 403);
  return c.json({ success: true, data: item });
});

styles.get(base + '/classes/:id', async (c) => {
  const a = await account(c);
  if (!hasStaffPermission(c, '/events')) throw new StyleError('forbidden', 403);
  const item = await c.env.DB.prepare(
    'SELECT s.*,e.is_trial FROM event_slots s JOIN events e ON e.id=s.event_id WHERE s.id=? AND e.line_account_id=?',
  )
    .bind(c.req.param('id'), a)
    .first();
  if (!item) throw new StyleError('not_found', 404);
  return c.json({ success: true, data: item });
});

styles.patch(base + '/restaurant-reservations/:id', async (c) => {
  edit(c);
  const a = await account(c),
    b = await json(c);
  if (!(await restaurantEffectivelyEnabledForTenant(c)))
    throw new StyleError('not_found', 404);
  const staffId = text(b.staffId, 100);
  if (
    staffId &&
    !(await c.env.DB.prepare(
      'SELECT id FROM staff WHERE id=? AND line_account_id=? AND is_active=1',
    )
      .bind(staffId, a)
      .first())
  )
    throw new StyleError('staff_not_found', 404);
  const r = await c.env.DB.prepare(
    `UPDATE rt_reservations SET confirmation_revision = confirmation_revision + 1, staff_id=?,customer_version=customer_version+1,updated_at=? WHERE id=? AND customer_version=? AND store_id IN(SELECT id FROM rt_stores WHERE line_account_id=?)`,
  )
    .bind(
      staffId,
      new Date().toISOString(),
      c.req.param('id'),
      b.expectedVersion,
      a,
    )
    .run();
  if (!r.meta.changes) throw new StyleError('version_conflict', 409);
  return c.json({ success: true, data: { staffId } });
});
