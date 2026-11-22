import {abWinner} from './broadcast-ab.js';
import {broadcastQuietHoursShift} from '../../services/gap-send-preview.js';
import {createFeatureJobGate} from '../../services/feature-enforcement.js';

type VariantStats={key:'A'|'B';sent:number;failed:number;unknown:number;clicks:number};
/** 数字は受理を確認した宛先だけから集計する。匿名クリックは案に割り当てない。 */
export async function liveAbStats(db:D1Database,id:string,until:string):Promise<VariantStats[]>{
 const rows=(await db.prepare(`SELECT r.variant_key AS key,
  SUM(r.state='sent') AS sent,SUM(r.state='failed') AS failed,SUM(r.state='unknown') AS unknown,
  SUM(CASE WHEN r.state='sent' AND EXISTS(SELECT 1 FROM tracked_links l JOIN link_clicks c ON c.tracked_link_id=l.id JOIN broadcasts b ON b.id=r.broadcast_id
   WHERE substr(l.dedup_key,1,length(b.line_account_id||'|ab-live:'||r.broadcast_id||':'||r.variant_key||'|'))=b.line_account_id||'|ab-live:'||r.broadcast_id||':'||r.variant_key||'|' AND c.friend_id=r.friend_id AND julianday(c.clicked_at)>=julianday(r.sent_at)
    AND julianday(c.clicked_at)<=julianday(?)) THEN 1 ELSE 0 END) AS clicks
  FROM broadcast_ab_live_recipients r WHERE r.broadcast_id=? AND r.variant_key IN ('A','B') GROUP BY r.variant_key`).bind(until,id).all<VariantStats>()).results;
 return (['A','B'] as const).map(key=>rows.find(row=>row.key===key)??{key,sent:0,failed:0,unknown:0,clicks:0});
}

/** 本番・旗オフの呼び出し元からは実行しない。判定と通知は条件付き更新で一度だけ行う。 */
export async function decideAbLiveTests(db:D1Database,now=new Date()){
 const gate=createFeatureJobGate(),at=now.toISOString();
 const tests=(await db.prepare(`SELECT t.broadcast_id,t.status,t.version,t.decide_at,t.decided_at,t.undecided_policy,b.line_account_id
  FROM broadcast_ab_live_tests t JOIN broadcasts b ON b.id=t.broadcast_id
  WHERE t.status IN ('live_testing','live_undecided') AND b.stopped_at IS NULL AND t.start_result_json IS NOT NULL LIMIT 100`)
  .all<{broadcast_id:string;status:string;version:number;decide_at:string;decided_at:string|null;undecided_policy:string;line_account_id:string}>()).results;
 for(const t of tests){
  if(!await gate.canRun(db,t.line_account_id,'broadcasts','AB test decisions (test transport)'))continue;
  if(t.status==='live_undecided'){
   if(t.decided_at&&Date.parse(t.decided_at)+86400000<=now.getTime())await db.prepare("UPDATE broadcast_ab_live_tests SET status='live_expired',version=version+1 WHERE broadcast_id=? AND status='live_undecided' AND version=?").bind(t.broadcast_id,t.version).run();
   continue;
  }
  if(!Number.isFinite(Date.parse(t.decide_at))||Date.parse(t.decide_at)>now.getTime())continue;
  const variants=await liveAbStats(db,t.broadcast_id,t.decide_at);
  const calculation=abWinner(variants[0],variants[1]);
  // 計測リンクが無い場合はクリック0と断定せず、勝者を出さない。
  const a=`${t.line_account_id}|ab-live:${t.broadcast_id}:A|`,b=`${t.line_account_id}|ab-live:${t.broadcast_id}:B|`;
  const tracked=await db.prepare("SELECT COUNT(DISTINCT CASE WHEN substr(dedup_key,1,length(?))=? THEN 'A' WHEN substr(dedup_key,1,length(?))=? THEN 'B' END) n FROM tracked_links").bind(a,a,b,b).first<{n:number}>();
  const reason=calculation.reason==='delivery_too_small'?'delivery_too_small':tracked?.n!==2?'tracking_unavailable':calculation.reason;
  const winner=reason==='winner'?calculation.winner:reason==='undecided'&&t.undecided_policy==='send_a'?'A':null;
  const shift=winner?await broadcastQuietHoursShift(db,t.line_account_id,at):null;
  const update=db.prepare(`UPDATE broadcast_ab_live_tests SET status=?,winner=?,decided_at=?,decided_by='auto',remainder_scheduled_at=?,stats_json=?,version=version+1
   WHERE broadcast_id=? AND status='live_testing' AND version=? AND start_result_json IS NOT NULL
   AND EXISTS(SELECT 1 FROM broadcasts b WHERE b.id=? AND b.stopped_at IS NULL)`)
   .bind(winner?'live_decided':'live_undecided',winner,at,winner?(shift??at):null,JSON.stringify({variants,confidence:calculation.confidence,reason}),t.broadcast_id,t.version,t.broadcast_id);
  if(winner)await update.run();
  else await db.batch([update,db.prepare("INSERT INTO notifications(id,event_type,title,body,channel,status,line_account_id,category) SELECT ?,'broadcast_ab_undecided','A/Bの勝ちを決められません',?,'dashboard','sent',?,'info' WHERE changes()=1")
   .bind(crypto.randomUUID(),reason==='delivery_too_small'?'人数が足りないため決められません。':reason==='tracking_unavailable'?'クリックを計測できないため決められません。':'配信の結果から、残りの人へ送る案を選んでください。',t.line_account_id)]);
 }
}
