'use client'

import { useEffect, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { notifySaved } from '@/components/shared/toast'
import { hqStyleApi, type StarterDistributionPreview, type StarterDistributionTarget } from '@/lib/api/helpers/styles'

/** 統括の配る口が 1 回で受ける数（今の口の上限）。 */
export const DISTRIBUTE_ACCOUNT_LIMIT = 100

export type DistributeDraft = { target: 'style' | 'pick'; accounts: string[]; editedAction: 'notify' | 'new_copy' }

function targetOf(style: AccountStyle, draft: DistributeDraft): StarterDistributionTarget | null {
  if (draft.target === 'style') return { style }
  if (draft.accounts.length === 0 || draft.accounts.length > DISTRIBUTE_ACCOUNT_LIMIT) return null
  return { accountIds: [...draft.accounts].sort() }
}

/**
 * 配る前の確かめ。配る先が決まるたびに preflight で数（対象・店で編集済みの物）と token を読み、
 * その token で distribute する。配る先を変えたら読み直すまで押せない（古い数のまま配らない）。
 */
export function useDistribute(style: AccountStyle, version: number | null, onDone: () => void) {
  const [draft, setDraft] = useState<DistributeDraft | null>(null)
  const [preview, setPreview] = useState<{ key: string; data: StarterDistributionPreview } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick,setTick]=useState(0)
  const target = draft && version !== null ? targetOf(style, draft) : null
  const key = target ? JSON.stringify({ style, version, target }) : null

  useEffect(() => {
    setPreview(null)
    if (!key || !target || version === null) return
    let cancelled = false
    void hqStyleApi.preflight(style, { expectedVersion: version, target }).then((res) => {
      if (!res.success) throw new Error('preflight failed')
      if (typeof res.data?.token !== 'string' || !res.data.token.trim() || !Number.isSafeInteger(res.data.accountCount) || res.data.accountCount < 0 || !Number.isSafeInteger(res.data.editedCount) || res.data.editedCount < 0) throw new Error('preflight failed')
      if (!cancelled) setPreview({ key, data: res.data })
    }).catch((caught: unknown) => { if (!cancelled) setError(describeApiFailure(caught, '読み込み', { scope: 'hq' })) })
    return () => { cancelled = true }
  }, [key,tick]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{setError('')},[key])

  const ready = preview !== null && preview.key === key
  const run = async () => {
    if (!draft || !target || !ready || preview.data.accountCount === 0 || version === null || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await hqStyleApi.distribute(style, { expectedVersion: version, target, token: preview.data.token, confirmed: true, editedAction: draft.editedAction })
      if (!res.success) throw new Error('distribute failed')
      if(res.data.items.some(item=>item.action==='failed')){setError('一部の物を入れられませんでした。入力を残しています。もう一度、配る先を確認してください。');onDone();setTick(n=>n+1);return}
      const held = res.data.items.filter((item) => item.action === 'pending').length
      notifySaved(held > 0 ? `${res.data.accountCount} アカウントへ配りました（確認が必要な ${held} 件は保留にして知らせました）` : `${res.data.accountCount} アカウントへ配りました`)
      setDraft(null)
      onDone()
    } catch (caught) {
      setError(describeApiFailure(caught, '配る操作', { scope: 'hq' }))
    } finally {
      setBusy(false)
    }
  }
  const tooMany = draft?.target === 'pick' && draft.accounts.length > DISTRIBUTE_ACCOUNT_LIMIT
  return { draft, setDraft, preview: ready ? preview.data : null, error, busy, run, tooMany }
}
