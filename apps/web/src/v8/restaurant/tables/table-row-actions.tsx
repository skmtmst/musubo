import { RowActions } from '@/components/shared/row-actions'
import type { RestaurantTable } from '@/lib/restaurant-test-api'
import {Copy} from 'lucide-react'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'

export default function TableRowActions({ table, canEdit, busy, pendingAccount, onEdit, onDuplicate, onStop, onResume, onDelete }: {
  table: RestaurantTable
  canEdit: boolean
  busy: boolean
  pendingAccount: boolean
  onEdit: (table: RestaurantTable) => void
  onDuplicate: (table: RestaurantTable) => void
  onStop: (table: RestaurantTable) => void
  onResume: (table: RestaurantTable) => void
  onDelete: (table: RestaurantTable) => void
}) {
  /* 権限が無い人にも隠さず、灰色＋理由。役割が読めるまでは押せないだけ。 */
  const permissionReason = usePermissionLockReason(canEdit)
  const disabledReason = pendingAccount ? '選んだアカウントの一覧を確認してください' : busy ? 'ほかの変更を反映しています' : undefined
  const locked = !canEdit ? permissionReason : pendingAccount ? disabledReason : undefined
  const off = busy || (!canEdit && !permissionReason)
  const blocked = !canEdit || busy || pendingAccount
  const run = (action: (item: RestaurantTable) => void) => () => {
    if (blocked) return
    return action(table)
  }
  return <RowActions subjectName={`${table.code}・${table.label}`}
    edit={{ label: '変更', disabled: off, lockedReason: locked, onClick: run(onEdit) }}
    menuButtonProps={{ disabled: off }}
    menuItems={[{id:'duplicate',label:'複製',icon:<Copy size={16} aria-hidden="true"/>,disabled:off,lockedReason:locked,disabledReason,onSelect:run(onDuplicate)},{
      id: table.is_active ? 'stop' : 'resume',
      label: table.is_active ? '停止' : '再開',
      disabled: off,
      lockedReason: locked,
      disabledReason,
      onSelect: run(table.is_active ? onStop : onResume),
    }, { id: 'delete', label: '削除', tone: 'danger', disabled: off, lockedReason: locked, disabledReason, onSelect: run(onDelete) }]} />
}
