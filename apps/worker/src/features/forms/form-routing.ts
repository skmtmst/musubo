import {collectInputs,parseLayout,type FormLayout,type BookingRouting,type RoutingTarget} from '@line-crm/shared';


import {GapError} from '../../services/gap-common.js';
export class RoutingConditionsConflict extends GapError {
 constructor(public blockId:string, public row:number, public questionId:string, public questionLabel:string){super('routing_conditions_conflict');}
}
export async function routingTargetUsable(db:D1Database,a:string,t:RoutingTarget){
 if(!t||typeof t.menuId!=='string'||(t.meetingMode!==undefined&&!['online','in_person'].includes(t.meetingMode)))return false;
 const m=await db.prepare('SELECT id FROM menus WHERE id=? AND line_account_id=? AND is_active=1 AND deleted_at IS NULL AND addon_only=0').bind(t.menuId,a).first();if(!m)return false;
 if(t.staffId&&t.staffGroupId)return false;
 let ids:string[]|null=null;
 if(t.staffGroupId){const g=await db.prepare('SELECT staff_ids_json FROM booking_routing_staff_groups WHERE id=? AND line_account_id=?').bind(t.staffGroupId,a).first<{staff_ids_json:string}>();if(!g)return false;ids=JSON.parse(g.staff_ids_json);}
 if(t.staffId)ids=[t.staffId];
 const staff=(await db.prepare(`SELECT s.id FROM staff s JOIN staff_menus sm ON sm.staff_id=s.id AND sm.menu_id=? AND sm.is_offered=1 WHERE s.line_account_id=? AND s.is_active=1 AND s.deleted_at IS NULL AND s.is_designation_optional=0`).bind(t.menuId,a).all<{id:string}>()).results.map(x=>x.id);
 return ids?ids.some(id=>staff.includes(id)):staff.length>0;
}
export async function validateLayoutRouting(db:D1Database,a:string,layout:FormLayout, options:{validateTargets?:boolean}={}){
 const inputs=collectInputs(layout);
 for(const block of inputs){const r=block.booking?.routing;if(!r)continue;
  if(typeof r.enabled!=='boolean'||!Array.isArray(r.rules)||r.rules.length>50||!r.fallback)throw new GapError('routing_invalid');
  for(const [index,row] of r.rules.entries()){
   if(!row||!Array.isArray(row.conditions)||row.conditions.length<1||row.conditions.length>3)throw new GapError(`routing_invalid:${index}`);
   for(const cond of row.conditions){if(!cond || typeof cond!=='object')throw new GapError(`routing_condition_invalid:${index}`);const q=inputs.find(x=>x.id===cond.questionId);
    if(!q||!['radio','checkbox','select','rating'].includes(q.type))throw new GapError(`routing_question_invalid:${index}`);
    if(!['is','in','between'].includes(cond.op))throw new GapError(`routing_condition_invalid:${index}`);
    if(cond.op==='is'&&typeof cond.value!=='string')throw new GapError(`routing_condition_invalid:${index}`);
    if(cond.op==='in'&&(!Array.isArray(cond.value)||!cond.value.length||cond.value.some(x=>typeof x!=='string')))throw new GapError(`routing_condition_invalid:${index}`);
    if(cond.op==='between'&&(q.type!=='rating'||!Array.isArray(cond.value)||cond.value.length!==2||cond.value.some(x=>typeof x!=='number'||!Number.isFinite(x))||Number(cond.value[0])>Number(cond.value[1])))throw new GapError(`routing_condition_invalid:${index}`);
   }
   if(r.enabled) for(const questionId of new Set(row.conditions.map(cond=>cond.questionId))){
    const q=inputs.find(input=>input.id===questionId),conditions=row.conditions.filter(cond=>cond.questionId===questionId);
    if(!q||q.type==='checkbox'||conditions.length<2)continue;
    let conflict=false;
    if(q.type==='rating'){
     if(conditions.every(cond=>cond.op==='between'&&Array.isArray(cond.value))){
      const ranges=conditions.map(cond=>cond.value as number[]);
      conflict=Math.max(...ranges.map(range=>range[0]))>Math.min(...ranges.map(range=>range[1]));
     }
    }else{
     const sets=conditions.map(cond=>cond.op==='is'?[cond.value as string]:cond.op==='in'?cond.value as string[]:null);
     if(sets.every((set):set is string[]=>set!==null)) conflict=!sets[0].some(value=>sets.every(set=>set.includes(value)));
    }
    if(conflict)throw new RoutingConditionsConflict(block.id,index,q.id,q.label);
   }
   if(r.enabled&&options.validateTargets!==false&&!await routingTargetUsable(db,a,row.target))throw new GapError(`routing_target_invalid:${index}`);
  }
  if(r.enabled&&options.validateTargets!==false&&!await routingTargetUsable(db,a,r.fallback))throw new GapError('routing_fallback_invalid');
 }
}
export function matchRouting(r:BookingRouting,layout:FormLayout,answers:Record<string,unknown>):number{
 const inputs=collectInputs(layout);
 return r.rules.findIndex(row=>row.conditions.every(c=>{const q=inputs.find(x=>x.id===c.questionId),v=q?answers[q.name]:undefined;
  if(c.op==='is')return Array.isArray(v)?v.includes(c.value):v===c.value;
  if(c.op==='in')return (c.value as string[]).some(x=>Array.isArray(v)?v.includes(x):v===x);
  return typeof v==='number'&&v>=Number(c.value[0])&&v<=Number(c.value[1]);
 }));
}
export async function resolveRouting(db:D1Database,a:string,layout:FormLayout,answers:Record<string,unknown>,blockId?:string){
 const block=collectInputs(layout).find(x=>x.type==='booking'&&x.booking?.routing?.enabled&&(!blockId||x.id===blockId));if(!block?.booking?.routing)throw new GapError('routing_disabled');
 const r=block.booking.routing,index=matchRouting(r,layout,answers),target=index<0?r.fallback:r.rules[index].target;
 if(await routingTargetUsable(db,a,target))return {matchedIndex:index,target,usable:true,blockId:block.id,fellBack:false};
 if(!await routingTargetUsable(db,a,r.fallback))throw new GapError('routing_unavailable',503);
 return {matchedIndex:-1,target:r.fallback,usable:true,blockId:block.id,fellBack:true};
}
export async function loadRoutingLayout(db:D1Database,id:string,a:string,published:boolean){
 const row=await db.prepare(`SELECT f.id,f.content_revision,f.current_published_version_id,${published?'v.layout,v.fields':'f.layout,f.fields'} FROM forms f ${published?'JOIN form_versions v ON v.id=f.current_published_version_id AND v.form_id=f.id':''} WHERE f.id=? ${published?"AND f.is_active=1 AND f.status!='archived'":''} AND EXISTS(SELECT 1 FROM form_accounts fa WHERE fa.form_id=f.id AND fa.line_account_id=?)`).bind(id,a).first<{layout:string;fields:string;content_revision:number;current_published_version_id:string}>();
 if(!row)throw new GapError('form_not_found',404);return {...row,layout:parseLayout(row.layout,row.fields)};
}
async function signingKey(db:D1Database,a:string){const r=await db.prepare('SELECT channel_secret FROM line_accounts WHERE id=? AND is_active=1').bind(a).first<{channel_secret:string}>();if(!r?.channel_secret)throw new GapError('routing_unavailable',503);return crypto.subtle.importKey('raw',new TextEncoder().encode(`booking-routing:v1:${r.channel_secret}`),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
const encode=(b:Uint8Array)=>btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0));
export interface RoutingClaim {account:string;friend:string;formId:string;versionId:string;blockId:string;target:RoutingTarget;matchedIndex:number;exp:number}
export async function issueRoutingToken(db:D1Database,claim:RoutingClaim){const body=encode(new TextEncoder().encode(JSON.stringify(claim))),sig=await crypto.subtle.sign('HMAC',await signingKey(db,claim.account),new TextEncoder().encode(body));return `${body}.${encode(new Uint8Array(sig))}`;}
export async function verifyRoutingToken(db:D1Database,a:string,friend:string,token:unknown,menu:string,staff:string|undefined){
 if(typeof token!=='string'||token.length>8000)throw new GapError('routing_token_invalid');
 try{
  const [body,sig,extra]=token.split('.');if(extra||!sig)throw 0;
  if(!await crypto.subtle.verify('HMAC',await signingKey(db,a),decode(sig),new TextEncoder().encode(body)))throw 0;
  const claim=JSON.parse(new TextDecoder().decode(decode(body))) as RoutingClaim;
  if(claim.account!==a||claim.friend!==friend||claim.exp<Date.now()||claim.target.menuId!==menu||claim.target.staffId&&staff!==undefined&&claim.target.staffId!==staff)throw 0;
  if(!await db.prepare('SELECT id FROM form_versions WHERE id=? AND form_id=?').bind(claim.versionId,claim.formId).first()||!await routingTargetUsable(db,a,claim.target))throw 0;
  if(claim.target.staffGroupId&&staff){const group=await db.prepare('SELECT staff_ids_json FROM booking_routing_staff_groups WHERE id=? AND line_account_id=?').bind(claim.target.staffGroupId,a).first<{staff_ids_json:string}>();if(!group||!(JSON.parse(group.staff_ids_json) as string[]).includes(staff))throw 0;}
  return claim;
 }catch{throw new GapError('routing_token_invalid');}
}
