'use client'

import { useLayoutEffect } from 'react'

/*
  「保存できた」「入力がそろった」で次の手順へ進む合図（承認済み Pen 枠 14 (orKSi) 共通ルール izsr5）。

  承認済み台本 guide-script.ts の trigger が 'event' / 'valid' の手順は、
  対象を押しただけでは進めない。画面側が実際に保存できた時・入力がそろった時に
  ここで合図を出し、案内の入れ物がその合図を受けて 1 手順だけ進める。

  画面から案内へ値を渡す道（props）を作らないので、共通部品の形を変えずに済む。
*/

const GUIDE_SIGNAL_EVENT = 'lh:v8:guide-signal'

/**
 * 手順が終わった合図を出す。`anchor` は guide-script.ts の anchor と同じ名前。
 */
export function emitGuideSignal(anchor: string, accountId?: string): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(GUIDE_SIGNAL_EVENT, { detail: { anchor, accountId } }))
  } catch { /* 合図が出せなくても画面の保存そのものは終わっている */ }
}

/** 今の手順の合図だけ受ける。別の手順の合図では進めない。 */
export function useGuideSignal(anchor: string | null, enabled: boolean, onSignal: () => void, accountId?: string): void {
  useLayoutEffect(() => {
    if (!enabled || !anchor || typeof window === 'undefined') return
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<{ anchor?: string; accountId?: string }>).detail
      if (detail?.anchor === anchor && (!accountId || detail.accountId === accountId)) onSignal()
    }
    window.addEventListener(GUIDE_SIGNAL_EVENT, handle)
    return () => window.removeEventListener(GUIDE_SIGNAL_EVENT, handle)
  }, [anchor, enabled, onSignal, accountId])
}
