import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { dbFor } from '../services/db-router.js';
import { assertChanged, clearAssertions } from '../features/booking/booking-series/index.js';
import { hasOrganizationSelector, organizationFor, requiredAccount, storeBelongsTo } from './restaurant-test-definition.js';

type Move = { id: string; expectedRevision: number; targetTableId: string | null };

/** 端末とサーバーの時計のずれとして許す幅。 */
const CLOCK_TOLERANCE_MS = 60_000;
/** 確認の窓を開いてから、この時間を過ぎた確認は読み直してもらう。 */
const CONFIRMATION_TTL_MS = 15 * 60_000;
/** 止める卓に結び付いた、これから先の有効な予約（主の卓または連結の卓）。 */
const ACTIVE_ON_TABLE = `r.store_id=? AND r.status NOT IN ('cancelled','no_show','completed','visited','seated') AND r.departed_at IS NULL AND julianday(r.ends_at)>julianday(?) AND (r.table_id=? OR EXISTS(SELECT 1 FROM rt_reservation_table_links l WHERE l.reservation_id=r.id AND l.table_id=?))`;

export async function stopRestaurantTable(c: Context<Env>) {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<{ storeId: string; expectedTableRevision: number; asOf?: string; reservations: Move[] }>().catch(() => null);
  if (!body || typeof body.storeId !== 'string' || !Number.isSafeInteger(body.expectedTableRevision) || body.expectedTableRevision < 1
    || !Array.isArray(body.reservations) || body.reservations.length > 200
    || body.reservations.some(r => !r || typeof r.id !== 'string' || !r.id || !Number.isSafeInteger(r.expectedRevision) || r.expectedRevision < 1 || (r.targetTableId !== null && typeof r.targetTableId !== 'string'))
    || new Set(body.reservations.map(r => r.id)).size !== body.reservations.length) {
    return c.json({ success: false, error: '確認した卓と予約が正しくありません' }, 400);
  }
  const asOf = body.asOf ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(asOf))) return c.json({ success: false, error: '確認した日時が正しくありません' }, 400);
  // 確認の基準時刻はサーバー時刻と照らす。未来の時刻や、確認してから時間がたった物は、読み直して確かめ直してもらう。
  const skew = Date.parse(asOf) - Date.now();
  if (skew > CLOCK_TOLERANCE_MS || skew < -CONFIRMATION_TTL_MS) {
    return c.json({ success: false, code: 'stale_confirmation', error: 'stale_confirmation',
      reason: skew > 0 ? '確認した時刻が正しくありません。読み直して確かめ直してください' : '確認してから時間がたちました。読み直して確かめ直してください' }, 409);
  }
  if ((organization.scopedStoreId && organization.scopedStoreId !== body.storeId) || !await storeBelongsTo(c, organization.id, body.storeId)) return c.json({ success: false, error: '店舗が見つかりません' }, 404);
  const db = dbFor(c.env, body.storeId), tableId = c.req.param('id')!;
  const table = await db.prepare('SELECT id FROM rt_tables WHERE id=? AND store_id=?').bind(tableId, body.storeId).first();
  if (!table) return c.json({ success: false, error: '卓が見つかりません' }, 404);
  // 連結席：主の卓が別で、止める卓を連結として使っている予約は、主の卓を移しても結び付きが付け替えられない。止めずに付け替えを先に頼む。
  const linkedOnly = await db.prepare(`SELECT r.id FROM rt_reservations r WHERE ${ACTIVE_ON_TABLE} AND r.table_id IS NOT ? LIMIT 50`)
    .bind(body.storeId, asOf, tableId, tableId, tableId).all<{ id: string }>();
  if (linkedOnly.results.length) {
    return c.json({ success: false, code: 'linked_seat_review', error: 'linked_seat_review',
      reason: `この卓を連結席として使う予約が${linkedOnly.results.length}件あります。予約台帳で卓を付け替えてから止めてください`,
      reservationIds: linkedOnly.results.map(r => r.id) }, 409);
  }
  const expected = JSON.stringify(body.reservations);
  const moves = body.reservations.map(r => db.prepare(`UPDATE rt_reservations SET table_id=?,customer_version=customer_version+1,confirmation_revision=confirmation_revision+1,updated_at=datetime('now')
    WHERE id=? AND store_id=? AND confirmation_revision=? AND (? IS NULL OR (? IS NOT table_id AND EXISTS(SELECT 1 FROM rt_tables t WHERE t.id=? AND t.store_id=rt_reservations.store_id AND t.id<>? AND t.is_active=1 AND t.min_capacity<=rt_reservations.guest_count AND t.max_capacity>=rt_reservations.guest_count)))`)
    .bind(r.targetTableId, r.id, body.storeId, r.expectedRevision, r.targetTableId, r.targetTableId, r.targetTableId, tableId));
  const steps: D1PreparedStatement[] = [db.prepare(`UPDATE rt_tables SET is_active=0,confirmation_revision=confirmation_revision+1,updated_at=datetime('now')
    WHERE id=? AND store_id=? AND is_active=1 AND confirmation_revision=?
    AND (SELECT COUNT(*) FROM rt_reservations r WHERE r.store_id=? AND r.status NOT IN ('cancelled','no_show','completed','visited','seated') AND r.departed_at IS NULL AND julianday(r.ends_at)>julianday(?) AND (r.table_id=? OR EXISTS(SELECT 1 FROM rt_reservation_table_links l WHERE l.reservation_id=r.id AND l.table_id=?)))=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM rt_reservations r WHERE r.id=json_extract(e.value,'$.id') AND r.store_id=? AND r.confirmation_revision=json_extract(e.value,'$.expectedRevision') AND r.status NOT IN ('cancelled','no_show','completed','visited','seated') AND r.departed_at IS NULL AND julianday(r.ends_at)>julianday(?) AND (r.table_id=? OR EXISTS(SELECT 1 FROM rt_reservation_table_links l WHERE l.reservation_id=r.id AND l.table_id=?))))`)
    .bind(tableId,body.storeId,body.expectedTableRevision,body.storeId,asOf,tableId,tableId,body.reservations.length,expected,body.storeId,asOf,tableId,tableId), assertChanged(db)];
  for (const move of moves) steps.push(move, assertChanged(db));
  steps.push(db.prepare(`INSERT INTO booking_batch_assertions(id,ok) SELECT ?, CASE WHEN EXISTS(SELECT 1 FROM rt_reservations r WHERE ${ACTIVE_ON_TABLE}) THEN 0 ELSE 1 END`)
    .bind(crypto.randomUUID(), body.storeId, asOf, tableId, tableId));
  steps.push(clearAssertions(db));
  try { await db.batch(steps); }
  catch (error) {
    const conflict = /closure_conflict|customer_table_conflict/i.exec(String(error))?.[0];
    if (conflict) return c.json({ success: false, code: conflict, error: conflict,
      reason: conflict === 'closure_conflict' ? '臨時休業・貸切と重なります' : '同じ卓に重なる予約または仮押さえがあります' }, 409);
    if (/restaurant_table_conflict/i.test(String(error))) {
      return c.json({ success: false, code: 'move_target_conflict', error: 'move_target_conflict',
        reason: '移す先の卓が、臨時休業・貸切・ほかの予約と重なるか、止める卓と連結しています。別の卓を選んでください' }, 409);
    }
    if (!/CHECK constraint/i.test(String(error))) throw error;
    const currentTable = await db.prepare('SELECT id,is_active,confirmation_revision FROM rt_tables WHERE id=? AND store_id=?').bind(tableId,body.storeId).first();
    const currentReservations = await db.prepare(`SELECT r.id,r.status,r.table_id,r.confirmation_revision FROM rt_reservations r WHERE r.store_id=? AND r.status NOT IN ('cancelled','no_show','completed','visited','seated') AND r.departed_at IS NULL AND julianday(r.ends_at)>julianday(?) AND (r.table_id=? OR EXISTS(SELECT 1 FROM rt_reservation_table_links l WHERE l.reservation_id=r.id AND l.table_id=?)) LIMIT 201`).bind(body.storeId,asOf,tableId,tableId).all();
    return c.json({ success: false, code: 'version_conflict', error: '卓または予約が変わりました。読み直してください', current: { table: currentTable, reservations: currentReservations.results } }, 409);
  }
  return c.json({ success: true, data: { id: tableId } });
}
