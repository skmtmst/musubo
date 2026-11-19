import { logger } from '@line-crm/shared/server';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { isStripeTestEvent, readBodyWithinLimit, verifyStripeSignature } from '../services/stripe-signature.js';
import { applyRestaurantPaymentReceipt, applyCardCheckoutReceipt, applyCardSetupReceipt, BookingStripeError, normalizeBookingStripeEvent, storeBookingStripeReceipt, stripeReceiptDigest, supportedBookingStripeType } from '../features/booking/booking-stripe-webhooks/index.js';
export const bookingStripeWebhook = new Hono<Env>();
/** Connect試験イベントの唯一の実受信口。署名鍵は模擬やSaaSの鍵へ戻さない。 */
bookingStripeWebhook.post('/api/booking/stripe-test/webhook',async c => {
  const raw = await readBodyWithinLimit(c.req.raw);
  if (raw === null) return c.json({success: false, error: 'body_too_large'},413);
  const secret = c.env.BOOKING_STRIPE_TEST_CONNECT_WEBHOOK_SECRET;
  if (!secret) return c.json({success: false, error: 'stripe_webhook_not_configured'},503);
  if (!await verifyStripeSignature(secret,raw,c.req.header('stripe-signature') ?? '')) return c.json({success: false, error: 'invalid_signature'},401);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return c.json({success: false, error: 'invalid_event'},400); }
  const envelope=value as {livemode?:unknown;type?:unknown;data?:{object?:{livemode?:unknown}}}|null;
  if(envelope?.livemode!==false || envelope.data?.object?.livemode===true) return c.json({success:false,error:'live_mode_not_approved'},409);
  // 関係のない署名済みイベントを蓄積せず、再送も求めない。
  if(typeof envelope.type!=='string')return c.json({success:false,error:'invalid_event'},400);
  if(!supportedBookingStripeType(envelope.type))return c.json({success:true,data:{status:'ignored'}},200);
  if (!isStripeTestEvent(value)) return c.json({success: false, error: 'live_mode_not_approved'},409);
  try {
    const event = normalizeBookingStripeEvent(value);
    const result = await storeBookingStripeReceipt(c.env.DB,event,await stripeReceiptDigest(raw));
    if (result.status !== 'review_required' && event.type === 'checkout.session.completed') {
      const applied = await applyCardCheckoutReceipt(c.env.DB,event.account,event.id);
      if (applied === 'applied' || applied === 'duplicate') return c.json({success:true,data:{status:'applied'}},200);
      if (applied === 'review_required') return c.json({success:true,data:{status:'review_required'}},202);
      const restaurant=await applyRestaurantPaymentReceipt(c.env,event.account,event.id);
      if (restaurant==='applied' || restaurant==='duplicate') return c.json({success:true,data:{status:'applied'}},200);
      if (restaurant==='review_required') return c.json({success:true,data:{status:'review_required'}},202);
    }
    // metadata は署名済みでも、それだけでは信用せず、保存済み binding と登録待ちの行に照合する。
    const metadata = (value as {data?:{object?:{metadata?:Record<string,unknown>}}}).data?.object?.metadata;
    const requestId = metadata?.booking_payment_method_id;
    if (result.status !== 'review_required' && event.type === 'setup_intent.succeeded'
      && typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 255) {
      const applied = await applyCardSetupReceipt(c.env.DB,event.account,event.id,requestId);
      if (applied === 'applied' || applied === 'duplicate') return c.json({success:true,data:{status:'applied'}},200);
      if (applied === 'review_required') return c.json({success:true,data:{status:'review_required'}},202);
    }
    if(result.status==='review_required')logger.warn('booking_stripe_webhook_review_required');
    // 保存済みで未反映。後続の業務が外部IDを確定した時に、共通の消費口から再開する。
    return c.json({success: true, data: result},result.status === 'applied' ? 200 : 202);
  } catch (error) {
    if (error instanceof BookingStripeError) return c.json({success: false, error: error.code},error.status);
    throw error;
  }
});
