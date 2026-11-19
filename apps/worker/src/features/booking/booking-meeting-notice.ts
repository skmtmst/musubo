/** 会議の問題は通知センターに同じ会議につき一度だけ記録する。 */
export async function notifyMeetingIssue(db:D1Database,input:{accountId:string;bookingId:string;linkId:string;reason:'unknown'|'failed'}):Promise<void> {
 const id=`meeting:${JSON.stringify([input.accountId,input.linkId])}`;
 const body=input.reason==='unknown'
  ? '会議サービスの処理結果を確認できません。予約の会議を確認してください。'
  : '会議サービスの処理に失敗しました。予約の会議を確認してください。';
 await db.prepare(`INSERT OR IGNORE INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
  SELECT ?,'booking_meeting_issue','会議の対応が必要です',?,'dashboard','sent',?,b.line_account_id,'error'
  FROM bookings b JOIN booking_meeting_links l ON l.booking_id=b.id
  WHERE b.id=? AND b.line_account_id=? AND l.id=?`)
  .bind(id,body,JSON.stringify({bookingId:input.bookingId}),input.bookingId,input.accountId,input.linkId).run();
}
