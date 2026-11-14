import type { LineAccount } from '@line-crm/shared'

type ConnectionAccount = Pick<LineAccount, 'connection' | 'isActive'> & { archivedAt?: string | null }

export { lineAccountConnectionState } from '@line-crm/shared'
import { lineAccountConnectionState } from '@line-crm/shared'

export function hasLineConnectionProblem(account: ConnectionAccount): boolean {
  return lineAccountConnectionState(account).tone === 'warn'
}

type TokenAccount = Pick<LineAccount, 'tokenExpiry'> & { archivedAt?: string | null }

/** 接続の要確認と期限切れは別の判定なので、共通部分だけを内訳にする。 */
export function tokenExpiryBreakdown(accounts: readonly (ConnectionAccount & TokenAccount)[]) {
  const result = { inProblem: 0, outsideProblem: 0, unknown: 0 }
  for (const account of accounts) {
    if (account.archivedAt) continue
    if (!account.tokenExpiry || account.tokenExpiry.status === 'unknown') result.unknown++
    else if (account.tokenExpiry.status === 'expired') {
      if (hasLineConnectionProblem(account)) result.inProblem++
      else result.outsideProblem++
    }
  }
  return result
}

export function tokenExpiryBreakdownText(accounts: readonly (ConnectionAccount & TokenAccount)[]): string | null {
  const { inProblem, outsideProblem, unknown } = tokenExpiryBreakdown(accounts)
  if (!inProblem && !outsideProblem) return null
  const parts = [
    inProblem ? `接続に問題のうちトークン期限切れ ${inProblem} 件` : null,
    outsideProblem ? `接続に問題以外のトークン期限切れ ${outsideProblem} 件` : null,
    unknown ? `トークン期限未確認 ${unknown} 件` : null,
  ].filter(Boolean)
  return parts.length ? parts.join('・') : null
}

/** 一覧の行・カードにトークンの期限を出すのは、切れた・近い時だけ（アーカイブは除く）。 */
export function tokenExpiryNotice(account: TokenAccount): string | null {
  const expiry = account.tokenExpiry
  if (account.archivedAt || !expiry) return null
  return expiry.status === 'expired' || expiry.status === 'expiring' ? expiry.label : null
}

/**
 * 表の LINE 接続の欄の札（共通の札。短い文字で、全文は title）。出すものが無ければ null。
 * 札の色は呼び出し側で付ける（期限切れは赤、接近は注意）。
 */
export function tokenExpiryBadge(account: TokenAccount): { text: string; title: string } | null {
  const notice = tokenExpiryNotice(account)
  if (!notice) return null
  const text = account.tokenExpiry?.status === 'expired' ? '期限切れ' : '期限が近い'
  return { text, title: notice }
}

/** 数の帯の下の1行。接続とは別に、期限の切れた・近いアカウントの数を言う。無ければ出さない。 */
export function tokenExpirySummary(accounts: readonly TokenAccount[]): string | null {
  const live = accounts.filter(account => !account.archivedAt)
  const expired = live.filter(account => account.tokenExpiry?.status === 'expired').length
  const expiring = live.filter(account => account.tokenExpiry?.status === 'expiring').length
  const parts = [expired > 0 ? `期限切れ ${expired} 件` : null, expiring > 0 ? `期限が近い ${expiring} 件` : null].filter(Boolean)
  return parts.length > 0 ? parts.join('・') : null
}
