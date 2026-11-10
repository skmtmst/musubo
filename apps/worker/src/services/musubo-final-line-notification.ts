import type { WorkerBindings } from '../worker-bindings.js';
import { billingRecipient } from './billing-invoice-notifications.js';
import { musuboFinalLineMail } from './musubo-account-lifecycle-mail.js';
import type { MusuboFinalLineNoticeSnapshot } from './musubo-final-line-notice-record.js';
import { sendPlainMail } from './plain-mail.js';
import { sendRecordedNotification } from './recorded-notification-send.js';

interface NoticeRow {
  id: string; tenant_id: string; event: 'scheduled' | 'immediate' | 'cancelled';
  snapshot_json: string;
}

function billingUrl(env: WorkerBindings): string | null {
  const origin = (env.ADMIN_PUBLIC_URL || env.ADMIN_ORIGIN?.split(',')[0] || '').trim();
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return null;
    url.pathname = '/hq/billing'; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

async function deliverNotice(env: WorkerBindings, row: NoticeRow): Promise<boolean> {
  const recipient = await billingRecipient(env.DB, row.tenant_id);
  const actionUrl = billingUrl(env);
  if (!recipient || !actionUrl) return false;
  const snapshot = JSON.parse(row.snapshot_json) as MusuboFinalLineNoticeSnapshot;
  const mail = musuboFinalLineMail({ event: row.event, ...snapshot, actionUrl });
  await sendRecordedNotification(env.DB, { sourceId: row.id, channel: 'email', recipient,
    payload: JSON.stringify(mail),
    send: () => sendPlainMail(env, { to: recipient, subject: mail.subject,
      body: mail.text, html: mail.html }) });
  await env.DB.prepare(`UPDATE musubo_final_line_notices SET delivered_at=?
    WHERE id=? AND delivered_at IS NULL`).bind(new Date().toISOString(), row.id).run();
  return true;
}

/** Try the current customer action immediately; the sweep recovers interrupted delivery. */
export async function deliverLatestMusuboFinalLineNotice(env: WorkerBindings,
  tenantId: string, event: NoticeRow['event']): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id,tenant_id,event,snapshot_json
    FROM musubo_final_line_notices WHERE tenant_id=? AND event=? AND delivered_at IS NULL
    ORDER BY created_at DESC,id DESC LIMIT 1`).bind(tenantId, event).first<NoticeRow>();
  return row ? deliverNotice(env, row) : false;
}

export async function sweepMusuboFinalLineNotices(env: WorkerBindings, limit = 100): Promise<{
  checked: number; failed: number }> {
  const rows = await env.DB.prepare(`SELECT id,tenant_id,event,snapshot_json
    FROM musubo_final_line_notices WHERE delivered_at IS NULL
    ORDER BY created_at LIMIT ?`).bind(limit).all<NoticeRow>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try { if (!await deliverNotice(env, row)) failed++; }
    catch { failed++; }
  }
  return { checked: rows.results?.length ?? 0, failed };
}
