import type { RestaurantFollowupTrigger } from '@line-crm/shared'

/*
 * LINE来店フォローの7行の定義。業種ごとに差し替えられる形にしてある。
 * 今つながっているのは飲食だけ（口が /api/restaurant-test/ のため）。
 * サロン・面談・教室・ECは、口ができたらこの形の設定を足す。
 */

export type OffsetUnit = 'minutes' | 'hours' | 'days'

export interface FollowupTriggerRow {
  trigger: RestaurantFollowupTrigger
  /** 行の名前。 */
  name: string
  /** 行の説明（いつ送るか）。 */
  note: string
  /** 時期の入力の向き。before=前、after=起点から後、at=起点で。 */
  direction: 'before' | 'after' | 'at'
  /** 時期の既定（分、符号つき）。 */
  defaultOffsetMinutes: number
  /** 時期の入力に出す単位。 */
  units: OffsetUnit[]
  /** 既定の単位。 */
  defaultUnit: OffsetUnit
  /** まだ無い店舗に見せる初期の文（見本。保存はしない）。 */
  sampleText: string
}

export const RESTAURANT_TRIGGER_ROWS: FollowupTriggerRow[] = [
  {
    trigger: 'reservation_created', name: '予約完了時', note: '予約が入ったらすぐ送る',
    direction: 'at', defaultOffsetMinutes: 0, units: ['minutes', 'hours', 'days'], defaultUnit: 'minutes',
    sampleText: 'ご予約ありがとうございます。当日のご来店をお待ちしています。',
  },
  {
    trigger: 'reservation_24h', name: '予約の前日', note: '予約の前の日に送る',
    direction: 'before', defaultOffsetMinutes: -1440, units: ['minutes', 'hours', 'days'], defaultUnit: 'hours',
    sampleText: '明日はご予約の日です。お気をつけてお越しください。',
  },
  {
    trigger: 'reservation_2h', name: '予約の2時間前', note: '予約の2時間前に送る',
    direction: 'before', defaultOffsetMinutes: -120, units: ['minutes', 'hours'], defaultUnit: 'hours',
    sampleText: '本日はご予約ありがとうございます。お待ちしています。',
  },
  {
    trigger: 'post_visit', name: '来店後', note: '退店がきっかけで送る',
    direction: 'after', defaultOffsetMinutes: 180, units: ['minutes', 'hours', 'days'], defaultUnit: 'hours',
    sampleText: '本日はご来店ありがとうございました。またのお越しをお待ちしています。',
  },
  {
    trigger: 'review_request', name: '口コミ依頼', note: '来店後に口コミをお願いする',
    direction: 'after', defaultOffsetMinutes: 1440, units: ['minutes', 'hours', 'days'], defaultUnit: 'days',
    sampleText: 'よろしければ口コミの投稿をお願いします。',
  },
  {
    trigger: 'waitlist_invited', name: '順番案内', note: '空きが出たらすぐ送る',
    direction: 'at', defaultOffsetMinutes: 0, units: ['minutes', 'hours'], defaultUnit: 'minutes',
    sampleText: 'お席のご用意ができました。ご案内します。',
  },
  {
    trigger: 'anniversary_before', name: '記念日前', note: '記念日の前にお祝いを送る',
    direction: 'before', defaultOffsetMinutes: -10080, units: ['minutes', 'hours', 'days'], defaultUnit: 'days',
    sampleText: 'もうすぐ記念日ですね。お祝いのご用意はいかがですか。',
  },
]

export const UNIT_MINUTES: Record<OffsetUnit, number> = { minutes: 1, hours: 60, days: 1440 }

export const UNIT_LABEL: Record<OffsetUnit, string> = { minutes: '分', hours: '時間', days: '日' }

/*
 * 既存の時期を数値＋単位に分ける。開いただけで丸めないよう、
 * 割り切れる一番大きい単位を選び、値は正確に復元できるものにする。
 */
export function exactTiming(absMinutes: number, units: OffsetUnit[]): { amount: string; unit: OffsetUnit } {
  const fallbackUnit: OffsetUnit = units[0] ?? 'minutes'
  if (!Number.isFinite(absMinutes) || absMinutes < 0) return { amount: '', unit: fallbackUnit }
  if (units.includes('days') && absMinutes % 1440 === 0) return { amount: String(absMinutes / 1440), unit: 'days' }
  if (units.includes('hours') && absMinutes % 60 === 0) return { amount: String(absMinutes / 60), unit: 'hours' }
  return { amount: String(absMinutes), unit: 'minutes' }
}

/*
 * Workerと同じ時期の規則。前なら負、後なら0以上。
 */
export function timingError(trigger: RestaurantFollowupTrigger, offsetMinutes: number): string | null {
  if (!Number.isSafeInteger(offsetMinutes) || Math.abs(offsetMinutes) > 525600) return '時期は525600分（365日）以内で入れてください'
  if (trigger === 'anniversary_before' && offsetMinutes % 1440 !== 0) return '記念日は日単位で入れてください'
  if ((trigger === 'reservation_24h' || trigger === 'reservation_2h' || trigger === 'anniversary_before') && offsetMinutes >= 0) {
    return '前の日時は0より小さい値で入れてください'
  }
  if ((trigger === 'reservation_created' || trigger === 'post_visit' || trigger === 'review_request' || trigger === 'waitlist_invited') && offsetMinutes < 0) {
    return '後の日時は0以上の値で入れてください'
  }
  return null
}

/** 時期の言い方（行の一覧に出す短い文）。 */
export function timingLabel(trigger: RestaurantFollowupTrigger, offsetMinutes: number | null): string {
  if (offsetMinutes === null) return '時期がまだありません'
  if (!Number.isFinite(offsetMinutes)) return '時期を確認できません'
  const abs = Math.abs(offsetMinutes)
  const span = abs % 1440 === 0 ? `${abs / 1440}日` : abs % 60 === 0 ? `${abs / 60}時間` : `${abs}分`
  switch (trigger) {
    case 'reservation_created': return offsetMinutes === 0 ? '予約が入ったらすぐ' : `予約から${span}後`
    case 'reservation_24h':
    case 'reservation_2h': return `${span}前`
    case 'post_visit': return `退店から ${span}後`
    case 'review_request': return `退店から ${span}後`
    case 'waitlist_invited': return offsetMinutes === 0 ? '空きが出たらすぐ' : `空きが出てから${span}後`
    case 'anniversary_before': return `記念日の${span}前`
  }
}
