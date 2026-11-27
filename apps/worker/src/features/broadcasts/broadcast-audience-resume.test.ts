import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestD1, insertFriend } from '../../test-utils/d1-sqlite.js';
import { processQueuedBroadcasts, processBroadcastSend } from './broadcast.js';
import { reopenFailedClaims, reopenUnsentClaims, updateBroadcastStatus, beginBroadcastRetryAttempt, requestBroadcastStop, resumeBroadcastSending } from '@line-crm/db';
import { prepareHqBroadcast, dispatchHqBroadcast } from '../../services/hq-broadcasts.js';

const sends = vi.hoisted(() => [] as string[]);
vi.mock('@line-crm/line-sdk', async original => ({
  ...await original<Record<string, unknown>>(),
  LineClient: class {
    async pushMessageWithRequestId(id: string) { sends.push(id); return { requestId: 'fake' }; }
    async multicast(ids: string[]) { sends.push(...ids); return { requestId: 'fake' }; }
  },
}));
vi.mock('../../services/stealth.js', async original => ({ ...await original<Record<string,unknown>>(), sleep: async () => {}, calculateStaggerDelay: () => 0 }));
const opened: ReturnType<typeof createTestD1>[] = [];
function fixture(kind = 'segment') {
  const f = createTestD1(); opened.push(f);
  for (let i = 0; i < 160; i++) insertFriend(f.raw, `f${String(i).padStart(3, '0')}`);
  f.raw.exec("INSERT INTO tags(id,name) VALUES('t','対象'); INSERT INTO friend_tags(friend_id,tag_id) SELECT id,'t' FROM friends");
  const conditions = JSON.stringify({ operator: 'AND', rules: [{ type: 'tag_exists', value: 't' }] });
  f.raw.prepare(`INSERT INTO broadcasts(id,title,message_type,message_content,target_type,target_tag_id,segment_conditions,status,batch_offset,track_links)
    VALUES('b','試験','text','{{name}} さん',?,'t',?,'sending',0,0)`).run(kind, kind === 'tag' ? null : conditions);
  return f;
}
const client = { async pushMessageWithRequestId(id: string) { sends.push(id); return { requestId: 'fake' }; } } as never;
afterEach(() => { for (const f of opened.splice(0)) f.raw.close(); sends.length = 0; vi.unstubAllGlobals(); });
describe('SEND-S01: 開始時の宛先をIDで保つ', () => {
  it.each(['tag','segment'])('%s: 処理済み・未送信者のタグを外し、新しい一致者を足しても元の160人だけに送る', async kind => {
    const f = fixture(kind);
    // tag の通常入口も、差し込み付きならキューへ入る。
    if (kind === 'tag') await processBroadcastSend(f.db, client, 'b');
    await processQueuedBroadcasts(f.db, client);
    expect(sends).toHaveLength(150);
    f.raw.exec("DELETE FROM friend_tags WHERE friend_id IN ('f000','f155')");
    insertFriend(f.raw, 'added'); f.raw.exec("INSERT INTO friend_tags VALUES('added','t',datetime('now'))");
    await processQueuedBroadcasts(f.db, client);
    expect(sends.length).toBe(160);
    expect(new Set(sends).size).toBe(160);
    expect(sends).toContain('Uf155'); expect(sends).not.toContain('Uadded');
  });
  it('開始時の相手が全員削除されても、新しい一致者へ取り直さない', async () => {
    const f = fixture();await processQueuedBroadcasts(f.db,client);
    // 人工DBでも、友だち削除時の宛先台帳のCASCADEを再現する。
    f.raw.exec('DELETE FROM friends; DELETE FROM broadcast_send_claims');insertFriend(f.raw,'added');
    f.raw.exec("INSERT INTO friend_tags VALUES('added','t',datetime('now'))");
    await processQueuedBroadcasts(f.db,client);
    expect(sends).toHaveLength(150);expect(sends).not.toContain('Uadded');
    expect(f.raw.prepare("SELECT total_count,stopped_at FROM broadcasts WHERE id='b'").get()).toMatchObject({total_count:160,stopped_at:expect.any(String)});
  });
  it('旧配信の一部しか宛先台帳が無い場合は、完了にせず確認待ちで止める', async () => {
    const f=fixture();
    f.raw.exec("UPDATE broadcasts SET total_count=160,success_count=150,batch_offset=150; INSERT INTO broadcast_send_claims(broadcast_id,friend_id,attempt_no,state) SELECT 'b',id,1,'sent' FROM friends WHERE id<'f150'");
    await processQueuedBroadcasts(f.db,client);
    expect(sends).toHaveLength(0);
    expect(f.raw.prepare("SELECT status,stopped_at FROM broadcasts WHERE id='b'").get()).toMatchObject({status:'sending',stopped_at:expect.any(String)});
  });
  it('再送：未送信の一時失敗だけを送り、送信済みには送らない', async () => {
    const f = fixture();
    await processQueuedBroadcasts(f.db, client); await processQueuedBroadcasts(f.db, client); sends.length = 0;
    f.raw.exec("UPDATE broadcast_send_claims SET state='failed',error_code='line_http_429' WHERE friend_id='f155'; DELETE FROM friend_tags WHERE friend_id='f155'; DELETE FROM messages_log WHERE friend_id='f155'; UPDATE broadcasts SET status='sending',sent_at=NULL,batch_offset=0,send_attempt_no=2 WHERE id='b'");
    await reopenFailedClaims(f.db, 'b', 2);
    await processQueuedBroadcasts(f.db, client);
    expect(sends).toEqual(['Uf155']);
  });
  it('統括で店を確定した後、各店の配信開始時の友だちを保持する', async () => {
    const f = fixture(); f.raw.exec("DELETE FROM broadcasts; INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret,tenant_id) VALUES('shop','店','c','fake','fake','00000000-0000-4000-8000-000000000001'); UPDATE friends SET line_account_id='shop'; UPDATE tags SET line_account_id='shop'; INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner','試験','owner','fake','00000000-0000-4000-8000-000000000001')");
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'limited', value: 10000, totalUsage: 0 }), { status: 200 })));
    const run = await prepareHqBroadcast(f.db,'00000000-0000-4000-8000-000000000001','owner',{requestId:'hq',title:'試験',messageType:'text',messageContent:'{{name}} さん',accountIds:['shop'],accountTagIds:[],excludedAccountIds:[],audience:{kind:'tag',tagName:'対象'},scheduledAt:null});
    const dispatched = await dispatchHqBroadcast(f.db,run,'owner',1);
    await processBroadcastSend(f.db,client,dispatched.targets[0].broadcastId!);
    await processQueuedBroadcasts(f.db,client);
    f.raw.exec("DELETE FROM friend_tags WHERE friend_id IN ('f000','f155')");
    await processQueuedBroadcasts(f.db,client);
    expect(sends.length).toBe(160); expect(sends).toContain('Uf155');
  });
});

it('複数アカウントの重複除外配信も、再開時に元の当選者を保つ', async () => {
  const f = fixture();
  for(let i=160;i<600;i++){const id=`f${String(i).padStart(3,'0')}`;insertFriend(f.raw,id);f.raw.prepare("INSERT INTO friend_tags(friend_id,tag_id) VALUES(?,'t')").run(id);}
  f.raw.exec("DELETE FROM broadcasts; INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('a','店','c','fake','fake'); UPDATE friends SET line_account_id='a'; INSERT INTO broadcasts(id,title,message_type,message_content,target_type,account_ids,dedup_priority,status,track_links) VALUES('b','試験','text','案内','multi-account-dedup','[\"a\"]','[\"a\"]','sending',0)");
  const { processMultiAccountDedupBroadcast } = await import('../../services/dedup-broadcast.js');
  const args = { id:'b',account_ids:'["a"]',dedup_priority:'["a"]',target_tag_id:'t',message_type:'text',message_content:'案内',stealth_spread_minutes:60 };
  const fake = { async multicast(ids: string[]) { sends.push(...ids); f.raw.exec("UPDATE broadcasts SET stopped_at='stop' WHERE id='b'"); return {requestId:'fake'}; } } as never;
  await processMultiAccountDedupBroadcast(f.db,args,()=>fake);
  // 時間分割の最初の束の後で条件を変更。
  const initialSent = sends.length;
  expect(initialSent).toBeGreaterThan(0); expect(initialSent).toBeLessThan(600);
  f.raw.exec("DELETE FROM friend_tags WHERE friend_id='f555'; UPDATE broadcasts SET stopped_at=NULL WHERE id='b'");
  insertFriend(f.raw,'added',{line_account_id:'a'}); f.raw.exec("INSERT INTO friend_tags VALUES('added','t',datetime('now'))");
  for (let i=0;i<50 && sends.length<600;i++) {
    const progress = (f.raw.prepare('SELECT dedup_progress FROM broadcasts').get() as {dedup_progress:string}).dedup_progress;
    await processMultiAccountDedupBroadcast(f.db,{...args,dedup_progress:progress},()=>({async multicast(ids:string[]){sends.push(...ids);return {requestId:'fake'};}} as never));
  }
  expect(new Set(sends).size).toBe(600); expect(sends).toContain('Uf555'); expect(sends).not.toContain('Uadded');
});

it('重複除外の完了後の再試行でも最初の宛先だけを選ぶ', async () => {
  const f = fixture();
  f.raw.exec(`DELETE FROM broadcasts; INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('a','店','c','fake','fake'); UPDATE friends SET line_account_id='a'; INSERT INTO broadcasts(id,title,message_type,message_content,target_type,account_ids,dedup_priority,status,track_links) VALUES('b','試験','text','案内','multi-account-dedup','["a"]','["a"]','sending',0)`);
  const { processMultiAccountDedupBroadcast } = await import('../../services/dedup-broadcast.js');
  const args = { id:'b',account_ids:'["a"]',dedup_priority:'["a"]',target_tag_id:'t',message_type:'text',message_content:'案内' };
  await processMultiAccountDedupBroadcast(f.db,args,()=>({async multicast(){throw Object.assign(new Error('LINE API error: 429 Too Many Requests'),{status:429});}} as never));
  await updateBroadcastStatus(f.db,'b','sent');
  f.raw.exec("DELETE FROM friend_tags WHERE friend_id='f155'");
  insertFriend(f.raw,'added',{line_account_id:'a'}); f.raw.exec("INSERT INTO friend_tags VALUES('added','t',datetime('now'))");
  const {lock_version} = f.raw.prepare("SELECT lock_version FROM broadcasts WHERE id='b'").get() as {lock_version:number};
  await beginBroadcastRetryAttempt(f.db,{id:'b',expectedVersion:lock_version});
  await reopenFailedClaims(f.db,'b',2);
  const {dedup_progress} = f.raw.prepare("SELECT dedup_progress FROM broadcasts WHERE id='b'").get() as {dedup_progress:string};
  await processMultiAccountDedupBroadcast(f.db,{...args,send_attempt_no:2,dedup_progress},()=>({async multicast(ids:string[]){sends.push(...ids);return {requestId:'fake'};}} as never));
  expect(sends).toHaveLength(160); expect(sends).toContain('Uf155'); expect(sends).not.toContain('Uadded');
});

it('差し込み無しのタグ一斉配信も、停止後は最初の600人の残りへ送る', async () => {
  const f=fixture('tag');
  for(let i=160;i<600;i++){const id=`f${String(i).padStart(3,'0')}`;insertFriend(f.raw,id);f.raw.prepare("INSERT INTO friend_tags(friend_id,tag_id) VALUES(?,'t')").run(id);}
  f.raw.exec("UPDATE broadcasts SET message_content='案内'");
  await processBroadcastSend(f.db,{async multicast(ids:string[]){sends.push(...ids);f.raw.exec("UPDATE broadcasts SET stopped_at='stop' WHERE id='b'");return {requestId:'fake'};}} as never,'b');
  expect(sends).toHaveLength(500);
  f.raw.exec("DELETE FROM friend_tags WHERE friend_id IN ('f001','f555'); UPDATE broadcasts SET stopped_at=NULL WHERE id='b'");
  insertFriend(f.raw,'added');f.raw.exec("INSERT INTO friend_tags VALUES('added','t',datetime('now'))");
  await processBroadcastSend(f.db,{async multicast(ids:string[]){sends.push(...ids);return {requestId:'fake'};}} as never,'b');
  expect(new Set(sends).size).toBe(600);expect(sends).toContain('Uf555');expect(sends).not.toContain('Uadded');
  expect(f.raw.prepare("SELECT total_count,success_count FROM broadcasts WHERE id='b'").get()).toEqual({total_count:600,success_count:600});
});

it('タグのその場送信も、受理後に記録ごと消えた相手を送り直さない', async () => {
  const f=fixture('tag');
  for(let i=160;i<600;i++){const id=`f${String(i).padStart(3,'0')}`;insertFriend(f.raw,id);f.raw.prepare("INSERT INTO friend_tags(friend_id,tag_id) VALUES(?,'t')").run(id);}
  f.raw.exec("UPDATE broadcasts SET message_content='案内'");
  let batches=0;
  const lost = {...f.db,async batch(stmts:D1PreparedStatement[]){if(++batches>=3)throw new Error('process lost after provider acceptance');return f.db.batch(stmts);}} as D1Database;
  const fake={async multicast(ids:string[]){sends.push(...ids);return {requestId:'fake'};}} as never;
  await expect(processBroadcastSend(lost,fake,'b')).rejects.toThrow('process lost');
  expect(sends).toHaveLength(500);
  await processBroadcastSend(f.db,fake,'b');
  expect(sends).toHaveLength(600);expect(new Set(sends).size).toBe(600);
  expect(f.raw.prepare("SELECT COUNT(*) n FROM broadcast_send_claims WHERE state='unknown'").get()).toEqual({n:500});
});

it.each([false,true])('重複除外の旧進捗に宛先snapshotが無い場合は保留する（既送キー=%s）', async oldKey => {
  const f=fixture();
  f.raw.exec("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('a','店','c','fake','fake'); UPDATE friends SET line_account_id='a'");
  const progress=JSON.stringify({sentIdentKeys:oldKey?['uid:f000']:[]});
  f.raw.exec("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,attempt_no,state,error_code) VALUES('b','f000',1,'failed','line_http_429')");
  const {processMultiAccountDedupBroadcast}=await import('../../services/dedup-broadcast.js');
  const result=await processMultiAccountDedupBroadcast(f.db,{id:'b',account_ids:'["a"]',dedup_priority:'["a"]',target_tag_id:'t',message_type:'text',message_content:'案内',dedup_progress:progress},()=>({async multicast(ids:string[]){sends.push(...ids);return {requestId:'fake'};}} as never));
  expect(sends).toHaveLength(0);expect(result.complete).toBe(false);expect(result.stopped).toBe(true);
  expect(f.raw.prepare("SELECT reason FROM broadcast_lifecycle_events WHERE broadcast_id='b'").get()).toMatchObject({reason:expect.stringContaining('要確認')});
});


it('古い未送信の押さえを再送し、送信済みと送達不明は重ねて送らない', async () => {
  const f=fixture();
  await processQueuedBroadcasts(f.db,client);
  expect(sends).toHaveLength(150);
  sends.length=0;
  f.raw.exec("UPDATE broadcasts SET status='sent' WHERE id='b'; UPDATE broadcast_send_claims SET state='unknown',dispatched_at='2026-11-21' WHERE broadcast_id='b' AND friend_id='f156'; UPDATE broadcast_send_claims SET state='failed',error_code='line_http_403' WHERE broadcast_id='b' AND friend_id>='f150' AND friend_id<>'f155' AND friend_id<>'f156'");
  const {lock_version}=f.raw.prepare("SELECT lock_version FROM broadcasts WHERE id='b'").get() as {lock_version:number};
  const attempt=await beginBroadcastRetryAttempt(f.db,{id:'b',expectedVersion:lock_version});
  expect(attempt).toEqual({changes:1,attemptNo:2});
  expect(await reopenUnsentClaims(f.db,'b',2)).toBe(1);
  await processQueuedBroadcasts(f.db,client);
  expect(sends).toEqual(['Uf155']);
  expect(f.raw.prepare("SELECT state FROM broadcast_send_claims WHERE broadcast_id='b' AND friend_id='f156'").get()).toEqual({state:'unknown'});
});

it('旧処理と進捗更新が重なっても、送達済みの人数を二重に数えない', async () => {
  const f=fixture();
  f.raw.exec("UPDATE broadcasts SET message_content='案内' WHERE id='b'");
  let injected=false;
  const racingDb={...f.db,async batch(stmts:D1PreparedStatement[]) {
    const result=await f.db.batch(stmts);
    if (!injected && stmts.some(stmt=>((stmt as unknown as {sql?:string}).sql??'').includes('INSERT INTO messages_log'))) {
      injected=true;
      f.raw.exec("UPDATE broadcasts SET success_count=(SELECT COUNT(*) FROM broadcast_send_claims WHERE broadcast_id='b' AND state='sent') WHERE id='b'");
    }
    return result;
  }} as D1Database;
  const multicast={async multicast(ids:string[]){sends.push(...ids); return {requestId:'fake'};}} as never;
  await processQueuedBroadcasts(racingDb,multicast);
  expect(injected).toBe(true);
  expect(sends).toHaveLength(160);
  expect(f.raw.prepare("SELECT success_count FROM broadcasts WHERE id='b'").get()).toEqual({success_count:160});
});

it.each([[false, false],[true, false],[false, true],[true, true]])('並走：複数アカウントで旧処理と再送・再開が重なっても二重送信しない（個別=%s、再開=%s）', async (personalized, resume) => {
  const f = createTestD1(); opened.push(f);
  f.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('a','店A','ca','fake','fake'),('b','店B','cb','fake','fake');
    INSERT INTO broadcasts(id,title,message_type,message_content,target_type,account_ids,dedup_priority,status,track_links)
    VALUES('bcast','試験','text','案内','multi-account-dedup','["a","b"]','["a","b"]','sending',0)`);
  insertFriend(f.raw, 'fa', {line_account_id:'a',line_user_id:'Ushared',user_id:'shared'});
  insertFriend(f.raw, 'fb', {line_account_id:'b',line_user_id:'Uother',user_id:'shared'});
  let unblock!: () => void; let reached!: () => void;
  const paused = new Promise<void>(r => { reached = r; });
  const gate = new Promise<void>(r => { unblock = r; });
  let held = false;
  const oldDb = {...f.db, async batch(statements: D1PreparedStatement[]) {
    if (!held && statements.some(s => ((s as unknown as {sql?:string}).sql ?? '').includes('dispatched_at, created_at'))) {
      held = true; reached(); await gate;
    }
    return f.db.batch(statements);
  }} as D1Database;
  const {processMultiAccountDedupBroadcast} = await import('../../services/dedup-broadcast.js');
  const args = {id:'bcast',account_ids:'["a","b"]',dedup_priority:'["a","b"]',message_type:'text',message_content:personalized?'{{name}} さん':'案内'};
  const fake = () => ({async multicast(ids:string[]) {sends.push(...ids);}, async pushMessage(id:string) {sends.push(id);}} as never);
  const before = f.raw.prepare("SELECT lock_version FROM broadcasts WHERE id='bcast'").get() as {lock_version:number};
  const oldRun = processMultiAccountDedupBroadcast(oldDb,{...args,lock_version:before.lock_version},fake);
  await paused;
  expect(await requestBroadcastStop(f.db,{id:'bcast',expectedVersion:before.lock_version})).toBe(1);
  if (resume) {
    expect(await resumeBroadcastSending(f.db,{id:'bcast',expectedVersion:before.lock_version+1})).toBe(1);
  } else {
    expect(await beginBroadcastRetryAttempt(f.db,{id:'bcast',expectedVersion:before.lock_version+1})).toEqual({changes:1,attemptNo:2});
  }
  const {dedup_progress} = f.raw.prepare("SELECT dedup_progress FROM broadcasts WHERE id='bcast'").get() as {dedup_progress:string};
  await processMultiAccountDedupBroadcast(f.db,{...args,send_attempt_no:resume?1:2,lock_version:before.lock_version+2,dedup_progress},fake);
  unblock(); await oldRun;
  expect(sends).toEqual(['Ushared']);
  expect(f.raw.prepare("SELECT attempt_no,state FROM broadcast_send_claims WHERE broadcast_id='bcast' AND friend_id='fa'").get()).toEqual({attempt_no:resume?1:2,state:'sent'});
});

it('重複除外の中断後は送信途中の相手を送達不明にし、残りには送る', async () => {
  const f = createTestD1(); opened.push(f);
  f.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('a','店A','ca','fake','fake'),('b','店B','cb','fake','fake');
    INSERT INTO broadcasts(id,title,message_type,message_content,target_type,account_ids,dedup_priority,status,batch_offset,track_links)
    VALUES('bcast','試験','text','案内','multi-account-dedup','["a","b"]','["a","b"]','sending',0,0)`);
  insertFriend(f.raw,'first',{line_account_id:'a'}); insertFriend(f.raw,'second',{line_account_id:'a'}); insertFriend(f.raw,'third',{line_account_id:'b'});
  const {computeDedupBroadcastPreview} = await import('../../services/dedup-broadcast.js');
  const audience = await computeDedupBroadcastPreview(f.db,['a','b'],['a','b']);
  f.raw.prepare("UPDATE broadcasts SET dedup_progress=? WHERE id='bcast'").run(JSON.stringify({sentIdentKeys:[],audience}));
  f.raw.exec("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,attempt_no,state,dispatched_at) VALUES('bcast','first','a',1,'claimed','2026-11-21')");
  await processQueuedBroadcasts(f.db,client);
  expect(new Set(sends)).toEqual(new Set(['Usecond','Uthird']));
  expect(f.raw.prepare("SELECT state,error_code FROM broadcast_send_claims WHERE broadcast_id='bcast' AND friend_id='first'").get()).toEqual({state:'unknown',error_code:'interrupted_dispatch'});
  expect(f.raw.prepare("SELECT status,success_count FROM broadcasts WHERE id='bcast'").get()).toEqual({status:'sent',success_count:2});
});

it('前の再送で未送信のまま残った宛先も、次の再送では送れる', async () => {
  const f = createTestD1(); opened.push(f);
  f.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('a','店A','ca','fake','fake'),('b','店B','cb','fake','fake');
    INSERT INTO broadcasts(id,title,message_type,message_content,target_type,account_ids,dedup_priority,status,batch_offset,track_links,send_attempt_no)
    VALUES('bcast','試験','text','案内','multi-account-dedup','["a","b"]','["a","b"]','sending',0,0,3)`);
  insertFriend(f.raw,'first',{line_account_id:'a'}); insertFriend(f.raw,'second',{line_account_id:'a'}); insertFriend(f.raw,'third',{line_account_id:'b'});
  const {computeDedupBroadcastPreview} = await import('../../services/dedup-broadcast.js');
  const audience = await computeDedupBroadcastPreview(f.db,['a','b'],['a','b']);
  f.raw.prepare("UPDATE broadcasts SET dedup_progress=? WHERE id='bcast'").run(JSON.stringify({sentIdentKeys:[],audience}));
  f.raw.exec("INSERT INTO broadcast_send_claims(broadcast_id,friend_id,line_account_id,attempt_no,state) VALUES('bcast','first','a',2,'claimed')");
  await processQueuedBroadcasts(f.db,client);
  expect(new Set(sends)).toEqual(new Set(['Ufirst','Usecond','Uthird']));
  expect(f.raw.prepare("SELECT attempt_no,state FROM broadcast_send_claims WHERE broadcast_id='bcast' AND friend_id='first'").get()).toEqual({attempt_no:3,state:'sent'});
  expect(f.raw.prepare("SELECT status,success_count FROM broadcasts WHERE id='bcast'").get()).toEqual({status:'sent',success_count:3});
});

it('停止：複数アカウント配信を止めた後は古い処理も再送候補の処理も送らない', async () => {
  const f=createTestD1(); opened.push(f);
  f.raw.exec(`INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('a','店A','ca','fake','fake'),('b','店B','cb','fake','fake');
    INSERT INTO broadcasts(id,title,message_type,message_content,target_type,account_ids,dedup_priority,status,track_links)
    VALUES('bcast','試験','text','案内','multi-account-dedup','["a","b"]','["a","b"]','sending',0)`);
  insertFriend(f.raw,'fa',{line_account_id:'a',line_user_id:'Ushared',user_id:'same'});
  insertFriend(f.raw,'fb',{line_account_id:'b',line_user_id:'Uother',user_id:'same'});
  let release!:()=>void; let reached!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}); const paused=new Promise<void>(r=>{reached=r;});
  let held=false;
  const oldDb={...f.db,async batch(stmts:D1PreparedStatement[]) {
    if (!held && stmts.some(s=>((s as unknown as {sql?:string}).sql??'').includes('dispatched_at, created_at'))) {
      held=true; reached(); await gate;
    }
    return f.db.batch(stmts);
  }} as D1Database;
  const {processMultiAccountDedupBroadcast}=await import('../../services/dedup-broadcast.js');
  const args={id:'bcast',account_ids:'["a","b"]',dedup_priority:'["a","b"]',message_type:'text',message_content:'案内'};
  const fake=()=>({async multicast(ids:string[]){sends.push(...ids);},async pushMessage(id:string){sends.push(id);}} as never);
  const old=processMultiAccountDedupBroadcast(oldDb,{...args,lock_version:1},fake);
  await paused;
  expect(await requestBroadcastStop(f.db,{id:'bcast',expectedVersion:1})).toBe(1);
  const {dedup_progress}=f.raw.prepare("SELECT dedup_progress FROM broadcasts WHERE id='bcast'").get() as {dedup_progress:string};
  const retry=await beginBroadcastRetryAttempt(f.db,{id:'bcast',expectedVersion:1});
  expect(retry.changes).toBe(0);
  await processMultiAccountDedupBroadcast(f.db,{...args,send_attempt_no:1,lock_version:2,dedup_progress},fake);
  release(); await old;
  expect(sends).toEqual([]);
  expect(f.raw.prepare("SELECT stopped_at FROM broadcasts WHERE id='bcast'").get()).toMatchObject({stopped_at:expect.any(String)});
});
