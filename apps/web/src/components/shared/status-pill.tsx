import { statusLabel } from '@/lib/status-labels'
import { CHAT_SUPPORT_STATUS, CHAT_SUPPORT_STATUS_ORDER, type ChatSupportStatus } from '@line-crm/shared'
import React, { type HTMLAttributes, type ReactNode } from 'react'
import type { StatusBadgeTone } from './status-badge'
import TruncatedText from './truncated-text'
import styles from './status-pill.module.css'

export type SupportStatus = ChatSupportStatus
export const SUPPORT_STATUS_ORDER = CHAT_SUPPORT_STATUS_ORDER
export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = Object.fromEntries(SUPPORT_STATUS_ORDER.map(key => [key, CHAT_SUPPORT_STATUS[key].label])) as Record<SupportStatus, string>
export const SUPPORT_STATUS_TONES: Record<SupportStatus, StatusBadgeTone> = Object.fromEntries(SUPPORT_STATUS_ORDER.map(key => [key, CHAT_SUPPORT_STATUS[key].tone])) as Record<SupportStatus, StatusBadgeTone>

/** 状態は色の点と文字の両方で伝える。 */
export function StatusDot({ tone = 'neutral', color }: { tone?: StatusBadgeTone; color?: string | null }) {
  return <span className={styles.dot} data-tone={tone} style={color ? { backgroundColor: color } : undefined} aria-hidden="true" />
}

/** ③：対応状況は色の点・薄い地・濃い文字の丸い札。 */
export default function StatusPill({ children, tone = 'neutral', color, ...props }: Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'color' | 'className'> & {
  children: ReactNode
  tone?: StatusBadgeTone
  color?: string | null
}) {
  return <span className={styles.pill} {...props} data-status-pill="" data-tone={tone}>
    <StatusDot tone={tone} color={color} />
    {typeof children === 'string' ? <TruncatedText className={styles.name} value={statusLabel(children)} /> : <span className={styles.name}>{children}</span>}
  </span>
}
