import { hqAudienceSnapshot, HqAudienceConflict, type HqConfirmedAudience } from '../features/hq-broadcasts/hq-audience-confirmation/index.js';
import { UnexpectedRouteError } from '../lib/unhandled-error.js';
import { buildOffsetListResponse, listQueryNumber } from '../lib/list-paging.js';
import { getBroadcastApprovalThreshold } from '../features/broadcasts/broadcast-approval/index.js';
import { sendAudienceCounts } from '../services/gap-send-preview.js';
import { resolveHqBroadcastAudience } from '../features/hq-broadcasts/hq-broadcast-audience/index.js';
import { copyHqBroadcast,hqBroadcastReactions } from '../features/hq-broadcasts/hq-broadcast-reactions/index.js';
import { listHqBroadcastViews, saveHqBroadcastView, archiveHqBroadcastView } from '../features/hq-broadcasts/hq-broadcast-saved-views/index.js';
import { listHqBroadcasts,hqBroadcastQuota } from '../features/hq-broadcasts/hq-broadcast-list/index.js';
import { folderInputError, inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { swapHqFolderOrder,HqFolderError } from '@line-crm/db';
import { sensitiveStepUpSatisfied, stepUpRequiredResponse } from '../lib/step-up.js';
import { hqBroadcastApprovalState, hqBroadcastApprovalCandidates, updateHqApproval } from '../features/hq-broadcasts/hq-broadcast-approval/index.js';
import { hqBroadcastRecipients, hqBroadcastActivity, testHqBroadcast, hqTestRecipientPreview, HqTestRecipientConflict } from '../features/hq-broadcasts/hq-broadcast-details/index.js';
import { Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { isFolderSelectColor } from '@line-crm/shared';
import type { HqBroadcastInput, HqBroadcastDraftInput } from '@line-crm/shared';
import { dbFor } from '../services/db-router.js';
import { requireRole, requireIrreversibleConfirmation } from '../middleware/role-guard.js';
import { StampError } from '../services/visit-stamps.js';
import { hqBroadcastAuthority, prepareHqBroadcast, getHqBroadcastRun, readHqBroadcastResult, preflightHqBroadcast,
  excludeHqBroadcastTargets, dispatchHqBroadcast, stopHqBroadcast, retryHqBroadcastTarget, previewHqRetry, HqRetryConflict } from '../services/hq-broadcasts.js';
export const hqBroadcasts=new Hono<Env>();
const mediaRuntime = (c: import('hono').Context<Env>) => ({bucket:c.env.IMAGES,publicBaseUrl:c.env.WORKER_URL || new URL(c.req.url).origin});
hqBroadcasts.onError((e, c) => {
  if (e instanceof HqAudienceConflict) return c.json({success:false,code:'HQ_AUDIENCE_CHANGED',error:e.message,data:e.current},409);
  if (e instanceof HqTestRecipientConflict) return c.json({success:false,code:'HQ_TEST_RECIPIENT_CHANGED',error:e.message,data:e.current},409);
  if (e instanceof HqRetryConflict) return c.json({success:false,error:e.message,currentCount:e.currentCount,data:{currentCount:e.currentCount}},409);
  if (!(e instanceof StampError)) throw new UnexpectedRouteError(c, { success: false, error: '統括配信を確認できません' });
  return inputError(c, { success: false, ...((e.status === 400 || e.status === 422) ? { fields: e.fields } : {}), error: e.message }, e.status);
});
hqBroadcasts.use('/api/hq/broadcasts/*',requireRole('owner','admin'),async(c,next)=>{await hqBroadcastAuthority(dbFor(c.env),c.get('staff'),['GET','HEAD'].includes(c.req.method));await next();});
hqBroadcasts.get('/api/hq/broadcasts',async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method));
  const result=await listHqBroadcasts(db,a.tenantId,{from:c.req.query('from'),to:c.req.query('to'),q:c.req.query('q'),status:c.req.query('status'),folderId:c.req.query('folderId'),limit:c.req.query('limit'),cursor:c.req.query('cursor'),sort:c.req.query('sort')});
  return c.json(buildOffsetListResponse({ success:true,...result, items: result.data, total: result.pagination.total, paging: { limit: result.pagination.limit }, sort: [{field:'at',direction:c.req.query('sort') === 'oldest' ? 'asc' : 'desc'},{field:'id',direction:c.req.query('sort') === 'oldest' ? 'asc' : 'desc'}] }));
});
hqBroadcasts.get('/api/hq/broadcasts/test-recipients',async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'));const accountId=c.req.query('accountId');
 if(!accountId)throw new StampError('対象店を確認してください',400);
 return c.json({success:true,data:await hqTestRecipientPreview(db,a.tenantId,accountId)});
});
hqBroadcasts.get('/api/hq/broadcasts/quota',async c=>{const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true);return c.json({success:true,data:await hqBroadcastQuota(db,a.tenantId)})});
hqBroadcasts.get('/api/hq/broadcasts/saved-views',async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true);
  const member=await db.prepare('SELECT access_level FROM staff_members WHERE id=? AND tenant_id=?').bind(a.actorId,a.tenantId).first<{access_level:string}>();
  return c.json({success:true,data:await listHqBroadcastViews(db,a.tenantId,a.actorId,!!c.get('staff').readOnly||member?.access_level==='read_only')});
});
hqBroadcasts.post('/api/hq/broadcasts/saved-views',inputJsonBoundary(),async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'));
  return c.json({success:true,data:await saveHqBroadcastView(db,a.tenantId,a.actorId,await c.req.json())},201);
});
hqBroadcasts.patch('/api/hq/broadcasts/saved-views/:viewId',inputJsonBoundary(),async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'));
  return c.json({success:true,data:await saveHqBroadcastView(db,a.tenantId,a.actorId,await c.req.json(),c.req.param('viewId'))});
});
hqBroadcasts.delete('/api/hq/broadcasts/saved-views/:viewId',inputJsonBoundary(),async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff')),input=await c.req.json();
  return c.json({success:true,data:await archiveHqBroadcastView(db,a.tenantId,a.actorId,c.req.param('viewId'),input.expectedRevision)});
});
hqBroadcasts.post('/api/hq/broadcasts',inputJsonBoundary({"title":["string"],"messageContent":["string"],"messageType":["string"],"messageBubbles":["array"],"messageBubblesJson":["null","string"],"altText":["null","string"],"targetType":["string"],"targetTagId":["null","string"],"segmentConditions":["null","object"],"excludedTagIds":["array"],"savedSearchId":["null","string"],"scheduledAt":["null","string"],"status":["string"],"lineAccountId":["null","string"],"accountIds":["array"],"dedupPriority":["array"],"trackLinks":["boolean"],"stealthSpreadMinutes":["number"],"folderId":["null","string"],"measureOpens":["boolean"],"saveAsDraft":["boolean"],"draftStep":["null","string"],"internalMemo":["null","string"],"messageOptions":["null","object"],"afterActionVersionIds":["object"],"afterActionVersionId":["null","string"],"confirmedRecipientCount":["number"],"requestId":["string"],"accountTagIds":["array"],"excludedAccountIds":["array"],"audience":["object"],"followupOfRunId":["string"]}), async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method)),input=await c.req.json<HqBroadcastInput>();
  const run=await prepareHqBroadcast(db,a.tenantId,a.actorId,input);return c.json({success:true,data:await readHqBroadcastResult(db,run)},201);
});
hqBroadcasts.get('/api/hq/broadcasts/approvals/candidates',async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true);
 return c.json({success:true,data:(await hqBroadcastApprovalCandidates(db,a.tenantId)).filter(r=>r.id!==a.actorId).map(r=>({...r,canApprove:true}))});
});
hqBroadcasts.post('/api/hq/broadcasts/folders/:id/swap-order',inputJsonBoundary({withId:['string'],expectedVersion:['number'],withExpectedVersion:['number']}),async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff')),b=await c.req.json();
 try {return c.json({success:true,data:await swapHqFolderOrder(db,'hq_broadcast_folders',a.tenantId,c.req.param('id'),{withId:b.withId,expectedRevision:b.expectedVersion,withExpectedRevision:b.withExpectedVersion})});}
 catch(e){if(e instanceof HqFolderError)return folderInputError(c, e, ['expectedVersion','withExpectedVersion']);throw e;}
});
hqBroadcasts.get('/api/hq/broadcasts/folders',async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true);
 return c.json({success:true,data:(await db.prepare(`SELECT f.id,f.name,f.revision,f.color,f.display_order,
   (SELECT COUNT(*) FROM hq_broadcast_runs r WHERE r.tenant_id=f.tenant_id AND json_extract(r.input_json,'$.folderId')=f.id) AS item_count
   FROM hq_broadcast_folders f WHERE tenant_id=? AND archived_at IS NULL ORDER BY display_order,name,id`).bind(a.tenantId).all()).results});
});
hqBroadcasts.post('/api/hq/broadcasts/folders',inputJsonBoundary({"name":["string"],"color":["null","string"]}), async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff')),b=await c.req.json<{name:string;color?:string|null}>();
 if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100)throw new StampError('分類名を確認してください', 400, ["name"]);
 if(b.color!==undefined&&!isFolderSelectColor(b.color))return inputError(c, {success:false,error:'フォルダの色を確認してください'}, 422, ["color"]);
 const id=crypto.randomUUID();await db.prepare('INSERT INTO hq_broadcast_folders(id,tenant_id,name,color,display_order) SELECT ?,?,?,?,COALESCE(MAX(display_order),-1)+1 FROM hq_broadcast_folders WHERE tenant_id=? AND archived_at IS NULL').bind(id,a.tenantId,b.name.trim(),b.color??null,a.tenantId).run();
 return c.json({success:true,data:{id,name:b.name.trim(),color:b.color??null,revision:1}},201);
});
hqBroadcasts.patch('/api/hq/broadcasts/folders/:id',inputJsonBoundary({"name":["string"],"expectedVersion":["number"],"color":["null","string"]}), async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff')),b=await c.req.json<{name:string;expectedVersion:number;color?:string|null}>();
 if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100||!Number.isSafeInteger(b.expectedVersion))throw new StampError('分類名と版を確認してください', 400, ["name","expectedVersion"]);
 if(b.color!==undefined&&!isFolderSelectColor(b.color))return inputError(c, {success:false,error:'フォルダの色を確認してください'}, 422, ["color"]);
 const r=await db.prepare(`UPDATE hq_broadcast_folders SET name=?,color=CASE WHEN ? THEN ? ELSE color END,revision=revision+1,updated_at=datetime('now') WHERE id=? AND tenant_id=? AND revision=? AND archived_at IS NULL`)
 .bind(b.name.trim(),b.color!==undefined?1:0,b.color??null,c.req.param('id'),a.tenantId,b.expectedVersion).run();if(!r.meta.changes)throw new StampError('分類が更新されました',409);
 const folder=await db.prepare('SELECT id,name,revision,color FROM hq_broadcast_folders WHERE id=? AND tenant_id=?').bind(c.req.param('id'),a.tenantId).first();
 return c.json({success:true,data:folder});
});
hqBroadcasts.delete('/api/hq/broadcasts/folders/:id',async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff')),b=await c.req.json<{expectedVersion:number}>();
 if(!Number.isSafeInteger(b.expectedVersion))throw new StampError('版を確認してください', 400, ["expectedVersion"]);
 const r=await db.prepare(`UPDATE hq_broadcast_folders SET archived_at=datetime('now'),revision=revision+1 WHERE id=? AND tenant_id=? AND revision=? AND archived_at IS NULL`)
 .bind(c.req.param('id'),a.tenantId,b.expectedVersion).run();if(!r.meta.changes)throw new StampError('分類が更新されました',409);
 return c.json({success:true,data:{id:c.req.param('id'),archived:true}});
});
hqBroadcasts.get('/api/hq/broadcasts/:id',async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method));return c.json({success:true,data:await readHqBroadcastResult(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')))});
});
hqBroadcasts.get('/api/hq/broadcasts/:id/send-preview',async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true);
  const run=await getHqBroadcastRun(db,a.tenantId,c.req.param('id')), input=JSON.parse(run.input_json) as HqBroadcastInput;
  const targets=(await db.prepare('SELECT line_account_id FROM hq_broadcast_targets WHERE run_id=? AND excluded=0 ORDER BY line_account_id').bind(run.id).all<{line_account_id:string}>()).results;
  const perAccount=await Promise.all(targets.map(async t=>{
    const [counts,snapshot]=await Promise.all([sendAudienceCounts(db,t.line_account_id,await resolveHqBroadcastAudience(db,a.tenantId,t.line_account_id,input)),hqAudienceSnapshot(db,a.tenantId,t.line_account_id,input)]);
    if(counts.recipients!==snapshot.recipientCount)throw new StampError('対象が更新されました。もう一度確認してください',409);
    return {accountId:t.line_account_id,...counts,recipientToken:snapshot.recipientToken};
  }));
  const thresholds=await Promise.all(perAccount.map(p=>getBroadcastApprovalThreshold(db,{target_type:'all',line_account_id:p.accountId} as import('@line-crm/db').Broadcast)));
  return c.json({success:true,data:{recipients:perAccount.reduce((n,p)=>n+p.recipients,0),perAccount,
    excluded:{blocked:perAccount.reduce((n,p)=>n+p.excluded.blocked,0),optedOut:perAccount.reduce((n,p)=>n+p.excluded.optedOut,0),duplicate:0},
    purpose:'marketing',scheduledAt:run.scheduled_at,quietHoursShiftTo:null,firstText:(input.messageContent??'').slice(0,200),sender:null,expectedVersion:run.version,needsApproval:perAccount.reduce((n,p)=>n+p.recipients,0)>=Math.min(...thresholds)}});
});
hqBroadcasts.post('/api/hq/broadcasts/:id/preflight',inputJsonBoundary(), async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method));return c.json({success:true,data:await preflightHqBroadcast(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),true,mediaRuntime(c))});
});
hqBroadcasts.put('/api/hq/broadcasts/:id/exclusions',inputJsonBoundary({"accountIds":["array"],"expectedVersion":["number"]}), async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method)),b=await c.req.json<{accountIds:string[];expectedVersion:number}>();
  const run=await getHqBroadcastRun(db,a.tenantId,c.req.param('id'));await excludeHqBroadcastTargets(db,run,a.actorId,b.accountIds,b.expectedVersion);
  return c.json({success:true,data:await readHqBroadcastResult(db,await getHqBroadcastRun(db,a.tenantId,run.id))});
});
hqBroadcasts.post('/api/hq/broadcasts/:id/send',requireIrreversibleConfirmation('broadcast-send'),inputJsonBoundary({"expectedVersion":["number"],"confirmedRecipientCount":["number"],"confirmedAudiences":["array"]}), async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method)),b=await c.req.json<{expectedVersion:number;confirmedRecipientCount?:number;confirmedAudiences?:HqConfirmedAudience[]}>();
  if(!Number.isSafeInteger(b.expectedVersion))throw new StampError('版を確認してください', 400, ["expectedVersion"]);
  if(b.confirmedAudiences!==undefined&&(!Array.isArray(b.confirmedAudiences)||b.confirmedAudiences.some(item=>!item||typeof item.accountId!=='string'||!Number.isSafeInteger(item.recipientCount)||item.recipientCount<0||typeof item.recipientToken!=='string'||!/^[a-f0-9]{64}$/.test(item.recipientToken))||new Set(b.confirmedAudiences.map(item=>item.accountId)).size!==b.confirmedAudiences.length))throw new StampError('確認した送信先が正しくありません',400);
  return c.json({success:true,data:await dispatchHqBroadcast(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),a.actorId,b.expectedVersion,b.confirmedRecipientCount,mediaRuntime(c),b.confirmedAudiences)});
});
hqBroadcasts.post('/api/hq/broadcasts/:id/stop',inputJsonBoundary({"expectedVersion":["number"]}), async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method)),b=await c.req.json<{expectedVersion:number}>();
  return c.json({success:true,data:await stopHqBroadcast(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),a.actorId,false,b.expectedVersion)});
});
hqBroadcasts.post('/api/hq/broadcasts/:id/cancel',inputJsonBoundary({"expectedVersion":["number"]}), async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method)),b=await c.req.json<{expectedVersion:number}>();
  return c.json({success:true,data:await stopHqBroadcast(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),a.actorId,true,b.expectedVersion)});
});
hqBroadcasts.get('/api/hq/broadcasts/:id/reactions',async c=>{const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true);return c.json({success:true,data:await hqBroadcastReactions(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')))})});
for(const [suffix,followup] of [['duplicate',false],['followup',true]] as const)hqBroadcasts.post(`/api/hq/broadcasts/:id/${suffix}`,inputJsonBoundary({requestId:['string'],expectedVersion:['number'],title:['string']}),async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'));return c.json({success:true,data:await copyHqBroadcast(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),a.actorId,await c.req.json(),followup)},201);
});
hqBroadcasts.get('/api/hq/broadcasts/:id/targets/:accountId/retry-preview',async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'));
  return c.json({success:true,data:await previewHqRetry(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),c.req.param('accountId'))});
});
hqBroadcasts.post('/api/hq/broadcasts/:id/targets/:accountId/retry',requireIrreversibleConfirmation('broadcast-send'),inputJsonBoundary({"expectedVersion":["number"],"confirmedRecipientCount":["number"],"confirmedRecipientToken":["string"]}), async c=>{
  const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method)),b=await c.req.json<{expectedVersion:number;confirmedRecipientCount?:number;confirmedRecipientToken?:string}>();
  const hasConfirmation=b.confirmedRecipientCount!==undefined||b.confirmedRecipientToken!==undefined;
  if(hasConfirmation&&(!Number.isSafeInteger(b.confirmedRecipientCount)||b.confirmedRecipientCount!<0||typeof b.confirmedRecipientToken!=='string'||!/^([a-f0-9]{64})$/.test(b.confirmedRecipientToken)))throw new StampError('確認した人数と対象を指定してください',400);
  return c.json({success:true,data:await retryHqBroadcastTarget(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),c.req.param('accountId'),a.actorId,b.expectedVersion,hasConfirmation?{count:b.confirmedRecipientCount!,token:b.confirmedRecipientToken!}:undefined)});
});

hqBroadcasts.patch('/api/hq/broadcasts/:id',inputJsonBoundary({"title":["string"],"messageContent":["string"],"messageType":["string"],"messageBubbles":["array"],"messageBubblesJson":["null","string"],"altText":["null","string"],"targetType":["string"],"targetTagId":["null","string"],"segmentConditions":["null","object"],"excludedTagIds":["array"],"savedSearchId":["null","string"],"scheduledAt":["null","string"],"status":["string"],"lineAccountId":["null","string"],"accountIds":["array"],"dedupPriority":["array"],"trackLinks":["boolean"],"stealthSpreadMinutes":["number"],"folderId":["null","string"],"measureOpens":["boolean"],"saveAsDraft":["boolean"],"draftStep":["null","string"],"internalMemo":["null","string"],"messageOptions":["null","object"],"afterActionVersionIds":["object"],"afterActionVersionId":["null","string"],"confirmedRecipientCount":["number"],"requestId":["string"],"accountTagIds":["array"],"excludedAccountIds":["array"],"audience":["object"],"expectedVersion":["number"]}), async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),['GET','HEAD'].includes(c.req.method)),b=await c.req.json<HqBroadcastDraftInput>().catch(()=>null);
 if(!b||typeof b!=='object'||Array.isArray(b))throw new StampError('入力を確認してください');
 const {expectedVersion,...input}=b,run=await getHqBroadcastRun(db,a.tenantId,c.req.param('id'));
 return c.json({success:true,data:await readHqBroadcastResult(db,await prepareHqBroadcast(db,a.tenantId,a.actorId,input,{run,expectedVersion}))});
});

function pagination(c:{req:{query(k:string):string|undefined}}) {
 const offset=listQueryNumber(c.req.query('cursor'), 0),limit=listQueryNumber(c.req.query('limit'), 50);
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new StampError('件数を確認してください');
 return {offset,limit};
}
hqBroadcasts.get('/api/hq/broadcasts/:id/approval',async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true);
 return c.json({success:true,data:await hqBroadcastApprovalState(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),a.actorId)});
});
for(const [suffix,action] of [['approval-request','request'],['approve','approve'],['reject','reject'],['approval-cancel','cancel']] as const)
 hqBroadcasts.post(`/api/hq/broadcasts/:id/${suffix}`,async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'));
 if(action==='approve'){const state=await hqBroadcastApprovalState(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),a.actorId);
   if(!state.viewer.canApprove)throw new StampError('承認を頼まれた別の担当者だけ決められます',403);
   if(!await sensitiveStepUpSatisfied(c,'broadcast.approval'))return stepUpRequiredResponse(c,'配信の承認には本人確認が必要です');}
 return c.json({success:true,data:await updateHqApproval(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),a.actorId,action,await c.req.json())});
});
hqBroadcasts.post('/api/hq/broadcasts/:id/test-send',inputJsonBoundary({"accountId":["string"],"expectedRecipientToken":["string"]}), async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff')),b=await c.req.json<{accountId:string;expectedRecipientToken?:string}>();
 if(b.expectedRecipientToken!==undefined&&!/^[a-f0-9]{64}$/.test(b.expectedRecipientToken))throw new StampError('テスト宛先の確認が正しくありません',400);
 return c.json({success:true,data:await testHqBroadcast(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),a.actorId,b.accountId,mediaRuntime(c),b.expectedRecipientToken)});
});
hqBroadcasts.get('/api/hq/broadcasts/:id/targets/:accountId/recipients',async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true),p=pagination(c);
 return c.json({success:true,data:await hqBroadcastRecipients(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),c.req.param('accountId'),p.offset,p.limit)});
});
hqBroadcasts.get('/api/hq/broadcasts/:id/activity',async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true),p=pagination(c);
 return c.json({success:true,data:await hqBroadcastActivity(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')),p.offset,p.limit)});
});
hqBroadcasts.get('/api/hq/broadcasts/:id/export.csv',async c=>{
 const db=dbFor(c.env),a=await hqBroadcastAuthority(db,c.get('staff'),true),run=await readHqBroadcastResult(db,await getHqBroadcastRun(db,a.tenantId,c.req.param('id')));
 c.set('outputAudit', { count: run.targets.length, accountIds: run.targets.map(t => t.accountId), accountCounts: Object.fromEntries(run.targets.map(t => [t.accountId, 1])), targetId: c.req.param('id') });
 const cell=(v:unknown)=>{let s=v==null?'':String(v);if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};
 const lines=[['アカウント','状態','送った数','開いた数','押した数','反応した人数'],...run.targets.map(t=>[t.accountName,t.status,t.successCount,t.openedCount,t.clickedCount,t.reactionCount])];
 return new Response('\uFEFF'+lines.map(r=>r.map(cell).join(',')).join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="hq-broadcast.csv"','Cache-Control':'no-store'}});
});
