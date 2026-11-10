import { buildOffsetListResponse } from '../lib/list-paging.js';
import { parseReservationFilter } from './restaurant-reservation-filter.js';
import { restaurantRotation } from '../services/restaurant-rotation.js';
import { validRestaurantFloor, saveRestaurantFloor } from '../services/restaurant-floor.js';
import { seatBoardEntry } from '@line-crm/shared';
import { inputError } from '../lib/input-errors.js';
import { publicClosure, closurePreview, openSeatTables, type ClosureRow } from '../services/restaurant-closures.js';
import { safeRestaurantHttpsUrl, restaurantReservationEmbed } from '../services/restaurant-media-links.js';
import { getRestaurantInventoryRules, getRestaurantInventoryRuleState, saveRestaurantInventoryRules, validateRestaurantInventoryRules, listRestaurantCloseTasks } from '@line-crm/db';

import type { Env } from '../worker-env.js';

import { dbFor } from '../services/db-router.js';
import { restaurantTableCapacity, validateRestaurantOpeningHours } from '../services/restaurant-inventory.js';
import { validRestaurantDate, restaurantCivilTime } from '../services/restaurant-booking.js';
import { DEFAULT_TENANT_ID } from '../lib/tenant.js';
import { hasOrganizationSelector, requiredAccount, organizationFor, storeBelongsTo, acquireLock, adjustInventoryReservedCount, releaseLock } from './restaurant-test-definition.js';
import type { Context } from 'hono';

export const post__api_restaurant_test_inventory_generate_1 = async (c: Context<Env, "/api/restaurant-test/inventory/generate">) => {
  if (!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization = await organizationFor(c);
  if (!organization) return c.json({ success: false, error: '組織が見つかりません' }, 404);
  const body = await c.req.json<{ storeId?: string; date?: string; expectedHoursVersion?: number; otaCapacity?: number; lineCapacity?: number; walkInCapacity?: number; sameDayCapacity?: number }>().catch(() => ({} as { storeId?: string; date?: string; expectedHoursVersion?: number; otaCapacity?: number; lineCapacity?: number; walkInCapacity?: number; sameDayCapacity?: number }));
  if (!body.storeId || !validRestaurantDate(body.date || '') || !await storeBelongsTo(c, organization.id, body.storeId)) return inputError(c, { success: false, error: '店舗と日付を確認してください' }, 400, ["storeId","date"]);
  const db = dbFor(c.env, body.storeId);
  const setting = await db.prepare(`SELECT h.hours_json,h.version,s.timezone FROM rt_opening_hours_settings h JOIN rt_stores s ON s.id=h.store_id WHERE h.store_id=?`)
    .bind(body.storeId).first<{ hours_json: string; version: number; timezone: string }>();
  if (!setting) return c.json({ success: false, error: '先に週の営業時間を保存してください' }, 409);
  if (setting.version !== body.expectedHoursVersion) return c.json({ success: false, error: '営業時間が変わりました。読み直してください', currentVersion: setting.version }, 409);
  const total = await restaurantTableCapacity(db, body.storeId);
  const allocation = [body.otaCapacity, body.lineCapacity, body.walkInCapacity,body.sameDayCapacity??0];
  if (allocation.some(n => !Number.isSafeInteger(n) || Number(n)<0) || allocation.reduce<number>((sum,n)=>sum+Number(n),0)>total) return inputError(c, { success: false, error: '稼働中の卓の席数以内で配分してください' }, 400, ["otaCapacity","lineCapacity","walkInCapacity","sameDayCapacity","storeId"]);
  const hours = validateRestaurantOpeningHours(JSON.parse(setting.hours_json))!;
  const weekday = new Date(body.date!).getUTCDay();
  const mins = (time: string) => Number(time.slice(0,2))*60+Number(time.slice(3));
  const starts: string[] = [];
  for (const p of hours.find(d=>d.weekday===weekday)!.periods) {
    const start = mins(p.opensAt); const close = mins(p.closesAt); const end = close <= start ? close+1440 : close;
    for (let minute=start; minute<end; minute+=30) starts.push(restaurantCivilTime(body.date!, minute, setting.timezone));
  }
  // INSERT時にも版を検査。途中で版が変わったらbatch全体を巻き戻す。
  const key = `inventory:${body.storeId}`; const owner = crypto.randomUUID();
  if (!await acquireLock(db,key,owner)) return c.json({ success:false,error:'在庫を更新中です。もう一度お試しください' },409);
  try {
    const batch = await db.batch([
      db.prepare('SELECT version FROM rt_opening_hours_settings WHERE store_id=?').bind(body.storeId),
      db.prepare('SELECT COALESCE(SUM(max_capacity),0) AS total FROM rt_tables WHERE store_id=? AND is_active=1').bind(body.storeId),
      ...starts.map(start => db.prepare(`INSERT INTO rt_inventory_slots
        (id,store_id,starts_at,total_capacity,ota_capacity,line_capacity,walk_in_capacity,same_day_capacity,updated_by)
        SELECT ?,?,?,COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id=? AND is_active=1),0),?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM rt_opening_hours_settings WHERE store_id=? AND version=?)
          AND ? <= COALESCE((SELECT SUM(max_capacity) FROM rt_tables WHERE store_id=? AND is_active=1),0)
        ON CONFLICT(store_id,starts_at) DO NOTHING`).bind(crypto.randomUUID(),body.storeId,start,body.storeId,...allocation,c.get('staff')!.id,body.storeId,body.expectedHoursVersion,allocation.reduce<number>((a,n)=>a+Number(n),0),body.storeId)),
    ]);
    if ((batch[0].results[0] as {version:number} | undefined)?.version !== body.expectedHoursVersion
      || Number((batch[1].results[0] as {total:number}).total) < allocation.reduce<number>((a,n)=>a+Number(n),0)) return c.json({success:false,error:'営業時間または卓が変わりました。読み直してください'},409);
    const results = batch.slice(2);
    await adjustInventoryReservedCount(db, body.storeId, '', 0);
    return c.json({ success: true, data: { generated: results.reduce((sum,r)=>sum+r.meta.changes,0), slotMinutes: 30 } });
  } finally { await releaseLock(db,key,owner); }
};

export const get__api_restaurant_test_login_members_2 = async (c: Context<Env, "/api/restaurant-test/login-members">) => {
  if(!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization=await organizationFor(c);
  if(!organization) return c.json({success:false,error:'組織が見つかりません'},404);
  // ログイン用の鍵や秘密値は射影しない。
  const rows=await dbFor(c.env).prepare(`SELECT sm.id,sm.name,sm.role,sm.access_level AS accessLevel,sm.is_active AS isActive,
    sm.account_scope AS accountScope,sm.policy_version AS policyVersion,
    (SELECT json_group_array(line_account_id) FROM staff_account_scopes WHERE staff_id=sm.id) AS accountIdsJson
    FROM staff_members sm WHERE COALESCE(sm.tenant_id,?)=? ORDER BY sm.name`)
    .bind(DEFAULT_TENANT_ID,organization.tenant_id??DEFAULT_TENANT_ID).all<{id:string;name:string;role:string;accessLevel:string;isActive:number;accountScope:string;policyVersion:number;accountIdsJson:string}>();
  return c.json({success:true,data:rows.results.map(({accountIdsJson,...row})=>({...row,accountIds:JSON.parse(accountIdsJson)}))});
};

export const put__api_restaurant_test_memberships_id_login_3 = async (c: Context<Env, "/api/restaurant-test/memberships/:id/login">) => {
  if(!hasOrganizationSelector(c)) return requiredAccount(c);
  const organization=await organizationFor(c);
  if(!organization) return c.json({success:false,error:'組織が見つかりません'},404);
  const db=dbFor(c.env);
  const member=await db.prepare(`SELECT id,store_id,role FROM rt_memberships WHERE id=? AND organization_id=? AND (? IS NULL OR store_id=?)`)
    .bind(c.req.param('id'),organization.id,organization.scopedStoreId,organization.scopedStoreId).first<{id:string;store_id:string|null;role:string}>();
  if(!member) return c.json({success:false,error:'所属ユーザーが見つかりません'},404);
  if(member.role==='super_admin' && c.get('staff')!.role!=='owner') return c.json({success:false,error:'オーナーとの連携はオーナーだけが変更できます'},403);
  if(member.store_id && !await storeBelongsTo(c,organization.id,member.store_id)) return c.json({success:false,error:'所属ユーザーが見つかりません'},404);
  const body=await c.req.json<{staffId?:string|null}>().catch(()=>null);
  if(!body || (body.staffId!==null && (typeof body.staffId!=='string' || !body.staffId))) return inputError(c, {success:false,error:'ログインメンバーを選んでください'}, 400, ["staffId"]);
  if(body.staffId===null) {
    await db.prepare('UPDATE rt_memberships SET staff_id=NULL,updated_at=datetime(\'now\') WHERE id=?').bind(member.id).run();
    return c.json({success:true,data:{id:member.id,staffId:null}});
  }
  const login=await db.prepare(`SELECT id,role,is_active,invite_status,account_scope,assigned_line_account_id FROM staff_members
    WHERE id=? AND COALESCE(tenant_id,?)=?`).bind(body.staffId,DEFAULT_TENANT_ID,organization.tenant_id??DEFAULT_TENANT_ID)
    .first<{id:string;role:string;is_active:number;invite_status:string;account_scope:string;assigned_line_account_id:string|null}>();
  if(!login) return c.json({success:false,error:'ログインメンバーが見つかりません'},404);
  if((login.role==='owner' || member.role==='super_admin') && c.get('staff')!.role!=='owner') return c.json({success:false,error:'オーナーとの連携はオーナーだけが変更できます'},403);
  const scopeIds=await db.prepare('SELECT line_account_id FROM staff_account_scopes WHERE staff_id=?').bind(login.id).all<{line_account_id:string}>();
  const accountIds=scopeIds.results.map(s=>s.line_account_id);
  const isAll=login.account_scope==='all';
  const stores=await db.prepare('SELECT id,line_account_id FROM rt_stores WHERE organization_id=?').bind(organization.id).all<{id:string;line_account_id:string|null}>();
  const matching=stores.results.filter(s=>s.line_account_id && accountIds.includes(s.line_account_id));
  const storeId=isAll ? null : matching.find(s=>s.id===member.store_id)?.id || matching[0]?.id;
  if(storeId===undefined || (organization.scopedStoreId && storeId!==organization.scopedStoreId)) return c.json({success:false,error:'ログインメンバーの担当店舗が合いません。先に統括メンバーで閲覧範囲を設定してください'},409);
  try {
    await db.prepare(`UPDATE rt_memberships SET staff_id=?,role=?,status=?,store_id=?,updated_at=datetime('now') WHERE id=?`)
      .bind(login.id,login.role==='owner'?'super_admin':login.role==='admin'?'store_manager':'staff',login.is_active===0?'suspended':login.invite_status==='active'?'active':'invited',storeId,member.id).run();
  }catch(error){if(/unique constraint/i.test(String(error)))return c.json({success:false,error:'このログインメンバーはすでに別の名簿へ連携されています'},409);throw error;}
  return c.json({success:true,data:{id:member.id,staffId:login.id}});
};

export const get__api_restaurant_test_inventory_rules_4 = async (c: Context<Env, "/api/restaurant-test/inventory-rules">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);const storeId=c.req.query('storeId')||org?.scopedStoreId;
 if(!org||!storeId||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'店舗が正しくありません'},404);
 const db=dbFor(c.env,storeId), date=c.req.query('date');
 if(date!==undefined&&!validRestaurantDate(date))return inputError(c,{success:false,error:'日付を確認してください'},400,['date']);
 const data=await getRestaurantInventoryRules(db,storeId);
 if(date===undefined)return c.json({success:true,data});
 const store=await db.prepare('SELECT timezone FROM rt_stores WHERE id=?').bind(storeId).first<{timezone:string}>();
 const state=await getRestaurantInventoryRuleState(db,storeId,restaurantCivilTime(date,0,store!.timezone),restaurantCivilTime(date,1440,store!.timezone));
 return c.json({success:true,data,state});
};

export const put__api_restaurant_test_inventory_rules_5 = async (c: Context<Env, "/api/restaurant-test/inventory-rules">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);const body=await c.req.json().catch(()=>null);
 if(!validateRestaurantInventoryRules(body))return inputError(c, {success:false,error:'ルールと読み込んだ版を確認してください'}, 400, ['storeId', 'threshold', 'stopLine', 'stopSameDay', 'notify', 'expectedVersion']);
 if(!org||!await storeBelongsTo(c,org.id,body.storeId))return c.json({success:false,error:'店舗が正しくありません'},404);
 const db=dbFor(c.env,body.storeId);
 if(!await saveRestaurantInventoryRules(db,body))return c.json({success:false,error:'ほかの担当者が先に保存しました',currentVersion:(await getRestaurantInventoryRules(db,body.storeId)).version},409);
 return c.json({success:true,data:await getRestaurantInventoryRules(db,body.storeId)});
};

export const get__api_restaurant_test_channel_close_tasks_6 = async (c: Context<Env, "/api/restaurant-test/channel-close-tasks">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);const storeId=c.req.query('storeId')||org?.scopedStoreId;
 if(!org||!storeId||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'店舗が正しくありません'},404);
 const source=c.req.query('source'),channel=c.req.query('channel');
 return c.json({success:true,data:await listRestaurantCloseTasks(dbFor(c.env,storeId),storeId,{source:source&&source!=='all'?source:undefined,channel:channel&&channel!=='all'?channel:undefined})});
};

export const post__api_restaurant_test_channel_close_tasks_id_opened_7 = async (c: Context<Env, "/api/restaurant-test/channel-close-tasks/:id/opened">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);if(!org)return c.json({success:false,error:'組織がありません'},404);
 const body=await c.req.json<{expectedGeneration?:unknown}>().catch(()=>null);
 if(!body||!Number.isSafeInteger(body.expectedGeneration)||Number(body.expectedGeneration)<1)return inputError(c,{success:false,error:'読み込んだ知らせの世代を確認してください'},400,['expectedGeneration']);
 const db=dbFor(c.env),id=c.req.param('id');
 const task=await db.prepare(`SELECT store_id,generation,status,'rt_channel_close_tasks' AS task_table FROM rt_channel_close_tasks WHERE id=?
 UNION ALL SELECT store_id,generation,status,'rt_reservation_close_tasks' FROM rt_reservation_close_tasks WHERE id=?
 UNION ALL SELECT store_id,generation,status,'rt_closure_close_tasks' FROM rt_closure_close_tasks WHERE id=?`).bind(id,id,id)
 .first<{store_id:string;generation:number;status:string;task_table:'rt_channel_close_tasks'|'rt_reservation_close_tasks'|'rt_closure_close_tasks'}>();
 if(!task||!await storeBelongsTo(c,org.id,task.store_id))return c.json({success:false,error:'知らせがありません'},404);
 const generation=Number(body.expectedGeneration);
 const saved=await db.prepare(`INSERT INTO account_settings(id,line_account_id,key,value)
 SELECT ?,s.line_account_id,?,? FROM ${task.task_table} t JOIN rt_stores s ON s.id=t.store_id
 WHERE t.id=? AND t.store_id=? AND t.status='reopen' AND t.generation=? AND s.line_account_id IS NOT NULL
 ON CONFLICT(line_account_id,key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`)
 .bind(crypto.randomUUID(),'restaurant_close_opened:'+id,String(generation),id,task.store_id,generation).run();
 if(!saved.meta.changes)return c.json({success:false,error:'知らせが更新されました。読み直してください'},409);
 return c.json({success:true,data:{id,status:'reopen',opened:true,generation}});
};

export const post__api_restaurant_test_channel_close_tasks_id_done_8 = async (c: Context<Env, "/api/restaurant-test/channel-close-tasks/:id/done">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);if(!org)return c.json({success:false,error:'組織がありません'},404);
 const db=dbFor(c.env);const task=await db.prepare(`SELECT store_id,status,'rt_channel_close_tasks' AS task_table FROM rt_channel_close_tasks WHERE id=? UNION ALL SELECT store_id,status,'rt_reservation_close_tasks' AS task_table FROM rt_reservation_close_tasks WHERE id=? UNION ALL SELECT store_id,status,'rt_closure_close_tasks' AS task_table FROM rt_closure_close_tasks WHERE id=?`).bind(c.req.param('id'),c.req.param('id'),c.req.param('id')).first<{store_id:string;status:string;task_table:'rt_channel_close_tasks'|'rt_reservation_close_tasks'|'rt_closure_close_tasks'}>();
 if(!task||!await storeBelongsTo(c,org.id,task.store_id))return c.json({success:false,error:'知らせがありません'},404);
 if(task.status==='reopen')return c.json({success:false,error:'席が戻りました。もう開けてよい状態です'},409);
 const changed=await db.prepare(`UPDATE ${task.task_table} SET status='done',updated_at=datetime('now') WHERE id=? AND status='close'`).bind(c.req.param('id')).run();
 if(!changed.meta.changes&&task.status!=='done')return c.json({success:false,error:'知らせが更新されました。読み直してください'},409);
 return c.json({success:true,data:{id:c.req.param('id'),status:'done'}});
};

export const get__api_restaurant_test_media_9 = async (c: Context<Env, "/api/restaurant-test/media">) => {
  return c.json({success:true,data:(await dbFor(c.env).prepare('SELECT code,name,accepts_reservations AS acceptsReservations FROM rt_media ORDER BY name').all()).results});
};

export const post__api_restaurant_test_media_10 = async (c: Context<Env, "/api/restaurant-test/media">) => {
  const body=await c.req.json<{code?:unknown;name?:unknown}>().catch(()=>null);
  if(typeof body?.code!=='string'||!/^gourmet_[a-z0-9_]{1,50}$/.test(body.code)||typeof body.name!=='string'||!body.name.trim()||body.name.length>100)
    return inputError(c, {success:false,error:'グルメ媒体のコードと名前を確認してください'}, 400, ["code","name"]);
  const result=await dbFor(c.env).prepare(`INSERT OR IGNORE INTO rt_media(id,code,name,parser_key,is_active,accepts_reservations) VALUES(?,?,?,?,0,0)`)
    .bind(crypto.randomUUID(),body.code,body.name.trim(),body.code).run();
  if(!result.meta.changes)return c.json({success:false,error:'同じコードの媒体が登録済みです'},409);
  return c.json({success:true,data:{code:body.code,name:body.name.trim(),acceptsReservations:false}},201);
};

export const get__api_restaurant_test_media_links_11 = async (c: Context<Env, "/api/restaurant-test/media-links">) => {
  const org=await organizationFor(c),storeId=c.req.query('storeId')||'';
  if(!org||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,code:'restaurant_store_mismatch',error:'店舗を確認してください'},400);
  const data=await dbFor(c.env,storeId).prepare(`SELECT m.code,m.name,m.accepts_reservations AS acceptsReservations,
    l.page_url AS pageUrl,l.login_url AS loginUrl,COALESCE(l.close_on_booking,0) AS closeOnBooking,COALESCE(l.version,0) AS version
    FROM rt_media m LEFT JOIN rt_store_media_links l ON l.media_id=m.id AND l.store_id=? ORDER BY m.name`).bind(storeId).all();
  return c.json({success:true,data:data.results});
};

export const put__api_restaurant_test_media_links_code_12 = async (c: Context<Env, "/api/restaurant-test/media-links/:code">) => {
  const b=await c.req.json<{storeId:string;pageUrl:unknown;loginUrl:unknown;closeOnBooking:boolean;expectedVersion:number}>().catch(()=>null);
  const org=await organizationFor(c);
  if(!b||!org||typeof b.storeId!=='string'||!await storeBelongsTo(c,org.id,b.storeId))return inputError(c, {success:false,code:'restaurant_store_mismatch',error:'店舗を確認してください'}, 400, ["storeId"]);
  const page=safeRestaurantHttpsUrl(b.pageUrl),login=safeRestaurantHttpsUrl(b.loginUrl);
  const media=await dbFor(c.env).prepare('SELECT id,accepts_reservations FROM rt_media WHERE code=?').bind(c.req.param('code')).first<{id:string;accepts_reservations:number}>();
  if(!media||page===undefined||login===undefined||typeof b.closeOnBooking!=='boolean'||(!media.accepts_reservations&&b.closeOnBooking)||!Number.isSafeInteger(b.expectedVersion)||b.expectedVersion<0)
    return inputError(c, {success:false,error:'HTTPSのURL・閉鎖対象・版を確認してください'}, 400, ["pageUrl","loginUrl","closeOnBooking","expectedVersion"]);
  const db=dbFor(c.env,b.storeId);
  const saved=await db.prepare(`INSERT INTO rt_store_media_links(store_id,media_id,page_url,login_url,close_on_booking)
    SELECT ?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM rt_store_media_links WHERE store_id=? AND media_id=?) ON CONFLICT(store_id,media_id) DO UPDATE SET page_url=excluded.page_url,login_url=excluded.login_url,
    close_on_booking=excluded.close_on_booking,version=version+1,updated_at=datetime('now') WHERE version=?`)
    .bind(b.storeId,media.id,page,login,b.closeOnBooking?1:0,b.expectedVersion,b.storeId,media.id,b.expectedVersion).run();
  if(!saved.meta.changes)return c.json({success:false,error:'設定が更新されました。読み直してください'},409);
  await db.prepare(`INSERT INTO rt_inventory_rule_queue(store_id,cause) VALUES(?,'media_links_saved') ON CONFLICT(store_id) DO UPDATE SET generation=generation+1,cause=excluded.cause`).bind(b.storeId).run();
  const row=await db.prepare('SELECT version FROM rt_store_media_links WHERE store_id=? AND media_id=?').bind(b.storeId,media.id).first<{version:number}>();
  return c.json({success:true,data:{code:c.req.param('code'),storeId:b.storeId,pageUrl:page,loginUrl:login,closeOnBooking:b.closeOnBooking,version:row!.version}});
};

export const post__api_restaurant_test_reservation_link_13 = async (c: Context<Env, "/api/restaurant-test/reservation-link">) => {
  const b=await c.req.json<{storeId?:string}>().catch(()=>null),org=await organizationFor(c);
  if(!b?.storeId||!org||!await storeBelongsTo(c,org.id,b.storeId))return inputError(c, {success:false,error:'店舗を確認してください'}, 400, ["storeId"]);
  const account=await dbFor(c.env).prepare(`SELECT a.liff_id FROM rt_stores s JOIN line_accounts a ON a.id=s.line_account_id WHERE s.id=? AND a.is_active=1 AND a.archived_at IS NULL`).bind(b.storeId).first<{liff_id:string|null}>();
  if(!account?.liff_id?.trim())return c.json({success:false,error:'店舗のLIFF IDの設定が必要です'},503);
  const db=dbFor(c.env,b.storeId);
  await db.prepare('INSERT OR IGNORE INTO rt_reservation_links(store_id,token) VALUES(?,?)').bind(b.storeId,crypto.randomUUID()).run();
  const link=await db.prepare('SELECT token FROM rt_reservation_links WHERE store_id=?').bind(b.storeId).first<{token:string}>();
  return c.json({success:true,data:restaurantReservationEmbed(account.liff_id.trim(),link!.token)});
};

export const get__api_restaurant_test_closures_14 = async (c: Context<Env, "/api/restaurant-test/closures">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),storeId=c.req.query('storeId')||org?.scopedStoreId||'',month=c.req.query('month');
 if(!org||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'店舗が正しくありません'},404);
 if(month!==undefined&&(!/^\d{4}-\d{2}$/.test(month)||!validRestaurantDate(month+'-01')))return c.json({success:false,error:'月はYYYY-MMです'},400);
 const rows=await dbFor(c.env,storeId).prepare(`SELECT * FROM rt_closures WHERE store_id=? AND archived_at IS NULL
 AND (? IS NULL OR (start_date<=date(?||'-01','+1 month','-1 day') AND end_date>=?||'-01')) ORDER BY start_date,start_time,id`)
 .bind(storeId,month??null,month??null,month??null).all<ClosureRow>();
 return c.json({success:true,data:rows.results.map(publicClosure)});
};

export const delete__api_restaurant_test_closures_id_15 = async (c: Context<Env, "/api/restaurant-test/closures/:id">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),b=await c.req.json().catch(()=>null);
 if(!b||!Number.isSafeInteger(b.expectedVersion)||b.expectedVersion<1)return c.json({success:false,error:'読み込んだ版を指定してください'},400);
 const db=dbFor(c.env),r=await db.prepare('SELECT * FROM rt_closures WHERE id=? AND archived_at IS NULL').bind(c.req.param('id')).first<ClosureRow>();
 if(!org||!r||!await storeBelongsTo(c,org.id,r.store_id))return c.json({success:false,error:'休業・貸切がありません'},404);
 const changed=await db.prepare(`UPDATE rt_closures SET archived_at=datetime('now'),version=version+1,updated_at=datetime('now') WHERE id=? AND version=? AND archived_at IS NULL`).bind(r.id,b.expectedVersion).run();
 if(!changed.meta.changes)return c.json({success:false,error:'version_conflict',currentVersion:r.version},409);
 return c.json({success:true,data:{id:r.id,version:r.version+1,archived:true}});
};

export const get__api_restaurant_test_availability_16 = async (c: Context<Env, "/api/restaurant-test/availability">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),storeId=c.req.query('storeId')||org?.scopedStoreId||'',startsAt=c.req.query('startsAt')||'',endsAt=c.req.query('endsAt')||'',guestCount=Number(c.req.query('guestCount'));
 if(!org||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'店舗が正しくありません'},404);
 if(!Number.isFinite(Date.parse(startsAt))||!Number.isFinite(Date.parse(endsAt))||Date.parse(endsAt)<=Date.parse(startsAt)||!Number.isSafeInteger(guestCount)||guestCount<1||guestCount>100)return c.json({success:false,error:'日時と人数を確認してください'},400);
 return c.json({success:true,data:{storeId,startsAt,endsAt,guestCount,tables:await openSeatTables(dbFor(c.env,storeId),storeId,startsAt,endsAt,guestCount)}});
};

export const get__api_restaurant_test_closures_id_contact_status_17 = async (c: Context<Env, "/api/restaurant-test/closures/:id/contact-status">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),db=dbFor(c.env),row=await db.prepare('SELECT * FROM rt_closures WHERE id=? AND archived_at IS NULL').bind(c.req.param('id')).first<ClosureRow>();
 if(!org||!row||!await storeBelongsTo(c,org.id,row.store_id))return c.json({success:false,error:'休業・貸切がありません'},404);
 return c.json({success:true,data:await closurePreview(db,publicClosure(row),JSON.parse(row.periods_json),row.id)});
};

export const get__api_restaurant_test_board_18 = async (c: Context<Env, "/api/restaurant-test/board">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);if(!org)return c.json({success:false,error:'組織がありません'},404);
 const from=c.req.query('from'),to=c.req.query('to'),storeId=c.req.query('storeId');
 if(!from||!to||!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(to)<=Date.parse(from))return inputError(c,{success:false,error:'期間を確認してください'},400,['from','to']);
 if(storeId&&!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'店舗がありません'},404);
 const filter=parseReservationFilter(c,org.id,org.scopedStoreId);if(!filter.ok)return c.json({success:false,error:filter.error},400);
 if(storeId){filter.where+=' AND r.store_id=?';filter.params.push(storeId)}
 const db=dbFor(c.env);
 const rows=await db.prepare(`SELECT r.*, (SELECT marked_at FROM rt_seat_visit_marks WHERE reservation_id=r.id AND kind='visited' AND undone_at IS NULL ORDER BY marked_at DESC LIMIT 1) AS arrived_at,t.label table_label,m.name course_name,
 (SELECT json_group_array(table_id) FROM rt_reservation_table_links WHERE reservation_id=r.id) table_ids_json
 FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id LEFT JOIN rt_tables t ON t.id=r.table_id LEFT JOIN rt_menu_items m ON m.id=r.course_id
 WHERE ${filter.where} ORDER BY r.starts_at,r.id LIMIT ? OFFSET ?`).bind(...filter.params,filter.limit,filter.offset).all<Record<string,unknown>>();
 const total=await db.prepare(`SELECT COUNT(*) total FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id WHERE ${filter.where}`).bind(...filter.params).first<{total:number}>();
 const items = rows.results.map(seatBoardEntry);
 return c.json({success:true,data:buildOffsetListResponse({ entries:items,items,total:total!.total,limit:filter.limit,offset:filter.offset,paging:filter,sort:[{field:'starts_at',direction:'asc'},{field:'id',direction:'asc'}] })});
};

export const post__api_restaurant_test_floors_19 = async (c: Context<Env, "/api/restaurant-test/floors">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),b=await c.req.json();
 if(!org||typeof b.storeId!=='string'||!await storeBelongsTo(c,org.id,b.storeId))return c.json({success:false,error:'店舗がありません'},404);
 if(typeof b.name!=='string'||!b.name.trim()||b.name.length>80)return inputError(c,{success:false,error:'階・エリアの名前を指定してください'},400,['name']);
 const kind=b.kind??'floor';
 if(!['floor','area'].includes(kind)||kind==='area'&&b.parentFloorId!=null&&typeof b.parentFloorId!=='string'||kind==='floor'&&b.parentFloorId)return inputError(c,{success:false,error:'階・エリアの種類を確認してください'},400,['kind','parentFloorId']);
 const db=dbFor(c.env,b.storeId);
 if(kind==='area'&&b.parentFloorId&&!await db.prepare("SELECT id FROM rt_floors WHERE id=? AND store_id=? AND kind='floor' AND archived_at IS NULL").bind(b.parentFloorId,b.storeId).first())return inputError(c,{success:false,error:'親の階を確認してください'},400,['parentFloorId']);
 if(b.afterFloorId!=null&&(kind!=='floor'||typeof b.afterFloorId!=='string'))return inputError(c,{success:false,error:'タブの表示位置を確認してください'},400,['afterFloorId']);
 const ordered=(await db.prepare('SELECT id FROM rt_floors WHERE store_id=? AND archived_at IS NULL ORDER BY sort_order,name,id').bind(b.storeId).all<{id:string}>()).results;
 const afterIndex=b.afterFloorId?ordered.findIndex(f=>f.id===b.afterFloorId):-1;
 if(b.afterFloorId&&afterIndex<0)return inputError(c,{success:false,error:'タブの表示位置を確認してください'},400,['afterFloorId']);
 const insertIndex=afterIndex<0?ordered.length:afterIndex+1;
 const id=crypto.randomUUID();
 const [saved]=await db.batch([
  db.prepare('INSERT OR IGNORE INTO rt_floors(id,store_id,name,kind,parent_floor_id,sort_order) VALUES(?,?,?,?,?,?)').bind(id,b.storeId,b.name.trim(),kind,kind==='area'?b.parentFloorId:null,insertIndex*10),
  ...ordered.map((f,index)=>db.prepare('UPDATE rt_floors SET sort_order=? WHERE id=? AND store_id=? AND EXISTS(SELECT 1 FROM rt_floors WHERE id=?)').bind((index<insertIndex?index:index+1)*10,f.id,b.storeId,id)),
 ]);
 if(!saved.meta.changes)return c.json({success:false,error:'同じ名前の階があります'},409);
 return c.json({success:true,data:{id,version:1}},201);
};

export const get__api_restaurant_test_floors_20 = async (c: Context<Env, "/api/restaurant-test/floors">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),storeId=c.req.query('storeId')??'';
 if(!org||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'店舗がありません'},404);
 const db=dbFor(c.env,storeId);
 const floors=await db.prepare('SELECT * FROM rt_floors WHERE store_id=? AND archived_at IS NULL ORDER BY sort_order,name,id').bind(storeId).all<Record<string,unknown>>();
 const tables=await db.prepare('SELECT * FROM rt_tables WHERE store_id=?').bind(storeId).all<Record<string,unknown>>();
 return c.json({success:true,data:floors.results.map(f=>({id:f.id,storeId:f.store_id,name:f.name,kind:f.kind,parentFloorId:f.parent_floor_id,sortOrder:f.sort_order,width:f.width,height:f.height,version:f.version,
 outline:JSON.parse(String(f.outline_json)),fixtures:JSON.parse(String(f.fixtures_json)),tables:tables.results.filter(t=>t.floor_id===f.id).map(t=>({id:t.id,x:t.floor_x,y:t.floor_y,width:t.width,height:t.height,shape:t.shape,rotation:t.rotation,joinGroup:t.join_group,seatType:t.seat_type,seatDetailType:t.seat_detail_type,minCapacity:t.min_capacity,maxCapacity:t.max_capacity,smokingPolicy:t.smoking_policy,partition:t.partition_type,shoesAllowed:Boolean(t.shoes_allowed),acceptsReservations:Boolean(t.is_active),visibleOnMap:Boolean(t.visible_on_map),chairArrangement:t.chair_arrangement,chairSide:t.chair_side}))}))});
};

export const put__api_restaurant_test_floors_order = async (c: Context<Env, "/api/restaurant-test/floors/order">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),body=await c.req.json().catch(()=>null);
 const storeId=body?.storeId;
 if(!org||typeof storeId!=='string'||!await storeBelongsTo(c,org.id,storeId))return c.json({success:false,error:'店舗がありません'},404);
 const orderedIds=body?.orderedIds,expectedIds=body?.expectedIds;
 if(!Array.isArray(orderedIds)||!Array.isArray(expectedIds)||orderedIds.length===0||orderedIds.length!==expectedIds.length||orderedIds.length>200||orderedIds.some(id=>typeof id!=='string'||!id)||expectedIds.some(id=>typeof id!=='string'||!id)||new Set(orderedIds).size!==orderedIds.length||new Set(expectedIds).size!==expectedIds.length)return inputError(c,{success:false,error:'タブの順番を確認してください'},400,['orderedIds']);
 const db=dbFor(c.env,storeId);
 const current=(await db.prepare('SELECT id FROM rt_floors WHERE store_id=? AND archived_at IS NULL ORDER BY sort_order,name,id').bind(storeId).all<{id:string}>()).results.map(row=>row.id);
 if(current.length!==expectedIds.length||current.some((id,index)=>id!==expectedIds[index]))return c.json({success:false,error:'タブの順番が変わりました。読み直してください'},409);
 if(orderedIds.some(id=>!current.includes(id)))return inputError(c,{success:false,error:'タブの順番を確認してください'},400,['orderedIds']);
 const cases=orderedIds.map(()=> 'WHEN ? THEN ?').join(' '),placeholders=orderedIds.map(()=>'?').join(',');
 const saved=await db.prepare(`WITH current_order AS MATERIALIZED (SELECT json_group_array(id) AS ids FROM (SELECT id FROM rt_floors WHERE store_id=? AND archived_at IS NULL ORDER BY sort_order,name,id)) UPDATE rt_floors SET sort_order=CASE id ${cases} END WHERE store_id=? AND archived_at IS NULL AND id IN (${placeholders}) AND (SELECT ids FROM current_order)=?`).bind(storeId,...orderedIds.flatMap((id,index)=>[id,index*10]),storeId,...orderedIds,JSON.stringify(expectedIds)).run();
 if(!saved.meta.changes)return c.json({success:false,error:'タブの順番が変わりました。読み直してください'},409);
 return c.json({success:true,data:{orderedIds}});
};

export const put__api_restaurant_test_floors_id_21 = async (c: Context<Env, "/api/restaurant-test/floors/:id">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),body=await c.req.json();
 if(!validRestaurantFloor(body)||body.id!==c.req.param('id'))return inputError(c,{success:false,error:'座席図の形・位置・版を確認してください'},400,['tables','expectedVersion']);
 if(!org||!await storeBelongsTo(c,org.id,body.storeId))return c.json({success:false,error:'店舗がありません'},404);
 if(!await saveRestaurantFloor(dbFor(c.env,body.storeId),body))return c.json({success:false,code:'version_conflict',error:'ほかの人が変更しました。最新を読み込んでください'},409);
 return c.json({success:true,data:{version:body.expectedVersion+1}});
};

export const delete__api_restaurant_test_floors_id = async (c: Context<Env, "/api/restaurant-test/floors/:id">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c),body=await c.req.json<{storeId?:string;expectedVersion?:number}>();
 if(!org||typeof body.storeId!=='string'||!await storeBelongsTo(c,org.id,body.storeId))return c.json({success:false,error:'店舗がありません'},404);
 if(!Number.isInteger(body.expectedVersion)||!body.expectedVersion||body.expectedVersion<1)return inputError(c,{success:false,error:'座席図の版を確認してください'},400,['expectedVersion']);
 const db=dbFor(c.env,body.storeId),id=c.req.param('id');
 const floor=await db.prepare('SELECT kind,version FROM rt_floors WHERE id=? AND store_id=? AND archived_at IS NULL').bind(id,body.storeId).first<{kind:string;version:number}>();
 if(!floor)return c.json({success:false,error:'階・エリアがありません'},404);
 if(floor.version!==body.expectedVersion)return c.json({success:false,code:'version_conflict',error:'座席図を読み直してください'},409);
 const tables=await db.prepare('SELECT COUNT(*) AS count FROM rt_tables WHERE floor_id=? AND store_id=?').bind(id,body.storeId).first<{count:number}>();
 if((tables?.count??0)>0)return c.json({success:false,error:'卓が残っています。先に卓を移動するか削除してください'},409);
 const children=await db.prepare('SELECT COUNT(*) AS count FROM rt_floors WHERE parent_floor_id=? AND store_id=? AND archived_at IS NULL').bind(id,body.storeId).first<{count:number}>();
 if((children?.count??0)>0)return c.json({success:false,error:'エリアが残っています。先に子エリアを削除してください'},409);
 if(floor.kind==='floor'){
  const roots=await db.prepare("SELECT COUNT(*) AS count FROM rt_floors WHERE store_id=? AND kind='floor' AND archived_at IS NULL").bind(body.storeId).first<{count:number}>();
  if((roots?.count??0)<=1)return c.json({success:false,error:'最後の階は削除できません。先に別の階を追加してください'},409);
 }
 const saved=await db.prepare(`UPDATE rt_floors SET archived_name=name,name='__archived__'||id,archived_at=datetime('now'),version=version+1
 WHERE id=? AND store_id=? AND version=? AND archived_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM rt_tables WHERE floor_id=rt_floors.id AND store_id=rt_floors.store_id)
 AND NOT EXISTS(SELECT 1 FROM rt_floors child WHERE child.parent_floor_id=rt_floors.id AND child.store_id=rt_floors.store_id AND child.archived_at IS NULL)
 AND (kind='area' OR (SELECT COUNT(*) FROM rt_floors root WHERE root.store_id=rt_floors.store_id AND root.kind='floor' AND root.archived_at IS NULL)>1)`)
 .bind(id,body.storeId,body.expectedVersion).run();
 if(!saved.meta.changes)return c.json({success:false,code:'version_conflict',error:'階・エリアが変わりました。最新の座席図を読み込んでください'},409);
 return c.json({success:true,data:{id}});
};

export const get__api_restaurant_test_rotation_22 = async (c: Context<Env, "/api/restaurant-test/rotation">) => {
 const org=await organizationFor(c);if(!org)return c.json({success:false,error:'店舗がありません'},404);
 const storeId=c.req.query('storeId')??'',date=c.req.query('date')??'';
 const store=await dbFor(c.env).prepare('SELECT id FROM rt_stores WHERE id=? AND organization_id=? AND (? IS NULL OR id=?)').bind(storeId,org.id,org.scopedStoreId,org.scopedStoreId).first();
 if(!store)return c.json({success:false,error:'店舗がありません'},404);
 if(!validRestaurantDate(date))return inputError(c,{success:false,error:'日付を確認してください'},400,['date']);
 return c.json({success:true,data:await restaurantRotation(dbFor(c.env,storeId),storeId,date)});
};

export const get__api_restaurant_test_reservations_id_23 = async (c: Context<Env, "/api/restaurant-test/reservations/:id">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);if(!org)return c.json({success:false,error:'not_found'},404);
 const row=await dbFor(c.env).prepare(`SELECT r.*,m.name course_name FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id
  LEFT JOIN rt_menu_items m ON m.id=r.course_id AND m.store_id=r.store_id
  WHERE r.id=? AND s.organization_id=? AND (? IS NULL OR s.id=?)`)
  .bind(c.req.param('id'),org.id,org.scopedStoreId,org.scopedStoreId).first<Record<string,unknown>>();
 if(!row)return c.json({success:false,error:'not_found'},404);
 const entry=seatBoardEntry(row);
 return c.json({success:true,data:{reservation:entry,courseAllergens:entry.dining?.courseAllergens??null,allergensSource:'registered_at_booking'}});
};

export const get__api_restaurant_test_store_groups_24 = async (c: Context<Env, "/api/restaurant-test/store-groups">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c,{ignoreSession:true});if(!org)return c.json({success:false,error:'not_found'},404);
 const rows=await dbFor(c.env).prepare('SELECT * FROM rt_store_groups WHERE organization_id=?').bind(org.id).all<{id:string}>();
 const result=[];
 for(const g of rows.results){
  const members=await dbFor(c.env).prepare('SELECT m.* FROM rt_store_group_members m WHERE m.group_id=?').bind(g.id).all<{store_id:string}>();
  if(!(await Promise.all(members.results.map(m=>storeBelongsTo(c,org.id,m.store_id)))).every(Boolean))continue;
  result.push({...g,members:members.results});
 }
 return c.json({success:true,data:result});
};

export const post__api_restaurant_test_store_groups_25 = async (c: Context<Env, "/api/restaurant-test/store-groups">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c,{ignoreSession:true});if(!org)return c.json({success:false,error:'not_found'},404);
 const b=await c.req.json<{name:string;members:Array<{storeId:string;referralEnabled:boolean;maxDistance:number}>}>();
 if(!b||typeof b.name!=='string'||!b.name.trim()||b.name.length>100||!Array.isArray(b.members)||b.members.length<2||b.members.length>50||b.members.some(m=>!m||typeof m!=='object'||Array.isArray(m)||typeof m.storeId!=='string'||!m.storeId)||new Set(b.members.map(m=>m.storeId)).size!==b.members.length)return inputError(c,{success:false,error:'invalid_group'},400,['name','members']);
 for(const m of b.members){
  if(typeof m.referralEnabled!=='boolean'||!Number.isFinite(m.maxDistance)||m.maxDistance<0||m.maxDistance>1000)return inputError(c,{success:false,error:'invalid_member'},400,['members']);
  if(!await storeBelongsTo(c,org.id,m.storeId))return c.json({success:false,error:'not_found'},404);
 }
 const id=crypto.randomUUID(),db=dbFor(c.env);
 await db.batch([db.prepare('INSERT INTO rt_store_groups(id,organization_id,name) VALUES(?,?,?)').bind(id,org.id,b.name.trim()),...b.members.map(m=>db.prepare('INSERT INTO rt_store_group_members(group_id,store_id,referral_enabled,max_distance) VALUES(?,?,?,?)').bind(id,m.storeId,m.referralEnabled?1:0,m.maxDistance))]);
 return c.json({success:true,data:{id}},201);
};

export const patch__api_restaurant_test_store_groups_id_members_storeId_26 = async (c: Context<Env, "/api/restaurant-test/store-groups/:id/members/:storeId">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c,{ignoreSession:true});if(!org||!await storeBelongsTo(c,org.id,c.req.param('storeId')))return c.json({success:false,error:'not_found'},404);
 const b=await c.req.json<{referralEnabled:boolean;maxDistance:number;expectedVersion?:number}>();
 if(!b||typeof b.referralEnabled!=='boolean'||!Number.isFinite(b.maxDistance)||b.maxDistance<0||b.maxDistance>1000||(b.expectedVersion!==undefined&&(!Number.isSafeInteger(b.expectedVersion)||b.expectedVersion<1)))return inputError(c,{success:false,error:'invalid_member'},400,['referralEnabled','maxDistance','expectedVersion']);
 const db=dbFor(c.env),groupId=c.req.param('id'),storeId=c.req.param('storeId');
 const r=await db.prepare('UPDATE rt_store_group_members SET referral_enabled=?,max_distance=?,version=version+1 WHERE group_id=? AND store_id=? AND (? IS NULL OR version=?) AND EXISTS(SELECT 1 FROM rt_store_groups WHERE id=? AND organization_id=?)').bind(b.referralEnabled?1:0,b.maxDistance,groupId,storeId,b.expectedVersion??null,b.expectedVersion??null,groupId,org.id).run();
 if(r.meta.changes)return c.json({success:true,data:{updated:true}});
 const current=await db.prepare('SELECT m.* FROM rt_store_group_members m JOIN rt_store_groups g ON g.id=m.group_id WHERE m.group_id=? AND m.store_id=? AND g.organization_id=?').bind(groupId,storeId,org.id).first();
 return current&&b.expectedVersion!==undefined?c.json({success:false,code:'version_conflict',error:'案内設定が変わりました。読み直してから、もう一度選んでください',data:{current}},409):c.json({success:false,error:'not_found'},404);
};

export const put__api_restaurant_test_stores_id_referral_location_27 = async (c: Context<Env, "/api/restaurant-test/stores/:id/referral-location">) => {
 if(!hasOrganizationSelector(c))return requiredAccount(c);
 const org=await organizationFor(c);if(!org||!await storeBelongsTo(c,org.id,c.req.param('id')))return c.json({success:false,error:'not_found'},404);
 const b=await c.req.json<{latitude:number;longitude:number;confirmed:boolean}>();
 if(!b||b.confirmed!==true||!Number.isFinite(b.latitude)||!Number.isFinite(b.longitude)||Math.abs(b.latitude)>90||Math.abs(b.longitude)>180)return inputError(c,{success:false,error:'confirmed_location_required'},400,['latitude','longitude','confirmed']);
 await dbFor(c.env).prepare("UPDATE rt_stores SET latitude=?,longitude=?,updated_at=datetime('now') WHERE id=?").bind(b.latitude,b.longitude,c.req.param('id')).run();
 return c.json({success:true,data:{updated:true}});
};
