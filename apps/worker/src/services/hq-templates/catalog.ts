import { normalizeScopedTagName, validateMileageRewardDraft, type MileageRewardDraftInput, type HqTemplateStatement } from '@line-crm/db';


import type { HqCatalogTemplateType, HqCatalogTemplateDefinition } from '@line-crm/shared';
import type { HqTemplateResolution } from './contract.js';
import { boundedText, HqTemplateError, nextAlias } from './tag.js';

export const isCatalogType=(type:string):type is HqCatalogTemplateType=>type==='booking_menu'||type==='mileage_reward';
const own=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const invalid=():never=>{throw new HqTemplateError('INVALID_DEFINITION',422);};
function integer(v:unknown,min:number,max:number,defaultValue?:number):number {
 const n=v===undefined?defaultValue:v;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<min||n>max)return invalid();return n;
}
function optionalText(v:unknown,max:number):string|null {return v==null||v===''?null:boundedText(v,max);}
const bookingKeys=['image_url','paymentMode','name','category_label','description','duration_minutes','buffer_after_minutes','base_price','price_mode','sort_order','concurrent_capacity','booking_window_days','cutoff_hours_before','cancel_deadline_hours_before','intake_question','autoTagName'];
const rewardKeys=['name','description','imageUrl','rewardKind','requiredMiles','stockLimit','perFriendLimit','startsAt','endsAt','benefitExpiresDays','commonActionName','failurePolicy','customerMessage','targetConditions'];
export function parseCatalogDefinition(type:HqCatalogTemplateType,value:unknown):HqCatalogTemplateDefinition {
 if(!own(value)||value.schemaVersion!==1||!own(value.settings)||Object.keys(value).some(k=>!['schemaVersion','settings'].includes(k)))return invalid();
 const raw=value.settings,allowed=type==='booking_menu'?bookingKeys:rewardKeys;
 if(Object.keys(raw).some(k=>!allowed.includes(k)))return invalid();
 if(type==='booking_menu') {
  if(raw.paymentMode!==undefined&&!['default','online','onsite'].includes(String(raw.paymentMode)))return invalid();
  if(raw.image_url!==undefined&&raw.image_url!==null&&(typeof raw.image_url!=='string'||!/^https:\/\//.test(raw.image_url)||raw.image_url.length>2048))return invalid();
  const mode=raw.price_mode??'fixed';if(!['fixed','free','inquiry'].includes(String(mode)))return invalid();
  const s:Record<string,unknown>={paymentMode:raw.paymentMode??'default',image_url:raw.image_url??null,name:boundedText(raw.name,200),category_label:optionalText(raw.category_label,200),description:optionalText(raw.description,10000),duration_minutes:integer(raw.duration_minutes,1,1440),buffer_after_minutes:integer(raw.buffer_after_minutes,0,1440,0),base_price:mode==='fixed'?integer(raw.base_price,0,100000000):0,price_mode:mode,sort_order:integer(raw.sort_order,0,1000000,0),concurrent_capacity:integer(raw.concurrent_capacity,1,100,1),intake_question:optionalText(raw.intake_question,200),autoTagName:optionalText(raw.autoTagName,100)};
  for(const [key,max] of [['booking_window_days',365],['cutoff_hours_before',720],['cancel_deadline_hours_before',720]] as const)s[key]=raw[key]==null?null:integer(raw[key],1,max);
  return {schemaVersion:1,settings:s as unknown as HqCatalogTemplateDefinition['settings']};
 }
 try {
  const actionName=optionalText(raw.commonActionName,200);
  const {commonActionVersionId:_,...validated}=validateMileageRewardDraft({...raw,commonActionVersionId:actionName?'hq-reference':null} as unknown as MileageRewardDraftInput);
  // 手渡しのひな形は未対応。別種類として保存・配布しない。
  const rewardKind = validated.rewardKind;
  if (rewardKind === 'handgift') return invalid();
  // 店別のIDを、統括の名前として解釈して別資源へ結びつけない。
  const walk=(c:typeof validated.targetConditions):void=>{if(!c)return;for(const r of c.rules)if(['friend_field','support_mark','form_answered','scenario_state'].includes(r.type))throw new HqTemplateError('UNSUPPORTED_REFERENCE',422);c.groups?.forEach(walk);};walk(validated.targetConditions);
  return {schemaVersion:1,settings:{...validated,rewardKind,commonActionName:actionName}};
 }catch(e){if(e instanceof HqTemplateError)throw e;return invalid();}
}
const columns:Record<string,string[]>={
 menus:['id','line_account_id',...bookingKeys.filter(k=>!['autoTagName','paymentMode'].includes(k)),'is_active','deleted_at','auto_tag_id','version','created_at','updated_at','hq_template_id','hq_template_version_id','hq_customized'],
 menu_versions:['id','menu_id','version_number','name','category_label','description','duration_minutes','buffer_after_minutes','base_price','price_mode','sort_order','is_active','rules_json','created_at'],
 mileage_rewards:['id','line_account_id','program_id','name','description','image_url','reward_kind','status','sort_order','current_draft_version_id','current_published_version_id','created_at','updated_at','archived_at','folder_id','hq_template_id','hq_template_version_id'],
 mileage_reward_versions:['id','reward_id','version_number','status','required_miles','stock_limit','per_friend_limit','starts_at','ends_at','benefit_expires_days','common_action_version_id','failure_policy','customer_message','created_at','published_at','target_conditions','revision'],
 tags:['id','name','status','version','updated_at'],scenarios:['id','name','is_active','updated_at','current_published_version_id'],
 common_actions:['id','name','status','current_published_version_id','archived_at','updated_at'],
 common_action_versions:['id','common_action_id','version_number','status','action_config'],mileage_programs:['id','name','status','updated_at'],
};
const rows=(table:string,where:string)=>`(SELECT COALESCE(json_group_array(json(row)),'[]') FROM (SELECT json_object(${columns[table].map(c=>`'${c}',${c}`).join(',')}) row FROM ${table} WHERE ${where} ORDER BY id))`;
function snapshotSql(type:HqCatalogTemplateType) {
 const account='(SELECT accountId FROM scope)',table=type==='booking_menu'?'menus':'mileage_rewards',versionTable=type==='booking_menu'?'menu_versions':'mileage_reward_versions',owner=type==='booking_menu'?'menu_id':'reward_id';
 const usage=type==='booking_menu'?`SELECT menu_id id,COUNT(*) n FROM (SELECT menu_id FROM bookings UNION ALL SELECT menu_id FROM staff_menus UNION ALL SELECT menu_id FROM booking_menu_resources) GROUP BY menu_id`:`SELECT reward_id id,COUNT(*) n FROM (SELECT reward_id FROM mileage_redemptions UNION ALL SELECT v.reward_id FROM mileage_reward_codes c JOIN mileage_reward_versions v ON v.id=c.reward_version_id) GROUP BY reward_id`;
 return `WITH scope AS (SELECT ? accountId) SELECT json_object('targets',json(${rows(table,`line_account_id=${account}`)}),'versions',json(${rows(versionTable,`${owner} IN (SELECT id FROM ${table} WHERE line_account_id=${account})`)}),'handgiftIds',json((SELECT COALESCE(json_group_array(reward_id),'[]') FROM (SELECT reward_id FROM mileage_handgift_rewards WHERE reward_id IN (SELECT id FROM mileage_rewards WHERE line_account_id=${account}) ORDER BY reward_id))),'usage',json((SELECT COALESCE(json_group_array(json_object('id',id,'n',n)),'[]') FROM (${usage} ORDER BY id))),'tags',json(${rows('tags',`line_account_id=${account}`)}),'scenarios',json(${rows('scenarios',`line_account_id=${account}`)}),'actions',json(${rows('common_actions',`line_account_id=${account}`)}),'actionVersions',json(${rows('common_action_versions',`common_action_id IN (SELECT id FROM common_actions WHERE line_account_id=${account})`)}),'programs',json(${rows('mileage_programs','1=1')}),'paymentConnected',EXISTS(SELECT 1 FROM booking_payment_connections WHERE line_account_id=${account} AND disconnected_at IS NULL),'style',COALESCE((SELECT style FROM account_styles WHERE line_account_id=${account}),'standard'))`;
}
export async function catalogSnapshot(db:D1Database,accountId:string,type:HqCatalogTemplateType):Promise<string> {
 return (await db.prepare(`SELECT (${snapshotSql(type)}) snapshot`).bind(accountId).first<{snapshot:string}>())!.snapshot;
}
type Row=Record<string,string|number|null>;
interface Snapshot {handgiftIds?:string[];targets:Row[];versions:Row[];usage:Array<{id:string;n:number}>;tags:Row[];scenarios:Row[];actions:Row[];actionVersions:Row[];programs:Row[]}
function named(rows:Row[],name:unknown):Row {
 if(typeof name!=='string'||!name.trim())throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);
 const matches=rows.filter(r=>normalizeScopedTagName(String(r.name))===normalizeScopedTagName(name));
 if(matches.length!==1)throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);return matches[0];
}
/** ひな形は店の同名の資源だけ参照する。実物は作成・公開しない。 */
export function catalogReferences(def:HqCatalogTemplateDefinition,snapshot:string,type:HqCatalogTemplateType) {
 const snap=JSON.parse(snapshot) as Snapshot,s=def.settings as unknown as Record<string,unknown>;
 const items:Array<{sourceId:string;itemKind:string;name:string;targetId:string;expectedRevision:string;duplicate:true;allowedModes:['overwrite'];operation:'reuse'}>=[];
 const add=(key:string,kind:string,name:unknown,row:Row)=>{if(!items.some(i=>i.sourceId===key))items.push({sourceId:key,itemKind:kind,name:String(name),targetId:String(row.id),expectedRevision:JSON.stringify(row),duplicate:true,allowedModes:['overwrite'],operation:'reuse'});};
 const tag=(name:unknown)=>{const row=named(snap.tags.filter(r=>r.status==='active'),name);add(`tag:${name}`,'tag',name,row);return row.id;};
 if(type==='booking_menu'&&s.autoTagName)tag(s.autoTagName);
 if(type==='mileage_reward') {
  if(!snap.programs.some(r=>r.id==='default'&&r.status==='active'))throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);
  if(s.commonActionName){const row=named(snap.actions.filter(r=>r.status==='published'&&!r.archived_at),s.commonActionName),v=snap.actionVersions.find(v=>v.id===row.current_published_version_id&&v.status==='published');if(!v)throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);add('commonActionName','common_action',s.commonActionName,{...row,id:v.id,action_config:v.action_config});}
  const walk=(c:unknown):void=>{if(!own(c))return;for(const r of c.rules as Array<{type:string;value:unknown}>){if(['tag_exists','tag_not_exists'].includes(r.type))tag(r.value);if(['tag_all','tag_not_all'].includes(r.type)){if(!Array.isArray(r.value)||!r.value.length)invalid();for(const name of r.value as unknown[])tag(name);}if(r.type==='scenario_subscribed'&&r.value){const row=named(snap.scenarios.filter(r=>r.is_active===1),r.value);add(`scenario:${r.value}`,'scenario',r.value,row);}}if(Array.isArray(c.groups))c.groups.forEach(walk);};walk(s.targetConditions);
 }
 return items;
}
export interface CatalogItem {sourceId:string;itemKind:string;name:string;targetId:string|null;expectedRevision:string|null;duplicate:boolean;allowedModes:Array<'create'|'overwrite'|'alias'>;operation?:'reuse'}
export function inspectCatalog(def:HqCatalogTemplateDefinition,snapshot:string,type:HqCatalogTemplateType):CatalogItem[] {
 const snap=JSON.parse(snapshot) as Snapshot,name=def.settings.name,same=snap.targets.filter(r=>normalizeScopedTagName(String(r.name))===normalizeScopedTagName(name));
 if(type==='booking_menu'){return [{sourceId:type,itemKind:type,name,targetId:null,expectedRevision:null,duplicate:!!same.length,allowedModes:['create']},...catalogReferences(def,snapshot,type)];}
 if(same.length>1)throw new HqTemplateError('VERSION_CONFLICT',409);
 const row=same[0],versions=snap.versions.filter(v=>v.reward_id===row?.id),used=snap.usage.some(u=>u.id===row?.id&&u.n>0);
 const safe=!!row&&!snap.handgiftIds?.includes(String(row.id))&&!used&&(row.status==='draft'&&!row.archived_at&&!row.current_published_version_id&&versions.every(v=>v.status==='draft'));
 return [{sourceId:type,itemKind:type,name,targetId:row?String(row.id):null,expectedRevision:row?JSON.stringify(row):null,duplicate:!!row,allowedModes:(row?safe?['overwrite','alias']:['alias']:['create']) as Array<'create'|'overwrite'|'alias'>},...catalogReferences(def,snapshot,type)];
}
export function planCatalog(accountId:string,def:HqCatalogTemplateDefinition,snapshot:string,type:HqCatalogTemplateType,resolutions:readonly HqTemplateResolution[],origin?:{templateId:string;versionId:string}) {
 const snap=JSON.parse(snapshot) as Snapshot,items=inspectCatalog(def,snapshot,type),root=items[0],selected=resolutions.find(r=>r.sourceId===type);
 if(!selected||resolutions.length!==items.length||!root.allowedModes.includes(selected.mode)||items.slice(1).some(i=>!resolutions.some(r=>r.sourceId===i.sourceId&&r.mode==='overwrite')))throw new HqTemplateError('SELECTION_REQUIRED',409);
 const id=selected.mode==='overwrite'?root.targetId!:crypto.randomUUID(),name=selected.mode==='alias'?nextAlias(def.settings.name,snap.targets.map(r=>String(r.name))):def.settings.name;
 const existing=snap.targets.find(r=>r.id===id),s={...def.settings,name} as unknown as Record<string,unknown>;
 const statements:HqTemplateStatement[]=[{sql:`SELECT json(CASE WHEN (${snapshotSql(type)})=? THEN '{}' ELSE 'VERSION_CONFLICT' END)`,bindings:[accountId,snapshot]}];
 const add=(sql:string,bindings:HqTemplateStatement['bindings'])=>statements.push({sql,bindings});
 const refs=items.slice(1),tagId=s.autoTagName?refs.find(r=>r.sourceId===`tag:${s.autoTagName}`)!.targetId:null;
 if(type==='booking_menu') {
  if((JSON.parse(snapshot) as {style?:string}).style==='ec')throw new HqTemplateError('BOOKING_NOT_USED',422);
  const data:Record<string,string|number|null>={...Object.fromEntries(bookingKeys.filter(k=>!['autoTagName','paymentMode'].includes(k)).map(k=>[k,s[k] as string|number|null])),auto_tag_id:tagId};
  if(existing){const keys=Object.keys(data);add(`UPDATE menus SET ${keys.map(k=>`${k}=?`).join(',')},version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND line_account_id=?`,[...keys.map(k=>data[k]),id,accountId]);}
  else {const keys=Object.keys(data);add(`INSERT INTO menus(id,line_account_id,${keys.join(',')},is_active) VALUES (?,?,${keys.map(()=>'?').join(',')},0)`,[id,accountId,...keys.map(k=>data[k])]);}
  if(origin)add('UPDATE menus SET hq_template_id=?,hq_template_version_id=?,hq_customized=0 WHERE id=? AND line_account_id=?',[origin.templateId,origin.versionId,id,accountId]);
  if(s.paymentMode!=='default')add(`INSERT INTO booking_payment_menu_settings(menu_id,line_account_id,mode,provider,created_at,updated_at) VALUES(?,?,?, ?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(menu_id) DO UPDATE SET mode=excluded.mode,provider=excluded.provider`,[id,accountId,s.paymentMode==='online'&&(JSON.parse(snapshot) as {paymentConnected?:number}).paymentConnected?'online':'onsite',s.paymentMode==='online'&&(JSON.parse(snapshot) as {paymentConnected?:number}).paymentConnected?'stripe':'onsite']);
  add(`INSERT INTO menu_versions(id,menu_id,version_number,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,price_mode,sort_order,is_active,rules_json) SELECT ?,id,version,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,price_mode,sort_order,is_active,json_object('concurrent_capacity',concurrent_capacity,'booking_window_days',booking_window_days,'cutoff_hours_before',cutoff_hours_before,'cancel_deadline_hours_before',cancel_deadline_hours_before,'intake_question',intake_question) FROM menus WHERE id=? AND line_account_id=?`,[crypto.randomUUID(),id,accountId]);
 } else {
  const actionId=refs.find(r=>r.sourceId==='commonActionName')?.targetId??null;
  const remap=(v:unknown):unknown=>{if(Array.isArray(v))return v.map(remap);if(!own(v))return v;if(typeof v.type==='string'&&['tag_exists','tag_not_exists','tag_all','tag_not_all','scenario_subscribed'].includes(v.type)){const kind=v.type==='scenario_subscribed'?'scenario':'tag',map=(x:unknown)=>refs.find(r=>r.sourceId===`${kind}:${x}`)?.targetId??x;return {...v,value:Array.isArray(v.value)?v.value.map(map):map(v.value)};}return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,remap(x)]));};
  const d=validateMileageRewardDraft({...s,commonActionVersionId:actionId,targetConditions:remap(s.targetConditions)} as unknown as MileageRewardDraftInput);
  const previous=snap.versions.find(v=>v.id===existing?.current_draft_version_id),versionId=previous?String(previous.id):crypto.randomUUID();
  if(existing)add(`UPDATE mileage_rewards SET name=?,description=?,image_url=?,reward_kind=?,current_draft_version_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND line_account_id=?`,[name,d.description,d.imageUrl,d.rewardKind,versionId,id,accountId]);
  else add(`INSERT INTO mileage_rewards(id,line_account_id,program_id,name,description,image_url,reward_kind,status,current_draft_version_id) VALUES (?,?,'default',?,?,?,?,'draft',?)`,[id,accountId,name,d.description,d.imageUrl,d.rewardKind,versionId]);
  if(origin)add('UPDATE mileage_rewards SET hq_template_id=?,hq_template_version_id=? WHERE id=? AND line_account_id=?',[origin.templateId,origin.versionId,id,accountId]);
  const vals=[d.requiredMiles,d.stockLimit,d.perFriendLimit,d.startsAt,d.endsAt,d.benefitExpiresDays,d.commonActionVersionId,d.failurePolicy,d.customerMessage,d.targetConditions?JSON.stringify(d.targetConditions):null];
  const cols=['required_miles','stock_limit','per_friend_limit','starts_at','ends_at','benefit_expires_days','common_action_version_id','failure_policy','customer_message','target_conditions'];
  if(previous)add(`UPDATE mileage_reward_versions SET ${cols.map(k=>`${k}=?`).join(',')},revision=revision+1 WHERE id=? AND reward_id=? AND status='draft'`,[...vals,versionId,id]);
  else add(`INSERT INTO mileage_reward_versions(id,reward_id,version_number,status,${cols.join(',')}) VALUES (?,?,(SELECT COALESCE(MAX(version_number),0)+1 FROM mileage_reward_versions WHERE reward_id=?),'draft',${cols.map(()=>'?').join(',')})`,[versionId,id,id,...vals]);
 }
 return {statements,resolutions:[{...selected,targetId:id,aliasName:selected.mode==='alias'?name:undefined},...refs.map(r=>({sourceId:r.sourceId,itemKind:r.itemKind,mode:'overwrite' as const,targetId:r.targetId??undefined,expectedRevision:r.expectedRevision??undefined}))],counts:{created:selected.mode==='create'?1:0,overwritten:selected.mode==='overwrite'?1:0,aliased:selected.mode==='alias'?1:0}};
}

export function catalogWarnings(def:HqCatalogTemplateDefinition,snapshot:string,type:HqCatalogTemplateType){
 const s=JSON.parse(snapshot) as {style:string;paymentConnected:number;targets:Row[]},settings=def.settings as unknown as Record<string,unknown>;
 if(type!=='booking_menu')return [];
 return [...(s.targets.some(t=>normalizeScopedTagName(String(t.name))===normalizeScopedTagName(settings.name as string))?['same_name_exists']:[]),...(settings.paymentMode==='online'&&!s.paymentConnected?['payment_downgraded_to_store']:[]),...(s.style==='ec'?['booking_not_used']:[]),'booking_reception_stopped','staff_selection_required'];
}

/** 配布の共通トランザクションでは、統括に限定した予約メニューのアダプターを使う。 */
export function createBookingMenuHqAdapter(db:D1Database,authority:import('./contract.js').HqTemplateAuthority):import('./contract.js').HqTemplateAdapter {
 const ok=<T>(value:T)=>({kind:'OK' as const,value});
 return {type:'booking_menu',
  async extractReferences(input){parseCatalogDefinition('booking_menu',JSON.parse(input.definitionJson));return ok([{kind:'booking_menu',sourceId:'booking_menu'}]);},
  async verifyReferences(context,references){if(context.tenantId!==authority.tenantId||!await db.prepare('SELECT id FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL').bind(context.targetAccountId,authority.tenantId).first())throw new HqTemplateError('FORBIDDEN',403);return ok(references.map(r=>({...r,targetId:r.sourceId})));},
  async detectDuplicates(){return ok([]);},async buildIdMap(){return ok({});},
  async buildCommitPlan(context,input){
   const version=await db.prepare('SELECT template_id FROM hq_template_versions WHERE id=? AND tenant_id=? AND definition_json=?').bind(input.templateVersionId,authority.tenantId,input.definitionJson).first<{template_id:string}>();if(!version)throw new HqTemplateError('VERSION_CONFLICT',409);
   const snapshot=await catalogSnapshot(db,context.targetAccountId,'booking_menu'),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(snapshot))),n=>n.toString(16).padStart(2,'0')).join('');if(`hqts1.${digest}`!==context.snapshotToken)throw new HqTemplateError('VERSION_CONFLICT',409);
   const plan=planCatalog(context.targetAccountId,parseCatalogDefinition('booking_menu',JSON.parse(input.definitionJson)),snapshot,'booking_menu',context.resolutions,{templateId:version.template_id,versionId:input.templateVersionId});
   return ok({tenantId:authority.tenantId,targetAccountId:context.targetAccountId,preflightId:context.preflightId,idempotencyFingerprint:context.idempotencyFingerprint,snapshotToken:context.snapshotToken,mode:context.mode,resolutions:plan.resolutions,stage:[],dbCommit:plan.statements,compensateOnDbFailure:[],reconcile:[]});
  },
 };
}
