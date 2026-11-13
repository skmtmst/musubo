import { liffBookingInputError, liffBookingJson } from '../liff-booking-response.js';
import { logger } from '@line-crm/shared/server';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { inputJsonBoundary } from '../../lib/input-errors.js';
import { openSeatTables, closuresForRange, closureAffectsTable } from '../../services/restaurant-closures.js';
import { explainBookingSlot, getAccountTimeZone, tzDateStr, tzHHMM } from '../../services/availability.js';
import { finishExpiredWaitlists, promoteBookingWaitlist } from '../../features/booking/booking-waitlist/index.js';
import { insertSeatWaitlistEntry } from '../restaurant-test.js';
import { restaurantTestEnabled } from '../../lib/environment-features.js';
import { validateInboundReservation } from '../../services/restaurant-test.js';
import { resolveSelfBookingCaller } from './identity.js';
import { googleCredentials } from './availability.js';
import { insertWaitlistEntry, WAITLIST_ERROR_STATUS } from './waitlist-input.js';

export function registerWaitlistLiff(booking: Hono<Env>): void {
booking.post('/api/liff/booking/waitlist', inputJsonBoundary(), async (c) => {
  const caller = await resolveSelfBookingCaller(c);
  if (!caller.ok) return liffBookingInputError(c, { error: caller.error }, caller.status, []);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return liffBookingInputError(c, { error: 'invalid_json' }, 400, []);
  const start=typeof body.starts_at==='string'?new Date(body.starts_at):new Date(NaN);
  if(!Number.isFinite(start.getTime()))return liffBookingInputError(c, {error:'invalid_starts_at'}, 400, ["starts_at"]);
  if(start.getTime()<=Date.now()+60*60_000)return liffBookingJson(c, {error:'registration_closed'},409);
  const tz=await getAccountTimeZone(c.env.DB,caller.accountId),date=tzDateStr(tz,start);
  const check=await explainBookingSlot(c.env.DB,{lineAccountId:caller.accountId,menuId:String(body.menu_id??''),staffId:String(body.staff_id??''),date,time:tzHHMM(tz,start),now:new Date(),minLeadTimeMinutes:0,waitlistOffer:true,applyStoreRules:true,googleCredentials:googleCredentials(c.env)});
  const full=check.per_staff.find(s=>s.staff_id===body.staff_id);
  const fullReasons=new Set(['other_booking','capacity_full','google_busy','store_full','resource_shortage']);
  if(!full||full.bookable||!full.reasons.length||full.reasons.some(reason=>!fullReasons.has(reason)))return liffBookingJson(c, {error:'slot_not_full'},409);
  const result = await insertWaitlistEntry(c.env.DB, {
    lineAccountId: caller.accountId,
    staffId: typeof body.staff_id === 'string' ? body.staff_id : '',
    menuId: typeof body.menu_id === 'string' ? body.menu_id : '',
    startsAt: typeof body.starts_at === 'string' ? body.starts_at : '',
    friendId: caller.friendId,
    bookingCustomerId: null,
  });
  if (!result.ok) return liffBookingInputError(c, { error: result.error }, WAITLIST_ERROR_STATUS[result.error] as 400 | 404 | 409, []);
  return liffBookingJson(c, { id: result.id }, 201);
});

booking.delete('/api/liff/booking/waitlist/:id', async (c) => {
  const caller = await resolveSelfBookingCaller(c);
  if (!caller.ok) return liffBookingInputError(c, { error: caller.error }, caller.status, []);
  const id = c.req.param('id');
  const entry = await c.env.DB
    .prepare(`SELECT staff_id, starts_at, status FROM booking_waitlist
      WHERE id = ? AND line_account_id = ? AND friend_id = ?`)
    .bind(id, caller.accountId, caller.friendId)
    .first<{ staff_id: string; starts_at: string; status: string }>();
  if (!entry || (entry.status !== 'waiting' && entry.status !== 'invited')) {
    return liffBookingJson(c, { error: 'not_found' }, 404);
  }
  const wasInvited = entry.status === 'invited';
  const updated = await c.env.DB
    .prepare(`UPDATE booking_waitlist SET status = 'cancelled',
                  updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
      WHERE id = ? AND status IN ('waiting', 'invited')`)
    .bind(id)
    .run();
  if ((updated.meta?.changes ?? 0) === 0) return liffBookingJson(c, { error: 'not_found' }, 404);
  if (wasInvited) {
    // 見送りで仮押さえが空いたら、次の人へすぐ回す。
    try {
      await promoteBookingWaitlist(c.env.DB, {
        lineAccountId: caller.accountId,
        staffId: entry.staff_id,
        startsAt: entry.starts_at,
      }, undefined, c.env.LIFF_URL ?? '',c.env);
    } catch {
      logger.error("booking.promote_waitlist_failed");
    }
  }
  return liffBookingJson(c, { status: 'cancelled' });
});

/**
 * 自分のキャンセル待ち一覧（お客さまの予約画面用）。
 * M6 の LIFF 画面が「空き枠入りで開く」「取り消しの確認」に使う。
 */
booking.get('/api/liff/booking/waitlist', async (c) => {
  const caller = await resolveSelfBookingCaller(c);
  if (!caller.ok) return liffBookingInputError(c, { error: caller.error }, caller.status, []);
  await finishExpiredWaitlists(c.env.DB,caller.accountId);
  const rows = await c.env.DB
    .prepare(
      `SELECT w.id, w.staff_id, w.menu_id, w.starts_at, w.status,CASE WHEN w.status='waiting' THEN (SELECT count(*) FROM booking_waitlist older WHERE older.line_account_id=w.line_account_id AND older.staff_id=w.staff_id AND julianday(older.starts_at)=julianday(w.starts_at) AND older.status='waiting' AND (older.created_at<w.created_at OR older.created_at=w.created_at AND older.id<=w.id)) ELSE NULL END AS position,
              w.hold_minutes, w.invited_at, w.hold_expires_at, w.created_at,w.ends_at,
              m.name AS menu_name, s.display_name AS staff_name
         FROM booking_waitlist w
         INNER JOIN menus m ON m.id = w.menu_id
         INNER JOIN staff s ON s.id = w.staff_id
        WHERE w.line_account_id = ? AND w.friend_id = ? AND (? IS NULL OR w.id=?)

        ORDER BY w.starts_at DESC, w.created_at ASC LIMIT 50`,
    )
    .bind(caller.accountId, caller.friendId,c.req.query('id')??null,c.req.query('id')??null)
    .all();
  return liffBookingJson(c, { waitlist: rows.results });
});

booking.get('/api/liff/booking/seat-waitlist',async(c)=>{
 const caller=await resolveSelfBookingCaller(c);if(!caller.ok)return liffBookingInputError(c, {error:caller.error}, caller.status, []);
 if(!restaurantTestEnabled(c.env))return liffBookingJson(c, {error:'not_found'},404);
 await finishExpiredWaitlists(c.env.DB,caller.accountId);
 const rows=await c.env.DB.prepare(`SELECT w.id,w.store_id,w.starts_at,w.ends_at,w.guest_count,w.status,w.hold_minutes,w.hold_expires_at,w.created_at,s.name store_name FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id WHERE s.line_account_id=? AND w.line_uid=? AND (? IS NULL OR w.id=?) ORDER BY w.starts_at DESC,w.created_at LIMIT 100`).bind(caller.accountId,caller.lineUserId,c.req.query('id')??null,c.req.query('id')??null).all();
 return liffBookingJson(c, {waitlist:rows.results});
});

booking.post('/api/liff/booking/seat-waitlist',inputJsonBoundary({"store_id":["string"],"starts_at":["string"],"guest_count":["number"]}), async(c)=>{
 const caller=await resolveSelfBookingCaller(c);if(!caller.ok)return liffBookingInputError(c, {error:caller.error}, caller.status, []);
 if(!restaurantTestEnabled(c.env))return liffBookingJson(c, {error:'not_found'},404);
 const body=await c.req.json<{store_id?:string;starts_at?:string;guest_count?:number}>().catch(()=>null);if(!body)return liffBookingInputError(c, {error:'invalid_json'}, 400, []);
 const store=await c.env.DB.prepare(`SELECT id FROM rt_stores WHERE id=? AND line_account_id=? AND status='active'`).bind(body.store_id??'',caller.accountId).first<{id:string}>();
 if(!store)return liffBookingJson(c, {error:'not_found'},404);
 const starts=typeof body.starts_at==='string'?Date.parse(body.starts_at):NaN;
 if(!Number.isFinite(starts))return liffBookingInputError(c, {error:'invalid_starts_at'}, 400, ["starts_at"]);
 if(starts<=Date.now()+60*60_000)return liffBookingJson(c, {error:'registration_closed'},409);
 const count=body.guest_count;if(!Number.isInteger(count)||!count||count<1||count>100)return liffBookingInputError(c, {error:'invalid_party'}, 400, ["guest_count"]);
 const end=new Date(starts+120*60_000).toISOString(),start=new Date(starts).toISOString();
 const fitting=await openSeatTables(c.env.DB,store.id,start,end,count,true);
 if(!fitting.length){
  if((await closuresForRange(c.env.DB,store.id,start,end)).length)return liffBookingJson(c, {error:'closure_conflict',reason:'臨時休業・貸切のため受付できません'},409);
  return liffBookingInputError(c, {error:'invalid_slot'}, 400, ["store_id","starts_at","guest_count"]);
 }
 // 閉じていない卓だけで満席を判定する。一部貸切の空卓を「予約できる」と数えない。
 if((await openSeatTables(c.env.DB,store.id,start,end,count)).length)return liffBookingJson(c, {error:'slot_not_full'},409);
 const friend=await c.env.DB.prepare('SELECT display_name FROM friends WHERE id=? AND line_account_id=?').bind(caller.friendId,caller.accountId).first<{display_name:string|null}>();
 const result=await insertSeatWaitlistEntry(c.env.DB,{storeId:store.id,startsAt:start,endsAt:end,guestCount:count,customerName:friend?.display_name||'LINEのお客さま',customerPhone:null,lineUid:caller.lineUserId});
 return result.ok?liffBookingJson(c, {id:result.id},201):liffBookingInputError(c, {error:result.error}, result.error==='already_waiting'||result.error==='registration_closed'||result.error==='waitlist_limit'||result.error==='closure_conflict'?409:400, []);
});

booking.delete('/api/liff/booking/seat-waitlist/:id',async(c)=>{
 const caller=await resolveSelfBookingCaller(c);if(!caller.ok)return liffBookingInputError(c, {error:caller.error}, caller.status, []);
 if(!restaurantTestEnabled(c.env))return liffBookingJson(c, {error:'not_found'},404);
 const result=await c.env.DB.prepare(`UPDATE rt_seat_waitlist SET confirmation_revision=confirmation_revision+1, status='cancelled',updated_at=? WHERE id=? AND line_uid=? AND store_id IN (SELECT id FROM rt_stores WHERE line_account_id=?) AND status IN ('waiting','invited')`).bind(new Date().toISOString(),c.req.param('id'),caller.lineUserId,caller.accountId).run();
 return result.meta.changes?liffBookingJson(c, {status:'cancelled'}):liffBookingJson(c, {error:'not_found'},404);
});

booking.post('/api/liff/booking/seat-waitlist/:id/accept',inputJsonBoundary(), async(c)=>{
 const caller=await resolveSelfBookingCaller(c);if(!caller.ok)return liffBookingInputError(c, {error:caller.error}, caller.status, []);
 if(!restaurantTestEnabled(c.env))return liffBookingJson(c, {error:'not_found'},404);
 const key=c.req.header('Idempotency-Key');if(!key)return liffBookingInputError(c, {error:'missing_idempotency_key'},400, []);
 const id=c.req.param('id');
 const entry=await c.env.DB.prepare(`SELECT w.* FROM rt_seat_waitlist w JOIN rt_stores s ON s.id=w.store_id WHERE w.id=? AND w.line_uid=? AND s.line_account_id=? AND s.status='active'`).bind(id,caller.lineUserId,caller.accountId).first<{store_id:string;table_id:string;starts_at:string;ends_at:string;guest_count:number;customer_name:string;status:string;hold_expires_at:string}>();
 if(!entry)return liffBookingJson(c, {error:'not_found'},404);
 const existing=await c.env.DB.prepare('SELECT id,status FROM rt_reservations WHERE store_id=? AND waitlist_entry_id=? AND line_uid=?').bind(entry.store_id,id,caller.lineUserId).first<{id:string;status:string}>();
 if(existing)return liffBookingJson(c, {reservation_id:existing.id,status:existing.status});
 if(entry.status!=='invited'||Date.parse(entry.hold_expires_at)<=Date.now())return liffBookingJson(c, {error:'offer_expired'},409);
 const checked=validateInboundReservation({externalId:`waitlist:${id}`,customerName:entry.customer_name,lineUid:caller.lineUserId,guestCount:entry.guest_count,startsAt:entry.starts_at,endsAt:entry.ends_at,status:'confirmed'});
 if(!checked.ok)return liffBookingInputError(c, {error:checked.error}, 400, []);
 const table=await c.env.DB.prepare('SELECT id FROM rt_tables WHERE id=? AND store_id=? AND is_active=1 AND min_capacity<=? AND max_capacity>=?').bind(entry.table_id,entry.store_id,entry.guest_count,entry.guest_count).first();
 if(!table)return liffBookingJson(c, {error:'slot_conflict'},409);
 const closed=await closuresForRange(c.env.DB,entry.store_id,entry.starts_at,entry.ends_at);
 if(closed.some(r=>closureAffectsTable(r,entry.table_id)))return liffBookingJson(c, {error:'closure_conflict',reason:'臨時休業・貸切のため受付できません'},409);
 const reservationId=crypto.randomUUID();
 try { await c.env.DB.batch([
 c.env.DB.prepare(`INSERT INTO rt_reservations(id,store_id,source,external_id,customer_name,line_uid,guest_count,starts_at,ends_at,table_id,status,waitlist_entry_id) VALUES(?,?,'line',?,?,?,?,?,?,?,'confirmed',?)`).bind(reservationId,entry.store_id,`waitlist:${id}`,entry.customer_name,caller.lineUserId,entry.guest_count,entry.starts_at,entry.ends_at,entry.table_id,id),
 c.env.DB.prepare(`UPDATE rt_inventory_slots SET reserved_count=COALESCE((SELECT SUM(r.guest_count) FROM rt_reservations r WHERE r.store_id=rt_inventory_slots.store_id AND r.status NOT IN ('cancelled','no_show') AND julianday(r.starts_at)<julianday(rt_inventory_slots.starts_at,'+'||rt_inventory_slots.slot_minutes||' minutes') AND julianday(r.ends_at)>julianday(rt_inventory_slots.starts_at)),0) WHERE store_id=?`).bind(entry.store_id),
 ]);
 }catch(error){if(String(error).includes('closure_conflict'))return liffBookingJson(c, {error:'closure_conflict',reason:'臨時休業・貸切のため受付できません'},409);throw error;}
 return liffBookingJson(c, {reservation_id:reservationId,status:'confirmed'},201);
});

/**
 * 前回と同じで予約（LIFF）：本人の「前回の予約（メニュー・担当）」を返す。
 *
 * 管理の /api/booking/admin/last-booking と同じ決めごと。友だち本人に
 * 絞る（idToken 検証ずみ）。前回の担当が辞めた・メニューが止まっている
 * ときは返さない（available=false）。写真は担当の顔写真を使う
 * （メニューに写真は無い）。
 */
booking.get('/api/liff/booking/last-booking', async (c) => {
  const caller = await resolveSelfBookingCaller(c);
  if (!caller.ok) return liffBookingInputError(c, { error: caller.error }, caller.status, []);
  const row = await c.env.DB
    .prepare(
      `SELECT b.id, b.starts_at, b.status,
              m.id AS menu_id, m.name AS menu_name, m.is_active AS menu_active,
              m.deleted_at AS menu_deleted_at,
              s.id AS staff_id, s.display_name AS staff_name,
              s.profile_image_url AS staff_image_url,
              s.is_active AS staff_active, s.deleted_at AS staff_deleted_at,
              sm.is_offered AS staff_offers_menu
         FROM bookings b
         INNER JOIN menus m ON m.id = b.menu_id
         INNER JOIN staff s ON s.id = b.staff_id
         LEFT JOIN staff_menus sm ON sm.staff_id = b.staff_id AND sm.menu_id = b.menu_id
        WHERE b.line_account_id = ? AND b.friend_id = ?
          AND b.status NOT IN ('cancelled', 'rejected', 'expired')
        ORDER BY b.starts_at DESC LIMIT 1`,
    )
    .bind(caller.accountId, caller.friendId)
    .first<{
      id: string;
      starts_at: string;
      status: string;
      menu_id: string;
      menu_name: string;
      menu_active: number;
      menu_deleted_at: string | null;
      staff_id: string;
      staff_name: string;
      staff_image_url: string | null;
      staff_active: number;
      staff_deleted_at: string | null;
      staff_offers_menu: number | null;
    }>();
  if (!row) return liffBookingJson(c, { available: false, reason: 'no_history' });
  if (Number(row.menu_active) !== 1 || row.menu_deleted_at !== null) {
    return liffBookingJson(c, { available: false, reason: 'menu_inactive' });
  }
  if (Number(row.staff_active) !== 1 || row.staff_deleted_at !== null) {
    return liffBookingJson(c, { available: false, reason: 'staff_inactive' });
  }
  if (row.staff_offers_menu !== null && Number(row.staff_offers_menu) !== 1) {
    return liffBookingJson(c, { available: false, reason: 'not_offered' });
  }
  return liffBookingJson(c, {
    available: true,
    booking: {
      id: row.id,
      starts_at: row.starts_at,
      status: row.status,
      menu: { id: row.menu_id, name: row.menu_name },
      staff: { id: row.staff_id, display_name: row.staff_name, profile_image_url: row.staff_image_url },
    },
  });
});

/**
 * キャンセル待ちの自分の登録（LIFF）：枠を指定して待っている・
 * 仮押さえ中の登録があれば返す。シートの登録・取り消しの切り替え用。
 */
booking.get('/api/liff/booking/waitlist/mine', async (c) => {
  const caller = await resolveSelfBookingCaller(c);
  if (!caller.ok) return liffBookingInputError(c, { error: caller.error }, caller.status, []);
  const staffId = c.req.query('staff_id')?.trim() || '';
  const menuId = c.req.query('menu_id')?.trim() || '';
  const startsAtRaw = c.req.query('starts_at')?.trim() || '';
  if (!staffId || !menuId || !startsAtRaw) return liffBookingJson(c, { error: 'missing_params' }, 400);
  const startsAtMs = Date.parse(startsAtRaw);
  if (Number.isNaN(startsAtMs)) return liffBookingJson(c, { error: 'invalid_starts_at' }, 400);
  const entry = await c.env.DB
    .prepare(
      `SELECT id, status, created_at,hold_expires_at,hold_minutes FROM booking_waitlist
        WHERE line_account_id = ? AND staff_id = ? AND menu_id = ?
          AND starts_at = ? AND friend_id = ?
          AND status IN ('waiting', 'invited')
        ORDER BY created_at ASC LIMIT 1`,
    )
    .bind(caller.accountId, staffId, menuId, new Date(startsAtMs).toISOString(), caller.friendId)
    .first<{ id: string; status: string; created_at: string }>();
  if (!entry) return liffBookingJson(c, { entry: null });
  return liffBookingJson(c, { entry });
});
}
