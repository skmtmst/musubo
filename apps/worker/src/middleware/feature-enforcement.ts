import { logger } from '@line-crm/shared/server';
import {appendFeatureScopeMeta} from './feature-scope-response.js';
import { ACCOUNT_KEYS, bodyAccountIds } from './feature-body-accounts.js';
import type { Context, MiddlewareHandler } from 'hono';
import type { FeatureId } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import type { AuthenticatedStaff } from './auth/principal/auth.js';
import { getVisibleLineAccountScope, restrictVisibleLineAccountScope } from '../services/account-access.js';
import { dbFor } from '../services/db-router.js';
import { accountFeatureAvailability, createFeatureAvailabilityRequestContext, type FeatureAvailability } from '../services/feature-enforcement.js';

export type RouteClassification =
  | { kind: 'feature'; featureId: FeatureId }
  | { kind: 'core' | 'public' | 'system'; reason: string };

export type FeatureRouteMetadata = {
  /** URL path の先頭。長いものを先に評価し、最初に一致した分類を使う。 */
  prefix: string;
  methods: '*';
  accountResolver: 'request-or-resource' | 'none';
  classification: RouteClassification;
};

export type FeatureRoutePatternMetadata = {
  pattern: RegExp;
  methods: readonly string[];
  accountResolver: 'request-or-resource' | 'none';
  classification: RouteClassification;
};

const feature = (prefix: string, featureId: FeatureId): FeatureRouteMetadata => ({
  prefix,
  methods: '*',
  accountResolver: 'request-or-resource',
  classification: { kind: 'feature', featureId },
});
const exempt = (
  prefix: string,
  kind: 'core' | 'public' | 'system',
  reason: string,
): FeatureRouteMetadata => ({
  prefix,
  methods: '*',
  accountResolver: 'none',
  classification: { kind, reason },
});

/**
 * Worker の route metadata 正本。固有経路を広い経路より前に置く。
 * `feature-route-manifest.test.ts` が実際に mount された全 route を照合する。
 */
export const FEATURE_ROUTE_MANIFEST: readonly FeatureRouteMetadata[] = [
  feature('/api/friends/support-mark', 'support_marks'),
  feature('/api/friends/saved-searches', 'saved_searches'),
  feature('/api/friends/saved-views', 'saved_searches'),
  feature('/api/friends/fields', 'friend_fields'),
  feature('/api/friend-fields-stats', 'friend_fields'),
  feature('/api/field-migrations', 'friend_fields'),
  feature('/api/friend-fields', 'friend_fields'),
  feature('/api/friend-attributes', 'friend_fields'),
  feature('/api/support-mark-rules', 'support_marks'),
  feature('/api/support-marks', 'support_marks'),
  feature('/api/saved-searches', 'saved_searches'),
  feature('/api/scenarios', 'scenarios'),
  feature('/api/scenario-drafts', 'scenarios'),
  // 購読1本への操作（止める・再開・失敗を再送・移す）。アカウントは
  // requestAccountIds が購読→友だちから引く。
  feature('/api/scenario-subscriptions', 'scenarios'),
  feature('/api/broadcasts', 'broadcasts'),
  feature('/api/broadcast-message-assets', 'broadcasts'),
  feature('/api/dedup-preview', 'broadcasts'),
  feature('/api/segments', 'broadcasts'),
  feature('/api/templates', 'templates'),
  feature('/api/message-templates', 'templates'),
  feature('/api/reminders', 'reminders'),
  feature('/api/friend-reminders', 'reminders'),
  feature('/api/reminder-runs', 'reminders'),
  feature('/api/auto-replies', 'auto_replies'),
  feature('/api/qa-entries', 'auto_replies'),
  feature('/api/ai-settings', 'auto_replies'),
  exempt('/api/ai-features','core','Account AI opt-in; explicit account scope, admin role, consent and step-up are checked in the route'),
  feature('/api/ai-answer-logs','auto_replies'),
  feature('/api/delivery-purposes','broadcasts'),
  feature('/api/mcp-connections','external_integrations'),
  feature('/api/auto-reply-runs', 'auto_replies'),
  feature('/api/rich-menus', 'rich_menus'),
  feature('/api/rich-menu', 'rich_menus'),
  feature('/api/rich-menu-groups', 'rich_menus'),
  feature('/api/rich-menu-images', 'rich_menus'),
  feature('/api/tracked-links', 'inflow_tracking'),
  feature('/api/entry-routes', 'inflow_tracking'),
  feature('/api/entry-route-genres', 'inflow_tracking'),
  feature('/api/links', 'inflow_tracking'),
  feature('/api/forms', 'forms'),
  feature('/api/form-files', 'forms'),
  feature('/api/postal-code', 'forms'),
  feature('/api/liff/webinars', 'webinars'),
  feature('/api/nen-members/photos', 'photo_review'),
  feature('/api/nen/photo', 'photo_review'),
  feature('/api/automations', 'automations'),
  feature('/api/automation-', 'automations'),
  feature('/api/common-actions', 'automations'),
  feature('/api/webhooks', 'external_integrations'),
  feature('/api/integrations/google-calendar', 'external_integrations'),
  feature('/api/integrations/google-sheets', 'external_integrations'),
  feature('/api/integrations/tiktok-pnl', 'external_integrations'),
  feature('/api/ad-platforms', 'external_integrations'),
  feature('/api/ad-costs', 'external_integrations'),
  feature('/api/instagram', 'external_integrations'),
  feature('/api/friend-add', 'friend_add_routing'),
  feature('/api/friend-add-routing', 'friend_add_routing'),
  feature('/api/friend-add-rules', 'friend_add_routing'),
  feature('/api/friend-add-runs', 'friend_add_routing'),
  feature('/api/traffic-pools', 'multi_store_hierarchy'),
  feature('/api/images', 'media'),
  feature('/api/media', 'media'),
  feature('/api/file-scans', 'media'),
  feature('/api/common-vars', 'common_vars'),
  feature('/api/contents', 'media'),
  feature('/api/analytics', 'analytics'),
  feature('/api/funnels', 'analytics'),
  feature('/api/search-console', 'analytics'),
  exempt('/api/site/collect', 'public', '公開サイトからの計測受信'),
  exempt('/api/site/script.js', 'public', '公開サイトへ配る計測スクリプト'),
  feature('/api/site', 'site_tracking'),
  feature('/api/webinars', 'webinars'),
  feature('/api/events', 'events'),
  exempt('/api/booking/stripe-test/webhook','public','Connect専用の試験署名を検査して未対応はpendingに保存する受信口'),
  exempt('/api/booking/pass-payments/webhook','public','Stripeの試験署名を確認する券の支払通知'),
  feature('/api/booking', 'booking'),
  feature('/api/meet-consultations', 'booking'),
  feature('/api/conversions', 'affiliates'),
  // 計測サイトの管理は成果計測(affiliates)の一部。公開口は /api/public で公開分類済み。
  feature('/api/measurement-sites', 'affiliates'),
  feature('/api/affiliates', 'affiliates'),
  feature('/api/affiliate-', 'affiliates'),
  feature('/api/affiliates-report', 'affiliates'),
  feature('/api/member-ranks', 'mileage'),
  feature('/api/mileage', 'mileage'),
  feature('/api/action-scores', 'mileage'),
  feature('/api/scoring-rules', 'mileage'),
  exempt('/api/ec/events','public','署名で店とEC本人を確認する行動の受信口'),
  feature('/api/ec/auto-line','ec_commerce'),
  feature('/api/ec-commerce', 'ec_commerce'),
  feature('/api/ec-operations', 'ec_commerce'),
  feature('/api/line-notifications', 'line_notifications'),
  feature('/api/notifications/rules', 'line_notifications'),
  feature('/api/notifications/teams', 'line_notifications'),
  feature('/api/nen-campaigns', 'nen_campaigns'),
  feature('/api/nen-members', 'photo_review'),
  // 然の会員（ランク・マイル）はECとの連携が前提。EC連携と同じ機能で止める。
  feature('/api/nen/rank-settings', 'ec_commerce'),
  feature('/api/nen/lifetime-milestones', 'ec_commerce'),
  feature('/api/nen/members', 'ec_commerce'),
  feature('/api/nen/feeding-products', 'photo_review'),
  // マイペット・健康日記は LINE 側だけで完結する然の機能。投稿（photo_review）と同じ束で止める。
  feature('/api/nen/pets', 'photo_review'),
  feature('/api/nen/health', 'photo_review'),
  // デリバリー受注の通知受け口。担当者の認証も統括の判定も通らないため、
  // 機能の入れ/切りでは止めない。route 内でサービスごとの合言葉を照合する。
  exempt(
    '/api/restaurant-test/delivery/webhooks',
    'public',
    '署名検証する各デリバリーサービスからの通知受信',
  ),
  feature('/api/restaurant-test', 'restaurant_test'),
  feature('/api/visit-stamps', 'visit_stamps'),

  exempt('/api/settings', 'core', '機能を再度オンにするため停止対象外'),
  exempt('/api/auth', 'core', 'ログインとセッション管理'),
  exempt('/api/me/presence','core','認証済み本人の在席設定。代理と閲覧専用の変更を拒否する'),
  exempt('/api/me/push', 'core', '認証済み本人の端末通知。各操作で本人と代理禁止を検証'),
  exempt('/api/staff', 'core', 'ログインユーザーと権限管理'),
  exempt('/api/access', 'core', '権限と監査の共通基盤'),
  exempt('/api/capabilities', 'core', '権限判定の共通基盤'),
  exempt('/api/line-account-folders', 'core', '統括内のLINEアカウント分類'),
  exempt('/api/line-account-tags', 'core', '統括内のLINEアカウント分類'),
  exempt('/api/line-accounts', 'core', 'LINEアカウント選択の共通基盤'),
  exempt('/api/friends', 'core', '友だち管理は必須機能'),
  exempt('/api/tags', 'core', 'タグは複数機能が参照する共通基盤'),
  exempt('/api/tag-groups', 'core', 'タグは複数機能が参照する共通基盤'),
  exempt('/api/inbox', 'core', '受信箱は必須機能'),
  exempt('/api/chats', 'core', '受信箱の会話基盤'),
  exempt('/api/conversations', 'core', '受信箱の会話基盤'),
  exempt('/api/dashboard', 'core', '管理画面の入口'),
  exempt('/api/notifications', 'core', '管理画面の共通通知'),
  exempt('/api/brand', 'core', '共通ブランド設定'),
  exempt('/api/public/brand', 'public', 'ログイン前の看板'),
  exempt('/api/health', 'system', '稼働確認'),
  exempt('/api/qr', 'public', '公開QR生成'),
  exempt('/api/liff', 'public', 'LIFF内で個別認証する公開経路'),
  exempt('/liff', 'public', '本人確認するLIFFへ案内する入口。ファイル本文は返さない'),
  exempt('/api/public', 'public', '公開表示専用経路'),
  exempt('/api/integrations', 'system', '署名検証する外部受信経路'),
  exempt('/api/internal', 'system', '内部サービス間経路'),
  exempt('/api/operations', 'system', '運用状態と監視'),
  exempt('/api/tenants', 'core', '統括管理'),
  exempt('/api/ops', 'core', '運営コンソール。ルート内で platform_admins を検証し、統括をまたいで読む'),
  exempt('/api/hq/style-starter-sets','core','統括の初期セット配布。各口で統括の役割と可視店を検証'),
  exempt('/api/hq/store-comparison','core','統括の現在の可視店だけの集計とCSV。各口で統括の役割・代理・取得時の店権限を確認'),
  exempt('/api/hq/operator-history', 'core', '契約先から見える運営の操作履歴。ルート内で staff.tenantId に絞る'),
  exempt('/api/setup', 'core', '初期設定'),
  exempt('/api/getting-started', 'core', '初期設定'),
  exempt('/api/hq/banners', 'core', '統括バナー生成。ルート内でtenantと統括編集権限を検証'),
  exempt('/api/hq/billing', 'core', '統括の契約・課金基盤。管理APIはtenant境界と役割、WebhookはStripe署名を検証'),
  exempt('/api/hq/onboarding/quotes', 'core', '個別見積もりの閲覧・同意。ルート内でtenant境界とowner/admin権限を検証'),
  exempt('/api/hq/onboarding/pricing', 'core', '利用開始前の料金確認・同意。ルート内でtenant境界とowner/admin権限を検証'),
  exempt('/api/hq/support', 'core', '統括利用者から運営への問い合わせ。ルート内でtenant境界と役割を検証'),
  exempt('/api/hq/notices', 'core', '運営からのお知らせと契約者専用LINEの登録案内。ルート内で staff.tenantId に絞る'),
  exempt('/api/hq/broadcasts', 'core', '統括全体のowner/adminだけ。店舗の配信停止は通常配信でも検証'),
  exempt('/api/hq/templates', 'core', '統括ひな形。ルート内でtenantと統括編集権限を検証'),
  exempt('/api/recipes', 'core', '設定テンプレート'),
  exempt('/api/manual-links', 'core', 'ヘルプ導線設定'),
  exempt('/api/error-messages', 'core', '失敗文面の対応表。全画面の失敗表示が引く共通基盤'),
  exempt('/api/account-handovers', 'core', 'アカウント引継ぎ'),
  exempt('/api/friend-bulk-runs', 'core', '複数機能から使う友だち操作'),
  exempt('/api/friend-migrations', 'core', '友だち移行'),
  exempt('/api/users', 'core', '利用者の共通参照'),
  exempt('/api/users-grouped', 'core', '利用者の共通参照'),
  exempt('/api/operators', 'core', '受信箱の担当者管理'),
  exempt('/api/identity-candidates', 'core', '友だち本人統合の共通基盤'),
  exempt('/api/duplicates', 'core', '友だち重複確認'),
  exempt('/api/calendar', 'core', '複数予約機能の共通カレンダー'),
  exempt('/api/accounts', 'core', 'アカウント移行と状態確認'),
  exempt('/api/audit', 'core', '監査の共通基盤'),
  exempt('/api/login-audit', 'core', 'ログイン監査'),
  exempt('/api/folders', 'core', '複数機能から使う分類基盤'),
  exempt('/api/list-stats', 'core', '共通一覧の件数'),
  exempt('/api/account-settings', 'core', 'LINEアカウント共通設定'),
  exempt('/api/profile-refresh', 'system', 'LINEプロフィール同期'),
  exempt('/api/line-proxy', 'system', '監査付きLINE送信基盤'),
  exempt('/api/support', 'core', '運用問い合わせ'),
  exempt('/api/line-webhook-events', 'system', 'Webhook監視'),
  exempt('/api/client-errors', 'system', 'クライアント障害監視'),
  exempt('/api/stripe', 'system', '契約・課金基盤'),
  exempt('/api/admin', 'system', '保守診断と復旧'),
  exempt('/api/meet-callback', 'system', '署名済み外部完了通知'),

  exempt('/mcp','system','接続ごとの鍵と店・操作の段を検証するMCP口'),
  exempt('/webhook', 'public', 'LINE署名で検証する受信経路'),
  exempt('/webhooks', 'public', '外部署名で検証する受信経路'),
  exempt('/openapi.json', 'public', '公開API仕様'),
  exempt('/robots.txt', 'public', '検索に出さない robots（全部拒否）'),
  exempt('/docs', 'public', '公開API仕様'),
  exempt('/auth', 'public', 'ログイン開始とcallback'),
  exempt('/health', 'system', '稼働確認'),
  exempt('/t', 'public', '計測リンク'),
  exempt('/r', 'public', '公開流入リンク'), exempt('/o', 'public', '公開流入リンク'),
  exempt('/book', 'public', '公開予約導線'),
  exempt('/pool', 'public', '公開流入プール'),
  exempt('/images', 'public', '署名付き画像配信'),
  exempt('/media', 'public', 'メディアIDで最新版へ解決する公開配信（ライブ参照）'),
  exempt('/setup', 'public', '初期設定画面'),
  exempt('/webinar-assets', 'public', '署名付きウェビナー素材'),
  exempt('/line-api', 'system', '監査付きLINE API proxy'),
  exempt('/line-api-data', 'system', '監査付きLINE data proxy'),
  exempt('/admin', 'system', '更新・版確認'),
];

/** 同じ prefix 内で公開経路と管理経路が分かれる例外。 */
export const FEATURE_ROUTE_PATTERN_MANIFEST: readonly FeatureRoutePatternMetadata[] = [
  {
    pattern: /^\/api\/instagram\/(?:connection|oauth\/start|oauth\/callback|refresh)$/,
    methods: ['GET', 'POST', 'DELETE'],
    accountResolver: 'none',
    classification: { kind: 'core', reason: 'SNS連携設定の接続状態・認可・解除は、機能停止中も管理できる。各routeで認証・所属・操作権限を確認する' },
  },
  {
    pattern: /^\/api\/restaurant-test\/google\/(?:connection|connect\/start|connect\/select-location|oauth\/callback|disconnect)$/,
    methods: ['GET', 'POST'],
    accountResolver: 'none',
    classification: { kind: 'core', reason: 'SNS連携設定のGoogle接続管理は、機能停止中も行える。Googleの利用と店舗所属・接続権限はrouteで確認する' },
  },
  {
    pattern: /^\/api\/hq\/style(?:\*|-template-samples|-starter-sets(?:\/[^/]+)?|-attention)$/,
    methods: ['ALL', 'GET', 'PUT'],
    accountResolver: 'none',
    classification: { kind: 'core', reason: '統括の業種設定。ルート内で統括所属とowner/adminを確認し、店舗の機能停止は各予約口で検証する' },
  },
  {pattern:/^\/api\/instagram\/webhook$/,methods:['GET','POST'],accountResolver:'none',classification:{kind:'public',reason:'Metaの確認用トークン・HMAC署名で個別認証する受信口'}},
  {pattern:/^\/internal\/ubereats\/sandbox-token-probe$/,methods:['POST'],accountResolver:'none',classification:{kind:'system',reason:'合言葉の署名で個別認証するUber Sandbox接続確認の一回実行口'}},
  {
    pattern: /^\/api\/auth\/(?:register|password)\//,
    methods: ['GET', 'POST'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: '登録前・ログイン前にTurnstileと回数制限で守る認証経路' },
  },
  {
    // 一次認証の課題で本人確認する。管理セッション発行前の公開経路。
    pattern: /^\/api\/auth\/passkeys\/login\/(?:options|verify)$/,
    methods: ['POST'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: '一次認証の課題で本人確認するパスキーログインの入口' },
  },
  {
    // 二段階認証の確認と初回設定。セッションはまだ無く、合言葉だけで守る公開経路。
    pattern: /^\/api\/auth\/two-factor\/(verify|setup(?:\/confirm)?)$/,
    methods: ['POST'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: 'ログイン中の合言葉で本人確認する二段階認証の入口' },
  },
  {
    // 運営メンバーの招待を受ける口（★37-10-A）。メールの URL のトークンだけで守る
    pattern: /^\/api\/auth\/ops-invite\//,
    methods: ['GET', 'POST'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: '招待メールのトークンで本人確認する運営メンバー登録の入口' },
  },
  {
    pattern: /^\/api\/hq\/billing\/webhook$/,
    methods: ['POST'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: 'Stripe署名で検証する課金イベント受信' },
  },
  {
    pattern: /^\/api\/integrations\/ai-loop\/reports$/,
    methods: ['POST'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: 'HMAC署名で検証するAI開発状況の一方向報告' },
  },
  {
    pattern: /^\/api\/affiliates\/click$/,
    methods: ['POST'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: '紹介コードからの公開クリック記録' },
  },
  {
    pattern: /^\/api\/friends\/[^/]+\/fields(?:\/|$)/,
    methods: ['GET', 'PUT'],
    accountResolver: 'request-or-resource',
    classification: { kind: 'feature', featureId: 'friend_fields' },
  },
  {
    pattern: /^\/api\/friends\/(?:[^/]+\/support-mark|support-mark\/bulk)(?:\/|$)/,
    methods: ['PATCH', 'POST'],
    accountResolver: 'request-or-resource',
    classification: { kind: 'feature', featureId: 'support_marks' },
  },
  {
    pattern: /^\/api\/friends\/[^/]+\/(?:mileage|score)(?:\/|$)/,
    methods: ['GET', 'POST'],
    accountResolver: 'request-or-resource',
    classification: { kind: 'feature', featureId: 'mileage' },
  },
  {
    pattern: /^\/api\/friends\/[^/]+\/site-events(?:\/|$)/,
    methods: ['GET'],
    accountResolver: 'request-or-resource',
    classification: { kind: 'feature', featureId: 'site_tracking' },
  },
  {
    pattern: /^\/api\/friends\/[^/]+\/journey(?:\/|$)/,
    methods: ['GET'],
    accountResolver: 'request-or-resource',
    classification: { kind: 'feature', featureId: 'affiliates' },
  },
  {
    // 管理者確認専用口。公開の :id 表示と紛らわしいため、固有経路を先に置く。
    // requireRole('owner', 'admin') で認証必須。公開口にしない。
    pattern: /^\/api\/forms\/unassigned$/,
    methods: ['GET'],
    accountResolver: 'request-or-resource',
    classification: { kind: 'feature', featureId: 'forms' },
  },
  {
    pattern: /^\/api\/forms\/[^/]+$/,
    methods: ['GET'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: '回答前に表示する公開フォーム' },
  },
  {
    pattern: /^\/api\/forms\/[^/]+\/images\/[^/]+$/,
    methods: ['GET'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: '採用中の公開フォーム版が表示する固定画像' },
  },
  {
    pattern: /^\/api\/forms\/[^/]+\/(?:submit|opened|partial|files)$/,
    methods: ['POST'],
    accountResolver: 'none',
    classification: { kind: 'public', reason: 'LINE利用者が行う公開フォーム操作' },
  },
];

function prefixMatches(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (prefix.endsWith('-')) return path.startsWith(prefix);
  return path.startsWith(`${prefix}/`);
}

export function routeClassification(path: string, method = 'GET'): RouteClassification | null {
  const prefixPath=path.replace(/\*$/, '').replace(/\/$/, '');
  const pattern = FEATURE_ROUTE_PATTERN_MANIFEST.find(
    (item) => item.methods.includes(method.toUpperCase()) && item.pattern.test(path),
  );
  if (pattern) return pattern.classification;
  return FEATURE_ROUTE_MANIFEST.find((item) => prefixMatches(prefixPath, item.prefix))?.classification ?? null;
}

/**
 * WRITE-01: URL の対象IDから所属LINEアカウントを引く対応表。
 *
 * 更新系APIのpayloadにはaccountを載せない口が多い（PUT /api/templates/:id、
 * PATCH /api/rich-menu-groups/:id など）。その場合でも対象の所有accountを
 * サーバー側で確かめ、機能設定と権限の判定をその所属accountに対して行う。
 * 行が無い・accountがNULL（全アカウント共用）なら従来の解決へ進む。
 *
 * 各 pattern の最初の捕捉はその表の主キー。`/api/conversions/ingest/:id`
 * （署名で守る外部受信口）や `/api/media/upload-sessions/:id` のように
 * 別のIDを持つ口は、表に無いIDとして行が見つからず従来どおり進むだけなので
 * 個別に除外しない。
 */
const RESOURCE_ACCOUNT_LOOKUPS: ReadonlyArray<{
  pattern: RegExp;
  sql: string;
  /** 本体で行が見つからないときだけ試す予備の照合（新旧の表の同居用）。 */
  fallbackSql?: string;
}> = [
  {pattern:/^\/api\/visit-stamps\/entries\/([^/]+)/,sql:'SELECT line_account_id AS account_id FROM visit_stamp_entries WHERE id=?'},
  {pattern:/^\/api\/visit-stamps\/paper-requests\/([^/]+)/,sql:'SELECT line_account_id AS account_id FROM visit_stamp_paper_requests WHERE id=?'},
  {pattern:/^\/api\/visit-stamps\/paper-photos\/([^/]+)/,sql:'SELECT line_account_id AS account_id FROM visit_stamp_paper_photos WHERE id=?'},
  {pattern:/^\/api\/visit-stamps\/visits\/restaurant\/([^/]+)/,sql:'SELECT s.line_account_id AS account_id FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id WHERE r.id=?'},
  {pattern:/^\/api\/visit-stamps\/visits\/booking\/([^/]+)/,sql:'SELECT line_account_id AS account_id FROM bookings WHERE id=?'},
  { pattern: /^\/api\/templates\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM templates WHERE id = ?' },
  { pattern: /^\/api\/scenarios\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM scenarios WHERE id = ?' },
  { pattern: /^\/api\/broadcasts\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM broadcasts WHERE id = ?' },
  { pattern: /^\/api\/broadcast-message-assets\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM broadcast_message_assets WHERE id = ?' },
  { pattern: /^\/api\/reminders\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM reminders WHERE id = ?' },
  // friend_reminders 表に所属列は無い。友だちの所属で判定する。
  { pattern: /^\/api\/friend-reminders\/([^/]+)/, sql: 'SELECT f.line_account_id AS account_id FROM friend_reminders fr JOIN friends f ON f.id = fr.friend_id WHERE fr.id = ?' },
  { pattern: /^\/api\/reminder-runs\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM reminder_delivery_runs WHERE id = ?' },
  { pattern: /^\/api\/auto-replies\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM auto_replies WHERE id = ?' },
  { pattern: /^\/api\/rich-menu-groups\/([^/]+)/, sql: 'SELECT account_id FROM rich_menu_groups WHERE id = ?' },
  { pattern: /^\/api\/form-files\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM form_submission_files WHERE id = ?' },
  { pattern: /^\/api\/forms\/document-settings\/([^/]+)$/, sql: 'SELECT id AS account_id FROM line_accounts WHERE id = ?' },
  { pattern: /^\/api\/media\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM media WHERE id = ?' },
  { pattern: /^\/api\/common-vars\/exports\/([^/]+)(?:\/|$)/, sql: 'SELECT line_account_id AS account_id FROM common_var_export_jobs WHERE id = ?' },
  { pattern: /^\/api\/common-vars\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM common_vars WHERE id = ?' },
  { pattern: /^\/api\/common-actions\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM common_actions WHERE id = ?' },
  // 一覧が返すidは の automation_definitions。旧 automations 表だけを
  // 見ると ルールの稼働切替・改訂下書きが全部 LINE_ACCOUNT_REQUIRED で止まる。
  { pattern: /^\/api\/automations\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM automation_definitions WHERE id = ?', fallbackSql: 'SELECT line_account_id AS account_id FROM automations WHERE id = ?' },
  { pattern: /^\/api\/tracked-links\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM tracked_links WHERE id = ?' },
  { pattern: /^\/api\/entry-routes\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM entry_routes WHERE id = ?' },
  { pattern: /^\/api\/ad-platforms\/(?!mappings(?:\/|$))([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM ad_platforms WHERE id = ?' },
  { pattern: /^\/api\/friend-add-rules\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM friend_add_rules WHERE id = ?' },
  { pattern: /^\/api\/conversions\/(?:definitions|points)\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM conversion_points WHERE id = ?' },
  // 成果の所属は地点表が持つ。イベント表に列は無いので結合して引く。
  { pattern: /^\/api\/conversions\/events\/([^/]+)/, sql: 'SELECT cp.line_account_id AS account_id FROM conversion_events ce JOIN conversion_points cp ON cp.id = ce.conversion_point_id WHERE ce.id = ?' },
  { pattern: /^\/api\/events\/admin\/events\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM events WHERE id = ?' },
  // たまる決めごとの停止・再開・削除は payload に account を載せない。
  // 照合が無いと PUT/DELETE /api/mileage/rules/:id が全部 LINE_ACCOUNT_REQUIRED で止まる。
  { pattern: /^\/api\/mileage\/rules\/([^/]+)/, sql: 'SELECT line_account_id AS account_id FROM mileage_rules WHERE id = ?' },
];

/**
 * 親ではなく行の送信元アカウントで担当を判定する口。
 * 履歴・登録の一覧と、登録1件の操作（日時変更・取消・再開）が対象。
 * 行の絞り込み自体は route 側で行い、ここでは「通してよいか」だけ決める。
 */
const ROW_SCOPED_REMINDER_PATTERN = /^\/api\/reminders\/([^/]+)\/(runs|registrants([/?].*)?$)/;

function matchRowScopedReminderId(path: string): string | null {
  const match = ROW_SCOPED_REMINDER_PATTERN.exec(path);
  return match ? decodeURIComponent(match[1]!) : null;
}

/**
 * ルールの今の所属に加え、実行行の送信元と登録の友だちの所属を集める。
 * 所属を変えた後も、旧所属の担当者が旧行へ届くようにするため。
 */
async function reminderRowAccountSet(db: D1Database, reminderId: string): Promise<string[]> {
  const result = await db.prepare(
    `SELECT line_account_id AS account_id FROM reminders WHERE id = ?
     UNION
     SELECT line_account_id FROM reminder_delivery_runs WHERE reminder_id = ?
     UNION
     SELECT f.line_account_id
       FROM friend_reminders fr
       JOIN friends f ON f.id = fr.friend_id
      WHERE fr.reminder_id = ?`,
  ).bind(reminderId, reminderId, reminderId).all<{ account_id: string | null }>();
  return [...new Set(
    (result.results ?? []).map((row) => row.account_id).filter((id): id is string => Boolean(id)),
  )];
}

async function rowScopedReminderAccountIds(
  c: Context<Env>,
  db: D1Database,
  staff: AuthenticatedStaff | undefined,
  reminderId: string,
): Promise<{ ids: string[]; accountMismatch: boolean; forbidden: boolean }> {
  let queryAccount: string | null = null;
  for (const key of ACCOUNT_KEYS) {
    const value = c.req.query(key);
    if (value?.trim()) {
      queryAccount = value.trim();
      break;
    }
  }
  const fromBody = await bodyAccountIds(c);
  const bodySingle = fromBody.length === 1 ? fromBody[0]! : null;
  if (queryAccount && bodySingle && queryAccount !== bodySingle) {
    return { ids: [], accountMismatch: true, forbidden: false };
  }
  const owned = await reminderRowAccountSet(db, reminderId);
  const candidates = queryAccount ? [queryAccount] : fromBody.length > 0 ? fromBody : owned;
  if (candidates.length === 0) return { ids: [], accountMismatch: false, forbidden: false };
  if (candidates.some((id) => !owned.includes(id))) {
    return { ids: [], accountMismatch: true, forbidden: false };
  }
  // 担当外の所属だけを指定・保持しているときは通さない。行の絞り込みは
  // route 側で行うため、ここでは見える所属だけを機能判定へ渡す。
  const scope = await getVisibleLineAccountScope(db, staff);
  const visible = candidates.filter((id) => scope.ids.includes(id));
  if (visible.length === 0) return { ids: [], accountMismatch: false, forbidden: true };
  return { ids: visible, accountMismatch: false, forbidden: false };
}

/**
 * URL が指す対象の所属accountを返す。対象が無い・account未割当なら null。
 * 一致する表が無い口（公開経路・collect 等）は呼ばれない前提で、
 * 表ごとの照合だけをここに集約する。
 */
async function resourceOwnerAccountId(c: Context<Env>): Promise<string | null> {
  for (const { pattern, sql, fallbackSql } of RESOURCE_ACCOUNT_LOOKUPS) {
    const match = pattern.exec(c.req.path);
    if (!match) continue;
    const id = decodeURIComponent(match[1]!);
    const db = dbFor(c.env);
    const row = await db.prepare(sql)
      .bind(id)
      .first<{ account_id: string | null }>();
    if (row) return row.account_id;
    if (!fallbackSql) return null;
    const fallback = await db.prepare(fallbackSql)
      .bind(id)
      .first<{ account_id: string | null }>();
    return fallback?.account_id ?? null;
  }
  return null;
}

async function requestAccountIds(c: Context<Env>): Promise<{ ids: string[]; accountMismatch: boolean }> {
  // /api/liff 外の互換予約 URL もイベントの機能判定を通す。所有者は未検証のパラメータや管理セッションでなく、保存済み LIFF 対応から解決する。
  if (c.req.method === 'POST' && /^\/api\/events\/liff\/bookings\/[^/]+\/change$/.test(c.req.path)) {
    const liffId = c.req.query('liffId');
    const account = liffId ? await dbFor(c.env).prepare(
      'SELECT id FROM line_accounts WHERE liff_id = ? AND is_active = 1',
    ).bind(liffId).first<{ id: string }>() : null;
    return { ids: account ? [account.id] : [], accountMismatch: false };
  }
  /*
   * 公開受信口は受信口IDから所属を確定する。
   * 画面のコピーURL（queryなし）でも通り、外部指定の account は使わない。
   * 別 account・不存在の指定で所有先の機能停止をすり抜けられない。
   * 有効な所有先の受信を無関係な指定で拒否しない。
   * 本文の account 探索のために JSON を先読みしない
   * （巨大本文は route の申告サイズ検査で読まずに413へ）。
   */
  const receiveMatch = /^\/api\/webhooks\/incoming\/([^/]+)\/receive$/.exec(c.req.path);
  if (receiveMatch) {
    let webhookId: string | null = null;
    try {
      webhookId = decodeURIComponent(receiveMatch[1]!);
    } catch {
      webhookId = null;
    }
    if (webhookId) {
      const owner = await dbFor(c.env).prepare(
        'SELECT line_account_id AS account_id FROM incoming_webhooks WHERE id = ? AND deleted_at IS NULL',
      ).bind(webhookId).first<{ account_id: string | null }>();
      if (owner?.account_id) return { ids: [owner.account_id], accountMismatch: false };
    }
    // 未知の受信口は従来の解決へ（route が 404 を返す）。
  }
  // query と body の両方に所属があるときは両方を見る。query だけを
  // 見ると、query に旧所属・body に新所属を書いて検査をすり抜けられる。
  // 両方が食い違う入力はどちらを信じるか決められないため断る。
  let queryAccount: string | null = null;
  for (const key of ACCOUNT_KEYS) {
    const value = c.req.query(key);
    if (value?.trim()) {
      queryAccount = value.trim();
      break;
    }
  }
  const fromBody = await bodyAccountIds(c);
  // 一括指定の配列（accountIds 等）は別用途の絞り込みに使う口があるため、
  // 単一指定のときだけ query との食い違いを見る。
  const bodySingle = fromBody.length === 1 ? fromBody[0]! : null;
  if (queryAccount && bodySingle && queryAccount !== bodySingle) {
    return { ids: [], accountMismatch: true };
  }
  const explicit: string[] = [];
  if (queryAccount) explicit.push(queryAccount);
  else explicit.push(...fromBody);
  if (explicit.length > 0) {
    /*
     * 明示されたaccountとURLの対象の所属が食い違うときは断る。
     * 別accountの名前を出せば所属の検査をすり抜けられる形にはしない。
     * 所属がNULLの対象（全アカウント共用）はここでは判定しない。
     */
    const owned = await resourceOwnerAccountId(c);
    if (owned && !explicit.includes(owned)) {
      return { ids: [], accountMismatch: true };
    }
    return { ids: explicit, accountMismatch: false };
  }
  const webinar = /^\/api\/liff\/webinars\/([^/]+)/.exec(c.req.path);
  if (webinar) {
    const row = await dbFor(c.env).prepare(
      'SELECT account_id FROM webinars WHERE slug = ?',
    ).bind(decodeURIComponent(webinar[1]!)).first<{ account_id: string | null }>();
    if (row?.account_id) return { ids: [row.account_id], accountMismatch: false };
  }
  const webinarAdmin = /^\/api\/webinars\/([^/]+)/.exec(c.req.path);
  if (webinarAdmin && !['overview'].includes(webinarAdmin[1]!)) {
    const row = await dbFor(c.env).prepare(
      'SELECT account_id FROM webinars WHERE id = ?',
    ).bind(decodeURIComponent(webinarAdmin[1]!)).first<{ account_id: string | null }>();
    if (row?.account_id) return { ids: [row.account_id], accountMismatch: false };
  }
  const friend = /^\/api\/friends\/([^/]+)/.exec(c.req.path);
  if (friend && !['support-mark'].includes(friend[1]!)) {
    const row = await dbFor(c.env).prepare(
      'SELECT line_account_id FROM friends WHERE id = ?',
    ).bind(decodeURIComponent(friend[1]!)).first<{ line_account_id: string | null }>();
    if (row?.line_account_id) return { ids: [row.line_account_id], accountMismatch: false };
  }
  // /api/scenario-subscriptions/:id/... は本体に account を載せない。
  // 購読の友だちが属するアカウントで機能設定を見る。
  const subscription = /^\/api\/scenario-subscriptions\/([^/]+)/.exec(c.req.path);
  if (subscription) {
    const row = await dbFor(c.env).prepare(
      `SELECT f.line_account_id
         FROM friend_scenarios fs
         JOIN friends f ON f.id = fs.friend_id
        WHERE fs.id = ?`,
    ).bind(decodeURIComponent(subscription[1]!)).first<{ line_account_id: string | null }>();
    if (row?.line_account_id) return { ids: [row.line_account_id], accountMismatch: false };
  }
  // WRITE-01: 更新系はpayloadにaccountを載せないため、URLの対象の所属で判定する。
  const owned = await resourceOwnerAccountId(c);
  if (owned) return { ids: [owned], accountMismatch: false };
  const staff = c.get('staff');
  if (staff?.assignedLineAccountId) {
    return { ids: [staff.assignedLineAccountId], accountMismatch: false };
  }
  return { ids: [], accountMismatch: false };
}


const BULK_APPROVAL_PATH = '/api/conversions/approvals/bulk';
const BULK_APPROVAL_MAX_ITEMS = 100;

/**
 * m22u ・：一括承認の対象IDから所属アカウントを引く。
 *
 * 一括の body は items（成果IDの列）だけで、アカウントを載せない。
 * URL にも対象IDが無いため従来の解決では空になり、固定アカウントのない
 * 管理者は LINE_ACCOUNT_REQUIRED で止まっていた。ここでは items の成果ID
 * から所属を引き、対象ごとの権限・機能状態を判定できるようにする。
 */
function bulkApprovalEventIds(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const ids: string[] = [];
  for (const raw of items) {
    if (ids.length >= BULK_APPROVAL_MAX_ITEMS) break;
    const id = (raw as { id?: unknown } | null | undefined)?.id;
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

type BulkApprovalScope =
  | { ok: true; enabled: string[] }
  | { ok: false; response: Response };

/**
 * 一括承認の入口判定。null のときは対象が引けなかったため、従来の解決
 * （割当アカウント・LINE_ACCOUNT_REQUIRED）へ進む。handler が入力検査で
 * 400 にするため、状態は変わらない。
 */
async function resolveBulkApprovalScope(
  c: Context<Env>,
  featureId: FeatureId,
): Promise<BulkApprovalScope | null> {
  let parsed: unknown = null;
  try {
    if (c.req.header('content-type')?.toLowerCase().includes('application/json')) {
      parsed = await c.req.raw.clone().json();
    }
  } catch {
    parsed = null;
  }
  const eventIds = bulkApprovalEventIds(parsed);
  if (eventIds.length === 0) return null;
  const db = dbFor(c.env);
  const rows = await db.prepare(
    `SELECT ce.id AS event_id, cp.line_account_id AS account_id
       FROM conversion_events ce
       JOIN conversion_points cp ON cp.id = ce.conversion_point_id
      WHERE ce.id IN (${eventIds.map(() => '?').join(',')})`,
  ).bind(...eventIds).all<{ event_id: string; account_id: string | null }>();
  const byId = new Map(rows.results.map((row) => [row.event_id, row.account_id]));
  // 行が無い対象は handler が denied/failed へ1件ずつ振り分ける。
  const resolved = eventIds
    .map((id) => byId.get(id))
    .filter((account): account is string | null => account !== undefined);
  // 所属が NULL（全アカウント共用）の対象が混ざるときは従来の解決へ。
  if (resolved.some((account) => account === null)) return null;
  const union = [...new Set(resolved as string[])];
  if (union.length === 0) return null;

  // 一括の URL に資源は無いため、ここでの mismatch は起きない。
  const { ids: explicit } = await requestAccountIds(c);
  const staff = c.get('staff');
  if (explicit.length > 0) {
    /*
     * 指定したアカウントと対象の所属が違うときは全体を拒否する。
     * A の名前で B の成果を通す抜け道にしない。
     */
    if (union.some((account) => !explicit.includes(account))) {
      return {
        ok: false,
        response: c.json({
          success: false,
          error: '指定されたLINEアカウントと対象データの所属が一致しません',
          code: 'LINE_ACCOUNT_MISMATCH',
        }, 403),
      };
    }
    if (staff) {
      const scope = await getVisibleLineAccountScope(db, staff);
      if (explicit.some((account) => !scope.ids.includes(account))) {
        return {
          ok: false,
          response: c.json({
            success: false,
            error: 'このLINEアカウントを操作する権限がありません',
          }, 403),
        };
      }
    }
    const enabled = await bulkEnabledAccounts(c, explicit, featureId);
    if (enabled.length === 0) {
      return { ok: false, response: await bulkUnavailable(c, explicit, featureId) };
    }
    return { ok: true, enabled };
  }
  /*
   * 明示がないときは対象の所属の和集合で見る。権限外の対象は全体を
   * 落とさず、handler が1件ずつ denied へ振り分ける。機能オフの対象も
   * 同じく handler が1件ずつ失敗として返し、許可分は処理する。
   */
  const enabled = await bulkEnabledAccounts(c, union, featureId);
  if (enabled.length === 0) {
    return { ok: false, response: await bulkUnavailable(c, union, featureId) };
  }
  return { ok: true, enabled };
}

/** 指定アカウントのうち機能が有効なものだけを返す。 */
async function bulkEnabledAccounts(
  c: Context<Env>,
  accountIds: string[],
  featureId: FeatureId,
): Promise<string[]> {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const requestContext = staff
    ? createFeatureAvailabilityRequestContext((await getVisibleLineAccountScope(db, staff)).accounts)
    : undefined;
  const states = await Promise.all(accountIds.map(async (accountId) => ({
    accountId,
    availability: await accountFeatureAvailability(db, accountId, featureId, requestContext),
  })));
  return states
    .filter(({ availability }) => availabilityAllowsOperation(availability, c.req.method))
    .map(({ accountId }) => accountId);
}

/** 対象すべてが機能オフのときの全体拒否（従来の unavailableResponse と同じ形）。 */
async function bulkUnavailable(
  c: Context<Env>,
  accountIds: string[],
  featureId: FeatureId,
): Promise<Response> {
  const staff = c.get('staff');
  const db = dbFor(c.env);
  const requestContext = staff
    ? createFeatureAvailabilityRequestContext((await getVisibleLineAccountScope(db, staff)).accounts)
    : undefined;
  const availability = await accountFeatureAvailability(db, accountIds[0]!, featureId, requestContext);
  return unavailableResponse(c, availability);
}

/**
 * 認証・tenant scope の後、handler の前で会社の機能設定を強制する。
 * manifest は CI で全 route 分類済みのため、未知の管理 API は fail closed にする。
 */
export const featureEnforcementMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (c.req.method === 'OPTIONS' || !c.req.path.startsWith('/api/')) return next();
  let classification = routeClassification(c.req.path, c.req.method);
  // GET /api/forms/:id は公開表示と管理編集が同居する。認証済みなら管理APIとして
  // 機能設定を強制し、未認証の公開表示だけ既存契約を保つ。
  if (
    classification?.kind === 'public'
    && c.get('staff')
    && /^\/api\/forms\/[^/]+$/.test(c.req.path)
  ) {
    classification = { kind: 'feature', featureId: 'forms' };
  }
  if (!classification) {
    logger.error("route.feature.unclassified");
    return c.json({
      success: false,
      error: 'APIの機能分類が未設定です',
      code: 'ROUTE_FEATURE_UNCLASSIFIED',
    }, 500);
  }
  if (classification.kind !== 'feature') return next();

  // m22u ・: 一括承認は items の成果IDから所属を引いて判定する。
  // URL に資源が無いため従来の解決では空になり、固定アカウントの無い管理者が
  // LINE_ACCOUNT_REQUIRED で止まる。items の成果IDから所属を引いて判定する。
  if (c.req.method === 'POST' && c.req.path === BULK_APPROVAL_PATH) {
    const bulk = await resolveBulkApprovalScope(c, classification.featureId);
    if (bulk) {
      if (!bulk.ok) return bulk.response;
      const bulkStaff = c.get('staff');
      if (bulkStaff) c.set('staff', restrictVisibleLineAccountScope(dbFor(c.env), bulkStaff, bulk.enabled));
      return next();
    }
    // 対象が引けない要求は下の従来の解決へ（handler が入力検査で400にする）。
  }
  const staff = c.get('staff');
  const db = dbFor(c.env);
  // 履歴・登録の口は親の所属だけで閉じない。行の送信元
  // アカウントのどれかを担当していれば通し、行の絞り込みは route 側で行う。
  const rowScopedReminderId = matchRowScopedReminderId(c.req.path);
  if (rowScopedReminderId) {
    const decided = await rowScopedReminderAccountIds(c, db, staff, rowScopedReminderId);
    if (decided.forbidden) {
      return c.json({
        success: false,
        error: 'このLINEアカウントを操作する権限がありません',
      }, 403);
    }
    return enforceAccounts(c, next, db, staff, classification, decided.ids, decided.accountMismatch);
  }

  const { ids: accountIds, accountMismatch } = await requestAccountIds(c);
  return enforceAccounts(c, next, db, staff, classification, accountIds, accountMismatch);
};

/**
 * 機能設定の強制（本文）。行単位の口と通常の口で共有する。
 * accountIds は「この要求で機能判定する所属」の確定ずみ一覧。
 */
async function enforceAccounts(
  c: Context<Env>,
  next: () => Promise<void>,
  db: D1Database,
  staff: AuthenticatedStaff | undefined,
  classification: Extract<RouteClassification, { kind: 'feature' }>,
  accountIds: string[],
  accountMismatch: boolean,
): Promise<Response | void> {
  const isReadOperation = c.req.method === 'GET' || c.req.method === 'HEAD';
  if (accountMismatch) {
    return c.json({
      success: false,
      error: '指定されたLINEアカウントと対象データの所属が一致しません',
      code: 'LINE_ACCOUNT_MISMATCH',
    }, 403);
  }
  if (accountIds.length === 0 && isReadOperation && staff) {
    const scope = await getVisibleLineAccountScope(db, staff);
    if (scope.ids.length === 0) {
      return c.json({
        success: false,
        error: 'この機能は設定でオフになっています',
        code: 'FEATURE_DISABLED',
        featureId: classification.featureId,
      }, 403);
    }
    const requestContext = createFeatureAvailabilityRequestContext(scope.accounts);
    const states = await Promise.all(scope.ids.map(async (accountId) => ({
      accountId,
      availability: await accountFeatureAvailability(
        db,
        accountId,
        classification.featureId,
        requestContext,
      ),
    })));
    const enabledIds = states
      .filter(({ availability }) => availabilityAllowsOperation(availability, c.req.method))
      .map(({ accountId }) => accountId);
    const excluded = states.length - enabledIds.length;
    if (enabledIds.length === 0) {
      return unavailableResponse(c, states[0]!.availability);
    }
    c.set('staff', restrictVisibleLineAccountScope(db, staff, enabledIds));
    await next();
    await appendFeatureScopeMeta(c, excluded);
    return;
  }
  if (accountIds.length === 0) {
    return c.json({
      success: false,
      error: 'LINEアカウントを指定してください',
      code: 'LINE_ACCOUNT_REQUIRED',
    }, 400);
  }
  let requestContext: ReturnType<typeof createFeatureAvailabilityRequestContext> | undefined;
  if (staff) {
    const scope = await getVisibleLineAccountScope(db, staff);
    if (accountIds.some((accountId) => !scope.ids.includes(accountId))) {
      return c.json({
        success: false,
        error: 'このLINEアカウントを操作する権限がありません',
      }, 403);
    }
    requestContext = createFeatureAvailabilityRequestContext(scope.accounts);
  }
  const states = await Promise.all(accountIds.map(
    (accountId) => accountFeatureAvailability(
      db,
      accountId,
      classification.featureId,
      requestContext,
    ),
  ));
  if (states.every((availability) => availabilityAllowsOperation(availability, c.req.method))) {
    return next();
  }
  return unavailableResponse(
    c,
    states.find((availability) => !availabilityAllowsOperation(availability, c.req.method))!,
  );
};

function availabilityAllowsOperation(availability: FeatureAvailability, method: string): boolean {
  if (availability.effectiveEnabled) return true;
  const readOperation = method === 'GET' || method === 'HEAD';
  return readOperation && availability.reason === 'contract_unavailable';
}

function unavailableResponse(c: Context<Env>, availability: FeatureAvailability) {
  const code = availability.reason === 'contract_unavailable'
    ? 'FEATURE_NOT_ENTITLED'
    : availability.reason === 'dependency_disabled'
      ? 'FEATURE_DEPENDENCY_DISABLED'
      : 'FEATURE_DISABLED';
  return c.json({
    success: false,
    error: availability.message,
    code,
    featureId: availability.featureId,
    reason: availability.reason,
  }, 403);
}
