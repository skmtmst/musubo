import { zonedWallTime } from '@line-crm/shared';
import { validRestaurantDate } from './restaurant-booking.js';
import { StyleError } from './style-setup.js';

export type ClosureConfirmationInput = {
  date: string;
  target: 'store' | 'staff';
  staffIds: string[];
  allDay: boolean;
  startTime?: string;
  endTime?: string;
  reason: string | null;
};

type Reservation = { id: string; kind: string; revision: number; slotRevision: number | null; startsAt: string; endsAt: string; staffId: string | null; name: string; partySize: number };

export function parseClosureConfirmation(body: Record<string, unknown>): ClosureConfirmationInput {
  if (typeof body.date !== 'string' || !validRestaurantDate(body.date)) throw new StyleError('invalid_date');
  if (body.target !== 'store' && body.target !== 'staff') throw new StyleError('invalid_scope');
  if (typeof body.allDay !== 'boolean') throw new StyleError('invalid_time');
  const staffIds = body.staffIds;
  if (!Array.isArray(staffIds) || staffIds.some(id => typeof id !== 'string' || !id || id.length > 100)
    || new Set(staffIds).size !== staffIds.length || (body.target === 'staff' && !staffIds.length)
    || (body.target === 'store' && staffIds.length)) throw new StyleError('invalid_scope');
  const startTime = body.startTime, endTime = body.endTime;
  if (!body.allDay && (typeof startTime !== 'string' || typeof endTime !== 'string'
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)
    || startTime >= endTime)) throw new StyleError('invalid_time');
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') throw new StyleError('invalid_reason');
  return { date: body.date, target: body.target, staffIds: staffIds as string[], allDay: body.allDay,
    startTime: typeof startTime === 'string' ? startTime : undefined, endTime: typeof endTime === 'string' ? endTime : undefined,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : null };
}

/** 対象と各版を同じ SQL で読み、保存時にも同じ式で照らす。 */
export function closureSnapshotQuery(account: string, input: ClosureConfirmationInput, timezone: string) {
  const start = zonedWallTime(input.date, input.allDay ? '00:00' : input.startTime!, timezone);
  const end = input.allDay ? zonedWallTime(input.date, '00:00', timezone, 1) : zonedWallTime(input.date, input.endTime!, timezone);
  const sql = `WITH candidates AS (
    SELECT b.id,'booking' kind,b.confirmation_revision revision,NULL slotRevision,b.starts_at startsAt,b.ends_at endsAt,b.staff_id staffId,
      COALESCE(f.display_name,c.display_name,'') name,1 partySize FROM bookings b
      LEFT JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id
      LEFT JOIN booking_customers c ON c.id=b.booking_customer_id AND c.line_account_id=b.line_account_id
      WHERE b.line_account_id=? AND b.status NOT IN ('cancelled','rejected','expired','no_show')
    UNION ALL
    SELECT m.id,'meet',m.confirmation_revision,NULL,m.starts_at,m.ends_at,m.staff_id,COALESCE(f.display_name,''),1
      FROM meet_consultations m JOIN friends f ON f.id=m.friend_id WHERE f.line_account_id=?
      AND m.status NOT IN ('cancelled','rejected','expired','no_show') AND COALESCE(m.attendance,'')<>'no_show'
      AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.id=m.booking_id AND b.line_account_id=f.line_account_id)
    UNION ALL
    SELECT b.id,'event',b.confirmation_revision,s.version,s.starts_at,s.ends_at,s.instructor_id,COALESCE(f.display_name,''),b.party_size
      FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id LEFT JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id
      WHERE b.line_account_id=? AND b.status NOT IN ('cancelled','rejected','expired','no_show')
  ) SELECT json_group_array(json_object('id',id,'kind',kind,'revision',revision,'slotRevision',slotRevision,
       'startsAt',startsAt,'endsAt',endsAt,'staffId',staffId,'name',name,'partySize',partySize)) FROM (
    SELECT * FROM candidates WHERE julianday(startsAt)<julianday(?) AND julianday(endsAt)>julianday(?)
      AND (?=1 OR staffId IN (SELECT value FROM json_each(?))) ORDER BY kind,id
  )`;
  return { sql, binds: [account, account, account, end, start, Number(input.target === 'store'), JSON.stringify(input.staffIds)] };
}

export async function readClosureSnapshot(db: D1Database, account: string, input: ClosureConfirmationInput, timezone: string) {
  const query = closureSnapshotQuery(account, input, timezone);
  const row = await db.prepare(`SELECT (${query.sql}) snapshot`).bind(...query.binds).first<{ snapshot: string }>();
  const snapshot = row?.snapshot ?? '[]';
  return { snapshot, reservations: JSON.parse(snapshot) as Reservation[] };
}

/** 同じ確認をもう一度確定しないよう、重なる休業の版も固定する。 */
export function closureExceptionSnapshotQuery(account: string, input: ClosureConfirmationInput) {
  const sql = `SELECT json_group_array(json_object('id',id,'revision',version)) FROM (
    SELECT id,version FROM booking_availability_exceptions WHERE line_account_id=? AND date_from<=? AND date_to>=?
      AND (scope_kind='store' OR ?=1 OR (scope_kind='staff' AND scope_id IN (SELECT value FROM json_each(?)))) ORDER BY id
  )`;
  return { sql, binds: [account, input.date, input.date, Number(input.target === 'store'), JSON.stringify(input.staffIds)] };
}

export async function readClosureExceptionSnapshot(db: D1Database, account: string, input: ClosureConfirmationInput) {
  const query = closureExceptionSnapshotQuery(account, input);
  return (await db.prepare(`SELECT (${query.sql}) snapshot`).bind(...query.binds).first<{ snapshot: string }>())?.snapshot ?? '[]';
}
