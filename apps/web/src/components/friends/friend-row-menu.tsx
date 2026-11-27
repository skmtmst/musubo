'use client'

import React, { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import { RowMenu } from '@/components/shared/row-actions'
import { useAccount } from '@/contexts/account-context'
import type { FriendAction } from './single-friend-actions'
import ScheduleDialog from './schedule-dialog'

export default function FriendRowMenu({ friendId, friendName, attention, canEdit = false, allowedActions, onAction, onToggleAttention }: {
  friendId: string
  friendName: string
  attention: boolean
  canEdit?: boolean
  allowedActions?: FriendAction[]
  onAction?: (action: FriendAction) => void
  onToggleAttention?: () => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  /* ★V8 ：「予約して送る」はこの行から小窓を直接開く（受信箱を開かずに予約）。
     送る権限はテンプレートを送ると同じ（会話に送る操作）。 */
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const canSchedule = allowedActions ? allowedActions.includes('template') : canEdit
  const allowed = (action: FriendAction) => allowedActions ? allowedActions.includes(action) : canEdit
  const edit = (id: FriendAction, label: string, dividerBefore = false): ActionMenuItem => ({
    id, label, dividerBefore, disabled: !allowed(id) || !onAction,
    disabledReason: allowed(id) ? undefined : '閲覧のみでは変更できません',
    onSelect: () => onAction?.(id),
  })
  const items: ActionMenuItem[] = [
    { id: 'talk', label: 'トークを開く', onSelect: () => router.push(`/chats?friend=${friendId}`) },
    { id: 'detail', label: '友だちの詳細を見る', onSelect: () => router.push(`/friends/detail?id=${friendId}`) },
    edit('status', '対応状況を変更する'),
    edit('operator', '担当者を変更する'),
    edit('tag', 'タグを付ける・外す'),
    { id: 'attention', label: attention ? '注目から外す' : '注目にする', disabled: !canEdit, disabledReason: '閲覧のみでは変更できません', onSelect: () => onToggleAttention?.() },
    edit('template', 'テンプレートを送る', true),
    { id: 'schedule', label: '予約して送る', disabled: !canSchedule, disabledReason: '閲覧のみでは変更できません', onSelect: () => setScheduleOpen(true) },
    edit('scenario', 'シナリオを開始'),
    edit('field', '友だち情報を書き換える'),
    edit('reminder', 'リマインダを開始'),
  ]
  return <span onClick={(event) => event.stopPropagation()}>
    <RowMenu size="row" label={`${friendName}のその他操作`} menuLabel={`${friendName}の操作`} open={open} onOpenChange={setOpen} items={items} />
    {scheduleOpen ? (
      <RowScheduleDialog friendId={friendId} friendName={friendName} onClose={() => setScheduleOpen(false)} />
    ) : null}
  </span>
}

/* 開いたときだけアカウントを読む（行のメニューはアカウントの枠の外でも描かれる）。 */
function RowScheduleDialog({ friendId, friendName, onClose }: { friendId: string; friendName: string; onClose: () => void }) {
  const { selectedAccountId } = useAccount()
  return <ScheduleDialog friendId={friendId} friendName={friendName} accountId={selectedAccountId} onClose={onClose} onReserved={onClose} />
}
