import { decidePrepayOnly, getBookingPaymentConfig } from '@line-crm/db';
import { GapError } from '../../services/gap-common.js';
import { depositEstimate } from './booking-deposit.js';

/** 保存済みのコース単価と人数からサーバー側で金額を決める。 */
export async function restaurantPaymentQuote(db:D1Database, input:{accountId:string;friendId:string;storeId:string;courseId:string|null;guestCount:number;startsAt:string;timezone:string;paymentMethod?:unknown}) {
  if (!Number.isSafeInteger(input.guestCount) || input.guestCount<1 || input.guestCount>100 || !Number.isFinite(Date.parse(input.startsAt))) throw new GapError('invalid_booking_request');
  const course=input.courseId ? await db.prepare(`SELECT id,price FROM rt_menu_items WHERE id=? AND store_id=? AND kind='course' AND status='active'`)
    .bind(input.courseId,input.storeId).first<{id:string;price:number}>() : null;
  if(input.courseId && !course)throw new GapError('invalid_course');
  const unitPrice=course?.price ?? 0,total=unitPrice*input.guestCount;
  if(!Number.isSafeInteger(unitPrice) || unitPrice<0 || !Number.isSafeInteger(total) || !Number.isSafeInteger(total*100))throw new GapError('invalid_course_price');
  const setting=input.courseId ? await db.prepare('SELECT mode,version FROM restaurant_course_payment_settings WHERE menu_id=? AND line_account_id=? AND store_id=?')
    .bind(input.courseId,input.accountId,input.storeId).first<{mode:string|null;version:number}>() : null;
  const base=await getBookingPaymentConfig(db,input.accountId),mode=setting?.mode ?? base.mode;
  if(!['none','onsite','online','customer_choice'].includes(mode))throw new GapError('invalid_payment_setting',409);
  if(input.paymentMethod!==undefined && input.paymentMethod!=='online' && input.paymentMethod!=='onsite')throw new GapError('invalid_payment_method');
  if(mode==='customer_choice' && !input.paymentMethod)throw new GapError('payment_method_required');
  if(mode!=='customer_choice' && input.paymentMethod!==undefined && input.paymentMethod!==mode)throw new GapError('payment_method_not_allowed');
  const chosen=mode==='customer_choice' ? input.paymentMethod : mode;
  if(chosen==='onsite' && (await decidePrepayOnly(db,input.accountId,input.friendId)).prepayOnly)throw new GapError('payment_method_not_allowed');
  const deposit=await depositEstimate(db,input.accountId,input.courseId ? `course:${input.courseId}` : '',total,input.startsAt,input.guestCount,input.timezone);
  if(!Number.isSafeInteger(deposit.amount) || deposit.amount<0 || deposit.amount>total)throw new GapError('invalid_deposit_rule',409);
  const amount=deposit.amount>0 ? deposit.amount : chosen==='online' ? total : 0;
  return {unitPrice,total,amount,remaining:total-amount,kind:deposit.amount>0?'deposit' as const:amount>0?'online' as const:'none' as const,
    mode,settingVersion:setting?.version ?? 0,depositRule:deposit.rule,provider:base.provider};
}
