import { activeTenantLineAccountSql, type BookingPaymentRecord } from '@line-crm/db';

import { API_RETRY_WAIT } from '../../lib/external-call/index.js';
import { runBookingExternalStep } from './booking-external-step.js';
import { featureJobCanRun } from '../../services/feature-enforcement.js';
import type { PaymentProvider, PaymentStartInput, PaymentStartResult } from '../../services/payment-providers.js';

/** 予約の既存支払記録に結ぶ。結果不明・保存失敗は新しい決済として開始し直さない。 */
export async function runBookingPaymentStart(db: D1Database, record: BookingPaymentRecord, provider: PaymentProvider) {
  const now = Date.now();
  if(record.hold_until&&Date.parse(record.hold_until)<=now)throw new Error('payment_hold_expired');
  const snapshot: PaymentStartInput = { amount: record.amount, currency: record.currency,
    bookingId: record.booking_id!, idempotencyKey: record.idempotency_key };
  return runBookingExternalStep<PaymentStartInput, PaymentStartResult>(db, {
    ref: { scopeId: `line:${record.line_account_id}`, processKind: 'booking_payment_start', subjectId: record.booking_id!, stepKey: 'start' },
    identity: { scope: { accountId: record.line_account_id, storeId: record.line_account_id,
      destination: 'payment', connectionId: record.provider }, operationId: record.id,
      idempotencyKey: record.idempotency_key, snapshotId: record.id, effect: 'write' },
    policy: { category: 'api', maxAttempts: 1, timeoutMs: 10_000,
      deadlineAt: record.hold_until ? Date.parse(record.hold_until) : now + 86_400_000, wait: API_RETRY_WAIT }, snapshot,
    authorize: async saved => !!await db.prepare(`SELECT 1 ok FROM booking_payments p
      JOIN bookings b ON b.id=p.booking_id AND b.line_account_id=p.line_account_id
      WHERE p.id=? AND p.line_account_id=? AND p.status='unpaid' AND p.provider=? AND p.amount=? AND p.currency=?
        AND b.status='requested' AND (p.hold_until IS NULL OR julianday(p.hold_until)>julianday(?))
        AND ${activeTenantLineAccountSql('p.line_account_id')}`).bind(record.id, record.line_account_id, provider.name,
        saved.amount, saved.currency, new Date().toISOString()).first()
      && await featureJobCanRun(db, { accountId: record.line_account_id, featureId: 'booking', job: 'booking payment start' }),
    execute: async (_signal, saved) => ({ kind: 'success', value: await provider.startPayment(saved) }),
    statements: (next, value) => next.phase === 'succeeded' && value?.providerPaymentId ? [
      db.prepare(`UPDATE booking_payments SET confirmation_revision=confirmation_revision+1, provider_payment_id=?,status='pending',updated_at=?
        WHERE id=? AND line_account_id=? AND status='unpaid' AND amount=? AND currency=?`)
        .bind(value.providerPaymentId, new Date().toISOString(), record.id, record.line_account_id, record.amount, record.currency),
    ] : [],
  });
}
