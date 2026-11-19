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
