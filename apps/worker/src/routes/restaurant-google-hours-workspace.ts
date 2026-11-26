import { Hono } from 'hono';
import type { Context } from 'hono';
import { getVersionedAccountSetting, saveVersionedAccountSetting } from '@line-crm/db';
import { emptyHoursWorkspace, HOURS_WEEKDAYS, HOURS_SERVICE_LABELS, hoursPeriodsProblem, validHoursDate, type HoursWorkspace, type HoursWorkspaceEvent } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { inputJsonBoundary } from '../lib/input-errors.js';
import { auditLog } from '../lib/audit-log.js';
import { requireRole } from '../middleware/role-guard.js';
import { dbFor } from '../services/db-router.js';
import { upcomingHolidays } from '../services/jp-holidays.js';
import { getMoreHoursTypes, todayIn, type GoogleProfile } from '../services/google-business-profile.js';
import { tracedFetch } from '@line-crm/shared/server';
import { hoursWorkspaceEvent } from '../services/google-hours-history.js';
import { GoogleBusinessError } from '../services/google-business.js';
import { accessTokenFor, connectionFor, fail, requestedConnectionId, requireConnectedStore, storeFor, type StoreContext } from './restaurant-google.js';
import { PROFILE_FOR_CONNECTION_SQL } from '../services/google-connection-primary.js';

type StoredWorkspace = { workspace: HoursWorkspace; history: HoursWorkspaceEvent[] };
const keyFor = (store: StoreContext) => `google.hours.${store.id}`;
export async function readHoursWorkspace(c: Context<Env>, store: StoreContext) {
  const saved = await getVersionedAccountSetting<StoredWorkspace>(dbFor(c.env, store.id), store.lineAccountId, keyFor(store));
  return { version: saved?.version ?? 0, data: saved?.data.workspace ?? emptyHoursWorkspace(), history: saved?.data.history ?? [] };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max; }
function periods(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 3) return false;
  if (!value.every(p => isRecord(p) && typeof p.open === 'string' && typeof p.close === 'string')) return false;
  return hoursPeriodsProblem(value) === null;
}
export function validateHoursWorkspace(value: unknown, today: string): value is HoursWorkspace {
  if (!isRecord(value) || !isRecord(value.holiday) || !isRecord(value.notes) || !isRecord(value.draft) || !Array.isArray(value.services)) return false;
  const { holiday, notes, draft, services } = value;
  if (value.holidayManagedDates !== undefined && (!Array.isArray(value.holidayManagedDates) || value.holidayManagedDates.length > 367 || !value.holidayManagedDates.every(d => typeof d === 'string' && validHoursDate(d)))) return false;
  if (!['weekly', 'custom', 'closed'].includes(String(holiday.mode)) || !periods(holiday.periods) || typeof holiday.overrideClosedWeekday !== 'boolean' || (holiday.mode === 'custom' && !(holiday.periods as unknown[]).length)) return false;
  if (Object.keys(notes).length > 367 || !Object.entries(notes).every(([d, note]) => validHoursDate(d) && text(note, 200))) return false;
  if (draft.weekly !== null && (!isRecord(draft.weekly) || !HOURS_WEEKDAYS.every(d => periods((draft.weekly as Record<string, unknown>)[d])))) return false;
  if (!Array.isArray(draft.days) || draft.days.length > 367 || !draft.days.every(d => isRecord(d) && text(d.date, 10) && validHoursDate(d.date) && d.date >= today && typeof d.closed === 'boolean' && periods(d.periods) && (d.closed || d.remove === true || (d.periods as unknown[]).length > 0) && (d.remove === undefined || typeof d.remove === 'boolean'))) return false;
  if (new Set(draft.days.map(d => d.date)).size !== draft.days.length) return false;
  if (typeof draft.holidayChanged !== 'boolean' || !Array.isArray(draft.serviceIds) || draft.serviceIds.length > 12 || !draft.serviceIds.every(id => text(id, 100)) || !Array.isArray(draft.reviewIds) || draft.reviewIds.length > 12 || !draft.reviewIds.every(id => text(id, 100))) return false;
  if (services.length > 12 || !services.every(s => isRecord(s) && text(s.id, 100) && s.id.length > 0 && typeof s.kind === 'string' && s.kind in HOURS_SERVICE_LABELS && text(s.label, 80) && (s.googleTypeId === null || text(s.googleTypeId, 100)) && typeof s.sameWeekdays === 'boolean' && Array.isArray(s.weekdays) && s.weekdays.every(d => HOURS_WEEKDAYS.includes(d)) && s.weekdays.length <= 7 && periods(s.periods) && (s.periods as unknown[]).length > 0 && text(s.orderDeadline, 5) && (s.orderDeadline === '' || /^([01]\d|2[0-3]):(00|15|30|45)$/.test(s.orderDeadline)) && text(s.menu, 120))) return false;
  return new Set(services.map(s => s.id)).size === services.length;
}

export const restaurantGoogleHoursWorkspace = new Hono<Env>();
restaurantGoogleHoursWorkspace.get('/api/restaurant-test/google/hours/workspace', async c => {
  const store = await storeFor(c);
  if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
  const row = await dbFor(c.env, store.id).prepare('SELECT timezone FROM rt_stores WHERE id = ?').bind(store.id).first<{ timezone: string | null }>();
  const today = todayIn(row?.timezone || 'Asia/Tokyo');
  // 写しは「どの接続の写しか」まで決めて読む。store_id だけで読むと、同じ店舗に接続が2件あるとき
  // 画面に出すサービス種別が別の接続の写しから混ざる。接続が無い店舗は接続に紐づかない写し
  // （connection_id IS NULL、店舗につき1行）を読むので、今までと同じ結果になる。
  const workspaceConnection = await connectionFor(c, store.id, requestedConnectionId(c));
  const cached = await dbFor(c.env, store.id)
    .prepare(`SELECT profile_json ${PROFILE_FOR_CONNECTION_SQL}`)
    .bind(store.id, workspaceConnection?.id ?? null)
    .first<{ profile_json: string }>();
  const profile = cached ? (JSON.parse(cached.profile_json) as { profile?: GoogleProfile }).profile : undefined;
  let serviceTypes = profile?.moreHoursTypes ?? [];
  if (!serviceTypes.length && profile?.categoryNames?.length) {
    const ctx = await requireConnectedStore(c);
    if (!(ctx instanceof Response)) {
      try { serviceTypes = await getMoreHoursTypes({ fetch: tracedFetch, accessToken: await accessTokenFor(c, ctx.connection) }, profile.categoryNames); }
      catch (error) { if (!(error instanceof GoogleBusinessError)) throw error; }
    }
  }
  return c.json({ success: true, ...await readHoursWorkspace(c, store), holidays: upcomingHolidays(today, 366), serviceTypes });
});
restaurantGoogleHoursWorkspace.put('/api/restaurant-test/google/hours/workspace', requireRole('owner', 'admin'), inputJsonBoundary(), async c => {
  const store = await storeFor(c);
  if (!store) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
  const body: unknown = await c.req.json();
  if (!isRecord(body) || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0 || !validateHoursWorkspace(body.data, '2000-01-01')) return fail(c, 400, '営業時間の入力内容を確認してください', {}, ['data']);
  const previous = await readHoursWorkspace(c, store);
  const history = [...previous.history];
  let sent = false;
  const ids = previous.data.draft.reviewIds;
  if (ids.length && body.data.draft.reviewIds.length === 0 && body.data.draft.days.length === 0 && body.data.draft.weekly === null && !body.data.draft.holidayChanged && body.data.draft.serviceIds.length === 0) {
    const records = await dbFor(c.env, store.id).prepare(`SELECT id, status FROM rt_google_changes WHERE store_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(store.id, ...ids).all<{ id: string; status: string }>();
    sent = records.results.length === ids.length && records.results.every(row => ['accepted','applied'].includes(row.status));
  }
  const event = hoursWorkspaceEvent(previous.data, body.data, sent);
  if (event) history.unshift({ at: new Date().toISOString(), staffName: c.get('staff')?.name ?? '', ...event });
  const saved = await saveVersionedAccountSetting(dbFor(c.env, store.id), { accountId: store.lineAccountId, key: keyFor(store), expectedVersion: Number(body.expectedVersion), data: { workspace: body.data, history: history.slice(0, 50) } });
  if (saved.status === 'conflict') return fail(c, 409, 'ほかの担当者が営業時間を変更しました。再読み込みして確認してください。', { code: 'version_conflict' });
  auditLog(c, 'restaurant.google.hours.save', { id: store.id, kind: 'rt_store' }, { lineAccountId: store.lineAccountId });
  return c.json({ success: true, version: saved.setting.version, data: saved.setting.data.workspace, history: saved.setting.data.history });
});
