import {fetchApi} from '../../api';
import type {EventMakeupRule} from '../types/events';
import type {SeriesInput,SeriesOccurrence,Gap2Booking,Gap2Series,BookingAudienceWrite,BookingRouting,FormLayout,MakeupCredit,QaEntry,QaEntryWrite,AiSummary,AiReplyDraft} from '@line-crm/shared';
type Result<T>={success:true;data:T};
const e=encodeURIComponent;
const account=(path:string,id:string)=>`${path}?account_id=${e(id)}`;
const json=(method:string,body:unknown,key?:string)=>({method,body:JSON.stringify(body),...(key?{headers:{'Idempotency-Key':key}}:{})});
const liff=(path:string,id:string)=>`${path}?liffId=${e(id)}`;
const bearer=(token:string,key?:string)=>({Authorization:`Bearer ${token}`,...(key?{'Idempotency-Key':key}:{})});
export interface Gap2MenuWrite {name:string;duration_minutes:number;base_price:number;expectedVersion?:number;description?:string|null;is_active?:boolean;audienceMode?:BookingAudienceWrite['audienceMode'];audienceTagIds?:string[];addonMenuIds?:string[];addonOnly?:boolean;maxPartySize?:1|2|3|4|5|6;recurring?:{enabled:boolean;freqs:Array<'weekly'|'biweekly'|'monthly_nth'>;maxCount:number}}
export const bookingAudienceApi={
 previewAs:(accountId:string,friendId:string)=>fetchApi<Result<Array<{id:string;name:string;visible:boolean;reason:string|null}>>>(account('/api/booking/admin/menus/preview-as',accountId)+`&friend_id=${e(friendId)}`),
 createMenu:(accountId:string,input:Gap2MenuWrite,key:string)=>fetchApi<{id:string;version:number}>(account('/api/booking/admin/menus',accountId),json('POST',input,key)),
 saveMenu:(accountId:string,id:string,input:Gap2MenuWrite&{expectedVersion:number})=>fetchApi<{ok:true;version:number}>(account(`/api/booking/admin/menus/${e(id)}`,accountId),json('PUT',input)),
 saveNominationFee:(accountId:string,staffId:string,nominationFee:number)=>fetchApi<{ok:true}>(account(`/api/booking/admin/staff/${e(staffId)}`,accountId),json('PUT',{nominationFee})),
 addons:(liffId:string,menuId:string,token:string)=>fetchApi<Result<Array<{id:string;name:string;duration_minutes:number;base_price:number}>>>(liff(`/api/liff/booking/menus/${e(menuId)}/addons`,liffId),{headers:bearer(token)}),
 request:(liffId:string,input:{menu_id:string;staff_id?:string;starts_at:string;addonIds?:string[];routingToken?:string;meeting_mode?:'online'|'in_person';customer_note?:string},token:string,key:string)=>fetchApi<{booking_id:string;status:string}>(liff('/api/liff/booking/requests',liffId),{...json('POST',input),headers:bearer(token,key)}),
};
export const bookingSeriesApi={
 preview:(a:string,input:SeriesInput)=>fetchApi<Result<{occurrences:SeriesOccurrence[]}>>(account('/api/booking/admin/series/preview',a),json('POST',input)),
 create:(a:string,input:SeriesInput,key:string)=>fetchApi<Result<{series:Gap2Series;bookings:Gap2Booking[];skipped:SeriesOccurrence[]}>>(account('/api/booking/admin/series',a),json('POST',input,key)),
 get:(a:string,id:string)=>fetchApi<Result<{series:Gap2Series;bookings:Gap2Booking[]}>>(account(`/api/booking/admin/series/${e(id)}`,a)),
 change:(a:string,id:string,input:{scope:'this'|'following';fromBookingId:string;expectedVersion:number;change:{startsAt?:string;staffId?:string}})=>fetchApi<Result<{changed:string[];conflicts:string[];version:number}>>(account(`/api/booking/admin/series/${e(id)}`,a),json('PATCH',input)),
 cancel:(a:string,id:string,input:{scope:'this'|'following';fromBookingId:string;expectedVersion:number;reason?:string})=>fetchApi<Result<{cancelled:string[];fees:Array<{bookingId:string;feeNow:number}>;version:number}>>(account(`/api/booking/admin/series/${e(id)}/cancel`,a),json('POST',input)),
};
export const formRoutingApi={
 targets:(a:string,id:string)=>fetchApi<Result<{menus:Array<{id:string;name:string;durationMinutes:number}>;staff:Array<{id:string;name:string;menuId:string}>;groups:Array<{id:string;name:string}>}>>(account(`/api/forms/${e(id)}/routing/targets`,a)),
 saveLayout:(a:string,id:string,layout:FormLayout,expectedContentRevision:number)=>fetchApi<unknown>(account(`/api/forms/${e(id)}`,a),json('PUT',{layout,expectedContentRevision})),
 preview:(a:string,id:string,answers:Record<string,unknown>,blockId?:string,layout?:FormLayout)=>fetchApi<Result<{matchedIndex:number;target:BookingRouting['fallback'];usable:boolean;fellBack:boolean}>>(account(`/api/forms/${e(id)}/routing/preview`,a),json('POST',{answers,blockId,...(layout ? {layout} : {})})),
 resolve:(liffId:string,id:string,answers:Record<string,unknown>,token:string,blockId?:string)=>fetchApi<Result<{matchedIndex:number;target:BookingRouting['fallback'];routingToken:string;expiresAt:string}>>(liff(`/api/liff/forms/${e(id)}/routing/resolve`,liffId),{...json('POST',{answers,blockId}),headers:bearer(token)}),
 groups:(a:string)=>fetchApi<Result<Array<{id:string;name:string;staff_ids_json:string;version:number}>>>(account('/api/booking/admin/routing-staff-groups',a)),
 saveGroup:(a:string,id:string,input:{name:string;staffIds:string[];expectedVersion:number})=>fetchApi<Result<{version:number}>>(account(`/api/booking/admin/routing-staff-groups/${e(id)}`,a),json('PUT',input)),
};
export const bookingMakeupApi={
 rule:(a:string,eventId:string,rule:EventMakeupRule,expectedRevision:number)=>fetchApi<Result<{rule:EventMakeupRule;revision:number}>>(account(`/api/events/admin/${e(eventId)}/makeup-rule`,a),json('PUT',{rule,expectedRevision})),
 absenceByStore:(a:string,id:string,input:{grantMakeup?:boolean;reason?:string})=>fetchApi<Result<{eventBooking:{id:string;status:'absent'};makeupCredit:MakeupCredit|null;reasonIfNone:string|null}>>(account(`/api/events/admin/bookings/${e(id)}/absence`,a),json('POST',input)),
 absence:(liffId:string,id:string,token:string,key:string)=>fetchApi<Result<{eventBooking:{id:string;status:'absent'};makeupCredit:MakeupCredit|null;reasonIfNone:string|null}>>(liff(`/api/liff/events/bookings/${e(id)}/absence`,liffId),{...json('POST',{}),headers:bearer(token,key)}),
 list:(liffId:string,token:string)=>fetchApi<Result<MakeupCredit[]>>(liff('/api/liff/events/makeup-credits',liffId),{headers:bearer(token)}),
 listByStore:(a:string,friendId:string)=>fetchApi<Result<MakeupCredit[]>>(account('/api/booking/admin/makeup-credits',a)+`&friend_id=${e(friendId)}`),
 options:(liffId:string,id:string,token:string,from?:string)=>fetchApi<Result<Array<{id:string;event_id:string;starts_at:string;ends_at:string;capacity:number|null;occupied:number}>>>(liff(`/api/liff/events/makeup-credits/${e(id)}/options`,liffId)+(from?`&from=${e(from)}`:''),{headers:bearer(token)}),
 use:(liffId:string,id:string,eventSlotId:string,token:string,key:string)=>fetchApi<Result<{bookingId:string;replayed:boolean}>>(liff(`/api/liff/events/makeup-credits/${e(id)}/use`,liffId),{...json('POST',{eventSlotId}),headers:bearer(token,key)}),
};
export const broadcastAbApi={
 save:(id:string,input:{testRatioPct:10|20|30|50;metric:'click';decideAfterMinutes:60|120|240|480|1440;undecidedPolicy:'stop'|'send_a';expectedVersion:number})=>fetchApi<Result<{version:number;testMode:true}>>(`/api/broadcasts/${e(id)}/ab-test`,json('PUT',input)),
 remove:(id:string,expectedVersion:number)=>fetchApi<Result<{deleted:true;version:number}>>(`/api/broadcasts/${e(id)}/ab-test`,json('DELETE',{expectedVersion})),
 saveVariant:(id:string,key:'A'|'B',text:string,expectedVersion:number)=>fetchApi<Result<{key:'A'|'B';version:number}>>(`/api/broadcasts/${e(id)}/variants/${key}`,json('PUT',{text,expectedVersion})),
 result:(id:string)=>fetchApi<Result<{status:string;winner:'A'|'B'|null;variants:Array<{key:string;sent:number;failed:number;clicks:number;clickRate:number|null}>;remainder:{count:number;sent:number};version:number;testMode:true}>>(`/api/broadcasts/${e(id)}/ab-result`),
 startMock:(id:string,expectedVersion:number,confirmedRecipientCount:number,key:string)=>fetchApi<Result<{status:'testing';testMode:true;decideAt:string;counts:{A:number;B:number;R:number}}>>(`/api/broadcasts/${e(id)}/send`,{...json('POST',{expectedVersion,confirmedRecipientCount,testMode:true}),headers:{'Idempotency-Key':key,'X-Confirm-Irreversible':'broadcast-send'}}),
 chooseMock:(id:string,variant:'A'|'B'|'none',confirmedRecipientCount:number,key:string)=>fetchApi<Result<{variant:'A'|'B'|'none';testMode:true}>>(`/api/broadcasts/${e(id)}/ab-test/choose`,{...json('POST',{variant,confirmedRecipientCount,testMode:true}),headers:{'Idempotency-Key':key,'X-Confirm-Irreversible':'broadcast-send'}}),
};
export const aiDraftApi={
 settings:(a:string)=>fetchApi<Result<{mode:'off'|'draft_only'|'suspended'|'auto_qa';version:number;autoReplyAvailable:false}>>(account('/api/ai-settings',a)),
 saveSettings:(a:string,input:{mode:'off'|'draft_only'|'suspended';expectedVersion:number;confirmed?:true;reason?:string})=>fetchApi<Result<{mode:string;version:number;autoReplyAvailable:false}>>(account('/api/ai-settings',a),json('PUT',input)),
 summary:(chatId:string)=>fetchApi<Result<AiSummary>>(`/api/chats/${e(chatId)}/ai/summary`,json('POST',{})),
 draft:(chatId:string)=>fetchApi<Result<AiReplyDraft>>(`/api/chats/${e(chatId)}/ai/draft`,json('POST',{})),
 qa:async(a:string,q='',offset=0)=>{const r=await fetchApi<Result<{items:QaEntry[];total:number;nextOffset:number|null}>>(account('/api/qa-entries',a)+`&q=${e(q)}&offset=${offset}`);return {success:true as const,data:r.data.items,total:r.data.total,nextOffset:r.data.nextOffset};},
 createQa:(a:string,input:QaEntryWrite,key:string)=>fetchApi<Result<QaEntry>>(account('/api/qa-entries',a),json('POST',input,key)),
 saveQa:(a:string,id:string,input:QaEntryWrite&{expectedVersion:number})=>fetchApi<Result<{version:number;status:'draft'}>>(account(`/api/qa-entries/${e(id)}`,a),json('PUT',input)),
 publishQa:(a:string,id:string,expectedVersion:number)=>fetchApi<Result<{version:number;status:'published'}>>(account(`/api/qa-entries/${e(id)}/publish`,a),json('POST',{expectedVersion})),
 stopQa:(a:string,id:string,expectedVersion:number)=>fetchApi<Result<{version:number;status:'stopped'}>>(account(`/api/qa-entries/${e(id)}/stop`,a),json('POST',{expectedVersion})),
 archiveQa:(a:string,id:string,expectedVersion:number)=>fetchApi<Result<{version:number;status:'stopped'}>>(account(`/api/qa-entries/${e(id)}`,a),json('DELETE',{expectedVersion})),
};
export const operatorPushApi={
 get:()=>fetchApi<Result<{subscriptions:Array<{id:string;user_agent_label:string;revoked_at:string|null}>;preferences:{kinds_json:string;quiet_start:string;quiet_end:string;quiet_allow_critical:number;version:number};vapidPublicKey:string|null;configured:boolean}>>('/api/me/push'),
 subscribe:(input:{endpoint:string;keys:{p256dh:string;auth:string};label:string},key:string)=>fetchApi<Result<{id:string;user_agent_label:string}>>('/api/me/push/subscriptions',json('POST',input,key)),
 unsubscribe:(id:string)=>fetchApi<{success:true}>(`/api/me/push/subscriptions/${e(id)}`,{method:'DELETE'}),
 savePreferences:(input:{kinds:Array<'new_inquiry'|'assigned_reply'>;quietStart:string;quietEnd:string;quietAllowCritical:boolean;expectedVersion:number})=>fetchApi<Result<{version:number}>>('/api/me/push/preferences',json('PUT',input)),
 test:()=>fetchApi<Result<{sent:number;failed:number}>>('/api/me/push/test',json('POST',{})),
};
/** H1 uses the existing HQ creation/preflight/distribution APIs. */
export {hqCatalogTemplatesApi as gap2HqTemplateApi} from './hq-catalog-templates';
