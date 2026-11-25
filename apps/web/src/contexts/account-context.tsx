'use client'

import { ListNavigationAccount, ListReturnAccountGuard } from '@/components/shared/list-navigation'
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { isHqShellPath } from '@/lib/menu'
import type { ReactNode } from 'react'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { loadLineAccounts } from '@/lib/line-accounts-cache'
import { KpiValueMotionProvider } from '@/components/shared/kpi-value-motion'
import { clearApiReadCache } from '@/lib/api/transport/read-cache'
import { api } from '@/lib/api'

const STORAGE_KEY = 'lh_selected_account'

export interface AccountWithStats {
  id: string
  revision?: number
  channelId: string
  name: string
  displayName?: string
  pictureUrl?: string | null
  basicId?: string | null
  isActive: boolean
  /** 既存のメール受信箱をこのアカウントで表示できるか。新規アカウントは未接続。 */
  emailInboxEnabled?: boolean
  country: string | null
  role: string | null
  displayOrder: number
  liffId?: string | null
  loginChannelId?: string | null
  ogSiteName?: string | null
  ogDefaultDescription?: string | null
  ogDefaultImageUrl?: string | null
  friendCapacity?: number | null
  capacityWarnAt?: number | null
  iconUrl?: string | null
  webhook?: {
    expectedUrl: string
    actualUrl: string | null
    active: boolean | null
    status: 'matched' | 'mismatched' | 'unconfigured' | 'unknown'
  }
  plan?: {
    key: 'communication' | 'light' | 'standard' | 'unknown'
    label: string
    monthlyMessageLimit: number | null
    source: 'messaging-api-quota'
  }
  stats?: {
    friendCount: number
    activeScenarios: number
    messagesThisMonth: number
    staffCount: number
  }
  /** 板 ：付けたタグ（`GET /api/line-accounts` の `tags`）。 */
  tags?: import("@line-crm/shared").LineAccountTagSummary[]
  /** 板 ：アーカイブ日時。あるときはアーカイブ済み。 */
  archivedAt?: string | null
  tokenExpiry?: import('@line-crm/shared').LineTokenExpiry
  connection?: import('@line-crm/shared').LineConnection
}

interface AccountContextValue {
  accounts: AccountWithStats[]
  selectedAccountId: string | null
  selectedAccount: AccountWithStats | null
  setSelectedAccountId: (id: string) => void
  clearSelectedAccountId: () => void
  /**
   * 一覧を取り直す。取り直しボタンや保存・確認の直後に呼ぶので、
   * 使い回しの答えは使わず必ず取り直す（古い一覧を見せない）。
   */
  refreshAccounts: () => Promise<void>
  loading: boolean
  /**
   * 一覧の取得に失敗したときだけ立つ。失敗を `accounts=[]` のままにすると
   * 「アカウントが1件も無い」画面に見えるので、利用側はこれを見て
   * 「読み込めませんでした＋再読み込み」を出す（Issue #978）。
   */
  error: string | null
  /** 再読み込みの最中。失敗表示の再試行ボタンを止めるのに使う。 */
  refreshing: boolean
}

const AccountContext = createContext<AccountContextValue | null>(null)

export function AccountProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const clearedAtPath = useRef<string | null>(null)
  const [accounts, setAccounts] = useState<AccountWithStats[]>([])
  const [selectedAccountId, setSelectedAccountIdState] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const setSelectedAccountId = useCallback((id: string) => {
    requestUnsavedAction(() => {
      clearApiReadCache()
      clearedAtPath.current = null
      setSelectedAccountIdState(id)
      try {
        localStorage.setItem(STORAGE_KEY, id)
      } catch {
        // localStorage unavailable
      }
    })
  }, [])

  const clearSelectedAccountId = useCallback(() => {
    requestUnsavedAction(() => {
      clearApiReadCache()
      clearedAtPath.current = pathname ?? ''
      setSelectedAccountIdState(null)
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        // localStorage unavailable
      }
    })
  }, [pathname])

  const loadAccounts = useCallback(async (reload: boolean) => {
    setRefreshing(true)
    try {
      // 初回は AuthGuard の先読みを使う。変更後の取り直しだけ古い答えを捨てる。
      const res = await loadLineAccounts({ reload })
      if (!res.success) {
        // 失敗時は手元の一覧を消さない。古い一覧でも「アカウントなし」の
        // 空画面より役に立つし、初回失敗ではもともと空なので差し支えない。
        setError(res.error || 'アカウント一覧を読み込めませんでした')
        return
      }
      // アーカイブ済みは管理画面で復元できるが、店舗の選択肢には出さない。
      // PC・モバイル・初期着地点で同じ一覧を使うため、ここで揃える。
      const list = (res.data as AccountWithStats[]).filter((account) => !account.archivedAt)
      if (list.length > 0) {
        setAccounts(list)

        // 無効になった選択だけを解除する。未選択のときに先頭へ勝手に
        // フォールバックすると、統括の着地点を店舗数で決められない。
        setSelectedAccountIdState((prev) => {
          if (prev && list.some((a) => a.id === prev)) return prev
          // 保存値が有効なら復元する。保存値も無ければ未選択のままにする。
          let stored: string | null = null
          try {
            stored = localStorage.getItem(STORAGE_KEY)
          } catch {
            // localStorage unavailable
          }
          const valid = stored && list.some((a) => a.id === stored)
          if (!valid && stored) {
            try {
              localStorage.removeItem(STORAGE_KEY)
            } catch {
              // localStorage unavailable
            }
          }
          return valid ? stored : null
        })
      } else {
        setAccounts([])
        setSelectedAccountIdState(null)
        try {
          localStorage.removeItem(STORAGE_KEY)
        } catch {
          // localStorage unavailable
        }
      }
      setError(null)
    } catch {
      setError('アカウント一覧を読み込めませんでした')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  const refreshAccounts = useCallback(() => loadAccounts(true), [loadAccounts])

  useEffect(() => {
    void loadAccounts(false)
  }, [loadAccounts])

  // 統括へ戻る直前の解除を再選択で打ち消さない。店の画面へ移ったら再び判定する。
  useEffect(() => {
    if (clearedAtPath.current !== null) {
      if (clearedAtPath.current === (pathname ?? '')) return
      clearedAtPath.current = null
    }
    if (!loading && !error && !isHqShellPath(pathname) && !selectedAccountId && accounts.length === 1) {
      setSelectedAccountId(accounts[0].id)
    }
  }, [pathname, loading, error, accounts, selectedAccountId, setSelectedAccountId])

  useEffect(() => {
    if (loading || error || accounts.length === 0) return
    let cancelled = false
    let inFlight = false
    let lastAttempt = 0
    const refreshPictures = async () => {
      if (inFlight || document.visibilityState === 'hidden' || Date.now() - lastAttempt < 30_000) return
      inFlight = true
      lastAttempt = Date.now()
      try {
        const response = await api.lineAccounts.profilePictures()
        if (cancelled || !response.success) return
        const byId = new Map(response.data.map((item) => [item.id, item.pictureUrl]))
        setAccounts((current) => current.map((account) => {
          if (!byId.has(account.id)) return account
          const pictureUrl = byId.get(account.id) ?? null
          return account.pictureUrl === pictureUrl ? account : { ...account, pictureUrl }
        }))
      } catch {
        // アイコン更新だけの失敗で、アカウント一覧を消さない。
      } finally {
        inFlight = false
      }
    }
    const onVisible = () => { void refreshPictures() }
    void refreshPictures()
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(onVisible, 5 * 60_000)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(timer)
    }
  }, [loading, error, accounts.length])

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null

  return (
    <ListNavigationAccount.Provider value={selectedAccountId}><AccountContext.Provider
      value={{ accounts, selectedAccountId, selectedAccount, setSelectedAccountId, clearSelectedAccountId, refreshAccounts, loading, error, refreshing }}
    >
      <ListReturnAccountGuard accountId={selectedAccountId} />
      <KpiValueMotionProvider scope={loading ? null : selectedAccountId ?? 'hq'} updates={false}>{children}</KpiValueMotionProvider>
    </AccountContext.Provider></ListNavigationAccount.Provider>
  )
}

/** 外枠の外（ログイン・試験の単体描画など）では null。外枠の共通部品が使う。 */
export function useOptionalAccount(): AccountContextValue | null {
  return useContext(AccountContext)
}

export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext)
  if (!ctx) throw new Error('useAccount must be used within AccountProvider')
  return ctx
}
