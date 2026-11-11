import { purgeUnboundBookingStripeReceipts, markOverdueBookingStripeReceipts } from '../features/booking/booking-stripe-webhooks/index.js';
import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { sweepOperatorPush, retryOperatorPush } from '../services/operator-push.js';

import { decideAbTests } from '../features/broadcasts/broadcast-ab/index.js';

import { expireMakeup } from '../features/booking/booking-makeup/index.js';

import type { Env } from '../worker-env.js';

import { processScenarioSourceJobs } from '../features/scenarios/scenario-source-jobs/index.js';

import { purgeExpiredFormDocuments } from '../features/forms/form-documents/index.js';

import { purgeInstagramTransientData } from '../services/instagram.js';

import { processRestaurantCustomerNotices } from '../services/restaurant-customer-booking.js';

import { purgeExpiredScenarioDrafts } from '../routes/scenario-drafts.js';

import { processVisitStampQueue } from '../services/visit-stamps.js';

import { LineClient } from '@line-crm/line-sdk';
import { getLineAccounts, processPendingMileageEvents, processActionScoreInactivity } from '@line-crm/db';

import { processFriendFieldReminders } from '../features/friends/friend-field-reminders/index.js';
import { toJstParts } from '@line-crm/shared';
import { checkAccountHealth } from '../services/ban-monitor.js';

import { processInsightFetch } from '../services/insight-fetcher.js';

import { processDueFriendBulkRuns } from '../features/friends/friend-bulk-runs/index.js';

import { dispatchActionScoreApplications } from '../services/action-score-events.js';
import { processDueMileageRewardDeliveries } from '../features/mileage/mileage-reward-delivery/index.js';

import { pruneSensitiveRateLimits } from '../middleware/sensitive-rate-limit.js';

import { dbFor } from '../services/db-router.js';

import { runIsolatedScheduledJobs, type ScheduledJob } from '../services/scheduled-job-isolation.js';

import { googleBusinessEnabled, restaurantTestEnabled } from '../lib/environment-features.js';

export async function runFrequentHeavyJobs(
  event: ScheduledEvent,
  env: Env['Bindings'],
): Promise<void> {
  try { await pruneSensitiveRateLimits(env.DB, new Date(event.scheduledTime)); }
  catch { logger.error("sensitive_rate_limit_cleanup_failed"); }
  const dbAccounts = await getLineAccounts(env.DB);
  const lineClients = new Map<string, LineClient>();
  for (const account of dbAccounts) {
    if (account.is_active) lineClients.set(account.id, new LineClient(account.channel_access_token));
  }
  try {
    const { processAutoReplyDeliveries } = await import('../features/auto-replies/auto-reply-delivery/index.js');
    await processAutoReplyDeliveries(env,new Date(event.scheduledTime));
  } catch { logger.error("src_index_failed"); }

  const defaultLineClient = new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN);
  const jobs: ScheduledJob[] = [
    {name:'operator push digest',run:async()=>{await sweepOperatorPush(env.DB,env,new Date(event.scheduledTime));await retryOperatorPush(env.DB,env,new Date(event.scheduledTime));}},
    {name:'makeup credit expiry',run:()=>expireMakeup(env.DB,new Date(event.scheduledTime))},
    {name:'AB test decisions (test transport)',run:()=>decideAbTests(env.DB,new Date(event.scheduledTime))},
    {name:'line webhook recovery',run:async()=>{const {processDueLineWebhookRetries}=await import('../services/line-webhook-recovery.js');await processDueLineWebhookRetries(env);}},
    {name:'durable tracked click continuation',run:async()=>{const {processDueTrackedClicks}=await import('../services/tracked-click-steps.js');await processDueTrackedClicks(env);}},
    {name:'durable banner generation',run:async()=>{const {processDueBannerGenerations}=await import('../services/banner-jobs.js');await processDueBannerGenerations(env);}},
    {
      name: 'form document retention',
      run: async () => { await purgeExpiredFormDocuments(env.DB, env.IMAGES, new Date(event.scheduledTime)); },
    },
    {name:'API draft and integration retention',run:async()=>{const now=new Date(event.scheduledTime);await purgeExpiredScenarioDrafts(env.DB,now);await purgeInstagramTransientData(env.DB,now);await purgeUnboundBookingStripeReceipts(env.DB,event.scheduledTime);const pending=await markOverdueBookingStripeReceipts(env.DB,event.scheduledTime);if(pending>0)logger.warn('booking_stripe_binding_overdue');}},
    {name:'booking waitlist expiry and promotion',run:async()=>{const {processBookingWaitlists}=await import('../services/waitlist-tick.js');await processBookingWaitlists(env);}},
    {
      name: 'follower import continuation',
      run: async () => {
        const { processPendingFollowerImports } = await import('../services/follower-import-background.js');
        await processPendingFollowerImports(env.DB, { credentialKey: env.LINE_CREDENTIAL_ENCRYPTION_KEY });
      },
    },
    {
      // EC の再試行（上限つき）の回収。落ちた受信を保存済み payload から
      // 同じ入口で回し直す。上限到達は dead letter へ倒す。安定キーと
      // claim で二重実行なし。停止中は回さない。
      name: 'ec event retry',
      run: async () => {
        const { processDueEcRetries } = await import('../features/ec-commerce/ec-retry/index.js');
        const result = await processDueEcRetries(env.DB, {
          now: new Date(event.scheduledTime).toISOString(),
          credentialKey: env.LINE_CREDENTIAL_ENCRYPTION_KEY,
        });
        if (result.processed + result.failed > 0) {
          logger.log("ec_event_retry");
        }
      },
    },
    {
      name: 'calendar busy cache and switch jobs',
      run: async () => {const {refreshCalendarBusyCaches,processCalendarSwitchJobs}=await import('../features/booking/booking-calendar-settings/index.js');const credentials={email:env.GOOGLE_SERVICE_ACCOUNT_EMAIL,privateKey:env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY};await refreshCalendarBusyCaches(env.DB,credentials,new Date(event.scheduledTime));await processCalendarSwitchJobs(env.DB,credentials,new Date(event.scheduledTime));},
    },
    {
      name: 'booking sync notices',
      run: async () => {
        const { processBookingSyncNoticeQueue } = await import('../features/booking/booking-sync-rules/index.js');
        await processBookingSyncNoticeQueue(env);
      },
    },
    {
      // 取消時の Calendar 削除の残り (retry_wait) を自動回収する。
      // 初回 200 の後に残っても次の tick で直る。安定キーで二重実行なし。
      name: 'booking calendar delete retry',
      run: async () => {
        const { processPendingCalendarDeleteOperations, removeBookingFromGoogle } = await import(
          '../features/booking/booking-calendar-sync/index.js'
        );
        const result = await processPendingCalendarDeleteOperations(env.DB, {
          now: new Date(event.scheduledTime),
          remove: (bookingId) => removeBookingFromGoogle(env.DB, {
            email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            privateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
          }, bookingId),
        });
        if (result.processed > 0) {
          logger.log("booking_calendar_delete_retry");
        }
      },
    },
    {
      // 危険なファイルの検査の再試行。期限切れの pending を拾って回す。
      // 検査が動かない時は pending のまま置き、clean に格上げしない。
      name: 'file scan retry',
      run: async () => {
        const { processDueFileScans } = await import('../routes/file-scan.js');
        const result = await processDueFileScans(env, 20);
        if (result.processed > 0) {
          logger.log("file_scan_retry");
        }
      },
    },
    {
      name: 'friend bulk runs',
      run: async () => {
        const result = await processDueFriendBulkRuns(env.DB, {
          now: new Date(event.scheduledTime).toISOString(),
          executorDependencies: { credentialEncryptionKey: env.LINE_CREDENTIAL_ENCRYPTION_KEY },
        });
        if (result.items > 0) logger.log("friend_bulk_runs_cron");
      },
    },
    {
      name: 'scheduled chat sends',
      run: async () => {
        const { processDueScheduledChatSends } = await import(
          '../services/scheduled-chat-sends.js'
        );
        const result = await processDueScheduledChatSends(env, {
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (result.claimed > 0) {
          logger.log("scheduled_chat_sends");
        }
      },
    },
    {
      // 運営からのお知らせの予約配信（★37-7）。claim で 1 件ずつ sending にしてから送る。
      name: 'platform announcements',
      run: async () => {
        const { processDueAnnouncements } = await import('../services/platform-announcements.js');
        const result = await processDueAnnouncements(env, { now: japanCalendar(new Date(event.scheduledTime)).toISOString().replace('Z', '+09:00') });
        if (result.sent > 0) logger.log("platform_announcements_cron");
      },
    },
    {
      name: 'mileage reward delivery retry',
      run: async () => {
        const result = await processDueMileageRewardDeliveries(env.DB, {
          now: new Date(event.scheduledTime).toISOString(),
          credentialEncryptionKey: env.LINE_CREDENTIAL_ENCRYPTION_KEY,
          limit: 50,
        });
        if (result.processed > 0) {
          logger.log("mileage_reward_delivery_retry");
        }
      },
    },
    {
      name: 'analytics cross',
      run: async () => {
        const {
          processPendingAnalyticsCrossRuns,
          recoverStalledAnalyticsCrossRuns,
        } = await import('@line-crm/db');
        const recovered = await recoverStalledAnalyticsCrossRuns(
          env.DB,
          new Date(event.scheduledTime),
        );
        const result = await processPendingAnalyticsCrossRuns(env.DB, 1);
        if (recovered + result.processed + result.failed > 0) {
          logger.log("analytics_cross_tick");
        }
      },
    },
    {
      name: 'mileage projection',
      run: async () => {
        try {
          const result = await processPendingMileageEvents(env.DB, { limit: 100 });
          if (result.claimed > 0) {
            logger.log("src_index_log");
          }
        } finally {
          // 付与に失敗しても、他店の予約済み通知は届ける。
          if (env.WORKER_PUBLIC_URL) {
            const { deliverDueMileageGrantNotifications } = await import(
              '../features/mileage/mileage-grant-notification/index.js'
            );
            const { dispatchLineProxyLocally } = await import('../services/local-line-proxy.js');
            const notified = await deliverDueMileageGrantNotifications(
              {
                db: env.DB,
                workerPublicUrl: env.WORKER_PUBLIC_URL,
                dispatch: (request) => dispatchLineProxyLocally(request, env),
              },
              { limit: 20 },
            );
            if (notified.delivered + notified.failed > 0) {
              logger.log("src_index_log");
            }
          }
        }
      },
    },
    {
      // マニュアル導線の週1回の点検（要件 -34 §8-4）。cron自体は
      // 短い間隔で回るので、最終確認から7日を経るまで関数側で何もしない。
      // 新たに broken になったリンクだけ、運営へ1回だけ知らせる。
      name: 'manual link weekly check',
      run: async () => {
        const { runWeeklyManualLinkCheck, notifyBrokenManualLinks } = await import(
          '../services/manual-link-check.js'
        );
        const result = await runWeeklyManualLinkCheck(env.DB);
        if (!result) return;
        if (result.newlyBroken.length > 0) {
          await notifyBrokenManualLinks(env.DB, env, result.newlyBroken);
        }
        logger.log("manual_link_weekly_check");
      },
    },
    {
      name: 'ad conversion outbox retry',
      run: async () => {
        const { drainAdConversionOutbox } = await import('../services/ad-conversion.js');
        const result = await drainAdConversionOutbox(env.DB, {
          limit: 50, credentialKey: env.LINE_CREDENTIAL_ENCRYPTION_KEY,
        });
        if (result.claimed > 0) {
          logger.log("ad_conversion_outbox_tick");
        }
      },
    },
    {
      name: 'analytics url exposure projection',
      run: async () => {
        const { processPendingAnalyticsUrlExposures } = await import('@line-crm/db');
        const result = await processPendingAnalyticsUrlExposures(env.DB, {
          limit: 100,
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (result.claimed > 0) {
          logger.log("analytics_url_exposure_queue");
        }
      },
    },
    {
      name: 'analytics projection',
      run: async () => {
        const { refreshRecentAnalyticsProjections } = await import('../services/analytics-projection.js');
        const result = await refreshRecentAnalyticsProjections(
          env.DB,
          dbAccounts,
          new Date(event.scheduledTime),
        );
        if (result.processed > 0) {
          logger.log("analytics_projection_tick");
        }
      },
    },
    {
      name: 'analytics scheduled reports',
      run: async () => {
        const { processDueAnalyticsReports } = await import('../services/analytics-reports.js');
        const result = await processDueAnalyticsReports(env, new Date(event.scheduledTime));
        if (result.processed + result.failed + result.purged + result.reclaimed + result.repaired > 0) {
          logger.log("analytics_report_tick");
        }
      },
    },
    {
      // 日次CSVの履歴は、店舗とJST暦日から作る安定IDで1回だけ生成する。
      name: 'scheduled exports',
      run: async () => {
        const { processDueScheduledExports } = await import('../services/scheduled-exports.js');
        const result = await processDueScheduledExports(env, {
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (result.generated + result.failed > 0) {
          logger.log("scheduled_exports_tick");
        }
      },
    },
    {
      //  第2段: Google Sheets への日次同期。その日(JST)の scheduled
      // 実行が済んでいる連携は飛ばし、未実行分だけ6時間tickのどれか1回が回す。
      name: 'google sheets sync',
      run: async () => {
        const { processDueGoogleSheetsSyncs } = await import('../services/google-sheets.js');
        const result = await processDueGoogleSheetsSyncs(env, {
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (result.synced + result.failed > 0) {
          logger.log("google_sheets_sync_tick");
        }
      },
    },
    { name: 'visit stamps', run: () => processVisitStampQueue(env) },
    { name: 'restaurant followup jobs', run: async () => { await processScenarioSourceJobs(env); } },
    { name: 'account health', run: async () => { await checkAccountHealth(env.DB); } },
    {
      name: 'broadcast insights',
      run: async () => { await processInsightFetch(env.DB, lineClients, defaultLineClient); },
    },
    {
      name: 'NEN rich menu jobs',
      run: async () => {
        const { processPendingNenRichMenuJobs } = await import('../services/nen-rich-menu.js');
        const result = await processPendingNenRichMenuJobs(env);
        if (result.processed > 0) logger.log("nen_rich_menu_job");
      },
    },
    {
      // リッチメニューの毎日の照合。公開中の group を1日1回だけ見る。
      // 見つけたずれは直さず台帳に残す。直すのは運用者が 照合・修復画面で行う。
      name: 'rich menu daily reconcile',
      run: async () => {
        const { processDailyRichMenuReconcile } = await import('../features/rich-menus/rich-menu-daily-reconcile/index.js');
        const result = await processDailyRichMenuReconcile(env.DB, {
          now: new Date(event.scheduledTime),
        });
        if (result.checked + result.failed > 0) {
          logger.log("rich_menu_daily_reconcile");
        }
      },
    },
  ];

  if (!env.XSERVER_RELAY_SECRET && env.XSERVER_MAIL_HOST && env.XSERVER_MAIL_USER && env.XSERVER_MAIL_PASSWORD) {
    jobs.push({
      name: 'support email sync',
      run: async () => {
        const { syncXServerSupportMailbox } = await import('../services/xserver-mail.js');
        const result = await syncXServerSupportMailbox(env);
        if (result.checked > 0) logger.log("support_email_sync");
      },
    });
  }

  if (restaurantTestEnabled(env)) {
    jobs.push({
      name: 'restaurant hold expiry',
      run: async () => {
        const { expireRestaurantHolds, applyDueRestaurantMenuPrices } = await import('../services/restaurant-booking.js');
        await expireRestaurantHolds(dbFor(env), new Date(event.scheduledTime).toISOString());
        const { processRestaurantInventoryRuleQueue } = await import('../services/restaurant-inventory-rules.js');
        await processRestaurantInventoryRuleQueue(env);
        await processRestaurantCustomerNotices(env);
        await applyDueRestaurantMenuPrices(dbFor(env));
      },
    });
  }
  if (googleBusinessEnabled(env)) {
    jobs.push({
      // Googleビジネス第4段: 口コミ・投稿の再同期。重い処理用レーン（`1-56/5`。
      // 通知レーンと1分ずらした5分間隔）で動くが、接続ごとの55分ゲートで実質1時間ごと。
      // 読み取りAPIだけを呼び、書き込みAPIは呼ばない（手動syncと同じ関数を使う）。
      name: 'google business resync',
      run: async () => {
        const { processGoogleBusinessHourlyResync } = await import('../services/google-business-resync.js');
        const result = await processGoogleBusinessHourlyResync(env, {
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (result.reviewsSynced + result.postsSynced + result.failed > 0) {
          logger.log("google_business_resync_tick");
        }
      },
    });
  }

  const jstMinutes = toJstParts(new Date(event.scheduledTime)).minutes;

  // 日本時間の各時01分に、友だち情報欄の日付から当日分のリマインダを立てる。
  if (jstMinutes === 1) {
    jobs.push({
      name: 'friend field reminders',
      run: async () => {
        const result = await processFriendFieldReminders(env.DB);
        if (result.enrolled > 0 || result.hasMore) {
          logger.log("src_index_log");
        }
      },
    });
  }

  // 通知処理を重くしないよう、無反応スコアの再評価は各時11分の重い処理側で行う。
  if (jstMinutes === 11) {
    jobs.push({
      name: 'action score inactivity',
      run: async () => {
        const result = await processActionScoreInactivity(env.DB, {
          now: new Date(event.scheduledTime).toISOString(),
          limit: 200,
        });
        for (const transition of result.transitions) {
          const account = dbAccounts.find((item) => item.id === transition.lineAccountId);
          await dispatchActionScoreApplications(env.DB, {
            ...transition,
            lineAccessToken: account?.channel_access_token,
          });
        }
        if (result.candidates > 0) {
          logger.log("action_score_inactivity_tick");
        }
      },
    });
  }

  await runIsolatedScheduledJobs(jobs);
}
