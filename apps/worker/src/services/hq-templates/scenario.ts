import type { HqTemplateStatement } from '@line-crm/db';
import type { HqScenarioDefinition } from '@line-crm/shared';
import type { HqTemplateResolution } from './contract.js';
import { boundedText, HqTemplateError, nextAlias } from './tag.js';
import { parseMessageTemplateDefinition } from './template.js';

export function parseScenarioDefinition(value: unknown): HqScenarioDefinition {
  const root=value as HqScenarioDefinition;
  if (!root || root.schemaVersion!==1 || !root.scenario || !Array.isArray(root.steps) || root.steps.length<1 || root.steps.length>100) throw new HqTemplateError('INVALID_DEFINITION',422);
  if (Object.keys(root).some(k=>!['schemaVersion','scenario','steps'].includes(k)) || Object.keys(root.scenario).some(k=>!['name','description'].includes(k))) throw new HqTemplateError('UNSUPPORTED_REFERENCE',422);
  const name=boundedText(root.scenario.name), description=root.scenario.description == null ? null : boundedText(root.scenario.description,2000);
  const steps=root.steps.map(step=>{
    if (!step || Object.keys(step).some(k=>!['id','delayMinutes','messageType','messageContent'].includes(k)) || !Number.isSafeInteger(step.delayMinutes) || step.delayMinutes<0 || step.delayMinutes>525600 || !['text','flex'].includes(step.messageType)) throw new HqTemplateError('INVALID_DEFINITION',422);
    const id=boundedText(step.id,80), messageContent=boundedText(step.messageContent,step.messageType==='text'?5000:32000);
    parseMessageTemplateDefinition({schemaVersion:1,template:{id,name:'step',category:'general',messageType:step.messageType,messageContent,carouselActionsJson:null,carouselTapLimitMode:'none',carouselTapLimitText:null,questionJson:null,questionStatus:'draft'},media:[]});
    return {id,delayMinutes:step.delayMinutes,messageType:step.messageType,messageContent};
  });
  if(new Set(steps.map(s=>s.id)).size!==steps.length) throw new HqTemplateError('INVALID_DEFINITION',422);
  return {schemaVersion:1,scenario:{name,description},steps};
}
// 下書き全体の内容と使用状況を、書込トランザクション内で照合する。
const SNAPSHOT_SQL=`SELECT json_object('scenarios',json((SELECT COALESCE(json_group_array(json(row)),'[]') FROM (
 SELECT json_object('id',s.id,'name',s.name,'active',s.is_active,'trigger',s.trigger_type,'mode',s.delivery_mode,'completion',s.on_complete_scenario_id,'published',s.current_published_version_id,'updated',s.updated_at,
 'usage',(SELECT COUNT(*) FROM friend_scenarios f WHERE f.scenario_id=s.id),
 'steps',json((SELECT COALESCE(json_group_array(json(sr)),'[]') FROM (SELECT json_object('id',id,'order',step_order,'delay',delay_minutes,'type',message_type,'content',message_content,'bubbles',message_bubbles_json,'condition',condition_value,'target',target_condition_json,'question',question_json,'template',template_id,'tag',on_reach_tag_id,'after',after_send,'draft',is_draft) sr FROM scenario_steps WHERE scenario_id=s.id ORDER BY step_order,id))),
 'actions',(SELECT COUNT(*) FROM scenario_actions WHERE scenario_id=s.id)) row
 FROM scenarios s WHERE s.line_account_id=? ORDER BY s.id)))) AS snapshot`;
type ScenarioTarget={id:string;name:string;active:number;trigger:string;mode:string;completion:string|null;published:string|null;usage:number;actions:number;steps:unknown[]};
export async function scenarioSnapshot(db:D1Database,accountId:string):Promise<string> {
  const row=await db.prepare(SNAPSHOT_SQL).bind(accountId).first<{snapshot:string}>();
  if(!row) throw new HqTemplateError('VERSION_CONFLICT',409);
  return row.snapshot;
}
export function inspectScenario(def:HqScenarioDefinition,snapshot:string) {
  const targets=(JSON.parse(snapshot) as {scenarios:ScenarioTarget[]}).scenarios;
  const same=targets.filter(t=>t.name.normalize('NFKC').toLocaleLowerCase()===def.scenario.name.normalize('NFKC').toLocaleLowerCase());
  if(same.length>1) throw new HqTemplateError('VERSION_CONFLICT',409);
  const row=same[0], safe=!!row && !row.active && !row.published && !row.usage && !row.actions && row.trigger==='manual' && row.mode==='relative' && !row.completion;
  return [{sourceId:'scenario',itemKind:'scenario',name:def.scenario.name,targetId:row?.id??null,expectedRevision:row?JSON.stringify(row):null,duplicate:!!row,allowedModes:row?(safe?['overwrite','alias']:['alias']):['create']}];
}
export function planScenario(accountId:string,definition:HqScenarioDefinition,snapshot:string,resolutions:readonly HqTemplateResolution[]) {
  const item=inspectScenario(definition,snapshot)[0], selection=resolutions.find(r=>r.sourceId==='scenario');
  if(resolutions.length!==1 || !selection || !item.allowedModes.includes(selection.mode)) throw new HqTemplateError('SELECTION_REQUIRED',409);
  const rows=(JSON.parse(snapshot) as {scenarios:ScenarioTarget[]}).scenarios;
  const id=selection.mode==='overwrite'?item.targetId!:crypto.randomUUID();
  const name=selection.mode==='alias'?nextAlias(definition.scenario.name,rows.map(r=>r.name)):definition.scenario.name;
  const statements:HqTemplateStatement[]=[{sql:`SELECT json(CASE WHEN (${SNAPSHOT_SQL})=? THEN '{}' ELSE 'VERSION_CONFLICT' END)`,bindings:[accountId,snapshot]}];
  if(selection.mode==='overwrite') statements.push({sql:`UPDATE scenarios SET content_revision = content_revision + 1, name=?,description=?,updated_at=strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') WHERE id=? AND line_account_id=?`,bindings:[name,definition.scenario.description,id,accountId]},{sql:'DELETE FROM scenario_steps WHERE scenario_id=?',bindings:[id]});
  else statements.push({sql:"INSERT INTO scenarios(id,name,description,trigger_type,is_active,line_account_id) VALUES (?,?,?,'manual',0,?)",bindings:[id,name,definition.scenario.description,accountId]});
  definition.steps.forEach((step,index)=>statements.push({sql:"INSERT INTO scenario_steps(id,scenario_id,step_order,delay_minutes,message_type,message_content,is_draft) VALUES (?,?,?,?,?,?,1)",bindings:[crypto.randomUUID(),id,index,step.delayMinutes,step.messageType,step.messageContent]}));
  return {statements,resolutions:[{...selection,targetId:id,aliasName:selection.mode==='alias'?name:undefined,expectedRevision:item.expectedRevision??undefined}],counts:{created:selection.mode==='create'?1:0,overwritten:selection.mode==='overwrite'?1:0,aliased:selection.mode==='alias'?1:0}};
}
