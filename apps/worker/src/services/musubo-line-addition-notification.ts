import { jstDate, prorateAnnualLineIncrement } from '@line-crm/shared';
import type { WorkerBindings } from '../worker-bindings.js';
import { billingRecipient } from './billing-invoice-notifications.js';
import { musuboAddedLineMail, musuboPendingLineMail } from './musubo-account-lifecycle-mail.js';
import { musuboAnnualAddedLineMail } from './musubo-annual-line-mail.js';
import type { MusuboPendingLineAddition } from './musubo-line-addition.js';
import { sendPlainMail } from './plain-mail.js';
import { sendRecordedNotification } from './recorded-notification-send.js';

interface AdditionSnapshot {
  activeLineCount: number;
  price?: { coreIncrementYen: number };
  monthlyPeriod?: { start: string; end: string };
  annualPeriod?: { start: string; end: string } | null;
  quotedAt?: string;
  activatedCoreYen?: number;
  activatedOptionsYen?: number;
  activatedTrialing?: number;
  activatedInterval?: 'month' | 'year';
  activatedDiscountPercent?: number;
}

function actionUrl(env: WorkerBindings, path: string): string | null {
  const origin = (env.ADMIN_PUBLIC_URL || env.ADMIN_ORIGIN?.split(',')[0] || '').trim();
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return null;
    url.pathname = path; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

export type AdditionMailEvent = 'activated' | 'payment_failed' | 'expired';

async function deliver(env: WorkerBindings, row: MusuboPendingLineAddition,
  event: AdditionMailEvent): Promise<boolean> {
  const current = await env.DB.prepare(`SELECT status,payment_failed_at FROM musubo_pending_additions
    WHERE id=?`).bind(row.id).first<Pick<MusuboPendingLineAddition, 'status' | 'payment_failed_at'>>();
  if (!current || (event === 'activated' && current.status !== 'activated')
    || (event === 'payment_failed' && (current.status !== 'awaiting_payment' || !current.payment_failed_at))
    || (event === 'expired' && current.status !== 'expired')) return true;
  const recipient = await billingRecipient(env.DB, row.tenant_id);
  const url = actionUrl(env, event === 'activated' ? '/accounts' : '/hq/billing/line-addition');
  if (!recipient || !url) return false;
  const snapshot = JSON.parse(row.price_snapshot_json) as AdditionSnapshot;
  if (!Number.isSafeInteger(snapshot.activeLineCount) || snapshot.activeLineCount < 1) {
    throw new Error('LINE addition count is unavailable');
  }
  const mail = event === 'activated' ? (() => {
    if (!Number.isSafeInteger(snapshot.activatedCoreYen)
      || !Number.isSafeInteger(snapshot.activatedOptionsYen)
      || !['month', 'year'].includes(snapshot.activatedInterval ?? '')) {
      throw new Error('Activated LINE price snapshot is unavailable');
    }
    if (snapshot.activatedInterval === 'year') {
      if (!Number.isSafeInteger(snapshot.activatedDiscountPercent)
        || snapshot.activatedDiscountPercent! < 0 || snapshot.activatedDiscountPercent! > 100) {
        throw new Error('Annual LINE discount snapshot is unavailable');
      }
      const discountPercent = snapshot.activatedDiscountPercent!;
      const at = (day: string) => `${day}T12:00:00+09:00`;
      if (snapshot.activatedTrialing === 1) {
        if (!snapshot.monthlyPeriod?.end) throw new Error('First annual charge date is unavailable');
        return musuboAnnualAddedLineMail({ phase: 'trial',
          previousLineCount: snapshot.activeLineCount, activeLineCount: snapshot.activeLineCount + 1,
          firstChargeAt: at(snapshot.monthlyPeriod.end),
          firstAnnualLineChargeYen: snapshot.activatedCoreYen!,
          firstMonthOptionsYen: snapshot.activatedOptionsYen!,
          lineBasicDiscountPercent: discountPercent, accountUrl: url });
      }
      if (!snapshot.annualPeriod || !snapshot.monthlyPeriod || !snapshot.quotedAt
        || !Number.isSafeInteger(snapshot.price?.coreIncrementYen)) {
        throw new Error('Annual LINE addition period is unavailable');
      }
      const proRated = prorateAnnualLineIncrement({
        annualIncrementYen: snapshot.price!.coreIncrementYen,
        periodStartDateJst: snapshot.annualPeriod.start,
        activationDateJst: jstDate(new Date(snapshot.quotedAt)),
        renewalDateJst: snapshot.annualPeriod.end,
      });
      return musuboAnnualAddedLineMail({ phase: 'paid',
        previousLineCount: snapshot.activeLineCount, activeLineCount: snapshot.activeLineCount + 1,
        paidNowYen: row.amount_due_yen, proratedAnnualLineYen: proRated.chargeYen,
        firstMonthOptionsYen: row.amount_due_yen - proRated.chargeYen,
        remainingAnnualDays: proRated.remainingDays, annualPeriodDays: proRated.annualPeriodDays,
        nextMonthlyChargeAt: at(snapshot.monthlyPeriod.end),
        nextMonthlyOptionsYen: snapshot.activatedOptionsYen!,
        nextAnnualRenewalAt: at(snapshot.annualPeriod.end),
        nextAnnualLineChargeYen: snapshot.activatedCoreYen!,
        lineBasicDiscountPercent: discountPercent, accountUrl: url });
    }
    return musuboAddedLineMail({ previousLineCount: snapshot.activeLineCount,
      activeLineCount: snapshot.activeLineCount + 1,
      trialing: snapshot.activatedTrialing === 1,
      amountPaidNowYen: row.amount_due_yen,
      nextCoreYen: snapshot.activatedCoreYen!,
      coreInterval: snapshot.activatedInterval!,
      nextOptionsMonthlyYen: snapshot.activatedOptionsYen!,
      accountUrl: url });
  })() : musuboPendingLineMail({ event,
    addedLineOrdinal: snapshot.activeLineCount + 1,
    activeLineCount: snapshot.activeLineCount,
    amountYen: row.amount_due_yen, holdUntil: row.expires_at, actionUrl: url });
  await sendRecordedNotification(env.DB, {
    sourceId: `musubo-line-addition:${row.id}:${event}`, channel: 'email', recipient,
    payload: JSON.stringify(mail),
    send: () => sendPlainMail(env, { to: recipient, subject: mail.subject,
      body: mail.text, html: mail.html }),
  });
  const column = event === 'activated' ? 'activation_mail_sent_at'
    : event === 'payment_failed' ? 'mail19_sent_at' : 'mail20_sent_at';
  await env.DB.prepare(`UPDATE musubo_pending_additions SET ${column}=?
    WHERE id=? AND ${column} IS NULL`).bind(new Date().toISOString(), row.id).run();
  return true;
}

/** Durable status and price snapshots let the scheduled worker recover missed sends. */
export async function sweepMusuboLineAdditionNotices(env: WorkerBindings, limit = 100): Promise<{
  checked: number; failed: number }> {
  const rows = await env.DB.prepare(`SELECT * FROM musubo_pending_additions
    WHERE kind='line' AND (
      (status='activated' AND activation_mail_sent_at IS NULL)
      OR (status='awaiting_payment' AND line_account_id IS NOT NULL
        AND payment_failed_at IS NOT NULL AND mail19_sent_at IS NULL)
      OR (status='expired' AND line_account_id IS NOT NULL AND amount_due_yen>0
        AND payment_failed_at IS NOT NULL AND mail20_sent_at IS NULL))
    ORDER BY created_at LIMIT ?`).bind(limit).all<MusuboPendingLineAddition>();
  let failed = 0;
  for (const row of rows.results ?? []) {
    const event: AdditionMailEvent = row.status === 'activated' ? 'activated'
      : row.status === 'expired' ? 'expired' : 'payment_failed';
    try { if (!await deliver(env, row, event)) failed++; }
    catch { failed++; }
  }
  return { checked: rows.results?.length ?? 0, failed };
}
