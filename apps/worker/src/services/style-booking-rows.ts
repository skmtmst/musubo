import type { IndustryStyle, StyleBooking } from '@line-crm/shared';

import { instant } from './style-analytics-core.js';
type Row = Record<string, string | number | null>;
function normalized(r: Row): StyleBooking {
  return {
    id: String(r.id),
    version: r.version == null ? null : Number(r.version),
    updatedAt: (r.updatedAt ?? null) as string | null,
    kind: String(r.kind) as StyleBooking['kind'],
    friendId: (r.friendId ?? null) as string | null,
    personKey: String(r.personKey),
    name: String(r.name ?? ''),
    startsAt: String(r.startsAt),
    endsAt: String(r.endsAt),
    requestedAt: String(r.requestedAt),
    status: String(r.status),
    staffId: (r.staffId ?? null) as string | null,
    menuId: (r.menuId ?? null) as string | null,
    menuName: (r.menuName ?? null) as string | null,
    storeId: (r.storeId ?? null) as string | null,
    slotId: (r.slotId ?? null) as string | null,
    departedAt: (r.departedAt ?? null) as string | null,
    partySize: Number(r.partySize ?? 1),
    price: Number(r.price ?? 0),
    visited: !!r.visited,
    attendance: (r.attendance ?? null) as string | null,
    held: !!r.held,
    meetingMode: (r.meetingMode ?? null) as string | null,
    meetingUrl: (r.meetingUrl ?? null) as string | null,
    location: (r.location ?? null) as string | null,
    outcome: (r.outcome ?? null) as string | null,
    source: String(r.source ?? ''),
    entryPoint: (r.entryPoint ?? null) as string | null,
    refCode: (r.refCode ?? null) as string | null,
    designation: (r.designation ?? null) as string | null,
    cancelledAt: (r.cancelledAt ?? null) as string | null,
    confirmedResponse: (r.confirmedResponse ?? null) as string | null,
    participationMode: (r.participationMode ?? null) as string | null,
  };
}
/** JOIN は選択アカウント内に保ち、予約に結び付いた Meet を二重計上しない。 */
async function industryRows(
  db: D1Database,
  account: string,
  style: IndustryStyle,
): Promise<StyleBooking[]> {
  let sql: string;
  if (style === 'restaurant')
    sql = `SELECT r.id,r.customer_version version,r.updated_at updatedAt,'restaurant' kind,f.id friendId,COALESCE(f.id,'phone:'||r.customer_phone,'reservation:'||r.id) personKey,
    r.customer_name name,r.starts_at startsAt,r.ends_at endsAt,r.created_at requestedAt,r.status,r.staff_id staffId,r.course_id menuId,m.name menuName,r.store_id storeId,COALESCE(r.table_id,(SELECT l.table_id FROM rt_reservation_table_links l WHERE l.reservation_id=r.id LIMIT 1)) slotId,r.departed_at departedAt,
    r.guest_count partySize,0 price,r.status IN('visited','seated') visited,r.hold_expires_at IS NOT NULL held,r.source,NULL cancelledAt,
    (SELECT response FROM rt_reservation_confirmations WHERE reservation_id=r.id ORDER BY requested_at DESC LIMIT 1) confirmedResponse
    FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id LEFT JOIN rt_menu_items m ON m.id=r.course_id AND m.store_id=r.store_id LEFT JOIN friends f ON f.line_user_id=r.line_uid AND f.line_account_id=s.line_account_id
    WHERE s.line_account_id=?`;
  else if (style === 'lesson')
    sql = `SELECT b.id,b.updated_at updatedAt,'event' kind,b.friend_id friendId,b.friend_id personKey,f.display_name name,s.starts_at startsAt,s.ends_at endsAt,
    b.requested_at requestedAt,b.status,s.instructor_id staffId,b.event_id menuId,e.name menuName,b.slot_id slotId,b.party_size partySize,0 price,b.status='attended' visited,
    0 held,b.status attendance,b.participation_mode participationMode,b.cancelled_at cancelledAt,f.ref_code refCode
    FROM event_bookings b JOIN event_slots s ON s.id=b.slot_id JOIN events e ON e.id=b.event_id
    JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id WHERE b.line_account_id=?`;
  else
    sql = `SELECT b.id,b.lock_version version,b.updated_at updatedAt,'booking' kind,b.friend_id friendId,COALESCE(b.friend_id,'customer:'||b.booking_customer_id) personKey,
    COALESCE(f.display_name,c.display_name,'') name,b.starts_at startsAt,b.ends_at endsAt,b.requested_at requestedAt,b.status,b.staff_id staffId,b.menu_id menuId,m.name menuName,
    1 partySize,COALESCE(b.price_at_booking,0) price,
    (b.status='completed' OR EXISTS(SELECT 1 FROM booking_visit_marks v WHERE v.booking_id=b.id AND v.kind IN('visited','late'))) visited,
    (SELECT kind FROM booking_visit_marks v WHERE v.booking_id=b.id ORDER BY marked_at DESC,id DESC LIMIT 1) attendance,
    b.status='pending_payment' held,COALESCE(b.meeting_mode,CASE WHEN m.meeting_mode='customer_choice' THEN NULL ELSE m.meeting_mode END) meetingMode,COALESCE(b.meeting_url,(SELECT mc.meet_url FROM meet_consultations mc WHERE mc.booking_id=b.id AND mc.status='confirmed' LIMIT 1)) meetingUrl,COALESCE(b.meeting_location,m.meeting_location) location,b.consultation_outcome outcome,
    b.source,b.entry_point entryPoint,f.ref_code refCode,b.designation,b.cancelled_at cancelledAt
    FROM bookings b LEFT JOIN menus m ON m.id=b.menu_id AND m.line_account_id=b.line_account_id LEFT JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id
    LEFT JOIN booking_customers c ON c.id=b.booking_customer_id AND c.line_account_id=b.line_account_id WHERE b.line_account_id=?`;
  const rows = (await db.prepare(sql).bind(account).all<Row>()).results.map(
    normalized,
  );
  if (style === 'consult') {
    const meet = (
      await db
        .prepare(
          `SELECT m.id,m.confirmation_revision version,m.updated_at updatedAt,'meet' kind,m.friend_id friendId,m.friend_id personKey,f.display_name name,m.starts_at startsAt,m.ends_at endsAt,
      m.created_at requestedAt,CASE WHEN m.attendance='no_show' THEN 'no_show' WHEN m.status='confirmed' THEN 'confirmed' ELSE m.status END status,
      m.staff_id staffId,(m.status='completed' OR m.attendance IN('visited','late')) visited,m.attendance,'online' meetingMode,m.meet_url meetingUrl,m.consultation_outcome outcome,f.ref_code refCode
      FROM meet_consultations m JOIN friends f ON f.id=m.friend_id WHERE f.line_account_id=?
      AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.id=m.booking_id AND b.line_account_id=f.line_account_id)`,
        )
        .bind(account)
        .all<Row>()
    ).results.map(normalized);
    rows.push(...meet);
  }
  return rows.sort(
    (a, b) =>
      instant(a.startsAt) - instant(b.startsAt) || a.id.localeCompare(b.id),
  );
}

/** スタイル変更で予約を失わないよう、予約種別も識別子に含める。 */
export async function styleRows(
  db: D1Database,
  account: string,
  _style: IndustryStyle,
  kinds: StyleBooking['kind'][] = ['booking', 'restaurant', 'event', 'meet'],
): Promise<StyleBooking[]> {
  const rows = (
    await Promise.all([
      kinds.includes('booking') || kinds.includes('meet')
        ? industryRows(db, account, 'consult')
        : [],
      kinds.includes('restaurant')
        ? industryRows(db, account, 'restaurant')
        : [],
      kinds.includes('event') ? industryRows(db, account, 'lesson') : [],
    ])
  )
    .flat()
    .filter((r) => kinds.includes(r.kind));
  return rows.sort(
    (a, b) =>
      instant(a.startsAt) - instant(b.startsAt) ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );
}
