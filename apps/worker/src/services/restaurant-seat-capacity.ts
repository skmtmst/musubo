import { parseTableAutomation } from './restaurant-table-automation.js';
import { planRestaurantSeats, type SeatPlanInput, type SeatPlanState } from './restaurant-seat-plan.js';

/** 同じ読取内容を予約の保存と同じbatchで照合する。未配席の同時受付も先勝ちにする。 */
const snapshotSql = `WITH scope AS (SELECT ? store_id,? ends_at,? starts_at,? exclude_id)
SELECT json_object(
 'store',(SELECT json_object('account',t.line_account_id,'status',t.status) FROM rt_stores t,scope s WHERE t.id=s.store_id),
 'tables',json((SELECT json_group_array(json_object('id',id,'label',label,'seatType',seat_type,'minCapacity',min_capacity,'maxCapacity',max_capacity,'joinGroup',join_group,'active',is_active)) FROM (SELECT t.* FROM rt_tables t,scope s WHERE t.store_id=s.store_id ORDER BY t.id))),
 'reservations',json((SELECT json_group_array(json_object('id',id,'startsAt',strftime('%Y-%m-%dT%H:%M:%fZ',starts_at),'endsAt',strftime('%Y-%m-%dT%H:%M:%fZ',ends_at),'guestCount',guest_count,'tableIds',json(table_ids))) FROM (SELECT r.*,CASE WHEN (SELECT COUNT(*) FROM rt_reservation_table_links l WHERE l.reservation_id=r.id)>0 THEN (SELECT json_group_array(table_id) FROM (SELECT table_id FROM rt_reservation_table_links l WHERE l.reservation_id=r.id ORDER BY table_id)) WHEN r.table_id IS NOT NULL THEN json_array(r.table_id) ELSE '[]' END table_ids FROM rt_reservations r,scope s WHERE r.store_id=s.store_id AND r.id<>s.exclude_id AND r.departed_at IS NULL AND r.status NOT IN('cancelled','no_show','rejected') AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(s.ends_at) AND julianday(r.ends_at)>julianday(s.starts_at) ORDER BY r.id))),
 'waiting',json((SELECT json_group_array(json_object('id',id,'startsAt',strftime('%Y-%m-%dT%H:%M:%fZ',starts_at),'endsAt',strftime('%Y-%m-%dT%H:%M:%fZ',effective_end),'guestCount',guest_count,'tableIds',json(table_ids))) FROM (SELECT w.*,COALESCE(w.ends_at,datetime(w.starts_at,'+120 minutes')) effective_end,CASE WHEN (SELECT COUNT(*) FROM rt_seat_waitlist_table_links l WHERE l.waitlist_id=w.id)>0 THEN (SELECT json_group_array(table_id) FROM (SELECT table_id FROM rt_seat_waitlist_table_links l WHERE l.waitlist_id=w.id ORDER BY table_id)) WHEN w.table_id IS NOT NULL THEN json_array(w.table_id) ELSE '[]' END table_ids FROM rt_seat_waitlist w,scope s WHERE w.store_id=s.store_id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND julianday(w.starts_at)<julianday(s.ends_at) AND julianday(COALESCE(w.ends_at,datetime(w.starts_at,'+120 minutes')))>julianday(s.starts_at) ORDER BY w.id))),
 'closures',json((SELECT json_group_array(json_object('tableIds',json(table_ids_json),'periods',json(periods_json))) FROM (SELECT c.* FROM rt_closures c,scope s WHERE c.store_id=s.store_id AND c.archived_at IS NULL ORDER BY c.id))),
 'policy',(SELECT a.value FROM account_settings a JOIN rt_stores t ON t.line_account_id=a.line_account_id,scope s WHERE t.id=s.store_id AND a.key='restaurant.table_auto_assignment:'||t.id)
) AS snapshot`;

export async function restaurantSeatCapacity(db: D1Database, storeId: string, startsAt: string, endsAt: string, excludeId = '') {
  let from = startsAt, to = endsAt;
  for (let pass = 0; pass < 16; pass++) {
    const params = [storeId, to, from, excludeId];
    const row = await db.prepare(snapshotSql).bind(...params).first<{ snapshot: string }>();
    const raw = row?.snapshot;
    if (typeof raw !== 'string') throw new Error('restaurant_capacity_unavailable');
    const state = JSON.parse(raw) as SeatPlanState;
    const unassigned = [...state.reservations, ...state.waiting].filter(r => !r.tableIds.length);
    const nextFrom = unassigned.reduce((v, r) => Date.parse(r.startsAt) < Date.parse(v) ? r.startsAt : v, from);
    const nextTo = unassigned.reduce((v, r) => Date.parse(r.endsAt) > Date.parse(v) ? r.endsAt : v, to);
    if (Date.parse(nextFrom) !== Date.parse(from) || Date.parse(nextTo) !== Date.parse(to)) { from = nextFrom; to = nextTo; continue; }
    const guard = db.prepare(`SELECT json(CASE WHEN (${snapshotSql})=? THEN '{}' ELSE 'RESTAURANT_CAPACITY_CHANGED' END)`).bind(...params, raw);
    const isCurrent = async () => (await db.prepare(snapshotSql).bind(...params).first<{ snapshot: string }>())?.snapshot === raw;
    const commit = async (statements: D1PreparedStatement[]) => {
      try { return await db.batch([guard, ...statements]); }
      catch (error) { if (!await isCurrent()) throw new Error('RESTAURANT_CAPACITY_CHANGED'); throw error; }
    };
    return {
      state, settings: parseTableAutomation(state.policy),
      select: (input: SeatPlanInput) => planRestaurantSeats(state, input),
      guard, commit,
    };
  }
  throw new Error('restaurant_capacity_unavailable');
}
