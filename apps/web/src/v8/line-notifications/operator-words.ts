/*
 * 運用者へのお知らせの言葉と選びもの（★V8 operator-edit.tsx が使う）。
 *
 * きっかけの一覧（EVENT_OPTIONS）は app/line-notifications/operator-event-options.ts の写し。
 * 正本はあちら（Worker の登録簿との突き合わせ試験が読む）。写しがずれたら
 * operator-edit.test.tsx の「きっかけの写しが正本と同じ」が落ちる。
 */
export const EVENT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'booking_created', label: '予約が入ったとき' },
  { value: 'broadcast_completed', label: '一斉配信が終わったとき' },
  { value: 'form_submitted', label: 'フォームに回答があったとき' },
  { value: 'ec_order_received', label: '注文を受け取ったとき' },
  { value: 'nen_birthday_coupon_failed', label: '誕生日クーポンの発行に失敗したとき' },
  { value: 'common_var_expiry', label: '共通情報の期限が近づいたとき' },
  { value: 'manual_link_broken', label: 'マニュアルのリンクが開けなくなったとき' },
]

export const DEFAULT_EVENT_TYPE = EVENT_OPTIONS[0]!.value

export const THRESHOLD_OPTIONS = [
  { value: 'one', label: '1件でも' },
  { value: 'three', label: '3件たまったら' },
  { value: 'ten', label: '10件たまったら' },
]

export const IMPORTANCE_OPTIONS = [
  { value: 'normal', label: 'ふつう' },
  { value: 'important', label: '重要' },
  { value: 'urgent', label: '緊急' },
]

export const SCHEDULE_OPTIONS = [
  { value: 'anytime', label: 'いつでも' },
  { value: 'business_hours', label: '営業時間だけ' },
  { value: 'morning_digest', label: '翌朝にまとめる' },
]

export const DEDUPE_OPTIONS = [
  { value: '0', label: '重ねず、その都度知らせる' },
  { value: '10', label: '10分のあいだは1回だけ' },
  { value: '30', label: '30分のあいだは1回だけ' },
  { value: '60', label: '1時間のあいだは1回だけ' },
]

/* 宛先の取得失敗時に保存を止める案内。宛先が回復したらこの文言だけを消す。 */
export const RECIPIENTS_SAVE_GUARD_MESSAGE =
  '受け取る人を読み込めませんでした。上の「もう一度読み込む」で取り直してから保存してください。'

/** 保存ずみのお知らせの条件を、画面の値へ戻す。 */
export function readConditions(rule: { conditions: Record<string, unknown> }) {
  const conditions = rule.conditions
  return {
    teamId: typeof conditions.teamId === 'string' ? conditions.teamId : '',
    threshold: typeof conditions.threshold === 'string' ? conditions.threshold : 'one',
    importance: typeof conditions.importance === 'string' ? conditions.importance : 'normal',
    recipientIds: Array.isArray(conditions.recipientIds)
      ? conditions.recipientIds.filter((id): id is string => typeof id === 'string')
      : [],
    schedule: typeof conditions.schedule === 'string' ? conditions.schedule : 'anytime',
    dedupeMinutes: typeof conditions.dedupeMinutes === 'number' ? String(conditions.dedupeMinutes) : '10',
    onlyAvailable: conditions.onlyAvailable === true,
  }
}

export function importanceLabel(value: string): string {
  return IMPORTANCE_OPTIONS.find((option) => option.value === value)?.label ?? value
}

export function eventLabel(value: string): string {
  return EVENT_OPTIONS.find((option) => option.value === value)?.label ?? value
}

/* 届いたお知らせから開く先（見本の吹き出しの「〇〇で見る ›」）。 */
const EVENT_PLACES: Record<string, string> = Object.assign(Object.create(null), {
  booking_created: '予約管理',
  broadcast_completed: '一斉配信',
  form_submitted: '回答フォーム',
  ec_order_received: 'EC連携',
  nen_birthday_coupon_failed: 'クーポン',
  common_var_expiry: '共通情報',
  manual_link_broken: '機能設定',
})

export function eventPlaceLabel(value: string): string {
  return EVENT_PLACES[value] ?? '管理画面'
}
