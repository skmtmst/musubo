import { formatYen } from '@line-crm/shared';
import { formatDurationMinutes } from '@/lib/format-duration'
import { formatDateTime } from '@/lib/format'
import type { StatusBadgeTone } from '@/components/shared/status-badge'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import type { DeliveryService, DeliveryUrgency } from '@/lib/restaurant-delivery-api'

/**
 * ★V8 デリバリー受注の見せ方（D-1 `kDQHr`／D-2 `hjdqV`／D-3 `dgeTy`／
 * D-4 `OzHLO`／D-5 `h7OeT`／D-6 `XCVGd`）。
 *
 * 時刻は必ず店舗の時間帯（日本時間）で出す。端末の時間帯では出さない。
 * 取れない値は数を推測せず「—」にする。
 */

export const STORE_TIME_ZONE = 'Asia/Tokyo'

export const DASH = '—'

/**
 * 注文番号は必ず頭に `#` を1つだけ付けて出す。
 * 取り込み元によって `#` が付く相手と付かない相手がいるので、ここでそろえる（`##` を出さない）。
 */
export function formatOrderNumber(value: string | null | undefined): string {
  const text = (value ?? '').trim()
  if (!text) return DASH
  return text.startsWith('#') ? text : `#${text}`
}

/* 相手ごとの色（絵のとおり Uber Eats は緑・出前館は赤・ロケットナウは青）。 */
export const SERVICE_TONES: Record<DeliveryService, StatusBadgeTone> = {
  ubereats: 'success',
  demaecan: 'danger',
  rocketnow: 'info',
}

function parts(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const map = Object.fromEntries(
    new Intl.DateTimeFormat('ja-JP', {
      timeZone: STORE_TIME_ZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return {
    y: map.year,
    m: Number(map.month),
    d: Number(map.day),
    hh: (map.hour ?? '').padStart(2, '0'),
    mm: (map.minute ?? '').padStart(2, '0'),
  }
}

/** 「12:02」 */
export function formatClock(value: string | null | undefined): string {
  const p = parts(value)
  return p ? `${p.hh}:${p.mm}` : DASH
}

/**
 * 詳細の日時（受付・準備完了など）。管理画面共通の書き方に合わせる：
 * 今年は「10月9日 12:02」、別の年は「2025年10月9日 12:02」。
 */
export function formatDetailStamp(value: string | null | undefined, now?: string | number | Date): string {
  if (!value) return DASH
  return formatDateTime(value, DASH, now, STORE_TIME_ZONE)
}

/**
 * きょうの日付（店舗の時間帯・`YYYY-MM-DD`）。
 * 注文履歴の日付欄の初めの値と「本日」の出し分けに使う。端末の時間帯では数えない。
 */
export function storeToday(nowMs?: number): string {
  const date = nowMs === undefined ? new Date() : new Date(nowMs)
  const map = Object.fromEntries(
    new Intl.DateTimeFormat('ja-JP', {
      timeZone: STORE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return `${map.year}-${map.month}-${map.day}`
}

/** 「¥3,480」。金額は円の整数で届く。 */
export { formatYen };

/**
 * 受信からの経過。D-1の「経過」列（「2分」「18分」）。
 * 受信時刻が読めないときは数を作らず「—」。
 */
export function formatElapsed(
  receivedAt: string | null | undefined,
  nowMs: number,
): string {
  if (!receivedAt) return DASH
  const received = new Date(receivedAt).getTime()
  if (Number.isNaN(received)) return DASH
  const minutes = Math.max(0, Math.floor((nowMs - received) / 60000))
  // 23：長い経過は日に直す（共通の日・時間・分）。短い表示は今までどおり。
  return formatDurationMinutes(minutes)
}

/**
 * 急ぎ度の見出し。判定はWorker側だけで行い、画面には結果と理由の文だけを出す。
 * 判定の仕組みの名前は画面に出さない。
 */
export const URGENCY_LABELS: Record<DeliveryUrgency, string> = {
  urgent: '急ぎ',
  watch: '注意',
  normal: 'ふつう',
}

export function urgencyLabel(value: DeliveryUrgency): string {
  return URGENCY_LABELS[value] ?? URGENCY_LABELS.normal
}

/** D-3のキャンセル理由。自由文は扱わず、選択肢の符号だけを送る。 */
export const CANCEL_REASON_OPTIONS = [
  { value: 'out_of_stock', label: '品切れのため用意できない' },
  { value: 'store_busy', label: '混雑のため受けられない' },
  { value: 'equipment_trouble', label: '調理機器の不具合' },
  { value: 'customer_request', label: 'お客様からの申し出' },
  { value: 'other', label: 'その他' },
] as const

export const CANCEL_REASON_LABELS: Record<string, string> = Object.fromEntries(
  CANCEL_REASON_OPTIONS.map((option) => [option.value, option.label]),
)

/** D-6の停止する時間。過ぎると各サービス側で自動的に再開する。 */
export const INTAKE_STOP_PRESET_OPTIONS = [
  { value: '30m', label: '30分' },
  { value: '60m', label: '60分' },
  { value: '90m', label: '90分' },
  { value: 'today', label: '本日中' },
] as const

/**
 * 画面に出す失敗の案内。「API error: 500」のような内部の文は出さず、
 * 日本語の案内だけを出す。
 */
export function errorMessage(error: unknown, fallback: string): string {
  return japaneseDetailOf(error) || fallback
}
