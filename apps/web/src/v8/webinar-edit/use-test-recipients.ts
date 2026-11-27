'use client'
import { useEffect, useRef, useState } from 'react'
import { webinarApi } from '@/lib/api'

type Preview = {count:number;recipients:Array<{id:string;displayName:string|null}>;token:string;confirmationId:string}

function isPreview(data: unknown): data is Preview {
  if (typeof data !== 'object' || data === null) return false
  const value = data as Record<string, unknown>
  return (
    typeof value.count === 'number'
    && Number.isFinite(value.count)
    && Array.isArray(value.recipients)
    && typeof value.token === 'string'
    && typeof value.confirmationId === 'string'
  )
}

export function useTestRecipients(webinarId:string, open:boolean) {
  const scope=useRef({id:webinarId,open,generation:0})
  if(scope.current.id!==webinarId||scope.current.open!==open)scope.current={id:webinarId,open,generation:scope.current.generation+1}
  const rendered=scope.current
  const [result,setResult]=useState<{scope:typeof rendered;preview:Preview|null;error:boolean}|null>(null)
  useEffect(()=>{
    if(!open)return
    let alive=true
    void webinarApi.testNotificationRecipients(webinarId).then(response=>{
      if(!alive||scope.current!==rendered)return
      const failed=!response||(response as {success?:boolean}).success===false
      if(failed||!isPreview(response.data)){
        setResult({scope:rendered,preview:null,error:true})
        return
      }
      setResult({scope:rendered,preview:response.data,error:false})
    }).catch(()=>{if(alive&&scope.current===rendered)setResult({scope:rendered,preview:null,error:true})})
    return ()=>{alive=false}
  },[open,webinarId,rendered])
  const current=open&&result?.scope===rendered?result:null
  return {preview:current?.preview??null,error:current?.error??false,isCurrent:()=>scope.current===rendered&&rendered.open}
}
