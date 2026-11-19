/** 会議の問題は通知センターに同じ会議につき一度だけ記録する。 */
export async function notifyMeetingIssue(db:D1Database,input:{accountId:string;bookingId:string;linkId:string;reason:'unknown'|'failed'|'manual_review'}):Promise<void> {
 const id=`meeting:${JSON.stringify([input.accountId,input.linkId])}${input.reason==='manual_review'?':manual_review':''}`;
 const body=input.reason==='manual_review'
  ? '元の担当者の会議が残っています。相手先で削除するか、元の担当者が連携し直してください。'
  : input.reason==='unknown'
  ? '会議サービスの処理結果を確認できません。予約の会議を確認してください。'
  : '会議サービスの処理に失敗しました。予約の会議を確認してください。';
 await db.prepare(`INSERT OR IGNORE INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
  SELECT ?,'booking_meeting_issue','会議の対応が必要です',?,'dashboard','sent',?,b.line_account_id,'error'
  FROM bookings b JOIN booking_meeting_links l ON l.booking_id=b.id
  WHERE b.id=? AND b.line_account_id=? AND l.id=?`)
  .bind(id,body,JSON.stringify({bookingId:input.bookingId}),input.bookingId,input.accountId,input.linkId).run();
}

/** 発行先を用意できない予約は会議記録が無くても一度だけ知らせる。 */
export async function notifyMeetingUnavailable(db:D1Database,input:{accountId:string;bookingId:string}):Promise<void> {
 const id=`meeting-unavailable:${JSON.stringify([input.accountId,input.bookingId])}`;
 await db.prepare(`INSERT OR IGNORE INTO notifications(id,event_type,title,body,channel,status,metadata,line_account_id,category)
  SELECT ?,'booking_meeting_issue','会議の対応が必要です','会議を作れませんでした。担当者の接続を確認するか、URL を手で入力してください。','dashboard','sent',?,line_account_id,'error'
  FROM bookings WHERE id=? AND line_account_id=?`).bind(id,JSON.stringify({bookingId:input.bookingId}),input.bookingId,input.accountId).run();
}
