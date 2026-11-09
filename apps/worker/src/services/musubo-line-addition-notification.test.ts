import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
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

it('sends annual LINE activation amounts in their separate billing cycles only once', async () => {
  const f = fixture();
  insert(f.raw, { id: 'a1', status: 'activated', amount: 6700,
    snapshot: { activeLineCount: 1, activatedCoreYen: 149040,
      activatedOptionsYen: 5500, activatedTrialing: 0, activatedInterval: 'year' } });
  expect(await sweepMusuboLineAdditionNotices(f.env)).toEqual({ checked: 1, failed: 0 });
  const first = vi.mocked(sendPlainMail).mock.calls[0]?.[1];
  expect(first?.body).toContain('149,040');
  expect(first?.body).toContain('5,500');
  expect(first?.body).toContain('／年');
  expect(first?.body).toContain('／月');
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
