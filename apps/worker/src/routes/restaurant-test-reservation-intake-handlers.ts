import { phoneIntakeFailure } from '../services/restaurant-phone-intake.js';
import { normalizePhone, phoneProblem } from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import { RESERVATION_FILTER_STATUSES } from './restaurant-reservation-filter.js';
import type { SeatWaitlistEntryLike } from './restaurant-context-types.js';
import { inputError } from '../lib/input-errors.js';
import { publicClosure, closuresForRange, closureAffectsTable, openSeatTables } from '../services/restaurant-closures.js';

import type { Env } from '../worker-env.js';

import { restaurantSeatCapacity } from '../services/restaurant-seat-capacity.js';
import { assignRestaurantTable } from '../features/booking/booking-assignment/index.js';
import { sendRestaurantLineConfirmation, type RestaurantLineNotice } from '../services/restaurant-line-confirmation.js';
import { promoteSeatWaitlist } from '../services/restaurant-seat-waitlist.js';
import { dbFor } from '../services/db-router.js';
import { expireRestaurantHolds } from '../services/restaurant-booking.js';
import { DEFAULT_STAY_MINUTES } from '../services/restaurant-reservation-email.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { isRestaurantReservationSource, validateInboundReservation } from '../services/restaurant-test.js';
import { hasOrganizationSelector, requiredAccount, organizationFor, acquireLock, releaseLock, storeBelongsTo, overlappingReservationExists, reservationSlotActive, adjustInventoryReservedCount, applyReservationInventoryChange, insertSeatWaitlistEntry, SEAT_WAITLIST_ERROR_STATUS, storeInOrganization, attendance } from './restaurant-test-definition.js';
import type { Context } from 'hono';

export const post__api_restaurant_test_inbound_emails_id_manual_import_1 = async (c: Context<Env, "/api/restaurant-test/inbound-emails/:id/manual-import">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const db = dbFor(c.env);
  const email = await db.prepare(`SELECT e.id, e.store_id, e.status, e.media_id, m.code AS media_code FROM rt_inbound_emails e
    JOIN rt_stores s ON s.id = e.store_id LEFT JOIN rt_media m ON m.id = e.media_id
    WHERE e.id = ? AND s.organization_id = ? AND (? IS NULL OR s.id = ?)`)
    .bind(c.req.param('id'), organization.id, organization.scopedStoreId, organization.scopedStoreId)
    .first<{ id: string; store_id: string; status: string; media_id: string | null; media_code: string | null }>();
  if (!email) return c.json({ success: false, error: 'メールが見つかりません' }, 404);
  const existing = await db.prepare("SELECT id, table_id FROM rt_reservations WHERE inbound_email_id = ? AND parser_key = 'manual_import'").bind(email.id).first<{ id: string; table_id: string | null }>();
  if (existing) return c.json({ success: true, data: { id: existing.id, tableId: existing.table_id, duplicate: true } });
  if (email.status !== 'quarantined') return c.json({ success: false, error: '手で取り込めるのは読めなかったメールだけです' }, 409);
  const body: Record<string, unknown> = (await c.req.json<Record<string, unknown>>().catch(() => null)) || {};
  const start = typeof body.startsAt === 'string' ? Date.parse(body.startsAt) : NaN;
  const endsAt = body.endsAt ?? (Number.isFinite(start) ? new Date(start + DEFAULT_STAY_MINUTES * 60_000).toISOString() : undefined);
  const checked = validateInboundReservation({ ...body, endsAt, externalId: `email-${email.id}`, status: 'confirmed' });
  if (!checked.ok) return inputError(c, { success: false, error: checked.error, field: checked.field }, 400, []);
  const reservation = checked.value;
  const key = `reservation:${email.store_id}:${reservation.startsAt}`;
  const owner = crypto.randomUUID();
  if (!await acquireLock(db, key, owner)) return c.json({ success: false, error: '同じ時間帯を別の担当者が更新中です' }, 409);
  try {
    const tables = await db.prepare(`SELECT t.id, t.min_capacity, t.max_capacity, t.is_active FROM rt_tables t WHERE t.store_id = ?
      AND NOT EXISTS (SELECT 1 FROM rt_reservations r WHERE r.store_id = t.store_id AND r.table_id = t.id
        AND r.status NOT IN ('cancelled', 'no_show') AND r.departed_at IS NULL AND datetime(r.starts_at) < datetime(?) AND datetime(r.ends_at) > datetime(?))`)
      .bind(email.store_id, reservation.endsAt, reservation.startsAt).all<{ id: string; min_capacity: number; max_capacity: number; is_active: number }>();
    const eligible = tables.results.filter(t => t.is_active === 1 && t.min_capacity <= reservation.guestCount && t.max_capacity >= reservation.guestCount)
      .map(t => ({ id: t.id, label: t.id, minCapacity: t.min_capacity, maxCapacity: t.max_capacity }))
      .sort((a,b) => a.maxCapacity - b.maxCapacity || a.id.localeCompare(b.id));
    const tableId = (await assignRestaurantTable(db, email.store_id, reservation.startsAt, reservation.guestCount, eligible))?.id ?? null;
    const id = crypto.randomUUID();
    const source = isRestaurantReservationSource(email.media_code) ? email.media_code : 'manual';
    const writes = await db.batch([
      db.prepare(`INSERT INTO rt_reservations (id, store_id, source, external_id, customer_name, guest_count, starts_at, ends_at, table_id, status, media_id, inbound_email_id, parser_key, note)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, 'manual_import', ?
        WHERE EXISTS (SELECT 1 FROM rt_inbound_emails WHERE id = ? AND status = 'quarantined')
        ON CONFLICT(store_id, source, external_id) DO NOTHING`).bind(id, email.store_id, source, reservation.externalId, reservation.customerName, reservation.guestCount,
          reservation.startsAt, reservation.endsAt, tableId, email.media_id, email.id, `担当者 ${c.get('staff')?.id || '管理者'} が手で取り込み`, email.id),
      db.prepare(`UPDATE rt_inbound_emails SET status = 'received', quarantine_reason = NULL WHERE id = ?
        AND EXISTS (SELECT 1 FROM rt_reservations WHERE inbound_email_id = ? AND parser_key = 'manual_import')`).bind(email.id, email.id),
      db.prepare(`UPDATE rt_inventory_slots SET reserved_count = COALESCE((SELECT SUM(r.guest_count) FROM rt_reservations r WHERE r.store_id=rt_inventory_slots.store_id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND datetime(r.starts_at)<datetime(rt_inventory_slots.starts_at, '+' || rt_inventory_slots.slot_minutes || ' minutes') AND datetime(r.ends_at)>datetime(rt_inventory_slots.starts_at)),0), updated_at = datetime('now')
        WHERE store_id = ? AND datetime(starts_at) = datetime(?) AND EXISTS (SELECT 1 FROM rt_reservations WHERE id = ?)` )
        .bind(email.store_id, reservation.startsAt, id),
    ]);
    const saved = await db.prepare("SELECT id, table_id FROM rt_reservations WHERE inbound_email_id = ? AND parser_key = 'manual_import'").bind(email.id).first<{ id: string; table_id: string | null }>();
    if (!saved) return c.json({ success: false, error: 'メールの状態が変わりました。読み直してください' }, 409);
    return c.json({ success: true, data: { id: saved.id, tableId: saved.table_id, duplicate: !writes[0].meta.changes } }, writes[0].meta.changes ? 201 : 200);
  } finally {
    await releaseLock(db, key, owner);
  }
};

export const patch__api_restaurant_test_approvals_id_2 = async (c: Context<Env, "/api/restaurant-test/approvals/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<{ action?: string; comment?: string }>();
  const status = body.action === 'approve' ? 'approved' : body.action === 'return' ? 'returned' : null;
  if (!status) return inputError(c, { success: false, error: 'action は approve または return です' }, 400, ["action"]);
  if (status === 'returned' && (typeof body.comment !== 'string' || !body.comment.trim())) {
    return inputError(c, { success: false, error: '差し戻しの理由を入力してください' }, 400, ["action","comment"]);
  }
  if (body.comment !== undefined && typeof body.comment !== 'string') return inputError(c, { success: false, error: 'コメントは文字列で入力してください' }, 400, ["comment"]);
  const staff = c.get('staff');
  const result = await dbFor(c.env).prepare(`UPDATE rt_approval_requests
    SET status = ?, review_comment = ?, reviewed_by = ?, updated_at = datetime('now')
    WHERE id = ? AND organization_id = ? AND (? IS NULL OR store_id = ?)
      AND status = 'pending'`).bind(
      status, body.comment?.trim() || null, staff?.name || staff?.id || '管理者', c.req.param('id'), organization.id,
      organization.scopedStoreId, organization.scopedStoreId,
    ).run();
  if (!result.meta.changes) return c.json({ success: false, error: '対象が無いか、すでに処理済みです' }, 409);
  const change = await dbFor(c.env).prepare('SELECT status, failure_reason FROM rt_menu_change_requests WHERE approval_id = ?')
    .bind(c.req.param('id')).first<{ status: string; failure_reason: string | null }>();
  return c.json({ success: true, data: { id: c.req.param('id'), status, menuChangeStatus: change?.status ?? null, failureReason: change?.failure_reason ?? null } });
};

export const post__api_restaurant_test_reservations_manual_3 = async (c: Context<Env, "/api/restaurant-test/reservations/manual">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  if (body.notifyLine !== undefined && typeof body.notifyLine !== 'boolean') {
    return inputError(c, { success: false, error: 'notifyLine は true または false を指定してください' }, 400, ["notifyLine"]);
  }
  const storeId = typeof body.storeId === 'string' ? body.storeId : '';
  if (!storeId || !await storeBelongsTo(c, organization.id, storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  const checked = validateInboundReservation({ ...body, externalId: `manual-${crypto.randomUUID()}` });
  if (!checked.ok) return inputError(c, { success: false, error: checked.error, field: checked.field }, 400, []);
  if (body.source === 'phone') {
    const failure = await phoneIntakeFailure(dbFor(c.env, storeId), storeId, checked.value.startsAt);
    if (failure) return c.json({ success: false, code: failure, error: failure }, 409);
  }
  await expireRestaurantHolds(dbFor(c.env, storeId), undefined, storeId);
  const lockKey = `reservation:${storeId}`;
  const lockOwner = crypto.randomUUID();
  if (!await acquireLock(dbFor(c.env, storeId), lockKey, lockOwner)) return c.json({ success: false, error: '同じ時間帯を別の担当者が更新中です' }, 409);
  let saved: { id: string; tableId: string | null };
  try {
    const tables = await dbFor(c.env, storeId).prepare('SELECT id, min_capacity, max_capacity, is_active FROM rt_tables WHERE store_id = ?').bind(storeId).all<{ id: string; min_capacity: number; max_capacity: number; is_active: number }>();
    if (checked.value.tableId && !tables.results.some((table) => table.id === checked.value.tableId && table.is_active === 1)) {
      return inputError(c, { success: false, error: '停止中の卓は選べません' }, 400, ["storeId"]);
    }
    if (checked.value.courseId) {
      const course = await dbFor(c.env, storeId).prepare('SELECT id FROM rt_menu_items WHERE id = ? AND store_id = ? AND status = ?').bind(checked.value.courseId, storeId, 'active').first();
      if (!course) return inputError(c, { success: false, error: '停止中のコースは選べません' }, 400, ["storeId"]);
    }
    const closures = await closuresForRange(dbFor(c.env, storeId), storeId, checked.value.startsAt, checked.value.endsAt);
    const blocked = closures.filter(r => checked.value.tableId ? closureAffectsTable(r, checked.value.tableId) : true);
    const open = await openSeatTables(dbFor(c.env, storeId), storeId, checked.value.startsAt, checked.value.endsAt, checked.value.guestCount, true);
    if (blocked.length && (checked.value.tableId || !open.length)) return c.json({ success: false, error: 'closure_conflict', code: 'closure_conflict', reason: '臨時休業・貸切の日時と卓に重なります', data: { closures: blocked.map(publicClosure) }, closures: blocked.map(publicClosure) }, 409);
    if(checked.value.tableId&&!open.some(t=>t.id===checked.value.tableId||t.tableIds?.includes(checked.value.tableId!)))return inputError(c,{success:false,error:'卓に入る人数を確認してください'},400,['guestCount','tableId']);
    const candidates=await openSeatTables(dbFor(c.env,storeId),storeId,checked.value.startsAt,checked.value.endsAt,checked.value.guestCount);
    const capacity=await restaurantSeatCapacity(dbFor(c.env,storeId),storeId,checked.value.startsAt,checked.value.endsAt);
    const selected=capacity.select({startsAt:checked.value.startsAt,endsAt:checked.value.endsAt,guestCount:checked.value.guestCount,tableId:checked.value.tableId});
    const tableId=checked.value.tableId || (capacity.settings.enabled?(selected?.id??null):null);
    if(!selected || !candidates.some(t=>t.id===selected.id||t.tableIds?.includes(selected.id)))return c.json({success:false,code:'availability_conflict',error:'人数が入る空き卓がありません'},409);
    if (tableId && await overlappingReservationExists(dbFor(c.env, storeId), storeId, tableId, checked.value.startsAt, checked.value.endsAt, undefined, c.env)) {
      return c.json({ success: false, error: '同じ卓に重なる時間の予約があるため登録できません' }, 409);
    }
    const id = crypto.randomUUID();
    await capacity.commit([dbFor(c.env, storeId).prepare(`INSERT INTO rt_reservations
      (id, store_id, source, external_id, customer_name, customer_phone, line_uid, guest_count, starts_at, ends_at, table_id, course_id, status, allergy_note, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        id, storeId, body.source === 'phone' ? 'phone' : 'manual', checked.value.externalId, checked.value.customerName, checked.value.customerPhone,
        checked.value.lineUid, checked.value.guestCount, checked.value.startsAt, checked.value.endsAt,
        tableId, checked.value.courseId, checked.value.status, checked.value.allergyNote, checked.value.note,
      )]);
    if (reservationSlotActive(checked.value.status)) {
      await adjustInventoryReservedCount(dbFor(c.env, storeId), storeId, checked.value.startsAt, checked.value.guestCount);
    }
    saved = { id, tableId };
  } finally {
    await releaseLock(dbFor(c.env, storeId), lockKey, lockOwner);
  }
  const lineNotice: RestaurantLineNotice = body.notifyLine === true
    ? await sendRestaurantLineConfirmation(c, {
      reservationId: saved.id, storeId, tenantId: organization.tenant_id ?? DEFAULT_TENANT_ID,
      lineUid: checked.value.lineUid ?? null, startsAt: checked.value.startsAt,
      endsAt: checked.value.endsAt, guestCount: checked.value.guestCount,
      courseId: checked.value.courseId ?? null, status: checked.value.status ?? 'confirmed',
    })
    : { sent: false, reason: 'not_requested' };
  return c.json({ success: true, data: { ...saved, syncDirection: 'inbound_only', lineNotice } }, 201);
};

export const post__api_restaurant_test_reservations_walk_in_4 = async (c: Context<Env, "/api/restaurant-test/reservations/walk-in">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  if (body.notifyLine !== undefined && typeof body.notifyLine !== 'boolean') {
    return inputError(c, { success: false, error: 'notifyLine は true または false を指定してください' }, 400, ["notifyLine"]);
  }
  const storeId = typeof body.storeId === 'string' ? body.storeId : '';
  if (!storeId || !await storeBelongsTo(c, organization.id, storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  if (!Number.isSafeInteger(body.guestCount) || Number(body.guestCount) < 1 || Number(body.guestCount) > 100
    || typeof body.tableId !== 'string' || !body.tableId) return inputError(c, { success: false, error: '人数と卓を指定してください' }, 400, ["guestCount","tableId"]);
  for (const key of ['customerName', 'customerPhone', 'lineUid']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || String(body[key]).length > 200)) return inputError(c, { success: false, error: '連絡先の形式を確認してください' }, 400, [key]);
  }
  const startsAt = new Date().toISOString();
  const checked = validateInboundReservation({ ...body, customerName: body.customerName || '予約なしの来店',
    startsAt, endsAt: new Date(Date.now() + DEFAULT_STAY_MINUTES * 60000).toISOString(), status: 'visited', externalId: `walk-in-${crypto.randomUUID()}` });
  if (!checked.ok) return inputError(c, { success: false, error: checked.error }, 400, ["customerName"]);
  await expireRestaurantHolds(dbFor(c.env, storeId), undefined, storeId);
  const lockKey = `reservation:${storeId}`;
  const lockOwner = crypto.randomUUID();
  if (!await acquireLock(dbFor(c.env, storeId), lockKey, lockOwner)) return c.json({ success: false, error: '同じ時間帯を別の担当者が更新中です' }, 409);
  let saved: { id: string; tableId: string | null };
  try {
    const tables = await dbFor(c.env, storeId).prepare('SELECT id, min_capacity, max_capacity, is_active FROM rt_tables WHERE store_id = ?').bind(storeId).all<{ id: string; min_capacity: number; max_capacity: number; is_active: number }>();
    if (checked.value.tableId && !tables.results.some((table) => table.id === checked.value.tableId && table.is_active === 1)) {
      return inputError(c, { success: false, error: '停止中の卓は選べません' }, 400, ["customerName","storeId"]);
    }
    if (checked.value.courseId) {
      const course = await dbFor(c.env, storeId).prepare('SELECT id FROM rt_menu_items WHERE id = ? AND store_id = ? AND status = ?').bind(checked.value.courseId, storeId, 'active').first();
      if (!course) return inputError(c, { success: false, error: '停止中のコースは選べません' }, 400, ["customerName","storeId"]);
    }
    const closures = await closuresForRange(dbFor(c.env, storeId), storeId, checked.value.startsAt, checked.value.endsAt);
    const blocked = closures.filter(r => checked.value.tableId ? closureAffectsTable(r, checked.value.tableId) : true);
    const open = await openSeatTables(dbFor(c.env, storeId), storeId, checked.value.startsAt, checked.value.endsAt, checked.value.guestCount, true);
    if (blocked.length && (checked.value.tableId || !open.length)) return c.json({ success: false, error: 'closure_conflict', code: 'closure_conflict', reason: '臨時休業・貸切の日時と卓に重なります', data: { closures: blocked.map(publicClosure) }, closures: blocked.map(publicClosure) }, 409);
    if(checked.value.tableId&&!open.some(t=>t.id===checked.value.tableId||t.tableIds?.includes(checked.value.tableId!)))return inputError(c,{success:false,error:'卓に入る人数を確認してください'},400,['guestCount','tableId']);
    const candidates=await openSeatTables(dbFor(c.env,storeId),storeId,checked.value.startsAt,checked.value.endsAt,checked.value.guestCount);
    const capacity=await restaurantSeatCapacity(dbFor(c.env,storeId),storeId,checked.value.startsAt,checked.value.endsAt);
    const selected=capacity.select({startsAt:checked.value.startsAt,endsAt:checked.value.endsAt,guestCount:checked.value.guestCount,tableId:checked.value.tableId});
    const tableId=checked.value.tableId || (capacity.settings.enabled?(selected?.id??null):null);
    if(!selected || !candidates.some(t=>t.id===selected.id||t.tableIds?.includes(selected.id)))return c.json({success:false,code:'availability_conflict',error:'人数が入る空き卓がありません'},409);
    if (tableId && await overlappingReservationExists(dbFor(c.env, storeId), storeId, tableId, checked.value.startsAt, checked.value.endsAt, undefined, c.env)) {
      return c.json({ success: false, error: '同じ卓に重なる時間の予約があるため登録できません' }, 409);
    }
    const id = crypto.randomUUID();
    const db = dbFor(c.env, storeId);
    await capacity.commit([
      db.prepare(`INSERT INTO rt_reservations
        (id, store_id, source, external_id, customer_name, customer_phone, line_uid, guest_count, starts_at, ends_at, table_id, course_id, status, allergy_note, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          id, storeId, 'walk_in', checked.value.externalId, checked.value.customerName, checked.value.customerPhone,
          checked.value.lineUid, checked.value.guestCount, checked.value.startsAt, checked.value.endsAt,
          tableId, checked.value.courseId, checked.value.status, checked.value.allergyNote, checked.value.note),
      db.prepare(`INSERT INTO rt_seat_visit_marks
        (id,reservation_id,store_id,kind,marked_by_staff_id,marked_by_name,marked_at) VALUES(?,?,?,'visited',?,?,?)`)
        .bind(crypto.randomUUID(),id,storeId,c.get('staff')?.id??null,c.get('staff')?.name??null,startsAt),
    ]);
    saved = { id, tableId };
  } finally {
    await releaseLock(dbFor(c.env, storeId), lockKey, lockOwner);
  }
  const lineNotice = body.notifyLine === true ? await sendRestaurantLineConfirmation(c,{reservationId:saved.id,storeId,tenantId:organization.tenant_id??DEFAULT_TENANT_ID,lineUid:checked.value.lineUid??null,startsAt:checked.value.startsAt,endsAt:checked.value.endsAt,guestCount:checked.value.guestCount,courseId:checked.value.courseId??null,status:'visited'}) : {sent:false,reason:'not_requested'};
  return c.json({ success: true, data: { ...saved, status: 'visited', source: 'walk_in', startsAt: checked.value.startsAt, endsAt: checked.value.endsAt,lineNotice } }, 201);
};

export const patch__api_restaurant_test_reservations_id_5 = async (c: Context<Env, "/api/restaurant-test/reservations/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const current = await dbFor(c.env).prepare(`SELECT r.* FROM rt_reservations r
    JOIN rt_stores s ON s.id = r.store_id
    WHERE r.id = ? AND s.organization_id = ? AND (? IS NULL OR s.id = ?)
    LIMIT 1`).bind(
      c.req.param('id'), organization.id,
      organization.scopedStoreId, organization.scopedStoreId,
    ).first<{
      id: string; store_id: string; customer_name: string; customer_phone: string | null;
      guest_count: number; starts_at: string; ends_at: string; table_id: string | null;
      course_id: string | null; status: string; allergy_note: string | null; note: string | null; cancel_reason: string | null; hold_expires_at: string | null; customer_version: number;
    }>();
  if (!current) return c.json({ success: false, error: '予約が見つかりません' }, 404);
  if (!await storeBelongsTo(c, organization.id, current.store_id)) return c.json({success:false,error:'この店舗を操作する権限がありません'},403);
  if (current.hold_expires_at && current.status === 'pending' && Date.parse(current.hold_expires_at) <= Date.now()) {
    await expireRestaurantHolds(dbFor(c.env, current.store_id), undefined, current.store_id);
    return c.json({ success: false, error: '仮押さえの期限が切れました。読み直してください' }, 409);
  }
  const body: Record<string, unknown> = (await c.req.json().catch(() => null)) || {};
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion)<1) return inputError(c,{success:false,error:'予約の版を指定してください'},400,['expectedVersion']);
  if (body.expectedVersion!==current.customer_version) return c.json({success:false,error:'ほかの人が変更しました。最新を読み込んでください',code:'version_conflict',data:{version:current.customer_version}},409);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  const next = {
    customer_name: current.customer_name,
    customer_phone: current.customer_phone,
    guest_count: current.guest_count,
    starts_at: current.starts_at,
    ends_at: current.ends_at,
    table_id: current.table_id,
    course_id: current.course_id,
    status: current.status,
    allergy_note: current.allergy_note,
    note: current.note,
    cancel_reason: current.cancel_reason,
  };
  if (has('customerName')) {
    const value = typeof body.customerName === 'string' ? body.customerName.trim() : '';
    if (!value) return inputError(c, { success: false, error: 'お客様名が正しくありません' }, 400, ["customerName"]);
    next.customer_name = value;
  }
  if (has('customerPhone')) {
    if (body.customerPhone != null && (typeof body.customerPhone !== 'string' || phoneProblem(body.customerPhone))) return inputError(c, { success: false, error: '電話番号は0から始まる10〜11桁の数字で入れてください。' }, 400, ['customerPhone']);
    next.customer_phone = typeof body.customerPhone === 'string' && body.customerPhone.trim()
      ? normalizePhone(body.customerPhone)
      : null;
  }
  if (has('guestCount')) {
    const value = Number(body.guestCount);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      return inputError(c, { success: false, error: '人数は1〜100で指定してください' }, 400, ["guestCount"]);
    }
    next.guest_count = value;
  }
  if (has('startsAt') || has('endsAt')) {
    if (!has('startsAt') || !has('endsAt')) {
      return inputError(c, { success: false, error: '日時は開始と終了を両方指定してください' }, 400, ["startsAt","endsAt"]);
    }
    const start = Date.parse(String(body.startsAt));
    const end = Date.parse(String(body.endsAt));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return inputError(c, { success: false, error: '日時の指定が正しくありません' }, 400, ["startsAt","endsAt"]);
    }
    next.starts_at = new Date(start).toISOString();
    next.ends_at = new Date(end).toISOString();
  }
  if (has('status')) {
    const value = typeof body.status === 'string' ? body.status : '';
    if (!RESERVATION_FILTER_STATUSES.includes(value)) {
      return inputError(c, { success: false, error: '状態の指定が正しくありません' }, 400, ["status"]);
    }
    if(value==='no_show' && current.status==='pending')return c.json({success:false,error:'承認してから無断にしてください',code:'approval_required'},409);
    if(value==='no_show' && (['visited','seated'].includes(current.status) || await dbFor(c.env,current.store_id).prepare("SELECT 1 FROM rt_seat_visit_marks WHERE reservation_id=? AND kind='visited' AND undone_at IS NULL LIMIT 1").bind(current.id).first()))return c.json({success:false,error:'来店済みの予約は無断にできません',code:'already_arrived'},409);
    if(value!==current.status&&['visited','seated'].includes(value))return inputError(c,{success:false,error:'来店の記録は来店・退店の操作から保存してください'},409,['status']);
    next.status = value;
  }
  if (has('tableId')) {
    if (body.tableId === null || body.tableId === '') {
      next.table_id = null;
    } else if (typeof body.tableId === 'string') {
      const table = await dbFor(c.env, current.store_id).prepare(
        'SELECT id FROM rt_tables WHERE id = ? AND store_id = ? AND (is_active = 1 OR id = ?) LIMIT 1',
      ).bind(body.tableId, current.store_id, current.table_id).first();
      if (!table) return inputError(c, { success: false, error: '卓が正しくありません' }, 400, ["tableId"]);
      next.table_id = body.tableId;
    } else {
      return inputError(c, { success: false, error: '卓が正しくありません' }, 400, ["tableId"]);
    }
  }
  if (has('courseId')) {
    if (body.courseId === null || body.courseId === '') {
      next.course_id = null;
    } else if (typeof body.courseId === 'string') {
      const course = await dbFor(c.env, current.store_id).prepare(
        'SELECT id FROM rt_menu_items WHERE id = ? AND store_id = ? AND (status = ? OR id = ?) LIMIT 1',
      ).bind(body.courseId, current.store_id, 'active', current.course_id).first();
      if (!course) return inputError(c, { success: false, error: 'コースが正しくありません' }, 400, ["courseId"]);
      next.course_id = body.courseId;
    } else {
      return inputError(c, { success: false, error: 'コースが正しくありません' }, 400, ["courseId"]);
    }
  }
  if (has('allergyNote')) {
    next.allergy_note = typeof body.allergyNote === 'string' && body.allergyNote.trim()
      ? body.allergyNote.trim()
      : null;
  }
  if (has('note')) {
    next.note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
  }
  if (has('cancellationReason')) {
    if (next.status !== 'cancelled' || typeof body.cancellationReason !== 'string' || !body.cancellationReason.trim()) {
      return inputError(c, { success: false, error: '取消理由を確認してください' }, 400, ['cancellationReason']);
    }
    next.cancel_reason = body.cancellationReason.trim();
  }

  const changesSlot=next.table_id!==current.table_id||next.guest_count!==current.guest_count||next.starts_at!==current.starts_at||next.ends_at!==current.ends_at||(!reservationSlotActive(current.status)&&reservationSlotActive(next.status));
  if(changesSlot && next.table_id && reservationSlotActive(next.status)) {
    const candidates=await openSeatTables(dbFor(c.env,current.store_id),current.store_id,next.starts_at,next.ends_at,next.guest_count,false,current.id);
    if(!candidates.some(t=>t.id===next.table_id||t.tableIds?.includes(next.table_id!)))return c.json({success:false,code:'availability_conflict',error:'人数・休業・卓の停止を確認してください'},409);
  }
  if (next.table_id && reservationSlotActive(next.status)
    && await overlappingReservationExists(
      dbFor(c.env, current.store_id), current.store_id, next.table_id, next.starts_at, next.ends_at, current.id, c.env,
    )) {
    return c.json({ success: false, error: '同じ卓に重なる時間の予約があるため変更できません' }, 409);
  }
  const db = dbFor(c.env, current.store_id);
  const capacity = changesSlot && reservationSlotActive(next.status) ? await restaurantSeatCapacity(db,current.store_id,next.starts_at,next.ends_at,current.id) : null;
  if(capacity && !capacity.select({startsAt:next.starts_at,endsAt:next.ends_at,guestCount:next.guest_count,tableId:next.table_id}))return c.json({success:false,code:'availability_conflict',error:'未配席の予約を含め、人数が入る空き卓がありません'},409);
  const update = db.prepare(`UPDATE rt_reservations SET
    confirmation_revision = confirmation_revision + 1, customer_name = ?, customer_phone = ?, guest_count = ?, starts_at = ?, ends_at = ?,
    table_id = ?, course_id = ?, status = ?, allergy_note = ?, note = ?, cancel_reason = ?, customer_version=customer_version+1, updated_at = datetime('now')
    WHERE id = ? AND customer_version = ?`).bind(
      next.customer_name, next.customer_phone, next.guest_count, next.starts_at, next.ends_at,
      next.table_id, next.course_id, next.status, next.allergy_note, next.note, next.cancel_reason, current.id, Number(body.expectedVersion),
    );
  const statements = [update];
  if ((current.status === 'no_show' && next.status !== 'no_show') || (next.status === 'cancelled' && ['visited', 'seated'].includes(current.status))) {
    statements.push(db.prepare(`UPDATE rt_seat_visit_marks SET undone_at=?, undone_by=?, undone_request_id=?, result_version=?
      WHERE reservation_id=? AND kind=? AND undone_at IS NULL AND changes()=1`).bind(
      new Date().toISOString(), c.get('staff')?.id ?? null, crypto.randomUUID(), current.customer_version + 1, current.id, current.status === 'no_show' ? 'no_show' : 'visited',
    ));
  }
  const results = await (capacity?.commit ?? db.batch.bind(db))(statements);
  const savedUpdate=results[capacity?1:0];
  if (!savedUpdate.meta.changes) return c.json({success:false,error:"ほかの人が変更しました。最新を読み込んでください",code:"version_conflict"},409);
  await applyReservationInventoryChange(
    dbFor(c.env, current.store_id), current.store_id,
    { starts_at: current.starts_at, guest_count: current.guest_count, status: current.status },
    { starts_at: next.starts_at, guest_count: next.guest_count, status: next.status },
  );
  if (next.status === 'cancelled' && next.table_id) {
    // 席の空き待ち：空いた卓に入る組の早い順で1組に知らせる。
    // 知らせの失敗で取り消し自体を失敗させない。
    try {
      await promoteSeatWaitlist(dbFor(c.env, current.store_id), {
        storeId: current.store_id,
        startsAt: next.starts_at,
        tableId: next.table_id,
      }, undefined, c.env.LIFF_URL ?? '',c.env);
    } catch {
      logger.error("restaurant_booking.promote_seat_waitlist_failed");
    }
  }
  return c.json({ success: true, data: { id: current.id, version: current.customer_version+1 } });
};

export const post__api_restaurant_test_seat_waitlist_6 = async (c: Context<Env, "/api/restaurant-test/seat-waitlist">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return inputError(c, { success: false, error: 'invalid_json' }, 400, []);
  const storeId = typeof body.storeId === 'string' ? body.storeId : '';
  if (!storeId || !await storeBelongsTo(c, organization.id, storeId)) {
    return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  }
  if (body.customerPhone != null && (typeof body.customerPhone !== 'string' || phoneProblem(body.customerPhone))) return inputError(c, { success: false, error: '電話番号は0から始まる10〜11桁の数字で入れてください。' }, 400, ['customerPhone']);
  const result = await insertSeatWaitlistEntry(dbFor(c.env, storeId), {
    storeId,
    startsAt: typeof body.startsAt === 'string' ? body.startsAt : '',
    guestCount: Number(body.guestCount),
    customerName: typeof body.customerName === 'string' ? body.customerName : '',
    customerPhone: typeof body.customerPhone === 'string' && body.customerPhone.trim()
      ? normalizePhone(body.customerPhone) : null,
    lineUid: typeof body.lineUid === 'string' && body.lineUid.trim() ? body.lineUid.trim() : null,
  });
  if (!result.ok) {
    return inputError(c, { success: false, error: result.error }, SEAT_WAITLIST_ERROR_STATUS[result.error] as 400 | 409, []);
  }
  return c.json({ success: true, data: { id: result.id } }, 201);
};

export const get__api_restaurant_test_seat_waitlist_7 = async (c: Context<Env, "/api/restaurant-test/seat-waitlist">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const storeId = c.req.query('storeId')?.trim() ?? '';
  const store = storeId ? await storeInOrganization(c, organization.id, storeId) : null;
  if (!store) return c.json({ success: false, error: '店舗が正しくありません' }, 400);
  const conditions = ['w.store_id = ?'];
  const values: unknown[] = [store.id];
  const startsAt = c.req.query('startsAt')?.trim();
  if (startsAt) {
    const startsAtMs = Date.parse(startsAt);
    if (Number.isNaN(startsAtMs)) return c.json({ success: false, error: '日時の指定が正しくありません' }, 400);
    conditions.push('w.starts_at = ?');
    values.push(new Date(startsAtMs).toISOString());
  }
  const status = c.req.query('status')?.trim();
  if (status && ['waiting', 'invited', 'converted', 'cancelled','finished'].includes(status)) {
    conditions.push('w.status = ?');
    values.push(status);
  }
  const rows = await dbFor(c.env, store.id)
    .prepare(
      `SELECT w.*, t.label AS table_label
         FROM rt_seat_waitlist w
         LEFT JOIN rt_tables t ON t.id = w.table_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY w.starts_at ASC, w.created_at ASC, w.rowid ASC LIMIT 100`,
    )
    .bind(...values)
    .all();
  return c.json({ success: true, data: { waitlist: rows.results } });
};

export const delete__api_restaurant_test_seat_waitlist_id_8 = async (c: Context<Env, "/api/restaurant-test/seat-waitlist/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const id = c.req.param('id');
  const rawRevision = c.req.query('expectedConfirmationRevision');
  if (rawRevision !== undefined && (!/^[1-9]\d*$/.test(rawRevision) || !Number.isSafeInteger(Number(rawRevision)))) {
    return c.json({ success: false, error: '確認した版が不正です' }, 400);
  }
  const expectedRevision = rawRevision === undefined ? null : Number(rawRevision);
  const entry = await dbFor(c.env).prepare(
    `SELECT w.store_id, w.starts_at, w.status, w.table_id, w.confirmation_revision FROM rt_seat_waitlist w
       JOIN rt_stores s ON s.id = w.store_id
      WHERE w.id = ? AND s.organization_id = ?
        AND (? IS NULL OR s.id = ?)`,
  ).bind(id, organization.id, organization.scopedStoreId, organization.scopedStoreId)
    .first<{ store_id: string; starts_at: string; status: string; table_id: string | null; confirmation_revision: number }>();
  if (!entry) return c.json({ success: false, error: '見つかりません' }, 404);
  if (expectedRevision !== null && entry.confirmation_revision !== expectedRevision) return c.json({ success: false, error: '状態が変わりました。読み直してください', current: entry }, 409);
  if (entry.status !== 'waiting' && entry.status !== 'invited') {
    return c.json({ success: false, error: 'すでに終わっています', current: entry }, 409);
  }
  const wasInvited = entry.status === 'invited';
  const updated = await dbFor(c.env, entry.store_id).prepare(
    `UPDATE rt_seat_waitlist SET confirmation_revision=confirmation_revision+1, status = 'cancelled', updated_at = datetime('now')
      WHERE id = ? AND status IN ('waiting', 'invited')
        AND (? IS NULL OR (confirmation_revision = ? AND status = ? AND store_id = ?))`,
  ).bind(id, expectedRevision, expectedRevision, entry.status, entry.store_id).run();
  if ((updated.meta?.changes ?? 0) === 0) {
    if (expectedRevision === null) return c.json({ success: false, error: 'すでに終わっています' }, 409);
    const current = await dbFor(c.env, entry.store_id).prepare('SELECT store_id, starts_at, status, table_id, confirmation_revision FROM rt_seat_waitlist WHERE id = ? AND store_id = ?').bind(id, entry.store_id).first();
    return c.json({ success: false, error: '状態が変わりました。読み直してください', current }, 409);
  }
  if (wasInvited && entry.table_id) {
    // 見送りで仮押さえが空いたら、その卓に入る次の組へすぐ回す。
    try {
      await promoteSeatWaitlist(dbFor(c.env, entry.store_id), {
        storeId: entry.store_id,
        startsAt: entry.starts_at,
        tableId: entry.table_id,
      }, undefined, c.env.LIFF_URL ?? '',c.env);
    } catch {
      logger.error("restaurant_booking.promote_seat_waitlist_failed");
    }
  }
  return c.json({ success: true, data: { status: 'cancelled' } });
};

export const post__api_restaurant_test_seat_waitlist_id_convert_9 = async (c: Context<Env, "/api/restaurant-test/seat-waitlist/:id/convert">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const id = c.req.param('id');
  const body = await c.req.json<{ reservationId?: unknown }>().catch(() => null);
  const reservationId = typeof body?.reservationId === 'string' ? body.reservationId : '';
  if (!reservationId) return inputError(c, { success: false, error: '予約が必要です' }, 400, ["reservationId"]);
  const entry = await dbFor(c.env).prepare(
    `SELECT w.* FROM rt_seat_waitlist w
       JOIN rt_stores s ON s.id = w.store_id
      WHERE w.id = ? AND s.organization_id = ?
        AND (? IS NULL OR s.id = ?)`,
  ).bind(id, organization.id, organization.scopedStoreId, organization.scopedStoreId)
    .first<SeatWaitlistEntryLike>();
  if (!entry) return c.json({ success: false, error: '見つかりません' }, 404);
  if (entry.status !== 'invited'||!entry.hold_expires_at||Date.parse(entry.hold_expires_at)<=Date.now()) {
    return c.json({ success: false, error: 'すでに終わっています' }, 409);
  }
  const reservation = await dbFor(c.env, entry.store_id).prepare(
    `SELECT store_id, starts_at, guest_count, status,line_uid,customer_phone,table_id FROM rt_reservations
      WHERE id = ? AND store_id = ? AND status NOT IN ('cancelled')`,
  ).bind(reservationId, entry.store_id)
    .first<{ store_id: string; starts_at: string; guest_count: number; status: string;line_uid:string|null;customer_phone:string|null;table_id:string|null }>();
  if (!reservation
    || reservation.starts_at !== entry.starts_at
    || reservation.guest_count !== entry.guest_count
    || reservation.table_id!==entry.table_id
    || (entry.line_uid?reservation.line_uid!==entry.line_uid:normalizePhone(reservation.customer_phone??'')!==normalizePhone(entry.customer_phone??''))) {
    return c.json({ success: false, error: '予約が待ちと合いません' }, 409);
  }
  const updated=await dbFor(c.env, entry.store_id).prepare(
    `UPDATE rt_seat_waitlist SET confirmation_revision=confirmation_revision+1, status = 'converted', updated_at = datetime('now')
      WHERE id = ? AND status='invited' AND julianday(hold_expires_at)>julianday('now')`,
  ).bind(id).run();
  if(!updated.meta.changes)return c.json({success:false,error:'案内の期限または状態が変わりました'},409);
  return c.json({ success: true, data: { status: 'converted' } });
};

export const post__api_restaurant_test_reservations_id_attendance_10 = (c: Context<Env, "/api/restaurant-test/reservations/:id/attendance">) => attendance(c);

export const post__api_restaurant_test_reservations_id_visit_11 = (c: Context<Env, "/api/restaurant-test/reservations/:id/visit">) => attendance(c,'visit');

export const delete__api_restaurant_test_reservations_id_visit_12 = (c: Context<Env, "/api/restaurant-test/reservations/:id/visit">) => attendance(c,'undo_visit');

export const post__api_restaurant_test_inbound_reservations_13 = async (c: Context<Env, "/api/restaurant-test/inbound/reservations">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<{ storeId?: string; provider?: unknown; eventId?: string; reservation?: unknown }>();
  if (!body.storeId || !await storeBelongsTo(c, organization.id, body.storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  if (!isRestaurantReservationSource(body.provider) || ['manual', 'phone', 'line', 'walk_in'].includes(body.provider)) return inputError(c, { success: false, error: '受信媒体が正しくありません' }, 400, ["provider"]);
  if (!body.eventId?.trim()) return inputError(c, { success: false, error: 'eventId が必要です' }, 400, ["eventId"]);
  const checked = validateInboundReservation(body.reservation);
  if (!checked.ok) return inputError(c, { success: false, error: checked.error }, 400, ["reservation"]);
  const eventDbId = crypto.randomUUID();
  const inserted = await dbFor(c.env, body.storeId).prepare(`INSERT INTO rt_sync_events
    (id, store_id, provider, external_event_id, payload_json, status)
    VALUES (?, ?, ?, ?, ?, 'received') ON CONFLICT(store_id, provider, external_event_id) DO NOTHING`).bind(
      eventDbId, body.storeId, body.provider, body.eventId.trim(), JSON.stringify(body.reservation),
    ).run();
  // 処理済みだけを重複終了にする。失敗・受信中の再送は取り込み直す。
  let syncEventId = eventDbId;
  if (!inserted.meta.changes) {
    const existing = await dbFor(c.env, body.storeId).prepare(
      `SELECT id, status FROM rt_sync_events
       WHERE store_id = ? AND provider = ? AND external_event_id = ? LIMIT 1`,
    ).bind(body.storeId, body.provider, body.eventId.trim())
      .first<{ id: string; status: string }>();
    if (!existing) return c.json({ success: true, data: { duplicate: true, direction: 'inbound' } });
    if (existing.status === 'processed' || existing.status === 'duplicate') {
      return c.json({ success: true, data: { duplicate: true, direction: 'inbound' } });
    }
    syncEventId = existing.id;
    await dbFor(c.env, body.storeId).prepare(
      `UPDATE rt_sync_events SET payload_json = ?, status = 'received', error_message = NULL,
        received_at = datetime('now') WHERE id = ?`,
    ).bind(JSON.stringify(body.reservation), existing.id).run();
  }
  try {
    const value = checked.value;
    const current = await dbFor(c.env, body.storeId).prepare(
      `SELECT id, starts_at, guest_count, status, table_id, course_id, source_updated_at FROM rt_reservations
       WHERE store_id = ? AND source = ? AND external_id = ? LIMIT 1`,
    ).bind(body.storeId, body.provider, value.externalId)
      .first<{ id: string; starts_at: string; guest_count: number; status: string; table_id: string | null; course_id: string | null; source_updated_at: string | null }>();
    // 媒体側の更新時刻が古い通知は記録だけ残して反映しない。
    if (current?.source_updated_at && value.sourceUpdatedAt
      && value.sourceUpdatedAt <= current.source_updated_at) {
      await dbFor(c.env, body.storeId).prepare(
        "UPDATE rt_sync_events SET status = 'processed', processed_at = datetime('now') WHERE id = ?",
      ).bind(syncEventId).run();
      return c.json({ success: true, data: { duplicate: false, stale: true, direction: 'inbound', outboundWrites: 0 } }, 200);
    }
    if (value.tableId && value.tableId !== current?.table_id) {
      const table = await dbFor(c.env, body.storeId).prepare('SELECT id FROM rt_tables WHERE id = ? AND store_id = ? AND is_active = 1')
        .bind(value.tableId, body.storeId).first();
      if (!table) {
        await dbFor(c.env, body.storeId).prepare("UPDATE rt_sync_events SET status = 'failed', error_message = ? WHERE id = ?")
          .bind('停止中の卓は選べません', syncEventId).run();
        return inputError(c, { success: false, error: '停止中の卓は選べません' }, 400, ["reservation","storeId"]);
      }
    }
    if (value.courseId && value.courseId !== current?.course_id) {
      const course = await dbFor(c.env, body.storeId).prepare("SELECT id FROM rt_menu_items WHERE id = ? AND store_id = ? AND status = 'active'")
        .bind(value.courseId, body.storeId).first();
      if (!course) {
        await dbFor(c.env, body.storeId).prepare("UPDATE rt_sync_events SET status = 'failed', error_message = ? WHERE id = ?")
          .bind('停止中のコースは選べません', syncEventId).run();
        return inputError(c, { success: false, error: '停止中のコースは選べません' }, 400, ["reservation","storeId"]);
      }
    }
    // 同じ卓に重なる有効予約があれば取り込まない（自分自身の更新は除く）。
    if (value.tableId && await overlappingReservationExists(
      dbFor(c.env, body.storeId), body.storeId, value.tableId, value.startsAt, value.endsAt, current?.id ?? null, c.env,
    )) {
      throw new Error('同じ卓に重なる時間の予約があります');
    }
    const id = crypto.randomUUID();
    await dbFor(c.env, body.storeId).prepare(`INSERT INTO rt_reservations
      (id, store_id, source, external_id, hub_source, customer_name, customer_phone, line_uid, guest_count, starts_at, ends_at, table_id, course_id, status, allergy_note, note, source_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(store_id, source, external_id) DO UPDATE SET confirmation_revision = rt_reservations.confirmation_revision + 1,
        customer_name = excluded.customer_name, customer_phone = excluded.customer_phone,
        line_uid = excluded.line_uid, guest_count = excluded.guest_count, starts_at = excluded.starts_at,
        ends_at = excluded.ends_at, table_id = excluded.table_id, course_id = excluded.course_id,
        status = excluded.status, allergy_note = excluded.allergy_note, note = excluded.note,
        source_updated_at = excluded.source_updated_at, updated_at = datetime('now')`).bind(
          id, body.storeId, body.provider, value.externalId,
          body.provider === 'restaurant_board' || body.provider === 'reszaiko' ? body.provider : null,
          value.customerName, value.customerPhone, value.lineUid, value.guestCount, value.startsAt, value.endsAt,
          value.tableId, value.courseId, value.status, value.allergyNote, value.note, value.sourceUpdatedAt,
        ).run();
    // 時間帯在庫の予約済数を人数分だけ動かす（更新時は差分・枠移動を調整）。
    await applyReservationInventoryChange(
      dbFor(c.env, body.storeId), body.storeId,
      current ? { starts_at: current.starts_at, guest_count: current.guest_count, status: current.status } : null,
      { starts_at: value.startsAt, guest_count: value.guestCount, status: value.status ?? 'confirmed' },
    );
    await dbFor(c.env, body.storeId).prepare("UPDATE rt_sync_events SET status = 'processed', processed_at = datetime('now') WHERE id = ?").bind(syncEventId).run();
    return c.json({ success: true, data: { duplicate: false, direction: 'inbound', outboundWrites: 0 } }, 201);
  } catch (error) {
    await dbFor(c.env, body.storeId).prepare("UPDATE rt_sync_events SET status = 'failed', error_message = ? WHERE id = ?").bind(error instanceof Error ? error.message.slice(0, 500) : 'unknown', syncEventId).run();
    throw error;
  }
};
