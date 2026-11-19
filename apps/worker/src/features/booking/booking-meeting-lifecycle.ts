import { createConfirmedBookingMeeting, type MeetingCreator, type MeetingProvider } from './booking-meeting-create.js';

/** 既に存在しない会議は deleted を返す。結果不明の再送はしない。 */
export interface MeetingRemover {
  remove(input: { staffId: string; meetingId: string; idempotencyKey: string; signal: AbortSignal }): Promise<'deleted' | 'failed' | 'unknown'>;
}

/** 古い会議の削除が確かになってから、確定中の予約に新しい会議を作る。 */
export async function reconcileBookingMeeting(db: D1Database, input: {
  bookingId: string; accountId: string;
  removers: Partial<Record<MeetingProvider, MeetingRemover>>;
  creator?: MeetingCreator;
}): Promise<'done' | 'failed' | 'unknown'> {
  const booking=await db.prepare('SELECT status FROM bookings WHERE id=? AND line_account_id=?')
    .bind(input.bookingId,input.accountId).first<{status:string}>();
  if (!booking) return 'failed';
  const pending=await db.prepare(`SELECT id,provider,staff_id,external_meeting_id,last_error_code FROM booking_meeting_links
    WHERE booking_id=? AND status='cancel_pending' ORDER BY created_at,id`).bind(input.bookingId)
    .all<{id:string;provider:MeetingProvider;staff_id:string|null;external_meeting_id:string|null;last_error_code:string|null}>();
  for (const row of pending.results ?? []) {
    const remover=input.removers[row.provider];
    if (!remover || !row.staff_id || !row.external_meeting_id) return 'failed';
    const claim=await db.prepare(`UPDATE booking_meeting_links SET last_error_code='delete_started',updated_at=?
      WHERE id=? AND status='cancel_pending' AND (last_error_code IS NULL OR last_error_code='delete_failed')`)
      .bind(new Date().toISOString(),row.id).run();
    if (claim.meta.changes!==1) return 'unknown';
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),8000);
    let outcome:'deleted'|'failed'|'unknown';
    try {
      outcome=await Promise.race([remover.remove({staffId:row.staff_id,meetingId:row.external_meeting_id,idempotencyKey:`meeting-delete:${row.id}`,signal:controller.signal}),
        new Promise<'unknown'>(resolve=>controller.signal.addEventListener('abort',()=>resolve('unknown'),{once:true}))]);
    } catch { outcome='unknown'; } finally { clearTimeout(timer); }
    await db.prepare(`UPDATE booking_meeting_links SET status=?,last_error_code=?,updated_at=?
      WHERE id=? AND status='cancel_pending' AND last_error_code='delete_started'`)
      .bind(outcome==='deleted'?'cancelled':'cancel_pending',outcome==='deleted'?null:outcome==='failed'?'delete_failed':'delete_unknown',new Date().toISOString(),row.id).run();
    if (outcome!=='deleted') return outcome;
  }
  const unresolved=await db.prepare("SELECT id FROM booking_meeting_links WHERE booking_id=? AND status='pending' AND attempt_count>0 LIMIT 1").bind(input.bookingId).first();
  if (unresolved) return 'unknown';
  if (booking.status==='confirmed' && input.creator) {
    const created=await createConfirmedBookingMeeting(db,input.bookingId,input.creator);
    if (created==='failed' || created==='unknown') return created;
  }
  return 'done';
}
