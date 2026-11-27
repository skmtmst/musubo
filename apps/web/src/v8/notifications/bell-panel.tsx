'use client'

import type { ReactNode } from 'react'
import BellPopover, { type BellItem, type BellPopoverProps } from '@/components/shared/bell-popover'
import { NOTIFICATION_TABS, type NotificationTab } from './tabs'

export type BellPanelItem = {
  id: string
  title: string
  /** 本文。絵に無いので行の title（指を乗せると出る）に置く。 */
  body?: string
  /** 印の形。システムの知らせは三角、それ以外は光。 */
  kind: 'system' | 'other'
  unread: boolean
  /** 「5分前」「昨日 18:20」など。 */
  time: string
  /** 元の日時（相対表示に指を乗せて確認する）。 */
  timeTitle?: string
  /** 作成日時を日本時間で分けた日付の組。日時が不正なら不明として残す。 */
  period: 'today' | 'earlier' | 'unknown'
  /** 行き先の言葉（「配信を開く」「更新する」など。→ は部品が付ける）。 */
  linkLabel: string
}

export type BellPanelState = 'loading' | 'ready' | 'error' | 'no-account'

export type BellPanelProps = {
  open: boolean
  onClose: () => void
  /** 開くボタン（ベル）。外を押したかの判定と、Esc で焦点を戻す先。 */
  getAnchor: () => HTMLElement | null
  getPositionRect?: BellPopoverProps['getPositionRect']
  id?: string
  state: BellPanelState
  /** 見せる行（呼ぶ側で未読が先・新しい順にし、5件までに切る）。 */
  items: BellPanelItem[]
  unreadCount: number | null
  partialNotice?: ReactNode
  tab: NotificationTab
  onTabChange: (tab: NotificationTab) => void
  errorMessage?: string
  onRetry?: () => void
  onSelect: (id: string) => void
  onMarkAllRead?: () => void
  markAllReadDisabled?: boolean
  markAllReadDisabledReason?: string
  markAllReadLockedReason?: string
  onViewAll: () => void
}

const EMPTY: Record<NotificationTab, string> = {
  all: '通知はまだありません。',
  unread: '未読の通知はありません。',
  system: 'システムの通知はありません。',
}

/**
 * 上の帯のベルを押したときの通知の小窓（V8.pen 小窓 `mV28V`）。
 *
 * 器・開閉・焦点は共通の小窓（`components/shared/bell-popover`）に任せ、
 * タブを「すべて・未読・システム」に、印をシステムは三角・それ以外は光にする。
 * 中身（取得・既読）は呼ぶ側が持つ。
 */
export default function BellPanel({ items, tab, onTabChange, ...rest }: BellPanelProps) {
  const safeItems = Array.isArray(items) ? items : []
  const rows: BellItem[] = safeItems.map(({ kind, ...item }) => ({ ...item, category: kind === 'system' ? 'error' : 'update' }))
  const emptyMessage = Object.prototype.hasOwnProperty.call(EMPTY, tab) ? EMPTY[tab] : EMPTY.all
  return (
    <BellPopover<NotificationTab>
      {...rest}
      title="通知"
      items={rows}
      filters={NOTIFICATION_TABS}
      filter={tab}
      onFilterChange={onTabChange}
      emptyText={rest.partialNotice ? '読み込めた店舗に該当する通知はありません。' : emptyMessage}
    />
  )
}
