import { readRestaurantReservationFormHealth } from '../services/restaurant-reservation-form.js';
import type { Hono } from 'hono';
import type { RestaurantBookingExposure, RestaurantSetupProgress } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { readRestaurantFollowupSetupProgress } from '../services/restaurant-followup-preferences.js';
import { dbFor } from '../services/db-router.js';
import { tzDateStr } from '../services/availability.js';
import { customerAvailability, type CustomerStore } from '../services/restaurant-customer-booking.js';
import { connectedGoogleProfile, googleOpeningDay, googleOpeningWeek } from '../services/restaurant-google-hours-source.js';
import { readInventoryAllocation } from '../services/restaurant-inventory-allocation.js';
import { scheduledInventoryWindows } from '../services/restaurant-inventory-schedule.js';
import { restaurantReservationEmbed } from '../services/restaurant-media-links.js';
import { accountId, authenticatedTenantId, hasOrganizationSelector, organizationFor, requiredAccount, storeBelongsTo } from './restaurant-test-definition.js';

function matchesReservationLink(value: string, expected: URL): boolean {
  try {
    const url = new URL(value);
    return url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password
      && !url.searchParams.has('view')
      && ['page', 'token'].every(key => url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === expected.searchParams.get(key));
  } catch {
    return false;
  }
}

async function readBookingExposure(
  db: D1Database, store: CustomerStore, liffId: string | null, token: string | null,
  dates: readonly string[], guestCount: number | null,
): Promise<RestaurantBookingExposure> {
  if (!liffId || !token) return { reservationLink: false, publicReservationMenu: false, availableCapacity: false };

  async function hasAvailability() {
    if (!guestCount) return false;
    for (const date of dates) {
      const availability = await customerAvailability(db, store, date, guestCount);
      if (availability?.data.slots.some(slot => slot.available)) return true;
    }
    return false;
  }
  const expected = new URL(restaurantReservationEmbed(liffId, token).url);
  const [buttons, availableCapacity] = await Promise.all([
    db.prepare(`SELECT a.action_data FROM rich_menu_groups g
       JOIN rich_menu_pages p ON p.id=g.default_page_id AND p.group_id=g.id
       JOIN rich_menu_areas a ON a.page_id=p.id AND a.action_type='uri'
       WHERE g.account_id=? AND g.status='published' AND g.is_default_for_all=1
         AND length(trim(COALESCE(p.line_richmenu_id,'')))>0
         AND NOT EXISTS(SELECT 1 FROM rich_menu_groups other WHERE other.account_id=g.account_id
           AND other.id<>g.id AND other.status='published' AND other.is_default_for_all=1)`)
      .bind(store.line_account_id).all<{ action_data: string }>(),
    hasAvailability(),
  ]);
  return {
    reservationLink: true,
    publicReservationMenu: buttons.results.some(button => matchesReservationLink(button.action_data, expected)),
    availableCapacity,
  };
}

/** 一覧の上限や満席に左右されず、選択店舗の設定の実物だけを読む。書込・送信をしない。 */
export function registerRestaurantSetupProgressRoutes(routes: Hono<Env>) {
  routes.get('/api/restaurant-test/setup-progress', requireRole('owner', 'admin', 'staff'), async (c) => {
    if (!hasOrganizationSelector(c)) return requiredAccount(c);
    const organization = await organizationFor(c);
    const storeId = c.req.query('storeId') || organization?.scopedStoreId;
    if (!organization || !storeId || (organization.scopedStoreId && organization.scopedStoreId !== storeId) || !await storeBelongsTo(c, organization.id, storeId))
      return c.json({ success: false, error: '店舗が見つかりません' }, 404);
    const db = dbFor(c.env, storeId);
    const selectedAccount = accountId(c);
    const row = await db.prepare(`SELECT s.id,s.name,s.timezone,s.line_account_id,
      EXISTS(SELECT 1 FROM rt_tables t WHERE t.store_id=s.id AND t.is_active=1 AND t.max_capacity>0) AS tables_ready,
      (SELECT MIN(MAX(t.min_capacity,1)) FROM rt_tables t WHERE t.store_id=s.id AND t.is_active=1 AND t.max_capacity>0) AS minimum_guest_count,
      (SELECT h.hours_json FROM rt_opening_hours_settings h WHERE h.store_id=s.id) AS hours_json,
      (SELECT NULLIF(trim(a.liff_id),'') FROM line_accounts a WHERE a.id=s.line_account_id AND a.is_active=1 AND a.archived_at IS NULL) AS liff_id,
      (SELECT l.token FROM rt_reservation_links l WHERE l.store_id=s.id) AS reservation_token,
      (SELECT i.starts_at FROM rt_inventory_slots i WHERE i.store_id=s.id
        AND julianday(i.starts_at)>julianday('now') AND i.total_capacity>0 AND i.line_capacity>0
        ORDER BY julianday(i.starts_at) LIMIT 1) AS next_line_slot_at,
      EXISTS(SELECT 1 FROM rt_menu_items m WHERE m.store_id=s.id AND m.status='active') AS menus_ready,
      EXISTS(SELECT 1 FROM rt_menu_items m WHERE m.store_id=s.id AND m.kind='course' AND m.status='draft'
        AND length(trim(m.name))>0 AND typeof(m.price)='integer' AND m.price>=0
        AND typeof(m.duration_minutes)='integer' AND m.duration_minutes BETWEEN 15 AND 600) AS course_draft_registered,
      EXISTS(SELECT 1 FROM rt_inventory_slots i WHERE i.store_id=s.id
        AND julianday(i.starts_at)>julianday('now') AND i.total_capacity>0
        AND COALESCE(i.auto_line_original,i.line_capacity)>0) AS line_capacity_configured,
      EXISTS(SELECT 1 FROM rt_store_followup_templates f WHERE f.store_id=s.id AND f.sending_status='active'
        AND EXISTS(SELECT 1 FROM rt_store_followup_step_bindings b WHERE b.store_id=s.id AND b.enabled=1)) AS followup_ready
      FROM rt_stores s WHERE s.id=? AND s.organization_id=? AND s.status='active' AND (? IS NULL OR s.line_account_id=?)`)
      .bind(storeId, organization.id, selectedAccount, selectedAccount).first<{
        id: string; name: string; timezone: string; line_account_id: string | null; tables_ready: number; hours_json: string | null;
        liff_id: string | null; reservation_token: string | null; next_line_slot_at: string | null; minimum_guest_count: number | null;
        menus_ready: number; course_draft_registered: number; line_capacity_configured: number; followup_ready: number;
      }>();
    if (!row) return c.json({ success: false, error: '店舗が見つかりません' }, 404);
    // JSON不正は想定外のエラーとして共通の報告経路へ渡す。空配列だけが未設定。
    const hours: unknown = row.hours_json === null ? [] : JSON.parse(row.hours_json);
    const [profile, allocation] = await Promise.all([connectedGoogleProfile(db, storeId), readInventoryAllocation(db, storeId)]);
    const googleWeek = profile ? googleOpeningWeek(profile) : null;
    const hoursReady = Boolean(googleWeek?.some(day => day.periods.length > 0));
    const bookingHoursReady = Array.isArray(hours) && hours.some(day => day && Array.isArray(day.periods)
      && day.periods.some((period: { opensAt?: string; closesAt?: string }) => /^\d{2}:\d{2}$/.test(period.opensAt ?? '')
        && /^\d{2}:\d{2}$/.test(period.closesAt ?? '') && period.opensAt !== period.closesAt));
    const lineConfigured = allocation.standard === null ? Boolean(row.line_capacity_configured) : allocation.standard.lineCapacity > 0;
    const reception = Boolean(row.tables_ready && hoursReady && bookingHoursReady && row.liff_id && lineConfigured);
    const lineAccountId = row.line_account_id;
    const bookingStore = lineAccountId ? {
      id: row.id, name: row.name, timezone: row.timezone, line_account_id: lineAccountId, tenant_id: authenticatedTenantId(c),
    } : null;
    // 行き先と空席の照合は任意の追加情報。読めなくても設定済みの判定を保つ。
    const now = new Date();
    const today = tzDateStr(row.timezone, now);
    let dates: string[] = [];
    if (reception && profile && allocation.standard) {
      const schedule = scheduledInventoryWindows(today, row.timezone, day => googleOpeningDay(profile, day), [-1,0,1,2,3,4,5,6,7]);
      dates = [...new Set(schedule.filter(window => Date.parse(window.startsAt) > now.getTime()).map(window => window.date))];
    } else if (reception && row.next_line_slot_at) {
      dates = [tzDateStr(row.timezone, new Date(row.next_line_slot_at))];
    }
    const [followupSetup, reservationForm, bookingExposure] = await Promise.all([
      readRestaurantFollowupSetupProgress(db, storeId),
      lineAccountId ? readRestaurantReservationFormHealth(db, storeId, lineAccountId) : null,
      bookingStore ? readBookingExposure(db, bookingStore, row.liff_id, row.reservation_token, dates, row.minimum_guest_count).catch(() => undefined) : null,
    ]);
    const data: RestaurantSetupProgress = {
      storeId: row.id, lineAccountId, tables: Boolean(row.tables_ready), hours: hoursReady, menus: Boolean(row.menus_ready),
      courseRegistered: Boolean(row.menus_ready || row.course_draft_registered),
      reception,
      followup: Boolean(row.followup_ready),
      ...(reservationForm ? { reservationForm } : {}),
      ...(bookingExposure ? { bookingExposure } : {}),
      ...(followupSetup ? { followupSetup } : {}),
    };
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, data });
  });
}
