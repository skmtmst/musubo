import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { inputError, inputJsonBoundary } from '../../lib/input-errors.js';
import { getBookingSyncRules, saveBookingSyncRules, validateBookingSyncRules, listBookingSyncNotices } from '@line-crm/db';
import { createBookingAvailabilityException, getBookingAdminSettings, saveBookingAdminSettings, listBookingAdminResources, getBookingAvailabilityException, listBookingAvailabilityExceptions, updateBookingAvailabilityException, deleteBookingAvailabilityException, createBookingResource, deleteBookingResourceSafely, updateBookingResourceSafely } from '@line-crm/db';
import { BOOKING_SETTINGS_KEY } from '@line-crm/shared';
import { requireRole, requirePermission } from '../../middleware/role-guard.js';
import { saveBookingAutoAssign, getBookingChannels, EXTERNAL_BOOKING_CHANNELS, getBookingChannelSetting, saveBookingChannelSetting, listBookingConflicts } from '../../features/booking/booking-channels/index.js';
import { assignmentSettingsResponse } from '../booking-assignment-settings.js';
import { resolveAccountIdAdmin } from './identity.js';
import { googleCredentials } from './availability.js';
import { readBookingAdminSettings, readBookingResourceInput, readBookingException } from './settings-input.js';
import { accountOpeningHours, openingWeek } from '../../services/account-opening-hours.js';

async function withOpeningHours(db: D1Database, accountId: string, settings: NonNullable<Awaited<ReturnType<typeof getBookingAdminSettings>>>) {
  const state = await accountOpeningHours(db, accountId);
  const googleWeek = openingWeek(state);
  const businessHours = googleWeek?.map(day => ({
    weekday: day.weekday,
    intervals: day.intervals.map(interval => ({
      ...interval,
      capacity: settings.businessHours.find(local => local.weekday === day.weekday)?.intervals[0]?.capacity ?? 1,
    })),
  })) ?? settings.businessHours;
  return { ...settings, businessHours, businessHoursConfigured: state.source === 'google_business' || (state.source === 'manual' && settings.businessHoursConfigured), openingHoursSource: state.source };
}

export function registerSettings(booking: Hono<Env>): void {
booking.get('/api/booking/admin/channels', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: await getBookingChannels(c.env.DB, accountId, googleCredentials(c.env)) });
});

booking.put('/api/booking/admin/channels/settings', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ["account_id"]);
  const body = await c.req.json<{ autoAssign?: unknown }>().catch(() => null);
  if (!body || typeof body.autoAssign !== 'boolean') return inputError(c, { error: 'invalid_auto_assign' }, 400, ["autoAssign"]);
  await saveBookingAutoAssign(c.env.DB, accountId, body.autoAssign);
  return c.json({ success: true, data: { autoAssign: body.autoAssign } });
});

booking.put('/api/booking/admin/channels/:channel/settings', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ['account_id']);
  const channel = EXTERNAL_BOOKING_CHANNELS.find((key) => key === c.req.param('channel'));
  if (!channel) return c.json({ success: false, error: 'channel_not_found' }, 404);
  const body = await c.req.json<{ enabled?: unknown; expectedVersion?: unknown }>().catch(() => null);
  if (!body || typeof body.enabled !== 'boolean' || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
    return inputError(c, { success: false, error: '連携の状態と読み込んだ版を確認してください' }, 400, ['enabled', 'expectedVersion']);
  }
  if (!await saveBookingChannelSetting(c.env.DB, accountId, channel, body.enabled, Number(body.expectedVersion))) {
    return c.json({ success: false, error: '設定が更新されました。読み直してください' }, 409);
  }
  return c.json({ success: true, data: await getBookingChannelSetting(c.env.DB, accountId, channel) });
});

booking.get('/api/booking/admin/conflicts', requireRole('owner', 'admin', 'staff'), requirePermission('/booking/bookings'), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, data: { conflicts: await listBookingConflicts(c.env.DB, accountId), notifyConflicts:(await getBookingSyncRules(c.env.DB,accountId)).notifyConflicts } });
});

booking.get('/api/booking/admin/sync-rules',async c=>{
  const accountId=await resolveAccountIdAdmin(c);if(!accountId)return c.json({error:'missing_account_id'},400);
  c.header('Cache-Control','no-store');
  return c.json({success:true,data:await getBookingSyncRules(c.env.DB,accountId)});
});

booking.put('/api/booking/admin/sync-rules',requirePermission(BOOKING_SETTINGS_KEY),inputJsonBoundary(), async c=>{
  const accountId=await resolveAccountIdAdmin(c);if(!accountId)return inputError(c, {error:'missing_account_id'}, 400, ["account_id"]);
  const body=await c.req.json().catch(()=>null);
  if(!validateBookingSyncRules(body))return inputError(c, {success:false,error:'ルールと読み込んだ版を確認してください'}, 400, ['autoAssign', 'notifyConflicts', 'notifyCalendarDisconnected', 'notifyDailyLimit', 'excludeCalendarBusy', 'writeLineBookingsToCalendar', 'dailyLimit', 'nearLimitRemaining', 'expectedVersion']);
  if(!await saveBookingSyncRules(c.env.DB,accountId,body))return c.json({success:false,error:'ほかの担当者が先に保存しました',currentVersion:(await getBookingSyncRules(c.env.DB,accountId)).version},409);
  return c.json({success:true,data:await getBookingSyncRules(c.env.DB,accountId)});
});

booking.get('/api/booking/admin/sync-notices',async c=>{
  const accountId=await resolveAccountIdAdmin(c);if(!accountId)return c.json({error:'missing_account_id'},400);
  c.header('Cache-Control','no-store');
  return c.json({success:true,data:await listBookingSyncNotices(c.env.DB,accountId)});
});

booking.post('/api/booking/admin/sync-notices/:id/done',requireRole('owner','admin','staff'),inputJsonBoundary(), async c=>{
  const accountId=await resolveAccountIdAdmin(c);if(!accountId)return inputError(c, {error:'missing_account_id'}, 400, ["account_id"]);
  const notice=await c.env.DB.prepare('SELECT status FROM booking_sync_notices WHERE id=? AND line_account_id=?').bind(c.req.param('id'),accountId).first<{status:string}>();
  if(!notice)return c.json({success:false,error:'知らせがありません'},404);
  if(notice.status==='resolved')return c.json({success:false,error:'すでに条件が解消した知らせです'},409);
  await c.env.DB.prepare("UPDATE booking_sync_notices SET status='done',updated_at=datetime('now') WHERE id=? AND line_account_id=? AND status='open'").bind(c.req.param('id'),accountId).run();
  return c.json({success:true,data:{id:c.req.param('id'),status:'done'}});
});

booking.get('/api/booking/admin/assignment-settings', async c => {
  const id = await resolveAccountIdAdmin(c);
  if (!id) return c.json({ success: false, error: 'missing_account_id' }, 400);
  return assignmentSettingsResponse(c, c.env.DB, { kind: 'staff', id });
});

booking.put('/api/booking/admin/assignment-settings', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async c => {
  const id = await resolveAccountIdAdmin(c);
  if (!id) return inputError(c, { success: false, error: 'missing_account_id' }, 400, ['account_id']);
  return assignmentSettingsResponse(c, c.env.DB, { kind: 'staff', id });
});

booking.get('/api/booking/admin/settings', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ success: false, error: 'missing_account_id' }, 400);
  try {
    const settings = await getBookingAdminSettings(c.env.DB, accountId);
    if (!settings) return c.json({ success: false, error: 'not_found' }, 404);
    return c.json({ success: true, data: await withOpeningHours(c.env.DB, accountId, settings) });
  } catch {
    logger.error("booking.read_settings_failed");
    return c.json({ success: false, error: 'booking_settings_unavailable' }, 503);
  }
});

booking.put('/api/booking/admin/settings', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { success: false, error: 'missing_account_id' }, 400, ["account_id"]);
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return inputError(c, { success: false, error: 'invalid_json' }, 400, []);
    const parsed = readBookingAdminSettings(body);
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, 400, ["expectedVersion","timeZone","bookingWindowDays","cutoffMinutesBefore","cancelDeadlineMinutesBefore","maxActiveBookingsPerFriend","approvalMode","holdMinutes","waitlistHoldMinutes","slotGranularityMinutes","businessHours","reminderDayBeforeTime","reminderHoursBefore","liffDateView"]);
    if (parsed.value.businessHours !== undefined && (await accountOpeningHours(c.env.DB, accountId)).source !== 'manual') {
      return c.json({ success: false, error: '営業時間はGoogleビジネスで変更してください' }, 409);
    }
    /*
     * 同時編集の見分けは「最後に直した日時で比べる」。
     * expectedUpdatedAt が送られてきたときだけ、保存前の値と照合する。
     * 違えば409で止めて今の中身を返す。送らなければ従来どおり通す。
     */
    const expectedSettingsUpdatedAt = typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : null;
    if (expectedSettingsUpdatedAt !== null) {
      const currentSettings = await getBookingAdminSettings(c.env.DB, accountId);
      if (currentSettings && currentSettings.updatedAt !== expectedSettingsUpdatedAt) {
        return c.json({
          success: false,
          code: 'VERSION_CONFLICT',
          error: '予約の設定が更新されています。読み直してください',
          data: { latest: currentSettings },
        }, 409);
      }
    }
    const result = await saveBookingAdminSettings(c.env.DB, {
      lineAccountId: accountId,
      ...parsed.value,
    });
    if (result.status === 'not_found') {
      return c.json({ success: false, error: 'not_found' }, 404);
    }
    if (result.status === 'conflict') {
      return c.json({
        success: false,
        code: 'version_conflict',
        error: '予約の基本ルールが更新されています。読み直してください',
        data: { currentVersion: result.currentVersion },
      }, 409);
    }
    return c.json(
      { success: true, data: await withOpeningHours(c.env.DB, accountId, result.item) },
      result.status === 'created' ? 201 : 200,
    );
  } catch {
    logger.error("booking_settings_save_failed");
    return c.json({ success: false, error: 'booking_settings_save_failed' }, 503);
  }
});

booking.get('/api/booking/admin/resources', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ success: false, error: 'missing_account_id' }, 400);
  try {
    const resources = await listBookingAdminResources(c.env.DB, accountId);
    return c.json({ success: true, data: { resources } });
  } catch {
    logger.error("booking.read_resources_failed");
    return c.json({ success: false, error: 'booking_resources_unavailable' }, 503);
  }
});

booking.post('/api/booking/admin/resources', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { success: false, error: 'missing_account_id' }, 400, ["account_id"]);
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return inputError(c, { success: false, error: 'invalid_json' }, 400, []);
    const parsed = readBookingResourceInput(body);
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, 400, ["name","type","capacity","isActive"]);
    const created = await createBookingResource(c.env.DB, { lineAccountId: accountId, ...parsed.value });
    const item = {
      ...created,
      businessHours: [],
      exceptions: [],
      usage: { menuCount: 0, bookingCount: 0, exceptionCount: 0, referenced: false },
    };
    return c.json({ success: true, data: item }, 201);
  } catch {
    logger.error("booking_resource_create_failed");
    return c.json({ success: false, error: 'booking_resource_save_failed' }, 503);
  }
});

booking.patch('/api/booking/admin/resources/:id', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { success: false, error: 'missing_account_id' }, 400, ["account_id"]);
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = body?.expectedVersion;
    if (!body || !Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) {
      return inputError(c, { success: false, error: 'expectedVersionは1以上の整数で指定してください' }, 400, ["expectedVersion"]);
    }
    const current = (await listBookingAdminResources(c.env.DB, accountId))
      .find((resource) => resource.id === c.req.param('id'));
    if (!current) return c.json({ success: false, error: 'not_found' }, 404);
    const parsed = readBookingResourceInput(body, current, 'update');
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, 400, ["name","type","capacity","isActive"]);
    const result = await updateBookingResourceSafely(c.env.DB, {
      lineAccountId: accountId,
      resourceId: current.id,
      expectedVersion: Number(expectedVersion),
      ...parsed.value,
    });
    if (result.status === 'not_found') return c.json({ success: false, error: 'not_found' }, 404);
    if (result.status === 'version_conflict') {
      return c.json({
        success: false, code: 'version_conflict',
        error: '設備が更新されています。読み直してください',
        data: { currentVersion: result.currentVersion },
      }, 409);
    }
    if (result.status === 'capacity_conflict') {
      return c.json({
        success: false, code: 'capacity_conflict',
        error: `今後の予約で最大${result.peakQuantity}枠を使用するため、この数には減らせません`,
        data: { peakQuantity: result.peakQuantity },
      }, 409);
    }
    if (result.status === 'assignment_conflict') {
      return c.json({
        success: false, code: 'assignment_conflict',
        error: `メニューで最大${result.requiredQuantity}個を必要としているため、先にメニューの設備割当を変更してください`,
        data: { requiredQuantity: result.requiredQuantity },
      }, 409);
    }
    if (!result.item) throw new Error('booking_resource_update_missing_result');
    const item = {
      ...result.item,
      businessHours: current.businessHours,
      exceptions: current.exceptions,
      usage: current.usage,
    };
    return c.json({ success: true, data: item });
  } catch {
    logger.error("booking.update_resource_failed");
    return c.json({ success: false, error: 'booking_resource_save_failed' }, 503);
  }
});

booking.delete('/api/booking/admin/resources/:id', requirePermission(BOOKING_SETTINGS_KEY), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ success: false, error: 'missing_account_id' }, 400);
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = body?.expectedVersion;
    if (!body || Object.keys(body).some((key) => key !== 'expectedVersion')
      || !Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) {
      return c.json({ success: false, error: 'expectedVersionは1以上の整数で指定してください' }, 400);
    }
    const result = await deleteBookingResourceSafely(c.env.DB, {
      lineAccountId: accountId, resourceId: c.req.param('id'), expectedVersion: Number(expectedVersion),
    });
    if (result.status === 'not_found') return c.json({ success: false, error: 'not_found' }, 404);
    if (result.status === 'version_conflict') {
      return c.json({
        success: false, code: 'version_conflict', error: '設備が更新されています。読み直してください',
        data: { currentVersion: result.currentVersion },
      }, 409);
    }
    if (result.status === 'reference_conflict') {
      return c.json({
        success: false, code: 'resource_in_use',
        error: '予約やメニューで使われている設備は削除できません。停止してください',
        data: result,
      }, 409);
    }
    return c.json({ success: true, data: { id: c.req.param('id') } });
  } catch {
    logger.error("booking_resource_delete_failed");
    return c.json({ success: false, error: 'booking_resource_delete_failed' }, 503);
  }
});

booking.get('/api/booking/admin/exceptions', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ success: false, error: 'missing_account_id' }, 400);
  try {
    const items = await listBookingAvailabilityExceptions(c.env.DB, accountId);
    return c.json({ success: true, data: { items } });
  } catch {
    logger.error("booking.read_exceptions_failed");
    return c.json({ success: false, error: 'booking_exceptions_unavailable' }, 503);
  }
});

booking.post('/api/booking/admin/exceptions', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { success: false, error: 'missing_account_id' }, 400, ["account_id"]);
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return inputError(c, { success: false, error: 'invalid_json' }, 400, []);
    const parsed = readBookingException(body);
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, 400, ["scopeKind","kind","dateFrom","dateTo","scopeId","reason","intervals"]);
    const item = await createBookingAvailabilityException(c.env.DB, {
      lineAccountId: accountId,
      ...parsed.value,
    });
    if (!item) return inputError(c, { success: false, error: 'scope_not_found' }, 422, ["scopeKind","kind","dateFrom","dateTo","scopeId","reason","intervals"]);
    return c.json({ success: true, data: item }, 201);
  } catch {
    logger.error("booking.create_exception_failed");
    return c.json({ success: false, error: 'booking_exception_save_failed' }, 503);
  }
});

booking.patch('/api/booking/admin/exceptions/:id', requirePermission(BOOKING_SETTINGS_KEY), inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return inputError(c, { success: false, error: 'missing_account_id' }, 400, ["account_id"]);
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = Number(body?.expectedVersion);
    if (!body || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return inputError(c, { success: false, error: 'expectedVersionは1以上の整数で指定してください' }, 400, ["expectedVersion"]);
    }
    const current = await getBookingAvailabilityException(c.env.DB, c.req.param('id'), accountId);
    if (!current) return c.json({ success: false, error: 'not_found' }, 404);
    const parsed = readBookingException({
      scopeKind: body.scopeKind ?? current.scopeKind,
      scopeId: Object.prototype.hasOwnProperty.call(body, 'scopeId') ? body.scopeId : current.scopeId,
      dateFrom: body.dateFrom ?? current.dateFrom,
      dateTo: body.dateTo ?? current.dateTo,
      kind: body.kind ?? current.kind,
      intervals: body.intervals ?? current.intervals,
      reason: Object.prototype.hasOwnProperty.call(body, 'reason') ? body.reason : current.reason,
    });
    if (!parsed.ok) return inputError(c, { success: false, error: parsed.error }, 400, ["scopeKind","scopeId","dateFrom","dateTo","kind","intervals","reason"]);
    const result = await updateBookingAvailabilityException(c.env.DB, {
      id: current.id,
      lineAccountId: accountId,
      expectedVersion,
      ...parsed.value,
    });
    if (result.status === 'not_found') return c.json({ success: false, error: 'not_found' }, 404);
    if (result.status === 'scope_not_found') {
      return inputError(c, { success: false, error: 'scope_not_found' }, 422, ["scopeKind","scopeId","dateFrom","dateTo","kind","intervals","reason"]);
    }
    if (result.status === 'conflict') {
      return c.json({
        success: false,
        code: 'version_conflict',
        error: '例外日が更新されています。読み直してください',
        data: { currentVersion: result.currentVersion },
      }, 409);
    }
    return c.json({ success: true, data: result.item });
  } catch {
    logger.error("booking.update_exception_failed");
    return c.json({ success: false, error: 'booking_exception_save_failed' }, 503);
  }
});

/**
 * 例外日の削除。登録だけできて画面から消せない状態を解消する。
 * 消す直前の版を expectedVersion で確認し、読み違えたまま別の版を
 * 消さないようにする。別アカウントのIDは not_found として隠す。
 */
booking.delete('/api/booking/admin/exceptions/:id', requirePermission(BOOKING_SETTINGS_KEY), async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ success: false, error: 'missing_account_id' }, 400);
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    const expectedVersion = Number(body?.expectedVersion);
    if (!body || Object.keys(body).some((key) => key !== 'expectedVersion')
      || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return c.json({ success: false, error: 'expectedVersionは1以上の整数で指定してください' }, 400);
    }
    const result = await deleteBookingAvailabilityException(c.env.DB, {
      id: c.req.param('id'),
      lineAccountId: accountId,
      expectedVersion,
    });
    if (result.status === 'not_found') return c.json({ success: false, error: 'not_found' }, 404);
    if (result.status === 'conflict') {
      return c.json({
        success: false,
        code: 'version_conflict',
        error: '例外日が更新されています。読み直してください',
        data: { currentVersion: result.currentVersion },
      }, 409);
    }
    return c.json({ success: true, data: { id: c.req.param('id') } });
  } catch {
    logger.error("booking_exception_delete_failed");
    return c.json({ success: false, error: 'booking_exception_delete_failed' }, 503);
  }
});
}
