import { inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';

import type { Env } from '../worker-env.js';

import { requireDeliveryAccess } from '../middleware/role-guard.js';

import { get__api_liff_webinars_slug_1, get__api_liff_webinars_slug_audience_2, post__api_liff_webinars_slug_heartbeat_3, post__api_liff_webinars_slug_comments_4, post__api_liff_webinars_slug_register_5, post__api_liff_webinars_slug_cta_click_6 } from './webinars-public-view-handlers.js';

import { post__api_liff_webinars_slug_funnel_event_1, get__webinar_assets_token_slug__2, get__api_webinars_overview_3, get__api_webinars_4, post__api_webinars_5, get__api_webinars_id_6, get__api_webinars_id_editor_7, put__api_webinars_id_editor_8, post__api_webinars_id_public_page_test_9, get__api_webinars_id_publish_validation_10, post__api_webinars_id_publish_11, get__api_webinars_id_video_asset_12, post__api_webinars_id_video_asset_advance_13, get__api_webinars_id_sessions_startAt_14, put__api_webinars_id_sessions_startAt_15, post__api_webinars_id_pause_16, post__api_webinars_id_duplicate_17, get__api_webinars_id_notifications_18, put__api_webinars_id_notifications_19 } from './webinars-funnel-assets-handlers.js';
import { requireVisibleWebinar } from './webinars-definition.js';
import { getWebinarTestRecipients, post__api_webinars_id_notifications_test_1, put__api_webinars_id_2, get__api_webinars_id_actions_3, put__api_webinars_id_actions_4, get__api_webinars_id_comments_5, put__api_webinars_id_comments_6, get__api_webinars_id_ctas_7, put__api_webinars_id_ctas_8, get__api_webinars_id_analytics_9, get__api_webinars_id_participants_10, get__api_webinars_id_participants_csv_11, get__api_webinars_id_user_comments_12 } from './webinars-management-handlers.js';
import { archiveVisibleWebinar } from './webinars-definition.js';

const webinarRoutes = new Hono<Env>();

// LIFF caller を認証し、webinar とそのアカウント配下の friend を解決する。
// ----------------------------------------------------------------
// LIFF: 視聴状態
// ----------------------------------------------------------------

webinarRoutes.get('/api/liff/webinars/:slug', get__api_liff_webinars_slug_1);

// 既存の視聴状態の返しは保ち、人数を更新したい時だけこの口を読む。
webinarRoutes.get('/api/liff/webinars/:slug/audience', get__api_liff_webinars_slug_audience_2);

webinarRoutes.post('/api/liff/webinars/:slug/heartbeat', inputJsonBoundary(), post__api_liff_webinars_slug_heartbeat_3);

webinarRoutes.post('/api/liff/webinars/:slug/comments', inputJsonBoundary(), post__api_liff_webinars_slug_comments_4);

// セッション選択メニューの予約。sessionStartAt はスケジュール上の実在する
// 未来セッションに加え、開始後5分以内だけ現在回も受理。
// 冪等 (同一回の再予約は成功扱い)。
webinarRoutes.post('/api/liff/webinars/:slug/register', inputJsonBoundary(), post__api_liff_webinars_slug_register_5);

webinarRoutes.post('/api/liff/webinars/:slug/cta-click', inputJsonBoundary(), post__api_liff_webinars_slug_cta_click_6);

// CTA表示→フォーム入力→送信の途中離脱を段階計測する。
// 同一 friend・同一回・同一段階はDB側の一意制約で1件にまとめる。
webinarRoutes.post('/api/liff/webinars/:slug/funnel-event', inputJsonBoundary(), post__api_liff_webinars_slug_funnel_event_1);

webinarRoutes.get('/webinar-assets/:token/:slug/*', get__webinar_assets_token_slug__2);

webinarRoutes.get('/api/webinars/overview', get__api_webinars_overview_3);

webinarRoutes.use('/api/webinars/:id', requireVisibleWebinar);

webinarRoutes.use('/api/webinars/:id/*', requireVisibleWebinar);

webinarRoutes.get('/api/webinars', get__api_webinars_4);

webinarRoutes.post('/api/webinars', requireDeliveryAccess('webinars'), inputJsonBoundary({"accountId":["null","string"],"title":["string"],"slug":["string"],"status":["string"],"videoPrefix":["null","string"],"videoMediaId":["null","string"],"durationSeconds":["number"],"schedule":["array"],"cta":["null","object"],"tagOnAttend":["null","string"],"tagOnCtaClick":["null","string"],"folderId":["null","string"],"publicationStartsAt":["null","string"],"publicationEndsAt":["null","string"],"expectedVersion":["number"],"deliveryKind":["string"],"viewingCondition":["object"],"publicDescription":["string"],"registrationFormId":["null","string"]}), post__api_webinars_5);

webinarRoutes.get('/api/webinars/:id', get__api_webinars_id_6);

webinarRoutes.get('/api/webinars/:id/editor', get__api_webinars_id_editor_7);

webinarRoutes.put('/api/webinars/:id/editor', requireDeliveryAccess('webinars'), inputJsonBoundary({"deliveryKind":["string"],"viewingCondition":["object"],"publicDescription":["string"],"registrationFormId":["null","string"],"notificationMessages":["object"],"notificationTest":["null","object"],"actionTemplateBody":["string"],"missingResultPolicy":["string"],"publicPageTest":["null","object"]}), put__api_webinars_id_editor_8);

webinarRoutes.post('/api/webinars/:id/public-page/test', requireDeliveryAccess('webinars'), inputJsonBoundary(), post__api_webinars_id_public_page_test_9);

webinarRoutes.get('/api/webinars/:id/publish-validation', get__api_webinars_id_publish_validation_10);

webinarRoutes.post('/api/webinars/:id/publish', requireDeliveryAccess('webinars'), inputJsonBoundary(), post__api_webinars_id_publish_11);

webinarRoutes.get('/api/webinars/:id/video-asset', get__api_webinars_id_video_asset_12);

webinarRoutes.post('/api/webinars/:id/video-asset/advance', requireDeliveryAccess('webinars'), inputJsonBoundary(), post__api_webinars_id_video_asset_advance_13);

webinarRoutes.get('/api/webinars/:id/sessions/:startAt', get__api_webinars_id_sessions_startAt_14);

webinarRoutes.put('/api/webinars/:id/sessions/:startAt', requireDeliveryAccess('webinars'), inputJsonBoundary(), put__api_webinars_id_sessions_startAt_15);

webinarRoutes.post('/api/webinars/:id/pause', requireDeliveryAccess('webinars'), inputJsonBoundary(), post__api_webinars_id_pause_16);

webinarRoutes.post('/api/webinars/:id/duplicate', requireDeliveryAccess('webinars'), inputJsonBoundary(), post__api_webinars_id_duplicate_17);

webinarRoutes.get('/api/webinars/:id/notifications', get__api_webinars_id_notifications_18);

webinarRoutes.put(
  '/api/webinars/:id/notifications',
  requireDeliveryAccess('webinars'),
  inputJsonBoundary({"registrationEnabled":["boolean"],"dayBeforeEnabled":["boolean"],"dayBeforeTime":["string"],"hourBeforeEnabled":["boolean"],"hourBeforeMinutes":["number"],"startEnabled":["boolean"],"missedEnabled":["boolean"],"missedTime":["string"],"completedEnabled":["boolean"],"missedWindowDays":["number"]}), put__api_webinars_id_notifications_19,
);

webinarRoutes.get('/api/webinars/:id/notifications/test', requireDeliveryAccess('webinars'), getWebinarTestRecipients);
webinarRoutes.post(
  '/api/webinars/:id/notifications/test',
  requireDeliveryAccess('webinars'),
  inputJsonBoundary({"expectedRecipientToken":["string"],"confirmationId":["string"]}), post__api_webinars_id_notifications_test_1,
);

webinarRoutes.put('/api/webinars/:id', requireDeliveryAccess('webinars'), inputJsonBoundary({"accountId":["null","string"],"title":["string"],"slug":["string"],"status":["string"],"videoPrefix":["null","string"],"videoMediaId":["null","string"],"durationSeconds":["number"],"schedule":["array"],"cta":["null","object"],"tagOnAttend":["null","string"],"tagOnCtaClick":["null","string"],"folderId":["null","string"],"publicationStartsAt":["null","string"],"publicationEndsAt":["null","string"],"expectedVersion":["number"],"deliveryKind":["string"],"viewingCondition":["object"],"publicDescription":["string"],"registrationFormId":["null","string"]}), put__api_webinars_id_2);

webinarRoutes.get('/api/webinars/:id/actions', get__api_webinars_id_actions_3);

webinarRoutes.put('/api/webinars/:id/actions', requireDeliveryAccess('webinars'), inputJsonBoundary(), put__api_webinars_id_actions_4);

webinarRoutes.post('/api/webinars/:id/archive', requireDeliveryAccess('webinars'), inputJsonBoundary(), archiveVisibleWebinar);

// 旧クライアント互換。物理削除はせず、同じアーカイブ処理を行う。
webinarRoutes.delete('/api/webinars/:id', requireDeliveryAccess('webinars'), archiveVisibleWebinar);

webinarRoutes.get('/api/webinars/:id/comments', get__api_webinars_id_comments_5);

webinarRoutes.put('/api/webinars/:id/comments', requireDeliveryAccess('webinars'), inputJsonBoundary(), put__api_webinars_id_comments_6);

webinarRoutes.get('/api/webinars/:id/ctas', get__api_webinars_id_ctas_7);

// CTA カード一括置換。kind='form' は forms 実在チェック、kind='url' は https? 必須。
// 全要素検証 → 不正が1件でもあれば何も書かない (comments と同じ all-or-nothing)。
webinarRoutes.put('/api/webinars/:id/ctas', requireDeliveryAccess('webinars'), inputJsonBoundary(), put__api_webinars_id_ctas_8);

webinarRoutes.get('/api/webinars/:id/analytics', get__api_webinars_id_analytics_9);

webinarRoutes.get(
  '/api/webinars/:id/participants',
  requireDeliveryAccess('webinars'),
  get__api_webinars_id_participants_10,
);

webinarRoutes.get(
  '/api/webinars/:id/participants.csv',
  requireDeliveryAccess('webinars', 'export'),
  get__api_webinars_id_participants_csv_11,
);

webinarRoutes.get('/api/webinars/:id/user-comments', get__api_webinars_id_user_comments_12);

export { webinarRoutes };
