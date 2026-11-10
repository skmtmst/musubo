import { expect, it, vi } from 'vitest';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';

const delivery = vi.hoisted(() => ({
  recipient: vi.fn(async (): Promise<string | null> => 'owner@example.com'),
  recorded: vi.fn(async () => {}),
  plain: vi.fn(async () => {}),
}));
vi.mock('./billing-invoice-notifications.js', () => ({ billingRecipient: delivery.recipient }));
vi.mock('./recorded-notification-send.js', () => ({ sendRecordedNotification: delivery.recorded }));
vi.mock('./plain-mail.js', () => ({ sendPlainMail: delivery.plain }));

import { deliverLatestMusuboFinalLineNotice, sweepMusuboFinalLineNotices } from
  './musubo-final-line-notification.js';

it('retries a durable end notice once a billing recipient exists and marks it delivered once', async () => {
  const fixture = createTestD1();
  const env = { DB: fixture.db, ADMIN_PUBLIC_URL: 'https://admin.example.com' } as WorkerBindings;
  fixture.raw.prepare(`INSERT INTO musubo_final_line_notices
    (id,tenant_id,event,snapshot_json,created_at) VALUES (?,?,?,?,?)`)
    .run('end-event', DEFAULT_TENANT_ID, 'immediate', JSON.stringify({
      lineName: '店舗LINE', interval: 'month', endAt: '2027-01-09T00:00:00+09:00',
    }), '2027-01-09T00:00:00+09:00');
  delivery.recipient.mockResolvedValueOnce(null).mockResolvedValue('owner@example.com');
  delivery.recorded.mockClear();
  expect(await sweepMusuboFinalLineNotices(env)).toEqual({ checked: 1, failed: 1 });
  expect(delivery.recorded).not.toHaveBeenCalled();
  expect(await deliverLatestMusuboFinalLineNotice(env, DEFAULT_TENANT_ID, 'immediate')).toBe(true);
  expect(delivery.recorded).toHaveBeenCalledWith(fixture.db, expect.objectContaining({
    sourceId: 'end-event', recipient: 'owner@example.com', channel: 'email',
  }));
  expect(fixture.raw.prepare(`SELECT delivered_at FROM musubo_final_line_notices WHERE id='end-event'`)
    .get()).toMatchObject({ delivered_at: expect.any(String) });
  expect(await sweepMusuboFinalLineNotices(env)).toEqual({ checked: 0, failed: 0 });
  expect(delivery.recorded).toHaveBeenCalledTimes(1);
});
