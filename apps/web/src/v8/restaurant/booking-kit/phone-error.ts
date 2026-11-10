import { getApiErrorCode } from '@/lib/api'

export function phoneReservationFailure(error: unknown, role?: string | null): string | null {
  switch (getApiErrorCode(error)) {
    case 'opening_hours_unconfigured': return role === 'staff' ? '営業時間が未設定のため予約できません。管理者に営業時間の設定を依頼してください。' : '営業時間が未設定のため予約できません。営業時間を確認してください。'
    case 'reservation_time_past': return '予約の時刻が過ぎました。日時を選び直してください。'
    case 'outside_opening_hours': return 'Googleビジネスの営業時間外です。日時を選び直してください。'
    default: return null
  }
}
