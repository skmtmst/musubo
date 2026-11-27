import type { LineAccount } from '@line-crm/shared'
import { formatNumber, formatListDateTime, formatListDay } from '@/lib/format'

/*
 * LINEアカウントの詳細（V8）の言葉。画面から切り離し、描かずに確かめられるようにする。
 * 今の画面（app/accounts/detail）の決まりを写した。src/v8 からは @/app を読めないため。
 */

/** 詳細の API が返す形（一覧の形に、数と接続の記録が付く）。 */
export type AccountDetailView = LineAccount & {
  timezone?: string
  stats?: { friendCount: number; activeScenarios: number; messagesThisMonth: number }
  connection?: { lastTestAt?: string | null; lastTestStatus?: string | null; lastReceivedAt?: string | null } | null
  webhook?: {
    expectedUrl?: string | null
    actualUrl?: string | null
    active?: boolean | null
    status?: string | null
    checkedAt?: string | null
  } | null
}

/** 受け付ける `?tab=`。今の画面と同じ名前。V8 は1枚の画面なので、該当する段へ送る。 */
export const DETAIL_TABS = ['overview', 'connection', 'credentials', 'handover'] as const
export type DetailTab = (typeof DETAIL_TABS)[number]
export function toTab(value: string | null): DetailTab {
  return (DETAIL_TABS as readonly string[]).includes(value ?? '') ? (value as DetailTab) : 'overview'
}

/** 接続の記録の日時。未取得・無効値は null。 */
export function shortDateTime(value: string | null | undefined): string | null {
  return formatListDateTime(value, '') || null
}
export function shortDay(value: string | null | undefined): string | null {
  return formatListDay(value, '') || null
}

/** 接続を確かめ直す必要があるか。止まっている・Webhook が合っていない・最後の確認が通っていない。 */
export function needsCheck(account: AccountDetailView): boolean {
  if (account.archivedAt) return false
  if (!account.isActive) return true
  if (account.webhook?.status !== 'matched') return true
  return account.connection?.lastTestStatus !== 'succeeded'
}

/** 題の下の1行：`@id・要確認（…）・既定ではない・親アカウントなし`。 */
export function summaryLine(account: AccountDetailView, parentName: string | null): string {
  const state = account.archivedAt
    ? 'アーカイブ'
    : needsCheck(account) ? '要確認（LINE ID・接続状態を確かめてください）' : '正常'
  const parent = account.parentLineAccountId ? `親アカウント ${parentName ?? '—'}` : '親アカウントなし'
  return [account.channelId, state, account.isDefault ? '既定のアカウント' : '既定ではない', parent].join('・')
}

/** 友だち数：`1,284 人（上限 5,000 人）`。数が無い・上限が無いときもそのまま書く。0 と書かない。 */
export function friendsLine(account: AccountDetailView): string {
  const count = account.stats ? `${formatNumber(account.stats.friendCount)} 人` : '—'
  const cap = account.friendCapacity
  if (cap === null || cap === undefined) return `${count}（上限なし）`
  return `${count}（上限 ${formatNumber(cap)} 人）`
}

/** 上限と警告の補足。未設定を0と表示しない。 */
export function capacityDetails(account: AccountDetailView): string {
  if (account.friendCapacity == null) return '上限は未設定'
  return `上限 ${formatNumber(account.friendCapacity)}／${account.capacityWarnAt == null ? '警告なし' : `警告 ${formatNumber(account.capacityWarnAt)}`}`
}

/** 状態の札。 */
export function stateBadge(account: AccountDetailView): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (account.archivedAt) return { label: 'アーカイブ', tone: 'neutral' }
  return account.isActive ? { label: '動いている', tone: 'success' } : { label: '止めている', tone: 'warning' }
}

/** 資格情報の1行。値そのものは出さない（入っているか・末尾・日付だけ）。 */
export function credentialLine(input: {
  configured: boolean | undefined
  last4?: string | null
  updatedAt?: string | null
  checkedAt?: string | null
}): string {
  if (!input.configured) return '未登録'
  const parts = ['登録済み']
  if (input.last4) parts.push(`末尾 …${input.last4}`)
  const checked = shortDateTime(input.checkedAt)
  if (checked) parts.push(`最後の確認 ${checked}`)
  const updated = shortDay(input.updatedAt)
  if (updated) parts.push(`更新 ${updated}`)
  return parts.join('・')
}

/** Webhook の利用。返事があったときだけ「オン」「オフ」と書く。 */
export function webhookUse(account: AccountDetailView): { label: string; tone: 'success' | 'neutral' } {
  const active = account.webhook?.active
  if (active === null || active === undefined) return { label: '確かめていません', tone: 'neutral' }
  return active ? { label: 'オン', tone: 'success' } : { label: 'オフ', tone: 'neutral' }
}

/** LINE 側に登録した URL と、このシステムが待っている URL の突き合わせ。 */
export function webhookMatch(account: AccountDetailView): { value: string; badge: string; tone: 'success' | 'warning' | 'neutral' } {
  const status = account.webhook?.status
  if (status === 'matched') return { value: '同じ', badge: 'Webhookの突合 OK', tone: 'success' }
  const actual = account.webhook?.actualUrl
  if (status === 'mismatched') return { value: actual ?? '登録なし', badge: '合っていません', tone: 'warning' }
  return { value: actual ?? '—', badge: 'まだ確かめていません', tone: 'neutral' }
}

/** 止めている間に送らなかった配信の種類を、運用者の言葉で。 */
export function skippedKindLabel(kind: string): string {
  switch (kind) {
  case 'broadcast': return '一斉配信'
  case 'scenario_step': return 'ステップ配信'
  case 'reminder': return 'リマインダ'
  case 'auto_reply': return '自動応答'
  case 'notification': return '通知'
  case 'automation': return 'オートメーション'
  default: return kind
  }
}

/** アーカイブできない理由（API の blockers）を、運用者の言葉で。 */
export const ARCHIVE_BLOCKER_MESSAGES: Record<string, string> = Object.assign(Object.create(null), {
  account_active: '送受信がまだ動いています。先に「送受信を止める」で止めてください',
  default_account: '既定のアカウントです。先にほかのアカウントを既定にしてください',
  delivery_job_running: '予約・送信中の配信があります。終わるか取り消してからアーカイブしてください',
  traffic_pool_member: 'アクセス振り分けの組に入っています。組から外してからアーカイブしてください',
})

/** アーカイブを押せない理由。押せるなら null。 */
export function archiveBlockedReason(account: AccountDetailView): string | null {
  if (account.archivedAt) return null
  if (account.isActive) return '先に送受信を止めてください'
  if (account.isDefault) return '既定のアカウントはアーカイブできません。先にほかのアカウントを既定にしてください'
  return null
}

/** 数の欄の文字（空欄は null・それ以外は整数）。数でないときは NaN。 */
export function parseCount(value: string): number | null {
  const trimmed = value.replace(/,/g, '').trim()
  if (trimmed === '') return null
  return Number(trimmed)
}
