'use client'

import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import TargetMissing from '@/components/shared/target-missing'
import PagePending from '@/components/templates/page-pending'
import { markLineAccountEntryReady, resolveLineAccountEntry } from '@/lib/line-account-entry'

export default function LineAccountEntryGate({ accountId, allowHandover = false, children }: {
  accountId: string
  allowHandover?: boolean
  children: ReactNode
}) {
  const { replace } = useRouter()
  const [status, setStatus] = useState<'pending' | 'dashboard' | 'unavailable' | 'error'>('pending')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!accountId) return
    let active = true
    void resolveLineAccountEntry(accountId).then((result) => {
      if (!active) return
      if ('href' in result) {
        if (allowHandover && result.destination === 'handover') setStatus('dashboard')
        else replace(result.href)
      } else setStatus(result.destination)
    }).catch(() => { if (active) setStatus('error') })
    return () => { active = false }
  }, [accountId, allowHandover, replace, retry])

  useLayoutEffect(() => {
    if (status === 'dashboard' && !allowHandover) return markLineAccountEntryReady(accountId)
  }, [accountId, allowHandover, status])

  if (status === 'dashboard') return <>{children}</>
  if (!accountId || status === 'unavailable') return <TargetMissing kind="not-found" title="登録を再開できませんでした"
    description="アカウントの状態が変わったため、LINEアカウントの一覧で確認してください。"
    backHref="/hq" backLabel="アカウント一覧へ" />
  if (status === 'error') return <PagePending stage="handover" failed errorTitle="登録の状態を確認できませんでした"
    onRetry={() => { setStatus('pending'); setRetry(value => value + 1) }} />
  return <PagePending stage="handover" loadingTitle="登録の状態を確認しています" />
}
