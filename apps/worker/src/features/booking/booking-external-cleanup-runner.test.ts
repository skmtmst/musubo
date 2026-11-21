import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {encryptCredential} from '@line-crm/db';
import {gapFixture} from '../../test-utils/gap1.js';
import {processExternalCleanup} from './booking-external-cleanup-runner.js';
let d:ReturnType<typeof gapFixture>;
const key=btoa('k'.repeat(32));
beforeEach(()=>{d=gapFixture();});afterEach(()=>d.raw.close());
async function insert(action='delete'){
 const payload=JSON.stringify(await encryptCredential(JSON.stringify({provider:'zoom',action,staffId:'staff',remoteId:'secret-id'}),key));
 d.raw.prepare("INSERT INTO workflow_steps(scope_id,process_kind,subject_id,step_key,status,retry_key,input_json,result_json,created_at,updated_at) VALUES('line:a','booking_external_cleanup','job','current','pending','job',?,?,0,0)").run(payload,JSON.stringify({retainUntil:90*86400000}));
}
it('成功時に参照を消し、同時実行でも一度だけ操作する',async()=>{
 await insert();const execute=vi.fn(async()=> 'done' as const);
 await Promise.all([processExternalCleanup(d.db,{encryptionKey:key,execute,now:1000}),processExternalCleanup(d.db,{encryptionKey:key,execute,now:1000})]);
 expect(execute).toHaveBeenCalledTimes(1);
 expect(d.raw.prepare("SELECT COUNT(*) n FROM workflow_steps WHERE process_kind='booking_external_cleanup'").get()).toEqual({n:0});
});
it('安全な一時失敗は間隔を空け上限で要確認にし、秘密を記録しない',async()=>{
 await insert();const execute=vi.fn(async()=> 'retry' as const);
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:1000});
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:1001});expect(execute).toHaveBeenCalledTimes(1);
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:301001});
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:601001});
 const row=d.raw.prepare("SELECT status,error_code,attempt_count,input_json FROM workflow_steps WHERE process_kind='booking_external_cleanup'").get() as {status:string;error_code:string;attempt_count:number;input_json:string};
 expect(row).toMatchObject({status:'unknown',error_code:'cleanup_review',attempt_count:3});expect(row.input_json).not.toContain('secret-id');
 expect(d.raw.prepare("SELECT body FROM notifications WHERE event_type='booking_external_cleanup_review'").get()).toEqual({body:'外部の予定・会議 1 件を確認してください。'});
});
it('設定の待機では回数を使わず時刻を進める',async()=>{
 await insert();const execute=vi.fn(async()=> 'wait' as const);
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:1000});
 expect(d.raw.prepare("SELECT status,attempt_count,next_attempt_at FROM workflow_steps WHERE process_kind='booking_external_cleanup'").get()).toEqual({status:'pending',attempt_count:0,next_attempt_at:301000});
});
it('要確認の対象と途中停止は外部操作を送らない',async()=>{
 await insert('review');const execute=vi.fn(async()=> 'review' as const);
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:1000});expect(execute).toHaveBeenCalledTimes(1);execute.mockClear();
 d.raw.exec("UPDATE workflow_steps SET status='running',lease_owner='old',lease_expires_at=1100 WHERE process_kind='booking_external_cleanup'");
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:1200});expect(execute).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT status,error_code FROM workflow_steps WHERE process_kind='booking_external_cleanup'").get()).toEqual({status:'unknown',error_code:'cleanup_interrupted'});
});
it('90日経過した参照は消し、未解決を内容なしで知らせる',async()=>{
 await insert();const execute=vi.fn(async()=> 'done' as const);
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:91*86400000});
 expect(execute).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT COUNT(*) n FROM workflow_steps WHERE process_kind='booking_external_cleanup'").get()).toEqual({n:0});
 const notice=d.raw.prepare("SELECT body,metadata FROM notifications WHERE event_type='booking_external_cleanup_expired'").get() as {body:string;metadata:string};
 expect(notice.body).toContain('保管期限');expect(JSON.stringify(notice)).not.toContain('secret-id');
});
it('期限の10日前には待機を要確認に変えて知らせる',async()=>{
 await insert();const execute=vi.fn(async()=> 'done' as const);
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:81*86400000});
 expect(execute).not.toHaveBeenCalled();
 expect(d.raw.prepare("SELECT status,error_code FROM workflow_steps WHERE process_kind='booking_external_cleanup'").get()).toEqual({status:'unknown',error_code:'cleanup_retention_expiring'});
 expect(d.raw.prepare("SELECT body FROM notifications WHERE event_type='booking_external_cleanup_review'").get()).toEqual({body:'外部の予定・会議 1 件を確認してください。'});
});
it('90日より先の予定の参照は予定後まで維持する',async()=>{
 await insert();d.raw.prepare("UPDATE workflow_steps SET result_json=? WHERE process_kind='booking_external_cleanup'").run(JSON.stringify({retainUntil:400*86400000}));
 const execute=vi.fn(async()=> 'wait' as const);
 await processExternalCleanup(d.db,{encryptionKey:key,execute,now:100*86400000});
 expect(d.raw.prepare("SELECT status FROM workflow_steps WHERE process_kind='booking_external_cleanup'").get()).toEqual({status:'pending'});
});
