import type { Env } from '../../worker-env.js';
import { GapError } from '../../services/gap-common.js';
import { BookingStripeTestError, bookingStripeTestRequest, searchBookingStripeTestCharge } from './booking-stripe-test-api.js';

interface Charge {id:string;amount:number;version:number;friend_id:string;status:string;idempotency_key:string|null;booking_status:string;
  stripe_connected_account_id:string|null;stripe_payment_intent_id:string|null;stripe_call_started_at:string|null;actor_staff_id:string|null;booking_payment_method_id:string|null}
interface Card {customer_id:string;payment_method_id:string;connect_account:string}

/** 外部操作の前に状態とキーを固定する。結果不明は照会だけで再請求しない。 */
export async function chargeCancellation(env:Env['Bindings'],account:string,bookingId:string,key:string,body:Record<string,unknown>,version:number,actor:string) {
  const read=()=>env.DB.prepare(`SELECT c.*,b.friend_id,b.status booking_status,b.booking_payment_method_id FROM booking_charges c
    JOIN bookings b ON b.id=c.booking_id AND b.line_account_id=c.line_account_id WHERE c.booking_id=? AND c.line_account_id=? AND c.kind=?`)
    .bind(bookingId,account,body.kind).first<Charge>();
  let row=await read();
  if(!row || !((body.kind==='cancellation_fee' && row.booking_status==='cancelled') || (body.kind==='no_show_fee' && row.booking_status==='no_show')))throw new GapError('charge_not_available',409);
  if(!Number.isSafeInteger(body.amount)||Number(body.amount)!==row.amount||row.amount<=0)throw new GapError('amount_exceeds_policy');
  if(row.status==='succeeded' && row.idempotency_key===key)return {row,replayed:true};
  const card=await env.DB.prepare(`SELECT p.stripe_customer_id customer_id,p.stripe_payment_method_id payment_method_id,r.connect_account
    FROM booking_payment_methods p JOIN booking_card_checkout_requests r ON r.id=p.id AND r.customer_id=p.stripe_customer_id AND r.friend_id=p.friend_id AND r.line_account_id=p.line_account_id
    WHERE p.id=? AND p.friend_id=? AND p.line_account_id=? AND p.status='ready' AND p.test_mode=1`).bind(row.booking_payment_method_id,row.friend_id,account).first<Card>();
  if(!card?.customer_id || !card.payment_method_id)throw new GapError('card_not_registered',409);
  if(!env.BOOKING_STRIPE_TEST_SECRET_KEY || !/^sk_test_[A-Za-z0-9]+$/.test(env.BOOKING_STRIPE_TEST_SECRET_KEY))throw new GapError('stripe_test_key_required',409);
  let create=false;
  if(row.status==='pending') {
    const connected=await env.DB.prepare("SELECT 1 FROM booking_payment_connections WHERE line_account_id=? AND provider='stripe' AND provider_account_id=? AND test_mode=1 AND disconnected_at IS NULL").bind(account,card.connect_account).first();
    if(!connected)throw new GapError('payment_not_connected',409);
    const result=await env.DB.prepare(`UPDATE booking_charges SET status='processing',idempotency_key=?,actor_staff_id=?,stripe_connected_account_id=?,stripe_call_started_at=?,version=version+1,updated_at=?
      WHERE id=? AND line_account_id=? AND status='pending' AND version=?
      AND NOT EXISTS(SELECT 1 FROM booking_charges other WHERE other.line_account_id=? AND other.idempotency_key=? AND other.id<>?)
      AND EXISTS(SELECT 1 FROM bookings b WHERE b.id=? AND b.line_account_id=? AND b.status=? AND b.booking_payment_method_id=?)
      AND EXISTS(SELECT 1 FROM booking_payment_connections c WHERE c.line_account_id=? AND c.provider='stripe' AND c.provider_account_id=? AND c.test_mode=1 AND c.disconnected_at IS NULL)`)

      .bind(key,actor,card.connect_account,new Date().toISOString(),new Date().toISOString(),row.id,account,version,account,key,row.id,bookingId,account,row.booking_status,row.booking_payment_method_id,account,card.connect_account).run();
    if(!result.meta.changes)throw new GapError('version_conflict',409);
    create=true;row=(await read())!;
  } else if(!['processing','unknown'].includes(row.status) || row.idempotency_key!==key || row.stripe_connected_account_id!==card.connect_account) {
    throw new GapError('already_charged',409);
  }
  let payment:Record<string,unknown>|undefined;
  const send=()=>bookingStripeTestRequest({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:card.connect_account,operation:'payment_intents',idempotencyKey:`booking_charge_${row!.id}`,
    body:{amount:row!.amount,currency:'jpy',customer:card.customer_id,payment_method:card.payment_method_id,off_session:true,confirm:true,'payment_method_types[0]':'card','metadata[booking_charge_id]':row!.id}});
  try {
    if(create) payment=await send();
    else {
      const matches=await searchBookingStripeTestCharge({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:card.connect_account,chargeId:row.id});
      if(matches.length===1)payment=matches[0];
      // 結果が検索にまだ現れない間は、同じStripeキー・同じ内容だけを再送する。
      else if(matches.length===0 && row.stripe_call_started_at && Date.now()-Date.parse(row.stripe_call_started_at)<23*60*60*1000) {
        const connected=await env.DB.prepare("SELECT 1 FROM booking_payment_connections WHERE line_account_id=? AND provider='stripe' AND provider_account_id=? AND test_mode=1 AND disconnected_at IS NULL").bind(account,card.connect_account).first();
        if(connected)payment=await send();
      }
    }
  } catch (error) { if(error instanceof BookingStripeTestError)payment=error.paymentIntent; }
  const valid=payment && payment.livemode===false && typeof payment.id==='string' && /^pi_[A-Za-z0-9]+$/.test(payment.id)
    && payment.amount===row.amount && payment.currency==='jpy' && payment.customer===card.customer_id
    && (payment.metadata as Record<string,unknown>|undefined)?.booking_charge_id===row.id;
  const lastError=payment?.last_payment_error as {payment_method?:unknown}|undefined;
  const failedMethod=typeof lastError?.payment_method==='object' && lastError.payment_method!==null
    ? (lastError.payment_method as {id?:unknown}).id : lastError?.payment_method;
  if(payment && valid && payment.payment_method===card.payment_method_id && payment.status==='succeeded') {
    const now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE booking_charges SET status='succeeded',stripe_payment_intent_id=?,version=version+1,updated_at=? WHERE id=? AND line_account_id=? AND idempotency_key=? AND status IN ('processing','unknown')`).bind(payment.id,now,row.id,account,key),
      env.DB.prepare(`INSERT INTO booking_cancellation_events(id,charge_id,actor_id,action,created_at) SELECT ?,?,?,'charge_test',? WHERE changes()=1`).bind(crypto.randomUUID(),row.id,row.actor_staff_id ?? actor,now)
    ]);
    const saved=await read();if(!saved || saved.status!=='succeeded' || saved.stripe_payment_intent_id!==payment.id)throw new GapError('charge_result_unknown',409);
    return {row:saved,replayed:!create};
  }
  if(payment && valid && (payment.payment_method===card.payment_method_id || failedMethod===card.payment_method_id) && ['requires_payment_method','requires_action','canceled'].includes(String(payment.status))) {
    await env.DB.prepare(`UPDATE booking_charges SET status='failed',stripe_payment_intent_id=?,version=version+1,updated_at=?
      WHERE id=? AND line_account_id=? AND idempotency_key=? AND status IN ('processing','unknown')`)
      .bind(payment.id,new Date().toISOString(),row.id,account,key).run();
    throw new GapError('card_payment_failed',409);
  }
  await env.DB.prepare(`UPDATE booking_charges SET status='unknown',updated_at=? WHERE id=? AND line_account_id=? AND idempotency_key=? AND status='processing'`).bind(new Date().toISOString(),row.id,account,key).run();
  throw new GapError('charge_result_unknown',409);
}
