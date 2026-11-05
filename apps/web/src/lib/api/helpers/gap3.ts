import { bookingAdvancedApi } from './booking-advanced'
import { fetchApi, downloadApiFile } from '../../api'
import type {MemberCard,AccountAiFeature,AccountAiSetting,SavedSearchConditions,CancellationOptions,InboxRoutingTarget,InboxStrategy,CustomerSegments,RankProgram,RankTier,StoreComparisonResult,StoreComparisonDetail,AutoLineKind,AutoLineRule,BookingPassPlan,BookingPassPlanSummary,BookingPassPlanWrite,McpConnection,AiAnswerLog,QaEntry} from '@line-crm/shared';
type Result<T>={success:true;data:T};
type Page<T>={items:T[];total:number};
const e=encodeURIComponent;
const account=(p:string,a:string)=>`${p}?account_id=${e(a)}`;
const json=(method:string,body:unknown,key?:string)=>({method,body:JSON.stringify(body),...(key?{headers:{'Idempotency-Key':key}}:{})});
const query=(p:string,values:Record<string,string|number|undefined>)=>{const q=new URLSearchParams();for(const [k,v]of Object.entries(values))if(v!==undefined)q.set(k,String(v));return `${p}${p.includes('?')?'&':'?'}${q}`;};
export const gap3InboxApi={
 get:(a:string)=>fetchApi<Result<{strategy:InboxStrategy;targets:InboxRoutingTarget[];enabled:boolean;firstResponseMinutes:number;businessHoursOnly:boolean;version:number}>>(account('/api/inbox/routing-settings',a)),
 save:(a:string,b:{strategy:InboxStrategy;targets:InboxRoutingTarget[];enabled:boolean;firstResponseMinutes:number;businessHoursOnly:boolean;expectedVersion:number;escalateTeamId?:string|null})=>fetchApi<Result<unknown>>(account('/api/inbox/routing-settings',a),json('PUT',b)),
 applyUnassigned:(a:string)=>fetchApi<Result<{assigned:number;skipped:number}>>(account('/api/inbox/routing/apply-unassigned',a),json('POST',{})),
 presence:(away:boolean)=>fetchApi<Result<{away:boolean}>>('/api/me/presence',json('PUT',{away})),
 icons:(a:string,offset=0)=>fetchApi<Result<{items:Array<{id:string;url:string;name:string}>;nextOffset:number|null}>>(query(`/api/line-accounts/${e(a)}/sender-icons`,{offset})),
};
export const gap3BookingApi = {
  createGroup: bookingAdvancedApi.createGroup,
  depositRule: bookingAdvancedApi.depositRule,
  saveDepositRule: bookingAdvancedApi.saveDepositRule,
  menuDeposit: bookingAdvancedApi.menuDeposit,
  saveMenuDeposit: bookingAdvancedApi.saveMenuDeposit,
  cancellationOptions: bookingAdvancedApi.cancellationOptions,
  saveCancellationOptions: bookingAdvancedApi.saveCancellationOptions as (accountId: string, input: { cardRequiredFor: CancellationOptions['cardRequiredFor']; chargeMode: 'manual'; expectedVersion: number }) => ReturnType<typeof bookingAdvancedApi.saveCancellationOptions>,
  card: bookingAdvancedApi.card,
  group: bookingAdvancedApi.group,
  series: bookingAdvancedApi.series,
  cancelGroup: bookingAdvancedApi.cancelGroup,
  impact: bookingAdvancedApi.impact,
  meetingCapabilities: bookingAdvancedApi.meetingCapabilities,
  costEstimate: bookingAdvancedApi.costEstimate,
  seriesPreview: bookingAdvancedApi.seriesPreview,
  groupAvailability: bookingAdvancedApi.groupAvailability,
  request: bookingAdvancedApi.request,
}

export const customerSegmentsApi={
 get:(a:string,basis='both',measure='count')=>fetchApi<Result<CustomerSegments>>(query(account('/api/analytics/customer-segments',a),{basis,measure})),
 friends:(a:string,r:number,f:number,basis='both',measure='count',cursor?:string)=>fetchApi<Result<Page<{id:string;display_name:string;activity_count:number;amount:number}>&{optedOutCount:number;nextCursor:string|null}>>(query(account(`/api/analytics/customer-segments/cells/${r}/${f}/friends`,a),{basis,measure,cursor})),
 rename:(a:string,r:number,f:number,name:string)=>fetchApi<Result<unknown>>(account(`/api/analytics/customer-segments/cells/${r}/${f}/name`,a),json('PUT',{name})),
 saveSearch:(a:string,r:number,f:number,b:{name:string;basis:'visit'|'purchase'|'both';measure:'count'|'amount'})=>fetchApi<Result<unknown>>(account(`/api/analytics/customer-segments/cells/${r}/${f}/saved-search`,a),json('POST',b)),
};
export const memberRanksApi={
 notices:(a:string)=>fetchApi<Result<{items:unknown[]}>>(account('/api/member-ranks/notices',a)),
 simulateNotices:(a:string)=>fetchApi<Result<{processed:number;sent:false;testMode:true}>>(account('/api/member-ranks/notices/simulate',a),json('POST',{testMode:true})),
 program:(a:string)=>fetchApi<Result<RankProgram>>(account('/api/member-ranks/program',a)),
 save:(a:string,b:{metric:RankProgram['metric'];windowMonths:number;expectedVersion:number;notifyUpgrade?:boolean;notifyDowngrade?:boolean})=>fetchApi<Result<RankProgram>>(account('/api/member-ranks/program',a),json('PUT',b)),
 tiers:(a:string,tiers:RankTier[],expectedVersion:number)=>fetchApi<Result<RankProgram>>(account('/api/member-ranks/tiers',a),json('PUT',{tiers,expectedVersion})),
 preview:(a:string)=>fetchApi<Result<{byTier:Array<{tierId:string;name:string;count:number}>;wouldUpgrade:number;wouldDowngrade:number}>>(account('/api/member-ranks/preview',a),json('POST',{})),
 activate:(a:string,expectedVersion:number,key:string)=>fetchApi<Result<RankProgram>>(account('/api/member-ranks/activate',a),json('POST',{expectedVersion},key)),
 stop:(a:string,expectedVersion:number)=>fetchApi<Result<RankProgram>>(account('/api/member-ranks/stop',a),json('POST',{expectedVersion})),
 friend:(a:string,id:string)=>fetchApi<Result<unknown>>(account(`/api/friends/${e(id)}/member-rank`,a)),
 card:(liffId:string,token:string)=>fetchApi<Result<MemberCard|null>>(query('/api/liff/member-card',{liffId}),{headers:{Authorization:`Bearer ${token}`}}),
};
export const storeComparisonApi={
 download:(id:string)=>downloadApiFile(`/api/hq/store-comparison/exports/${e(id)}/download`,'store-comparison.csv'),
 export:(filters:{from?:string;to?:string;compare?:'average'|'previous';poolId?:string;sort?:string;order?:'asc'|'desc'},key:string)=>fetchApi<Result<{id:string;replayed:boolean}>>('/api/hq/store-comparison/export',json('POST',filters,key)),
 exportStatus:(id:string)=>fetchApi<Result<{id:string;status:'pending'|'completed'|'failed';rowCount:number|null;downloadUrl:string|null;errorCode:string|null}>>(`/api/hq/store-comparison/exports/${e(id)}`),
 get:(filters:{from?:string;to?:string;compare?:'average'|'previous';sort?:string;order?:'asc'|'desc';page?:number;pageSize?:10|20|50;poolId?:string}={})=>fetchApi<Result<StoreComparisonResult>>(query('/api/hq/store-comparison',filters)),
 detail:(id:string,from?:string,to?:string)=>fetchApi<Result<StoreComparisonDetail>>(query(`/api/hq/store-comparison/${e(id)}`,{from,to})),
};
export const ecAutoLineApi={
 send:(a:string,id:string)=>fetchApi<Result<unknown>>(account(`/api/ec/auto-line/sends/${e(id)}`,a)),
 simulateAttribution:(a:string,b:{sendId:string;friendId:string;eventId:string;kind:'click'|'purchase';occurredAt:string;orderId?:string;amount?:number})=>fetchApi<Result<unknown>>(account('/api/ec/auto-line/attribution/simulate',a),json('POST',{...b,testMode:true})),
 simulate:(a:string)=>fetchApi<Result<{processed:number;sent:false;testMode:true}>>(account('/api/ec/auto-line/simulate',a),json('POST',{testMode:true})),
 rules:(a:string)=>fetchApi<Result<AutoLineRule[]>>(account('/api/ec/auto-line/rules',a)),
 save:(a:string,kind:AutoLineKind,b:{waitMinutes:number;messages:unknown[];expectedVersion:number;enabled?:false;reason?:string})=>fetchApi<Result<AutoLineRule>>(account(`/api/ec/auto-line/rules/${kind}`,a),json('PUT',{...b,testMode:true})),
 enableMock:(a:string,kind:AutoLineKind,expectedVersion:number,key:string)=>fetchApi<Result<AutoLineRule>>(account(`/api/ec/auto-line/rules/${kind}/enable`,a),json('POST',{expectedVersion,enabled:true,confirmed:true,testMode:true},key)),
 test:(a:string,kind:AutoLineKind)=>fetchApi<Result<unknown>>(account(`/api/ec/auto-line/rules/${kind}/test`,a),json('POST',{})),
 sends:(a:string,kind?:AutoLineKind,status?:string,offset=0)=>fetchApi<Result<Page<unknown>>>(query(account('/api/ec/auto-line/sends',a),{kind,status,offset})),
 stats:(a:string)=>fetchApi<Result<{sent:0;simulated:number;skipped:number;clicks:null;purchases:null;simulatedResults:{clickedMessages:number;purchases:number;purchaseAmount:number};testMode:true}>>(account('/api/ec/auto-line/stats',a)),
};
export const bookingPassPlansApi={
 checkout:(liffId:string,token:string,planId:string,key:string)=>fetchApi<Result<unknown>>(query(`/api/liff/booking/pass-plans/${e(planId)}/checkout`,{liffId}),{...json('POST',{testMode:true}),headers:{Authorization:`Bearer ${token}`,'Idempotency-Key':key}}),
 purchase:(liffId:string,token:string,id:string)=>fetchApi<Result<unknown>>(query(`/api/liff/booking/pass-purchases/${e(id)}`,{liffId}),{headers:{Authorization:`Bearer ${token}`}}),
 purchases:(a:string)=>fetchApi<Result<{items:unknown[]}>>(account('/api/booking/admin/pass-purchases',a)),
 simulateBillingEvent:(a:string,event:Record<string,unknown>)=>fetchApi<Result<unknown>>(account('/api/booking/admin/pass-purchases/simulate-event',a),json('POST',{...event,testMode:true})),
 list:(a:string,q='',offset=0,limit:10|20|50=20,kind?:BookingPassPlan['kind'])=>fetchApi<Result<Page<BookingPassPlan>&{summary:BookingPassPlanSummary}>>(query(account('/api/booking/admin/pass-plans',a),{q,offset,limit,kind})),
 create:(a:string,b:BookingPassPlanWrite,key:string)=>fetchApi<Result<BookingPassPlan>>(account('/api/booking/admin/pass-plans',a),json('POST',b,key)),
 save:(a:string,id:string,b:BookingPassPlanWrite&{expectedVersion:number})=>fetchApi<Result<BookingPassPlan>>(account(`/api/booking/admin/pass-plans/${e(id)}`,a),json('PUT',b)),
 start:(a:string,id:string,expectedVersion:number,eventIds?:string[]|null)=>fetchApi<Result<{status:'on_sale';version:number}>>(account(`/api/booking/admin/pass-plans/${e(id)}/start`,a),json('POST',{expectedVersion,...(eventIds===undefined?{}:{eventIds})})),
 stop:(a:string,id:string,expectedVersion:number)=>fetchApi<Result<{status:'stopped';version:number}>>(account(`/api/booking/admin/pass-plans/${e(id)}/stop`,a),json('POST',{expectedVersion})),
 holders:(a:string,id:string,offset=0,limit:10|20|50=20)=>fetchApi<Result<Page<unknown>>>(query(account(`/api/booking/admin/pass-plans/${e(id)}/holders`,a),{offset,limit})),
 grant:(a:string,planId:string,friendId:string,reason:string,key:string)=>fetchApi<Result<unknown>>(account('/api/booking/admin/entitlements',a),json('POST',{planId,friendId,reason},key)),
};
export const gap3AiApi={
 typing:(chatId:string,typing:boolean)=>fetchApi<Result<{typing:boolean;expiresAt?:string}>>(`/api/chats/${e(chatId)}/ai/typing`,json('POST',{typing})),
 enableSimulation:(a:string,expectedVersion:number,stepUpToken:string)=>fetchApi<Result<{mode:'auto_qa';testMode:true;autoReplyAvailable:false}>>(account('/api/ai-settings',a),{...json('PUT',{mode:'auto_qa',expectedVersion,confirmed:true,testMode:true}),headers:{'X-Step-Up-Token':stepUpToken}}),
 simulate:(a:string,b:{chatId:string;question:string;kind?:string},key:string)=>fetchApi<Result<unknown>>(account('/api/ai-settings/simulate',a),json('POST',{...b,testMode:true},key)),
 qa:(a:string,q='',offset=0)=>fetchApi<Result<Page<QaEntry>>>(query(account('/api/qa-entries',a),{q,offset})),
 logs:(a:string,action?:string,offset=0)=>fetchApi<Result<Page<AiAnswerLog>&{summary:unknown}>>(query(account('/api/ai-answer-logs',a),{action,offset})),
 log:(a:string,id:string)=>fetchApi<Result<AiAnswerLog&{answerText:string|null;qa:unknown;afterNote:string|null}>>(account(`/api/ai-answer-logs/${e(id)}`,a)),
 test:(a:string,question:string)=>fetchApi<Result<unknown>>(account('/api/ai-settings/test',a),json('POST',{question})),
};
export const mcpConnectionsApi={
 list:(a:string)=>fetchApi<Result<McpConnection[]>>(account('/api/mcp-connections',a)),
 create:(a:string,b:{name:string;level:'read'|'draft'|'send_request';expiryDays:30|90|180|365},stepUpToken:string)=>fetchApi<Result<{connection:McpConnection;url:string;key:string}>>(account('/api/mcp-connections',a),{...json('POST',b),headers:{'X-Step-Up-Token':stepUpToken}}),
 rotate:(a:string,id:string,expectedVersion:number,stepUpToken:string)=>fetchApi<Result<{connection:McpConnection;url:string;key:string}>>(account(`/api/mcp-connections/${e(id)}/rotate`,a),{...json('POST',{expectedVersion}),headers:{'X-Step-Up-Token':stepUpToken}}),
 stop:(a:string,id:string,expectedVersion:number,reason?:string)=>fetchApi<Result<McpConnection>>(account(`/api/mcp-connections/${e(id)}/stop`,a),json('POST',{expectedVersion,reason})),
 logs:(a:string,connectionId?:string,offset=0)=>fetchApi<Result<Page<unknown>&{connection:McpConnection|null}>>(query(account('/api/mcp-connections/logs',a),{connectionId,offset})),
};

export const deliveryPurposesApi={
 list:(a:string)=>fetchApi<Result<Array<{id:'transaction'|'notice'|'marketing';label:string;sendAvailable:boolean}>>>(account('/api/delivery-purposes',a)),
 preview:(a:string,purpose:'transaction'|'notice'|'marketing',friendIds?:string[])=>fetchApi<Result<{purpose:string;recipients:number;excluded:{blocked:number;optedOut:number};sent:false;previewOnly:true}>>(account('/api/delivery-purposes/preview',a),json('POST',{purpose,friendIds})),
};

export const broadcastSimulationApi={
 create:(a:string,b:{title:string;text:string;purpose:'transaction'|'notice'|'marketing';targetTagId?:string},key:string)=>fetchApi<Result<{id:string;version:number;recipients:number;testMode:true}>>(account('/api/broadcasts/simulation-drafts',a),json('POST',{...b,testMode:true},key)),
 save:(a:string,id:string,b:{title:string;text:string;purpose:'transaction'|'notice'|'marketing';targetTagId?:string;expectedVersion:number})=>fetchApi<Result<unknown>>(account(`/api/broadcasts/${e(id)}/simulation-draft`,a),json('PUT',{...b,testMode:true})),
 preview:(a:string,id:string)=>fetchApi<Result<{version:number;purpose:string;recipients:number;simulated:number;sent:0;testMode:true}>>(account(`/api/broadcasts/${e(id)}/simulation`,a)),
 send:(a:string,id:string,b:{expectedVersion:number;confirmedRecipientCount:number;scheduledAt?:string},key:string)=>fetchApi<Result<unknown>>(account(`/api/broadcasts/${e(id)}/simulate-send`,a),json('POST',{...b,testMode:true},key)),
};

export const accountAiFeaturesApi={
 get:(a:string)=>fetchApi<Result<{items:AccountAiSetting[];disclosure:string;disclosureVersion:string}>>(account('/api/ai-features',a)),
 save:(a:string,feature:AccountAiFeature,b:{enabled:boolean;expectedVersion:number;consent?:boolean;disclosureVersion?:string},stepUpToken?:string)=>fetchApi<Result<AccountAiSetting>>(account(`/api/ai-features/${e(feature)}`,a),{...json('PUT',b),...(stepUpToken?{headers:{'X-Step-Up-Token':stepUpToken}}:{})}),
};
export const memberActivityFriendsApi={
 list:(a:string,conditions:SavedSearchConditions)=>fetchApi<Result<unknown>>(query('/api/friends',{lineAccountId:a,conditions:JSON.stringify(conditions)})),
};
