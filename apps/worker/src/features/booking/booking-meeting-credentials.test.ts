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
it('再接続した鍵は古い更新の結果で上書きされない',async()=>{
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

it('旧 v1 と旧鍵を読み、新鍵 ID と店・担当・サービスに結び付けた暗号へ更新する', async()=>{
 const {encryptCredential}=await import('@line-crm/db');
 const {cachedMeetingAccess}=await import('./booking-meeting-credentials.js');
 const {decryptMeetingCredential,encryptMeetingCredential}=await import('./booking-meeting-crypto.js');
 await connect(input);
 const old=btoa('o'.repeat(32)),next=btoa('n'.repeat(32));
 const keys={legacyKey:key,activeId:'new',keys:{old,new:next}};
 const scope={accountId:'a',staffId:'bs',provider:'zoom' as const};
 const withAccess={...credential,accessToken:'fixture-access',accessExpiresAt:new Date(Date.now()+3600000).toISOString()};
 const legacy=await encryptCredential(JSON.stringify(withAccess),key);
 d.raw.prepare("UPDATE booking_meeting_connections SET credential_enc=? WHERE line_account_id='a'").run(legacy);
 expect((await cachedMeetingAccess(d.db,{...scope,encryptionKey:keys}))?.token).toBe('fixture-access');
 let row=d.raw.prepare("SELECT credential_enc FROM booking_meeting_connections WHERE line_account_id='a'").get() as {credential_enc:string};
 expect(row.credential_enc).toMatch(/^v2\.new\./);
 for(const changed of [{...scope,accountId:'b'},{...scope,staffId:'other'},{...scope,provider:'teams' as const}]) await expect(decryptMeetingCredential(row.credential_enc,keys,changed)).rejects.toThrow();
 const previous=await encryptMeetingCredential(JSON.stringify(withAccess),{...keys,activeId:'old'},scope);
 d.raw.prepare("UPDATE booking_meeting_connections SET credential_enc=? WHERE line_account_id='a'").run(previous);
 expect((await cachedMeetingAccess(d.db,{...scope,encryptionKey:keys}))?.token).toBe('fixture-access');
 row=d.raw.prepare("SELECT credential_enc FROM booking_meeting_connections WHERE line_account_id='a'").get() as {credential_enc:string};
 expect(row.credential_enc).toMatch(/^v2\.new\./);
 await expect(decryptMeetingCredential(previous,{...keys,keys:{new:next}},scope)).rejects.toThrow();
});

it('段階配備中は旧形式で書き、明示的に有効化した後だけ AAD 付きに切り替える',async()=>{
 const {meetingCredentialKeys,encryptMeetingCredential,decryptMeetingCredential}=await import('./booking-meeting-crypto.js');
 const scope={accountId:'a',staffId:'bs',provider:'zoom' as const};
 const env={LINE_CREDENTIAL_ENCRYPTION_KEY:key};
 const first=meetingCredentialKeys(env);
 const legacy=await encryptMeetingCredential('secret',first,scope);
 expect(legacy).toMatch(/^v1\./);
 expect((await decryptMeetingCredential(legacy,first,scope)).needsRotation).toBe(false);
 const next=meetingCredentialKeys({...env,BOOKING_MEETING_CREDENTIAL_V2_ENABLED:'true'});
 expect((await decryptMeetingCredential(legacy,next,scope)).needsRotation).toBe(true);
 const upgraded=await encryptMeetingCredential('secret',next,scope);
 expect(upgraded).toMatch(/^v2\.line\./);
 expect((await decryptMeetingCredential(upgraded,first,scope)).plaintext).toBe('secret');
});

it('鍵 ID が設定されていない時は接続を要再接続にせず戻す',async()=>{
 const {encryptMeetingCredential}=await import('./booking-meeting-crypto.js');
 await connect(input); const scope={accountId:'a',staffId:'bs',provider:'zoom' as const};
 const old=btoa('o'.repeat(32));
 const encrypted=await encryptMeetingCredential(JSON.stringify(credential),{activeId:'old',keys:{old},legacyKey:key},scope);
 d.raw.prepare("UPDATE booking_meeting_connections SET credential_enc=? WHERE line_account_id='a'").run(encrypted);
 await expect(claimMeetingRefresh(d.db,{...scope,encryptionKey:{activeId:'new',keys:{new:key},legacyKey:key}})).rejects.toThrow('invalid_meeting_key_config');
 expect(d.raw.prepare("SELECT refresh_state FROM booking_meeting_connections WHERE line_account_id='a'").get()).toEqual({refresh_state:'ready'});
});
it('LINE の鍵の前後の空白を正規化し、後から鍵束を設定しても line の鍵を保持する',async()=>{
 const {meetingCredentialKeys,encryptMeetingCredential,decryptMeetingCredential}=await import('./booking-meeting-crypto.js');
 const scope={accountId:'a',staffId:'bs',provider:'zoom' as const};
 const old=meetingCredentialKeys({LINE_CREDENTIAL_ENCRYPTION_KEY:` ${key}\n`,BOOKING_MEETING_CREDENTIAL_V2_ENABLED:'true'});
 const encrypted=await encryptMeetingCredential('x',old,scope);
 const ring=meetingCredentialKeys({LINE_CREDENTIAL_ENCRYPTION_KEY:` ${key}\n`,BOOKING_MEETING_CREDENTIAL_V2_ENABLED:'true',BOOKING_MEETING_CREDENTIAL_KEYS:JSON.stringify({activeId:'new',keys:{new:btoa('n'.repeat(32))}})});
 expect((await decryptMeetingCredential(encrypted,ring,scope)).plaintext).toBe('x');
 expect(()=>meetingCredentialKeys({LINE_CREDENTIAL_ENCRYPTION_KEY:key,BOOKING_MEETING_CREDENTIAL_KEYS:JSON.stringify({activeId:'line',keys:{line:key}})})).toThrow('invalid_meeting_key_config');
});

it('旧形式を拒否しても接続は要再接続に変わらない',async()=>{
 await connect(input);
 await expect(claimMeetingRefresh(d.db,{accountId:'a',staffId:'bs',provider:'zoom',encryptionKey:{activeId:'new',keys:{new:key},legacyKey:key,writeV2:true,rejectLegacy:true}})).rejects.toThrow('invalid_meeting_key_config');
 expect(d.raw.prepare("SELECT refresh_state FROM booking_meeting_connections WHERE line_account_id='a'").get()).toEqual({refresh_state:'ready'});
});

it('未使用の旧接続も dry-run で数え、実行時だけ新しい鍵で再暗号化する',async()=>{
 const {encryptCredential}=await import('@line-crm/db');
 const {rotateMeetingCredentials}=await import('./booking-meeting-credentials.js');
 await connect(input);
 const legacy=await encryptCredential(JSON.stringify(credential),key);
 d.raw.prepare("UPDATE booking_meeting_connections SET credential_enc=? WHERE line_account_id='a'").run(legacy);
 const keys={legacyKey:key,activeId:'new',keys:{new:btoa('n'.repeat(32))},writeV2:true};
 expect(await rotateMeetingCredentials(d.db,{accountId:'a',encryptionKey:keys,dryRun:true})).toMatchObject({scanned:1,needsRotation:1,rotated:0,unreadable:0});
 d.raw.prepare("UPDATE booking_meeting_connections SET refresh_state='unknown'").run();
 expect(await rotateMeetingCredentials(d.db,{accountId:'a',encryptionKey:keys,dryRun:true})).toMatchObject({needsRotation:1,busy:1,rotated:0});
 d.raw.prepare("UPDATE booking_meeting_connections SET refresh_state='ready'").run();
 expect((d.raw.prepare('SELECT credential_enc FROM booking_meeting_connections').get() as {credential_enc:string}).credential_enc).toBe(legacy);
 expect(await rotateMeetingCredentials(d.db,{accountId:'a',encryptionKey:keys,dryRun:false})).toMatchObject({needsRotation:1,rotated:1,changed:0});
 expect((d.raw.prepare('SELECT credential_enc FROM booking_meeting_connections').get() as {credential_enc:string}).credential_enc).toMatch(/^v2\.new\./);
 expect(await rotateMeetingCredentials(d.db,{accountId:'a',encryptionKey:keys,dryRun:true})).toMatchObject({needsRotation:0,unreadable:0});
});
