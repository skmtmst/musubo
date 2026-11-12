import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import { seedAssignmentFixture } from '../../test-utils/assignment-fixture.js';
import { receivePaymentEvent } from './booking-payment-events.js';
import { paidBookingPaymentStatements, reconcileExpiredBookingPayment } from './booking-payment-recovery.js';
import { runBookingPaymentStart } from './booking-payment-start.js';
import { linkPaymentBooking } from './booking-payment-refunds.js';
import type { BookingPaymentRecord } from '@line-crm/db';
let f: SqliteD1;
const revision = () => (f.raw.prepare("SELECT confirmation_revision FROM booking_payments WHERE id='p'").get() as {confirmation_revision:number}).confirmation_revision;
const payment = () => f.raw.prepare("SELECT * FROM booking_payments WHERE id='p'").get() as BookingPaymentRecord;
beforeEach(() => {
  vi.stubGlobal('fetch',vi.fn(() => { throw new Error('external_forbidden'); }));
  f=createTestD1({foreignKeys:true}); seedAssignmentFixture(f);
  f.raw.exec(`INSERT INTO friends(id,line_user_id,line_account_id) VALUES('f','Uf','a');
    INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
    VALUES('bk','a','f','s1','m','2030-01-01T03:00:00Z','2030-01-01T04:00:00Z','2030-01-01T04:00:00Z','requested',1000,'2026-10-16');
    INSERT INTO booking_payments(id,line_account_id,booking_id,amount,status,provider,provider_payment_id,idempotency_key,hold_until,created_at,updated_at)
    VALUES('p','a','bk',1000,'unpaid','stripe','pi_test_p','key','2099-01-01T00:00:00Z','2026-10-16','2026-10-16');`);
});
afterEach(() => { f.raw.close(); vi.unstubAllGlobals(); });
const event = {providerPaymentId:'pi_test_p',providerEventId:'evt',status:'failed' as const,amount:1000,currency:'JPY'};
it('revision-event-status', async () => {
  expect(await receivePaymentEvent(f.db,'stripe',event,'event')).toMatchObject({result:'applied'});
  expect(revision()).toBe(2);
});
it('revision-event-receipt', async () => {
  f.raw.exec("UPDATE booking_payments SET status='paid'");
  await receivePaymentEvent(f.db,'stripe',{...event,status:'paid',receiptUrl:'https://pay.stripe.com/receipts/test'},'receipt');
  expect(f.raw.prepare("SELECT receipt_url FROM booking_payments WHERE id='p'").get()).toEqual({receipt_url:'https://pay.stripe.com/receipts/test'});
  expect(revision()).toBe(2);
});
it('revision-recovery-paid', async () => {
  await f.db.batch(paidBookingPaymentStatements(f.db,{id:'p',line_account_id:'a',booking_id:'bk',status:'unpaid'},new Date().toISOString(),true));
  expect(revision()).toBe(2);
});
it('revision-recovery-expired', async () => {
  f.raw.exec("UPDATE booking_payments SET hold_until='2000-01-01T00:00:00Z'");
  await reconcileExpiredBookingPayment(f.db,'p',new Date('2026-10-17T00:00:00Z'));
  expect(revision()).toBe(2);
});
it('revision-start', async () => {
  const provider={name:'stripe' as const,startPayment:vi.fn(async()=>({checkoutUrl:'https://checkout.stripe.com/test/fixture',providerPaymentId:'pi_test_new'})),getStatus:async()=> 'unknown' as const,refund:async()=>false,verifyWebhook:async()=>null};
  expect((await runBookingPaymentStart(f.db,payment(),provider)).kind).toBe('success');
  expect(revision()).toBe(2);
});
it('revision-link', async () => {
  f.raw.exec("UPDATE booking_payments SET booking_id=NULL");
  await linkPaymentBooking(f.db,payment(),'bk','照合',{id:'s1',name:'担当'});
  expect(revision()).toBe(2);
});
