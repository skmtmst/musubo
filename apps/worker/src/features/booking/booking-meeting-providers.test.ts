import {expect,it,vi} from 'vitest';
import {meetingProvider} from './booking-meeting-providers.js';
import type {MeetingProvider} from './booking-meeting-create.js';
const input={bookingId:'b',idempotencyKey:'key',startsAt:'2026-12-01T01:00:00Z',endsAt:'2026-12-01T02:00:00Z',staffId:'s',signal:new AbortController().signal};
it.each<[MeetingProvider,Record<string,unknown>]>([
 ['google_meet',{id:'event',hangoutLink:'https://meet.google.com/abc'}],
 ['zoom',{id:123,join_url:'https://zoom.us/j/123'}],
 ['teams',{id:'event',joinWebUrl:'https://teams.microsoft.com/l/meetup-join/test'}],
])('%s の作成を模擬する',async(provider,data)=>{
 const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{const sent=JSON.parse(String(init?.body??'{}')) as {id?:string};return new Response(JSON.stringify(provider==='google_meet'?{...data,id:sent.id}:data),{status:200});}) as unknown as typeof fetch;
 const adapter=meetingProvider(provider,async()=> ({token:'test-token',accountId:'owner'}),request);
 expect(await adapter.create(input)).toMatchObject({kind:'created'});
 expect(request).toHaveBeenCalledOnce();
});
it('鍵が無いと外部通信せず、失敗を返す',async()=>{
 const request=vi.fn() as unknown as typeof fetch;
 expect(await meetingProvider('zoom',async()=>null,request).create(input)).toEqual({kind:'failed',code:'not_connected'});
 expect(request).not.toHaveBeenCalled();
});
it('通信失敗は結果不明とし、自動再送しない',async()=>{
 const request=vi.fn(async()=>{throw new Error('timeout')}) as unknown as typeof fetch;
 expect(await meetingProvider('zoom',async()=> ({token:'test-token',accountId:'owner'}),request).create(input)).toEqual({kind:'unknown'});
 expect(request).toHaveBeenCalledOnce();
});
it('削除済みの会議は削除成功と扱う',async()=>{
 const request=vi.fn(async()=>new Response(null,{status:404})) as unknown as typeof fetch;
 expect(await meetingProvider('teams',async()=> ({token:'test-token',accountId:'owner'}),request).remove({staffId:'s',meetingId:JSON.stringify(['owner','m']),idempotencyKey:'delete',signal:input.signal})).toBe('deleted');
});
it('相手先と異なる会議URLは発行済みとしない',async()=>{
 const request=vi.fn(async()=>new Response(JSON.stringify({id:'123',join_url:'https://example.test/room'}))) as unknown as typeof fetch;
 expect(await meetingProvider('zoom',async()=> ({token:'test-token',accountId:'owner'}),request).create(input)).toEqual({kind:'unknown'});
});
it('Google の会議は一意の目印が一致した場合だけ照合する',async()=>{
 let savedId='';
 const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
  if(init?.method==='POST') {const body=JSON.parse(String(init.body)) as {id:string};savedId=body.id;return new Response(JSON.stringify({id:savedId,hangoutLink:'https://meet.google.com/test'}));}
  return new Response(JSON.stringify({id:savedId,hangoutLink:'https://meet.google.com/test',extendedProperties:{private:{bookingKey:'key'}}}));
 }) as unknown as typeof fetch;
 const provider=meetingProvider('google_meet',async()=> ({token:'test-token',accountId:'owner'}),request);
 await provider.create(input);
 expect(await provider.verifyCreate({staffId:'s',idempotencyKey:'key',signal:input.signal})).toMatchObject({kind:'found',idempotencyKey:'key'});
 expect(await provider.verifyCreate({staffId:'s',idempotencyKey:'other',signal:input.signal})).toEqual({kind:'unknown'});
});
it('別アカウントへの再接続後は元の会議を削除済みと判定しない',async()=>{
 const request=vi.fn() as unknown as typeof fetch;
 const provider=meetingProvider('zoom',async()=>({token:'test-token',accountId:'new-owner'}),request);
 const meetingId=JSON.stringify(['old-owner','123']);
 expect(await provider.remove({staffId:'s',meetingId,idempotencyKey:'delete',signal:input.signal})).toBe('failed');
 expect(await provider.verifyDelete({staffId:'s',meetingId,signal:input.signal})).toBe('unknown');
 expect(request).not.toHaveBeenCalled();
});
it('Google 会議には招待者や顧客情報を入れず、予定を空き扱いにする',async()=>{
 const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{const data=JSON.parse(String(init?.body)) as {id:string};return new Response(JSON.stringify({id:data.id,hangoutLink:'https://meet.google.com/test'}));});
 await meetingProvider('google_meet',async()=>({token:'test-token',accountId:'owner'}),request as unknown as typeof fetch).create(input);
 const [url,init]=request.mock.calls[0];const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
 expect(String(url)).toContain('sendUpdates=none');expect(body.transparency).toBe('transparent');
 expect(body).not.toHaveProperty('attendees');expect(body).not.toHaveProperty('participants');expect(JSON.stringify(body)).not.toContain('customer');
 expect(JSON.stringify(body)).toContain(input.idempotencyKey);
});
