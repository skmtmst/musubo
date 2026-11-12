// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({list:vi.fn(),create:vi.fn(),regenerate:vi.fn(),detail:vi.fn(),stepUp:vi.fn(),download:vi.fn()}));
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>();
  return {...actual,downloadApiFile:calls.download,api:{...actual.api,auth:{...actual.api.auth,stepUp:calls.stepUp},commonVars:{...actual.api.commonVars,listExports:calls.list,createExport:calls.create,regenerateExport:calls.regenerate,exportDetail:calls.detail}}};
});
import { ApiError } from '@/lib/api';
import { rememberSessionSnapshot, forgetSessionSnapshot } from '@/lib/session-snapshot';
import { useVarsExportPanel } from './export-panel';
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const expired = {id:'job-old',lineAccountId:'account-a',folderId:null,ungrouped:false,status:'expired',totalCount:1,processedCount:1,rowCount:1,byteSize:1,createdBy:'actor',createdByName:'Fixture',createdAt:'2026-09-01T00:00:00Z',startedAt:null,finishedAt:null,expiresAt:'2026-09-08T00:00:00Z',failureReason:null,downloadUrl:null};
const ready = {...expired,id:'job-new',status:'completed',downloadUrl:'/api/common-vars/exports/job-new/download'};
function Panel(props:{accountId:string;folderId:string|null}) { const panel=useVarsExportPanel(props);return <>{panel.action}{panel.status}</>; }
let host:HTMLDivElement,root:Root;
async function render(accountId='account-a',folderId:string|null=null){await act(async()=>root.render(<Panel accountId={accountId} folderId={folderId}/>));}
async function click(name:string){const b=[...document.querySelectorAll('button')].find(n=>n.textContent?.trim()===name);expect(b,`button ${name}`).toBeTruthy();await act(async()=>b!.click());}
async function approve(){const input=document.querySelector('input[type=password]') as HTMLInputElement;expect(input).toBeTruthy();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'fixture-password');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});await click('本人確認して実行');}
beforeEach(()=>{vi.clearAllMocks();calls.list.mockResolvedValue({success:true,data:[expired]});calls.create.mockResolvedValue({success:true,data:ready});calls.regenerate.mockResolvedValue({success:true,data:ready});calls.stepUp.mockResolvedValue({success:true,data:{token:'fixture-grant'}});calls.download.mockResolvedValue({totalCount:1,returnedCount:1,truncated:false});rememberSessionSnapshot({impersonation:null,unfamiliarAt:null,stepUpMethod:'password'});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();forgetSessionSnapshot();});
describe('共通情報CSVの本人確認と失敗からのやり直し',()=>{
 it('本人確認後に同じ絞り込みと確認票で依頼する',async()=>{
  calls.create.mockRejectedValueOnce(new ApiError(401,'','STEP_UP_REQUIRED'));await render('account-a','folder-a');await click('CSVで書き出す');
  expect(document.querySelector('[role=dialog] h2')?.textContent).toBe('共通情報を書き出す：パスワードで本人確認');expect(calls.create).toHaveBeenCalledTimes(1);
  await approve();expect(calls.stepUp).toHaveBeenCalledWith({method:'password',value:'fixture-password',purpose:'data.export'});
  expect(calls.create).toHaveBeenLastCalledWith({accountId:'account-a',folderId:'folder-a',ungrouped:undefined},'fixture-grant');
  expect(host.textContent).toContain('完了');expect(host.textContent).not.toContain('失敗しました');
 });
 it('本人確認の取消は書き出しの依頼数を増やさない',async()=>{
  calls.create.mockRejectedValueOnce(new ApiError(401,'','STEP_UP_REQUIRED'));await render();await click('CSVで書き出す');expect(document.querySelector('[role=dialog]')).not.toBeNull();const close=document.querySelector('[role=dialog] button[aria-label=閉じる]') as HTMLButtonElement;expect(close).toBeTruthy();await act(async()=>close.click());
  expect(calls.create).toHaveBeenCalledTimes(1);expect(calls.stepUp).not.toHaveBeenCalled();expect(document.querySelector('[role=dialog]')).toBeNull();
 });
 it('過去の履歴を残して現在の失敗の帯を一つだけ出す',async()=>{
  calls.list.mockResolvedValue({success:true,data:[expired,{...expired,id:'job-older'}]});calls.create.mockRejectedValue(new ApiError(403));await render();await click('CSVで書き出す');
  expect(host.querySelector('[data-testid=vars-export-status]')).toBeNull();expect(host.textContent).toContain('この操作の権限がありません');expect(host.textContent).toContain('最近の書き出し');expect(host.textContent).not.toContain('接続を確かめて');expect(calls.stepUp).not.toHaveBeenCalled();
 });
 it.each(['account','folder'])('%sを替えたら窓を閉じて前の依頼を再開しない',async kind=>{
  calls.create.mockRejectedValueOnce(new ApiError(401,'','STEP_UP_REQUIRED'));await render('account-a','folder-a');await click('CSVで書き出す');expect(document.querySelector('[role=dialog]')).not.toBeNull();
  calls.list.mockResolvedValue({success:true,data:[]});await render(kind==='account'?'account-b':'account-a','folder-b');
  expect(document.querySelector('[role=dialog]')).toBeNull();expect(calls.create).toHaveBeenCalledTimes(1);expect(calls.stepUp).not.toHaveBeenCalled();
 });
 it('ダウンロードは別の本人確認で行いAPIのURLを直接開かない',async()=>{
  calls.list.mockResolvedValue({success:true,data:[ready]});calls.download.mockRejectedValueOnce(new ApiError(401,'','STEP_UP_REQUIRED'));await render();
  expect(host.querySelector('a[href*="/exports/"]')).toBeNull();await click('CSVをダウンロード');expect(document.querySelector('[role=dialog] h2')?.textContent).toBe('共通情報のCSVをダウンロードする：パスワードで本人確認');await approve();
  expect(calls.download).toHaveBeenNthCalledWith(1,ready.downloadUrl,'common-vars-job-new.csv',undefined);
  expect(calls.download).toHaveBeenNthCalledWith(2,ready.downloadUrl,'common-vars-job-new.csv',{stepUpToken:'fixture-grant'});
  expect(calls.create).not.toHaveBeenCalled();expect(calls.regenerate).not.toHaveBeenCalled();
 });
 it('履歴で選んだ書き出しを専用の本人確認で再生成する',async()=>{
  calls.regenerate.mockRejectedValueOnce(new ApiError(401,'','STEP_UP_REQUIRED'));await render();await click('もう一度書き出す');expect(document.querySelector('[role=dialog] h2')?.textContent).toBe('共通情報をもう一度書き出す：パスワードで本人確認');await approve();
  expect(calls.regenerate).toHaveBeenNthCalledWith(1,'job-old');expect(calls.regenerate).toHaveBeenNthCalledWith(2,'job-old','fixture-grant');expect(calls.create).not.toHaveBeenCalled();
 });
 it('結果が分からない依頼を自動再送せず履歴を読み直す',async()=>{
  calls.create.mockRejectedValueOnce(new Error('connection lost'));await render();await click('CSVで書き出す');expect(calls.create).toHaveBeenCalledTimes(1);expect(calls.list).toHaveBeenCalledTimes(2);expect(calls.stepUp).not.toHaveBeenCalled();
  await click('CSVで書き出す');expect(calls.create).toHaveBeenCalledTimes(2);expect(host.textContent).toContain('完了');expect(host.textContent).not.toContain('失敗しました');
 });
 it('切替後に届いた前のアカウントの失敗を出さない',async()=>{
  let reject!:(error:Error)=>void;calls.create.mockImplementationOnce(()=>new Promise((_resolve,rejected)=>{reject=rejected}));await render();await click('CSVで書き出す');
  calls.list.mockResolvedValue({success:true,data:[]});await render('account-b');await act(async()=>reject(new ApiError(403)));
  expect(host.textContent).not.toContain('この操作の権限がありません');expect(document.querySelector('[role=dialog]')).toBeNull();
 });
 it('本人確認を待つ間の二重押下を止める',async()=>{
  calls.create.mockRejectedValueOnce(new ApiError(401,'','STEP_UP_REQUIRED'));await render();await act(async()=>{const b=[...host.querySelectorAll('button')].find(n=>n.textContent==='CSVで書き出す')!;b.click();b.click();});
  expect(calls.create).toHaveBeenCalledTimes(1);expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1);
 });
 it('業務の失敗の安全な理由を通信障害へ置き換えない',async()=>{calls.create.mockResolvedValueOnce({success:false,error:'このフォルダは見つかりません。一覧から選び直してください。'});await render();await click('CSVで書き出す');expect(host.textContent).toContain('このフォルダは見つかりません。一覧から選び直してください。');expect(host.textContent).not.toContain('接続を確かめて');});
});
