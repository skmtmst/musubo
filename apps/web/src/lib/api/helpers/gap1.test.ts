import {expect,test,vi} from 'vitest';
const fetchApi=vi.hoisted(()=>vi.fn().mockResolvedValue({success:true}));
vi.mock('../../api',()=>({fetchApi}));
import {chatSafetyApi,lineSenderApi,inboxRoutingApi,bookingCancellationApi,bookingCalendarApi} from './gap1';
test('UNS-02 UNS-18 SND-05: 手動ヘッダと訂正元・送り手・代理の理由を渡す',async()=>{
 await chatSafetyApi.send('friend/id',{content:'文',correctionOfMessageId:'m',senderId:'s'},'key');expect(fetchApi).toHaveBeenLastCalledWith('/api/chats/friend%2Fid/send',expect.objectContaining({headers:{'Idempotency-Key':'key','X-Line-Harness-Source':'manual'},body:JSON.stringify({content:'文',correctionOfMessageId:'m',senderId:'s'})}));
 await chatSafetyApi.cancelScheduled('f','sch','取消の理由');expect(fetchApi).toHaveBeenLastCalledWith('/api/chats/f/scheduled/sch',{method:'DELETE',headers:{'X-Impersonation-Reason':encodeURIComponent('取消の理由')}});
});
test('SND-14 SLA-19 B1-29 B7-58: 各保存が版を渡す',async()=>{
 await lineSenderApi.deactivate('a','s',3);expect(fetchApi).toHaveBeenLastCalledWith('/api/line-accounts/a/senders/s',{method:'DELETE',body:'{"expectedVersion":3}'});
 await inboxRoutingApi.save('a',{strategy:'none',enabled:true,firstResponseMinutes:30,businessHoursOnly:true,expectedVersion:4});expect(JSON.parse(fetchApi.mock.calls.at(-1)![1].body).expectedVersion).toBe(4);
 await bookingCancellationApi.savePolicy('a',{enabled:false,tiers:[{beforeHours:24,percent:0},{beforeHours:0,percent:50}],noShowPercent:100,expectedVersion:5});expect(JSON.parse(fetchApi.mock.calls.at(-1)![1].body).expectedVersion).toBe(5);
 await bookingCalendarApi.saveSwitches('a',{readEnabled:true,writeEnabled:false,expectedVersion:6},'s');expect(fetchApi).toHaveBeenLastCalledWith('/api/booking/admin/staff/s/calendar-sync?account_id=a',expect.objectContaining({method:'PUT'}));
});
test('外部の予定の確認は店を付けて読み、記録は確認済みの明示を送る',async()=>{
 await bookingCalendarApi.listExternalCleanups('a/b');expect(fetchApi).toHaveBeenLastCalledWith('/api/booking/admin/external-cleanup?account_id=a%2Fb');
 await bookingCalendarApi.resolveExternalCleanup('a','job/1');expect(fetchApi).toHaveBeenLastCalledWith('/api/booking/admin/external-cleanup/job%2F1/resolve?account_id=a',{method:'POST',body:'{"confirmed":true}'});
 await bookingCalendarApi.resolveExternalCleanup('a','job','Zoom で削除した');expect(fetchApi).toHaveBeenLastCalledWith('/api/booking/admin/external-cleanup/job/resolve?account_id=a',{method:'POST',body:JSON.stringify({confirmed:true,reason:'Zoom で削除した'})});
});
test('B1-08: LIFFの本人のトークンと冪等キーをカード登録へ渡す',async()=>{await bookingCancellationApi.setup('liff',{menuId:'m',policyAccepted:true},'id-token','key');expect(fetchApi).toHaveBeenLastCalledWith('/api/liff/booking/setup-intent?liffId=liff',expect.objectContaining({headers:{Authorization:'Bearer id-token','Idempotency-Key':'key'}}));});
