import type { StatusBadgeTone } from '@/components/shared/status-badge'
import type { BookingPaymentMode, PaymentEvent } from '@/lib/api/helpers/booking-payment-admin'

/* お支払いの言葉と札の色（・絵 T91bV・FY8HC・UteeA）。画面ごとに言い換えない。 */

/** いつもの方法・メニューごとの方法の名前。 */
export const MODE_LABEL: Record<BookingPaymentMode, string> = {
  none: 'お店で払う',
  onsite: 'お店で払う',
  online: 'オンラインで先払い',
  customer_choice: 'お客さまが選ぶ',
}

/** 右の欄・札で使う短い名前。 */
export const MODE_SHORT: Record<BookingPaymentMode, string> = {
  none: 'お店で払う',
  onsite: 'お店で払う',
  online: '先払い',
  customer_choice: 'お客さまが選ぶ',
}

export const MODE_TONE: Record<BookingPaymentMode, StatusBadgeTone> = {
  none: 'info',
  onsite: 'info',
  online: 'success',
  customer_choice: 'warning',
}

export const EVENT_KIND: Record<PaymentEvent['kind'], string> = {
  paid: '支払いが済んだ',
  refunded: '返金した',
  expired: '支払いの期限が切れた',
  other: 'そのほかの知らせ',
}

export const EVENT_RESULT: Record<PaymentEvent['result'], { label: string; tone: StatusBadgeTone }> = {
  applied: { label: '反映した', tone: 'success' },
  duplicate: { label: 'もう反映済み', tone: 'neutral' },
  failed: { label: '失敗', tone: 'danger' },
}

/** お客さまの情報を削除した支払いの呼び名。名前・連絡先は残っていないので、どの画面もこの言葉で出す。 */
export const DELETED_CUSTOMER_LABEL = '削除済みのお客さま'
/** お客さまの情報を削除した支払いの返金の理由。返金の口はこの値だけを受け付け、自由な文を残さない。 */
export const DELETED_CUSTOMER_REFUND_REASON = '削除済み'

/** 選べる方法。保存するときの決済サービスは方法で決まる（先払い・選ぶは Stripe）。 */
export function providerFor(mode: BookingPaymentMode): 'onsite' | 'stripe' | 'none' {
  if (mode === 'online' || mode === 'customer_choice') return 'stripe'
  return mode === 'none' ? 'none' : 'onsite'
}
