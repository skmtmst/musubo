import { getReminderDraftVersion,prepareReminderDraftPublication } from '@line-crm/db';
import type { RestaurantFollowupTrigger } from '@line-crm/shared';
import { getAutomationDraft,publishAutomationDraft } from '../features/automations/automation-drafts/index.js';
import { readFollowupEngineSnapshot,type FollowupEngineSnapshot } from './restaurant-followup-engine-approval.js';
import { FollowupDraftError } from './restaurant-followup-engine-draft.js';

export const followupTestResource=(targetId:string,snapshot:Pick<FollowupEngineSnapshot,'versionId'|'contentHash'>)=>`restaurant-followup-test:${targetId}:${snapshot.versionId}:${snapshot.contentHash}`;
export async function readFollowupEngineDraftSnapshot(db:D1Database,storeId:string,trigger:RestaurantFollowupTrigger,expectedTargetVersion:number){
 const target=await db.prepare(`SELECT ft.*,s.line_account_id,s.organization_id FROM rt_store_followup_targets ft JOIN rt_stores s ON s.id=ft.store_id
  WHERE ft.store_id=? AND ft.trigger=? AND ft.enabled=1 AND s.status='active' AND ft.version=?`)
  .bind(storeId,trigger,expectedTargetVersion).first<{engine:'reminder'|'automation'|'scenario';reminder_id:string|null;automation_id:string|null;line_account_id:string;organization_id:string;version:number}>();
 if(!target||target.engine==='scenario')throw new FollowupDraftError('version_conflict','送り方を保存してから、読み直してください');
 const targetId=target.engine==='reminder'?target.reminder_id:target.automation_id;
 if(!targetId)throw new FollowupDraftError('version_conflict','送り方を読み直してください');
 const version=target.engine==='reminder'?(await getReminderDraftVersion(db,targetId))?.id:(await db.prepare('SELECT current_draft_version_id id FROM automation_definitions WHERE id=?').bind(targetId).first<{id:string|null}>())?.id;
 if(!version)throw new FollowupDraftError('version_conflict','編集する下書きを保存してから、読み直してください');
 const snapshot=await readFollowupEngineSnapshot(db,{engine:target.engine,targetId,lineAccountId:target.line_account_id,storeId,publishingVersionId:version});
 if(!snapshot?.publicationGuard)throw new FollowupDraftError('version_conflict','公開する版を読み直してください');
 return {target,targetId,snapshot};
}

/** テストした同じ版を公開し、承認・送り手・実物の有効化を1つのbatchで確定する。 */
export async function startRestaurantFollowupEngine(db:D1Database,input:{storeId:string;trigger:RestaurantFollowupTrigger;expectedTargetVersion:number;expectedContentHash:string;staffId:string;canApprove:boolean}){
 if(!input.canApprove||!input.staffId)throw new Error('restaurant_followup_approval_forbidden');
 const {target,targetId,snapshot}=await readFollowupEngineDraftSnapshot(db,input.storeId,input.trigger,input.expectedTargetVersion);
 if(snapshot.contentHash!==input.expectedContentHash)throw new FollowupDraftError('version_conflict','試した内容が変わりました。もう一度テストしてください');
 const resource=followupTestResource(targetId,snapshot);
 const proofSql="EXISTS(SELECT 1 FROM outbound_send_requests WHERE resource_id=? AND line_account_id=? AND channel='line' AND status='succeeded')";
 if(!await db.prepare(`SELECT 1 WHERE ${proofSql}`).bind(resource,target.line_account_id).first())throw new Error('restaurant_followup_test_required');
 const approvalId=crypto.randomUUID(),now=new Date().toISOString();
 const payload=JSON.stringify({operation:'start_restaurant_followup_engines',lineAccountId:target.line_account_id,targets:[{trigger:input.trigger,engine:target.engine,targetId,versionId:snapshot.versionId,contentHash:snapshot.contentHash}]});
 const before=[db.prepare(`SELECT json(CASE WHEN (${snapshot.publicationGuard!.sql}) AND ${proofSql} AND EXISTS(
   SELECT 1 FROM rt_store_followup_targets ft JOIN rt_stores s ON s.id=ft.store_id WHERE ft.store_id=? AND ft.trigger=? AND ft.version=? AND ft.enabled=1 AND ft.engine=? AND s.line_account_id=? AND s.status='active') THEN '{}' ELSE 'FOLLOWUP_START_CONFLICT' END)`)
   .bind(...snapshot.publicationGuard!.binds,resource,target.line_account_id,input.storeId,input.trigger,input.expectedTargetVersion,target.engine,target.line_account_id)];
 const after=[
  db.prepare('UPDATE rt_store_followup_step_bindings SET enabled=0,version=version+1 WHERE store_id=? AND trigger=? AND enabled=1').bind(input.storeId,input.trigger),
  db.prepare(`SELECT json(CASE WHEN ${snapshot.guard.sql} THEN '{}' ELSE 'FOLLOWUP_PUBLISHED_CONTENT_CHANGED' END)`).bind(...snapshot.guard.binds),
  db.prepare(`INSERT INTO rt_approval_requests(id,organization_id,store_id,kind,title,status,payload_json,requested_by,reviewed_by,updated_at)
   VALUES(?,?,?,'line_message','LINE来店フォローの本送信を開始','approved',?,?,?,?)`).bind(approvalId,target.organization_id,input.storeId,payload,input.staffId,input.staffId,now),
  db.prepare(`UPDATE rt_store_followup_targets SET sending_status='active',approved_version_id=?,approved_content_hash=?,approval_id=?,version=version+1 WHERE store_id=? AND trigger=? AND version=? AND enabled=1`)
   .bind(snapshot.versionId,snapshot.contentHash,approvalId,input.storeId,input.trigger,input.expectedTargetVersion),
 ];
 try{
  if(target.engine==='reminder'){
   const publish=await prepareReminderDraftPublication(db,targetId,input.staffId);
   if(publish.draft.id!==snapshot.versionId)throw new FollowupDraftError('version_conflict','公開する版が変わりました');
   await db.batch([...before,...publish.statements,...after]);
  }else{
   const draft=await getAutomationDraft(db,{id:targetId,lineAccountId:target.line_account_id});
   const status=await db.prepare('SELECT status FROM automation_definitions WHERE id=?').bind(targetId).first<{status:string}>();
   await publishAutomationDraft(db,{id:targetId,lineAccountId:target.line_account_id,expectedDraftVersionId:draft.draftVersionId,expectedStatus:status?.status,activate:true,
    transaction:{before,after:()=>[...after,db.prepare("UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, status='active' WHERE id=? AND current_published_version_id=?").bind(targetId,snapshot.versionId)]}});
  }
 }catch(error){if(String(error).includes('malformed JSON'))throw new FollowupDraftError('version_conflict','公開する内容が変わりました。読み直してください');throw error;}
 return {targetId,versionId:snapshot.versionId,approvalId,sendingStatus:'active' as const};
}
