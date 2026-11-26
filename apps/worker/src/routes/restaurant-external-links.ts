import { parseOffsetPaging, buildOffsetListResponse } from '../lib/list-paging.js';
import { fail } from '../lib/fail.js';
import { Hono, type Context } from 'hono';
import { DEFAULT_TENANT_ID, RESTAURANT_EXTERNAL_PROVIDERS, reservationInstant, type RestaurantExternalLink, type RestaurantExternalProvider } from '@line-crm/shared';

import type { Env } from '../worker-env.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { restaurantTestEnabled } from '../lib/environment-features.js';
import { adminSessionTokenHashFromRequest } from '../middleware/auth.js';
import { getVisibleLineAccountScope } from '../services/account-access.js';
import { dbFor } from '../services/db-router.js';
import { tenantHasFeaturePack } from '../services/tenant-features.js';

/** 独立した対応表だけを更新する。予約・在庫・待ち・送信処理へ渡さない。 */
export const restaurantExternalLinks = new Hono<Env>();
const path = '/api/restaurant-test/external-links';
type Store = { id: string; line_account_id: string | null };
restaurantExternalLinks.onError((error, c) => {
  if (String(error).includes('external_link_legacy_conflict')) return conflict(c, 'duplicate_external_id');
  if (String(error).includes('external_link_store_mismatch')) return c.json({ success: false, error: '予約が見つかりません' }, 404);
  throw error;
});

async function selectedStore(c: Context<Env>): Promise<Store | Response> {
  const staff = c.get('staff');
  if (!staff) return c.json({ success: false, error: '認証が必要です' }, 401);
  const tenantId = staff.tenantId ?? DEFAULT_TENANT_ID;
  const db = dbFor(c.env);
  if (!restaurantTestEnabled(c.env) || !await tenantHasFeaturePack(db, tenantId, 'restaurant')) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  if (c.req.query('tenant_id') && c.req.query('tenant_id') !== tenantId) {
    return c.json({ success: false, error: 'この統括を操作する権限がありません' }, 403);
  }
  const accountId = c.req.query('account_id');
  const storeId = c.req.query('storeId');
  if (!accountId || !storeId) return inputError(c, { success: false, error: 'LINE公式アカウントと店舗を指定してください' }, 400, [!accountId ? 'account_id' : 'storeId']);
  const scope = await getVisibleLineAccountScope(db, staff);
  if (!scope.ids.includes(accountId)) return c.json({ success: false, error: 'このLINE公式アカウントを操作する権限がありません' }, 403);
  const store = await db.prepare(`SELECT s.id, s.line_account_id FROM rt_stores s
    JOIN rt_organizations o ON o.id = s.organization_id
    WHERE s.id = ? AND COALESCE(o.tenant_id, ?) = ? AND (s.line_account_id = ? OR o.account_id = ?)`)
    .bind(storeId, DEFAULT_TENANT_ID, tenantId, accountId, accountId).first<Store>();
  if (!store || (store.line_account_id ? !scope.ids.includes(store.line_account_id) : scope.isAccountScoped)) {
    return c.json({ success: false, error: '店舗が見つかりません' }, 404);
  }
  const tokenHash = await adminSessionTokenHashFromRequest(c);
  if (tokenHash) {
    const session = await db.prepare(`SELECT selected_restaurant_store_id FROM admin_sessions
      WHERE token_hash = ? AND expires_at > ?`).bind(tokenHash, new Date().toISOString())
      .first<{ selected_restaurant_store_id: string | null }>();
    if (session?.selected_restaurant_store_id && session.selected_restaurant_store_id !== store.id) {
      return c.json({ success: false, error: '店舗が見つかりません' }, 404);
    }
  }
  return store;
}

restaurantExternalLinks.use(path, async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const staff = c.get('staff');
    if (!staff || staff.readOnly || !['owner', 'admin', 'staff'].includes(staff.role)) {
      return c.json({ success: false, error: '閲覧のみの権限では変更できません' }, 403);
    }
  }
  return next();
});
restaurantExternalLinks.use(`${path}/*`, async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const staff = c.get('staff');
    if (!staff || staff.readOnly || !['owner', 'admin', 'staff'].includes(staff.role)) {
      return c.json({ success: false, error: '閲覧のみの権限では変更できません' }, 403);
    }
  }
  return next();
});

interface LinkRow {
  id: string; store_id: string; provider: RestaurantExternalProvider; external_id: string;
  origin_provider: RestaurantExternalProvider | null; reservation_id: string; version: number;
  unlinked_at: string | null; updated_at: string; customer_name: string | null;
  starts_at: string | null; ends_at: string | null; reservation_status: string | null;
  friend_id: string | null; friend_name: string | null; tables_json: string;
}
const readSql = `SELECT l.*, r.customer_name, r.starts_at, r.ends_at, r.status AS reservation_status,
  f.id AS friend_id, f.display_name AS friend_name,
  COALESCE((SELECT json_group_array(json_object('id', t.id, 'label', t.label))
    FROM rt_tables t WHERE t.store_id = l.store_id AND
      (t.id IN (SELECT table_id FROM rt_reservation_table_links WHERE reservation_id = r.id)
        OR (t.id = r.table_id AND NOT EXISTS (SELECT 1 FROM rt_reservation_table_links WHERE reservation_id = r.id)))), '[]') AS tables_json
  FROM rt_reservation_external_links l
  LEFT JOIN rt_reservations r ON r.id = l.reservation_id AND r.store_id = l.store_id AND l.unlinked_at IS NULL
  JOIN rt_stores s ON s.id = l.store_id
  LEFT JOIN friends f ON f.line_account_id = s.line_account_id AND f.line_platform_user_id = r.line_uid`;

function publicLink(row: LinkRow): RestaurantExternalLink {
  return {
    id: row.id, storeId: row.store_id, provider: row.provider, externalId: row.external_id,
    originProvider: row.origin_provider, status: row.unlinked_at ? 'unlinked' : 'linked',
    version: row.version, unlinkedAt: row.unlinked_at ? reservationInstant(row.unlinked_at) : null, updatedAt: reservationInstant(row.updated_at),
    reservation: row.unlinked_at || row.customer_name === null ? null : {
      id: row.reservation_id, customerName: row.customer_name, startsAt: reservationInstant(row.starts_at), endsAt: reservationInstant(row.ends_at),
      status: row.reservation_status!, friend: row.friend_id ? { id: row.friend_id, displayName: row.friend_name ?? '' } : null,
      tables: JSON.parse(row.tables_json),
    },
  };
}
async function readLink(c: Context<Env>, storeId: string, id: string) {
  return dbFor(c.env, storeId).prepare(`${readSql} WHERE l.store_id = ? AND l.id = ?`).bind(storeId, id).first<LinkRow>();
}
function conflict(c: Context<Env>, code = 'version_conflict') {
  return fail(c, 409, code, { error: code === 'duplicate_external_id'
    ? 'この外部予約はすでに登録されています。対応を読み直して結び直してください'
    : '対応が変わりました。最新を読み込んでください' });
}
function provider(value: unknown): value is RestaurantExternalProvider {
  return typeof value === 'string' && (RESTAURANT_EXTERNAL_PROVIDERS as readonly string[]).includes(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}
function version(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
async function hasReservation(c: Context<Env>, storeId: string, id: string) {
  return Boolean(await dbFor(c.env, storeId).prepare('SELECT id FROM rt_reservations WHERE store_id = ? AND id = ?').bind(storeId, id).first());
}
async function inputBody(c: Context<Env>): Promise<Record<string, unknown> | Response> {
  try {
    const body: unknown = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* DELETEも、不正なJSONで500にしない。 */ }
  return c.json({ success: false, code: 'INVALID_JSON', error: '入力内容はJSONのオブジェクトで指定してください', fields: {} }, 400);
}

restaurantExternalLinks.get(path, async (c) => {
  const store = await selectedStore(c); if (store instanceof Response) return store;
  const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit'), offset: c.req.query('offset') }, { defaultLimit: 100, limitPolicy: {}, offsetPolicy: {} });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    return inputError(c, { success: false, error: '表示件数または開始位置が正しくありません' }, 400, ['limit', 'offset']);
  }
  const reservationId = c.req.query('reservationId') ?? null;
  const filter = 'l.store_id = ? AND (? IS NULL OR (l.reservation_id = ? AND l.unlinked_at IS NULL))';
  const db = dbFor(c.env, store.id);
  const rows = await db.prepare(`${readSql} WHERE ${filter} ORDER BY l.created_at DESC, l.id LIMIT ? OFFSET ?`)
    .bind(store.id, reservationId, reservationId, limit, offset).all<LinkRow>();
  const count = await db.prepare(`SELECT count(*) AS total FROM rt_reservation_external_links l WHERE ${filter}`)
    .bind(store.id, reservationId, reservationId).first<{ total: number }>();
  const responseItems = rows.results.map(publicLink);
  return c.json({ success: true, data: buildOffsetListResponse({ links: responseItems, total: count!.total, limit, offset, items: responseItems, paging: { limit, offset }, sort: [{ field: 'createdAt', direction: 'desc' }, { field: 'id', direction: 'asc' }] }) });
});
restaurantExternalLinks.get(`${path}/:id`, async (c) => {
  const store = await selectedStore(c); if (store instanceof Response) return store;
  const row = await readLink(c, store.id, c.req.param('id'));
  return row ? c.json({ success: true, data: publicLink(row) }) : c.json({ success: false, error: '対応が見つかりません' }, 404);
});
restaurantExternalLinks.post(path, inputJsonBoundary(), async (c) => {
  const store = await selectedStore(c); if (store instanceof Response) return store;
  const body = await inputBody(c); if (body instanceof Response) return body;
  if (!provider(body.provider)) return inputError(c, { success: false, error: '媒体を選んでください' }, 400, ['provider']);
  if (!identifier(body.externalId)) return inputError(c, { success: false, error: '外部IDは1〜200文字で入力してください' }, 400, ['externalId']);
  if (!identifier(body.reservationId)) return inputError(c, { success: false, error: 'こちらの予約を選んでください' }, 400, ['reservationId']);
  if (body.originProvider != null && !provider(body.originProvider)) return inputError(c, { success: false, error: '元の媒体が正しくありません' }, 400, ['originProvider']);
  if (!await hasReservation(c, store.id, body.reservationId)) return c.json({ success: false, error: '予約が見つかりません' }, 404);
  const id = crypto.randomUUID();
  const result = await dbFor(c.env, store.id).prepare(`INSERT INTO rt_reservation_external_links
    (id, store_id, provider, external_id, reservation_id, origin_provider, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(store_id, provider, external_id) DO NOTHING`)
    .bind(id, store.id, body.provider, body.externalId.trim(), body.reservationId, body.originProvider ?? null, c.get('staff')!.id).run();
  if (!result.meta.changes) return conflict(c, 'duplicate_external_id');
  return c.json({ success: true, data: publicLink((await readLink(c, store.id, id))!) }, 201);
});
restaurantExternalLinks.patch(`${path}/:id`, inputJsonBoundary(), async (c) => {
  const store = await selectedStore(c); if (store instanceof Response) return store;
  const body = await inputBody(c); if (body instanceof Response) return body;
  if (!version(body.expectedVersion)) return inputError(c, { success: false, error: '対応の版が必要です', fields: { expectedVersion: '対応の版が必要です' } }, 400);
  if (!identifier(body.reservationId)) return inputError(c, { success: false, error: 'こちらの予約を選んでください' }, 400, ['reservationId']);
  const id = c.req.param('id');
  if (!await readLink(c, store.id, id)) return c.json({ success: false, error: '対応が見つかりません' }, 404);
  if (!await hasReservation(c, store.id, body.reservationId)) return c.json({ success: false, error: '予約が見つかりません' }, 404);
  const result = await dbFor(c.env, store.id).prepare(`UPDATE rt_reservation_external_links
    SET reservation_id = ?, unlinked_at = NULL, version = version + 1, updated_by = ?, updated_at = datetime('now')
    WHERE id = ? AND store_id = ? AND version = ?`)
    .bind(body.reservationId, c.get('staff')!.id, id, store.id, body.expectedVersion).run();
  if (!result.meta.changes) return conflict(c);
  return c.json({ success: true, data: publicLink((await readLink(c, store.id, id))!) });
});
restaurantExternalLinks.delete(`${path}/:id`, inputJsonBoundary(), async (c) => {
  const store = await selectedStore(c); if (store instanceof Response) return store;
  const body = await inputBody(c); if (body instanceof Response) return body;
  if (!version(body.expectedVersion)) return inputError(c, { success: false, error: '対応の版が必要です', fields: { expectedVersion: '対応の版が必要です' } }, 400);
  const id = c.req.param('id');
  if (!await readLink(c, store.id, id)) return c.json({ success: false, error: '対応が見つかりません' }, 404);
  const result = await dbFor(c.env, store.id).prepare(`UPDATE rt_reservation_external_links
    SET unlinked_at = datetime('now'), version = version + 1, updated_by = ?, updated_at = datetime('now')
    WHERE id = ? AND store_id = ? AND version = ? AND unlinked_at IS NULL`)
    .bind(c.get('staff')!.id, id, store.id, body.expectedVersion).run();
  if (!result.meta.changes) return conflict(c);
  return c.json({ success: true, data: publicLink((await readLink(c, store.id, id))!) });
});
