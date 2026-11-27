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
 const active=useRef(true),selectionLock=useRef(false)
 useEffect(()=>{active.current=true;return()=>{active.current=false}},[accountId])
 const [query,setQuery]=useState(''),[page,setPage]=useState(1),[total,setTotal]=useState(0),[templates,setTemplates]=useState<BroadcastTemplateOption[]>([]),[assets,setAssets]=useState<BroadcastMessageAsset[]>([]),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[selectError,setSelectError]=useState(''),[retry,setRetry]=useState(0)
 useEffect(()=>{let live=true;const timer=setTimeout(()=>{
  setLoading(true);setLoadError('');setSelectError('')
  Promise.all([api.templates.listPage({accountId,q:query,page,limit:100}),api.broadcastMessageAssets.list({accountId})]).then(([messages,media])=>{
   if(!live)return
   if(!messages.success||!media.success){setLoadError('テンプレートを読み込めませんでした。もう一度お試しください。');return}
   setTemplates(filterSendableTemplates(messages.data.items,accountId));setTotal(messages.data.total)
   setAssets(media.data.filter(item=>item.lineAccountId===accountId))
  }).catch(()=>{if(live)setLoadError('テンプレートを読み込めませんでした。もう一度お試しください。')}).finally(()=>{if(live)setLoading(false)})
 },200);return()=>{live=false;clearTimeout(timer)}},[accountId,query,page,retry])
 const asset=(id:string)=>assets.find(item=>`asset:${item.id}`===id)
 const template=(id:string)=>templates.find(item=>item.id===id)
 const preview=(id:string)=>{const a=asset(id),t=template(id);const bubble=a?contentTemplateToBubble(a):t?messageTemplateToBubble(t):null;return bubble?[bubble]:[]}
 async function select(id:string){
  if(selectionLock.current||busy||loading||loadError)return
  const a=asset(id);if(a){onPick([contentTemplateToBubble(a)]);return}
  const row=template(id);if(!row)return
  selectionLock.current=true;setBusy(true);setSelectError('')
  try{
   const response=await api.templates.get(row.id)
   if(!active.current)return
   if(!response.success||response.data.accountId!==accountId)throw new Error('account')
   const source=response.data
   const bubbles=source.messageBubbles?.length?source.messageBubbles:[messageTemplateToBubble({...row,...source})].filter((item):item is BroadcastBubble=>!!item)
   if(!bubbles.length||bubbles.length>5)throw new Error('content')
   onPick(bubbles)
  }catch{if(active.current)setSelectError('このテンプレートを読み込めませんでした。もう一度選んでください')}finally{selectionLock.current=false;if(active.current)setBusy(false)}
 }
 return <EntityPickerDialog title="テンプレートから選ぶ" searchPlaceholder="テンプレート名・本文で探す" query={query} onQueryChange={value=>{setQuery(value);setPage(1)}}
  items={[...assets.filter(item=>!query||item.name.includes(query)).map(item=>({id:`asset:${item.id}`,name:item.name,meta:'配信用の素材'})),...templates.map(item=>({id:item.id,name:item.name,folderId:item.folderId,keywords:item.messageContent,meta:'公開済みのテンプレート'}))]}
  state={loading?<p role="status">読み込んでいます…</p>:loadError?<Notice tone="danger" action={<Button variant="text" size="inline" data-notice-inline-action type="button" onClick={()=>setRetry(value=>value+1)}>もう一度読み込む</Button>}>{loadError}</Notice>:undefined}
  error={selectError||undefined} busy={busy||loading} confirmDisabled={!!loadError} onSelect={()=>setSelectError('')}
  listFooter={total>100?<><Button disabled={page<=1||loading} onClick={()=>setPage(value=>value-1)}>前の100件</Button><span>{page}ページ目</span><Button disabled={page*100>=total||loading} onClick={()=>setPage(value=>value+1)}>次の100件</Button></>:undefined}
  preview={item=>item?<FollowupMessageSample bubbles={preview(item.id)} storeName={storeName}/>:null}
  createHref="/templates" createLabel="新しく作る →" onCancel={onCancel} onConfirm={id=>void select(id)}/>
}
