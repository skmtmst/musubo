import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {gapFixture} from '../../test-utils/gap1.js';
import {beginMeetingAuthorization,consumeMeetingAuthorization} from './booking-meeting-oauth-state.js';
import {finishAuthorizedMeetingConnection,hasMeetingCredential} from './booking-meeting-credentials.js';
import {meetingAccessToken} from './booking-meeting-access.js';
import type {MeetingOAuthConfig} from './booking-meeting-oauth-client.js';
let d:ReturnType<typeof gapFixture>;const key=btoa('x'.repeat(32));
const config:MeetingOAuthConfig={provider:'zoom',clientId:'fixture-client',clientSecret:'fixture-secret',redirectUri:'https://example.test/callback'};
const scope={accountId:'a',staffId:'bs',provider:'zoom' as const,encryptionKey:key,config,signal:new AbortController().signal};
beforeEach(async()=>{d=gapFixture();const now=new Date();const state=await beginMeetingAuthorization(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider:'zoom',verifier:'fixture',encryptionKey:key,now});await consumeMeetingAuthorization(d.db,{accountId:'a',state,actorId:'o',encryptionKey:key,now});expect(await finishAuthorizedMeetingConnection(d.db,{...scope,state,actorId:'o',credential:{provider:'zoom',externalAccountId:'external',refreshToken:'fixture-refresh'}})).toBe(true);});
afterEach(()=>d.raw.close());
it('同時に更新しても外部の更新要求は一度だけ',async()=>{
 let finish:((r:Response)=>void)|undefined;const request=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;}));
 const first=meetingAccessToken(d.db,scope,request as unknown as typeof fetch);await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce());
 expect(await meetingAccessToken(d.db,scope,request as unknown as typeof fetch)).toEqual({kind:'busy'});
 finish!(new Response(JSON.stringify({access_token:'access',refresh_token:'rotated',expires_in:3600})));
 expect(await first).toMatchObject({kind:'ready',externalAccountId:'external'});expect(request).toHaveBeenCalledOnce();
});
it('Zoom の通信結果が不明なら更新鍵を再送しない',async()=>{
 const request=vi.fn(async()=>{throw new Error('timeout')}) as unknown as typeof fetch;
 expect(await meetingAccessToken(d.db,scope,request)).toEqual({kind:'reconnect'});
 expect(await hasMeetingCredential(d.db,scope)).toBe(false);
 expect(await meetingAccessToken(d.db,scope,request)).toEqual({kind:'reconnect'});expect(request).toHaveBeenCalledOnce();
});
it('更新中に処理が止まった場合は期限後に再接続待ちにする',async()=>{
 const {claimMeetingRefresh}=await import('./booking-meeting-credentials.js');
 expect(await claimMeetingRefresh(d.db,scope)).not.toBeNull();
 d.raw.exec("UPDATE booking_meeting_connections SET updated_at='2020-01-01T00:00:00.000Z'");
 const request=vi.fn() as unknown as typeof fetch;
 expect(await meetingAccessToken(d.db,scope,request)).toEqual({kind:'reconnect'});expect(request).not.toHaveBeenCalled();
});
it('クライアントの設定が空なら接続を壊さず設定待ちにする',async()=>{
 const request=vi.fn() as unknown as typeof fetch;
 expect(await meetingAccessToken(d.db,{...scope,config:{...config,clientSecret:''}},request)).toEqual({kind:'configuration'});
 expect(await hasMeetingCredential(d.db,scope)).toBe(true);expect(request).not.toHaveBeenCalled();
});
it('期限内の access token を再利用し、更新鍵を再送しない',async()=>{
 const request=vi.fn(async()=>new Response(JSON.stringify({access_token:'access',refresh_token:'rotated',expires_in:3600}))) as unknown as typeof fetch;
 expect(await meetingAccessToken(d.db,scope,request)).toMatchObject({kind:'ready'});
 expect(await meetingAccessToken(d.db,scope,request)).toMatchObject({kind:'ready'});
 expect(request).toHaveBeenCalledOnce();
 const row=d.raw.prepare('SELECT credential_enc FROM booking_meeting_connections').get() as {credential_enc:string};
 expect(row.credential_enc).not.toContain('access');expect(row.credential_enc).not.toContain('rotated');
});
