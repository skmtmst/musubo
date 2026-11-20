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
it('Zoom の一覧と詳細を読み、完全一致した会議だけを照合する',async()=>{
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  expect(init?.method).toBe('GET');
  const u=new URL(String(url));
  if(u.pathname==='/v2/users/me/meetings')return new Response(JSON.stringify(u.searchParams.has('next_page_token')
   ?{meetings:[{id:123,agenda:'key'}],next_page_token:''}
   :{meetings:[{id:456,agenda:'other'}],next_page_token:'next'}));
  expect(u.pathname).toBe('/v2/meetings/123');
  return new Response(JSON.stringify({id:123,agenda:'key',join_url:'https://us02web.zoom.us/j/123'}));
 });
 const verifier=meetingProvider('zoom',async()=>({token:'test-token',accountId:'owner'}),request as unknown as typeof fetch);
 expect(await verifier.verifyCreate({staffId:'s',idempotencyKey:'key',signal:input.signal})).toEqual({kind:'found',meetingId:JSON.stringify(['owner','123']),url:'https://us02web.zoom.us/j/123',idempotencyKey:'key'});
 expect(request).toHaveBeenCalledTimes(3);
});
it('Zoom で未発見、複数一致、詳細の不一致、ページング不能なら要確認にする',async()=>{
 for(const kind of ['empty','multiple','mismatch','page'] as const){
  const request=vi.fn(async(url:RequestInfo|URL)=>{
   if(new URL(String(url)).pathname==='/v2/users/me/meetings')return new Response(JSON.stringify(kind==='empty'?{meetings:[]}:kind==='page'?{meetings:[],next_page_token:'same'}:{meetings:kind==='multiple'?[{id:1,agenda:'key'},{id:2,agenda:'key'}]:[{id:1,agenda:'key'}]}));
   const id=Number(new URL(String(url)).pathname.split('/').pop());
   return new Response(JSON.stringify({id,agenda:kind==='mismatch'?'other':'key',join_url:`https://zoom.us/j/${id}`}));
  });
  expect(await meetingProvider('zoom',async()=>({token:'t',accountId:'owner'}),request as unknown as typeof fetch).verifyCreate({staffId:'s',idempotencyKey:'key',signal:input.signal})).toEqual({kind:kind==='empty'?'absent':'unknown'});
  expect(request.mock.calls.every(call=>String(call[0]).startsWith('https://api.zoom.us/'))).toBe(true);
 }
});
it('Teams の結果不明では自動作成せず要確認にする',async()=>{
 const request=vi.fn() as unknown as typeof fetch;
 expect(await meetingProvider('teams',async()=>({token:'t',accountId:'owner'}),request).verifyCreate({staffId:'s',idempotencyKey:'key',signal:input.signal})).toEqual({kind:'unknown'});
 expect(request).not.toHaveBeenCalled();
});
it('Zoom の一覧と詳細の間で別アカウントに切り替わると照合しない',async()=>{
 let calls=0;
 const token=async()=>({token:'t',accountId:++calls===1?'first':'second'});
 const request=vi.fn(async()=>new Response(JSON.stringify({meetings:[{id:123,agenda:'key'}],next_page_token:''})));
 expect(await meetingProvider('zoom',token,request as unknown as typeof fetch).verifyCreate({staffId:'s',idempotencyKey:'key',signal:input.signal})).toEqual({kind:'unknown'});
 expect(request).toHaveBeenCalledOnce();
});
