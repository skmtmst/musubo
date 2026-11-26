import {DELIVERY_CONSENT_ALLOWED_SQL} from '@line-crm/db/src/friend-delivery-consents.js';
import {buildSegmentWhere} from '../../services/segment-query.js';
import {GapError} from '../../services/gap-common.js';
import {assertChanged,clearAssertions} from '../booking/booking-series/index.js';
import {broadcastQuietHoursShift} from '../../services/gap-send-preview.js';
import {createFeatureJobGate} from '../../services/feature-enforcement.js';
export interface AbSettings{test_ratio_pct:number;metric:'click';decide_after_minutes:number;undecided_policy:'stop'|'send_a'}
export function abSettings(b:Record<string,unknown>):AbSettings {
 if(![10,20,30,50].includes(Number(b.testRatioPct))||![60,120,240,480,1440].includes(Number(b.decideAfterMinutes))||b.metric!=='click'||!['stop','send_a'].includes(String(b.undecidedPolicy)))throw new GapError('invalid_ab_settings');
 return {test_ratio_pct:Number(b.testRatioPct),metric:'click',decide_after_minutes:Number(b.decideAfterMinutes),undecided_policy:b.undecidedPolicy as 'stop'|'send_a'};
}
export async function abAudience(db:D1Database,id:string){
 const b=await db.prepare('SELECT * FROM broadcasts WHERE id=?').bind(id).first<{target_type:string;target_tag_id:string;line_account_id:string;segment_conditions:string|null;hq_run_id:string|null}>();
 if(!b||!['tag','segment'].includes(b.target_type)||b.hq_run_id)throw new GapError('AB_NOT_SUPPORTED_FOR_BROADCAST_ALL');
 if(b.target_type==='segment'&&!b.segment_conditions)throw new GapError('AB_SEGMENT_REQUIRED');
 const seg=b.target_type==='segment'?buildSegmentWhere(JSON.parse(b.segment_conditions!)):null;
 const condition=seg?`AND (${seg.sql})`:'AND EXISTS(SELECT 1 FROM friend_tags ft WHERE ft.friend_id=f.id AND ft.tag_id=?)';
 const rows=(await db.prepare(`SELECT f.id FROM friends f WHERE f.line_account_id=? AND f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND COALESCE(f.line_platform_user_id,'')!='' AND ${DELIVERY_CONSENT_ALLOWED_SQL} ${condition} ORDER BY f.id`).bind(b.line_account_id,...(seg?seg.bindings:[b.target_tag_id])).all<{id:string}>()).results;
 return {account:b.line_account_id,ids:rows.map(x=>x.id)};
}
export function splitAb(ids:string[],ratio:number,random=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296){
 const list=[...new Set(ids)];for(let i=list.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[list[i],list[j]]=[list[j],list[i]];}
 const n=ratio===50?Math.floor(list.length/2):Math.floor(list.length*ratio/200);
 if(n<200)throw new GapError('AB_AUDIENCE_TOO_SMALL');
 return list.map((id,i)=>({id,key:(i<n?'A':i<(ratio===50?list.length:2*n)?'B':'R') as 'A'|'B'|'R'}));
}
export function abWinner(a:{sent:number;clicks:number},b:{sent:number;clicks:number}){
 if(a.sent<50||b.sent<50)return {winner:null,confidence:0,reason:'delivery_too_small'};
 const pa=a.clicks/a.sent,pb=b.clicks/b.sent,p=(a.clicks+b.clicks)/(a.sent+b.sent),se=Math.sqrt(p*(1-p)*(1/a.sent+1/b.sent)),z=se?Math.abs(pa-pb)/se:0;
 const winner=Math.abs(pa-pb)>=.01&&z>=1.959964?(pa>pb?'A':'B'):null;
 return {winner,confidence:z>=2.576?.99:z>=1.959964?.95:0,reason:winner?'winner':'undecided'};
}
export async function abStats(db:D1Database,id:string,until=new Date().toISOString()){
 const rows=(await db.prepare(`SELECT r.variant_key key,SUM(r.state='sent') sent,SUM(r.state='failed') failed,
 COUNT(DISTINCT CASE WHEN lc.id IS NOT NULL THEN r.friend_id END) clicks
 FROM broadcast_ab_recipients r LEFT JOIN broadcast_tracked_links bl ON bl.broadcast_id=r.broadcast_id
 LEFT JOIN link_clicks lc ON lc.tracked_link_id=bl.tracked_link_id AND lc.friend_id=r.friend_id AND julianday(lc.clicked_at)>=julianday(r.sent_at) AND julianday(lc.clicked_at)<=julianday(?)
 WHERE r.broadcast_id=? AND r.variant_key IN('A','B') GROUP BY r.variant_key`).bind(until,id).all<{key:'A'|'B';sent:number;failed:number;clicks:number}>()).results;
 // 同じ受信者が複数リンクを押せるため、配信数の分母はクリック数と別に数える。
 const denominators=(await db.prepare("SELECT variant_key key,SUM(state='sent') sent,SUM(state='failed') failed FROM broadcast_ab_recipients WHERE broadcast_id=? AND variant_key IN('A','B') GROUP BY variant_key").bind(id).all<{key:string;sent:number;failed:number}>()).results;
 return ['A','B'].map(key=>{const click=rows.find(x=>x.key===key)?.clicks??0,d=denominators.find(x=>x.key===key);return {key,sent:d?.sent??0,failed:d?.failed??0,clicks:click,clickRate:d?.sent?click/d.sent:null,bookings:null,purchases:null,purchaseAmount:null};});
}
export async function startAbMock(db:D1Database,id:string,expectedVersion:number,count:number,key:string){
 const t=await db.prepare('SELECT * FROM broadcast_ab_tests WHERE broadcast_id=?').bind(id).first<AbSettings&{status:string;version:number;start_key:string|null;start_request_json:string|null;start_result_json:string|null}>();if(!t)throw new GapError('ab_not_found',404);
 const request=JSON.stringify({expectedVersion,count});
 if(t.start_key===key){if(t.start_request_json!==request||!t.start_result_json)throw new GapError('idempotency_conflict',409);return JSON.parse(t.start_result_json);}
 if(t.status!=='draft')throw new GapError('ab_already_started',409);
 const {ids}=await abAudience(db,id);if(ids.length!==count)throw new GapError('SEND_PREVIEW_CHANGED',409);const rows=splitAb(ids,t.test_ratio_pct),now=new Date().toISOString(),decide=new Date(Date.now()+t.decide_after_minutes*60000).toISOString();
 const result={status:'testing',decideAt:decide,counts:{A:rows.filter(x=>x.key==='A').length,B:rows.filter(x=>x.key==='B').length,R:rows.filter(x=>x.key==='R').length},testMode:true};
 const statements=[db.prepare("UPDATE broadcasts SET lock_version=lock_version+1 WHERE id=? AND status='draft' AND stopped_at IS NULL AND lock_version=?").bind(id,expectedVersion),assertChanged(db),db.prepare("UPDATE broadcast_ab_tests SET status='testing',started_at=?,decide_at=?,version=version+1,start_key=?,start_request_json=?,start_result_json=? WHERE broadcast_id=? AND status='draft' AND version=?").bind(now,decide,key,request,JSON.stringify(result),id,t.version),assertChanged(db)];
 if((await db.prepare('SELECT COUNT(*) n FROM broadcast_variants WHERE broadcast_id=?').bind(id).first<{n:number}>())?.n!==2)throw new GapError('two_variants_required');
 // 模擬だけ。送達台帳には本物と混ぜずtest_modeを固定する。LINE/Stripeには通信しない。
 for(let i=0;i<rows.length;i+=100){const chunk=rows.slice(i,i+100);statements.push(db.prepare(`INSERT INTO broadcast_ab_recipients(broadcast_id,friend_id,variant_key,state,sent_at) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.key'),CASE WHEN json_extract(value,'$.key')='R' THEN 'pending' ELSE 'sent' END,CASE WHEN json_extract(value,'$.key')='R' THEN NULL ELSE ? END FROM json_each(?)`).bind(id,now,JSON.stringify(chunk)));}
 statements.push(clearAssertions(db));try{await db.batch(statements);}catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw new GapError('version_conflict',409);throw e;}
 return result;
}
export async function decideAbTests(db:D1Database,now=new Date()){
 const gate=createFeatureJobGate();
 const tests=(await db.prepare("SELECT t.*,b.line_account_id FROM broadcast_ab_tests t JOIN broadcasts b ON b.id=t.broadcast_id WHERE t.status IN('testing','undecided','decided') AND b.stopped_at IS NULL AND t.test_mode=1 LIMIT 100").all<AbSettings&{broadcast_id:string;status:string;version:number;decide_at:string;decided_at:string|null;remainder_scheduled_at:string|null;line_account_id:string}>()).results;
 for(const t of tests){
  if(!await gate.canRun(db,t.line_account_id,'broadcasts','AB test decisions (test transport)'))continue;
  if(t.status==='undecided'){if(t.decided_at&&Date.parse(t.decided_at)+86400000<=now.getTime())await db.prepare("UPDATE broadcast_ab_tests SET status='expired',version=version+1 WHERE broadcast_id=? AND status='undecided' AND version=?").bind(t.broadcast_id,t.version).run();continue;}
  if(t.status==='decided'){
   if(t.remainder_scheduled_at&&Date.parse(t.remainder_scheduled_at)>now.getTime())continue;
   await finishMockRemainder(db,t.broadcast_id,now);continue;
  }
  if(Date.parse(t.decide_at)>now.getTime())continue;
  const stats=await abStats(db,t.broadcast_id,t.decide_at),result=abWinner(stats[0],stats[1]),winner=result.winner??(t.undecided_policy==='send_a'&&result.reason!=='delivery_too_small'?'A':null),shift=winner?await broadcastQuietHoursShift(db,t.line_account_id,now.toISOString()):null;
  const changed=await db.prepare("UPDATE broadcast_ab_tests SET status=?,winner=?,decided_at=?,decided_by='auto',remainder_scheduled_at=?,stats_json=?,version=version+1 WHERE broadcast_id=? AND status='testing' AND version=?").bind(winner?'decided':'undecided',winner,now.toISOString(),winner?(shift??now.toISOString()):null,JSON.stringify({variants:stats,...result}),t.broadcast_id,t.version).run();
  if(changed.meta.changes&&!winner)await db.prepare("INSERT INTO notifications(id,event_type,title,body,channel,status,line_account_id,category) VALUES(?,'broadcast_ab_undecided','A/Bの勝ちを決められません','配信の結果から、残りの人へ送る案を選んでください','dashboard','sent',?,'info')").bind(crypto.randomUUID(),t.line_account_id).run();
  if(changed.meta.changes&&winner&&!shift)await finishMockRemainder(db,t.broadcast_id,now);
 }
}
export async function finishMockRemainder(db:D1Database,id:string,now=new Date()){
 const rs=await db.batch([db.prepare("UPDATE broadcast_ab_tests SET status='finished',remainder_sent_at=?,version=version+1 WHERE broadcast_id=? AND status='decided' AND julianday(remainder_scheduled_at)<=julianday(?) AND EXISTS(SELECT 1 FROM broadcasts WHERE id=? AND stopped_at IS NULL)").bind(now.toISOString(),id,now.toISOString(),id),db.prepare("UPDATE broadcast_ab_recipients SET state='sent',sent_at=? WHERE broadcast_id=? AND variant_key='R' AND state='pending' AND changes()=1").bind(now.toISOString(),id)]);return !!rs[0].meta.changes;
}
