import { useCustomerWords } from './customer-style-scope.js';
import { PAYMENT_UNKNOWN } from '../lib/customer-words.js';
import BookingCancelDeadline from './booking-cancel-deadline.js';
import type { BookingHistoryItem } from '../lib/api.js';
import { paymentText, type PaymentView } from '../lib/booking-payment-view.js';
import { utcToJstHm, utcToJstMd } from '../lib/datetime.js';
import Card from './ui/card.js';
import Badge from './ui/badge.js';
import Button from './ui/button/index.js';
import Icon from './ui/icon.js';
import UnpaidPaymentNote from './unpaid-payment-note.js';
import OnlineMeetingCard from './online-meeting-card.js';

/**
 * 予約の履歴の札 (★V8・nWby5)。日付の四角＋メニュー名＋支払いの札（無いときは予約の状態の札）。
 * 支払い済み・返金済みは「領収書を見る」（Stripe のページ）。未払いは払う期限と［お支払いへ進む］。
 * 下に「日時を変える／キャンセル」の2ボタン (本人の変更・取消)。
 * 押す口が渡されたときだけ出す (履歴の口が版などを返さないと送れないため、呼び側が決める)。
 */
export default function HistoryCard({
  booking,
  payment = null,
  onChange,
  onCancel,
  onPay,
  onReceipt,
  disabled = false,
}: {
  booking: BookingHistoryItem;
  payment?: PaymentView | null;
  onChange?: () => void;
  onCancel?: () => void;
  /** 未払いの先払いのときだけ渡す。Stripe の支払いページへ。 */
  onPay?: () => void;
  /** 支払い済み・返金済みのときだけ渡す。 */
  onReceipt?: () => void;
  disabled?: boolean;
}) {
  const words = useCustomerWords();
  const statusWords: Record<string, string> = { requested: words.approvalPending, completed: words.completed, no_show: words.noShow, rejected: 'お受けできませんでした' };
  const base = Object.hasOwn(STATUS_META, booking.status) ? STATUS_META[booking.status] : undefined;
  const meta = (base ? { ...base, label: statusWords[booking.status] ?? base.label } : null) ?? { label: '予約状態を確認できません', tone: 'neutral' as const };
  const validStart = typeof booking.starts_at === 'string' && Number.isFinite(Date.parse(booking.starts_at));
  const hasActions = Boolean(onChange || onCancel || onPay);
  // 支払いの札があるときは、予約の状態は「確定」以外だけを札の右に文字で添える（絵の「返金済み キャンセル」）。
  const statusAside = payment && booking.status !== 'confirmed' && booking.status !== 'completed' && meta.label !== payment.label ? meta.label : null;
  return (
    <li>
      <Card className="flex flex-col gap-2.5 p-3.5">
        <div className="flex items-center gap-3">
          <div className="flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-(--liff-radius) bg-liff-off-bg py-2">
            <span className="liff-num text-[15px] leading-[18px] font-bold whitespace-nowrap text-ink">
              {validStart ? utcToJstMd(booking.starts_at) : '日時不明'}
            </span>
            {validStart ? <span className="liff-num text-[11px] leading-[13px] text-liff-sub">{utcToJstHm(booking.starts_at)}</span> : null}
          </div>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
            <div className="w-full truncate text-[15px] leading-normal font-bold text-ink" title={booking.menu_name}>
              {booking.menu_name}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              {payment ? <Badge size="md" tone={payment.tone}>{paymentText(payment, words.payOnsite)}</Badge> : <Badge size="md" tone={meta.tone}>{meta.label}</Badge>}
              {statusAside && <span className="truncate text-xs text-liff-sub">{statusAside}</span>}
            </div>
          </div>
        </div>
        {payment?.actionRequired ? <p role="status" className="text-xs leading-5 text-liff-sub">{PAYMENT_UNKNOWN}</p> : null}
        {validStart ? <OnlineMeetingCard bookingId={booking.id} status={booking.status} booking={booking} /> : <p role="status" className="text-xs text-liff-sub">予約日時を確認できません</p>}
        {onReceipt && (
          <div className="flex items-center justify-between gap-2">
            <Button variant="link" onClick={onReceipt} disabled={disabled}>
              <Icon name="receipt" className="h-4 w-4" />
              領収書を見る
              <Icon name="external-link" className="h-3.5 w-3.5" />
            </Button>
            <span className="truncate text-[11px] text-liff-sub">{payment?.receiptUrl ? '領収書のページが開きます' : '領収書は準備中です'}</span>
          </div>
        )}
        {/* 未払い（nWby5）：払う期限と、［お支払いへ進む］を日時を変えるの位置に（主ボタン）。 */}
        {payment?.kind === 'unpaid' && payment.holdUntil ? <UnpaidPaymentNote holdUntil={payment.holdUntil} /> : <BookingCancelDeadline deadline={booking.cancel_deadline_at} />}
        {hasActions && (
          <div className="flex gap-2">
            {onPay ? (
              <Button variant="primary" className="flex-1" disabled={disabled} onClick={onPay}>
                お支払いへ進む
              </Button>
            ) : onChange && (
              <Button variant="secondary" className="flex-1" disabled={disabled} onClick={onChange}>
                日時を変える
              </Button>
            )}
            {onCancel && (
              <Button variant="secondary" className="flex-1" disabled={disabled} onClick={onCancel}>
                キャンセル
              </Button>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

const STATUS_META: Record<string, { label: string; tone: 'confirmed' | 'pending' | 'neutral' }> = {
  requested: { label: '確認待ち', tone: 'pending' },
  confirmed: { label: '確定', tone: 'confirmed' },
  rejected: { label: '不可', tone: 'neutral' },
  expired: { label: '期限切れ', tone: 'neutral' },
  cancelled: { label: 'キャンセル', tone: 'neutral' },
  completed: { label: '完了', tone: 'neutral' },
  no_show: { label: '無断キャンセル', tone: 'neutral' },
};
