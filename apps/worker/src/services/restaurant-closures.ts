import type { RestaurantClosure, RestaurantClosureInput, RestaurantClosurePreview, RestaurantSeatAvailability } from '@line-crm/shared';
import { restaurantCivilTime, validRestaurantDate } from './restaurant-booking.js';
import { tzDateStr } from './availability.js';
export type ClosurePeriod = { startsAt: string; endsAt: string };
export type ClosureRow = {
 id: string; store_id: string; start_date: string; end_date: string; all_day: number; start_time: string | null; end_time: string | null;
 kind: RestaurantClosure['kind']; memo: string | null; table_ids_json: string; periods_json: string; created_by: string | null;
 notify_media: number; created_by_name: string | null; created_at: string; updated_at: string; version: number; archived_at: string | null;
};
export function publicClosure(r: ClosureRow): RestaurantClosure {
 return {id:r.id,notifyMedia:r.notify_media!==0,name:r.memo||({temporary_closed:'臨時休業',private_event:'貸切',maintenance:'設備点検',other:'その他'}[r.kind]),storeId:r.store_id,startDate:r.start_date,endDate:r.end_date,allDay:!!r.all_day,startTime:r.start_time,endTime:r.end_time,
 kind:r.kind,memo:r.memo,tableIds:JSON.parse(r.table_ids_json),createdBy:r.created_by,createdByName:r.created_by_name,createdAt:r.created_at,updatedAt:r.updated_at,version:r.version};
}
const minute = (t:string) => Number(t.slice(0,2))*60+Number(t.slice(3));
export function validateClosure(b:unknown,timezone:string,now=new Date()): {input:RestaurantClosureInput;periods:ClosurePeriod[]} | null {
 if(!b||typeof b!=='object')return null;
 const r=b as RestaurantClosureInput;
 if(typeof r.storeId!=='string'||!r.storeId||typeof r.startDate!=='string'||typeof r.endDate!=='string'
 ||!validRestaurantDate(r.startDate)||!validRestaurantDate(r.endDate)||r.startDate<tzDateStr(timezone,now)||r.endDate<r.startDate
 ||Date.parse(r.endDate)-Date.parse(r.startDate)>365*86400000||typeof r.allDay!=='boolean'
 ||!['temporary_closed','private_event','maintenance','other'].includes(r.kind)
 ||(r.notifyMedia!==undefined&&typeof r.notifyMedia!=='boolean')
 ||(r.memo!=null&&(typeof r.memo!=='string'||r.memo.length>1000))
 ||(r.tableIds!==undefined&&(!Array.isArray(r.tableIds)||r.tableIds.length>1000||r.tableIds.some(t=>typeof t!=='string'||!t)||new Set(r.tableIds).size!==r.tableIds.length)))return null;
 if(!r.allDay&&(typeof r.startTime!=='string'||typeof r.endTime!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.startTime)
 ||!/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(r.endTime)||minute(r.startTime)>=minute(r.endTime)))return null;
 const input:RestaurantClosureInput={notifyMedia:r.notifyMedia??true,storeId:r.storeId,startDate:r.startDate,endDate:r.endDate,allDay:r.allDay,
 startTime:r.allDay?null:r.startTime,endTime:r.allDay?null:r.endTime,kind:r.kind,memo:r.memo?.trim()||null,tableIds:r.tableIds??[]};
 const periods:ClosurePeriod[]=[];
 for(let d=Date.parse(r.startDate);d<=Date.parse(r.endDate);d+=86400000){const date=new Date(d).toISOString().slice(0,10);
  periods.push({startsAt:restaurantCivilTime(date,r.allDay?0:minute(r.startTime!),timezone),endsAt:restaurantCivilTime(date,r.allDay?1440:minute(r.endTime!),timezone)});}
 return {input,periods};
}
export async function closuresForRange(db:D1Database,storeId:string,from:string,to:string):Promise<ClosureRow[]> {
 return (await db.prepare(`SELECT c.* FROM rt_closures c WHERE c.store_id=? AND c.archived_at IS NULL AND EXISTS(
 SELECT 1 FROM json_each(c.periods_json) p WHERE julianday(json_extract(p.value,'$.startsAt'))<julianday(?) AND julianday(json_extract(p.value,'$.endsAt'))>julianday(?)) ORDER BY c.start_date,c.start_time,c.id`)
 .bind(storeId,to,from).all<ClosureRow>()).results;
}
export function closureAffectsTable(r:ClosureRow,tableId:string|null):boolean {
 const ids=JSON.parse(r.table_ids_json) as string[];return !ids.length||tableId===null||ids.includes(tableId);
}
export function restaurantClosureSnapshotQuery(input: RestaurantClosureInput, periods: ClosurePeriod[]) {
 const ids=JSON.stringify(input.tableIds??[]);
 const sql=`SELECT json_group_array(json_object('id',id,'revision',revision)) FROM (
   SELECT r.id,r.confirmation_revision revision FROM rt_reservations r WHERE r.store_id=?
   AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND r.hold_expires_at IS NULL
   AND EXISTS(SELECT 1 FROM json_each(?) p WHERE julianday(r.starts_at)<julianday(json_extract(p.value,'$.endsAt')) AND julianday(r.ends_at)>julianday(json_extract(p.value,'$.startsAt')))
   AND (json_array_length(?)=0 OR r.table_id IS NULL OR EXISTS(SELECT 1 FROM rt_reservation_table_links l WHERE l.reservation_id=r.id AND l.table_id IN (SELECT value FROM json_each(?)))) ORDER BY r.id
 )`;
 return {sql,binds:[input.storeId,JSON.stringify(periods),ids,ids]};
}

export async function closurePreview(db:D1Database,input:RestaurantClosureInput,periods:ClosurePeriod[],excludeId:string|null=null):Promise<RestaurantClosurePreview> {
 const args=[input.storeId,JSON.stringify(periods),JSON.stringify(input.tableIds??[])];
 const overlap=`EXISTS(SELECT 1 FROM json_each(?) p WHERE julianday(r.starts_at)<julianday(json_extract(p.value,'$.endsAt')) AND julianday(r.ends_at)>julianday(json_extract(p.value,'$.startsAt')))
 AND (json_array_length(?)=0 OR r.table_id IS NULL OR EXISTS(SELECT 1 FROM rt_reservation_table_links l WHERE l.reservation_id=r.id AND l.table_id IN (SELECT value FROM json_each(?))))`;
 const reservations=(await db.prepare(`SELECT r.id,r.confirmation_revision AS confirmationRevision,r.starts_at AS startsAt,r.ends_at AS endsAt,r.guest_count AS guestCount,r.customer_name AS customerName,r.customer_phone AS customerPhone,r.source,r.table_id AS tableId,
 (SELECT f.id FROM friends f JOIN rt_stores s ON s.line_account_id=f.line_account_id WHERE s.id=r.store_id AND f.line_user_id=r.line_uid AND f.is_following=1 LIMIT 1) AS friendId
 FROM rt_reservations r WHERE r.store_id=? AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL AND r.hold_expires_at IS NULL AND ${overlap} ORDER BY julianday(r.starts_at),r.id`)
 .bind(...args,args[2]).all<Omit<RestaurantClosurePreview['reservations'][number],'isLineFriend'|'contacted'>>()).results;
 const waiting=await db.prepare(`SELECT COUNT(*) AS count FROM (SELECT w.*,COALESCE(w.ends_at,datetime(w.starts_at,'+120 minutes')) AS end_time FROM rt_seat_waitlist w) r
 WHERE r.store_id=? AND r.status IN ('waiting','invited') AND EXISTS(SELECT 1 FROM json_each(?) p WHERE julianday(r.starts_at)<julianday(json_extract(p.value,'$.endsAt')) AND julianday(r.end_time)>julianday(json_extract(p.value,'$.startsAt')))
 AND (json_array_length(?)=0 OR r.table_id IS NULL OR EXISTS(SELECT 1 FROM rt_seat_waitlist_table_links l WHERE l.waitlist_id=r.id AND l.table_id IN (SELECT value FROM json_each(?))))`).bind(...args,args[2]).first<{count:number}>();
 const candidates=await closuresForRange(db,input.storeId,periods[0].startsAt,periods.at(-1)!.endsAt);
 const conflicts=candidates.filter(r=>r.id!==excludeId&&(input.tableIds!.length===0||JSON.parse(r.table_ids_json).length===0||input.tableIds!.some(id=>closureAffectsTable(r,id)))
 &&(JSON.parse(r.periods_json) as ClosurePeriod[]).some(a=>periods.some(b=>Date.parse(a.startsAt)<Date.parse(b.endsAt)&&Date.parse(a.endsAt)>Date.parse(b.startsAt)))).map(publicClosure);
 const closure=excludeId?await db.prepare('SELECT created_at FROM rt_closures WHERE id=? AND store_id=?').bind(excludeId,input.storeId).first<{created_at:string}>():null;
 const results=[];
 for(const r of reservations) {
  // 手動の送信成功だけが messages_log に載る。既存のタイムゾーンなしJST記録はUTCへ直す。
  const sent=closure&&r.friendId?await db.prepare(`SELECT 1 FROM messages_log WHERE friend_id=? AND source='manual' AND direction='outgoing' AND sent_by_staff_id IS NOT NULL
   AND julianday(CASE WHEN created_at GLOB '*Z' OR substr(created_at,-6,1) IN ('+','-') THEN created_at ELSE datetime(created_at,'-9 hours') END)>julianday(?) LIMIT 1`).bind(r.friendId,closure.created_at).first():null;
  results.push({...r,isLineFriend:r.friendId!==null,contacted:!!sent});
 }
 return {reservations:results,contactedCount:results.filter(r=>r.contacted).length,waitlistCount:waiting?.count??0,conflicts};
}
/** 空き照会・手動の自動配席・待機登録で共通。予約で埋まっていても閉じていない卓は候補に残せる。 */
export async function openSeatTables(db:D1Database,storeId:string,startsAt:string,endsAt:string,guestCount:number,ignoreReservations=false,excludeReservationId=''):Promise<RestaurantSeatAvailability['tables']> {
 const closed=await closuresForRange(db,storeId,startsAt,endsAt);
 const tables=(await db.prepare(`SELECT t.id,t.label,t.seat_type AS seatType,t.min_capacity AS minCapacity,t.max_capacity AS maxCapacity,t.join_group FROM rt_tables t
 WHERE t.store_id=? AND t.is_active=1
 AND (?=1 OR (NOT EXISTS(SELECT 1 FROM rt_reservations r JOIN rt_reservation_table_links l ON l.reservation_id=r.id WHERE r.store_id=t.store_id AND r.id<>? AND l.table_id=t.id AND r.status NOT IN ('cancelled','no_show') AND r.departed_at IS NULL
 AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(?) AND julianday(r.ends_at)>julianday(?))
 AND NOT EXISTS(SELECT 1 FROM rt_seat_waitlist w JOIN rt_seat_waitlist_table_links l ON l.waitlist_id=w.id WHERE w.store_id=t.store_id AND l.table_id=t.id AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now')
 AND julianday(w.starts_at)<julianday(?) AND julianday(COALESCE(w.ends_at,datetime(w.starts_at,'+120 minutes')))>julianday(?)))) ORDER BY t.max_capacity,t.id`)
 .bind(storeId,Number(ignoreReservations),excludeReservationId,endsAt,startsAt,endsAt,startsAt).all<RestaurantSeatAvailability['tables'][number]&{join_group:string|null}>()).results;
 const open=tables.filter(t=>!closed.some(r=>closureAffectsTable(r,t.id)));
 const candidates:RestaurantSeatAvailability['tables']=open.filter(t=>t.minCapacity<=guestCount&&t.maxCapacity>=guestCount);
 const groups=new Set(open.map(t=>t.join_group).filter(Boolean));
 // 全構成卓が空いている組だけ。片方が塞がれた組を縮めて使わない。
 const all=(await db.prepare('SELECT id,join_group,is_active FROM rt_tables WHERE store_id=?').bind(storeId).all<{id:string;join_group:string|null;is_active:number}>()).results;
 for(const group of groups){const members=open.filter(t=>t.join_group===group);
 if(members.length<2||all.filter(t=>t.join_group===group).some(t=>!members.some(m=>m.id===t.id)))continue;
 const min=members.reduce((n,t)=>n+t.minCapacity,0),max=members.reduce((n,t)=>n+t.maxCapacity,0);
 if(guestCount>=min&&guestCount<=max&&members.every(t=>t.maxCapacity<guestCount))candidates.push({...members[0],tableIds:members.map(t=>t.id),label:members.map(t=>t.label).join('＋'),minCapacity:min,maxCapacity:max});}
 return candidates.sort((a,b)=>a.maxCapacity-b.maxCapacity||a.id.localeCompare(b.id));
}

/** カレンダーの時間セルごとに照会せず、席の使用状況を一度だけ取得する。 */
export async function openSeatTablePeriods(
  db: D1Database,
  storeId: string,
  periods: ClosurePeriod[],
  guestCount: number,
) {
  if (!periods.length) return [];
  const from = periods.reduce(
    (v, p) => (p.startsAt < v ? p.startsAt : v),
    periods[0].startsAt,
  );
  const to = periods.reduce(
    (v, p) => (p.endsAt > v ? p.endsAt : v),
    periods[0].endsAt,
  );
  const tables = (
    await db
      .prepare(
        'SELECT id,label,seat_type seatType,min_capacity minCapacity,max_capacity maxCapacity,join_group,is_active FROM rt_tables WHERE store_id=? ORDER BY max_capacity,id',
      )
      .bind(storeId)
      .all<
        RestaurantSeatAvailability['tables'][number] & {
          join_group: string | null;
          is_active: number;
        }
      >()
  ).results;
  const closed = await closuresForRange(db, storeId, from, to);
  const busy = (
    await db
      .prepare(
        `SELECT l.table_id,strftime('%Y-%m-%dT%H:%M:%fZ',r.starts_at) starts_at,strftime('%Y-%m-%dT%H:%M:%fZ',r.ends_at) ends_at FROM rt_reservations r JOIN rt_reservation_table_links l ON l.reservation_id=r.id
  WHERE r.store_id=? AND r.status NOT IN('cancelled','no_show') AND r.departed_at IS NULL
  AND (r.status<>'pending' OR r.hold_expires_at IS NULL OR julianday(r.hold_expires_at)>julianday('now')) AND julianday(r.starts_at)<julianday(?) AND julianday(r.ends_at)>julianday(?)
  UNION ALL SELECT l.table_id,strftime('%Y-%m-%dT%H:%M:%fZ',w.starts_at),strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(w.ends_at,datetime(w.starts_at,'+120 minutes'))) FROM rt_seat_waitlist w JOIN rt_seat_waitlist_table_links l ON l.waitlist_id=w.id
  WHERE w.store_id=? AND w.status='invited' AND julianday(w.hold_expires_at)>julianday('now') AND julianday(w.starts_at)<julianday(?) AND julianday(COALESCE(w.ends_at,datetime(w.starts_at,'+120 minutes')))>julianday(?)`,
      )
      .bind(storeId, to, from, storeId, to, from)
      .all<{ table_id: string; starts_at: string; ends_at: string }>()
  ).results;
  const at = (v: string) =>
    Date.parse(
      /(?:Z|[+-]\d\d:\d\d)$/.test(v) ? v : v.replace(' ', 'T') + '+09:00',
    );
  return periods.map((period) => {
    const a = at(period.startsAt),
      b = at(period.endsAt);
    const open = tables.filter(
      (t) =>
        t.is_active &&
        !busy.some(
          (r) =>
            r.table_id === t.id && at(r.starts_at) < b && at(r.ends_at) > a,
        ) &&
        !closed.some(
          (c) =>
            closureAffectsTable(c, t.id) &&
            (JSON.parse(c.periods_json) as ClosurePeriod[]).some(
              (p) => at(p.startsAt) < b && at(p.endsAt) > a,
            ),
        ),
    );
    const options: RestaurantSeatAvailability['tables'] = open.filter(
      (t) => t.minCapacity <= guestCount && t.maxCapacity >= guestCount,
    );
    for (const group of new Set(
      open.map((t) => t.join_group).filter(Boolean),
    )) {
      const members = open.filter((t) => t.join_group === group);
      if (
        members.length < 2 ||
        tables
          .filter((t) => t.join_group === group)
          .some((t) => !members.some((m) => m.id === t.id))
      )
        continue;
      const min = members.reduce((n, t) => n + t.minCapacity, 0),
        max = members.reduce((n, t) => n + t.maxCapacity, 0);
      if (
        guestCount >= min &&
        guestCount <= max &&
        members.every((t) => t.maxCapacity < guestCount)
      )
        options.push({
          ...members[0],
          tableIds: members.map((t) => t.id),
          label: members.map((t) => t.label).join('＋'),
          minCapacity: min,
          maxCapacity: max,
        });
    }
    return {
      ...period,
      tables: options.sort(
        (a, b) => a.maxCapacity - b.maxCapacity || a.id.localeCompare(b.id),
      ),
    };
  });
}
