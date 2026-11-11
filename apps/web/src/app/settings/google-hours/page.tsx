'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount } from '@/contexts/account-context'
import { restaurantGoogleApi } from '@/lib/restaurant-google-api'
import HoursPage from '@/v8/restaurant/google/hours'
import ListState from '@/components/shared/list-state'
import { PageFrame } from '@/components/templates/page-frame'

function GoogleHoursContent() {
  const router = useRouter()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [state, setState] = useState<{ accountId: string; status: 'loading' | 'connected' | 'error' }>({ accountId: '', status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!selectedAccountId) return
    let current = true
    setState({ accountId: selectedAccountId, status: 'loading' })
    restaurantGoogleApi.connection(selectedAccountId).then(data => {
      if (!current) return
      if (data.connection.status === 'connected' && data.connection.locationName) setState({ accountId: selectedAccountId, status: 'connected' })
      else router.replace('/settings/sns?source=hours')
    }).catch(() => { if (current) setState({ accountId: selectedAccountId, status: 'error' }) })
    return () => { current = false }
  }, [selectedAccountId, router, attempt])
  if (!selectedAccountId) return <PageFrame kind="list"><ListState kind="empty" title="LINEアカウントを選んでください" /></PageFrame>
  if (accountLoading || state.accountId !== selectedAccountId || state.status === 'loading') return <PageFrame kind="list"><ListState kind="loading" title="Googleの営業時間を読み込んでいます" /></PageFrame>
  if (state.status === 'error') return <PageFrame kind="list"><ListState kind="error" title="Googleの接続状態を確認できませんでした" onRetry={() => setAttempt(value => value + 1)} /></PageFrame>
  return <HoursPage key={selectedAccountId} accountId={selectedAccountId} tabs={null} shared />
}

export default function Page() {
  return <Suspense fallback={<PageFrame kind="list"><ListState kind="loading" /></PageFrame>}><GoogleHoursContent /></Suspense>
}
