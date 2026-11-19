'use client'

/* 回数券・月謝と、この友だちの予約への行き先。 */
import { CalendarDays } from 'lucide-react'
import EmptyTab from './empty-tab'
import EntitlementsCard from './entitlements'
import MakeupCredits from './makeup-credits'
import styles from './entitlements.module.css'

export default function BookingsTab({ accountId, friendId, friendName, canEdit }: { accountId: string | null; friendId: string; friendName: string; canEdit: boolean }) {
  return (
    <div className={styles.bookingsStack}>
      <MakeupCredits key={`${accountId}:${friendId}`} accountId={accountId} friendId={friendId} canEdit={canEdit} />
      <EntitlementsCard accountId={accountId} friendId={friendId} friendName={friendName} canEdit={canEdit} />
      <EmptyTab
        icon={<CalendarDays size={16} />}
        title="この友だちの予約だけを集めた画面はまだありません"
        text="予約の一覧からはこの人の予約を探せます。"
        actions={[{ label: '予約一覧を見る ↗', href: '/booking/bookings' }]}
      />
    </div>
  )
}
