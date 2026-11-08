import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { getBillingPaymentFailure, paymentFailureState, trustedHostedInvoiceUrl } from './billing-payment-failure.js';

const subscription = 'sub_current';
const billing = { id: DEFAULT_TENANT_ID, plan_status: 'past_due' as const, stripe_subscription_id: subscription };
const failedAtSeconds = Math.floor(Date.parse('2026-11-09T03:00:00Z') / 1000);

describe('有料請求失敗の7日猶予', () => {
  it('最初の失敗日時からちょうど7日で停止し、請求書の作成日は使わない', () => {
    const invoice = { id: 'in_1', amount_due: 5900, amount_paid: 0, created_at: '2026-11-01T00:00:00Z',
      hosted_invoice_url: 'https://invoice.stripe.com/i/test' };
    const before = paymentFailureState(invoice, failedAtSeconds, new Date('2026-11-16T02:59:59Z'));
    expect(before).toMatchObject({ state: 'grace', failedAt: '2026-11-09T03:00:00.000Z',
      graceDeadlineAt: '2026-11-16T03:00:00.000Z' });
    expect(paymentFailureState(invoice, failedAtSeconds, new Date('2026-11-16T03:00:00Z'))?.state).toBe('suspended');
    expect(paymentFailureState(invoice, 0, new Date('2026-11-20T00:00:00Z'))).toBeNull();
  });

  it('支払いURLはStripeの請求書ドメインだけ受け付ける', () => {
    expect(trustedHostedInvoiceUrl('https://invoice.stripe.com/i/test')).toContain('invoice.stripe.com');
    expect(trustedHostedInvoiceUrl('https://invoice.stripe.com.evil.example/i/test')).toBeNull();
    expect(trustedHostedInvoiceUrl('http://invoice.stripe.com/i/test')).toBeNull();
  });

  it('未払いの現在契約と対応する失敗イベントだけを使う', async () => {
    const db = createTestD1();
    try {
      const addInvoice = (id: string, sub: string, status = 'open') => db.raw.prepare(`INSERT INTO billing_invoices
        (id,tenant_id,subscription_id,status,amount_due,amount_paid,currency,synced_at,created_at,hosted_invoice_url)
        VALUES (?,?,?,?,5900,0,'jpy','2026-11-09T03:00:00Z','2026-11-01T00:00:00Z','https://invoice.stripe.com/i/test')`)
        .run(id, DEFAULT_TENANT_ID, sub, status);
      const addEvent = (id: string, invoiceId: string) => db.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
        VALUES (?,'invoice.payment_failed',?,?)`).run(id, DEFAULT_TENANT_ID,
        JSON.stringify({ state: 'completed', created: failedAtSeconds, subjectId: invoiceId }));
      addInvoice('in_other', 'sub_other');
      addEvent('evt_other', 'in_other');
      addInvoice('in_current', subscription);
      addEvent('evt_current', 'in_current');
      expect(await getBillingPaymentFailure(db.db, billing, new Date('2026-11-15T00:00:00Z')))
        .toMatchObject({ invoiceId: 'in_current', state: 'grace', amountYen: 5900 });
      db.raw.prepare("UPDATE billing_invoices SET status='paid' WHERE id='in_current'").run();
      expect(await getBillingPaymentFailure(db.db, billing, new Date('2026-11-20T00:00:00Z'))).toBeNull();
    } finally { db.raw.close(); }
  });

  it('古いイベントに請求書IDが無ければ停止の根拠にしない', async () => {
    const db = createTestD1();
    try {
      db.raw.prepare(`INSERT INTO billing_invoices
        (id,tenant_id,subscription_id,status,amount_due,amount_paid,currency,synced_at,created_at)
        VALUES ('in_old',?,?,'open',5900,0,'jpy','2026-11-09T03:00:00Z','2026-11-01T00:00:00Z')`)
        .run(DEFAULT_TENANT_ID, subscription);
      db.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
        VALUES ('evt_old','invoice.payment_failed',?,'{"state":"completed","created":100}')`).run(DEFAULT_TENANT_ID);
      expect(await getBillingPaymentFailure(db.db, billing, new Date('2026-11-20T00:00:00Z'))).toBeNull();
    } finally { db.raw.close(); }
  });
});
