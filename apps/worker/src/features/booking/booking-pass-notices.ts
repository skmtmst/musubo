import {getAccountTimeZone,tzDateStr} from '../../services/availability.js';
import {restaurantCivilTime} from '../../services/restaurant-booking.js';
import {purposeAliases} from '../broadcasts/broadcast-simulation/index.js';

export async function processPassNotices(db:D1Database,now=new Date(),account?:string){
 const at=now.toISOString();
 const accounts=(await db.prepare(`SELECT a.id FROM line_accounts a WHERE a.is_active=1 AND a.archived_at IS NULL
 AND (a.tenant_id IS NULL OR EXISTS(SELECT 1 FROM tenants t WHERE t.id=a.tenant_id AND t.status='active')) AND (? IS NULL OR a.id=?)`).bind(account??null,account??null).all<{id:string}>()).results;
 let processed=0;
 for(const a of accounts){
  const zone=await getAccountTimeZone(db,a.id),today=tzDateStr(zone,now);
  const targetDay=new Date(Date.parse(today+'T00:00:00Z')+14*86400000).toISOString().slice(0,10),endDay=new Date(Date.parse(targetDay+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const expiryFrom=restaurantCivilTime(targetDay,0,zone),expiryTo=restaurantCivilTime(endDay,0,zone);
  // 期限に近い候補だけを読み、cron が重なっても一意キーで通知の重複を防ぐ。
  const expiring=(await db.prepare(`SELECT e.id,e.friend_id,e.plan_id,e.name,e.expires_at FROM booking_entitlements e
 JOIN booking_pass_plans p ON p.id=e.plan_id AND p.line_account_id=e.line_account_id
 WHERE e.line_account_id=? AND e.status='active' AND e.friend_id IS NOT NULL AND p.notify_expiry_14_days=1
 AND julianday(e.valid_from)<=julianday(?) AND julianday(e.expires_at)>julianday(?) AND julianday(e.expires_at)>=julianday(?) AND julianday(e.expires_at)<julianday(?)
 AND NOT EXISTS(SELECT 1 FROM booking_entitlement_notices n WHERE n.entitlement_id=e.id AND n.kind='expiry_14_days' AND n.dedupe_key=e.expires_at)
 ORDER BY e.expires_at,e.id LIMIT 100`).bind(a.id,at,at,expiryFrom,expiryTo).all<{id:string;friend_id:string;plan_id:string;name:string;expires_at:string}>()).results;
  for(const e of expiring){
   const expiryDay=tzDateStr(zone,new Date(e.expires_at)),dueDay=new Date(Date.parse(expiryDay+'T00:00:00Z')-14*86400000).toISOString().slice(0,10);
   if(today!==dueDay)continue;
   const scheduled=restaurantCivilTime(dueDay,8*60,zone);
   await db.prepare(`INSERT INTO booking_entitlement_notices(id,line_account_id,friend_id,entitlement_id,plan_id,kind,dedupe_key,messages_json,scheduled_at)
 SELECT ?,?,?,?,?,'expiry_14_days',?,?,? WHERE EXISTS(SELECT 1 FROM booking_entitlements e JOIN booking_pass_plans p ON p.id=e.plan_id AND p.line_account_id=e.line_account_id WHERE e.id=? AND e.status='active' AND e.expires_at=? AND p.notify_expiry_14_days=1)
 ON CONFLICT(entitlement_id,kind,dedupe_key) DO NOTHING`).bind(crypto.randomUUID(),a.id,e.friend_id,e.id,e.plan_id,e.expires_at,JSON.stringify([{type:'text',text:`${e.name}の期限は${expiryDay}です（あと14日）`}]),scheduled,e.id,e.expires_at).run();
  }
  const rows=(await db.prepare("SELECT id,scheduled_at FROM booking_entitlement_notices WHERE line_account_id=? AND status='scheduled' AND julianday(scheduled_at)<=julianday(?) ORDER BY scheduled_at,id LIMIT 100").bind(a.id,at).all<{id:string;scheduled_at:string}>()).results;
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'}).format(now));
  for(const n of rows){
   const dueHour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'}).format(new Date(n.scheduled_at)));
   let scheduled=n.scheduled_at;
   if(dueHour<8||dueHour>=21){
    const dueDay=tzDateStr(zone,new Date(scheduled)),day=dueHour>=21?new Date(Date.parse(dueDay+'T00:00:00Z')+86400000).toISOString().slice(0,10):dueDay;
    scheduled=restaurantCivilTime(day,8*60,zone);
    await db.prepare("UPDATE booking_entitlement_notices SET scheduled_at=? WHERE id=? AND status='scheduled'").bind(scheduled,n.id).run();
   }
   if(Date.parse(scheduled)>now.getTime())continue;
   if((hour<8||hour>=21)&&now.getTime()-Date.parse(scheduled)<=3*3600000){
    const day=hour>=21?new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10):today;
    await db.prepare("UPDATE booking_entitlement_notices SET scheduled_at=? WHERE id=? AND status='scheduled'").bind(restaurantCivilTime(day,8*60,zone),n.id).run();continue;
   }
   const r=await db.prepare(`UPDATE booking_entitlement_notices AS n SET status=CASE
 WHEN NOT EXISTS(SELECT 1 FROM booking_pass_plans p WHERE p.id=n.plan_id AND p.line_account_id=n.line_account_id AND CASE WHEN n.kind='remaining_one' THEN p.notify_remaining_one ELSE p.notify_expiry_14_days END=1) THEN 'skipped_disabled'
 WHEN NOT EXISTS(SELECT 1 FROM booking_entitlements e JOIN friends f ON f.id=e.friend_id AND f.line_account_id=e.line_account_id JOIN line_accounts a ON a.id=e.line_account_id
 WHERE e.id=n.entitlement_id AND e.line_account_id=n.line_account_id AND e.friend_id=n.friend_id AND e.status='active' AND e.billing_status!='stopped' AND (e.billing_status!='grace' OR julianday(e.grace_until)>julianday(?)) AND f.is_following=1 AND f.is_hidden=0 AND f.line_platform_user_id IS NOT NULL AND f.line_platform_user_id<>''
 AND julianday(e.valid_from)<=julianday(?) AND julianday(e.expires_at)>julianday(?) AND (n.kind='remaining_one' AND e.remaining=1 OR n.kind='expiry_14_days' AND e.expires_at=n.dedupe_key)
 AND a.is_active=1 AND a.archived_at IS NULL AND (a.tenant_id IS NULL OR EXISTS(SELECT 1 FROM tenants t WHERE t.id=a.tenant_id AND t.status='active'))) THEN 'skipped_unavailable'
 WHEN EXISTS(SELECT 1 FROM friend_delivery_consents c WHERE c.friend_id=n.friend_id AND c.line_account_id=n.line_account_id AND c.purpose IN(SELECT value FROM json_each(?)) AND c.state!='granted') THEN 'skipped_opted_out'
 WHEN julianday(?)>julianday(n.scheduled_at,'+3 hours') THEN 'skipped_late' ELSE 'simulated' END,
 messages_json=CASE WHEN n.kind='remaining_one' THEN COALESCE((SELECT json_array(json_object('type','text','text',e.name||'の残りは1回です（期限 '||e.expires_at||'）')) FROM booking_entitlements e WHERE e.id=n.entitlement_id),messages_json) ELSE messages_json END,processed_at=?
 WHERE id=? AND status='scheduled'`).bind(at,at,at,JSON.stringify([...purposeAliases.transaction,'booking_reminders']),at,at,n.id).run();
   processed+=r.meta.changes;
  }
 }
 return {processed,sent:false as const,testMode:true as const};
}
