import { normalizeLayout } from '@line-crm/shared';
import {Hono} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError,gapAccount,gapBody,gapWrite,gapVersion} from '../services/gap-common.js';
import {loadRoutingLayout,resolveRouting,issueRoutingToken,validateLayoutRouting} from '../features/forms/form-routing/index.js';
import {resolveAccountIdFromLiff,resolveFriendId,verifyCallerLineUserId} from './booking.js';
import {requireDeliveryAccess,requirePermission} from '../middleware/role-guard.js';
export const formRouting=new Hono<Env>();
formRouting.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'routing_unavailable'},e instanceof GapError?e.status:503));
// Forms viewers need only the scoped names and IDs required to choose destinations.
formRouting.get('/api/forms/:id/routing/targets',requireDeliveryAccess('forms','view'),async(c)=>{
 const a=await gapAccount(c);await loadRoutingLayout(c.env.DB,c.req.param('id'),a,false);
 const [menus,staff,groups,groupMenus]=await Promise.all([
  c.env.DB.prepare(`SELECT id,name,duration_minutes AS durationMinutes FROM menus WHERE line_account_id=? AND is_active=1 AND deleted_at IS NULL AND addon_only=0 ORDER BY name,id`).bind(a).all<{id:string;name:string;durationMinutes:number}>(),
  c.env.DB.prepare(`SELECT s.id,s.display_name AS name,sm.menu_id AS menuId FROM staff s JOIN staff_menus sm ON sm.staff_id=s.id AND sm.is_offered=1 JOIN menus m ON m.id=sm.menu_id AND m.line_account_id=s.line_account_id WHERE s.line_account_id=? AND s.is_active=1 AND s.deleted_at IS NULL AND s.is_designation_optional=0 AND m.is_active=1 AND m.deleted_at IS NULL AND m.addon_only=0 ORDER BY s.display_name,s.id`).bind(a).all<{id:string;name:string;menuId:string}>(),
  c.env.DB.prepare(`SELECT id,name FROM booking_routing_staff_groups WHERE line_account_id=? ORDER BY name,id`).bind(a).all<{id:string;name:string}>(),
  c.env.DB.prepare(`SELECT DISTINCT g.id AS groupId,sm.menu_id AS menuId FROM booking_routing_staff_groups g JOIN json_each(g.staff_ids_json) member JOIN staff s ON s.id=member.value AND s.line_account_id=g.line_account_id JOIN staff_menus sm ON sm.staff_id=s.id AND sm.is_offered=1 JOIN menus m ON m.id=sm.menu_id AND m.line_account_id=g.line_account_id WHERE g.line_account_id=? AND s.is_active=1 AND s.deleted_at IS NULL AND s.is_designation_optional=0 AND m.is_active=1 AND m.deleted_at IS NULL AND m.addon_only=0`).bind(a).all<{groupId:string;menuId:string}>(),
 ]);
 return c.json({success:true,data:{menus:menus.results,staff:staff.results,groups:groups.results.map(group=>({...group,menuIds:groupMenus.results.filter(row=>row.groupId===group.id).map(row=>row.menuId)}))}});
});
formRouting.post('/api/forms/:id/routing/preview',requireDeliveryAccess('forms','view'),async(c)=>{
 const a=await gapAccount(c),b=await gapBody(c),layout=await loadRoutingLayout(c.env.DB,c.req.param('id'),a,false);
 if(!b.answers||typeof b.answers!=='object'||Array.isArray(b.answers))throw new GapError('invalid_answers');
 const draft=b.layout === undefined ? layout.layout : normalizeLayout(b.layout);
 if(!draft)throw new GapError('routing_invalid');
 if(b.layout!==undefined) await validateLayoutRouting(c.env.DB,a,draft,{validateTargets:false});
 return c.json({success:true,data:await resolveRouting(c.env.DB,a,draft,b.answers as Record<string,unknown>,b.blockId as string|undefined)});
});
formRouting.post('/api/liff/forms/:id/routing/resolve',async(c)=>{
 const a=await resolveAccountIdFromLiff(c),user=await verifyCallerLineUserId(c);if(!a||!user)throw new GapError('unauthorized',401);
 const f=await resolveFriendId(c,user,a);if(!f)throw new GapError('not_found',404);
 const b=await gapBody(c),layout=await loadRoutingLayout(c.env.DB,c.req.param('id'),a,true);
 if(!b.answers||typeof b.answers!=='object'||Array.isArray(b.answers))throw new GapError('invalid_answers');
 const result=await resolveRouting(c.env.DB,a,layout.layout,b.answers as Record<string,unknown>,b.blockId as string|undefined);
 const token=await issueRoutingToken(c.env.DB,{account:a,friend:f,formId:c.req.param('id'),versionId:layout.current_published_version_id,blockId:result.blockId,target:result.target,matchedIndex:result.matchedIndex,exp:Date.now()+1800000});
 return c.json({success:true,data:{...result,routingToken:token,expiresAt:new Date(Date.now()+1800000).toISOString()}});
});
formRouting.get('/api/booking/admin/routing-staff-groups',requirePermission('/booking/menus'),async(c)=>{const a=await gapAccount(c);return c.json({success:true,data:(await c.env.DB.prepare('SELECT * FROM booking_routing_staff_groups WHERE line_account_id=? ORDER BY name,id').bind(a).all()).results});});
formRouting.put('/api/booking/admin/routing-staff-groups/:id',requirePermission('/booking/menus'),async(c)=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c),v=gapVersion(b.expectedVersion);
 if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100||!Array.isArray(b.staffIds)||!b.staffIds.length||b.staffIds.length>100||b.staffIds.some(x=>typeof x!=='string'))throw new GapError('invalid_group');
 const ids=[...new Set(b.staffIds)];const rows=(await c.env.DB.prepare('SELECT id FROM staff WHERE line_account_id=? AND is_active=1 AND deleted_at IS NULL AND id IN(SELECT value FROM json_each(?))').bind(a,JSON.stringify(ids)).all()).results;if(rows.length!==ids.length)throw new GapError('invalid_staff');
 const r=await c.env.DB.prepare(`INSERT INTO booking_routing_staff_groups(id,line_account_id,name,staff_ids_json) SELECT ?,?,?,? WHERE ?=0 ON CONFLICT(id) DO UPDATE SET name=excluded.name,staff_ids_json=excluded.staff_ids_json,version=version+1 WHERE line_account_id=? AND version=?`).bind(c.req.param('id'),a,b.name.trim(),JSON.stringify(ids),v,a,v).run();
 if(!r.meta.changes)throw new GapError('version_conflict',409);return c.json({success:true,data:{version:v+1}});
});
