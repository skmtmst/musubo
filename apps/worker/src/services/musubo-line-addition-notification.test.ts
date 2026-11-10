import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { prorateAnnualLineIncrement } from '@line-crm/shared';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';
import { sweepMusuboLineAdditionNotices } from './musubo-line-addition-notification.js';
import { sendPlainMail } from './plain-mail.js';

vi.mock('./plain-mail.js', () => ({ sendPlainMail: vi.fn(async () => undefined) }));
afterEach(() => vi.clearAllMocks());

function fixture() {
  const { db, raw } = createTestD1();
  raw.prepare('UPDATE tenants SET contact_email=? WHERE id=?')
    .run('billing@example.com', DEFAULT_TENANT_ID);
  return { db, raw, env: { DB: db, ADMIN_PUBLIC_URL: 'https://admin.example.com' } as WorkerBindings };
}

function insert(raw: ReturnType<typeof createTestD1>['raw'], input: {
  id: string; status: string; lineId?: string; amount: number; failedAt?: string;
  snapshot: Record<string, unknown>;
}) {
  raw.prepare(`INSERT INTO musubo_pending_additions
    (id,tenant_id,kind,line_account_id,status,amount_due_yen,price_snapshot_json,
      expires_at,payment_failed_at,created_at,updated_at)
    VALUES (?,?,'line',?,?,?,?,?,?,?,?)`).run(input.id, DEFAULT_TENANT_ID,
    input.lineId ?? null, input.status, input.amount, JSON.stringify(input.snapshot),
    '2027-01-20T09:00:00Z', input.failedAt ?? null, '2027-01-13T09:00:00Z', '2027-01-13T09:00:00Z');
}

it('sends annual trial LINE activation with the first annual and monthly amounts only once', async () => {
  const f = fixture();
  insert(f.raw, { id: 'a1', status: 'activated', amount: 0,
    snapshot: { activeLineCount: 1, activatedCoreYen: 149040,
      activatedOptionsYen: 5500, activatedTrialing: 1, activatedInterval: 'year',
      activatedDiscountPercent: 0, monthlyPeriod: { start: '2026-11-09', end: '2026-12-09' } } });
  expect(await sweepMusuboLineAdditionNotices(f.env)).toEqual({ checked: 1, failed: 0 });
  const first = vi.mocked(sendPlainMail).mock.calls[0]?.[1];
  expect(first?.body).toContain('149,040');
  expect(first?.body).toContain('5,500');
  expect(first?.body).toContain('LINE年額');
  expect(first?.body).toContain('オプション初月');
  expect(await sweepMusuboLineAdditionNotices(f.env)).toEqual({ checked: 0, failed: 0 });
  expect(sendPlainMail).toHaveBeenCalledTimes(1);
});

it('sends failure only after a failed payment and an attached LINE, then expiry notice', async () => {
  const f = fixture();
  insert(f.raw, { id: 'a2', status: 'awaiting_payment', lineId: 'new-line', amount: 6700,
    snapshot: { activeLineCount: 1 } });
  expect(await sweepMusuboLineAdditionNotices(f.env)).toEqual({ checked: 0, failed: 0 });
  f.raw.prepare('UPDATE musubo_pending_additions SET payment_failed_at=? WHERE id=?')
    .run('2027-01-13T09:00:00Z', 'a2');
  expect(await sweepMusuboLineAdditionNotices(f.env)).toEqual({ checked: 1, failed: 0 });
  expect(vi.mocked(sendPlainMail).mock.calls[0]?.[1].subject).toContain('お支払いを確認');
  f.raw.prepare("UPDATE musubo_pending_additions SET status='expired' WHERE id='a2'").run();
  expect(await sweepMusuboLineAdditionNotices(f.env)).toEqual({ checked: 1, failed: 0 });
  expect(vi.mocked(sendPlainMail).mock.calls[1]?.[1].subject).toContain('期限切れ');
});

it('sends the paid annual addition with separate next monthly and annual charges', async () => {
  const f = fixture();
  const proration = prorateAnnualLineIncrement({ annualIncrementYen: 85320,
    periodStartDateJst: '2026-01-01', activationDateJst: '2026-07-02',
    renewalDateJst: '2027-01-01' });
  insert(f.raw, { id: 'a3', status: 'activated', amount: proration.chargeYen + 5322,
    snapshot: { activeLineCount: 1, activatedCoreYen: 149040,
      activatedOptionsYen: 5500, activatedTrialing: 0, activatedInterval: 'year',
      activatedDiscountPercent: 0, price: { coreIncrementYen: 85320 },
      monthlyPeriod: { start: '2026-07-01', end: '2026-08-01' },
      annualPeriod: { start: '2026-01-01', end: '2027-01-01' },
      quotedAt: '2026-07-02T12:00:00+09:00' } });
  expect(await sweepMusuboLineAdditionNotices(f.env)).toEqual({ checked: 1, failed: 0 });
  const body = vi.mocked(sendPlainMail).mock.calls[0]?.[1].body;
  expect(body).toContain('次の月次請求');
  expect(body).toContain('次の年次更新');
  expect(body).toContain('149,040');
  expect(body).toContain('5,500');
});
