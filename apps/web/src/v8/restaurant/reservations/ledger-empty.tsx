import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { canManageRole, useStaffRole } from '@/lib/staff-role'

/** 卓の準備と予約の未登録を区別して、次にできる操作を知らせる。 */
export default function LedgerEmpty({ noTables, inactiveTables = false, filtered = false, canWrite, busy, onCreate, onViewList }: {
  noTables: boolean
  inactiveTables?: boolean
  filtered?: boolean
  canWrite: boolean
  busy: boolean
  onCreate: () => void
  onViewList?: () => void
}) {
  const role = useStaffRole()
  const tableLockReason = usePermissionLockReason(canManageRole(role), 'manager')
  const bookingLockReason = usePermissionLockReason(canWrite)
  if (noTables || inactiveTables) return <ListState kind="empty"
    title={noTables ? '卓がまだ設定されていません' : '利用できる卓がありません'}
    description={noTables ? '時間と卓で予約を確認するには、先に座席・卓管理で卓を登録してください。卓が未設定の予約は一覧で確認できます。' : 'すべての卓が停止中です。座席・卓管理で使う卓を有効にしてください。'}
    action={<>{role ? <Button variant="primary" href="/restaurant-test/tables" lockedReason={tableLockReason}>座席・卓を設定する</Button> : <Button variant="primary" disabled>座席・卓を設定する</Button>}{onViewList ? <Button onClick={onViewList}>一覧で予約を見る</Button> : null}</>}
  />
  return <ListState kind="empty" title={filtered ? '条件に合う予約はありません' : '予約はまだありません'} description={filtered ? '期間や状態、予約元の条件を変えて確認してください。' : '予約が入ると、ここに表示されます。時間×卓の空きマスからも電話の予約を入れられます。'} action={filtered ? undefined : <Button variant="primary" disabled={busy || !role} lockedReason={bookingLockReason} onClick={onCreate}>電話の予約を入れる</Button>} />
}
