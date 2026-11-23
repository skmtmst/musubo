import type { RestaurantReservationAllergy } from './restaurant-reservation-allergies.js';
import { allergyValues } from './fixed-friend-fields.js';
import { maskPhone } from './phone.js';
/** 共通盤。保存先・状態・版は種類ごとの既存契約を保つ。 */
export type ReservationAxis = 'resource' | 'floor' | 'list' | 'month';
export type DiningSnapshot = { allergy: string | null; anniversary: string | null; seatPreference: string | null; courseId: string | null; courseAllergens?: string[]; capturedAt: string };
export interface ReservationBoardEntry {
 id: string; kind: 'people' | 'seats'; version: number; scopeId: string;
 startsAt: string; endsAt: string; status: string; customerName: string;
 guestCount: number; resourceIds: string[]; resourceLabel: string | null;
 contactLabel?:string|null; currentAllergy?:string|null; allergies?: RestaurantReservationAllergy[] | null; source: string; courseName: string | null; note: string | null; dining: DiningSnapshot | null;
 holdExpiresAt: string | null; arrivedAt?: string | null; departedAt?: string | null;
}
export interface ReservationBoardResource { id: string; label: string; active: boolean; capacity: number; groupLabel?: string; }
export interface ReservationBoardPage { entries: ReservationBoardEntry[]; total: number; limit: number; offset: number; }
export type ReservationBoardMove =
 | {kind:'people';expectedVersion:number;startsAt:string;staffId?:string}
 | {kind:'seats';expectedVersion:number;startsAt:string;endsAt:string;tableId:string|null;guestCount?:number};
export interface RestaurantFloor {
 id:string;storeId:string;name:string;width:number;height:number;version:number;
 kind?:'floor'|'area';parentFloorId?:string|null;sortOrder?:number;
 outline: Array<{x:number;y:number}>;
 fixtures: Array<{id:string;kind:'wall'|'entrance'|'kitchen'|'toilet'|'window';x:number;y:number;width:number;height:number}>;
 tables: Array<{joinGroup?:string|null;id:string;x:number;y:number;width:number;height:number;rotation:number;shape:'rectangle'|'circle'|'long'|'counter'|'sofa';seatType?:string;seatDetailType?:string;minCapacity?:number;maxCapacity?:number;smokingPolicy?:'non_smoking'|'smoking'|'heated_tobacco';shoesAllowed?:boolean;partition?:'open'|'semi_private'|'private';acceptsReservations?:boolean;visibleOnMap?:boolean;chairArrangement?:'both'|'one'|'all';chairSide?:'top'|'right'|'bottom'|'left'}>;
}
export type RestaurantFloorWrite = Omit<RestaurantFloor,'version'> & {expectedVersion:number};
/** visited は来店。退店済みは卓を解放し、予定終了は記録として維持する。 */
export function reservationOccupies(status:string,holdExpiresAt:string|null,now=Date.now(),departedAt:string|null=null):boolean {
 return departedAt===null && !['cancelled','no_show'].includes(status) && !(status==='pending'&&holdExpiresAt!==null&&Date.parse(reservationInstant(holdExpiresAt))<=now);
}
export function reservationInstant(value:unknown):string {
 const raw=String(value);
 return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)&&!/Z$|[+-]\d{2}:?\d{2}$/i.test(raw)?raw.replace(' ','T')+'Z':raw;
}
export function diningSnapshot(value:unknown):DiningSnapshot|null {
 if(typeof value!=='string')return null;
 try {const snapshot = JSON.parse(value) as DiningSnapshot; return { ...snapshot, allergy: allergyValues(snapshot.allergy).join('・') || null };}catch{return null;}
}
export function seatBoardEntry(r:Record<string,unknown>):ReservationBoardEntry {
 let links:string[]=[];try{links=JSON.parse(String(r.table_ids_json??'[]'));}catch{/* old rows */}
 let allergies: RestaurantReservationAllergy[] | null = null; try { const parsed: unknown = JSON.parse(String(r.allergies_json ?? 'null')); if (Array.isArray(parsed) && parsed.every(item => item && typeof item === 'object' && (item.kind === 'option' || item.kind === 'other') && typeof item.value === 'string')) allergies = parsed; } catch { /* 旧予約 */ }
 return {id:String(r.id),kind:'seats',version:Number(r.customer_version??1),scopeId:String(r.store_id),
 startsAt:reservationInstant(r.starts_at),endsAt:reservationInstant(r.ends_at),status:String(r.status),customerName:String(r.customer_name),
 guestCount:Number(r.guest_count),resourceIds:links.length?links:r.table_id?[String(r.table_id)]:[],resourceLabel:r.table_label?String(r.table_label):null,
 allergies, contactLabel:r.line_uid?'LINE UID':r.customer_phone?maskPhone(String(r.customer_phone)):'電話未登録',currentAllergy:r.allergy_note?String(r.allergy_note):null,source:String(r.source),courseName:r.course_name?String(r.course_name):null,note:r.note?String(r.note):null,
 arrivedAt:r.arrived_at?reservationInstant(r.arrived_at):null,departedAt:r.departed_at?reservationInstant(r.departed_at):null,dining:diningSnapshot(r.dining_snapshot_json),holdExpiresAt:r.hold_expires_at?reservationInstant(r.hold_expires_at):null};
}
export function peopleBoardEntry(r:Record<string,unknown>):ReservationBoardEntry {
 return {id:String(r.id),kind:'people',version:Number(r.lock_version??0),scopeId:String(r.line_account_id),
 startsAt:reservationInstant(r.starts_at),endsAt:reservationInstant(r.ends_at),status:String(r.status),customerName:String(r.customer_name??'—'),
 guestCount:1,resourceIds:r.staff_id?[String(r.staff_id)]:[],resourceLabel:r.staff_name?String(r.staff_name):null,
 source:String(r.source??'line'),courseName:r.menu_name?String(r.menu_name):null,note:r.customer_note?String(r.customer_note):null,dining:null,holdExpiresAt:null};
}

export type FloorBox = { x: number; y: number; width: number; height: number; rotation?: number };
/** 回転した卓の四隅。表示と保存の境界検査で同じ形を使う。 */
export function floorBoxCorners(box: FloorBox): Array<{x:number;y:number}> {
 const angle=(box.rotation??0)*Math.PI/180, c=Math.cos(angle),s=Math.sin(angle);
 const cx=box.x+box.width/2,cy=box.y+box.height/2;
 return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([dx,dy])=>({x:cx+dx*box.width/2*c-dy*box.height/2*s,y:cy+dx*box.width/2*s+dy*box.height/2*c}));
}
export function floorBoxInside(box:FloorBox,width:number,height:number):boolean {
 return floorBoxCorners(box).every(p=>p.x>=-1e-6&&p.y>=-1e-6&&p.x<=width+1e-6&&p.y<=height+1e-6);
}
/** 分離軸で回転後の重なりを検査。接するだけの卓は重なりに数えない。 */
export function floorBoxesOverlap(a:FloorBox,b:FloorBox):boolean {
 const ac=floorBoxCorners(a),bc=floorBoxCorners(b);
 return [ac,bc].every(points=>points.slice(0,2).every((p,i)=>{
  const next=points[i+1],axis={x:next.y-p.y,y:p.x-next.x};
  const project=(ps:typeof points)=>ps.map(q=>q.x*axis.x+q.y*axis.y),ap=project(ac),bp=project(bc);
  return Math.min(Math.max(...ap),Math.max(...bp))-Math.max(Math.min(...ap),Math.min(...bp))>1e-6;
 }));
}
