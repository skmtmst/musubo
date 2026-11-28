import { currentInvocation } from './context.js';
import { SCHEDULED_JOB_CODES, type ScheduledJobCode, type ScheduledFailureKind } from './scheduled-job-codes.js';

const scheduledJobs = new Set<string>([...Object.values(SCHEDULED_JOB_CODES), 'unknown']);
const failureKinds = new Set<string>(['error','type_error','syntax_error','aborted']);
const billingWebhookEventTypes = new Set([
  'checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'invoice.voided',
  'invoice.marked_uncollectible', 'charge.refunded',
]);
const billingWebhookStages = new Set(['receipt', 'invoice', 'contract', 'musubo', 'refund', 'card_setup', 'legacy', 'commit']);
const billingWebhookReasons = new Set([
  'invoice_id_missing', 'invoice_owner_mismatch', 'schema_missing', 'contract_missing', 'customer_missing',
  'event_unresolved', 'plan_mismatch', 'subscription_unavailable', 'stripe_unavailable', 'subscription_mismatch',
  'stripe', 'internal',
]);
type BillingWebhookMetrics = { eventType: string; stage: string; reason: string };
type Metrics = { failedCount?: number; status?: number; durationMs?: number; scheduledJob?: ScheduledJobCode; failureKind?: ScheduledFailureKind; upstreamCode?: number; upstreamSubcode?: number; billingWebhook?: BillingWebhookMetrics };

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug';
/** 固定イベント名・数値・許可済み分類だけ。例外、URL、本文、任意の文字列をログへ流さない。 */
function write(level: Level, code: string, metrics: Metrics = {}): void {
  const context = currentInvocation();
  const event = {
    timestamp: new Date().toISOString(), level: level === 'log' ? 'info' : level,
    code: /^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/.test(code) ? code : 'invalid_log_event',
    ...(metrics.scheduledJob && scheduledJobs.has(metrics.scheduledJob) ? {scheduledJob: metrics.scheduledJob} : {}),
    ...(metrics.failureKind && failureKinds.has(metrics.failureKind) ? {failureKind: metrics.failureKind} : {}),
    requestId: context?.requestId ?? null, invocationId: context?.invocationId ?? null, source: context?.source ?? 'background',
    ...(Number.isInteger(metrics.failedCount) && metrics.failedCount! >= 0 ? { failedCount: metrics.failedCount } : {}),
    ...(Number.isInteger(metrics.status) && metrics.status! >= 100 && metrics.status! <= 599 ? { status: metrics.status } : {}),
    ...(Number.isInteger(metrics.upstreamCode) && metrics.upstreamCode! >= 0 && metrics.upstreamCode! <= 999999999 ? { upstreamCode: metrics.upstreamCode } : {}),
    ...(Number.isInteger(metrics.upstreamSubcode) && metrics.upstreamSubcode! >= 0 && metrics.upstreamSubcode! <= 999999999 ? { upstreamSubcode: metrics.upstreamSubcode } : {}),
    ...(metrics.billingWebhook && billingWebhookEventTypes.has(metrics.billingWebhook.eventType)
      && billingWebhookStages.has(metrics.billingWebhook.stage) && billingWebhookReasons.has(metrics.billingWebhook.reason) ? {
        billingEventType: metrics.billingWebhook.eventType,
        billingStage: metrics.billingWebhook.stage,
        billingReason: metrics.billingWebhook.reason,
      } : {}),
    ...(Number.isFinite(metrics.durationMs) && metrics.durationMs! >= 0 ? { durationMs: Math.round(metrics.durationMs!) } : {}),
  };
  console[level](JSON.stringify(event));
}
export const logger = {
  log: (code: string, metrics?: Metrics) => write('log', code, metrics),
  info: (code: string, metrics?: Metrics) => write('info', code, metrics),
  warn: (code: string, metrics?: Metrics) => write('warn', code, metrics),
  error: (code: string, metrics?: Metrics) => write('error', code, metrics),
  debug: (code: string, metrics?: Metrics) => write('debug', code, metrics),
};
