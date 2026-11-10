import { readRestaurantReservationFormHealth } from '../services/restaurant-reservation-form.js';
import type { Hono } from 'hono';
import type { RestaurantSetupProgress } from '@line-crm/shared';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { readRestaurantFollowupSetupProgress } from '../services/restaurant-followup-preferences.js';
import { dbFor } from '../services/db-router.js';
import { connectedGoogleProfile, googleOpeningWeek } from '../services/restaurant-google-hours-source.js';
import { hasOrganizationSelector, organizationFor, requiredAccount, storeBelongsTo } from './restaurant-test-definition.js';

/** 一覧の上限や満席に左右されず、選択店舗の設定の実物だけを読む。書込・送信をしない。 */
export function registerRestaurantSetupProgressRoutes(routes: Hono<Env>) {
  routes.get('/api/restaurant-test/setup-progress', requireRole('owner', 'admin', 'staff'), async (c) => {
    if (!hasOrganizationSelector(c)) return requiredAccount(c);
    const organization = await organizationFor(c);
    const storeId = c.req.query('storeId') || organization?.scopedStoreId;
    if (!organization || !storeId || (organization.scopedStoreId && organization.scopedStoreId !== storeId) || !await storeBelongsTo(c, organization.id, storeId))
      return c.json({ success: false, error: '店舗が見つかりません' }, 404);
    const row = await dbFor(c.env, storeId).prepare(`SELECT s.id,s.line_account_id,
      EXISTS(SELECT 1 FROM rt_tables t WHERE t.store_id=s.id AND t.is_active=1 AND t.max_capacity>0) AS tables_ready,
      (SELECT h.hours_json FROM rt_opening_hours_settings h WHERE h.store_id=s.id) AS hours_json,
      EXISTS(SELECT 1 FROM rt_menu_items m WHERE m.store_id=s.id AND m.status='active') AS menus_ready,
      (EXISTS(SELECT 1 FROM line_accounts a WHERE a.id=s.line_account_id AND a.is_active=1 AND a.archived_at IS NULL AND length(trim(COALESCE(a.liff_id,'')))>0) AND EXISTS(SELECT 1 FROM rt_inventory_slots i WHERE i.store_id=s.id
        AND julianday(i.starts_at)>julianday('now') AND i.total_capacity>0
        AND COALESCE(i.auto_line_original,i.line_capacity)>0)) AS reception_ready,
      EXISTS(SELECT 1 FROM rt_store_followup_templates f WHERE f.store_id=s.id AND f.sending_status='active'
        AND EXISTS(SELECT 1 FROM rt_store_followup_step_bindings b WHERE b.store_id=s.id AND b.enabled=1)) AS followup_ready
      FROM rt_stores s WHERE s.id=? AND s.organization_id=? AND s.status='active'`)
      .bind(storeId, organization.id).first<{ id: string; line_account_id:string|null; tables_ready: number; hours_json: string | null; menus_ready: number; reception_ready: number; followup_ready: number }>();
    if (!row) return c.json({ success: false, error: '店舗が見つかりません' }, 404);
    // JSON不正は想定外のエラーとして共通の報告経路へ渡す。空配列だけが未設定。
    const hours: unknown = row.hours_json === null ? [] : JSON.parse(row.hours_json);
    const profile = await connectedGoogleProfile(dbFor(c.env, storeId), storeId);
    const googleWeek = profile ? googleOpeningWeek(profile) : null;
    const hoursReady = Boolean(googleWeek?.some(day => day.periods.length > 0));
    const bookingHoursReady = Array.isArray(hours) && hours.some(day => day && Array.isArray(day.periods)
      && day.periods.some((period: { opensAt?: string; closesAt?: string }) => /^\d{2}:\d{2}$/.test(period.opensAt ?? '')
        && /^\d{2}:\d{2}$/.test(period.closesAt ?? '') && period.opensAt !== period.closesAt));
    const followupSetup = await readRestaurantFollowupSetupProgress(dbFor(c.env, storeId), storeId);
    const data: RestaurantSetupProgress = {
      storeId: row.id, tables: Boolean(row.tables_ready), hours: hoursReady, menus: Boolean(row.menus_ready),
      reception: Boolean(row.tables_ready && hoursReady && bookingHoursReady && row.reception_ready),
      followup: Boolean(row.followup_ready),
      ...(row.line_account_id?{reservationForm:await readRestaurantReservationFormHealth(dbFor(c.env,storeId),storeId,row.line_account_id)}:{}),
      ...(followupSetup ? { followupSetup } : {}),
    };
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, data });
  });
}
