import { restaurantReservationAnswerError } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import { tzDateStr } from '../../services/availability.js';
import { customerAvailability, type CustomerReservationRow, type CustomerStore } from '../../services/restaurant-customer-booking.js';
import { restaurantSeatCapacity } from '../../services/restaurant-seat-capacity.js';
import { readRestaurantCustomerReservationForm } from '../../services/restaurant-reservation-form.js';
import { bookingStripeTestRequest, listBookingStripeTestRefunds } from './booking-stripe-test-api.js';
import { restaurantTestEnabled } from '../../lib/environment-features.js';
import { accountFeatureIsEnabled } from '../../services/feature-enforcement.js';

interface Payment {id:string;line_account_id:string;store_id:string;reservation_id:string;connect_account:string;amount:number;payment_intent_id:string|null;status:string;refund_started_at:string|null;stripe_refund_id:string|null}
const paymentById=(db:D1Database,id:string)=>db.prepare('SELECT * FROM restaurant_payment_requests WHERE id=?').bind(id).first<Payment>();
/** 全額のみ。結果不明は同じ操作の照会・再送で回収し、成功するまで取消を確定しない。 */
export async function refundRestaurantPayment(env:Env['Bindings'],id:string,reconcileOnly=false):Promise<'refunded'|'pending'> {
 const db=env.DB;let p=await paymentById(db,id);
 if(!p?.payment_intent_id || !/^pi_[A-Za-z0-9]+$/.test(p.payment_intent_id))return 'pending';
 if(p.status==='refunded')return 'refunded';
 if(!['paid','refund_pending'].includes(p.status))return 'pending';
 let first=false;
 if(p.status==='paid') {
  if(reconcileOnly || !restaurantTestEnabled(env) || !await accountFeatureIsEnabled(db,p.line_account_id,'restaurant_test'))return 'pending';
  const now=new Date().toISOString();const update=await db.prepare("UPDATE restaurant_payment_requests SET status='refund_pending',refund_started_at=?,updated_at=? WHERE id=? AND status='paid'").bind(now,now,id).run();
  first=Boolean(update.meta.changes);p=await paymentById(db,id);if(!p || p.status==='refunded')return p?.status==='refunded'?'refunded':'pending';
 }
 const saved=p, intent=p.payment_intent_id;
 if(!intent || !env.BOOKING_STRIPE_TEST_SECRET_KEY || !/^sk_test_[A-Za-z0-9]+$/.test(env.BOOKING_STRIPE_TEST_SECRET_KEY))return 'pending';
 const send=async()=>{
  if(!restaurantTestEnabled(env) || !await accountFeatureIsEnabled(db,saved.line_account_id,'restaurant_test'))throw new Error('restaurant_payment_disabled');
  return bookingStripeTestRequest({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:saved.connect_account,operation:'refunds',idempotencyKey:`restaurant_refund_${saved.id}`,
   body:{payment_intent:intent,amount:saved.amount,'metadata[restaurant_payment_id]':saved.id}});
 };
 let refund:Record<string,unknown>|undefined;
 try {
  if(first)refund=await send();
  else {
   const matches=(await listBookingStripeTestRefunds({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:saved.connect_account,paymentIntentId:intent}))
    .filter(row=>(row.metadata as Record<string,unknown>|undefined)?.restaurant_payment_id===saved.id);
   if(matches.length===1)refund=matches[0];
   else if(!reconcileOnly && matches.length===0 && saved.refund_started_at && Date.now()-Date.parse(saved.refund_started_at)<23*60*60*1000)refund=await send();
  }
 } catch { return 'pending'; }
 if(!refund || (refund.livemode!==undefined && refund.livemode!==false) || typeof refund.id!=='string' || !/^re_[A-Za-z0-9]+$/.test(refund.id)
   || refund.amount!==saved.amount || refund.currency!=='jpy' || refund.payment_intent!==intent || refund.status!=='succeeded'
   || (refund.metadata as Record<string,unknown>|undefined)?.restaurant_payment_id!==saved.id)return 'pending';
 await db.prepare("UPDATE restaurant_payment_requests SET status='refunded',stripe_refund_id=?,updated_at=? WHERE id=? AND status='refund_pending'").bind(refund.id,new Date().toISOString(),saved.id).run();
 return (await paymentById(db,id))?.status==='refunded'?'refunded':'pending';
}

/** 入金後も営業時間と席・顧客フォームの版を再確認し、空いていない場合は返金する。 */
export async function finishRestaurantPaidReservation(env:Env['Bindings'],paymentId:string):Promise<void> {
 const db=env.DB,payment=await paymentById(db,paymentId);if(!payment || payment.status==='refunded')return;
 if(payment.status==='refund_pending'){await refundRestaurantPayment(env,payment.id);return;}
 if(payment.status!=='paid')return;
 const row=await db.prepare(`SELECT r.*,NULL seat_type FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id
   WHERE r.id=? AND s.id=? AND s.line_account_id=?`).bind(payment.reservation_id,payment.store_id,payment.line_account_id).first<CustomerReservationRow>();
 if(!row || row.status==='cancelled' || row.status==='rejected'){await refundRestaurantPayment(env,payment.id);return;}
 if(['confirmed','seated','visited','no_show'].includes(row.status))return;
 if(row.status!=='pending')return;
 if(Date.parse(row.starts_at)<=Date.now()){await refundRestaurantPayment(env,payment.id);return;}
 const details=await db.prepare('SELECT customer_name,customer_phone,allergy_note,note,form_version FROM restaurant_payment_details WHERE request_id=?').bind(payment.id)
  .first<{customer_name:string;customer_phone:string|null;allergy_note:string|null;note:string|null;form_version:number}>();
 if(!details){await refundRestaurantPayment(env,payment.id);return;}
 const store=await db.prepare(`SELECT s.id,s.name,s.timezone,s.line_account_id,a.tenant_id FROM rt_stores s JOIN line_accounts a ON a.id=s.line_account_id
   WHERE s.id=? AND s.line_account_id=? AND s.status='active' AND a.is_active=1 AND a.archived_at IS NULL`).bind(payment.store_id,payment.line_account_id).first<CustomerStore>();
 if(!store){await refundRestaurantPayment(env,payment.id);return;}
 const formSnapshot=await readRestaurantCustomerReservationForm(db,store.id,payment.line_account_id);
 if((formSnapshot.form?.version ?? 0)!==details.form_version || (formSnapshot.form && restaurantReservationAnswerError(formSnapshot.form.definition,{customerName:details.customer_name,customerPhone:details.customer_phone,allergyNote:details.allergy_note,note:details.note}))) {
  await refundRestaurantPayment(env,payment.id);return;
 }
 const availability=await customerAvailability(db,store,tzDateStr(store.timezone,new Date(row.starts_at)),row.guest_count,row.id,row.course_id);
 const slot=availability?.data.slots.find(s=>s.startsAt===row.starts_at && s.endsAt===row.ends_at && s.available);
 if(!availability || !slot){await refundRestaurantPayment(env,payment.id);return;}
 const capacity=await restaurantSeatCapacity(db,store.id,row.starts_at,row.ends_at,row.id);
 const selected=capacity.select({startsAt:row.starts_at,endsAt:row.ends_at,guestCount:row.guest_count,tableId:row.hold_expires_at && Date.parse(row.hold_expires_at)>Date.now()?row.table_id:null});
 if(!selected){await refundRestaurantPayment(env,payment.id);return;}
 const now=new Date().toISOString(),table=capacity.settings.enabled?selected.id:null;
 let results:Awaited<ReturnType<typeof capacity.commit>>;
 try { results=await capacity.commit([
  ...(formSnapshot.form?[formSnapshot.guard]:[]),
  db.prepare(`UPDATE rt_reservations SET confirmation_revision=confirmation_revision+1,status='confirmed',table_id=?,customer_name=?,customer_phone=?,allergy_note=?,note=?,customer_version=customer_version+1,hold_expires_at=NULL,updated_at=datetime('now')
   WHERE id=? AND store_id=? AND line_uid=? AND status='pending' AND customer_version=? AND starts_at=? AND ends_at=? AND guest_count=? AND course_id IS ?
   AND EXISTS(SELECT 1 FROM restaurant_payment_requests WHERE id=? AND reservation_id=rt_reservations.id AND status='paid')
   AND EXISTS(SELECT 1 FROM rt_opening_hours_settings WHERE store_id=? AND version=?)`)
   .bind(table,details.customer_name,details.customer_phone,details.allergy_note,details.note,row.id,store.id,row.line_uid,row.customer_version,row.starts_at,row.ends_at,row.guest_count,row.course_id ?? null,payment.id,store.id,availability.hoursVersion),
  db.prepare(`INSERT OR IGNORE INTO rt_customer_notice_outbox(id,store_id,reservation_id,customer_version,line_uid,message,retry_key)
   SELECT ?,?,?,?,?,?,? WHERE changes()=1`).bind(`restaurant-customer:${row.id}:${row.customer_version+1}`,store.id,row.id,row.customer_version+1,row.line_uid,
    `${store.name}の予約を確定しました。\n${new Intl.DateTimeFormat('ja-JP',{timeZone:store.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(row.starts_at))}\n${row.guest_count}名\n変更・取り消しはLINEの予約ページから行えます。`,crypto.randomUUID())
 ]); } catch(error) {
  if(/customer_duplicate_booking|customer_table_conflict|restaurant_table_conflict|closure_conflict/.test(String(error))) {
   await refundRestaurantPayment(env,payment.id);return;
  }
  if(String(error).includes('RESTAURANT_CAPACITY_CHANGED')) {
   const fresh=await customerAvailability(db,store,tzDateStr(store.timezone,new Date(row.starts_at)),row.guest_count,row.id,row.course_id);
   if(fresh && !fresh.data.slots.some(s=>s.startsAt===row.starts_at && s.endsAt===row.ends_at && s.available)) { await refundRestaurantPayment(env,payment.id);return; }
  }
  throw error;
 }
 if(!results[(formSnapshot.form?1:0)+1]?.meta.changes)logger.warn('restaurant_payment_confirmation_retry');
}

/** 取消中の印を版つきで固定し、返金成功後に予約取消と通知を原子的に記録する。 */
export async function cancelPaidRestaurantReservation(env:Env['Bindings'],paymentId:string,expectedVersion:number,reason:string|null=null):Promise<'cancelled'|'pending'> {
 const db=env.DB;
 let payment=await paymentById(db,paymentId);if(!payment)return 'pending';
 const now=new Date().toISOString();
 const row=await db.prepare('SELECT id,store_id,line_uid,status,customer_version FROM rt_reservations WHERE id=?').bind(payment.reservation_id)
  .first<{id:string;store_id:string;line_uid:string;status:string;customer_version:number}>();
 if(!row)return 'pending';
 if(row.status==='cancelled')return 'cancelled';
 if(row.customer_version!==expectedVersion || !['pending','confirmed'].includes(row.status))return 'pending';
 if(payment.status==='paid' && (!restaurantTestEnabled(env) || !await accountFeatureIsEnabled(db,payment.line_account_id,'restaurant_test')))return 'pending';
 if(payment.status==='paid' || payment.status==='refunded') {
  const next=payment.status==='paid'?'refund_pending':'refunded';
  await db.prepare(`UPDATE restaurant_payment_requests SET status=?,cancel_requested=1,cancel_expected_version=?,cancel_reason=?,
    refund_started_at=COALESCE(refund_started_at,?),updated_at=? WHERE id=? AND status=? AND cancel_requested=0
    AND EXISTS(SELECT 1 FROM rt_reservations WHERE id=? AND status IN ('pending','confirmed') AND customer_version=?)`)
   .bind(next,expectedVersion,reason,now,now,paymentId,payment.status,row.id,expectedVersion).run();
 }
 payment=await paymentById(db,paymentId);
 const claim=await db.prepare('SELECT cancel_requested,cancel_expected_version,cancel_reason FROM restaurant_payment_requests WHERE id=?').bind(paymentId)
  .first<{cancel_requested:number;cancel_expected_version:number|null;cancel_reason:string|null}>();
 if(!payment || claim?.cancel_requested!==1 || claim.cancel_expected_version!==expectedVersion || claim.cancel_reason!==reason)return 'pending';
 if(payment.status!=='refunded' && await refundRestaurantPayment(env,paymentId)!=='refunded')return 'pending';
 const store=await db.prepare('SELECT name FROM rt_stores WHERE id=? AND line_account_id=?').bind(row.store_id,payment.line_account_id).first<{name:string}>();
 if(!store)return 'pending';
 const results=await db.batch([
  db.prepare(`UPDATE rt_reservations SET confirmation_revision=confirmation_revision+1,status='cancelled',cancel_reason=COALESCE(?,cancel_reason),customer_version=customer_version+1,hold_expires_at=NULL,updated_at=datetime('now')
    WHERE id=? AND status IN ('pending','confirmed') AND customer_version=? AND EXISTS(SELECT 1 FROM restaurant_payment_requests WHERE id=? AND status='refunded' AND cancel_requested=1 AND cancel_expected_version=?)`)
   .bind(reason,row.id,expectedVersion,paymentId,expectedVersion),
  db.prepare(`INSERT OR IGNORE INTO rt_customer_notice_outbox(id,store_id,reservation_id,customer_version,line_uid,message,retry_key)
    SELECT ?,?,?,?,?,?,? WHERE changes()=1`).bind(`restaurant-customer:${row.id}:${expectedVersion+1}`,row.store_id,row.id,expectedVersion+1,row.line_uid,`${store.name}の予約を取り消しました。`,crypto.randomUUID())
 ]);
 if(results[0].meta.changes)return 'cancelled';
 const current=await db.prepare('SELECT status FROM rt_reservations WHERE id=?').bind(row.id).first<{status:string}>();
 return current?.status==='cancelled'?'cancelled':'pending';
}
