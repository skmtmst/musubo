import { prefetchApiRead } from './api/transport/prefetch'
import { invalidateApiReads } from './api/transport/read-cache'
import { api } from './api'

type AccountsResponse = Awaited<ReturnType<typeof api.lineAccounts.list>>

/** 外枠も画面も共通 GET の取得中の要求を使う。手動の読み直しは必ず通信する。 */
export function loadLineAccounts(options?: { reload?: boolean }): Promise<AccountsResponse> {
  return api.lineAccounts.list(false, undefined, options?.reload ? { cache: 'reload' } : undefined)
}

/** 認証確認と並列に開始する。失敗は載せる側が表示する。 */
export function prefetchLineAccounts(): void {
  prefetchApiRead('/api/staff/me')
  void loadLineAccounts().catch(() => undefined)
}

export function clearLineAccountsCache(): void {
  invalidateApiReads('/api/line-accounts')
}
