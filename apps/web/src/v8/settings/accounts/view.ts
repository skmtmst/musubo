import { hasLineConnectionProblem, lineAccountConnectionState } from '@/lib/line-account-state'
import type { LineAccount } from '@line-crm/shared'

/*
 * ★V8 LINEアカウント一覧の言葉と判定。
 * app/accounts/account-list-view.ts から写した（src/v8 は @/app を読めない）。
 * 直すときは両方を直す（V8 に切り替える日に古い方を消す）。
 */

export type AccountWithStats = LineAccount & {
  stats?: { friendCount: number; activeScenarios: number; messagesThisMonth: number }
  timezone?: string
}

/** 接続状態は共通の判定。未確認・停止中・アーカイブも区別する。**色だけに頼らず、必ず文字で言う。** */
export function connectionLabel(account: LineAccount): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  const state = lineAccountConnectionState(account)
  return { label: state.label, tone: state.tone === 'ok' ? 'success' : state.tone === 'warn' ? 'warning' : 'neutral' }
}

/** Webhook の照合結果：正常／未確認（合っていない・登録が無い・まだ確かめていないは「未確認」）。 */
export function webhookLabel(account: LineAccount): { label: string; tone: 'success' | 'neutral' } {
  return account.webhook?.status === 'matched' ? { label: '正常', tone: 'success' } : { label: '未確認', tone: 'neutral' }
}

export type AccountFilter = 'all' | 'active' | 'inactive' | 'archived' | 'problem'

/** 絞り込みの札。絵  の並び（すべて・稼働中・停止中・接続に問題・アーカイブ）。 */
export const ACCOUNT_FILTERS: ReadonlyArray<{ value: AccountFilter; label: string }> = [
  { value: 'all', label: 'すべて' },
  { value: 'active', label: '稼働中' },
  { value: 'inactive', label: '停止中' },
  { value: 'problem', label: '接続に問題' },
  { value: 'archived', label: 'アーカイブ' },
]

/** 接続の最新の判定が要確認で、停止中・保管中でない。 */
export function hasConnectionProblem(account: LineAccount): boolean {
  return hasLineConnectionProblem(account)
}

export function matchesFilter(account: LineAccount, filter: AccountFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return account.isActive && !account.archivedAt
  if (filter === 'inactive') return !account.isActive && !account.archivedAt
  if (filter === 'archived') return Boolean(account.archivedAt)
  return hasConnectionProblem(account)
}

/** 名前とチャネルIDで絞る。打つたびに取り直さない。 */
export function matchesQuery(account: LineAccount, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return account.name.toLowerCase().includes(q) || account.channelId.toLowerCase().includes(q)
}

/** 親アカウントの名前。**IDをそのまま出さない。** 親が無いものは「—」。 */
export function parentName(account: LineAccount, all: LineAccount[]): string {
  if (!account.parentLineAccountId) return '—'
  return all.find((a) => a.id === account.parentLineAccountId)?.name ?? '—'
}

/** 「並び順と親子を変える」で決めた並び（display_order）。同じ値は元の順を保つ。 */
export function orderAccounts<T extends LineAccount>(accounts: readonly T[]): T[] {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((a, b) => (a.account.displayOrder ?? 0) - (b.account.displayOrder ?? 0) || a.index - b.index)
    .map(({ account }) => account)
}

/** 数の4枚：つないでいる・稼働中・接続に問題・友だちの合計（アーカイブは数えない）。 */
export function accountKpis(accounts: readonly AccountWithStats[]): { connected: number; active: number; problem: number; friends: number | null } {
  const visible = accounts.filter((a) => !a.archivedAt)
  return {
    connected: accounts.filter((a) => !a.archivedAt).length,
    active: accounts.filter((a) => a.isActive && !a.archivedAt).length,
    problem: accounts.filter((a) => !a.archivedAt && hasConnectionProblem(a)).length,
    friends: visible.some((a) => a.stats?.friendCount == null) ? null : visible.reduce((sum, a) => sum + (a.stats?.friendCount ?? 0), 0),
  }
}
