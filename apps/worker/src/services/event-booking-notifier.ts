import type { AccountStyle } from '@line-crm/shared';
import { notificationWords, readNotificationStyle } from './notification-words.js';
import { currentEventNotificationSubject,type EventNotificationSubject } from './event-notification-subject.js';
import { activeTenantLineAccountSql, isOperationCapabilityStopped } from '@line-crm/db';
import { lineTransport } from '../lib/external-call/line.js';
import { deliverBookingLine } from '../features/booking/booking-line-delivery/index.js';
import { featureJobCanRun } from './feature-enforcement.js';
import { LineClient, type Message } from '@line-crm/line-sdk';


export type EventNotificationKind =
  | 'received_pending'
  | 'received_confirmed'
  | 'confirmed'
  | 'rejected'
  | 'cancelled_by_admin'
  | 'waitlist_offer'
  | 'reminder_day_before'
  | 'reminder_hours_before'
  | 'schedule_changed';

export interface EventNotificationContext {
  style?:AccountStyle;
  eventName: string;
  startsAtJst: string;
  venueName?: string | null;
  venueUrl?: string | null;
  hoursBefore?: number;
  /** 変更のお知らせ (schedule_changed) の新旧の要点。人の言葉で1行。 */
  changeSummary?: string | null;
  // 確定系 (received_confirmed / confirmed) の末尾に追記。空 / null は何もしない。
  confirmationExtra?: string | null;
  // リマインド系 (reminder_day_before / reminder_hours_before) の末尾に追記。
  reminderExtra?: string | null;
  /** キャンセル待ちの期限付き座席保留。URLが無い場合も期限は必ず案内する。 */
  offerExpiresAtJst?: string | null;
  offerUrl?: string | null;
}

function appendExtra(base: string, extra: string | null | undefined): string {
  if (!extra) return base;
  const trimmed = extra.trim();
  if (trimmed.length === 0) return base;
  return `${base}\n\n${trimmed}`;
}

export function renderEventNotificationText(
  kind: EventNotificationKind,
  ctx: EventNotificationContext,
): string {
  const words=notificationWords(ctx.style);
  const reservation=ctx.style==='lesson'?'クラスのご予約':'イベント予約';
  const venueLine = ctx.venueName ? `\n会場: ${ctx.venueName}` : '';
  const venueUrlLine = ctx.venueUrl ? `\n${ctx.venueUrl}` : '';
  const detail = `\n${words.event}: ${ctx.eventName}\n日時: ${ctx.startsAtJst}${venueLine}${venueUrlLine}`;
  switch (kind) {
    case 'received_pending':
      return `${words.event}のお申し込みを受け付けました。${detail}\n\n${words.contact}の確認をお待ちください。`;
    case 'received_confirmed':
      return appendExtra(
        `${reservation}が確定しました。${detail}\n\n変更・キャンセルは予約履歴画面からお願いします。`,
        ctx.confirmationExtra,
      );
    case 'confirmed':
      return appendExtra(
        `${reservation}が確定しました。${detail}\n\n変更・キャンセルは予約履歴画面からお願いします。`,
        ctx.confirmationExtra,
      );
    case 'rejected':
      return `申し訳ございません、今回の${reservation}はお受けできませんでした。${detail}`;
    case 'cancelled_by_admin':
      return `${words.contact}で${reservation}をキャンセルさせていただきました。${detail}\n\n詳細は LINE にてご連絡ください。`;
    case 'waitlist_offer': {
      const deadline = ctx.offerExpiresAtJst
        ? `\n回答期限: ${ctx.offerExpiresAtJst}`
        : '';
      const link = ctx.offerUrl ? `\n\n予約する: ${ctx.offerUrl}` : '';
      return `キャンセル待ちの空きが出ました。${detail}${deadline}${link}\n\n期限までに予約するか選んでください。期限を過ぎると次の方へご案内します。`;
    }
    case 'reminder_day_before':
      return appendExtra(`【リマインド】明日${words.event}が開催されます。${detail}`, ctx.reminderExtra);
    case 'reminder_hours_before': {
      const hours = ctx.hoursBefore ?? 0;
      return appendExtra(
        `【リマインド】まもなく${words.event}開始です（あと ${hours} 時間）。${detail}`,
        ctx.reminderExtra,
      );
    }
    case 'schedule_changed': {
      const summary = ctx.changeSummary?.trim()
        ? `\n\n変更内容: ${ctx.changeSummary.trim()}`
        : '';
      return `${words.event}の内容が変更になりました。${detail}${summary}\n\n参加が難しい場合は予約履歴画面から変更・キャンセルをお願いします。`;
    }
  }
}

export interface SendEventNotificationParams {
  channelAccessToken: string;
  signal?: AbortSignal;
  delivery?: { db: D1Database; accountId: string; operationId: string; subject?:EventNotificationSubject; authorize?: () => Promise<boolean>; deadlineAt?: number };
  /** 同じ論理的な自動通知では識別子を固定する。 */
  retryKey?: string;
  toLineUserId: string;
  kind: EventNotificationKind;
  ctx: EventNotificationContext;
}

/** 通常送信と回復が、同じ組立済みの不変の本文を使う。 */
export async function sendPreparedEventBookingNotification(
  channelAccessToken: string, snapshot: { to: string; messages: Message[] }, signal?: AbortSignal, retryKey?: string,
): Promise<void> {
  const client = new LineClient(channelAccessToken, signal ? { transport: lineTransport(signal) } : undefined);
  await client.pushMessage(snapshot.to, snapshot.messages, retryKey);
}

export async function sendEventBookingNotification(
  params: SendEventNotificationParams,
): Promise<void> {
  const ctx=params.ctx.style||!params.delivery?params.ctx
    :{...params.ctx,style:await readNotificationStyle(params.delivery.db,params.delivery.accountId)};
  const snapshot = { to: params.toLineUserId, kind: params.kind, ctx,
    messages:[{type:'text' as const,text:renderEventNotificationText(params.kind,ctx)}],
    ...(params.delivery?.subject?{subject:params.delivery.subject}:{}) };
  const send = async (signal: AbortSignal | undefined, saved: typeof snapshot, key?: string) => {
    await sendPreparedEventBookingNotification(params.channelAccessToken, saved, signal, key);
  };
  if (!params.delivery) return send(params.signal, snapshot, params.retryKey);
  const { db, accountId, operationId } = params.delivery;
  await deliverBookingLine(db, { accountId, operationId, snapshot, retryKey: params.retryKey,
    deadlineAt: params.delivery.deadlineAt,
    authorize: async saved => !!await db.prepare(`SELECT 1 ok FROM friends f WHERE f.line_account_id=? AND f.line_platform_user_id=?
      AND f.is_following=1 AND ${activeTenantLineAccountSql('f.line_account_id')}`).bind(accountId, saved.to).first()
      && !await isOperationCapabilityStopped(db, accountId, 'reminder_dispatch')
      && await featureJobCanRun(db, { accountId, featureId: 'events', job: 'event notification' })
      && (!saved.subject||await currentEventNotificationSubject(db,accountId,saved.subject,saved.to))
      && (!params.delivery!.authorize || await params.delivery!.authorize()),
    send,
  });
}

export type EventBookingNotificationSender = (
  params: SendEventNotificationParams,
) => Promise<void>;
