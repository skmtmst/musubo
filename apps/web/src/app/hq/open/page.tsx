'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import HqAccountList from '@/components/hq/account-list'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { usePageTitle } from '@/components/shell/page-chrome'
import { useAccount, type AccountWithStats } from '@/contexts/account-context'
import { isForbidden } from '@/components/shared/api-error-message'
import { api } from '@/lib/api'
import { resolveHqOpenTarget, type HqOpenTarget } from '@/lib/hq-navigation'

export default function HqOpenPage() {
  // 左のメニューと同じ名前を見出しにする（/hq と同じ）。
  usePageTitle('アカウント')
  const router = useRouter()
  const { setSelectedAccountId } = useAccount()
  const [target, setTarget] = useState<HqOpenTarget | null>(null)
  const [accounts, setAccounts] = useState<AccountWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<unknown>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const resolved = resolveHqOpenTarget(new URLSearchParams(window.location.search).get('target'))
    if (!resolved) {
      router.replace('/hq')
      return
    }
    setTarget(resolved)
  }, [router])

  useEffect(() => {
    if (!target) return
    let cancelled = false
    void api.lineAccounts.list()
      .then((response) => {
        if (cancelled) return
        if (!response.success) throw new Error(response.error)
        setAccounts(response.data as AccountWithStats[])
      })
      .catch((caught) => {
        // R608: 403は押しても直らない権限不足なので、捕まえた失敗をそのまま
        // 残して描画側で言い分ける（文言をここで決めると503と混ざる）。
        if (!cancelled) setFailure(caught)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [target, reloadKey])

  const openStorePage = (accountId: string) => {
    if (!target) return
    setSelectedAccountId(accountId)
    router.push(target.destination)
  }

  if (!target) {
    return (
      <div className="flex min-h-64 items-center justify-center" role="status" aria-label="移動先を確認中">
        <div className="h-8 w-8 animate-spin rounded-pill border-4 border-hairline border-t-accent" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* カード同士の縦の間隔はこの親の gap-4（16px）だけで作る。子ごとの mb/mt は付けない。 */}
      <header data-design="Head" className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-secondary">統括コンソール</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">どのアカウントの{target.label}を開きますか</h1>
          <p className="mt-1 text-sm text-ink-secondary">アカウントを選ぶと、そのアカウントの管理画面へ移動します。</p>
        </div>
        <Button href="/hq" variant="secondary" className="shrink-0">アカウント管理へ戻る</Button>
      </header>

      {failure ? (
        isForbidden(failure) ? (
          <Notice
            tone="warn"
            message="このアカウント一覧を見る権限がありません。見るには権限が要ります。オーナーか管理者に追加を依頼してください。"
          />
        ) : (
          <Notice
            tone="danger"
            message="アカウント情報を読み込めませんでした。時間をおいてもう一度お試しください。"
            action={
              <Button
                type="button"
                variant="secondary"
                onClick={() => { setFailure(null); setLoading(true); setReloadKey((key) => key + 1) }}
              >
                再読み込み
              </Button>
            }
          />
        )
      ) : null}
      {!failure && loading ? (
        <div className="flex min-h-64 items-center justify-center" role="status" aria-label="アカウントを読み込み中">
          <div className="h-8 w-8 animate-spin rounded-pill border-4 border-hairline border-t-accent" />
        </div>
      ) : null}
      {!failure && !loading && accounts.length === 0 ? (
        <ListState
          kind="empty"
          data-design="Empty"
          title="まだアカウントがありません"
          description="最初のLINE公式アカウントを登録してください。"
          action={<Button href="/accounts/new" variant="primary">＋LINEアカウントを登録する</Button>}
        />
      ) : null}
      {!failure && !loading && accounts.length > 0 ? (
        <HqAccountList accounts={accounts} onSelect={openStorePage} selectLabel="このアカウントを選択する" />
      ) : null}
    </div>
  )
}
