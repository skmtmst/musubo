import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import type { WorkerBindings } from '../worker-bindings.js';
import { runSecurityMonitor } from './security-monitor.js';
import { collectSecurityCounts } from './security-monitor-counts.js';
import { securityThresholds } from './security-monitor-rules.js';
import { securityMonitorStatus } from './security-monitor-store.js';
import { flushSecurityAlerts } from './security-monitor-slack.js';
import { runScheduledOperationHealthChecks } from './operations-health.js';

let store: ReturnType<typeof createTestD1>;
const NOW = new Date('2026-10-16T16:00:00.000Z'); // JST 01:00
const fetcher = vi.fn<typeof fetch>();
function env(extra: Partial<WorkerBindings> = {}): WorkerBindings {
  return { DB: store.db, SLACK_BOT_TOKEN: 'test-only', SLACK_ERROR_CHANNEL_ID: 'CERROR', ...extra } as WorkerBindings;
}
function audit(action: string, options: { count?: number; at?: string; account?: string | null; result?: string } = {}) {
  store.raw.prepare(`INSERT INTO audit_events
    (id, tenant_id, line_account_id, category, action, result, after_json, target_id, reason, created_at)
    VALUES (?, 'tenant-a', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), options.account ?? null, action.startsWith('auth.') ? 'auth' : 'business',
      action, options.result ?? 'success', JSON.stringify({ count: options.count, arbitrary: 'private@example.test' }),
      'private-customer', 'private-value?secret=test-only', options.at ?? '2026-10-17T00:55:00.000');
}
function alerts() { return store.raw.prepare('SELECT * FROM security_alerts').all() as Array<Record<string, unknown>>; }

beforeEach(() => {
  store = createTestD1();
  store.raw.exec(`INSERT INTO tenants (id,name) VALUES ('tenant-a','A');
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
    VALUES ('account-a','channel-a','A','test-token','test-secret','tenant-a')`);
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); store.raw.close(); });

describe('security detection using actual audit SQL and durable alerts', () => {
  it('purge review alerts do not block the security notification queue', async () => {
    const insert=store.raw.prepare(`INSERT INTO security_alerts(id,tenant_id,scope_key,rule_key,observed_count,threshold_count,first_detected_at,last_detected_at,latest_event_at,notification_id)
      VALUES(?,'tenant-a',?,'stripe_purge_review',1,1,'2020-01-01','2020-01-01',1,?)`);
    for(let i=0;i<31;i++) insert.run(`review-${i}`,`review-${i}`,`notification-${i}`);
    audit('auth.api_key.rotate');
    await runSecurityMonitor(env(),NOW,fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('鍵');
  });
  it('exceeding the threshold creates attention and a safe Slack message, below it does neither', async () => {
    for (let n = 0; n < 19; n++) audit('auth.fail', { result: 'failed' });
    await runSecurityMonitor(env(), NOW, fetcher);
    expect(alerts()).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
    audit('auth.fail', { result: 'failed' });
    await runSecurityMonitor(env(), new Date(NOW.getTime() + 5 * 60000), fetcher);
    expect(alerts()).toEqual([expect.objectContaining({ rule_key: 'login_failures', observed_count: 20, status: 'open', slack_sent_version: 1 })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sent = String(fetcher.mock.calls[0][1]?.body);
    expect(sent).toContain('ログイン失敗');
    for (const privateText of ['private@example.test', 'private-customer', 'test-only', 'tenant-a', 'secret=', '?']) expect(sent).not.toContain(privateText);
    expect(JSON.stringify(alerts())).not.toContain('private');
    await runSecurityMonitor(env(), new Date(NOW.getTime() + 10 * 60000), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    // 静かな期間だけで警告を自動解決しない。
    await runSecurityMonitor(env(), new Date(NOW.getTime() + 60 * 60000), fetcher);
    expect(alerts()[0].status).toBe('open');
  });

  it('counts UTC, JST offsets and legacy JST consistently; excludes old and future records', async () => {
    for (const at of ['2026-10-16T15:55:00.000Z', '2026-10-16T15:55:00Z', '2026-10-17T00:55:00+09:00', '2026-10-17T00:55:00.000']) audit('auth.fail', { at, result: 'failed' });
    for (const at of ['2026-10-16T15:45:00Z', '2026-10-17T00:44:59.999', '2026-10-16T16:00:01Z']) audit('auth.fail', { at, result: 'failed' });
    expect((await collectSecurityCounts(store.db, NOW)).find(row => row.rule_key === 'login_failures')?.count).toBe(4);
  });

  it('counts exports by records, permission changes, keys, invites, API writes and hidden impersonation', async () => {
    audit('data.export', { count: 12000, account: 'account-a' });
    audit('data.export', { count: 99999, result: 'denied', account: 'account-a' });
    audit('api.patch./api/staff/:id', { account: 'account-a' });
    audit('auth.api_key.rotate', { account: 'account-a' });
    audit('api.post./api/staff', { account: 'account-a' });
    store.raw.prepare(`INSERT INTO platform_audit_logs (id, staff_id, tenant_id, action, visible_to_tenant, created_at)
      VALUES ('p', 'platform-admin', 'tenant-a', 'impersonation.start', 0, '2026-10-17T00:55:00')`).run();
    await runSecurityMonitor(env({ SECURITY_MONITOR_THRESHOLDS: '{"api_mutations":2,"night_activity":2,"export_requests":1}' }), NOW, fetcher);
    expect(alerts().map(row => row.rule_key).sort()).toEqual(['admin_additions', 'api_mutations', 'export_records', 'export_requests', 'impersonation', 'key_rotations', 'night_activity', 'permission_changes'].sort());
    expect(alerts().find(row => row.rule_key === 'export_records')?.observed_count).toBe(12000);
  });

  it('invalid or disabling thresholds use defaults and expose configuration failure', async () => {
    for (const input of ['{', '[]', '{"login_failures":0}', '{"unknown":1}', '{"login_failures":1.5}', '{"toString":2}']) {
      expect(securityThresholds(input)).toMatchObject({ invalid: true, values: { login_failures: 20 } });
    }
    await runSecurityMonitor(env({ SECURITY_MONITOR_THRESHOLDS: '{"login_failures":0}' }), NOW, fetcher);
    expect(await securityMonitorStatus(store.db, NOW)).toMatchObject({ status: 'failed', configurationValid: false });
  });

  it('persists failures for retry, handles Slack ok:false, and does not double-send concurrently', async () => {
    audit('auth.api_key.rotate');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'private@example.test' })));
    await Promise.all([runSecurityMonitor(env(), NOW, fetcher), runSecurityMonitor(env(), NOW, fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(alerts()[0]).toMatchObject({ slack_sent_version: 0, slack_last_error: 'delivery_failed' });
    const retryAt = new Date(NOW.getTime() + 5 * 60000);
    await Promise.all([flushSecurityAlerts(store.db, env(), retryAt, fetcher), flushSecurityAlerts(store.db, env(), retryAt, fetcher)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(alerts()[0].slack_sent_version).toBe(1);
    const [first, second] = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(second.client_msg_id).toBe(first.client_msg_id);
  });

  it('missing Slack stays unconfigured; recurrence after human resolution gets a new delivery id', async () => {
    audit('auth.api_key.rotate');
    await runSecurityMonitor(env({ SLACK_BOT_TOKEN: undefined }), NOW, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(alerts()[0]).toMatchObject({ slack_last_error: 'unconfigured', slack_sent_version: 0 });
    await flushSecurityAlerts(store.db, env(), new Date(NOW.getTime() + 5 * 60000), fetcher);
    store.raw.prepare("UPDATE security_alerts SET status = 'resolved', reviewed_at = ?").run(NOW.toISOString());
    await runSecurityMonitor(env(), new Date(NOW.getTime() + 5 * 60000), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    audit('auth.api_key.rotate', { at: '2026-10-16T16:09:00Z' });
    await runSecurityMonitor(env(), new Date(NOW.getTime() + 10 * 60000), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(alerts()[0]).toMatchObject({ version: 2, status: 'open', slack_sent_version: 2 });
    const [first, second] = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(second.client_msg_id).not.toBe(first.client_msg_id);
  });

  it('collection failures are not reported as healthy and raw errors are never persisted', async () => {
    store.raw.exec('DROP TABLE audit_events');
    await expect(runSecurityMonitor(env(), NOW, fetcher)).rejects.toThrow('security_monitor_failed');
    expect(await securityMonitorStatus(store.db, NOW)).toMatchObject({ status: 'failed', lastCompletedAt: null });
    expect(store.raw.prepare('SELECT last_error FROM security_monitor_state').get()).toEqual({ last_error: 'collection_failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('the existing scheduled health sweep invokes security monitoring even with no active store', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', fetcher);
    store.raw.exec('UPDATE line_accounts SET is_active = 0');
    audit('auth.api_key.rotate');
    await runScheduledOperationHealthChecks(store.db, { security: env() });
    expect(alerts()).toEqual([expect.objectContaining({ rule_key: 'key_rotations' })]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('checks the next clock window despite cron jitter and exposes stopped monitoring', async () => {
    await runSecurityMonitor(env(), new Date(NOW.getTime() + 900), fetcher);
    await runSecurityMonitor(env(), new Date(NOW.getTime() + 300000 + 100), fetcher);
    const status = await securityMonitorStatus(store.db, new Date(NOW.getTime() + 300000 + 100));
    expect(status).toMatchObject({ status: 'running', lastCompletedAt: new Date(NOW.getTime() + 300000 + 100).toISOString() });
    expect(await securityMonitorStatus(store.db, new Date(NOW.getTime() + 21 * 60000))).toMatchObject({ status: 'stale' });
  });
});
