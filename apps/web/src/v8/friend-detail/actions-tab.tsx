'use client'

/* アクションタブ。操作だけの履歴はまだ無い。同じ記録は履歴タブに時系列で並ぶ。 */
import { Zap } from 'lucide-react'
import EmptyTab from './empty-tab'

export default function ActionsTab({ friendId }: { friendId: string }) {
  const safeId = typeof friendId === 'string' ? friendId.trim() : ''
  return (
    <EmptyTab
      icon={<Zap size={16} />}
      title="この友だちへの操作だけを集めた履歴はまだありません"
      text="今は履歴タブに同じ記録が時系列で並んでいます。"
      actions={safeId ? [{ label: '履歴タブを見る', href: `/friends/detail?id=${encodeURIComponent(safeId)}&tab=history` }] : []}
    />
  )
}
