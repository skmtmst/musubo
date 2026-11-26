import { isOperationCapabilityStopped } from '@line-crm/db';
import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { dbFor } from './db-router.js';
import { processRestaurantEvents } from './restaurant-events.js';
import { processScenarioSourceJobs } from '../features/scenarios/scenario-source-jobs/index.js';
export type RestaurantLineNotice = {sent:boolean;reason:null|'not_requested'|'not_friend'|'blocked'|'sending_disabled'|'account_unavailable'|'not_confirmed'|'send_failed'|'approval_required'|'queued'};
/** 固定文は送らず「予約が入ったとき」の共通の行へ渡す。予約の保存結果とは別。 */
export async function sendRestaurantLineConfirmation(c:Context<Env>,input:{reservationId:string;storeId:string;tenantId:string;lineUid:string|null;startsAt:string;endsAt:string;guestCount:number;courseId:string|null;status:string}):Promise<RestaurantLineNotice> {
 try {
  if(!input.lineUid)return {sent:false,reason:'not_friend'};
  if(!['confirmed','visited','seated'].includes(input.status))return {sent:false,reason:'not_confirmed'};
  const db=dbFor(c.env,input.storeId);
  const friend=await db.prepare('SELECT f.is_following FROM friends f JOIN rt_stores s ON s.line_account_id=f.line_account_id WHERE s.id=? AND f.line_platform_user_id=?').bind(input.storeId,input.lineUid).first<{is_following:number}>();
  if(!friend)return {sent:false,reason:'not_friend'};
  if(!friend.is_following)return {sent:false,reason:'blocked'};
  const account=await db.prepare('SELECT a.id FROM line_accounts a JOIN rt_stores s ON s.line_account_id=a.id WHERE s.id=? AND a.is_active=1 AND a.archived_at IS NULL').bind(input.storeId).first<{id:string}>();
  if(!account)return {sent:false,reason:'account_unavailable'};
  if(await isOperationCapabilityStopped(db,account.id,'broadcast_dispatch'))return {sent:false,reason:'sending_disabled'};
  const t=await db.prepare('SELECT sending_status FROM rt_store_followup_templates WHERE store_id=?').bind(input.storeId).first<{sending_status:string}>();
  if(t?.sending_status!=='active')return {sent:false,reason:'approval_required'};
  await processRestaurantEvents(c.env,input.storeId);
  await processScenarioSourceJobs(c.env);
  const j=await db.prepare(`SELECT j.status FROM scenario_source_jobs j JOIN rt_reservation_events e ON e.id=j.source_event_id WHERE j.source_id=? AND e.event_type='restaurant.reservation.created' ORDER BY j.scheduled_at LIMIT 1`).bind(input.reservationId).first<{status:string}>();
  return {sent:j?.status==='sent',reason:j?.status==='sent'?null:j?.status==='failed'?'send_failed':'queued'};
 }catch{return {sent:false,reason:'send_failed'};}
}
