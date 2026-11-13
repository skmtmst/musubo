import { fetchApi } from './api';
import type { HqBroadcastInput,HqBroadcastDraftInput,HqBroadcastRun,HqBroadcastPreflight } from '@line-crm/shared';
type Response<T>={success:true;data:T};
const path=(s:string)=>`/api/hq/broadcasts${s}`;
const send=<T>(s:string,body:unknown,confirmed=false,method='POST')=>fetchApi<Response<T>>(path(s),{method,body:JSON.stringify(body),...(confirmed?{headers:{'X-Confirm-Irreversible':'broadcast-send'}}:{})});
export const hqBroadcastsApi={
 list:()=>fetchApi<Response<HqBroadcastRun[]>>(path('')),
 create:(body:HqBroadcastInput)=>send<HqBroadcastRun>('',body),
 get:(id:string)=>fetchApi<Response<HqBroadcastRun>>(path(`/${encodeURIComponent(id)}`)),
 update:(id:string,body:HqBroadcastDraftInput)=>send<HqBroadcastRun>(`/${encodeURIComponent(id)}`,body,false,'PATCH'),
 preflight:(id:string)=>send<HqBroadcastPreflight[]>(`/${encodeURIComponent(id)}/preflight`,{}),
 exclude:(id:string,accountIds:string[],expectedVersion:number)=>send<HqBroadcastRun>(`/${encodeURIComponent(id)}/exclusions`,{accountIds,expectedVersion},false,'PUT'),
 send:(id:string,expectedVersion:number,confirmedRecipientCount?:number,confirmedAudiences?:Array<{accountId:string;recipientCount:number;recipientToken:string}>)=>send<HqBroadcastRun>(`/${encodeURIComponent(id)}/send`,{expectedVersion,confirmedRecipientCount,confirmedAudiences},true),
 stop:(id:string,expectedVersion:number)=>send<HqBroadcastRun>(`/${encodeURIComponent(id)}/stop`,{expectedVersion}),
 cancel:(id:string,expectedVersion:number)=>send<HqBroadcastRun>(`/${encodeURIComponent(id)}/cancel`,{expectedVersion}),
 swapFolderOrder:(id:string,withId:string,expectedVersion:number,withExpectedVersion:number)=>send<{swapped:[string,string]}>(`/folders/${encodeURIComponent(id)}/swap-order`,{withId,expectedVersion,withExpectedVersion}),
 folders:()=>fetchApi<Response<Array<import('@line-crm/shared').HqBroadcastFolder & {item_count:number}>>>(path('/folders')),
 createFolder:(name:string,color?:string|null)=>send<import('@line-crm/shared').HqBroadcastFolder>('/folders',{name,color}),
 updateFolder:(id:string,name:string,expectedVersion:number,color?:string|null)=>send<import('@line-crm/shared').HqBroadcastFolder>(`/folders/${encodeURIComponent(id)}`,{name,expectedVersion,color},false,'PATCH'),
 deleteFolder:(id:string,expectedVersion:number)=>send<{id:string;archived:boolean}>(`/folders/${encodeURIComponent(id)}`,{expectedVersion},false,'DELETE'),
 approval:(id:string)=>fetchApi<Response<import('@line-crm/shared').BroadcastApprovalState>>(path(`/${encodeURIComponent(id)}/approval`)),
 approvalCandidates:()=>fetchApi<Response<Array<{id:string;name:string;role:string;canApprove:boolean}>>>(path('/approvals/candidates')),
 requestApproval:(id:string,expectedVersion:number,approverStaffId:string,note?:string)=>send<import('@line-crm/shared').BroadcastApprovalState>(`/${encodeURIComponent(id)}/approval-request`,{expectedVersion,approverStaffId,note}),
 approve:(id:string,expectedVersion:number,stepUpToken?:string)=>fetchApi<Response<import('@line-crm/shared').BroadcastApprovalState>>(path(`/${encodeURIComponent(id)}/approve`),{method:'POST',body:JSON.stringify({expectedVersion}),...(stepUpToken?{headers:{'X-Step-Up-Token':stepUpToken}}:{})}),
 reject:(id:string,expectedVersion:number,reason:string)=>send<import('@line-crm/shared').BroadcastApprovalState>(`/${encodeURIComponent(id)}/reject`,{expectedVersion,reason}),
 cancelApproval:(id:string,expectedVersion:number)=>send<import('@line-crm/shared').BroadcastApprovalState>(`/${encodeURIComponent(id)}/approval-cancel`,{expectedVersion}),
 testRecipients:(accountId:string)=>fetchApi<Response<{count:number;recipients:Array<{id:string;displayName:string|null}>;token:string}>>(path(`/test-recipients?accountId=${encodeURIComponent(accountId)}`)),
 testSend:(id:string,accountId:string,expectedRecipientToken?:string)=>send<{sent:number;failed:number}>(`/${encodeURIComponent(id)}/test-send`,{accountId,expectedRecipientToken}),
 recipients:(id:string,accountId:string,cursor=0,limit=50)=>fetchApi<Response<{rows:Array<{friendId:string;displayName:string|null;state:string;attemptNo:number;sentAt:string|null;claimedAt:string;errorCode:string|null}>;total:number;nextCursor:string|null}>>(path(`/${encodeURIComponent(id)}/targets/${encodeURIComponent(accountId)}/recipients?cursor=${cursor}&limit=${limit}`)),
 activity:(id:string,cursor=0,limit=50)=>fetchApi<Response<{rows:Array<{id:string;accountId:string;actorId:string;action:string;createdAt:string}>;nextCursor:string|null}>>(path(`/${encodeURIComponent(id)}/activity?cursor=${cursor}&limit=${limit}`)),
 exportPath:(id:string)=>path(`/${encodeURIComponent(id)}/export.csv`),
 retry:(id:string,accountId:string,expectedVersion:number,confirmation?:{count:number;token:string})=>send<HqBroadcastRun>(`/${encodeURIComponent(id)}/targets/${encodeURIComponent(accountId)}/retry`,{expectedVersion,...(confirmation?{confirmedRecipientCount:confirmation.count,confirmedRecipientToken:confirmation.token}:{})},true),
 retryPreview:(id:string,accountId:string)=>fetchApi<Response<{count:number;token:string}>>(path(`/${encodeURIComponent(id)}/targets/${encodeURIComponent(accountId)}/retry-preview`)),
};
