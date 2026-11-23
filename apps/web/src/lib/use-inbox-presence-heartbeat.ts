'use client'
import { useEffect } from 'react'
import { gap3InboxApi } from '@/lib/api/helpers/gap3'

/** 画面を操作した時だけ在席を更新する。不在の設定自体は変えない。 */
export function useInboxPresenceHeartbeat(enabled:boolean) {
  useEffect(()=>{
    if(!enabled)return
    let last=0
    const touch=()=>{
      if(document.visibilityState==='hidden'||Date.now()-last<5*60_000)return
      last=Date.now()
      void gap3InboxApi.heartbeat().catch(()=>{})
    }
    touch()
    window.addEventListener('pointerdown',touch,{passive:true})
    window.addEventListener('keydown',touch)
    return ()=>{window.removeEventListener('pointerdown',touch);window.removeEventListener('keydown',touch)}
  },[enabled])
}
