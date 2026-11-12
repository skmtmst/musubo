import type { MeetReminderSchedule, RegisterMeetConsultationInput } from './meet-reminder-types.js';

export interface StoredConsultation {
  id: string; friend_id: string; starts_at: string; ends_at: string; meet_url: string;
  status: string; booking_id: string | null; booking_version: number | null; schedule_revision: number;
}
/** 親の CAS と将来の通知計画を一緒に確定し、送信済み・不明の行は戻さない。 */
export async function persistMeetGeneration(db: D1Database, input: RegisterMeetConsultationInput,
  friend: { line_account_id: string; line_user_id: string }, existing: StoredConsultation | null,
  schedules: MeetReminderSchedule[], now: string) {
  const id = existing?.id ?? crypto.randomUUID();
  const bookingId = input.bookingId ?? null, bookingVersion = input.bookingVersion ?? null;
  const changed = !!existing && (existing.friend_id !== input.friendId || existing.starts_at !== input.startsAt
    || existing.ends_at !== input.endsAt || existing.meet_url !== input.meetUrl || existing.status !== 'confirmed'
    || existing.booking_id !== bookingId || existing.booking_version !== bookingVersion);
  const revision = (existing?.schedule_revision ?? 0) + (changed ? 1 : 0);
  const guard = `EXISTS(SELECT 1 FROM meet_consultations c WHERE c.id=? AND c.schedule_revision=? AND c.status='confirmed')`;
  const writes = [db.prepare(`INSERT INTO meet_consultations
    (id,external_event_id,friend_id,title,starts_at,ends_at,meet_url,status,booking_id,booking_version,cancel_claim_id,schedule_revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'confirmed',?,?,NULL,?,?,?)
    ON CONFLICT(external_event_id) DO UPDATE SET confirmation_revision=meet_consultations.confirmation_revision+1, friend_id=excluded.friend_id,title=excluded.title,
      starts_at=excluded.starts_at,ends_at=excluded.ends_at,meet_url=excluded.meet_url,status='confirmed',
      booking_id=excluded.booking_id,booking_version=excluded.booking_version,cancel_claim_id=NULL,
      schedule_revision=excluded.schedule_revision,updated_at=excluded.updated_at
    WHERE meet_consultations.id=excluded.id AND meet_consultations.schedule_revision=?
      AND (excluded.booking_version IS NULL OR meet_consultations.booking_version IS NULL OR excluded.booking_version>=meet_consultations.booking_version)`)
    .bind(id,input.externalEventId,input.friendId,input.title,input.startsAt,input.endsAt,input.meetUrl,
      bookingId,bookingVersion,revision,now,now,existing?.schedule_revision ?? 0)];
  // 古い更新者が通知予定を変えないよう、親 CAS に負けたら batch 全体を失敗させる。
  writes.push(db.prepare(`SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'meet_generation_conflict' END)`));
  writes.push(db.prepare(`UPDATE meet_consultation_notification_runs SET status='cancelled',updated_at=?
    WHERE consultation_id=? AND schedule_revision<>? AND (status='pending' OR status='failed' AND last_error='notification_preflight_failed') AND ${guard}`)
    .bind(now,id,revision,id,revision));
  writes.push(db.prepare(`UPDATE meet_consultation_notification_runs SET status='cancelled',updated_at=?
    WHERE consultation_id=? AND schedule_revision=? AND (status='pending' OR status='failed' AND last_error='notification_preflight_failed')
      AND kind NOT IN(SELECT value FROM json_each(?)) AND ${guard}`)
    .bind(now,id,revision,JSON.stringify(schedules.map(item=>item.kind)),id,revision));
  for (const item of schedules) {
    const runId=crypto.randomUUID();
    writes.push(db.prepare(`INSERT OR IGNORE INTO meet_consultation_notification_runs
      (id,consultation_id,schedule_revision,booking_id,booking_version,line_account_id,friend_id,recipient_id,
       starts_at,ends_at,meet_url,kind,scheduled_at,retry_key,status,retry_count,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,? WHERE ${guard}`)
      .bind(runId,id,revision,bookingId,bookingVersion,friend.line_account_id,input.friendId,friend.line_user_id,
        input.startsAt,input.endsAt,input.meetUrl,item.kind,item.scheduledAt,runId,now,now,id,revision));
  }
  try { await db.batch(writes); }
  catch(error) { if(error instanceof Error && /meet_generation_conflict|malformed JSON/.test(error.message)) return {id,revision,updated:false}; throw error; }
  return {id,revision,updated:true};
}
