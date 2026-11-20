import {fetchApi} from '../../api';
import type {LineSender,SendConfirmationPreview,InboxFirstResponseSettings,InboxFirstResponseWrite,BookingCancellationPolicy,BookingCancellationQuote,BookingCancellationCharge,BookingCalendarSwitch,BookingCalendarSwitchWrite} from '@line-crm/shared';
type Result<T>={success:true;data:T};
const e=encodeURIComponent;
const account=(path:string,id:string)=>`${path}?account_id=${e(id)}`;
const senders=(id:string)=>`/api/line-accounts/${e(id)}/senders`;
const json=(method:string,body:unknown,key?:string)=>({method,body:JSON.stringify(body),...(key?{headers:{'Idempotency-Key':key}}:{})});
export const chatSafetyApi={
 confirmBroadcast:(id:string,input:{expectedVersion:number;confirmedRecipientCount:number;scheduledAt?:string})=>fetchApi<Result<{scheduled?:boolean;scheduledAt?:string}>>(`/api/broadcasts/${e(id)}/send`,{...json('POST',input),headers:{'X-Confirm-Irreversible':'broadcast-send'}}),
 sendPreview:(id:string)=>fetchApi<Result<SendConfirmationPreview>>(`/api/broadcasts/${e(id)}/send-preview`),
 hqSendPreview:(id:string)=>fetchApi<Result<SendConfirmationPreview>>(`/api/hq/broadcasts/${e(id)}/send-preview`),
 send:(id:string,input:{content:string;messageType?:string;revision?:number;correctionOfMessageId?:string;senderId?:string},key:string)=>fetchApi<Result<{sent:true;messageId:string;revision:number}>>(`/api/chats/${e(id)}/send`,{...json('POST',input,key),headers:{'Idempotency-Key':key,'X-Line-Harness-Source':'manual'}}),
 cancelScheduled:(id:string,scheduleId:string,impersonationReason?:string)=>fetchApi<Result<{cancelled:true}>>(`/api/chats/${e(id)}/scheduled/${e(scheduleId)}`,{method:'DELETE',...(impersonationReason?{headers:{'X-Impersonation-Reason':encodeURIComponent(impersonationReason)}}:{})}),
};
export const lineSenderApi={
 list:(id:string)=>fetchApi<Result<LineSender[]>>(senders(id)),
 create:(id:string,input:{name:string;iconMediaId?:string|null;visibility:'all'|'owner_only';ownerStaffId?:string},key:string)=>fetchApi<Result<LineSender>>(senders(id),json('POST',input,key)),
 update:(id:string,senderId:string,input:{name:string;iconMediaId?:string|null;expectedVersion:number})=>fetchApi<Result<LineSender>>(`${senders(id)}/${e(senderId)}`,json('PUT',input)),
 deactivate:(id:string,senderId:string,expectedVersion:number)=>fetchApi<Result<LineSender>>(`${senders(id)}/${e(senderId)}`,json('DELETE',{expectedVersion})),
};
export const inboxRoutingApi={
 get:(id:string)=>fetchApi<Result<InboxFirstResponseSettings>>(account('/api/inbox/routing-settings',id)),
 save:(id:string,input:InboxFirstResponseWrite)=>fetchApi<Result<InboxFirstResponseSettings>>(account('/api/inbox/routing-settings',id),json('PUT',input)),
 listByDeadline:(id:string,options:{overdue?:boolean;limit?:number;beforeDueAt?:string;beforeId?:string}={})=>{const q=new URLSearchParams({lineAccountId:id,sort:'sla_due'});if(options.overdue)q.set('slaState','overdue');if(options.limit)q.set('limit',String(options.limit));if(options.beforeDueAt)q.set('beforeDueAt',options.beforeDueAt);if(options.beforeId)q.set('beforeId',options.beforeId);return fetchApi<{success:true;data:Array<{id:string;friendId:string;conversationId:string;lastMessage:string|null;unread:boolean;slaDueAt:string|null;slaState:string;assignedBy:string|null}>;total:number}>(`/api/chats?${q}`);},
};
export const bookingCancellationApi={
 cancel:(liffId:string,bookingId:string,input:{lock_version:number;feeAccepted?:true;expectedFeeAmount?:number},idToken:string)=>fetchApi<{status:string;feeNow?:number}>(`/api/liff/booking/${e(bookingId)}/cancel?${new URLSearchParams({liffId})}`,{...json('POST',input),headers:{Authorization:`Bearer ${idToken}`}}),
 cancelByStore:(id:string,bookingId:string)=>fetchApi<{status:string}>(account(`/api/booking/admin/requests/${e(bookingId)}`,id),json('PATCH',{action:'cancel',cancellationReason:'store'})),
 getPolicy:(id:string)=>fetchApi<Result<BookingCancellationPolicy>>(account('/api/booking/admin/cancellation-policy',id)),
 savePolicy:(id:string,input:Omit<BookingCancellationPolicy,'version'>&{expectedVersion:number})=>fetchApi<Result<BookingCancellationPolicy>>(account('/api/booking/admin/cancellation-policy',id),json('PUT',input)),
 charges:(id:string,bookingId:string)=>fetchApi<Result<{charges:BookingCancellationCharge[];quote:BookingCancellationQuote;testMode:true}>>(account(`/api/booking/admin/bookings/${e(bookingId)}/charges`,id)),
 charge:(id:string,bookingId:string,input:{kind:'cancellation_fee'|'no_show_fee';amount:number;expectedVersion:number},key:string)=>fetchApi<Result<BookingCancellationCharge>>(account(`/api/booking/admin/bookings/${e(bookingId)}/charges`,id),json('POST',input,key)),
 waive:(id:string,chargeId:string,reason:string,expectedVersion:number)=>fetchApi<Result<{id:string;status:'waived';version:number}>>(account(`/api/booking/admin/charges/${e(chargeId)}/waive`,id),json('POST',{reason,expectedVersion})),
 refund:(id:string,chargeId:string,input:{reason:string;expectedVersion:number;confirmed:true;confirmedIrreversible:true},key:string)=>fetchApi<Result<{id:string;status:'refunded';version:number}>>(account(`/api/booking/admin/charges/${e(chargeId)}/refund`,id),json('POST',input,key)),
 quote:(liffId:string,bookingId:string,idToken:string)=>fetchApi<Result<BookingCancellationQuote>>(`/api/liff/booking/cancellation-quote?${new URLSearchParams({liffId,booking_id:bookingId})}`,{headers:{Authorization:`Bearer ${idToken}`}}),
 setup:(liffId:string,input:{menuId:string;policyAccepted:true},idToken:string,key:string)=>fetchApi<Result<{setupIntentId:string;url:string;status:'pending'|'ready';testMode:true}>>(`/api/liff/booking/setup-intent?${new URLSearchParams({liffId})}`,{...json('POST',input,key),headers:{Authorization:`Bearer ${idToken}`,'Idempotency-Key':key}}),
};
export const bookingCalendarApi={
 connection:(id:string,staffId:string,provider:'google_meet'|'zoom'|'teams'|'outlook')=>fetchApi<Result<{state:'ready'|'refreshing'|'unknown'|'missing';preferred:boolean;mode:'configured'|'mock'}>>(account(`/api/booking/admin/staff/${e(staffId)}/connections/${provider}`,id)),
 connect:(id:string,staffId:string,provider:'google_meet'|'zoom'|'teams'|'outlook')=>fetchApi<Result<{mode:'configured'|'mock';authorizationUrl:string|null}>>(account(`/api/booking/admin/staff/${e(staffId)}/connections/${provider}/connect`,id),json('POST',{})),
 disconnect:(id:string,staffId:string,provider:'google_meet'|'zoom'|'teams'|'outlook')=>fetchApi<Result<{disconnected:true}>>(account(`/api/booking/admin/staff/${e(staffId)}/connections/${provider}`,id),{method:'DELETE'}),
 prefer:(id:string,staffId:string,provider:'google_meet'|'zoom'|'teams')=>fetchApi<Result<{preferred:true}>>(account(`/api/booking/admin/staff/${e(staffId)}/connections/${provider}/prefer`,id),json('POST',{})),
 meetingReviews:(id:string,bookingId:string)=>fetchApi<Result<{items:Array<{id:string;provider:string;staff_name:string|null;starts_at:string|null;ends_at:string|null}>}>>(account(`/api/booking/admin/bookings/${e(bookingId)}/meeting-links`,id)),
 resolveMeetingReview:(id:string,bookingId:string,linkId:string)=>fetchApi<Result<{resolved:true}>>(account(`/api/booking/admin/bookings/${e(bookingId)}/meeting-links/${e(linkId)}/resolve`,id),json('POST',{confirmed:true})),
 meetingStatus:(id:string,bookingId:string)=>fetchApi<Result<{state:'none'|'active'|'failed'|'unknown';provider:'google_meet'|'zoom'|'teams'|null;version:number}>>(account(`/api/booking/admin/bookings/${e(bookingId)}/meeting-status`,id)),
 retryMeeting:(id:string,bookingId:string,key:string)=>fetchApi<Result<{outcome:'created'|'failed'|'unknown'|'in_progress'|'unavailable'}>>(account(`/api/booking/admin/bookings/${e(bookingId)}/meeting-retry`,id),json('POST',{},key)),
 rewrite:(id:string,bookingId:string,expectedVersion:number)=>fetchApi<Result<{queued:true;version:number}>>(account(`/api/booking/admin/bookings/${e(bookingId)}/calendar/rewrite`,id),json('POST',{expectedVersion})),
 retryJobs:(id:string)=>fetchApi<Result<{queued:number}>>(account('/api/booking/admin/calendar-sync/retry',id),json('POST',{})),
 getSwitches:(id:string,staffId?:string)=>fetchApi<Result<BookingCalendarSwitch>>(account(staffId?`/api/booking/admin/staff/${e(staffId)}/calendar-sync`:'/api/booking/admin/calendar-sync',id)),
 saveSwitches:(id:string,input:BookingCalendarSwitchWrite,staffId?:string)=>fetchApi<Result<BookingCalendarSwitch>>(account(staffId?`/api/booking/admin/staff/${e(staffId)}/calendar-sync`:'/api/booking/admin/calendar-sync',id),json('PUT',input)),
 getStaffUrl:(id:string,staffId:string)=>fetchApi<Result<{url:string|null;version:number}>>(account(`/api/booking/admin/staff/${e(staffId)}/meeting-url`,id)),
 saveStaffUrl:(id:string,staffId:string,url:string|null,expectedVersion:number)=>fetchApi<Result<{url:string|null;version:number}>>(account(`/api/booking/admin/staff/${e(staffId)}/meeting-url`,id),json('PUT',{url,expectedVersion})),
 getMenuUrl:(id:string,menuId:string)=>fetchApi<Result<{url:string|null;version:number;issuance:'manual'|'automatic'}>>(account(`/api/booking/admin/menus/${e(menuId)}/meeting-url`,id)),
 saveMenuUrl:(id:string,menuId:string,url:string|null,expectedVersion:number,issuance?:'manual'|'automatic')=>fetchApi<Result<{url:string|null;version:number;issuance:'manual'|'automatic'}>>(account(`/api/booking/admin/menus/${e(menuId)}/meeting-url`,id),json('PUT',{url,expectedVersion,...(issuance?{issuance}:{})})),
 setBookingUrl:(id:string,bookingId:string,input:{action:'set_manual';url:string;expectedVersion:number}|{action:'refresh_fixed';expectedVersion:number})=>fetchApi<Result<{url:string|null;source:'staff'|'menu'|'manual';version:number}>>(account(`/api/booking/admin/bookings/${e(bookingId)}/meeting`,id),json('POST',input)),
};
