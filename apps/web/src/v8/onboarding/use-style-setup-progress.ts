'use client'
import { useEffect, useRef, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import { ACCOUNT_STYLE_UPDATED } from '@/hooks/use-account-style'
import type { StyleSetupProgress } from '@/v8/settings/public/getting-started-steps/index'
import { loadStyleSetupProgress, unknownStyleSetupProgress } from './style-setup-progress'

/** 店とスタイルを切り替えた直後に、前の設定を「済み」として見せない。 */
export function useStyleSetupProgress(accountId: string | null, style: AccountStyle | null, enabled = true, storeId?: string | null) {
  const scope = JSON.stringify([accountId, style, storeId])
  const [snapshot, setSnapshot] = useState<{ scope: string; progress: StyleSetupProgress } | null>(null)
  const [tick, setTick] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    let active = true
    const at = ++generation.current
    if (!enabled || !accountId || !style) return
    void loadStyleSetupProgress(accountId, style, storeId).then(progress => {
      if (active && generation.current === at) setSnapshot({ scope, progress })
    }).catch(() => {
      if (active && generation.current === at) setSnapshot({ scope, progress: unknownStyleSetupProgress(style, '設定を読み込めていません。もう一度読み直してください') })
    })
    return () => { active = false }
  }, [accountId, style, enabled, scope, tick, storeId])
  useEffect(() => {
    const reload = (event: Event) => {
      if (event.type === 'visibilitychange' ? document.visibilityState === 'visible' : (event as CustomEvent<{ accountId: string }>).detail?.accountId === accountId) setTick(value => value + 1)
    }
    window.addEventListener(ACCOUNT_STYLE_UPDATED, reload)
    document.addEventListener('visibilitychange', reload)
    return () => { window.removeEventListener(ACCOUNT_STYLE_UPDATED, reload); document.removeEventListener('visibilitychange', reload) }
  }, [accountId])
  return {
    status: !enabled || !accountId || !style ? 'idle' as const : snapshot?.scope === scope ? 'ready' as const : 'loading' as const,
    progress: enabled && snapshot?.scope === scope ? snapshot.progress : style ? unknownStyleSetupProgress(style) : undefined,
    invalidate: () => { generation.current += 1; setSnapshot(null) },
    reload: () => { generation.current += 1; setSnapshot(null); setTick(value => value + 1) },
  }
}
