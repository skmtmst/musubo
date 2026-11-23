import { tracedFetch as fetch } from '@line-crm/shared/server';
import type { WorkerBindings } from '../worker-bindings.js';
import { collectSecurityCounts } from './security-monitor-counts.js';
import { securityThresholds } from './security-monitor-rules.js';
import { observeSecurityAlert } from './security-monitor-store.js';
import { flushSecurityAlerts } from './security-monitor-slack.js';
import { observeUncertainBillingEffects } from './billing-external-review.js';

export async function runSecurityMonitor(env: WorkerBindings, now = new Date(), fetcher: typeof fetch = fetch): Promise<void> {
  const startedAt = now.toISOString();
  const leaseUntil = new Date(now.getTime() + 5 * 60000).toISOString();
  const token = crypto.randomUUID();
  const window = new Date(Math.floor(now.getTime() / 300000) * 300000).toISOString();
  const claim = await env.DB.prepare(`INSERT INTO security_monitor_state
    (id, lease_until, lease_token, last_started_at, window_started_at) VALUES ('security', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET lease_until = excluded.lease_until,
      lease_token = excluded.lease_token, last_started_at = excluded.last_started_at, window_started_at = excluded.window_started_at
    WHERE security_monitor_state.lease_until <= excluded.last_started_at
      AND security_monitor_state.window_started_at < excluded.window_started_at`)
    .bind(leaseUntil, token, startedAt, window).run();
  if (Number(claim.meta.changes) !== 1) return;
  try {
    await observeUncertainBillingEffects(env.DB, startedAt);
    const config = securityThresholds(env.SECURITY_MONITOR_THRESHOLDS);
    const counts = await collectSecurityCounts(env.DB, now);
    for (const count of counts) {
      const threshold = config.values[count.rule_key];
      if (count.count >= threshold) await observeSecurityAlert(env.DB, count, threshold, startedAt);
    }
    await env.DB.prepare(`UPDATE security_monitor_state SET last_completed_at = ?, last_error = ?, lease_until = ?
      WHERE id = 'security' AND lease_token = ?`)
      .bind(startedAt, config.invalid ? 'invalid_thresholds' : null, startedAt, token).run();
    await flushSecurityAlerts(env.DB, env, now, fetcher);
  } catch {
    await env.DB.prepare(`UPDATE security_monitor_state SET last_error = 'collection_failed'
      WHERE id = 'security' AND lease_token = ?`).bind(token).run();
    throw new Error('security_monitor_failed');
  }
}
