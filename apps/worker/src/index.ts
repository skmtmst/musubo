import { bookingStripeWebhook } from './routes/booking-stripe-webhook.js';
import { escapeHtml as escapeHtmlAttribute } from './lib/html-escape.js';
import { failureMessage } from './lib/failure-messages.js';
import { logger, resumeInvocation, withInvocation } from '@line-crm/shared/server';
import { setHolidayCoverageWarningHandler } from '@line-crm/shared';
import { stagingQa } from './routes/staging-qa.js';
import { qaEnabled, qaOutboundStopped, qaSafeBindings, withQaOutboundBoundary } from './services/staging-qa-safety.js';
import { scheduled } from './cron/scheduled.js';
import { apiContractMiddleware } from './middleware/api-contract.js';

import { accountAiFeatures } from './routes/account-ai-features.js';
import { broadcastSimulation } from './routes/broadcast-simulation.js';
import { bookingPassNotices } from './routes/booking-pass-notices.js';
import { bookingMonthly } from './routes/booking-monthly.js';
import { bookingPassBilling } from './routes/booking-pass-billing.js';
import { deliveryPurposePreview } from './routes/delivery-purpose-preview.js';
import { mcpRpc } from './routes/mcp-rpc.js';
import { customerSegments } from './routes/customer-segments.js';
import { memberRanks } from './routes/member-ranks.js';
import { storeComparison } from './routes/store-comparison.js';
import { ecAutoLine } from './routes/ec-auto-line.js';
import { bookingPassPlans } from './routes/booking-pass-plans.js';
import { bookingGap3 } from './routes/booking-gap3.js';
import { aiAnswerLogs } from './routes/ai-answer-logs.js';
import { mcpConnections } from './routes/mcp-connections.js';

import { operatorPush } from './routes/operator-push.js';
import { aiDrafts } from './routes/ai-drafts.js';
import { broadcastAb } from './routes/broadcast-ab.js';

import { bookingMakeup } from './routes/booking-makeup.js';

import { formRouting } from './routes/form-routing.js';
import { bookingSeries } from './routes/booking-series.js';
import { bookingCalendarSettings } from './routes/booking-calendar-settings.js';
import { bookingCancellation } from './routes/booking-cancellation.js';
import { inboxSla } from './routes/inbox-sla.js';
import { lineSenders } from './routes/line-senders.js';
import { sensitiveOperationMiddleware } from './middleware/sensitive-step-up.js';
import type { Env } from './worker-env.js';

export type { Env } from './worker-env.js';import { liffNotificationPreferences } from './routes/liff-notification-preferences.js';
import { styles } from './routes/styles.js';
import { buildOgForLiffPath } from './liff-open-graph.js';

import { formDocuments } from './routes/form-documents.js';

import { autoReplyUnmatched } from './routes/auto-reply-unmatched.js';
import { instagram } from './routes/instagram.js';

import { restaurantCustomerBooking } from './routes/restaurant-customer-booking.js';

import { chatMessages } from './routes/chat-messages.js';
import { scenarioDrafts } from './routes/scenario-drafts.js';
import { broadcastMediaDirect } from './routes/broadcast-media-direct.js';
import { hqBroadcasts } from './routes/hq-broadcasts.js';
import { visitStamps } from './routes/visit-stamps.js';

import { Hono, type Context } from 'hono';
import { noindexHeaderMiddleware, robotsTxtHandler } from './lib/robots.js';
import { cors } from 'hono/cors';

import { getTrafficPoolBySlug, getTrafficPoolById, getRandomPoolAccount, getPoolAccounts, getEntryRouteByRefCode, getEntryRouteByRefCodeAny, getLineAccountById, getAffiliateLinkByRefCode, incrementAffiliateLinkClick, getStaffById } from '@line-crm/db';

import { authMiddleware } from './middleware/auth.js';
import { tenantScopeMiddleware } from './middleware/tenant-scope.js';
import { tenantPublicBoundaryMiddleware } from './middleware/tenant-public-boundary.js';
import { rateLimitMiddleware, authenticatedRateLimitMiddleware } from './middleware/rate-limit.js';

import { htmlSecurityMiddleware } from './middleware/html-security.js';
import { businessAuditMiddleware } from './middleware/business-audit.js';
import { featureEnforcementMiddleware } from './middleware/feature-enforcement.js';
import { webhook } from './routes/webhook.js';
import { friends } from './routes/friends.js';
import { friendBulkRuns } from './routes/friend-bulk-runs.js';
import { friendMigrations } from './routes/friend-migrations.js';
import { tags } from './routes/tags.js';
import { scenarios } from './routes/scenarios.js';
import { broadcasts } from './routes/broadcasts.js';
import { broadcastApprovals } from './routes/broadcast-approvals.js';
import { customerDownloads } from './routes/customer-downloads.js';
import { chatAttachments } from './routes/chat-attachments.js';
import { broadcastMessageAssets } from './routes/broadcast-message-assets.js';
import { users } from './routes/users.js';
import { lineAccountFolders } from './routes/line-account-folders.js';
import { lineAccountTags } from './routes/line-account-tags.js';
import { lineAccounts } from './routes/line-accounts.js';
import { gettingStarted } from './routes/getting-started.js';
import { recipes } from './routes/recipes.js';
import { hqTemplates } from './routes/hq-templates.js';
import { hqFormTests } from './routes/hq-form-tests.js';
import { manualLinks } from './routes/manual-links.js';
import { errorMessages } from './routes/error-messages.js';
import { accountHandovers } from './routes/account-handovers.js';
import { brand } from './routes/brand.js';
import { conversions } from './routes/conversions.js';
import { affiliates } from './routes/affiliates.js';
import { affiliateOffers } from './routes/affiliate-offers.js';
import { duplicates } from './routes/duplicates.js';
import { usersGrouped } from './routes/users-grouped.js';
import { inbox } from './routes/inbox.js';
import { openapi } from './routes/openapi.js';
import { liffRoutes } from './routes/liff.js';
import { affiliateSelfRoutes } from './routes/affiliate-self.js';
import { affiliatePayouts } from './routes/affiliate-payouts.js';
import { webhooks } from './routes/webhooks.js';
import { publicApi } from './routes/public-api.js';
import { calendar } from './routes/calendar.js';
import { meetConsultations } from './routes/meet-consultations.js';
import { reminders } from './routes/reminders.js';
import { scoring } from './routes/scoring.js';
import { actionScoreRules } from './routes/action-score-rules.js';
import { templates } from './routes/templates.js';
import { chats } from './routes/chats.js';
import { conversations } from './routes/conversations.js';
import { notificationCenter } from './routes/notification-center.js';
import { notifications } from './routes/notifications.js';
import { lineNotifications } from './routes/line-notifications.js';
import { stripe } from './routes/stripe.js';
import { health } from './routes/health.js';
import { automations } from './routes/automations.js';
import { commonActions } from './routes/common-actions.js';
import { richMenus } from './routes/rich-menus.js';
import { trackedLinks } from './routes/tracked-links.js';
import { entryRoutes } from './routes/entry-routes.js';
import { forms } from './routes/forms.js';
import { postalCode } from './routes/postal-code.js';
import { adPlatforms } from './routes/ad-platforms.js';
import { adCosts } from './routes/ad-costs.js';
import { webMeasurement } from './routes/web-measurement.js';
import { staff } from './routes/staff.js';
import { access } from './routes/access.js';
import { capabilities } from './routes/capabilities.js';
import { images } from './routes/images.js';
import { accountSettings } from './routes/account-settings.js';
import { companySettings } from './routes/company-settings.js';
import { setup } from './routes/setup.js';
import { autoReplies } from './routes/auto-replies.js';
import { autoReplyRuns } from './routes/auto-reply-runs.js';
import { adminAuth } from './routes/admin-auth.js';
import { adminPasskeysSelf } from './routes/admin-passkeys-self.js';
import { adminPasskeysLogin } from './routes/admin-passkeys-login.js';
import { resolveCorsOrigin } from './middleware/admin-auth-config.js';
import { timingHandler, timingMiddleware, timingStart } from './lib/server-timing.js';
import booking from './routes/booking.js';
import { bookingEntitlements } from './routes/booking-entitlements.js';
import { bookingPayments } from './routes/booking-payments.js';
import { bookingPaymentAdmin } from './routes/booking-payment-admin.js';
import { bookingPlus } from './routes/booking-plus.js';
import events from './routes/events.js';
import { trafficPools } from './routes/traffic-pools.js';
import { meetCallback } from './routes/meet-callback.js';
import { messageTemplates } from './routes/message-templates.js';
import dedupPreview from './routes/dedup-preview.js';
import { profileRefresh } from './routes/profile-refresh.js';
import { richMenuGroups } from './routes/rich-menu-groups.js';
import { lineProxy } from './routes/line-proxy.js';
import { research } from './routes/research.js';
import { webinarRoutes } from './routes/webinars.js';
import { instagramEngagement } from './routes/instagram-engagement.js';
import adminVersion from './routes/admin-version.js';
import adminUpdate from './routes/admin-update.js';
import { privateImageResponseMiddleware } from './services/image-access.js';
import { ecIntegrations } from './routes/ec-integrations.js';
import { ecCommerce } from './routes/ec-commerce.js';
import { ecOperations } from './routes/ec-operations.js';
import { nenCampaigns } from './routes/nen-campaigns.js';
import { nenMembers } from './routes/nen-members.js';
import { nenRanks } from './routes/nen-ranks.js';
import { nenPets } from './routes/nen-pets.js';
import { nenPhotoOperations } from './routes/nen-photo-operations.js';
import { supportInbox } from './routes/support-inbox.js';
import { searchConsole } from './routes/search-console.js';
import { friendFields } from './routes/friend-fields.js';
import { friendAttributes } from './routes/friend-attributes.js';
import { featureSettings } from './routes/feature-settings.js';
import { friendAddRules } from './routes/friend-add-rules.js';
import { contents } from './routes/contents.js';
import { fileScan } from './routes/file-scan.js';
import { commonVarExports } from './routes/common-var-exports.js';
import { analytics } from './routes/analytics.js';
import { analyticsExports } from './routes/analytics-exports.js';
import { dashboard } from './routes/dashboard.js';
import { siteTracking } from './routes/site-tracking.js';

import { restaurantTest } from './routes/restaurant-test.js';
import { restaurantExternalLinks } from './routes/restaurant-external-links.js';
import { restaurantGoogle } from './routes/restaurant-google.js';
import { googleSheets } from './routes/google-sheets.js';
import { tiktokPnl } from './routes/tiktok-pnl.js';
import { restaurantGoogleProfile } from './routes/restaurant-google-profile.js';
import { restaurantGooglePosts } from './routes/restaurant-google-posts.js';
import { restaurantGooglePerformance } from './routes/restaurant-google-performance.js';
import { restaurantDelivery } from './routes/restaurant-delivery.js';
import { tenants } from './routes/tenants.js';
import { ops } from './routes/ops.js';
import { opsApplications } from './routes/ops-applications.js';
import { opsPricingConditions } from './routes/ops-pricing-conditions.js';
import { hqMusuboQuotes } from './routes/hq-musubo-quotes.js';
import { hqMusuboPricing } from './routes/hq-musubo-pricing.js';
import { hqMusuboLineAddition } from './routes/hq-musubo-line-addition.js';
import { hqMusuboFinalLineEnd } from './routes/hq-musubo-final-line-end.js';
import { hqMusuboLineRemoval } from './routes/hq-musubo-line-removal.js';
import { hqMusuboLineResumption } from './routes/hq-musubo-line-resumption.js';
import { opsIndividualQuotes } from './routes/ops-individual-quotes.js';
import { piiMaskMiddleware } from './middleware/impersonation.js';
import { outputAuditMiddleware } from './middleware/output-audit.js';
import { hqBanners } from './routes/hq-banners.js';
import { hqSupport } from './routes/hq-support.js';
import { hqBilling } from './routes/hq-billing.js';
import { authEmail } from './routes/auth-email.js';
import { opsInvite } from './routes/ops-invite.js';
import { opsSupport } from './routes/ops-support.js';
import { opsDashboard } from './routes/ops-dashboard.js';
import { opsBilling } from './routes/ops-billing.js';
import { opsAnnouncements } from './routes/ops-announcements.js';
import { hqNotices } from './routes/hq-notices.js';
import { codexSlackEvents } from './routes/codex-slack-events.js';
import { aiLoopSlackReports } from './routes/ai-loop-slack-reports.js';
import { clientErrors } from './routes/client-errors.js';
import { lineWebhookEvents } from './routes/line-webhook-events.js';
import { operations } from './routes/operations.js';
import { securityAlerts } from './routes/security-alerts.js';

import { unhandledWorkerError } from './lib/unhandled-error.js';
import { routeInboundEmail } from './services/inbound-email-router.js';

import { classifyCodexMonitorError, markCodexMentionFailed, processCodexMentionMessage, shouldStopCodexQueueRetry } from './services/codex-cloud-monitor.js';
import { type CodexMentionQueueMessage } from './services/codex-cloud-types.js';
import { createQrImage, isQrDataAllowed, normalizeQrFormat, normalizeQrSize, qrResponseHeaders, QrInputError, QR_MAX_RESPONSE_BYTES } from './lib/qr-response.js';
import { storedRedirectTarget } from './lib/safe-redirect.js';
import { isLinkPreviewBot } from './lib/og-bot.js';

export const app = new Hono<Env>();

/**
 * 管理画面から送られてくるヘッダ。
 *
 * ここに無いヘッダを1つでも付けると、ブラウザは**preflight の段階で**
 * 止める。サーバーには何も届かないので worker のログにも残らず、
 * 画面には「保存できませんでした」とだけ出る。
 *
 * 実際に起きた: 一斉配信の作成が `Idempotency-Key` を送るのに、ここに
 * 無かった。下書き保存・テスト送信・配信予約はすべてこの1本の POST を
 * 通るので、**管理画面から一斉配信を1つも作れない**状態だった。
 *
 * 追加するときは `cors-headers.test.ts` の一覧にも足す。
 */
export const ADMIN_REQUEST_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-CSRF-Token',
  'X-Line-Account-Id',
  'x-admin-api-key',
  'X-Filename',
  'Idempotency-Key',
  'X-Confirm-Irreversible',
  'X-Line-Harness-Source',
  'X-Impersonation-Reason',
  'x-step-up-token',
] as const;

// Cookie 認証の CORS で任意の origin を許可しないよう、同一 origin と ADMIN_ORIGIN の許可先だけを反映する。ほかはヘッダを返さず、Origin のない SDK/MCP の Bearer 認証には影響させない。robots.txt と X-Robots-Tag で検索対象から外す。
setHolidayCoverageWarningHandler(() => logger.warn('src_japanese_holidays_warn'));
app.use('*', timingStart());
app.use('*', apiContractMiddleware);
app.use('*', noindexHeaderMiddleware);
// 認証や障害報告より先に、実行単位の外部送信境界を確立する。
app.use('*', async (c, next) => {
  if ((c.req.path === '/api/ops/staging-qa' || c.req.path.startsWith('/api/ops/staging-qa/')) && !qaEnabled(c.env)) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const env = c.env;
  c.env = qaSafeBindings(env);
  return withQaOutboundBoundary(env, next);
});
app.get('/robots.txt', robotsTxtHandler);

// 段とD1の待ちを、認証前の拒否・公開応答も含めて数値だけで返す。
app.use('*', timingMiddleware('cors', cors({
  origin: (origin, c) => resolveCorsOrigin(c.env, origin, c.req.url),
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: [...ADMIN_REQUEST_HEADERS],
  exposeHeaders: ['Content-Disposition', 'X-Exported-By', 'X-Exported-At', 'X-Csv-Total-Count', 'X-Csv-Returned-Count', 'X-Csv-Truncated', 'X-Request-ID', 'Server-Timing', 'Retry-After'],
  maxAge: 600,
})));

// 認証処理へ負荷を掛ける前に、不正な大量要求をレート制限で止める。
app.use('*', htmlSecurityMiddleware);
app.use('*', timingMiddleware('rate', rateLimitMiddleware));

// LIFF・公開経路は staff 認証を通らないため、フォーム・予約・会員の書込より前に統括の境界を適用する。
app.use('/api/liff/*', timingMiddleware('tenant', tenantPublicBoundaryMiddleware));
app.use('/api/events/liff/*', timingMiddleware('tenant', tenantPublicBoundaryMiddleware));

// /webhook と /docs はスタッフ認証の対象外とする。
app.use('*', authMiddleware);
app.use('*', timingMiddleware('rate', authenticatedRateLimitMiddleware));
app.use('/api/*', timingMiddleware('audit', outputAuditMiddleware));

// 別の統括を選択できないよう、管理 API の LINE アカウントをログイン中のスタッフの統括へ限定する。
app.use('*', timingMiddleware('tenant', tenantScopeMiddleware));
// Account-limited members cannot access tenant-wide management endpoints.
app.use('/api/hq/*', async (c, next) => {
  const actor = c.get('staff');
  if (actor.id === 'env-owner') return next();
  const member = await getStaffById(c.env.DB, actor.id);
  if (!member?.is_active || member.account_scope !== 'all') {
    return c.json({ success: false, error: '統括の権限が必要です' }, 403);
  }
  return next();
});
// 代理ログイン中の個人情報の伏せ字。認証の後ろ、各ルートの前。
app.use('/api/*', timingMiddleware('pii', piiMaskMiddleware));
app.use('/api/*', timingMiddleware('pii', privateImageResponseMiddleware));

// 認証済み管理APIの変更を共通監査へ残す。route固有の監査がある場合は重複させない。
app.use('/api/*', timingMiddleware('audit', businessAuditMiddleware));

// 機能設定は認証・tenant scope の後、各 route handler の前で強制する。
// manifest と実 route の全件照合を必須テストにした上で、未分類も fail closed にする。
app.use('/api/*', timingMiddleware('feature', featureEnforcementMiddleware));
app.use('/api/*', timingMiddleware('sensitive', sensitiveOperationMiddleware));

app.use('*', timingHandler());


app.route('/', webhook);
app.route('/', stagingQa);
app.route('/', gettingStarted);
app.route('/', recipes);
app.route('/', hqTemplates);
app.route('/', hqFormTests);
app.route('/', hqBroadcasts);
app.route('/', ops);
app.route('/', opsApplications);
app.route('/', opsPricingConditions);
app.route('/', hqMusuboQuotes);
app.route('/', hqMusuboPricing);
app.route('/', hqMusuboLineAddition);
app.route('/', hqMusuboFinalLineEnd);
app.route('/', hqMusuboLineRemoval);
app.route('/', hqMusuboLineResumption);
app.route('/', opsIndividualQuotes);
app.route('/', manualLinks);
app.route('/', errorMessages);
app.route('/', accountHandovers);
app.route('/', friendBulkRuns);
app.route('/', friendMigrations);
// NOTE:  — /api/friends/people 等の固定名は :id より先に載せる。
// duplicates（本人候補・統合ユーザー）は friends の GET /:id より先でないと
// people を友だちIDと読んで404になる。broadcastApprovals と同じ考え方。
app.route('/', duplicates);
app.route('/', friends);
app.route('/', tags);
app.route('/', scenarios);
app.route('/', scenarioDrafts);
// NOTE: 承認の口（approval-threshold 等の固定名）は :id より先に載せる。
// broadcasts の PUT /:id が先だと approval-threshold を id と読んで404になる。
app.route('/', broadcastApprovals);
app.route('/', broadcastAb);
app.route('/', broadcastSimulation);
app.route('/', broadcasts);
app.route('/', customerDownloads);
app.route('/', chatAttachments);
app.route('/', broadcastMessageAssets);
app.route('/', broadcastMediaDirect);
app.route('/', users);
app.route('/', lineAccountFolders);
app.route('/', lineAccountTags);
app.route('/', lineAccounts);
app.route('/', brand);
app.route('/', conversions);
app.route('/', affiliates);
app.route('/', affiliateOffers);
app.route('/', usersGrouped);
app.route('/', inbox);
app.route('/', openapi);
app.route('/', liffRoutes);
app.route('/', liffNotificationPreferences);
app.route('/', affiliateSelfRoutes);
app.route('/', affiliatePayouts);

app.use('*', timingHandler());


app.route('/', webhooks);
app.route('/', publicApi);
app.route('/', calendar);
app.route('/', meetConsultations);
app.route('/', reminders);
app.route('/', scoring);
app.route('/', actionScoreRules);
app.route('/', templates);
app.route('/', inboxSla);
app.route('/', lineSenders);
app.route('/', aiDrafts);
app.route('/', accountAiFeatures);
app.route('/', customerSegments);
app.route('/', memberRanks);
app.route('/', bookingMonthly);
app.route('/', bookingPassBilling);
app.route('/', storeComparison);
app.route('/', ecAutoLine);
app.route('/', bookingPassPlans);
app.route('/', bookingPassNotices);
app.route('/', aiAnswerLogs);
app.route('/', deliveryPurposePreview);
app.route('/', mcpConnections);
app.route('/', mcpRpc);
app.route('/', operatorPush);
app.route('/', chats);
app.route('/', chatMessages);
app.route('/', conversations);
app.route('/', notificationCenter);
// 通知ルールの画面が呼ぶ /api/notifications/rules を登録する。

app.route('/', notifications);
app.route('/', lineNotifications);
app.route('/', stripe);
app.route('/', health);
app.route('/', automations);
app.route('/', commonActions);
app.route('/', richMenus);
app.route('/', trackedLinks);
app.route('/', entryRoutes);
app.route('/', formDocuments);
app.route('/', formRouting);
app.route('/', forms);
app.route('/', postalCode);
app.route('/', adPlatforms);
app.route('/', adCosts);
// Web計測の公開口と計測サイトの管理。
app.route('/', webMeasurement);
app.route('/', staff);
app.route('/', access);
app.route('/', capabilities);
app.route('/', images);
app.route('/', setup);
app.route('/', autoReplyUnmatched);
app.route('/', autoReplies);
app.route('/', autoReplyRuns);
app.route('/', adminAuth);
app.route('/', adminPasskeysSelf);
app.route('/', adminPasskeysLogin);
app.route('/', trafficPools);
app.route('/', bookingSeries);
app.route('/', booking);
app.route('/', bookingCalendarSettings);
app.route('/', bookingGap3);
app.route('/', bookingCancellation);
app.route('/', bookingPayments);
app.route('/', bookingStripeWebhook);
app.route('/', bookingPaymentAdmin);
app.route('/', bookingEntitlements);
app.route('/', bookingPlus);
app.route('/', bookingMakeup);
app.route('/', events);
app.route('/', accountSettings);
app.route('/', companySettings);
app.route('/', meetCallback);
app.route('/', messageTemplates);
app.route('/', dedupPreview);
app.route('/', profileRefresh);
app.route('/', richMenuGroups);
app.route('/', webinarRoutes);
app.route('/', research);
app.route('/', instagramEngagement);
app.route('/', instagram);
// LINE Messaging API 互換プロキシ — 外部エージェントの直接送信を messages_log に残す
app.route('/', lineProxy);
// EC-CUBEの取引イベント。管理者認証ではなく署名・時刻・重複IDで検証する。
app.route('/', ecIntegrations);
// NEN EC連携の管理画面API（通常の管理者認証・CSRF保護対象）。
app.route('/', ecCommerce);
app.route('/', ecOperations);
app.route('/', nenCampaigns);
app.route('/', nenPhotoOperations);
app.route('/', nenMembers);
app.route('/', nenRanks);
app.route('/', nenPets);
app.route('/', supportInbox);
app.route('/', searchConsole);
app.route('/', friendFields);
app.route('/', friendAttributes);
app.route('/', featureSettings);
app.route('/', friendAddRules);
// /api/common-vars/exports は contents の /api/common-vars/:id より先に
// 登録しないと、静的な 'exports' が :id に取られて届かない。
app.route('/', commonVarExports);
app.route('/', contents);
app.route('/', fileScan);
app.route('/', analytics);
app.route('/', analyticsExports);
app.route('/', dashboard);
app.route('/', styles);
app.route('/', siteTracking);
// 飲食店向けの検証専用領域。既存NEN機能とはAPI/DB名前空間を分離する。
app.route('/', visitStamps);
app.route('/', restaurantExternalLinks);
app.route('/', restaurantTest);
app.route('/', restaurantCustomerBooking);
app.route('/', restaurantGoogle);
app.route('/', restaurantGoogleProfile);
app.route('/', restaurantGooglePosts);
app.route('/', restaurantGooglePerformance);
app.route('/', restaurantDelivery);
app.route('/', googleSheets);
app.route('/', tiktokPnl);
app.route('/', tenants);
app.route('/', hqBanners);
app.route('/', hqSupport);
app.route('/', hqBilling);
app.route('/', authEmail);
app.route('/', opsInvite);
app.route('/', opsSupport);
app.route('/', opsDashboard);
app.route('/', opsBilling);
app.route('/', opsAnnouncements);
app.route('/', hqNotices);
app.route('/', codexSlackEvents);
app.route('/', aiLoopSlackReports);
app.route('/', clientErrors);
app.route('/', lineWebhookEvents);
app.route('/', operations);
app.route('/', securityAlerts);

// ログイン前の更新案内でも使うため、配備済み bundle から導ける版情報は未認証で返す。更新操作の認証とは分ける。
app.route('/admin', adminVersion);
// HTTP 経由の自己更新は受け付けず、すべて404を返す。
app.route('/admin/update', adminUpdate);

// QR は Worker の中だけで作る。流入 ref や LIFF URL は計測の識別子で、
// 流入識別子や LIFF URL を第三者へ漏らさないため、QR は Worker 内で生成する。
// api.qrserver.com へ送っていたので、説明と実装が食い違っていた。
export const qrHandler: (c: Context<Env>) => Promise<Response> = async (c) => {
  const data = c.req.query('data');
  if (!data) return c.text('Missing data param', 400);
  if (!isQrDataAllowed(data)) return c.text('Data param too long', 400);
  const size = normalizeQrSize(c.req.query('size'));
  if (!size) return c.text('Invalid size', 400);
  // 印刷に使うので svg も出せる。知らない値は png に丸める。
  const format = normalizeQrFormat(c.req.query('format'));
  let image: Awaited<ReturnType<typeof createQrImage>>;
  try {
    image = await createQrImage(data, size, format);
  } catch (error) {
    // 指定を直せば通る失敗（小さすぎる・長すぎる）は理由を返す。
    if (error instanceof QrInputError) return c.text(error.message, 400);
    return c.text('QR generation failed', 500);
  }
  if (image.bytes.byteLength > QR_MAX_RESPONSE_BYTES) return c.text('QR response too large', 500);
  return new Response(image.bytes, {
    headers: qrResponseHeaders(
      image.contentType,
      c.req.query('download') === '1',
      c.req.query('filename') || 'referral-link-qr',
      format,
    ),
  });
};

app.get('/api/qr', qrHandler);

// 停止した流入経路の公開URLは、active・停止・不存在の区別や
// 転送先を漏らさない同一の終了応答で止める。ref の echo もしない。
const ENTRY_ROUTE_STOPPED_HTML =
  '<!doctype html><html lang="ja"><meta charset="utf-8"><title>このページは利用できません</title><body><main><h1>このページは利用できません</h1><p>公開が終わっているか、アドレスが正しくありません。運用者へ、新しいリンクをご確認ください。</p></main></body></html>';

// 短縮 URL は端末共通の LIFF リンクへ案内する。PC では QR を出し、起動できない場合だけ /help で外部ブラウザへの手順を案内する。form は友だち追加後の案内へ引き継ぐ。
app.get('/r/:ref', async (c) => {
  const ref = c.req.param('ref');
  const formId = c.req.query('form') || '';

  // 送信先は経路の pool_id、クエリの pool、main の順で選ぶ。
  let liffUrl = c.env.LIFF_URL;
  let pool: Awaited<ReturnType<typeof getTrafficPoolBySlug>> | null = null;

  // ID 取得は有効状態で絞らないため、停止中のプールを明示的に除く。流入記録は OAuth/LIFF 完了時に作るため、ここでは二重計上しない。ログイン前の離脱はこの集計に含まれない。
  const route = await getEntryRouteByRefCode(c.env.DB, ref);
  // 停止した経路は active と同じ受付をしない。転送先があっても
  // 送らず、紹介リンクやプールの後段にも落とさず、同一の終了応答で止める。
  // ref が entry_routes の名前空間に属さないときだけ従来の後段へ進む。
  if (!route) {
    const anyRoute = await getEntryRouteByRefCodeAny(c.env.DB, ref);
    if (anyRoute && anyRoute.is_active !== 1) {
      return c.html(ENTRY_ROUTE_STOPPED_HTML, 410);
    }
  }
  // クーポンの所属アカウントを固定する。main poolへ落とすと別の店へ着地する。
  const couponRoute = route?.coupon_enabled === 1 && Boolean(route.coupon_asset_id);
  if (couponRoute) {
    const account = route?.line_account_id ? await getLineAccountById(c.env.DB, route.line_account_id) : null;
    if (!account?.liff_id || !/^\d+-[A-Za-z0-9]+$/.test(account.liff_id)) return c.html('<!doctype html><html lang="ja"><meta charset="utf-8"><title>このリンクは現在利用できません</title><p>お店へお問い合わせください。</p></html>', 503);
    liffUrl = `https://liff.line.me/${account.liff_id}`;
  }
  // 転送先が設定された経路はそちらへ送る（ 重大4）。保存はするのに
  // 読まないままだった。危険な形式は safe-redirect が弾き、そのときは
  // 従来どおり友だち追加の着地画面へ進む。
  if (!couponRoute && route?.redirect_url) {
    const target = storedRedirectTarget(route.redirect_url);
    if (target) return c.redirect(target, 302);
  }
  if (!couponRoute && route?.pool_id) {
    const candidate = await getTrafficPoolById(c.env.DB, route.pool_id);
    if (candidate?.is_active) pool = candidate;
  }

  // 経路とアフィリエイトで ref が重なれば経路を優先する。アフィリエイトは所属アカウントの LIFF へ直接案内し、停止中なら移動もクリック計上もしない。ref はその後の友だち追加の帰属へ引き継ぐ。
  let affiliateResolved = false;
  if (!route) {
    const affiliateLink = await getAffiliateLinkByRefCode(c.env.DB, ref);
    if (affiliateLink && (
      affiliateLink.is_active !== 1 || affiliateLink.affiliate_is_active === 0
    )) {
      return c.html(
        '<!doctype html><html lang="ja"><meta charset="utf-8"><title>この紹介リンクは停止しています</title><body><main><h1>この紹介リンクは停止しています</h1><p>紹介元の運用者へ、新しいリンクをご確認ください。</p></main></body></html>',
        410,
      );
    }
    if (affiliateLink?.is_active === 1) {
      await incrementAffiliateLinkClick(c.env.DB, ref);
      affiliateResolved = true;
      if (affiliateLink.line_account_id) {
        const account = await getLineAccountById(c.env.DB, affiliateLink.line_account_id);
        if (account?.liff_id && /^\d+-[A-Za-z0-9]+$/.test(account.liff_id)) liffUrl = `https://liff.line.me/${account.liff_id}`;
      }
      // line_account_id === null → keep the default LIFF_URL (既定アカウント).
    }
  }

  // アフィリエイトの送信先を main プールで上書きしないよう、その場合は pool の代替解決を省く。
  if (!pool && !affiliateResolved && !couponRoute) {
    const poolSlug = c.req.query('pool') || 'main';
    pool = await getTrafficPoolBySlug(c.env.DB, poolSlug);
  }

  if (pool) {
    const account = await getRandomPoolAccount(c.env.DB, pool.id);
    if (account) {
      if (account.liff_id && /^\d+-[A-Za-z0-9]+$/.test(account.liff_id)) liffUrl = `https://liff.line.me/${account.liff_id}`;
    } else {
      const allAccounts = await getPoolAccounts(c.env.DB, pool.id);
      if (allAccounts.length === 0) {
        if (pool.liff_id && /^\d+-[A-Za-z0-9]+$/.test(pool.liff_id)) liffUrl = `https://liff.line.me/${pool.liff_id}`;
      }
    }
  }


  const liffIdMatch = liffUrl.match(/liff\.line\.me\/([0-9]+-[A-Za-z0-9]+)/);
  const liffParams = new URLSearchParams();
  if (liffIdMatch) liffParams.set('liffId', liffIdMatch[1]);
  if (ref) liffParams.set('ref', ref);
  if (couponRoute) liffParams.set('couponRef', ref);
  if (formId) liffParams.set('form', formId);
  const gate = c.req.query('gate');
  if (gate) liffParams.set('gate', gate);
  const xh = c.req.query('xh');
  if (xh) liffParams.set('xh', xh);
  const ig = c.req.query('ig');
  if (ig) liffParams.set('ig', ig);
  const iga = c.req.query('iga');
  if (iga) liffParams.set('iga', iga);
  const igan = c.req.query('igan');
  if (igan) liffParams.set('igan', igan);
  // OpenChat 内でも友だち追加と流入計測を保つため、page/id の転送は友だち追加判定を持つ salon-booking と event-booking に限る。判定を通らない book/form は許可しない。
  const PAGE_PASSTHROUGH_ALLOWED = new Set(['salon-book', 'event', 'event-me', 'webinar', 'research', 'visit-stamps']);
  const page = c.req.query('page');
  if (page && PAGE_PASSTHROUGH_ALLOWED.has(page)) liffParams.set('page', page);
  if (page === 'research' && c.req.query('researchId')) liffParams.set('researchId', c.req.query('researchId')!);
  const id = c.req.query('id');
  if (id) liffParams.set('id', id);
  const slug = c.req.query('slug');
  if (slug) liffParams.set('slug', slug);
  if (page === 'salon-book') {
    const menuId = c.req.query('menu_id');
    if (menuId && /^[A-Za-z0-9_-]{1,128}$/.test(menuId)) liffParams.set('menu_id', menuId);
    if (c.req.query('view') === 'history') liffParams.set('view', 'history');
  }
  if (page === 'visit-stamps') {
    const card = c.req.query('card');
    if (card && /^[A-Za-z0-9_-]{1,128}$/.test(card)) liffParams.set('card', card);
  }

  // モバイル経路でも広告の帰属を落とさないよう、auth/line が扱うクリック ID と UTM を LIFF のクエリへ引き継ぐ。
  for (const key of ['gclid', 'fbclid', 'twclid', 'ttclid', 'utm_source', 'utm_medium', 'utm_campaign']) {
    const value = c.req.query(key);
    if (value) liffParams.set(key, value);
  }
  const liffTarget = liffParams.toString() ? `${liffUrl}?${liffParams.toString()}` : liffUrl;

  // 再試行のたびにプールのアカウントを再抽選しないよう、解決済み LIFF URL を t で help へ渡す。
  const helpUrl = `/r/${encodeURIComponent(ref)}/help?t=${encodeURIComponent(liffTarget)}`;

  const ua = (c.req.header('user-agent') || '').toLowerCase();
  const isMobile = /iphone|ipad|android|mobile/.test(ua);
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);

  if (isMobile) {
    // アプリ内ブラウザで通常のリンクが開けない場合に備え、iOS はシステムの長押しメニュー、Android は intent を案内する。ブラウザごとの判別は行わない。

    // Android では intent で LINE を開き、未インストールや WebView の拒否時にも行き止まりにしないよう、HTTPS の代替 URL を設定する。
    const liffPath = liffTarget.replace(/^https:\/\//, '');
    const intentFallback = encodeURIComponent(liffTarget);
    const androidIntent = `intent://${liffPath}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=jp.naver.line.android;S.browser_fallback_url=${intentFallback};end`;
    const buttonHref = isAndroid ? androidIntent : liffTarget;
    // Android の長押しは選択肢が増えるため、長押し案内は iOS にだけ出し、Android は intent を使う。
    const longPressHint = isIOS
      ? '<p class="hint">※開かない場合はボタンを<strong>長押し</strong>して「LINEで開く」を選択</p>'
      : '';

    return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE で開く</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:360px;width:90%;padding:40px 28px 32px;border:1px solid rgba(0,0,0,0.04)}
.line-icon{width:48px;height:48px;margin:0 auto 20px}
.line-icon svg{width:48px;height:48px}
.msg{font-size:15px;color:#444;font-weight:500;margin-bottom:28px;line-height:1.6}
.btn{display:block;width:100%;padding:16px;border:none;border-radius:12px;font-size:16px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#06C755;box-shadow:0 2px 12px rgba(6,199,85,0.2);transition:all .15s}
.btn:active{transform:scale(0.98);opacity:.9}
.hint{font-size:11px;color:#888;margin-top:10px;line-height:1.6}
.hint strong{color:#06C755;font-weight:700}
.help{font-size:12px;color:#999;margin-top:18px;line-height:1.5}
.help a{color:#999;text-decoration:underline}
</style>
</head>
<body>
<div class="card">
<div class="line-icon">
<svg viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M24 12C17.37 12 12 16.58 12 22.2c0 3.54 2.35 6.65 5.86 8.47-.2.74-.76 2.75-.87 3.17-.14.55.2.54.42.39.18-.12 2.84-1.88 4-2.65.84.13 1.7.22 2.59.22 6.63 0 12-4.58 12-10.2S30.63 12 24 12z" fill="#fff"/></svg>
</div>
<p class="msg">友達追加して始める</p>
<a href="${escapeHtmlAttribute(buttonHref)}" class="btn">LINEで開く</a>
${longPressHint}
<p class="help">うまく開けない方は <a href="${helpUrl}">こちら</a></p>
</div>
</body>
</html>`);
  }

  // PC: show QR code page — QR encodes LIFF URL directly
  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE で開く</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:480px;width:90%;padding:48px;border:1px solid rgba(0,0,0,0.04)}
.line-icon{width:48px;height:48px;margin:0 auto 20px}
.line-icon svg{width:48px;height:48px}
.msg{font-size:15px;color:#444;font-weight:500;margin-bottom:32px;line-height:1.6}
.qr{background:#f9f9f9;border-radius:16px;padding:24px;display:inline-block;margin-bottom:24px;border:1px solid rgba(0,0,0,0.04)}
.qr img{display:block;width:240px;height:240px}
.hint{font-size:13px;color:#999;line-height:1.6}
.footer{font-size:11px;color:#bbb;margin-top:24px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<div class="line-icon">
<svg viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M24 12C17.37 12 12 16.58 12 22.2c0 3.54 2.35 6.65 5.86 8.47-.2.74-.76 2.75-.87 3.17-.14.55.2.54.42.39.18-.12 2.84-1.88 4-2.65.84.13 1.7.22 2.59.22 6.63 0 12-4.58 12-10.2S30.63 12 24 12z" fill="#fff"/></svg>
</div>
<p class="msg">スマートフォンで QR コードを読み取ってください</p>
<div class="qr">
<img src="/api/qr?size=240x240&data=${encodeURIComponent(liffTarget)}" alt="QR Code">
</div>
<p class="hint">LINE アプリのカメラまたは<br>スマートフォンのカメラで読み取れます</p>
<p class="footer">友だち追加で全機能を無料体験できます</p>
</div>
</body>
</html>`);
});

// LINE が開かないときだけ、iOS の長押しまたは URL コピーと外部ブラウザを案内する。システムのメニューはアプリ内ブラウザのリンク制限を受けにくい。
app.get('/r/:ref/help', async (c) => {
  const ref = c.req.param('ref');
  // 停止した経路の回復ページも同じ終了応答で止める。直接開かれても
  // 受付へ戻さない。属さない ref は従来どおり回復ページを出す。
  const helpRoute = await getEntryRouteByRefCode(c.env.DB, ref);
  if (!helpRoute) {
    const anyRoute = await getEntryRouteByRefCodeAny(c.env.DB, ref);
    if (anyRoute && anyRoute.is_active !== 1) {
      return c.html(ENTRY_ROUTE_STOPPED_HTML, 410);
    }
  }
  const reqUrl = new URL(c.req.url);
  // プールの再抽選を防ぐため解決済みの t を優先する。任意サイトへの転送を防ぐため https://liff.line.me/ 配下だけを受け付け、t がない場合だけ短縮 URL に戻す。
  const tParam = c.req.query('t') || '';
  let displayUrl: string;
  if (tParam && /^https:\/\/liff\.line\.me\//.test(tParam)) {
    displayUrl = tParam;
  } else {
    // 未検証の t は除き、再入場に必要な form/gate/xh/ig/pool などは保つ。
    const safeParams = new URLSearchParams(reqUrl.search);
    safeParams.delete('t');
    const qs = safeParams.toString();
    displayUrl = `${reqUrl.origin}/r/${encodeURIComponent(ref)}${qs ? '?' + qs : ''}`;
  }
  // HTML 属性や表示文へ URL を埋める前にエスケープする。
  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const urlForHtml = escapeHtml(displayUrl);

  const ua = (c.req.header('user-agent') || '').toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);
  const browserName = isIOS ? 'Safari' : isAndroid ? 'Chrome' : 'ブラウザ（iPhoneは Safari／Androidは Chrome）';

  // Android は元の intent で回復できるため、長押しの手順は iOS にだけ表示する。
  const longPressBlock = isIOS ? `<div class="method">
<div class="method-num">1</div>
<div class="method-body">
<div class="method-title">長押しで開く（最も簡単）</div>
<div class="method-desc">前のページに戻り、緑の「LINEで開く」ボタンを<strong>長押し</strong>。表示されたメニューから「<strong>LINEで開く</strong>」を選択してください。</div>
</div>
</div>` : '';
  const copyMethodNum = isIOS ? '2' : '1';

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINEを開く方法</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);max-width:400px;width:100%;padding:28px 24px;border:1px solid rgba(0,0,0,0.04)}
.title{font-size:17px;color:#333;font-weight:700;margin-bottom:20px;text-align:center;line-height:1.5}
.method{display:flex;gap:12px;margin-bottom:20px;align-items:flex-start}
.method-num{flex-shrink:0;width:28px;height:28px;border-radius:50%;background:#06C755;color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;margin-top:1px}
.method-body{flex:1}
.method-title{font-size:14px;font-weight:700;color:#333;margin-bottom:6px}
.method-desc{font-size:13px;color:#666;line-height:1.7}
.method-desc strong{color:#06C755;font-weight:700}
.copy-section{background:#f9f9f9;border-radius:12px;padding:16px;margin-top:8px}
.url-box{background:#fff;border:1px solid #e5e7e5;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#333;word-break:break-all;line-height:1.5;user-select:all;-webkit-user-select:all}
.copy-btn{display:block;width:100%;padding:12px;border:none;border-radius:10px;font-size:13px;font-weight:600;text-align:center;color:#fff;background:#06C755;cursor:pointer;margin-bottom:10px;transition:all .15s;font-family:inherit}
.copy-btn:active{transform:scale(0.98);opacity:.9}
.copy-btn.copied{background:#999}
.copy-hint{font-size:11px;color:#aaa;text-align:center;margin-bottom:8px;line-height:1.5}
.steps{font-size:12px;color:#666;line-height:1.8;padding-left:18px;margin-top:6px}
.steps li::marker{color:#06C755;font-weight:700}
</style>
</head>
<body>
<div class="card">
<p class="title">LINEを開く方法</p>
${longPressBlock}
<div class="method">
<div class="method-num">${copyMethodNum}</div>
<div class="method-body">
<div class="method-title">${browserName}で開く</div>
<div class="method-desc">URLをコピーして${browserName}のアドレスバーに貼り付け</div>
<div class="copy-section">
<div class="url-box" id="urlBox">${urlForHtml}</div>
<button class="copy-btn" id="copyBtn" type="button" data-url="${urlForHtml}">URLをコピー</button>
<p class="copy-hint">うまくコピーできない場合は上のURLを長押しで選択</p>
<ol class="steps">
<li>ホームに戻る</li>
<li>${browserName}を開く</li>
<li>アドレスバーに貼り付け</li>
<li>「LINEで開く」をタップ</li>
</ol>
</div>
</div>
</div>
</div>
<script>
(function(){
  var btn = document.getElementById('copyBtn');
  var url = btn.getAttribute('data-url');
  function showCopied(){
    btn.textContent = '✓ コピーしました';
    btn.classList.add('copied');
    setTimeout(function(){
      btn.textContent = 'URLをコピー';
      btn.classList.remove('copied');
    }, 2000);
  }
  function showFailed(){
    btn.textContent = '上のURLを長押しでコピー';
    btn.classList.add('copied');
    setTimeout(function(){
      btn.textContent = 'URLをコピー';
      btn.classList.remove('copied');
    }, 3000);
  }
  function execFallback(text){
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }
  btn.addEventListener('click', function(){
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(showCopied, function(){
        if (execFallback(url)) { showCopied(); } else { showFailed(); }
      });
    } else if (execFallback(url)) {
      showCopied();
    } else {
      showFailed();
    }
  });
})();
</script>
</body>
</html>`);
});

// /o — `/r/:ref` の ref 解決・追跡を一切行わない明示 liffId 版の open page。
// admin UI が OpenChat / IG DM 等で `liff.line.me` を弾かれるチャネル向けに
// 配布するラップ URL のためのルート。`/r/main` を使うと (a) traffic_pool の
// ランダム pool account に再解決されて選択中アカウントから外れる、
// (b) `ref=main` として ref_tracking / friends.ref_code に書き込まれて
// attribution を汚染する、という 2 つの問題があるため別ルートに分けている。
// 仕様:
// - クエリ: liffId (必須, `<digits>-<id>` 形式) / page / id
// - page は `/r/:ref` と同じ allowlist (salon-book / event / event-me / webinar / visit-stamps)
// - mobile UA は「LINEで開く」ボタン、desktop は QR を返す (`/r/:ref` 同等)
app.get('/o', async (c) => {
  if (isLinkPreviewBot(c.req.header('user-agent') || '')) {
    return c.html(await buildOgForLiffPath(c.env.DB, new URL(c.req.url)));
  }

  const liffId = c.req.query('liffId') || '';
  if (!/^[0-9]+-[A-Za-z0-9]+$/.test(liffId)) {
    return c.text(failureMessage('Invalid liffId'), 400);
  }

  const liffParams = new URLSearchParams();
  liffParams.set('liffId', liffId);
  const PAGE_PASSTHROUGH_ALLOWED = new Set(['salon-book', 'event', 'event-me', 'webinar', 'research', 'visit-stamps']);
  const page = c.req.query('page');
  if (page && PAGE_PASSTHROUGH_ALLOWED.has(page)) liffParams.set('page', page);
  if (page === 'research' && c.req.query('researchId')) liffParams.set('researchId', c.req.query('researchId')!);
  const id = c.req.query('id');
  if (id) liffParams.set('id', id);
  const slug = c.req.query('slug');
  if (slug) liffParams.set('slug', slug);
  if (page === 'salon-book') {
    const menuId = c.req.query('menu_id');
    if (menuId && /^[A-Za-z0-9_-]{1,128}$/.test(menuId)) liffParams.set('menu_id', menuId);
  }
  if (page === 'visit-stamps') {
    const card = c.req.query('card');
    if (card && /^[A-Za-z0-9_-]{1,128}$/.test(card)) liffParams.set('card', card);
  }
  // 管理画面が発行する「予約履歴URL」は salon-book の view=history を
  // 指す。任意の view を通すと未定義画面へ誘導できてしまうので、履歴だけを通す。
  const view = c.req.query('view');
  if (page === 'salon-book' && view === 'history') liffParams.set('view', view);
  const liffTarget = `https://liff.line.me/${liffId}?${liffParams.toString()}`;

  const ua = (c.req.header('user-agent') || '').toLowerCase();
  const isMobile = /iphone|ipad|android|mobile/.test(ua);
  const isIOS = /iphone|ipad|ipod/.test(ua);
  const isAndroid = /android/.test(ua);

  if (isMobile) {
    const liffPath = liffTarget.replace(/^https:\/\//, '');
    const intentFallback = encodeURIComponent(liffTarget);
    const androidIntent = `intent://${liffPath}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;package=jp.naver.line.android;S.browser_fallback_url=${intentFallback};end`;
    const buttonHref = isAndroid ? androidIntent : liffTarget;
    const longPressHint = isIOS
      ? '<p class="hint">※開かない場合はボタンを<strong>長押し</strong>して「LINEで開く」を選択</p>'
      : '';
    return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE で開く</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:360px;width:90%;padding:40px 28px 32px;border:1px solid rgba(0,0,0,0.04)}
.line-icon{width:48px;height:48px;margin:0 auto 20px}
.line-icon svg{width:48px;height:48px}
.msg{font-size:15px;color:#444;font-weight:500;margin-bottom:28px;line-height:1.6}
.btn{display:block;width:100%;padding:16px;border:none;border-radius:12px;font-size:16px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#06C755;box-shadow:0 2px 12px rgba(6,199,85,0.2);transition:all .15s}
.btn:active{transform:scale(0.98);opacity:.9}
.hint{font-size:11px;color:#888;margin-top:10px;line-height:1.6}
.hint strong{color:#06C755;font-weight:700}
</style>
</head>
<body>
<div class="card">
<div class="line-icon">
<svg viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M24 12C17.37 12 12 16.58 12 22.2c0 3.54 2.35 6.65 5.86 8.47-.2.74-.76 2.75-.87 3.17-.14.55.2.54.42.39.18-.12 2.84-1.88 4-2.65.84.13 1.7.22 2.59.22 6.63 0 12-4.58 12-10.2S30.63 12 24 12z" fill="#fff"/></svg>
</div>
<p class="msg">LINE で開く</p>
<a href="${escapeHtmlAttribute(buttonHref)}" class="btn">LINEで開く</a>
${longPressHint}
</div>
</body>
</html>`);
  }

  return c.html(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE で開く</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f5f7f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#fff;border-radius:20px;box-shadow:0 2px 20px rgba(0,0,0,0.06);text-align:center;max-width:480px;width:90%;padding:48px;border:1px solid rgba(0,0,0,0.04)}
.line-icon{width:48px;height:48px;margin:0 auto 20px}
.line-icon svg{width:48px;height:48px}
.msg{font-size:15px;color:#444;font-weight:500;margin-bottom:32px;line-height:1.6}
.qr{background:#f9f9f9;border-radius:16px;padding:24px;display:inline-block;margin-bottom:24px;border:1px solid rgba(0,0,0,0.04)}
.qr img{display:block;width:240px;height:240px}
.hint{font-size:13px;color:#999;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<div class="line-icon">
<svg viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M24 12C17.37 12 12 16.58 12 22.2c0 3.54 2.35 6.65 5.86 8.47-.2.74-.76 2.75-.87 3.17-.14.55.2.54.42.39.18-.12 2.84-1.88 4-2.65.84.13 1.7.22 2.59.22 6.63 0 12-4.58 12-10.2S30.63 12 24 12z" fill="#fff"/></svg>
</div>
<p class="msg">スマートフォンで QR コードを読み取ってください</p>
<div class="qr">
<img src="/api/qr?size=240x240&data=${encodeURIComponent(liffTarget)}" alt="QR Code">
</div>
<p class="hint">LINE アプリのカメラまたは<br>スマートフォンのカメラで読み取れます</p>
</div>
</body>
</html>`);
});


app.get('/book', (c) => c.redirect('/?page=book'));

// API の未検出は JSON の404、ほかは管理画面・LIFF の静的ファイルへ渡す。
export async function notFoundHandler(
  c: import('hono').Context<Env>,
): Promise<Response> {
  const url = new URL(c.req.url);
  const path = url.pathname;
  if (path.startsWith('/api/') || path === '/webhook' || path.startsWith('/webhook/') || path === '/docs' || path === '/openapi.json') {
    return c.json({ success: false, error: 'Not found' }, 404);
  }

  // Bot UA (LINE/X/Facebook 等のリンクプレビュー) → OGP HTML を返す
  const ua = c.req.header('user-agent') || '';
  if (isLinkPreviewBot(ua)) {
    const html = await buildOgForLiffPath(c.env.DB, url);
    return c.html(html);
  }

  // 静的ファイルの binding がない開発・試験環境でも、未定義の fetch を呼んで GET 全体を失敗させないよう、先に存在を確認する。
  if (!c.env.ASSETS || typeof c.env.ASSETS.fetch !== 'function') {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  const assetRes = await c.env.ASSETS.fetch(c.req.raw);
  if (assetRes.status !== 404) return assetRes;

  // SPA fallback: LIFF deep links (/webinar/:slug, /events/:id など) は
  // アセットストアに実ファイルが無く 404 で返る。HTML を要求する GET
  // ナビゲーションに限り index.html を返してクライアントルーターに任せる。
  // それ以外 (存在しない .js/.png への参照など) は 404 のまま透過する。
  const accept = c.req.header('accept') ?? '';
  if (c.req.method === 'GET' && accept.includes('text/html')) {
    return c.env.ASSETS.fetch(
      new Request(new URL('/', c.req.url).toString(), { headers: c.req.raw.headers }),
    );
  }
  return assetRes;
}
app.onError(unhandledWorkerError);

app.notFound(notFoundHandler);

export default {
  fetch: (...args: Parameters<typeof app.fetch>) => withInvocation('http', () => app.fetch(...args)),
  async scheduled(event: ScheduledEvent, env: Env['Bindings'], ctx: ExecutionContext): Promise<void> {
    if (qaOutboundStopped(env)) return;
    return withInvocation('cron', () => scheduled(event, env, ctx));
  },
  async queue(
    batch: MessageBatch<CodexMentionQueueMessage>,
    env: Env['Bindings'],
  ): Promise<void> {
    if (qaOutboundStopped(env)) {
      for (const message of batch.messages) message.retry({ delaySeconds: 60 });
      return;
    }
    for (const message of batch.messages) {
      await withInvocation('queue', () => resumeInvocation(message.body?.requestId, async () => {
        try {
          await processCodexMentionMessage(env, message.body);
          message.ack();
        } catch (error) {
          const reason = classifyCodexMonitorError(error);
          const stopped = shouldStopCodexQueueRetry(
            message.attempts,
            env.CODEX_QUEUE_MAX_ATTEMPTS,
          );
          logger.error("src_index_failed");
          if (stopped) {
            try {
              if (message.body.kind !== 'auto_merge') {
                await markCodexMentionFailed(env.DB, message.body.slackEventId);
              }
            } catch {
              logger.error("codex_cloud_monitor_queue_ledger_failed");
            }
            message.ack();
          } else {
            message.retry({ delaySeconds: 60 });
          }
        }
      }));
    }
  },
  async email(
    message: ForwardableEmailMessage,
    env: Env['Bindings'],
    _ctx: ExecutionContext,
  ): Promise<void> {
    if (qaOutboundStopped(env)) {
      message.setReject('Staging QA outbound stop is active');
      return;
    }
    await withInvocation('email', () => routeInboundEmail(message, env));
  },
};
