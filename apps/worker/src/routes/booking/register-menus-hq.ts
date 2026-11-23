import type { Context, Hono } from 'hono';
import { BOOKING_MENUS_KEY } from '@line-crm/shared';
import type { Env } from '../../worker-env.js';
import { inputError, inputJsonBoundary } from '../../lib/input-errors.js';
import { requirePermission } from '../../middleware/role-guard.js';
import { adoptCatalogVersion, CatalogAdoptionError, catalogHqStatus, dismissCatalogVersion } from '../../services/hq-templates/catalog-adoption.js';
import { resolveAccountIdAdmin } from './identity.js';

/** 本部から配られた予約メニューの、新しい版の知らせ・取り込み・今のまま。権限は予約メニューの編集と同じ入口に従う。 */
export function registerMenusHq(booking: Hono<Env>): void {
  const fail = (c: Context<Env>, error: unknown) => {
    if (error instanceof CatalogAdoptionError) return c.json({ error: error.code }, error.status);
    throw error;
  };
  const writer = (c: Context<Env>) => {
    const staff = c.get('staff');
    // 閲覧のみは全体の認証でも止まるが、この口だけ単独で使われても書かせない。
    return staff && !staff.readOnly ? { id: staff.id, role: staff.role } : null;
  };

  booking.get('/api/booking/admin/menus/:id/hq-status', async (c) => {
    const accountId = await resolveAccountIdAdmin(c);
    if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ['account_id']);
    try { return c.json({ success: true, data: await catalogHqStatus(c.env.DB, 'booking_menu', accountId, c.req.param('id')) }); }
    catch (error) { return fail(c, error); }
  });

  for (const [suffix, run, action] of [['hq-adopt', adoptCatalogVersion, 'adopted'], ['hq-dismiss', dismissCatalogVersion, 'dismissed']] as const) {
    booking.post(`/api/booking/admin/menus/:id/${suffix}`, requirePermission(BOOKING_MENUS_KEY), inputJsonBoundary({ versionId: ['string'] }), async (c) => {
      const accountId = await resolveAccountIdAdmin(c);
      if (!accountId) return inputError(c, { error: 'missing_account_id' }, 400, ['account_id']);
      const actor = writer(c);
      if (!actor) return c.json({ error: 'forbidden' }, 403);
      const body = await c.req.json<{ versionId?: unknown }>();
      try {
        const data = await run(c.env.DB, { kind: 'booking_menu', accountId, targetId: c.req.param('id'), versionId: body.versionId, actor });
        c.set('auditRecorded', true);
        return c.json({ success: true, data: { ...data, action } });
      } catch (error) { return fail(c, error); }
    });
  }
}
