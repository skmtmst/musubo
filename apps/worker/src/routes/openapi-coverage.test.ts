import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { app } from '../index.js';
import { routeClassification } from '../middleware/feature-enforcement.js';
import { ALLOWLIST } from './openapi-coverage-allowlist.js';

/**
 * OpenAPI（GET /openapi.json）と実装の同期ゲート。
 *
 * 目的: 仕様書だけ置き去りになる状態を防ぐ。route を足したのに OpenAPI へ
 * 記載も allowlist 登録もしていないと落ちる。API の実動作は変えない。
 *
 * 対象: `/api/*` と `/webhook`、認証なし公開メタデータ 2 件
 * （GET /admin/version、GET /admin/manifest）。
 * 対象外とその理由:
 * - `/api/restaurant-test/*`（休業・貸切と席の空きの口以外） … 飲食店向け機能（`RESTAURANT_TEST_ENABLED` で環境ごとに切替）
 * - `/api/internal/*` … 内部サービス間経路（内部専用口）
 * - `/admin/update/*` … 管理キー必須の内部保守口
 * - `ALL` メソッド … ミドルウェア掛け（同じ path の具体メソッドが別にある）
 * - `OPTIONS`、`/*`、`/api/*` … プリフライトと全体ミドルウェア
 * - `/openapi.json`、`/docs` … 仕様書そのもの
 * - `/auth/*`、`/book`、`/setup`、`/t/*`、`/r/*` などのページ・転送 … 公開APIではない
 *
 * 運用: 新しい route を足したら OpenAPI（openapi.ts）へ記載する。
 * ALLOWLIST への追加は原則禁止。新 route は OpenAPI 記載が必要。
 * 後続票で記載を増やしたら ALLOWLIST から消し、ALLOWLIST_MAX と
 * BASELINE_DOCUMENTED の基準も同じ PR で更新する。
 * version は repo の package.json と一致させる（自動取得ではなく検査で同期）。
 * request/response の中身までは見ない。本文の parity は順次対応。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const ROOT_VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

const HONO_PARAM_PATTERN = /:([A-Za-z0-9_]+)/g;
const toOpenApiPath = (honoPath: string): string => honoPath.replace(HONO_PARAM_PATTERN, '{$1}');

const INFRASTRUCTURE_PATHS = new Set(['/*', '/api/*', '/openapi.json', '/docs']);

function isCoveredRoute(method: string, path: string): boolean {
  if (method === 'ALL' || method === 'OPTIONS') return false;
  if (INFRASTRUCTURE_PATHS.has(path)) return false;
  if (path.startsWith('/api/restaurant-test') && ![
    '/api/restaurant-test/menus/:id/payment',
    '/api/restaurant-test/assignment-settings',
    '/api/restaurant-test/table-auto-assignment-settings',
    '/api/restaurant-test/store-groups', '/api/restaurant-test/store-groups/:id/members/:storeId', '/api/restaurant-test/stores/:id/referral-location',
    '/api/restaurant-test/closures', '/api/restaurant-test/closures/preview', '/api/restaurant-test/closures/:id',
    '/api/restaurant-test/availability', '/api/restaurant-test/google/hours/from-closure',
    '/api/restaurant-test/closures/:id/contact-status', '/api/restaurant-test/close-notification-settings',
    '/api/restaurant-test/opening-hours', '/api/restaurant-test/reservation-link',
    '/api/restaurant-test/followups/:storeId',
    '/api/restaurant-test/followups/:storeId/steps/:stepId/messages',
    '/api/restaurant-test/followups/:storeId/review-history',
    '/api/restaurant-test/followups/:storeId/bindings/:stepId',
    '/api/restaurant-test/followups/:storeId/request-start',
    '/api/restaurant-test/followups/:storeId/stop',
    '/api/restaurant-test/reservations/:id',
    '/api/restaurant-test/reservations/:id/confirmations',
    '/api/restaurant-test/channel-close-tasks',
    '/api/restaurant-test/channel-close-tasks/:id/opened',
    '/api/restaurant-test/google/reviews/:id/draft/generate',

  ].includes(path)) return false;
  if (path.startsWith('/api/internal')) return false;
  if (path.startsWith('/admin/update')) return false;
  return (
    path.startsWith('/api/') ||
    path === '/webhook' ||
    path === '/admin/version' ||
    path === '/admin/manifest'
  );
}

type InventoryEntry = { key: string; method: string; openApiPath: string; honoPath: string };

function mountedInventory(): Map<string, InventoryEntry> {
  const inventory = new Map<string, InventoryEntry>();
  for (const route of app.routes) {
    if (!isCoveredRoute(route.method, route.path)) continue;
    const openApiPath = toOpenApiPath(route.path);
    const key = `${route.method} ${openApiPath}`;
    if (!inventory.has(key)) {
      inventory.set(key, { key, method: route.method, openApiPath, honoPath: route.path });
    }
  }
  return inventory;
}

type Operation = {
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  responses?: Record<string, { description?: string }>;
  security?: Array<Record<string, unknown>>;
};

type OpenApiSpec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  security?: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, Operation>>;
  components?: { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
};

async function loadSpec(): Promise<OpenApiSpec> {
  const res = await app.request('/openapi.json');
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiSpec;
}

const OPERATION_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

function documentedKeys(spec: OpenApiSpec): Map<string, { method: string; path: string }> {
  const keys = new Map<string, { method: string; path: string }>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!OPERATION_METHODS.has(method) || operation == null) continue;
      keys.set(`${method.toUpperCase()} ${path}`, { method: method.toUpperCase(), path });
    }
  }
  return keys;
}

function formatKeys(keys: string[]): string {
  const shown = keys.slice(0, 30).join('\n  ');
  return keys.length > 30 ? `  ${shown}\n  ほか ${keys.length - 30} 件` : `  ${shown}`;
}

/** 未記載負債はこの件数より増やせない。 */
const ALLOWLIST_MAX = 769;

/**
 * 記載済み operation の完全な基準一覧。
 *
 * 件数の下限もこの Set の size から導く。別の数値定数を置くと、OpenAPI を
 * 増やしたときに片方だけ更新され、後退を見逃すため。既存仕様を ALLOWLIST
 * へ移した場合も、新しい記載をここへ足し忘れた場合もテストで落とす。
 * 後続票で記載を増やしたら、同じ PR でここへ追加する。
 */
const BASELINE_DOCUMENTED = new Set<string>([
  'GET /api/hq/billing/musubo/last-line-end',
  'POST /api/hq/billing/musubo/last-line-end',
  'GET /api/hq/billing/musubo/line-addition',
  'POST /api/hq/billing/musubo/line-addition',
  'GET /api/hq/onboarding/pricing',
  'GET /api/hq/onboarding/quotes/latest',
  'GET /api/hq/onboarding/quotes/{id}',
  'GET /api/ops/applications/{applicationId}/quotes',
  'GET /api/ops/applications/{applicationId}/quotes/{id}/mail-preview',
  'GET /api/ops/pricing-conditions',
  'POST /api/hq/onboarding/pricing',
  'POST /api/hq/onboarding/quotes/{id}/accept',
  'POST /api/ops/applications/{applicationId}/quotes',
  'POST /api/ops/applications/{applicationId}/quotes/{id}/send',
  'POST /api/ops/pricing-conditions',
  'PUT /api/ops/applications/{applicationId}/quotes/{id}',
  'PUT /api/ops/pricing-conditions/{id}',
  'GET /api/forms/{id}/images/{blockId}',
  'GET /api/liff/events',
  'POST /api/liff/tracked-link-identity',
  'GET /api/booking/admin/menus/photos',
  'GET /api/liff/booking/store-photos',
  'PUT /api/booking/admin/menus/{id}/photo',
  'PUT /api/booking/admin/staff/{id}/photo',
  'PUT /api/booking/admin/store-photos',
  "GET /api/booking/admin/bookings/{id}",
  'GET /api/ops/staging-qa/safety',
  'GET /api/ops/staging-qa/runs',
  'POST /api/ops/staging-qa/runs',
  'GET /api/ops/staging-qa/runs/{id}',
  'DELETE /api/ops/staging-qa/runs/{id}',
  'POST /api/ops/staging-qa/runs/{id}/friends',
  'POST /api/ops/staging-qa/runs/{id}/session',
  'POST /api/ops/staging-qa/runs/{id}/cron',
  "GET /api/ai-answer-logs",
  "GET /api/ai-answer-logs/{id}",
  "GET /api/ai-features",
  "GET /api/analytics/customer-segments",
  "GET /api/analytics/customer-segments/cells/{r}/{f}/friends",
  "GET /api/booking/admin/bookings/{id}/group",
  "GET /api/booking/admin/bookings/{id}/payment-method",
  "GET /api/booking/admin/bookings/{id}/series",
  "GET /api/booking/admin/cancellation-options",
  "GET /api/booking/admin/deposit-rules",
  "GET /api/booking/admin/meeting-capabilities",
  "GET /api/booking/admin/menus/{id}/deposit",
  "GET /api/booking/admin/pass-notices",
  "GET /api/booking/admin/pass-plans",
  "GET /api/booking/admin/pass-plans/{id}/holders",
  "GET /api/booking/admin/pass-plans/{id}/notice-settings",
  "GET /api/booking/admin/pass-purchases",
  "GET /api/broadcasts/{id}/simulation",
  "GET /api/delivery-purposes",
  "GET /api/ec/auto-line/rules",
  "GET /api/ec/auto-line/sends",
  "GET /api/ec/auto-line/sends/{id}",
  "GET /api/ec/auto-line/stats",
  "GET /api/friends/{id}/delivery-consents/history",
  "GET /api/friends/{id}/member-rank",
  "GET /api/hq/store-comparison",
  "GET /api/hq/store-comparison/exports/{id}",
  "GET /api/hq/store-comparison/exports/{id}/download",
  "GET /api/hq/store-comparison/{accountId}",
  "GET /api/liff/booking/cost-estimate",
  "GET /api/liff/booking/group-availability",
  "GET /api/liff/booking/pass-purchases/{id}",
  "GET /api/liff/booking/series/preview",
  "GET /api/liff/member-card",
  "GET /api/line-accounts/{id}/sender-icons",
  "GET /api/mcp-connections",
  "GET /api/mcp-connections/logs",
  "GET /api/member-ranks/notices",
  "GET /api/member-ranks/program",
  "POST /api/ai-settings/simulate",
  "POST /api/ai-settings/test",
  "POST /api/analytics/customer-segments/cells/{r}/{f}/saved-search",
  "POST /api/booking/admin/bookings/{id}/group/cancel",
  "POST /api/booking/admin/groups",
  "POST /api/booking/admin/groups/{id}/cancel",
  "POST /api/booking/admin/pass-notices/simulate",
  "POST /api/booking/admin/pass-plans",
  "POST /api/booking/admin/pass-plans/{id}/start",
  "POST /api/booking/admin/pass-plans/{id}/stop",
  "POST /api/booking/admin/pass-purchases/simulate-event",
  "POST /api/booking/admin/series/{id}/impact",
  "POST /api/booking/pass-payments/webhook",
  "POST /api/broadcasts/simulation-drafts",
  "POST /api/broadcasts/{id}/simulate-send",
  "POST /api/chats/{id}/ai/typing",
  "POST /api/dashboard/style/starter-items/{key}/accept-update",
  "POST /api/dashboard/style/starter-items/ensure",
  "POST /api/delivery-purposes/preview",
  "POST /api/ec/auto-line/attribution/simulate",
  "POST /api/ec/auto-line/rules/{kind}/enable",
  "POST /api/ec/auto-line/rules/{kind}/test",
  "POST /api/ec/auto-line/simulate",
  "POST /api/ec/events",
  "POST /api/hq/store-comparison/export",
  "POST /api/hq/style-starter-sets/{style}/distribute",
  "POST /api/hq/style-starter-sets/{style}/preflight",
  "POST /api/hq/style-starter-sets/{style}/reset",
  "POST /api/inbox/routing/apply-unassigned",
  "POST /api/liff/booking/pass-plans/{id}/checkout",
  "POST /api/liff/booking/series/preview",
  "POST /api/mcp-connections",
  "POST /api/mcp-connections/{id}/rotate",
  "POST /api/mcp-connections/{id}/stop",
  "POST /api/member-ranks/activate",
  "POST /api/member-ranks/notices/simulate",
  "POST /api/member-ranks/preview",
  "POST /api/member-ranks/stop",
  "PUT /api/ai-features/{feature}",
  "PUT /api/analytics/customer-segments/cells/{r}/{f}/name",
  "PUT /api/booking/admin/cancellation-options",
  "PUT /api/booking/admin/deposit-rules",
  "PUT /api/booking/admin/menus/{id}/deposit",
  "PUT /api/booking/admin/pass-plans/{id}",
  "PUT /api/booking/admin/pass-plans/{id}/notice-settings",
  "PUT /api/broadcasts/{id}/simulation-draft",
  "PUT /api/ec/auto-line/rules/{kind}",
  "PUT /api/me/presence",
  "PUT /api/member-ranks/program",
  "PUT /api/member-ranks/tiers",

  "DELETE /api/broadcasts/{id}/ab-test",
  "DELETE /api/line-accounts/{id}/senders/{senderId}",
  "DELETE /api/me/push/subscriptions/{id}",
  "DELETE /api/qa-entries/{id}",
  "GET /api/ai-settings",
  "GET /api/booking/admin/bookings/{id}/charges",
  "GET /api/booking/admin/calendar-sync",
  "GET /api/booking/admin/cancellation-policy",
  "GET /api/booking/admin/makeup-credits",
  "GET /api/booking/admin/menus/preview-as",
  "GET /api/booking/admin/menus/{id}/meeting-url",
  "GET /api/booking/admin/routing-staff-groups",
  "GET /api/booking/admin/series/{id}",
  "GET /api/booking/admin/staff/{id}/calendar-sync",
  "GET /api/booking/admin/staff/{id}/meeting-url",
  "GET /api/broadcasts/{id}/ab-result",
  "GET /api/broadcasts/{id}/send-preview",
  "GET /api/hq/broadcasts/{id}/send-preview",
  "GET /api/inbox/routing-settings",
  "GET /api/liff/booking/cancellation-quote",
  "GET /api/liff/booking/menus/{id}/addons",
  "GET /api/liff/events/makeup-credits",
  "GET /api/liff/events/makeup-credits/{id}/options",
  "GET /api/line-accounts/{id}/senders",
  "GET /api/me/push",
  "GET /api/qa-entries",
  "PATCH /api/booking/admin/series/{id}",
  "POST /api/booking/admin/bookings/{id}/calendar/rewrite",
  "POST /api/booking/admin/bookings/{id}/charges",
  "POST /api/booking/admin/bookings/{id}/meeting",
  "POST /api/booking/admin/calendar-sync/retry",
  "POST /api/booking/admin/charges/{id}/refund",
  "POST /api/booking/admin/charges/{id}/waive",
  "POST /api/booking/admin/series",
  "POST /api/booking/admin/series/preview",
  "POST /api/booking/admin/series/{id}/cancel",
  "POST /api/broadcasts/{id}/ab-test/choose",
  "POST /api/chats/{id}/ai/draft",
  "POST /api/chats/{id}/ai/summary",
  "POST /api/events/admin/bookings/{id}/absence",
  "POST /api/forms/{id}/routing/preview",
  "POST /api/liff/booking/setup-intent",
  "POST /api/liff/booking/setup-webhook",
  "POST /api/liff/events/bookings/{id}/absence",
  "POST /api/liff/events/makeup-credits/{id}/use",
  "POST /api/liff/forms/{id}/routing/resolve",
  "POST /api/line-accounts/{id}/senders",
  "POST /api/me/push/subscriptions",
  "POST /api/me/push/test",
  "POST /api/qa-entries",
  "POST /api/qa-entries/{id}/publish",
  "POST /api/qa-entries/{id}/stop",
  "PUT /api/ai-settings",
  "PUT /api/booking/admin/calendar-sync",
  "PUT /api/booking/admin/cancellation-policy",
  "PUT /api/booking/admin/menus/{id}/meeting-url",
  "PUT /api/booking/admin/routing-staff-groups/{id}",
  "PUT /api/booking/admin/staff/{id}/calendar-sync",
  "PUT /api/booking/admin/staff/{id}/meeting-url",
  "PUT /api/broadcasts/{id}/ab-test",
  "PUT /api/broadcasts/{id}/variants/{key}",
  "PUT /api/events/admin/{id}/makeup-rule",
  "PUT /api/inbox/routing-settings",
  "PUT /api/line-accounts/{id}/senders/{senderId}",
  "PUT /api/me/push/preferences",
  "PUT /api/qa-entries/{id}",

  'GET /api/account-settings/personal-data-retention',
  'PUT /api/account-settings/personal-data-retention',
  'GET /api/liff/files/{id}/download',
  'GET /api/operations/security-alerts',
  'GET /api/ops/security-alerts',
  'POST /api/ops/security-alerts/run-once',
  'POST /api/operations/security-alerts/{id}/acknowledge',
  'POST /api/operations/security-alerts/{id}/resolve',
  'POST /api/ops/security-alerts/{id}/acknowledge',
  'POST /api/ops/security-alerts/{id}/resolve',
  'DELETE /api/dashboard/style/cards',
  'GET /api/dashboard/style',
  'GET /api/dashboard/style/analytics',
  'GET /api/dashboard/style/analytics-settings',
  'GET /api/dashboard/style/bookings',
  'GET /api/dashboard/style/bookings/{id}',
  'GET /api/dashboard/style/classes/{id}',
  'GET /api/dashboard/style/ec-summary',
  'GET /api/dashboard/style/members',
  'GET /api/dashboard/style/menus/{id}',
  'GET /api/dashboard/style/people',
  'GET /api/dashboard/style/resources',
  'GET /api/dashboard/style/schedule',
  'GET /api/dashboard/style/starter-items',
  'GET /api/dashboard/style/starter-set',
  'GET /api/dashboard/style/summary',
  'GET /api/dashboard/style/template-samples',
  'GET /api/dashboard/style/warnings',
  'GET /api/hq/style-attention',
  'GET /api/hq/style-starter-sets',
  'GET /api/hq/style-starter-sets/catalog',
  'GET /api/hq/style-starter-sets/catalog/{templateId}/versions/{versionId}',
  'GET /api/hq/style-starter-sets/{style}/default',
  'GET /api/hq/style-template-samples',
  'GET /api/liff/booking/style-readiness',
  'PATCH /api/dashboard/style/bookings/{id}',
  'PATCH /api/dashboard/style/classes/{id}',
  'PATCH /api/dashboard/style/event-bookings/{id}',
  'PATCH /api/dashboard/style/event-waitlist/{id}',
  'PATCH /api/dashboard/style/events/{id}',
  'PATCH /api/dashboard/style/meet/{id}',
  'PATCH /api/dashboard/style/menus/{id}',
  'PATCH /api/dashboard/style/restaurant-reservations/{id}',
  'POST /api/dashboard/style/activate',
  'POST /api/dashboard/style/closures',
  'POST /api/dashboard/style/results/{id}/audiences',
  'POST /api/liff/booking/page-views',
  'PUT /api/dashboard/style',
  'PUT /api/dashboard/style/cards',
  'PUT /api/dashboard/style/holidays/{date}',
  'PUT /api/dashboard/style/members/{friendId}',
  'PUT /api/dashboard/style/targets',
  'PUT /api/hq/style-starter-sets/{style}',
  'GET /api/hq/templates/{id}/distribution-targets',
  'GET /api/hq/templates/resources',
  'GET /api/liff/notification-preferences',
  'PUT /api/liff/notification-preferences/{purpose}',
  'DELETE /api/hq/broadcasts/saved-views/{viewId}',
  'DELETE /api/hq/templates/{id}/test-tokens/{tokenId}',
  'POST /api/forms/{id}/exports',
  'POST /api/mileage/exports',
  'GET /api/operations/security-alerts',
  'GET /api/ops/security-alerts',
  'POST /api/ops/security-alerts/run-once',
  'POST /api/operations/security-alerts/{id}/acknowledge',
  'POST /api/operations/security-alerts/{id}/resolve',
  'POST /api/ops/security-alerts/{id}/acknowledge',
  'POST /api/ops/security-alerts/{id}/resolve',
  'GET /api/hq/billing/metrics',
  'GET /api/hq/broadcasts/quota',
  'GET /api/hq/broadcasts/saved-views',
  'GET /api/hq/broadcasts/{id}/reactions',
  'GET /api/hq/templates/media',
  'GET /api/liff/hq-form-tests/{id}',
  'PATCH /api/hq/broadcasts/saved-views/{viewId}',
  'POST /api/hq/broadcasts/saved-views',
  'POST /api/hq/broadcasts/{id}/duplicate',
  'POST /api/hq/broadcasts/{id}/followup',
  'POST /api/hq/templates/rich-menu-preview',
  'POST /api/hq/templates/tags/import',
  'POST /api/hq/templates/tags/import/preview',
  'POST /api/hq/templates/{id}/test-send',
  'POST /api/hq/templates/{id}/test-token',
  'POST /api/hq/templates/{id}/restore',
  'POST /api/liff/hq-form-tests/{id}/submit',
  'GET /api/webhooks/interactions/export.csv',
  'POST /api/reminders/{id}/message-preview',
  'GET /api/friends/{id}/delivery-consents',
  'PUT /api/friends/{id}/delivery-consents/{purpose}',
  'GET /api/hq/support/summary',
  'GET /api/manual-links/lookup',
  'GET /api/restaurant-test/channel-close-tasks',
  'POST /api/restaurant-test/channel-close-tasks/{id}/opened',
  'POST /api/restaurant-test/google/reviews/{id}/draft/generate',
  'PUT /api/booking/admin/channels/{channel}/settings',
  'GET /api/booking/admin/payment-connection',
  'DELETE /api/booking/admin/payment-connection',
  'GET /api/booking/admin/payment-connection/callback',
  'POST /api/booking/admin/payment-connection/authorize',
  'POST /api/booking/admin/payment-connection/callback',
  'GET /api/booking/admin/menu-payments',
  'GET /api/booking/admin/payments',
  'GET /api/booking/admin/payments/export',
  'GET /api/booking/admin/staff/today-counts',
  'POST /api/booking/admin/payments/{id}/send-link',
  'GET /api/booking/admin/payment-events',
  'POST /api/booking/admin/payment-events/{id}/replay',
  'GET /api/events/admin/events/{id}/payment',
  'PUT /api/events/admin/events/{id}/payment',
  'GET /api/events/admin/events/{id}/price',
  'PUT /api/events/admin/events/{id}/price',
  'GET /api/restaurant-test/menus/{id}/payment',
  'PUT /api/restaurant-test/menus/{id}/payment',
  'POST /api/liff/booking/requests',
  'GET /api/booking/admin/monthly-contracts',
  'GET /api/liff/booking/monthly-contracts',
  'GET /api/booking/admin/entitlements',
  'POST /api/booking/admin/entitlements',
  'POST /api/booking/admin/entitlements/{id}/operations',
  'GET /api/booking/admin/entitlements/{id}/history',
  'GET /api/liff/booking/entitlements',
  'GET /api/booking/admin/assignment-settings',
  'PUT /api/booking/admin/assignment-settings',
  'GET /api/restaurant-test/assignment-settings',
  'PUT /api/restaurant-test/assignment-settings',
  'GET /api/restaurant-test/table-auto-assignment-settings',
  'PUT /api/restaurant-test/table-auto-assignment-settings',
  'GET /api/hq/templates/media',
  'GET /api/hq/templates/resources',
  'GET /api/hq/templates/{id}/distribution-targets',
  'POST /api/hq/templates/rich-menu-preview',
  'POST /api/hq/templates/{id}/test-send',
  'GET /api/hq/templates/saved-views',
  'POST /api/hq/templates/saved-views',
  'PATCH /api/hq/templates/saved-views/{viewId}',
  'DELETE /api/hq/templates/saved-views/{viewId}',
  'GET /api/auth/api-key',
  'POST /api/auth/api-key',
  'DELETE /api/auth/api-key',
  'GET /api/auth/two-factor/policy',
  'GET /api/auth/two-factor/self',
  'GET /api/auth/passkeys/self',
  'DELETE /api/auth/passkeys/self',
  'POST /api/auth/passkeys/register/options',
  'POST /api/auth/passkeys/register/verify',
  'GET /api/line-accounts/profile-pictures',
  'GET /api/ops/applications',
  'GET /api/ops/applications/{id}',
  'POST /api/ops/applications/{id}/approve',
  'POST /api/ops/applications/{id}/contact',
  'POST /api/ops/applications/{id}/resend-invite',
  'POST /api/ops/notice-line-account/connect',
  'PUT /api/auth/two-factor/policy',
  'GET /api/images/{key}',
  'GET /api/account-settings/allergy-options',
  'PUT /api/account-settings/allergy-options',
  'GET /api/account-settings/customer-look',
  'PUT /api/account-settings/customer-look',
  'GET /api/liff/customer-look',
  'GET /api/liff/restaurant/courses',
  'GET /api/liff/restaurant/referrals',
  'POST /api/liff/restaurant/referrals',
  'POST /api/liff/restaurant/form-booking',
  'GET /api/restaurant-test/store-groups',
  'POST /api/restaurant-test/store-groups',
  'PATCH /api/restaurant-test/store-groups/{id}/members/{storeId}',
  'PUT /api/restaurant-test/stores/{id}/referral-location',
  'PATCH /api/restaurant-test/reservations/{id}',
  'GET /api/restaurant-test/followups/{storeId}',
  'PUT /api/restaurant-test/followups/{storeId}/steps/{stepId}/messages',
  'GET /api/restaurant-test/followups/{storeId}/review-history',
  'POST /api/restaurant-test/followups/{storeId}/bindings/{stepId}',
  'PATCH /api/restaurant-test/followups/{storeId}/bindings/{stepId}',
  'DELETE /api/restaurant-test/followups/{storeId}/bindings/{stepId}',
  'POST /api/restaurant-test/followups/{storeId}/request-start',
  'POST /api/restaurant-test/followups/{storeId}/stop',
  'GET /api/restaurant-test/reservations/{id}',
  'GET /api/restaurant-test/reservations/{id}/confirmations',
  'POST /api/liff/restaurant/confirmations/{requestId}/respond',

  'GET /api/traffic-pools/{id}',
  'PUT /api/traffic-pools/{id}',
  'DELETE /api/visit-stamps/staff-qr/{id}',
  'GET /api/visit-stamps/cards/{id}/storefront-qr',
  'GET /api/visit-stamps/staff-qr/{id}',
  'POST /api/liff/visit-stamps/qr/redeem',
  'POST /api/visit-stamps/cards/{id}/staff-qr',
  'POST /api/visit-stamps/cards/{id}/storefront-qr',
  'DELETE /api/forms/{id}/submissions/{submissionId}',
  'DELETE /api/friends/{id}/data',
  'GET /api/booking/admin/board',
  'PATCH /api/booking/admin/board/{id}',
  'POST /api/tags/{id}/restore',
  'POST /api/support-marks/{id}/restore',
  'POST /api/automations/{id}/restore',
  'GET /api/form-files/{id}/content',
  'GET /api/forms/document-settings/{accountId}',
  'PUT /api/forms/document-settings/{accountId}',
  'POST /api/forms/{id}/files',
  'POST /api/hq/templates/media/upload-sessions',
  'POST /api/hq/templates/media/upload-sessions/{id}/complete',
  'DELETE /api/hq/templates/media/upload-sessions/{id}',
  'POST /api/entry-routes/{id}/qr-image',
  'POST /api/liff/entry-route-coupon',
  'POST /api/liff/entry-route-coupon/use',
  'POST /api/events/admin/events/{id}/duplicate',
  'POST /api/friend-add-rules/{id}/duplicate',
  'POST /api/friend-add-rules/{id}/unarchive',
  "GET /api/hq/banners/folders",
  "POST /api/hq/banners/folders",
  "PATCH /api/hq/banners/folders/{id}",
  "DELETE /api/hq/banners/folders/{id}",
  "POST /api/hq/banners/folders/{id}/swap-order",
  "POST /api/hq/templates/folders/{id}/swap-order",
  "POST /api/hq/broadcasts/folders/{id}/swap-order",
  'DELETE /api/friend-add-rules/folders/{id}',
  'GET /api/scenarios/{id}/question-answers',
  'POST /api/scenarios/{id}/question-answers/{executionId}/resume',
  'GET /api/automations/counts',
  'GET /api/media/counts',
  'GET /api/conversions/approvals/counts',
  'PUT /api/booking/admin/menus/order',
  'GET /api/tenants/me/company-contact',
  'PATCH /api/tenants/me/company-contact',
  'GET /api/hq/templates/attribute-kind-counts',
  'GET /api/hq/templates/{id}/versions',
  'GET /api/hq/templates/{id}/versions/compare',
  'POST /api/hq/templates/{id}/versions/{version}/restore',
  'GET /api/hq/templates/{id}/received-versions',
  'GET /api/hq/broadcasts/folders',
  'POST /api/hq/broadcasts/folders',
  'PATCH /api/hq/broadcasts/folders/{id}',
  'DELETE /api/hq/broadcasts/folders/{id}',
  'GET /api/hq/broadcasts/approvals/candidates',
  'GET /api/hq/broadcasts/{id}/approval',
  'POST /api/hq/broadcasts/{id}/approval-request',
  'POST /api/hq/broadcasts/{id}/approve',
  'POST /api/hq/broadcasts/{id}/reject',
  'POST /api/hq/broadcasts/{id}/approval-cancel',
  'POST /api/hq/broadcasts/{id}/test-send',
  'GET /api/hq/broadcasts/{id}/targets/{accountId}/recipients',
  'GET /api/hq/broadcasts/{id}/activity',
  'GET /api/hq/broadcasts/{id}/export.csv',

  'POST /api/chats/{id}/send',
  'POST /api/chats/{id}/attachments/upload',
  'POST /api/chats/{id}/attachments/upload-sessions',
  'POST /api/chats/{id}/attachments/upload-sessions/{sessionId}/complete',
  'GET /api/line-account-folders',
  'POST /api/line-account-folders',
  'PATCH /api/line-account-folders/{id}',
  'DELETE /api/line-account-folders/{id}',
  'PUT /api/line-accounts/{id}/folder',
  'GET /api/hq/templates/kind-counts',
  'GET /api/restaurant-test/opening-hours',
  'PUT /api/restaurant-test/opening-hours',
  'POST /api/restaurant-test/reservation-link',
  'GET /api/liff/visit-stamps/cards/{id}/paper-requests',
  'GET /api/liff/visit-stamps/paper-photos/{id}',
  'GET /api/restaurant-test/close-notification-settings',
  'GET /api/restaurant-test/closures/{id}/contact-status',
  'GET /api/visit-stamps/entries',
  'GET /api/visit-stamps/paper-photos/{id}',
  'PATCH /api/hq/broadcasts/{id}',
  'POST /api/liff/visit-stamps/cards/{id}/paper-photos',
  'PUT /api/restaurant-test/close-notification-settings',

  'GET /api/scenario-drafts/{key}',
  'PUT /api/scenario-drafts/{key}',
  'DELETE /api/scenario-drafts/{key}',
  'GET /api/chats/{friendId}/messages/search',
  'GET /api/chats/{friendId}/messages',
  'GET /api/liff/restaurant/link/{token}',
  'GET /api/liff/restaurant/availability',
  'POST /api/liff/restaurant/holds',
  'GET /api/liff/restaurant/reservations',
  'POST /api/liff/restaurant/reservations/{id}/confirm',
  'POST /api/liff/restaurant/reservations/{id}/cancel',
  'POST /api/liff/restaurant/reservations/{id}/reschedule',
  'GET /api/auto-replies/unmatched-settings',
  'PUT /api/auto-replies/unmatched-settings',
  'GET /api/instagram/connection',
  'DELETE /api/instagram/connection',
  'POST /api/instagram/oauth/start',
  'GET /api/instagram/oauth/callback',
  'POST /api/instagram/refresh',
  'POST /api/instagram/sync',
  'GET /api/instagram/profile',
  'GET /api/instagram/posts',
  'GET /api/instagram/messages',
  'POST /api/instagram/messages/{id}/reply',
  'GET /api/instagram/webhook',
  'POST /api/instagram/webhook',
  'GET /api/booking/admin/sync-rules',
  'PUT /api/booking/admin/sync-rules',
  'GET /api/booking/admin/sync-notices',
  'POST /api/booking/admin/sync-notices/{id}/done',
  'GET /api/mileage/reward-folders',
  'POST /api/mileage/reward-folders',
  'PUT /api/mileage/reward-folders/order',
  'PUT /api/mileage/rewards/{id}/folder',
  'POST /api/broadcast-message-assets/upload-sessions',
  'POST /api/broadcast-message-assets/upload-sessions/{id}/complete',
  'DELETE /api/restaurant-test/closures/{id}',
  'GET /api/liff/booking/seat-availability',
  'GET /api/restaurant-test/availability',
  'GET /api/restaurant-test/closures',
  'PATCH /api/restaurant-test/closures/{id}',
  'POST /api/restaurant-test/closures',
  'POST /api/restaurant-test/closures/preview',
  'POST /api/restaurant-test/google/hours/from-closure',
  // V8 integration endpoints.
  'GET /api/visit-stamps/cards',
  'POST /api/visit-stamps/cards',
  'PUT /api/visit-stamps/cards/{id}',
  'GET /api/visit-stamps/cards/{id}/wallet',
  'POST /api/visit-stamps/cards/{id}/grants',
  'POST /api/visit-stamps/entries/{id}/reverse',
  'PUT /api/visit-stamps/pins/{staffId}',
  'GET /api/visit-stamps/paper-requests',
  'POST /api/visit-stamps/paper-requests/{id}/review',
  'POST /api/visit-stamps/visits/{kind}/{id}/checkout',
  'GET /api/liff/visit-stamps/cards',
  'GET /api/liff/visit-stamps/cards/{id}',
  'POST /api/liff/visit-stamps/cards/{id}/rewards',
  'POST /api/liff/visit-stamps/redemptions/{id}/use',
  'POST /api/liff/visit-stamps/cards/{id}/paper-requests',
  'GET /api/hq/broadcasts',
  'POST /api/hq/broadcasts',
  'GET /api/hq/broadcasts/{id}',
  'POST /api/hq/broadcasts/{id}/preflight',
  'PUT /api/hq/broadcasts/{id}/exclusions',
  'POST /api/hq/broadcasts/{id}/send',
  'POST /api/hq/broadcasts/{id}/stop',
  'POST /api/hq/broadcasts/{id}/cancel',
  'GET /api/hq/broadcasts/{id}/targets/{accountId}/retry-preview',
  'POST /api/hq/broadcasts/{id}/targets/{accountId}/retry',
  'GET /api/dashboard/activity',
  'GET /api/forms/{id}/submissions/{submissionId}',
  'GET /api/friends/{id}/summary',
  'DELETE /api/hq/templates/folders/{id}',
  'DELETE /api/notifications/teams/{id}',
  'GET /api/ad-platforms/mappings',
  'GET /api/hq/templates/folders',
  'GET /api/hq/templates/message-references',
  'GET /api/nen-members/photos/publications/order',
  'GET /api/notifications/teams',
  'PATCH /api/hq/templates/folders/{id}',
  'POST /api/ad-platforms/logs/{id}/retry',
  'POST /api/ad-platforms/{id}/connect',
  'POST /api/events/admin/application-preview',
  'POST /api/hq/templates/folders',
  'POST /api/hq/templates/{id}/duplicate',
  'POST /api/nen-members/photos/{id}/publish',
  'POST /api/notifications/teams',
  'PUT /api/ad-platforms/mappings/{pointId}',
  'PUT /api/nen-members/photos/publications/order',
  'PUT /api/notifications/teams/{id}',

  'DELETE /api/affiliates/{id}',
  'DELETE /api/auth/sessions/{tokenHash}',
  'DELETE /api/booking/admin/bookings/{id}/visit',
  'DELETE /api/booking/admin/exceptions/{id}',
  'DELETE /api/booking/admin/friends/{friendId}/prepay',
  'DELETE /api/booking/admin/menus/{id}/payment',
  'DELETE /api/booking/admin/resources/{id}',
  'DELETE /api/booking/admin/waitlist/{id}',
  'DELETE /api/broadcasts/{id}',
  'DELETE /api/chats/{id}/scheduled/{scheduleId}',
  'DELETE /api/conversions/points/{id}',
  'DELETE /api/friends/{id}/tags/{tagId}',
  'DELETE /api/file-scans/{id}',
  'DELETE /api/hq/banners/images/{id}',
  'DELETE /api/hq/templates/media',
  'DELETE /api/hq/templates/{id}',
  'DELETE /api/liff/booking/waitlist/{id}',
  'DELETE /api/line-account-tags/{id}',
  'DELETE /api/line-accounts/{id}',
  'DELETE /api/mileage/rules/{id}',
  'DELETE /api/ops/announcements/{id}',
  'DELETE /api/reminders/{id}/steps/{stepId}',
  'DELETE /api/scenarios/{id}',
  'DELETE /api/scenarios/{id}/steps/{stepId}',
  'DELETE /api/tags/{id}',
  'DELETE /api/users/{id}',
  'GET /api/accounts/health-summary',
  'GET /api/account-handovers/{id}',
  'GET /api/ad-costs',
  'GET /api/affiliate-offers/{id}/cap-status',
  'GET /api/affiliate-offers/{id}/versions',
  'GET /api/affiliates',
  'GET /api/affiliates/{id}',
  'GET /api/affiliates/{id}/report',
  'GET /api/auto-replies',
  'GET /api/automation-runs/{id}',
  'GET /api/auth/ops-invite/check',
  'GET /api/auth/password/reset/check',
  'GET /api/auth/register/check',
  'GET /api/auth/sessions',
  'GET /api/booking/admin/availability-check',
  'GET /api/booking/admin/bookings.csv',
  'GET /api/booking/admin/bookings/{id}/audit-logs',
  'GET /api/booking/admin/friends/{friendId}/noshow',
  'GET /api/booking/admin/last-booking',
  'GET /api/booking/admin/noshow-settings',
  'GET /api/booking/admin/sales-summary',
  'GET /api/booking/admin/today',
  'GET /api/booking/admin/waitlist',
  'GET /api/booking/admin/staff-menus',
  'GET /api/booking/admin/staff/{id}/break-dates',
  'GET /api/booking/admin/staff/{id}/breaks',
  'GET /api/booking/admin/resources',
  'GET /api/booking/admin/settings',
  'GET /api/broadcast-message-assets/counts',
  'GET /api/broadcasts',
  'GET /api/broadcasts/approval-config',
  'GET /api/broadcasts/approval-threshold',
  'GET /api/broadcasts/approvals/candidates',
  'GET /api/broadcasts/{id}',
  'GET /api/broadcasts/{id}/activity',
  'GET /api/broadcasts/{id}/approval',
  'GET /api/broadcasts/{id}/recipients',
  'GET /api/chats/outbound-failures',
  'GET /api/chats/quick-counts',
  'GET /api/chats/{id}/scheduled',
  'GET /api/common-actions/resources',
  'GET /api/common-vars/exports',
  'GET /api/common-vars/exports/{id}',
  'GET /api/common-vars/exports/{id}/download',
  'GET /api/conversions/definitions/{id}/events',
  'GET /api/conversions/definitions/{id}/ingest-events',
  'GET /api/conversions/events',
  'GET /api/conversions/events/{id}/attribution',
  'GET /api/conversions/events/{id}/reversals',
  'GET /api/conversions/points',
  'GET /api/conversions/report',
  'GET /api/dashboard/comparisons',
  'GET /api/dashboard/delivery-failure-origins',
  'GET /api/dashboard/upcoming',
  'GET /api/ec-commerce/orders/{id}',
  'GET /api/events/admin/events/{id}/occurrence-selector',
  'GET /api/events/admin/occurrences/{id}/applicants.csv',
  'GET /api/forms/unassigned',
  'GET /api/file-scans',
  'GET /api/file-scans/by-subject',
  'GET /api/file-scans/config',
  'GET /api/file-scans/for-media',
  'GET /api/file-scans/health',
  'GET /api/friends',
  'GET /api/friends/{friendId}/reminders',
  'GET /api/friends/{id}',
  'GET /api/friends/{id}/fields',
  'GET /api/friends/{id}/form-submissions',
  'GET /api/friends/{id}/upcoming',
  'GET /api/friends/count',
  'GET /api/hq/banners/generations/{id}',
  'GET /api/hq/banners/images',
  'GET /api/hq/banners/images/{id}',
  'GET /api/hq/banners/presets',
  'GET /api/hq/banners/projects',
  'GET /api/hq/banners/projects/{id}',
  'GET /api/hq/banners/stats',
  'GET /api/hq/banners/usage',
  'GET /api/hq/billing/invoices',
  'GET /api/hq/billing/card-status',
  'GET /api/hq/billing/payment-failure',
  'GET /api/hq/billing/summary',
  'GET /api/hq/support/context',
  'GET /api/hq/support/kinds',
  'GET /api/hq/notices',
  'GET /api/hq/notices/line-registration',
  'GET /api/hq/notices/line-registration/status',
  'GET /api/hq/support/requests',
  'GET /api/hq/support/requests/{id}',
  'GET /api/hq/templates',
  'GET /api/hq/templates/accounts',
  'GET /api/hq/templates/{id}',
  'GET /api/hq/templates/{id}/distributions/{runId}',
  'GET /api/hq/operator-history',
  'GET /api/integrations/google-sheets/connection',
  'GET /api/integrations/google-sheets/oauth/callback',
  'GET /api/integrations/google-sheets/runs',
  'GET /api/integrations/tiktok-pnl/status',
  'GET /api/line-accounts',
  'GET /api/line-accounts/{id}',
  'GET /api/line-accounts/{id}/registration-receipt',
  'GET /api/line-accounts/{id}/handovers',
  'GET /api/line-accounts/{id}/skipped-deliveries',
  'GET /api/line-accounts/summary',
  'GET /api/line-notifications/deliveries/{id}',
  'GET /api/line-notifications/operator-deliveries.csv',
  'GET /api/line-notifications/operator-event-types',
  'GET /api/line-notifications/operator-rules',
  'GET /api/line-notifications/operator-rules/{id}',
  'GET /api/line-notifications/quota',
  'GET /api/line-notifications/send-counts',
  'GET /api/measurement-sites',
  'GET /api/media/{id}',
  'GET /api/media/{id}/content',
  'GET /api/media/{id}/download',
  'GET /api/media/{id}/versions/{versionNo}/download',
  'POST /api/media/{id}/archive',
  'POST /api/media/{id}/restore',
  'GET /api/mileage/redemptions',
  'GET /api/mileage/rules',
  'GET /api/mileage/rules/export',
  'GET /api/nen/feeding-products',
  'GET /api/nen/health',
  'GET /api/nen/health/{petId}/summary',
  'GET /api/nen/members',
  'GET /api/nen/pets',
  'GET /api/nen/rank-settings',
  'GET /api/nen/rank-settings/member-sync/{operationId}',
  'POST /api/nen/rank-settings/member-sync/{operationId}/retry',
  'DELETE /api/nen/rank-settings/{id}',
  'GET /api/public/nen/adopted-photos',
  'GET /api/nen-campaigns/deliveries',
  'GET /api/nen-campaigns/deliveries/{id}',
  'GET /api/nen-campaigns/metrics/columns',
  'GET /api/nen-campaigns/metrics/flows',
  'GET /api/nen-campaigns/metrics/pets',
  'GET /api/nen-members/photo-reward-policy/versions',
  'POST /api/nen-campaigns/columns/import',
  'GET /api/notifications/operator-event-types',
  'GET /api/operations/alerts',
  'GET /api/operations/send-paths',
  'GET /api/ops/announcements',
  'GET /api/ops/audit',
  'GET /api/ops/dashboard',
  'GET /api/ops/dashboard/first-run',
  'GET /api/ops/dashboard/line-unregistered',
  'GET /api/ops/impersonation/current',
  'GET /api/ops/me',
  'GET /api/ops/notice-line-account',
  'GET /api/ops/members',
  'GET /api/ops/knowledge',
  'GET /api/ops/knowledge/{id}',
  'GET /api/ops/support/summary',
  'GET /api/ops/support/tickets',
  'GET /api/ops/support/tickets/{id}',
  'GET /api/ops/tenants',
  'GET /api/ops/tenants/{id}',
  'GET /api/reminders',
  'GET /api/reminders/{id}/registrants',
  'GET /api/reminders/{id}/test-recipient',
  'GET /api/scenarios',
  'GET /api/scenarios/{id}',
  'GET /api/scenarios/{id}/actions',
  'GET /api/scenarios/{id}/friends/{friendId}/plan',
  'GET /api/scenarios/{id}/preview',
  'GET /api/scenarios/{id}/runs',
  'GET /api/scenarios/{id}/stats',
  'GET /api/scenarios/{id}/triggers',
  'GET /api/scenarios/{id}/move-referrers',
  'GET /api/settings/company',
  'GET /api/settings/features/visibility',
  'GET /api/staff/last-logins',
  'GET /api/tags',
  'GET /api/tags/{id}',
  'GET /api/tags/{id}/delete-impact',
  'GET /api/tags/{id}/dependencies',
  'GET /api/users',
  'GET /api/users/{id}',
  'GET /api/users/{id}/accounts',
  'PATCH /api/hq/banners/images/{id}',
  'PATCH /api/booking/admin/bookings/{id}',
  'PATCH /api/booking/admin/resources/{id}',
  'PATCH /api/chats/{id}/scheduled/{scheduleId}',
  'PATCH /api/friend-add-rules/reorder',
  'PUT /api/friend-add-rules/order',
  'POST /api/friend-add-rules/{id}/test-send',
  'PATCH /api/friend-fields/reorder',
  'POST /api/folders/{id}/swap-order',
  'PATCH /api/saved-searches/reorder',
  'PATCH /api/support-marks/reorder',
  'PUT /api/booking/admin/menus/{id}/payment',
  'PUT /api/booking/admin/menus/{id}/resources',
  'GET /api/booking/admin/menus/{id}/versions',
  'GET /api/booking/admin/menus/{id}/versions/{version}',
  'POST /api/booking/admin/menus/{id}/versions/{version}/revert',
  'PUT /api/booking/admin/noshow-settings',
  'PATCH /api/hq/banners/projects/{id}',
  'PATCH /api/hq/templates/{id}',
  'PATCH /api/line-accounts/{id}',
  'PATCH /api/line-accounts/order',
  'PATCH /api/line-notifications/operator-rules/{id}/draft',
  'PATCH /api/ops/members/{staffId}',
  'PATCH /api/ops/support/tickets/{id}',
  'PATCH /api/ops/tenants/{id}/feature-packs',
  'PATCH /api/ops/tenants/{id}/status',
  'PATCH /api/reminders/{id}/registrants/{enrollmentId}',
  'PATCH /api/tags/{id}',
  'POST /api/action-scores/adjustments',
  'POST /api/action-scores/bands/preview',
  'POST /api/account-handovers',
  'POST /api/account-handovers/link',
  'POST /api/account-handovers/{id}/cancel',
  'POST /api/account-handovers/{id}/execute',
  'POST /api/account-handovers/{id}/preview',
  'POST /api/account-handovers/{id}/rollback',
  'POST /api/ad-costs',
  'POST /api/ad-costs/{id}/cancel',
  'POST /api/ad-platforms/{id}/cost-import',
  'POST /api/affiliate-offers/{id}/versions',
  'POST /api/affiliates',
  'POST /api/affiliates/click',
  'POST /api/auth/password/forgot',
  'POST /api/auth/password/login',
  'POST /api/auth/ops-invite/accept',
  'POST /api/auth/password/reset',
  'POST /api/auth/register/complete',
  'POST /api/auth/register/request',
  'POST /api/auth/register/resend-expired',
  'POST /api/auth/sessions/revoke-others',
  'POST /api/auth/step-up',
  'POST /api/auth/two-factor/setup',
  'POST /api/auth/two-factor/setup/confirm',
  'POST /api/auto-replies/{id}/restore',
  'POST /api/auto-replies/{id}/stop',
  'POST /api/auto-reply-runs/{id}/retry',
  'POST /api/automation-runs/{id}/cancel',
  'POST /api/automations/{id}/draft',
  'POST /api/automations/{id}/duplicate',
  'POST /api/automations/{id}/status',
  'POST /api/friend-add-runs/{id}/retry',
  'POST /api/booking/admin/bookings/{id}/notifications/{runId}/retry',
  'POST /api/booking/admin/bookings/{id}/sync/retry',
  'POST /api/booking/admin/bookings/{id}/visit',
  'POST /api/booking/admin/friends/{friendId}/prepay',
  'POST /api/booking/admin/resources',
  'POST /api/booking/admin/waitlist',
  'POST /api/booking/admin/waitlist/{id}/convert',
  'POST /api/booking/payments/start',
  'POST /api/booking/payments/webhook/{provider}',
  'POST /api/booking/stripe-test/webhook',
  'POST /api/booking/payments/{id}/refund',
  'GET /api/booking/payments/{id}/refunds',
  'POST /api/booking/payments/{id}/booking',
  'POST /api/broadcasts',
  'POST /api/broadcasts/{id}/approval-approve',
  'POST /api/broadcasts/{id}/approval-cancel',
  'POST /api/broadcasts/{id}/approval-reject',
  'POST /api/broadcasts/{id}/approval-remind',
  'POST /api/broadcasts/{id}/approval-request',
  'POST /api/broadcasts/{id}/cancel',
  'POST /api/broadcasts/{id}/resume',
  'POST /api/broadcasts/{id}/retry-failed',
  'POST /api/broadcasts/{id}/send',
  'POST /api/broadcasts/{id}/stop',
  'POST /api/broadcasts/dedup-preview',
  'POST /api/chats/{id}/render-preview',
  'POST /api/chats/{id}/send-combined',
  'POST /api/chats/{id}/schedule',
  'POST /api/common-actions/{id}/archive',
  'POST /api/common-actions/{id}/unarchive',
  'POST /api/common-vars/exports',
  'POST /api/common-vars/exports/{id}/regenerate',
  'POST /api/conversions/approvals/bulk',
  'POST /api/conversions/definitions/{id}/ingest-disable',
  'POST /api/conversions/definitions/{id}/ingest-enable',
  'POST /api/conversions/definitions/{id}/ingest-secret',
  'POST /api/conversions/definitions/{id}/publish',
  'POST /api/conversions/definitions/{id}/revise',
  'POST /api/conversions/events/{id}/reversals',
  'POST /api/conversions/ingest/{id}',
  'POST /api/conversions/points',
  'POST /api/conversions/track',
  'POST /api/entry-routes/{id}/qr-pdf',
  'POST /api/events/admin/occurrences/{id}/applicant-broadcasts/preview',
  'POST /api/events/admin/events/{id}/change-review',
  'POST /api/events/admin/events/{id}/change-review/apply',
  'POST /api/events/admin/events/{id}/lifecycle',
  'POST /api/events/admin/occurrences/{id}/waitlist/reorder',
  'POST /api/events/admin/occurrences/{id}/waitlist/skip',
  'POST /api/events/liff/bookings/{id}/change',
  'POST /api/friends/bulk-runs/{id}/approve',
  'POST /api/friends/{id}/tags',
  'POST /api/file-scans/{id}/release',
  'POST /api/file-scans/{id}/retry',
  'POST /api/forms/{id}/duplicate',
  'POST /api/forms/{id}/publish',
  'POST /api/forms/{id}/submissions/{submissionId}/retry-effects',
  'POST /api/forms/{id}/test-token',
  'POST /api/forms/{id}/unarchive',
  'POST /api/hq/banners/generations/{id}/cancel',
  'POST /api/hq/banners/generations/{id}/run',
  'POST /api/hq/banners/images/{id}/deliver',
  'POST /api/hq/banners/projects',
  'POST /api/hq/banners/projects/{id}/duplicate',
  'POST /api/hq/banners/projects/{id}/generations',
  'POST /api/hq/banners/projects/{id}/uploads',
  'POST /api/hq/billing/checkout',
  'POST /api/hq/billing/card-setup',
  'POST /api/hq/billing/portal',
  'POST /api/hq/billing/webhook',
  'POST /api/hq/notices/{id}/read',
  'POST /api/hq/support/requests',
  'POST /api/hq/support/requests/{id}/messages',
  'POST /api/hq/templates',
  'POST /api/hq/templates/media',
  'POST /api/hq/templates/{id}/distribute',
  'POST /api/hq/templates/{id}/preflight',
  'POST /api/integrations/ai-loop/reports',
  'POST /api/integrations/eccube/coupon-usages',
  'POST /api/integrations/google-sheets/connect/start',
  'POST /api/integrations/google-sheets/disconnect',
  'POST /api/integrations/google-sheets/sync',
  'POST /api/integrations/tiktok-pnl/sync',
  'POST /api/liff/booking/{id}/cancel',
  'POST /api/liff/booking/{id}/reschedule',
  'GET /api/liff/events/me/waitlist',
  'GET /api/liff/events/me/waitlist/{waitlistId}',
  'GET /api/liff/events/waitlist/{token}',
  'GET /api/liff/webinars/{slug}/audience',
  'POST /api/liff/booking/payments/start',
  'POST /api/liff/booking/waitlist',
  'POST /api/liff/events/me/waitlist/{waitlistId}/cancel',
  'POST /api/liff/events/waitlist/{token}/accept',
  'POST /api/nen-campaigns/pets',
  'POST /api/ops/announcements',
  'POST /api/ops/announcements/preview',
  'POST /api/ops/billing/sync',
  'POST /api/ops/impersonation/end',
  'POST /api/ops/impersonation/pii-reveal',
  'POST /api/ops/impersonation/read',
  'POST /api/ops/impersonation/start',
  'POST /api/ops/impersonation/write',
  'POST /api/ops/members',
  'POST /api/ops/knowledge/{id}/review',
  'POST /api/ops/knowledge/{id}/feedback',
  'POST /api/ops/knowledge/tickets/{id}/process',
  'POST /api/ops/knowledge/tickets/{id}/retry',
  'POST /api/ops/members/{staffId}/resend-invite',
  'POST /api/ops/support/tickets',
  'POST /api/ops/support/tickets/{id}/draft/ai',
  'POST /api/ops/support/tickets/{id}/reply',
  'PUT /api/ops/announcements/{id}',
  'PUT /api/ops/knowledge/{id}',
  'PUT /api/ops/notice-line-account',
  'PUT /api/ops/support/tickets/{id}/draft',
  'DELETE /api/ops/support/tickets/{id}/draft',
  'POST /api/line-accounts',
  'POST /api/line-accounts/connect',
  'POST /api/line-accounts/connect/check',
  'POST /api/line-accounts/verify-connection',
  'POST /api/line-accounts/{id}/activate',
  'POST /api/line-accounts/{id}/archive',
  'POST /api/line-accounts/{id}/connection-checks',
  'POST /api/line-accounts/{id}/deactivate',
  'POST /api/line-accounts/{id}/restore',
  'POST /api/line-notifications/customer-definitions/{id}/test',
  'POST /api/line-notifications/deliveries/{id}/resend',
  'POST /api/line-notifications/operator-events',
  'POST /api/line-notifications/operator-outbox/sweep',
  'POST /api/line-notifications/operator-rules',
  'POST /api/line-notifications/operator-rules/recipients-preview',
  'POST /api/line-notifications/operator-rules/{id}/publish',
  'POST /api/line-notifications/operator-rules/{id}/recipients-preview',
  'POST /api/line-notifications/operator-rules/{id}/stop',
  'POST /api/line-notifications/operator-rules/{id}/test',
  'POST /api/mileage/earning-rules/{id}/publish',
  'POST /api/mileage/entries/{id}/notification-retry',
  'POST /api/mileage/rules',
  'POST /api/nen/rank-settings/initialize',
  'POST /api/nen/rank-settings/resync',
  'POST /api/nen-campaigns/deliveries/{id}/retry',
  'POST /api/nen-members/photo-reward-policy/revert',
  'POST /api/nen-members/photo-reward-policy/versions',
  'POST /api/nen-members/photos/{id}/point-reconcile',
  'POST /api/nen-members/photos/{id}/point-retry',
  'POST /api/notifications/operator-outbox/sweep',
  'POST /api/operations/alerts/{id}/acknowledge',
  'POST /api/operations/alerts/{id}/notifications/retry',
  'POST /api/operations/incidents/{id}/restore-preview',
  'POST /api/reminders/{id}/audience',
  'POST /api/reminders/{id}/registrants/{enrollmentId}/cancel',
  'POST /api/reminders/{id}/registrants/{enrollmentId}/resume',
  'POST /api/reminders/{id}/restore',
  'POST /api/scenario-subscriptions/{subscriptionId}/move',
  'POST /api/scenario-subscriptions/{subscriptionId}/pause',
  'POST /api/scenario-subscriptions/{subscriptionId}/resume',
  'POST /api/scenario-subscriptions/{subscriptionId}/retry',
  'POST /api/scenarios',
  'POST /api/scenarios/{id}/enroll/{friendId}',
  'POST /api/scenarios/{id}/publish',
  'POST /api/scenarios/{id}/simulate',
  'POST /api/scenarios/{id}/steps',
  'POST /api/settings/features/impact',
  'POST /api/staff/email-change/confirm',
  'POST /api/staff/{id}/resend-invite',
  'POST /api/staff/{id}/resend-invitation',
  'POST /api/tags',
  'POST /api/tags/import',
  'POST /api/tags/import/preview',
  'POST /api/tags/{id}/retroactive-preview',
  'GET /api/templates/{id}/versions',
  'POST /api/templates/{id}/publish',
  'POST /api/templates/{id}/revert',
  'GET /api/templates/examples',
  'GET /api/broadcast-message-assets/{id}/versions',
  'POST /api/broadcast-message-assets/{id}/publish',
  'GET /api/broadcast-message-assets/folders',
  'POST /api/broadcast-message-assets/folders',
  'GET /api/postal-code/search',
  'POST /api/rich-menu-groups/{groupId}/schedule',
  'GET /api/rich-menu-groups/{groupId}/schedules',
  'POST /api/rich-menu-groups/{groupId}/schedules/{scheduleId}/cancel',
  'GET /api/rich-menu-groups/{groupId}/publish-runs',
  'POST /api/rich-menu-groups/{groupId}/publish-runs/{requestId}/retry',
  'POST /api/rich-menu-groups/{groupId}/reconcile',
  'GET /api/rich-menu-groups/{groupId}/publish-progress',
  'GET /api/rich-menu-groups/{groupId}/prepublish-check',
  'POST /api/rich-menu-groups/{groupId}/validate',
  'POST /api/rich-menu-groups/{groupId}/device-confirm',
  'POST /api/rich-menu-groups/{groupId}/duplicate',
  'GET /api/rich-menu-groups/{groupId}/audience-summary',
  'GET /api/rich-menu-groups/{groupId}/test-apply',
  'POST /api/rich-menu-groups/{groupId}/test-apply',
  'POST /api/rich-menu-groups/{groupId}/test-apply/revert',
  'POST /api/users',
  'POST /api/users/{id}/link',
  'POST /api/users/match',
  // 外部連携の編集・未照合の箱・公開APIトークン・公開API。
  'GET /api/webhooks/outgoing/{id}',
  'POST /api/webhooks/incoming/{id}/test',
  'POST /api/webhooks/incoming/{id}/restore',
  'POST /api/webhooks/outgoing/{id}/restore',
  'GET /api/webhooks/incoming/{id}/unmatched',
  'POST /api/webhooks/unmatched/{id}/resolve',
  'GET /api/webhooks/api-tokens',
  'POST /api/webhooks/api-tokens',
  'POST /api/webhooks/api-tokens/{id}/revoke',
  'POST /api/webhooks/api-tokens/{id}/reactivate',
  'POST /api/webhooks/api-tokens/{id}/rotate',
  'GET /api/webhooks/interactions/{id}/payload',
  'GET /api/public/v1/tags',
  'PATCH /api/measurement-sites/{id}',
  'POST /api/measurement-sites',
  'POST /api/measurement-sites/{id}/resume',
  'POST /api/measurement-sites/{id}/stop',
  'POST /api/public/web-conversions',
  'POST /api/public/v1/friends/{friendId}/tags',
  'POST /api/auth/passkeys/login/options',
  'POST /api/auth/passkeys/login/verify',
  'POST /api/webhooks/maintenance/secret-backfill',
  'POST /webhook',
  'PUT /api/booking/admin/payment-config',
  'PUT /api/booking/admin/settings',
  'PUT /api/affiliates/{id}',
  'PUT /api/analytics/report-schedules/{id}',
  'PUT /api/analytics/report-schedules/{id}/status',
  'GET /api/analytics/funnels/{id}',
  'PUT /api/analytics/funnels/{id}/status',
  'GET /api/analytics/audiences/{id}',
  'GET /api/analytics/exports/{id}',
  'GET /api/analytics/exports/{id}/download',
  'GET /api/analytics/ref/{refCode}/orders',
  'GET /api/booking/admin/channels',
  'GET /api/booking/admin/conflicts',
  'GET /api/booking/admin/payment-config',
  'GET /api/booking/admin/last-booking',
  'GET /api/booking/admin/today',
  'GET /api/booking/admin/waitlist',
  'DELETE /api/booking/admin/waitlist/{id}',
  'POST /api/booking/admin/waitlist',
  'POST /api/booking/admin/waitlist/{id}/convert',
  'POST /api/booking/admin/bookings/{id}/visit',
  'GET /api/liff/booking/last-booking',
  'GET /api/liff/booking/waitlist/mine',
  'POST /api/liff/booking/waitlist',
  'DELETE /api/liff/booking/waitlist/{id}',
  'GET /api/liff/booking/seat-waitlist',
  'POST /api/liff/booking/seat-waitlist',
  'DELETE /api/liff/booking/seat-waitlist/{id}',
  'POST /api/liff/booking/seat-waitlist/{id}/accept',
  'GET /api/booking/payments/by-booking',
  'POST /api/analytics/exports',
  'GET /api/booking/admin/staff/me',
  'GET /api/hq/billing/preview',
  'PUT /api/booking/admin/staff-menus',
  'PUT /api/booking/admin/staff/{id}/break-dates',
  'PUT /api/booking/admin/staff/{id}/breaks',
  'PUT /api/broadcasts/approval-threshold',
  'PUT /api/broadcasts/{id}',
  'PUT /api/file-scans/config',
  'PUT /api/friends/{id}/fields',
  'PUT /api/integrations/google-sheets/target',
  'PUT /api/account-handovers/{id}/decisions',
  'PUT /api/line-accounts/{id}',
  'PUT /api/line-accounts/default',
  'PUT /api/mileage/earning-rules-order',
  'PUT /api/mileage/rules/{id}',
  'PUT /api/nen-campaigns/pets/{id}',
  'PUT /api/scenarios/{id}',
  'PUT /api/scenarios/{id}/draft',
  'PUT /api/scenarios/{id}/steps/{stepId}',
  'PUT /api/settings/company',
  'PUT /api/users/{id}',
  'PUT /api/nen/lifetime-milestones',
  'GET /api/liff/booking/payments/by-booking',
  'GET /api/liff/booking/settings',
  'GET /api/liff/booking/waitlist',
  'GET /api/liff/nen/health-logs/summary',
  'GET /api/line-account-tags',
  'PUT /api/liff/nen/pets/{id}',
  'PUT /api/nen/feeding-products',
  'PUT /api/nen/rank-settings',
  'GET /api/webinars/{id}/sessions/{startAt}',
  'GET /api/webinars/{id}/video-asset',
  'PATCH /api/line-account-tags/{id}',
  'POST /api/booking/admin/bookings/{id}/reassign',
  'POST /api/line-account-tags',
  'POST /api/webinars/{id}/video-asset/advance',
  'PUT /api/booking/admin/channels/settings',
  'PUT /api/line-accounts/{id}/tags',
  'PUT /api/webinars/{id}/sessions/{startAt}',
]);

describe('OpenAPIと公開APIの同期', () => {
  test('versionはrepoのpackage.jsonと一致する', async () => {
    const spec = await loadSpec();
    expect(
      spec.info.version,
      `openapi.ts の version を ${ROOT_VERSION} に上げてください`,
    ).toBe(ROOT_VERSION);
  });

  test('仕様書の基本構造が壊れていない', async () => {
    const spec = await loadSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title.length).toBeGreaterThan(0);
    expect(typeof spec.paths).toBe('object');
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
  });

  test('公開APIは記載済みかallowlistのどちらかに入っている', async () => {
    const spec = await loadSpec();
    const documented = documentedKeys(spec);
    const missing = [...mountedInventory().keys()]
      .filter((key) => !documented.has(key) && !ALLOWLIST.has(key))
      .sort();
    expect(
      missing,
      `OpenAPI未記載の公開APIが ${missing.length} 件あります:\n${formatKeys(missing)}\n` +
        'openapi.ts へ記載するか、ALLOWLIST へ理由付きで登録してください。',
    ).toEqual([]);
  });

  test('記載済みだが実装に無いpathは無い（陳腐化の検出）', async () => {
    const spec = await loadSpec();
    const documented = documentedKeys(spec);
    const inventory = mountedInventory();
    const orphans = [...documented.keys()].filter((key) => !inventory.has(key)).sort();
    expect(
      orphans,
      `実装に無い記載が ${orphans.length} 件あります:\n${formatKeys(orphans)}\n` +
        'route が消えたなら openapi.ts からも消してください。',
    ).toEqual([]);
  });

  test('記載済み・廃止済みはALLOWLISTに残っていない', async () => {
    const spec = await loadSpec();
    const documented = documentedKeys(spec);
    const inventory = mountedInventory();
    const stale = [...ALLOWLIST].filter((key) => documented.has(key) || !inventory.has(key)).sort();
    expect(
      stale,
      `ALLOWLISTのうち ${stale.length} 件は記載済みか廃止済みです:\n${formatKeys(stale)}\n` +
        'ALLOWLISTから消してください。残っていると次の追加漏れを見逃します。',
    ).toEqual([]);
  });

  test('記載済みoperation数は基準一覧の件数以上（後退禁止）', async () => {
    const spec = await loadSpec();
    const count = documentedKeys(spec).size;
    expect(
      count >= BASELINE_DOCUMENTED.size,
      `記載済みが ${count} 件で基準 ${BASELINE_DOCUMENTED.size} 件を下回っています。` +
        '既存仕様を消す・ALLOWLISTへ移す変更は禁止です。後続票で記載を増やした場合は基準一覧を同じPRで更新してください。',
    ).toBe(true);
  });

  test('暫定allowlistは基準件数以下（増加禁止）', async () => {
    expect(
      ALLOWLIST.size <= ALLOWLIST_MAX,
      `ALLOWLISTが ${ALLOWLIST.size} 件で基準 ${ALLOWLIST_MAX} 件を超えています。` +
        'ALLOWLISTへの追加は原則禁止です。新routeはopenapi.tsへ記載してください。',
    ).toBe(true);
  });

  test('基準一覧と記載済みoperationが一致する（移し替え・更新漏れ検出）', async () => {
    const spec = await loadSpec();
    const documented = documentedKeys(spec);
    const lost = [...BASELINE_DOCUMENTED].filter((key) => !documented.has(key)).sort();
    const untracked = [...documented.keys()].filter((key) => !BASELINE_DOCUMENTED.has(key)).sort();
    expect(
      { lost, untracked },
      `基準から消えた記載が ${lost.length} 件、基準へ未登録の記載が ${untracked.length} 件あります。\n` +
        `消えた記載:\n${formatKeys(lost)}\n未登録の記載:\n${formatKeys(untracked)}\n` +
        'OpenAPIと基準一覧は同じPRで更新してください。',
    ).toEqual({ lost: [], untracked: [] });
  });

  test('path parameterは名前まで実装と一致して宣言されている', async () => {
    const spec = await loadSpec();
    const problems: string[] = [];
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      const expected = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const [method, operation] of Object.entries(item ?? {})) {
        if (!OPERATION_METHODS.has(method) || operation == null) continue;
        const declared = (operation.parameters ?? []).filter((p) => p.in === 'path');
        for (const name of expected) {
          const hit = declared.find((p) => p.name === name);
          if (!hit) problems.push(`${method.toUpperCase()} ${path}: {${name}} の宣言が無い`);
          else if (hit.required !== true) problems.push(`${method.toUpperCase()} ${path}: {${name}} に required: true が無い`);
        }
        for (const p of declared) {
          if (!expected.includes(p.name)) problems.push(`${method.toUpperCase()} ${path}: path に無い {${p.name}} を宣言している`);
        }
      }
    }
    expect(problems, `path parameterの不一致が ${problems.length} 件あります:\n${formatKeys(problems)}`).toEqual([]);
  });

  test('pathの重複・名前違いの衝突が無い', async () => {
    const spec = await loadSpec();
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const path of Object.keys(spec.paths ?? {})) {
      // 名前を消した形（/api/friends/{}/tags）で衝突を見つける
      const shape = path.replace(/\{[^}]+\}/g, '{}');
      const prev = seen.get(shape);
      if (prev !== undefined && prev !== path) collisions.push(`${prev} と ${path}`);
      else seen.set(shape, path);
    }
    expect(collisions, `pathの衝突が ${collisions.length} 件あります:\n${formatKeys(collisions)}`).toEqual([]);
  });

  test('認証の表示が実装と一致する（公開口だけsecurity空）', async () => {
    const spec = await loadSpec();
    const inventory = mountedInventory();
    const problems: string[] = [];
    for (const [key, { method, path }] of documentedKeys(spec)) {
      const entry = inventory.get(key);
      // 実装に無い記載は陳腐化テストが落とすので、ここでは飛ばす
      if (!entry) continue;
      const classification = routeClassification(entry.honoPath, method);
      const operation = spec.paths[path]?.[method.toLowerCase() as 'get'];
      // LIFF ハンドラ自身が、対象アカウントの LINE ID トークンを検証する。
      const verifiedLiff = ['/api/liff/booking/monthly-contracts','/api/liff/files/:id/download',"/api/liff/booking/cost-estimate","/api/liff/booking/group-availability","/api/liff/booking/pass-purchases/:id","/api/liff/booking/series/preview","/api/liff/member-card","/api/liff/booking/pass-plans/:id/checkout","/api/liff/forms/:id/routing/resolve","/api/liff/events/bookings/:id/absence","/api/liff/events/makeup-credits","/api/liff/events/makeup-credits/:id/options","/api/liff/events/makeup-credits/:id/use","/api/liff/booking/cancellation-quote","/api/liff/booking/setup-intent",'/api/liff/notification-preferences', '/api/liff/notification-preferences/:purpose', '/api/liff/restaurant/courses', '/api/liff/restaurant/referrals', '/api/liff/restaurant/form-booking'].includes(entry.honoPath);
      if (verifiedLiff) {
        if (JSON.stringify(operation?.security) !== '[{"liffIdToken":[]}]') problems.push(`${key}: LINE IDトークンの表示が無い`);
      } else if (classification?.kind === 'public') {
        if (JSON.stringify(operation?.security ?? null) !== '[]') {
          problems.push(`${key}: 認証なし公開口なのに security: [] が無い`);
        }
      } else if (operation?.security !== undefined && operation.security.length === 0) {
        problems.push(`${key}: 認証が必要なのに security: [] になっている`);
      }
    }
    expect(problems, `認証表示の不一致が ${problems.length} 件あります:\n${formatKeys(problems)}`).toEqual([]);
  });

  test('主要responseの形がある（2xxと説明文）', async () => {
    const spec = await loadSpec();
    const problems: string[] = [];
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        if (!OPERATION_METHODS.has(method) || operation == null) continue;
        const key = `${method.toUpperCase()} ${path}`;
        const responses = operation.responses ?? {};
        const codes = Object.keys(responses);
        if (codes.length === 0) {
          problems.push(`${key}: responses が空`);
          continue;
        }
        if (!codes.some((code) => code.startsWith('2') || code === 'default')) {
          problems.push(`${key}: 成功時（2xx）の response が無い`);
        }
        for (const code of codes) {
          if (!responses[code]?.description) problems.push(`${key} [${code}]: description が無い`);
        }
      }
    }
    expect(problems, `responseの不足が ${problems.length} 件あります:\n${formatKeys(problems)}`).toEqual([]);
  });

  test('予約設備PATCHは版に加えて変更項目を1つ以上要求する', async () => {
    const spec = await loadSpec();
    const operation = spec.paths['/api/booking/admin/resources/{id}']?.patch as {
      requestBody?: { content?: { 'application/json'?: { schema?: {
        required?: string[];
        anyOf?: Array<{ required?: string[] }>;
      } } } };
    } | undefined;
    const schema = operation?.requestBody?.content?.['application/json']?.schema;
    expect(schema?.required).toEqual(['expectedVersion']);
    expect(schema?.anyOf).toEqual([
      { required: ['name'] },
      { required: ['type'] },
      { required: ['capacity'] },
      { required: ['isActive'] },
    ]);
  });

  test('$refの指す先がすべて存在する', async () => {
    const spec = await loadSpec();
    const broken: string[] = [];
    const resolve = (pointer: string): unknown => {
      if (!pointer.startsWith('#/')) return 'external';
      let node: unknown = spec;
      for (const raw of pointer.slice(2).split('/')) {
        // JSON Pointer (RFC 6901) のエスケープを戻す
        const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (typeof node !== 'object' || node === null || !(segment in node)) return undefined;
        node = (node as Record<string, unknown>)[segment];
      }
      return node;
    };
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${at}[${index}]`));
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') {
          if (resolve(v) === undefined) broken.push(`${at}: ${v}`);
        } else walk(v, `${at}.${k}`);
      }
    };
    walk(spec, '$');
    expect(broken, `参照切れが ${broken.length} 件あります:\n${formatKeys(broken)}`).toEqual([]);
  });
});
