'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { opsCall } from '@/components/ops/ops-ui'

/**
 * いまの運営メンバーが閲覧のみか（/api/ops/me の readOnly）。
 * 分かるまでは閲覧のみとして扱う。理由つきの押せない形にする画面は
 * `useOpsReadOnlyState` を使う（2026-10-26 オーナー決定：隠さず灰色＋理由）。
 * 取れなかったときも閲覧のみのまま（変える操作は出さない）。
 */
export function useOpsReadOnly(): boolean {
  return useOpsReadOnlyState() !== 'writer'
}

/** 閲覧のみの運営メンバーに押せない操作を見せる時の理由（2026-10-26 オーナー決定：全画面で隠さず灰色＋理由）。 */
export const OPS_READONLY_LOCK_REASON = '閲覧のみで見ています。変える時は書ける運営メンバーに頼んでください。'

/** 運営メンバーの書き込みの可否（分かるまでは 'unknown'）。理由つきの押せない形に使う。 */
export function useOpsReadOnlyState(): 'unknown' | 'readonly' | 'writer' {
  const [state, setState] = useState<'unknown' | 'readonly' | 'writer'>('unknown')
  useEffect(() => {
    let active = true
    let call: ReturnType<typeof api.ops.me> | null = null
    try {
      call = api.ops.me()
    } catch {
      call = null
    }
    if (!call) return () => { active = false }
    void opsCall(call).then((res) => {
      if (!active || !res.success) return
      const readOnly = (res.data as { readOnly?: unknown } | null | undefined)?.readOnly
      if (typeof readOnly === 'boolean') setState(readOnly ? 'readonly' : 'writer')
    })
    return () => { active = false }
  }, [])
  return state
}
