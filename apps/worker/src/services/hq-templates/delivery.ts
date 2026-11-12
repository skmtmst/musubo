import { jstNow, type HqTemplateStatement, type AutoReplyDraftSettings, type FriendAddRuleDefinition, type ReminderDraftSettings } from '@line-crm/db';




import { HQ_DELIVERY_TEMPLATE_TYPES, type HqDeliveryTemplateType, type HqDeliveryTemplateDefinition } from '@line-crm/shared';

import { readDraftSettings as readAutoReplySettings } from '../../routes/auto-replies.js';
import { readDraftSettings as readReminderSettings, validateReminderDraftReferences } from '../../routes/reminders.js';
import { validateInput as validateFriendAddInput, validateReferences as validateFriendAddReferences } from '../../routes/friend-add-rules.js';
import { boundedText, HqTemplateError, nextAlias } from './tag.js';
import type { HqTemplateResolution } from './contract.js';
export const isDeliveryType = (type: string): type is HqDeliveryTemplateType => (HQ_DELIVERY_TEMPLATE_TYPES as readonly string[]).includes(type);
const own = (value: unknown): value is Record<string, unknown> => !!value && typeof value==='object' && !Array.isArray(value);
const KEY_KINDS: Record<string,string> = { assetId:'coupon',templateId:'template',formId:'form',scenarioId:'scenario',tagIds:'tag',tagId:'tag',targetTagId:'tag',visibleTagId:'tag',fieldId:'friend_field',triggerFieldId:'friend_field',markId:'mark',markIds:'mark',eventId:'event',triggerEventId:'event',reminderId:'reminder',routeIds:'entry_route',varKey:'common_var',folderId:'tag_folder',notificationRuleId:'notification_rule' };
const ACTION_KINDS: Record<string,string> = {add_tag:'tag',remove_tag:'tag',start_scenario:'scenario',set_friend_field:'friend_field',add_support_mark:'mark',use_common_var:'common_var'};
const CONDITION_KINDS: Record<string,string> = {
  tag_exists:'tag',tag_not_exists:'tag',tag_all:'tag',tag_not_all:'tag',
  scenario_subscribed:'scenario',form_answered:'form',
  tag:'tag',friend_field:'friend_field',support_mark:'mark',scenario:'scenario',event_booking:'event',reminder:'reminder',
};
// IDを読む箇所と書き換える箇所で同じ条件の語彙を使う。valueが物体なら中を読む。
function referenceKind(key:string,parent:Record<string,unknown>):string|undefined {
  return KEY_KINDS[key]
    ?? (key==='messageText' && ['template','form','scenario'].includes(String(parent.messageType))?String(parent.messageType):undefined)
    ?? (key==='targetId'?ACTION_KINDS[String(parent.type)]:undefined)
    ?? (key==='value' && (typeof parent.value==='string'||Array.isArray(parent.value))?CONDITION_KINDS[String(parent.type)]:undefined);
}
// 条件の中にもIDがある。読めない形式を通して他店の資源へ結びつけない。
function referencesIn(value: unknown, output: Array<{id:string;kind:string}> = []): Array<{id:string;kind:string}> {
  if(Array.isArray(value)) { for(const v of value) referencesIn(v,output); return output; }
  if(!own(value)) return output;
  for(const [key,v] of Object.entries(value)) {
    if(key==='slotId' && v!=null && v!=='') throw new HqTemplateError('UNSUPPORTED_REFERENCE',422);
    const kind=referenceKind(key,value);
    if(kind && v!=null && v!=='') {
      for(const id of Array.isArray(v)?v:[v]) { if(typeof id!=='string') throw new HqTemplateError('INVALID_DEFINITION',422); output.push({id,kind}); }
    }
    if(['responseContent','friendCondition','config_json','condition','config'].includes(key) && (key!=='responseContent'||value.responseType==='coupon') && typeof v==='string' && v.trim()) { try { referencesIn(JSON.parse(v),output); } catch { throw new HqTemplateError('INVALID_DEFINITION',422); } }
    else referencesIn(v,output);
  }
  return output;
}
async function readSettings(db:D1Database,type:HqDeliveryTemplateType,settings:Record<string,unknown>,accountId:string,checkReferences:boolean) {
  if(type==='auto_reply') {
    const r=await readAutoReplySettings(db,{...settings,lineAccountId:accountId,folderId:null},checkReferences);
    if(!r.ok) throw new HqTemplateError('INVALID_DEFINITION',422);
    return r.value;
  }
  if(type==='reminder') {
    const r=readReminderSettings({...settings,lineAccountId:accountId,folderId:null});
    if(!r.ok || r.value.steps.some(s=>!s.stableStepId)) throw new HqTemplateError('INVALID_DEFINITION',422);
    if(checkReferences && await validateReminderDraftReferences(db,r.value)) throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);
    return r.value;
  }
  const definition=settings.definition as FriendAddRuleDefinition;
  if(!own(definition) || !Array.isArray(definition.routeIds) || !Array.isArray(definition.actions) || typeof definition.friendCondition!=='string' || !['text','template','form','scenario'].includes(definition.messageType) || !['immediate','scenario'].includes(definition.timing) || typeof definition.messageText!=='string' || definition.actions.some(a=>!own(a)||!['add_tag','remove_tag','start_scenario','set_friend_field','add_support_mark','grant_mileage','use_common_var'].includes(a.type))) throw new HqTemplateError('INVALID_DEFINITION',422);
  if(validateFriendAddInput(settings as never)) throw new HqTemplateError('INVALID_DEFINITION',422);
  if(checkReferences && (await validateFriendAddReferences(db,accountId,definition,settings.friendKind as 'first_time'|'returning',{allowIncomplete:true})).length) throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);
  return settings;
}
export async function parseDeliveryDefinition(db:D1Database,type:HqDeliveryTemplateType,value:unknown):Promise<HqDeliveryTemplateDefinition> {
  if(!own(value) || value.schemaVersion!==1 || !own(value.settings) || Object.keys(value).some(k=>!['schemaVersion','settings','references'].includes(k))) throw new HqTemplateError('INVALID_DEFINITION',422);
  const allowedSettings:Record<HqDeliveryTemplateType,string[]>={
    auto_reply:['name','keyword','matchType','responseType','responseContent','templateId','activeFrom','activeUntil','cooldownMinutes','skipWhenOperatorActive','priority','messageKinds','receiveSources','friendConditions','actions','responseWeekdays','responseHolidayRule','oncePerFriend','keywords','respondToAll','keywordMatchMode','normalizeKeywords','internalMemo','replyDelaySeconds','unmatchedAction'],
    friend_add_rule:['name','friendKind','priority','definition'],
    reminder:['name','description','triggerType','deliveryMode','triggerFieldId','triggerEventId','repeatYearly','leapYearPolicy','triggerOffsetMinutes','sendAtTime','targetTagId','targetCondition','stopConditions','steps'],
  };
  if(Object.keys(value.settings).some(k=>!allowedSettings[type].includes(k))) throw new HqTemplateError('UNSUPPORTED_REFERENCE',422);
  const settings:Record<string,unknown>&{name:string}={...value.settings,name:boundedText(value.settings.name,60)};
  if(Object.hasOwn(settings,'lineAccountId') || Object.hasOwn(settings,'folderId')) throw new HqTemplateError('UNSUPPORTED_REFERENCE',422);
  const references=value.references??[];
  if(!Array.isArray(references) || references.length>100 || references.some(r=>!own(r)||!['sourceId','kind','name'].every(k=>typeof r[k]==='string'&&!!r[k])||!['coupon','tag','template','scenario','form','friend_field','mark','event','reminder','entry_route','common_var','tag_folder','notification_rule'].includes(r.kind as string)||Object.keys(r).some(k=>!['sourceId','kind','name','accountId'].includes(k))) || new Set(references.map(r=>r.sourceId)).size!==references.length) throw new HqTemplateError('INVALID_DEFINITION',422);
  for (const ref of references) if (ref.accountId !== undefined) {
    if(typeof ref.accountId !== 'string' || !ref.accountId || ref.accountId.length>100) throw new HqTemplateError('INVALID_DEFINITION',422);
    const scope=await db.prepare("SELECT a.id FROM line_accounts a WHERE a.id=? AND a.is_active=1 AND a.archived_at IS NULL").bind(ref.accountId).first();
    if(!scope) throw new HqTemplateError('REFERENCE_UNAVAILABLE',422);
  }
  const used=referencesIn(settings);
  if(used.some(r=>!references.some(ref=>ref.sourceId===r.id&&ref.kind===r.kind)) || references.some(r=>!used.some(ref=>ref.id===r.sourceId&&ref.kind===r.kind))) throw new HqTemplateError('REFERENCE_UNAVAILABLE',422);
  await readSettings(db,type,settings,'hq-validation',false);
  // 安定した通知ステップIDは保存時点で必須。再確認ごとに作り直さない。
  if(type==='reminder' && (!Array.isArray(settings.steps) || settings.steps.some(s=>!own(s)||typeof s.stableStepId!=='string'||!s.stableStepId))) throw new HqTemplateError('INVALID_DEFINITION',422);
  return {schemaVersion:1,settings,references:references as HqDeliveryTemplateDefinition['references']};
}
const TABLES={auto_reply:'auto_replies',friend_add_rule:'friend_add_rules',reminder:'reminders'} as const;
// 版・利用状況も含める。親の時刻が変わらない編集や登録も競合として止める。
const SNAPSHOT_COLUMNS: Record<string, readonly string[]> = {
  auto_replies: ["id", "keyword", "match_type", "response_type", "response_content", "template_id", "line_account_id", "is_active", "created_at", "actions_json", "response_weekdays_json", "response_holiday_rule", "once_per_friend", "keywords_json", "respond_to_all", "name", "keyword_match_mode", "active_from", "active_until", "cooldown_minutes", "skip_when_operator_active", "folder_id", "display_order", "priority", "message_kinds_json", "friend_conditions_json", "lifecycle_status", "current_draft_version_id", "current_published_version_id", "created_from_recipe_id", "recipe_clone_run_id", "stopped_at", "stopped_by_staff_id", "stop_reason", "stop_idempotency_key", "deleted_at", "deleted_by_staff_id"],
  auto_reply_versions: ["id", "auto_reply_id", "version_number", "line_account_id", "definition_snapshot", "status", "published_at", "published_by_staff_id", "created_at", "last_test_status", "last_tested_at", "last_tested_by_staff_id", "publish_idempotency_key", "updated_at"],
  friend_add_rules: ["id", "line_account_id", "friend_kind", "name", "folder_name", "priority", "is_unknown_route_fallback", "status", "current_version_id", "create_idempotency_key", "archived_at", "created_at", "updated_at", "lock_version", "stop_idempotency_key", "stopped_at", "stopped_by_staff_id", "created_from_recipe_id", "recipe_clone_run_id", "folder_id"],
  friend_add_rule_versions: ["id", "rule_id", "version_number", "definition_snapshot", "status", "last_test_status", "last_tested_at", "last_tested_by_staff_id", "draft_save_idempotency_key", "published_at", "published_by_staff_id", "publish_idempotency_key", "created_at", "updated_at"],
  reminders: ["id", "name", "description", "is_active", "line_account_id", "trigger_type", "trigger_offset_minutes", "send_at_time", "target_tag_id", "folder_id", "delivery_mode", "trigger_field_id", "repeat_yearly", "created_at", "updated_at", "display_order", "deleted_at", "lifecycle_status", "current_draft_version_id", "current_published_version_id", "created_from_recipe_id", "recipe_clone_run_id", "trigger_event_id", "leap_year_policy"],
  reminder_versions: ["id", "reminder_id", "version_number", "status", "settings_snapshot", "last_test_status", "last_tested_at", "last_tested_by_staff_id", "published_at", "published_by_staff_id", "created_at", "updated_at"],
  reminder_version_steps: ["id", "reminder_version_id", "stable_step_id", "position", "offset_minutes", "message_type", "message_content", "offset_days", "send_at_time", "template_id", "target_condition_json", "action_json", "created_at"],
  templates: ["id", "name", "category", "message_type", "message_content", "carousel_actions_json", "carousel_tap_limit_mode", "carousel_tap_limit_text", "question_json", "question_status", "created_at", "updated_at", "folder_id", "display_order", "line_account_id", "created_from_recipe_id", "recipe_clone_run_id", "published_version", "published_at", "draft_message_type", "draft_message_content", "draft_carousel_actions_json", "draft_carousel_tap_limit_mode", "draft_carousel_tap_limit_text", "draft_question_json", "draft_question_status", "publish_idempotency_key", "draft_revision", "message_bubbles_json", "draft_message_bubbles_json"],
  tags: ["id", "name", "color", "mileage_reward", "referral_mileage_reward", "mileage_multiplier_bps", "mileage_multiplier_priority", "created_at", "group_id", "folder_id", "is_starred", "display_order", "line_account_id", "description", "normalized_name", "manual_assignment_allowed", "reapply_policy", "linked_enabled", "status", "version", "created_by", "updated_by", "updated_at", "created_from_recipe_id", "recipe_clone_run_id"],
  scenarios: ["id", "name", "description", "trigger_type", "trigger_tag_id", "is_active", "delivery_mode", "created_at", "updated_at", "line_account_id", "folder_id", "display_order", "allow_concurrent", "audience_condition_json", "on_complete_mode", "on_complete_scenario_id", "created_from_recipe_id", "recipe_clone_run_id", "current_published_version_id", "stopped_reason", "stopped_by", "stopped_at"],
  forms: ["id", "name", "description", "fields", "on_submit_tag_id", "on_submit_scenario_id", "save_to_metadata", "is_active", "submit_count", "created_at", "updated_at", "on_submit_message_type", "on_submit_message_content", "on_submit_webhook_url", "on_submit_webhook_headers", "on_submit_webhook_fail_message", "og_title", "og_description", "og_image_url", "layout", "status", "archived_at", "revision", "content_revision", "current_published_version_id", "folder_id"],
  friend_fields: ["id", "folder_id", "name", "field_key", "type", "options_json", "default_value", "source", "ec_field_path", "ec_is_master", "is_personal", "is_starred", "display_order", "created_at", "updated_at", "status", "version", "type_v6", "type_v8"],
  support_marks: ["id", "name", "color", "is_default", "auto_on_inbound", "display_order", "created_at", "archived_at", "version", "updated_at", "created_by", "updated_by"],
  events: ["id", "line_account_id", "name", "venue_name", "venue_url", "image_url", "description", "description_centered", "max_bookings_per_friend", "requires_approval", "cancel_deadline_hours_before", "reminder_day_before_enabled", "reminder_hours_before", "is_published", "folder_id", "sort_order", "deleted_at", "created_at", "updated_at", "target_type", "account_ids", "dedup_priority", "failed_account_ids", "confirmation_message_extra", "reminder_message_extra", "og_title", "og_description", "og_image_url", "visible_tag_id", "waitlist_enabled", "entry_cutoff_hours_before", "version", "current_published_version_id", "version_write_token", "approval_deadline_hours", "questions_json", "lifecycle_status", "lifecycle_changed_at", "lifecycle_change_reason", "venue_address"],
  entry_routes: ["id", "ref_code", "name", "tag_id", "scenario_id", "redirect_url", "is_active", "created_at", "updated_at", "pool_id", "intro_template_id", "run_account_friend_add_scenarios", "genre", "tenant_id", "line_account_id", "stopped_at", "stopped_reason"],
  common_vars: ["id", "folder_id", "name", "var_key", "type", "value", "created_at", "updated_at", "line_account_id", "memo", "version", "updated_by", "archived_at", "replacement_run_id", "valid_from", "valid_until", "fallback_value", "expiry_behavior", "status", "stopped_at", "expiry_notice_14_at", "expiry_notice_3_at"],
  broadcast_message_assets: ['id','name','kind','payload_json','published_version','updated_at','line_account_id'],
  notification_rules: ["id", "name", "event_type", "conditions", "channels", "line_account_id", "is_active", "created_at", "updated_at", "version"],
  folders: ["id", "kind", "name", "parent_id", "display_order", "created_at", "updated_at", "color", "account_id", "revision"],
};
function recordJson(table:string,alias:string) { return `json_object(${SNAPSHOT_COLUMNS[table].map(c=>`'${c}',${alias}.${c}`).join(',')})`; }
function rowsJson(table:string,alias:string,where:string,order='id') { return `(SELECT COALESCE(json_group_array(json(row)),'[]') FROM (SELECT ${recordJson(table,alias)} row FROM ${table} ${alias} WHERE ${where} ORDER BY ${alias}.${order}))`; }
function snapshotSql(type:HqDeliveryTemplateType) {
  const table=TABLES[type],scope='(SELECT account_id FROM scope)';
  const versionTable=type==='auto_reply'?'auto_reply_versions':type==='friend_add_rule'?'friend_add_rule_versions':'reminder_versions';
  const owner=type==='auto_reply'?'auto_reply_id':type==='friend_add_rule'?'rule_id':'reminder_id';
  const used=type==='auto_reply'?`(SELECT COUNT(*) FROM auto_reply_evaluations WHERE winning_auto_reply_id=t.id)+(SELECT COUNT(*) FROM auto_reply_hits WHERE auto_reply_id=t.id)`:
    type==='friend_add_rule'?`(SELECT COUNT(*) FROM friend_add_events WHERE routing_rule_id=t.id)`:`(SELECT COUNT(*) FROM friend_reminders WHERE reminder_id=t.id)`;
  const children=type==='reminder'?rowsJson('reminder_version_steps','child',`child.reminder_version_id IN (SELECT id FROM reminder_versions WHERE reminder_id=t.id)`):"'[]'";
  const targets=`(SELECT COALESCE(json_group_array(json(row)),'[]') FROM (SELECT json_object('record',json(${recordJson(table,'t')}),'versions',json(${rowsJson(versionTable,'v',`v.${owner}=t.id`,'version_number')}),'children',json(${children}),'usage',${used}) row FROM ${table} t WHERE t.line_account_id=${scope} ORDER BY t.id))`;
  const references=['broadcast_message_assets','templates','tags','scenarios','events','entry_routes','common_vars','reminders','notification_rules'].map(table=>`'${table}',json(${rowsJson(table,'ref',`ref.line_account_id=${scope}`)})`);
  references.push(`'folders',json(${rowsJson('folders','ref',`ref.account_id=${scope} AND ref.kind='tag'`)})`);
  references.push(`'forms',json(${rowsJson('forms','ref',`EXISTS(SELECT 1 FROM form_accounts fa WHERE fa.form_id=ref.id AND fa.line_account_id=${scope})`)})`);
  references.push(`'fields',json(${rowsJson('friend_fields','ref',`EXISTS(SELECT 1 FROM friend_field_scopes fs WHERE fs.field_id=ref.id AND fs.line_account_id=${scope})`)})`);
  references.push(`'marks',json(${rowsJson('support_marks','ref',`EXISTS(SELECT 1 FROM support_mark_scopes ms WHERE ms.mark_id=ref.id AND ms.line_account_id=${scope})`)})`);
  return `WITH scope AS (SELECT ? AS account_id) SELECT json_object('targets',json(${targets}),'references',json_object(${references.join(',')}))`;
}
export async function deliverySnapshot(db:D1Database,accountId:string,type:HqDeliveryTemplateType):Promise<string> {
  const row=await db.prepare(`SELECT (${snapshotSql(type)}) AS snapshot`).bind(accountId).first<{snapshot:string}>();
  if(!row) throw new HqTemplateError('VERSION_CONFLICT',409);
  return row.snapshot;
}
type Target={record:Record<string,unknown> & {id:string;name:string|null;keyword?:string;priority?:number};versions:Array<{id:string;status:string}>;children:unknown[];usage:number};
export function inspectDelivery(def:HqDeliveryTemplateDefinition,snapshot:string,type:HqDeliveryTemplateType) {
  const rows=(JSON.parse(snapshot) as {targets:Target[]}).targets;
  const same=rows.filter(r=>String(r.record.name??r.record.keyword).normalize('NFKC').toLowerCase()===def.settings.name.normalize('NFKC').toLowerCase());
  if(same.length>1) throw new HqTemplateError('VERSION_CONFLICT',409);
  const row=same[0],r=row?.record;
  const safe=!!row && row.versions.length<=1 && (r!.status??r!.lifecycle_status)==='draft' && !r!.is_active && !r!.current_published_version_id && !r!.deleted_at && !r!.archived_at && !row.usage && row.versions.every(v=>v.status==='draft') && (type!=='friend_add_rule'||r!.friend_kind===def.settings.friendKind);
  return [{sourceId:type,itemKind:type,name:def.settings.name,targetId:r?.id??null,expectedRevision:row?JSON.stringify(row):null,duplicate:!!row,allowedModes:(row?safe?['overwrite','alias']:['alias']:['create']) as Array<'create'|'overwrite'|'alias'>}];
}
export async function deliveryReferenceItems(db:D1Database,accountId:string,def:HqDeliveryTemplateDefinition,initialDraft=false) {
  const items:Array<{sourceId:string;itemKind:string;name:string;targetId:string;expectedRevision:string;duplicate:true;allowedModes:['overwrite'];operation:'reuse'}>=[];
  for(const ref of def.references??[]) {
    const table:Record<string,string>={coupon:'broadcast_message_assets',tag:'tags',template:'templates',scenario:'scenarios',form:'forms',friend_field:'friend_fields',mark:'support_marks',event:'events',reminder:'reminders',entry_route:'entry_routes',common_var:'common_vars',tag_folder:'folders',notification_rule:'notification_rules'};
    let scope='line_account_id=?';const bindings:string[]=[accountId,ref.name];
    if(ref.kind==='coupon') scope+=initialDraft?" AND kind='coupon'":" AND kind='coupon' AND published_version>0";
    if(ref.kind==='tag_folder') scope="account_id=? AND kind='tag'";
    if(ref.kind==='form') scope='EXISTS(SELECT 1 FROM form_accounts fa WHERE fa.form_id=forms.id AND fa.line_account_id=?)';
    if(ref.kind==='friend_field') scope='EXISTS(SELECT 1 FROM friend_field_scopes fs WHERE fs.field_id=friend_fields.id AND fs.line_account_id=?)';
    if(ref.kind==='mark') scope='EXISTS(SELECT 1 FROM support_mark_scopes ms WHERE ms.mark_id=support_marks.id AND ms.line_account_id=?)';
    const rows=(await db.prepare(`SELECT *,${ref.kind==='common_var'?'var_key':'id'} AS target_id FROM ${table[ref.kind]} WHERE ${scope} AND name=?${ref.accountId===accountId?' AND id=?':''} ORDER BY id`).bind(...bindings,...(ref.accountId===accountId?[ref.sourceId]:[])).all<Record<string,unknown>&{target_id:string}>()).results;
    if(rows.length!==1) throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);
    if (ref.accountId && ref.accountId !== accountId) {
      const source=await db.prepare('SELECT tenant_id FROM line_accounts WHERE id=? AND is_active=1 AND archived_at IS NULL').bind(ref.accountId).first<{tenant_id:string}>();
      const target=await db.prepare('SELECT tenant_id FROM line_accounts WHERE id=?').bind(accountId).first<{tenant_id:string}>();
      if(!source || source.tenant_id!==target?.tenant_id) throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);
    }
    const revision=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(rows[0])))),b=>b.toString(16).padStart(2,'0')).join('');
    items.push({sourceId:`${ref.kind}:${ref.sourceId}`,itemKind:ref.kind,name:ref.name,targetId:rows[0].target_id,expectedRevision:revision,duplicate:true,allowedModes:['overwrite'],operation:'reuse'});
  }
  return items;
}
async function mapSettings(db:D1Database,accountId:string,def:HqDeliveryTemplateDefinition,initialDraft=false) {
  const items=await deliveryReferenceItems(db,accountId,def,initialDraft);
  const mapped=new Map((def.references??[]).map((r,i)=>[r.sourceId,items[i].targetId]));
  const transform=(value:unknown):unknown=> {
    if(Array.isArray(value)) return value.map(transform);
    if(!own(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key,v])=>{
      const kind=referenceKind(key,value);
      if(kind) return [key,Array.isArray(v)?v.map(id=>mapped.get(String(id))??id):mapped.get(String(v))??v];
      if(['responseContent','friendCondition','config_json','condition','config'].includes(key) && (key!=='responseContent'||value.responseType==='coupon') && typeof v==='string' && v.trim()) return [key,JSON.stringify(transform(JSON.parse(v)))];
      return [key,transform(v)];
    }));
  };
  const settings=transform(def.settings) as Record<string,unknown>;
  if(settings.responseType==='coupon') {
    const payload=JSON.parse(String(settings.responseContent));
    const asset=await db.prepare(`SELECT payload_json,name FROM broadcast_message_assets WHERE id=? AND line_account_id=? AND kind='coupon' ${initialDraft?'':'AND published_version>0'}`).bind(payload.assetId,accountId).first<{payload_json:string;name:string}>();
    if(!asset)throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);
    settings.responseContent=JSON.stringify({...JSON.parse(asset.payload_json),assetId:payload.assetId,assetName:asset.name});
  }
  const refreshNotice=(value:unknown):void=>{
    if(Array.isArray(value)){value.forEach(refreshNotice);return;}
    if(!own(value))return;
    if(typeof value.notificationRuleId==='string') {
      const item=items.find(i=>i.itemKind==='notification_rule'&&i.targetId===value.notificationRuleId);
      if(!item)throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);
      value.notificationRuleVersion=noticeVersions.get(item.targetId);
    }
    for(const [key,v] of Object.entries(value)) {
      if(key==='config_json'&&typeof v==='string'){const config=JSON.parse(v);refreshNotice(config);value[key]=JSON.stringify(config);}
      else refreshNotice(v);
    }
  };
  const noticeVersions=new Map<string,number>();
  for(const item of items.filter(i=>i.itemKind==='notification_rule')) {
    const rule=await db.prepare('SELECT version FROM notification_rules WHERE id=? AND line_account_id=? AND is_active=1').bind(item.targetId,accountId).first<{version:number}>();
    if(!rule)throw new HqTemplateError('REFERENCE_UNAVAILABLE',409);
    noticeVersions.set(item.targetId,rule.version);
  }
  refreshNotice(settings);
  return settings;
}
export async function validateDeliveryReferences(db:D1Database,accountId:string,type:HqDeliveryTemplateType,def:HqDeliveryTemplateDefinition,initialDraft=false) {
  return readSettings(db,type,await mapSettings(db,accountId,def,initialDraft),accountId,!initialDraft);
}
export async function planDelivery(db:D1Database,accountId:string,def:HqDeliveryTemplateDefinition,snapshot:string,type:HqDeliveryTemplateType,resolutions:readonly HqTemplateResolution[],initialDraft=false) {
  const item=inspectDelivery(def,snapshot,type)[0],selected=resolutions.find(r=>r.sourceId===type);
  if(resolutions.length!==1+(def.references?.length??0) || !selected || !item.allowedModes.includes(selected.mode)) throw new HqTemplateError('SELECTION_REQUIRED',409);
  const references=await deliveryReferenceItems(db,accountId,def,initialDraft);
  for(const item of references) if(!resolutions.some(r=>r.sourceId===item.sourceId && r.itemKind===item.itemKind && r.mode==='overwrite')) throw new HqTemplateError('SELECTION_REQUIRED',409);
  const rows=(JSON.parse(snapshot) as {targets:Target[]}).targets;
  const id=selected.mode==='overwrite'?item.targetId!:crypto.randomUUID();
  const name=selected.mode==='alias'?nextAlias(def.settings.name,rows.map(r=>String(r.record.name??r.record.keyword))):def.settings.name;
  const settings=await validateDeliveryReferences(db,accountId,type,{...def,settings:{...def.settings,name}},initialDraft);
  const now=jstNow(),existingDraft=selected.mode==='overwrite'?rows.find(r=>r.record.id===id)?.versions.find(v=>v.status==='draft')?.id:undefined,versionId=existingDraft??crypto.randomUUID();
  const statements:HqTemplateStatement[]=[{sql:`SELECT json(CASE WHEN (${snapshotSql(type)})=? THEN '{}' ELSE 'VERSION_CONFLICT' END)`,bindings:[accountId,snapshot]}];
  const add=(sql:string,bindings:HqTemplateStatement['bindings'])=>statements.push({sql,bindings});
  if(type==='auto_reply') {
    const s=settings as AutoReplyDraftSettings;
    if(selected.mode==='overwrite') add(`UPDATE auto_replies SET confirmation_revision = confirmation_revision + 1, name=?,current_draft_version_id=? WHERE id=? AND line_account_id=?`,[name,versionId,id,accountId]);
    else add(`INSERT INTO auto_replies(id,name,keyword,match_type,response_type,response_content,line_account_id,is_active,lifecycle_status,current_draft_version_id) VALUES (?,?,?,?,?,?,?,0,'draft',?)`,[id,name,s.keyword,s.matchType,s.responseType,s.responseContent,accountId,versionId]);
    if(existingDraft) add(`UPDATE auto_reply_versions SET definition_snapshot=?,last_test_status=NULL,last_tested_at=NULL,last_tested_by_staff_id=NULL,updated_at=? WHERE id=? AND auto_reply_id=? AND status='draft'`,[JSON.stringify(s),now,versionId,id]);
    else add(`INSERT INTO auto_reply_versions(id,auto_reply_id,version_number,line_account_id,definition_snapshot,status,created_at,updated_at) VALUES (?,?,(SELECT COALESCE(MAX(version_number),0)+1 FROM auto_reply_versions WHERE auto_reply_id=?),?,?,'draft',?,?)`,[versionId,id,id,accountId,JSON.stringify(s),now,now]);
  } else if(type==='friend_add_rule') {
    const s=settings as Record<string,unknown>;
    const priority=Math.max(Number(s.priority),...rows.map(r=>Number(r.record.priority)+1),1);
    if(selected.mode==='overwrite') add(`UPDATE friend_add_rules SET name=?,lock_version=lock_version+1,updated_at=? WHERE id=? AND line_account_id=?`,[name,now,id,accountId]);
    else add(`INSERT INTO friend_add_rules(id,line_account_id,friend_kind,name,priority,status,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?)`,[id,accountId,String(s.friendKind),name,priority,now,now]);
    if(existingDraft) add(`UPDATE friend_add_rule_versions SET definition_snapshot=?,last_test_status=NULL,last_tested_at=NULL,last_tested_by_staff_id=NULL,updated_at=? WHERE id=? AND rule_id=? AND status='draft'`,[JSON.stringify(s.definition),now,versionId,id]);
    else add(`INSERT INTO friend_add_rule_versions(id,rule_id,version_number,definition_snapshot,status,created_at,updated_at) VALUES (?,?,(SELECT COALESCE(MAX(version_number),0)+1 FROM friend_add_rule_versions WHERE rule_id=?),?,'draft',?,?)`,[versionId,id,id,JSON.stringify(s.definition),now,now]);
  } else {
    const s=settings as ReminderDraftSettings;
    if(selected.mode==='overwrite') add(`UPDATE reminders SET name=?,description=?,current_draft_version_id=?,updated_at=? WHERE id=? AND line_account_id=?`,[name,s.description??null,versionId,now,id,accountId]);
    else add(`INSERT INTO reminders(id,name,description,line_account_id,is_active,lifecycle_status,current_draft_version_id,trigger_type,delivery_mode,trigger_field_id,trigger_event_id,repeat_yearly,leap_year_policy,created_at,updated_at) VALUES (?,?,?,?,0,'draft',?,?,?,?,?,?,?,?,?)`,[id,name,s.description??null,accountId,versionId,s.triggerType,s.deliveryMode,s.triggerFieldId??null,s.triggerEventId??null,s.repeatYearly?1:0,s.leapYearPolicy??'feb28',now,now]);
    if(existingDraft) {
      add(`DELETE FROM reminder_version_steps WHERE reminder_version_id=?`,[versionId]);
      add(`UPDATE reminder_versions SET settings_snapshot=?,last_test_status=NULL,last_tested_at=NULL,last_tested_by_staff_id=NULL,updated_at=? WHERE id=? AND reminder_id=? AND status='draft'`,[JSON.stringify(s),now,versionId,id]);
    } else add(`INSERT INTO reminder_versions(id,reminder_id,version_number,status,settings_snapshot,created_at,updated_at) VALUES (?,?,(SELECT COALESCE(MAX(version_number),0)+1 FROM reminder_versions WHERE reminder_id=?),'draft',?,?,?)`,[versionId,id,id,JSON.stringify(s),now,now]);
    s.steps.forEach((step,index)=>add(`INSERT INTO reminder_version_steps(id,reminder_version_id,stable_step_id,position,offset_minutes,message_type,message_content,offset_days,send_at_time,template_id,target_condition_json,action_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[crypto.randomUUID(),versionId,step.stableStepId,index,step.offsetMinutes,step.messageType,step.messageContent,step.offsetDays??null,step.sendAtTime??null,step.templateId??null,JSON.stringify(step.targetCondition??{}),JSON.stringify(step.action??{}),now]));
  }
  return {statements,resolutions:[{...selected,targetId:id,aliasName:selected.mode==='alias'?name:undefined,expectedRevision:item.expectedRevision??undefined},...references.map(r=>({sourceId:r.sourceId,itemKind:r.itemKind,mode:'overwrite' as const,targetId:r.targetId,expectedRevision:r.expectedRevision}))],counts:{created:selected.mode==='create'?1:0,overwritten:selected.mode==='overwrite'?1:0,aliased:selected.mode==='alias'?1:0}};
}
