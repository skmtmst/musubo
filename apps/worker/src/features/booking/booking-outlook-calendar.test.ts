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
