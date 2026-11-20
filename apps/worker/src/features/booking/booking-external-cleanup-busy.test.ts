import {afterEach,beforeEach,expect,it} from 'vitest';
import {encryptCredential} from '@line-crm/db';
import {gapFixture} from '../../test-utils/gap1.js';
import {cleanupOwnEventIds} from './booking-external-cleanup-busy.js';
import {cleanupIndex} from './booking-external-cleanup-proof.js';
let d:ReturnType<typeof gapFixture>;const key=btoa('k'.repeat(32));
beforeEach(()=>{d=gapFixture();});afterEach(()=>d.raw.close());
async function put(id:string,account:string,item:{provider:string;staffId:string;[key:string]:unknown}){
 const encrypted=JSON.stringify(await encryptCredential(JSON.stringify(item),key));
 const index=await cleanupIndex(key,account,item.provider,item.staffId);
 d.raw.prepare("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,retry_key,input_json,created_at,updated_at) VALUES(?,'booking_external_cleanup',?,'current',?,?,0,0)").run(`line:${account}`,id,index.index,encrypted);
}
it('同じ店・担当・接続先の予定だけを除く',async()=>{
 await put('a','a',{provider:'outlook',staffId:'s',externalAccountId:'owner',remoteId:'own'});
 await put('b','a',{provider:'outlook',staffId:'s',externalAccountId:'other',remoteId:'other'});
 await put('c','b',{provider:'outlook',staffId:'s',externalAccountId:'owner',remoteId:'foreign'});
 expect(await cleanupOwnEventIds(d.db,{accountId:'a',staffId:'s',provider:'outlook',externalAccountId:'owner',encryptionKey:key})).toEqual(['own']);
});
it('作成が結果不明の予定を無条件で空き扱いにせず、鍵が無い場合も失敗する',async()=>{
 await put('a','a',{provider:'google_calendar',staffId:'s',calendarId:'c',connectionId:'x',remoteId:'event',uncertainty:'create'});
 expect(await cleanupOwnEventIds(d.db,{accountId:'a',staffId:'s',provider:'google_calendar',calendarId:'c',connectionId:'x',encryptionKey:key})).toEqual([]);
 await expect(cleanupOwnEventIds(d.db,{accountId:'a',staffId:'s',provider:'google_calendar',calendarId:'c',connectionId:'x'})).rejects.toThrow('cleanup_busy_unavailable');
});
it('別の担当の壊れた行や大量の行は、この担当の空き確認を止めない',async()=>{
 const other=await cleanupIndex(key,'a','outlook','other');
 const insert=d.raw.prepare("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,retry_key,input_json,created_at,updated_at) VALUES('line:a','booking_external_cleanup',?,'current',?,'\"broken\"',0,0)");
 for(let i=0;i<501;i++)insert.run(`job-${i}`,other.index);
 expect(await cleanupOwnEventIds(d.db,{accountId:'a',staffId:'s',provider:'outlook',externalAccountId:'owner',encryptionKey:key})).toEqual([]);
 await expect(cleanupOwnEventIds(d.db,{accountId:'a',staffId:'other',provider:'outlook',externalAccountId:'owner',encryptionKey:key})).rejects.toThrow('cleanup_busy_unavailable');
});
it('鍵を変えたら古い索引を見落として空きと判断しない',async()=>{
 await put('a','a',{provider:'outlook',staffId:'s',externalAccountId:'owner',remoteId:'own'});
 await expect(cleanupOwnEventIds(d.db,{accountId:'a',staffId:'s',provider:'outlook',externalAccountId:'owner',encryptionKey:btoa('z'.repeat(32))})).rejects.toThrow('cleanup_busy_unavailable');
});
