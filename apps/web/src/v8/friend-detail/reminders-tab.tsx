'use client'

/* 登録済みのリマインダへ、IDだけで絞り込みを引き継ぐ。 */
import { Bell } from 'lucide-react'
import EmptyTab from './empty-tab'
import { friendFilterHref } from '@/components/shared/friend-filter-band'

export default function RemindersTab({ friendId }: { friendId: string }) {
  const safeId = typeof friendId === 'string' ? friendId.trim() : ''
  return (
    <EmptyTab
      icon={<Bell size={16} />}
      title="この友だちのリマインダ"
      text="登録されているリマインダを一覧で確認できます。"
      actions={safeId ? [{ label: 'この友だちのリマインダを見る ↗', href: friendFilterHref('/reminders', safeId) }] : []}
    />
  )
}
