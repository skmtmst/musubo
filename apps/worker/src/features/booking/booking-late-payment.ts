import { confirmationWorkflowStatement } from './booking-confirmed-effects.js';
import { activeTenantLineAccountSql, ensureWorkflowStep, claimWorkflowStep, finishWorkflowStep, failWorkflowStep, type BookingPaymentRecord } from '@line-crm/db';

import { getAccountTimeZone, getAvailability, getStoreCapacitySnapshot, tzDateStr } from '../../services/availability.js';
import { getStaffGoogleBusy } from './booking-calendar-sync.js';
import { STORE_CAPACITY_GUARD_EXCLUDE_SQL, STORE_SETTINGS_VERSION_GUARD_SQL } from './booking-store-capacity.js';
import { simulatePaymentRefund } from './booking-payment-refunds.js';
import { queueBookingOperation, finishBookingOperation } from './booking-operation-runs.js';
import { notifyForBooking } from './booking-notification.js';
import { featureJobCanRun } from '../../services/feature-enforcement.js';
import type { GoogleServiceAccountCredentials } from '../../services/google-service-account.js';

/** 期限後の入金を過去の成功として捨てず、枠の復元か補償に結び付ける。 */
export async function reconcileLateBookingPayment(db: D1Database, paymentId: string, now: Date,
  credentials: GoogleServiceAccountCredentials = {}): Promise<void> {
  const payment=await db.prepare('SELECT * FROM booking_payments WHERE id=?').bind(paymentId).first<BookingPaymentRecord>();
  if(!payment?.booking_id||!['paid','refunded'].includes(payment.status))return;
  const account=payment.line_account_id;
  const booking=await db.prepare(`SELECT b.id,b.status,b.staff_id,b.menu_id,b.lock_version,b.starts_at,b.ends_at,b.block_ends_at,
    m.concurrent_capacity FROM bookings b JOIN menus m ON m.id=b.menu_id AND m.line_account_id=b.line_account_id
    WHERE b.id=? AND b.line_account_id=? AND ${activeTenantLineAccountSql('b.line_account_id')}`)
    .bind(payment.booking_id,account).first<{id:string;status:string;staff_id:string;menu_id:string;lock_version:number;
      starts_at:string;ends_at:string;block_ends_at:string;concurrent_capacity:number}>();
  if(!booking||!['expired','cancelled'].includes(booking.status)
    ||!await featureJobCanRun(db,{accountId:account,featureId:'booking',job:'late booking payment'}))return;
  const ref={scopeId:`line:${account}`,processKind:'booking_late_payment',subjectId:paymentId,stepKey:'resolve'};
  const checkpoint=await ensureWorkflowStep(db,ref,{now:now.getTime(),maxAttempts:3,input:{paymentId,bookingId:booking.id,
    amount:payment.amount,currency:payment.currency,idempotencyKey:`late-payment:${payment.id}`}});
  if(checkpoint.status==='succeeded')return;
  const lease=await claimWorkflowStep(db,ref,{now:now.getTime()});
  if(!lease)return;
  const review=await queueBookingOperation(db,{bookingId:booking.id,lineAccountId:account,kind:'automation',
    idempotencyKey:`${booking.id}:late-payment:${payment.id}:review`,result:{paymentId:payment.id,reason:'late_payment'}});
  await finishBookingOperation(db,{id:review,status:'permanent_failed',completedAt:now.toISOString(),
    errorCode:'late_payment_review_required',result:{paymentId:payment.id,reason:'late_payment'}});
  try {
    let restored=false;
    if(booking.status==='expired'&&payment.status==='paid'&&Date.parse(booking.starts_at)>now.getTime()) {
      // 読取り不能は「満席」にしない。返金に進まず要対応のまま止める。
      const busy=await getStaffGoogleBusy(db,credentials,{lineAccountId:account,staffId:booking.staff_id,
        timeMin:booking.starts_at,timeMax:booking.block_ends_at,fresh:true});
      const start=new Date(booking.starts_at),timezone=await getAccountTimeZone(db,account),date=tzDateStr(timezone,start);
      const availability=await getAvailability(db,{lineAccountId:account,menuId:booking.menu_id,staffId:booking.staff_id,
        from:date,to:date,now,minLeadTimeMinutes:0,googleCredentials:credentials,excludeBookingId:booking.id});
      const available=availability.by_staff.some(staff=>staff.staff_id===booking.staff_id
        &&staff.slots.some(slot=>Date.parse(slot.startUtc??'')===start.getTime()));
      const googleFree=!(busy??[]).some(slot=>Date.parse(slot.start)<Date.parse(booking.block_ends_at)&&Date.parse(slot.end)>start.getTime());
      if(available&&googleFree) {
        const store=await getStoreCapacitySnapshot(db,account,start,new Date(booking.block_ends_at));
        await db.batch([
          db.prepare(`UPDATE bookings SET confirmation_revision = confirmation_revision + 1, status=CASE WHEN COALESCE((SELECT approval_mode FROM booking_settings WHERE line_account_id=?),'automatic')='automatic'
              THEN 'confirmed' ELSE 'requested' END,lock_version=lock_version+1,decided_at=?,updated_at=?
            WHERE id=? AND line_account_id=? AND status='expired' AND lock_version=?
              AND EXISTS(SELECT 1 FROM booking_payments WHERE id=? AND line_account_id=? AND booking_id=bookings.id AND status='paid')
              AND NOT EXISTS(SELECT 1 FROM bookings occupied WHERE occupied.id<>bookings.id AND occupied.line_account_id=?
                AND occupied.staff_id=? AND occupied.status IN ('requested','confirmed')
                AND julianday(occupied.starts_at)<julianday(?) AND julianday(occupied.block_ends_at)>julianday(?) AND occupied.menu_id<>?)
              AND (SELECT COUNT(*) FROM bookings occupied WHERE occupied.id<>bookings.id AND occupied.line_account_id=?
                AND occupied.staff_id=? AND occupied.status IN ('requested','confirmed')
                AND julianday(occupied.starts_at)<julianday(?) AND julianday(occupied.block_ends_at)>julianday(?) AND occupied.menu_id=?)<?
              ${STORE_CAPACITY_GUARD_EXCLUDE_SQL} ${STORE_SETTINGS_VERSION_GUARD_SQL}
              AND NOT EXISTS(SELECT 1 FROM booking_resource_consumptions own
                LEFT JOIN booking_resources r ON r.id=own.resource_id AND r.line_account_id=own.line_account_id
                WHERE own.booking_id=bookings.id AND (r.id IS NULL OR r.is_active<>1 OR own.quantity>r.capacity OR own.quantity+(
                  SELECT COALESCE(SUM(other.quantity),0) FROM booking_resource_consumptions other JOIN bookings occupied ON occupied.id=other.booking_id
                  WHERE other.resource_id=own.resource_id AND other.line_account_id=own.line_account_id AND occupied.id<>bookings.id
                    AND occupied.status IN ('requested','confirmed') AND julianday(occupied.starts_at)<julianday(bookings.block_ends_at)
                    AND julianday(occupied.block_ends_at)>julianday(bookings.starts_at))>r.capacity))`)
            .bind(account,now.toISOString(),now.toISOString(),booking.id,account,booking.lock_version,payment.id,account,
              account,booking.staff_id,booking.block_ends_at,booking.starts_at,booking.menu_id,
              account,booking.staff_id,booking.block_ends_at,booking.starts_at,booking.menu_id,Math.max(1,booking.concurrent_capacity),
              JSON.stringify(store.windows),account,booking.id,account,booking.id,account,store.settingsVersion),
          db.prepare(`INSERT INTO booking_audit_logs(id,booking_id,line_account_id,action,before_json,after_json,reason,actor_type,occurred_at)
            SELECT ?,?,?,'payment_hold_restored','{"status":"expired"}',json_object('status',status),'late_payment','system',?
            FROM bookings WHERE id=? AND line_account_id=? AND changes()=1`)
            .bind(`late-payment:${payment.id}:restored`,booking.id,account,now.toISOString(),booking.id,account),
          confirmationWorkflowStatement(db,booking.id,true),
        ]);
        restored=!!await db.prepare('SELECT 1 ok FROM booking_audit_logs WHERE id=?')
          .bind(`late-payment:${payment.id}:restored`).first();
      }
    }
    if(!restored) {
      const live=await db.prepare('SELECT status,lock_version FROM bookings WHERE id=? AND line_account_id=?')
        .bind(booking.id,account).first<{status:string;lock_version:number}>();
      // 別操作が復元した枠を返金しない。元の期限切れ・取消のままか確認する。
      if(!live||!['expired','cancelled'].includes(live.status)||live.lock_version!==booking.lock_version)throw new Error('late_payment_conflict');
      await simulatePaymentRefund(db,payment,{reason:'支払い期限後の入金・予約の復元不可',notifyLine:true,
        idempotencyKey:`late-payment:${payment.id}`},{id:'system',name:'自動補償（模擬）'});
    }
    await finishWorkflowStep(db,ref,lease.lease_owner!,{now:now.getTime(),result:{outcome:restored?'restored':'refunded',simulation:!restored}});
    const current=await db.prepare('SELECT status FROM bookings WHERE id=?').bind(booking.id).first<{status:string}>();
    const kind=current?.status==='confirmed'?'approved':'requested';
    const notification=await queueBookingOperation(db,{bookingId:booking.id,lineAccountId:account,kind:'confirmation_line',
      idempotencyKey:restored&&kind==='approved'?`${booking.id}:confirmation-line:approved`:`${booking.id}:late-payment:${payment.id}:notice`,result:{reason:'late_payment',simulation:!restored}});
    if(restored) {
      await notifyForBooking(db,booking.id,kind,notification);
    } else await finishBookingOperation(db,{id:notification,status:'skipped',completedAt:now.toISOString(),
      result:{reason:'late_payment_refund',simulation:true,sent:false}});
  } catch {
    await failWorkflowStep(db,ref,lease.lease_owner!,{now:now.getTime(),code:'late_payment_reconcile_failed'});
    // 実返金のadapterは本機能に存在しない。外部へ代用の送金をせず要対応を残す。
    await finishBookingOperation(db,{id:review,status:'permanent_failed',completedAt:now.toISOString(),
      errorCode:'late_payment_reconcile_required',result:{paymentId:payment.id,reason:'late_payment'}});
  }
}
