import { knownValue } from '@/lib/known-value'
import type { BookingSlotBlockReason } from '@/lib/api'

/** IDEA-28: 予約できない理由コードを運用者向けの文へ。予定の件名や相手など詳細は API から返らない。 */
const SLOT_REASON_LABELS: Record<BookingSlotBlockReason, string> = {
  menu_inactive: 'このメニューは受付を止めているか、削除されています',
  staff_not_offered: 'このメニューを担当できるスタッフがいません',
  invalid_resource: 'このメニューが必要とする設備の設定に問題があります',
  booking_window: '受付期間（何日先まで取れるか）の外です',
  past_cutoff: '受付の締め切り（何時間前まで取れるか）を過ぎています',
  invalid_time: 'その時刻は存在しません',
  not_on_grid: '開始時刻が受付の刻みに合っていません',
  exception_closed: '休業日・例外日で閉めています',
  exception_invalid: '例外日の時間設定が壊れているため、安全のため閉めています',
  outside_working: '勤務・営業時間の外です',
  duration_overrun: '勤務・営業の終わりまでに所要時間が収まりません',
  other_booking: 'ほかの予約と重なっています',
  google_busy: '外部カレンダーの予定と重なっています',
  capacity_full: '担当の同時受付数がいっぱいです',
  store_full: '店舗全体の同時受付枠がいっぱいです',
  resource_shortage: '必要な設備がその時間に足りません',
  calendar_unavailable: '外部カレンダーを読めないため、安全のため閉めています',
  unavailable: 'この日時は受け付けられません',
}

/*
 * R314: 刻みの理由だけ、判定に実際に使った幅を添える。応答に無いときは
 * 幅を書かない文言にする（古い決めつけの「30分」は出さない）。
 */
export function slotReasonLabel(reason: BookingSlotBlockReason, slotGranularityMinutes?: number): string {
  if (reason === 'not_on_grid' && slotGranularityMinutes != null) {
    return `開始時刻が受付の刻み（${slotGranularityMinutes}分）に合っていません`
  }
  return knownValue(SLOT_REASON_LABELS, reason, 'この日時は受け付けられません')
}
