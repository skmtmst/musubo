import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';

const mail = vi.hoisted(() => ({ send: vi.fn(async (_env: unknown, _message: { to: string; subject: string; body: string; html?: string }) => {}) }));
vi.mock('./plain-mail.js', () => ({ sendPlainMail: mail.send }));

import {
  deliverBillingRecoveryNotice, deliverCurrentBillingFailureNotice,
  sweepBillingFailureNotices, sweepBillingRecoveryNotices,
} from './billing-invoice-notifications.js';

const failedAt = Math.floor(Date.parse('2026-11-09T03:00:00Z') / 1000);

describe('有料請求の通知', () => {
  it('請求書ごとに失敗・6日目・停止・復旧を一度ずつ送る', async () => {
    const fixture = createTestD1();
    mail.send.mockClear();
    try {
      fixture.raw.prepare(`UPDATE tenants SET plan_status='past_due',
        stripe_subscription_id='sub_notice', current_period_ends_at='2026-12-09T03:00:00Z'
        WHERE id=?`).run(DEFAULT_TENANT_ID);
      fixture.raw.prepare(`INSERT INTO staff_members
        (id,name,email,role,api_key,tenant_id,is_active)
        VALUES ('notice_owner','Owner','owner@example.test','owner','key',?,1)`)
        .run(DEFAULT_TENANT_ID);
      fixture.raw.prepare("UPDATE tenants SET contact_email='not-an-email' WHERE id=?").run(DEFAULT_TENANT_ID);
      fixture.raw.prepare(`INSERT INTO billing_invoices
        (id,tenant_id,subscription_id,status,amount_due,amount_paid,currency,synced_at,created_at)
        VALUES ('in_notice',?,'sub_notice','open',5900,0,'jpy','2026-11-09T03:00:00Z','2026-11-08T03:00:00Z')`)
        .run(DEFAULT_TENANT_ID);
      fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
        VALUES ('evt_notice','invoice.payment_failed',?,?)`)
        .run(DEFAULT_TENANT_ID, JSON.stringify({ state: 'completed', created: failedAt, subjectId: 'in_notice' }));
      const env = { DB: fixture.db, ADMIN_PUBLIC_URL: 'https://admin.example.test' } as Env['Bindings'];

      expect(await deliverCurrentBillingFailureNotice(env, DEFAULT_TENANT_ID, new Date('2026-11-09T04:00:00Z'))).toBe(true);
      await deliverCurrentBillingFailureNotice(env, DEFAULT_TENANT_ID, new Date('2026-11-09T04:05:00Z'));
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(mail.send.mock.calls[0]?.[1]).toMatchObject({ to: 'owner@example.test',
        subject: '【musubo】お支払いの確認をお願いします' });
      expect(mail.send.mock.calls[0]?.[1].body).toContain('/hq/billing/payment-recovery');

      expect(await sweepBillingFailureNotices(env, new Date('2026-11-15T04:00:00Z'))).toMatchObject({ checked: 1, failed: 0 });
      expect(await sweepBillingFailureNotices(env, new Date('2026-11-16T03:00:00Z'))).toMatchObject({ checked: 1, failed: 0 });
      expect(mail.send.mock.calls.map((call) => call[1].subject)).toEqual([
        '【musubo】お支払いの確認をお願いします',
        '【musubo】明日、利用が一時停止します',
        '【musubo】利用を一時停止しました',
      ]);

      fixture.raw.prepare("UPDATE billing_invoices SET status='paid', amount_paid=5900 WHERE id='in_notice'").run();
      fixture.raw.prepare("UPDATE tenants SET plan_status='active' WHERE id=?").run(DEFAULT_TENANT_ID);
      fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
        VALUES ('evt_notice_paid','invoice.paid',?,?)`)
        .run(DEFAULT_TENANT_ID, JSON.stringify({ state: 'completed', subjectId: 'in_notice', applied: 1 }));
      expect(await deliverBillingRecoveryNotice(env, 'in_notice')).toBe(true);
      await deliverBillingRecoveryNotice(env, 'in_notice');
      expect(mail.send).toHaveBeenCalledTimes(4);
      expect(mail.send.mock.calls[3]?.[1]).toMatchObject({
        subject: '【musubo】お支払いを確認しました',
      });
      expect(mail.send.mock.calls[3]?.[1].body).toContain('/hq/billing/payment-recovery');
      expect(mail.send.mock.calls[3]?.[1].body).toContain('2026年12月9日');
    } finally { fixture.raw.close(); }
  });

  it('別請求の未払いが残る場合は復旧メールを出さない', async () => {
    const fixture = createTestD1();
    mail.send.mockClear();
    try {
      fixture.raw.prepare(`UPDATE tenants SET plan_status='active',stripe_subscription_id='sub_notice' WHERE id=?`)
        .run(DEFAULT_TENANT_ID);
      for (const [id, status, paid] of [['in_paid','paid',5900],['in_open','open',0]] as const) {
        fixture.raw.prepare(`INSERT INTO billing_invoices
          (id,tenant_id,subscription_id,status,amount_due,amount_paid,currency,synced_at,created_at)
          VALUES (? ,?,'sub_notice',?,5900,?,'jpy','2026-11-09T03:00:00Z','2026-11-08T03:00:00Z')`)
          .run(id, DEFAULT_TENANT_ID, status, paid);
      }
      fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
        VALUES ('evt_paid_failure','invoice.payment_failed',?,?)`)
        .run(DEFAULT_TENANT_ID, JSON.stringify({ state: 'completed', created: failedAt, subjectId: 'in_paid' }));
      const env = { DB: fixture.db, ADMIN_PUBLIC_URL: 'https://admin.example.test' } as Env['Bindings'];
      expect(await deliverBillingRecoveryNotice(env, 'in_paid')).toBe(false);
      expect(mail.send).not.toHaveBeenCalled();
    } finally { fixture.raw.close(); }
  });

  it('入金済みWebhook後に送信処理が中断されても、定期処理で復旧通知を一度だけ回収する', async () => {
    const fixture = createTestD1();
    mail.send.mockClear();
    try {
      fixture.raw.prepare(`UPDATE tenants SET plan_status='active', stripe_subscription_id='sub_notice',
        contact_email='owner@example.test' WHERE id=?`).run(DEFAULT_TENANT_ID);
      fixture.raw.prepare(`INSERT INTO billing_invoices
        (id,tenant_id,subscription_id,status,amount_due,amount_paid,currency,synced_at,created_at)
        VALUES ('in_recovered',?,'sub_notice','paid',5900,5900,'jpy','2026-11-09T13:00:00.000+09:00','2026-11-08T03:00:00Z')`)
        .run(DEFAULT_TENANT_ID);
      fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
        VALUES ('evt_recovered_failure','invoice.payment_failed',?,?)`)
        .run(DEFAULT_TENANT_ID, JSON.stringify({ state: 'completed', created: failedAt, subjectId: 'in_recovered' }));
      fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary)
        VALUES ('evt_recovered_paid','invoice.paid',?,?)`)
        .run(DEFAULT_TENANT_ID, JSON.stringify({ state: 'completed', subjectId: 'in_recovered', applied: 1 }));
      const env = { DB: fixture.db, ADMIN_PUBLIC_URL: 'https://admin.example.test' } as Env['Bindings'];
      const now = new Date('2026-11-09T05:00:00Z');
      expect(await sweepBillingRecoveryNotices(env, now)).toMatchObject({ checked: 1, failed: 0 });
      expect(await sweepBillingRecoveryNotices(env, now)).toMatchObject({ checked: 1, failed: 0 });
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(mail.send.mock.calls[0]?.[1].subject).toBe('【musubo】お支払いを確認しました');
      expect(await sweepBillingRecoveryNotices(env, new Date('2026-11-13T05:00:00Z')))
        .toMatchObject({ checked: 0, failed: 0 });
    } finally { fixture.raw.close(); }
  });

  it('複数の未払いを順に解消しても、復旧メールは利用再開を確定した最後の入金だけに送る', async () => {
    const fixture = createTestD1();
    mail.send.mockClear();
    try {
      fixture.raw.prepare(`UPDATE tenants SET plan_status='active', stripe_subscription_id='sub_notice',
        contact_email='owner@example.test' WHERE id=?`).run(DEFAULT_TENANT_ID);
      for (const [id, applied] of [['in_earlier', 0], ['in_final', 1]] as const) {
        fixture.raw.prepare(`INSERT INTO billing_invoices
          (id,tenant_id,subscription_id,status,amount_due,amount_paid,currency,synced_at,created_at)
          VALUES (? ,?,'sub_notice','paid',5900,5900,'jpy','2026-11-09T13:00:00+09:00','2026-11-08T03:00:00Z')`)
          .run(id, DEFAULT_TENANT_ID);
        fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary) VALUES (?,?,?,?)`)
          .run(`evt_failure_${id}`, 'invoice.payment_failed', DEFAULT_TENANT_ID,
            JSON.stringify({ state: 'completed', created: failedAt, subjectId: id }));
        fixture.raw.prepare(`INSERT INTO billing_events (id,type,tenant_id,summary) VALUES (?,?,?,?)`)
          .run(`evt_paid_${id}`, 'invoice.paid', DEFAULT_TENANT_ID,
            JSON.stringify({ state: 'completed', subjectId: id, applied }));
      }
      const env = { DB: fixture.db, ADMIN_PUBLIC_URL: 'https://admin.example.test' } as Env['Bindings'];
      expect(await sweepBillingRecoveryNotices(env, new Date('2026-11-09T05:00:00Z')))
        .toMatchObject({ checked: 1, failed: 0 });
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(await deliverBillingRecoveryNotice(env, 'in_earlier')).toBe(false);
    } finally { fixture.raw.close(); }
  });
});
