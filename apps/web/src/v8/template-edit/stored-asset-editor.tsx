'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { api, type BroadcastMessageAsset } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import { TemplateEditFrame } from './frame'

type StoredAssetResult =
  | { scope: string; id: string; status: 'ready'; asset: BroadcastMessageAsset }
  | { scope: string; id: string; status: 'missing' }
  | { scope: string; id: string; status: 'error' }

/** A stored coupon is opened through the same editor as a new coupon. */
export default function StoredAssetEditor({ id, children }: { id: string; children: (asset: BroadcastMessageAsset) => ReactNode }) {
  const { selectedAccountId } = useAccount()
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<StoredAssetResult | null>(null)
  useEffect(() => {
    if (!selectedAccountId) return
    let current = true
    setResult(null)
    void api.broadcastMessageAssets.list({ accountId: selectedAccountId, kind: 'coupon' }).then(response => {
      if (!current) return
      if (!response.success || !Array.isArray(response.data)) {
        setResult({ scope: selectedAccountId, id, status: 'error' })
        return
      }
      const asset = response.data.find(item => item.id === id && (item.lineAccountId === selectedAccountId || item.lineAccountId === null))
      setResult(asset
        ? { scope: selectedAccountId, id, status: 'ready', asset }
        : { scope: selectedAccountId, id, status: 'missing' })
    }).catch(() => { if (current) setResult({ scope: selectedAccountId, id, status: 'error' }) })
    return () => { current = false }
  }, [selectedAccountId, id, attempt])
  const active = result?.scope === selectedAccountId && result.id === id ? result : null
  if (active?.status === 'ready') return children(active.asset)
  return <TemplateEditFrame boardId="S6FEuB" title="クーポンを編集する" description="保存されているクーポンを読み込みます。" side={null}>
    {!selectedAccountId ? (
      <ListState
        kind="empty"
        title="LINEアカウントを選んでください"
        description="編集するクーポンがあるLINEアカウントを選んでから開いてください。"
      />
    ) : !active ? (
      <ListState kind="loading" title="クーポンを読み込んでいます" />
    ) : active.status === 'error' ? (
      <ListState
        kind="error"
        title="クーポンを読み込めませんでした"
        description="通信状態を確認して、もう一度読み込んでください。"
        onRetry={() => setAttempt(value => value + 1)}
      />
    ) : (
      <ListState
        kind="empty"
        title="このクーポンは見つかりません"
        description="削除されたか、別のLINEアカウントのものです。一覧から選び直してください。"
        action={<Button type="button" onClick={() => setAttempt(value => value + 1)}>もう一度確認する</Button>}
      />
    )}
  </TemplateEditFrame>
}
