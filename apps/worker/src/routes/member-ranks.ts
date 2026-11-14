import {resolveAccountIdFromLiff,verifyCallerLineUserId,resolveFriendId} from './booking.js';
import {requirePermission} from '../middleware/role-guard.js';
import {Hono} from 'hono';
import type { Env } from '../worker-env.js';
import {GapError,gapAccount,gapBody,gapVersion,gapWrite,gapKey} from '../services/gap-common.js';
import {rankProgram,rankPreview,rankEvaluationStatements,type RankTier,processRankNotices} from '../services/member-ranks.js';
import {assertChanged,clearAssertions} from '../features/booking/booking-series/index.js';
export const memberRanks=new Hono<Env>();
memberRanks.use('/api/member-ranks*',requirePermission('/mileage'));
memberRanks.onError((e,c)=>c.json({success:false,error:e instanceof GapError?e.code:'ranks_unavailable'},e instanceof GapError?e.status:503));
memberRanks.get('/api/member-ranks/program',async c=>{const a=await gapAccount(c);return c.json({success:true,data:await rankProgram(c.env.DB,a)});});
memberRanks.put('/api/member-ranks/program',async c=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c),v=gapVersion(b.expectedVersion);if(!['visits','amount','miles'].includes(String(b.metric))||!Number.isInteger(b.windowMonths)||Number(b.windowMonths)<1||Number(b.windowMonths)>36)throw new GapError('invalid_program');
 // 変更後の初期割当をオーナーが確認できるよう、更新時はプログラムを停止へ戻す。
 if((b.notifyUpgrade!==undefined&&typeof b.notifyUpgrade!=='boolean')||(b.notifyDowngrade!==undefined&&typeof b.notifyDowngrade!=='boolean'))throw new GapError('invalid_notification');
 const current=await rankProgram(c.env.DB,a);
 const r=await c.env.DB.prepare(`INSERT INTO member_rank_programs(account_id,metric,window_months,updated_at,notify_upgrade,notify_downgrade) SELECT ?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM member_rank_programs WHERE account_id=? AND version=?) ON CONFLICT(account_id) DO UPDATE SET metric=excluded.metric,window_months=excluded.window_months,status='stopped',version=version+1,updated_at=excluded.updated_at,notify_upgrade=excluded.notify_upgrade,notify_downgrade=excluded.notify_downgrade WHERE version=?`).bind(a,b.metric,b.windowMonths,new Date().toISOString(),b.notifyUpgrade??current.notifyUpgrade,b.notifyDowngrade??current.notifyDowngrade,v,a,v,v).run();if(!r.meta.changes)throw new GapError('version_conflict',409);return c.json({success:true,data:await rankProgram(c.env.DB,a)});
});
memberRanks.put('/api/member-ranks/tiers',async c=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c),v=gapVersion(b.expectedVersion),tiers=b.tiers as RankTier[];
 if(!Array.isArray(tiers)||tiers.length<2||tiers.length>5||new Set(tiers.map(t=>t?.id)).size!==tiers.length||tiers.some((t,i)=>!t||typeof t.id!=='string'||t.id.length>100||typeof t.name!=='string'||!t.name.trim()||t.name.length>30||!Number.isSafeInteger(t.threshold)||t.threshold<0||(i===0?t.threshold!==0:t.threshold<=tiers[i-1].threshold)||typeof t.mileMultiplier!=='number'||t.mileMultiplier<1||t.mileMultiplier>3))throw new GapError('invalid_tiers');
 for(const t of tiers){if(t.benefitDescriptions!==undefined&&(!Array.isArray(t.benefitDescriptions)||t.benefitDescriptions.length>10||t.benefitDescriptions.some(x=>typeof x!=='string'||!x.trim()||x.length>200)))throw new GapError('invalid_benefits');if(t.couponCode!==undefined&&t.couponCode!==null&&(typeof t.couponCode!=='string'||t.couponCode.length>100))throw new GapError('invalid_coupon');for(const messages of [t.upgradeMessages,t.downgradeMessages])if(messages!==undefined&&(!Array.isArray(messages)||messages.length>5||messages.some(m=>m?.type!=='text'||typeof m.text!=='string'||!m.text.trim()||m.text.length>2000)))throw new GapError('invalid_messages');}
 // 退役した段階と履歴を残し、別店舗の ID を再利用しない。
 for(const t of tiers){const old=await c.env.DB.prepare('SELECT account_id FROM member_rank_tiers WHERE id=?').bind(t.id).first<{account_id:string}>();if(old&&old.account_id!==a)throw new GapError('invalid_tier_id');}
 const ops=[c.env.DB.prepare("UPDATE member_rank_programs SET version=version+1,status='stopped',updated_at=? WHERE account_id=? AND version=?").bind(new Date().toISOString(),a,v),assertChanged(c.env.DB),c.env.DB.prepare('UPDATE member_rank_tiers SET sort=-sort-1 WHERE account_id=? AND sort>=0').bind(a)];
 for(const [i,t]of tiers.entries()){
 const old=await c.env.DB.prepare('SELECT tag_id FROM member_rank_tiers WHERE id=? AND account_id=?').bind(t.id,a).first<{tag_id:string}>(),tag=old?.tag_id??crypto.randomUUID();
 if(!old)ops.push(c.env.DB.prepare("INSERT INTO tags(id,name,line_account_id,manual_assignment_allowed) VALUES(?,?,?,0)").bind(tag,'ランク：'+t.name,a));
 else ops.push(c.env.DB.prepare('UPDATE tags SET name=?,manual_assignment_allowed=0 WHERE id=? AND line_account_id=?').bind('ランク：'+t.name,tag,a));
 ops.push(c.env.DB.prepare('INSERT INTO member_rank_tiers(id,account_id,sort,name,threshold,mile_multiplier,tag_id,coupon_code,upgrade_message_json,downgrade_message_json,benefit_descriptions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sort=excluded.sort,name=excluded.name,threshold=excluded.threshold,mile_multiplier=excluded.mile_multiplier,coupon_code=excluded.coupon_code,upgrade_message_json=excluded.upgrade_message_json,downgrade_message_json=excluded.downgrade_message_json,benefit_descriptions_json=excluded.benefit_descriptions_json').bind(t.id,a,i,t.name,t.threshold,t.mileMultiplier,tag,t.couponCode??null,JSON.stringify(t.upgradeMessages??[]),JSON.stringify(t.downgradeMessages??[]),JSON.stringify(t.benefitDescriptions??[])));
 }
 ops.push(clearAssertions(c.env.DB));try{await c.env.DB.batch(ops);}catch(e){if(/CHECK constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;}
 return c.json({success:true,data:await rankProgram(c.env.DB,a)});
});
memberRanks.post('/api/member-ranks/preview',async c=>{const a=await gapAccount(c),p=await rankPreview(c.env.DB,a);return c.json({success:true,data:{byTier:p.byTier,wouldUpgrade:p.wouldUpgrade,wouldDowngrade:p.wouldDowngrade}});});
for(const action of ['activate','stop']as const)memberRanks.post(`/api/member-ranks/${action}`,async c=>{
 gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c),v=gapVersion(b.expectedVersion),key=action==='activate'?gapKey(c):null,request=JSON.stringify({action,expectedVersion:v});
 if(key){const old=await c.env.DB.prepare('SELECT request_json,response_json FROM member_rank_mutations WHERE account_id=? AND request_key=?').bind(a,key).first<{request_json:string;response_json:string}>();if(old){if(old.request_json!==request)throw new GapError('idempotency_conflict',409);return c.json({success:true,data:JSON.parse(old.response_json)});}}
 const program=await rankProgram(c.env.DB,a),now=new Date();
 if(program.version!==v)throw new GapError('version_conflict',409);
 const evaluations=action==='activate'?await rankEvaluationStatements(c.env.DB,a,program,true,now):[];
 const data={...program,status:action==='activate'?'active':'stopped',version:v+1,activatedAt:action==='activate'?now.toISOString():program.activatedAt};
 const ops=[c.env.DB.prepare('UPDATE member_rank_programs SET status=?,version=version+1,activated_at=? WHERE account_id=? AND version=?').bind(data.status,data.activatedAt,a,v),assertChanged(c.env.DB),...evaluations];
 if(key)ops.push(c.env.DB.prepare('INSERT INTO member_rank_mutations(account_id,request_key,request_json,response_json) VALUES(?,?,?,?)').bind(a,key,request,JSON.stringify(data)));
 ops.push(clearAssertions(c.env.DB));
 try{await c.env.DB.batch(ops);}catch(e){
  if(key){const old=await c.env.DB.prepare('SELECT request_json,response_json FROM member_rank_mutations WHERE account_id=? AND request_key=?').bind(a,key).first<{request_json:string;response_json:string}>();if(old?.request_json===request)return c.json({success:true,data:JSON.parse(old.response_json)});}
  if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;
 }
 return c.json({success:true,data});
});
memberRanks.get('/api/friends/:id/member-rank',requirePermission('/mileage'),async c=>{
 const a=await gapAccount(c),id=c.req.param('id');if(!await c.env.DB.prepare('SELECT id FROM friends WHERE id=? AND line_account_id=?').bind(id,a).first())throw new GapError('not_found',404);
 const current=await c.env.DB.prepare('SELECT r.*,t.name,t.threshold,t.mile_multiplier FROM member_ranks r JOIN member_rank_tiers t ON t.id=r.tier_id WHERE r.account_id=? AND r.friend_id=?').bind(a,id).first();
 const history=(await c.env.DB.prepare(`SELECT h.id,h.account_id,h.friend_id,h.from_tier_id,h.to_tier_id,h.reason,
 CASE WHEN EXISTS(SELECT 1 FROM member_rank_notices n JOIN outbound_send_requests o ON o.resource_id='rank-notice:'||n.id AND o.line_account_id=n.account_id AND o.channel='line' AND o.status='succeeded'
 WHERE n.account_id=h.account_id AND n.friend_id=h.friend_id AND n.kind='upgrade' AND n.change_key=h.at||':'||h.to_tier_id) THEN 1 ELSE h.notified END notified,h.at
 FROM member_rank_history h WHERE h.account_id=? AND h.friend_id=? ORDER BY h.at DESC LIMIT 20`).bind(a,id).all()).results;
 return c.json({success:true,data:{current,history}});
});

memberRanks.get('/api/liff/member-card',async c=>{
 const a=await resolveAccountIdFromLiff(c),u=await verifyCallerLineUserId(c);if(!a||!u)throw new GapError('unauthorized',401);const f=await resolveFriendId(c,u,a);if(!f)throw new GapError('not_found',404);
 const p=await rankProgram(c.env.DB,a);const row=await c.env.DB.prepare('SELECT r.tier_id,r.since,r.downgrade_due_at,t.name,t.threshold,t.mile_multiplier FROM member_ranks r JOIN member_rank_tiers t ON t.id=r.tier_id AND t.account_id=r.account_id WHERE r.account_id=? AND r.friend_id=?').bind(a,f).first<{tier_id:string;name:string;threshold:number;downgrade_due_at:string|null;since:string}>();
 if(!row||p.status!=='active')return c.json({success:true,data:null});
 const decision=(await rankPreview(c.env.DB,a,p)).decisions.find(d=>d.id===f),next=p.tiers.find(t=>t.threshold>row.threshold);
 const tier=p.tiers.find(t=>t.id===row.tier_id),identity=await c.env.DB.prepare('SELECT member_number FROM friends WHERE id=? AND line_account_id=?').bind(f,a).first<{member_number:string}>();
 const benefitDetails={couponCode:tier?.couponCode??null,mileMultiplier:tier?.mileMultiplier??1,tagId:tier?.tagId};
 const benefits=tier?.benefitDescriptions?.length?tier.benefitDescriptions:[...(benefitDetails.couponCode?[`特典クーポン：${benefitDetails.couponCode}`]:[]),...(benefitDetails.mileMultiplier>1?[`マイル${benefitDetails.mileMultiplier}倍`]:[])];
 return c.json({success:true,data:{memberNumber:identity!.member_number,name:row.name,benefits,benefitDetails,since:row.since,downgradeDueAt:row.downgrade_due_at,next:next?{name:next.name,remaining:Math.max(0,next.threshold-(decision?.score??0)),metric:p.metric,progress:Math.max(0,Math.min(1,((decision?.score??0)-row.threshold)/(next.threshold-row.threshold)))}:null}});
});

memberRanks.get('/api/member-ranks/notices',async c=>{const a=await gapAccount(c);const items=(await c.env.DB.prepare(`SELECT n.id,n.kind,n.purpose,n.scheduled_at scheduledAt,
 CASE WHEN o.status='succeeded' THEN 'sent' WHEN o.status='unknown' THEN 'delivery_unknown'
 WHEN o.status='failed' AND o.failure_code='NOTIFICATION_PRECONDITION_CHANGED' THEN 'delivery_blocked' WHEN o.status='failed' THEN 'delivery_failed' WHEN o.status='in_progress' AND o.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'delivery_unknown' WHEN o.status='in_progress' THEN 'sending' ELSE n.status END status,
 COALESCE(o.completed_at,n.processed_at) processedAt,CASE WHEN o.idempotency_key IS NULL THEN n.test_mode ELSE 0 END testMode
 FROM member_rank_notices n LEFT JOIN outbound_send_requests o ON o.resource_id='rank-notice:'||n.id AND o.line_account_id=n.account_id AND o.channel='line'
 WHERE n.account_id=? ORDER BY n.scheduled_at DESC,n.id LIMIT 100`).bind(a).all()).results;return c.json({success:true,data:{items}});});
memberRanks.post('/api/member-ranks/notices/simulate',async c=>{gapWrite(c,{admin:true});const a=await gapAccount(c),b=await gapBody(c);if(b.testMode!==true)throw new GapError('test_mode_required');return c.json({success:true,data:await processRankNotices(c.env.DB,new Date(),a)});});
