import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createTestD1,type SqliteD1} from '../test-utils/d1-sqlite.js';
import type {HqBroadcastInput} from '@line-crm/shared';
import {prepareHqBroadcast,getHqBroadcastRun,preflightHqBroadcast,dispatchHqBroadcast,excludeHqBroadcastTargets,stopHqBroadcast,retryHqBroadcastTarget,hqBroadcastAuthority} from './hq-broadcasts.js';
vi.mock('./feature-enforcement.js',()=>({featureJobCanRun:vi.fn(async()=>true)}));
const tenant='00000000-0000-4000-8000-000000000001';let f:SqliteD1;
const input:HqBroadcastInput={requestId:'run-1',title:'お知らせ',messageType:'text',messageContent:'{{account.name}}のお知らせ',accountIds:['shop1','shop2'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'all'},scheduledAt:null};
beforeEach(()=>{f=createTestD1();for(const id of ['shop1','shop2']){f.raw.prepare('INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id) VALUES(?,?,?,\'unused\',?,?)').run(id,id,id,'token-'+id,tenant);f.raw.prepare('INSERT INTO friends(id,line_user_id,line_account_id) VALUES(?,?,?)').run('friend-'+id,'U-'+id,id);}
 f.raw.prepare('INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES(\'owner\',\'管理者\',\'owner\',\'unused\',?)').run(tenant);
 vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{const two=new Headers(init.headers).get('Authorization')?.includes('shop2');return new Response(JSON.stringify(url.endsWith('consumption')?{totalUsage:two?10:0}:{type:'limited',value:two?10:100}),{status:200});}));
});
afterEach(()=>{f.raw.close();vi.unstubAllGlobals();});
describe('統括の一括配信',()=>{
 it('詳細の読み直しでは宛先をハッシュせず、確認窓の取得時だけ作る',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.prepare("UPDATE broadcasts SET status='sent' WHERE id=?").run(child);
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'friend-shop1','failed','line_http_429')").run(child);
  const digest=vi.spyOn(crypto.subtle,'digest');const {readHqBroadcastResult,previewHqRetry}=await import('./hq-broadcasts.js');
  const run=await getHqBroadcastRun(f.db,tenant,r.id);
  expect((await readHqBroadcastResult(f.db,run)).targets[0].retryableCount).toBe(1);expect(digest).not.toHaveBeenCalled();
  expect((await previewHqRetry(f.db,run,'shop1')).count).toBe(1);expect(digest).toHaveBeenCalledTimes(1);digest.mockRestore();
 });
 it('停止直後の未送信台帳も再送可能人数に含め、送信途中の台帳は含めない',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('pending','U-pending','shop1'),('inflight','U-inflight','shop1')");
  f.raw.prepare("UPDATE broadcasts SET status='sending',stopped_at=datetime('now') WHERE id=?").run(child);
  const put=f.raw.prepare('INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code,dispatched_at) VALUES(?,?,?,?,?)');
  put.run(child,'friend-shop1','failed','line_http_429',null);put.run(child,'pending','claimed',null,null);put.run(child,'inflight','claimed',null,'2026-01-01');
  const {readHqBroadcastResult}=await import('./hq-broadcasts.js');
  expect((await readHqBroadcastResult(f.db,await getHqBroadcastRun(f.db,tenant,r.id))).targets[0].retryableCount).toBe(2);
 });
 it('停止前の処理が残っていても版を更新して再送できる',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.prepare("UPDATE broadcasts SET status='sending',stopped_at=datetime('now'),batch_offset=-1 WHERE id=?").run(child);
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'friend-shop1','failed','stopped_before_dispatch')").run(child);
  await retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1','owner',1);
  expect(f.raw.prepare('SELECT stopped_at,batch_offset,lock_version FROM broadcasts WHERE id=?').get(child)).toEqual({stopped_at:null,batch_offset:0,lock_version:2});
 });
 it('人数が同じでも再送対象が変わったら409で止める',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('another','U-another','shop1')");
  f.raw.prepare("UPDATE broadcasts SET status='sent' WHERE id=?").run(child);
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'friend-shop1','failed','line_http_429')").run(child);
  const {previewHqRetry}=await import('./hq-broadcasts.js');
  const preview=await previewHqRetry(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1');
  f.raw.prepare("UPDATE broadcast_send_claims SET friend_id='another' WHERE broadcast_id=?").run(child);
  await expect(retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1','owner',1,{count:preview.count,token:preview.token})).rejects.toMatchObject({status:409,currentCount:1});
  expect(f.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(child)).toEqual({status:'sent'});
 });
 it('再送の確定直前に対象が増えたら新しい人数を返して止める',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('late','U-late','shop1')");
  f.raw.prepare("UPDATE broadcasts SET status='sent' WHERE id=?").run(child);
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'friend-shop1','failed','line_http_429')").run(child);
  const {previewHqRetry}=await import('./hq-broadcasts.js');
  const preview=await previewHqRetry(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1');
  const batch=f.db.batch.bind(f.db);let injected=false;
  vi.spyOn(f.db,'batch').mockImplementation(async statements=>{
    if(!injected&&statements.length===4){injected=true;f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'late','failed','line_http_429')").run(child);}
    return batch(statements);
  });
  await expect(retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1','owner',1,{count:preview.count,token:preview.token})).rejects.toMatchObject({status:409,currentCount:2});
  expect(injected).toBe(true);expect(f.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(child)).toEqual({status:'sent'});
 });
 it.each(['ledger','audience'] as const)('送信前の確定直前に対象が変わると原子操作を止める (%s)',async kind=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.prepare("UPDATE broadcasts SET status='draft' WHERE id=?").run(child);
  if(kind==='ledger'){
   f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('late','U-late','shop1')");
   f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'friend-shop1','failed','line_http_429')").run(child);
  }
  const {previewHqRetry}=await import('./hq-broadcasts.js');
  const run=await getHqBroadcastRun(f.db,tenant,r.id),preview=await previewHqRetry(f.db,run,'shop1');
  const batch=f.db.batch.bind(f.db);let injected=false;
  vi.spyOn(f.db,'batch').mockImplementation(async statements=>{
   if(!injected&&statements.length===3){injected=true;
    if(kind==='ledger')f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,error_code) VALUES(?,'late','failed','line_http_429')").run(child);
    else f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('late','U-late','shop1')");
   }
   return batch(statements);
  });
  await expect(retryHqBroadcastTarget(f.db,run,'shop1','owner',1,preview)).rejects.toMatchObject({status:409,currentCount:2});
  expect(injected).toBe(true);expect(f.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(child)).toEqual({status:'draft'});
  expect(f.raw.prepare('SELECT state FROM broadcast_send_claims WHERE broadcast_id=? ORDER BY friend_id').all(child)).toEqual(kind==='ledger'?[{state:'failed'},{state:'failed'}]:[]);
 });
 it('停止後の未送信を確認情報と一緒に一括で再送対象に固定する',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.prepare("UPDATE broadcasts SET status='sending',stopped_at=datetime('now') WHERE id=?").run(child);
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,dispatched_at) VALUES(?,'friend-shop1','claimed',NULL)").run(child);
  const {previewHqRetry}=await import('./hq-broadcasts.js');
  const preview=await previewHqRetry(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1');
  await retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1','owner',1,{count:preview.count,token:preview.token});
  expect(f.raw.prepare('SELECT state,attempt_no FROM broadcast_send_claims WHERE broadcast_id=?').get(child)).toEqual({state:'claimed',attempt_no:2});
 });
 it('配信できない友だちは確認人数から外し、後で復帰しても勝手に再送しない',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id,is_following) VALUES('offline','U-offline','shop1',0)");
  f.raw.prepare("UPDATE broadcasts SET status='sending',stopped_at=datetime('now') WHERE id=?").run(child);
  const put=f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state) VALUES(?,?,'claimed')");
  put.run(child,'friend-shop1');put.run(child,'offline');
  const {previewHqRetry}=await import('./hq-broadcasts.js');
  const preview=await previewHqRetry(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1');
  expect(preview.count).toBe(1);
  await retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1','owner',1,{count:preview.count,token:preview.token});
  expect(f.raw.prepare("SELECT state,error_code FROM broadcast_send_claims WHERE friend_id='offline'").get()).toEqual({state:'failed',error_code:'recipient_unavailable'});
 });
 it('送信済みの古い台帳に未送信が残っていても確認対象に含める',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.prepare("UPDATE broadcasts SET status='sent' WHERE id=?").run(child);
  f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,dispatched_at) VALUES(?,'friend-shop1','claimed',NULL)").run(child);
  const {readHqBroadcastResult}=await import('./hq-broadcasts.js');
  expect((await readHqBroadcastResult(f.db,await getHqBroadcastRun(f.db,tenant,r.id))).targets[0].retryableCount).toBe(1);
 });
 it('送信前に停止した店も確認した対象を固定して再送できる',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.prepare("UPDATE broadcasts SET status='draft',stopped_at=datetime('now') WHERE id=?").run(child);
  const {previewHqRetry}=await import('./hq-broadcasts.js');
  const preview=await previewHqRetry(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1');
  expect(preview.count).toBe(1);
  await retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1','owner',1,{count:preview.count,token:preview.token});
  expect(f.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id=?').all(child)).toEqual([{friend_id:'friend-shop1',state:'claimed'}]);
 });
 it('宛先の固定前に停止した送信中の店も人数を確認して再送できる',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
  const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.prepare("UPDATE broadcasts SET status='sending',stopped_at=datetime('now'),batch_offset=0 WHERE id=?").run(child);
  const {previewHqRetry}=await import('./hq-broadcasts.js');
  const preview=await previewHqRetry(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1');
  expect(preview.count).toBe(1);
  await retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1','owner',1,{count:preview.count,token:preview.token});
  expect(f.raw.prepare('SELECT status FROM broadcasts WHERE id=?').get(child)).toEqual({status:'scheduled'});
  expect(f.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims WHERE broadcast_id=?').all(child)).toEqual([{friend_id:'friend-shop1',state:'claimed'}]);
 });
 it('人数・残枠を店ごとに返し、足りない店を外した後だけ送れる',async()=>{
  let run=await prepareHqBroadcast(f.db,tenant,'owner',input),check=await preflightHqBroadcast(f.db,run);
  expect(check.map(p=>p.remaining)).toEqual([100,0]);expect(check[1].blockedReasons).toContain('今月の送信枠が足りません');
  await expect(dispatchHqBroadcast(f.db,run,'owner',1)).rejects.toThrow('外して');
  await excludeHqBroadcastTargets(f.db,run,'owner',['shop2'],1);run=await getHqBroadcastRun(f.db,tenant,run.id);
  const result=await dispatchHqBroadcast(f.db,run,'owner',2);expect(result.targets.filter(t=>t.broadcastId)).toHaveLength(1);
  const broadcasts=f.raw.prepare('SELECT hq_run_id,status,target_type FROM broadcasts').all();expect(broadcasts).toEqual([{hq_run_id:run.id,status:'scheduled',target_type:'segment'}]);
  await dispatchHqBroadcast(f.db,await getHqBroadcastRun(f.db,tenant,run.id),'owner',3);expect(f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({n:1});
 });
 it('対象店は固定され、重複依頼は同じ実行。内容が変わったら409',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',input);expect((await prepareHqBroadcast(f.db,tenant,'owner',input)).id).toBe(r.id);
  await expect(prepareHqBroadcast(f.db,tenant,'owner',{...input,title:'変更'})).rejects.toMatchObject({status:409});
  await expect(excludeHqBroadcastTargets(f.db,r,'owner',['other'],1)).rejects.toThrow('固定');
 });
 it('アカウント分類で選び、友だちの同名タグは店ごとのIDで固定する',async()=>{
  f.raw.prepare("INSERT INTO line_account_tags(id,tenant_id,name,created_at,updated_at) VALUES('group',?,'地域',datetime('now'),datetime('now'))").run(tenant);
  f.raw.prepare("INSERT INTO line_account_tag_links(line_account_id,tag_id,tenant_id) VALUES('shop1','group',?)").run(tenant);
  f.raw.exec("INSERT INTO tags(id,name,line_account_id) VALUES('tag-shop1','常連','shop1');INSERT INTO friend_tags(friend_id,tag_id) VALUES('friend-shop1','tag-shop1')");
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:[],accountTagIds:['group'],audience:{kind:'tag',tagName:'常連'}});
  expect(f.raw.prepare('SELECT line_account_id,tag_id FROM hq_broadcast_targets WHERE run_id=?').all(r.id)).toEqual([{line_account_id:'shop1',tag_id:'tag-shop1'}]);
  f.raw.prepare("INSERT INTO line_account_tag_links(line_account_id,tag_id,tenant_id) VALUES('shop2','group',?)").run(tenant);
  expect((await preflightHqBroadcast(f.db,r))).toHaveLength(1);
 });
 it('全店の取消は予約を下書きへ戻し、統括の操作記録を店ごとに残す',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});await dispatchHqBroadcast(f.db,r,'owner',1);
  const run=await getHqBroadcastRun(f.db,tenant,r.id);await stopHqBroadcast(f.db,run,'owner',true,2);
  expect(f.raw.prepare('SELECT status,scheduled_at FROM broadcasts').get()).toEqual({status:'draft',scheduled_at:null});
  expect(f.raw.prepare("SELECT COUNT(*) n FROM hq_broadcast_audit WHERE action='cancelled'").get()).toEqual({n:1});
 });
 it('店舗のやり直しは一時的な失敗だけを開き、成功・送達不明には送らない',async()=>{
  const r=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});const sent=await dispatchHqBroadcast(f.db,r,'owner',1),child=sent.targets[0].broadcastId!;
  f.raw.exec("INSERT INTO friends(id,line_user_id,line_account_id) VALUES('success','U-success','shop1'),('unknown','U-unknown','shop1')");
  f.raw.prepare("UPDATE broadcasts SET status='sent' WHERE id=?").run(child);
  const put=f.raw.prepare('INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,state,error_code) VALUES(?,?,\'shop1\',?,?)');
  put.run(child,'friend-shop1','failed','line_http_429');put.run(child,'success','sent',null);put.run(child,'unknown','unknown','network_timeout');
  await retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1','owner',1);
  expect(f.raw.prepare('SELECT friend_id,state FROM broadcast_send_claims ORDER BY friend_id').all()).toEqual([{friend_id:'friend-shop1',state:'claimed'},{friend_id:'success',state:'sent'},{friend_id:'unknown',state:'unknown'}]);
  await expect(retryHqBroadcastTarget(f.db,await getHqBroadcastRun(f.db,tenant,r.id),'shop1','owner',1)).rejects.toMatchObject({status:409});
 });
 it('統括全体の権限だけ許可し、店だけ担当する管理者を拒否する',async()=>{
  const staff={id:'owner',name:'管理者',role:'owner' as const,readOnly:false,tenantId:tenant};
  expect((await hqBroadcastAuthority(f.db,staff)).tenantId).toBe(tenant);
  f.raw.exec("UPDATE staff_members SET account_scope='accounts' WHERE id='owner'");await expect(hqBroadcastAuthority(f.db,staff)).rejects.toMatchObject({status:403});
  await expect(hqBroadcastAuthority(f.db,{...staff,tenantId:'other'})).rejects.toMatchObject({status:403});
 });
});

it('下書き本文と対象店を同じIDで変更し、古い版・送信後の変更は子配信を変えない',async()=>{
 const run=await prepareHqBroadcast(f.db,tenant,'owner',input);
 const changed={...input,title:'新しい下書き',messageContent:'変更本文',accountIds:['shop1']};
 const updated=await prepareHqBroadcast(f.db,tenant,'owner',changed,{run,expectedVersion:1});expect(updated.id).toBe(run.id);expect(updated.version).toBe(2);
 const {readHqBroadcastResult}=await import('./hq-broadcasts.js');expect((await readHqBroadcastResult(f.db,updated)).input).toEqual(changed);
 await expect(prepareHqBroadcast(f.db,tenant,'owner',input,{run,expectedVersion:1})).rejects.toMatchObject({status:409});
 expect(f.raw.prepare('SELECT line_account_id FROM hq_broadcast_targets').all()).toEqual([{line_account_id:'shop1'}]);
 await dispatchHqBroadcast(f.db,updated,'owner',2);
 await expect(prepareHqBroadcast(f.db,tenant,'owner',input,{run:await getHqBroadcastRun(f.db,tenant,run.id),expectedVersion:3})).rejects.toMatchObject({status:409});
 expect(f.raw.prepare('SELECT message_content FROM broadcasts').get()).toEqual({message_content:'変更本文'});
});
it('クーポンとリッチ素材を店側と同じ吹き出しで予約し、実送信の形式に変換できる',async()=>{
 const bubbles=[{id:'coupon',type:'coupon',content:{assetId:'coupon-1',assetName:'飲み物券',startsAt:'2026-01-01T00:00',endsAt:'2027-01-01T00:00',description:'1杯無料'}},
 {id:'rich',type:'rich_message',content:{assetId:'rich-1',assetName:'お知らせ',baseUrl:'https://example.test/map',baseSize:{width:1040,height:520},tapAreas:[{x:0,y:0,width:100,height:100,actionType:'uri',uri:'https://example.test/book'}]}}];
 const b={...input,accountIds:['shop1'],messageBubblesJson:JSON.stringify(bubbles)};const run=await prepareHqBroadcast(f.db,tenant,'owner',b);await dispatchHqBroadcast(f.db,run,'owner',1);
 const child=f.raw.prepare('SELECT message_type,message_content,message_bubbles_json FROM broadcasts').get() as any;
 const {parseBroadcastMessageParts,buildMessages}=await import('../features/broadcasts/broadcast-message-set.js');
 expect(buildMessages(parseBroadcastMessageParts({messageType:child.message_type,messageContent:child.message_content,messageBubblesJson:child.message_bubbles_json})).map(m=>m.type)).toEqual(['flex','imagemap']);
});
it('人数0・LINE応答なし・失敗の分類を返し、生のエラー本文を返さない',async()=>{
 const {readHqBroadcastResult}=await import('./hq-broadcasts.js');const run=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
 await dispatchHqBroadcast(f.db,run,'owner',1);const child=(f.raw.prepare('SELECT id FROM broadcasts').get() as any).id;
 f.raw.prepare("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,state,attempt_no,error_code) VALUES(?,'friend-shop1','unknown',1,'secret_external_error')").run(child);
 const result=await readHqBroadcastResult(f.db,await getHqBroadcastRun(f.db,tenant,run.id));expect(result.targets[0].failureReasons).toEqual([{code:'delivery_unknown',label:'LINEの応答なし（届いたか確認が必要）',count:1,retryable:false}]);
 f.raw.exec('DELETE FROM broadcast_send_claims;DELETE FROM friends;');const preflight=await preflightHqBroadcast(f.db,run);expect(preflight[0].blockedReasons).toContain('友だちが0人です');
});
it('店の電話番号と予約ページは決定した共通キーで調べ、空なら送信を止める',async()=>{
 const b={...input,accountIds:['shop1'],messageContent:'{店の電話番号} / {予約ページ}'};const r=await prepareHqBroadcast(f.db,tenant,'owner',b);
 const check=await preflightHqBroadcast(f.db,r);expect(check[0].blockedReasons).toContain('店舗の共通情報を確認してください');
 await expect(dispatchHqBroadcast(f.db,r,'owner',1)).rejects.toMatchObject({status:409});expect(f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({n:0});
 f.raw.exec("INSERT INTO common_vars(id,var_key,name,value,line_account_id) VALUES('phone','store_phone','電話','03-0000-5678','shop1'),('url','reservation_url','予約','https://example.test/book','shop1')");
 expect((await preflightHqBroadcast(f.db,r))[0].blockedReasons).toEqual([]);
 f.raw.exec("UPDATE common_vars SET value=' ' WHERE var_key='store_phone'");expect((await preflightHqBroadcast(f.db,r))[0].blockedReasons).toContain('店舗の共通情報を確認してください');
});

it('店舗名・LIFFは構造を壊さず吹き出しと実際の子配信へ固定する',async()=>{
 f.raw.prepare("UPDATE line_accounts SET name=?,liff_id='liff-shop1' WHERE id='shop1'").run('店"\nA');
 const bubbles=[
  {id:'text',type:'text',content:{text:'{{account.name}} https://liff.line.me/{{liff_id}}'}},
  {id:'image',type:'image',content:{originalContentUrl:'https://example.test/{{liff_id}}/image.png',previewImageUrl:'https://example.test/{{liff_id}}/image.png'}},
  {id:'video',type:'video',content:{originalContentUrl:'https://example.test/{{liff_id}}/video.mp4',previewImageUrl:'https://example.test/{{liff_id}}/preview.png'}},
  {id:'carousel',type:'carousel',content:{templateId:'template',columnsJson:JSON.stringify([{text:'{{account.name}}',actions:[{type:'uri',label:'予約',uri:'https://liff.line.me/{{liff_id}}'}]}])}},
 ];
 const b={...input,accountIds:['shop1'],messageBubbles:bubbles} as HqBroadcastInput;
 const run=await prepareHqBroadcast(f.db,tenant,'owner',b);
 expect((await preflightHqBroadcast(f.db,run))[0].blockedReasons).toEqual([]);
 await dispatchHqBroadcast(f.db,run,'owner',1);
 const stored=f.raw.prepare('SELECT message_type,message_content,message_bubbles_json FROM broadcasts').get() as {message_type:string;message_content:string;message_bubbles_json:string};
 expect(stored.message_content).toBe('店"\nAのお知らせ');
 const values=JSON.parse(stored.message_bubbles_json);
 expect(values[0].content.text).toBe('店"\nA https://liff.line.me/liff-shop1');
 expect(JSON.parse(values[3].content.columnsJson)[0].text).toBe('店"\nA');
 const {parseBroadcastMessageParts,buildMessages}=await import('../features/broadcasts/broadcast-message-set.js');
 expect(buildMessages(parseBroadcastMessageParts({messageType:stored.message_type,messageContent:stored.message_content,messageBubblesJson:stored.message_bubbles_json})).map(m=>m.type)).toEqual(['text','image','video','template']);
 expect(stored.message_bubbles_json).not.toContain('{{liff_id}}');
});
it('LIFFの差し込みが必要な店舗にLIFFが無ければ予約前に止める',async()=>{
 const b={...input,accountIds:['shop1'],messageContent:'https://liff.line.me/{{liff_id}}'};
 const run=await prepareHqBroadcast(f.db,tenant,'owner',b);
 expect((await preflightHqBroadcast(f.db,run))[0].blockedReasons).toContain('店舗のLIFF IDを確認してください');
 await expect(dispatchHqBroadcast(f.db,run,'owner',1)).rejects.toMatchObject({status:409});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({n:0});
});

it.each([{deliveryLimit:{upToRemainingQuota:true}}, {deliveryLimitConfirmation:{broadcastId:'copied',recipientCount:1,version:1}}])('統括の入口で店舗だけの上限と確認印を混ぜない %j',async options=>{
 await expect(prepareHqBroadcast(f.db,tenant,'owner',{...input,messageOptions:options} as unknown as HqBroadcastInput)).rejects.toMatchObject({status:400});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM hq_broadcast_runs').get()).toEqual({n:0});
});
it('保存済みの統括の入力に印が混ざっても、子配信を作る前に拒否する',async()=>{
 const run=await prepareHqBroadcast(f.db,tenant,'owner',{...input,accountIds:['shop1']});
 const forged={...JSON.parse(run.input_json),messageOptions:{deliveryLimit:{upToRemainingQuota:true},deliveryLimitConfirmation:{broadcastId:'copied',recipientCount:1,version:1}}};
 f.raw.prepare('UPDATE hq_broadcast_runs SET input_json=? WHERE id=?').run(JSON.stringify(forged),run.id);
 await expect(dispatchHqBroadcast(f.db,await getHqBroadcastRun(f.db,tenant,run.id),'owner',1)).rejects.toMatchObject({status:400});
 expect(f.raw.prepare('SELECT COUNT(*) n FROM broadcasts').get()).toEqual({n:0});
});
