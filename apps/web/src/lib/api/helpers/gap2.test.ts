import {beforeEach,expect,test,vi} from 'vitest';
const transport=vi.hoisted(()=>({fetchApi:vi.fn(async()=>({success:true,data:{}})),ApiError:class extends Error {}}));
vi.mock('../../api',()=>transport);
import {bookingAudienceApi,bookingSeriesApi,formRoutingApi,bookingMakeupApi,broadcastAbApi,aiDraftApi,operatorPushApi} from './gap2';
beforeEach(()=>transport.fetchApi.mockClear());
test('B4-04 B6-10 B3-07: 予約系はアカウント・本人token・同じキーを運ぶ',async()=>{
 await bookingSeriesApi.create('a/1',{friendId:'f',menuId:'m',startsAt:'2026-11-01T00:00:00Z',rule:{freq:'weekly',count:2}},'repeat-key');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/booking/admin/series?account_id=a%2F1',expect.objectContaining({headers:{'Idempotency-Key':'repeat-key'}}));
 await bookingAudienceApi.request('liff',{menu_id:'m',starts_at:'date',routingToken:'signed',addonIds:['addon']},'identity','same');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/liff/booking/requests?liffId=liff',expect.objectContaining({headers:{Authorization:'Bearer identity','Idempotency-Key':'same'},body:JSON.stringify({menu_id:'m',starts_at:'date',routingToken:'signed',addonIds:['addon']})}));
 await bookingMakeupApi.use('l','c','slot','identity','use-key');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/liff/events/makeup-credits/c/use?liffId=l',expect.objectContaining({headers:{Authorization:'Bearer identity','Idempotency-Key':'use-key'}}));
});
test('AB-05 AI-03 G4-01: 模擬の確認・返信案の非送信・端末登録のキー',async()=>{
 await broadcastAbApi.chooseMock('b','B',1920,'choose');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/broadcasts/b/ab-test/choose',expect.objectContaining({headers:{'Idempotency-Key':'choose','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({variant:'B',confirmedRecipientCount:1920,testMode:true})}));
 await aiDraftApi.draft('chat/1');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/chats/chat%2F1/ai/draft',expect.objectContaining({method:'POST'}));
 await formRoutingApi.preview('a','f',{question:'answer'});expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/forms/f/routing/preview?account_id=a',expect.objectContaining({method:'POST'}));
 await operatorPushApi.subscribe({endpoint:'https://push.example.test',keys:{p256dh:'key',auth:'auth'},label:'端末'},'device');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/me/push/subscriptions',expect.objectContaining({headers:{'Idempotency-Key':'device'}}));
});
test('A/B検証送信は全体とテスト宛先の人数・確認・同一キーを送る',async()=>{
 await broadcastAbApi.startLive('b',4,2400,20,'start');
 expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/broadcasts/b/send',expect.objectContaining({headers:{'Idempotency-Key':'start','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({expectedVersion:4,confirmedRecipientCount:2400,confirmedTestRecipientCount:20,liveMode:true})}));
 await broadcastAbApi.chooseLive('b','B',16,'choose');
 expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/broadcasts/b/ab-test/choose',expect.objectContaining({headers:{'Idempotency-Key':'choose','X-Confirm-Irreversible':'broadcast-send'},body:JSON.stringify({variant:'B',confirmedRecipientCount:16,liveMode:true})}));
});
