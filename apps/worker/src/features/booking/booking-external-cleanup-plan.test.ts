import {expect,it} from 'vitest';
import {planExternalCleanup} from './booking-external-cleanup-plan.js';

it('現在の予定から外れた作成済みの旧版も、個人情報を含む可能性があるので後片づけに残す', () => {
 const old=(id:string,start:string)=>({process_kind:'booking_calendar_create',status:'succeeded',input_json:JSON.stringify({snapshot:{connectionId:'conn',calendarId:'calendar',event:{id,start,summary:'顧客名',description:'予約ID'}}})});
 const result=planExternalCleanup({now:Date.parse('2031-01-01T00:00:00Z'),booking:{staff_id:'staff'},meetings:[],workflows:[old('past','2030-01-01T00:00:00Z'),old('future','2032-01-01T00:00:00Z')]});
 expect(result).toEqual([
  expect.objectContaining({provider:'google_calendar',remoteId:'past',calendarId:'calendar',connectionId:'conn',action:'redact'}),
  expect.objectContaining({provider:'google_calendar',remoteId:'future',calendarId:'calendar',connectionId:'conn',action:'delete'}),
 ]);
 expect(JSON.stringify(result)).not.toMatch(/顧客名|予約ID/);
});

it('旧担当者の接続で作った予定を元の担当者へ割り当て、旧版の削除成功も確認する', () => {
 const create=(id:string)=>({process_kind:'booking_calendar_create',status:'succeeded',input_json:JSON.stringify({snapshot:{connectionId:'old-connection',calendarId:'calendar',event:{id,start:'2032-01-01T00:00:00Z'}}})});
 const removed={process_kind:'booking_calendar_delete',status:'succeeded',input_json:JSON.stringify({snapshot:{eventId:'removed',calendarId:'calendar'},identity:{scope:{connectionId:'old-connection'}}})};
 const result=planExternalCleanup({now:0,booking:{staff_id:'new-staff',external_event_id:'current',external_calendar_id:'calendar'},meetings:[],workflows:[create('current'),create('old'),create('removed'),removed],calendarStaff:{'old-connection':'old-staff'}});
 expect(result.map(item=>[item.remoteId,item.staffId,item.action])).toEqual([['current','old-staff','delete'],['old','old-staff','delete'],['removed','old-staff','review']]);
 expect(result[2]).toMatchObject({uncertainty:'delete'});
 const missing=planExternalCleanup({now:0,booking:{staff_id:'new-staff',external_event_id:'current',external_calendar_id:'calendar'},meetings:[],workflows:[create('current')],calendarStaff:{}});
 expect(missing[0]).toMatchObject({staffId:'',action:'review'});
});

it('同じ予定IDと primary でも別の接続なら別々に確認する', () => {
 const create=(connectionId:string)=>({process_kind:'booking_calendar_create',status:'succeeded',input_json:JSON.stringify({snapshot:{connectionId,calendarId:'primary',event:{id:'same',start:'2032-01-01T00:00:00Z'}}})});
 const result=planExternalCleanup({now:0,booking:{staff_id:'s',external_event_id:'same',external_calendar_id:'primary'},meetings:[],workflows:[create('one'),create('two')],calendarStaff:{one:'s1',two:'s2'}});
 expect(result.map(item=>[item.connectionId,item.staffId])).toEqual([['one','s1'],['two','s2']]);
});

it('同じ予定の削除結果が複数不明なら1件にまとめ、勝手に再削除しない', () => {
 const create={process_kind:'booking_calendar_create',status:'succeeded',input_json:JSON.stringify({snapshot:{connectionId:'conn',calendarId:'c',event:{id:'event',start:'2032-01-01T00:00:00Z'}}})};
 const del={process_kind:'booking_calendar_delete',status:'unknown',input_json:JSON.stringify({snapshot:{eventId:'event',calendarId:'c'},identity:{scope:{connectionId:'conn'}}})};
 const result=planExternalCleanup({now:0,booking:{staff_id:'s',external_event_id:'event',external_calendar_id:'c'},meetings:[],workflows:[create,del,del]});
 expect(result).toHaveLength(1);
 expect(result[0]).toMatchObject({remoteId:'event',action:'review',uncertainty:'delete'});
});

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
