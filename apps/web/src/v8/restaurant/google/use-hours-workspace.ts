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
 const version=useRef(0),current=useRef(workspace),savedRef=useRef(''),alive=useRef(true),queue=useRef<Promise<unknown>>(Promise.resolve()),blocked=useRef(false)
 const scope=useRef<string|null>(null)
 const editedHere=useRef(false)
 const load=useCallback(async(force=false)=>{
  setLoading(true);setError('');setSaveError('');blocked.current=false
  try{const profile=await (force ? restaurantGoogleApi.syncProfile(accountId) : restaurantGoogleApi.profile(accountId));const setting=await restaurantGoogleApi.hoursWorkspace(accountId);if(!alive.current)return
    if(profile.store.lineAccountId!==accountId)throw new Error('選択した店舗の営業時間を読み込めませんでした。')
    const w=structuredClone(setting.data)
    if(setting.version===0)w.services=importServices(profile)
    scope.current=retainDraft?guideDraftKey(`hours-workspace:${profile.profile.name}`,accountId,profile.store.id):null
    const draft=readGuideDraft<HoursDraft>(scope.current)
    const restored=draft?.version===setting.version&&Array.isArray(draft.workspace?.draft?.reviewIds)?draft.workspace:w
    if(draft&&restored===w)writeGuideDraft(scope.current,null)
    editedHere.current=false
    setData(profile);setConfig(setting);version.current=setting.version;current.current=restored;setWorkspace(restored);setChanges([]);const serial=JSON.stringify(w);savedRef.current=serial;setSaved(serial)
  }catch(e){if(alive.current)setError(errorMessage(e,'営業時間を読み込めませんでした。'))}finally{if(alive.current)setLoading(false)}
 },[accountId,retainDraft])
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false}},[load])
 const update=useCallback((w:HoursWorkspace)=>{
  editedHere.current=true;current.current=w;setWorkspace(w);setSaveError('')
  writeGuideDraft(scope.current,JSON.stringify(w)===savedRef.current?null:{version:version.current,workspace:w})
 },[])
 const persist=useCallback((next:HoursWorkspace,summary='')=>{
   const serial=JSON.stringify(next)
   const task=queue.current.catch(()=>undefined).then(async()=>{
    if(blocked.current)throw new Error('保存が競合しています。再読み込みしてください。')
    if(serial===savedRef.current)return
    setSaving(true)
    try{const response=await restaurantGoogleApi.saveHoursWorkspace(accountId,version.current,next,summary);version.current=response.version;savedRef.current=serial
      if(alive.current){
        writeGuideDraft(scope.current,JSON.stringify(current.current)===serial?null:{version:response.version,workspace:current.current})
        setSaved(serial);setConfig(old=>old?{...old,version:response.version,history:response.history}:old);setSaveError('')
      }
    }catch(e){blocked.current=true;if(alive.current)setSaveError(errorMessage(e,'下書きを保存できませんでした。入力は残っています。再読み込みの前に内容を控えてください。'));throw e}
    finally{if(alive.current)setSaving(false)}
   });queue.current=task;return task
 },[accountId])
 useEffect(()=>{if(!editedHere.current||!config||JSON.stringify(workspace)===saved||blocked.current)return;const timer=setTimeout(()=>{void persist(workspace).catch(()=>undefined)},600);return()=>clearTimeout(timer)},[workspace,config,saved,persist])
 const flush=useCallback(async()=>{await queue.current;await persist(current.current)},[persist])
 const restoreReview=useCallback(async()=>{
  const ids=current.current.draft.reviewIds
  const rows=await Promise.all(ids.map(id=>restaurantGoogleApi.change(accountId,id)))
  if(!alive.current||current.current.draft.reviewIds!==ids)return false
  setChanges(rows.map(row=>row.change));return true
 },[accountId])
 const review=useCallback(async()=>{
  await flush()
  const w=current.current
  if(w.draft.reviewIds.length){const rows=await Promise.all(w.draft.reviewIds.map(id=>restaurantGoogleApi.change(accountId,id)));setChanges(rows.map(r=>r.change));return rows.map(r=>r.change)}
  const response=await restaurantGoogleApi.reviewHoursWorkspace(accountId,version.current)
  const ordered=[...response.changes].sort((a,b)=>(a.kind==='special_hours'?0:a.kind==='regular_hours'?1:2)-(b.kind==='special_hours'?0:b.kind==='regular_hours'?1:2))
  const next={...w,holidayManagedDates:response.holidayManagedDates??w.holidayManagedDates,draft:{...w.draft,reviewIds:ordered.map(c=>c.id)}};update(next);await persist(next,'営業時間の変更案を確認');setChanges(ordered);return ordered
 },[accountId,flush,persist,update])
 const complete=useCallback(async(google=true)=>{
  const next={...current.current,draft:emptyHoursWorkspace().draft};update(next);await persist(next,google?'Googleへ営業時間の変更を送信':'営業時間の設定を保存')
  const profile=await restaurantGoogleApi.profile(accountId);if(alive.current)setData(profile)
 },[accountId,persist,update])
 return {data,config,workspace,update,loading,error,saveError,saving,saved:JSON.stringify(workspace)===saved,load,flush,review,restoreReview,changes,setChanges,complete}
}
