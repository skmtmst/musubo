'use client'
import dynamic from 'next/dynamic'
import { useAccountStyle } from '@/hooks/use-account-style'
import StaleStyleNotice from '@/components/shared/stale-style-notice'
import PagePending from '@/components/templates/page-pending'
import { PageContent, PageFrame, PageHeading } from '@/components/templates/page-frame'
import ListState from '@/components/shared/list-state'
import { useAccount } from '@/contexts/account-context'
import type { IndustryStyle, UsageStyle } from './model'
import { DashboardV8 as StandardDashboard } from '@/v8/dashboard/index'

/*
 * ホーム（/）の入口。アカウントの使い方のスタイルで出し分ける。
 * 飲食・サロン・面談・教室は業種ダッシュボード、標準・ECは共通のダッシュボードに、それぞれ使うカードだけを出す。
 * スタイルは GET /api/dashboard/style（styleApi.get）の正本を読む。未取得・失敗は分け、端末に残った前の業種へ戻さない。
 */

/* 業種が分かるまでの同じ形。題は最初からダッシュボード、中身は骨組み。別の画面や別の題を出さない。 */
function HomeLoading({ error, onRetry }: { error?: unknown; onRetry?: () => void }) {
  return <PagePending variant="dashboard" stage="style" failed={Boolean(error)} error={error} errorTitle="使い方のスタイルを読み込めませんでした" onRetry={onRetry} />
}

const StyleDashboard = dynamic(() => import('./style-dashboard'), { ssr: false, loading: () => <HomeLoading /> })

const INDUSTRY: readonly UsageStyle[] = ['restaurant', 'salon', 'consult', 'lesson']

export default function HomeDashboard() {
  const { selectedAccountId, loading: accountsLoading, error: accountsError, accounts, refreshAccounts } = useAccount()
  const profile = useAccountStyle(selectedAccountId)
  if (!accountsLoading && !selectedAccountId && accountsError) return <PagePending variant="dashboard" stage="style" failed error={accountsError} errorTitle="アカウント一覧を読み込めませんでした" onRetry={() => void refreshAccounts()} />
  if (!accountsLoading && !selectedAccountId && accounts.length > 1) return <PageFrame kind="dashboard"><PageHeading title="ダッシュボード" /><PageContent layout="stats"><ListState kind="empty" title="上部でLINE公式アカウントを選んでください" /></PageContent></PageFrame>
  // 店が1件も無い時だけ共通画面へ。それ以外は業種が分かるまで読み込み中の同じ形。
  const noAccounts = !accountsLoading && !accountsError && accounts.length === 0
  if (!profile.data && !profile.error && !noAccounts) return <HomeLoading />
  if (profile.error && !profile.data) return <HomeLoading error={profile.error} onRetry={profile.reload} />
  const style = profile.data?.style ?? 'standard'
  const stale = profile.stale ? <StaleStyleNotice onRetry={profile.reload} /> : null
  if (INDUSTRY.includes(style)) return <>{stale}<StyleDashboard key={style} style={style as IndustryStyle} /></>
  return <>{stale}<StandardDashboard key={selectedAccountId} usageStyle={style === 'ec' ? 'ec' : 'standard'} accountStyle={style} /></>
}
