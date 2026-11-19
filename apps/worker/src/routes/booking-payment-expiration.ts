import { getBookingPaymentByBooking } from '@line-crm/db';
import { reconcileExpiredBookingPayment, reconcilePaidBookingPayment } from '../features/booking/booking-payment-recovery/index.js';

/** 状態の読込で旧版の分割更新も補完する。定期回収と同じ条件付き更新。 */
export async function expireBookingPaymentIfHeld(
  db: D1Database,
  lineAccountId: string,
  bookingId: string,
  meetingCreatorForBooking?: Parameters<typeof reconcilePaidBookingPayment>[5],
) {
  const record = await getBookingPaymentByBooking(db, lineAccountId, bookingId);
  if (!record) return null;
  if (record.status === 'paid') await reconcilePaidBookingPayment(db, record.id, new Date(), false, {}, meetingCreatorForBooking);
  else await reconcileExpiredBookingPayment(db, record.id);
  return getBookingPaymentByBooking(db, lineAccountId, bookingId);
}
