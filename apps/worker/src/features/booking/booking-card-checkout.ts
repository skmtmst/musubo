import { GapError } from '../../services/gap-common.js';
import type { Env } from '../../worker-env.js';
import { bookingStripeTestRequest } from './booking-stripe-test-api.js';
import { prepareBookingStripeBinding } from './booking-stripe-webhooks/index.js';
import { replayCardCheckoutReceipts } from './booking-stripe-webhooks/card-checkout.js';

interface CheckoutRow { id:string; booking_json:string; connect_account:string; customer_id:string|null; checkout_id:string|null; checkout_url:string|null; created_at:string }
/** 同じキーは同じ申込にだけ使い、外部呼出しの前に申込を確定する。 */
export async function startCardCheckout(env:Env['Bindings'], account:string, friend:string, key:string, body:Record<string,unknown>) {
  if (typeof body.menuId !== 'string' || typeof body.startsAt !== 'string' || !Number.isFinite(Date.parse(body.startsAt))
    || typeof body.staffId !== 'string' || !Number.isSafeInteger(body.partySize) || Number(body.partySize)<1 || Number(body.partySize)>100
    || body.policyAccepted !== true) throw new GapError('invalid_booking_request',400);
  const scope = await env.DB.prepare(`SELECT a.tenant_id,a.liff_id,c.provider_account_id FROM line_accounts a
    JOIN booking_payment_connections c ON c.line_account_id=a.id WHERE a.id=? AND c.provider='stripe' AND c.test_mode=1 AND c.disconnected_at IS NULL`)
    .bind(account).first<{tenant_id:string;liff_id:string;provider_account_id:string}>();
  if (!scope?.tenant_id || !/^\d+-[A-Za-z0-9]+$/.test(scope.liff_id ?? '') || !/^acct_[A-Za-z0-9]+$/.test(scope.provider_account_id)) throw new GapError('payment_not_connected',409);
  const bookingJson=JSON.stringify({menuId:body.menuId,startsAt:body.startsAt,staffId:body.staffId,partySize:body.partySize,policyAccepted:true});
  const id=crypto.randomUUID(), now=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO booking_payment_methods(id,friend_id,line_account_id,setup_id,idempotency_key,created_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(line_account_id,friend_id,idempotency_key) DO NOTHING`).bind(id,friend,account,`pending_${id}`,key,now),
    env.DB.prepare(`INSERT INTO booking_card_checkout_requests(id,line_account_id,friend_id,idempotency_key,booking_json,connect_account,created_at)
      SELECT id,line_account_id,friend_id,idempotency_key,?,?,? FROM booking_payment_methods
      WHERE id=? ON CONFLICT(line_account_id,friend_id,idempotency_key) DO NOTHING`).bind(bookingJson,scope.provider_account_id,now,id)
  ]);
  let row=await env.DB.prepare('SELECT * FROM booking_card_checkout_requests WHERE line_account_id=? AND friend_id=? AND idempotency_key=?')
    .bind(account,friend,key).first<CheckoutRow>();
  if (!row || row.booking_json!==bookingJson || row.connect_account!==scope.provider_account_id) throw new GapError('idempotency_conflict',409);
  // Stripe の再送キーの有効期間が過ぎた不明な外部操作は、再作成せず確認待ちにする。
  if ((!row.customer_id || !row.checkout_id) && Date.now()-Date.parse(row.created_at)>23*60*60*1000) throw new GapError('stripe_result_unknown',409);
  if (!row.customer_id) {
    const customer=await bookingStripeTestRequest({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:row.connect_account,
      operation:'customers',idempotencyKey:`card_customer_${row.id}`,body:{'metadata[booking_payment_method_id]':row.id}});
    if (typeof customer.id!=='string' || !/^cus_[A-Za-z0-9]+$/.test(customer.id)) throw new GapError('stripe_invalid_response',503);
    await env.DB.prepare('UPDATE booking_card_checkout_requests SET customer_id=? WHERE id=? AND customer_id IS NULL').bind(customer.id,row.id).run();
    row=await env.DB.prepare('SELECT * FROM booking_card_checkout_requests WHERE id=?').bind(row.id).first<CheckoutRow>();
    if (!row?.customer_id || row.customer_id!==customer.id) throw new GapError('stripe_customer_conflict',409);
  }
  if (!row.checkout_id) {
    const returnUrl=`https://liff.line.me/${scope.liff_id}/booking`;
    const session=await bookingStripeTestRequest({key:env.BOOKING_STRIPE_TEST_SECRET_KEY,connectedAccount:row.connect_account,
      operation:'checkout/sessions',idempotencyKey:`card_checkout_${row.id}`,body:{mode:'setup',currency:'jpy',customer:row.customer_id,
        success_url:`${returnUrl}?liffId=${encodeURIComponent(scope.liff_id)}&card_setup=success`,cancel_url:`${returnUrl}?liffId=${encodeURIComponent(scope.liff_id)}&card_setup=cancelled`,
        'setup_intent_data[metadata][booking_payment_method_id]':row.id}});
    if (typeof session.id!=='string' || !/^cs_test_[A-Za-z0-9]+$/.test(session.id) || typeof session.url!=='string') throw new GapError('stripe_invalid_response',503);
    let url:URL; try { url=new URL(session.url); } catch { throw new GapError('stripe_invalid_response',503); }
    if (url.protocol!=='https:' || url.hostname!=='checkout.stripe.com' || url.username || url.password || url.port) throw new GapError('stripe_invalid_response',503);
    await env.DB.batch([
      env.DB.prepare('UPDATE booking_card_checkout_requests SET checkout_id=?,checkout_url=? WHERE id=? AND checkout_id IS NULL').bind(session.id,url.toString(),row.id),
      ...prepareBookingStripeBinding(env.DB,{tenantId:scope.tenant_id,accountId:account,friendId:friend,purpose:'payment_method',targetId:row.id,
        connectAccount:row.connect_account,objectId:session.id,objectKind:'checkout.session',amount:null,currency:null,customerId:row.customer_id})
    ]);
    row=await env.DB.prepare('SELECT * FROM booking_card_checkout_requests WHERE id=?').bind(row.id).first<CheckoutRow>();
    if (!row || row.checkout_id!==session.id) throw new GapError('stripe_checkout_conflict',409);
  }
  await replayCardCheckoutReceipts(env.DB,row.connect_account,row.checkout_id!);
  const method=await env.DB.prepare('SELECT setup_id,status FROM booking_payment_methods WHERE id=?').bind(row.id).first<{setup_id:string;status:string}>();
  if (!method || !row.checkout_url) throw new GapError('stripe_checkout_unavailable',503);
  if (method.status==='pending' && method.setup_id.startsWith('pending_') && await env.DB.prepare(`SELECT 1 FROM workflow_steps
    WHERE scope_id=? AND process_kind='booking_stripe_webhook' AND step_key='apply'
    AND json_extract(input_json,'$.event.object.id')=? AND json_extract(input_json,'$.event.type')='checkout.session.expired' LIMIT 1`)
    .bind(`stripe-test:${row.connect_account}`,row.checkout_id).first()) throw new GapError('stripe_checkout_expired',409);
  return {setupIntentId:method.setup_id,url:row.checkout_url,status:method.status,testMode:true as const};
}
