import { Hono } from 'hono';

import type { Env } from '../worker-env.js';

import { hasStaffPermission } from '../middleware/role-guard.js';
import { StyleError } from '../services/style-setup.js';

import { base, account, json, edit, text, oneOf, version } from './styles-common.js';
export const styles = new Hono<Env>();

styles.patch(base + '/bookings/:id', async (c) => {
  edit(c, '/booking/bookings');
  const a = await account(c),
    b = await json(c),
    id = c.req.param('id');
  const r = await c.env.DB.prepare(
    'SELECT * FROM bookings WHERE id=? AND line_account_id=?',
  )
    .bind(id, a)
    .first<Record<string, string | number | null>>();
  if (!r) throw new StyleError('not_found', 404);
  version(b.expectedVersion, Number(r.lock_version));
  if (c.get('staff').role === 'staff') {
    const own = await c.env.DB.prepare(
      'SELECT id FROM staff WHERE id=? AND staff_member_id=?',
    )
      .bind(r.staff_id, c.get('staff').id)
      .first();
    if (!own) throw new StyleError('forbidden', 403);
  }
  const mode =
      b.meetingMode === undefined
        ? r.meeting_mode
        : oneOf(b.meetingMode, ['online', 'in_person'], true),
    url = b.meetingUrl === undefined ? r.meeting_url : text(b.meetingUrl, 2000);
  if (url) {
    let u: URL;
    try {
      u = new URL(String(url));
    } catch {
      throw new StyleError('invalid_meeting_url');
    }
    if (u.protocol !== 'https:' || u.username || u.password)
      throw new StyleError('invalid_meeting_url');
  }
  if (
    b.meetingUrl !== undefined &&
    url &&
    new URL(String(url)).hostname === 'meet.google.com'
  ) {
    const registered = await c.env.DB.prepare(
      `SELECT m.id FROM meet_consultations m WHERE m.booking_id=? AND m.friend_id=? AND m.meet_url=? AND m.status='confirmed' AND julianday(m.starts_at)=julianday(?) AND julianday(m.ends_at)=julianday(?) AND EXISTS(SELECT 1 FROM meet_consultation_notification_runs r WHERE r.consultation_id=m.id AND r.schedule_revision=m.schedule_revision AND r.kind='day_before') AND EXISTS(SELECT 1 FROM meet_consultation_notification_runs r WHERE r.consultation_id=m.id AND r.schedule_revision=m.schedule_revision AND r.kind='hour_before')`,
    )
      .bind(id, r.friend_id, url, r.starts_at, r.ends_at)
      .first();
    if (!registered)
      throw new StyleError('register_meet_consultation_first', 422);
  }
  const outcome =
      b.outcome === undefined
        ? r.consultation_outcome
        : oneOf(b.outcome, ['considering', 'won', 'lost'], true),
    now = new Date().toISOString();
  const update = c.env.DB.prepare(
    `UPDATE bookings SET confirmation_revision = confirmation_revision + 1, meeting_mode=?,meeting_url=?,meeting_location=?,consultation_outcome=?,outcome_recorded_at=?,outcome_recorded_by=?,cancellation_reason=?,designation=?,entry_point=?,lock_version=lock_version+1,updated_at=? WHERE id=? AND line_account_id=? AND lock_version=?`,
  ).bind(
    mode,
    url,
    b.location === undefined ? r.meeting_location : text(b.location),
    outcome,
    b.outcome === undefined ? r.outcome_recorded_at : now,
    b.outcome === undefined ? r.outcome_recorded_by : c.get('staff').id,
    b.cancellationReason === undefined
      ? r.cancellation_reason
      : text(b.cancellationReason),
    b.designation === undefined
      ? r.designation
      : oneOf(b.designation, ['designated', 'any', 'unspecified']),
    b.entryPoint === undefined ? r.entry_point : text(b.entryPoint, 100),
    now,
    id,
    a,
    r.lock_version,
  );
  await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT json(CASE WHEN EXISTS(SELECT 1 FROM bookings WHERE id=? AND line_account_id=? AND lock_version=?) THEN '{}' ELSE 'STYLE_VERSION_CONFLICT' END)`,
    ).bind(id, a, r.lock_version),
    update,
    c.env.DB.prepare(
      'UPDATE meet_consultations SET confirmation_revision = confirmation_revision + 1, booking_version=? WHERE booking_id=? AND booking_version=?',
    ).bind(Number(r.lock_version) + 1, id, r.lock_version),
    c.env.DB.prepare(
      'INSERT INTO style_change_logs(id,line_account_id,actor_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)',
    ).bind(
      crypto.randomUUID(),
      a,
      c.get('staff').id,
      'booking.details',
      JSON.stringify({
        id,
        version: r.lock_version,
        outcome: r.consultation_outcome,
      }),
      JSON.stringify({ id, outcome, fields: Object.keys(b) }),
      now,
    ),
  ]);
  return c.json({
    success: true,
    data: { id, version: Number(r.lock_version) + 1 },
  });
});

styles.patch(base + '/classes/:id', async (c) => {
  edit(c, '/events');
  const a = await account(c),
    b = await json(c);
  const s = await c.env.DB.prepare(
    'SELECT s.* FROM event_slots s JOIN events e ON e.id=s.event_id WHERE s.id=? AND e.line_account_id=?',
  )
    .bind(c.req.param('id'), a)
    .first<{
      id: string;
      version: number;
      capacity: number | null;
      classroom_capacity: number | null;
      online_capacity: number | null;
      instructor_id: string | null;
    }>();
  if (!s) throw new StyleError('not_found', 404);
  version(b.expectedVersion, s.version);
  const capacity = (v: unknown) => {
    if (
      v !== null &&
      (!Number.isInteger(v) || Number(v) < 0 || Number(v) > 100000)
    )
      throw new StyleError('invalid_capacity');
    return v as number | null;
  };
  const classroom =
      b.classroomCapacity === undefined
        ? s.classroom_capacity
        : capacity(b.classroomCapacity),
    online =
      b.onlineCapacity === undefined
        ? s.online_capacity
        : capacity(b.onlineCapacity),
    instructor =
      b.instructorId === undefined
        ? s.instructor_id
        : text(b.instructorId, 100);
  if (
    instructor &&
    !(await c.env.DB.prepare(
      'SELECT id FROM staff WHERE id=? AND line_account_id=? AND is_active=1',
    )
      .bind(instructor, a)
      .first())
  )
    throw new StyleError('instructor_not_found', 404);
  const total =
    classroom === null && online === null
      ? s.capacity
      : classroom === null || online === null
        ? null
        : classroom + online;
  const changed = await c.env.DB.prepare(
    'UPDATE event_slots SET classroom_capacity=?,online_capacity=?,capacity=?,instructor_id=?,version=version+1 WHERE id=? AND version=?',
  )
    .bind(classroom, online, total, instructor, s.id, s.version)
    .run();
  if (!changed.meta.changes) throw new StyleError('version_conflict', 409);
  return c.json({
    success: true,
    data: {
      id: s.id,
      version: s.version + 1,
      classroomCapacity: classroom,
      onlineCapacity: online,
      instructorId: instructor,
    },
  });
});

styles.patch(base + '/events/:id', async (c) => {
  edit(c, '/events');
  const a = await account(c),
    b = await json(c);
  if (typeof b.isTrial !== 'boolean') throw new StyleError('invalid_trial');
  const r = await c.env.DB.prepare(
    'UPDATE events SET is_trial=?,version=version+1 WHERE id=? AND line_account_id=? AND version=?',
  )
    .bind(Number(b.isTrial), c.req.param('id'), a, b.expectedVersion)
    .run();
  if (!r.meta.changes) throw new StyleError('version_conflict', 409);
  return c.json({ success: true });
});

styles.patch(base + '/event-bookings/:id', async (c) => {
  edit(c, '/events');
  const a = await account(c),
    b = await json(c),
    mode = oneOf(b.participationMode, ['classroom', 'online']);
  const r = await c.env.DB.prepare(
    'UPDATE event_bookings SET confirmation_revision = confirmation_revision + 1, participation_mode=? WHERE id=? AND line_account_id=?',
  )
    .bind(mode, c.req.param('id'), a)
    .run();
  if (!r.meta.changes) throw new StyleError('not_found', 404);
  return c.json({ success: true, data: { participationMode: mode } });
});

styles.patch(base + '/event-waitlist/:id', async (c) => {
  edit(c, '/events');
  const a = await account(c),
    b = await json(c),
    mode = oneOf(b.participationMode, ['classroom', 'online']);
  const r = await c.env.DB.prepare(
    'UPDATE event_waitlist SET participation_mode=?,version=version+1 WHERE id=? AND line_account_id=? AND version=?',
  )
    .bind(mode, c.req.param('id'), a, b.expectedVersion)
    .run();
  if (!r.meta.changes) throw new StyleError('version_conflict', 409);
  return c.json({ success: true, data: { participationMode: mode } });
});

styles.get(base + '/members', async (c) => {
  const a = await account(c);
  if (!hasStaffPermission(c, '/events')) throw new StyleError('forbidden', 403);
  return c.json({
    success: true,
    data: (
      await c.env.DB.prepare(
        'SELECT m.* FROM lesson_memberships m JOIN friends f ON f.id=m.friend_id AND f.line_account_id=m.line_account_id WHERE m.line_account_id=?',
      )
        .bind(a)
        .all()
    ).results,
  });
});
