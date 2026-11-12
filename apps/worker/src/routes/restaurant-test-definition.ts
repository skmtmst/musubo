import { validRestaurantMenuDescription, validRestaurantMenuImage } from './restaurant-menu-media.js';
import { normalizePhone, phoneProblem } from '@line-crm/shared';
import { normalizedPhoneSql } from '../lib/phone-sql.js';
import type { OrganizationRow, OrganizationContext, SelectedRestaurantStore } from './restaurant-context-types.js';
import { setRestaurantAttendance, type AttendanceInput } from '../services/restaurant-attendance.js';
import { inputError } from '../lib/input-errors.js';
import { closuresForRange, openSeatTables } from '../services/restaurant-closures.js';
import { processVisitStampQueue } from '../services/visit-stamps.js';
import { recordRestaurantTableConflict } from '../services/restaurant-inventory-rules.js';
import { StampError } from '../services/visit-stamps.js';
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { adminSessionTokenHashFromRequest } from '../middleware/auth.js';
import { canAccessLineAccount, getVisibleLineAccountScope } from '../services/account-access.js';
import { finishExpiredWaitlists } from '../features/booking/booking-waitlist/index.js';
import { dbFor } from '../services/db-router.js';
import { type LineTokenIssueFailure } from '../services/token-refresh.js';
import { DEFAULT_STAY_MINUTES } from '../services/restaurant-reservation-email.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';

export const RESTAURANT_TERMS_DOCUMENT_KEY = 'musubo-terms';
export const RESTAURANT_TERMS_DOCUMENT_VERSION = 'v0.1-draft';

export async function organizationByTenantId(
  c: Context<Env>,
  id: string,
): Promise<OrganizationContext | null> {
  const organization = await dbFor(c.env).prepare(`SELECT
      o.id, o.account_id, o.tenant_id, t.name AS tenant_name, o.name, o.status
    FROM rt_organizations o
    LEFT JOIN tenants t ON t.id = o.tenant_id
    WHERE o.tenant_id = ?
    LIMIT 1`).bind(id).first<OrganizationRow>();
  return organization ? { ...organization, scopedStoreId: null } : null;
}

export function accountId(c: Context<Env>): string | null {
  return c.req.query('account_id') || null;
}

export function tenantId(c: Context<Env>): string | null {
  return c.req.query('tenant_id') || null;
}

export function hasOrganizationSelector(c: Context<Env>): boolean {
  return Boolean(accountId(c) || tenantId(c));
}

export function authenticatedTenantId(c: Context<Env>): string {
  return c.get('staff')?.tenantId ?? DEFAULT_TENANT_ID;
}

export /** 1人の認証済み担当者は1つの飲食店組織に所属する。複数所属は権限モデルが定義されるまで扱わない。 */
async function baseOrganizationFor(c: Context<Env>): Promise<OrganizationContext | null> {
  const requestedTenant = tenantId(c);
  if (requestedTenant) {
    return organizationByTenantId(c, requestedTenant);
  }

  const id = accountId(c);
  if (!id) return null;
  const organization = await dbFor(c.env).prepare(
    `SELECT o.id, o.account_id, o.tenant_id, t.name AS tenant_name, o.name, o.status
     FROM rt_organizations o
     LEFT JOIN tenants t ON t.id = o.tenant_id
     WHERE o.account_id = ? LIMIT 1`,
  ).bind(id).first<OrganizationRow>();
  if (organization) return { ...organization, scopedStoreId: null };

  const storeOrganization = await dbFor(c.env).prepare(`SELECT
      o.id, o.account_id, o.tenant_id, t.name AS tenant_name,
      o.name, o.status, s.id AS scoped_store_id
    FROM rt_stores s
    JOIN rt_organizations o ON o.id = s.organization_id
    LEFT JOIN tenants t ON t.id = o.tenant_id
    WHERE s.line_account_id = ?
    LIMIT 1`).bind(id).first<OrganizationRow & { scoped_store_id: string }>();
  return storeOrganization
    ? { ...storeOrganization, scopedStoreId: storeOrganization.scoped_store_id }
    : null;
}

export /** 必要な書込時だけ実組織を作る。同時要求は統括と account_id の一意制約へ収束させ、INSERT 後の SELECT で勝者を取得する。 */
async function ensureOrganizationForAuthenticatedTenant(
  c: Context<Env>,
): Promise<OrganizationContext | null> {
  const staffTenantId = authenticatedTenantId(c);
  const existing = await organizationByTenantId(c, staffTenantId);
  if (existing) return existing;

  const tenant = await dbFor(c.env).prepare(
    'SELECT name FROM tenants WHERE id = ? LIMIT 1',
  ).bind(staffTenantId).first<{ name: string }>();
  if (!tenant) return null;

  await dbFor(c.env).prepare(`INSERT OR IGNORE INTO rt_organizations
    (id, account_id, tenant_id, name, status)
    VALUES (?, ?, ?, ?, 'active')`).bind(
      crypto.randomUUID(),
      staffTenantId,
      staffTenantId,
      tenant.name,
    ).run();
  return organizationByTenantId(c, staffTenantId);
}

export async function selectedRestaurantStore(
  c: Context<Env>,
  organizationId: string,
): Promise<SelectedRestaurantStore | null> {
  const tokenHash = await adminSessionTokenHashFromRequest(c);
  if (!tokenHash) return null;
  return dbFor(c.env).prepare(`SELECT s.id, s.organization_id, s.name
    FROM admin_sessions session
    JOIN rt_stores s ON s.id = session.selected_restaurant_store_id
    WHERE session.token_hash = ?
      AND session.expires_at > ?
      AND s.organization_id = ?
    LIMIT 1`).bind(tokenHash, new Date().toISOString(), organizationId)
    .first<SelectedRestaurantStore>();
}

export async function organizationFor(
  c: Context<Env>,
  options: { ignoreSession?: boolean } = {},
): Promise<OrganizationContext | null> {
  const organization = await baseOrganizationFor(c);
  if (!organization || options.ignoreSession) return organization;
  const selected = await selectedRestaurantStore(c, organization.id);
  return selected ? { ...organization, scopedStoreId: selected.id } : organization;
}

export async function storeBelongsTo(c: Context<Env>, organizationId: string, storeId: string): Promise<boolean> {
  const selected = await selectedRestaurantStore(c, organizationId);
  if (selected && selected.id !== storeId) return false;
  const row = await dbFor(c.env, storeId).prepare(
    'SELECT line_account_id FROM rt_stores WHERE id = ? AND organization_id = ? LIMIT 1',
  ).bind(storeId, organizationId).first<{ line_account_id: string | null }>();
  if (!row) return false;
  const scope = await getVisibleLineAccountScope(dbFor(c.env), c.get('staff'));
  return row.line_account_id ? scope.ids.includes(row.line_account_id) : !scope.isAccountScoped;
}

export function requiredAccount(c: Context<Env>) {
  return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["account_id"]);
}

export function publicOrganization(organization: OrganizationContext): OrganizationRow {
  return {
    id: organization.id,
    account_id: organization.account_id,
    tenant_id: organization.tenant_id,
    tenant_name: organization.tenant_name,
    name: organization.name,
    status: organization.status,
  };
}

export async function validateStoreLineAccount(
  c: Context<Env>,
  lineAccountId: string,
): Promise<boolean> {
  const scope = await getVisibleLineAccountScope(dbFor(c.env), c.get('staff'));
  return canAccessLineAccount(scope.accounts, c.get('staff'), lineAccountId);
}

export async function updateSelectedRestaurantStore(
  c: Context<Env>,
  storeId: string | null,
): Promise<boolean> {
  const tokenHash = await adminSessionTokenHashFromRequest(c);
  if (!tokenHash) return false;
  const result = await dbFor(c.env).prepare(`UPDATE admin_sessions
    SET selected_restaurant_store_id = ?
    WHERE token_hash = ? AND expires_at > ?`).bind(
      storeId,
      tokenHash,
      new Date().toISOString(),
    ).run();
  return Boolean(result.meta.changes);
}

export function lineConnectionMessage(reason: LineTokenIssueFailure): string {
  if (reason === 'credentials') {
    return 'チャネルIDまたはチャネルシークレットが違う可能性があります。LINE Developersの「チャネル基本設定」からコピーし直してください。';
  }
  if (reason === 'rate_limited') {
    return 'LINE側の利用回数制限に達しました。少し時間を置いてから、もう一度お試しください。';
  }
  if (reason === 'network' || reason === 'temporary') {
    return 'LINEへ一時的に接続できませんでした。通信状況を確認し、少し時間を置いてからもう一度お試しください。';
  }
  return 'LINEから接続確認に必要な情報を取得できませんでした。チャネルIDとチャネルシークレットを確認してください。';
}

export async function acquireLock(db: D1Database, key: string, owner: string): Promise<boolean> {
  const expires = new Date(Date.now() + 10_000).toISOString();
  await db.prepare(`INSERT INTO rt_resource_locks (resource_key, owner_token, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(resource_key) DO UPDATE SET owner_token = excluded.owner_token, expires_at = excluded.expires_at, created_at = datetime('now')
    WHERE datetime(rt_resource_locks.expires_at) <= datetime('now')`).bind(key, owner, expires).run();
  const held = await db.prepare('SELECT owner_token FROM rt_resource_locks WHERE resource_key = ?').bind(key).first<{ owner_token: string }>();
  return held?.owner_token === owner;
}

export async function releaseLock(db: D1Database, key: string, owner: string): Promise<void> {
  await db.prepare('DELETE FROM rt_resource_locks WHERE resource_key = ? AND owner_token = ?').bind(key, owner).run();
}

export const INACTIVE_RESERVATION_STATUSES = ['cancelled', 'no_show'];

export function reservationSlotActive(status: string | null | undefined): boolean {
  return !INACTIVE_RESERVATION_STATUSES.includes(status || '');
}

export /**
 * 同じ卓に時間が重なる有効予約があるかを調べる。
 * 終了ちょうどの入替（ends_at = starts_at）は重なりとみなさない。
 */
async function overlappingReservationExists(
  db: D1Database,
  storeId: string,
  tableId: string,
  startsAt: string,
  endsAt: string,
  excludeId?: string | null,
  env?: Env['Bindings'],
): Promise<boolean> {
  const params: unknown[] = [storeId, tableId, endsAt, startsAt];
  let sql = `SELECT 1 AS ok FROM rt_reservations
    WHERE store_id = ? AND EXISTS(SELECT 1 FROM rt_reservation_table_links l WHERE l.reservation_id=rt_reservations.id AND l.table_id=?)
      AND status NOT IN ('cancelled', 'no_show')
      AND (status<>'pending' OR hold_expires_at IS NULL OR julianday(hold_expires_at)>julianday('now'))
      AND julianday(starts_at) < julianday(?) AND julianday(ends_at) > julianday(?)`;
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  const row = await db.prepare(`${sql} LIMIT 1`).bind(...params).first();
  if(row && env) await recordRestaurantTableConflict(env,storeId,startsAt,tableId);
  return Boolean(row);
}

export type ReservationSlotState = { starts_at: string; guest_count: number; status: string };

export /** 予約の新旧状態に合わせて時間帯在庫の予約済数を動かす。 */
async function applyReservationInventoryChange(
  db: D1Database,
  storeId: string,
  old: ReservationSlotState | null,
  next: ReservationSlotState | null,
): Promise<void> {
  const wasActive = old ? reservationSlotActive(old.status) : false;
  const isActive = next ? reservationSlotActive(next.status) : false;
  if (!old && next && isActive) {
    await adjustInventoryReservedCount(db, storeId, next.starts_at, next.guest_count);
    return;
  }
  if (!old || !next) return;
  if (wasActive && !isActive) {
    await adjustInventoryReservedCount(db, storeId, old.starts_at, -old.guest_count);
  } else if (!wasActive && isActive) {
    await adjustInventoryReservedCount(db, storeId, next.starts_at, next.guest_count);
  } else if (wasActive && isActive) {
    if (old.starts_at === next.starts_at) {
      await adjustInventoryReservedCount(db, storeId, next.starts_at, next.guest_count - old.guest_count);
    } else {
      await adjustInventoryReservedCount(db, storeId, old.starts_at, -old.guest_count);
      await adjustInventoryReservedCount(db, storeId, next.starts_at, next.guest_count);
    }
  }
}

export /** 時間帯在庫の予約済数を人数分だけ動かす。枠が無ければ何もしない。 */
async function adjustInventoryReservedCount(
  db: D1Database,
  storeId: string,
  startsAt: string,
  guestDelta: number,
): Promise<void> {
  // 予約そのものを正本にし、取消・枠をまたぐ滞在・再送で二重加算しない。
  await db.prepare(`UPDATE rt_inventory_slots SET reserved_count = COALESCE((SELECT SUM(r.guest_count)
    FROM rt_reservations r WHERE r.store_id = rt_inventory_slots.store_id AND r.status NOT IN ('cancelled', 'no_show') AND r.departed_at IS NULL
      AND datetime(r.starts_at) < datetime(rt_inventory_slots.starts_at, '+' || rt_inventory_slots.slot_minutes || ' minutes')
      AND datetime(r.ends_at) > datetime(rt_inventory_slots.starts_at)), 0) WHERE store_id = ?`).bind(storeId).run();
}

/**
 * 席の空き待ちの登録の共通処理。
 *
 * 開始時刻は UTC ISO (Z) にそろえる（取り消し時の突き合わせ用）。
 * 満席の判定は空き照会の表示側で行い、登録口は受け付ける。
 */
export async function insertSeatWaitlistEntry(
  db: D1Database,
  input: {
    storeId: string;
    startsAt: string;
    guestCount: number;
    customerName: string;
    customerPhone: string | null;
    lineUid: string | null;
    endsAt?:string;
  },
): Promise<
  | { ok: true; id: string }
  | { ok: false; error: 'invalid_slot' | 'invalid_party' | 'invalid_starts_at' | 'starts_at_in_past' | 'missing_customer' | 'invalid_phone' | 'already_waiting' | 'registration_closed' | 'waitlist_limit' | 'closure_conflict' }
> {
  const startsAtMs = Date.parse(input.startsAt);
  if (Number.isNaN(startsAtMs)) return { ok: false, error: 'invalid_starts_at' };
  if (startsAtMs <= Date.now()) return { ok: false, error: 'starts_at_in_past' };
  if(startsAtMs<=Date.now()+60*60_000)return {ok:false,error:'registration_closed'};
  const account=await db.prepare('SELECT line_account_id FROM rt_stores WHERE id=?').bind(input.storeId).first<{line_account_id:string}>();
  if(account)await finishExpiredWaitlists(db,account.line_account_id);
  if (!Number.isInteger(input.guestCount) || input.guestCount < 1 || input.guestCount > 100) {
    return { ok: false, error: 'invalid_party' };
  }
  if (input.customerPhone != null && phoneProblem(input.customerPhone)) return { ok: false, error: 'invalid_phone' };
  const customerPhone = normalizePhone(input.customerPhone ?? '') || null;
  const customerName = input.customerName.trim();
  if (!customerName) return { ok: false, error: 'missing_customer' };
  const startsAt = new Date(startsAtMs).toISOString();
  const endsAt = input.endsAt ?? new Date(startsAtMs + DEFAULT_STAY_MINUTES * 60_000).toISOString();
  if (!Number.isFinite(Date.parse(endsAt)) || Date.parse(endsAt) <= startsAtMs) return { ok: false, error: 'invalid_slot' };
  if ((await closuresForRange(db, input.storeId, startsAt, endsAt)).length && !(await openSeatTables(db, input.storeId, startsAt, endsAt, input.guestCount, true)).length) return { ok: false, error: 'closure_conflict' };
  const identityKey = input.lineUid
    ? `line:${input.lineUid}`
    : customerPhone
      ? `phone:${customerPhone}`
      : `name:${customerName}`;
  // 旧行は書き換えず、同じ枠の有効な待機者だけを読んで表記ゆれを照合する。
  const existing = (await db.prepare(`SELECT id,identity_key,customer_phone,line_uid FROM rt_seat_waitlist
      WHERE store_id = ? AND starts_at = ? AND status IN ('waiting', 'invited')`)
    .bind(input.storeId, startsAt).all<{ id: string; identity_key: string; customer_phone: string | null; line_uid: string | null }>()).results
    .some(row => row.identity_key === identityKey || (!input.lineUid && !row.line_uid && customerPhone !== null && normalizePhone(row.customer_phone ?? '') === customerPhone));
  if (existing) return { ok: false, error: 'already_waiting' };
  const id = crypto.randomUUID();
  try {
    const inserted = await db
      .prepare(`INSERT INTO rt_seat_waitlist
        (id, store_id, starts_at, guest_count, customer_name, customer_phone,
         line_uid, identity_key,ends_at,created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?,?,?
        WHERE ? IS NOT NULL OR (SELECT COUNT(*) FROM rt_seat_waitlist w
          JOIN rt_stores s ON s.id=w.store_id
          WHERE s.line_account_id=(SELECT line_account_id FROM rt_stores WHERE id=?)
            AND w.status IN ('waiting','invited') AND w.line_uid IS NULL
            AND (w.identity_key=? OR ${normalizedPhoneSql}=?))<3`)
      .bind(id, input.storeId, startsAt, input.guestCount, customerName,
        customerPhone, input.lineUid, identityKey,input.endsAt??new Date(startsAtMs+DEFAULT_STAY_MINUTES*60_000).toISOString(),new Date().toISOString(),
        input.lineUid, input.storeId, identityKey, customerPhone)
      .run();
    if (!inserted.meta.changes) return { ok: false, error: 'waitlist_limit' };
  } catch (error) {
    // 同時登録の race は部分一致キーが止める。
    if (/closure_conflict/.test(String(error))) return { ok: false, error: 'closure_conflict' };
    if (/waitlist_limit/.test(String(error)))return {ok:false,error:'waitlist_limit'};
    if(/waitlist_registration_closed/.test(String(error)))return {ok:false,error:'registration_closed'};
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      return { ok: false, error: 'already_waiting' };
    }
    throw error;
  }
  return { ok: true, id };
}

export const SEAT_WAITLIST_ERROR_STATUS: Record<string, number> = {
  invalid_phone: 400,
  invalid_slot: 400,
  invalid_party: 400,
  invalid_starts_at: 400,
  starts_at_in_past: 400,
  missing_customer: 400,
  already_waiting: 409,
  registration_closed:409,waitlist_limit:409,closure_conflict:409,
};

export /** 店舗が組織のものか確かめる。違えば null。 */
async function storeInOrganization(
  c: Context<Env>,
  organizationId: string,
  storeId: string,
): Promise<{ id: string; timezone: string } | null> {
  const row = await dbFor(c.env).prepare(
    `SELECT id, timezone FROM rt_stores WHERE id = ? AND organization_id = ? AND status != 'archived'`,
  ).bind(storeId, organizationId).first<{ id: string; timezone: string }>();
  return row ?? null;
}

export /** 旧来店URLも共通の保存口へ渡す。版と操作IDは全更新で必須。 */
async function attendance(c:Context<Env>,legacy?:'visit'|'undo_visit') {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);if(!org)return c.json({success:false,error:'飲食店テスト組織がありません'},404);
 const id=c.req.param('id');if(!id)return c.json({success:false,error:'予約が見つかりません'},404);
 const r=await dbFor(c.env).prepare(`SELECT r.store_id FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id WHERE r.id=? AND s.organization_id=? AND (? IS NULL OR s.id=?)`).bind(id,org.id,org.scopedStoreId,org.scopedStoreId).first<{store_id:string}>();
 if(!r)return c.json({success:false,error:'予約が見つかりません'},404);
 const body=legacy==='undo_visit'?{action:'undo_visit',expectedVersion:Number(c.req.query('expectedVersion')),requestId:c.req.query('requestId')}:await c.req.json<Record<string,unknown>>();
 const input={...body,action:legacy==='visit'?body.kind:body.action} as unknown as AttendanceInput;
 try {
  const data=await setRestaurantAttendance(dbFor(c.env,r.store_id),id,r.store_id,input,c.get('staff')?.id??null,c.get('staff')?.name??null);
  await processVisitStampQueue(c.env);
  const mark=await dbFor(c.env,r.store_id).prepare('SELECT * FROM rt_seat_visit_marks WHERE reservation_id=? AND undone_at IS NULL ORDER BY marked_at DESC,rowid DESC LIMIT 1').bind(id).first();
  const stamped=await dbFor(c.env,r.store_id).prepare("SELECT SUM(delta) AS count FROM visit_stamp_entries WHERE visit_key=? AND kind IN('visit','reverse','restore')").bind('restaurant:'+id).first<{count:number|null}>();
  const stamp={status:stamped?.count?'recorded':'pending_or_unavailable',count:stamped?.count??0};
  return c.json({success:true,data:{...data as object,visit_mark:mark,stamp}});
 }catch(e){if(e instanceof StampError){const error=e.message==='approval_required'?'承認してから無断にしてください':e.message==='already_arrived'?'来店済みの予約は無断にできません':e.message;return inputError(c,{success:false,error,code:e.message,fields:e.fields},e.status);}throw e;}
}

export const updateRestaurantMenu = async (c: Context<Env>) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const current = await dbFor(c.env).prepare(`SELECT m.* FROM rt_menu_items m JOIN rt_stores s ON s.id = m.store_id
    WHERE m.id = ? AND s.organization_id = ? AND (? IS NULL OR s.id = ?)`)
    .bind(c.req.param('id'), organization.id, organization.scopedStoreId, organization.scopedStoreId)
    .first<{ store_id: string; kind: string; name: string; price: number; allergens_json: string; service_periods_json: string; status: string; description: string | null; image_media_id: string | null }>();
  if (!current) return c.json({ success: false, error: 'メニューが見つかりません' }, 404);
  const body = await c.req.json<{ kind?: string; name?: string; price?: number; allergens?: string[]; servicePeriods?: string[]; status?: string; effectiveAt?: string | null; description?: string | null; imageMediaId?: string | null; expectedVersion?: number }>();
  if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)) return inputError(c, { success: false, error: "確認した版が正しくありません" }, 400, ["expectedVersion"]);
  const kind = body.kind === undefined ? current.kind : body.kind;
  const name = body.name === undefined ? current.name : body.name;
  const price = body.price === undefined ? current.price : body.price;
  if (body.price !== undefined && price !== current.price && price > 1_000_000) return inputError(c, { success: false, error: '値段は1,000,000円以下で入れてください。' }, 400, ['price']);
  const status = body.status === undefined ? current.status : body.status;
  if (!['course', 'a_la_carte'].includes(kind) || typeof name !== 'string' || !name.trim()
    || !Number.isInteger(price) || price < 0 || !['draft', 'active', 'archived'].includes(status)
    || (body.allergens !== undefined && (!Array.isArray(body.allergens) || body.allergens.some((item) => typeof item !== 'string')))
    || (body.servicePeriods !== undefined && (!Array.isArray(body.servicePeriods) || body.servicePeriods.some((item) => !['lunch', 'dinner'].includes(item))))) {
    return inputError(c, { success: false, error: 'メニューの入力内容が正しくありません' }, 400, ["kind","name","price","status","allergens","servicePeriods"]);
  }
  if (body.effectiveAt !== undefined && body.effectiveAt !== null && (typeof body.effectiveAt !== 'string' || !Number.isFinite(Date.parse(body.effectiveAt)))) return inputError(c, { success:false,error:'価格の開始日時を確認してください' }, 400, ["effectiveAt"]);
  if (!validRestaurantMenuDescription(body.description)) return inputError(c, { success:false, error:'説明は2000文字以内で入力してください' }, 400, ['description']);
  if ((body.imageMediaId != null && (typeof body.imageMediaId !== 'string' || !body.imageMediaId)) || (body.imageMediaId !== undefined && body.imageMediaId !== current.image_media_id && !await validRestaurantMenuImage(dbFor(c.env, current.store_id), current.store_id, body.imageMediaId))) return inputError(c, { success:false, code:'MENU_IMAGE_UNAVAILABLE', error:'選択した画像を利用できません。登録メディアから選び直してください。' }, 400, ['imageMediaId']);
  const effectiveAt = body.effectiveAt ? new Date(body.effectiveAt).toISOString() : null;
  const db = dbFor(c.env, current.store_id);
  const approvalId = price !== current.price ? crypto.randomUUID() : null;
  const requestId = approvalId ? crypto.randomUUID() : null;
  const scheduledChange = approvalId ? await db.prepare(`SELECT id, approval_id FROM rt_menu_change_requests
    WHERE menu_id = ? AND store_id = ? AND status = 'approved' LIMIT 1`)
    .bind(c.req.param('id'), current.store_id).first<{ id: string; approval_id: string }>() : null;
  const writes = [db.prepare(`UPDATE rt_menu_items SET confirmation_revision = confirmation_revision + 1, kind = ?, name = ?, allergens_json = ?, service_periods_json = ?, status = ?, description = CASE WHEN ? THEN ? ELSE description END, image_media_id = CASE WHEN ? THEN ? ELSE image_media_id END, updated_at = datetime('now') WHERE id = ? AND store_id = ? AND (? IS NULL OR confirmation_revision = ?)` )
    .bind(kind, name.trim(), body.allergens === undefined ? current.allergens_json : JSON.stringify(body.allergens), body.servicePeriods === undefined ? current.service_periods_json : JSON.stringify(body.servicePeriods), status, body.description !== undefined ? 1 : 0, body.description?.trim() || null, body.imageMediaId !== undefined ? 1 : 0, body.imageMediaId ?? null, c.req.param('id'), current.store_id, body.expectedVersion ?? null, body.expectedVersion ?? null)];
  if (body.expectedVersion !== undefined) writes.push(db.prepare("SELECT json(CASE WHEN changes() = 1 THEN '{}' ELSE 'menu_confirmation_conflict' END)"));
  if (approvalId) {
    const requester = c.get('staff')?.id || '管理者';
    if (scheduledChange) {
      writes.push(db.prepare(`UPDATE rt_menu_change_requests SET status = 'returned', return_reason = '新しい価格変更で置き換え', updated_at = datetime('now')
        WHERE id = ? AND status = 'approved'`).bind(scheduledChange.id));
      writes.push(db.prepare(`UPDATE rt_approval_requests SET status = 'returned', review_comment = '新しい価格変更で置き換え', reviewed_by = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'approved'`).bind(requester, scheduledChange.approval_id));
    }
    writes.push(db.prepare(`INSERT INTO rt_approval_requests (id, organization_id, store_id, kind, title, status, payload_json, requested_by)
      VALUES (?, ?, ?, 'menu_change', ?, 'pending', ?, ?)`).bind(approvalId, organization.id, current.store_id,
      `${name.trim()}の価格変更`, JSON.stringify({ menuId: c.req.param('id'), beforePrice: current.price, afterPrice: price, effectiveAt }), requester));
    writes.push(db.prepare(`INSERT INTO rt_menu_change_requests (id, approval_id, menu_id, store_id, before_price, after_price, requested_by, effective_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(requestId, approvalId, c.req.param('id'), current.store_id, current.price, price, requester, effectiveAt));
    // 価格変更は保存した権限者自身が確定する。既存のトリガーで即時反映または開始待ちにする。
    writes.push(db.prepare(`UPDATE rt_approval_requests SET status = 'approved', reviewed_by = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'`).bind(requester, approvalId));
  }
  try {
    await db.batch(writes);
  } catch (error) {
    if (body.expectedVersion !== undefined && /malformed json/i.test(String(error))) {
      const latest = await db.prepare('SELECT * FROM rt_menu_items WHERE id = ? AND store_id = ?').bind(c.req.param('id'), current.store_id).first();
      return c.json({ success: false, code: 'menu_confirmation_conflict', error: 'メニューが変更されました。最新の内容を確認してください', data: latest }, 409);
    }
    if (/unique constraint/i.test(String(error))) return c.json({ success: false, error: 'このメニューには以前の価格変更申請が残っています。メニュー一覧の申請中から確認してください' }, 409);
    throw error;
  }
  const priceChange = requestId ? await db.prepare('SELECT status FROM rt_menu_change_requests WHERE id = ?').bind(requestId).first<{ status: string }>() : null;
  if (priceChange?.status === 'failed') return c.json({ success: false, error: '価格が先に変更されたため反映できませんでした。画面を読み直してください' }, 409);
  return c.json({ success: true, data: { id: c.req.param('id'), approvalId, requestId, pendingPrice: priceChange?.status === 'approved' ? price : null } });
};
