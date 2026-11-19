import { readRestaurantReservationFormHealth } from '../services/restaurant-reservation-form.js';
import { readLegacyFollowupEditorContents } from '../services/restaurant-followup-editor-content.js';
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { inputError } from '../lib/input-errors.js';
import { dbFor } from '../services/db-router.js';
import { hasOrganizationSelector,requiredAccount,organizationFor,storeBelongsTo } from './restaurant-test-definition.js';
import { isRestaurantFollowupTrigger } from '../services/restaurant-followup-rows.js';
import { FollowupDraftError,saveRestaurantFollowupEngineDraft,saveRestaurantFollowupStoreDrafts,type FollowupDraftInput } from '../services/restaurant-followup-engine-draft.js';
import { readRestaurantFollowupEngineStates } from '../services/restaurant-followup-engine-state.js';
import { startRestaurantFollowupEngine } from '../services/restaurant-followup-engine-start.js';
import { testRestaurantFollowupEngine } from '../services/restaurant-followup-test-send.js';
import { NotificationDeliveryIncomplete } from '../services/recorded-notification-send.js';
import { CommonVarResolutionFailedError } from '../services/interpolation-context.js';
import { commonVarTestError } from '../services/common-var-test-error.js';
import { resolveReminderTestRecipient } from '../services/reminder-draft.js';

async function scope(c:Context<Env>){
 if(!hasOrganizationSelector(c))return {response:requiredAccount(c)};
 const org=await organizationFor(c),storeId=c.req.param('storeId')??'';
 if(!org||!await storeBelongsTo(c,org.id,storeId))return {response:c.json({success:false,error:'見つかりません'},404)};
 return {db:dbFor(c.env,storeId),storeId};
}
function draftInput(value:unknown):value is FollowupDraftInput{
 if(!value||typeof value!=='object')return false;
 const body=value as Record<string,unknown>;
 return Number.isSafeInteger(body.expectedRowVersion)&&Number.isSafeInteger(body.expectedTargetVersion)
  &&(body.expectedContentRevision===null||typeof body.expectedContentRevision==='string')&&typeof body.enabled==='boolean'
  &&!!body.timing&&typeof body.timing==='object'&&Array.isArray(body.messageBubbles);
}
async function failure(c:Context<Env>,error:unknown){
 if(error instanceof CommonVarResolutionFailedError){
  const db=dbFor(c.env,c.req.param('storeId')??'');
  return inputError(c,await commonVarTestError(db,error.lineAccountId??null,error),422,['CommonVarResolutionFailedError']);
 }
 if(error instanceof FollowupDraftError){
  const payload={success:false,code:error.code,error:error.message};
  return error.code==='invalid_followup'?inputError(c,payload,422,error.field?[error.field]:[]):c.json(payload,409);
 }
 if(error instanceof NotificationDeliveryIncomplete&&error.blockedReason){
  if(error.blockedReason==='sending_stopped')return c.json({success:false,code:'sending_stopped',error:'いまは送信を止めています。停止が解除されてから、もう一度テストしてください'},409);
  return c.json({success:false,code:'test_precondition_changed',error:'内容か宛先が変わりました。読み直してからもう一度テストしてください'},409);
 }
 const code=error instanceof Error?error.message:'';
 if(code==='restaurant_followup_approval_forbidden')return c.json({success:false,error:'この機能を操作する権限がありません'},403);
 if(code==='restaurant_followup_test_required'||code==='REMINDER_DRAFT_NOT_TESTED')return c.json({success:false,code:'test_required',error:'この内容をテスト送信してから、送り始めてください'},409);
 if(code==='REMINDER_TEST_RECIPIENT_NOT_AVAILABLE')return inputError(c,{success:false,code:'test_recipient_unavailable',error:'自分のLINEを確認するか、登録済みのテスト送信先を設定してください'},422,[]);
 if(code==='notification_delivery_unknown'||code==='REMINDER_TEST_DELIVERY_UNCONFIRMED')return c.json({success:false,code:'delivery_unconfirmed',error:'送信結果を確認できません。送り直さず、履歴を確認してください'},409);
 if(code==='notification_delivery_failed')return c.json({success:false,code:'test_failed',error:'テスト送信に失敗しました。設定を確認してください'},502);
 throw error;
}
export async function getRestaurantFollowupEngines(c:Context<Env>){
 const access=await scope(c);if(access.response)return access.response;
 const store=await access.db!.prepare('SELECT line_account_id FROM rt_stores WHERE id=?').bind(access.storeId).first<{line_account_id:string|null}>();
 const recipient=store?.line_account_id?await resolveReminderTestRecipient(access.db!,store.line_account_id,{staffId:c.get('staff')?.id}):null;
 return c.json({success:true,data:{engines:await readRestaurantFollowupEngineStates(access.db!,access.storeId!),legacyContents:await readLegacyFollowupEditorContents(access.db!,access.storeId!),testRecipient:recipient,...(store?.line_account_id?{reservationForm:await readRestaurantReservationFormHealth(access.db!,access.storeId!,store.line_account_id)}:{})}});
}
export async function initializeRestaurantFollowupEngines(c:Context<Env>){
 const access=await scope(c);if(access.response)return access.response;
 const staffId=c.get('staff')?.id;if(!staffId)return c.json({success:false,error:'ログインし直してください'},401);
 const body=await c.req.json<{rows?:unknown}>();
 if(!Array.isArray(body?.rows)||!body.rows.every(row=>row&&isRestaurantFollowupTrigger(row.trigger)&&draftInput(row.input)))return inputError(c,{success:false,error:'送り方を確認してください'},400,['rows']);
 try{await saveRestaurantFollowupStoreDrafts(access.db!,access.storeId!,body.rows,staffId);return c.json({success:true,data:{engines:await readRestaurantFollowupEngineStates(access.db!,access.storeId!),message:'まだ送っていません。テスト送信と承認のあと送り始めます'}});}catch(error){return failure(c,error);}
}
export async function saveRestaurantFollowupEngine(c:Context<Env>){
 const access=await scope(c);if(access.response)return access.response;
 const staffId=c.get('staff')?.id,trigger=c.req.param('trigger');if(!staffId)return c.json({success:false,error:'ログインし直してください'},401);
 const body:unknown=await c.req.json();if(!isRestaurantFollowupTrigger(trigger)||!draftInput(body))return inputError(c,{success:false,error:'送り方を確認してください'},400,['trigger','timing','messageBubbles']);
 try{await saveRestaurantFollowupEngineDraft(access.db!,access.storeId!,trigger,body,staffId);return c.json({success:true,data:{engines:await readRestaurantFollowupEngineStates(access.db!,access.storeId!),message:'まだ送っていません。テスト送信と承認のあと送り始めます'}});}catch(error){return failure(c,error);}
}
export async function testRestaurantFollowupEngineHandler(c:Context<Env>){
 const access=await scope(c);if(access.response)return access.response;
 const staffId=c.get('staff')?.id,trigger=c.req.param('trigger');if(!staffId)return c.json({success:false,error:'ログインし直してください'},401);
 const body=await c.req.json<{expectedTargetVersion?:unknown}>();
 if(!isRestaurantFollowupTrigger(trigger)||!Number.isSafeInteger(body?.expectedTargetVersion))return inputError(c,{success:false,error:'送り方を読み直してください'},400,['expectedTargetVersion']);
 try{return c.json({success:true,data:await testRestaurantFollowupEngine(access.db!,{storeId:access.storeId!,trigger,expectedTargetVersion:Number(body.expectedTargetVersion),staffId},{credentialEncryptionKey:c.env.LINE_CREDENTIAL_ENCRYPTION_KEY})});}catch(error){return failure(c,error);}
}
export async function startRestaurantFollowupEngineHandler(c:Context<Env>){
 const access=await scope(c);if(access.response)return access.response;
 const staff=c.get('staff'),trigger=c.req.param('trigger');if(!staff?.id)return c.json({success:false,error:'ログインし直してください'},401);
 const body=await c.req.json<{expectedTargetVersion?:unknown;expectedContentHash?:unknown}>();
 if(!isRestaurantFollowupTrigger(trigger)||!Number.isSafeInteger(body?.expectedTargetVersion)||typeof body?.expectedContentHash!=='string')return inputError(c,{success:false,error:'テストした内容を読み直してください'},400,['expectedTargetVersion','expectedContentHash']);
 try{return c.json({success:true,data:await startRestaurantFollowupEngine(access.db!,{storeId:access.storeId!,trigger,expectedTargetVersion:Number(body.expectedTargetVersion),expectedContentHash:body.expectedContentHash,staffId:staff.id,canApprove:staff.role==='owner'||staff.role==='admin'})});}catch(error){return failure(c,error);}
}
