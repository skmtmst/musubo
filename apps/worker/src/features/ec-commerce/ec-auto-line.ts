import {prepareAutoLineSimulationCap} from './ec-auto-line-cap.js';
import {GapError} from '../../services/gap-common.js';
import {getAccountTimeZone,tzHHMM,tzDateStr} from '../../services/availability.js';
import {restaurantCivilTime} from '../../services/restaurant-booking.js';
export const autoKinds=['cart','browse','restock']as const;
export async function autoLineRules(db:D1Database,a:string){
 const rows=(await db.prepare('SELECT * FROM ec_auto_line_rules WHERE account_id=?').bind(a).all<Record<string,unknown>>()).results;
 return autoKinds.map(kind=>{const r=rows.find(x=>x.kind===kind);return {kind,enabled:!!r?.enabled,waitMinutes:Number(r?.wait_minutes??(kind==='cart'?60:kind==='browse'?1440:0)),messages:JSON.parse(String(r?.messages_json??'[]')),version:Number(r?.version??0),testMode:true};});
}
export async function ingestBehavior(db:D1Database,a:string,b:Record<string,unknown>,now=new Date()){
 if(!b||typeof b!=='object'||Array.isArray(b))throw new GapError('invalid_event');
 if(typeof b.eventId!=='string'||!b.eventId||b.eventId.length>128||!['cart_add','cart_remove','product_view','purchase','restock','restock_subscribe'].includes(String(b.type))||typeof b.productId!=='string'||!b.productId||b.productId.length>128||typeof b.occurredAt!=='string'||!Number.isFinite(Date.parse(b.occurredAt))||Date.parse(b.occurredAt)>now.getTime()+300000)throw new GapError('invalid_event');
 if(!b||typeof b!=='object'||Array.isArray(b))throw new GapError('invalid_event');
 const customer=typeof b.customerId==='string'?b.customerId:null;
 const f=customer?await db.prepare('SELECT friend_id FROM ec_identity_links WHERE line_account_id=? AND external_customer_id=? AND unlinked_at IS NULL').bind(a,customer).first<{friend_id:string}>():null;
 // 公開訪問者の友だち ID を信用しないよう、計測同意は認証済みの自社 EC 接続から受け取る。
 if(['product_view','cart_add','cart_remove'].includes(String(b.type))&&b.trackingConsent!==true)return {accepted:false,reason:'tracking_consent_required'};
 const id=crypto.randomUUID(),insert=await db.prepare(`INSERT INTO ec_behavior_events(id,account_id,friend_id,ec_customer_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM ec_behavior_events WHERE account_id=? AND julianday(received_at)>=julianday(?,'-1 minute'))<600 ON CONFLICT(account_id,dedupe_key) DO NOTHING`).bind(id,a,f?.friend_id??null,customer,b.type,b.productId,JSON.stringify({stock:Number.isSafeInteger(b.stock)?b.stock:null}),b.occurredAt,now.toISOString(),b.eventId,a,now.toISOString()).run();
 const saved=await db.prepare('SELECT id,type,product_id,ec_customer_id,occurred_at FROM ec_behavior_events WHERE account_id=? AND dedupe_key=?').bind(a,b.eventId).first<{id:string;type:string;product_id:string;ec_customer_id:string|null;occurred_at:string}>();if(!saved)throw new GapError('rate_limited',429);if(saved.type!==b.type||saved.product_id!==b.productId||saved.ec_customer_id!==customer||saved.occurred_at!==b.occurredAt)throw new GapError('idempotency_conflict',409);
 if(!insert.meta.changes||!f&&b.type!=='restock')return {accepted:true,matched:!!f,duplicate:!insert.meta.changes};
 const rules=await autoLineRules(db,a),kind=b.type==='cart_add'?'cart':b.type==='product_view'?'browse':null;
 if(kind&&f){const r=rules.find(x=>x.kind===kind)!;
 if(r.enabled){const browse=kind!=='browse'||(await db.prepare("SELECT count(*) n FROM ec_behavior_events WHERE account_id=? AND friend_id=? AND product_id=? AND type='product_view' AND julianday(occurred_at)>=julianday(?,'-24 hours')").bind(a,f.friend_id,b.productId,b.occurredAt).first<{n:number}>())!.n>=2;
 if(browse){const due=new Date(Date.parse(b.occurredAt)+r.waitMinutes*60000).toISOString();await db.prepare('INSERT OR IGNORE INTO ec_auto_line_sends(id,account_id,rule_kind,friend_id,product_id,trigger_event_id,scheduled_at,original_due_at,messages_snapshot_json) VALUES(?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),a,kind,f.friend_id,b.productId,id,due,due,JSON.stringify(r.messages)).run();}}
 }
 if(b.type==='restock'&&Number(b.stock)>0){const r=rules.find(x=>x.kind==='restock')!;if(r.enabled){await db.prepare(`INSERT OR IGNORE INTO ec_auto_line_sends(id,account_id,rule_kind,friend_id,product_id,trigger_event_id,scheduled_at,original_due_at,messages_snapshot_json) SELECT lower(hex(randomblob(16))),?,'restock',friend_id,?,id,?,?,? FROM ec_behavior_events WHERE account_id=? AND product_id=? AND type='restock_subscribe' AND friend_id IS NOT NULL`).bind(a,b.productId,now.toISOString(),now.toISOString(),JSON.stringify(r.messages),a,b.productId).run();}}
 return {accepted:true,matched:true,duplicate:false};
}
export async function processAutoLineMock(db:D1Database,now=new Date(),account?:string){
 const rows=(await db.prepare("SELECT s.*,e.occurred_at FROM ec_auto_line_sends s JOIN ec_behavior_events e ON e.id=s.trigger_event_id WHERE s.status='scheduled' AND (? IS NULL OR s.account_id=?) AND julianday(s.scheduled_at)<=julianday(?) ORDER BY s.scheduled_at,s.id LIMIT 100").bind(account??null,account??null,now.toISOString()).all<Record<string,unknown>>()).results;
 let processed=0;
 for(const s of rows){
 const a=String(s.account_id),f=String(s.friend_id),at=now.toISOString(),tz=await getAccountTimeZone(db,a),hour=tzHHMM(tz,now),day=tzDateStr(tz,now),rules=await autoLineRules(db,a);let status='simulated';
 const friend=await db.prepare('SELECT is_following FROM friends WHERE id=? AND line_account_id=?').bind(f,a).first<{is_following:number}>();
 if(!friend?.is_following)status='skipped_blocked';
 if(!rules.find(r=>r.kind===s.rule_kind)?.enabled)status='skipped_disabled';
 if(await db.prepare("SELECT id FROM ec_behavior_events WHERE account_id=? AND friend_id=? AND type='purchase' AND julianday(occurred_at)>=julianday(?) LIMIT 1").bind(a,f,s.occurred_at).first()||await db.prepare("SELECT id FROM ec_orders WHERE line_account_id=? AND friend_id=? AND normalized_status='current' AND julianday(ordered_at)>=julianday(?) LIMIT 1").bind(a,f,s.occurred_at).first())status='skipped_purchased';
 const consents=(await db.prepare("SELECT state FROM friend_delivery_consents WHERE line_account_id=? AND friend_id=? AND purpose IN('promotion','marketing','advertising','宣伝')").bind(a,f).all<{state:string}>()).results;
 if(consents.some(c=>c.state==='revoked'))status='skipped_opted_out';
 else if(status==='simulated'&&(!consents.some(c=>c.state==='granted')||consents.some(c=>c.state!=='granted')))continue;
 if(s.rule_kind==='cart'){
 const latest=await db.prepare("SELECT id,type,occurred_at FROM ec_behavior_events WHERE account_id=? AND friend_id=? AND product_id=? AND type IN('cart_add','cart_remove') ORDER BY julianday(occurred_at) DESC,received_at DESC,id DESC LIMIT 1").bind(a,f,s.product_id).first<{id:string;type:string;occurred_at:string}>();
 if(latest?.type==='cart_remove')status='skipped_removed';
 else if(latest&&latest.id!==s.trigger_event_id)status='skipped_replaced';
 }
 if(s.rule_kind==='browse'&&await db.prepare("SELECT id FROM ec_behavior_events WHERE account_id=? AND friend_id=? AND product_id=? AND type='cart_add' AND julianday(occurred_at)>=julianday(?)").bind(a,f,s.product_id,s.occurred_at).first())status='skipped_cart';
 if(s.rule_kind==='restock'){const stock=await db.prepare("SELECT json_extract(product_snapshot_json,'$.stock') stock FROM ec_behavior_events WHERE account_id=? AND product_id=? AND type='restock' ORDER BY occurred_at DESC LIMIT 1").bind(a,s.product_id).first<{stock:number}>();if(!stock||!Number.isFinite(stock.stock)||stock.stock<=0)status='skipped_stock';}
 // 注文照会アダプターがないため、イベントの到着遅延を10分待ってから購入を最終確認する。
 if(status==='simulated'&&Date.parse(String(s.original_due_at))+10*60000>now.getTime())continue;
 if(status==='simulated'&&(hour<'08:00'||hour>='21:00')){
 const nextDay=hour<'08:00'?day:new Date(Date.parse(day)+86400000).toISOString().slice(0,10),next=restaurantCivilTime(nextDay,480,tz);
 await db.prepare("UPDATE ec_auto_line_sends SET scheduled_at=? WHERE id=? AND status='scheduled'").bind(next,s.id).run();continue;
 }
 if(status==='simulated'&&((s.rule_kind==='cart'&&now.getTime()-Date.parse(String(s.original_due_at))>12*3600000)||now.getTime()-Date.parse(String(s.scheduled_at))>=3*3600000))status='skipped_late';
 // 共通の日次上限は店のタイムゾーンではなく日本時間の暦日で数える。
 const midnight=restaurantCivilTime(tzDateStr('Asia/Tokyo',now),0,'Asia/Tokyo');
 // 並行実行でも上限を超えないよう、送信権と3つの上限を1つの条件付き UPDATE で確認する。
 const reservationId=crypto.randomUUID(),claimToken=crypto.randomUUID();
 const update=db.prepare(`UPDATE ec_auto_line_sends SET status=?,sent_at=CASE WHEN ?='simulated' THEN ? ELSE NULL END,claim_token=? WHERE id=? AND status='scheduled'
 AND (?!='simulated' OR EXISTS(SELECT 1 FROM ec_auto_line_cap_reservations WHERE id=? AND candidate_id=ec_auto_line_sends.id AND mode='simulation' AND state='reserved'))
 AND (?!='simulated' OR (
 EXISTS(SELECT 1 FROM friends WHERE id=? AND line_account_id=? AND is_following=1)
 AND EXISTS(SELECT 1 FROM line_accounts account JOIN tenants tenant ON tenant.id=account.tenant_id JOIN ec_connectors connector ON connector.line_account_id=account.id WHERE account.id=ec_auto_line_sends.account_id AND account.is_active=1 AND account.archived_at IS NULL AND tenant.status='active' AND connector.status='connected')
 AND EXISTS(SELECT 1 FROM ec_auto_line_rules WHERE account_id=? AND kind=? AND enabled=1)
 AND NOT EXISTS(SELECT 1 FROM ec_behavior_events WHERE account_id=? AND friend_id=? AND type='purchase' AND julianday(occurred_at)>=julianday(?))
 AND NOT EXISTS(SELECT 1 FROM ec_orders WHERE line_account_id=? AND friend_id=? AND normalized_status='current' AND julianday(ordered_at)>=julianday(?))
 AND EXISTS(SELECT 1 FROM friend_delivery_consents WHERE line_account_id=? AND friend_id=? AND purpose IN('promotion','marketing','advertising','宣伝') AND state='granted')
 AND NOT EXISTS(SELECT 1 FROM friend_delivery_consents WHERE line_account_id=? AND friend_id=? AND purpose IN('promotion','marketing','advertising','宣伝') AND state!='granted')))
 AND (?!='simulated' OR (
 (rule_kind!='restock' OR COALESCE((SELECT json_extract(e.product_snapshot_json,'$.stock') FROM ec_behavior_events e WHERE e.account_id=ec_auto_line_sends.account_id AND e.product_id=ec_auto_line_sends.product_id AND e.type='restock' ORDER BY julianday(e.occurred_at) DESC,e.id DESC LIMIT 1),0)>0)
 AND (rule_kind!='browse' OR NOT EXISTS(SELECT 1 FROM ec_behavior_events e WHERE e.account_id=ec_auto_line_sends.account_id AND e.friend_id=ec_auto_line_sends.friend_id AND e.product_id=ec_auto_line_sends.product_id AND e.type='cart_add' AND julianday(e.occurred_at)>=julianday((SELECT occurred_at FROM ec_behavior_events WHERE id=ec_auto_line_sends.trigger_event_id))))
 AND (rule_kind!='cart' OR trigger_event_id=(SELECT e.id FROM ec_behavior_events e WHERE e.account_id=ec_auto_line_sends.account_id AND e.friend_id=ec_auto_line_sends.friend_id AND e.product_id=ec_auto_line_sends.product_id AND e.type IN('cart_add','cart_remove') ORDER BY julianday(e.occurred_at) DESC,e.received_at DESC,e.id DESC LIMIT 1))))
 AND (?!='simulated' OR (julianday(original_due_at) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_auto_line_sends x WHERE x.account_id=ec_auto_line_sends.account_id AND x.friend_id=ec_auto_line_sends.friend_id AND x.status='scheduled' AND x.id!=ec_auto_line_sends.id AND (julianday(x.original_due_at) IS NULL OR julianday(x.original_due_at)<julianday(ec_auto_line_sends.original_due_at) OR (julianday(x.original_due_at)=julianday(ec_auto_line_sends.original_due_at) AND x.id<ec_auto_line_sends.id)))))
 AND (?!='simulated' OR NOT EXISTS(SELECT 1 FROM ec_auto_line_sends x WHERE x.account_id=? AND x.friend_id=? AND x.status='simulated' AND (julianday(x.sent_at)>=julianday(?) OR x.product_id=? AND julianday(x.sent_at)>=julianday(?,'-30 days')))) AND (?!='simulated' OR (SELECT count(*) FROM ec_auto_line_sends x WHERE x.account_id=? AND x.friend_id=? AND x.status='simulated' AND julianday(x.sent_at)>=julianday(?,'-7 days'))<3)`).bind(status,status,at,claimToken,s.id,status,reservationId,status,f,a,a,s.rule_kind,a,f,s.occurred_at,a,f,s.occurred_at,a,f,a,f,status,status,status,a,f,midnight,s.product_id,at,status,a,f,at);
 let result:D1Result;
 if(status==='simulated'){
  const results=await db.batch([
   prepareAutoLineSimulationCap(db,a,String(s.id),now,reservationId),
   update,
   db.prepare("UPDATE ec_auto_line_cap_reservations SET state='accepted' WHERE id=? AND state='reserved' AND EXISTS(SELECT 1 FROM ec_auto_line_sends WHERE id=? AND status='simulated' AND claim_token=?)").bind(reservationId,s.id,claimToken),
   db.prepare("DELETE FROM ec_auto_line_cap_reservations WHERE id=? AND mode='simulation' AND state='reserved'").bind(reservationId),
  ]);
  // Missing or conflicting evidence is held. A proven revocation is a final stop.
  if(!results[0].meta.changes){
   const revoked=await db.prepare("UPDATE ec_auto_line_sends SET status='skipped_opted_out' WHERE id=? AND status='scheduled' AND EXISTS(SELECT 1 FROM friend_delivery_consents WHERE line_account_id=ec_auto_line_sends.account_id AND friend_id=ec_auto_line_sends.friend_id AND purpose IN('promotion','marketing','advertising','宣伝') AND state='revoked')").bind(s.id).run();
   processed+=revoked.meta.changes;
   continue;
  }
  result=results[1];
 }else result=await update.run();
 if(result.meta.changes)processed++;
 else {
  const fallback=await db.prepare(`UPDATE ec_auto_line_sends SET status=CASE
   WHEN EXISTS(SELECT 1 FROM ec_behavior_events WHERE account_id=? AND friend_id=? AND type='purchase' AND julianday(occurred_at)>=julianday(?)) OR EXISTS(SELECT 1 FROM ec_orders WHERE line_account_id=? AND friend_id=? AND normalized_status='current' AND julianday(ordered_at)>=julianday(?)) THEN 'skipped_purchased'
   WHEN EXISTS(SELECT 1 FROM friend_delivery_consents WHERE line_account_id=? AND friend_id=? AND purpose IN('promotion','marketing','advertising','宣伝') AND state='revoked') THEN 'skipped_opted_out'
   WHEN NOT EXISTS(SELECT 1 FROM ec_auto_line_rules WHERE account_id=? AND kind=? AND enabled=1) THEN 'skipped_disabled'
   WHEN NOT EXISTS(SELECT 1 FROM friends WHERE id=? AND line_account_id=? AND is_following=1) THEN 'skipped_blocked'
   WHEN rule_kind='restock' AND COALESCE((SELECT json_extract(e.product_snapshot_json,'$.stock') FROM ec_behavior_events e WHERE e.account_id=ec_auto_line_sends.account_id AND e.product_id=ec_auto_line_sends.product_id AND e.type='restock' ORDER BY julianday(e.occurred_at) DESC,e.id DESC LIMIT 1),0)<=0 THEN 'skipped_stock'
   WHEN rule_kind='browse' AND EXISTS(SELECT 1 FROM ec_behavior_events e WHERE e.account_id=ec_auto_line_sends.account_id AND e.friend_id=ec_auto_line_sends.friend_id AND e.product_id=ec_auto_line_sends.product_id AND e.type='cart_add' AND julianday(e.occurred_at)>=julianday((SELECT occurred_at FROM ec_behavior_events WHERE id=ec_auto_line_sends.trigger_event_id))) THEN 'skipped_cart'
   WHEN rule_kind='cart' AND trigger_event_id IS NOT (SELECT e.id FROM ec_behavior_events e WHERE e.account_id=ec_auto_line_sends.account_id AND e.friend_id=ec_auto_line_sends.friend_id AND e.product_id=ec_auto_line_sends.product_id AND e.type IN('cart_add','cart_remove') ORDER BY julianday(e.occurred_at) DESC,e.received_at DESC,e.id DESC LIMIT 1) THEN 'skipped_removed'
   ELSE 'skipped_cap' END WHERE id=? AND status='scheduled'
   AND EXISTS(SELECT 1 FROM line_accounts account JOIN tenants tenant ON tenant.id=account.tenant_id JOIN ec_connectors connector ON connector.line_account_id=account.id WHERE account.id=ec_auto_line_sends.account_id AND account.is_active=1 AND account.archived_at IS NULL AND tenant.status='active' AND connector.status='connected')
   AND julianday(original_due_at) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ec_auto_line_sends x WHERE x.account_id=ec_auto_line_sends.account_id AND x.friend_id=ec_auto_line_sends.friend_id AND x.status='scheduled' AND x.id!=ec_auto_line_sends.id AND (julianday(x.original_due_at) IS NULL OR julianday(x.original_due_at)<julianday(ec_auto_line_sends.original_due_at) OR (julianday(x.original_due_at)=julianday(ec_auto_line_sends.original_due_at) AND x.id<ec_auto_line_sends.id)))
   AND (EXISTS(SELECT 1 FROM friend_delivery_consents WHERE line_account_id=? AND friend_id=? AND purpose IN('promotion','marketing','advertising','宣伝') AND state='revoked')
     OR (EXISTS(SELECT 1 FROM friend_delivery_consents WHERE line_account_id=? AND friend_id=? AND purpose IN('promotion','marketing','advertising','宣伝') AND state='granted')
       AND NOT EXISTS(SELECT 1 FROM friend_delivery_consents WHERE line_account_id=? AND friend_id=? AND purpose IN('promotion','marketing','advertising','宣伝') AND state!='granted')))`).bind(a,f,s.occurred_at,a,f,s.occurred_at,a,f,a,s.rule_kind,f,a,s.id,a,f,a,f,a,f).run();
  processed+=fallback.meta.changes;
 }
 }
 return {processed};
}
