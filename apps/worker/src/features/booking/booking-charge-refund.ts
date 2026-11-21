import type { Env } from '../../worker-env.js';
import { GapError } from '../../services/gap-common.js';
import { bookingStripeTestRequest, listBookingStripeTestRefunds } from './booking-stripe-test-api.js';

interface Charge {id:string;line_account_id:string;status:string;version:number;amount:number;stripe_payment_intent_id:string|null;stripe_connected_account_id:string|null}
interface Refund {id:string;charge_id:string;line_account_id:string;idempotency_key:string;expected_version:number;reason:string;actor_id:string;connect_account:string;payment_intent_id:string;amount:number;status:string;created_at:string;stripe_refund_id:string|null}
/** 同じ請求の返金を一度に固定し、結果不明のときは元の接続先に照会する。 */
export async function refundCancellationCharge(env:Env['Bindings'],account:string,id:string,key:string,version:number,reason:string,actor:string) {
  const readCharge=()=>env.DB.prepare('SELECT * FROM booking_charges WHERE id=? AND line_account_id=?').bind(id,account).first<Charge>();
  let charge=await readCharge();
  if(!charge)throw new GapError('not_found',404);
  if(!reason.trim() || reason.trim().length>500)throw new GapError('reason_required');
  if(!charge.stripe_connected_account_id || !charge.stripe_payment_intent_id || !/^pi_[A-Za-z0-9]+$/.test(charge.stripe_payment_intent_id))throw new GapError('refund_not_available',409);
  if(!env.BOOKING_STRIPE_TEST_SECRET_KEY || !/^sk_test_[A-Za-z0-9]+$/.test(env.BOOKING_STRIPE_TEST_SECRET_KEY))throw new GapError('stripe_test_key_required',409);
  const readRefund=()=>env.DB.prepare('SELECT * FROM booking_charge_refund_requests WHERE charge_id=? AND line_account_id=?').bind(id,account).first<Refund>();
  let saved=await readRefund();let create=false;
  if(saved && (saved.idempotency_key!==key || saved.reason!==reason))throw new GapError('refund_idempotency_conflict',409);
  if(saved ? version!==saved.expected_version && version!==charge.version : charge.version!==version)throw new GapError('version_conflict',409);
  if(saved?.status==='succeeded' && charge.status==='refunded') return {id,status:'refunded',version:charge.version,replayed:true,testMode:true as const};
  if(!saved) {
    if(charge.status!=='succeeded')throw new GapError('refund_not_available',409);
    const connected=await env.DB.prepare("SELECT 1 FROM booking_payment_connections WHERE line_account_id=? AND provider='stripe' AND provider_account_id=? AND test_mode=1 AND disconnected_at IS NULL").bind(account,charge.stripe_connected_account_id).first();
    if(!connected)throw new GapError('payment_not_connected',409);
    const now=new Date().toISOString(),requestId=crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO booking_charge_refund_requests(id,charge_id,line_account_id,idempotency_key,expected_version,reason,actor_id,connect_account,payment_intent_id,amount,status,created_at,updated_at)
        SELECT ?,c.id,c.line_account_id,?,?,?,?,?,c.stripe_payment_intent_id,c.amount,'processing',?,? FROM booking_charges c
        WHERE c.id=? AND c.line_account_id=? AND c.status='succeeded' AND c.version=? AND c.stripe_connected_account_id=?
        AND NOT EXISTS(SELECT 1 FROM booking_charge_refund_requests r WHERE r.charge_id=c.id OR (r.line_account_id=c.line_account_id AND r.idempotency_key=?))`)
        .bind(requestId,key,version,reason,actor,charge.stripe_connected_account_id,now,now,id,account,version,charge.stripe_connected_account_id,key),
      env.DB.prepare(`UPDATE booking_charges SET version=version+1,updated_at=? WHERE id=? AND line_account_id=? AND version=?
        AND EXISTS(SELECT 1 FROM booking_charge_refund_requests WHERE id=?)`).bind(now,id,account,version,requestId)
    ]);
    saved=await readRefund();charge=await readCharge();
    if(!saved || saved.id!==requestId || !charge)throw new GapError('version_conflict',409);
    create=true;
  }
  const request=saved;
  if(!request || request.payment_intent_id!==charge.stripe_payment_intent_id || request.connect_account!==charge.stripe_connected_account_id || request.amount!==charge.amount)throw new GapError('refund_not_available',409);
  const send=()=>bookingStripeTestRequest({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:request.connect_account,operation:'refunds',idempotencyKey:`booking_refund_${request.id}`,
    body:{payment_intent:request.payment_intent_id,amount:request.amount,'metadata[booking_refund_request_id]':request.id}});
  let external:Record<string,unknown>|undefined;
  try {
    if(create)external=await send();
    else {
      const matches=(await listBookingStripeTestRefunds({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:request.connect_account,paymentIntentId:request.payment_intent_id}))
        .filter(r=>(r.metadata as Record<string,unknown>|undefined)?.booking_refund_request_id===request.id);
      if(matches.length===1)external=matches[0];
      else if(matches.length===0 && Date.now()-Date.parse(request.created_at)<23*60*60*1000) {
        const connected=await env.DB.prepare("SELECT 1 FROM booking_payment_connections WHERE line_account_id=? AND provider='stripe' AND provider_account_id=? AND test_mode=1 AND disconnected_at IS NULL").bind(account,request.connect_account).first();
        if(connected)external=await send();
      }
    }
  } catch { /* 分からない結果は再請求・二重返金とせず保留する。 */ }
  const valid=external && (external.livemode===undefined || external.livemode===false) && typeof external.id==='string' && /^re_[A-Za-z0-9]+$/.test(external.id)
    && external.amount===request.amount && external.currency==='jpy' && external.payment_intent===request.payment_intent_id
    && (external.metadata as Record<string,unknown>|undefined)?.booking_refund_request_id===request.id;
  if(external && valid && external.status==='succeeded') {
    const now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE booking_charge_refund_requests SET status='succeeded',stripe_refund_id=?,updated_at=? WHERE id=? AND status IN ('processing','unknown')`).bind(external.id,now,request.id),
      env.DB.prepare(`UPDATE booking_charges SET status='refunded',reason=?,actor_staff_id=?,version=version+1,updated_at=?
        WHERE id=? AND line_account_id=? AND status='succeeded' AND EXISTS(SELECT 1 FROM booking_charge_refund_requests WHERE id=? AND status='succeeded' AND stripe_refund_id=?)`)
        .bind(reason,request.actor_id,now,id,account,request.id,external.id)
    ]);
    const current=await readCharge();if(!current || current.status!=='refunded')throw new GapError('refund_result_unknown',409);
    return {id,status:'refunded',version:current.version,replayed:!create,testMode:true as const};
  }
  await env.DB.prepare("UPDATE booking_charge_refund_requests SET status='unknown',updated_at=? WHERE id=? AND status='processing'").bind(new Date().toISOString(),request.id).run();
  throw new GapError('refund_result_unknown',409);
}
