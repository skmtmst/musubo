'use client'

/*
 * 受信箱の一覧の「返事の期限」の札（板 Fk2FC・要件 G3）。
 * ふつう（期限まで余裕）は札を出さない。期限まで 15 分以下＝金「あと 12 分」・過ぎた＝赤「20 分過ぎ」。
 * 期限を使わない店（slaState が none か無い）は何も出さない。営業時間の外は灰「営業時間外」。
 * 言葉：「返事の期限」「期限超過」。使わない：SLA。
 */
import StatusBadge from '@/components/shared/status-badge'
import type { InboxSlaState } from '@line-crm/shared'
import { formatTimeSpan } from '@/lib/format-duration'

/** 一覧の行に口が足す3つの値（契約 API-CONTRACT-GAP1.md の G3）。無い口・期限オフは undefined か none。 */
export type ChatSlaFields = {
  slaDueAt?: string | null
  slaState?: InboxSlaState
  assignedBy?: 'auto' | 'manual' | null
}

export function formatSlaDistance(minutes: number): string {
  return formatTimeSpan(Math.max(1, Math.round(minutes)), { gap: true })
}

export function slaBadgeOf(fields: ChatSlaFields, now: number): { tone: 'warning' | 'danger' | 'neutral'; text: string } | null {
  const state = fields.slaState
  if (!state || state === 'none' || state === 'ok') return null
  if (state === 'outside_hours') return { tone: 'neutral', text: '営業時間外' }
  const due = fields.slaDueAt ? Date.parse(fields.slaDueAt) : NaN
  if (Number.isNaN(due)) return state === 'overdue' ? { tone: 'danger', text: '期限超過' } : null
  const minutes = (due - now) / 60000
  if (state === 'overdue' || minutes < 0) return { tone: 'danger', text: `${formatSlaDistance(-minutes)}過ぎ` }
  return { tone: 'warning', text: `あと ${formatSlaDistance(minutes)}` }
}

export function SlaBadge({ fields, now }: { fields: ChatSlaFields; now: number }) {
  const badge = slaBadgeOf(fields, now)
  if (!badge) return null
  return <StatusBadge tone={badge.tone} dot={false} size="compact" data-sla-badge={badge.tone}>{badge.text}</StatusBadge>
}

/**
 * 「期限超過」の一覧に残す会話か。行は口が期限の絞り（上の「期限超過 N」・統括の件数と同じ数え方）で返すので、
 * 手元の時計や札の状態（営業時間外など）で選び直さない。この画面で解決済みにした会話と、期限が消えた会話だけを外す。
 */
export function staysInOverdueList(fields: ChatSlaFields, status: string | null | undefined): boolean {
  return status !== 'resolved' && Boolean(fields.slaDueAt)
}

/** 担当の名前の後ろに付ける印。自動で決まった担当だけ「（自動）」。 */
export function assigneeLabel(name: string | null, fields: ChatSlaFields): string {
  if (!name) return '未割り当て'
  return fields.assignedBy === 'auto' ? `${name}（自動）` : name
}
