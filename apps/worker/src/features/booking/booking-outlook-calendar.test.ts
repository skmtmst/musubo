import {expect,it,vi} from 'vitest';
import {outlookCalendar} from './booking-outlook-calendar.js';
const input={staffId:'s',start:'2026-12-01T00:00:00Z',end:'2026-12-02T00:00:00Z',ownEventIds:['own'],signal:new AbortController().signal};
const event=(id:string,showAs='busy',isAllDay=false)=>({id,showAs,isAllDay,start:{dateTime:'2026-12-01T01:00:00.0000000',timeZone:'UTC'},end:{dateTime:'2026-12-01T02:00:00.0000000',timeZone:'UTC'}});
it('空き枠の取得は必要な欄だけ読み、終日・空き・自分の予約は除く',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({value:[event('busy'),event('own'),event('free','free'),event('day','busy',true)]}))) as unknown as typeof fetch;
 const result=await outlookCalendar(async()=> 'token',fetcher).busy(input);
 expect(result).toEqual([{eventId:'busy',start:'2026-12-01T01:00:00.000Z',end:'2026-12-01T02:00:00.000Z'}]);
 const [url,init]=vi.mocked(fetcher).mock.calls[0];expect(decodeURIComponent(String(url))).toContain('$select=id,start,end,showAs,isAllDay');
 expect((init?.headers as Record<string,string>).Prefer).toContain('IdType="ImmutableId"');
 expect(String(url)).not.toContain('token');
});
it('外部サービスが読めない場合は空きとして扱わない',async()=>{
 const fetcher=vi.fn(async()=>new Response('',{status:503})) as unknown as typeof fetch;
 await expect(outlookCalendar(async()=> 'token',fetcher).busy(input)).rejects.toThrow('outlook_calendar_unavailable');
});
it('別のサーバーへの続きURLは読み込まない',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({value:[],'@odata.nextLink':'https://example.test/steal'}))) as unknown as typeof fetch;
 await expect(outlookCalendar(async()=> 'token',fetcher).busy(input)).rejects.toThrow('outlook_calendar_unavailable');
 expect(fetcher).toHaveBeenCalledOnce();
});

it('未知の予定状態は安全のため予定ありとして扱う',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({value:[event('x','unknown')]}))) as unknown as typeof fetch;
 expect(await outlookCalendar(async()=> 'token',fetcher).busy(input)).toHaveLength(1);
});
it('予約の予定は一意の取引IDで作り、参加者を含めない',async()=>{
 const fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({id:'immutable-id'}),{status:201}));
 const calendar=outlookCalendar(async()=> 'token',fetcher as unknown as typeof fetch);
 const result=await calendar.create({staffId:'s',calendarId:'calendar',start:input.start,end:input.end,title:'予約',description:'管理画面で確認',transactionId:'stable-transaction',signal:input.signal});
 expect(result).toEqual({kind:'created',eventId:'immutable-id'});
 const [,options]=fetcher.mock.calls[0];const body=JSON.parse(String(options?.body)) as Record<string,unknown>;
 expect(body.transactionId).toBe('stable-transaction');expect(body.start).toEqual({dateTime:'2026-12-01T00:00:00.000',timeZone:'UTC'});expect(body).not.toHaveProperty('attendees');expect((options?.headers as Record<string,string>).Prefer).toContain('ImmutableId');
});
it('作成中の通信断は結果不明として自動再送しない',async()=>{
 const fetcher=vi.fn(async()=>{throw new Error('network')}) as unknown as typeof fetch;
 const result=await outlookCalendar(async()=> 'token',fetcher).create({staffId:'s',calendarId:'calendar',start:input.start,end:input.end,title:'予約',description:'',transactionId:'stable',signal:input.signal});
 expect(result).toEqual({kind:'unknown'});expect(fetcher).toHaveBeenCalledOnce();
});
it('予定の変更・取消は明示設定と同じ主催者を要し、参加者に通知を送らない',async()=>{
 const fetcher=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>init?.method?new Response(null,{status:204}):new Response(JSON.stringify({id:'event',isOrganizer:true,attendees:[], '@odata.etag':'"version-1"'})));
 const token=async()=>({token:'token',accountId:'owner'});
 const base={staffId:'s',accountId:'owner',eventId:'event',signal:input.signal};
 expect(await outlookCalendar(token,fetcher as typeof fetch).mutate({...base,action:'delete'})).toBe('failed');expect(fetcher).not.toHaveBeenCalled();
 const calendar=outlookCalendar(token,fetcher as typeof fetch,{allowMutations:true});
 expect(await calendar.mutate({...base,action:'update',start:input.start,end:input.end})).toBe('done');
 const [,patch]=fetcher.mock.calls[1];expect(patch?.method).toBe('PATCH');expect(JSON.parse(String(patch?.body))).not.toHaveProperty('attendees');expect((patch?.headers as Record<string,string>)['If-Match']).toBe('"version-1"');
 expect(await calendar.mutate({...base,action:'delete'})).toBe('done');expect(fetcher.mock.calls[3][1]?.method).toBe('DELETE');
 expect(await calendar.mutate({...base,accountId:'different',action:'delete'})).toBe('failed');expect(fetcher).toHaveBeenCalledTimes(4);
});
it('予定に参加者がいれば通知を防ぐため変更・取消を送らない',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:'event',isOrganizer:true,attendees:[{emailAddress:{address:'customer@example.test'}}], '@odata.etag':'"v1"'})));
 const calendar=outlookCalendar(async()=>({token:'token',accountId:'owner'}),fetcher as typeof fetch,{allowMutations:true});
 expect(await calendar.mutate({staffId:'s',accountId:'owner',eventId:'event',action:'delete',signal:input.signal})).toBe('failed');expect(fetcher).toHaveBeenCalledOnce();
});

it('予定の作成に使った Microsoft アカウントの識別子を一緒に返す',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:'event'}),{status:201}));
 const calendar=outlookCalendar(async()=>({token:'token',accountId:'owner'}),fetcher as typeof fetch);
 expect(await calendar.create({staffId:'s',calendarId:'calendar',start:input.start,end:input.end,title:'予約',description:'',transactionId:'key',signal:input.signal})).toEqual({kind:'created',eventId:'event',accountId:'owner'});
});
it('送信直前にスイッチが戻ったときは取消を送らない',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:'event',isOrganizer:true,attendees:[],'@odata.etag':'"v1"'})));
 const calendar=outlookCalendar(async()=>({token:'token',accountId:'owner'}),fetcher as typeof fetch,{allowMutations:true});
 expect(await calendar.mutate({staffId:'s',accountId:'owner',eventId:'event',action:'delete',signal:input.signal,authorize:async()=>false})).toBe('failed');
 expect(fetcher).toHaveBeenCalledOnce();
});
