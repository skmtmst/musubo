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
test('B1-08: LIFFの本人のトークンと冪等キーをカード登録へ渡す',async()=>{await bookingCancellationApi.setup('liff',{menuId:'m',staffId:'s',startsAt:'2026-12-01T05:00:00Z',partySize:1,policyAccepted:true},'id-token','key');expect(fetchApi).toHaveBeenLastCalledWith('/api/liff/booking/setup-intent?liffId=liff',expect.objectContaining({headers:{Authorization:'Bearer id-token','Idempotency-Key':'key'}}));});
