import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { StyleError } from '../services/style-setup.js';
import { base, account, json, edit, text, oneOf } from './styles-common.js';

export const styleMeetUpdates=new Hono<Env>();


styleMeetUpdates.patch(base + '/meet/:id', async (c) => {
  edit(c, '/booking/bookings');
  const a = await account(c),
    b = await json(c),
    id = c.req.param('id');
  const r = await c.env.DB.prepare(
    'SELECT m.* FROM meet_consultations m JOIN friends f ON f.id=m.friend_id WHERE m.id=? AND f.line_account_id=?',
  )
    .bind(id, a)
    .first<Record<string, string | null>>();
  if (!r) throw new StyleError('not_found', 404);
  if (b.expectedUpdatedAt !== r.updated_at)
    throw new StyleError('version_conflict', 409);
  if (
    c.get('staff').role === 'staff' &&
    !(await c.env.DB.prepare(
      'SELECT id FROM staff WHERE id=? AND staff_member_id=? AND line_account_id=?',
    )
      .bind(r.staff_id, c.get('staff').id, a)
      .first())
  )
    throw new StyleError('forbidden', 403);
  const staffId = b.staffId === undefined ? r.staff_id : text(b.staffId, 100);
  if (
    staffId &&
    !(await c.env.DB.prepare(
      'SELECT id FROM staff WHERE id=? AND line_account_id=? AND is_active=1',
    )
      .bind(staffId, a)
      .first())
  )
    throw new StyleError('staff_not_found', 404);
  const outcome =
      b.outcome === undefined
        ? r.consultation_outcome
        : oneOf(b.outcome, ['considering', 'won', 'lost'], true),
    attendance =
      b.attendance === undefined
        ? r.attendance
        : oneOf(b.attendance, ['visited', 'late', 'no_show'], true),
    now = new Date().toISOString();
  const changed = await c.env.DB.prepare(
    'UPDATE meet_consultations SET confirmation_revision = confirmation_revision + 1, staff_id=?,attendance=?,consultation_outcome=?,outcome_recorded_at=?,outcome_recorded_by=?,updated_at=? WHERE id=? AND updated_at=?',
  )
    .bind(
      staffId,
      attendance,
      outcome,
      b.outcome === undefined ? r.outcome_recorded_at : now,
      b.outcome === undefined ? r.outcome_recorded_by : c.get('staff').id,
      now,
      id,
      r.updated_at,
    )
    .run();
  if (!changed.meta.changes) throw new StyleError('version_conflict', 409);
  return c.json({ success: true, data: { id, updatedAt: now } });
});
