import { applyBookingStripeReceipt } from './application.js';
import { getBookingStripeReceipt, listPendingBookingStripeReceipts } from './receipts.js';
import { BookingStripeError } from './types.js';

/** 署名済み通知と保存した申込の両方を照合して、カードを登録済みにする。 */
export async function applyCardSetupReceipt(db: D1Database, account: string, eventId: string, requestId: string) {
  return applyBookingStripeReceipt(db, account, eventId, async ({event, binding}) => {
    if (binding.purpose !== 'payment_method' || binding.targetId !== requestId || event.type !== 'setup_intent.succeeded'
      || event.object.status !== 'succeeded' || !event.object.customer || !event.object.paymentMethod) {
      throw new BookingStripeError('stripe_binding_mismatch');
    }
    return [db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM booking_payment_methods p
      JOIN booking_payment_connections c ON c.line_account_id=p.line_account_id
      WHERE p.id=? AND p.line_account_id=? AND p.friend_id=? AND p.setup_id=? AND p.test_mode=1
        AND c.provider_account_id=? AND c.test_mode=1 AND c.disconnected_at IS NULL
        AND (p.status='pending' OR (p.status='ready' AND p.stripe_customer_id=? AND p.stripe_payment_method_id=?)))
      THEN 'true' ELSE 'stripe_payment_method_mismatch' END)`)
      .bind(requestId,binding.accountId,binding.friendId,event.object.id,account,event.object.customer,event.object.paymentMethod),
      db.prepare(`UPDATE booking_payment_methods SET status='ready',stripe_customer_id=?,stripe_payment_method_id=?
        WHERE id=? AND line_account_id=? AND friend_id=? AND setup_id=? AND status='pending' AND test_mode=1`)
        .bind(event.object.customer,event.object.paymentMethod,requestId,binding.accountId,binding.friendId,event.object.id)];
  });
}

/** 外部IDを確定した後、先に届いて保留された通知を再処理する。 */
export async function replayCardSetupReceipts(db: D1Database, account: string, setupId: string, requestId: string) {
  for (const eventId of await listPendingBookingStripeReceipts(db,account,setupId)) {
    const receipt = await getBookingStripeReceipt(db,account,eventId);
    if (receipt?.input.event.type === 'setup_intent.succeeded') {
      await applyCardSetupReceipt(db,account,eventId,requestId);
    }
  }
}
