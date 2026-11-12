import { logger } from '@line-crm/shared/server';
import type { SelfBookingChange } from '../booking-self-meet-sync.js';
import { notifyForBooking } from '../../features/booking/booking-notification/index.js';
import { inputError } from '../../lib/input-errors.js';
import { type Context } from 'hono';
import type { Env } from '../../worker-env.js';
import { cancelByTrigger, reconcileV6ToStartsAt, rescheduleByTrigger } from '../../services/reminder-trigger.js';
import { getStoreCapacitySnapshot } from '../../services/availability.js';
import { STORE_CAPACITY_GUARD_EXCLUDE_SQL, STORE_SETTINGS_VERSION_GUARD_SQL } from '../../features/booking/booking-store-capacity/index.js';
import { BOOKING_RESOURCE_CAPACITY_GUARD_EXCLUDE_SQL, bookingResourceGuardExcludeBindings } from '../../features/booking/booking-resource-capacity/index.js';
import { runBookingGoogleSync } from '../../features/booking/booking-calendar-sync/index.js';
import { buildConfirmationReminderSchedule, getReminderTiming, type BookingReminderScheduleItem } from '../../features/booking/booking-confirm/index.js';
import { type BookingStatus } from '../../features/booking/booking-types/index.js';
import { bookingAuditInsert, recordBookingAudit } from '@line-crm/db';
import { listBookingOperations, queueBookingOperation } from '../../features/booking/booking-operation-runs/index.js';
import { bookingAutomaticNotificationAllowed } from '../../features/booking/booking-channels/index.js';
import { resolveAccountIdAdmin, readSelfBookingRules, assertStaffInAccount, selfAuditActor } from './identity.js';
import { googleCredentials, reverifyLatestSlot, bookingConflictAlternatives } from './availability.js';
import { readNotificationPolicySnapshot, BookingNotificationPolicy, readNotificationPolicyPatch } from './notification-input.js';

/**
 * 予約内容の変更。日時・担当・メニュー・料金・メモ・通知方針を変える。
 *
 * - `lock_version` 必須。版が古い・状態が変わっていれば 409。
 * - 新しい枠の確保と旧枠の解放は同じ UPDATE のガードで一体化する。
 *   変更対象そのものは重なり判定・席数・資源の各ガードから外す
 *   （自予約と衝突して全部の変更が通らなくなるため）。
 * - 外部反映（Google・変更通知・リマインダ再作成）の失敗で予約は
 *   巻き戻さない。台帳に retry_wait/failed を残し、再試行口から回収する。
 */
export type AdminBookingPatch = {
  lock_version?: unknown;
  menu_id?: string;
  staff_id?: string;
  starts_at?: string;
  price?: unknown;
  customer_note?: unknown;
  internal_note?: unknown;
  notification_policy?: unknown;
  send_change_notification?: unknown;
  reason?: unknown;
};

export async function updateAdminBooking(c: Context<Env>, override?: AdminBookingPatch, self?: SelfBookingChange) {
  const accountId = self?.accountId ?? await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const bookingId = c.req.param('id')!;
  const body = override ?? await c.req.json<AdminBookingPatch>().catch(() => null);
  if (!body) return inputError(c, { error: 'invalid_json' }, 400, []);
  if (!Number.isInteger(body.lock_version) || Number(body.lock_version) < 0) {
    return inputError(c, { error: 'missing_lock_version' }, 400, ["lock_version"]);
  }
  const expectedVersion = Number(body.lock_version);
  const row = await c.env.DB
    .prepare(
      `SELECT id, status, friend_id, booking_customer_id, staff_id, menu_id,
              starts_at, ends_at, block_ends_at,
              price_at_booking, customer_note, internal_note,
              lock_version, notification_policy_snapshot
         FROM bookings WHERE id = ? AND line_account_id = ?`,
    )
    .bind(bookingId, accountId)
    .first<{
      id: string;
      status: BookingStatus;
      friend_id: string | null;
      booking_customer_id: string | null;
      staff_id: string;
      menu_id: string;
      starts_at: string;
      ends_at: string;
      block_ends_at: string;
      price_at_booking: number;
      customer_note: string | null;
      internal_note: string | null;
      lock_version: number;
      notification_policy_snapshot: string | null;
    }>();
  if (!row) return c.json({ error: 'booking_not_found' }, 404);
  if (row.status !== 'requested' && row.status !== 'confirmed') {
    return c.json({ error: 'not_editable' }, 409);
  }
  if (Number(row.lock_version) !== expectedVersion) {
    return c.json({ error: 'version_conflict' }, 409);
  }
  if (self) {
    // 本人変更の境界: 所有・期限・項目制限。管理者キーは見ない。
    if (row.friend_id !== self.friendId) return c.json({ error: 'booking_not_found' }, 404);
    const selfForbidden = ['menu_id', 'staff_id', 'price', 'customer_note', 'internal_note', 'notification_policy', 'send_change_notification'];
    if (selfForbidden.some((key) => Object.hasOwn(body, key))) {
      return inputError(c, { error: 'invalid_params' }, 400, selfForbidden.filter((key) => Object.hasOwn(body, key)));
    }
    if (body.starts_at === undefined) return inputError(c, { error: 'missing_starts_at' }, 400, ["starts_at"]);
    const rules = await readSelfBookingRules(c.env.DB, accountId, row.menu_id);
    if (Date.now() > new Date(row.starts_at).getTime() - rules.cancelDeadlineMinutesBefore * 60_000) {
      return c.json({ error: 'self_deadline_passed' }, 403);
    }
  }
  const editable = ['menu_id', 'staff_id', 'starts_at', 'price', 'customer_note', 'internal_note', 'notification_policy'];
  if (!editable.some((key) => Object.hasOwn(body, key))) {
    return inputError(c, { error: 'nothing_to_update' }, 400, []);
  }

  const newStaffId = typeof body.staff_id === 'string' && body.staff_id.trim()
    ? body.staff_id.trim()
    : row.staff_id;
  const newMenuId = typeof body.menu_id === 'string' && body.menu_id.trim()
    ? body.menu_id.trim()
    : row.menu_id;
  if (!(await assertStaffInAccount(c.env.DB, newStaffId, accountId))) {
    return c.json({ error: 'staff_not_found' }, 404);
  }
  const menuRow = await c.env.DB
    .prepare(
      `SELECT m.id, m.duration_minutes, m.buffer_after_minutes, m.base_price,
              m.concurrent_capacity,
              COALESCE(sm.override_duration_minutes, m.duration_minutes) AS dur,
              COALESCE(sm.override_price, m.base_price) AS price,
              sm.is_offered
         FROM menus m
         LEFT JOIN staff_menus sm ON sm.menu_id = m.id AND sm.staff_id = ?2
        WHERE m.id = ?1 AND m.line_account_id = ?3
          AND m.deleted_at IS NULL AND m.is_active = 1`,
    )
    .bind(newMenuId, newStaffId, accountId)
    .first<{
      duration_minutes: number;
      buffer_after_minutes: number;
      concurrent_capacity: number;
      dur: number;
      price: number;
      is_offered: number | null;
    }>();
  if (!menuRow || menuRow.is_offered !== 1) {
    return inputError(c, { error: 'menu_not_offered' }, 422, ["menu_id","staff_id"]);
  }

  const newStartsAt = body.starts_at !== undefined ? new Date(String(body.starts_at)) : new Date(row.starts_at);
  if (Number.isNaN(newStartsAt.getTime())) {
    return inputError(c, { error: 'invalid_starts_at' }, 422, ["starts_at"]);
  }
  if (self) {
    // 受付締切 (menu→store)。過ぎた新日時は受け付けない。
    const rules = await readSelfBookingRules(c.env.DB, accountId, row.menu_id);
    if (newStartsAt.getTime() - Date.now() < rules.cutoffMinutesBefore * 60_000) {
      return inputError(c, { error: 'past_cutoff' }, 422, ["starts_at"]);
    }
    // 同じ日時の再送は成功のまま返す (二重更新しない)。
    // 未完の副作用は同じ版・同じ冪等キーで回復する (二重予定・通知を作らない)。
    if (newStartsAt.toISOString() === row.starts_at) {
      const replaySync = await runBookingGoogleSync(c.env.DB, {
        bookingId,
        lineAccountId: accountId,
        credentials: googleCredentials(c.env),
      });
      return c.json({
        booking_id: bookingId,
        lock_version: Number(row.lock_version),
        status: row.status,
        changed: false,
        calendar_sync: replaySync === 'succeeded' ? 'synced'
          : replaySync === 'retry_wait' ? 'failed'
          : replaySync === 'skipped' ? 'not_configured' : 'not_applicable',
        change_notification: 'not_applicable',
        v6_sync: 'not_applicable',
        reminders_created: 0,
        meet_sync: 'unchanged',
      });
    }
  }
  // 過去チェックは「日時を実際に動かす指定」があるときだけ適用する。
  // 開始時刻の過ぎた予約でも料金・メモ・担当修正は必要になるため、
  // 開始時刻が未指定または同じ値の変更は、日程変更として拒まない。
  const startsAtMoved = body.starts_at !== undefined
    && newStartsAt.toISOString() !== row.starts_at;
  if (startsAtMoved && newStartsAt.getTime() < Date.now()) {
    return inputError(c, { error: 'past_datetime' }, 422, ["starts_at"]);
  }
  const timingChanged = newStartsAt.toISOString() !== row.starts_at
    || newStaffId !== row.staff_id
    || newMenuId !== row.menu_id;
  // 日時・担当・メニューを変えない保存では、保存ずみの終了時刻と
  // 占有時間をそのまま使う。メニュー改訂後の再計算で、頼んでいない
  // 時間変更が既存予約へ波及しないようにする。変えたときだけ新しい
  // 所要時間で枠を確保し、変更履歴にも残る (下の diff が拾う)。
  const storedEndsAt = new Date(row.ends_at);
  const storedBlockEndsAt = new Date(row.block_ends_at);
  const newEndsAt = timingChanged || Number.isNaN(storedEndsAt.getTime())
    ? new Date(newStartsAt.getTime() + menuRow.dur * 60_000)
    : storedEndsAt;
  const newBlockEndsAt = timingChanged || Number.isNaN(storedBlockEndsAt.getTime())
    ? new Date(newEndsAt.getTime() + menuRow.buffer_after_minutes * 60_000)
    : storedBlockEndsAt;

  let newPrice = Number(row.price_at_booking);
  if (body.price !== undefined) {
    if (!Number.isInteger(body.price) || Number(body.price) < 0 || Number(body.price) > 100_000_000) {
      return inputError(c, { error: 'invalid_price' }, 422, ["price"]);
    }
    newPrice = Number(body.price);
  } else if (newMenuId !== row.menu_id) {
    // メニューを変えて料金の指定が無いときは、その担当の提示価格へ付け替える。
    // 旧メニューの価格を残すと請求とメニューが食い違う。
    newPrice = Number(menuRow.price);
  }

  const newCustomerNote = body.customer_note === undefined
    ? row.customer_note
    : body.customer_note === null ? null : String(body.customer_note).slice(0, 2_000);
  const newInternalNote = body.internal_note === undefined
    ? row.internal_note
    : body.internal_note === null ? null : String(body.internal_note).slice(0, 2_000);

  const prevPolicy = readNotificationPolicySnapshot(row.notification_policy_snapshot);
  let policyPatch: Partial<BookingNotificationPolicy> = {};
  if (body.notification_policy !== undefined) {
    const parsed = readNotificationPolicyPatch(body.notification_policy);
    if (!parsed.ok) return inputError(c, { error: 'invalid_notification_policy' }, 422, ["notification_policy"]);
    policyPatch = parsed.value;
  }
  const newPolicy: BookingNotificationPolicy = {
    send_line_confirmation: policyPatch.send_line_confirmation ?? prevPolicy.send_line_confirmation,
    day_before: policyPatch.day_before ?? prevPolicy.day_before,
    hours_before: policyPatch.hours_before ?? prevPolicy.hours_before,
  };
  // LINE未連携の予約へ送信を明示的にオンにはできない (作成時と同じ422)。
  // 指定が無いまま残った旧値も、この時点で実態に合わせて畳む。
  if (!row.friend_id) {
    if (policyPatch.send_line_confirmation === true
      || policyPatch.day_before === true
      || policyPatch.hours_before === true) {
      return inputError(c, { error: 'line_notification_unavailable' }, 422, ["notification_policy"]);
    }
    newPolicy.send_line_confirmation = false;
    newPolicy.day_before = false;
    newPolicy.hours_before = false;
  }
  const newPolicyJson = JSON.stringify(newPolicy);

  const policyChanged = newPolicyJson !== (row.notification_policy_snapshot ?? '{}')
    && JSON.stringify(prevPolicy) !== newPolicyJson;

  // 枠・担当・メニューが変わるときだけ空きを再照合する。
  // 変更対象の予約自身は照合から外す（同じ枠のままの変更も通せる）。
  // 開始時刻の過ぎた予約は、過去の空き照合が意味を持たないため
  // 再照合を飛ばす（実施済み予約の担当修正などを塞がない）。
  if (timingChanged && newStartsAt.getTime() >= Date.now() && !(await reverifyLatestSlot(c.env.DB, c.env, {
    lineAccountId: accountId,
    menuId: newMenuId,
    staffId: newStaffId,
    startsAt: newStartsAt,
    minLeadTimeMinutes: 0,
    excludeBookingId: bookingId,
  }))) {
    const alternatives = await bookingConflictAlternatives(c.env.DB, c.env, {
      lineAccountId: accountId,
      menuId: newMenuId,
      staffId: newStaffId,
      startsAt: newStartsAt,
      durationMinutes: menuRow.dur,
    });
    return c.json({ error: 'slot_not_available', data: alternatives }, 409);
  }
  const storeCapacity = await getStoreCapacitySnapshot(c.env.DB, accountId, newStartsAt, newBlockEndsAt);

  const nowIso = new Date().toISOString();
  const newVersion = expectedVersion + 1;
  // 新しい枠の確保と旧枠の解放を1文で行う。lock_version + 状態 + 重なり +
  // 席数 + 営業時間版 + 資源を同時に確かめ、どれか外れれば 0 行更新になる。
  const update = c.env.DB.prepare(
    `UPDATE bookings SET
        confirmation_revision = confirmation_revision + 1, staff_id = ?, menu_id = ?, starts_at = ?, ends_at = ?, block_ends_at = ?,
        price_at_booking = ?, customer_note = ?, internal_note = ?,
        notification_policy_snapshot = ?, updated_by_staff_id = ?,
        lock_version = lock_version + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
      WHERE id = ? AND line_account_id = ?
        AND lock_version = ? AND status IN ('requested','confirmed')
        AND NOT EXISTS (
          -- 別メニューの予約は、定員に関係なく1件でも塞ぐ。
          SELECT 1 FROM bookings
           WHERE staff_id = ?
             AND status IN ('requested','confirmed')
             AND starts_at < ?
             AND block_ends_at > ?
             AND menu_id != ?
             AND id != ?
        )
        AND (
          -- 同じメニューは同時受付数まで重ねられる（自予約は数えない）。
          SELECT COUNT(*) FROM bookings
           WHERE staff_id = ?
             AND status IN ('requested','confirmed')
             AND starts_at < ?
             AND block_ends_at > ?
             AND menu_id = ?
             AND id != ?
        ) < ?
        ${STORE_CAPACITY_GUARD_EXCLUDE_SQL}
        ${STORE_SETTINGS_VERSION_GUARD_SQL}
        ${BOOKING_RESOURCE_CAPACITY_GUARD_EXCLUDE_SQL}`,
  ).bind(
    newStaffId,
    newMenuId,
    newStartsAt.toISOString(),
    newEndsAt.toISOString(),
    newBlockEndsAt.toISOString(),
    newPrice,
    newCustomerNote,
    newInternalNote,
    newPolicyJson,
    self ? null : c.get('staff').id,
    bookingId,
    accountId,
    expectedVersion,
    // 別メニューの重なりを見る副問い合わせ
    newStaffId,
    newBlockEndsAt.toISOString(),
    newStartsAt.toISOString(),
    newMenuId,
    bookingId,
    // 同じメニューの件数を数える副問い合わせ
    newStaffId,
    newBlockEndsAt.toISOString(),
    newStartsAt.toISOString(),
    newMenuId,
    bookingId,
    Math.max(1, menuRow.concurrent_capacity ?? 1),
    // 席数ガード（自予約除外版）
    JSON.stringify(storeCapacity.windows), accountId, bookingId, accountId, bookingId,
    // 営業時間版ガード
    accountId, storeCapacity.settingsVersion,
    ...bookingResourceGuardExcludeBindings({
      menuId: newMenuId,
      lineAccountId: accountId,
      excludeBookingId: bookingId,
      startsAt: newStartsAt.toISOString(),
      blockEndsAt: newBlockEndsAt.toISOString(),
    }),
  );
  const statements: D1PreparedStatement[] = [update];
  if (newMenuId !== row.menu_id) {
    // メニューが変わったときだけ資源消費のsnapshotを取り直す。
    // UPDATE が 0 行 (競合・版ずれ) のときは EXISTS が不成立になり、
    // 古い snapshot を消さない。
    statements.push(
      c.env.DB.prepare(
        `DELETE FROM booking_resource_consumptions
          WHERE booking_id = ?
            AND EXISTS (
              SELECT 1 FROM bookings b
               WHERE b.id = ? AND b.menu_id = ? AND b.lock_version = ?
            )`,
      ).bind(bookingId, bookingId, newMenuId, newVersion),
      c.env.DB.prepare(
        `INSERT INTO booking_resource_consumptions (
            booking_id, line_account_id, resource_id, quantity, snapshot_source)
         SELECT ?, ?, mr.resource_id, mr.quantity, 'booking'
           FROM booking_menu_resources mr
           INNER JOIN booking_resources r ON r.id = mr.resource_id
          WHERE mr.menu_id = ?
            AND r.line_account_id = ?
            AND r.is_active = 1
            AND EXISTS (
              SELECT 1 FROM bookings b
               WHERE b.id = ? AND b.menu_id = ? AND b.lock_version = ?
            )`,
      ).bind(bookingId, accountId, newMenuId, accountId, bookingId, newMenuId, newVersion),
    );
  }
  // ---- 監査履歴 : 変わった項目だけ before/after で残す ----
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const diff = (key: string, oldValue: unknown, newValue: unknown) => {
    if (oldValue !== newValue) {
      before[key] = oldValue;
      after[key] = newValue;
    }
  };
  diff('starts_at', row.starts_at, newStartsAt.toISOString());
  diff('staff_id', row.staff_id, newStaffId);
  diff('menu_id', row.menu_id, newMenuId);
  diff('price', Number(row.price_at_booking), newPrice);
  diff('customer_note', row.customer_note, newCustomerNote);
  diff('internal_note', row.internal_note, newInternalNote);
  if (JSON.stringify(prevPolicy) !== newPolicyJson) {
    before.notification_policy = prevPolicy;
    after.notification_policy = newPolicy;
  }

  // 予約更新・資源snapshot・監査・通知予定の作り直しは1つの batch で
  // 原子的に行う。予定の INSERT だけ失敗して「予約は新日時・予定は無し」
  // の半端な状態を残さない。失敗時は全て巻き戻り、同じ版での再送で直る。
  const friendId = row.friend_id;
  let reminderSchedule: BookingReminderScheduleItem[] = [];
  if ((timingChanged || policyChanged) && friendId
    && (newPolicy.day_before || newPolicy.hours_before)) {
    // LINE未連携の予約では行を作らない
    // (送信クエリが friends INNER JOIN のため、未連携行は宙に浮く)。
    const timing = await getReminderTiming(c.env.DB, accountId);
    reminderSchedule = buildConfirmationReminderSchedule({
      startsAt: newStartsAt,
      now: new Date(),
      reminderHoursBefore: timing.reminderHoursBefore,
      dayBeforeTime: timing.dayBeforeTime,
      timeZone: timing.timeZone,
      kinds: { dayBefore: newPolicy.day_before, hoursBefore: newPolicy.hours_before },
    });
  }
  statements.push(
    bookingAuditInsert(c.env.DB, {
      bookingId,
      lineAccountId: accountId,
      action: 'updated',
      before,
      after,
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null,
      ...selfAuditActor(self, c),
      occurredAt: nowIso,
    }),
  );
  if (timingChanged || policyChanged) {
    // 未送信だけ止める。送信済みの履歴は残す。
    // 未連携へ切り替わった変更では、将来分を作らないだけでなく
    // 既存の未送信もここで止める。
    statements.push(
      c.env.DB.prepare(
        `UPDATE booking_reminders SET status='cancelled'
          WHERE booking_id = ? AND status IN ('pending', 'failed')`,
      ).bind(bookingId),
    );
    for (const item of reminderSchedule) {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO booking_reminders (id, booking_id, kind, scheduled_at) VALUES (?,?,?,?)`,
        ).bind(crypto.randomUUID(), bookingId, item.kind, item.scheduledAt),
      );
    }
  }
  const results = await c.env.DB.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const current = await c.env.DB
      .prepare(`SELECT lock_version, status FROM bookings WHERE id = ? AND line_account_id = ?`)
      .bind(bookingId, accountId)
      .first<{ lock_version: number; status: string }>();
    if (!current) return c.json({ error: 'booking_not_found' }, 404);
    if (Number(current.lock_version) !== expectedVersion
      || (current.status !== 'requested' && current.status !== 'confirmed')) {
      return c.json({ error: 'version_conflict' }, 409);
    }
    const alternatives = await bookingConflictAlternatives(c.env.DB, c.env, {
      lineAccountId: accountId,
      menuId: newMenuId,
      staffId: newStaffId,
      startsAt: newStartsAt,
      durationMinutes: menuRow.dur,
    });
    return c.json({ error: 'slot_conflict', data: alternatives }, 409);
  }
  const remindersCreated = (timingChanged || policyChanged) ? reminderSchedule.length : 0;

  // ---- トリガ連動 ----
  // 変更は「新しい起点へ移す」ので cancel ではなく reschedule を使う。
  // 応答を返す前に終わらせ、失敗は握りつぶさず応答と監査へ残す。
  // 予約変更自体は成立ずみのため 200 のまま (落とさない)。
  // 処理の後は現在の予約日時から再照合し、途中失敗の置き忘れを回収する
  // (日時差分の無い再保存でも回復する。ずれが無ければ 0 件の冪等)。
  let v6Sync: 'synced' | 'failed' | 'not_applicable' = 'not_applicable';
  if ((timingChanged || policyChanged) && friendId) {
    v6Sync = 'synced';
    if (newPolicy.day_before || newPolicy.hours_before) {
      if (newStartsAt.toISOString() !== row.starts_at) {
        try {
          await rescheduleByTrigger(c.env.DB, {
            triggerType: 'booking',
            sourceId: bookingId,
            sourceEventId: bookingId,
            friendId,
            oldStartsAtIso: row.starts_at,
            newStartsAtIso: newStartsAt.toISOString(),
            lineAccountId: accountId,
          });
        } catch (error) {
          logger.error("booking.update_admin_booking_failed");
          v6Sync = 'failed';
        }
      }
    } else {
      try {
        await cancelByTrigger(c.env.DB, {
          triggerType: 'booking',
          sourceId: bookingId,
          sourceEventId: bookingId,
          friendId,
          // 移行前の行を探す起点は変更前の開始時刻。
          // 新日時で探すと旧登録に一致しない。
          startsAtIso: row.starts_at,
          lineAccountId: accountId,
          cancelReason: `booking_updated_notifications_off:${bookingId}:by:${self ? `self:${self.lineUserId}` : (c.get('staff')?.id ?? 'admin')}`,
        });
      } catch (error) {
        logger.error("booking.update_admin_booking_failed");
        v6Sync = 'failed';
      }
    }
  }
  if (friendId) {
    try {
      await reconcileV6ToStartsAt(c.env.DB, {
        triggerType: 'booking',
        sourceId: bookingId,
        sourceEventId: bookingId,
        friendId,
        startsAtIso: newStartsAt.toISOString(),
      });
    } catch (error) {
      logger.error("booking.update_admin_booking_failed");
      v6Sync = 'failed';
    }
  }
  if (v6Sync === 'failed') {
    await recordBookingAudit(c.env.DB, {
      bookingId,
      lineAccountId: accountId,
      action: 'v6_sync_failed',
      before: { starts_at: newStartsAt.toISOString() },
      after: { outcome: 'pending_retry' },
      reason: 'booking_updated',
      ...selfAuditActor(self, c),
      occurredAt: new Date().toISOString(),
    });
  }

  // ---- Google カレンダー同期  ----
  // 新版 (lock_version) をキーに台帳へ載せ、現在の予約状態を反映する。
  // confirmed は delete+create、requested は touched せず skipped。
  // 失敗は retry_wait で残し、/sync/retry または次の変更で回収する。
  const googleSync = await runBookingGoogleSync(c.env.DB, {
    bookingId,
    lineAccountId: accountId,
    credentials: googleCredentials(c.env),
  });

  // ---- 変更案内の LINE 通知 ----
  // 明示的に送らない指定が無い限り、連携済みの予約には変更を知らせる。
  // 未連携の予約では送らない (operation 行も作らない)。
  const changeNoticeRequested = Boolean(row.friend_id) && body.send_change_notification !== false;
  const wantsChangeNotice = changeNoticeRequested && await bookingAutomaticNotificationAllowed(c.env.DB, accountId);
  let changeOperationId: string | null = null;
  if (wantsChangeNotice) {
    changeOperationId = await queueBookingOperation(c.env.DB, {
      bookingId,
      lineAccountId: accountId,
      kind: 'confirmation_line',
      idempotencyKey: `${bookingId}:confirmation-line:changed:v${newVersion}`,
      result: { notificationKind: 'changed' },
    });
    c.executionCtx.waitUntil(
      notifyForBooking(c.env.DB, bookingId, 'changed', changeOperationId).catch((err) =>
        logger.error("booking.update_admin_booking_failed"),
      ),
    );
  }

  const [reminderRows, operationRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, kind, scheduled_at, sent_at, status
         FROM booking_reminders WHERE booking_id = ? ORDER BY scheduled_at ASC`,
    ).bind(bookingId).all<{
      id: string; kind: string; scheduled_at: string; sent_at: string | null; status: string;
    }>(),
    listBookingOperations(c.env.DB, { bookingId, lineAccountId: accountId }),
  ]);
  return c.json({
    booking_id: bookingId,
    lock_version: newVersion,
    status: row.status,
    calendar_sync: googleSync === 'succeeded' ? 'synced'
      : googleSync === 'retry_wait' ? 'failed'
      : googleSync === 'skipped' ? 'not_configured' : 'not_applicable',
    change_notification: wantsChangeNotice ? 'queued' : 'not_applicable',
    change_notification_reason: !wantsChangeNotice && changeNoticeRequested ? 'sending_stopped' : null,
    // 通知同期の結果。failed のときは監査 (v6_sync_failed) にも残し、
    // 日時差分の無い再保存でも reconcile で回復する。
    v6_sync: v6Sync,
    reminders: (reminderRows.results ?? []).map((reminder) => ({
      id: reminder.id,
      kind: reminder.kind,
      scheduled_at: reminder.scheduled_at,
      sent_at: reminder.sent_at,
      status: reminder.status,
    })),
    reminders_created: remindersCreated,
    operations: operationRows,
  });
}
