'use client'
import { useEffect,useRef,useState } from 'react'
import type { BroadcastBubble } from '@line-crm/shared'
import type { BroadcastMessageAsset } from '@/lib/api/types/broadcasts'
import { api } from '@/lib/api'
import { contentTemplateToBubble,messageTemplateToBubble,type BroadcastTemplateOption } from '@/lib/broadcast-template'
import { filterSendableTemplates } from '@/components/scenarios/carousel-picker'
import { EntityPickerDialog } from '@/components/shared/entity-picker'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { FollowupMessageSample } from './message-sample'
export function FollowupTemplatePicker({accountId,storeName,onCancel,onPick}:{accountId:string;storeName:string;onCancel:()=>void;onPick:(bubbles:BroadcastBubble[])=>void}){
 const accountRef=useRef(accountId),selectSeq=useRef(0),selectionLock=useRef(false)
 accountRef.current=accountId
 const [query,setQuery]=useState(''),[page,setPage]=useState(1),[loaded,setLoaded]=useState<{accountId:string;templates:BroadcastTemplateOption[];assets:BroadcastMessageAsset[];total:number}>({accountId,templates:[],assets:[],total:0}),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[selectError,setSelectError]=useState(''),[retry,setRetry]=useState(0)
 useEffect(()=>{
  selectSeq.current+=1
  selectionLock.current=false
  setBusy(false)
  setSelectError('')
  setLoadError('')
  setPage(1)
  setLoading(true)
  return()=>{selectSeq.current+=1}
 },[accountId])
 useEffect(()=>{let live=true;setLoading(true);setLoadError('');setSelectError('');const requestAccount=accountId;const timer=setTimeout(()=>{
  Promise.all([api.templates.listPage({accountId:requestAccount,q:query,page,limit:100}),api.broadcastMessageAssets.list({accountId:requestAccount})]).then(([messages,media])=>{
   if(!live||accountRef.current!==requestAccount)return
   if(!messages.success||!media.success||!Array.isArray(messages.data?.items)||!Array.isArray(media.data)){setLoadError('テンプレートを読み込めませんでした。もう一度お試しください。');return}
   setLoaded({accountId:requestAccount,templates:filterSendableTemplates(messages.data.items,requestAccount),assets:media.data.filter(item=>item.lineAccountId===requestAccount),total:messages.data.total})
  }).catch(()=>{if(live&&accountRef.current===requestAccount)setLoadError('テンプレートを読み込めませんでした。もう一度お試しください。')}).finally(()=>{if(live&&accountRef.current===requestAccount)setLoading(false)})
 },200);return()=>{live=false;clearTimeout(timer)}},[accountId,query,page,retry])
 const inScope=loaded.accountId===accountId
 const templates=inScope?loaded.templates:[],assets=inScope?loaded.assets:[],total=inScope?loaded.total:0
 const effectiveLoading=loading||!inScope
 const asset=(id:string)=>assets.find(item=>`asset:${item.id}`===id&&item.lineAccountId===accountId)
 const template=(id:string)=>templates.find(item=>item.id===id)
 const preview=(id:string)=>{const a=asset(id),t=template(id);const bubble=a?contentTemplateToBubble(a):t?messageTemplateToBubble(t):null;return bubble?[bubble]:[]}
 async function select(id:string){
  if(selectionLock.current||busy||effectiveLoading||loadError)return
  const a=asset(id);if(a){onPick([contentTemplateToBubble(a)]);return}
  const row=template(id);if(!row)return
  const seq=++selectSeq.current
  const requestAccount=accountId
  selectionLock.current=true;setBusy(true);setSelectError('')
  try{
   const response=await api.templates.get(row.id)
   if(selectSeq.current!==seq||accountRef.current!==requestAccount)return
   if(!response.success||response.data.accountId!==requestAccount)throw new Error('account')
   const source=response.data
   const bubbles=source.messageBubbles?.length?source.messageBubbles:[messageTemplateToBubble({...row,...source})].filter((item):item is BroadcastBubble=>!!item)
   if(!bubbles.length||bubbles.length>5)throw new Error('content')
   onPick(bubbles)
  }catch{if(selectSeq.current===seq&&accountRef.current===requestAccount)setSelectError('このテンプレートを読み込めませんでした。もう一度選んでください')}finally{if(selectSeq.current===seq&&accountRef.current===requestAccount){selectionLock.current=false;setBusy(false)}}
 }
 return <EntityPickerDialog title="テンプレートから選ぶ" searchPlaceholder="テンプレート名・本文で探す" query={query} onQueryChange={value=>{setQuery(value);setPage(1)}}
  items={[...assets.filter(item=>!query||item.name.includes(query)).map(item=>({id:`asset:${item.id}`,name:item.name,meta:'配信用の素材'})),...templates.map(item=>({id:item.id,name:item.name,folderId:item.folderId,keywords:item.messageContent,meta:'公開済みのテンプレート'}))]}
  state={effectiveLoading?<p role="status">読み込んでいます…</p>:loadError?<Notice tone="danger" action={<Button variant="text" size="inline" data-notice-inline-action type="button" onClick={()=>setRetry(value=>value+1)}>もう一度読み込む</Button>}>{loadError}</Notice>:undefined}
  error={selectError||undefined} busy={busy||effectiveLoading} confirmDisabled={!!loadError} onSelect={()=>setSelectError('')}
  listFooter={total>100?<><Button disabled={page<=1||effectiveLoading} onClick={()=>setPage(value=>value-1)}>前の100件</Button><span>{page}ページ目</span><Button disabled={page*100>=total||effectiveLoading} onClick={()=>setPage(value=>value+1)}>次の100件</Button></>:undefined}
  preview={item=>item?<FollowupMessageSample bubbles={preview(item.id)} storeName={storeName}/>:null}
  createHref="/templates" createLabel="新しく作る →" onCancel={onCancel} onConfirm={id=>void select(id)}/>
}
