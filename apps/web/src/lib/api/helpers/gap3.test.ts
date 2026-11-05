import {beforeEach,expect,test,vi} from 'vitest';
const transport=vi.hoisted(()=>({fetchApi:vi.fn(async()=>({success:true,data:{}}))}));
vi.mock('../../api',()=>transport);
import {gap3InboxApi,gap3BookingApi,customerSegmentsApi,memberRanksApi,storeComparisonApi,ecAutoLineApi,bookingPassPlansApi,gap3AiApi,mcpConnectionsApi,broadcastSimulationApi} from './gap3';
beforeEach(()=>transport.fetchApi.mockClear());
test('GAP3-CLIENT-01: 店ID・ページ条件・本人token・同じキーを正しい口へ運ぶ',async()=>{
 await customerSegmentsApi.friends('a/1',1,5,'purchase','amount','20');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/analytics/customer-segments/cells/1/5/friends?account_id=a%2F1&basis=purchase&measure=amount&cursor=20');
 await gap3InboxApi.icons('a/1');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/line-accounts/a%2F1/sender-icons?offset=0');
 await memberRanksApi.activate('a',2,'activate-key');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/member-ranks/activate?account_id=a',expect.objectContaining({headers:{'Idempotency-Key':'activate-key'},body:JSON.stringify({expectedVersion:2})}));
 await bookingPassPlansApi.grant('a','plan','f','店頭払い','grant-key');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/booking/admin/entitlements?account_id=a',expect.objectContaining({headers:{'Idempotency-Key':'grant-key'},body:JSON.stringify({planId:'plan',friendId:'f',reason:'店頭払い'})}));
 await gap3BookingApi.request('l','identity',{starts_at:'date',members:[{menuId:'m'},{menuId:'m2'}],routing_token:'signed'},'same');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/liff/booking/requests?liffId=l',expect.objectContaining({headers:{Authorization:'Bearer identity','Idempotency-Key':'same'}}));
});
test('GAP3-CLIENT-02: 模擬の起動確認・再認証と停止理由、QA記録の詳細',async()=>{
 await ecAutoLineApi.enableMock('a','cart',1,'enable-key');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/ec/auto-line/rules/cart/enable?account_id=a',expect.objectContaining({headers:{'Idempotency-Key':'enable-key'},body:JSON.stringify({expectedVersion:1,enabled:true,confirmed:true,testMode:true})}));
 await mcpConnectionsApi.rotate('a','c/1',1,'step-up');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/mcp-connections/c%2F1/rotate?account_id=a',expect.objectContaining({headers:{'X-Step-Up-Token':'step-up'}}));
 await mcpConnectionsApi.stop('a','c',2,'緊急停止');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/mcp-connections/c/stop?account_id=a',expect.objectContaining({body:JSON.stringify({expectedVersion:2,reason:'緊急停止'})}));
 await gap3AiApi.log('a','log/1');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/ai-answer-logs/log%2F1?account_id=a');
 await storeComparisonApi.get({compare:'average',pageSize:50});expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/hq/store-comparison?compare=average&pageSize=50');
});

test('GAP3-CLIENT-03: G2とECの模擬は必ず試験指定・本人確認・同じキー、店比較のプール',async()=>{
 await gap3AiApi.enableSimulation('a',2,'step-up');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/ai-settings?account_id=a',expect.objectContaining({method:'PUT',headers:{'X-Step-Up-Token':'step-up'},body:JSON.stringify({mode:'auto_qa',expectedVersion:2,confirmed:true,testMode:true})}));
 await gap3AiApi.simulate('a',{chatId:'chat',question:'駐車場'},'same');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/ai-settings/simulate?account_id=a',expect.objectContaining({headers:{'Idempotency-Key':'same'},body:JSON.stringify({chatId:'chat',question:'駐車場',testMode:true})}));
 await gap3AiApi.typing('chat/1',false);expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/chats/chat%2F1/ai/typing',expect.objectContaining({body:'{"typing":false}'}));
 await ecAutoLineApi.simulate('a');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/ec/auto-line/simulate?account_id=a',expect.objectContaining({body:'{"testMode":true}'}));
 await storeComparisonApi.get({poolId:'p/1',compare:'average'});expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/hq/store-comparison?poolId=p%2F1&compare=average');
});

test('GAP3-CLIENT-04: 後続APIも店・本人・試験指定・同じキーと版を渡す',async()=>{
 await storeComparisonApi.export({poolId:'pool',compare:'average'},'export');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/hq/store-comparison/export',expect.objectContaining({headers:{'Idempotency-Key':'export'},body:'{"poolId":"pool","compare":"average"}'}));
 await memberRanksApi.simulateNotices('a');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/member-ranks/notices/simulate?account_id=a',expect.objectContaining({body:'{"testMode":true}'}));
 await bookingPassPlansApi.checkout('liff','identity','p/1','same');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/liff/booking/pass-plans/p%2F1/checkout?liffId=liff',expect.objectContaining({headers:{Authorization:'Bearer identity','Idempotency-Key':'same'},body:'{"testMode":true}'}));
 await broadcastSimulationApi.send('a','b/1',{expectedVersion:2,confirmedRecipientCount:3},'send');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/broadcasts/b%2F1/simulate-send?account_id=a',expect.objectContaining({headers:{'Idempotency-Key':'send'},body:'{"expectedVersion":2,"confirmedRecipientCount":3,"testMode":true}'}));
});

 test('B354/B349: AI同意と既存形式の友だち絞り込みをそのまま渡す',async()=>{
 const {accountAiFeaturesApi,memberActivityFriendsApi}=await import('./gap3');
 await accountAiFeaturesApi.save('a','banner',{enabled:true,expectedVersion:0,consent:true,disclosureVersion:'2026-10-16'},'step-up-grant');
 expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/ai-features/banner?account_id=a',expect.objectContaining({method:'PUT',headers:{'X-Step-Up-Token':'step-up-grant'},body:JSON.stringify({enabled:true,expectedVersion:0,consent:true,disclosureVersion:'2026-10-16'})}));
 const conditions={all:[{kind:'visit_count' as const,op:'between',value:{min:5}}]};await memberActivityFriendsApi.list('a',conditions);
 expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/friends?lineAccountId=a&conditions='+encodeURIComponent(JSON.stringify(conditions)));
 });

test('回数券の種類とページを API に渡し、省略時は従来の全種類を取得する',async()=>{
 await bookingPassPlansApi.list('a','ヨガ',20,20,'monthly');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/booking/admin/pass-plans?account_id=a&q=%E3%83%A8%E3%82%AC&offset=20&limit=20&kind=monthly');
 await bookingPassPlansApi.list('a');expect(transport.fetchApi).toHaveBeenLastCalledWith('/api/booking/admin/pass-plans?account_id=a&q=&offset=0&limit=20');
});
