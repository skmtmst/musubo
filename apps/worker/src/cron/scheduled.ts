import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger, tracedFetch as fetch } from '@line-crm/shared/server';
import type { Env } from '../worker-env.js';

import { processRestaurantEvents } from '../services/restaurant-events.js';

import { processVisitStampReminders } from '../services/visit-stamp-reminders.js';

import { LineClient } from '@line-crm/line-sdk';
import { getLineAccountById, isLineAccountTenantActive } from '@line-crm/db';
import { processStepDeliveries } from '../services/step-delivery.js';
import { processScheduledBroadcasts, processQueuedBroadcasts } from '../features/broadcasts/broadcast/index.js';
import { processReminderDeliveries } from '../services/reminder-delivery.js';

import { refreshLineAccessTokens } from '../services/token-refresh.js';

import { processDueReminders } from '../features/booking/booking-reminders/index.js';

import { processDueEventReminders } from '../services/event-booking-reminders.js';
import { processDueMeetConsultationReminders } from '../services/meet-consultation-reminders.js';
import { processDueAutomationRuns } from '../features/automations/automation-engine/index.js';

import { createAutomationActionExecutors } from '../features/automations/automation-action-executors/index.js';
import { processOverdueSupportMarkTriggers, processScheduledAutomationTriggers } from '../features/automations/automation-triggers/index.js';

import { sendEventBookingNotification } from '../services/event-booking-notifier.js';
import { createEventWaitlistOfferSender, processEventWaitlistPromotionJobs } from '../services/event-waitlist.js';
import { sendBookingNotification } from '../features/booking/booking-notifier/index.js';

import { staff } from '../routes/staff.js';

import { lineProxy } from '../routes/line-proxy.js';

import { dbFor } from '../services/db-router.js';

import { runScheduledOperationHealthChecks } from '../services/operations-health.js';
import { observeOperationDispatcher } from '../services/operation-dispatch-health.js';
import { processOperationNotificationOutbox } from '../services/operation-notifications.js';
import { processOperationAlertNotificationOutbox } from '../services/operation-alert-notifications.js';
import { sweepBillingFailureNotices, sweepBillingRecoveryNotices } from '../services/billing-invoice-notifications.js';
import { OPERATOR_NOTIFICATION_SWEEP_LIMIT, sweepOperatorNotifications } from '../services/operator-notification-dispatch.js';

import { runIsolatedScheduledJobs, scheduledLane } from '../services/scheduled-job-isolation.js';

import { runFrequentHeavyJobs } from './frequent.js';
import { runSixHourlyHeavyJobs } from './six-hourly.js';

// 稼働中の全 LINE アカウントを対象にする。
export async function scheduled(
  event: ScheduledEvent,
  env: Env['Bindings'],
  ctx: ExecutionContext,
): Promise<void> {
  // 通知・配信と、再実行できる重い集計・走査を別のCron invocationへ分ける。
  // 重い処理は次の専用tickで処理単位ごとに再試行され、通知tickを占有しない。
  const lane = scheduledLane(event.cron);
  if (lane === 'restaurantMinute') {
    await runIsolatedScheduledJobs([
      {name:'restaurant events',run:()=>processRestaurantEvents(env)},
      {name:'customer segments and ranks',run:async()=>{
        const now=new Date(event.scheduledTime);
        if(japanCalendar(now).getUTCHours()<4)return;
        const {processCustomerSegments}=await import('../services/customer-segments.js');
        await processCustomerSegments(env.DB,now);
      }},
      {name:'store comparison snapshots',run:async()=>{
        const now=new Date(event.scheduledTime),jst=japanCalendar(now);
        if(jst.getUTCHours()*60+jst.getUTCMinutes()<270)return;
        const {processStoreComparison}=await import('../services/store-comparison.js');
        await processStoreComparison(env.DB,now);
      }},
      {name:'pass notice simulations',run:async()=>{const {processPassNotices}=await import('../features/booking/booking-pass-notices/index.js');await processPassNotices(env.DB,new Date(event.scheduledTime));}},
      {name:'pass billing grace',run:async()=>{const {expirePassGrace}=await import('../features/booking/booking-pass-billing/index.js');await expirePassGrace(env.DB,new Date(event.scheduledTime));}},
      {name:'comparison CSV jobs',run:async()=>{const {processComparisonExports}=await import('../services/store-comparison-export.js');await processComparisonExports(env.DB,new Date(event.scheduledTime));}},
      {name:'rank notice simulations',run:async()=>{const {processRankNotices}=await import('../services/member-ranks.js');await processRankNotices(env.DB,new Date(event.scheduledTime));}},
      {name:'EC automatic LINE simulation',run:async()=>{
        const {processAutoLineMock}=await import('../features/ec-commerce/ec-auto-line/index.js');
        await processAutoLineMock(env.DB,new Date(event.scheduledTime));
      }},
      {name:'inbox first response deadlines',run:async()=>{
        const {processInboxSla}=await import('../services/inbox-sla.js');
        await processInboxSla(env.DB,new Date(event.scheduledTime));
      }},
    ]);
    return;
  }
  if (lane === 'frequentHeavy') {
    await runFrequentHeavyJobs(event, env);
    return;
  }
  if (lane === 'sixHourlyHeavy') {
    await runSixHourlyHeavyJobs(event, env);
    return;
  }
  if (lane !== 'delivery') return;

  // 接続の運用確認とリマインドより先にトークンを取り替える (失効直後トークンでの 401 送信を防ぐ。
  // 送信前に有効なトークンを準備する)。
  try {
    await refreshLineAccessTokens(env.DB);
  } catch (e) {
    logger.error("src_index_failed");
  }

  // 管理画面を開いていなくても、各LINEアカウントの確認項目を5分窓ごとに保存する。
  // 各checkと各accountは独立しており、失敗しても配信ジョブを止めない。
  try {
    await runScheduledOperationHealthChecks(env.DB, {
      r2: env.IMAGES,
      queue: env.CODEX_MENTION_QUEUE, security: env,
    });
  } catch (error) {
    logger.error("src_index_failed");
  }

  try {
    await processOperationNotificationOutbox(env);
  } catch (error) {
    logger.error("src_index_failed");
  }

  try {
    await processOperationAlertNotificationOutbox(env);
  } catch (error) {
    logger.error("src_index_failed");
  }

  try {
    const result = await sweepBillingFailureNotices(env, new Date(event.scheduledTime));
    if (result.failed > 0) logger.error('billing_invoice_notification_sweep_failed');
  } catch {
    logger.error('billing_invoice_notification_sweep_failed');
  }

  try {
    const result = await sweepBillingRecoveryNotices(env, new Date(event.scheduledTime));
    if (result.failed > 0) logger.error('billing_recovery_notification_sweep_failed');
  } catch {
    logger.error('billing_recovery_notification_sweep_failed');
  }

  try {
    const { sweepMusuboContracts } = await import('../services/musubo-core-subscription.js');
    const result = await sweepMusuboContracts(env);
    if (result.failed > 0) logger.error('musubo_contract_sweep_failed');
  } catch {
    logger.error('musubo_contract_sweep_failed');
  }

  try {
    const { sweepMusuboLineAdditions } = await import('../services/musubo-line-addition.js');
    const result = await sweepMusuboLineAdditions(env);
    if (result.failed > 0) logger.error('musubo_line_addition_sweep_failed');
  } catch {
    logger.error('musubo_line_addition_sweep_failed');
  }

  try {
    const { sweepMusuboLineAdditionNotices } = await import('../services/musubo-line-addition-notification.js');
    const result = await sweepMusuboLineAdditionNotices(env);
    if (result.failed > 0) logger.error('musubo_line_addition_notice_sweep_failed');
  } catch {
    logger.error('musubo_line_addition_notice_sweep_failed');
  }

  try {
    const { sweepMusuboRecurringPrices } = await import('../services/musubo-recurring-prices.js');
    const result = await sweepMusuboRecurringPrices(env);
    if (result.failed > 0) logger.error('musubo_recurring_prices_sweep_failed');
  } catch {
    logger.error('musubo_recurring_prices_sweep_failed');
  }

  try {
    const { sweepMusuboFinalLineEnds } = await import('../services/musubo-final-line-end.js');
    const result = await sweepMusuboFinalLineEnds(env, new Date(event.scheduledTime).toISOString());
    if (result.failed > 0) logger.error('musubo_final_line_end_sweep_failed');
  } catch {
    logger.error('musubo_final_line_end_sweep_failed');
  }

  try {
    const { sweepMusuboFinalLineNotices } = await import('../services/musubo-final-line-notification.js');
    const result = await sweepMusuboFinalLineNotices(env);
    if (result.failed > 0) logger.error('musubo_final_line_notice_sweep_failed');
  } catch {
    logger.error('musubo_final_line_notice_sweep_failed');
  }

  try {
    const { sweepMusuboLineResumptions } = await import('../services/musubo-line-resumption.js');
    const result = await sweepMusuboLineResumptions(env, new Date(event.scheduledTime));
    if (result.failed > 0) logger.error('musubo_line_resumption_sweep_failed');
  } catch {
    logger.error('musubo_line_resumption_sweep_failed');
  }

  try {
    const { sweepMusuboResumptionNotices } = await import('../services/musubo-resumption-notification.js');
    const result = await sweepMusuboResumptionNotices(env, new Date(event.scheduledTime));
    if (result.failed > 0) logger.error('musubo_resumption_notice_sweep_failed');
  } catch {
    logger.error('musubo_resumption_notice_sweep_failed');
  }

  //  公開済み運用者通知ルールの送り残しを回収する。
  //
  // 初回の送信は業務イベントの側で同期に行う。ここが拾うのは、そこで
  // 落ちて retry_wait に入った行と、Worker が途中で止まって pending の
  // まま残った行だけ。回収しないと「公開したのに届かない」が、繋がって
  // いないからではなく溜まったままで起きる。
  //
  // 間隔をこの delivery レーン(5分)に載せた理由と件数の根拠は
  // services/operator-notification-dispatch.ts の SWEEP 定数の説明にある。
  // 1件の失敗で他のアカウントの回収を止めないよう、例外はここで止める。
  try {
    const result = await sweepOperatorNotifications(env.DB, env, {
      limit: OPERATOR_NOTIFICATION_SWEEP_LIMIT,
      now: new Date(event.scheduledTime),
    });
    if (result.swept > 0) {
      logger.log("operator_notification_sweep");
    }
  } catch (error) {
    logger.error("src_index_failed");
  }

  // 送信Webhookの送り残しを回収する。
  //
  // 初回の送信はイベント発火の側で同期に行う。ここが拾うのは、そこで
  // 落ちて retry_wait に入った行と、Worker が途中で止まって
  // pending/sending のまま残った行だけ。再送時刻は台帳の
  // next_retry_at が持つので、5分のレーンで十分である。
  // 1件の失敗で他の回収を止めないよう、例外はここで止める。
  try {
    const { sweepOutgoingWebhookDeliveries, OUTGOING_WEBHOOK_SWEEP_LIMIT } =
      await import('../services/outgoing-webhook-delivery.js');
    const result = await sweepOutgoingWebhookDeliveries(env.DB, {
      limit: OUTGOING_WEBHOOK_SWEEP_LIMIT,
      now: new Date(event.scheduledTime),
    });
    if (result.swept > 0) {
      logger.log("outgoing_webhook_delivery_sweep");
    }
  } catch (error) {
    logger.error("src_index_failed");
  }

  try {
    const { processAutoReplyDeliveries } = await import('../features/auto-replies/auto-reply-delivery/index.js');
    await processAutoReplyDeliveries(env,new Date(event.scheduledTime));
  } catch (error) { logger.error("src_index_failed"); }

  const defaultLineClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
  const dispatchObservedAt = new Date(event.scheduledTime).toISOString();
  const observeDispatch = <T>(jobName: string, run: () => Promise<T>) =>
    observeOperationDispatcher(env.DB, jobName, run, dispatchObservedAt);

  // 配信系は1回だけ実行（内部でfriendのline_account_idから正しいlineClientを動的解決）
  // アカウントフィルタなしの DB クエリで取得するため、全体を1回だけ処理する。
  // アカウントごとの再実行で同じ配信を重ねない。
  ctx.waitUntil(import('../routes/webhooks.js').then(({processIncomingWebhookQueue})=>processIncomingWebhookQueue(env)).catch(()=>logger.error("incoming_queue_failed")));

  // 復旧処理 (batch_offset=-1 → 0 にする軽量な UPDATE のみ) を queue 処理より
  // 先に await 完了させる。これで stalled/stuck から復旧した配信が同じ cron tick の
  // processQueuedBroadcasts に拾われ、復旧レイテンシが 1 tick 縮む。recover は inline 送信を
  // 含まない高速処理なので、先に await しても他ジョブを starve させない。
  const { recoverStalledBroadcasts, recoverStuckDeliveries } = await import('@line-crm/db');
  await Promise.allSettled([
    recoverStalledBroadcasts(env.DB),
    recoverStuckDeliveries(env.DB),
  ]);

  // Booking / event-booking リマインドは時刻厳守 + 軽量 (数件/tick、上限100件) なので、
  // 開始前の通知期限を守るため、重い配信・insight ジョブより先に実行する。
  // 手前のジョブが invocation を止めると数時間分のリマインドが未送信のまま
  // starts_at を過ぎると送信ガードにより送れなくなるため、後続ジョブで遅延させない。

  // オートメーションの日時指定を起動し、待機・一時失敗中の実行を再開する。
  // 同じ5分Cronにまとめても、実行・処理ごとの冪等キーで二重実行を防ぐ。
  try {
    await observeDispatch('automation deliveries', async () => {
      const now = new Date(event.scheduledTime).toISOString();
      const executors = createAutomationActionExecutors({
        credentialEncryptionKey: env.LINE_CREDENTIAL_ENCRYPTION_KEY,
        operatorMailEnv: env,
      });
      const scheduledResult = await processScheduledAutomationTriggers(env.DB, {
        now, executors, limit: 100,
      });
      const overdueResults = await processOverdueSupportMarkTriggers(env.DB, {
        now, executors, limit: 100,
      });
      for (const result of [...scheduledResult.results, ...overdueResults]) {
        if (result.kind === 'configuration_error') {
          logger.error("automation_v6_scheduled_trigger_failed");
        }
      }
      const dueResult = await processDueAutomationRuns(env.DB, {
        now, executors, limit: 100,
      });
      if (scheduledResult.results.length + overdueResults.length + dueResult.processed > 0) {
        logger.log("automation_v6_cron");
      }
    });
  } catch (e) {
    logger.error("src_index_failed");
  }

  try {
    await observeDispatch('booking reminders', async () => {
      const result = await processDueReminders(env.DB, {
        now: new Date(),
        sender: sendBookingNotification,
      });
      if (result.sent + result.failed > 0) {
        logger.log("src_index_log");
      }
    });
  } catch (e) {
    logger.error("src_index_failed");
  }

  try {
    await observeDispatch('event reminders', async () => {
      const result = await processDueEventReminders(env.DB, {
        now: new Date(),
        sender: sendEventBookingNotification,
      });
      if (result.sent + result.failed > 0) {
        logger.log("src_index_log");
      }
    });
  } catch (e) {
    logger.error("src_index_failed");
  }

  // 取消・拒否・期限切れで空いた席を、同意が必要な24時間の保留として先頭へ案内する。
  // LINE送信に失敗したjobは完了にせず、次のdelivery tickで再試行する。
  try {
    const result = await processEventWaitlistPromotionJobs(env.DB, {
      now: new Date(event.scheduledTime),
      sender: createEventWaitlistOfferSender(env.DB, { liffUrl: env.LIFF_URL }),
    });
    if (result.processed > 0) {
      logger.log("src_index_log");
    }
  } catch (e) {
    logger.error("src_index_failed");
  }

  // 来店スタンプの期限通知。配信の見張り（observeDispatch）の対応表には未登録なので、
  // event-waitlist と同じく、定期処理から直接呼ぶ。
  try {
    await processVisitStampReminders(dbFor(env), {
      now: new Date(event.scheduledTime), proxyBaseUrl: env.WORKER_PUBLIC_URL ?? 'https://your-worker.your-subdomain.workers.dev',
      proxyDispatch: request => Promise.resolve(lineProxy.fetch(request, env, ctx)),
    });
  } catch {
    logger.error("visit_stamp_reminders_pending");
  }

  // 外部Google Calendarで確定したMeet個別相談。前日・1時間前のLINE通知を
  // D1で管理し、送信は必ずLINE Harness Proxyを通す。
  try {
    await observeDispatch('meet consultation reminders', async () => {
      const result = await processDueMeetConsultationReminders(env.DB, {
        now: new Date(),
        proxyBaseUrl:
          env.WORKER_PUBLIC_URL ?? 'https://your-worker.your-subdomain.workers.dev',
        proxyDispatch: (request) => Promise.resolve(lineProxy.fetch(request, env, ctx)),
      });
      if (result.sent + result.failed > 0) {
        logger.log("src_index_log");
      }
    });
  } catch (e) {
    logger.error("src_index_failed");
  }

  // ウェビナー予約リマインド (セッション選択メニュー)。時刻厳守・軽量なので
  // booking 系リマインドと同じく重いジョブより先に実行する。
  try {
    await observeDispatch('webinar reminders', async () => {
      const { processWebinarReminders } = await import('../features/webinars/webinar-reminders/index.js');
      const liffMatch = /liff\.line\.me\/([^/?]+)/.exec(env.LIFF_URL ?? '');
      const result = await processWebinarReminders(
        env.DB,
        {
          proxyBaseUrl:
            env.WORKER_PUBLIC_URL ?? 'https://your-worker.your-subdomain.workers.dev',
          defaultAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
          defaultLiffId: liffMatch?.[1] ?? null,
          proxyDispatch: (request) => Promise.resolve(lineProxy.fetch(request, env, ctx)),
        },
      );
      if (result.sent + result.failed > 0) {
        logger.log("src_index_log");
      }
    });
  } catch (e) {
    logger.error("src_index_failed");
  }

  // で設定した複数時点の通知。既存の5分前通知とはDB上で排他的にし、
  // 同じ申込へ二重送信しない。
  try {
    await observeDispatch('webinar notifications', async () => {
      const { processWebinarNotificationJobs } = await import('../features/webinars/webinar-notifications/index.js');
      const liffMatch = /liff\.line\.me\/([^/?]+)/.exec(env.LIFF_URL ?? '');
      const result = await processWebinarNotificationJobs(env.DB, {
        proxyBaseUrl:
          env.WORKER_PUBLIC_URL ?? 'https://your-worker.your-subdomain.workers.dev',
        defaultAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
        defaultLiffId: liffMatch?.[1] ?? null,
        proxyDispatch: (request) => Promise.resolve(lineProxy.fetch(request, env, ctx)),
      });
      if (result.sent + result.failed + result.skipped > 0) {
        logger.log("src_index_log");
      }
    });
  } catch (e) {
    logger.error("src_index_failed");
  }

  // NEN専用の購入後フォローと誕生日クーポン。自動配信なのでmanualヘッダーは付けない。
  try {
    await observeDispatch('NEN campaign deliveries', async () => {
      const { processNenDeliveries, enqueueBirthdayCoupons } = await import('../services/nen-engagement.js');
      const { dispatchOperatorEvent } = await import('../services/operator-notification-dispatch.js');
      // EC側の発行に失敗しても残りの子と通常配信は止めない。失敗は
      // 運用通知へ回し、次の日次走査で同じコードへ収束させる（部分成功を成功扱いしない）。
      const birthday = await enqueueBirthdayCoupons(
        env.DB,
        new Date(),
        env.NEN_EC_BASE_URL && env.ECCUBE_WEBHOOK_SECRET
          ? { baseUrl: env.NEN_EC_BASE_URL, secret: env.ECCUBE_WEBHOOK_SECRET }
          : undefined,
        async (failure) => {
          if (!failure.lineAccountId) return;
          await dispatchOperatorEvent(env.DB, env, {
            lineAccountId: failure.lineAccountId,
            eventType: 'nen_birthday_coupon_failed',
            sourceEventId: `nen_coupon_issue_failed:${failure.petId}:${failure.issueYear}`,
            message: `誕生日クーポンの発行に失敗しました。次の日次処理でやり直します（コード: ${failure.couponCode || '未発行'}）`,
            executionMode: 'automatic',
          });
        },
      );
      const result = await processNenDeliveries(env.DB, {
        proxyBaseUrl: env.WORKER_PUBLIC_URL ?? 'https://your-worker.your-subdomain.workers.dev',
        defaultAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
        proxyDispatch: (request) => Promise.resolve(lineProxy.fetch(request, env, ctx)),
      });
      /*
       * 採用写真のポイント付与outboxの日次回収。
       * 採用直後・手動の再試行で届かなかった分を、期限の来た順に届け直す。
       * EC接続が未設定の環境では何もしない（行は「要対応」として一覧に残る）。
       */
      const { processDuePhotoRewards, processDuePhotoPublicationRewards, ecPhotoPointClientFromEnv } = await import('../services/photo-reward-sync.js');
      const photoRewards = await processDuePhotoRewards(
        env.DB,
        ecPhotoPointClientFromEnv(env),
        { now: new Date() },
      );
      const publicationRewards = await processDuePhotoPublicationRewards(
        env.DB, ecPhotoPointClientFromEnv(env), { now: new Date() },
      );
      if (birthday.queued + birthday.failed + result.sent + result.failed + result.skipped
        + result.deferred + photoRewards.synced + photoRewards.failed + photoRewards.skipped
        + publicationRewards.synced + publicationRewards.failed > 0) {
        logger.log("nen_campaign_tick");
      }
    });
  } catch (e) {
    logger.error("src_index_failed");
  }

  // 共通情報の日付での切り替え。
  //
  // applied_at が NULL で、予約した日時を過ぎたものだけを反映する。
  // 二度当たらないので、cron が重なっても値が飛ばない。
  // 失敗しても他の処理は続ける。営業時間の表記が1周ぶん古いままなのと、
  // 配信そのものが止まるのとでは、後者の方がはるかに重い。
  try {
    await observeDispatch('common variable schedules', async () => {
      const { applyDueCommonVarSchedules } = await import('@line-crm/db');
      const jstNowIso = japanCalendar().toISOString().replace('Z', '');
      const applied = await applyDueCommonVarSchedules(env.DB, jstNowIso);
      if (applied > 0) logger.log("common_var_schedule_applied");
    });
  } catch (e) {
    logger.error("src_index_failed");
  }

  // 保存済みリッチメニュー公開予約を時刻到来時に実行する。
  // 予約時のスナップショットを公開し、期間モードは終了時に元メニューへ戻す。
  // 失敗しても他の処理は続ける。実LINE送信はここで行うが、DB配備は別工程。
  try {
    const { processDueRichMenuSchedules } = await import('../features/rich-menus/rich-menu-schedule-executor/index.js');
    const { assembleRichMenuGroupInput, richMenuLiveToSnapshot } = await import('../features/rich-menus/rich-menu-group-input/index.js');
    const {
      getRichMenuGroupWithPages,
      getLineAccountById,
      getStaffById,
    } = await import('@line-crm/db');
    const { canAccessAllLineAccounts } = await import('../services/account-access.js');
    const {
      createRichMenuShells,
      switchRichMenuLive,
      restorePreSwitchLive,
      restorePreSwitchDefault,
      deleteRichMenuShells,
    } = await import('../lib/rich-menu-publisher.js');
    const r2Adapter = {
      async get(key: string) {
        const obj = await env.IMAGES.get(key);
        if (!obj) return null;
        return { body: obj.body as ReadableStream };
      },
    };
    // routes の createLineClient と同じ実装をここで再現する。
    const createScheduleLineClient = (auth: string) => ({
      async createRichMenu(payload: unknown) {
        const res = await fetch('https://api.line.me/v2/bot/richmenu', {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`LINE createRichMenu failed: ${res.status} ${await res.text()}`);
        return res.json() as Promise<{ richMenuId: string }>;
      },
      async validateRichMenu(payload: unknown) {
        const res = await fetch('https://api.line.me/v2/bot/richmenu/validate', {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`LINE validateRichMenu failed: ${res.status} ${await res.text()}`);
      },
      async listRichMenus() {
        const res = await fetch('https://api.line.me/v2/bot/richmenu/list', {
          headers: { Authorization: auth },
        });
        if (!res.ok) throw new Error(`LINE listRichMenus failed: ${res.status}`);
        const body = (await res.json()) as { richmenus?: Array<{ richMenuId?: string; name?: string }> };
        return (body.richmenus ?? []).flatMap((menu) => (
          typeof menu.richMenuId === 'string'
            ? [{ richMenuId: menu.richMenuId, name: typeof menu.name === 'string' ? menu.name : null }]
            : []
        ));
      },
      async uploadRichMenuImage(richMenuId: string, image: Uint8Array, contentType: string) {
        const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': contentType },
          body: image,
        });
        if (!res.ok) throw new Error(`LINE uploadRichMenuImage failed: ${res.status} ${await res.text()}`);
      },
      async deleteRichMenuAlias(aliasId: string) {
        const res = await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
          method: 'DELETE',
          headers: { Authorization: auth },
        });
        if (!res.ok && res.status !== 404) throw new Error(`LINE deleteRichMenuAlias failed: ${res.status}`);
      },
      async createRichMenuAlias(aliasId: string, richMenuId: string) {
        const res = await fetch('https://api.line.me/v2/bot/richmenu/alias', {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
        });
        if (!res.ok) throw new Error(`LINE createRichMenuAlias failed: ${res.status}`);
      },
      async upsertRichMenuAlias(aliasId: string, richMenuId: string) {
        const res = await fetch(`https://api.line.me/v2/bot/richmenu/alias/${aliasId}`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuId }),
        });
        if (res.ok) return;
        if (res.status === 404) {
          const createRes = await fetch('https://api.line.me/v2/bot/richmenu/alias', {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ richMenuAliasId: aliasId, richMenuId }),
          });
          if (createRes.ok) return;
          throw new Error(`LINE createRichMenuAlias failed: ${createRes.status}`);
        }
        throw new Error(`LINE updateRichMenuAlias failed: ${res.status}`);
      },
      async deleteRichMenu(richMenuId: string) {
        const res = await fetch(`https://api.line.me/v2/bot/richmenu/${richMenuId}`, {
          method: 'DELETE',
          headers: { Authorization: auth },
        });
        if (!res.ok && res.status !== 404) throw new Error(`LINE deleteRichMenu failed: ${res.status}`);
      },
      async setDefaultRichMenu(richMenuId: string) {
        const res = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
          method: 'POST',
          headers: { Authorization: auth },
        });
        if (!res.ok) throw new Error(`LINE setDefaultRichMenu failed: ${res.status}`);
      },
      async clearDefaultRichMenu() {
        const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
          method: 'DELETE',
          headers: { Authorization: auth },
        });
        if (!res.ok && res.status !== 404) throw new Error(`LINE clearDefaultRichMenu failed: ${res.status}`);
      },
      async getCurrentDefaultRichMenuId() {
        const res = await fetch('https://api.line.me/v2/bot/user/all/richmenu', {
          method: 'GET',
          headers: { Authorization: auth },
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`LINE getCurrentDefaultRichMenu failed: ${res.status}`);
        const body = (await res.json()) as { richMenuId?: string };
        return body.richMenuId ?? null;
      },
      async linkRichMenuBulk(richMenuId: string, userIds: string[]) {
        const res = await fetch('https://api.line.me/v2/bot/richmenu/bulk/link', {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ richMenuId, userIds }),
        });
        if (!res.ok) throw new Error(`LINE linkRichMenuBulk failed: ${res.status}`);
      },
    });
    const buildGroupInput = async (snapshot: unknown, fallbackGroupId: string) => {
      const record = snapshot as import('../features/rich-menus/rich-menu-group-input/index.js').RichMenuGroupSnapshot;
      const groupId = typeof record.id === 'string' ? record.id : fallbackGroupId;
      const group = await getRichMenuGroupWithPages(env.DB, groupId);
      const account = group ? await getLineAccountById(env.DB, group.account_id) : null;
      return {
        groupIdForDb: groupId,
        account,
        input: await assembleRichMenuGroupInput(env.DB, record, account, {
          fallbackGroupId: groupId,
          workerBaseUrl: env.WORKER_URL,
          liffUrl: env.LIFF_URL,
        }),
      };
    };
    const result = await processDueRichMenuSchedules(env.DB, {
      getGroupWithPages: (db, groupId) => getRichMenuGroupWithPages(db, groupId),
      getLineAccount: async (db, accountId) => {
        if (!await isLineAccountTenantActive(db, accountId)) return null;
        return getLineAccountById(db, accountId) as Promise<{
          id: string; channel_access_token: string | null; is_active: number; archived_at: string | null;
        } | null>;
      },
      getRequestingStaff: async (db, staffId) => {
        const staff = await getStaffById(db, staffId);
        return staff as unknown as {
          id: string; role: 'owner' | 'admin' | 'staff'; is_active: number; access_level: string | null;
        } | null;
      },
      isStaffAllowedForAccount: async (db, staffId, accountId) => {
        const staff = await getStaffById(db, staffId);
        if (!staff) return false;
        return canAccessAllLineAccounts(db, {
          id: staff.id,
          name: staff.name,
          role: staff.role,
          readOnly: staff.access_level === 'read_only',
          tenantId: staff.tenant_id,
        } as never, [accountId]);
      },
      createLineShells: async (snapshot, schedule, heartbeat) => {
        // 第一段: 予約スナップショットから新規作成だけ行い、新IDを返す。
        // alias/defaultは触らない。DB反映は実行役がjournal確定後に行う。
        // ページ数ぶんの作成と画像uploadで時間がかかるため、1枚ごとに
        // group と予約行の lease を実時刻で延ばす(heartbeat)。
        const built = await buildGroupInput(snapshot, schedule.group_id);
        if (!built.account) throw new Error('line account not found');
        const line = createScheduleLineClient(`Bearer ${built.account.channel_access_token}`);
        const { shells } = await createRichMenuShells(built.input as never, line, r2Adapter, heartbeat);
        const oldByPageId = new Map(
          (built.input.pages as Array<{ id: string; lineRichMenuId: string | null }>).map((page) => [page.id, page.lineRichMenuId]),
        );
        return shells.map((shell) => ({
          pageId: shell.pageId,
          orderIndex: shell.orderIndex,
          newRichMenuId: shell.newRichMenuId,
          oldLineRichMenuId: oldByPageId.get(shell.pageId) ?? null,
        }));
      },
      createRestoreShells: async (restoreGroup, schedule, heartbeat) => {
        // 明示の戻し先の現内容から新規作成だけ行う。alias/defaultは触らない。
        const account = await getLineAccountById(env.DB, restoreGroup.account_id);
        if (!account) throw new Error('line account not found');
        const line = createScheduleLineClient(`Bearer ${account.channel_access_token}`);
        const input = await assembleRichMenuGroupInput(
          env.DB,
          richMenuLiveToSnapshot(restoreGroup),
          account,
          {
            fallbackGroupId: restoreGroup.id,
            workerBaseUrl: env.WORKER_URL,
            liffUrl: env.LIFF_URL,
          },
        );
        const { shells } = await createRichMenuShells(input as never, line, r2Adapter, heartbeat);
        const oldByPageId = new Map(
          (input.pages as Array<{ id: string; lineRichMenuId: string | null }>).map((page) => [page.id, page.lineRichMenuId]),
        );
        return shells.map((shell) => ({
          pageId: shell.pageId,
          orderIndex: shell.orderIndex,
          newRichMenuId: shell.newRichMenuId,
          oldLineRichMenuId: oldByPageId.get(shell.pageId) ?? null,
        }));
      },
      readCurrentDefaultId: async (schedule) => {
        // 切替直前の実LINE defaultを読む。固定(pin)の材料にする。
        const account = await getLineAccountById(env.DB, schedule.account_id);
        if (!account?.channel_access_token) throw new Error('line account not found');
        const line = createScheduleLineClient(`Bearer ${account.channel_access_token}`);
        return line.getCurrentDefaultRichMenuId();
      },
      switchLiveTo: async ({ schedule, groupId, setDefault, shells, heartbeat }) => {
        // 第二段: alias切替+default設定/解除。失敗時は投げるだけで補償しない。
        const account = await getLineAccountById(env.DB, schedule.account_id);
        if (!account) throw new Error('line account not found');
        const line = createScheduleLineClient(`Bearer ${account.channel_access_token}`);
        await switchRichMenuLive(line, {
          id: groupId,
          size: 'large',
          chatBarText: '',
          isDefaultForAll: setDefault,
          pages: shells.map((shell) => ({
            id: shell.pageId,
            orderIndex: shell.orderIndex,
            name: '',
            imageR2Key: null,
            imageContentType: null,
            lineRichMenuId: shell.oldLineRichMenuId,
            areas: [],
          })),
        } as never, shells.map((shell) => ({
          pageId: shell.pageId,
          orderIndex: shell.orderIndex,
          newRichMenuId: shell.newRichMenuId,
        })), heartbeat);
      },
      compensateSwitchToPrevious: async ({ schedule, groupId, prev, newIds }) => {
        // 切替失敗時は journal 削除後に元の状態へ補償する。補償の失敗を呼び出し元へ投げない。
        const account = await getLineAccountById(env.DB, schedule.account_id);
        if (!account?.channel_access_token) {
          // 補償手段がない。何も消さないよう全滅扱いで返す
          // (defaultも読めないので retainedId は不明扱い)。
          return {
            unrestoredPageIds: new Set(prev.oldIds.map((old) => old.pageId)),
            defaultRestore: { state: 'failed' as const, retainedId: null },
          };
        }
        const line = createScheduleLineClient(`Bearer ${account.channel_access_token}`);
        const unrestoredPageIds = await restorePreSwitchLive(line, groupId, prev);
        const defaultRestore = await restorePreSwitchDefault(line, prev, newIds);
        return { unrestoredPageIds, defaultRestore };
      },
      deleteLineShells: async (schedule, lineRichMenuIds) => {
        // 作った分・旧分の後片付け。404許容で決して投げない。
        const account = await getLineAccountById(env.DB, schedule.account_id);
        if (!account?.channel_access_token) return;
        const line = createScheduleLineClient(`Bearer ${account.channel_access_token}`);
        await deleteRichMenuShells(line, lineRichMenuIds);
      },
      restoreCapturedDefault: async (schedule, lineId) => {
        // 固定した切替前defaultへ戻す。すでに固定値なら何もしない。
        // 固定メニューがLINEから消えていたら勝手に解除せず投げる(恒久失敗に残す)。
        const account = await getLineAccountById(env.DB, schedule.account_id);
        if (!account?.channel_access_token) throw new Error('line account not found');
        const line = createScheduleLineClient(`Bearer ${account.channel_access_token}`);
        const current = await line.getCurrentDefaultRichMenuId();
        if (current === lineId) return;
        try {
          await line.setDefaultRichMenu(lineId);
        } catch (error) {
          if (error instanceof Error && /setDefaultRichMenu failed: 404/.test(error.message)) {
            throw new Error(`no_restore_target: pinned default menu ${lineId} was deleted`);
          }
          throw error;
        }
      },
      clearAccountDefault: async (schedule) => {
        // no_default の明示解除。このgroupのものが現在defaultのときだけ外す。
        // 別メニューのdefaultまで壊さない。何もなければ成功扱い。
        const scheduled = await getRichMenuGroupWithPages(env.DB, schedule.group_id);
        const account = await getLineAccountById(env.DB, schedule.account_id);
        if (!scheduled || !account?.channel_access_token) throw new Error('schedule group not found');
        const line = createScheduleLineClient(`Bearer ${account.channel_access_token}`);
        const ownIds = new Set(
          scheduled.pages.map((page) => page.line_richmenu_id).filter((id): id is string => !!id),
        );
        const current = await line.getCurrentDefaultRichMenuId();
        if (current && ownIds.has(current)) {
          await line.clearDefaultRichMenu();
        }
      },
      unlinkIndividualLinks: async (schedule) => {
        // 期限切れメニューを指す個別割当をLINE側で外し、既定へ戻す。
        // 解除済み・対象なしは何もしない。D1行の削除より先に呼ぶ。
        const { listScheduleGroupIndividualLinks } = await import('@line-crm/db');
        const targets = await listScheduleGroupIndividualLinks(env.DB, schedule.account_id, schedule.group_id);
        if (targets.length === 0) return 0;
        const account = await getLineAccountById(env.DB, schedule.account_id);
        if (!account) throw new Error('line account not found');
        const auth = `Bearer ${account.channel_access_token}`;
        let unlinked = 0;
        for (const target of targets) {
          const res = await fetch(
            `https://api.line.me/v2/bot/user/${encodeURIComponent(target.lineUserId)}/richmenu`,
            { method: 'DELETE', headers: { Authorization: auth } },
          );
          if (res.status === 404) continue;
          if (!res.ok) throw new Error(`LINE unlinkRichMenu failed: ${res.status}`);
          unlinked += 1;
        }
        return unlinked;
      },
    }, { now: new Date(event.scheduledTime) });
    if (result.processed > 0) {
      logger.log("rich_menu_schedule_tick");
    }
  } catch (e) {
    logger.error("src_index_failed");
  }

  // 予約画面の未予約、予約後の未視聴、フォーム途中離脱、回答後の相談未予約を
  // 段階別に自動追客する。対象は followup config で有効化したウェビナーだけ。
  try {
    await observeDispatch('webinar followups', async () => {
      const { processWebinarFollowups } = await import('../features/webinars/webinar-followups/index.js');
      const liffMatch = /liff\.line\.me\/([^/?]+)/.exec(env.LIFF_URL ?? '');
      const result = await processWebinarFollowups(env.DB, {
        proxyBaseUrl:
          env.WORKER_PUBLIC_URL ?? 'https://your-worker.your-subdomain.workers.dev',
        defaultAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
        defaultLiffId: liffMatch?.[1] ?? null,
        proxyDispatch: (request) => Promise.resolve(lineProxy.fetch(request, env, ctx)),
      });
      if (result.sent + result.failed > 0) {
        logger.log("src_index_log");
      }
    });
  } catch (e) {
    logger.error("src_index_failed");
  }

  // 配信系と定期ジョブを並列実行する。processScheduledBroadcasts は tag/all の
  // inline 送信を含み時間がかかり得るため、queue 処理と並列にして互いを block しない
  // (barrier 化すると長い scheduled 送信が queue 処理を待たせる)。scheduled dedup は
  // status='sending', batch_offset=0 に enqueue され、同 tick もしくは次 tick (最大5分、
  // 5分 cron の粒度内) で processQueuedBroadcasts に拾われて分割送信される。
  const jobs: Promise<unknown>[] = [];
  jobs.push(
    observeDispatch('scenario deliveries',
      () => processStepDeliveries(env.DB, defaultLineClient, env.WORKER_URL, env.LINE_CREDENTIAL_ENCRYPTION_KEY)),
    observeDispatch('broadcast deliveries', async () => {
      await Promise.all([
        processScheduledBroadcasts(env.DB, defaultLineClient, env.WORKER_URL),
        processQueuedBroadcasts(env.DB, defaultLineClient, env.WORKER_URL),
      ]);
      // 送信後動作の取り残し回収（受理済みだが実行が終わっていない宛先）。
      // 失敗・送達不明の宛先は対象外。送達自体は変えない。
      try {
        const { sweepBroadcastAfterActions } = await import('../features/broadcasts/broadcast-after-actions/index.js');
        const swept = await sweepBroadcastAfterActions(env.DB);
        if (swept.done + swept.failed > 0) {
          logger.log("broadcast_after_actions_sweep");
        }
      } catch (sweepError) {
        logger.error("src_index_failed");
      }
    }),
    observeDispatch('reminder deliveries',
      () => processReminderDeliveries(env.DB, defaultLineClient)),
  );

  await Promise.allSettled(jobs);

  // Cross-account duplicate detection — disabled.
  // The cron used to materialize duplicates into the tag system but the 1k-subrequest
  // budget can't drain a 1k+ candidate backlog, and a live SELECT against
  // friends.picture_url / display_name / status_message gives the same answer
  // on demand. Replacement: a /api/duplicates endpoint plus a dashboard view
  // (planned alongside the multi-provider UI work). Keeping the service file
  // (apps/worker/src/services/duplicate-detect.ts) and the existing
  // `重複:` tag rows untouched until that replacement lands.
}
