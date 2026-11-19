import { normalizePhone, restaurantReservationAnswerError, type RestaurantCustomerDetails } from '@line-crm/shared';
import { customerDetailValue, validCustomerDetails } from '../../services/restaurant-customer-booking.js';
import { readRestaurantCustomerReservationForm } from '../../services/restaurant-reservation-form.js';
import { GapError } from '../../services/gap-common.js';
import type { Env } from '../../worker-env.js';
import { restaurantPaymentQuote } from './restaurant-payment-quote.js';
import { bookingStripeTestRequest } from './booking-stripe-test-api.js';
import { prepareBookingStripeBinding } from './booking-stripe-webhooks/index.js';
import { replayRestaurantPaymentReceipts } from './booking-stripe-webhooks/restaurant-payment.js';

interface Reservation {id:string;store_id:string;line_uid:string;course_id:string|null;guest_count:number;starts_at:string;status:string;customer_version:number;hold_expires_at:string|null;timezone:string;tenant_id:string;liff_id:string;friend_id:string;customer_name:string;customer_phone:string|null;allergy_note:string|null;note:string|null}
interface Attempt {id:string;reservation_id:string;form_submission_id:string|null;connect_account:string;request_json:string;total_amount:number;amount:number;customer_id:string|null;checkout_id:string|null;checkout_url:string|null;status:string;created_at:string}

/** 本人の仮押さえから金額を固定し、同じ予約・同じ回答の支払いを重ねない。 */
export async function startRestaurantPayment(env:Env['Bindings'],account:string,uid:string,reservationId:string,version:number,input:RestaurantCustomerDetails & {paymentMethod?:unknown;formSubmissionId?:string;formId?:string}) {
  const db=env.DB;
  const reservation=await db.prepare(`SELECT r.id,r.store_id,r.line_uid,r.course_id,r.guest_count,r.starts_at,r.status,r.customer_version,r.hold_expires_at,r.customer_name,r.customer_phone,r.allergy_note,r.note,s.timezone,a.tenant_id,a.liff_id,f.id friend_id
    FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id JOIN line_accounts a ON a.id=s.line_account_id
    JOIN friends f ON f.line_account_id=a.id AND f.line_user_id=r.line_uid
    WHERE r.id=? AND r.line_uid=? AND a.id=? AND s.status='active' AND a.is_active=1 AND a.archived_at IS NULL AND f.is_following=1`)
    .bind(reservationId,uid,account).first<Reservation>();
  if(!reservation)throw new GapError('not_found',404);
  if(reservation.customer_version!==version)throw new GapError('version_conflict',409);
  if(reservation.status!=='pending' || !reservation.hold_expires_at || Date.parse(reservation.hold_expires_at)<=Date.now())throw new GapError('hold_expired',409);
  if(!validCustomerDetails(input))throw new GapError('invalid_customer_details');
  const details={customerName:input.customerName===undefined?reservation.customer_name:customerDetailValue(input.customerName),
    customerPhone:input.customerPhone===undefined?reservation.customer_phone:(normalizePhone(input.customerPhone ?? '') || null),
    allergyNote:input.allergyNote===undefined?reservation.allergy_note:customerDetailValue(input.allergyNote),
    note:input.note===undefined?reservation.note:customerDetailValue(input.note)};
  if(!details.customerName)throw new GapError('invalid_customer_details');
  const formSnapshot=await readRestaurantCustomerReservationForm(db,reservation.store_id,account);
  if(formSnapshot.form && ((input.expectedFormVersion??0)!==formSnapshot.form.version || restaurantReservationAnswerError(formSnapshot.form.definition,details)))throw new GapError('reservation_form_changed',409);
  const priceStateSql=`SELECT json_object(
    'course',(SELECT json_object('price',price,'status',status) FROM rt_menu_items WHERE id=? AND store_id=?),
    'courseSetting',(SELECT json_object('mode',mode,'version',version) FROM restaurant_course_payment_settings WHERE menu_id=? AND line_account_id=? AND store_id=?),
    'accountSetting',(SELECT json_object('mode',mode,'provider',provider,'hold',hold_minutes) FROM booking_payment_configs WHERE line_account_id=?),
    'rules',json((SELECT json_group_array(json_object('scope',scope_id,'rule',json(rule_json),'inherit',inherit,'version',version))
      FROM (SELECT scope_id,rule_json,inherit,version FROM booking_deposit_rules WHERE account_id=? AND scope_id IN ('',?) ORDER BY scope_id))),
    'timezone',(SELECT timezone FROM rt_stores WHERE id=? AND line_account_id=?))`;
  const priceArgs=[reservation.course_id,reservation.store_id,reservation.course_id,account,reservation.store_id,account,account,reservation.course_id ? `course:${reservation.course_id}` : '',reservation.store_id,account];
  const stateBefore=await db.prepare(priceStateSql).bind(...priceArgs).first<Record<string,string>>();
  const stateBeforeJson=stateBefore ? Object.values(stateBefore)[0] : null;
  const quote=await restaurantPaymentQuote(db,{accountId:account,friendId:reservation.friend_id,storeId:reservation.store_id,courseId:reservation.course_id,
    guestCount:reservation.guest_count,startsAt:reservation.starts_at,timezone:reservation.timezone,paymentMethod:input.paymentMethod});
  const stateAfter=await db.prepare(priceStateSql).bind(...priceArgs).first<Record<string,string>>();
  if(!stateBeforeJson || !stateAfter || Object.values(stateAfter)[0]!==stateBeforeJson)throw new GapError('payment_setting_changed',409);
  if(quote.amount===0)return {required:false as const,quote};
  if(!/^\d+-[A-Za-z0-9]+$/.test(reservation.liff_id ?? '') || !reservation.tenant_id)throw new GapError('payment_not_connected',409);
  const connection=await db.prepare(`SELECT provider_account_id FROM booking_payment_connections WHERE line_account_id=? AND provider='stripe' AND test_mode=1 AND disconnected_at IS NULL`)
    .bind(account).first<{provider_account_id:string}>();
  if(!connection || !/^acct_[A-Za-z0-9]+$/.test(connection.provider_account_id) || quote.provider!=='stripe')throw new GapError('payment_not_connected',409);
  if(!env.BOOKING_STRIPE_TEST_SECRET_KEY || !/^sk_test_[A-Za-z0-9]+$/.test(env.BOOKING_STRIPE_TEST_SECRET_KEY))throw new GapError('stripe_test_key_required',409);
  const requestJson=JSON.stringify({reservationId,courseId:reservation.course_id,guestCount:reservation.guest_count,startsAt:reservation.starts_at,
    paymentMethod:input.paymentMethod ?? null,unitPrice:quote.unitPrice,total:quote.total,amount:quote.amount,kind:quote.kind,settingVersion:quote.settingVersion,depositRule:quote.depositRule,formVersion:formSnapshot.form?.version ?? 0});
  const now=new Date().toISOString(),id=crypto.randomUUID();
  await db.batch([
    db.prepare(`SELECT json(CASE WHEN (${priceStateSql})=? THEN '{}' ELSE 'RESTAURANT_PAYMENT_CHANGED' END)`).bind(...priceArgs,stateBeforeJson),
    ...(formSnapshot.form?[formSnapshot.guard]:[]),
    db.prepare(`INSERT INTO restaurant_payment_requests(id,line_account_id,tenant_id,store_id,reservation_id,form_submission_id,connect_account,request_json,total_amount,amount,status,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,'pending',?,? WHERE EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id
      WHERE r.id=? AND r.line_uid=? AND s.line_account_id=? AND r.status='pending' AND r.customer_version=? AND julianday(r.hold_expires_at)>julianday(?)
      AND r.guest_count=? AND r.starts_at=? AND r.course_id IS ?)
    AND (? IS NULL OR EXISTS(SELECT 1 FROM rt_menu_items WHERE id=? AND store_id=? AND kind='course' AND status='active' AND price=?))
    ON CONFLICT DO NOTHING`).bind(id,account,reservation.tenant_id,reservation.store_id,reservationId,input.formSubmissionId ?? null,connection.provider_account_id,requestJson,quote.total,quote.amount,now,now,
      reservationId,uid,account,version,now,reservation.guest_count,reservation.starts_at,reservation.course_id,reservation.course_id,reservation.course_id,reservation.store_id,quote.unitPrice),
    db.prepare(`INSERT INTO restaurant_payment_details(request_id,friend_id,customer_name,customer_phone,allergy_note,note,form_version)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM restaurant_payment_requests WHERE id=?) ON CONFLICT(request_id) DO NOTHING`)
      .bind(id,reservation.friend_id,details.customerName,details.customerPhone,details.allergyNote,details.note,formSnapshot.form?.version ?? 0,id)
  ]);
  let attempt=await db.prepare('SELECT * FROM restaurant_payment_requests WHERE reservation_id=? AND line_account_id=?').bind(reservationId,account).first<Attempt>();
  if(!attempt)throw new GapError('paid_form_or_reservation_conflict',409);
  if(attempt.form_submission_id!==(input.formSubmissionId ?? null) || attempt.request_json!==requestJson || attempt.connect_account!==connection.provider_account_id)throw new GapError('payment_request_conflict',409);
  const stored=await db.prepare('SELECT friend_id,customer_name,customer_phone,allergy_note,note,form_version FROM restaurant_payment_details WHERE request_id=?').bind(attempt.id)
    .first<{friend_id:string;customer_name:string;customer_phone:string|null;allergy_note:string|null;note:string|null;form_version:number}>();
  if(!stored || stored.friend_id!==reservation.friend_id || stored.customer_name!==details.customerName || stored.customer_phone!==details.customerPhone
    || stored.allergy_note!==details.allergyNote || stored.note!==details.note || stored.form_version!==(formSnapshot.form?.version ?? 0))throw new GapError('payment_request_conflict',409);
  if(attempt.status==='paid')return {required:true as const,quote,status:'paid' as const,url:null};
  if(attempt.status!=='pending')throw new GapError('payment_not_available',409);
  if(Date.now()-Date.parse(attempt.created_at)>23*60*60*1000 && (!attempt.customer_id || !attempt.checkout_id))throw new GapError('stripe_result_unknown',409);
  if(!attempt.customer_id) {
    const customer=await bookingStripeTestRequest({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:attempt.connect_account,operation:'customers',idempotencyKey:`restaurant_customer_${attempt.id}`,body:{'metadata[restaurant_payment_id]':attempt.id}});
    if(typeof customer.id!=='string' || !/^cus_[A-Za-z0-9]+$/.test(customer.id))throw new GapError('stripe_invalid_response',503);
    await db.prepare('UPDATE restaurant_payment_requests SET customer_id=?,updated_at=? WHERE id=? AND customer_id IS NULL').bind(customer.id,now,attempt.id).run();
    attempt=await db.prepare('SELECT * FROM restaurant_payment_requests WHERE id=?').bind(attempt.id).first<Attempt>();
    if(!attempt?.customer_id || attempt.customer_id!==customer.id)throw new GapError('stripe_customer_conflict',409);
  }
  if(!attempt.checkout_id) {
    const link=await db.prepare('SELECT token FROM rt_reservation_links WHERE store_id=?').bind(reservation.store_id).first<{token:string}>();
    if(!input.formId && !link?.token)throw new GapError('reservation_link_required',409);
    const params=new URLSearchParams({liffId:reservation.liff_id,...(input.formId?{page:'form',id:input.formId}:{page:'restaurant',token:link!.token}),payment_request:attempt.id});
    const target=`https://liff.line.me/${reservation.liff_id}?${params}`;
    // Stripeの最短30分と同じ申込の有効期限を固定し、再送で本文を変えない。
    const createdAt=Date.parse(attempt.created_at);
    const expiresAt=Math.floor(Math.min(createdAt+23*60*60*1000,Math.max(createdAt+31*60*1000,Date.parse(reservation.hold_expires_at!)))/1000);
    const session=await bookingStripeTestRequest({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:attempt.connect_account,operation:'checkout/sessions',idempotencyKey:`restaurant_checkout_${attempt.id}`,
      body:{mode:'payment',customer:attempt.customer_id,expires_at:expiresAt,'payment_method_types[0]':'card',success_url:`${target}&payment_result=success`,cancel_url:`${target}&payment_result=cancelled`,
        'line_items[0][price_data][currency]':'jpy','line_items[0][price_data][unit_amount]':attempt.amount,'line_items[0][price_data][product_data][name]':'予約のお支払い','line_items[0][quantity]':1,
        'payment_intent_data[metadata][restaurant_payment_id]':attempt.id}});
    if(typeof session.id!=='string' || !/^cs_test_[A-Za-z0-9]+$/.test(session.id) || typeof session.url!=='string')throw new GapError('stripe_invalid_response',503);
    let url:URL;try{url=new URL(session.url);}catch{throw new GapError('stripe_invalid_response',503);}
    if(url.protocol!=='https:' || url.hostname!=='checkout.stripe.com' || url.username || url.password || url.port)throw new GapError('stripe_invalid_response',503);
    await db.batch([
      db.prepare('UPDATE restaurant_payment_requests SET checkout_id=?,checkout_url=?,updated_at=? WHERE id=? AND checkout_id IS NULL').bind(session.id,url.toString(),now,attempt.id),
      ...prepareBookingStripeBinding(db,{tenantId:reservation.tenant_id,accountId:account,friendId:reservation.friend_id,purpose:'restaurant_payment',targetId:attempt.id,
        connectAccount:attempt.connect_account,objectId:session.id,objectKind:'checkout.session',amount:attempt.amount,currency:'jpy',customerId:attempt.customer_id})
    ]);
    attempt=await db.prepare('SELECT * FROM restaurant_payment_requests WHERE id=?').bind(attempt.id).first<Attempt>();
    if(!attempt || attempt.checkout_id!==session.id)throw new GapError('stripe_checkout_conflict',409);
  }
  await replayRestaurantPaymentReceipts(env,attempt.connect_account,attempt.checkout_id!);
  const current=await db.prepare('SELECT * FROM restaurant_payment_requests WHERE id=?').bind(attempt.id).first<Attempt>();
  if(!current || !current.checkout_url)throw new GapError('stripe_checkout_unavailable',503);
  return {required:true as const,quote,status:current.status,url:current.checkout_url};
}
