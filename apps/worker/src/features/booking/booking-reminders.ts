import type { AccountStyle } from '@line-crm/shared';
import { runBookingExternalStep } from './booking-external-step.js';
import { API_RETRY_WAIT, lineFailure } from '../../lib/external-call/index.js';
import {bookingCancellationQuote} from './booking-cancellation.js';
// 通知文面の組立に必要な予約・メニュー・担当者・アカウント・友だちは、まとめて取得して問い合わせを増やさない。

import type { BookingNotificationSender, NotificationKind } from './booking-notifier.js';
import { formatStartsAtForStore, notificationTiming, renderNotificationText } from './booking-notifier.js';
import type { Message } from '@line-crm/line-sdk';
import { REMINDER_MAX_RETRY } from './booking-types.js';
import {
  activeTenantLineAccountSql,
  isOperationCapabilityStopped,
  resolveLineCredential,
} from '@line-crm/db';
import { stoppedTenantLineAccountSql } from '../../services/tenant-runtime-status.js';
import { featureJobCanRun } from '../../services/feature-enforcement.js';

interface DueRow {
  id: string;
  booking_id: string;
  line_account_id: string;
  kind: 'day_before' | 'hours_before';
  retry_count: number;
  last_error: string | null;
  retry_key: string | null;
  recipient_line_user_id: string | null;
  messages_json: string | null;
  meeting_mode:string|null;meeting_url:string|null;policy_snapshot_json:string|null;
  starts_at: string;
  menu_name: string;
  staff_name: string;
  channel_access_token: string;
  channel_access_token_encrypted: string | null;
  line_user_id: string;
  /** 店舗のタイムゾーン。文面の日時と「本日/明日」の判定に使う。 */
  timezone: string | null;
  notification_style: AccountStyle | null;
}

interface ReminderRequestSnapshot {
  retry_key: string;
  recipient_line_user_id: string;
  messages_json: string;
}

export interface ProcessRemindersParams {
  now: Date;
  sender: BookingNotificationSender;
}

/**
 * 送信権の貸出期限（分）。claim 時に sent_at を刻み、期限内の行は
 * 別 cron が拾わない。処理中に止まった worker の行は期限切れで回収する。
 * 期限の起点は「貸出開始」のため、成功時は送信完了時刻で上書きし、
 * 失敗時は NULL に戻して次回すぐに拾えるようにする。
 */
const REMINDER_CLAIM_LEASE_MINUTES = 10;

function claimCutoffIso(now: Date): string {
  return new Date(now.getTime() - REMINDER_CLAIM_LEASE_MINUTES * 60_000).toISOString();
}

export async function processDueReminders(
  db: D1Database,
  params: ProcessRemindersParams,
): Promise<{ sent: number; failed: number }> {
  // 統括の復旧後に期限切れの通知をまとめて送らないよう、取得前に期限到達分を取消へ進める。cancelled は終端であり送信の成功・失敗に数えない。
  await db.prepare(
    `UPDATE booking_reminders
        SET status = 'cancelled', last_error = 'tenant_suspended'
      WHERE status IN ('pending','failed')
        AND scheduled_at <= ?
        AND EXISTS (
          SELECT 1 FROM bookings stopped_booking
           WHERE stopped_booking.id = booking_reminders.booking_id
             AND ${stoppedTenantLineAccountSql('stopped_booking.line_account_id')}
        )`,
  ).bind(params.now.toISOString()).run();
  // status は 'pending' に加え 'failed'（一時エラーで失敗、retry 残あり）も拾う。
  // 'failed_permanent' / 'sent' / 'cancelled' は再送対象外。
  const due = await db
    .prepare(
      `SELECT r.id, r.booking_id, r.kind, r.retry_count, r.last_error,
              r.retry_key, r.recipient_line_user_id, r.messages_json,
              b.line_account_id, b.starts_at, b.meeting_mode, b.meeting_url,b.policy_snapshot_json,
              m.name AS menu_name,
              s.display_name AS staff_name,
              la.channel_access_token,
              la.channel_access_token_encrypted,
              f.line_platform_user_id AS line_user_id,
              bs.timezone, ast.style AS notification_style
         FROM booking_reminders r
         INNER JOIN bookings b ON b.id = r.booking_id
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         INNER JOIN line_accounts la ON la.id = b.line_account_id
         INNER JOIN friends f ON f.id = b.friend_id AND f.line_account_id=b.line_account_id
          LEFT JOIN booking_settings bs ON bs.line_account_id = b.line_account_id
         LEFT JOIN account_styles ast ON ast.line_account_id=b.line_account_id AND ast.selection_mode='configured'
        WHERE r.status IN ('pending','failed')
          AND r.retry_count < 3
          AND r.scheduled_at <= ?
          AND f.is_following=1
          AND b.status = 'confirmed'
          AND b.starts_at > ?       -- 開始時刻を過ぎた予約のリマインダは送らない
          AND (r.sent_at IS NULL OR r.sent_at < ?)  -- R330: 貸出中の行は拾わない
          AND ${activeTenantLineAccountSql('b.line_account_id')}
        LIMIT 100`,
    )
    .bind(params.now.toISOString(), params.now.toISOString(), claimCutoffIso(params.now))
    .all<DueRow>();

  let sent = 0;
  let failed = 0;
  for (const row of due.results) {
    const kind: NotificationKind = row.kind;
    // 機能オフ中は送らずpendingのまま残す。再オンで再開する。
    if (row.line_account_id && !await featureJobCanRun(db, { accountId: row.line_account_id, featureId: 'booking', job: 'booking reminders' })) {
      continue;
    }
    // 緊急停止 : reminder_dispatch が止まっている統括は claim せず
    // pending のまま残す。復旧すれば次の cron が拾う。
    if (await isOperationCapabilityStopped(db, row.line_account_id, 'reminder_dispatch')) {
      continue;
    }
    // 読み出し時点の試行回数。fence の CAS はこの値を epoch に使い、失敗記録も
    // これを基準にする (claim 後に row を読み直さない)。
    // catch へ来るのは自分が失敗したときだけ。握れなかった行は continue で
    // 抜けるので catch を通らない。よって fence の前で投げた場合 (資格情報が
    // 復号できない等) も1回ぶん数える: 数えないと retry_count が伸びず、上限で
    // failed_permanent へ打ち切れないまま failed で滞留する (due の SELECT は
    // LIMIT 100 で ORDER BY が無く、滞留行が正常なリマインダを押し出す)。
    const priorRetry = row.retry_count;
    const attemptedRetry = priorRetry + 1;
    let claimed = false;
    try {
      // 送信の準備 (資格情報の復号) は fence の前に済ませる。fence と外部
      // 送信の間に待つ処理を挟まない (の verifyClaimedRunBeforeSend と
      // 同じ形。窓を SQL 1文ぶんに詰める)。
      const accessToken = await resolveLineCredential(
        row.channel_access_token_encrypted,
        row.channel_access_token,
        { lineAccountId: row.line_account_id, field: 'channel_access_token' },
      );
      // NULL の旧行も従来の日時・文面で組み立て、初回の送信権と一緒に保存。
      // 再送では本文を再描画しない。ctx は既存の sender の契約として残す。
      const timeZone = row.timezone ?? 'Asia/Tokyo';
      const ctx = {
        style:row.notification_style??'standard',
        meetingMode:row.meeting_mode,meetingUrl:row.meeting_url,
        ...(row.policy_snapshot_json?{cancellationText:(await bookingCancellationQuote(db,row.booking_id,row.line_account_id)).text}:{}),
        menuName: row.menu_name,
        staffName: row.staff_name,
        startsAt: formatStartsAtForStore(row.starts_at, timeZone),
        ...notificationTiming(row.starts_at, timeZone, params.now),
      };
      const messagesJson = row.messages_json ?? JSON.stringify([
        { type: 'text', text: renderNotificationText(kind, ctx) },
      ]);
      // 取消と送信の直列化 (原子的)。上の SELECT の b.status='confirmed' は
      // 読み出し時にしか効かず、100件ループの全区間で取消を素通りさせる。
      // 送る直前に1文で「まだ未送信」と「予約がまだ confirmed」と
      // 「今の種別が通知方針で有効」を確かめ、同時に送信権を握る
      // (retry_count を claim epoch に、sent_at を貸出印に使う)。
      // 取消・方針OFFが先なら 0 件になり送らない。0 件は別 cron が担当
      // した場合も同じなので、どちらでもこの実行は手を引く。
      // 方針の判定は保存ずみの snapshot を読む。未保存の旧予約
      // (NULL/'{}') は従来どおり送る側に倒す (route 側の既定値と同じ)。
      const claim = await db
        .prepare(
          `UPDATE booking_reminders
              SET retry_count = retry_count + 1, sent_at = ?,
                  retry_key = COALESCE(retry_key, ?),
                  recipient_line_user_id = COALESCE(recipient_line_user_id, ?),
                  messages_json = COALESCE(messages_json, ?)
            WHERE id = ? AND retry_count = ? AND status IN ('pending','failed')
              AND (sent_at IS NULL OR sent_at < ?)
              AND EXISTS (
                SELECT 1 FROM bookings b
                 WHERE b.id = booking_reminders.booking_id AND b.status = 'confirmed'
                   AND ${activeTenantLineAccountSql('b.line_account_id')}
                   AND CASE booking_reminders.kind
                         WHEN 'day_before'
                         THEN json_extract(b.notification_policy_snapshot, '$.day_before')
                         ELSE json_extract(b.notification_policy_snapshot, '$.hours_before')
                       END IS NOT 0)
            RETURNING retry_key, recipient_line_user_id, messages_json`,
        )
        .bind(params.now.toISOString(), row.retry_key ?? crypto.randomUUID(),
          row.recipient_line_user_id ?? row.line_user_id, messagesJson,
          row.id, priorRetry, claimCutoffIso(params.now))
        .first<ReminderRequestSnapshot>();
      if (!claim) continue;
      claimed = true;

      // claim と送信の間に緊急停止へ切り替わった分は、握った retry_count を
      // 差し戻して pending のまま残す。停止を失敗として数えない。
      // 貸出印も消し、次回すぐに拾えるようにする。
      if (await isOperationCapabilityStopped(db, row.line_account_id, 'reminder_dispatch')) {
        await db
          .prepare(
            `UPDATE booking_reminders SET retry_count = retry_count - 1, sent_at = NULL
              WHERE id = ? AND retry_count = ? AND sent_at = ? AND status IN ('pending','failed')`,
          )
          .bind(row.id, attemptedRetry, params.now.toISOString())
          .run();
        continue;
      }

      // RETURNING で実際に保存した要求を使う。停止で貸出を戻した直後に
      // 古い SELECT を持つ別 cron が claim しても、保存ずみの値を変えない。
      const snapshot = { to: claim.recipient_line_user_id, kind, ctx,
        messages: JSON.parse(claim.messages_json) as Message[] };
      const outcome = await runBookingExternalStep(db, {
        ref: { scopeId: `line:${row.line_account_id}`, processKind: 'booking_reminder', subjectId: row.id, stepKey: 'send' },
        identity: { scope: { accountId: row.line_account_id, storeId: row.line_account_id,
          destination: 'line', connectionId: row.line_account_id }, operationId: row.id,
          idempotencyKey: claim.retry_key, snapshotId: row.id, effect: 'write' },
        policy: { category: 'api', maxAttempts: REMINDER_MAX_RETRY, timeoutMs: 10_000,
          deadlineAt: Date.parse(row.starts_at), wait: API_RETRY_WAIT },
        initialAttempts: priorRetry, legacyUnknown: priorRetry > 0 && row.last_error !== 'notification_preflight_failed', snapshot, now: () => params.now.getTime(),
        authorize: async () => !await isOperationCapabilityStopped(db, row.line_account_id, 'reminder_dispatch')
          && await featureJobCanRun(db, { accountId: row.line_account_id, featureId: 'booking', job: 'booking reminders' }),
        execute: async (signal, saved, identity) => {
          try {
            await params.sender({ channelAccessToken: accessToken, toLineUserId: saved.to,
              kind: saved.kind, ctx: saved.ctx, messages: saved.messages, retryKey: identity.idempotencyKey, signal });
            return { kind: 'success', value: { accepted: true } };
          } catch (error) { return lineFailure(error, identity, params.now.getTime()); }
        },
        statements: next => {
          if (next.phase === 'started') return [
            db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM booking_reminders r JOIN bookings b ON b.id=r.booking_id
              WHERE r.id=? AND r.status IN ('pending','failed') AND r.retry_count=? AND r.sent_at=?
                AND b.status='confirmed' AND b.starts_at>?
                AND EXISTS(SELECT 1 FROM friends live_friend WHERE live_friend.id=b.friend_id
                  AND live_friend.line_account_id=b.line_account_id AND live_friend.is_following=1 AND live_friend.line_platform_user_id=?)
                AND ${activeTenantLineAccountSql('b.line_account_id')}
                AND CASE r.kind WHEN 'day_before' THEN json_extract(b.notification_policy_snapshot,'$.day_before')
                  ELSE json_extract(b.notification_policy_snapshot,'$.hours_before') END IS NOT 0)
              THEN 'true' ELSE 'booking_reminder_obsolete' END)`)
              .bind(row.id, attemptedRetry, params.now.toISOString(), params.now.toISOString(), claim.recipient_line_user_id),
            db.prepare(`UPDATE booking_reminders
            SET status='failed_permanent',last_error='delivery_unknown'
            WHERE id=? AND status IN ('pending','failed') AND retry_count=? AND sent_at=?`)
              .bind(row.id, attemptedRetry, params.now.toISOString())];
          return [db.prepare(`UPDATE booking_reminders SET status=?,sent_at=?,last_error=?
            WHERE id=? AND status='failed_permanent' AND last_error='delivery_unknown'
              AND retry_count=? AND sent_at=?`)
            .bind(next.phase === 'succeeded' ? 'sent' : 'failed_permanent', params.now.toISOString(),
              next.phase === 'succeeded' ? null : next.phase === 'unknown' ? 'delivery_unknown' : 'delivery_rejected',
              row.id, attemptedRetry, params.now.toISOString())];
        },
      });
      if (outcome.kind === 'success' || outcome.kind === 'succeeded') {
        const completed = await db.prepare("SELECT status FROM booking_reminders WHERE id=?").bind(row.id).first<{ status: string }>();
        if (completed?.status === 'sent') sent++;
      } else {
        if (outcome.kind === 'unknown' || outcome.kind === 'stopped' && outcome.state.phase === 'stopped') {
          await db.prepare(`UPDATE booking_reminders SET status='failed_permanent',last_error=?
            WHERE id=? AND status IN ('pending','failed') AND retry_count=? AND sent_at=?`)
            .bind(outcome.kind === 'unknown' ? 'delivery_unknown' : 'delivery_rejected', row.id, attemptedRetry, params.now.toISOString()).run();
        } else if (outcome.state.phase === 'ready') {
          // 遮断・停止・送信前保存の競合で0要求なら、外側の準備用の貸出を戻す。
          await db.prepare(`UPDATE booking_reminders SET retry_count=retry_count-1,sent_at=NULL
            WHERE id=? AND status IN ('pending','failed') AND retry_count=? AND sent_at=?`)
            .bind(row.id,attemptedRetry,params.now.toISOString()).run();
        }
        const completed = await db.prepare("SELECT status FROM booking_reminders WHERE id=?").bind(row.id).first<{ status: string }>();
        if (completed?.status === 'failed_permanent') failed++;
      }
    } catch (e) {
      // fence で握れていれば DB 上も同じ値まで進んでいる (二重に数えない)。
      // ここでも取消ずみの行は触らない。貸出印は消して次回に備える。
      // claim 前の失敗は読み出した回数・貸出期限、claim 後は自分の貸出を
      // 照合する。古い応答で新しい試行の回数や結果を巻き戻さない。
      const newStatus = attemptedRetry >= REMINDER_MAX_RETRY ? 'failed_permanent' : 'failed';
      const recorded = await db
        .prepare(
          `UPDATE booking_reminders
              SET status = ?, retry_count = ?, last_error = ?, sent_at = NULL
            WHERE id = ? AND status IN ('pending','failed')
              AND retry_count = ?
              AND ${claimed ? 'sent_at = ?' : '(sent_at IS NULL OR sent_at < ?)'}`,
        )
        .bind(newStatus, attemptedRetry, 'notification_preflight_failed', row.id,
          claimed ? attemptedRetry : priorRetry,
          claimed ? params.now.toISOString() : claimCutoffIso(params.now))
        .run();
      if ((recorded.meta?.changes ?? 0) > 0) failed++;
    }
  }
  return { sent, failed };
}
