export { getHqBroadcastRun, expandAccountName, mappedHqContent, preflightHqBroadcast } from '../features/hq-broadcasts/preflight/index.js';
import { assertHqDeliveryOptions, getHqBroadcastRun, expandAccountName, mappedHqContent, preflightHqBroadcast } from '../features/hq-broadcasts/preflight/index.js';
import type { RunRow, Target } from '../features/hq-broadcasts/preflight/index.js';
import { validateHqAfterActionSelection, hqAfterAction } from '../features/hq-broadcasts/hq-broadcast-after-actions/index.js';
import { hqBroadcastBlocks } from '../features/hq-broadcasts/hq-broadcast-blocks/index.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
import type { HqMediaRuntime } from './hq-media.js';
import { resolveHqBroadcastAudience, countHqAudience } from '../features/hq-broadcasts/hq-broadcast-audience/index.js';
import { hqBroadcastApprovalState } from '../features/hq-broadcasts/hq-broadcast-approval/index.js';
import { getLineAccountById, getStaffById, getBroadcastById, closeClaimsForStop } from '@line-crm/db';
import type { HqBroadcastInput, HqBroadcastPreflight, HqBroadcastRun } from '@line-crm/shared';
import { requireHqTemplateAuthority } from './hq-templates/contract.js';
import type { AuthenticatedStaff } from '../middleware/auth/principal/auth.js';
import { StampError, stampId } from './visit-stamps.js';
import { fetchQuota } from '../features/broadcasts/broadcast-quota-guard/index.js';
import { parseBroadcastMessageParts, buildMessages, unsupportedMessageVariables } from '../features/broadcasts/broadcast-message-set/index.js';
import { resolveSendCommonVars } from './interpolation-context.js';
import { isOperationCapabilityStopped } from '@line-crm/db';
import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import { buildBroadcastAudienceQuery } from '../features/broadcasts/index.js';
import { scopeStoredBroadcastSegmentQuery } from './segment-query-scope.js';
import { featureJobCanRun } from './feature-enforcement.js';
import { resolveHqBroadcastMaterials } from '../features/hq-broadcasts/hq-broadcast-materials/index.js';
export async function hqBroadcastAuthority(db:D1Database,staff:AuthenticatedStaff|undefined, read=false) {
  if(!staff?.tenantId)throw new StampError('統括の編集権限が必要です',403);
  const member=await getStaffById(db,staff.id);
  if(!member||member.tenant_id!==staff.tenantId||!member.is_active)throw new StampError('統括の編集権限が必要です',403);
  const result=requireHqTemplateAuthority({tenantId:staff.tenantId,actorId:staff.id,role:member.role,
    hqRole:staff.hqRole,
    readOnly:staff.readOnly||member.access_level==='read_only',accountScoped:member.account_scope==='accounts'});
  if(result.kind!=='AUTHORIZED'||(!read&&result.authority.readOnly))throw new StampError('統括全体の編集権限が必要です',403);return result.authority;
}
export async function prepareHqBroadcast(db:D1Database,tenantId:string,actorId:string,b:HqBroadcastInput, update?:{run:RunRow;expectedVersion:number}) {
  assertHqDeliveryOptions(b);
  if(!b||typeof b.title!=='string'||!b.title.trim()||b.title.length>200||typeof b.messageContent!=='string'||(!b.messageContent.trim()&&!b.messageBubbles&&!b.messageBubblesJson)||b.messageContent.length>200000)throw new StampError('配信名と本文を確認してください', 400, ["title","messageContent","messageBubbles","messageBubblesJson"]);
  stampId(b.requestId);
  if(b.followupOfRunId!==undefined)stampId(b.followupOfRunId);
  if(b.targetType!==undefined&&!['all','tag','segment'].includes(b.targetType))throw new StampError('配信対象の種類を確認してください', 400, ["targetType"]);
  if(b.targetType==='multi-account-dedup')throw new StampError('配布先の店で決める設定は指定できません', 400, ["targetType"]);
  if(b.internalMemo!=null&&(typeof b.internalMemo!=='string'||b.internalMemo.length>10000))throw new StampError('社内メモを確認してください', 400, ["internalMemo"]);
  if(b.excludedTagIds!==undefined&&(!Array.isArray(b.excludedTagIds)||b.excludedTagIds.length>100||b.excludedTagIds.some(v=>typeof v!=='string')))throw new StampError('除くタグを確認してください', 400, ["excludedTagIds"]);
  if(b.folderId&&!await db.prepare('SELECT id FROM hq_broadcast_folders WHERE id=? AND tenant_id=? AND archived_at IS NULL').bind(b.folderId,tenantId).first())throw new StampError('分類を確認してください', 403, ["folderId"]);
  if(b.messageBubbles&&b.messageBubblesJson)throw new StampError('吹き出しは1つの形式で指定してください', 400, ["messageBubbles","messageBubblesJson"]);
  if(b.trackLinks!==undefined&&typeof b.trackLinks!=='boolean'||b.measureOpens!==undefined&&typeof b.measureOpens!=='boolean')throw new StampError('計測設定を確認してください', 400, ["trackLinks","measureOpens"]);
  if(b.stealthSpreadMinutes!==undefined&&(!Number.isInteger(b.stealthSpreadMinutes)||b.stealthSpreadMinutes<0||b.stealthSpreadMinutes>1440))throw new StampError('配信時間を確認してください', 400, ["stealthSpreadMinutes"]);
  if(update&&(!Number.isSafeInteger(update.expectedVersion)||update.expectedVersion<1))throw new StampError('読み込んだ版を指定してください', 400, ["expectedVersion"]);
  if(update&&(update.run.status!=='prepared'||b.requestId!==(JSON.parse(update.run.input_json) as HqBroadcastInput).requestId))throw new StampError('下書きだけ変更できます。同じ依頼番号を使ってください', 409, ["requestId"]);
  for(const ids of [b.accountIds,b.accountTagIds,b.excludedAccountIds])if(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length)throw new StampError('店舗・分類を確認してください', 400, ["accountIds","accountTagIds"]);else ids.forEach(stampId);
  if(!b.accountIds.length&&!b.accountTagIds.length)throw new StampError('対象店か分類を選んでください', 400, ["accountIds","accountTagIds"]);
  if(!b.audience||!['all','tag'].includes(b.audience.kind)||(b.audience.kind==='tag'&&(typeof b.audience.tagName!=='string'||!b.audience.tagName.trim()||b.audience.tagName.length>100)))throw new StampError('全員か、同じ名前のタグを選んでください', 400, ["audience"]);
  if(!['text','image','video','audio','flex','sticker','location','carousel','imagemap','rich_message','card_message','coupon','research'].includes(b.messageType))throw new StampError('本文の種類を確認してください', 400, ["messageType"]);
  try {const content=mappedHqContent(b,'確認用の店名'),parts=parseBroadcastMessageParts({...b,...content});buildMessages(parts);if(unsupportedMessageVariables(parts).length)throw new Error();}
  catch {throw new StampError('本文・差し込みの形式を確認してください', 400, ["messageContent"]);}
  const canonical=JSON.stringify(Object.fromEntries(Object.entries(b).sort(([a],[z])=>a.localeCompare(z)))),existing=await db.prepare('SELECT id,input_json FROM hq_broadcast_runs WHERE tenant_id=? AND request_id=?').bind(tenantId,b.requestId).first<{id:string;input_json:string}>();
  if(existing&&!update){if(existing.input_json!==canonical)throw new StampError('同じ実行の依頼で内容が変わっています',409);return getHqBroadcastRun(db,tenantId,existing.id);}
  if(b.scheduledAt!==null&&(typeof b.scheduledAt!=='string'||!Number.isFinite(Date.parse(b.scheduledAt))||Date.parse(b.scheduledAt)<=Date.now()))throw new StampError('予約日時は未来にしてください', 400, ["scheduledAt"]);
  for(const tag of b.accountTagIds)if(!await db.prepare('SELECT id FROM line_account_tags WHERE id=? AND tenant_id=?').bind(tag,tenantId).first())throw new StampError('分類を確認してください',403);
  const all=(await db.prepare('SELECT id,name FROM line_accounts WHERE tenant_id=? AND archived_at IS NULL').bind(tenantId).all<{id:string;name:string}>()).results;
  for(const id of [...b.accountIds,...b.excludedAccountIds])if(!all.some(a=>a.id===id))throw new StampError('店舗を確認してください',403);
  const tagged=b.accountTagIds.length?(await db.prepare(`SELECT DISTINCT line_account_id FROM line_account_tag_links WHERE tenant_id=? AND tag_id IN (${sqlIdSet(b.accountTagIds).sql})`).bind(tenantId,...(b.accountTagIds.length ? sqlIdSet(b.accountTagIds).binds : [])).all<{line_account_id:string}>()).results.map(x=>x.line_account_id):[];
  const selected=all.filter(a=>[...b.accountIds,...tagged].includes(a.id));if(!selected.length)throw new StampError('対象店がありません', 400, ["accountIds","accountTagIds"]);
  validateHqAfterActionSelection(b,selected.map(a=>a.id));
  const id=update?.run.id??crypto.randomUUID(),token=crypto.randomUUID(),statements=[db.prepare('INSERT INTO hq_broadcast_runs(id,tenant_id,request_id,actor_id,input_json,scheduled_at) VALUES(?,?,?,?,?,?)').bind(id,tenantId,b.requestId,actorId,canonical,b.scheduledAt)];
  if(update){
   statements.splice(0,1,db.prepare(`UPDATE hq_broadcast_runs SET input_json=?,scheduled_at=?,approval_json=NULL,version=version+1,dispatch_token=?,updated_at=datetime('now') WHERE id=? AND tenant_id=? AND status='prepared' AND version=?`).bind(canonical,b.scheduledAt,token,id,tenantId,update.expectedVersion));
   statements.push(db.prepare('DELETE FROM hq_broadcast_targets WHERE run_id=? AND EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)').bind(id,id,token));
  }
  for(const a of selected) {
    // 作成・更新でも条件の欠落を全員配信へ変えない。
    if(!b.excludedAccountIds.includes(a.id)){await resolveHqBroadcastAudience(db,tenantId,a.id,b);await hqAfterAction(db,b,a.id);}
    let tag:string|null=null;if(b.audience.kind==='tag'){
      const tags=(await db.prepare('SELECT id FROM tags WHERE line_account_id=? AND name=?').bind(a.id,b.audience.tagName.trim()).all<{id:string}>()).results;
      if(tags.length===1)tag=tags[0].id;
    }
    statements.push(db.prepare(`INSERT INTO hq_broadcast_targets(run_id,line_account_id,account_name,tag_id,excluded) SELECT ?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)`).bind(id,a.id,a.name,tag,b.excludedAccountIds.includes(a.id)?1:0,Number(!!update),id,token));
    statements.push(db.prepare(`INSERT INTO hq_broadcast_audit(id,run_id,line_account_id,actor_id,action) SELECT ?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)`).bind(crypto.randomUUID(),id,a.id,actorId,update?'draft_updated':'target_fixed',Number(!!update),id,token));
  }
  try {const result=await db.batch(statements);if(update&&!result[0].meta.changes)throw new StampError('下書きが更新されました。読み直してください',409);}catch(e){if(update)throw e;const winner=await db.prepare('SELECT id,input_json FROM hq_broadcast_runs WHERE tenant_id=? AND request_id=?').bind(tenantId,b.requestId).first<{id:string;input_json:string}>();if(!winner)throw e;if(winner.input_json!==canonical)throw new StampError('同じ実行の依頼で内容が変わっています',409);return getHqBroadcastRun(db,tenantId,winner.id);}
  return getHqBroadcastRun(db,tenantId,id);
}
export async function excludeHqBroadcastTargets(db:D1Database,run:RunRow,actorId:string,ids:string[],version:number) {
  if(!Array.isArray(ids)||ids.length>100||!Number.isSafeInteger(version))throw new StampError('除外する店舗と版を確認してください');ids.forEach(stampId);
  const targets=(await db.prepare('SELECT line_account_id FROM hq_broadcast_targets WHERE run_id=?').bind(run.id).all<{line_account_id:string}>()).results;
  if(ids.some(x=>!targets.some(t=>t.line_account_id===x)))throw new StampError('固定した対象以外の店は選べません');
  const token=crypto.randomUUID();const ops=[db.prepare(`UPDATE hq_broadcast_runs SET approval_json=NULL,version=version+1,dispatch_token=? WHERE id=? AND status='prepared' AND version=?`).bind(token,run.id,version)];
  for(const t of targets){ops.push(db.prepare(`UPDATE hq_broadcast_targets SET excluded=? WHERE run_id=? AND line_account_id=? AND EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)`).bind(ids.includes(t.line_account_id)?1:0,run.id,t.line_account_id,run.id,token));
    ops.push(db.prepare(`INSERT INTO hq_broadcast_audit(id,run_id,line_account_id,actor_id,action) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)`).bind(crypto.randomUUID(),run.id,t.line_account_id,actorId,ids.includes(t.line_account_id)?'excluded':'included',run.id,token));}
  const r=await db.batch(ops);if(!r[0].meta.changes)throw new StampError('対象店が更新されました。読み直してください', 409, ["accountIds","accountTagIds"]);
}
export async function dispatchHqBroadcast(db:D1Database,run:RunRow,actorId:string,version:number, confirmedRecipientCount?:number, runtime?:HqMediaRuntime) {
  if(run.status!=='prepared')return readHqBroadcastResult(db,run);
  const preflight=await preflightHqBroadcast(db,run,true,runtime),selected=preflight.filter(p=>!p.excluded);
  if(!selected.length||selected.some(p=>p.blockedReasons.length))throw new StampError('送れない店舗を外して再確認してください',409);
  if(confirmedRecipientCount!==undefined && confirmedRecipientCount!==selected.reduce((n,p)=>n+(p.audienceCount??0),0))throw new StampError('送る相手が変わりました。もう一度確かめてください',409);
  const approval=await hqBroadcastApprovalState(db,run,actorId,preflight);
  if(approval.gate.required) {
    if(approval.gate.singleOperator&&confirmedRecipientCount!==approval.gate.recipientCount)throw new StampError('送る人数を入力して確認してください',409);
    if(!approval.gate.singleOperator&&(approval.approval.status!=='approved'||approval.approval.confirmedCount!==approval.gate.recipientCount))throw new StampError('別の担当者の承認が必要です。人数が変わった場合は再承認してください',409);
  }
  const input=JSON.parse(run.input_json) as HqBroadcastInput,at=input.scheduledAt??new Date().toISOString(),token=crypto.randomUUID();
  const ops=[db.prepare("UPDATE hq_broadcast_runs SET status='scheduled',version=version+1,dispatch_token=?,updated_at=datetime('now') WHERE id=? AND status='prepared' AND version=?").bind(token,run.id,version)];
  for(const p of selected){const broadcastId=crypto.randomUUID();
    const resolved=await resolveHqBroadcastAudience(db,run.tenant_id,p.accountId,input);
    const account=await getLineAccountById(db,p.accountId);
    if(!account||account.tenant_id!==run.tenant_id)throw new StampError('店舗を確認してください',409);
    const materials=await resolveHqBroadcastMaterials(db,run.tenant_id,p.accountId,input,runtime ? {...runtime,copy:true} : undefined);
    const content=mappedHqContent(materials,account.name,account.liff_id);
    const after=await hqAfterAction(db,input,p.accountId);
    if(after)ops.push(db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM common_action_versions v JOIN common_actions a ON a.id=v.common_action_id WHERE v.id=? AND v.status='published' AND a.id=? AND a.line_account_id=? AND a.status='published' AND a.archived_at IS NULL AND v.action_config=?) THEN '{}' ELSE 'AFTER_ACTION_CONFLICT' END)`).bind(after.id,after.actionId,p.accountId,after.actionsJson));
    ops.push(db.prepare(`INSERT INTO broadcasts(id,title,message_type,message_content,message_bubbles_json,target_type,status,scheduled_at,line_account_id,alt_text,segment_conditions,hq_run_id,
      internal_memo,track_links,measure_opens,stealth_spread_minutes,message_options_json,after_action_version_id,approval_status,approval_requested_by_staff_id,approval_decided_by_staff_id,approval_confirmed_count)
      SELECT ?,?,?,?,?,'segment','scheduled',?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)`)
      .bind(broadcastId,input.title,input.messageType,content.messageContent,content.messageBubblesJson,at,p.accountId,content.altText,JSON.stringify(resolved),run.id,
        input.internalMemo??null,Number(input.trackLinks!==false),Number(input.measureOpens!==false),input.stealthSpreadMinutes??0,content.messageOptionsJson,after?.id??null,
        approval.gate.required?'approved':'none',approval.approval.requestedByStaffId,approval.approval.decidedByStaffId,p.audienceCount,run.id,token));
    ops.push(db.prepare(`UPDATE hq_broadcast_targets SET broadcast_id=? WHERE run_id=? AND line_account_id=? AND EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)`).bind(broadcastId,run.id,p.accountId,run.id,token));
    ops.push(db.prepare(`INSERT INTO hq_broadcast_audit(id,run_id,line_account_id,actor_id,action) SELECT ?,?,?,?,'scheduled' WHERE EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)`).bind(crypto.randomUUID(),run.id,p.accountId,actorId,run.id,token));
  }
  const result=await db.batch(ops);if(!result[0].meta.changes)throw new StampError('別の担当者が先に操作しました',409);
  return readHqBroadcastResult(db,await getHqBroadcastRun(db,run.tenant_id,run.id));
}
const retryableWhere = `((s.state='failed' AND s.error_code IN ('line_http_429','stopped_before_dispatch')) OR ((b.stopped_at IS NOT NULL OR b.status='sent') AND s.state='claimed' AND s.dispatched_at IS NULL))`;
const availableWhere = `EXISTS(SELECT 1 FROM friends f WHERE f.id=s.friend_id AND f.line_account_id=b.line_account_id
  AND f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND ${DELIVERY_CONSENT_ALLOWED_SQL})`;
async function draftAudienceQuery(db:D1Database,broadcastId:string) {
  const b=await db.prepare('SELECT status,segment_conditions,line_account_id,stopped_at FROM broadcasts WHERE id=?').bind(broadcastId).first<{status:string;segment_conditions:string|null;line_account_id:string|null;stopped_at:string|null}>();
  if(!b||!b.segment_conditions||!(b.status==='draft'||(b.status==='sending'&&b.stopped_at!==null)))return null;
  const prior=await db.prepare('SELECT 1 FROM broadcast_send_claims WHERE broadcast_id=? LIMIT 1').bind(broadcastId).first();
  if(prior)return null;
  const query=await scopeStoredBroadcastSegmentQuery(db,buildBroadcastAudienceQuery(JSON.parse(b.segment_conditions)),b.line_account_id);
  return {sql:`SELECT f.id AS friend_id FROM (${query.sql}) f WHERE ${DELIVERY_CONSENT_ALLOWED_SQL}`,bindings:query.bindings};
}
async function retrySnapshot(db:D1Database,broadcastId:string) {
  const draft=await draftAudienceQuery(db,broadcastId);
  const rows=draft
    ? await db.prepare(`${draft.sql} ORDER BY f.id`).bind(...draft.bindings).all<{friend_id:string}>()
    : await db.prepare(`SELECT s.friend_id FROM broadcast_send_claims s JOIN broadcasts b ON b.id=s.broadcast_id WHERE s.broadcast_id=? AND ${retryableWhere} AND ${availableWhere} ORDER BY s.friend_id`).bind(broadcastId).all<{friend_id:string}>();
  const ids=rows.results.map(r=>r.friend_id), json=JSON.stringify(ids);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(json));
  return {ids,json,token:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),draft};
}
async function retryCount(db:D1Database,broadcastId:string) {
  const draft=await draftAudienceQuery(db,broadcastId);
  const count=draft
    ? await db.prepare(`SELECT COUNT(*) AS n FROM (${draft.sql})`).bind(...draft.bindings).first<{n:number}>()
    : await db.prepare(`SELECT COUNT(*) AS n FROM broadcast_send_claims s JOIN broadcasts b ON b.id=s.broadcast_id WHERE s.broadcast_id=? AND ${retryableWhere} AND ${availableWhere}`).bind(broadcastId).first<{n:number}>();
  return Number(count?.n??0);
}
export async function previewHqRetry(db:D1Database,run:RunRow,accountId:string) {
  const target=await db.prepare('SELECT broadcast_id FROM hq_broadcast_targets WHERE run_id=? AND line_account_id=? AND excluded=0').bind(run.id,stampId(accountId)).first<{broadcast_id:string|null}>();
  if(!target?.broadcast_id)throw new StampError('店舗の配信が見つかりません',404);
  const snapshot=await retrySnapshot(db,target.broadcast_id);
  return {count:snapshot.ids.length,token:snapshot.token};
}
export class HqRetryConflict extends StampError {
  constructor(public currentCount:number) { super('送る相手が変わりました。もう一度確かめてください。',409); }
}
export async function readHqBroadcastResult(db:D1Database,run:RunRow):Promise<HqBroadcastRun> {
  const input=JSON.parse(run.input_json) as HqBroadcastInput,rows=(await db.prepare(`SELECT t.*,b.status AS child_status,b.total_count,b.success_count,b.stopped_at,b.lock_version,b.approval_status,
    (SELECT unique_impression FROM broadcast_insights i WHERE i.broadcast_id=b.id AND i.status='ready' ORDER BY fetched_at DESC,rowid DESC LIMIT 1) AS opened_count,
    (SELECT unique_click FROM broadcast_insights i WHERE i.broadcast_id=b.id AND i.status='ready' ORDER BY fetched_at DESC,rowid DESC LIMIT 1) AS clicked_count,
    CASE WHEN b.sent_at IS NULL THEN NULL ELSE (SELECT COUNT(DISTINCT m.friend_id) FROM messages_log m JOIN broadcast_send_claims s ON s.friend_id=m.friend_id AND s.broadcast_id=b.id AND s.state='sent'
      WHERE m.line_account_id=b.line_account_id AND m.direction='incoming' AND julianday(m.created_at)>=julianday(b.sent_at) AND julianday(m.created_at)<julianday(b.sent_at,'+14 days')) END AS reaction_count
    FROM hq_broadcast_targets t JOIN line_accounts a ON a.id=t.line_account_id AND a.tenant_id=? LEFT JOIN broadcasts b ON b.id=t.broadcast_id WHERE t.run_id=? ORDER BY t.line_account_id`).bind(run.tenant_id,run.id).all<Target & {opened_count:number|null;clicked_count:number|null;reaction_count:number|null;approval_status:string|null;child_status:string|null;total_count:number|null;success_count:number|null;stopped_at:string|null;lock_version:number|null}>()).results;
  const failures=(await db.prepare(`SELECT t.line_account_id,s.state,s.error_code,COUNT(*) AS count FROM hq_broadcast_targets t JOIN broadcast_send_claims s ON s.broadcast_id=t.broadcast_id WHERE t.run_id=? AND s.state IN ('failed','unknown') GROUP BY t.line_account_id,s.state,s.error_code`).bind(run.id).all<{line_account_id:string;state:string;error_code:string|null;count:number}>()).results;
  const blocks=await hqBroadcastBlocks(db,run.tenant_id,run.id);
  const counts=await Promise.all(rows.map(r=>r.broadcast_id&&(r.child_status==='sent'||(r.child_status==='sending'&&r.stopped_at)||(r.child_status==='draft'&&run.status!=='prepared'))?retryCount(db,r.broadcast_id):0));
  return {input,id:run.id,title:input.title,status:run.status,version:run.version,scheduledAt:run.scheduled_at,targets:rows.map((r,index)=>({...(r.preflight_json?JSON.parse(r.preflight_json):{accountId:r.line_account_id,accountName:r.account_name,audienceCount:null,remaining:null,connected:false,paused:false,blockedReasons:[]}),failureReasons:failures.filter(f=>f.line_account_id===r.line_account_id).map(f=>classifyHqFailure(f.state,f.error_code,f.count)).concat(r.child_status==='sent'&&r.total_count===0?[{code:'no_friends',label:'友だちが0人です',count:0,retryable:false}]:r.child_status==='draft'&&run.status==='scheduled'?[{code:'before_send_failed',label:'送信前の確認で止まりました。店舗の送信前確認をやり直してください',count:0,retryable:true}]:[]),excluded:!!r.excluded,broadcastId:r.broadcast_id,status:r.excluded?'excluded':(run.status==='cancelled'?'cancelled':r.child_status==='draft'&&run.status!=='prepared'?'failed':r.child_status??'prepared'),openedCount:r.opened_count,clickedCount:r.clicked_count,reactionCount:r.reaction_count,blockedCount:blocks.blocksByAccount.find(b=>b.accountId===r.line_account_id)?.blockCount??null,approvalStatus:r.approval_status??'none',successCount:r.success_count??0,totalCount:r.total_count??0,version:r.lock_version??1,retryableCount:counts[index],stopped:!!r.stopped_at}))};
}
export async function stopHqBroadcast(db:D1Database,run:RunRow,actorId:string,cancel:boolean,version:number) {
  const token=crypto.randomUUID(),ops=[db.prepare(`UPDATE hq_broadcast_runs SET status=?,version=version+1,dispatch_token=? WHERE id=? AND version=? AND status NOT IN ('cancelled')`).bind(cancel?'cancelled':'stopped',token,run.id,version)];
  const targets=(await db.prepare('SELECT * FROM hq_broadcast_targets WHERE run_id=?').bind(run.id).all<Target>()).results;
  for(const t of targets){if(t.broadcast_id)ops.push(db.prepare(`UPDATE broadcasts SET status=CASE WHEN status='scheduled' THEN 'draft' ELSE status END,scheduled_at=NULL,
    stopped_at=COALESCE(stopped_at,datetime('now')),stopped_by=?,lock_version=lock_version+1 WHERE id=? AND status IN ('scheduled','sending') AND EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)`).bind(actorId,t.broadcast_id,run.id,token));
    ops.push(db.prepare(`INSERT INTO hq_broadcast_audit(id,run_id,line_account_id,actor_id,action) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND dispatch_token=?)`).bind(crypto.randomUUID(),run.id,t.line_account_id,actorId,cancel?'cancelled':'stopped',run.id,token));}
  const r=await db.batch(ops);if(!r[0].meta.changes)throw new StampError('別の担当者が先に操作しました',409);
  for(const t of targets)if(t.broadcast_id)await closeClaimsForStop(db,t.broadcast_id);
  return readHqBroadcastResult(db,await getHqBroadcastRun(db,run.tenant_id,run.id));
}
export async function retryHqBroadcastTarget(db:D1Database,run:RunRow,accountId:string,actorId:string,version:number,confirmation?:{count:number;token:string}) {
  if(run.status==='cancelled')throw new StampError('取り消した配信はやり直せません',409);
  const t=await db.prepare('SELECT broadcast_id FROM hq_broadcast_targets WHERE run_id=? AND line_account_id=? AND excluded=0').bind(run.id,stampId(accountId)).first<{broadcast_id:string|null}>();
  if(!t?.broadcast_id)throw new StampError('店舗の配信が見つかりません',404);
  const broadcast=await getBroadcastById(db,t.broadcast_id);if(!broadcast)throw new StampError('配信が見つかりません',404);
  if(confirmation) {
    const snapshot=await retrySnapshot(db,broadcast.id);
    if(confirmation.count!==snapshot.ids.length||confirmation.token!==snapshot.token)throw new HqRetryConflict(snapshot.ids.length);
  }
  const check=(await preflightHqBroadcast(db,run)).find(p=>p.accountId===accountId);if(check?.blockedReasons.length)throw new StampError('店舗の送信前確認に問題があります',409);
  const beforeDelivery=confirmation&&broadcast.status==='sending'&&broadcast.stopped_at?await draftAudienceQuery(db,broadcast.id):null;
  if(broadcast.status==='draft'||beforeDelivery) {
    if(confirmation) {
      const snapshot=await retrySnapshot(db,broadcast.id);
      if(confirmation.count!==snapshot.ids.length||confirmation.token!==snapshot.token||!snapshot.ids.length)throw new HqRetryConflict(snapshot.ids.length);
      if(!snapshot.draft) {
        const update=db.prepare(`UPDATE broadcasts SET status='scheduled',scheduled_at=?,stopped_at=NULL,stopped_by=NULL,lock_version=lock_version+1,send_attempt_no=send_attempt_no+1
          WHERE id=? AND status='draft' AND lock_version=? AND NOT EXISTS(SELECT 1 FROM broadcast_send_claims WHERE broadcast_id=? AND state IN ('sent','unknown','claimed'))
          AND EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND status<>'cancelled')
          AND ?=(SELECT COALESCE(json_group_array(friend_id),'[]') FROM (SELECT s.friend_id FROM broadcast_send_claims s JOIN broadcasts b ON b.id=s.broadcast_id WHERE s.broadcast_id=? AND ${retryableWhere} AND ${availableWhere} ORDER BY s.friend_id))`)
          .bind(new Date().toISOString(),broadcast.id,version,broadcast.id,run.id,snapshot.json,broadcast.id);
        const reopen=db.prepare(`UPDATE broadcast_send_claims SET state='claimed',attempt_no=(SELECT send_attempt_no FROM broadcasts WHERE id=?),dispatched_at=NULL,settled_at=NULL,error_code=NULL
          WHERE broadcast_id=? AND friend_id IN (SELECT value FROM json_each(?))`).bind(broadcast.id,broadcast.id,snapshot.json);
        try { await db.batch([update,db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'RETRY_CONFLICT' END)"),reopen]); }
        catch(error) { if(!(error instanceof Error)||!/(malformed JSON|RETRY_CONFLICT)/i.test(error.message))throw error; throw new HqRetryConflict((await retrySnapshot(db,broadcast.id)).ids.length); }
        await db.prepare('INSERT INTO hq_broadcast_audit(id,run_id,line_account_id,actor_id,action) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),run.id,accountId,actorId,'retry_before_delivery').run();
        return readHqBroadcastResult(db,await getHqBroadcastRun(db,run.tenant_id,run.id));
      }
      const update=db.prepare(`UPDATE broadcasts SET status='scheduled',scheduled_at=?,stopped_at=NULL,stopped_by=NULL,lock_version=lock_version+1,total_count=?
        WHERE id=? AND (status='draft' OR (status='sending' AND stopped_at IS NOT NULL)) AND lock_version=? AND NOT EXISTS(SELECT 1 FROM broadcast_send_claims WHERE broadcast_id=?)
        AND EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND status<>'cancelled')
        AND ?=(SELECT COALESCE(json_group_array(friend_id),'[]') FROM (SELECT friend_id FROM (${snapshot.draft.sql}) ORDER BY friend_id))`)
        .bind(new Date().toISOString(),snapshot.ids.length,broadcast.id,version,broadcast.id,run.id,snapshot.json,...snapshot.draft.bindings);
      const freeze=db.prepare(`INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,attempt_no,state)
        SELECT ?,value,?,COALESCE((SELECT send_attempt_no FROM broadcasts WHERE id=?),1),'claimed' FROM json_each(?)`)
        .bind(broadcast.id,accountId,broadcast.id,snapshot.json);
      try { await db.batch([update,db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'RETRY_CONFLICT' END)"),freeze]); }
      catch(error) { if(!(error instanceof Error)||!/(malformed JSON|RETRY_CONFLICT)/i.test(error.message))throw error; throw new HqRetryConflict((await retrySnapshot(db,broadcast.id)).ids.length); }
      await db.prepare('INSERT INTO hq_broadcast_audit(id,run_id,line_account_id,actor_id,action) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),run.id,accountId,actorId,'retry_before_delivery').run();
      return readHqBroadcastResult(db,await getHqBroadcastRun(db,run.tenant_id,run.id));
    }
    const prior=await db.prepare(`SELECT 1 FROM broadcast_send_claims WHERE broadcast_id=? AND state IN ('sent','unknown','claimed') LIMIT 1`).bind(broadcast.id).first();
    if(prior)throw new StampError('送達の状態を確認する必要があります',409);
    const changed=await db.prepare(`UPDATE broadcasts SET status='scheduled',scheduled_at=?,stopped_at=NULL,stopped_by=NULL,lock_version=lock_version+1
      WHERE id=? AND status='draft' AND lock_version=? AND EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND status<>'cancelled')`).bind(new Date().toISOString(),broadcast.id,version,run.id).run();
    if(!changed.meta.changes)throw new StampError('配信が更新されました',409);
    await db.prepare('INSERT INTO hq_broadcast_audit(id,run_id,line_account_id,actor_id,action) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),run.id,accountId,actorId,'retry_before_delivery').run();
    return readHqBroadcastResult(db,await getHqBroadcastRun(db,run.tenant_id,run.id));
  }
  const snapshot=await retrySnapshot(db,broadcast.id);
  if(confirmation&&(confirmation.count!==snapshot.ids.length||confirmation.token!==snapshot.token))throw new HqRetryConflict(snapshot.ids.length);
  if(!snapshot.ids.length)throw new StampError('やり直せる一時的な失敗がありません',409);
  const update=db.prepare(`UPDATE broadcasts SET send_attempt_no=send_attempt_no+1,status='sending',sent_at=NULL,stopped_at=NULL,stopped_by=NULL,
    batch_offset=0,batch_lock_at=NULL,lock_version=lock_version+1 WHERE id=? AND lock_version=? AND (status='sent' OR (status='sending' AND stopped_at IS NOT NULL))
    AND EXISTS(SELECT 1 FROM hq_broadcast_runs WHERE id=? AND status<>'cancelled')
    AND ?=(SELECT COALESCE(json_group_array(friend_id),'[]') FROM (SELECT s.friend_id FROM broadcast_send_claims s JOIN broadcasts b ON b.id=s.broadcast_id WHERE s.broadcast_id=? AND ${retryableWhere} AND ${availableWhere} ORDER BY s.friend_id))`)
    .bind(broadcast.id,version,run.id,snapshot.json,broadcast.id);
  const reopen=db.prepare(`UPDATE broadcast_send_claims SET state='claimed',attempt_no=(SELECT send_attempt_no FROM broadcasts WHERE id=?),dispatched_at=NULL,settled_at=NULL,error_code=NULL,updated_at=datetime('now')
    WHERE broadcast_id=? AND friend_id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND lock_version=? AND status='sending' AND stopped_at IS NULL)`)
    .bind(broadcast.id,broadcast.id,snapshot.json,broadcast.id,version+1);
  const exclude=db.prepare(`UPDATE broadcast_send_claims SET state='failed',error_code='recipient_unavailable',settled_at=datetime('now')
    WHERE broadcast_id=? AND state='claimed' AND dispatched_at IS NULL AND friend_id NOT IN (SELECT value FROM json_each(?))`)
    .bind(broadcast.id,snapshot.json);
  try {
    await db.batch([update,db.prepare("SELECT json(CASE WHEN changes()=1 THEN '{}' ELSE 'RETRY_CONFLICT' END)"),reopen,exclude]);
  } catch(error) {
    if(!(error instanceof Error)||!/(malformed JSON|RETRY_CONFLICT)/i.test(error.message))throw error;
    throw new HqRetryConflict((await retrySnapshot(db,broadcast.id)).ids.length);
  }
  await db.prepare('INSERT INTO hq_broadcast_audit(id,run_id,line_account_id,actor_id,action) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),run.id,accountId,actorId,'retry_failed').run();
  return readHqBroadcastResult(db,run);
}

export function classifyHqFailure(state:string,errorCode:string|null,count:number) {
 if(errorCode==='delivery_consent_suppressed')return {code:'consent_excluded',label:'配信を止めているため送りませんでした',count,retryable:false};
 if(state==='unknown')return {code:'delivery_unknown',label:'LINEの応答なし（届いたか確認が必要）',count,retryable:false};
 if(errorCode==='line_http_429')return {code:'line_busy',label:'LINEが混雑しています',count,retryable:true};
 if(errorCode==='stopped_before_dispatch')return {code:'stopped',label:'送信前に停止しました',count,retryable:true};
 if(errorCode?.startsWith('common_var'))return {code:'store_information_missing',label:'店の共通情報が不足しています',count,retryable:false};
 if(errorCode==='line_http_401'||errorCode==='line_http_403')return {code:'line_connection',label:'LINEの接続を確認してください',count,retryable:false};
 return {code:'send_failed',label:'LINEへ送れませんでした',count,retryable:false};
}
