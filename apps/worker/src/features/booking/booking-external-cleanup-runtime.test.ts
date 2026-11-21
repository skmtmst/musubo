import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Env} from '../../worker-env.js';
const feature=vi.hoisted(()=>vi.fn(async()=>true));
vi.mock('../../services/feature-enforcement.js',()=>({featureJobCanRun:feature}));
import {gapFixture,seedGapBooking} from '../../test-utils/gap1.js';
import {cleanupRecipientProof} from './booking-external-cleanup-proof.js';
import {externalCleanupExecutor} from './booking-external-cleanup-runtime.js';
import {beginMeetingAuthorization,consumeMeetingAuthorization} from './booking-meeting-oauth-state.js';
import {finishAuthorizedMeetingConnection} from './booking-meeting-credentials.js';
let d:ReturnType<typeof gapFixture>;const key=btoa('k'.repeat(32));
function env(extra:Partial<Env['Bindings']>={}):Env['Bindings']{return {DB:d.db,DEPLOY_ENV:'staging',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_REAL_ENABLED:'true',BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({outlook:{clientId:'client',clientSecret:'secret'},zoom:{clientId:'client',clientSecret:'secret'}}),WORKER_URL:'https://worker.example.test',...extra} as Env['Bindings'];}
beforeEach(()=>{feature.mockReset();feature.mockResolvedValue(true);d=gapFixture();seedGapBooking(d);d.raw.exec("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('test','a','test_recipients','[\"f\"]')");});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals();});
async function connect(provider:'outlook'|'zoom'){
 const state=await beginMeetingAuthorization(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider,verifier:'fixture',encryptionKey:key});
 await consumeMeetingAuthorization(d.db,{accountId:'a',state,actorId:'o',encryptionKey:key});
 expect(await finishAuthorizedMeetingConnection(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider,state,encryptionKey:key,credential:{provider,externalAccountId:'owner',refreshToken:'refresh',accessToken:'access',accessExpiresAt:new Date(Date.now()+3600000).toISOString()}})).toBe(true);
}
it('Outlook の変更・取消の設定がオフなら外部通信せず待機する',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const proof=await cleanupRecipientProof(key,'a','["f"]');
 expect(await externalCleanupExecutor(env())('a',{provider:'outlook',action:'delete',staffId:'bs',remoteId:'event',externalAccountId:'owner',testRecipientProof:proof})).toBe('wait');
 expect(fetcher).not.toHaveBeenCalled();
});
it('予約機能が停止しても Google の個人情報整理は機能の判定で止めない',async()=>{
 feature.mockResolvedValue(false);
 expect(await externalCleanupExecutor(env())('a',{provider:'google_calendar',action:'redact',staffId:'bs',remoteId:'event',calendarId:'c',connectionId:'missing'})).toBe('review');
 expect(feature).not.toHaveBeenCalled();
 expect(await externalCleanupExecutor(env())('a',{provider:'zoom',action:'delete',staffId:'bs',remoteId:'meeting'})).toBe('wait');
});
it('Google の接続の担当者が違えば外部通信せず要確認にする',async()=>{
 d.raw.exec("INSERT INTO staff(id,name,display_name,line_account_id) VALUES('other','Other','Other','a'); INSERT INTO google_calendar_connections(id,calendar_id,line_account_id,staff_id,auth_type,is_active) VALUES('conn','c','a','other','oauth',1)");
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect(await externalCleanupExecutor(env())('a',{provider:'google_calendar',action:'delete',staffId:'bs',remoteId:'event',calendarId:'c',connectionId:'conn'})).toBe('review');
 expect(fetcher).not.toHaveBeenCalled();
});
it('試験先の一覧が変われば送らず要確認とする',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const proof=await cleanupRecipientProof(key,'a','["f"]');d.raw.exec("UPDATE account_settings SET value='[]' WHERE key='test_recipients'");
 expect(await externalCleanupExecutor(env())('a',{provider:'zoom',action:'delete',staffId:'bs',remoteId:'remote',testRecipientProof:proof})).toBe('review');
 expect(fetcher).not.toHaveBeenCalled();
});
it('Outlook は本人の予定で参加者がいないときだけ通知先を増やさず削除する',async()=>{
 await connect('outlook');const proof=await cleanupRecipientProof(key,'a','["f"]');
 const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>init?.method==='DELETE'?new Response(null,{status:204}):new Response(JSON.stringify({id:'event',attendees:[],isOrganizer:true,'@odata.etag':'"v"'})));
 vi.stubGlobal('fetch',fetcher);
 expect(await externalCleanupExecutor(env({BOOKING_OUTLOOK_MUTATIONS_ENABLED:'true'}))('a',{provider:'outlook',action:'delete',staffId:'bs',remoteId:'event',externalAccountId:'owner',testRecipientProof:proof})).toBe('done');
 expect(fetcher.mock.calls.map(call=>call[1]?.method??'GET')).toEqual(['GET','DELETE']);
 expect(fetcher.mock.calls[1][1]?.body).toBeUndefined();
});
it('Zoom の結果不明は目印でGET照合し、不在なら作り直さない',async()=>{
 await connect('zoom');const proof=await cleanupRecipientProof(key,'a','["f"]');
 const fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({meetings:[]})));vi.stubGlobal('fetch',fetcher);
 expect(await externalCleanupExecutor(env())('a',{provider:'zoom',action:'review',staffId:'bs',marker:'fixture-marker',uncertainty:'create',testRecipientProof:proof})).toBe('review');
 expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
});
it('Zoom の結果不明は目印で一致した会議だけ消す',async()=>{
 await connect('zoom');const proof=await cleanupRecipientProof(key,'a','["f"]');
 const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.method==='DELETE')return new Response(null,{status:204});
  return new Response(JSON.stringify(String(url).includes('/users/me/meetings')?{meetings:[{id:123,agenda:'fixture-marker'}]}:{id:123,agenda:'fixture-marker',join_url:'https://zoom.us/j/123'}));
 });vi.stubGlobal('fetch',fetcher);
 expect(await externalCleanupExecutor(env())('a',{provider:'zoom',action:'review',staffId:'bs',marker:'fixture-marker',uncertainty:'create',testRecipientProof:proof})).toBe('done');
 expect(fetcher.mock.calls.map(call=>call[1]?.method)).toEqual(['GET','GET','DELETE']);
});
