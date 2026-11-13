import { reminderFollowupEditorContent,automationFollowupEditorContent } from './restaurant-followup-editor-content.js';
import { protectRestaurantFollowupMessageParts } from './restaurant-followup-message-parts.js';
import {
 getReminderPublishedVersion,getReminderDraftVersion,prepareReminderDraftCreation,prepareReminderDraftSave,parseReminderVersionSettings,
 type ReminderDraftSettings,
} from '@line-crm/db';
import { RESTAURANT_FOLLOWUP_LABELS,parseAutomationWait,type RestaurantFollowupTrigger,type RestaurantFollowupTiming,type RestaurantFollowupEngineDraftInput } from '@line-crm/shared';
import { automationDraftCreationStatements } from '../features/automations/automation-draft-storage/index.js';
import { automationRevisionToken,createAutomationDraftFromDefinition,updateAutomationDraft } from '../features/automations/automation-drafts/index.js';
import { parseBroadcastMessageParts,buildMessages } from '../features/broadcasts/broadcast-message-set/index.js';
import { validateTemplateMessage } from './template-message-validation.js';
import { readRestaurantFollowupRows } from './restaurant-followup-rows.js';

type Timing=RestaurantFollowupTiming;
export type FollowupDraftInput=RestaurantFollowupEngineDraftInput;
export class FollowupDraftError extends Error {
 constructor(public code:'version_conflict'|'invalid_followup'|'delivery_unconfirmed'|'line_account_required',message:string,public field?:'timing'|'messageBubbles'){super(message);}
}
interface Target {engine:'scenario'|'reminder'|'automation';reminder_id:string|null;automation_id:string|null;version:number}
function conflict(){return new FollowupDraftError('version_conflict','設定が変わりました。読み直してください');}
function invalid(field?:'timing'|'messageBubbles',message='送り方と送る内容を確認してください'){return new FollowupDraftError('invalid_followup',message,field);}
function validateTiming(trigger:RestaurantFollowupTrigger,timing:Timing){
 if(!timing||typeof timing!=='object')throw invalid('timing','送る時期を選び直してから保存してください');
 const reminder=['reservation_24h','reservation_2h','anniversary_before'].includes(trigger);
 if(reminder){
  if(timing.mode==='time'&&Number.isSafeInteger(timing.offsetDays)&&timing.offsetDays<=(trigger==='anniversary_before'?-1:0)&&timing.offsetDays>=-365&&/^([01]\d|2[0-3]):[0-5]\d$/.test(timing.sendAtTime))return;
  if(trigger!=='anniversary_before'&&timing.mode==='countdown'&&Number.isSafeInteger(timing.offsetMinutes)&&timing.offsetMinutes<0&&timing.offsetMinutes>=-525600)return;
 }else if(timing.mode==='countdown'&&timing.offsetMinutes===0)return;
 else if((timing.mode==='next_day'&&['post_visit','review_request'].includes(trigger)||timing.mode==='countdown')&&parseAutomationWait(timing.mode==='countdown'?{durationMinutes:timing.offsetMinutes}:timing))return;
 const reason=reminder
  ?trigger==='anniversary_before'?'記念日の1〜365日前の日数と、00:00〜23:59の時刻を指定してください。'
   :timing.mode!=='time'&&timing.mode!=='countdown'?'この送り方は日時か、予約の前の時間で指定してください。'
   :timing.mode==='countdown'?'予約前の時間は1分〜365日で指定してください。'
   :'送る日は予約の365日前〜当日、時刻は00:00〜23:59で指定してください。'
  :timing.mode==='next_day'
   ?['post_visit','review_request'].includes(trigger)?'退店の翌日に送る時刻を00:00〜23:59で指定してください。':'この送り方は「すぐに送る」か、きっかけから待つ時間を指定してください。'
   :'待つ時間は0以上・365日以内の5分単位で指定してください。';
 throw invalid('timing',reason);
}
/** 同じ実物IDを保ち、停止した下書きと送り手の切替を同じbatchへ収める。 */
async function saveEngineDraft(db:D1Database,storeId:string,trigger:RestaurantFollowupTrigger,input:FollowupDraftInput,staffId:string){
 if(!Number.isSafeInteger(input.expectedRowVersion)||input.expectedRowVersion<1||!Number.isSafeInteger(input.expectedTargetVersion)||input.expectedTargetVersion<0||typeof input.enabled!=='boolean')throw invalid();
 const row=(await readRestaurantFollowupRows(db,storeId)).find(item=>item.trigger===trigger);
 const target=await db.prepare('SELECT * FROM rt_store_followup_targets WHERE store_id=? AND trigger=?').bind(storeId,trigger).first<Target>();
 if(!row||row.version!==input.expectedRowVersion||(target?.version??0)!==input.expectedTargetVersion)throw conflict();
 const store=await db.prepare('SELECT line_account_id,name FROM rt_stores WHERE id=?').bind(storeId).first<{line_account_id:string|null;name:string}>();
 if(!store?.line_account_id)throw new FollowupDraftError('line_account_required','LINE公式アカウントを接続してください');
 const engine=['reservation_24h','reservation_2h','anniversary_before'].includes(trigger)?'reminder':'automation';
 const account=store.line_account_id;
 const unknown=await db.prepare(`SELECT 1 FROM scenario_source_jobs j JOIN scenario_versions v ON v.id=j.scenario_version_id
   WHERE j.attempt_count>0 AND j.status IN('running','failed') AND NOT (j.status='failed' AND EXISTS(SELECT 1 FROM outbound_send_requests request WHERE request.idempotency_key=j.idempotency_key AND request.line_account_id=j.line_account_id AND request.channel='line' AND request.status='failed' AND request.failure_code IN('LINE_REQUEST_REJECTED','LINE_RATE_LIMITED'))) AND EXISTS(SELECT 1 FROM rt_store_followup_step_bindings b
     WHERE b.store_id=? AND b.trigger=? AND EXISTS(SELECT 1 FROM json_each(v.steps_snapshot) st WHERE json_extract(st.value,'$.live_step_id')=b.step_id AND json_extract(st.value,'$.version_step_id')=j.step_id)) LIMIT 1`).bind(storeId,trigger).first();
 if(unknown)throw new FollowupDraftError('delivery_unconfirmed','送信結果を確認できない仕事があるため、切り替えられません。サポートへ連絡してください');
 const before=[db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM rt_store_followup_rows r JOIN rt_stores s ON s.id=r.store_id WHERE r.store_id=? AND r.trigger=? AND r.version=? AND s.line_account_id=?)
   AND COALESCE((SELECT version FROM rt_store_followup_targets WHERE store_id=? AND trigger=?),0)=? THEN '{}' ELSE 'FOLLOWUP_VERSION_CONFLICT' END)`)
   .bind(storeId,trigger,input.expectedRowVersion,account,storeId,trigger,input.expectedTargetVersion),
  // 試行済みで結果が未確定の仕事は、別の送り手へ自動で引き継がない。
  db.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM scenario_source_jobs j JOIN scenario_versions v ON v.id=j.scenario_version_id
    WHERE j.attempt_count>0 AND j.status IN('running','failed') AND NOT (j.status='failed' AND EXISTS(SELECT 1 FROM outbound_send_requests request WHERE request.idempotency_key=j.idempotency_key AND request.line_account_id=j.line_account_id AND request.channel='line' AND request.status='failed' AND request.failure_code IN('LINE_REQUEST_REJECTED','LINE_RATE_LIMITED'))) AND EXISTS(SELECT 1 FROM rt_store_followup_step_bindings b
      WHERE b.store_id=? AND b.trigger=? AND EXISTS(SELECT 1 FROM json_each(v.steps_snapshot) st WHERE json_extract(st.value,'$.live_step_id')=b.step_id AND json_extract(st.value,'$.version_step_id')=j.step_id))) THEN '{}' ELSE 'FOLLOWUP_DELIVERY_UNCONFIRMED' END)`)
   .bind(storeId,trigger)];
 const after=(id:string|null)=>{
  const statements=[
   db.prepare(`UPDATE rt_store_followup_step_bindings SET enabled=0,version=version+1 WHERE store_id=? AND trigger=? AND enabled=1`).bind(storeId,trigger),
   db.prepare(`UPDATE scenario_source_jobs SET status='cancelled',lease_until=NULL WHERE status IN('pending','failed') AND attempt_count=0
    AND EXISTS(SELECT 1 FROM rt_store_followup_step_bindings b JOIN scenario_versions v ON v.id=scenario_source_jobs.scenario_version_id
      WHERE b.store_id=? AND b.trigger=? AND EXISTS(SELECT 1 FROM json_each(v.steps_snapshot) st WHERE json_extract(st.value,'$.live_step_id')=b.step_id AND json_extract(st.value,'$.version_step_id')=scenario_source_jobs.step_id))`).bind(storeId,trigger),
  ];
  if(id){
   const column=engine==='reminder'?'reminder_id':'automation_id';
   statements.push(db.prepare(`INSERT INTO rt_store_followup_targets(store_id,trigger,engine,${column},enabled)
    VALUES(?,?,?,?,?) ON CONFLICT(store_id,trigger) DO UPDATE SET engine=excluded.engine,${column}=excluded.${column},enabled=excluded.enabled,
    sending_status='stopped',approval_id=NULL,approved_version_id=NULL,approved_content_hash=NULL,version=rt_store_followup_targets.version+1`)
    .bind(storeId,trigger,engine,id,input.enabled?1:0));
  }
  if(!id&&target)statements.push(db.prepare("UPDATE rt_store_followup_targets SET enabled=0,sending_status='stopped',approval_id=NULL,approved_version_id=NULL,approved_content_hash=NULL,version=version+1 WHERE store_id=? AND trigger=?").bind(storeId,trigger));
  if(target?.reminder_id)statements.push(db.prepare("UPDATE reminders SET is_active=0,lifecycle_status=CASE WHEN current_published_version_id IS NULL THEN 'draft' ELSE 'stopped' END WHERE id=?").bind(target.reminder_id));
  if(target?.automation_id)statements.push(db.prepare("UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, status=CASE WHEN current_published_version_id IS NULL THEN 'draft' ELSE 'stopped' END WHERE id=?").bind(target.automation_id));
  statements.push(db.prepare('UPDATE rt_store_followup_rows SET version=version+1 WHERE store_id=? AND trigger=?').bind(storeId,trigger));
  return statements;
 };
 try{
  if(!input.enabled){await db.batch([...before,...after(target?.reminder_id??target?.automation_id??null)]);return;}
  validateTiming(trigger,input.timing);
  let parts:ReturnType<typeof parseBroadcastMessageParts>;
  try{
   parts=protectRestaurantFollowupMessageParts(trigger,parseBroadcastMessageParts({messageType:'text',messageContent:'',messageBubbles:input.messageBubbles}));
   for(const part of parts){const validation=validateTemplateMessage(part.messageType,part.messageContent);if(!validation.ok)throw invalid('messageBubbles',validation.error);}
   buildMessages(parts);
  }catch(error){
   if(error instanceof FollowupDraftError)throw error;
   const code=error instanceof Error?error.message:'';
   const known:Record<string,string>={
    'messageBubbles text is required':'本文を入力するか、テンプレートを選んでください。',
    '文章の自動分割とボタンを合わせて5通までです。本文や吹き出しを減らしてください':'文章の自動分割とボタンを合わせて5通までです。本文や吹き出しを減らしてください',
    '予約の返事の入口を含めて5つ以内になるよう、吹き出しを減らしてください':'予約の返事の入口を含めて5つ以内になるよう、吹き出しを減らしてください',
   };
   throw invalid('messageBubbles',(Object.hasOwn(known,code)?known[code]:undefined)??'本文の形式を読み取れません。テンプレートを選び直すか、テキストを入れて保存し直してください。');
  }
  const name=`${store.name}：${RESTAURANT_FOLLOWUP_LABELS[trigger]}`;
  if(engine==='reminder'){
   const existing=target?.reminder_id?await getReminderDraftVersion(db,target.reminder_id):null;
   const published=target?.reminder_id?await getReminderPublishedVersion(db,target.reminder_id):null;
   const current=existing??published;
   if(target?.reminder_id&&input.expectedContentRevision!==(current?`${current.id}:${current.updated_at}`:null))throw conflict();
   if(target?.reminder_id)before.push(db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM reminders WHERE id=? AND current_published_version_id IS ? AND current_draft_version_id IS ?) THEN '{}' ELSE 'FOLLOWUP_VERSION_CONFLICT' END)`).bind(target.reminder_id,published?.id??null,existing?.id??null));
   const timing=input.timing as Exclude<Timing,{mode:'next_day'}>;
   const field=trigger==='anniversary_before'?await db.prepare("SELECT field_id FROM friend_fixed_fields WHERE fixed_key='anniversary'").first<{field_id:string}>():null;
   if(trigger==='anniversary_before'&&!field)throw invalid();
   if(current&&!reminderFollowupEditorContent(current,trigger,field?.field_id))throw new FollowupDraftError('invalid_followup','この内容は詳しい設定で変更してください');
   const settings:ReminderDraftSettings={name,lineAccountId:account,triggerType:field?'friend_field':'manual',triggerFieldId:field?.field_id??null,repeatYearly:!!field,leapYearPolicy:'feb28',deliveryMode:timing.mode,
    stopConditions:{bookingCancelled:true,friendBlocked:true,supportMarkCompleted:false,daysAfterTarget:0},
    steps:[{stableStepId:current?parseReminderVersionSettings(current).steps[0]?.stableStepId??crypto.randomUUID():crypto.randomUUID(),offsetMinutes:timing.mode==='countdown'?timing.offsetMinutes:0,offsetDays:timing.mode==='time'?timing.offsetDays:null,sendAtTime:timing.mode==='time'?timing.sendAtTime:null,messageType:parts[0].messageType,messageContent:parts[0].messageContent,messageParts:parts.map(part=>({messageType:part.messageType,messageContent:part.messageContent}))}]};
   if(target?.reminder_id){const prepared=await prepareReminderDraftSave(db,target.reminder_id,settings,{expectedVersionId:existing?.id??null,expectedUpdatedAt:existing?.updated_at??null});await db.batch([...before,...prepared.statements,...after(target.reminder_id)]);}
   else{const prepared=prepareReminderDraftCreation(db,settings);await db.batch([...before,...prepared.statements,...after(prepared.reminderId)]);}
  }else{
   const timing=input.timing,wait=timing.mode==='next_day'?timing:timing.mode==='countdown'&&timing.offsetMinutes>0?{durationMinutes:timing.offsetMinutes}:null;
   const actions=[...(wait?[{id:'wait',type:'wait',params:wait,onFailure:'stop'}]:[]),...parts.map((part,i)=>({id:`message-${i+1}`,type:'send_message',params:{messageType:part.messageType,content:part.messageContent},onFailure:'stop'}))];
   const content={trigger_type:trigger==='reservation_created'?'restaurant.reservation.created':trigger==='waitlist_invited'?'restaurant.waitlist.invited':'restaurant.departed',trigger_config:JSON.stringify({storeId}),condition_config:'{}',action_config:JSON.stringify(actions)};
   if(target?.automation_id){
    const current=await db.prepare(`SELECT d.current_draft_version_id,d.current_published_version_id,v.* FROM automation_definitions d JOIN automation_versions v ON v.id=COALESCE(d.current_draft_version_id,d.current_published_version_id) WHERE d.id=? AND d.line_account_id=?`).bind(target.automation_id,account).first<{id:string;current_published_version_id:string|null;trigger_type:string;trigger_config:string;condition_config:string;action_config:string}>();
    if(!current||await automationRevisionToken(current.id,current)!==input.expectedContentRevision)throw conflict();
    if(!automationFollowupEditorContent(current,storeId,trigger))throw new FollowupDraftError('invalid_followup','この内容は詳しい設定で変更してください');
    before.push(db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM automation_definitions WHERE id=? AND current_published_version_id IS ?) THEN '{}' ELSE 'FOLLOWUP_VERSION_CONFLICT' END)`).bind(target.automation_id,current.current_published_version_id));
    const draft=await createAutomationDraftFromDefinition(db,{id:target.automation_id,lineAccountId:account,createdBy:staffId});
    await updateAutomationDraft(db,{id:target.automation_id,lineAccountId:account,expectedDraftVersionId:draft.draftVersionId,name,eventType:content.trigger_type,triggerConfig:{storeId},conditions:{},actions,transaction:{before,after:()=>after(target.automation_id)}});
   }else{
    const id=crypto.randomUUID(),versionId=crypto.randomUUID();
    await db.batch([...before,...automationDraftCreationStatements(db,{id,versionId,lineAccountId:account,name,description:'LINE来店フォロー',createdBy:staffId,now:new Date().toISOString(),content}),...after(id)]);
   }
  }
 }catch(error){
  if(String(error).includes('FOLLOWUP_DELIVERY_UNCONFIRMED'))throw new FollowupDraftError('delivery_unconfirmed','送信結果を確認できない仕事があるため、切り替えられません。サポートへ連絡してください');
  if(String(error).includes('malformed JSON')||String(error).includes('REMINDER_DRAFT_CONFLICT'))throw conflict();
  throw error;
 }
}

export async function saveRestaurantFollowupEngineDraft(db:D1Database,storeId:string,trigger:RestaurantFollowupTrigger,input:FollowupDraftInput,staffId:string){
 if(!await db.prepare('SELECT 1 FROM rt_store_followup_targets WHERE store_id=? LIMIT 1').bind(storeId).first())throw new FollowupDraftError('version_conflict','初めての設定は、店の送り方をまとめて保存してください');
 return saveEngineDraft(db,storeId,trigger,input,staffId);
}

/** 初回の旧7行は店ごとに切り替える。途中の行だけが新しい送り手になる状態を残さない。 */
export async function saveRestaurantFollowupStoreDrafts(db:D1Database,storeId:string,rows:Array<{trigger:RestaurantFollowupTrigger;input:FollowupDraftInput}>,staffId:string){
 const expected=(await readRestaurantFollowupRows(db,storeId)).map(row=>row.trigger).sort();
 if(rows.length!==7||new Set(rows.map(row=>row.trigger)).size!==7||JSON.stringify(rows.map(row=>row.trigger).sort())!==JSON.stringify(expected))throw invalid();
 if(await db.prepare('SELECT 1 FROM rt_store_followup_targets WHERE store_id=? LIMIT 1').bind(storeId).first())throw conflict();
 const statements:D1PreparedStatement[]=[db.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM rt_store_followup_targets WHERE store_id=?) THEN '{}' ELSE 'FOLLOWUP_STORE_CONFLICT' END)`).bind(storeId)];
 // 初回だけなので公開版の改訂を作る経路は通らず、実物の作成SQLを集める。
 const collectingDb={prepare:(sql:string)=>db.prepare(sql),batch:async(batch:D1PreparedStatement[])=>{statements.push(...batch);return [];}} as unknown as D1Database;
 for(const row of rows)await saveEngineDraft(collectingDb,storeId,row.trigger,row.input,staffId);
 try{await db.batch(statements);}catch(error){if(String(error).includes('malformed JSON'))throw conflict();throw error;}
}
