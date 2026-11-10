'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useAccount } from '@/contexts/account-context'
import PagePending from '@/components/templates/page-pending'
import { api } from '@/lib/api'
import { decideRootLanding, musuboOnboardingResumePath } from '@/lib/hq-navigation'

export default function RootLandingGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { accounts, selectedAccountId, setSelectedAccountId, loading, error, refreshing, refreshAccounts } = useAccount()
  // 一覧の取得に失敗したのに店舗数0として扱うと、統括へ飛ばされて
  // 「アカウントが1件も無い」ように見える（Issue #978）。
  const loadFailed = pathname === '/' && Boolean(error) && !loading && accounts.length === 0
  const decision = pathname === '/' && !loadFailed
    ? decideRootLanding(loading, selectedAccountId, accounts.map((account) => account.id))
    : { action: 'show-dashboard' as const }
  const decisionAccountId = decision.action === 'select-account' ? decision.accountId : null
  const needsOnboardingLookup = decision.action === 'go-hq' && accounts.length === 0

  useEffect(() => {
    if (decision.action === 'select-account' && decisionAccountId) {
      setSelectedAccountId(decisionAccountId)
    } else if (decision.action === 'go-hq' && !needsOnboardingLookup) {
      router.replace('/hq')
    }
  }, [decision.action, decisionAccountId, needsOnboardingLookup, router, setSelectedAccountId])

  useEffect(() => {
    if (!needsOnboardingLookup) return
    let cancelled = false
    void api.musuboOnboardingPricing.get().then((response) => {
      if (cancelled) return
      router.replace(response.success ? musuboOnboardingResumePath(response.data) ?? '/hq' : '/hq')
    }).catch(() => { if (!cancelled) router.replace('/hq') })
    return () => { cancelled = true }
  }, [needsOnboardingLookup, router])

  if (loadFailed) {
    return (
      <PagePending
        stage="root"
        failed
        errorTitle="アカウント一覧を読み込めませんでした"
        description="通信状況を確認して、もう一度お試しください。"
        onRetry={() => { void refreshAccounts() }}
        retrying={refreshing}
      />
    )
  }

  if (decision.action !== 'show-dashboard') {
    return <PagePending stage="root" />
  }

  return <>{children}</>
}
