import { activeTenantLineAccountSql } from '@line-crm/db';

export type EventNotificationSubject = {bookingId:string;slotId:string;status:string;startsAt?:string;version?:number};
export async function currentEventNotificationSubject(db:D1Database,account:string,subject:EventNotificationSubject,to:string) {
  return !!await db.prepare(`SELECT 1 ok FROM event_bookings b JOIN friends f ON f.id=b.friend_id
    JOIN event_slots s ON s.id=b.slot_id
    WHERE b.id=? AND b.line_account_id=? AND b.slot_id=? AND b.status=? AND (? IS NULL OR b.lock_version=?)
      AND f.line_account_id=b.line_account_id AND f.line_platform_user_id=? AND f.is_following=1
      AND (? IS NULL OR julianday(s.starts_at)=julianday(?))
      AND ${activeTenantLineAccountSql('b.line_account_id')}`)
    .bind(subject.bookingId,account,subject.slotId,subject.status,subject.version??null,subject.version??null,to,subject.startsAt??null,subject.startsAt??null).first();
}
