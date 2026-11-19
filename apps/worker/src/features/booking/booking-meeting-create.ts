/** 会議の外部通信は相手先アダプタに任せる。到達不明は再送しない。 */
export type MeetingProvider = 'google_meet' | 'zoom' | 'teams';
export type MeetingCreateResult =
  | { kind: 'created'; meetingId: string; url: string }
  | { kind: 'failed'; code: string }
  | { kind: 'unknown' };
export interface MeetingCreator {
  provider: MeetingProvider;
  create(input: { bookingId: string; idempotencyKey: string; startsAt: string; endsAt: string; staffId: string; signal: AbortSignal }): Promise<MeetingCreateResult>;
}

/** 失敗しても予約と固定URLはそのまま。通信結果不明は照合待ちとする。 */
export async function createConfirmedBookingMeeting(db: D1Database, bookingId: string, creator: MeetingCreator): Promise<'created' | 'failed' | 'unknown' | 'skipped'> {
  const booking = await db.prepare(`SELECT id,line_account_id,staff_id,starts_at,ends_at,lock_version
    FROM bookings WHERE id=? AND status='confirmed' AND meeting_mode='online'`)
    .bind(bookingId).first<{id:string;line_account_id:string;staff_id:string;starts_at:string;ends_at:string;lock_version:number}>();
  if (!booking) return 'skipped';
  const key = `booking-meeting:${booking.id}:${booking.lock_version}`;
  const now = new Date().toISOString();
  await db.prepare(`INSERT OR IGNORE INTO booking_meeting_links
    (id,booking_id,provider,status,idempotency_key,created_at,updated_at)
    VALUES (?,?,?,'pending',?,?,?)`).bind(crypto.randomUUID(), booking.id, creator.provider, key, now, now).run();
  const claimed = await db.prepare(`UPDATE booking_meeting_links SET attempt_count=1,updated_at=?
    WHERE booking_id=? AND provider=? AND idempotency_key=? AND status='pending' AND attempt_count=0
    AND EXISTS (SELECT 1 FROM bookings b WHERE b.id=booking_meeting_links.booking_id AND b.status='confirmed' AND b.lock_version=?)`)
    .bind(now, booking.id, creator.provider, key, booking.lock_version).run();
  if (claimed.meta.changes !== 1) {
    const existing = await db.prepare('SELECT status FROM booking_meeting_links WHERE idempotency_key=?').bind(key).first<{status:string}>();
    return existing?.status === 'active' ? 'created' : existing?.status === 'failed' ? 'failed' : 'unknown';
  }
  let result: MeetingCreateResult;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    result = await Promise.race([creator.create({ bookingId, idempotencyKey:key, startsAt:booking.starts_at, endsAt:booking.ends_at, staffId:booking.staff_id, signal:controller.signal }),
      new Promise<MeetingCreateResult>(resolve => controller.signal.addEventListener('abort', () => resolve({kind:'unknown'}), {once:true}))]);
  } catch { result = { kind:'unknown' }; } finally { clearTimeout(timer); }
  if (result.kind === 'unknown') {
    await db.prepare("UPDATE booking_meeting_links SET last_error_code='result_unknown',updated_at=? WHERE idempotency_key=? AND status='pending'").bind(new Date().toISOString(),key).run();
    return 'unknown';
  }
  if (result.kind === 'failed') {
    await db.prepare("UPDATE booking_meeting_links SET status='failed',last_error_code='provider_failure',updated_at=? WHERE idempotency_key=? AND status='pending'").bind(new Date().toISOString(), key).run();
    return 'failed';
  }
  let url: URL;
  try { url = new URL(result.url); } catch { return 'unknown'; }
  if (url.protocol !== 'https:' || !result.meetingId) return 'unknown';
  const saved = await db.prepare(`UPDATE booking_meeting_links SET external_meeting_id=?,meeting_url=?,updated_at=?,
    status=CASE WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.id=booking_id AND b.status='confirmed' AND b.lock_version=?) THEN 'active' ELSE 'cancel_pending' END
    WHERE idempotency_key=? AND status='pending'`)
    .bind(result.meetingId,result.url,new Date().toISOString(),booking.lock_version,key).run();
  if (saved.meta.changes !== 1) return 'unknown';
  const current = await db.prepare('SELECT status FROM booking_meeting_links WHERE idempotency_key=?').bind(key).first<{status:string}>();
  return current?.status === 'active' ? 'created' : 'unknown';
}
