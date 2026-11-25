import { beforeEach, it, expect, vi } from 'vitest';
vi.mock('./api',()=>({fetchApi:vi.fn()}));
import { fetchApi } from './api';
import { hqBroadcastsApi } from './hq-broadcasts-api';
import { describeFolderFailure } from '@/components/shared/folder-failure';
import { ApiError } from './api/transport/errors';
const request=vi.mocked(fetchApi);
beforeEach(()=>{request.mockReset();request.mockResolvedValue({success:true,data:{}});});
it('同名409は名前の理由として、版の409は更新競合として画面へ渡る',async()=>{
 const duplicate=new ApiError(409,'同じ名前のフォルダがあります','FOLDER_NAME_CONFLICT',undefined,undefined,undefined,{name:'同じ名前のフォルダがあります'});
 request.mockRejectedValueOnce(duplicate);
 await expect(hqBroadcastsApi.createFolder('テスト')).rejects.toBe(duplicate);
 expect(describeFolderFailure(duplicate)).toMatchObject({kind:'name',nameError:'同じ名前のフォルダがあります。'});
 expect(describeFolderFailure(new ApiError(409,'分類が更新されました','VERSION_CONFLICT'))).toMatchObject({kind:'conflict'});
});
it('統括のテスト・承認・人数確認付き送信も共通transportを通す',async()=>{
 await hqBroadcastsApi.testSend('run/1','shop');expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/run%2F1/test-send',{method:'POST',body:JSON.stringify({accountId:'shop'})});
 await hqBroadcastsApi.requestApproval('run1',3,'reviewer','確認');expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/run1/approval-request',{method:'POST',body:JSON.stringify({expectedVersion:3,approverStaffId:'reviewer',note:'確認'})});
 await hqBroadcastsApi.send('run1',5,1000);expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/run1/send',{method:'POST',body:JSON.stringify({expectedVersion:5,confirmedRecipientCount:1000}),headers:{'X-Confirm-Irreversible':'broadcast-send'}});
});
it('分類・宛先・記録を読み、識別子をパスからescapeする',async()=>{
 await hqBroadcastsApi.approvalCandidates();expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/approvals/candidates');
 await hqBroadcastsApi.createFolder('毎月');expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/folders',{method:'POST',body:JSON.stringify({name:'毎月'})});
 await hqBroadcastsApi.recipients('run/1','shop/1',50,10);expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/run%2F1/targets/shop%2F1/recipients?cursor=50&limit=10');
 await hqBroadcastsApi.activity('run/1');expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/run%2F1/activity?cursor=0&limit=50');
 expect(hqBroadcastsApi.exportPath('run/1')).toBe('/api/hq/broadcasts/run%2F1/export.csv');
});

it('分類の作成と更新で色を送り、色を消すNULLも送れる',async()=>{
 await hqBroadcastsApi.createFolder('毎月','#ef4444');expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/folders',{method:'POST',body:JSON.stringify({name:'毎月',color:'#ef4444'})});
 await hqBroadcastsApi.updateFolder('f/1','改名',3,null);expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/folders/f%2F1',{method:'PATCH',body:JSON.stringify({name:'改名',expectedVersion:3,color:null})});
});

it('フォルダ交換は双方の版をまとめて送り、IDをescapeする',async()=>{
 await hqBroadcastsApi.swapFolderOrder('f/1','f/2',3,4);
 expect(request).toHaveBeenLastCalledWith('/api/hq/broadcasts/folders/f%2F1/swap-order',{method:'POST',body:JSON.stringify({withId:'f/2',expectedVersion:3,withExpectedVersion:4})});
});
