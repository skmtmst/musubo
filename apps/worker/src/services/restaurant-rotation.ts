import { restaurantCivilTime, validRestaurantDate } from './restaurant-booking.js';
import { closuresForRange, closureAffectsTable } from './restaurant-closures.js';
import { addDays, reservationInstant, type RestaurantOpeningDay } from '@line-crm/shared';
import { connectedGoogleProfile, googleOpeningDay } from './restaurant-google-hours-source.js';

type Interval=[number,number];
function union(intervals:Interval[]):Interval[] {const out:Interval[]=[];for(const range of intervals.sort((a,b)=>a[0]-b[0])){const last=out.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else if(range[1]>range[0])out.push([...range]);}return out;}
function subtract(open:Interval[],closed:Interval[]):Interval[] {let remaining=union(open);for(const [from,to] of union(closed))remaining=remaining.flatMap(([a,b])=>to<=a||from>=b?[[a,b]] as Interval[]:[[a,Math.min(b,from)],[Math.max(a,to),b]].filter(([x,y])=>y>x) as Interval[]);return remaining;}
const length=(xs:Interval[])=>union(xs).reduce((sum,[a,b])=>sum+b-a,0);
export async function restaurantRotation(db:D1Database,storeId:string,date:string,now=Date.now()) {
 if(!validRestaurantDate(date))throw new Error('invalid_date');
 const store=await db.prepare('SELECT timezone FROM rt_stores WHERE id=?').bind(storeId).first<{timezone:string}>();if(!store)throw new Error('store_missing');
 const setting=await db.prepare('SELECT hours_json FROM rt_opening_hours_settings WHERE store_id=?').bind(storeId).first<{hours_json:string}>();
 const googleConnection=await db.prepare('SELECT status FROM rt_google_connections WHERE store_id=?').bind(storeId).first<{status:string}>();
 const googleProfile=googleConnection?await connectedGoogleProfile(db,storeId):null;
 const hasHours=googleConnection?Boolean(googleProfile):Boolean(setting);
 const from=restaurantCivilTime(date,0,store.timezone),to=restaurantCivilTime(date,1440,store.timezone),start=Date.parse(from),end=Date.parse(to);
 const minute=(t:string)=>Number(t.slice(0,2))*60+Number(t.slice(3));
 const localWeek=setting&&!googleConnection?JSON.parse(setting.hours_json) as RestaurantOpeningDay[]:[];
 const previousDate=addDays(date,-1);
 const operating:Interval[]=[previousDate,date].flatMap(openDate=>{
  const weekday=new Date(`${openDate}T00:00:00Z`).getUTCDay();
  const periods=googleConnection?(googleProfile?googleOpeningDay(googleProfile,openDate):null):localWeek.find(d=>d.weekday===weekday)?.periods??[];
  return (periods??[]).flatMap(p=>{
   const opens=minute(p.opensAt),closes=minute(p.closesAt)+(minute(p.closesAt)<opens?1440:0);
   const a=Math.max(start,Date.parse(restaurantCivilTime(openDate,opens,store.timezone)));
   const b=Math.min(end,Date.parse(restaurantCivilTime(openDate,closes,store.timezone)));
   return b>a?[[a,b] as Interval]:[];
  });
 });
 const tables=(await db.prepare('SELECT id FROM rt_tables WHERE store_id=? AND is_active=1').bind(storeId).all<{id:string}>()).results;
 const closures=await closuresForRange(db,storeId,from,to);
 const open=new Map(tables.map(t=>[t.id,subtract(operating,closures.filter(c=>closureAffectsTable(c,t.id)).flatMap(c=>(JSON.parse(c.periods_json) as Array<{startsAt:string;endsAt:string}>).map(p=>[Date.parse(p.startsAt),Date.parse(p.endsAt)] as Interval)))]));
 const visits=(await db.prepare(`SELECT r.id,r.departed_at,(SELECT MIN(marked_at) FROM rt_seat_visit_marks WHERE reservation_id=r.id AND kind='visited' AND undone_at IS NULL) AS arrived_at,
 (SELECT json_group_array(table_id) FROM rt_reservation_table_links WHERE reservation_id=r.id) AS tables_json
 FROM rt_reservations r WHERE r.store_id=? AND r.status IN('visited','seated')`).bind(storeId).all<{id:string;departed_at:string|null;arrived_at:string|null;tables_json:string}>()).results;
 const completed=visits.filter(v=>v.arrived_at&&v.departed_at&&Date.parse(reservationInstant(v.departed_at))>=start&&Date.parse(reservationInstant(v.departed_at))<end);
 const stay=completed.map(v=>(Date.parse(reservationInstant(v.departed_at!))-Date.parse(reservationInstant(v.arrived_at!)))/60000).filter(n=>n>=0);
 const occupied=new Map<string,Interval[]>();
 for(const visit of visits){if(!visit.arrived_at)continue;const a=Date.parse(reservationInstant(visit.arrived_at)),b=visit.departed_at?Date.parse(reservationInstant(visit.departed_at)):now;
  for(const id of JSON.parse(visit.tables_json) as string[])for(const [x,y] of open.get(id)??[]){const clip:[number,number]=[Math.max(a,x,start),Math.min(b,y,end,now)];if(clip[1]>clip[0])occupied.set(id,[...occupied.get(id)??[],clip]);}}
 const denominator=[...open.values()].reduce((sum,x)=>sum+length(x),0),activeTables=[...open.values()].filter(x=>length(x)>0).length;
 const unmeasured=visits.filter(v=>!v.arrived_at&&(!v.departed_at||Date.parse(reservationInstant(v.departed_at))>=start)).length;
 const bookings=await db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN status='no_show' THEN 1 ELSE 0 END) AS no_shows FROM rt_reservations WHERE store_id=? AND status<>'cancelled' AND hold_expires_at IS NULL AND julianday(starts_at)>=julianday(?) AND julianday(starts_at)<julianday(?)`).bind(storeId,from,to).first<{total:number;no_shows:number|null}>();
 return {date,activeTables,openTableMinutes:hasHours?denominator/60000:null,occupiedTableMinutes:hasHours&&!unmeasured?[...occupied.values()].reduce((sum,x)=>sum+length(x),0)/60000:null,measuredDepartures:stay.length,totalStayMinutes:stay.reduce((a,b)=>a+b,0),departedGroups:completed.length,turnover:hasHours&&activeTables?completed.length/activeTables:null,
  utilization:hasHours&&denominator&&!unmeasured?[...occupied.values()].reduce((sum,x)=>sum+length(x),0)/denominator:null,
  averageStayMinutes:stay.length?stay.reduce((a,b)=>a+b,0)/stay.length:null,noShowRate:bookings?.total?(bookings.no_shows??0)/bookings.total:null,unmeasuredVisits:unmeasured};
}
