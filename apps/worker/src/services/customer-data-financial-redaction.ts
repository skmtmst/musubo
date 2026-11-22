/** 顧客削除の取引内で、会計・監査の行を残して自由記述と連絡先への参照を取り除く。 */
export function financialRedactionStatements(db:D1Database, accountId:string|null, friendId:string, bookingIds:string[]):D1PreparedStatement[] {
 const ids=JSON.stringify(bookingIds);
 const inBookings="SELECT value FROM json_each(?)";
 // 監査 JSON は未知のキーを引き継がない。数値と定義済みの状態だけを残す。
 const safeJson=(col:string)=>{
  const fields:Array<[string,string,string]>=[
   ['status',`json_extract(${col},'$.status') IN ('requested','confirmed','cancelled','rejected','no_show','expired','completed')`,`json_extract(${col},'$.status')`],
   ...['amount','price','price_at_booking'].map(key=>[key,`json_type(${col},'$.${key}') IN ('integer','real')`,`json_extract(${col},'$.${key}')`] as [string,string,string]),
   ['starts_at',`json_type(${col},'$.starts_at')='text' AND julianday(json_extract(${col},'$.starts_at')) IS NOT NULL`,`strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(${col},'$.starts_at'))`],
   ...(['staff_id','menu_id'] as const).map(key=>[key,`json_type(${col},'$.${key}')='text' AND EXISTS(SELECT 1 FROM ${key==='staff_id'?'staff':'menus'} entity WHERE entity.id=json_extract(${col},'$.${key}') AND entity.line_account_id=booking_audit_logs.line_account_id)`,`json_extract(${col},'$.${key}')`] as [string,string,string]),
  ];
  let result="'{}'";
  for(const [key,condition,expression] of fields) result=`json_patch(${result},CASE WHEN ${condition} THEN json_object('${key}',${expression}) ELSE '{}' END)`;
  let notification="'{}'";
  for(const key of ['send_line_confirmation','day_before','hours_before']) {
   const type=`json_type(${col},'$.notification_policy.${key}')`;
   notification=`json_patch(${notification},CASE WHEN ${type} IN ('true','false') THEN json_object('${key}',json(${type})) ELSE '{}' END)`;
  }
  result=`json_patch(${result},CASE WHEN json_type(${col},'$.notification_policy')='object' THEN json_object('notification_policy',json(${notification})) ELSE '{}' END)`;
  return `CASE WHEN ${col} IS NULL THEN NULL ELSE ${result} END`;
 };
 const paymentIds=`SELECT id FROM booking_payments WHERE line_account_id IS ? AND (booking_id IN (${inBookings}) OR (booking_id IS NULL AND booking_id_history IN (${inBookings})))`;
 const paymentArgs=[accountId,ids,ids];
 const policy="CASE WHEN json_valid(policy_snapshot_json) THEN policy_snapshot_json ELSE '{}' END";
 const number=(json:string,path:string,max:number)=>`CASE WHEN json_type(${json},'${path}')='integer' AND json_extract(${json},'${path}') BETWEEN 0 AND ${max} THEN json_extract(${json},'${path}') ELSE NULL END`;
 const safePolicy=`json_object('enabled',json(CASE WHEN json_type(${policy},'$.enabled')='true' THEN 'true' ELSE 'false' END),
   'noShowPercent',${number(policy,'$.noShowPercent',100)},'version',${number(policy,'$.version',1000000)},
   'tiers',json(COALESCE((SELECT json_group_array(json_object('beforeHours',${number("CASE WHEN j.type='object' THEN j.value ELSE '{}' END",'$.beforeHours',8760)},'percent',${number("CASE WHEN j.type='object' THEN j.value ELSE '{}' END",'$.percent',100)})) FROM json_each(${policy},'$.tiers') j WHERE j.type='object'),'[]')))`;
 return [
  db.prepare(`UPDATE booking_audit_logs SET before_json=${safeJson('before_json')},after_json=${safeJson('after_json')},reason=NULL,actor_name=NULL,
   customer_redacted_at=CASE WHEN booking_id IN (${inBookings}) OR (booking_id IS NULL AND booking_id_history IN (${inBookings})) THEN COALESCE(customer_redacted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE customer_redacted_at END,
   actor_id=CASE WHEN actor_type='customer' THEN NULL ELSE actor_id END
   WHERE line_account_id IS ? AND (booking_id IN (${inBookings}) OR (booking_id IS NULL AND booking_id_history IN (${inBookings})) OR (actor_type='customer' AND actor_id=?))`).bind(ids,ids,accountId,ids,ids,friendId),
  db.prepare(`UPDATE booking_payment_events SET receipt_url=NULL WHERE line_account_id IS ? AND payment_id IN (${paymentIds})`).bind(accountId,...paymentArgs),
  db.prepare(`UPDATE booking_payment_refunds SET reason='削除済み',actor_label='削除済み' WHERE line_account_id IS ? AND payment_id IN (${paymentIds})`).bind(accountId,...paymentArgs),
  db.prepare(`UPDATE booking_payment_booking_links SET reason='削除済み',actor_label='削除済み' WHERE line_account_id IS ? AND booking_id IN (${inBookings})`).bind(accountId,ids),
  db.prepare(`UPDATE booking_payments SET receipt_url=NULL,action_reason=NULL,actor_label=NULL,customer_redacted_at=COALESCE(customer_redacted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id IN (${paymentIds})`).bind(...paymentArgs),
  db.prepare(`UPDATE booking_cancellation_events SET reason=NULL WHERE charge_id IN (SELECT id FROM booking_charges WHERE line_account_id IS ? AND booking_id IN (${inBookings}))`).bind(accountId,ids),
  db.prepare(`UPDATE booking_charges SET reason=NULL,policy_snapshot_json=${safePolicy} WHERE line_account_id IS ? AND booking_id IN (${inBookings})`).bind(accountId,ids),
  db.prepare(`UPDATE stripe_events SET metadata=NULL WHERE (friend_id=? OR (friend_id IS NULL AND CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.line_friend_id')=? ELSE 0 END))
   AND EXISTS(SELECT 1 FROM friends WHERE id=? AND line_account_id IS ?)`).bind(friendId,friendId,friendId,accountId),
  db.prepare(`UPDATE stripe_events SET metadata=json_remove(metadata,'$.line_friend_id') WHERE friend_id IS NOT NULL AND friend_id<>?
   AND CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.line_friend_id')=? ELSE 0 END
   AND EXISTS(SELECT 1 FROM friends WHERE id=? AND line_account_id IS ?)`).bind(friendId,friendId,friendId,accountId),
 ];
}
