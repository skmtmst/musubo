import { meetingCreatorForBooking } from '../../features/booking/booking-meeting-runtime/index.js';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { confirmationWorkflowStatement, runConfirmedBookingSideEffects } from '../../features/booking/booking-confirmed-effects/index.js';
import { inputError, inputJsonBoundary } from '../../lib/input-errors.js';
import { BOOKING_PERSON_LIMIT_GUARD_SQL, bookingPersonLimitBindings, bookingPersonLimitError } from '../../features/booking/booking-person-limit/index.js';
import { bookingPaymentInsertStatement, decidePrepayOnly, prepayNoticeFor, resolveBookingPaymentConfig } from '@line-crm/db';
import { requireRole } from '../../middleware/role-guard.js';
import { enrollByTrigger } from '../../services/reminder-trigger.js';
import { explainBookingSlot, getStoreCapacitySnapshot } from '../../services/availability.js';
import { STORE_CAPACITY_GUARD_SQL, STORE_SETTINGS_VERSION_GUARD_SQL } from '../../features/booking/booking-store-capacity/index.js';
import { BOOKING_RESOURCE_CAPACITY_GUARD_SQL, bookingResourceGuardBindings, insertBookingWithResourceSnapshot } from '../../features/booking/booking-resource-capacity/index.js';
import { completeIdempotencyResponse, findIdempotencyResponse, releaseReservedIdempotencyResponse, reserveIdempotencyResponse } from '../../features/booking/booking-idempotency/index.js';
import { fireOutgoingWebhooks } from '../../services/event-bus.js';
import { DEFAULT_ACCOUNT_SETTINGS, IDEMPOTENCY_TTL_MINUTES, type BookingStatus } from '../../features/booking/booking-types/index.js';
import { recordBookingAudit } from '@line-crm/db';
import { listBookingOperations } from '../../features/booking/booking-operation-runs/index.js';
import { getBookingCustomerContext } from '../../features/booking/booking-admin-detail/index.js';
import { resolveAccountIdAdmin, assertStaffInAccount } from './identity.js';
import { isValidShiftDate, isClockTime, googleCredentials, reverifyLatestSlot, bookingConflictAlternatives } from './availability.js';
import { BookingNotificationPolicy, readNotificationPolicyPatch, staffAuditActor } from './notification-input.js';
import { ensureProxyBookingSideEffects } from './create-effects.js';
import { needsAutoAssignment, autoAssignBookingStaff } from './assignment.js';
import { buildMenuSnapshot } from './menu-snapshot.js';

export function registerCreate(booking: Hono<Env>): void {
//  予約設定: 指定した日時がなぜ予約できないかを説明する確認口。
// 読み取りだけで予約は作らない。判定はお客様の予約画面（LIFF）と同じ
// リードタイムを使い、結果は理由コードだけを返す（他担当の非公開予定の
// 件名・相手など詳細は含めない）。
booking.get('/api/booking/admin/availability-check', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const menuId = c.req.query('menu_id')?.trim();
  const staffId = c.req.query('staff_id')?.trim() || undefined;
  const date = c.req.query('date')?.trim();
  const time = c.req.query('time')?.trim();
  if (!menuId || !date || !time) {
    return c.json({ error: 'missing_params' }, 400);
  }
  if (!isValidShiftDate(date) || !isClockTime(time)) {
    return c.json({ error: 'invalid_params' }, 400);
  }
  // R92: 「なぜ取れないか」の説明もお客さまの判定と同じ店舗ルールで出す。
  const result = await explainBookingSlot(c.env.DB, {
    lineAccountId: accountId,
    menuId,
    staffId,
    date,
    time,
    now: new Date(),
    minLeadTimeMinutes: DEFAULT_ACCOUNT_SETTINGS.min_lead_time_minutes,
    applyStoreRules: true,
    googleCredentials: googleCredentials(c.env),
  });
  return c.json(result);
});

// 担当者の代理予約も LIFF と同じ勤務・枠・競合検査を通す。顧客対応中の直前予約を許すため最小リードタイムだけを適用せず、確定予約として作る。
booking.post('/api/booking/admin/bookings', requireRole('owner', 'admin', 'staff'), inputJsonBoundary({"friend_id":["string"],"booking_customer_id":["string"],"menu_id":["string"],"staff_id":["string"],"starts_at":["string"],"customer_note":["string"],"send_line_confirmation":["boolean"]}), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const idemKey = c.req.header('Idempotency-Key')?.trim();
  if (!idemKey) return inputError(c, { error: 'missing_idempotency_key' }, 400, []);
  const body = await c.req.json<{
    friend_id?: string;
    booking_customer_id?: string;
    menu_id: string;
    staff_id: string;
    starts_at: string; // UTC の ISO8601。
    customer_note?: string;
    send_line_confirmation?: boolean;
    /** 確認・前日・当日のお知らせを個別に切る。未指定は従来どおり全て送る。 */
    notification_policy?: unknown;
    party_size?: unknown;
  }>();
  if (body.party_size !== undefined && body.party_size !== 1) return inputError(c, { error: 'unsupported_party_size' }, 422, ["party_size"]);
  const friendInput = body.friend_id?.trim() || null;
  const customerInput = body.booking_customer_id?.trim() || null;
  if (
    (!friendInput && !customerInput)
    || (friendInput && customerInput)
    || !body.menu_id
    || !body.starts_at
  ) {
    return inputError(c, { error: 'missing_params' }, 400, ["friend_id","booking_customer_id","menu_id","starts_at"]);
  }

  let friendId: string | null = null;
  let bookingCustomerId: string | null = null;
  if (friendInput) {
    const friend = await c.env.DB
      .prepare(`SELECT id, is_following FROM friends WHERE id = ? AND line_account_id = ?`)
      .bind(friendInput, accountId)
      .first<{ id: string; is_following: number }>();
    if (!friend) return c.json({ error: 'friend_not_found' }, 404);
    if (friend.is_following === 0) return c.json({ error: 'cannot_book' }, 403);
    friendId = friend.id;
  } else {
    const customer = await c.env.DB
      .prepare(
        `SELECT id, friend_id FROM booking_customers
          WHERE id = ? AND line_account_id = ?`,
      )
      .bind(customerInput, accountId)
      .first<{ id: string; friend_id: string | null }>();
    if (!customer) return c.json({ error: 'booking_customer_not_found' }, 404);
    bookingCustomerId = customer.id;
    friendId = customer.friend_id;
    if (friendId) {
      const friend = await c.env.DB
        .prepare(`SELECT is_following FROM friends WHERE id = ? AND line_account_id = ?`)
        .bind(friendId, accountId)
        .first<{ is_following: number }>();
      if (!friend || friend.is_following === 0) return c.json({ error: 'cannot_book' }, 403);
    }
  }
  // 通知方針。send_line_confirmation は旧キー、notification_policy は新しい器。
  // 両方あるときは notification_policy が勝つ。未連携で明示オンは 422。
  let policyPatch: Partial<BookingNotificationPolicy> = {};
  if (body.notification_policy !== undefined) {
    const parsed = readNotificationPolicyPatch(body.notification_policy);
    if (!parsed.ok) return inputError(c, { error: 'invalid_notification_policy' }, 422, ["notification_policy"]);
    policyPatch = parsed.value;
  }
  if (!friendId) {
    const wantsNotification = body.send_line_confirmation === true
      || policyPatch.send_line_confirmation === true
      || policyPatch.day_before === true
      || policyPatch.hours_before === true;
    if (wantsNotification) {
      return inputError(c, { error: 'line_notification_unavailable' }, 422, ["send_line_confirmation"]);
    }
  }
  const sendLineConfirmation = Boolean(friendId)
    && (policyPatch.send_line_confirmation ?? body.send_line_confirmation ?? true);
  const sendDayBefore = Boolean(friendId) && (policyPatch.day_before ?? true);
  const sendHoursBefore = Boolean(friendId) && (policyPatch.hours_before ?? true);
  const idempotencySubject = friendId ?? `booking-customer:${bookingCustomerId}`;

  const cached = await findIdempotencyResponse(c.env.DB, {
    key: idemKey,
    lineAccountId: accountId,
    friendId: idempotencySubject,
    now: new Date(),
  });
  if (cached) {
    if (cached.status !== 202) {
      return c.json(
        cached.body as Record<string, unknown>,
        cached.status as 200 | 201 | 400 | 409 | 422,
      );
    }
    const pendingBookingId = (cached.body as { booking_id?: unknown }).booking_id;
    if (typeof pendingBookingId === 'string') {
      const created = await c.env.DB
        .prepare(
          `SELECT id, status, external_event_id, staff_id, menu_id, starts_at,
                  price_at_booking, source, notification_policy_snapshot FROM bookings
            WHERE id = ? AND line_account_id = ?
              AND ((? IS NOT NULL AND friend_id = ?)
                OR (? IS NOT NULL AND booking_customer_id = ?))`,
        )
        .bind(
          pendingBookingId,
          accountId,
          friendId,
          friendId,
          bookingCustomerId,
          bookingCustomerId,
        )
        .first<{
          id: string; status: string; external_event_id: string | null;
          staff_id: string; menu_id: string; starts_at: string;
          price_at_booking: number; source: string;
          notification_policy_snapshot: string | null;
        }>();
      if (created) {
        /*
         * 残差: 仮応答のまま取り消された予約へ同じキーで再送したとき、
         * 補完がカレンダー作成などの副作用を積み直していた。取り消し済みの
         * 予約に作り直しは要らないので、今の状態をそのまま返し、
         * 副作用は確定中の予約にだけ足す。
         */
        if (created.status === 'confirmed') {
          // 予約は残っているのに履歴・予定処理が欠けているときは、
          // 成功を返す前に不足を埋める。あるものは作り直さない。
          await ensureProxyBookingSideEffects(
            c.env.DB,
            created,
            { lineAccountId: accountId, friendId },
            staffAuditActor(c),
          );
        }
        return c.json({
          booking_id: created.id,
          booking_customer_id: bookingCustomerId,
          status: created.status,
          calendar_sync: created.external_event_id ? 'synced' : 'pending',
          line_notification: sendLineConfirmation ? 'scheduled' : 'not_applicable',
          replayed: true,
        }, 201);
      }
    }
    return c.json({ error: 'request_in_progress' }, 409);
  }

  // staff が同じ account に属することを保証（別 tenant の staff への予約を防ぐ）。
  if (await needsAutoAssignment(c,accountId,body.staff_id)) {
    const assigned = await autoAssignBookingStaff(c,accountId,body.menu_id,body.starts_at,false);
    if (!assigned) return c.json({ error: 'auto_assignment_unavailable' }, 409);
    body.staff_id = assigned;
  }

  if (!(await assertStaffInAccount(c.env.DB, body.staff_id, accountId))) {
    return c.json({ error: 'staff_not_found' }, 404);
  }

  const menuRow = await c.env.DB
    .prepare(
      `SELECT m.id, m.name, m.duration_minutes, m.buffer_after_minutes, m.base_price,
              m.price_mode, m.version,
              m.concurrent_capacity,
              COALESCE(sm.override_duration_minutes, m.duration_minutes) AS dur,
              COALESCE(sm.override_price, m.base_price) AS price,
              sm.is_offered
         FROM menus m
         LEFT JOIN staff_menus sm ON sm.menu_id = m.id AND sm.staff_id = ?2
        WHERE m.id = ?1 AND m.line_account_id = ?3
          AND m.deleted_at IS NULL AND m.is_active = 1`,
    )
    .bind(body.menu_id, body.staff_id, accountId)
    .first<{ name: string; duration_minutes: number; buffer_after_minutes: number; concurrent_capacity: number; dur: number; price: number; price_mode: string; version: number; is_offered: number | null }>();
  if (!menuRow || menuRow.is_offered !== 1) {
    return inputError(c, { error: 'menu_not_offered' }, 422, ["menu_id","staff_id"]);
  }

  const startsAt = new Date(body.starts_at);
  if (Number.isNaN(startsAt.getTime())) {
    return inputError(c, { error: 'invalid_starts_at' }, 422, ["starts_at"]);
  }
  if (startsAt < new Date()) {
    return inputError(c, { error: 'past_datetime' }, 422, ["starts_at"]);
  }
  const endsAt = new Date(startsAt.getTime() + menuRow.dur * 60_000);
  const blockEndsAt = new Date(endsAt.getTime() + menuRow.buffer_after_minutes * 60_000);
  // LIFFと同じ順序で営業時間snapshotを先に固定し、その後の変更を
  // availability再計算または原子的なversion guardのどちらかで止める。
  const storeCapacity = await getStoreCapacitySnapshot(c.env.DB, accountId, startsAt, blockEndsAt);

  // 営業・Google Calendar・既存予約を検査し、店舗の暦日で再取得した候補の瞬間と要求の瞬間が完全一致するときだけ許可する。
  if (!(await reverifyLatestSlot(c.env.DB, c.env, {
    lineAccountId: accountId,
    menuId: body.menu_id,
    staffId: body.staff_id,
    startsAt,
    minLeadTimeMinutes: 0,
  }))) {
    const alternatives = await bookingConflictAlternatives(c.env.DB, c.env, {
      lineAccountId: accountId,
      menuId: body.menu_id,
      staffId: body.staff_id,
      startsAt,
      durationMinutes: menuRow.dur,
    });
    return c.json({ error: 'slot_not_available', data: alternatives }, 409);
  }

  const bookingId = crypto.randomUUID();
  const reserved = await reserveIdempotencyResponse(c.env.DB, {
    key: idemKey,
    lineAccountId: accountId,
    friendId: idempotencySubject,
    body: { error: 'request_in_progress', booking_id: bookingId },
    ttlMinutes: IDEMPOTENCY_TTL_MINUTES,
    now: new Date(),
  });
  if (!reserved) {
    const raced = await findIdempotencyResponse(c.env.DB, {
      key: idemKey,
      lineAccountId: accountId,
      friendId: idempotencySubject,
      now: new Date(),
    });
    if (raced && raced.status !== 202) {
      return c.json(
        raced.body as Record<string, unknown>,
        raced.status as 200 | 201 | 400 | 409 | 422,
      );
    }
    return c.json({ error: raced ? 'request_in_progress' : 'idempotency_key_conflict' }, 409);
  }
  const nowIso = new Date().toISOString();
  // 選んだ方針を予約へ固定する。後から設定を変えても
  // この予約へ送るものは変わらない。
  const notificationPolicy = JSON.stringify({
    send_line_confirmation: sendLineConfirmation,
    day_before: sendDayBefore,
    hours_before: sendHoursBefore,
  });
  // 無断キャンセルの前払いのみ。前払いの人（友だち登録があるときだけ判定）は
  // ここでは確定させず、支払い済みの知らせで確定させる。
  let adminPrepayOnly = false;
  let adminPrepayNotice: string | null = null;
  if (friendId) {
    try {
      const decision = await decidePrepayOnly(c.env.DB, accountId, friendId);
      adminPrepayOnly = decision.prepayOnly;
      adminPrepayNotice = await prepayNoticeFor(c.env.DB, accountId, decision);
    } catch (error) {
      logger.error("booking.admin_bookings_create_failed");
    }
  }
  const initialStatus = (adminPrepayOnly ? 'requested' : 'confirmed') satisfies BookingStatus;
  const adminPaymentConfig = adminPrepayOnly ? await resolveBookingPaymentConfig(c.env.DB, accountId, body.menu_id) : null;
  const adminPrepayPayment = adminPaymentConfig?.mode === 'online' && menuRow.price > 0
    ? { id: crypto.randomUUID(), status: 'unpaid', holdUntil: new Date(Date.now()+adminPaymentConfig.holdMinutes*60000).toISOString() } : null;
  // 予約した時点の内容（値段・時間）の写しを持つ（T）。
  const menuSnapshot = buildMenuSnapshot(menuRow);
  const bookingInsert = c.env.DB.prepare(
      `INSERT INTO bookings
        (id, line_account_id, friend_id, booking_customer_id, staff_id, menu_id,
         starts_at, ends_at, block_ends_at, status,
         customer_note, price_at_booking, requested_at, decided_at,
         source, created_by_staff_id, notification_policy_snapshot,
         menu_version_number, menu_snapshot_json)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        WHERE NOT EXISTS (
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
      bookingCustomerId,
      body.staff_id,
      body.menu_id,
      startsAt.toISOString(),
      endsAt.toISOString(),
      blockEndsAt.toISOString(),
      initialStatus,
      body.customer_note ?? null,
      menuRow.price,
      nowIso,
      nowIso,
      bookingCustomerId ? 'phone' : 'operator',
      c.get('staff').id,
      notificationPolicy,
      menuSnapshot.version,
      menuSnapshot.json,
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
      ...bookingPersonLimitBindings(accountId, friendId, bookingCustomerId),
    );
  let insertResult: { inserted: boolean; consumptionCount: number };
  try {
    insertResult = await insertBookingWithResourceSnapshot(c.env.DB, {
      bookingInsert,
      bookingId,
      lineAccountId: accountId,
      menuId: body.menu_id,
      additionalStatements: [
        ...(adminPrepayPayment ? [bookingPaymentInsertStatement(c.env.DB, {
          id: adminPrepayPayment.id, bookingId, lineAccountId: accountId, amount: menuRow.price,
          provider: adminPaymentConfig!.provider, holdUntil: adminPrepayPayment.holdUntil, now: nowIso,
        })] : []),
        ...(initialStatus === 'confirmed' ? [confirmationWorkflowStatement(c.env.DB, bookingId)] : []),
      ],
    });
  } catch (error) {
    await releaseReservedIdempotencyResponse(c.env.DB, {
      key: idemKey,
      lineAccountId: accountId,
      friendId: idempotencySubject,
      bookingId,
    });
    throw error;
  }
  if (!insertResult.inserted) {
    const limitError = await bookingPersonLimitError(c.env.DB, accountId, friendId, bookingCustomerId);
    if (limitError) {
      await completeIdempotencyResponse(c.env.DB, { key: idemKey, lineAccountId: accountId,
        friendId: idempotencySubject, status: 422, body: limitError });
      return c.json(limitError, 422);
    }
    const alternatives = await bookingConflictAlternatives(c.env.DB, c.env, {
      lineAccountId: accountId,
      menuId: body.menu_id,
      staffId: body.staff_id,
      startsAt,
      durationMinutes: menuRow.dur,
    });
    const response = { error: 'slot_conflict', data: alternatives };
    await completeIdempotencyResponse(c.env.DB, {
      key: idemKey,
      lineAccountId: accountId,
      friendId: idempotencySubject,
      status: 409,
      body: response,
    });
    return c.json(response, 409);
  }

  // 作成も履歴の起点として残す。操作者 (代理登録したスタッフ) を記録する。
  await recordBookingAudit(c.env.DB, {
    bookingId,
    lineAccountId: accountId,
    action: 'created',
    after: {
      status: initialStatus,
      staff_id: body.staff_id,
      menu_id: body.menu_id,
      starts_at: startsAt.toISOString(),
      price: Number(menuRow.price),
      source: bookingCustomerId ? 'phone' : 'operator',
    },
    ...staffAuditActor(c),
    occurredAt: nowIso,
  });

  let calendarSync: 'not_configured' | 'synced' | 'failed' = 'not_configured';
  if (initialStatus === 'confirmed') {
    await runConfirmedBookingSideEffects(c.env.DB, bookingId, { credentials: googleCredentials(c.env), meetingCreatorForBooking: id => meetingCreatorForBooking(c.env,id) });
    const calendarOp = await c.env.DB.prepare(`SELECT status, result_json FROM booking_operation_runs
      WHERE booking_id = ? AND kind = 'google_calendar' AND idempotency_key = ?`)
      .bind(bookingId, `${bookingId}:google-calendar:create`).first<{ status: string; result_json: string }>();
    if (calendarOp?.status === 'succeeded') calendarSync = 'synced';
    else if (calendarOp && ['retry_wait','permanent_failed'].includes(calendarOp.status)) calendarSync = 'failed';
    if (friendId && (sendDayBefore || sendHoursBefore)) {
      c.executionCtx.waitUntil(enrollByTrigger(c.env.DB, {
        triggerType: 'booking', friendId, startsAtIso: startsAt.toISOString(), sourceId: bookingId,
        sourceEventId: bookingId, lineAccountId: accountId,
      }).catch(() => logger.error("booking.enroll_proxy_reminder_failed")));
    }
  }
  if (friendId) {
    // 「予約が入ったとき」の送信Webhook購読者へも届ける。
    c.executionCtx.waitUntil(
      fireOutgoingWebhooks(c.env.DB, 'booking_created', {
        friendId,
        sourceKind: 'booking',
        sourceEventId: bookingId,
        occurredAt: new Date().toISOString(),
        eventData: {
          bookingId,
          bookingType: 'salon',
          menuId: body.menu_id,
          staffId: body.staff_id,
          startsAt: startsAt.toISOString(),
        },
      }, accountId).catch((err) => logger.error("booking.admin_bookings_create_failed")),
    );
  }
  const [reminderRows, operationRows, customerContext] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, kind, scheduled_at, sent_at, status
         FROM booking_reminders WHERE booking_id = ? ORDER BY scheduled_at ASC`,
    ).bind(bookingId).all<{
      id: string; kind: string; scheduled_at: string; sent_at: string | null; status: string;
    }>(),
    listBookingOperations(c.env.DB, { bookingId, lineAccountId: accountId }),
    getBookingCustomerContext(c.env.DB, {
      lineAccountId: accountId,
      friendId,
      bookingCustomerId,
    }),
  ]);
  const response = {
    booking_id: bookingId,
    booking_customer_id: bookingCustomerId,
    status: initialStatus,
    ...(adminPrepayOnly
      ? {
          prepayNotice: adminPrepayNotice,
          payment: adminPrepayPayment,
        }
      : {}),
    calendar_sync: calendarSync,
    line_notification: sendLineConfirmation ? 'queued' : 'not_applicable',
    reminders: (reminderRows.results ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      scheduled_at: row.scheduled_at,
      sent_at: row.sent_at,
      status: row.status,
    })),
    operations: operationRows,
    customer_context: customerContext,
  };
  await completeIdempotencyResponse(c.env.DB, {
    key: idemKey,
    lineAccountId: accountId,
    friendId: idempotencySubject,
    status: 201,
    body: response,
  });
  return c.json(response, 201);
});
}
