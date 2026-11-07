import { getRestaurantReservationForm,putRestaurantReservationForm } from './restaurant-reservation-form.js';
import { registerRestaurantSetupProgressRoutes } from './restaurant-setup-progress.js';
import { getRestaurantFollowupEngines,initializeRestaurantFollowupEngines,saveRestaurantFollowupEngine,testRestaurantFollowupEngineHandler,startRestaurantFollowupEngineHandler } from './restaurant-followup-engine.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { validateClosure, publicClosure, closurePreview, type ClosureRow } from '../services/restaurant-closures.js';

import { readCloseNotificationSettings, saveCloseNotificationSettings } from '../services/restaurant-close-settings.js';
import { StampError } from '../services/visit-stamps.js';
import { updateRestaurantFollowupBinding } from './restaurant-followup-binding.js';
import { putRestaurantFollowupSetup, putRestaurantFollowupRow, get__api_restaurant_test_followups_storeId_15 } from './restaurant-followup-row.js';
import { Hono } from 'hono';

import type { Env } from '../worker-env.js';

import { requireRole, requirePermission } from '../middleware/role-guard.js';
import { BOOKING_SETTINGS_KEY } from '@line-crm/shared';

import { dbFor } from '../services/db-router.js';
import { paymentSettingResponse } from './booking-payment-settings.js';

import { use__api_restaurant_test__1, onError_route_2, use___3, use__api_restaurant_test__4, get__api_restaurant_test_assignment_settings_5, put__api_restaurant_test_assignment_settings_6, get__api_restaurant_test_stores_7, get__api_restaurant_test_store_context_8, get__api_restaurant_test_terms_agreement_9, post__api_restaurant_test_terms_agreement_10, post__api_restaurant_test_stores_id_select_11, post__api_restaurant_test_stores_selection_clear_12, get__api_restaurant_test_snapshot_13, post__api_restaurant_test_stores_connect_14, post__api_restaurant_test_stores_15, patch__api_restaurant_test_stores_id_16, get__api_restaurant_test_intake_addresses_17, post__api_restaurant_test_intake_addresses_18, get__api_restaurant_test_channels_19, get__api_restaurant_test_inbound_emails_20 } from './restaurant-test-organization-handlers.js';
import { organizationFor, accountId, hasOrganizationSelector, requiredAccount, storeBelongsTo } from './restaurant-test-definition.js';
import { post__api_restaurant_test_inbound_emails_id_manual_import_1, patch__api_restaurant_test_approvals_id_2, post__api_restaurant_test_reservations_manual_3, post__api_restaurant_test_reservations_walk_in_4, patch__api_restaurant_test_reservations_id_5, post__api_restaurant_test_seat_waitlist_6, get__api_restaurant_test_seat_waitlist_7, delete__api_restaurant_test_seat_waitlist_id_8, post__api_restaurant_test_seat_waitlist_id_convert_9, post__api_restaurant_test_reservations_id_attendance_10, post__api_restaurant_test_reservations_id_visit_11, delete__api_restaurant_test_reservations_id_visit_12, post__api_restaurant_test_inbound_reservations_13 } from './restaurant-test-reservation-intake-handlers.js';
import { acquireLock, releaseLock, insertSeatWaitlistEntry } from './restaurant-test-definition.js';
import { put__api_restaurant_test_tables_layout_1, post__api_restaurant_test_tables_2, post__api_restaurant_test_memberships_3, patch__api_restaurant_test_tables_id_4, delete__api_restaurant_test_tables_id, patch__api_restaurant_test_memberships_id_5, put__api_restaurant_test_inventory_allocation_6, put__api_restaurant_test_inventory_id_7, get__api_restaurant_test_opening_hours_8, put__api_restaurant_test_opening_hours_9, post__api_restaurant_test_menu_10, get__api_restaurant_test_menus_11, delete__api_restaurant_test_menus_id_12, post__api_restaurant_test_gbp_posts_13, put__api_restaurant_test_gbp_reviews_id_draft_14, put__api_restaurant_test_followups_storeId_steps_stepId_messages_16, delete__api_restaurant_test_followups_storeId_bindings_stepId_17, post__api_restaurant_test_followups_storeId_request_start_18, post__api_restaurant_test_followups_storeId_stop_19, get__api_restaurant_test_reservations_id_confirmations_20, get__api_restaurant_test_followups_storeId_review_history_21, put__api_restaurant_test_line_flows_id_22, post__api_restaurant_test_reservations_holds_23, get__api_restaurant_test_reservations_day_24, get__api_restaurant_test_customers_history_25, get__api_restaurant_test_customers_search_26, get__api_restaurant_test_inventory_day_27 } from './restaurant-test-store-resources-handlers.js';
import { updateRestaurantMenu } from './restaurant-test-definition.js';
import { post__api_restaurant_test_inventory_generate_1, get__api_restaurant_test_login_members_2, put__api_restaurant_test_memberships_id_login_3, get__api_restaurant_test_inventory_rules_4, put__api_restaurant_test_inventory_rules_5, get__api_restaurant_test_channel_close_tasks_6, post__api_restaurant_test_channel_close_tasks_id_opened_7, post__api_restaurant_test_channel_close_tasks_id_done_8, get__api_restaurant_test_media_9, post__api_restaurant_test_media_10, get__api_restaurant_test_media_links_11, put__api_restaurant_test_media_links_code_12, post__api_restaurant_test_reservation_link_13, get__api_restaurant_test_closures_14, delete__api_restaurant_test_closures_id_15, get__api_restaurant_test_availability_16, get__api_restaurant_test_closures_id_contact_status_17, get__api_restaurant_test_board_18, post__api_restaurant_test_floors_19, get__api_restaurant_test_floors_20, put__api_restaurant_test_floors_order, put__api_restaurant_test_floors_id_21, delete__api_restaurant_test_floors_id, get__api_restaurant_test_rotation_22, get__api_restaurant_test_reservations_id_23, get__api_restaurant_test_store_groups_24, post__api_restaurant_test_store_groups_25, patch__api_restaurant_test_store_groups_id_members_storeId_26, put__api_restaurant_test_stores_id_referral_location_27 } from './restaurant-test-inventory-handlers.js';

/**
 * 飲食店向け（テスト）の専用API。
 *
 * 媒体連携は管理者が投入した受信データを検証する一方向である。
 * 手動予約の確認通知は、明示的に選んだときだけ既存のHarness経路で送る。
 */
export const restaurantTest = new Hono<Env>();
export { insertSeatWaitlistEntry } from './restaurant-test-definition.js';

restaurantTest.use('/api/restaurant-test/*', use__api_restaurant_test__1);

restaurantTest.onError(onError_route_2);

restaurantTest.use('*',use___3);

restaurantTest.use('/api/restaurant-test/*', use__api_restaurant_test__4);

/** 統括全体の店舗一覧なので、セッションの店舗絞込を適用しない。 */
restaurantTest.get('/api/restaurant-test/assignment-settings', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_assignment_settings_5);

restaurantTest.put('/api/restaurant-test/assignment-settings', requireRole('owner', 'admin', 'staff'), requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), put__api_restaurant_test_assignment_settings_6);

registerRestaurantSetupProgressRoutes(restaurantTest);

restaurantTest.get('/api/restaurant-test/stores', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_stores_7);

/** 固定の店舗表示は読み取り専用のコンテキストを使う。 */
restaurantTest.get('/api/restaurant-test/store-context', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_store_context_8);

/** 組織の最新同意だけを取得し、関係しない資格情報を選択しない。 */
restaurantTest.get('/api/restaurant-test/terms-agreement', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_terms_agreement_9);

/** 同じ組織・版の同意を冪等に記録し、IP などの個人情報を残さない。 */
restaurantTest.post('/api/restaurant-test/terms-agreement', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_restaurant_test_terms_agreement_10);

/** 同じ組織の店舗だけを、既存の不透明な管理セッションへ保存する。 */
restaurantTest.post('/api/restaurant-test/stores/:id/select', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), post__api_restaurant_test_stores_id_select_11);

/** 店舗の絞込を解除し、組織全体の統括画面へ戻す。 */
restaurantTest.post('/api/restaurant-test/stores/selection/clear', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), post__api_restaurant_test_stores_selection_clear_12);

restaurantTest.get('/api/restaurant-test/snapshot', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_snapshot_13);

/** 店舗作成の4段階をサーバーで一括確定し、接続失敗時に店舗や LINE アカウントだけを残さない。送信前の入力はブラウザに保持する。 */
restaurantTest.post('/api/restaurant-test/stores/connect', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_restaurant_test_stores_connect_14);

/** LINE公式アカウントを必ず1つ割り当てて店舗を作成する。 */
restaurantTest.post('/api/restaurant-test/stores', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_restaurant_test_stores_15);

/** 店舗は削除せず、不要になった場合はarchivedへ変更する。 */
restaurantTest.patch('/api/restaurant-test/stores/:id', requireRole('owner', 'admin'), inputJsonBoundary(), patch__api_restaurant_test_stores_id_16);

/** 店舗で現在受信できる予約メール取り込みアドレスを確認する。 */
restaurantTest.get('/api/restaurant-test/intake-addresses', requireRole('owner', 'admin'), get__api_restaurant_test_intake_addresses_17);

/** 店舗の予約メール取り込みアドレスを発行・再発行する。 */
restaurantTest.post('/api/restaurant-test/intake-addresses', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["string"]}), post__api_restaurant_test_intake_addresses_18);

restaurantTest.get('/api/restaurant-test/channels', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_channels_19);

restaurantTest.get('/api/restaurant-test/inbound-emails', requireRole('owner', 'admin'), get__api_restaurant_test_inbound_emails_20);

restaurantTest.post('/api/restaurant-test/inbound-emails/:id/manual-import', requireRole('owner', 'admin'), inputJsonBoundary(), post__api_restaurant_test_inbound_emails_id_manual_import_1);

restaurantTest.patch('/api/restaurant-test/approvals/:id', requireRole('owner', 'admin'), inputJsonBoundary({"action":["string"],"comment":["string"]}), patch__api_restaurant_test_approvals_id_2);

restaurantTest.post('/api/restaurant-test/reservations/manual', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), post__api_restaurant_test_reservations_manual_3);

restaurantTest.post('/api/restaurant-test/reservations/walk-in', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), post__api_restaurant_test_reservations_walk_in_4);

/**
 * 登録後の予約を変更・取消・再配席する。日時・人数・卓の変更は
 * 重なり検査と在庫連動を通し、取消は在庫を戻す（物理削除はしない）。
 */
restaurantTest.patch('/api/restaurant-test/reservations/:id', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), patch__api_restaurant_test_reservations_id_5);

restaurantTest.post('/api/restaurant-test/seat-waitlist', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), post__api_restaurant_test_seat_waitlist_6);

restaurantTest.get('/api/restaurant-test/seat-waitlist', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_seat_waitlist_7);

restaurantTest.delete('/api/restaurant-test/seat-waitlist/:id', requireRole('owner', 'admin', 'staff'), delete__api_restaurant_test_seat_waitlist_id_8);

/**
 * 招待ずみの組が予約を取ったとき、待ちを「予約になった」へ進める。
 * 同じ店・同じ開始時刻・同じ組の予約だけ受け付ける。
 */
restaurantTest.post('/api/restaurant-test/seat-waitlist/:id/convert', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), post__api_restaurant_test_seat_waitlist_id_convert_9);

restaurantTest.post('/api/restaurant-test/reservations/:id/attendance',requireRole('owner','admin','staff'),inputJsonBoundary(),post__api_restaurant_test_reservations_id_attendance_10);

restaurantTest.post('/api/restaurant-test/reservations/:id/visit',requireRole('owner','admin','staff'),inputJsonBoundary(),post__api_restaurant_test_reservations_id_visit_11);

restaurantTest.delete('/api/restaurant-test/reservations/:id/visit',requireRole('owner','admin','staff'),delete__api_restaurant_test_reservations_id_visit_12);

/**
 * 予約媒体の受信検証口。管理画面セッションでのみ投入でき、外部媒体へ返す処理は無い。
 * 本接続時は媒体ごとの署名アダプターをこの前段に置く。
 */
restaurantTest.post('/api/restaurant-test/inbound/reservations', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["string"],"eventId":["string"]}), post__api_restaurant_test_inbound_reservations_13);

restaurantTest.put('/api/restaurant-test/tables/layout', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["string"],"tables":["array"]}), put__api_restaurant_test_tables_layout_1);

restaurantTest.post('/api/restaurant-test/tables', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["string"],"code":["string"],"label":["string"],"seatType":["string"],"minCapacity":["number"],"maxCapacity":["number"],"floorX":["number"],"floorY":["number"],"joinGroup":["null","string"]}), post__api_restaurant_test_tables_2);

restaurantTest.post('/api/restaurant-test/memberships', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["null","string"],"staffName":["string"],"email":["string"],"role":["string"],"lineUid":["string"],"googleEmail":["string"]}), post__api_restaurant_test_memberships_3);

restaurantTest.delete('/api/restaurant-test/tables/:id', requireRole('owner', 'admin'), delete__api_restaurant_test_tables_id);

restaurantTest.patch('/api/restaurant-test/tables/:id', requireRole('owner', 'admin'), inputJsonBoundary({"code":["string"],"label":["string"],"seatType":["string"],"minCapacity":["number"],"maxCapacity":["number"],"isActive":["boolean"],"floorX":["number"],"floorY":["number"],"joinGroup":["null","string"]}), patch__api_restaurant_test_tables_id_4);

restaurantTest.patch('/api/restaurant-test/memberships/:id', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["null","string"],"staffName":["string"],"email":["null","string"],"role":["string"],"lineUid":["null","string"],"googleEmail":["null","string"],"status":["string"],"expectedPolicyVersion":["number"],"idempotencyKey":["string"]}), patch__api_restaurant_test_memberships_id_5);

restaurantTest.patch('/api/restaurant-test/menu/:id', requireRole('owner', 'admin'), inputJsonBoundary({"kind":["string"],"name":["string"],"price":["number"],"allergens":["array"],"servicePeriods":["array"],"status":["string"],"effectiveAt":["null","string"],"description":["null","string"],"imageMediaId":["null","string"]}), updateRestaurantMenu);

restaurantTest.patch('/api/restaurant-test/menus/:id', requireRole('owner', 'admin'), inputJsonBoundary({"kind":["string"],"name":["string"],"price":["number"],"allergens":["array"],"servicePeriods":["array"],"status":["string"],"effectiveAt":["null","string"],"description":["null","string"],"imageMediaId":["null","string"]}), updateRestaurantMenu);

// 飲食の既存の統括/店/機能の境界を先に通す。
for (const method of ['get','put'] as const) {
  restaurantTest[method]('/api/restaurant-test/menus/:id/payment',requireRole('owner','admin','staff'),async c => {
    c.header('Cache-Control','no-store');
    if (method==='put' && (c.get('staff').readOnly || c.get('staff').role==='staff')) return c.json({success:false,error:'forbidden'},403);
    if (!accountId(c)) return requiredAccount(c);
    const organization=await organizationFor(c);
    if (!organization) return c.json({success:false,error:'not_found'},404);
    const menu=await dbFor(c.env).prepare(`SELECT m.id,m.store_id FROM rt_menu_items m JOIN rt_stores s ON s.id=m.store_id
      WHERE m.id=? AND m.kind='course' AND s.organization_id=? AND s.line_account_id=?
      AND (? IS NULL OR s.id=?)`)
      .bind(c.req.param('id'),organization.id,accountId(c),organization.scopedStoreId,organization.scopedStoreId).first<{id:string;store_id:string}>();
    if (!menu) return c.json({success:false,error:'not_found'},404);
    return paymentSettingResponse(c,dbFor(c.env,menu.store_id),{kind:'course',id:menu.id,account:accountId(c)!,storeId:menu.store_id},'mode');
  });
}

/** 全枠を一括保存し、どれか一つの版が古ければ一件も変更しない。 */
restaurantTest.put('/api/restaurant-test/inventory/allocation', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["string"],"slots":["array"],"otaCapacity":["number"],"lineCapacity":["number"],"walkInCapacity":["number"],"sameDayCapacity":["number"]}), put__api_restaurant_test_inventory_allocation_6);

restaurantTest.put('/api/restaurant-test/inventory/:id', requireRole('owner', 'admin'), inputJsonBoundary(), put__api_restaurant_test_inventory_id_7);

restaurantTest.get('/api/restaurant-test/opening-hours', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_opening_hours_8);

restaurantTest.put('/api/restaurant-test/opening-hours', requireRole('owner', 'admin'), inputJsonBoundary(), put__api_restaurant_test_opening_hours_9);

restaurantTest.post('/api/restaurant-test/menu', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["string"],"kind":["string"],"name":["string"],"price":["number"],"allergens":["array"],"servicePeriods":["array"],"status":["string"],"description":["null","string"],"imageMediaId":["null","string"]}), post__api_restaurant_test_menu_10);

restaurantTest.get('/api/restaurant-test/menus', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_menus_11);

restaurantTest.delete('/api/restaurant-test/menus/:id', requireRole('owner', 'admin'), delete__api_restaurant_test_menus_id_12);

restaurantTest.post('/api/restaurant-test/gbp/posts', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["string"],"postType":["string"],"title":["string"],"body":["string"],"ctaType":["string"],"ctaUrl":["string"]}), post__api_restaurant_test_gbp_posts_13);

restaurantTest.put('/api/restaurant-test/gbp/reviews/:id/draft', requireRole('owner', 'admin'), inputJsonBoundary({"replyDraft":["string"]}), put__api_restaurant_test_gbp_reviews_id_draft_14);

restaurantTest.get('/api/restaurant-test/followups/:storeId',requireRole('owner','admin','staff'),get__api_restaurant_test_followups_storeId_15);

restaurantTest.get('/api/restaurant-test/followups/:storeId/reservation-form',requireRole('owner','admin','staff'),getRestaurantReservationForm);
restaurantTest.put('/api/restaurant-test/followups/:storeId/reservation-form',requireRole('owner','admin'),inputJsonBoundary(),putRestaurantReservationForm);
restaurantTest.get('/api/restaurant-test/followups/:storeId/engines',requireRole('owner','admin','staff'),getRestaurantFollowupEngines);
restaurantTest.post('/api/restaurant-test/followups/:storeId/engines/initialize',requireRole('owner','admin'),inputJsonBoundary(),initializeRestaurantFollowupEngines);
restaurantTest.post('/api/restaurant-test/followups/:storeId/engines/:trigger/draft',requireRole('owner','admin'),inputJsonBoundary(),saveRestaurantFollowupEngine);
restaurantTest.post('/api/restaurant-test/followups/:storeId/engines/:trigger/test-send',requireRole('owner','admin'),inputJsonBoundary(),testRestaurantFollowupEngineHandler);
restaurantTest.post('/api/restaurant-test/followups/:storeId/engines/:trigger/start',requireRole('owner','admin'),inputJsonBoundary(),startRestaurantFollowupEngineHandler);

restaurantTest.put('/api/restaurant-test/followups/:storeId/setup',requireRole('owner','admin'),inputJsonBoundary(),putRestaurantFollowupSetup);
restaurantTest.put('/api/restaurant-test/followups/:storeId/rows/:trigger',requireRole('owner','admin'),inputJsonBoundary(),putRestaurantFollowupRow);

// 同じ共通シナリオの行へ保存し、既存トリガーで旧承認を失効させる。
restaurantTest.put('/api/restaurant-test/followups/:storeId/steps/:stepId/messages',requireRole('owner','admin'),inputJsonBoundary(),put__api_restaurant_test_followups_storeId_steps_stepId_messages_16);

restaurantTest.post('/api/restaurant-test/followups/:storeId/bindings/:stepId',requireRole('owner','admin'),inputJsonBoundary(),updateRestaurantFollowupBinding);

restaurantTest.patch('/api/restaurant-test/followups/:storeId/bindings/:stepId',requireRole('owner','admin'),inputJsonBoundary(),updateRestaurantFollowupBinding);

restaurantTest.delete('/api/restaurant-test/followups/:storeId/bindings/:stepId',requireRole('owner','admin'),inputJsonBoundary(),delete__api_restaurant_test_followups_storeId_bindings_stepId_17);

restaurantTest.post('/api/restaurant-test/followups/:storeId/request-start',requireRole('owner','admin'),inputJsonBoundary(),post__api_restaurant_test_followups_storeId_request_start_18);

restaurantTest.post('/api/restaurant-test/followups/:storeId/stop',requireRole('owner','admin'),post__api_restaurant_test_followups_storeId_stop_19);

restaurantTest.get('/api/restaurant-test/reservations/:id/confirmations',requireRole('owner','admin','staff'),get__api_restaurant_test_reservations_id_confirmations_20);

restaurantTest.get('/api/restaurant-test/followups/:storeId/review-history',requireRole('owner','admin','staff'),get__api_restaurant_test_followups_storeId_review_history_21);

restaurantTest.put('/api/restaurant-test/line-flows/:id', requireRole('owner', 'admin'), inputJsonBoundary({"title":["string"],"body":["string"],"timingMinutes":["null","number"],"isEnabled":["boolean"]}), put__api_restaurant_test_line_flows_id_22);

restaurantTest.post('/api/restaurant-test/reservations/holds', requireRole('owner', 'admin', 'staff'), inputJsonBoundary(), post__api_restaurant_test_reservations_holds_23);

/** 500件の一覧ページ上限を使わず、店舗の暦日に重なる予約をすべて取得する。 */
restaurantTest.get('/api/restaurant-test/reservations/day', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_reservations_day_24);

restaurantTest.get('/api/restaurant-test/customers/history', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_customers_history_25);

restaurantTest.get('/api/restaurant-test/customers/search', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_customers_search_26);

restaurantTest.get('/api/restaurant-test/inventory/day', requireRole('owner', 'admin', 'staff'), get__api_restaurant_test_inventory_day_27);

restaurantTest.post('/api/restaurant-test/inventory/generate', requireRole('owner', 'admin'), inputJsonBoundary({"storeId":["string"],"date":["string"],"expectedHoursVersion":["number"],"otaCapacity":["number"],"lineCapacity":["number"],"walkInCapacity":["number"],"sameDayCapacity":["number"]}), post__api_restaurant_test_inventory_generate_1);

restaurantTest.get('/api/restaurant-test/login-members', requireRole('owner','admin'), get__api_restaurant_test_login_members_2);

restaurantTest.put('/api/restaurant-test/memberships/:id/login', requireRole('owner','admin'), inputJsonBoundary({"staffId":["null","string"]}), put__api_restaurant_test_memberships_id_login_3);

restaurantTest.get('/api/restaurant-test/inventory-rules',requireRole('owner','admin','staff'),get__api_restaurant_test_inventory_rules_4);

restaurantTest.put('/api/restaurant-test/inventory-rules',requireRole('owner','admin'),inputJsonBoundary(), put__api_restaurant_test_inventory_rules_5);

restaurantTest.get('/api/restaurant-test/channel-close-tasks',requireRole('owner','admin','staff'),get__api_restaurant_test_channel_close_tasks_6);

restaurantTest.post('/api/restaurant-test/channel-close-tasks/:id/opened',requireRole('owner','admin','staff'),inputJsonBoundary(),post__api_restaurant_test_channel_close_tasks_id_opened_7);

restaurantTest.post('/api/restaurant-test/channel-close-tasks/:id/done',requireRole('owner','admin','staff'),inputJsonBoundary(), post__api_restaurant_test_channel_close_tasks_id_done_8);

restaurantTest.get('/api/restaurant-test/media', requireRole('owner','admin','staff'), get__api_restaurant_test_media_9);

restaurantTest.post('/api/restaurant-test/media', requireRole('owner','admin'), inputJsonBoundary(), post__api_restaurant_test_media_10);

restaurantTest.get('/api/restaurant-test/media-links', requireRole('owner','admin','staff'),get__api_restaurant_test_media_links_11);

restaurantTest.put('/api/restaurant-test/media-links/:code', requireRole('owner','admin'),inputJsonBoundary({"storeId":["string"],"closeOnBooking":["boolean"],"expectedVersion":["number"]}), put__api_restaurant_test_media_links_code_12);

restaurantTest.post('/api/restaurant-test/reservation-link', requireRole('owner','admin'),inputJsonBoundary({"storeId":["string"]}), post__api_restaurant_test_reservation_link_13);

restaurantTest.get('/api/restaurant-test/closures', requireRole('owner','admin','staff'), get__api_restaurant_test_closures_14);

/** previewも保存も同じ検査・影響計算。版はPATCH/DELETEで必須。 */
for(const action of ['preview','create','patch'] as const) {
 const path=action==='preview'?'/api/restaurant-test/closures/preview':action==='create'?'/api/restaurant-test/closures':'/api/restaurant-test/closures/:id';
 restaurantTest.on(action==='patch'?'PATCH':'POST',path,requireRole('owner','admin','staff'),async c=>{
  if(!hasOrganizationSelector(c))return requiredAccount(c);
  const org=await organizationFor(c),b=await c.req.json().catch(()=>null);
  if(!org||!b||typeof b.storeId!=='string'||!await storeBelongsTo(c,org.id,b.storeId))return inputError(c, {success:false,error:'店舗が正しくありません'}, 400, ["storeId"]);
  const db=dbFor(c.env,b.storeId),store=await db.prepare('SELECT timezone FROM rt_stores WHERE id=?').bind(b.storeId).first<{timezone:string}>();
  const checked=validateClosure(b,store!.timezone);
  if(!checked)return inputError(c, {success:false,error:'日付・時間帯・種類・卓を確認してください（過去日は登録不可、期間は366日以内）'}, 400, ["storeId"]);
  const {input,periods}=checked;
  if(input.tableIds!.length){const tables=await db.prepare('SELECT id FROM rt_tables WHERE store_id=? AND is_active=1').bind(input.storeId).all<{id:string}>();
   if(input.tableIds!.some(id=>!tables.results.some(t=>t.id===id)))return inputError(c, {success:false,error:'ほかの店舗・停止中の卓は指定できません'}, 400, ["storeId","tableIds"]);}
  const id=action==='patch'?c.req.param('id'):crypto.randomUUID();
  const excluded=action==='preview'?b.excludeId:undefined;
  if(excluded!==undefined&&(typeof excluded!=='string'||!excluded||excluded.length>160))return inputError(c, {success:false,error:'除外する記録を確認してください'}, 400, ["excludeId"]);
  if(excluded&&!await db.prepare('SELECT id FROM rt_closures WHERE id=? AND store_id=? AND archived_at IS NULL').bind(excluded,input.storeId).first())return c.json({success:false,error:'除外する休業・貸切がありません'},404);
  const current=action==='patch'?await db.prepare('SELECT * FROM rt_closures WHERE id=? AND store_id=? AND archived_at IS NULL').bind(id,input.storeId).first<ClosureRow>():null;
  if(action==='patch'&&!current)return c.json({success:false,error:'休業・貸切がありません'},404);
  if(action==='patch'&&(!Number.isSafeInteger(b.expectedVersion)||b.expectedVersion<1))return inputError(c, {success:false,error:'読み込んだ版を指定してください'}, 400, ["expectedVersion"]);
  if(current&&current.version!==b.expectedVersion)return c.json({success:false,error:'version_conflict',currentVersion:current.version},409);
  const key=`reservation:${input.storeId}`,owner=crypto.randomUUID();
  if(action!=='preview'&&!await acquireLock(db,key,owner))return c.json({success:false,error:'同じ店舗を更新中です'},409);
  try {
   // The table could have been deleted after the initial validation and before this lock.
   if(action!=='preview' && input.tableIds!.length){
    const tables=await db.prepare('SELECT id FROM rt_tables WHERE store_id=? AND is_active=1').bind(input.storeId).all<{id:string}>();
    if(input.tableIds!.some(id=>!tables.results.some(t=>t.id===id)))return inputError(c,{success:false,error:'ほかの店舗・停止中の卓は指定できません'},400,['storeId','tableIds']);
   }
   const preview=await closurePreview(db,input,periods,current?.id??excluded??null);
   if(preview.conflicts.length)return c.json({success:false,error:'休業・貸切が重なっています',code:'closure_overlap',data:preview},409);
   if(action==='preview')return c.json({success:true,data:preview});
   const values=[input.startDate,input.endDate,Number(input.allDay),input.startTime,input.endTime,input.kind,input.memo,JSON.stringify(input.tableIds),JSON.stringify(periods),Number(input.notifyMedia)];
   try {
    if(action==='patch'){
     const saved=await db.prepare(`UPDATE rt_closures SET start_date=?,end_date=?,all_day=?,start_time=?,end_time=?,kind=?,memo=?,table_ids_json=?,periods_json=?,notify_media=?,version=version+1,updated_at=datetime('now')
     WHERE id=? AND store_id=? AND version=? AND archived_at IS NULL`).bind(...values,id,input.storeId,b.expectedVersion).run();
     if(!saved.meta.changes)return c.json({success:false,error:'version_conflict'},409);
    }else await db.prepare(`INSERT INTO rt_closures(start_date,end_date,all_day,start_time,end_time,kind,memo,table_ids_json,periods_json,notify_media,id,store_id,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(...values,id,input.storeId,c.get('staff')?.id??null,c.get('staff')?.name??null).run();
   }catch(error){if(String(error).includes('closure_overlap'))return c.json({success:false,error:'休業・貸切が重なっています',code:'closure_overlap',data:await closurePreview(db,input,periods,current?.id??excluded??null)},409);throw error;}
   const row=(await db.prepare('SELECT * FROM rt_closures WHERE id=?').bind(id).first<ClosureRow>())!;
   return c.json({success:true,data:{closure:publicClosure(row),...await closurePreview(db,input,periods,id)}},action==='create'?201:200);
  }finally {if(action!=='preview')await releaseLock(db,key,owner);}
 });
}

restaurantTest.delete('/api/restaurant-test/closures/:id',requireRole('owner','admin','staff'),delete__api_restaurant_test_closures_id_15);

restaurantTest.get('/api/restaurant-test/availability',requireRole('owner','admin','staff'),get__api_restaurant_test_availability_16);

for(const method of ['GET','PUT'] as const)restaurantTest.on(method,'/api/restaurant-test/close-notification-settings',requireRole('owner','admin','staff'),async c=>{
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),b=method==='PUT'?await c.req.json().catch(()=>null):null,storeId=method==='PUT'?b?.storeId:c.req.query('storeId');
 if(!org||typeof storeId!=='string'||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,code:'restaurant_store_mismatch',error:'店舗が正しくありません'},404);
 try{return c.json({success:true,data:method==='GET'?await readCloseNotificationSettings(dbFor(c.env,storeId),storeId):await saveCloseNotificationSettings(dbFor(c.env,storeId),storeId,b)});}
 catch(e){if(e instanceof StampError)return inputError(c, {success:false,error:e.message}, e.status, []);throw e;}
});

restaurantTest.get('/api/restaurant-test/closures/:id/contact-status',requireRole('owner','admin','staff'),get__api_restaurant_test_closures_id_contact_status_17);

restaurantTest.get('/api/restaurant-test/board',requireRole('owner','admin','staff'),get__api_restaurant_test_board_18);

restaurantTest.post('/api/restaurant-test/floors',requireRole('owner','admin'),inputJsonBoundary(),post__api_restaurant_test_floors_19);

restaurantTest.get('/api/restaurant-test/floors',requireRole('owner','admin','staff'),get__api_restaurant_test_floors_20);

restaurantTest.put('/api/restaurant-test/floors/order',requireRole('owner','admin'),inputJsonBoundary(),put__api_restaurant_test_floors_order);

restaurantTest.put('/api/restaurant-test/floors/:id',requireRole('owner','admin'),inputJsonBoundary(),put__api_restaurant_test_floors_id_21);
restaurantTest.delete('/api/restaurant-test/floors/:id',requireRole('owner','admin'),inputJsonBoundary(),delete__api_restaurant_test_floors_id);

restaurantTest.get('/api/restaurant-test/rotation',requireRole('owner','admin','staff'),get__api_restaurant_test_rotation_22);

restaurantTest.get('/api/restaurant-test/reservations/:id',requireRole('owner','admin','staff'),get__api_restaurant_test_reservations_id_23);

// 系列への案内を許可する操作。店舗やアカウントの閲覧権限は広げない。
restaurantTest.get('/api/restaurant-test/store-groups',requireRole('owner','admin','staff'),get__api_restaurant_test_store_groups_24);

restaurantTest.post('/api/restaurant-test/store-groups',requireRole('owner','admin'),inputJsonBoundary(),post__api_restaurant_test_store_groups_25);

restaurantTest.patch('/api/restaurant-test/store-groups/:id/members/:storeId',requireRole('owner','admin'),inputJsonBoundary(),patch__api_restaurant_test_store_groups_id_members_storeId_26);

restaurantTest.put('/api/restaurant-test/stores/:id/referral-location',requireRole('owner','admin'),inputJsonBoundary(),put__api_restaurant_test_stores_id_referral_location_27);
