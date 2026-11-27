'use client'
import { useEffect, useState } from 'react'
import type { AccountStyle,InitialMenuTarget } from '@line-crm/shared'
import { api } from '@/lib/api'
import { styleApi } from '@/lib/api/helpers/styles'

export type StarterButton = { target?:InitialMenuTarget;ready?:boolean;reason?:string;destination?:string;formId?:string|null;bounds?:{x:number;y:number;width:number;height:number};label: string; feature: string; actionType?: 'uri' | 'message'; actionData?: string }
type ResolvedPreview = { key: string; imageR2Key?:string|null;imageHeight?:number;buttons: StarterButton[] }

/** 保存と同じ解決済みのボタンだけ。未設定の行き先を見本で補わない。 */
export function useStarterMenu(accountId: string | null, style: AccountStyle) {
  const [snapshot, setSnapshot] = useState<{ accountId: string; style: AccountStyle; buttons: StarterButton[] | null;imageR2Key?:string|null;imageHeight?:number;error: unknown } | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    setSnapshot(null)
    if (!accountId) return
    let active = true
    void styleApi.starterSet(accountId, style).then(res => {
      if (!res.success) throw new Error('見本を読み込めませんでした')
      // T01の追加応答。未提供のWorkerで名前だけを本物のボタンとして描かない。
      const preview = (res.data as typeof res.data & { preview?: ResolvedPreview[] }).preview
      if (!Array.isArray(preview)) throw new Error('見本の行き先を確認できませんでした。時間をおいて、もう一度お試しください。')
      const buttons = preview[0]?.buttons??[]
      if (active) setSnapshot({ accountId, style, buttons,imageR2Key:preview[0]?.imageR2Key,imageHeight:preview[0]?.imageHeight,error: null })
    }).catch(error => { if (active) setSnapshot({ accountId, style, buttons: null, error }) })
    return () => { active = false }
  }, [accountId, style, tick])
  const current = snapshot?.accountId === accountId && snapshot.style === style ? snapshot : null
  return { imageUrl:current?.imageR2Key===null?null:current?.imageR2Key?api.richMenuGroups.imageUrl(current.imageR2Key):undefined,imageHeight:current?.imageHeight,buttons: current?.buttons ?? [], loading: Boolean(accountId) && !current, error: current?.error ?? null, reload: () => setTick(n => n + 1) }
}
