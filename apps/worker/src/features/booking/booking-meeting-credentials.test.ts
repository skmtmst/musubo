import {afterEach,beforeEach,expect,it} from 'vitest';
import {beginMeetingAuthorization,consumeMeetingAuthorization} from './booking-meeting-oauth-state.js';
import {gapFixture} from '../../test-utils/gap1.js';
import {finishAuthorizedMeetingConnection,hasMeetingCredential,deleteMeetingCredential,claimMeetingRefresh,finishMeetingRefresh} from './booking-meeting-credentials.js';
let d:ReturnType<typeof gapFixture>;
const key=btoa('x'.repeat(32));
const credential={provider:'zoom' as const,externalAccountId:'external-user',refreshToken:'fixture-refresh-token'};
const input={accountId:'a',staffId:'bs',credential,encryptionKey:key,actorId:'o'};
async function connect(value:typeof input){
 const state=await beginMeetingAuthorization(d.db,{accountId:value.accountId,staffId:value.staffId,actorId:value.actorId,provider:value.credential.provider,verifier:'fixture',encryptionKey:key});
 expect(await consumeMeetingAuthorization(d.db,{accountId:value.accountId,state,actorId:value.actorId,encryptionKey:key})).not.toBeNull();
 expect(await finishAuthorizedMeetingConnection(d.db,{...value,provider:value.credential.provider,state})).toBe(true);
}
beforeEach(()=>{d=gapFixture()});afterEach(()=>d.raw.close());
it('鍵を暗号化して担当と店の範囲で読み取り、切断時に消す',async()=>{
 await connect(input);
 const rows=d.raw.prepare("SELECT credential_enc AS value FROM booking_meeting_connections WHERE line_account_id='a'").all() as {value:string}[];
 expect(rows).toHaveLength(1);expect(rows[0].value).not.toContain(credential.refreshToken);expect(rows[0].value).not.toContain(credential.externalAccountId);
 expect(await hasMeetingCredential(d.db,{accountId:'a',staffId:'bs',provider:'zoom'})).toBe(true);
 expect(await hasMeetingCredential(d.db,{accountId:'b',staffId:'bs',provider:'zoom'})).toBe(false);
 await deleteMeetingCredential(d.db,{accountId:'a',staffId:'bs',provider:'zoom'});
 expect(await hasMeetingCredential(d.db,{accountId:'a',staffId:'bs',provider:'zoom'})).toBe(false);
});
it('別の店の担当には保存せず、暗号鍵が違えば復号しない',async()=>{
 await expect(connect({...input,accountId:'b'})).rejects.toThrow('staff_not_found');
 await connect(input);
 await expect(claimMeetingRefresh(d.db,{accountId:'a',staffId:'bs',provider:'zoom',encryptionKey:btoa('y'.repeat(32))})).rejects.toThrow();
});

it('更新中の切断は鍵を復活させず、同時更新は一つだけ通る',async()=>{
 await connect(input);
 const scope={accountId:'a',staffId:'bs',provider:'zoom' as const,encryptionKey:key};
 const [a,b]=await Promise.all([claimMeetingRefresh(d.db,scope),claimMeetingRefresh(d.db,scope)]);
 const claimed=a??b;expect(Boolean(a)!==Boolean(b)).toBe(true);expect(claimed).not.toBeNull();
 await deleteMeetingCredential(d.db,scope);
 expect(await finishMeetingRefresh(d.db,{id:claimed!.id,claim:claimed!.claim,version:claimed!.version,credential,encryptionKey:key})).toBe(false);
 expect(await hasMeetingCredential(d.db,scope)).toBe(false);
});
it('担当者を削除すると暗号化された鍵も削除する',async()=>{
 await connect(input);
 d.raw.exec("UPDATE staff SET deleted_at='2026-11-19T00:00:00Z' WHERE id='bs'");
 expect(d.raw.prepare('SELECT COUNT(*) n FROM booking_meeting_connections').get()).toEqual({n:0});
});
it('接続し直した鍵は古い更新の結果で上書きされない',async()=>{
 await connect(input);
 const scope={accountId:'a',staffId:'bs',provider:'zoom' as const,encryptionKey:key};
 const old=await claimMeetingRefresh(d.db,scope);expect(old).not.toBeNull();
 await deleteMeetingCredential(d.db,scope);
 const replacement={...credential,refreshToken:'new-token'};
 await connect({...input,credential:replacement});
 expect(await finishMeetingRefresh(d.db,{id:old!.id,claim:old!.claim,version:old!.version,credential,encryptionKey:key})).toBe(false);
 expect((await claimMeetingRefresh(d.db,scope))?.credential).toEqual(replacement);
});

it('更新中につなぎ直しても古い鍵が新しい鍵を上書きしない',async()=>{
 await connect(input);const scope={accountId:'a',staffId:'bs',provider:'zoom' as const,encryptionKey:key};
 const old=await claimMeetingRefresh(d.db,scope);expect(old).not.toBeNull();
 const replacement={...credential,refreshToken:'reconnected-token'};await connect({...input,credential:replacement});
 expect(await finishMeetingRefresh(d.db,{id:old!.id,claim:old!.claim,version:old!.version,credential,encryptionKey:key})).toBe(false);
 expect((await claimMeetingRefresh(d.db,scope))?.credential).toEqual(replacement);
});
