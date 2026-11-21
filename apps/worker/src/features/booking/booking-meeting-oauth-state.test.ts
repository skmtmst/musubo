import {afterEach,beforeEach,expect,it} from 'vitest';
import {gapFixture} from '../../test-utils/gap1.js';
import {beginMeetingAuthorization,consumeMeetingAuthorization} from './booking-meeting-oauth-state.js';
let d:ReturnType<typeof gapFixture>;
const key=btoa('x'.repeat(32)),now=new Date('2026-11-19T00:00:00Z');
const input={accountId:'a',staffId:'bs',actorId:'o',provider:'zoom' as const,verifier:'fixture-verifier',encryptionKey:key,now};
beforeEach(()=>{d=gapFixture()});afterEach(()=>d.raw.close());
it('認可状態は暗号化し、本人のみ一度だけ使える',async()=>{
 const state=await beginMeetingAuthorization(d.db,input);
 const row=d.raw.prepare("SELECT verifier_enc AS value FROM booking_meeting_oauth_states WHERE line_account_id='a'").get() as {value:string};expect(row.value).not.toContain(input.verifier);
 const consume={accountId:'a',state,actorId:'o',encryptionKey:key,now};
 expect(await consumeMeetingAuthorization(d.db,{...consume,accountId:'b'})).toBeNull();
 expect(await consumeMeetingAuthorization(d.db,consume)).toEqual({staffId:'bs',provider:'zoom',verifier:input.verifier});
 expect(await consumeMeetingAuthorization(d.db,consume)).toBeNull();
});
it('期限切れと異なる担当者の状態は使えない',async()=>{
 const first=await beginMeetingAuthorization(d.db,input);expect(await consumeMeetingAuthorization(d.db,{accountId:'a',state:first,actorId:'other',encryptionKey:key,now})).toBeNull();
 expect(await consumeMeetingAuthorization(d.db,{accountId:'a',state:first,actorId:'o',encryptionKey:key,now})).not.toBeNull();
 const second=await beginMeetingAuthorization(d.db,input);expect(await consumeMeetingAuthorization(d.db,{accountId:'a',state:second,actorId:'o',encryptionKey:key,now:new Date(now.getTime()+600000)})).toBeNull();
});
it('同じ state を同時に使っても一度だけ受け付ける',async()=>{
 const state=await beginMeetingAuthorization(d.db,input);
 const consume={accountId:'a',state,actorId:'o',encryptionKey:key,now};
 const result=await Promise.all([consumeMeetingAuthorization(d.db,consume),consumeMeetingAuthorization(d.db,consume)]);
 expect(result.filter(Boolean)).toHaveLength(1);
});
it('認可中に切断されたら古い callback は接続を復活できない',async()=>{
 const {deleteMeetingCredential,finishAuthorizedMeetingConnection}=await import('./booking-meeting-credentials.js');
 const current=new Date();const state=await beginMeetingAuthorization(d.db,{...input,now:current});
 expect(await consumeMeetingAuthorization(d.db,{accountId:'a',state,actorId:'o',encryptionKey:key,now:current})).not.toBeNull();
 await deleteMeetingCredential(d.db,{accountId:'a',staffId:'bs',provider:'zoom'});
 expect(await finishAuthorizedMeetingConnection(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider:'zoom',state,encryptionKey:key,credential:{provider:'zoom',externalAccountId:'external',refreshToken:'fixture-token'}})).toBe(false);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_meeting_connections').get()).toEqual({n:0});
});
it('認可済みの callback は一度だけ接続を保存する',async()=>{
 const {finishAuthorizedMeetingConnection}=await import('./booking-meeting-credentials.js');
 const current=new Date();const state=await beginMeetingAuthorization(d.db,{...input,now:current});
 expect(await consumeMeetingAuthorization(d.db,{accountId:'a',state,actorId:'o',encryptionKey:key,now:current})).not.toBeNull();
 const finish={accountId:'a',staffId:'bs',actorId:'o',provider:'zoom' as const,state,encryptionKey:key,credential:{provider:'zoom' as const,externalAccountId:'external',refreshToken:'fixture-token'}};
 expect(await finishAuthorizedMeetingConnection(d.db,finish)).toBe(true);
 expect(await finishAuthorizedMeetingConnection(d.db,finish)).toBe(false);
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_meeting_connections').get()).toEqual({n:1});
});
it('新しい認可を始めたら古い認可結果は使えない',async()=>{
 const first=await beginMeetingAuthorization(d.db,input);const second=await beginMeetingAuthorization(d.db,input);
 expect(await consumeMeetingAuthorization(d.db,{accountId:'a',state:first,actorId:'o',encryptionKey:key,now})).toBeNull();
 expect(await consumeMeetingAuthorization(d.db,{accountId:'a',state:second,actorId:'o',encryptionKey:key,now})).not.toBeNull();
});
