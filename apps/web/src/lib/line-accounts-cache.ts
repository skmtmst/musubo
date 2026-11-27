import { prefetchApiRead } from './api/transport/prefetch'
import { invalidateApiReads } from './api/transport/read-cache'
import { adoptPrefetchedApiRead } from './api/transport/request'
import { api } from './api'

type AccountsResponse = Awaited<ReturnType<typeof api.lineAccounts.list>>

export interface LineAccountsPrefetch {
  readonly promise: Promise<AccountsResponse>
  readonly startedAt: number
  readonly getStatus: () => 'pending' | 'ok' | 'failed'
}

/** 外枠も画面も共通 GET の取得中・30秒の結果を使う。手動の読み直しは必ず通信する。 */
export function loadLineAccounts(options?: { reload?: boolean }): Promise<AccountsResponse> {
  return api.lineAccounts.list(false, undefined, options?.reload ? { cache: 'reload' } : undefined)
}

/** 認証確認と並列に開始する。失敗は載せる側が表示する。 */
export function prefetchLineAccounts(): LineAccountsPrefetch {
  prefetchApiRead('/api/staff/me')
  const startedAt = Date.now()
  let status: 'pending' | 'ok' | 'failed' = 'pending'
  const promise = loadLineAccounts()
  void promise.then((response) => {
    status = response && typeof response === 'object' && response.success === true && 'data' in response ? 'ok' : 'failed'
  }, () => {
    status = 'failed'
  })
  return { promise, startedAt, getStatus: () => status }
}

/** 認証確認が通った直後に、並列で始めた取得を確定済みスコープへ引き継ぐ。失敗は引き継がない。 */
export function adoptPrefetchedLineAccounts(prefetch: LineAccountsPrefetch | null | undefined): void {
  if (!prefetch) return
  const status = prefetch.getStatus()
  if (status === 'failed') return
  adoptPrefetchedApiRead('/api/line-accounts', prefetch.promise, prefetch.startedAt, status === 'ok')
}

export function clearLineAccountsCache(): void {
  invalidateApiReads('/api/line-accounts')
}
