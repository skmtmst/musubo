import type { WorkerBindings } from '../worker-bindings.js';
import { billingRecipient } from './billing-invoice-notifications.js';
import { musuboAnnualLineRemovalMail } from './musubo-annual-line-removal-mail.js';
import { mailJstDate, mailMoney, musuboSimpleMail } from './musubo-mail-layout.js';
import { sendPlainMail } from './plain-mail.js';
import { sendRecordedNotification } from './recorded-notification-send.js';

interface NoticeRow {
  id: string; tenant_id: string; event: 'scheduled' | 'ended' | 'cancelled';
  snapshot_json: string;
}
interface Snapshot {
  lineName: string; interval: 'month' | 'year'; effectiveAt: string;
  requestedAt: string; nextMonthlyChargeAt: string | null;
  nextAnnualRenewalAt: string | null;
  nextCoreYen: number; nextOptionsMonthlyYen: number;
}

function billingUrl(env: WorkerBindings): string | null {
  try {
    const url = new URL((env.ADMIN_PUBLIC_URL || env.ADMIN_ORIGIN?.split(',')[0] || '').trim());
    if (url.protocol !== 'https:') return null;
    url.pathname = '/hq/billing'; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

function buildMail(row: NoticeRow, snapshot: Snapshot, url: string) {
  const lastUsableAt = new Date(Date.parse(snapshot.effectiveAt) - 1).toISOString();
  if (snapshot.interval === 'year' && snapshot.nextAnnualRenewalAt
    && row.event === 'scheduled') {
    return musuboAnnualLineRemovalMail({ event: 'scheduled', lineName: snapshot.lineName,
      previousLineCount: 2, endAt: snapshot.effectiveAt, lastUsableAt,
      nextAnnualRenewalAt: `${snapshot.nextAnnualRenewalAt}T00:00:00+09:00`,
      nextAnnualLineChargeYen: snapshot.nextCoreYen, accountUrl: url });
  }
  if (snapshot.interval === 'year' && snapshot.nextAnnualRenewalAt
    && snapshot.nextMonthlyChargeAt && row.event === 'ended'
    && Date.parse(snapshot.effectiveAt) < Date.parse(`${snapshot.nextAnnualRenewalAt}T00:00:00+09:00`)
    && Date.parse(snapshot.effectiveAt) < Date.parse(`${snapshot.nextMonthlyChargeAt}T00:00:00+09:00`)) {
    return musuboAnnualLineRemovalMail({ event: 'immediate', lineName: snapshot.lineName,
      previousLineCount: 2, endedAt: snapshot.effectiveAt,
      nextAnnualRenewalAt: `${snapshot.nextAnnualRenewalAt}T00:00:00+09:00`,
      nextAnnualLineChargeYen: snapshot.nextCoreYen,
      nextMonthlyChargeAt: `${snapshot.nextMonthlyChargeAt}T00:00:00+09:00`,
      nextMonthlyOptionsYen: snapshot.nextOptionsMonthlyYen, accountUrl: url });
  }
  const scheduled = row.event === 'scheduled';
  const cancelled = row.event === 'cancelled';
  return musuboSimpleMail({
    subject: cancelled ? '【musubo】LINE利用終了予約の取り消し'
      : scheduled ? '【musubo】LINE利用終了予約のご案内' : '【musubo】LINE利用終了のご案内',
    eyebrow: cancelled ? '利用終了予約の取り消し' : 'LINE利用終了のお知らせ',
    title: cancelled ? `${snapshot.lineName}の終了予約を取り消しました`
      : scheduled ? `${snapshot.lineName}の利用終了を予約しました`
        : `${snapshot.lineName}の利用を終了しました`,
    intro: cancelled ? 'LINEは引き続き利用できます。'
      : scheduled ? `${mailJstDate(lastUsableAt)}まで利用できます。`
        : 'このLINEの接続と配信を停止しました。',
    detail: cancelled ? '利用終了予約の取り消しを確認しました。次の請求は現在の有効LINEに基づいて計算します。'
      : 'もう一方のLINEは引き続きご利用いただけます。支払済みの料金は返金されません。',
    summaryTitle: cancelled ? '継続する利用' : '終了後の料金',
    rows: [
      { label: '有効LINE', value: cancelled ? '2個' : '2個 → 1個' },
      { label: '終了予定日', value: cancelled ? '取り消し済み' : mailJstDate(snapshot.effectiveAt) },
      { label: 'LINE基本料金', value: cancelled ? '現在の料金条件で継続'
        : `${mailMoney(snapshot.nextCoreYen)}／${snapshot.interval === 'year' ? '年' : '月'}（税込・予定）` },
      { label: '統括・追加料金', value: cancelled ? '利用状況に応じて計算'
        : `${mailMoney(snapshot.nextOptionsMonthlyYen)}／月（税込・予定）` },
    ], buttonLabel: 'アカウントと料金を確認', buttonUrl: url,
    notes: cancelled ? ['終了予約は取り消されています。現在のLINEはそのまま利用できます。']
      : ['支払済みのLINE基本料金の返金はありません。',
        '友だち超過と追加連携枠は実際の利用状況で確定します。'],
  });
}

async function deliver(env: WorkerBindings, row: NoticeRow): Promise<boolean> {
  const recipient = await billingRecipient(env.DB, row.tenant_id);
  const url = billingUrl(env);
  if (!recipient || !url) return false;
  const mail = buildMail(row, JSON.parse(row.snapshot_json) as Snapshot, url);
  await sendRecordedNotification(env.DB, { sourceId: row.id, channel: 'email', recipient,
    payload: JSON.stringify(mail),
    send: () => sendPlainMail(env, { to: recipient, subject: mail.subject,
      body: mail.text, html: mail.html }) });
  await env.DB.prepare(`UPDATE musubo_line_removal_notices SET delivered_at=?
    WHERE id=? AND delivered_at IS NULL`).bind(new Date().toISOString(), row.id).run();
  return true;
}

export async function deliverLatestMusuboLineRemovalNotice(env: WorkerBindings,
  tenantId: string, event: NoticeRow['event']): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id,tenant_id,event,snapshot_json
    FROM musubo_line_removal_notices WHERE tenant_id=? AND event=? AND delivered_at IS NULL
    ORDER BY created_at DESC LIMIT 1`).bind(tenantId, event).first<NoticeRow>();
  return row ? deliver(env, row) : false;
}

export async function sweepMusuboLineRemovalNotices(env: WorkerBindings, limit = 100) {
  const rows = await env.DB.prepare(`SELECT id,tenant_id,event,snapshot_json
    FROM musubo_line_removal_notices WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?`)
    .bind(limit).all<NoticeRow>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    try { if (!await deliver(env, row)) failed++; } catch { failed++; }
  }
  return { checked: rows.results?.length ?? 0, failed };
}
