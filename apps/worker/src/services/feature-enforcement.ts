export type { FeatureJobEnforcement, FeatureJobMetadata } from './feature-job-types.js';
import type { FeatureJobEnforcement, FeatureJobMetadata } from './feature-job-types.js';
import {recordFeatureExecutionSkipped} from './feature-skip-audit.js';
export {recordFeatureExecutionSkipped} from './feature-skip-audit.js';
import {
  getAccountSettings,
  getTenantBilling,
  getTenantBillingByLineAccount,
  getVersionedAccountSetting,
  recordAuditEvent,
} from '@line-crm/db';
import {
  FEATURE_CATALOG,
  featureCatalogEntry,
  type FeatureId,
} from '@line-crm/shared';

import { featureContractIsAvailable, resolveEntitlements, resolveTenantEntitlements } from './billing-plans.js';
import {
  PERSONAL_DATA_RETENTION_JOB,
  TENANT_DATA_RETENTION_JOB,
  GOOGLE_CONTENT_RETENTION_JOB,
} from './retention-job-manifest.js';

const FEATURE_SETTINGS_BUNDLE_KEY = 'feature.settings_bundle_v1';

type FeatureSettingsBundle = {
  features?: Partial<Record<FeatureId, boolean>>;
};

/**
 * scheduled dispatcher に登録される処理の分類正本。
 *
 * 各行は「どの機能に属するか」と「off強制が実装のどこにあるか」を持つ。
 * enforcement の目印は feature-job-manifest.test.ts が実ソースを読んで
 * 照合するため、判定を消したり移したりすると必ずテストが落ちる。
 */
export const FEATURE_JOB_MANIFEST: readonly FeatureJobMetadata[] = [
  {name:'operator push digest',classification:{kind:'core',reason:'受信箱の運用者通知'},enforcement:{mode:'exempt',reason:'基本受信箱の通知で個別機能に属さない。送信直前に本人の停止・店の範囲・会話権限を確認する'}},
  {name:'makeup credit expiry',classification:{kind:'core',reason:'保存済みの振替券の期限の後始末'},enforcement:{mode:'exempt',reason:'送信や新規予約を行わず、予約機能の停止中も保存済みの期限を守る'}},
  {name:'AB test decisions (test transport)',classification:{kind:'feature',featureId:'broadcasts'},enforcement:{mode:'gated',sources:['apps/worker/src/features/broadcasts/broadcast-ab.ts'],markers:["gate.canRun(db,t.line_account_id,'broadcasts','AB test decisions (test transport)')"]}},
  {name:'calendar busy cache and switch jobs',classification:{kind:'feature',featureId:'booking'},enforcement:{mode:'gated',sources:['apps/worker/src/features/booking/booking-calendar-settings.ts'],markers:["gate.canRun(db,j.line_account_id,'booking','calendar busy cache and switch jobs')","gate.canRun(db,r.line_account_id,'booking','calendar busy cache and switch jobs')"]}},
  PERSONAL_DATA_RETENTION_JOB,
  {name:'line webhook recovery',classification:{kind:'core',reason:'保存済みのLINE受信から未完の工程だけを再開する'},enforcement:{mode:'exempt',reason:'基本受信の回収は単一機能に属さない。停止した契約・アカウントを除外し、採点・マイル・自動化・配送は既存の個別停止判定に従う。返信鍵なしと送達不明は要確認に止める'}},
  {name:'durable tracked click continuation',classification:{kind:'feature',featureId:'inflow_tracking'},enforcement:{mode:'gated',sources:['apps/worker/src/services/tracked-click-steps.ts'],markers:["featureId:'inflow_tracking'","job:'durable tracked click continuation'"]}},
  {name:'durable banner generation',classification:{kind:'core',reason:'統括のバナー生成の継続'},enforcement:{mode:'exempt',reason:'店舗別機能スイッチの対象外。生成の直前に統括の契約・枚数上限・停止依頼を判定する'}},
  { name: 'form document retention', classification: { kind: 'core', reason: '本人確認書類の保存期限と未送信添付の後始末' }, enforcement: { mode: 'exempt', reason: '送信・公開をせず、フォーム機能の停止中も保存期限を守る' } },
  {name:'API draft and integration retention',classification:{kind:'core',reason:'保存期限を過ぎた下書きと連携の一時情報の消去'},enforcement:{mode:'exempt',reason:'外部送信をせず、機能の有効・無効にかかわらず保存期限を守る'}},
  {name:'restaurant followup jobs',classification:{kind:'feature',featureId:'restaurant_test'},enforcement:{mode:'gated',sources:['apps/worker/src/features/scenarios/scenario-source-jobs.ts'],markers:["featureId: 'restaurant_test'",'featureJobCanRun(db,']}},
  {name:'restaurant events',classification:{kind:'core',reason:'保存済みの飲食のできごとの再配送'},enforcement:{mode:'exempt',reason:'店舗の検証スイッチを確認し、スタンプ・マイル・オートメーションの可否は受取先の停止判定に従う。外向きWebhookは配送しない'}},
  {name:'visit stamps',classification:{kind:'feature',featureId:'visit_stamps'},enforcement:{mode:'gated',sources:['apps/worker/src/services/visit-stamps.ts'],markers:["featureId:'visit_stamps'","job:'visit stamps'"]}},
  {name:'booking waitlist expiry and promotion',classification:{kind:'core',reason:'人・席の待ちの期限と先着順を保つ'},enforcement:{mode:'exempt',reason:'保存済みの待ちの後始末。LINE送信はsendAutomaticBookingLineで機能停止・外部更新停止を個別判定する'}},
  {
    name: 'booking sync notices',
    classification: { kind: 'feature', featureId: 'booking' },
    enforcement: {
      mode: 'gated',
      sources: [
        'apps/worker/src/features/booking/booking-sync-rules.ts',
        'apps/worker/src/features/booking/booking-automatic-line.ts',
      ],
      markers: [
        "featureId:'booking'",
        'featureJobCanRun(db,',
        "featureId:input.featureId,job:'予約の自動通知'",
      ],
    },
  },
  {
    name: 'follower import continuation',
    classification: { kind: 'core', reason: 'LINEアカウント登録後の既存友だちの取り込み継続' },
    enforcement: { mode: 'exempt', reason: '登録処理の後半で、個別機能の有効・無効には属さない' },
  },
  {
    name: 'restaurant hold expiry',
    classification: { kind: 'core', reason: '保存済み予約の仮押さえ期限と予約済み価格変更の後始末' },
    enforcement: { mode: 'exempt', reason: '飲食店の検証環境だけ。保存済みの期限と変更を確定し、自動通知はsendAutomaticBookingLineが機能・停止を個別判定する' },
  },
  {
    name: 'friend bulk runs',
    classification: { kind: 'core', reason: '複数機能の友だち一括操作' },
    enforcement: { mode: 'exempt', reason: '共通の一括操作で、単一機能に属さない' },
  },
  {
    name: 'scheduled chat sends',
    classification: { kind: 'core', reason: '1対1トークの送信予約' },
    enforcement: { mode: 'exempt', reason: '受信箱の基本動作で、機能カタログの個別スイッチに属さない' },
  },
  {
    name: 'manual link weekly check',
    classification: { kind: 'core', reason: '画面横断のマニュアル導線の健全性点検' },
    enforcement: { mode: 'exempt', reason: '機能別スイッチに属さない共通ヘルプ導線の週次確認で、off対象の機能がない' },
  },
  {
    name: 'mileage reward delivery retry',
    classification: { kind: 'feature', featureId: 'mileage' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/mileage/mileage-reward-delivery.ts'],
      markers: [
        "job: 'mileage reward delivery retry'",
        "job: 'mileage reward delivery'",
        "accountFeatureOffExclusionSql('mileage_redemptions.line_account_id', 'mileage')",
      ],
    },
  },
  {
    name: 'analytics cross',
    classification: { kind: 'feature', featureId: 'analytics' },
    enforcement: {
      mode: 'gated',
      sources: ['packages/db/src/analytics-cross.ts'],
      markers: [
        "isAccountFeatureEnabled(db, row.line_account_id, 'analytics')",
        // 取り出し(LIMIT前)と停滞回収の両方をSQLで止める。
        "accountFeatureOffExclusionSql('analytics_cross_runs.line_account_id', 'analytics')",
      ],
    },
  },
  {
    name: 'mileage projection',
    classification: { kind: 'feature', featureId: 'mileage' },
    enforcement: {
      mode: 'gated',
      sources: ['packages/db/src/mileage/queue.ts'],
      markers: [
        "isAccountFeatureEnabled(db, owner.line_account_id, 'mileage')",
        // 取り出し(LIMIT前)と停滞回収の両方をSQLで止める。
        'function mileageOwnerOffSql(',
        'AND NOT ${mileageOwnerOffSql(',
      ],
    },
  },
  {
    name: 'ad conversion outbox retry',
    classification: { kind: 'core', reason: '広告成果の送信再試行' },
    enforcement: {
      mode: 'exempt',
      reason: '送信可否はアカウント自身の広告設定だけで決まり、機能設定に属さない',
    },
  },
  {
    name: 'ad cost import',
    classification: { kind: 'core', reason: '広告費の日次取込' },
    enforcement: {
      mode: 'exempt',
      reason: '取込の可否はアカウント自身の広告設定(連携のis_active)だけで決まり、機能設定に属さない',
    },
  },
  {
    name: 'ec event retry',
    classification: { kind: 'core', reason: 'ECイベント通知の再試行' },
    enforcement: {
      mode: 'exempt',
      reason: '再試行の可否はアカウント自身のEC連携の取り込み停止だけで決まり、機能設定に属さない',
    },
  },
  {
    name: 'analytics url exposure projection',
    classification: { kind: 'feature', featureId: 'analytics' },
    enforcement: {
      mode: 'gated',
      sources: ['packages/db/src/analytics-url-exposures.ts'],
      markers: [
        "isAccountFeatureEnabled(db, item.line_account_id, 'analytics')",
        "accountFeatureOffExclusionSql('analytics_url_exposure_queue.line_account_id', 'analytics')",
      ],
    },
  },
  {
    name: 'analytics projection',
    classification: { kind: 'feature', featureId: 'analytics' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/analytics-projection.ts'],
      markers: ["job: 'analytics projection'"],
    },
  },
  {
    name: 'analytics scheduled reports',
    classification: { kind: 'feature', featureId: 'analytics' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/analytics-reports.ts'],
      markers: ["job: 'analytics scheduled reports'"],
    },
  },
  {
    name: 'account health',
    classification: { kind: 'core', reason: 'LINEアカウント稼働監視' },
    enforcement: { mode: 'exempt', reason: 'LINEアカウント自体の稼働監視で、機能設定に属さない' },
  },
  {
    name: 'broadcast insights',
    classification: { kind: 'feature', featureId: 'broadcasts' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/insight-fetcher.ts'],
      markers: ["job: 'broadcast insights'"],
    },
  },
  {
    name: 'NEN rich menu jobs',
    classification: { kind: 'feature', featureId: 'rich_menus' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/nen-rich-menu.ts'],
      markers: ["job: 'NEN rich menu jobs'"],
    },
  },
  {
    // 公開中のリッチメニューを1日1回だけ見て、ずれを台帳に残す。
    name: 'rich menu daily reconcile',
    classification: { kind: 'feature', featureId: 'rich_menus' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/rich-menus/rich-menu-daily-reconcile.ts'],
      markers: ["job: 'rich menu daily reconcile'"],
    },
  },
  {
    name: 'support email sync',
    classification: { kind: 'core', reason: '運用問い合わせ受信' },
    enforcement: { mode: 'exempt', reason: '運用の問い合わせ受信で、アカウント機能に属さない' },
  },
  {
    name: 'platform announcements',
    classification: { kind: 'core', reason: '運営からのお知らせ配信（★V6 37-7）' },
    enforcement: { mode: 'exempt', reason: '運営が契約先の権限者へ送るお知らせで、アカウント機能に属さない' },
  },
  {
    name: 'billing invoice sync',
    classification: { kind: 'core', reason: '運営ダッシュボードのStripe入金実績' },
    enforcement: { mode: 'exempt', reason: '契約先の課金台帳同期で、アカウント機能に属さない' },
  },
  {
    name: 'friend field reminders',
    classification: { kind: 'feature', featureId: 'friend_fields' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/friends/friend-field-reminders.ts'],
      markers: ["job: 'friend field reminders'"],
    },
  },
  {
    name: 'action score inactivity',
    classification: { kind: 'feature', featureId: 'mileage' },
    enforcement: {
      mode: 'gated',
      sources: [
        'packages/db/src/action-score-rules.ts',
        'apps/worker/src/services/action-score-handlers.ts',
      ],
      markers: [
        "isAccountFeatureEnabled(db, row.line_account_id, 'mileage')",
        "job: 'action score applications'",
      ],
    },
  },
  {
    name: 'NEN tag refresh',
    classification: { kind: 'feature', featureId: 'photo_review' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/nen-tag-sync.ts'],
      markers: ["'photo_review', 'NEN tag refresh'"],
    },
  },
  {
    name: 'analytics retention purge',
    classification: { kind: 'feature', featureId: 'analytics' },
    enforcement: {
      mode: 'gated',
      sources: ['packages/db/src/analytics-projection.ts'],
      markers: ['const offAnalytics = (table: string): string =>', 'accountFeatureOffExclusionSql('],
    },
  },
  {
    name: 'automation retention purge',
    classification: { kind: 'feature', featureId: 'automations' },
    enforcement: {
      mode: 'gated',
      sources: ['packages/db/src/automation-retention.ts'],
      markers: ['accountFeatureOffExclusionSql(', "`${alias}.line_account_id`, 'automations'"],
    },
  },
  {
    name: 'friend snapshot',
    classification: { kind: 'core', reason: '友だち基礎集計' },
    enforcement: { mode: 'exempt', reason: '友だちの基礎集計で、外部呼び出しも機能の状態更新もしない' },
  },
  {
    name: 'scheduled exports',
    classification: { kind: 'core', reason: '友だちCSVの定期書き出し' },
    enforcement: { mode: 'exempt', reason: '既存の書き出し台帳へ行を足すだけで、外部呼び出しも機能の状態更新もしない' },
  },
  {
    name: 'google sheets sync',
    classification: { kind: 'feature', featureId: 'external_integrations' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/google-sheets.ts'],
      markers: ["'external_integrations', 'google sheets sync'"],
    },
  },
  {
    name: 'tiktok pnl sync',
    classification: { kind: 'feature', featureId: 'external_integrations' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/tiktok-pnl.ts'],
      markers: ["'external_integrations', 'tiktok pnl sync'"],
    },
  },
  {
    name: 'media usage scan',
    classification: { kind: 'feature', featureId: 'media' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/media/media-usage-scan.ts'],
      markers: ["'media', 'media usage scan'"],
    },
  },
  {
    name: 'file scan retry',
    classification: { kind: 'core', reason: '危険なファイルの検査の再試行（メディア・写真・添付を横断）' },
    enforcement: { mode: 'exempt', reason: '安全の後始末で、止めると検査待ちが詰まる。単一機能に属さない' },
  },
  {
    name: 'following mileage',
    classification: { kind: 'feature', featureId: 'mileage' },
    enforcement: {
      mode: 'gated',
      sources: ['packages/db/src/mileage/queue.ts'],
      markers: ["accountFeatureOffExclusionSql('f.line_account_id', 'mileage')"],
    },
  },
  {
    name: 'booking expirer',
    classification: { kind: 'feature', featureId: 'booking' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/booking/booking-expirer.ts'],
      markers: ["job: 'booking expirer'"],
    },
  },
  {
    name: 'event booking expirer',
    classification: { kind: 'feature', featureId: 'events' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/event-booking-expirer.ts'],
      markers: ["job: 'event booking expirer'"],
    },
  },
  TENANT_DATA_RETENTION_JOB,
  {
    name: 'restaurant raw mail retention',
    classification: { kind: 'feature', featureId: 'restaurant_test' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/restaurant-email-intake.ts'],
      markers: ["accountFeatureOffExclusionSql('st.line_account_id', 'restaurant_test')"],
    },
  },
  {
    name: 'google business resync',
    classification: { kind: 'feature', featureId: 'restaurant_test' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/google-business-resync.ts'],
      markers: ["'restaurant_test', 'google business resync'"],
    },
  },
  {
    name: 'google business metrics',
    classification: { kind: 'feature', featureId: 'restaurant_test' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/google-business-resync.ts'],
      markers: ["'restaurant_test', 'google business metrics'"],
    },
  },
  {
    name: 'google business token keepalive',
    classification: { kind: 'core', reason: 'Google認可（リフレッシュトークン）の失効防止' },
    enforcement: {
      mode: 'exempt',
      reason: '機能offの間もトークンを生かし続けるのが目的で、offで止めると放置失効して再接続が必要になる',
    },
  },
  GOOGLE_CONTENT_RETENTION_JOB,
  {
    name: 'automation deliveries',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'automations' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/automations/automation-engine.ts'],
      markers: ["job: 'automation runs'"],
    },
  },
  {
    name: 'booking reminders',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'booking' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/booking/booking-reminders.ts'],
      markers: ["job: 'booking reminders'"],
    },
  },
  {
    name: 'event reminders',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'events' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/event-booking-reminders.ts'],
      markers: ["job: 'event reminders'"],
    },
  },
  {
    name: 'meet consultation reminders',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'booking' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/meet-consultation-reminders.ts'],
      markers: ["job: 'meet consultation reminders'"],
    },
  },
  {
    name: 'webinar reminders',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'webinars' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/webinars/webinar-reminders.ts'],
      markers: ["job: 'webinar-reminders'"],
    },
  },
  {
    name: 'webinar notifications',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'webinars' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/webinars/webinar-notifications.ts'],
      markers: ["job: 'webinar-notifications'"],
    },
  },
  {
    name: 'webinar followups',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'webinars' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/webinars/webinar-followups.ts'],
      markers: ["job: 'webinar followups'"],
    },
  },
  {
    name: 'NEN campaign deliveries',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'nen_campaigns' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/nen-engagement.ts'],
      markers: [
        "job: 'NEN campaign deliveries'",
        "accountFeatureOffExclusionSql('nen_delivery_jobs.line_account_id', 'nen_campaigns')",
      ],
    },
  },
  {
    name: 'common variable schedules',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'common_vars' },
    enforcement: {
      mode: 'gated',
      sources: ['packages/db/src/common-vars/schedules.ts'],
      markers: ['isCommonVarsEnabled(db, current.line_account_id)'],
    },
  },
  {
    name: 'common var expiry notices',
    classification: { kind: 'feature', featureId: 'common_vars' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/common-var-expiry-sweep.ts'],
      markers: ['isCommonVarsEnabled(db, candidate.line_account_id)'],
    },
  },
  {
    name: 'scenario deliveries',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'scenarios' },
    enforcement: {
      mode: 'gated',
      sources: [
        'apps/worker/src/services/step-delivery.ts',
        'packages/db/src/scenario-delivery-timestamps.ts',
        'packages/db/src/scenarios/enrollment-dispatch.ts',
      ],
      markers: [
        "job: 'scenario deliveries'",
        // 取り出し(LIMIT前)と停滞回収の両方をSQLで止める。
        "accountFeatureOffExclusionSql('s.line_account_id', 'scenarios')",
      ],
    },
  },
  {
    name: 'broadcast deliveries',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'broadcasts' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/broadcasts/broadcast.ts'],
      markers: ["job: 'broadcast deliveries'"],
    },
  },
  {
    name: 'reminder deliveries',
    dispatchLane: 'delivery',
    classification: { kind: 'feature', featureId: 'reminders' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/services/reminder-delivery.ts'],
      markers: ["job: 'reminder deliveries'"],
    },
  },
  {
    name: 'booking calendar delete retry',
    classification: { kind: 'feature', featureId: 'booking' },
    enforcement: {
      mode: 'gated',
      sources: ['apps/worker/src/features/booking/booking-calendar-sync.ts'],
      markers: [
        "'booking', 'booking calendar delete retry'",
        // 候補読取(LIMIT前)でオフのアカウントを外す。
        "accountFeatureOffExclusionSql('booking_operation_runs.line_account_id', 'booking')",
      ],
    },
  },
];

/** 運用監視とscheduled実行が共有するdelivery dispatcherの正本。 */
export const DELIVERY_DISPATCH_JOB_NAMES = FEATURE_JOB_MANIFEST
  .filter(({ dispatchLane }) => dispatchLane === 'delivery')
  .map(({ name }) => name);

async function accountCompanyFeatureSettings(
  db: D1Database,
  accountId: string,
  featureIds: readonly FeatureId[],
): Promise<Partial<Record<FeatureId, boolean>>> {
  const bundle = await getVersionedAccountSetting<FeatureSettingsBundle>(
    db,
    accountId,
    FEATURE_SETTINGS_BUNDLE_KEY,
  );
  // 一括設定に無い分だけ旧 `feature.<キー>` を読む。機能ごとの往復にせず
  // 1往復でまとめて取る。
  const missing = featureIds.filter(
    (featureId) => typeof bundle?.data.features?.[featureId] !== 'boolean',
  );
  const legacyValues = missing.length > 0
    ? await getAccountSettings(db, accountId, missing.map((featureId) => `feature.${featureId}`))
    : {};
  const entries = featureIds.map((featureId) => {
    const bundled = bundle?.data.features?.[featureId];
    if (typeof bundled === 'boolean') return [featureId, bundled] as const;

    const legacy = legacyValues[`feature.${featureId}`];
    if (legacy) {
      try {
        const parsed = JSON.parse(legacy) as boolean | { enabled?: boolean };
        if (typeof parsed === 'boolean') return [featureId, parsed] as const;
        if (typeof parsed.enabled === 'boolean') return [featureId, parsed.enabled] as const;
      } catch {
        // 壊れた旧値はカタログの既定値へ戻す。設定画面の読取と同じ扱い。
      }
    }
    return [featureId, featureCatalogEntry(featureId).defaultEnabled] as const;
  });
  return Object.fromEntries(entries) as Partial<Record<FeatureId, boolean>>;
}

export type FeatureUnavailableReason =
  | 'contract_unavailable'
  | 'company_disabled'
  | 'dependency_disabled';

export type FeatureAvailability = {
  featureId: FeatureId;
  contractAvailable: boolean;
  companyEnabled: boolean;
  dependenciesEnabled: boolean;
  effectiveEnabled: boolean;
  reason: FeatureUnavailableReason | null;
  message: string | null;
  disabledDependencies: FeatureId[];
};

export type FeatureAvailabilityRequestContext = {
  tenantIdsByAccount: ReadonlyMap<string, string | null>;
  entitlementsByTenant: Map<string, Promise<ReturnType<typeof resolveEntitlements>>>;
};

/** 同じHTTP request内で、account所属とtenant料金を使い回す。request外へ持ち出さない。 */
export function createFeatureAvailabilityRequestContext(
  accounts: readonly { id: string; tenant_id: string | null }[] = [],
): FeatureAvailabilityRequestContext {
  return {
    tenantIdsByAccount: new Map(accounts.map((account) => [account.id, account.tenant_id])),
    entitlementsByTenant: new Map(),
  };
}

async function tenantEntitlements(
  db: D1Database,
  tenantId: string,
  context?: FeatureAvailabilityRequestContext,
): Promise<ReturnType<typeof resolveEntitlements>> {
  const load = async () => resolveTenantEntitlements(db, await getTenantBilling(db, tenantId));
  if (!context) return load();
  const cached = context.entitlementsByTenant.get(tenantId);
  if (cached) return cached;
  const pending = load();
  context.entitlementsByTenant.set(tenantId, pending);
  return pending;
}

async function contractAvailability(
  db: D1Database,
  accountId: string,
  featureIds: readonly FeatureId[] = FEATURE_CATALOG.map(({ featureId }) => featureId),
  context?: FeatureAvailabilityRequestContext,
): Promise<Record<FeatureId, boolean>> {
  const allIncluded = featureIds.every(
    (featureId) => featureCatalogEntry(featureId).entitlementKey === 'included',
  );
  if (allIncluded || typeof db.prepare !== 'function') {
    return Object.fromEntries(
      FEATURE_CATALOG.map(({ featureId }) => [featureId, true]),
    ) as Record<FeatureId, boolean>;
  }
  // 古い試験・移行行のようにアカウント所有者を解決できない場合は、従来どおり
  // 契約で止めない。実アカウントは tenant_id から必ず料金状態を読む。
  if (context?.tenantIdsByAccount.has(accountId)) {
    const tenantId = context.tenantIdsByAccount.get(accountId) ?? null;
    const entitlements = tenantId
      ? await tenantEntitlements(db, tenantId, context)
      : resolveEntitlements(null);
    return Object.fromEntries(FEATURE_CATALOG.map((entry) => [
      entry.featureId,
      featureContractIsAvailable(entitlements, entry.entitlementKey),
    ])) as Record<FeatureId, boolean>;
  }
  // tenant_id 読取 + tenants 読取の2往復を1往復の結合読取へ。
  const entitlements = await resolveTenantEntitlements(db, await getTenantBillingByLineAccount(db, accountId));
  return Object.fromEntries(FEATURE_CATALOG.map((entry) => [
    entry.featureId,
    featureContractIsAvailable(entitlements, entry.entitlementKey),
  ])) as Record<FeatureId, boolean>;
}

function resolveFeatureAvailability(
  featureId: FeatureId,
  companySettings: Partial<Record<FeatureId, boolean>>,
  contracts: Record<FeatureId, boolean>,
  resolved: Map<FeatureId, FeatureAvailability>,
): FeatureAvailability {
  const cached = resolved.get(featureId);
  if (cached) return cached;
  const entry = featureCatalogEntry(featureId);
  const dependencies = entry.dependencies as readonly FeatureId[];
  const disabledDependencies = dependencies.filter(
    (dependency) => !resolveFeatureAvailability(
      dependency,
      companySettings,
      contracts,
      resolved,
    ).effectiveEnabled,
  );
  const contractAvailable = contracts[featureId];
  const companyEnabled = companySettings[featureId] ?? entry.defaultEnabled;
  const dependenciesEnabled = disabledDependencies.length === 0;
  const reason: FeatureUnavailableReason | null = !contractAvailable
    ? 'contract_unavailable'
    : !companyEnabled
      ? 'company_disabled'
      : !dependenciesEnabled
        ? 'dependency_disabled'
        : null;
  const message = reason === 'contract_unavailable'
    ? 'ご契約ではこの機能を利用できません'
    : reason === 'company_disabled'
      ? 'この機能は設定でオフになっています'
      : reason === 'dependency_disabled'
        ? '必要な機能がオフになっているため利用できません'
        : null;
  const state: FeatureAvailability = {
    featureId,
    contractAvailable,
    companyEnabled,
    dependenciesEnabled,
    effectiveEnabled: reason === null,
    reason,
    message,
    disabledDependencies,
  };
  resolved.set(featureId, state);
  return state;
}

export async function accountFeatureAvailabilityMap(
  db: D1Database,
  accountId: string,
  knownCompanySettings?: Partial<Record<FeatureId, boolean>>,
  context?: FeatureAvailabilityRequestContext,
): Promise<Record<FeatureId, FeatureAvailability>> {
  const missingFeatureIds = FEATURE_CATALOG
    .map(({ featureId }) => featureId)
    .filter((featureId) => typeof knownCompanySettings?.[featureId] !== 'boolean');
  const [loadedCompanySettings, contracts] = await Promise.all([
    missingFeatureIds.length > 0
      ? accountCompanyFeatureSettings(db, accountId, missingFeatureIds)
      : Promise.resolve({}),
    contractAvailability(db, accountId, undefined, context),
  ]);
  const companySettings = {
    ...loadedCompanySettings,
    ...knownCompanySettings,
  } as Record<FeatureId, boolean>;
  const resolved = new Map<FeatureId, FeatureAvailability>();
  return Object.fromEntries(
    FEATURE_CATALOG.map(({ featureId }) => [
      featureId,
      resolveFeatureAvailability(featureId, companySettings, contracts, resolved),
    ]),
  ) as Record<FeatureId, FeatureAvailability>;
}

export async function accountFeatureAvailability(
  db: D1Database,
  accountId: string,
  featureId: FeatureId,
  context?: FeatureAvailabilityRequestContext,
): Promise<FeatureAvailability> {
  const requiredFeatureIds = new Set<FeatureId>();
  const collect = (current: FeatureId): void => {
    if (requiredFeatureIds.has(current)) return;
    requiredFeatureIds.add(current);
    for (const dependency of featureCatalogEntry(current).dependencies as readonly FeatureId[]) {
      collect(dependency);
    }
  };
  collect(featureId);
  const [companySettings, contracts] = await Promise.all([
    accountCompanyFeatureSettings(db, accountId, [...requiredFeatureIds]),
    contractAvailability(db, accountId, [...requiredFeatureIds], context),
  ]);
  return resolveFeatureAvailability(featureId, companySettings, contracts, new Map());
}

export async function accountFeatureIsEnabled(
  db: D1Database,
  accountId: string,
  featureId: FeatureId,
): Promise<boolean> {
  return (await accountFeatureAvailability(db, accountId, featureId)).effectiveEnabled;
}


export async function featureJobCanRun(
  db: D1Database,
  input: { accountId: string; featureId: FeatureId; job: string; occurredAt?: string },
): Promise<boolean> {
  if (await accountFeatureIsEnabled(db, input.accountId, input.featureId)) return true;
  await recordFeatureExecutionSkipped(db, input);
  return false;
}

/**
 * 1 tick内で使い回す判定器。友だち単位など件数が多い処理で、
 * 同じアカウントの判定を繰り返さない。tickをまたいで持たないこと。
 */
export function createFeatureJobGate() {
  const cache = new Map<string, boolean>();
  return {
    async canRun(
      db: D1Database,
      accountId: string | null,
      featureId: FeatureId,
      job: string,
    ): Promise<boolean> {
      // 持ち主不明の旧行は従来どおり進める。止めるのは持ち主が分かる行だけ。
      if (!accountId) return true;
      const key = `${featureId}:${accountId}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const ok = await featureJobCanRun(db, { accountId, featureId, job });
      cache.set(key, ok);
      return ok;
    },
  };
}
