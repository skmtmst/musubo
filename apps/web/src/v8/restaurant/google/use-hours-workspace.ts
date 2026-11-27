'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyHoursWorkspace, type HoursWorkspace, type HoursWorkspaceData } from '@line-crm/shared'
import { restaurantGoogleApi, type GoogleProfileData, type GoogleChange } from '@/lib/restaurant-google-api'
import { guideDraftKey, readGuideDraft, writeGuideDraft } from '@/lib/scoped-guide-draft'
import { errorMessage } from './format'
import { importServices } from './hours-model'

type HoursDraft = { version: number; workspace: HoursWorkspace }

export function useHoursWorkspace(accountId:string, retainDraft = false) {
 const [data,setData]=useState<GoogleProfileData|null>(null)
 const [config,setConfig]=useState<HoursWorkspaceData|null>(null)
 const [workspace,setWorkspace]=useState<HoursWorkspace>(emptyHoursWorkspace)
 const [loading,setLoading]=useState(true)
 const [error,setError]=useState('')
 const [saveError,setSaveError]=useState('')
 const [saving,setSaving]=useState(false)
 const [saved,setSaved]=useState('')
 const [changes,setChanges]=useState<GoogleChange[]>([])
 const version=useRef(0),current=useRef(workspace),savedRef=useRef(''),scopeGen=useRef(0),loadGen=useRef(0),prevAccount=useRef(accountId),queue=useRef<Promise<unknown>>(Promise.resolve()),blocked=useRef(false)
 const scope=useRef<string|null>(null)
 const editedHere=useRef(false)
 const load=useCallback(async(force=false)=>{
  const myScope=scopeGen.current,myLoad=++loadGen.current
  const isCurrent=()=>scopeGen.current===myScope&&loadGen.current===myLoad
  setLoading(true);setError('');setSaveError('');blocked.current=false
  try{const profile=await (force ? restaurantGoogleApi.syncProfile(accountId) : restaurantGoogleApi.profile(accountId));const setting=await restaurantGoogleApi.hoursWorkspace(accountId);if(!isCurrent())return
    if(profile.store.lineAccountId!==accountId)throw new Error('選択した店舗の営業時間を読み込めませんでした。')
    const w=structuredClone(setting.data)
    if(setting.version===0)w.services=importServices(profile)
    scope.current=retainDraft?guideDraftKey(`hours-workspace:${profile.profile.name}`,accountId,profile.store.id):null
    const draft=readGuideDraft<HoursDraft>(scope.current)
    const restored=draft?.version===setting.version&&Array.isArray(draft.workspace?.draft?.reviewIds)?draft.workspace:w
    if(draft&&restored===w)writeGuideDraft(scope.current,null)
    editedHere.current=false
    setData(profile);setConfig(setting);version.current=setting.version;current.current=restored;setWorkspace(restored);setChanges([]);const serial=JSON.stringify(w);savedRef.current=serial;setSaved(serial)
  }catch(e){if(isCurrent())setError(errorMessage(e,'営業時間を読み込めませんでした。'))}finally{if(isCurrent())setLoading(false)}
 },[accountId,retainDraft])
 useEffect(()=>{
  const switched=prevAccount.current!==accountId
  prevAccount.current=accountId
  scopeGen.current+=1
  if(switched){
    const empty=emptyHoursWorkspace()
    version.current=0;current.current=empty;savedRef.current='';scope.current=null;editedHere.current=false;blocked.current=false;queue.current=Promise.resolve()
    setData(null);setConfig(null);setWorkspace(empty);setSaved('');setChanges([]);setSaving(false);setSaveError('');setError('')
  }
  void load()
  return()=>{scopeGen.current+=1;loadGen.current+=1}
 },[accountId,load])
 const update=useCallback((w:HoursWorkspace)=>{
  editedHere.current=true;current.current=w;setWorkspace(w);setSaveError('')
  writeGuideDraft(scope.current,JSON.stringify(w)===savedRef.current?null:{version:version.current,workspace:w})
 },[])
 const persist=useCallback((next:HoursWorkspace,summary='')=>{
   const myScope=scopeGen.current
   const serial=JSON.stringify(next)
   const task=queue.current.catch(()=>undefined).then(async()=>{
    if(scopeGen.current!==myScope)return
    if(blocked.current)throw new Error('保存が競合しています。再読み込みしてください。')
    if(serial===savedRef.current)return
    setSaving(true)
    try{const response=await restaurantGoogleApi.saveHoursWorkspace(accountId,version.current,next,summary)
      if(scopeGen.current!==myScope)return
      version.current=response.version;savedRef.current=serial
      writeGuideDraft(scope.current,JSON.stringify(current.current)===serial?null:{version:response.version,workspace:current.current})
      setSaved(serial);setConfig(old=>old?{...old,version:response.version,history:response.history}:old);setSaveError('')
    }catch(e){if(scopeGen.current===myScope){blocked.current=true;setSaveError(errorMessage(e,'下書きを保存できませんでした。入力は残っています。再読み込みの前に内容を控えてください。'))}throw e}
    finally{if(scopeGen.current===myScope)setSaving(false)}
   });queue.current=task;return task
 },[accountId])
 useEffect(()=>{if(!editedHere.current||!config||JSON.stringify(workspace)===saved||blocked.current)return;const timer=setTimeout(()=>{void persist(workspace).catch(()=>undefined)},600);return()=>clearTimeout(timer)},[workspace,config,saved,persist])
 const flush=useCallback(async()=>{await queue.current;await persist(current.current)},[persist])
 const restoreReview=useCallback(async()=>{
  const myScope=scopeGen.current
  const ids=current.current.draft.reviewIds
  const rows=await Promise.all(ids.map(id=>restaurantGoogleApi.change(accountId,id)))
  if(scopeGen.current!==myScope||current.current.draft.reviewIds!==ids)return false
  setChanges(rows.map(row=>row.change));return true
 },[accountId])
 const review=useCallback(async()=>{
  const myScope=scopeGen.current
  await flush()
  if(scopeGen.current!==myScope)return []
  const w=current.current
  if(w.draft.reviewIds.length){const rows=await Promise.all(w.draft.reviewIds.map(id=>restaurantGoogleApi.change(accountId,id)));if(scopeGen.current!==myScope)return [];setChanges(rows.map(r=>r.change));return rows.map(r=>r.change)}
  const response=await restaurantGoogleApi.reviewHoursWorkspace(accountId,version.current)
  if(scopeGen.current!==myScope)return []
  const ordered=[...response.changes].sort((a,b)=>(a.kind==='special_hours'?0:a.kind==='regular_hours'?1:2)-(b.kind==='special_hours'?0:b.kind==='regular_hours'?1:2))
  const next={...w,holidayManagedDates:response.holidayManagedDates??w.holidayManagedDates,draft:{...w.draft,reviewIds:ordered.map(c=>c.id)}};update(next);await persist(next,'営業時間の変更案を確認');if(scopeGen.current!==myScope)return [];setChanges(ordered);return ordered
 },[accountId,flush,persist,update])
 const complete=useCallback(async(google=true)=>{
  const myScope=scopeGen.current
  const next={...current.current,draft:emptyHoursWorkspace().draft};update(next);await persist(next,google?'Googleへ営業時間の変更を送信':'営業時間の設定を保存')
  if(scopeGen.current!==myScope)return
  const profile=await restaurantGoogleApi.profile(accountId);if(scopeGen.current===myScope)setData(profile)
 },[accountId,persist,update])
 return {data,config,workspace,update,loading,error,saveError,saving,saved:JSON.stringify(workspace)===saved,load,flush,review,restoreReview,changes,setChanges,complete}
}
