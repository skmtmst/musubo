import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { jstDateOffset as japanDateOffset } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../worker-env.js';

import { enqueueFollowingMileageMilestones } from '@line-crm/db';

import { runExpirer } from '../features/booking/booking-expirer/index.js';

import { runEventBookingExpirer } from '../services/event-booking-expirer.js';

import { sendBookingNotification } from '../features/booking/booking-notifier/index.js';

import events from '../routes/events.js';

import { tenants } from '../routes/tenants.js';

import { deleteExpiredRestaurantRawEmails } from '../services/restaurant-email-intake.js';
import { runIsolatedScheduledJobs, type ScheduledJob } from '../services/scheduled-job-isolation.js';

import { googleBusinessEnabled, restaurantTestEnabled } from '../lib/environment-features.js';

export async function runSixHourlyHeavyJobs(
  event: ScheduledEvent,
  env: Env['Bindings'],
): Promise<void> {
  const jobs: ScheduledJob[] = [
    {
      name: 'NEN tag refresh',
      run: async () => {
        const { refreshAllNenTags } = await import('../services/nen-tag-sync.js');
        const result = await refreshAllNenTags(env.DB, { allTenants: true }, 500, new Date());
        if (result.added + result.removed > 0) logger.log("nen_tag_refresh");
      },
    },
    {
      name: 'personal data retention',
      run: async () => {
        const { processPersonalDataRetention } = await import('../services/personal-data-retention.js');
        const result = await processPersonalDataRetention(env, new Date(event.scheduledTime));
        if (result.failed) throw new Error('personal_data_retention_retry_required');
      },
    },
    {
      name: 'analytics retention purge',
      run: async () => {
        const { purgeExpiredAnalyticsReadData } = await import('@line-crm/db');
        const purged = await purgeExpiredAnalyticsReadData(env.DB, new Date(event.scheduledTime));
        if (
          purged.events + purged.dailyMetrics + purged.reconciliationRuns
          + purged.funnelRuns + purged.crossRuns + purged.savedSnapshots + purged.audiences > 0
        ) {
          logger.log("analytics_retention_purged");
        }
      },
    },
    {
      // -25 §15: 明細90日・日別13か月。確定済みだけ畳んで消す。
      name: 'automation retention purge',
      run: async () => {
        const { purgeExpiredAutomationRuns } = await import('@line-crm/db');
        const purged = await purgeExpiredAutomationRuns(env.DB, new Date(event.scheduledTime));
        if (purged.runs + purged.dailyExpired > 0) {
          logger.log("automation_retention_purged");
        }
      },
    },
    {
      name: 'friend snapshot',
      run: async () => {
        const { recordFriendSnapshot } = await import('@line-crm/db');
        await recordFriendSnapshot(env.DB, null);
      },
    },
    {
      // 日常更新は各保存経路で原子的に行う。ここは欠損補修だけの経路。
      name: 'media usage scan',
      run: async () => {
        const { scanMediaUsage } = await import('../features/media/media-usage-scan/index.js');
        const scanStartedAt = japanCalendar().toISOString().replace('Z', '');
        const result = await scanMediaUsage(env.DB, scanStartedAt);
        if (result.matched > 0 || result.pruned > 0) {
          logger.log("media_usage_scan");
        }
      },
    },
    {
      name: 'following mileage',
      run: async () => {
        const result = await enqueueFollowingMileageMilestones(env.DB, { limitPerMilestone: 1000 });
        if (result.eventsCreated + result.queued > 0) {
          logger.log("src_index_log");
        }
      },
    },
    {
      name: 'booking expirer',
      run: async () => {
        const result = await runExpirer(env.DB, { now: new Date(), sender: sendBookingNotification,
          credentials: { email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, privateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY } });
        logger.log("src_index_log");
      },
    },
    {
      name: 'event booking expirer',
      run: async () => {
        const result = await runEventBookingExpirer(env.DB, { now: new Date() });
        logger.log("src_index_log");
      },
    },
    {
      // 共通情報の期限の14日前・3日前に運用者へ知らせる。
      name: 'common var expiry notices',
      run: async () => {
        const { sweepCommonVarExpiryNotices } = await import('../services/common-var-expiry-sweep.js');
        const result = await sweepCommonVarExpiryNotices(env.DB, env, new Date());
        if (result.notified > 0 || result.errors > 0) {
          logger.log("common_var_expiry_sweep");
        }
      },
    },
    {
      name: 'billing invoice sync',
      run: async () => {
        const { syncBillingInvoicesDaily } = await import('../services/billing-invoices-sync.js');
        const result = await syncBillingInvoicesDaily(env, new Date(event.scheduledTime));
        if (result && (result.imported > 0 || result.failed > 0)) {
          logger.log("billing_invoice_sync");
        }
      },
    },
    {
      // 広告費の日次取り込み。媒体の数字は前日分までしか確定しないので
      // 対象は常に昨日(JST)。実行台帳の媒体×日一意制約で、6時間ごとの
      // 再実行は成功済みの分を取り直さない。
      name: 'ad cost import',
      run: async () => {
        const { importAdCosts } = await import('../services/ad-cost-import.js');
        const day = japanDateOffset(-1);
        const result = await importAdCosts(env.DB, {
          day,
          credentialKey: env.LINE_CREDENTIAL_ENCRYPTION_KEY,
        });
        if (result.imported + result.failed > 0) {
          logger.log("ad_cost_import");
        }
      },
    },
    {
      // TikTok利益計算: EC-CUBEの注文明細を取り込み、利益計算シートへ反映。
      // 差分（sheet_dirty）だけ書くので6時間ごとの再実行は重くならない。
      name: 'tiktok pnl sync',
      run: async () => {
        const { processTiktokPnlTick } = await import('../services/tiktok-pnl.js');
        const result = await processTiktokPnlTick(env, {
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (result.createdSheets + result.importedOrders + result.wroteRows + result.failed > 0) {
          logger.log("tiktok_pnl_tick");
        }
      },
    },
    {
      // ★36-2: 退会・無料体験切れから保存期限が過ぎた統括の顧客データを消す。
      // 1回の行数に上限があり、途中で止まっても次の回が続きから消す。
      name: 'tenant data retention purge',
      run: async () => {
        const { processTenantDataPurge } = await import('../services/tenant-data-purge.js');
        const result = await processTenantDataPurge(env, {
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (result.failedTenants) throw new Error('tenant_data_purge_retry_required');
        if (result.anchoredTrials + result.tenants + result.deletedRows > 0) {
          logger.log("tenant_data_retention_purge");
        }
      },
    },
    {
      name: 'registration application retention',
      run: async () => {
        const { purgeExpiredRegistrationApplications } = await import('../services/registration-application-retention.js');
        const deleted = await purgeExpiredRegistrationApplications(env.DB, new Date(event.scheduledTime));
        if (deleted) logger.log('registration_application_retention');
      },
    },
    {
      // Googleビジネス: Googleから受け取った内容の保存期限（暦日30日）を守る掃除。
      // 機能スイッチでゲートしない。機能をoffにした店舗の古いコピーが残り続けるほうが
      // ポリシー違反になるため、スイッチと関係なく毎回走らせる。
      name: 'google business content retention',
      run: async () => {
        const { purgeExpiredGoogleContent, totalRetentionActions } = await import(
          '../services/google-business-retention.js'
        );
        const result = await purgeExpiredGoogleContent(env, {
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (totalRetentionActions(result) > 0) {
          logger.log("google_business_content_retention");
        }
      },
    },
  ];

  if (restaurantTestEnabled(env)) {
    jobs.push({
      name: 'restaurant raw mail retention',
      run: async () => {
        const result = await deleteExpiredRestaurantRawEmails(env);
        if (result.deleted + result.failed > 0) {
          logger.log("restaurant_raw_mail_retention");
        }
      },
    });
  }
  if (googleBusinessEnabled(env)) {
    jobs.push({
      // Googleビジネス第4段: パフォーマンス指標の取り込み。JST日付でゲートし、
      // 6時間tickのうち当日未実行の最初の1回（通常は深夜）だけ実際に回る。
      name: 'google business metrics',
      run: async () => {
        const { processGoogleBusinessDailyMetrics } = await import('../services/google-business-resync.js');
        const result = await processGoogleBusinessDailyMetrics(env, {
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (result.synced + result.failed > 0) {
          logger.log("google_business_metrics_tick");
        }
      },
    });
    jobs.push({
      // Googleビジネス: 認可を切らさないための先回り更新。再同期が回らない接続
      // （場所未選択・機能off）のトークンも6時間ごとに使って、放置による失効を防ぐ。
      name: 'google business token keepalive',
      run: async () => {
        const { processGoogleBusinessTokenKeepalive } = await import('../services/google-business-resync.js');
        const result = await processGoogleBusinessTokenKeepalive(env, {
          now: new Date(event.scheduledTime).toISOString(),
        });
        if (result.refreshed + result.failed > 0) {
          logger.log("google_business_token_keepalive_tick");
        }
      },
    });
  }

  await runIsolatedScheduledJobs(jobs);
}
