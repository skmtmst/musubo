import { liffBookingJson, liffBookingInputError, liffBookingResponse } from '../liff-booking-response.js';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { depositEstimate, cancellationCardRequired } from '../../features/booking/booking-deposit/index.js';
import { assertPassRequirement } from '../../features/booking/booking-pass-plans/index.js';
import { verifyRoutingToken } from '../../features/forms/form-routing/index.js';
import { bookingAddons } from '../../features/booking/booking-addons/index.js';
import { menuAudience } from '../../features/booking/booking-audience/index.js';
import { cancellationPolicy, requireCancellationTestConnection } from '../../features/booking/booking-cancellation/index.js';
import { EntitlementError, entitlementUseStatement, validateEntitlementSelection } from '../../features/booking/booking-entitlements/index.js';
import { bookingPaymentSelection, defaultBookingPaymentSelection } from '../../features/booking/booking-payment-selection/index.js';
import { resolveFormBookingAnswer, FormBookingAnswerError } from '../../features/forms/form-booking-answer/index.js';
import { notifyForBooking } from '../../features/booking/booking-notification/index.js';
import { confirmationWorkflowStatement, runConfirmedBookingSideEffects } from '../../features/booking/booking-confirmed-effects/index.js';
import { inputJsonBoundary } from '../../lib/input-errors.js';
import { BOOKING_PERSON_LIMIT_GUARD_SQL, bookingPersonLimitBindings, bookingPersonLimitError } from '../../features/booking/booking-person-limit/index.js';
import { getBookingAdminSettings, bookingPaymentInsertStatement, getBookingPaymentByBooking, decidePrepayOnly, prepayNoticeFor, resolveBookingPaymentForBooking } from '@line-crm/db';
import { enrollByTrigger } from '../../services/reminder-trigger.js';
import { getAccountTimeZone, getStoreCapacitySnapshot } from '../../services/availability.js';
import { STORE_CAPACITY_GUARD_SQL, STORE_SETTINGS_VERSION_GUARD_SQL } from '../../features/booking/booking-store-capacity/index.js';
import { BOOKING_RESOURCE_CAPACITY_GUARD_SQL, bookingResourceGuardBindings, insertBookingWithResourceSnapshot } from '../../features/booking/booking-resource-capacity/index.js';
import { completeIdempotencyResponse, findIdempotencyResponse, releaseReservedIdempotencyResponse, reserveIdempotencyResponse } from '../../features/booking/booking-idempotency/index.js';
import { dispatchOperatorEvent } from '../../services/operator-notification-dispatch.js';
import { fireOutgoingWebhooks } from '../../services/event-bus.js';
import { attachTagAndFireSideEffects } from '../../features/friends/friend-tag-attach/index.js';
import { DEFAULT_ACCOUNT_SETTINGS, IDEMPOTENCY_TTL_MINUTES, type BookingStatus } from '../../features/booking/booking-types/index.js';
import { awardActivityMileage } from '../../services/activity-mileage.js';
import { applyActionScoreEvent } from '../../services/action-score-events.js';
import { recordBookingAudit } from '@line-crm/db';
import { resolveAccountIdFromLiff, verifyCallerLineUserId, resolveFriendId } from './identity.js';
import { needsAutoAssignment, autoAssignBookingStaff } from './assignment.js';
import { reverifyLatestSlot, googleCredentials } from './availability.js';
import { buildMenuSnapshot, isAssignableAutoTag } from './menu-snapshot.js';

export function registerLiffCreate(booking: Hono<Env>): void {
booking.post('/api/liff/booking/requests', inputJsonBoundary({"menu_id":["string"],"staff_id":["string"],"starts_at":["string"],"customer_note":["string"],"waitlist_id":["string"]}), async (c) => {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return liffBookingJson(c, { error: 'unknown_liff' }, 404);
  let idemKey = c.req.header('Idempotency-Key');
  if (!idemKey) return liffBookingInputError(c, { error: 'missing_idempotency_key' }, 400, []);

  // 認証済み caller の LINE userId を Authorization: Bearer <id_token> から取得。
  const callerLineUserId = await verifyCallerLineUserId(c, accountId);
  if (!callerLineUserId) return liffBookingJson(c, { error: 'unauthorized' }, 401);

  const body = await c.req.json<{
    menu_id: string;
    staff_id: string;
    starts_at: string; // UTC の ISO8601。
    customer_note?: string;
    party_size?: unknown;
    entitlement_id?: string;
    addonIds?:string[];
    routingToken?:string;
    recurrence?:unknown;members?:unknown;
    policyAccepted?: boolean;
    policyVersion?: number;
    setupIntentId?: string;
    meeting_mode?: 'online'|'in_person';
    payment_method?: 'onsite' | 'online';
    waitlist_id?: string;
    formAnswer?: {formId:string;blockId:string;submissionKey:string};
  }>();
  if((body as Record<string,unknown>).routing_token!==undefined){if(body.routingToken!==undefined&&body.routingToken!==(body as Record<string,unknown>).routing_token)return liffBookingJson(c, {error:'routing_token_invalid'},400);body.routingToken=String((body as Record<string,unknown>).routing_token);}
  if(body.recurrence!==undefined||body.members!==undefined){
    const friend=await resolveFriendId(c,callerLineUserId,accountId);if(!friend)return liffBookingJson(c, {error:'friend_not_found'},404);
    const {createBulkBooking}=await import('../../features/booking/booking-bulk/index.js');return liffBookingResponse(c, await createBulkBooking(c,accountId,friend,body as Record<string,unknown>));
  }
  try { await assertPassRequirement(c.env.DB,accountId,body.menu_id,body.entitlement_id); } catch(e) { if(e instanceof EntitlementError)return liffBookingJson(c, {error:e.code},e.status);throw e; }
  if (body.entitlement_id !== undefined && (typeof body.entitlement_id !== 'string' || !body.entitlement_id)) return liffBookingInputError(c,{error:'invalid_entitlement_id'},400,['entitlement_id']);
  if (body.payment_method !== undefined && !['onsite','online'].includes(body.payment_method)) return liffBookingInputError(c,{error:'invalid_payment_method'},400,['payment_method']);
  if (body.party_size !== undefined && body.party_size !== 1) return liffBookingInputError(c, { error: 'unsupported_party_size' }, 422, ["party_size"]);
  const friendId = await resolveFriendId(c, callerLineUserId, accountId);
  if (!friendId) return liffBookingJson(c, { error: 'friend_not_found' }, 404);
  let formRequiresApproval = false;
  if (body.formAnswer !== undefined) {
    try {
      const source = await resolveFormBookingAnswer(c.env.DB,body.formAnswer,accountId,friendId,await getAccountTimeZone(c.env.DB,accountId));
      body.menu_id=source.menuId; body.staff_id=source.staffId; body.starts_at=source.startsAt;
      delete body.waitlist_id;
      idemKey=source.idempotencyKey; formRequiresApproval=source.requireApproval;
    } catch(error) {
      if(error instanceof FormBookingAnswerError)return liffBookingJson(c, {error:error.message},error.status);
      throw error;
    }
  }
  if (!body.menu_id || !body.starts_at) return liffBookingInputError(c,{error:'missing_params'},400,['menu_id','starts_at']);

  // Idempotency lookup は account+friend スコープ。同じ key を別 caller が送っても
  // それぞれの caller のキャッシュを返す（=cross-tenant leak 防止）。
  const cached = await findIdempotencyResponse(c.env.DB, {
    key: idemKey,
    lineAccountId: accountId,
    friendId,
    now: new Date(),
  });
  if (cached) {
    if (cached.status !== 202) {
      const response = cached.body as { booking_id?: string; payment?: unknown; payment_required?: boolean };
      if (cached.status === 201 && response.booking_id && !response.payment && response.payment_required !== false) {
        const saved = await c.env.DB.prepare(`SELECT menu_id, price_at_booking FROM bookings
          WHERE id = ? AND line_account_id = ? AND friend_id = ?`)
          .bind(response.booking_id, accountId, friendId).first<{ menu_id: string; price_at_booking: number }>();
        if (saved && saved.price_at_booking > 0
          && (await resolveBookingPaymentForBooking(c.env.DB, accountId, response.booking_id, saved.menu_id)).mode === 'online'
          && !await getBookingPaymentByBooking(c.env.DB, accountId, response.booking_id)) {
          return liffBookingJson(c, { error: 'booking_payment_unavailable' }, 500);
        }
      }
      return liffBookingJson(c, cached.body as Record<string, unknown>, cached.status as 200 | 201 | 400 | 409 | 422);
    }
    // 完成応答を書けなかった要求は、先に確保した予約IDを本人の範囲で引く。
    // INSERT前の同時要求は409で待たせる。保存済みの予約は作り直さず、
    // 通知・タグ等の副作用もこの再送口から重ねて実行しない。
    const pendingBookingId = (cached.body as { booking_id?: unknown }).booking_id;
    if (typeof pendingBookingId === 'string') {
      const saved = await c.env.DB.prepare(
        `SELECT id, status, menu_id, price_at_booking FROM bookings WHERE id = ? AND line_account_id = ? AND friend_id = ?`,
      ).bind(pendingBookingId, accountId, friendId).first<{ id: string; status: string; menu_id: string; price_at_booking: number }>();
      if (saved) {
        const payment = await getBookingPaymentByBooking(c.env.DB, accountId, saved.id);
        const requiresPayment = saved.price_at_booking > 0
          && (await resolveBookingPaymentForBooking(c.env.DB, accountId, saved.id, saved.menu_id)).mode === 'online';
        if (requiresPayment && !payment) return liffBookingJson(c, { error: 'booking_payment_unavailable' }, 500);
        if (['expired','cancelled','rejected'].includes(saved.status)) return liffBookingJson(c, { error: 'booking_unavailable' }, 409);
        const prepayNotice = await prepayNoticeFor(
          c.env.DB, accountId, await decidePrepayOnly(c.env.DB, accountId, friendId),
        );
        return liffBookingJson(c, {
          booking_id: saved.id,
          status: saved.status,
          payment_required: requiresPayment,
          ...(payment ? { payment: { id: payment.id, status: payment.status, holdUntil: payment.hold_until } } : {}),
          ...(prepayNotice ? { prepayNotice } : {}),
        }, 201);
      }
    }
    return liffBookingJson(c, { error: 'request_in_progress' }, 409);
  }

  // 案内を受けた本人・枠・有効期限を確認してから、通常の予約確定処理を使う。
  if(body.waitlist_id){
   const offer=await c.env.DB.prepare(`SELECT id FROM booking_waitlist WHERE id=? AND line_account_id=? AND friend_id=? AND staff_id=? AND menu_id=? AND julianday(starts_at)=julianday(?) AND status='invited' AND julianday(hold_expires_at)>julianday('now')`).bind(body.waitlist_id,accountId,friendId,body.staff_id,body.menu_id,body.starts_at).first();
   if(!offer)return liffBookingJson(c, {error:'offer_expired'},409);
  }
  // ブロック中の顧客は予約できない。
  const friend = await c.env.DB
    .prepare(`SELECT is_following FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ is_following: number }>();
  if (!friend || friend.is_following === 0) {
    return liffBookingJson(c, { error: 'cannot_book' }, 403);
  }

  if(!(await menuAudience(c.env.DB,accountId,body.menu_id,friendId)).visible)return liffBookingJson(c, {error:'menu_not_available'},403);
  const addons=await bookingAddons(c.env.DB,accountId,body.menu_id,body.addonIds,friendId);
  if((await c.env.DB.prepare('SELECT addon_only FROM menus WHERE id=?').bind(body.menu_id).first<{addon_only:number}>())?.addon_only)return liffBookingJson(c, {error:'addon_only_menu'},400);
  const addonDuration=addons.reduce((n,a)=>n+a.duration_minutes,0);
  const nominated=!body.routingToken&&!(await needsAutoAssignment(c,accountId,body.staff_id));
  let routingAllowedStaff:string[]|undefined;
  if(body.routingToken){const claim=await verifyRoutingToken(c.env.DB,accountId,friendId,body.routingToken,body.menu_id,body.staff_id||undefined);if(claim.target.staffId)body.staff_id=claim.target.staffId;else body.staff_id='';
   if(claim.target.staffGroupId){const group=await c.env.DB.prepare('SELECT staff_ids_json FROM booking_routing_staff_groups WHERE id=? AND line_account_id=?').bind(claim.target.staffGroupId,accountId).first<{staff_ids_json:string}>();routingAllowedStaff=JSON.parse(group!.staff_ids_json);}}

  if (await needsAutoAssignment(c,accountId,body.staff_id)) {
    const assigned = await autoAssignBookingStaff(c,accountId,body.menu_id,body.starts_at,true,addonDuration,routingAllowedStaff,!!body.routingToken);
    if (!assigned) return liffBookingJson(c, { error: 'auto_assignment_unavailable' }, 409);
    body.staff_id = assigned;
  }

  // メニューと担当者の組が提供対象かを確認する。
  const menuRow = await c.env.DB
    .prepare(
      `SELECT m.id, m.name, m.duration_minutes, m.buffer_after_minutes, m.base_price,
              m.price_mode, m.version,m.meeting_mode,
              m.auto_tag_id, m.concurrent_capacity,
              COALESCE(sm.override_duration_minutes, m.duration_minutes) AS dur,
              COALESCE(sm.override_price, m.base_price) AS price,
              sm.is_offered
         FROM menus m
         LEFT JOIN staff_menus sm ON sm.menu_id = m.id AND sm.staff_id = ?2
        WHERE m.id = ?1 AND m.line_account_id = ?3
          AND m.deleted_at IS NULL AND m.is_active = 1`,
    )
    .bind(body.menu_id, body.staff_id, accountId)
    .first<{ name: string; duration_minutes: number; buffer_after_minutes: number; auto_tag_id: string | null; concurrent_capacity: number; dur: number; price: number; price_mode: string; meeting_mode:'online'|'in_person'|'customer_choice'; version: number; is_offered: number | null }>();
  if (!menuRow || menuRow.is_offered !== 1) {
    return liffBookingInputError(c, { error: 'menu_not_offered' }, 422, ["menu_id","staff_id"]);
  }

  const routing=body.routingToken?await verifyRoutingToken(c.env.DB,accountId,friendId,body.routingToken,body.menu_id,body.staff_id):null;
  const nominationFee=nominated?((await c.env.DB.prepare('SELECT nomination_fee FROM staff WHERE id=? AND line_account_id=?').bind(body.staff_id,accountId).first<{nomination_fee:number}>())?.nomination_fee??0):0;
  menuRow.price+=nominationFee+addons.reduce((n,a)=>n+a.base_price,0);
  menuRow.dur+=addonDuration;
  const cancellation = await cancellationPolicy(c.env.DB, accountId);
  if(cancellation.enabled && !body.entitlement_id) {
    if(body.policyAccepted!==true) return liffBookingJson(c, {error:'policy_acceptance_required'},400);
    if(body.policyVersion!==cancellation.version)return liffBookingJson(c, {error:'policy_changed'},409);
    if(await cancellationCardRequired(c.env.DB,accountId,friendId)){
    try {await requireCancellationTestConnection(c.env.DB,accountId);} catch {return liffBookingJson(c, {error:'payment_not_connected'},409);}
    if(typeof body.setupIntentId!=='string' || !await c.env.DB.prepare("SELECT id FROM booking_payment_methods WHERE setup_id=? AND friend_id=? AND line_account_id=? AND status='ready' AND test_mode=1")
      .bind(body.setupIntentId,friendId,accountId).first()) return liffBookingJson(c, {error:'card_not_registered'},409);
    }
  }

  if(routing?.target.meetingMode&&body.meeting_mode&&routing.target.meetingMode!==body.meeting_mode)return liffBookingJson(c, {error:'routing_token_invalid'},400);
  if(routing?.target.meetingMode)body.meeting_mode=routing.target.meetingMode;
  const bookingMeetingMode=menuRow.meeting_mode==='customer_choice'?body.meeting_mode:menuRow.meeting_mode;
  if(!['online','in_person'].includes(bookingMeetingMode??'') || (body.meeting_mode!==undefined&&body.meeting_mode!==bookingMeetingMode))return liffBookingJson(c, {error:'meeting_mode_required'},400);
  const startsAt = new Date(body.starts_at);
  if (Number.isNaN(startsAt.getTime())) {
    return liffBookingInputError(c, { error: 'invalid_starts_at' }, 422, ["starts_at"]);
  }
  if (startsAt < new Date()) {
    return liffBookingInputError(c, { error: 'past_datetime' }, 422, ["starts_at"]);
  }
  const endsAt = new Date(startsAt.getTime() + menuRow.dur * 60_000);
  const blockEndsAt = new Date(endsAt.getTime() + menuRow.buffer_after_minutes * 60_000);
  // 営業時間snapshotを空き枠の再計算より先に固定する。以後に営業時間が
  // 変われば、再計算が新条件で拒否するか、INSERT時のversion guardが
  // このsnapshotとの差を検知する。逆順だと両読取の間の閉店を見逃す。
  const storeCapacity = await getStoreCapacitySnapshot(c.env.DB, accountId, startsAt, blockEndsAt);

  // Server-side availability 再検証: 曜日受付時間 / Google Calendar /
  // リードタイム / 既存予約を、確定直前にもう一度突合する。
  // 突合は店舗タイムゾーンの暦日で取り直した候補の instant と、要求の
  // instant の完全一致で行う（+09:00 固定の壁時刻照合ではない）。
  // R92: 予約直前の突合もお客さまの空き確認と同じ店舗ルールで判定する。
  const slotMatched = await reverifyLatestSlot(c.env.DB, c.env, {
    lineAccountId: accountId,
    menuId: body.menu_id,
    staffId: body.staff_id,
    startsAt,
    minLeadTimeMinutes: DEFAULT_ACCOUNT_SETTINGS.min_lead_time_minutes,
    applyStoreRules: true,
    excludeWaitlistId:body.waitlist_id,waitlistOffer:!!body.waitlist_id,additionalDurationMinutes:addonDuration,
  });
  if (!slotMatched) return liffBookingInputError(c, { error: 'slot_not_available' }, 422, ["menu_id","staff_id","waitlist_id"]);

  const bookingId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  // 予約のルール「お店が承認してから確定する」が automatic の店は、
  // 未承認を通さずその場で確定にする。設定が読めないときは承認ありに倒す。
  const adminSettings = await getBookingAdminSettings(c.env.DB, accountId);
  const paymentSelection = await bookingPaymentSelection(c.env.DB, accountId, body.menu_id, friendId);
  let paymentConfig = paymentSelection.config;
  if (body.entitlement_id) {
    try { await validateEntitlementSelection(c.env.DB,accountId,friendId,body.menu_id,body.entitlement_id,startsAt.toISOString()); }
    catch(error) { if(error instanceof EntitlementError)return liffBookingJson(c, {error:error.code},error.status); throw error; }
    if(body.payment_method) return liffBookingInputError(c,{error:'choose_entitlement_or_payment'},400,['entitlement_id','payment_method']);
    paymentConfig={mode:'none',provider:'none',holdMinutes:paymentConfig.holdMinutes};
  } else if(paymentConfig.mode==='customer_choice') {
    if (body.payment_method && !paymentSelection.allowedMethods.includes(body.payment_method))
      return liffBookingInputError(c,{error:'payment_method_not_allowed'},400,['payment_method']);
    paymentConfig=body.payment_method
      ? {...paymentConfig,mode:body.payment_method,provider:body.payment_method==='online'?'stripe':'onsite'}
      : paymentSelection.allowedMethods.length === 1
      ? {...paymentConfig,mode:'online',provider:'stripe'}
      : await defaultBookingPaymentSelection(c.env.DB, accountId);
  } else if(body.payment_method && body.payment_method!==paymentConfig.mode) {
    return liffBookingInputError(c,{error:'payment_method_not_allowed'},400,['payment_method']);
  }
  const deposit=await depositEstimate(c.env.DB,accountId,body.menu_id,menuRow.price,startsAt.toISOString(),1,await getAccountTimeZone(c.env.DB,accountId));
  if(deposit.amount>0&&!body.entitlement_id)return liffBookingJson(c, {error:'deposit_collection_not_available'},409);
  const requiresOnlinePayment = paymentConfig.mode === 'online' && menuRow.price > 0;
  const autoConfirm = adminSettings?.approvalMode === 'automatic' && !requiresOnlinePayment && !formRequiresApproval;
  const initialStatus = (autoConfirm ? 'confirmed' : 'requested') satisfies BookingStatus;
  const decidedAt = autoConfirm ? nowIso : null;
  const reserved = await reserveIdempotencyResponse(c.env.DB, {
    key: idemKey,
    lineAccountId: accountId,
    friendId,
    body: { error: 'request_in_progress', booking_id: bookingId },
    ttlMinutes: IDEMPOTENCY_TTL_MINUTES,
    now: new Date(),
  });
  if (!reserved) {
    const raced = await findIdempotencyResponse(c.env.DB, {
      key: idemKey, lineAccountId: accountId, friendId, now: new Date(),
    });
    if (raced && raced.status !== 202) {
      return liffBookingJson(c, raced.body as Record<string, unknown>, raced.status as 200 | 201 | 400 | 409 | 422);
    }
    return liffBookingJson(c, { error: raced ? 'request_in_progress' : 'idempotency_key_conflict' }, 409);
  }
  // 競合チェックと INSERT を 1 ステートメントで原子化する。
  // INSERT ... SELECT WHERE NOT EXISTS パターンで、同一スタッフの overlap 行がある場合は
  // 0 行 INSERT に落とす。changes=0 を 409 として扱う。
  // 予約した時点の内容（値段・時間）の写しを持つ（T）。
  const menuSnapshot = buildMenuSnapshot(menuRow);
  const bookingInsert = c.env.DB.prepare(
      `INSERT INTO bookings
        (id, line_account_id, friend_id, staff_id, menu_id,
         starts_at, ends_at, block_ends_at, status,
         customer_note, price_at_booking, requested_at, decided_at,
         menu_version_number, menu_snapshot_json,waitlist_entry_id,policy_snapshot_json,meeting_mode,nominated,nomination_fee_at_booking,routing_rule_index,routing_form_version_id)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        WHERE (SELECT COUNT(*) FROM menus m JOIN json_each(?) j ON m.id=json_extract(j.value,'$.id') AND m.version=json_extract(j.value,'$.version') WHERE m.is_active=1 AND m.deleted_at IS NULL AND m.line_account_id=?)=? AND COALESCE((SELECT version FROM booking_cancellation_policies WHERE line_account_id=?),0)=? AND NOT EXISTS (
          -- 別メニューの予約は、定員に関係なく1件でも塞ぐ。
          -- 1対1の施術とグループを同じ時間に入れることはできない。
          SELECT 1 FROM bookings
           WHERE staff_id = ?
             AND status IN ('requested','confirmed')
             AND starts_at < ?
             AND block_ends_at > ?
             AND menu_id != ?
        )
        AND (
          -- 同じメニューは同時受付数まで重ねられる。定員1なら従来と同じ判定になる。
          SELECT COUNT(*) FROM bookings
           WHERE staff_id = ?
             AND status IN ('requested','confirmed')
             AND starts_at < ?
             AND block_ends_at > ?
             AND menu_id = ?
        ) < ?
        ${STORE_CAPACITY_GUARD_SQL}
        ${STORE_SETTINGS_VERSION_GUARD_SQL}
        ${BOOKING_RESOURCE_CAPACITY_GUARD_SQL}
        ${BOOKING_PERSON_LIMIT_GUARD_SQL}`,
    )
    .bind(
      bookingId,
      accountId,
      friendId,
      body.staff_id,
      body.menu_id,
      startsAt.toISOString(),
      endsAt.toISOString(),
      blockEndsAt.toISOString(),
      initialStatus,
      body.customer_note ?? null,
      menuRow.price,
      nowIso,
      decidedAt,
      menuSnapshot.version,
      menuSnapshot.json,
      body.waitlist_id??null,
      JSON.stringify(body.entitlement_id?{...cancellation,enabled:false}:cancellation),
      bookingMeetingMode,
      nominated?1:0,nominationFee,routing?.matchedIndex??null,routing?.versionId??null,
      JSON.stringify(addons),accountId,addons.length,
      accountId,cancellation.version,
      // 別メニューの重なりを見る副問い合わせ
      body.staff_id,
      blockEndsAt.toISOString(),
      startsAt.toISOString(),
      body.menu_id,
      // 同じメニューの件数を数える副問い合わせ
      body.staff_id,
      blockEndsAt.toISOString(),
      startsAt.toISOString(),
      body.menu_id,
      Math.max(1, menuRow.concurrent_capacity ?? 1),
      JSON.stringify(storeCapacity.windows), accountId, accountId,
      accountId, storeCapacity.settingsVersion,
      ...bookingResourceGuardBindings({
        menuId: body.menu_id,
        lineAccountId: accountId,
        startsAt: startsAt.toISOString(),
        blockEndsAt: blockEndsAt.toISOString(),
      }),
      ...bookingPersonLimitBindings(accountId, friendId, null),
    );
  const paymentId = requiresOnlinePayment ? crypto.randomUUID() : null;
  const paymentHoldUntil = requiresOnlinePayment
    ? new Date(Date.now() + paymentConfig.holdMinutes * 60_000).toISOString() : null;
  const bookingPayment = paymentId && paymentHoldUntil
    ? { id: paymentId, status: 'unpaid', holdUntil: paymentHoldUntil } : null;
  let insertResult: { inserted: boolean; consumptionCount: number };
  try {
    insertResult = await insertBookingWithResourceSnapshot(c.env.DB, {
      bookingInsert, bookingId, lineAccountId: accountId, menuId: body.menu_id,
      additionalStatements: [
        c.env.DB.prepare("UPDATE bookings SET confirmation_revision = confirmation_revision + 1, booking_payment_method_id=(SELECT id FROM booking_payment_methods WHERE setup_id=? AND friend_id=? AND line_account_id=? AND status='ready' AND test_mode=1) WHERE id=?").bind(body.setupIntentId??null,friendId,accountId,bookingId),
        ...addons.map(addon=>c.env.DB.prepare('INSERT INTO booking_addons(booking_id,addon_menu_id,duration_min,price_at_booking) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM bookings WHERE id=?)').bind(bookingId,addon.id,addon.duration_minutes,addon.base_price,bookingId)),
        ...(body.entitlement_id ? [entitlementUseStatement(c.env.DB,bookingId,body.entitlement_id,startsAt.toISOString(),await getAccountTimeZone(c.env.DB,accountId))] : []),
        ...(!body.entitlement_id && paymentConfig.mode !== 'none' ? [c.env.DB.prepare(`INSERT INTO booking_payment_choices(booking_id,line_account_id,mode,provider,hold_minutes)
          SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM bookings WHERE id=?)`).bind(bookingId,accountId,paymentConfig.mode,paymentConfig.provider,paymentConfig.holdMinutes,bookingId)] : []),
        ...(bookingPayment ? [bookingPaymentInsertStatement(c.env.DB, {
          id: bookingPayment.id, bookingId, lineAccountId: accountId, amount: menuRow.price,
          provider: paymentConfig.provider, holdUntil: bookingPayment.holdUntil!, now: nowIso,
        })] : []),
        ...(autoConfirm ? [confirmationWorkflowStatement(c.env.DB, bookingId)] : []),
      ],
    });
  } catch (error) {
    // DB応答だけ消えた場合はcommit済みかもしれない。不在を確認できた
    // ときだけ自分の仮応答を消す。救出の読取も失敗したら確保を残す。
    try {
      const saved = await c.env.DB.prepare('SELECT id FROM bookings WHERE id = ? AND line_account_id = ? AND friend_id = ?')
        .bind(bookingId, accountId, friendId).first();
      if (!saved) await releaseReservedIdempotencyResponse(c.env.DB, {
        key: idemKey, lineAccountId: accountId, friendId, bookingId,
      });
    } catch { /* 不明な結果はキーを残して二重作成を止める。 */ }
    if(error instanceof Error && error.message.includes('entitlement_unavailable'))return liffBookingJson(c, {error:'entitlement_unavailable'},409);
    throw error;
  }
  if (!insertResult.inserted) {
    const limitError = await bookingPersonLimitError(c.env.DB, accountId, friendId, null);
    const err = limitError ?? { error: 'slot_conflict' };
    await completeIdempotencyResponse(c.env.DB, {
      key: idemKey,
      lineAccountId: accountId,
      friendId,
      status: limitError ? 422 : 409,
      body: err,
    });
    return liffBookingJson(c, err, limitError ? 422 : 409);
  }

  // お客様が自分で入れた予約も履歴の起点として残す。
  await recordBookingAudit(c.env.DB, {
    bookingId,
    lineAccountId: accountId,
    action: 'created',
    after: {
      status: initialStatus,
      staff_id: body.staff_id,
      menu_id: body.menu_id,
      starts_at: startsAt.toISOString(),
      source: 'liff',
    },
    actorType: 'customer',
    actorId: friendId,
    occurredAt: nowIso,
  });

  c.executionCtx.waitUntil(
    awardActivityMileage(c.env.DB, {
      eventType: 'booking_created',
      source: 'booking',
      sourceEventId: bookingId,
      friendId,
      metadata: { bookingType: 'salon', menuId: body.menu_id, staffId: body.staff_id },
      occurredAt: nowIso,
    }),
  );
  c.executionCtx.waitUntil(
    applyActionScoreEvent(c.env.DB, {
      lineAccountId: accountId,
      friendId,
      eventType: 'booking_created',
      source: 'booking',
      sourceEventId: bookingId,
      subjectKey: body.menu_id,
      occurredAt: nowIso,
    }).catch((error) => logger.error("booking.liff_booking_requests_create_failed")),
  );

  // 予約をきっかけにするリマインダへ登録する。通知やタグ付与と同じく
  // 予約成功は左右しない。リマインダが登録できなかったからといって
  // 予約そのものを失敗させるのは筋が違う。
  c.executionCtx.waitUntil(
    enrollByTrigger(c.env.DB, {
      triggerType: 'booking',
      friendId,
      startsAtIso: startsAt.toISOString(),
      sourceId: bookingId,
      sourceEventId: bookingId,
      lineAccountId: accountId,
    }).catch((err) => logger.error("booking.liff_booking_requests_create_failed")),
  );

  if (autoConfirm) {
    // 承認なし確定: 承認で確定したときと同じ始末をその場でそろえる。
    // 失敗しても予約は成立させる（承認の動きと同じ扱い）。
    try {
      await runConfirmedBookingSideEffects(c.env.DB, bookingId, { credentials: googleCredentials(c.env) });
    } catch (error) {
      logger.error("booking.liff_booking_requests_create_failed");
    }
  } else {
    // 通知失敗だけで予約を取り消さないよう、確定後の通知を分離する。
    c.executionCtx.waitUntil(
      notifyForBooking(c.env.DB, bookingId, 'requested').catch((err) =>
        logger.error("booking.liff_booking_requests_create_failed"),
      ),
    );
  }

  // 予約が入ったことを運用者へ知らせる。これも他の副作用と同じ扱いで、
  // 通知が落ちても予約は成立させる。発生元に予約IDを使うので、同じ予約から
  // 通知が二重に作られることはない。送り残しは回収口から拾う。
  c.executionCtx.waitUntil(
    dispatchOperatorEvent(c.env.DB, c.env, {
      lineAccountId: accountId,
      eventType: 'booking_created',
      sourceEventId: bookingId,
      message: '新しい予約が入りました',
      executionMode: 'automatic',
    }).catch((err) => logger.error("booking.liff_booking_requests_create_failed")),
  );

  // 「予約が入ったとき」を購読する送信Webhookへも届ける。
  // 通知が落ちても予約は成立させるため、他の副作用と同じく応答の後ろで捌く。
  c.executionCtx.waitUntil(
    fireOutgoingWebhooks(c.env.DB, 'booking_created', {
      friendId,
      sourceKind: 'booking',
      sourceEventId: bookingId,
      occurredAt: nowIso,
      eventData: {
        bookingId,
        bookingType: 'salon',
        menuId: body.menu_id,
        staffId: body.staff_id,
        startsAt: startsAt.toISOString(),
      },
    }, accountId).catch((err) => logger.error("booking.liff_booking_requests_create_failed")),
  );

  // notifyForBooking と同じく fire-and-forget。タグ付与失敗は予約成功扱い。
  // attachTagAndFireSideEffects は POST /api/friends/:id/tags と同じ side effects
  // (tag_added シナリオ enrollment + tag_change イベント) を発火する。
  // INSERT OR IGNORE で重複を吸収し、新規付与のときだけ side effects を打つ。
  //
  // 設定した時点で active でも、予約が入る時点では整理済み(archived)になっている
  // ことがある。メニューに残っている auto_tag_id をそのまま信じず、付与の直前に
  // アカウントと status='active' を引き直す。外れていれば付与も後続副作用も打たない
  // (整理済みのタグが友だちに付き、シナリオ・イベントまで動いてしまうのを止める)。
  if (menuRow.auto_tag_id) {
    const tagId = menuRow.auto_tag_id;
    c.executionCtx.waitUntil(
      (async () => {
        if (!(await isAssignableAutoTag(c.env.DB, tagId, accountId))) {
          logger.warn("booking_auto_tag_skipped");
          return;
        }
        await attachTagAndFireSideEffects(c.env.DB, friendId, tagId, {
          defaultAccessToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
          workerUrl: c.env.WORKER_URL,
        });
      })().catch((err) => logger.error("booking.liff_booking_requests_create_failed")),
    );
  }

  // 無断キャンセルの前払いのみ。前払いの人は案内を付ける（予約自体は仮押さえのまま）。
  let selfPrepayNotice: string | null = null;
  try {
    selfPrepayNotice = await prepayNoticeFor(
      c.env.DB, accountId, await decidePrepayOnly(c.env.DB, accountId, friendId),
    );
  } catch (error) {
    logger.error("booking.liff_booking_requests_create_failed");
  }

  const responseBody = {
    booking_id: bookingId,
    status: initialStatus,
    payment_required: requiresOnlinePayment,
    ...(bookingPayment ? { payment: bookingPayment } : {}),
    ...(selfPrepayNotice ? { prepayNotice: selfPrepayNotice } : {}),
  };
  await completeIdempotencyResponse(c.env.DB, {
    key: idemKey,
    lineAccountId: accountId,
    friendId,
    status: 201,
    body: responseBody,
  });
  return liffBookingJson(c, responseBody, 201);
});
}
