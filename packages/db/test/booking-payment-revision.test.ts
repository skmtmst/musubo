import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { markBookingPayment } from '../src/booking/payments.js';

it('revision-mark', async () => {
  const raw = new Database(':memory:');
  try {
    raw.exec(`CREATE TABLE booking_payments(id TEXT, line_account_id TEXT, status TEXT, provider_payment_id TEXT,
      paid_at TEXT, refunded_at TEXT, updated_at TEXT, confirmation_revision INTEGER NOT NULL DEFAULT 1);
      INSERT INTO booking_payments(id,line_account_id,status) VALUES('p','a','unpaid');`);
    const db = { prepare(sql: string) { return { bind(...args: unknown[]) { return {
      async run() { return raw.prepare(sql).run(...args as never[]); },
      async first() { return raw.prepare(sql).get(...args as never[]) ?? null; },
    }; } }; } } as unknown as D1Database;
    await markBookingPayment(db,{lineAccountId:'a',paymentId:'p',status:'paid'});
    expect(raw.prepare("SELECT confirmation_revision FROM booking_payments WHERE id='p'").get()).toEqual({confirmation_revision:2});
  } finally { raw.close(); }
});
