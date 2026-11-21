import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleCalendarClient, GoogleCalendarReadError } from './google-calendar.js';
const client = new GoogleCalendarClient({ calendarId: 'target', accessToken: 'test-token' });
afterEach(() => vi.unstubAllGlobals());
function response(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}
describe('顧客削除後の予定整理',()=>{
 it.each(['delete','redact'] as const)('%s は参加者が無い版だけを通知せず変更する',async action=>{
  const transport=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>init?.method?new Response(null,{status:204}):new Response(JSON.stringify({id:'event',etag:'"v1"',organizer:{self:true},attendees:[]})));
  const calendar=new GoogleCalendarClient({calendarId:'target',accessToken:'token',transport:transport as unknown as typeof fetch});
  expect(await calendar.cleanupEvent('event',action)).toBe('done');
  const [url,init]=transport.mock.calls[1];
  expect(String(url)).toContain('sendUpdates=none');expect((init?.headers as Record<string,string>)['If-Match']).toBe('"v1"');
  if(action==='redact')expect(JSON.parse(String(init?.body))).toEqual({summary:'予約',description:''});
 });
 it('参加者が省略されず存在しない予定は変更できる',async()=>{
  const transport=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>init?.method?new Response(null,{status:204}):new Response(JSON.stringify({id:'event',etag:'v',organizer:{self:true}})));
  const calendar=new GoogleCalendarClient({calendarId:'target',accessToken:'token',transport:transport as unknown as typeof fetch});
  expect(await calendar.cleanupEvent('event','redact')).toBe('done');expect(transport).toHaveBeenCalledTimes(2);
 });
 it('参加者あり・一覧が省略された・版不明・取消済みは外部へ変更しない',async()=>{
  for(const data of [{id:'event',etag:'v',organizer:{self:true},attendees:[{}]},{id:'event',etag:'v',organizer:{self:true},attendeesOmitted:true},{id:'event',organizer:{self:true},attendees:[]},{id:'event',status:'cancelled',etag:'v',organizer:{self:true},attendees:[]}]){
   const transport=vi.fn(async()=>new Response(JSON.stringify(data)));
   const calendar=new GoogleCalendarClient({calendarId:'target',accessToken:'token',transport:transport as unknown as typeof fetch});
   expect(await calendar.cleanupEvent('event','redact')).toBe('review');expect(transport).toHaveBeenCalledTimes(1);
  }
 });
});
describe('FreeBusyの取得結果', () => {
  it.each([
    {}, { calendars: {} }, { calendars: { other: { busy: [] } } },
    { calendars: { target: { errors: [{ reason: 'notFound' }], busy: [] } } },
    { calendars: { target: {} } }, { calendars: { target: { busy: null } } },
    { calendars: { target: { busy: [{ start: 'bad', end: 'bad' }] } } },
    { calendars: { target: { busy: [{ start: '2026-10-08T02:00:00Z', end: '2026-10-08T01:00:00Z' }] } } },
  ])('未取得・部分的な失敗・壊れた区間を予定なしにしない: %j', async body => {
    response(body);
    await expect(client.getFreeBusy('2026-10-08T00:00:00Z', '2026-10-09T00:00:00Z'))
      .rejects.toBeInstanceOf(GoogleCalendarReadError);
  });
  it('予定なしは確認済みの空配列だけを返す', async () => {
    response({ calendars: { target: { errors: [], busy: [] } } });
    await expect(client.getFreeBusy('from', 'to')).resolves.toEqual([]);
  });
  it('正常な区間は返し、HTTPエラーには外部の本文を含めない', async () => {
    const busy = [{ start: '2026-10-08T01:00:00Z', end: '2026-10-08T02:00:00Z' }];
    response({ calendars: { target: { busy } } });
    await expect(client.getFreeBusy('from', 'to')).resolves.toEqual(busy);
    response({ secret: 'private-calendar-info' }, 403);
    await expect(client.getFreeBusy('from', 'to')).rejects.toMatchObject({ status: 403, message: 'calendar_read_failed' });
  });
});
