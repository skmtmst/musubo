import {expect,it} from 'vitest';
import {planExternalCleanup} from './booking-external-cleanup-plan.js';

it('将来の対象を選び、顧客情報と会議URLを含めない',()=>{
 const result=planExternalCleanup({now:0,booking:{id:'booking',friend_id:'customer',customer_note:'private',staff_id:'staff',starts_at:'2030-01-01T00:00:00Z',external_event_id:'google-event',external_calendar_id:'calendar'},meetings:[{provider:'zoom',status:'active',staff_id:'staff',starts_at:'2030-01-01T00:00:00Z',external_meeting_id:'remote',meeting_url:'https://secret.test'}],workflows:[{process_kind:'booking_calendar_create',status:'succeeded',input_json:JSON.stringify({snapshot:{connectionId:'connection',calendarId:'calendar',event:{id:'google-event',start:'2030-01-01T00:00:00Z',summary:'private'}}})},{process_kind:'booking_outlook_sync',status:'succeeded',result_json:JSON.stringify({eventId:'outlook-event',accountId:'owner',staffId:'staff',startsAt:'2030-01-01T00:00:00Z',customerName:'private'})}]});
 expect(result.map(x=>[x.provider,x.action])).toEqual([['google_calendar','delete'],['zoom','delete'],['outlook','delete']]);
 expect(JSON.stringify(result)).not.toMatch(/customer|private|secret|booking/);
});
it('過去のGoogleだけを匿名化対象とし、結果不明は要確認にする',()=>{
 const past=planExternalCleanup({now:Date.parse('2031-01-01'),booking:{staff_id:'s',starts_at:'2030-01-01',external_event_id:'e',external_calendar_id:'c'},meetings:[{provider:'zoom',status:'active',starts_at:'2030-01-01',external_meeting_id:'z'}],workflows:[{process_kind:'booking_calendar_create',status:'succeeded',input_json:JSON.stringify({snapshot:{connectionId:'conn',calendarId:'c',event:{id:'e',start:'2030-01-01'}}})}]});
 expect(past).toEqual([{provider:'google_calendar',action:'redact',staffId:'s',remoteId:'e',calendarId:'c',connectionId:'conn',startsAt:'2030-01-01T00:00:00.000Z'}]);
 const unknown=planExternalCleanup({now:0,booking:{staff_id:'s',starts_at:'2030-01-01'},meetings:[{provider:'teams',status:'pending',attempt_count:1,idempotency_key:'marker'}],workflows:[]});
 expect(unknown).toEqual([{provider:'teams',action:'review',staffId:'s',marker:'marker',uncertainty:'create'}]);
});
it('照合先が分からない予定は推測で操作しない',()=>{
 const result=planExternalCleanup({now:0,booking:{staff_id:'s',starts_at:'2030-01-01',external_event_id:'google-event',external_calendar_id:'calendar'},meetings:[],workflows:[{process_kind:'booking_calendar_create',status:'unknown',input_json:'broken'},{process_kind:'booking_outlook_sync',status:'unknown',result_json:'{"eventId":"event"}'}]});
 expect(result).toEqual([
  {provider:'google_calendar',action:'review',staffId:'s',remoteId:'google-event',calendarId:'calendar'},
  {provider:'google_calendar',action:'review',staffId:'s',uncertainty:'create'},
  {provider:'outlook',action:'review',staffId:'s',remoteId:'event'},
 ]);
});
it('予約の日時が変わっても残った外部予定の日時を使う',()=>{
 const result=planExternalCleanup({now:Date.parse('2031-01-01'),booking:{staff_id:'s',starts_at:'2030-01-01'},meetings:[{provider:'zoom',status:'cancel_pending',external_meeting_id:'remote',starts_at:'2032-01-01'}],workflows:[{process_kind:'booking_outlook_sync',status:'succeeded',result_json:JSON.stringify({eventId:'event',accountId:'owner',staffId:'s',startsAt:'2032-01-01'})}]});
 expect(result.map(x=>[x.provider,x.action])).toEqual([['zoom','delete'],['outlook','delete']]);
});
it('作成結果が不明な Google 予定はIDがあっても要確認にする',()=>{
 const result=planExternalCleanup({now:0,booking:{staff_id:'s',external_event_id:'e',external_calendar_id:'c'},meetings:[],workflows:[{process_kind:'booking_calendar_create',status:'unknown',input_json:JSON.stringify({snapshot:{connectionId:'conn',calendarId:'c',event:{id:'e',start:'2030-01-01'}}})}]});
 expect(result).toEqual([{provider:'google_calendar',action:'review',staffId:'s',remoteId:'e',calendarId:'c',connectionId:'conn',uncertainty:'create',startsAt:'2030-01-01T00:00:00.000Z'}]);
});
it('結果不明の Google 予定削除も参照を残して要確認にする',()=>{
 const row={process_kind:'booking_calendar_delete',status:'unknown',input_json:JSON.stringify({snapshot:{eventId:'old-event',calendarId:'c'},identity:{scope:{connectionId:'conn'}}})};
 expect(planExternalCleanup({now:0,booking:{staff_id:'s'},meetings:[],workflows:[row]})).toEqual([{provider:'google_calendar',action:'review',staffId:'s',uncertainty:'delete',remoteId:'old-event',calendarId:'c',connectionId:'conn'}]);
});
