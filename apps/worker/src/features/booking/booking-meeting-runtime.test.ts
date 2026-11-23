import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Env} from '../../worker-env.js';
import {gapFixture,seedGapBooking} from '../../test-utils/gap1.js';
import {beginMeetingAuthorization,consumeMeetingAuthorization} from './booking-meeting-oauth-state.js';
import {finishAuthorizedMeetingConnection,deleteMeetingCredential} from './booking-meeting-credentials.js';
import {meetingQueueDependencies} from './booking-meeting-runtime.js';
let d:ReturnType<typeof gapFixture>;const key=btoa('x'.repeat(32));
function env(extra:Partial<Env['Bindings']>={}):Env['Bindings']{return {DB:d.db,WORKER_URL:'https://worker.example.test',DEPLOY_ENV:'staging',LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_OAUTH_ENABLED:'true',BOOKING_MEETING_REAL_ENABLED:'true',BOOKING_MEETING_OAUTH_CONFIG:JSON.stringify({zoom:{clientId:'fixture-client',clientSecret:'fixture-secret'}}),...extra} as Env['Bindings'];}
beforeEach(async()=>{
 d=gapFixture();seedGapBooking(d);d.raw.exec("UPDATE bookings SET meeting_mode='online' WHERE id='bk'; INSERT INTO account_settings(id,line_account_id,key,value) VALUES('test','a','test_recipients','[\"f\"]'); INSERT INTO booking_meeting_links(id,booking_id,provider,status,idempotency_key,attempt_count,staff_id,starts_at,ends_at,created_at,updated_at) VALUES('link','bk','zoom','pending','meeting-key',1,'bs','2026-11-20T05:00:00Z','2026-11-20T06:00:00Z','2026-11-01','2026-11-01')");
 const state=await beginMeetingAuthorization(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider:'zoom',verifier:'fixture',encryptionKey:key});
 await consumeMeetingAuthorization(d.db,{accountId:'a',state,actorId:'o',encryptionKey:key});
 expect(await finishAuthorizedMeetingConnection(d.db,{accountId:'a',staffId:'bs',actorId:'o',provider:'zoom',state,encryptionKey:key,credential:{provider:'zoom',externalAccountId:'provider-user',refreshToken:'fixture-refresh'}})).toBe(true);
});
afterEach(()=>{d.raw.close();vi.unstubAllGlobals()});
it('有効化していない環境・試験宛先以外では外部通信しない',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 expect(await meetingQueueDependencies(env({BOOKING_MEETING_REAL_ENABLED:undefined})).resolve({accountId:'a',bookingId:'bk'})).toBeNull();
 d.raw.exec("UPDATE account_settings SET value='[]' WHERE key='test_recipients'");
 expect(await meetingQueueDependencies(env()).resolve({accountId:'a',bookingId:'bk'})).toBeNull();expect(fetcher).not.toHaveBeenCalled();
});
it('試験環境では鍵を先に更新し、切断後は同じ access token を送らない',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-rotated',expires_in:3600})));vi.stubGlobal('fetch',fetcher);
 const deps=await meetingQueueDependencies(env()).resolve({accountId:'a',bookingId:'bk'});expect(deps).not.toBeNull();expect(fetcher).toHaveBeenCalledOnce();
 await deleteMeetingCredential(d.db,{accountId:'a',staffId:'bs',provider:'zoom'});
 const result=await deps!.removers.zoom!.remove({staffId:'bs',meetingId:JSON.stringify(['provider-user','id']),idempotencyKey:'key',signal:new AbortController().signal});
 expect(result).toBe('failed');expect(fetcher).toHaveBeenCalledOnce();
});
it('自動発行のメニューと試験宛先だけに担当の会議を用意する',async()=>{
 const {meetingCreatorForBooking}=await import('./booking-meeting-runtime.js');
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-rotated',expires_in:3600})));vi.stubGlobal('fetch',fetcher);
 expect(await meetingCreatorForBooking(env(),'bk')).toBeNull();expect(fetcher).not.toHaveBeenCalled();
 d.raw.exec("INSERT INTO account_settings(id,line_account_id,key,value) VALUES('auto','a','booking.meeting.automatic:menu','automatic')");
 const creator=await meetingCreatorForBooking(env(),'bk');
 expect(creator && typeof creator!=='string' ? creator.provider : null).toBe('zoom');expect(fetcher).toHaveBeenCalledOnce();
 d.raw.exec("UPDATE bookings SET meeting_url_source='manual' WHERE id='bk'");
 expect(await meetingCreatorForBooking(env(),'bk')).toBeNull();
});
