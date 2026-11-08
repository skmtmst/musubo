import { DELIVERY_API_PERMISSIONS } from '@line-crm/shared';

// 経路の委譲だけを担当し、所有権と操作別の権限はハンドラでも検証する。
const STAFF_API_PERMISSIONS: Array<[string, string]> = [
  ['/api/auth/two-factor/policy', 'auth.mfa.policy'],
  ...DELIVERY_API_PERMISSIONS,
  ['/api/inbox', '/chats'], ['/api/chats', '/chats'], ['/api/conversations', '/chats'],
  ['/api/support', '/chats'], ['/api/operators', '/chats'],
  ['/api/friends', '/friends'], ['/api/tags', '/tags'], ['/api/friend-fields', '/tags'],
  ['/api/tag-groups', '/tags'], ['/api/support-marks', '/tags'], ['/api/support-mark-rules', '/tags'],
  ['/api/saved-searches', '/tags'], ['/api/folders', '/tags'],
  ['/api/form-files', '/form-submissions'],
  // 流入計測の入口経路と文面は /inflow-links 画面が呼ぶ。
  ['/api/entry-routes', '/inflow-links'], ['/api/entry-route-genres', '/inflow-links'],
  ['/api/message-templates', '/inflow-links'],
  // 広告費の台帳も流入画面の一部。書き込みは route 側で owner/admin に絞る。
  ['/api/ad-costs', '/inflow-links'],
  ['/api/funnels', '/analytics'],
  // ダッシュボード(ホーム)の数字と表示設定。'/' 鍵はメニューの href と同じ。
  // /api/list-stats は複数画面の集計で帰属を決められないため登録しない
  // 未対応の経路も、安全側で拒否する。
  ['/api/dashboard', '/'],
  ['/api/getting-started', '/getting-started'],
  ['/api/conversions', '/conversions'], ['/api/measurement-sites', '/conversions'], ['/api/scoring', '/scoring'], ['/api/scoring-rules', '/scoring'],
  ['/api/ad-platforms/mappings', '/inflow-links'], ['/api/tracked-links', '/inflow-links'], ['/api/analytics', '/analytics'],
  ['/api/hq/broadcasts', '/hq/broadcasts'],
  ['/api/visit-stamps', '/visit-stamps'],
  ['/api/mileage', '/mileage'], ['/api/action-scores', '/mileage'],
  ['/api/automations', '/automations'], ['/api/automation-runs', '/automations'],
  ['/api/automation-templates', '/automations'], ['/api/automation-drafts', '/automations'],
  ['/api/automation-draft-resources', '/automations'], ['/api/common-actions', '/automations'],
  ['/api/webhooks', '/webhooks'], ['/api/instagram', '/webhooks'],
  ['/api/booking', '/booking/bookings'], ['/api/events', '/events'],
  // 個別相談の変更・取消は予約と同じ `/booking/bookings` 権限で守る
  // 公開コールバックの /api/meet-callback は対象外とする。
  ['/api/meet-consultations', '/booking/bookings'],
  ['/api/ec-commerce', '/ec-commerce'],
  // 然の会員（★37-1）。メニューの href は /nen/members。
  ['/api/nen/rank-settings', '/nen/members'], ['/api/nen/lifetime-milestones', '/nen/members'], ['/api/nen/members', '/nen/members'],
  // 然のマイペット・健康日記（★37-3／37-4）。主食のカロリー表はマイペット画面へ移した。
  ['/api/nen/feeding-products', '/nen/pets'], ['/api/nen/pets', '/nen/pets'], ['/api/nen/health', '/nen/health'],
  // ログインユーザー一覧・権限のかたまり・監査の閲覧は「設定」の点キーで守る。
  // route 側の requirePermission が最終判定を握る。
  ['/api/access', 'access.user.view'],
  ['/api/audit', 'access.audit.view'],
  // 在庫ルールと媒体受付の操作は、予約枠・在庫画面に帰属する。
  // 設定変更は route 側でも owner/admin に絞る。
  ['/api/restaurant-test/media-links', '/restaurant-test/channels'],
  ['/api/restaurant-test/reservation-link', '/restaurant-test/channels'],
  ['/api/restaurant-test/media', '/restaurant-test/channels'],
  ['/api/restaurant-test/closures', '/restaurant-test/inventory'],
  ['/api/restaurant-test/availability', '/restaurant-test/inventory'],
  ['/api/restaurant-test/close-notification-settings', '/restaurant-test/inventory'],
  ['/api/restaurant-test/inventory-rules', '/restaurant-test/inventory'],
  ['/api/restaurant-test/channel-close-tasks', '/restaurant-test/inventory'],
  ['/api/restaurant-test/assignment-settings', 'booking.settings'],
  ['/api/restaurant-test/table-auto-assignment-settings', 'booking.settings'],
];

/** URL 互換性で /api/friends 配下にある別機能を先に解決し、friends 権限だけでチャットや属性へアクセスできないようにする。 */
const STAFF_API_PERMISSION_OVERRIDES: Array<[RegExp, string]> = [
  [/^\/api\/restaurant-test\/followups\/[^/]+\/(?:engines|rows|reservation-form)(?:\/|$)/, '/restaurant-test/line-followup'],
  [/^\/api\/dashboard\/style\/template-samples$/, '/templates'],
  // 予約の細かい権限。広い '/api/booking' → '/booking/bookings' より先に評価する。
  // 本人勤務は route 側で「自分に紐づく予約スタッフか」を確認する。
  [/^\/api\/booking\/admin\/staff\/me(?:\/|$)/, 'booking.staff.own'],
  [/^\/api\/booking\/admin\/staff\/[^/]+\/(?:availability-rules|breaks|break-dates|shifts|google-calendar|calendar-sync|meeting-url)(?:\/|$)/, 'booking.staff.own'],
    // メニューと担当割当は「予約メニュー」の鍵。
  [/^\/api\/booking\/admin\/staff-menus(?:\/|$)/, '/booking/menus'],
  [/^\/api\/booking\/admin\/staff\/[^/]+\/menus(?:\/|$)/, '/booking/menus'],
  [/^\/api\/booking\/admin\/menus(?:\/|$)/, '/booking/menus'],
  // 予約設定（受付枠・資源・例外）の GET は予約の閲覧に含め、
  // 変更は route 側で 'booking.settings' を要求する（後方互換のため）。
  // 運用状態の健全性サマリは '/health' 権限で守る。
  // /api/accounts 全体ではなくこの配下だけを対象にする。
  [/^\/api\/accounts\/health-summary(?:\/|$)/, '/health'],
  [/^\/api\/accounts\/[^/]+\/health(?:\/|$)/, '/health'],
  [/^\/api\/nen-members\/photos\/decisions\/bulk(?:\/|$)/, 'photo.submission.bulk_review'],
  [/^\/api\/nen-members\/photos\/(?:original-download\/[^/]+|[^/]+\/original-download)(?:\/|$)/, 'photo.original.download'],
  [/^\/api\/nen-members\/photos\/[^/]+\/(?:assessments\/re-evaluate|assets\/process|review|notification\/retry)(?:\/|$)/, 'photo.submission.review'],
  // ポイント付与の復旧（再試行・照合）は審査権限とは別の専用鍵。
  [/^\/api\/nen-members\/photos\/[^/]+\/(?:point-retry|point-reconcile)(?:\/|$)/, 'photo.reward.reconcile'],
  // 公開の撤回・掲載先の変更は審査権限ではなく掲載管理の上位権限。
  // 一覧の表示（GET publications）は審査と同じ閲覧権限のままにする。
  [/^\/api\/nen-members\/photos\/publications\/[^/]+\/(?:withdraw|placements)(?:\/|$)/, 'photo.publication.manage'],
  [/^\/api\/nen-members\/photos\/(?:publications\/order|[^/]+\/publish)(?:\/|$)/, 'photo.publication.manage'],
  [/^\/api\/nen-members\/photos(?:\/|$)/, 'photo.submission.view'],
  [/^\/api\/friends\/[^/]+\/messages(?:\/|$)/, '/chats'],
  [/^\/api\/friends\/[^/]+\/fields(?:\/|$)/, '/tags'],
  [/^\/api\/friends\/[^/]+\/support-mark(?:\/|$)/, '/tags'],
  [/^\/api\/friends\/support-mark\/bulk(?:\/|$)/, '/tags'],
  // 友だち単位の購読操作（機能05 §7）は操作ごとの個別鍵で
  // 委譲する。失敗の再送だけを任された staff（scenario.step_run.retry）が
  // 購読の操作権限なしで retry へ届くよう、第一関門も操作単位の鍵を見る。
  // route 側の requirePermission が最終判定を握る。
  [/^\/api\/scenario-subscriptions\/[^/]+\/retry(?:\/|$)/, 'scenario.step_run.retry'],
  [/^\/api\/scenario-subscriptions(?:\/|$)/, 'scenario.subscription.edit'],
];

/** 読取だけを行うPOSTの、経路と閲覧鍵。複数の鍵はどちらか一つでよい。 */
export const READ_OPERATION_PERMISSIONS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['POST /api/segments/count', ['/scenarios', '/broadcasts']],
]);

export function readOperationPermissions(method: string, path: string): readonly string[] | null {
  return READ_OPERATION_PERMISSIONS.get(`${method.toUpperCase()} ${path}`) ?? null;
}

/** POST でも業務データを更新しない読取・プレビュー操作。 */
export function gap2ReadOperation(method: string, path: string): boolean {
  return method === 'POST' && (
    readOperationPermissions(method, path) !== null
    || /^\/api\/forms\/[^/]+\/routing\/preview$/.test(path)
    || /^\/api\/chats\/[^/]+\/ai\/summary$/.test(path)
    || path === '/api/booking/admin/series/preview'
    || path === '/api/member-ranks/preview'
    || path === '/api/hq/store-comparison/export'
    || path === '/api/delivery-purposes/preview'
    || /^\/api\/booking\/admin\/series\/[^/]+\/impact$/.test(path)
  );
}

export function gap2SelfPreference(method: string, path: string): boolean {
  return (method === 'POST' && /^\/api\/me\/push\/(subscriptions|test)$/.test(path))
    || (method === 'PUT' && path === '/api/me/push/preferences')
    || (method === 'DELETE' && /^\/api\/me\/push\/subscriptions\/[^/]+$/.test(path));
}

export function permissionForApiPath(path: string): string | null {
  if(/^\/api\/friends\/[^/]+\/member-rank$/.test(path))return '/mileage';
  if(path.startsWith('/api/analytics/customer-segments'))return '/analytics';
  if(path.startsWith('/api/inbox/routing'))return '/chats';
  if(path.startsWith('/api/delivery-purposes'))return '/broadcasts';
  if(path.startsWith('/api/member-ranks'))return '/mileage';
  if(path.startsWith('/api/ec/auto-line'))return '/ec-commerce';
  if(path.startsWith('/api/ai-answer-logs'))return '/auto-replies';
  if(path.startsWith('/api/ai-features'))return '/settings';
  if(path.startsWith('/api/qa-entries')||path.startsWith('/api/ai-settings'))return '/auto-replies';
  if (/^\/api\/line-accounts\/[^/]+\/(?:senders|sender-icons)(?:\/|$)/.test(path)) return '/chats';
  const override = STAFF_API_PERMISSION_OVERRIDES.find(([pattern]) => pattern.test(path));
  if (override) return override[1];
  return STAFF_API_PERMISSIONS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] ?? null;
}

/**
 * 役割に関わらず認証済みなら通す本人・自組織・シェル必須の口。
 *
 * いずれも route 側で対象を絞っている: 自分の表示・自組織の名前・
 * 可視アカウントだけの一覧・秘密値を含まない版情報・自分の二段階認証
 * (handler 内で本人確認)・失敗報告の受付。exact 一致で列挙し、
 * 新しい口は fail-closed (staff 403) に倒す。
 */
const STAFF_SELF_ENDPOINTS: Array<[method: string, path: string]> = [
  // 本人向け操作は実セッションを必須とし、その本人だけを対象にする。
  ['GET', '/api/auth/api-key'],
  ['POST', '/api/auth/api-key'],
  ['DELETE', '/api/auth/api-key'],
  ['GET', '/api/auth/session'],
  ['PUT', '/api/me/presence'],
  // 外部入力で対象を選ばせず、認証済みの本人だけから解決する。
  ['GET', '/api/auth/two-factor/self'],
  ['GET', '/api/auth/passkeys/self'],
  ['POST', '/api/auth/passkeys/register/options'],
  ['POST', '/api/auth/passkeys/register/verify'],
  ['DELETE', '/api/auth/passkeys/self'],
  ['POST', '/api/auth/step-up'],
  // 本人のログイン中セッション一覧と一括失効。handler が本人分だけを対象にする。
  ['GET', '/api/auth/sessions'],
  ['POST', '/api/auth/sessions/revoke-others'],
  ['GET', '/api/staff/me'],
  ['GET', '/api/tenants/me'],
  // 自社の表示設定だけ読む。PUTは会社全体のowner/adminに限定する。
  ['GET', '/api/settings/company'],
  ['GET', '/api/hq/support/summary'],
  ['POST', '/api/client-errors'],
  ['GET', '/api/capabilities'],
  ['GET', '/api/line-accounts'],
  ['GET', '/api/line-accounts/profile-pictures'],
  ['GET', '/api/line-accounts/summary'],
  ['GET', '/api/line-account-folders'],
  // 殻の表示に要る最小boolean。管理用の機能設定GETは owner/admin 専用。
  ['GET', '/api/settings/features/visibility'],
  // 共通アップローダ。受信箱の 1 対 1 返信など staff の付与機能から使う。
  // 読み取りは公開の /images/* 経由で、鍵は機能 API の応答で渡る。
  ['POST', '/api/images'],
  // 失敗文面の対応表。エラー表示は役割を問わず全スタッフに必要な
  // シェル機能で、内容は文言の対応表だけ（秘密値・個人情報を含まない）。
  ['GET', '/api/error-messages'],
];

/**
 * route 定義を静的検査するときだけ本人系として扱う template。
 * 固定 path を `:id` と同じ形で判定しないため、実リクエスト用の判定とは分ける。
 */
const STAFF_SELF_ROUTE_TEMPLATES: Array<[method: string, path: string]> = [
  ['GET', '/api/staff/:id'],
  ['PATCH', '/api/staff/:id'],
  ['POST', '/api/staff/:id/two-factor/setup'],
  ['POST', '/api/staff/:id/two-factor/confirm'],
  ['DELETE', '/api/staff/:id/two-factor'],
  ['DELETE', '/api/auth/sessions/:tokenHash'],
];

export function isStaffSelfRouteTemplate(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if((normalizedMethod==='GET'&&path==='/api/me/push')||gap2SelfPreference(normalizedMethod,path))return true;
  if (STAFF_SELF_ENDPOINTS.some(([m, p]) => m === normalizedMethod && p === path)) return true;
  return STAFF_SELF_ROUTE_TEMPLATES.some(([m, p]) => m === normalizedMethod && p === path);
}

/**
 * `/api/staff/:id` 配下の本人操作。
 *
 * URL の形だけでは本人系にしない。将来 `/api/staff/export` のような固定 path が
 * 追加されても permission 検査を迂回しないよう、path 内の id と認証済み staff.id
 * が一致する場合だけ通す。
 */
const STAFF_SELF_PATH_PATTERNS: Array<[method: string, pattern: RegExp]> = [
  ['GET', /^\/api\/staff\/([^/]+)$/],
  ['PATCH', /^\/api\/staff\/([^/]+)$/],
  ['POST', /^\/api\/staff\/([^/]+)\/two-factor\/(?:setup|confirm)$/],
  ['DELETE', /^\/api\/staff\/([^/]+)\/two-factor$/],
];

/**
 * handler が本人の資産だけを対象にする口。path の可変部は staff id ではない
 * ため id 比較をせず、認証済みなら誰でも通す（中身は本人分に閉じる）。
 */
const STAFF_SELF_SCOPED_PATTERNS: Array<[method: string, pattern: RegExp]> = [
  ['DELETE', /^\/api\/auth\/sessions\/[^/]+$/],
];

export function isStaffSelfEndpoint(method: string, path: string, staffId?: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (STAFF_SELF_ENDPOINTS.some(([m, p]) => m === normalizedMethod && p === path)) return true;
  if (STAFF_SELF_SCOPED_PATTERNS.some(([m, pattern]) => m === normalizedMethod && pattern.test(path))) return true;
  if (!staffId) return false;
  return STAFF_SELF_PATH_PATTERNS.some(([m, pattern]) => {
    if (m !== normalizedMethod) return false;
    return pattern.exec(path)?.[1] === staffId;
  });
}

/**
 * route が staff へ明示許可する経路だけを対応させる。
 * GET /api/staff は他人のメールを伏せる仕様を保つ。飲食店テストも既存の明示許可を写し、範囲を広げない。
 */
const STAFF_EXPLICIT_ALLOW: Array<[method: string, path: string]> = [
  ['GET', '/api/staff'],
  ['GET', '/api/restaurant-test/stores'],
  ['GET', '/api/restaurant-test/store-groups'],
  ['GET', '/api/restaurant-test/store-context'],
  ['GET', '/api/restaurant-test/terms-agreement'],
  ['POST', '/api/restaurant-test/stores/selection/clear'],
  ['GET', '/api/restaurant-test/snapshot'],
  ['GET', '/api/restaurant-test/setup-progress'],
  ['GET', '/api/restaurant-test/board'],
  ['GET', '/api/restaurant-test/rotation'],
  ['GET', '/api/restaurant-test/external-links'],
  ['POST', '/api/restaurant-test/external-links'],
  ['GET', '/api/restaurant-test/floors'],
  ['GET', '/api/restaurant-test/opening-hours'],
  ['GET', '/api/restaurant-test/menus'],
  ['GET', '/api/restaurant-test/channels'],
  ['GET', '/api/restaurant-test/media'],
  ['GET', '/api/restaurant-test/media-links'],
  ['POST', '/api/restaurant-test/reservations/manual'],
  ['POST', '/api/restaurant-test/reservations/walk-in'],
  // 席の空き待ち（booking-plus 席版）：担当者も日の帯から印を付ける。
  ['GET', '/api/restaurant-test/seat-waitlist'],
  ['POST', '/api/restaurant-test/seat-waitlist'],
  ['POST', '/api/restaurant-test/reservations/holds'],
  ['GET', '/api/restaurant-test/reservations/day'],
  ['GET', '/api/restaurant-test/customers/search'],
  ['GET', '/api/restaurant-test/customers/history'],
  ['GET', '/api/restaurant-test/inventory/day'],
  // 既存の在庫閲覧と同じく担当者も確認できる。ルールの保存は管理者以上。
  ['GET', '/api/restaurant-test/closures'],
  ['POST', '/api/restaurant-test/closures'],
  ['POST', '/api/restaurant-test/closures/preview'],
  ['GET', '/api/restaurant-test/availability'],
  ['POST', '/api/restaurant-test/google/hours/from-closure'],
  ['GET', '/api/restaurant-test/inventory-rules'],
  ['GET', '/api/restaurant-test/channel-close-tasks'],
  // Googleビジネス（★GB-2/GB-3）：担当者も口コミを読み、同期し、下書きを作れる。公開・接続は店舗管理者以上。
  ['GET', '/api/restaurant-test/google/connection'],
  ['GET', '/api/restaurant-test/google/reviews'],
  ['POST', '/api/restaurant-test/google/reviews/sync'],
  // Googleビジネス第2段（GB-10〜GB-19）：担当者もプロフィールを読み、変更案を作れる。Googleへの送信は店舗管理者以上。
  ['GET', '/api/restaurant-test/google/profile'],
  ['POST', '/api/restaurant-test/google/profile/sync'],
  ['GET', '/api/restaurant-test/google/holidays'],
  ['GET', '/api/restaurant-test/google/hours/workspace'],
  ['GET', '/api/restaurant-test/google/photos'],
  ['POST', '/api/restaurant-test/google/hours/propose'],
  ['POST', '/api/restaurant-test/google/profile/propose'],
  ['GET', '/api/restaurant-test/google/changes'],
  // Googleビジネス第3段（GB-4〜GB-14）：担当者も投稿を読み、下書きを作れる。Googleへの送信・削除は店舗管理者以上。
  ['GET', '/api/restaurant-test/google/posts'],
  ['POST', '/api/restaurant-test/google/posts'],
  ['POST', '/api/restaurant-test/google/posts/sync'],
  // Googleビジネス第4段（GB-9）：パフォーマンスは読み取りのみ。担当者も見られる。
  // performance/sync は口コミ・投稿・プロフィールのsyncと同じくGoogleから読んで自DBに書くだけ（Googleへの書き込みは無い）ため、担当者にも許可する。
  ['GET', '/api/restaurant-test/google/performance'],
  ['POST', '/api/restaurant-test/google/performance/sync'],
  // デリバリー受注（D-1〜D-6）：担当者も注文を読み、厨房の流れ（受注→準備完了→受け渡し）と
  // 品切れの一括設定を進められる。拒否・キャンセル・受付の一括停止と再開は店舗管理者以上。
  ['GET', '/api/restaurant-test/delivery/orders'],
  ['GET', '/api/restaurant-test/delivery/history'],
  ['GET', '/api/restaurant-test/delivery/history.csv'],
  ['GET', '/api/restaurant-test/delivery/menu-items'],
  ['POST', '/api/restaurant-test/delivery/menu-items/bulk-sold-out'],
  // 運営からのお知らせ（★37-7）は本人宛て。担当者でも読んで既読にできる。
  ['GET', '/api/hq/notices'],
  ['GET', '/api/hq/notices/line-registration'],
  ['GET', '/api/hq/notices/line-registration/status'],
];

const STAFF_EXPLICIT_ALLOW_PATTERNS: Array<[method: string, pattern: RegExp]> = [
  // 店の入口で引き継ぎ状態を読む。見える店だけ route 側で絞り、開始・進行は管理者に限る。
  ['GET', /^\/api\/line-accounts\/[^/]+\/follower-import$/],
  // 飲食3：担当者はフォロー・返事・登録情報を読む。開始・編集は管理者だけ。
  ['GET', /^\/api\/restaurant-test\/followups\/[^/]+(?:\/review-history)?$/],
  ['GET', /^\/api\/restaurant-test\/reservations\/[^/]+(?:\/confirmations)?$/],
  ['GET', /^\/api\/restaurant-test\/external-links\/[^/]+$/],
  ['PATCH', /^\/api\/restaurant-test\/external-links\/[^/]+$/],
  ['DELETE', /^\/api\/restaurant-test\/external-links\/[^/]+$/],
  ['POST', /^\/api\/restaurant-test\/stores\/[^/]+\/select$/],
  ['PATCH', /^\/api\/restaurant-test\/reservations\/[^/]+$/],
  // 席の空き待ちの取り消し・繰り上げ・来店の印（booking-plus 席版）。
  ['DELETE', /^\/api\/restaurant-test\/seat-waitlist\/[^/]+$/],
  ['POST', /^\/api\/restaurant-test\/seat-waitlist\/[^/]+\/convert$/],
  ['POST', /^\/api\/restaurant-test\/reservations\/[^/]+\/visit$/],
  ['POST', /^\/api\/restaurant-test\/reservations\/[^/]+\/attendance$/],
  ['DELETE', /^\/api\/restaurant-test\/reservations\/[^/]+\/visit$/],
  ['PATCH', /^\/api\/restaurant-test\/closures\/[^/]+$/],
  ['DELETE', /^\/api\/restaurant-test\/closures\/[^/]+$/],
  ['POST', /^\/api\/restaurant-test\/channel-close-tasks\/[^/]+\/(?:done|opened)$/],
  ['GET', /^\/api\/restaurant-test\/google\/reviews\/[^/]+$/],
  ['POST', /^\/api\/restaurant-test\/google\/reviews\/[^/]+\/draft\/generate$/],
  ['PUT', /^\/api\/restaurant-test\/google\/reviews\/[^/]+\/draft$/],
  ['GET', /^\/api\/restaurant-test\/google\/changes\/[^/]+$/],
  ['POST', /^\/api\/restaurant-test\/google\/changes\/[^/]+\/cancel$/],
  ['GET', /^\/api\/restaurant-test\/google\/posts\/[^/]+$/],
  ['PUT', /^\/api\/restaurant-test\/google\/posts\/[^/]+$/],
  ['POST', /^\/api\/restaurant-test\/google\/posts\/[^/]+\/cancel$/],
  // デリバリー受注の1件表示と、厨房の流れの3操作。拒否・キャンセルは含めない。
  ['GET', /^\/api\/restaurant-test\/delivery\/orders\/[^/]+$/],
  ['POST', /^\/api\/restaurant-test\/delivery\/orders\/[^/]+\/accept$/],
  ['POST', /^\/api\/restaurant-test\/delivery\/orders\/[^/]+\/ready$/],
  ['POST', /^\/api\/restaurant-test\/delivery\/orders\/[^/]+\/handed-over$/],
  ['POST', /^\/api\/hq\/notices\/[^/]+\/read$/],
];

export function isStaffExplicitAllow(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (STAFF_EXPLICIT_ALLOW.some(([m, p]) => m === normalizedMethod && p === path)) return true;
  return STAFF_EXPLICIT_ALLOW_PATTERNS.some(([m, pattern]) => m === normalizedMethod && pattern.test(path));
}
