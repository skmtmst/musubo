import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { recordAuditEvent } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { requirePlatformAdmin, requirePlatformAdminWrite } from '../middleware/platform-admin.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { publicSecurityAlert, securityMonitorStatus, type SecurityAlertRow } from '../services/security-monitor-store.js';
import { SECURITY_WINDOW_MINUTES, securityThresholds } from '../services/security-monitor-rules.js';
import { runSecurityMonitor } from '../services/security-monitor.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';

export const securityAlerts = new Hono<Env>();

async function scopeFor(c: Context<Env>, platform: boolean) {
  if (platform) return { where: '1 = 1', binds: [] as string[] };
  const accountId = c.req.query('account_id')?.trim();
  if (!accountId) return null;
  if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) return null;
  return { where: 'tenant_id = ? AND line_account_id = ?', binds: [c.get('staff').tenantId ?? DEFAULT_TENANT_ID, accountId] };
}

async function list(c: Context<Env>, platform: boolean) {
  try {
    const scope = await scopeFor(c, platform);
    if (!scope) return c.json({ success: false, error: '表示できるアカウントを指定してください' }, 403);
    const offset = parseOffsetPaging({ offset: c.req.query('offset') }, { offsetPolicy: {} }).offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) return c.json({ success: false, error: '表示位置が正しくありません' }, 400);
    const total = await c.env.DB.prepare(`SELECT COUNT(*) AS count FROM security_alerts WHERE ${scope.where} AND status != 'resolved'`)
      .bind(...scope.binds).first<{ count: number }>();
    const rows = await c.env.DB.prepare(`SELECT security_alerts.*,
      CASE WHEN rule_key='stripe_purge_review' AND json_valid(scope_key) THEN (
        SELECT json_object('eventId',s.stripe_event_id,'eventType',s.event_type,'amount',s.amount,'currency',s.currency,
          'amountMeaning',CASE WHEN s.event_type='charge.refunded' THEN '返金の累計'
            WHEN s.event_type='invoice.paid' THEN '支払われた額'
            WHEN s.event_type LIKE 'invoice.%' THEN '請求した額（未払いを含む）'
            WHEN s.event_type LIKE 'checkout.session.%' THEN '申込の合計額'
            ELSE '通知された金額' END,
          'amountUnit','通貨の最小単位')
        FROM stripe_events s WHERE s.tenant_id=security_alerts.tenant_id
          AND s.stripe_event_id=json_extract(security_alerts.scope_key,'$[1]') AND s.review_reason='purged_tenant'
      ) ELSE NULL END AS stripe_review
      FROM security_alerts WHERE ${scope.where}
      AND status != 'resolved' ORDER BY last_detected_at DESC, id LIMIT 200 OFFSET ?`).bind(...scope.binds, offset).all<SecurityAlertRow & {stripe_review:string|null}>();
    const monitor = await securityMonitorStatus(c.env.DB);
    const thresholds = securityThresholds(c.env.SECURITY_MONITOR_THRESHOLDS);
    return c.json({ success: true, data: buildOffsetListResponse({ items: rows.results.map(row => {
      const item=publicSecurityAlert(row);
      if (!platform) return item;
      const detail=row.stripe_review ? JSON.parse(row.stripe_review) as {amount:number|null;currency:string|null;amountMeaning:string} : null;
      const amount=detail?.amount == null ? '金額不明' : detail.currency === 'jpy'
        ? `¥${detail.amount.toLocaleString('ja-JP')}` : `${detail.currency?.toUpperCase() ?? '通貨不明'} ${detail.amount.toLocaleString('ja-JP')}（最小単位）`;
      return {...item, ...(detail ? {summary:`${amount}・${detail.amountMeaning}・削除済み統括のStripe通知`,stripeReview:detail} : {}), scope:{tenantId:row.tenant_id,lineAccountId:row.line_account_id}};
    }), monitor,
      thresholds: thresholds.values, configurationValid: !thresholds.invalid,
      windowMinutes: SECURITY_WINDOW_MINUTES, limit: 200, offset, total: Number(total?.count ?? 0), paging: { limit: 200, offset }, sort: [{ field: 'lastDetectedAt', direction: 'desc' }, { field: 'id', direction: 'asc' }] }) });
  } catch {
    return c.json({ success: false, error: '安全監視の記録を取得できませんでした', code: 'SECURITY_MONITOR_UNAVAILABLE' }, 503);
  }
}

async function review(c: Context<Env>, platform: boolean, status: 'acknowledged' | 'resolved') {
  const staff = c.get('staff');
  if (!staff || staff.readOnly || c.get('impersonation')) return c.json({ success: false, error: 'この記録を更新する権限がありません' }, 403);
  try {
    const scope = await scopeFor(c, platform);
    if (!scope) return c.json({ success: false, error: '操作できるアカウントを指定してください' }, 403);
    const body = await c.req.json<{ expectedVersion?: unknown }>().catch(() => null);
    if (!Number.isSafeInteger(body?.expectedVersion) || Number(body?.expectedVersion) < 1) {
      return c.json({ success: false, error: '最新の記録を読み直してください' }, 400);
    }
    const alert = await c.env.DB.prepare(`SELECT * FROM security_alerts WHERE id = ? AND ${scope.where}`)
      .bind(c.req.param('id'), ...scope.binds).first<SecurityAlertRow>();
    if (!alert) return c.json({ success: false, error: '記録が見つかりません' }, 404);
    const updated = await c.env.DB.prepare(`UPDATE security_alerts SET status = ?, reviewed_at = ?, version = version + 1,
      slack_sent_version = CASE WHEN slack_sent_version = version THEN version + 1 ELSE slack_sent_version END
      WHERE id = ? AND version = ? AND ${scope.where}`)
      .bind(status, new Date().toISOString(), alert.id, body!.expectedVersion, ...scope.binds).run();
    if (Number(updated.meta.changes) !== 1) return c.json({ success: false, error: '記録が更新されています。読み直してください' }, 409);
    await recordAuditEvent(c.env.DB, { tenantId: staff.tenantId, lineAccountId: alert.line_account_id,
      category: 'business', action: `security.alert.${status}`, actorPrincipalId: staff.id,
      targetKind: 'security_alert', targetId: alert.id, result: 'success', retentionClass: 'security' });
    return c.json({ success: true, data: { id: alert.id, status, version: alert.version + 1 } });
  } catch {
    return c.json({ success: false, error: '安全監視の記録を更新できませんでした' }, 503);
  }
}

securityAlerts.get('/api/operations/security-alerts', requireRole('owner', 'admin'), c => list(c, false));
securityAlerts.post('/api/operations/security-alerts/:id/acknowledge', requireRole('owner', 'admin'), c => review(c, false, 'acknowledged'));
securityAlerts.post('/api/operations/security-alerts/:id/resolve', requireRole('owner', 'admin'), c => review(c, false, 'resolved'));
securityAlerts.get('/api/ops/security-alerts', requirePlatformAdmin(), c => list(c, true));
securityAlerts.post('/api/ops/security-alerts/:id/acknowledge', requirePlatformAdminWrite(), c => review(c, true, 'acknowledged'));
securityAlerts.post('/api/ops/security-alerts/:id/resolve', requirePlatformAdminWrite(), c => review(c, true, 'resolved'));


// 検証環境には cron がないため監視だけを実行し、配信の定期処理は呼ばない。
securityAlerts.post('/api/ops/security-alerts/run-once', requirePlatformAdminWrite(), async c => {
  if (c.env.DEPLOY_ENV !== 'staging') return c.notFound();
  if (c.get('impersonation')) return c.json({ success: false, error: '代理ログイン中は実行できません' }, 403);
  try {
    await runSecurityMonitor(c.env);
    return c.json({ success: true, data: { monitor: await securityMonitorStatus(c.env.DB) } });
  } catch {
    return c.json({ success: false, error: '安全監視を実行できませんでした', code: 'SECURITY_MONITOR_UNAVAILABLE' }, 503);
  }
});
