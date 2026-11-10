import { validRestaurantMenuDescription, validRestaurantMenuImage } from './restaurant-menu-media.js';
import { phoneIntakeFailure } from '../services/restaurant-phone-intake.js';
import { normalizePhone } from '@line-crm/shared';
import { normalizedPhoneSql as customerPhoneSql } from '../lib/phone-sql.js';
import { validFloorCoordinate, validJoinGroup } from './restaurant-store-status.js';
import { extractBroadcastTemplateIds, refreshScenarioReferences } from '@line-crm/db';
import { parseBroadcastMessageParts, buildMessages } from '../features/broadcasts/broadcast-message-set/index.js';
import { validateTemplateMessage } from '../services/template-message-validation.js';
import { requestRestaurantFollowupApproval } from '../services/restaurant-followup.js';
import { validRestaurantFloor, readRestaurantFloor, firstTablePlacement, tablePlacementFits } from '../services/restaurant-floor.js';
import { inputError } from '../lib/input-errors.js';
import { auditLog } from '../lib/audit-log.js';
import { publicClosure, closuresForRange, closureAffectsTable, openSeatTables } from '../services/restaurant-closures.js';
import type { RestaurantTableLayoutInput, RestaurantFloorWrite } from '@line-crm/shared';
import { updateStaffPolicy } from './staff.js';

import type { Env } from '../worker-env.js';

import { restaurantSeatCapacity } from '../services/restaurant-seat-capacity.js';
import { dbFor } from '../services/db-router.js';

import { restaurantTableCapacity, validateRestaurantOpeningHours } from '../services/restaurant-inventory.js';
import { applyDueRestaurantMenuPrices, expireRestaurantHolds, validateRestaurantHold, validRestaurantDate, restaurantCivilTime } from '../services/restaurant-booking.js';
import { hasOrganizationSelector, requiredAccount, organizationFor, storeBelongsTo, acquireLock, adjustInventoryReservedCount, releaseLock } from './restaurant-test-definition.js';
import type { Context } from 'hono';

function duplicateTableCode(c: Context<Env>) {
 return inputError(c,{success:false,code:'duplicate_table_code',error:'この卓番はすでに使われています。別の卓番を入力してください。'},400,['code']);
}

function isDuplicateTableCode(error: unknown): boolean {
 const seen = new Set<unknown>();
 while (error && typeof error === 'object' && !seen.has(error)) {
  seen.add(error);
  if ('message' in error && typeof error.message === 'string' && /UNIQUE constraint failed:\s*rt_tables\.store_id,\s*rt_tables\.code\b/i.test(error.message)) return true;
  error = 'cause' in error ? error.cause : undefined;
 }
 return false;
}

type TableVisualInput = {shape?:string;width?:number;height?:number;rotation?:number;smokingPolicy?:string;partition?:string;shoesAllowed?:boolean;visibleOnMap?:boolean;chairArrangement?:string;chairSide?:string|null;isActive?:boolean;seatDetailType?:string};
function validTableVisual(b:TableVisualInput):boolean {
 return (b.shape===undefined||['rectangle','circle','long','counter','sofa'].includes(b.shape))
  && (b.width===undefined||Number.isFinite(b.width)&&b.width>0&&b.width<=1000)
  && (b.height===undefined||Number.isFinite(b.height)&&b.height>0&&b.height<=1000)
  && (b.rotation===undefined||Number.isFinite(b.rotation)&&Math.abs(b.rotation)<=360)
  && (b.smokingPolicy===undefined||['non_smoking','smoking','heated_tobacco'].includes(b.smokingPolicy))
  && (b.partition===undefined||['open','semi_private','private'].includes(b.partition))
  && (b.shoesAllowed===undefined||typeof b.shoesAllowed==='boolean')
  && (b.visibleOnMap===undefined||typeof b.visibleOnMap==='boolean')
  && (b.chairArrangement===undefined||['both','one','all'].includes(b.chairArrangement))
  && (b.chairSide===undefined||b.chairSide===null||['top','right','bottom','left'].includes(b.chairSide))
  && (b.isActive===undefined||typeof b.isActive==='boolean')
  && (b.seatDetailType===undefined||['table','counter','horigotatsu','zashiki','private_room','terrace'].includes(b.seatDetailType));
}

export const put__api_restaurant_test_tables_layout_1 = async (c: Context<Env, "/api/restaurant-test/tables/layout">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<RestaurantTableLayoutInput>().catch(() => null);
  if (!body || typeof body.storeId !== 'string' || !await storeBelongsTo(c, organization.id, body.storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  if (!Array.isArray(body.tables) || !body.tables.length || body.tables.length > 200
      || body.tables.some(t => !t || typeof t.id !== 'string' || !t.id || !validFloorCoordinate(t.floorX) || !validFloorCoordinate(t.floorY) || !validJoinGroup(t.joinGroup))
      || new Set(body.tables.map(t => t.id)).size !== body.tables.length) return inputError(c, { success: false, error: '卓の配置が正しくありません' }, 400, ["tables"]);
  const rows = body.tables.map(t => ({ ...t, joinGroup: t.joinGroup?.trim() || null }));
  const eligible=await dbFor(c.env).prepare("SELECT COUNT(*) n FROM rt_tables WHERE store_id=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?))").bind(body.storeId,JSON.stringify(rows)).first<{n:number}>();
  if(eligible?.n!==rows.length)return c.json({success:false,error:'卓が見つかりません'},404);
  if(!Number.isInteger(body.expectedVersion)||body.expectedVersion<1)return inputError(c,{success:false,error:'座席図の版を指定してください'},400,['expectedVersion']);
  const db=dbFor(c.env);
  const floors=await db.prepare('SELECT id FROM rt_floors WHERE store_id=? AND archived_at IS NULL').bind(body.storeId).all<{id:string}>();
  for(const item of floors.results){const floor=await readRestaurantFloor(db,item.id,body.storeId);if(!floor)continue;floor.tables=floor.tables.map(t=>{const position=rows.find(r=>r.id===t.id);return position?{...t,x:position.floorX,y:position.floorY}:t});if(!validRestaurantFloor(floor))return inputError(c,{success:false,error:'盤外や卓が重なる配置は保存できません'},400,['tables']);}
  const result=await db.batch([db.prepare(`UPDATE rt_floors SET version=version+1 WHERE id='floor-'||? AND version=? AND (SELECT COUNT(*) FROM rt_tables WHERE store_id=? AND floor_id=rt_floors.id AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?)))=?`).bind(body.storeId,body.expectedVersion,body.storeId,JSON.stringify(rows),rows.length),db.prepare(`WITH positions AS MATERIALIZED (
    SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.floorX') AS x,json_extract(value,'$.floorY') AS y,json_extract(value,'$.joinGroup') AS join_group FROM json_each(?)
  ), eligible AS MATERIALIZED (SELECT t.id FROM rt_tables t JOIN positions p ON p.id=t.id WHERE t.store_id=?)
  UPDATE rt_tables SET floor_x=(SELECT x FROM positions WHERE id=rt_tables.id),floor_y=(SELECT y FROM positions WHERE id=rt_tables.id),
    join_group=(SELECT join_group FROM positions WHERE id=rt_tables.id),updated_at=datetime('now')
    WHERE id IN (SELECT id FROM eligible) AND (SELECT COUNT(*) FROM eligible)=? AND changes()=1`)
    .bind(JSON.stringify(rows), body.storeId, rows.length)]);
  if(!result[0].meta.changes)return c.json({success:false,code:'version_conflict',error:'座席図を読み直してください'},409);
  if (result[1].meta.changes !== rows.length) return c.json({ success: false, error: '卓が見つかりません。配置を読み直してください' }, 404);
  return c.json({ success: true, data: { tables: rows } });
};

export const post__api_restaurant_test_tables_2 = async (c: Context<Env, "/api/restaurant-test/tables">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<{ storeId?: string; code?: string; label?: string; seatType?: string; minCapacity?: number; maxCapacity?: number; floorX?: number; floorY?: number; floorId?:string; joinGroup?: string | null } & TableVisualInput>();
  if (!body.storeId || !await storeBelongsTo(c, organization.id, body.storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  const seatTypes = ['counter', 'table', 'private_room', 'terrace'];
  const min = Number(body.minCapacity);
  const max = Number(body.maxCapacity);
  if (!body.code?.trim() || !body.label?.trim() || !seatTypes.includes(body.seatType || '') || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || !validTableVisual(body)) return inputError(c, { success: false, error: '卓の入力内容が正しくありません' }, 400, ["code","label","seatType","minCapacity","maxCapacity","shape"]);
  if (!validFloorCoordinate(body.floorX === undefined ? 0 : body.floorX) || !validFloorCoordinate(body.floorY === undefined ? 0 : body.floorY) || !validJoinGroup(body.joinGroup ?? null)) return inputError(c, { success: false, error: '卓の配置が正しくありません' }, 400, ["floorX","floorY","joinGroup"]);
  if(await dbFor(c.env,body.storeId).prepare('SELECT id FROM rt_tables WHERE store_id=? AND code=?').bind(body.storeId,body.code.trim()).first())return duplicateTableCode(c);
  if(body.floorId&&!await dbFor(c.env,body.storeId).prepare('SELECT id FROM rt_floors WHERE id=? AND store_id=? AND archived_at IS NULL').bind(body.floorId,body.storeId).first())return inputError(c,{success:false,error:'階が正しくありません'},400,['floorId']);
  const db=dbFor(c.env,body.storeId),firstFloor=await db.prepare('SELECT id FROM rt_floors WHERE store_id=? AND archived_at IS NULL ORDER BY sort_order,name,id LIMIT 1').bind(body.storeId).first<{id:string}>(),floorId=body.floorId??firstFloor?.id??'floor-'+body.storeId;
  const floor=await readRestaurantFloor(db,floorId,body.storeId);if(!floor)return inputError(c,{success:false,error:'階を確認してください'},400,['floorId']);
  const shape=body.shape??'rectangle',width=body.width??(shape==='long'?120:shape==='counter'?64:80),height=body.height??(shape==='long'?64:shape==='counter'?80:64),rotation=body.rotation??0;
  const position=body.floorX===undefined&&body.floorY===undefined?firstTablePlacement(floor,width,height):{x:body.floorX??0,y:body.floorY??0};
  if(!position||!tablePlacementFits(floor,{id:'new',...position,width,height,rotation,shape:shape as RestaurantFloorWrite['tables'][number]['shape']}))return inputError(c,{success:false,error:'座席図の空いている位置を選んでください'},400,['floorX','floorY']);
  const id=crypto.randomUUID();
  try {
   const saved=await db.batch([
   db.prepare('UPDATE rt_floors SET version=version+1 WHERE id=? AND store_id=? AND archived_at IS NULL AND version=?').bind(floorId,body.storeId,floor.expectedVersion),
   db.prepare('INSERT INTO rt_tables (id,store_id,code,label,seat_type,min_capacity,max_capacity,floor_x,floor_y,join_group,floor_id,shape,width,height,rotation,smoking_policy,partition_type,shoes_allowed,visible_on_map,chair_arrangement,chair_side,is_active,seat_detail_type) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1').bind(id,body.storeId,body.code.trim(),body.label.trim(),body.seatType,min,max,position.x,position.y,body.joinGroup?.trim()||null,floorId,shape,width,height,rotation,body.smokingPolicy??'non_smoking',body.partition??'open',Number(body.shoesAllowed??true),Number(body.visibleOnMap??true),body.chairArrangement??'both',body.chairSide??null,Number(body.isActive??true),body.seatDetailType??body.seatType)
  ]);if(!saved[0].meta.changes)return c.json({success:false,code:'version_conflict',error:'座席図が変わりました。読み直してください'},409);
  } catch (error) {
   if(isDuplicateTableCode(error))return duplicateTableCode(c);
   throw error;
  }
  return c.json({ success: true, data: { id } }, 201);
};

// Current references, including stored snapshots, prevent physical deletion.
export const delete__api_restaurant_test_tables_id = async (c: Context<Env, "/api/restaurant-test/tables/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const db = dbFor(c.env);
  const table = await db.prepare(`SELECT t.id,t.store_id,t.floor_id FROM rt_tables t JOIN rt_stores s ON s.id=t.store_id
    WHERE t.id=? AND s.organization_id=? AND (? IS NULL OR s.id=?)`)
    .bind(c.req.param('id'), organization.id, organization.scopedStoreId, organization.scopedStoreId)
    .first<{id:string;store_id:string;floor_id:string|null}>();
  if (!table || !await storeBelongsTo(c, organization.id, table.store_id)) return c.json({success:false,error:'卓が見つかりません'},404);
  const key = `reservation:${table.store_id}`, owner = crypto.randomUUID();
  if (!await acquireLock(db,key,owner)) return c.json({success:false,code:'resource_busy',error:'店舗を更新中です。少し待ってからお試しください'},409);
  try {
    const result = await db.batch([
      db.prepare(`DELETE FROM rt_tables WHERE id=? AND store_id=?
        AND NOT EXISTS (SELECT 1 FROM rt_reservations WHERE table_id=rt_tables.id)
        AND NOT EXISTS (SELECT 1 FROM rt_reservation_table_links WHERE table_id=rt_tables.id)
        AND NOT EXISTS (SELECT 1 FROM rt_seat_waitlist WHERE table_id=rt_tables.id)
        AND NOT EXISTS (SELECT 1 FROM rt_seat_waitlist_table_links WHERE table_id=rt_tables.id)
        AND (is_active=0 OR NOT EXISTS (SELECT 1 FROM booking_assignment_settings a, json_each(a.resources_json) j WHERE a.scope_kind='table' AND a.scope_id=rt_tables.store_id AND json_extract(j.value,'$.resourceId')=rt_tables.id))
        AND NOT EXISTS (SELECT 1 FROM rt_closures c WHERE c.store_id=rt_tables.store_id AND (NOT json_valid(c.table_ids_json) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(c.table_ids_json) THEN c.table_ids_json ELSE '[]' END) WHERE value=rt_tables.id)))
        AND NOT EXISTS (SELECT 1 FROM rt_closure_close_tasks c WHERE c.store_id=rt_tables.store_id AND (NOT json_valid(c.table_ids_json) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(c.table_ids_json) THEN c.table_ids_json ELSE '[]' END) WHERE value=rt_tables.id)))`).bind(table.id,table.store_id),
      db.prepare("UPDATE rt_floors SET version=version+1 WHERE id=? AND changes()=1").bind(table.floor_id),
      db.prepare(`UPDATE booking_assignment_settings SET resources_json=(
        SELECT COALESCE(json_group_array(json(j.value)), '[]') FROM json_each(resources_json) j
        WHERE json_extract(j.value,'$.resourceId') IS NOT ?
      ), version=version+1, updated_at=datetime('now')
      WHERE scope_kind='table' AND scope_id=?
        AND NOT EXISTS (SELECT 1 FROM rt_tables WHERE id=?)
        AND EXISTS (SELECT 1 FROM json_each(resources_json) j WHERE json_extract(j.value,'$.resourceId')=?)`).bind(table.id,table.store_id,table.id,table.id),
    ]);
    if (!result[0].meta.changes) return c.json({success:false,code:'resource_in_use',error:'割り当て設定にある有効な卓は先に停止すると削除できます。予約や休業などで使われている卓は停止中でも削除できません。'},409);
    auditLog(c,'restaurant.table.delete',{id:table.id,kind:'rt_table'});
    return c.json({success:true,data:{id:table.id}});
  } finally { await releaseLock(db,key,owner); }
};

export const post__api_restaurant_test_memberships_3 = async (c: Context<Env, "/api/restaurant-test/memberships">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<{ storeId?: string | null; staffName?: string; email?: string; role?: string; lineUid?: string; googleEmail?: string }>();
  if (body.storeId && !await storeBelongsTo(c, organization.id, body.storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  if (!body.staffName?.trim() || !['super_admin', 'store_manager', 'staff'].includes(body.role || '')) return inputError(c, { success: false, error: '氏名と役割が必要です' }, 400, ["staffName","role"]);
  if (body.role === 'super_admin' && c.get('staff')?.role !== 'owner') return c.json({ success: false, error: 'SuperAdminを追加できるのはオーナーだけです' }, 403);
  const id = crypto.randomUUID();
  await dbFor(c.env, body.storeId).prepare(`INSERT INTO rt_memberships
    (id, organization_id, store_id, staff_name, email, role, line_uid, google_email, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`).bind(
      id, organization.id, body.storeId || null, body.staffName.trim(), body.email?.trim() || null,
      body.role, body.lineUid?.trim() || null, body.googleEmail?.trim() || null,
    ).run();
  return c.json({ success: true, data: { id } }, 201);
};

export const patch__api_restaurant_test_tables_id_4 = async (c: Context<Env, "/api/restaurant-test/tables/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const current = await dbFor(c.env).prepare(`SELECT t.*, (SELECT version FROM rt_floors f WHERE f.id=t.floor_id) floor_version FROM rt_tables t JOIN rt_stores s ON s.id = t.store_id
    WHERE t.id = ? AND s.organization_id = ? AND (? IS NULL OR s.id = ?)`)
    .bind(c.req.param('id'), organization.id, organization.scopedStoreId, organization.scopedStoreId)
    .first<{ store_id: string; code: string; label: string; seat_type: string; min_capacity: number; max_capacity: number; is_active: number; floor_x: number; floor_y: number; join_group: string | null; floor_id:string }>();
  if (!current || !await storeBelongsTo(c, organization.id, current.store_id)) return c.json({ success: false, error: '卓が見つかりません' }, 404);
  const body = await c.req.json<{ code?: string; label?: string; seatType?: string; minCapacity?: number; maxCapacity?: number; floorX?: number; floorY?: number; joinGroup?: string | null; expectedVersion?:number;floorId?:string;expectedTargetVersion?:number } & TableVisualInput>();
  const code = body.code === undefined ? current.code : body.code;
  const label = body.label === undefined ? current.label : body.label;
  const seatType = body.seatType === undefined ? current.seat_type : body.seatType;
  const min = body.minCapacity === undefined ? current.min_capacity : body.minCapacity;
  const max = body.maxCapacity === undefined ? current.max_capacity : body.maxCapacity;
  if (typeof code !== 'string' || !code.trim() || typeof label !== 'string' || !label.trim()
    || !['counter', 'table', 'private_room', 'terrace'].includes(seatType)
    || !Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min
    || !validTableVisual(body)
    || (body.floorX !== undefined && !validFloorCoordinate(body.floorX))
    || (body.floorY !== undefined && !validFloorCoordinate(body.floorY))
    || (body.joinGroup !== undefined && body.joinGroup !== null && (typeof body.joinGroup !== 'string' || body.joinGroup.length > 100))) {
    return inputError(c, { success: false, error: '卓の入力内容が正しくありません' }, 400, ["code","label","seatType","minCapacity","maxCapacity","isActive","floorX","floorY","joinGroup"]);
  }
  const db=dbFor(c.env,current.store_id),movingFloor=body.floorId!==undefined&&body.floorId!==current.floor_id,changesLayout=movingFloor||body.floorX!==undefined||body.floorY!==undefined||body.joinGroup!==undefined||body.shape!==undefined||body.width!==undefined||body.height!==undefined||body.rotation!==undefined;
  if(await db.prepare('SELECT id FROM rt_tables WHERE store_id=? AND code=? AND id<>?').bind(current.store_id,code.trim(),c.req.param('id')).first())return duplicateTableCode(c);
  if(changesLayout&&(!Number.isInteger(body.expectedVersion)||Number(body.expectedVersion)<1))return inputError(c,{success:false,error:'座席図の版を指定してください'},400,['expectedVersion']);
  if(movingFloor&&(!Number.isInteger(body.expectedTargetVersion)||!await db.prepare('SELECT id FROM rt_floors WHERE id=? AND store_id=? AND archived_at IS NULL').bind(body.floorId!,current.store_id).first()))return inputError(c,{success:false,error:'移動先の階と版を確認してください'},400,['floorId','expectedTargetVersion']);
  if(movingFloor||body.floorX!==undefined||body.floorY!==undefined||body.shape!==undefined||body.width!==undefined||body.height!==undefined||body.rotation!==undefined){
   const source=await readRestaurantFloor(db,current.floor_id,current.store_id),target=movingFloor?await readRestaurantFloor(db,body.floorId!,current.store_id):source;
   const shape=source?.tables.find(t=>t.id===c.req.param('id'));
   if(!target||!shape||!tablePlacementFits(target,{...shape,x:body.floorX??current.floor_x,y:body.floorY??current.floor_y,width:body.width??shape.width,height:body.height??shape.height,rotation:body.rotation??shape.rotation,shape:(body.shape??shape.shape) as typeof shape.shape}))return inputError(c,{success:false,error:'座席図の空いている位置を選んでください'},400,['floorX','floorY','floorId']);
  }
  const update=db.prepare(`UPDATE rt_tables SET code = ?, label = ?, seat_type = ?, min_capacity = ?, max_capacity = ?, is_active = ?, floor_x = ?, floor_y = ?, join_group = ?,floor_id=?,shape=COALESCE(?,shape),width=COALESCE(?,width),height=COALESCE(?,height),rotation=COALESCE(?,rotation),smoking_policy=COALESCE(?,smoking_policy),partition_type=COALESCE(?,partition_type),shoes_allowed=COALESCE(?,shoes_allowed),visible_on_map=COALESCE(?,visible_on_map),chair_arrangement=COALESCE(?,chair_arrangement),chair_side=CASE WHEN ?=1 THEN ? ELSE chair_side END,seat_detail_type=COALESCE(?,seat_detail_type), updated_at = datetime('now') WHERE id = ? AND (?=0 OR changes()=1)`)
    .bind(code.trim(), label.trim(), seatType, min, max, body.isActive === undefined ? current.is_active : Number(body.isActive), body.floorX ?? current.floor_x, body.floorY ?? current.floor_y, body.joinGroup === undefined ? current.join_group : body.joinGroup?.trim() || null, body.floorId??current.floor_id,body.shape??null,body.width??null,body.height??null,body.rotation??null,body.smokingPolicy??null,body.partition??null,body.shoesAllowed===undefined?null:Number(body.shoesAllowed),body.visibleOnMap===undefined?null:Number(body.visibleOnMap),body.chairArrangement??null,Number(body.chairSide!==undefined),body.chairSide??null,body.seatDetailType??null,c.req.param('id'),Number(changesLayout));
  try {
   if(changesLayout){const saved=await db.batch([db.prepare('UPDATE rt_floors SET version=version+1 WHERE id=? AND archived_at IS NULL AND version=? AND (?=0 OR EXISTS(SELECT 1 FROM rt_floors target WHERE target.id=? AND target.archived_at IS NULL AND target.version=?))').bind(current.floor_id,body.expectedVersion!,Number(movingFloor),body.floorId??current.floor_id,body.expectedTargetVersion??0),...(movingFloor?[db.prepare('UPDATE rt_floors SET version=version+1 WHERE id=? AND archived_at IS NULL AND version=? AND changes()=1').bind(body.floorId!,body.expectedTargetVersion!)]:[]),update]);if(!saved[0].meta.changes)return c.json({success:false,code:'version_conflict',error:'座席図を読み直してください'},409)}else await update.run();
  } catch (error) {
   if(isDuplicateTableCode(error))return duplicateTableCode(c);
   throw error;
  }
  return c.json({ success: true, data: { id: c.req.param('id') } });
};

export const patch__api_restaurant_test_memberships_id_5 = async (c: Context<Env, "/api/restaurant-test/memberships/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const current = await dbFor(c.env).prepare(`SELECT * FROM rt_memberships WHERE id = ? AND organization_id = ? AND (? IS NULL OR store_id = ?)`)
    .bind(c.req.param('id'), organization.id, organization.scopedStoreId, organization.scopedStoreId)
    .first<{ store_id: string | null; staff_name: string; email: string | null; role: string; line_uid: string | null; google_email: string | null; status: string; staff_id: string | null }>();
  if (!current) return c.json({ success: false, error: '所属ユーザーが見つかりません' }, 404);
  const body = await c.req.json<{ storeId?: string | null; staffName?: string; email?: string | null; role?: string; lineUid?: string | null; googleEmail?: string | null; status?: string; expectedPolicyVersion?: number; idempotencyKey?: string }>();
  const storeId = body.storeId === undefined ? current.store_id : body.storeId === '' ? null : body.storeId;
  const name = body.staffName === undefined ? current.staff_name : body.staffName;
  const role = body.role === undefined ? current.role : body.role;
  const status = body.status === undefined ? current.status : body.status;
  if (typeof name !== 'string' || !name.trim() || !['super_admin', 'store_manager', 'staff'].includes(role)
    || !['active', 'invited', 'suspended'].includes(status)
    || [body.email, body.lineUid, body.googleEmail].some((value) => value !== undefined && value !== null && typeof value !== 'string')
    || (storeId !== null && (typeof storeId !== 'string' || !await storeBelongsTo(c, organization.id, storeId)))
    || (organization.scopedStoreId && storeId !== organization.scopedStoreId)) {
    return inputError(c, { success: false, error: '所属ユーザーの入力内容が正しくありません' }, 400, ["staffName","role","status","email","lineUid","googleEmail","storeId"]);
  }
  if ((role === 'super_admin' || current.role === 'super_admin') && c.get('staff')?.role !== 'owner') {
    return c.json({ success: false, error: 'SuperAdminを変更できるのはオーナーだけです' }, 403);
  }
  if (current.staff_id && (role !== current.role || status !== current.status || storeId !== current.store_id)) {
    if (!Number.isSafeInteger(body.expectedPolicyVersion) || Number(body.expectedPolicyVersion) < 1) return inputError(c, {success:false,error:'ログイン権限の版を読み直してください'}, 400, ["expectedPolicyVersion"]);
    if (role === 'super_admin' || current.role === 'super_admin') return c.json({success:false,error:'オーナーの権限と利用状態は統括メンバーで管理してください'},403);
    if (status === 'invited') return inputError(c, {success:false,error:'連携済みのログインメンバーを招待状態へ戻せません'}, 400, ["status"]);
    const loginStore = storeId ? await dbFor(c.env).prepare('SELECT line_account_id FROM rt_stores WHERE id=?').bind(storeId).first<{line_account_id:string|null}>() : null;
    if (storeId && !loginStore?.line_account_id) return inputError(c, {success:false,error:'担当店舗にLINEアカウントを設定してください'}, 400, ["storeId"]);
    // 既存の認可・再認証・最終管理者保護・セッション失効・版検査をそのまま使う。
    const response = await updateStaffPolicy(c, current.staff_id, {
      ...(role !== current.role ? {role: role === 'store_manager' ? 'admin' : 'staff'} : {}),
      ...(status !== current.status ? {isActive: status === 'active'} : {}),
      ...(storeId !== current.store_id ? {accountScope:storeId ? 'accounts' : 'all',scopedLineAccountIds:storeId ? [loginStore!.line_account_id!] : []} : {}),
      expectedPolicyVersion:body.expectedPolicyVersion, idempotencyKey:body.idempotencyKey,
    });
    if (!response.ok) return response;
  }
  const optional = (value: string | null | undefined, old: string | null) => value === undefined ? old : typeof value === 'string' ? value.trim() || null : null;
  await dbFor(c.env, storeId || undefined).prepare(`UPDATE rt_memberships SET store_id = ?, staff_name = ?, email = ?, role = ?, line_uid = ?, google_email = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(storeId, name.trim(), optional(body.email, current.email), role, optional(body.lineUid, current.line_uid), optional(body.googleEmail, current.google_email), status, c.req.param('id')).run();
  return c.json({ success: true, data: { id: c.req.param('id') } });
};

export const put__api_restaurant_test_inventory_allocation_6 = async (c: Context<Env, "/api/restaurant-test/inventory/allocation">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({success:false,error:'組織が見つかりません'},404);
  const body = await c.req.json<{storeId:string;slots:Array<{id:string;expectedVersion:number}>;otaCapacity:number;lineCapacity:number;walkInCapacity:number;sameDayCapacity?:number}>().catch(()=>null);
  if (!body || !Array.isArray(body.slots) || body.slots.length<1 || body.slots.length>200 || new Set(body.slots.map(s=>s?.id)).size!==body.slots.length
    || body.slots.some(s=>!s || typeof s.id!=='string' || !Number.isSafeInteger(s.expectedVersion) || s.expectedVersion<1)
    || !await storeBelongsTo(c,organization.id,body.storeId)) return inputError(c, {success:false,error:'店舗・枠・版を確認してください'}, 400, ["slots","storeId"]);
  const db=dbFor(c.env,body.storeId); const total=await restaurantTableCapacity(db,body.storeId);
  const allocation=[body.otaCapacity,body.lineCapacity,body.walkInCapacity,body.sameDayCapacity??0]; const sum=allocation.reduce((a,b)=>a+b,0);
  if(allocation.some(n=>!Number.isSafeInteger(n)||n<0)||sum>total) return inputError(c, {success:false,error:'稼働中の席数以内で配分してください'}, 400, ["otaCapacity","lineCapacity","walkInCapacity","sameDayCapacity","storeId"]);
  const result=await db.prepare(`WITH expected AS MATERIALIZED (
      SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.expectedVersion') AS version FROM json_each(?)
    ), eligible AS MATERIALIZED (
      SELECT i.id FROM rt_inventory_slots i JOIN expected e ON e.id=i.id AND e.version=i.version WHERE i.store_id=? AND i.auto_line_original IS NULL AND i.auto_same_day_original IS NULL
    ) UPDATE rt_inventory_slots SET ota_capacity=?,line_capacity=?,walk_in_capacity=?,same_day_capacity=?,version=version+1,updated_by=?,updated_at=datetime('now')
    WHERE store_id=? AND id IN (SELECT id FROM eligible) AND (SELECT COUNT(*) FROM eligible)=?
    AND ? <= COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id=? AND is_active=1),0)`)
    .bind(JSON.stringify(body.slots),body.storeId,...allocation,c.get('staff')!.id,body.storeId,body.slots.length,sum,body.storeId).run();
  if(result.meta.changes!==body.slots.length) return c.json({success:false,error:'ほかの担当者が先に保存しました。最新の内容を比べてください'},409);
  return c.json({success:true,data:{updated:result.meta.changes}});
};

export const put__api_restaurant_test_inventory_id_7 = async (c: Context<Env, "/api/restaurant-test/inventory/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const db = dbFor(c.env);
  const slot = await db.prepare(`SELECT i.store_id, i.version FROM rt_inventory_slots i JOIN rt_stores s ON s.id = i.store_id
    WHERE i.id = ? AND s.organization_id = ? AND (? IS NULL OR s.id = ?)`)
    .bind(c.req.param('id'), organization.id, organization.scopedStoreId, organization.scopedStoreId)
    .first<{ store_id: string; version: number }>();
  if (!slot) return c.json({ success: false, error: '対象がありません' }, 404);
  const body: { totalCapacity?: number; otaCapacity?: number; lineCapacity?: number; walkInCapacity?: number; sameDayCapacity?: number; expectedVersion?: number } = (await c.req.json().catch(() => null)) || {};
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion ?? 0) < 1) return inputError(c, { success: false, error: 'expectedVersion に読み込んだ版を指定してください' }, 400, ["expectedVersion"]);
  if (body.expectedVersion !== slot.version) return c.json({ success: false, error: 'ほかの担当者が先に保存しました。読み直してください', currentVersion: slot.version }, 409);
  const values = [body.otaCapacity, body.lineCapacity, body.walkInCapacity,body.sameDayCapacity??0];
  const totalCapacity = await restaurantTableCapacity(db, slot.store_id);
  if (values.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    || values.reduce<number>((sum, value) => sum + Number(value), 0) > totalCapacity) {
    return inputError(c, { success: false, error: '媒体別枠の合計は稼働中の卓の総席数以下にしてください', totalCapacity }, 400, ["otaCapacity","lineCapacity","walkInCapacity","sameDayCapacity"]);
  }
  const result = await db.prepare(`UPDATE rt_inventory_slots SET
    total_capacity = COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id = rt_inventory_slots.store_id AND is_active = 1), 0),
    ota_capacity = ?, line_capacity = ?, walk_in_capacity = ?, same_day_capacity = ?, version = version + 1, updated_by = ?, updated_at = datetime('now')
    WHERE id = ? AND version = ? AND auto_line_original IS NULL AND auto_same_day_original IS NULL
      AND ? <= COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id = rt_inventory_slots.store_id AND is_active = 1), 0)`)
    .bind(...values, c.get('staff')?.id || '管理者', c.req.param('id'), body.expectedVersion,
      values.reduce<number>((sum, value) => sum + Number(value), 0)).run();
  if (!result.meta.changes) return c.json({ success: false, error: '卓または予約枠が変更されました。読み直してください' }, 409);
  const savedVersion=await db.prepare('SELECT version FROM rt_inventory_slots WHERE id=?').bind(c.req.param('id')).first<{version:number}>();
  return c.json({ success: true, data: { id: c.req.param('id'), totalCapacity, version: savedVersion!.version } });
};

export const get__api_restaurant_test_opening_hours_8 = async (c: Context<Env, "/api/restaurant-test/opening-hours">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const storeId = c.req.query('storeId') || organization.scopedStoreId;
  if (!storeId || (organization.scopedStoreId && organization.scopedStoreId !== storeId) || !await storeBelongsTo(c, organization.id, storeId)) return c.json({ success: false, error: '店舗が正しくありません' }, 400);
  const row = await dbFor(c.env, storeId).prepare('SELECT hours_json, version, updated_by, updated_at, late_cancel_after_minutes, late_arrival_message FROM rt_opening_hours_settings WHERE store_id = ?')
    .bind(storeId).first<{ hours_json: string; version: number; updated_by: string; updated_at: string; late_cancel_after_minutes: number | null; late_arrival_message: string | null }>();
  const connection = await dbFor(c.env, storeId).prepare('SELECT status FROM rt_google_connections WHERE store_id=?')
    .bind(storeId).first<{ status: import('@line-crm/shared').RestaurantOpeningHours['googleStatus'] }>();
  return c.json({ success: true, data: { storeId, hours: row ? JSON.parse(row.hours_json) : null, version: row?.version ?? 0, updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null, googleStatus: connection?.status ?? null, lateArrivalPolicy: row?.late_cancel_after_minutes != null && row.late_arrival_message ? {cancelAfterMinutes:row.late_cancel_after_minutes,message:row.late_arrival_message} : null } });
};

export const put__api_restaurant_test_opening_hours_9 = async (c: Context<Env, "/api/restaurant-test/opening-hours">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body: { storeId?: string; hours?: unknown; expectedVersion?: number; lateArrivalPolicy?: import('@line-crm/shared').RestaurantLateArrivalPolicy | null } = (await c.req.json().catch(() => null)) || {};
  const storeId = typeof body.storeId === 'string' ? body.storeId : body.storeId === undefined ? organization.scopedStoreId : null;
  if (!storeId || (organization.scopedStoreId && organization.scopedStoreId !== storeId) || !await storeBelongsTo(c, organization.id, storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  const googleConnection = await dbFor(c.env, storeId).prepare('SELECT status FROM rt_google_connections WHERE store_id=?')
    .bind(storeId).first<{ status: string }>();
  if (googleConnection && googleConnection.status !== 'disconnected')
    return c.json({ success: false, error: '営業時間はGoogleビジネスで変更してください', code: 'google_hours_source' }, 409);
  const hours = validateRestaurantOpeningHours(body.hours);
  if (!hours || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion ?? -1) < 0) {
    return inputError(c, { success: false, error: '曜日0〜6の営業時間とexpectedVersionを指定してください。重なる営業時間は保存できません' }, 400, ["hours","expectedVersion"]);
  }
  const policy = body.lateArrivalPolicy;
  if (policy != null && (typeof policy !== 'object' || !Number.isInteger(policy.cancelAfterMinutes) || policy.cancelAfterMinutes<1 || policy.cancelAfterMinutes>1440 || typeof policy.message!=='string' || !policy.message.trim() || Array.from(policy.message).length>1000)) return inputError(c, {success:false,error:'遅刻の取消分数と案内文を確認してください'}, 400, ["lateArrivalPolicy"]);
  const db = dbFor(c.env, storeId);
  const result = body.expectedVersion === 0
    ? await db.prepare(`INSERT INTO rt_opening_hours_settings (store_id, hours_json, updated_by, late_cancel_after_minutes, late_arrival_message) VALUES (?, ?, ?, ?, ?) ON CONFLICT(store_id) DO NOTHING`)
      .bind(storeId, JSON.stringify(hours), c.get('staff')?.id || '管理者',policy?.cancelAfterMinutes??null,policy?.message.trim()??null).run()
    : await db.prepare(`UPDATE rt_opening_hours_settings SET hours_json = ?, version = version + 1, updated_by = ?, updated_at = datetime('now'), late_cancel_after_minutes=CASE WHEN ? THEN ? ELSE late_cancel_after_minutes END, late_arrival_message=CASE WHEN ? THEN ? ELSE late_arrival_message END
      WHERE store_id = ? AND version = ?`).bind(JSON.stringify(hours), c.get('staff')?.id || '管理者',Number(policy!==undefined),policy?.cancelAfterMinutes??null,Number(policy!==undefined),policy?.message.trim()??null,storeId, body.expectedVersion).run();
  if (!result.meta.changes) return c.json({ success: false, error: 'ほかの担当者が先に保存しました。読み直してください' }, 409);
  return c.json({ success: true, data: { storeId, hours, version: body.expectedVersion! + 1 } });
};

export const post__api_restaurant_test_menu_10 = async (c: Context<Env, "/api/restaurant-test/menu">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<{ storeId?: string; kind?: string; name?: string; price?: number; allergens?: string[]; servicePeriods?: string[]; status?: string; description?: string | null; imageMediaId?: string | null }>();
  if (!body.storeId || !await storeBelongsTo(c, organization.id, body.storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  const price = Number(body.price);
  if (price > 1_000_000) return inputError(c, { success: false, error: '値段は1,000,000円以下で入れてください。' }, 400, ['price']);
  if (!['course', 'a_la_carte'].includes(body.kind || '') || !body.name?.trim() || !Number.isInteger(price) || price < 0) return inputError(c, { success: false, error: 'メニューの入力内容が正しくありません' }, 400, ["kind","name","price"]);
  if (!validRestaurantMenuDescription(body.description)) return inputError(c, { success:false, error:'説明は2000文字以内で入力してください' }, 400, ['description']);
  if ((body.imageMediaId != null && (typeof body.imageMediaId !== 'string' || !body.imageMediaId)) || (!await validRestaurantMenuImage(dbFor(c.env, body.storeId), body.storeId, body.imageMediaId ?? null))) return inputError(c, { success:false, code:'MENU_IMAGE_UNAVAILABLE', error:'選択した画像を利用できません。登録メディアから選び直してください。' }, 400, ['imageMediaId']);
  const status = body.status ?? 'active';
  if (!['draft', 'active'].includes(status)) return inputError(c, { success: false, error: '作成時の状態は下書きまたは公開です' }, 400, ["status"]);
  const id = crypto.randomUUID();
  await dbFor(c.env, body.storeId).prepare('INSERT INTO rt_menu_items (id, store_id, kind, name, price, allergens_json, service_periods_json, status, description, image_media_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.storeId, body.kind, body.name.trim(), price, JSON.stringify(body.allergens || []), JSON.stringify(body.servicePeriods || ['dinner']), status, body.description?.trim() || null, body.imageMediaId ?? null).run();
  return c.json({ success: true, data: { id } }, 201);
};

export const get__api_restaurant_test_menus_11 = async (c: Context<Env, "/api/restaurant-test/menus">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  await applyDueRestaurantMenuPrices(dbFor(c.env), organization.id, organization.scopedStoreId ?? undefined);
  const storeId = c.req.query('storeId') || null;
  if (storeId && !await storeBelongsTo(c, organization.id, storeId)) return c.json({ success: false, error: '店舗が正しくありません' }, 400);
  const rows = await dbFor(c.env, storeId).prepare(`SELECT m.*,
    (SELECT after_price FROM rt_menu_change_requests r WHERE r.menu_id = m.id AND r.status IN ('pending','approved')) AS pendingPrice, (SELECT effective_at FROM rt_menu_change_requests r WHERE r.menu_id=m.id AND r.status IN ('pending','approved')) AS pendingEffectiveAt, (SELECT status FROM rt_menu_change_requests r WHERE r.menu_id=m.id AND r.status IN ('pending','approved')) AS priceChangeStatus
    FROM rt_menu_items m JOIN rt_stores s ON s.id = m.store_id
    WHERE s.organization_id = ? AND (? IS NULL OR m.store_id = ?) AND (? IS NULL OR m.store_id = ?)
    ORDER BY m.kind, m.name`).bind(organization.id, organization.scopedStoreId, organization.scopedStoreId, storeId, storeId).all();
  return c.json({ success: true, data: rows.results });
};

export const delete__api_restaurant_test_menus_id_12 = async (c: Context<Env, "/api/restaurant-test/menus/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const db = dbFor(c.env);
  const menu = await db.prepare(`SELECT m.id,m.store_id FROM rt_menu_items m JOIN rt_stores s ON s.id = m.store_id
    WHERE m.id = ? AND s.organization_id = ? AND (? IS NULL OR s.id = ?)`)
    .bind(c.req.param('id'), organization.id, organization.scopedStoreId, organization.scopedStoreId)
    .first<{ id: string; store_id: string }>();
  if (!menu || !await storeBelongsTo(c,organization.id,menu.store_id)) return c.json({ success: false, error: 'メニューが見つかりません' }, 404);
  const key=`reservation:${menu.store_id}`,owner=crypto.randomUUID();
  if (!await acquireLock(db,key,owner)) return c.json({success:false,code:'resource_busy',error:'店舗を更新中です。少し待ってからお試しください'},409);
  try {
    const result = await db.prepare(`DELETE FROM rt_menu_items WHERE id = ? AND store_id = ?
      AND NOT EXISTS (SELECT 1 FROM rt_resource_locks l WHERE substr(l.resource_key,1,length('form-course:'||rt_menu_items.id||':'))='form-course:'||rt_menu_items.id||':' AND datetime(l.expires_at)>datetime('now'))
      AND NOT EXISTS (SELECT 1 FROM rt_menu_change_requests WHERE menu_id = rt_menu_items.id)
      AND NOT EXISTS (SELECT 1 FROM restaurant_course_payment_settings WHERE menu_id = rt_menu_items.id)
      AND NOT EXISTS (SELECT 1 FROM rt_reservations r WHERE r.course_id=rt_menu_items.id OR (r.store_id=rt_menu_items.store_id AND r.dining_snapshot_json IS NOT NULL AND (NOT json_valid(r.dining_snapshot_json) OR json_extract(CASE WHEN json_valid(r.dining_snapshot_json) THEN r.dining_snapshot_json ELSE '{}' END,'$.courseId')=rt_menu_items.id)))
      AND NOT EXISTS (SELECT 1 FROM rt_approval_requests a WHERE a.store_id=rt_menu_items.store_id AND a.kind='menu_change' AND (NOT json_valid(a.payload_json) OR json_extract(CASE WHEN json_valid(a.payload_json) THEN a.payload_json ELSE '{}' END,'$.menuId')=rt_menu_items.id))
      AND NOT EXISTS (SELECT 1 FROM forms f WHERE (instr(f.layout,rt_menu_items.id)>0 OR instr(f.layout,char(92))>0) AND (NOT json_valid(f.layout) OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(f.layout) THEN f.layout ELSE '{}' END) j WHERE j.key='courseId' AND j.value=rt_menu_items.id)))
      AND NOT EXISTS (SELECT 1 FROM forms f WHERE (instr(f.fields,rt_menu_items.id)>0 OR instr(f.fields,char(92))>0) AND (NOT json_valid(f.fields) OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(f.fields) THEN f.fields ELSE '[]' END) j WHERE j.key='courseId' AND j.value=rt_menu_items.id)))
      AND NOT EXISTS (SELECT 1 FROM form_versions f WHERE (instr(f.layout,rt_menu_items.id)>0 OR instr(f.layout,char(92))>0) AND (NOT json_valid(f.layout) OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(f.layout) THEN f.layout ELSE '{}' END) j WHERE j.key='courseId' AND j.value=rt_menu_items.id)))
      AND NOT EXISTS (SELECT 1 FROM form_versions f WHERE (instr(f.fields,rt_menu_items.id)>0 OR instr(f.fields,char(92))>0) AND (NOT json_valid(f.fields) OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(f.fields) THEN f.fields ELSE '[]' END) j WHERE j.key='courseId' AND j.value=rt_menu_items.id)))
      AND NOT EXISTS (SELECT 1 FROM form_submissions f WHERE (instr(f.data,rt_menu_items.id)>0 OR instr(f.data,char(92))>0) AND (NOT json_valid(f.data) OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(f.data) THEN f.data ELSE '{}' END) j WHERE j.type='object' AND json_extract(j.value,'$.kind')='seats' AND json_extract(j.value,'$.storeId')=rt_menu_items.store_id AND json_extract(j.value,'$.courseId')=rt_menu_items.id)))
      AND NOT EXISTS (SELECT 1 FROM hq_template_versions f WHERE (instr(f.definition_json,rt_menu_items.id)>0 OR instr(f.definition_json,char(92))>0) AND (NOT json_valid(f.definition_json) OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(f.definition_json) THEN f.definition_json ELSE '{}' END) j WHERE j.key='courseId' AND j.value=rt_menu_items.id)))
      AND NOT EXISTS (SELECT 1 FROM style_starter_catalog_resources f, json_tree(f.source_snapshot) j WHERE j.key='courseId' AND j.value=rt_menu_items.id)
      AND NOT EXISTS (SELECT 1 FROM style_starter_items f, json_tree(COALESCE(f.source_snapshot,'{}')) j WHERE j.key='courseId' AND j.value=rt_menu_items.id)
      AND NOT EXISTS (SELECT 1 FROM style_starter_items f, json_tree(COALESCE(f.pending_update,'{}')) j WHERE j.key='courseId' AND j.value=rt_menu_items.id)
      AND NOT EXISTS (SELECT 1 FROM style_starter_sets f, json_tree(f.definition_json) j WHERE j.key='courseId' AND j.value=rt_menu_items.id)` )
      .bind(menu.id,menu.store_id).run();
    if (!result.meta.changes) return c.json({ success: false, code:'resource_in_use', error: '予約やフォーム、設定などで使われているメニューは削除できません。停止してください' }, 409);
    auditLog(c,'restaurant.menu.delete',{id:menu.id,kind:'rt_menu_item'});
    return c.json({ success: true, data: { id: menu.id } });
  } finally { await releaseLock(db,key,owner); }
};

export const post__api_restaurant_test_gbp_posts_13 = async (c: Context<Env, "/api/restaurant-test/gbp/posts">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<{ storeId?: string; postType?: string; title?: string; body?: string; ctaType?: string; ctaUrl?: string }>();
  if (!body.storeId || !await storeBelongsTo(c, organization.id, body.storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  if (!['standard', 'event', 'offer'].includes(body.postType || '') || !body.title?.trim() || !body.body?.trim()) return inputError(c, { success: false, error: '投稿種別・タイトル・本文が必要です' }, 400, ["postType","title","body"]);
  const postId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();
  const staff = c.get('staff');
  await dbFor(c.env, body.storeId).batch([
    dbFor(c.env, body.storeId).prepare(`INSERT INTO rt_gbp_posts
      (id, store_id, post_type, title, body, cta_type, cta_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`).bind(postId, body.storeId, body.postType, body.title.trim(), body.body.trim(), body.ctaType || null, body.ctaUrl?.trim() || null),
    dbFor(c.env, body.storeId).prepare(`INSERT INTO rt_approval_requests
      (id, organization_id, store_id, kind, title, status, payload_json, requested_by)
      VALUES (?, ?, ?, 'gbp_post', ?, 'pending', ?, ?)`).bind(approvalId, organization.id, body.storeId, body.title.trim(), JSON.stringify({ postId }), staff?.name || staff?.id || '管理者'),
  ]);
  return c.json({ success: true, data: { postId, approvalId, published: false } }, 201);
};

export const put__api_restaurant_test_gbp_reviews_id_draft_14 = async (c: Context<Env, "/api/restaurant-test/gbp/reviews/:id/draft">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const body = await c.req.json<{ replyDraft?: string }>();
  if (!body.replyDraft?.trim()) return inputError(c, { success: false, error: '返信案が必要です' }, 400, ["replyDraft"]);
  const result = await dbFor(c.env).prepare(`UPDATE rt_gbp_reviews SET reply_draft = ?, reply_status = 'draft', updated_at = datetime('now')
    WHERE id = ? AND store_id IN (
      SELECT id FROM rt_stores WHERE organization_id = ? AND (? IS NULL OR id = ?)
    )`).bind(
      body.replyDraft.trim(), c.req.param('id'), organization.id,
      organization.scopedStoreId, organization.scopedStoreId,
    ).run();
  if (!result.meta.changes) return c.json({ success: false, error: '対象がありません' }, 404);
  return c.json({ success: true, data: { id: c.req.param('id'), sent: false } });
};

export const put__api_restaurant_test_followups_storeId_steps_stepId_messages_16 = async (c: Context<Env, "/api/restaurant-test/followups/:storeId/steps/:stepId/messages">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),storeId=c.req.param('storeId');
 if(!org||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'not_found'},404);
 const body=await c.req.json<{expectedVersion?:unknown;messageBubbles?:unknown}>();
 if(!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1)
  return inputError(c,{success:false,error:'最新の版を指定してください'},400,['expectedVersion']);
 if(!Array.isArray(body.messageBubbles)||body.messageBubbles.length<1||body.messageBubbles.length>5)
  return inputError(c,{success:false,error:'吹き出しは1〜5個で指定してください'},400,['messageBubbles']);
 let parts:ReturnType<typeof parseBroadcastMessageParts>;
 try {
  parts=parseBroadcastMessageParts({messageType:'text',messageContent:'',messageBubbles:body.messageBubbles});
  buildMessages(parts);
  for(const part of parts){const checked=validateTemplateMessage(part.messageType,part.messageContent);if(!checked.ok)throw new Error(checked.error);}
 }catch(error){return inputError(c,{success:false,error:error instanceof Error?error.message:'吹き出しを確認してください'},422,['messageBubbles']);}
 const db=dbFor(c.env,storeId),stepId=c.req.param('stepId');
 const target=await db.prepare(`SELECT step.id,step.scenario_id,s.line_account_id FROM scenario_steps step JOIN rt_store_followup_templates t ON t.scenario_id=step.scenario_id JOIN rt_stores s ON s.id=t.store_id WHERE t.store_id=? AND step.id=?`).bind(storeId,stepId).first<{id:string;scenario_id:string;line_account_id:string}>();
 if(!target)return c.json({success:false,error:'not_found'},404);
 const templateIds=extractBroadcastTemplateIds(JSON.stringify(body.messageBubbles));
 if(templateIds.length){
  const found=await db.prepare('SELECT id FROM templates WHERE line_account_id=? AND id IN (SELECT value FROM json_each(?))').bind(target.line_account_id,JSON.stringify(templateIds)).all<{id:string}>();
  if(found.results.length!==templateIds.length)return inputError(c,{success:false,error:'この店舗のテンプレートを選んでください'},422,['messageBubbles']);
 }
 const changed=await db.prepare(`UPDATE scenario_steps SET message_bubbles_json=?,message_type=?,message_content=?,template_id=NULL
   WHERE id=? AND EXISTS(SELECT 1 FROM rt_store_followup_templates t WHERE t.store_id=? AND t.scenario_id=scenario_steps.scenario_id AND t.template_version=?)`)
   .bind(JSON.stringify(body.messageBubbles),parts[0].messageType,parts[0].messageContent,stepId,storeId,body.expectedVersion).run();
 if(!changed.meta.changes)return c.json({success:false,error:'version_conflict'},409);
 await refreshScenarioReferences(db,target.scenario_id);
 return c.json({success:true,data:{stepId,messageBubbles:body.messageBubbles,version:Number(body.expectedVersion)+1,sendingStatus:'stopped'}});
};

export const delete__api_restaurant_test_followups_storeId_bindings_stepId_17 = async (c: Context<Env, "/api/restaurant-test/followups/:storeId/bindings/:stepId">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),storeId=c.req.param('storeId');
 if(!org||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'not_found'},404);
 const b=await c.req.json<{expectedVersion?:number;trigger?:string}>().catch(()=>null);
 if(!b||!Number.isSafeInteger(b.expectedVersion)||Number(b.expectedVersion)<1||typeof b.trigger!=='string')return inputError(c,{success:false,error:'invalid_binding'},400,['expectedVersion','trigger']);
 const changed=await dbFor(c.env,storeId).prepare(`DELETE FROM rt_store_followup_step_bindings WHERE store_id=? AND trigger=? AND step_id=?
  AND EXISTS(SELECT 1 FROM rt_store_followup_templates WHERE store_id=? AND template_version=?)`)
  .bind(storeId,b.trigger,c.req.param('stepId'),storeId,b.expectedVersion).run();
 return changed.meta.changes?c.json({success:true,data:{stopped:true}}):c.json({success:false,error:'version_conflict'},409);
};

export const post__api_restaurant_test_followups_storeId_request_start_18 = async (c: Context<Env, "/api/restaurant-test/followups/:storeId/request-start">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),storeId=c.req.param('storeId');
 if(!org||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'not_found'},404);
 const b=await c.req.json<{expectedVersion?:number}>().catch(()=>null);
 if(!b||!Number.isSafeInteger(b.expectedVersion)||Number(b.expectedVersion)<1)return inputError(c,{success:false,error:'expected_version_required'},400,['expectedVersion']);
 const result=await requestRestaurantFollowupApproval(dbFor(c.env,storeId),storeId,b.expectedVersion!,c.get('staff')?.id??'');
 return result?c.json({success:true,data:{approvalId:result.id,sendingStatus:'pending'}},201):c.json({success:false,error:'version_or_publication_conflict'},409);
};

export const post__api_restaurant_test_followups_storeId_stop_19 = async (c: Context<Env, "/api/restaurant-test/followups/:storeId/stop">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),storeId=c.req.param('storeId');
 if(!org||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'not_found'},404);
 await dbFor(c.env,storeId).prepare("UPDATE rt_store_followup_templates SET sending_status='stopped',approval_id=NULL,approved_version_id=NULL,template_version=template_version+1 WHERE store_id=?").bind(storeId).run();
 return c.json({success:true,data:{sendingStatus:'stopped'}});
};

export const get__api_restaurant_test_reservations_id_confirmations_20 = async (c: Context<Env, "/api/restaurant-test/reservations/:id/confirmations">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);
 if(!org)return c.json({success:false,error:'not_found'},404);
 const db=dbFor(c.env);
 const reservation=await db.prepare('SELECT r.id,r.customer_version FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id WHERE r.id=? AND s.organization_id=? AND (? IS NULL OR s.id=?)').bind(c.req.param('id'),org.id,org.scopedStoreId,org.scopedStoreId).first<{id:string;customer_version:number}>();
 if(!reservation)return c.json({success:false,error:'not_found'},404);
 const data=(await db.prepare('SELECT *,reservation_version=? AS is_current FROM rt_reservation_confirmations WHERE reservation_id=? ORDER BY requested_at DESC').bind(reservation.customer_version,reservation.id).all()).results;
 return c.json({success:true,data});
};

export const get__api_restaurant_test_followups_storeId_review_history_21 = async (c: Context<Env, "/api/restaurant-test/followups/:storeId/review-history">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),storeId=c.req.param('storeId');
 if(!org||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'not_found'},404);
 const rows=await dbFor(c.env,storeId).prepare(`SELECT j.id source_job_id,j.source_id reservation_id,j.status,j.scheduled_at,j.message_log_id,
  log.created_at sent_at,log.content FROM scenario_source_jobs j
  JOIN rt_reservation_events e ON e.id=j.source_event_id AND e.store_id=?
  JOIN scenario_versions v ON v.id=j.scenario_version_id
  LEFT JOIN messages_log log ON log.id=j.message_log_id
  WHERE EXISTS(SELECT 1 FROM json_each(v.steps_snapshot) st WHERE json_extract(st.value,'$.version_step_id')=j.step_id
    AND EXISTS(SELECT 1 FROM rt_approval_requests a,json_each(a.payload_json,'$.bindings') binding WHERE a.store_id=e.store_id AND json_extract(a.payload_json,'$.scenarioVersionId')=j.scenario_version_id AND json_extract(binding.value,'$.trigger')='review_request' AND json_extract(binding.value,'$.step_id')=json_extract(st.value,'$.live_step_id'))) ORDER BY j.scheduled_at DESC LIMIT 100`).bind(storeId).all();
 return c.json({success:true,data:{invitations:rows.results,origin:'line_invitation',verifiedGoogleReviewAttributions:[],reviewSelection:'all_customers'}});
};

export const put__api_restaurant_test_line_flows_id_22 = async (c: Context<Env, "/api/restaurant-test/line-flows/:id">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '飲食店テスト組織がありません' }, 404);
  const managed=await dbFor(c.env).prepare(`SELECT t.scenario_id FROM rt_line_flows f LEFT JOIN rt_store_followup_templates t ON t.store_id=f.store_id WHERE (t.store_id IS NOT NULL OR EXISTS(SELECT 1 FROM rt_store_followup_rows WHERE store_id=f.store_id)) AND f.id=? AND f.organization_id=? AND (? IS NULL OR f.store_id=?)`).bind(c.req.param('id'),organization.id,organization.scopedStoreId,organization.scopedStoreId).first<{scenario_id:string}>();
  if(managed)return c.json({success:false,error:'common_scenario_editor_required',data:{scenarioId:managed.scenario_id}},409);
  const body = await c.req.json<{ title?: string; body?: string; timingMinutes?: number | null; isEnabled?: boolean }>();
  if (!body.title?.trim() || !body.body?.trim()) return inputError(c, { success: false, error: 'タイトルと本文が必要です' }, 400, ["title","body"]);
  const result = await dbFor(c.env).prepare(`UPDATE rt_line_flows SET title = ?, body = ?, timing_minutes = ?, is_enabled = ?,
    delivery_mode = 'preview_only', updated_at = datetime('now')
    WHERE id = ? AND organization_id = ? AND (? IS NULL OR store_id = ?)`).bind(
      body.title.trim(), body.body.trim(), body.timingMinutes ?? null, body.isEnabled ? 1 : 0,
      c.req.param('id'), organization.id, organization.scopedStoreId, organization.scopedStoreId,
    ).run();
  if (!result.meta.changes) return c.json({ success: false, error: '対象がありません' }, 404);
  return c.json({ success: true, data: { id: c.req.param('id'), deliveryMode: 'preview_only' } });
};

export const post__api_restaurant_test_reservations_holds_23 = async (c: Context<Env, "/api/restaurant-test/reservations/holds">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '組織が見つかりません' }, 404);
  const body = validateRestaurantHold(await c.req.json().catch(() => null));
  if (!body) return inputError(c, { success: false, error: '日時・人数・仮押さえの期限（1〜120分）を確認してください' }, 400, []);
  if (!await storeBelongsTo(c, organization.id, body.storeId)) return inputError(c, { success: false, error: '店舗が正しくありません' }, 400, ["storeId"]);
  const db = dbFor(c.env, body.storeId);
  const failure = await phoneIntakeFailure(db, body.storeId, body.startsAt);
  if (failure) return c.json({ success: false, code: failure, error: failure }, 409);
  await expireRestaurantHolds(db, undefined, body.storeId);
  const owner = crypto.randomUUID();
  const key = `reservation:${body.storeId}`;
  if (!await acquireLock(db, key, owner)) return c.json({ success: false, error: '同じ店舗で予約を更新中です。再度お試しください' }, 409);
  try {
    const closures = await closuresForRange(db, body.storeId, body.startsAt, body.endsAt);
    const tables = await openSeatTables(db, body.storeId, body.startsAt, body.endsAt, body.guestCount);
    const capacity=await restaurantSeatCapacity(db,body.storeId,body.startsAt,body.endsAt);
    const selected=capacity.select({startsAt:body.startsAt,endsAt:body.endsAt,guestCount:body.guestCount,tableId:body.tableId});
    const tableId=body.tableId || (capacity.settings.enabled?(selected?.id??null):null);
    if (!selected || !tables.some(t=>t.id===selected.id||t.tableIds?.includes(selected.id))) {
      const blocked = closures.filter(r => body.tableId ? closureAffectsTable(r, body.tableId) : true);
      if (blocked.length) return c.json({ success: false, error: 'closure_conflict', code: 'closure_conflict', reason: '臨時休業・貸切の日時と卓に重なります', data: { closures: blocked.map(publicClosure) }, closures: blocked.map(publicClosure) }, 409);
      return c.json({ success: false, error: '人数が入る空き卓がありません' }, 409);
    }
    const id = crypto.randomUUID();
    const holdExpiresAt = new Date(Date.now() + body.holdMinutes * 60_000).toISOString();
    await capacity.commit([db.prepare(`INSERT INTO rt_reservations
      (id, store_id, source, customer_name, guest_count, starts_at, ends_at, table_id, status, note, hold_expires_at)
      VALUES (?, ?, 'manual', '押さえ', ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(id, body.storeId, body.guestCount, body.startsAt, body.endsAt, tableId, body.note?.trim() || null, holdExpiresAt)]);
    await adjustInventoryReservedCount(db, body.storeId, body.startsAt, body.guestCount);
    return c.json({ success: true, data: { id, tableId, holdExpiresAt } }, 201);
  } finally { await releaseLock(db, key, owner); }
};

export const get__api_restaurant_test_reservations_day_24 = async (c: Context<Env, "/api/restaurant-test/reservations/day">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '組織が見つかりません' }, 404);
  const storeId = c.req.query('storeId') || organization.scopedStoreId || '';
  const date = c.req.query('date') || '';
  if (!validRestaurantDate(date) || !await storeBelongsTo(c, organization.id, storeId)) return c.json({ success: false, error: '店舗と日付を確認してください' }, 400);
  const db = dbFor(c.env, storeId);
  await expireRestaurantHolds(db, undefined, storeId);
  const store = await db.prepare('SELECT timezone FROM rt_stores WHERE id = ?').bind(storeId).first<{ timezone: string }>();
  const from = restaurantCivilTime(date, 0, store!.timezone);
  const to = restaurantCivilTime(date, 1440, store!.timezone);
  const rows = await db.prepare(`SELECT r.*, (SELECT marked_at FROM rt_seat_visit_marks WHERE reservation_id=r.id AND kind='visited' AND undone_at IS NULL ORDER BY marked_at DESC LIMIT 1) AS arrived_at, (SELECT json_group_array(table_id) FROM rt_reservation_table_links WHERE reservation_id=r.id) AS table_ids_json, s.name AS store_name, t.label AS table_label, m.name AS course_name
    FROM rt_reservations r JOIN rt_stores s ON s.id = r.store_id
    LEFT JOIN rt_tables t ON t.id = r.table_id LEFT JOIN rt_menu_items m ON m.id = r.course_id
    WHERE r.store_id = ? AND datetime(r.starts_at) < datetime(?) AND datetime(r.ends_at) > datetime(?)
    ORDER BY r.starts_at, r.id`).bind(storeId, to, from).all();
  return c.json({ success: true, data: { date, reservations: rows.results, closures: (await closuresForRange(db, storeId, from, to)).map(publicClosure) } });
};

export const get__api_restaurant_test_customers_history_25 = async (c: Context<Env, "/api/restaurant-test/customers/history">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '組織が見つかりません' }, 404);
  const storeId = c.req.query('storeId') || '';
  const lineUid = c.req.query('lineUid')?.trim();
  const phone = normalizePhone(c.req.query('phone') ?? '');
  if ((!lineUid && !phone) || !await storeBelongsTo(c, organization.id, storeId)) return c.json({ success: false, error: '店舗と連絡先を確認してください' }, 400);
  const db = dbFor(c.env, storeId);
  const where = `r.store_id = ? AND r.status IN ('visited', 'seated') AND ${lineUid ? 'r.line_uid = ?' : `${customerPhoneSql} = ?`}`;
  const args = [storeId, lineUid || phone];
  const count = await db.prepare(`SELECT COUNT(*) AS total FROM rt_reservations r WHERE ${where}`).bind(...args).first<{ total: number }>();
  const rows = await db.prepare(`SELECT r.id, r.starts_at, r.guest_count, r.allergy_note, t.label AS table_label, m.name AS course_name
    FROM rt_reservations r LEFT JOIN rt_tables t ON t.id = r.table_id LEFT JOIN rt_menu_items m ON m.id = r.course_id
    WHERE ${where} ORDER BY r.starts_at DESC, r.id LIMIT 20`).bind(...args).all();
  return c.json({ success: true, data: { visitCount: count!.total, visits: rows.results } });
};

export const get__api_restaurant_test_customers_search_26 = async (c: Context<Env, "/api/restaurant-test/customers/search">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '組織が見つかりません' }, 404);
  const storeId = c.req.query('storeId') || '';
  const q = c.req.query('q')?.trim() || '';
  if (q.length < 2 || q.length > 100 || !await storeBelongsTo(c, organization.id, storeId)) return c.json({ success: false, error: '店舗と検索文字を確認してください' }, 400);
  const rows = await dbFor(c.env, storeId).prepare(`SELECT customer_name AS name, customer_phone AS phone, line_uid AS lineUid
    FROM rt_reservations WHERE store_id = ? AND hold_expires_at IS NULL
      AND (INSTR(customer_name, ?) > 0 OR INSTR(${customerPhoneSql}, ?) > 0)
      AND (customer_phone IS NOT NULL OR line_uid IS NOT NULL)
    GROUP BY COALESCE(line_uid, customer_phone) UNION
    SELECT COALESCE(f.display_name, 'LINEの友だち') AS name, NULL AS phone, f.line_user_id AS lineUid
    FROM friends f JOIN rt_stores s ON s.line_account_id = f.line_account_id
    WHERE s.id = ? AND f.is_following = 1 AND INSTR(COALESCE(f.display_name, ''), ?) > 0 LIMIT 20`)
    .bind(storeId, q, normalizePhone(q) || q, storeId, q).all<{ name: string; phone: string | null; lineUid: string | null }>();
  return c.json({ success: true, data: rows.results.map(row => ({ ...row, phone: row.phone ? normalizePhone(row.phone) : null })) });
};

export const get__api_restaurant_test_inventory_day_27 = async (c: Context<Env, "/api/restaurant-test/inventory/day">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '組織が見つかりません' }, 404);
  const storeId = c.req.query('storeId') || organization.scopedStoreId || '';
  const date = c.req.query('date') || '';
  if (!validRestaurantDate(date) || !await storeBelongsTo(c, organization.id, storeId)) return c.json({ success: false, error: '店舗と日付を確認してください' }, 400);
  const db = dbFor(c.env, storeId);
  await expireRestaurantHolds(db, undefined, storeId);
  const store = await db.prepare('SELECT timezone FROM rt_stores WHERE id = ?').bind(storeId).first<{ timezone: string }>();
  const rows = await db.prepare(`SELECT v.*, sm.name AS updated_by_name FROM rt_inventory_occupancy v
    LEFT JOIN staff_members sm ON sm.id=v.updated_by
    WHERE v.store_id=? AND datetime(v.starts_at)>=datetime(?) AND datetime(v.starts_at)<datetime(?) ORDER BY v.starts_at`)
    .bind(storeId, restaurantCivilTime(date, 0, store!.timezone), restaurantCivilTime(date, 1440, store!.timezone)).all<Record<string, unknown>>();
  const closures = await closuresForRange(db, storeId, restaurantCivilTime(date, 0, store!.timezone), restaurantCivilTime(date, 1440, store!.timezone));
  const tables=(await db.prepare('SELECT id,max_capacity FROM rt_tables WHERE store_id=? AND is_active=1').bind(storeId).all<{id:string;max_capacity:number}>()).results;
  return c.json({ success: true, closures: closures.map(publicClosure), data: rows.results.map(r => {
    const occupiedTableIds=JSON.parse(String(r.occupied_table_ids_json)) as string[];
    const from=Date.parse(String(r.starts_at)),to=from+Number(r.slot_minutes)*60_000;
    const closed=closures.filter(c=>(JSON.parse(c.periods_json) as Array<{startsAt:string;endsAt:string}>).some(p=>Date.parse(p.startsAt)<to&&Date.parse(p.endsAt)>from));
    const closedTables=tables.filter(t=>closed.some(c=>closureAffectsTable(c,t.id)));
    const blockedSeats=closedTables.filter(t=>!occupiedTableIds.includes(t.id)).reduce((n,t)=>n+t.max_capacity,0);
    return {...r,reserved_count:r.guest_count,occupiedTableIds,closedTableIds:closedTables.map(t=>t.id),
      freeSeats:Math.max(0,Number(r.total_capacity)-Number(r.occupied_seats)-Number(r.unassigned_guests)-blockedSeats)};
  }) });
};
