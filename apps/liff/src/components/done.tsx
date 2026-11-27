import { useCustomerWords } from './customer-style-scope.js';
import PaymentPreparingNote from './payment-preparing-note.js';
import { PAYMENT_UNKNOWN } from '../lib/customer-words.js';
import { isCalendarDate } from '@line-crm/shared';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import liff from '@line/liff';
import { addMinutesHm, formatJpLong } from '../lib/datetime.js';
import { api } from '../lib/api.js';
import { logFailure } from '../lib/user-message.js';
import Button from './ui/button/index.js';
import BottomBar from './ui/bottom-bar.js';
import Icon from './ui/icon.js';
import OnlineMeetingCard from './online-meeting-card.js';
import type { SlotPick } from './date-time-picker.js';

/**
 * 1-e 受け付けました (★V8・)。緑の丸の印＋題＋送った内容のカード。
 * 下の帯は「LINEに戻る」(主) と「予約の履歴を見る」(副)。
 * (撮影: ボタン名は「予約の履歴を見る」のまま)
 */
export default function Done({
  menuName,
  slot,
  durationMinutes,
  status,
  bookingId,
  prepayNotice,
}: {
  menuName: string;
  slot: SlotPick;
  /** 所要時間（分）。渡したときは日時に終わりの時刻も出す（★V8 sjkwK・I5hxa）。 */
  durationMinutes?: number;
  /** 作られた予約の状態。confirmed なら未承認の表示を出さない。 */
  status: string;
  /** 予約ID（前払いのみの案内があるときだけ使う）。 */
  bookingId?: string | null;
  /** 無断キャンセルが続いている人への前払いのみの案内。無いときは出さない。 */
  prepayNotice?: string | null;
}) {
  const words = useCustomerWords();
  // initLiff は ?liffId=... をクエリから読むので、内部遷移でも保持する。
  // search を維持しないと「予約の履歴を見る」→ WebView 再読み込みで liffId が失われる。
  const { search } = useLocation();
  const navigate = useNavigate();
  const knownStatus = status === 'confirmed' || status === 'requested';
  const validSlot = isCalendarDate(slot.date) && typeof slot.start === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot.start);
  /** お支払いへ進む：starting | phone（決済が無い店）| failed。 */
  const [payState, setPayState] = useState<'idle' | 'starting' | 'phone' | 'failed'>('idle');

  async function startPayment() {
    if (!bookingId || (payState === 'starting' || payState === 'failed')) return;
    setPayState('starting');
    try {
      const res = await api.startBookingPayment(bookingId);
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      // 決済の用意が無い店では電話での確認に案内する。
      setPayState('phone');
    } catch (e) {
      logFailure('start-booking-payment', e);
      setPayState('failed');
    }
  }

  return (
    <div className="space-y-3.5" data-design-node="VU6Xi">
      {/* 板 VU6Xi：上に 40 空け、丸・題・説明・箱の間は 14。 */}
      <div className="flex flex-col items-center pt-10 text-center">
        <span
          className="mt-3.5 flex h-18 w-18 items-center justify-center rounded-full bg-liff-soft text-liff-primary"
          aria-hidden="true"
        >
          <Icon name={knownStatus ? 'check' : 'alert-triangle'} className="h-9 w-9" />
        </span>
        <p className="mt-3.5 text-xl font-bold text-ink">
          {status === 'confirmed' ? '予約が確定しました' : status === 'requested' ? 'リクエストを受け付けました' : '予約の状態を確認できません'}
        </p>
        <p className="mt-3.5 text-[13px] leading-[21px] text-pretty text-liff-sub">
          {status === 'confirmed' ? (
            <>
              前日と 1 時間前に LINE でお知らせします。
              <br />
              この画面は閉じてかまいません。
            </>
          ) : status === 'requested' ? (
            <>
              {`${words.contact}が確かめたら、LINE でお知らせします。`}
              <br />
              この画面は閉じてかまいません。
            </>
          ) : '予約の履歴をご確認ください。'}
        </p>
      </div>
      <dl data-liff-card className="divide-y divide-liff-divider rounded-(--liff-radius-lg) bg-canvas px-3.5 py-1 outline outline-1 -outline-offset-1 outline-liff-line">
        <div className="flex h-10 items-start gap-2 py-2.5">
          <dt className="w-18 shrink-0 text-xs text-liff-sub">日時</dt>
          <dd className="min-w-0 flex-1 text-sm font-semibold text-ink">
            {/* 終わりの時刻まで出す（★V8 sjkwK・I5hxa）。所要時間が分からないときは始まりだけ。 */}
            {validSlot ? `${formatJpLong(slot.date)}${slot.start}〜${durationMinutes && Number.isFinite(durationMinutes) && durationMinutes > 0 ? addMinutesHm(slot.start, durationMinutes) : ''}` : '予約日時を確認できません'}
          </dd>
        </div>
        <div className="flex h-10 items-start gap-2 py-2.5">
          <dt className="w-18 shrink-0 text-xs text-liff-sub">{words.bookingContent}</dt>
          <dd className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={menuName}>
            {menuName}
          </dd>
        </div>
        <div className="flex h-10 items-start gap-2 py-2.5">
          <dt className="w-18 shrink-0 text-xs text-liff-sub">状態</dt>
          <dd className="min-w-0 flex-1 text-sm font-semibold text-ink">
            {status === 'confirmed' ? '確定' : status === 'requested' ? words.approvalPending : '確認できません'}
          </dd>
        </div>
      </dl>
      <OnlineMeetingCard bookingId={bookingId} status={status} />
      {prepayNotice ? <PaymentPreparingNote /> : null}
      {prepayNotice && (
        <section
          aria-label="事前のお支払いのお願い"
          className="rounded-(--liff-radius-lg) bg-canvas p-3.5 outline-1 -outline-offset-1 outline-liff-line"
        >
          <p className="text-[15px] font-bold text-ink">事前のお支払いをお願いしています</p>
          <p className="mt-1 text-[13px] leading-6 text-liff-sub">{prepayNotice}</p>
          {payState === 'phone' || payState === 'failed' ? (
            <p className="mt-2 text-[13px] leading-6 text-ink" role="status">
              {payState === 'failed' ? PAYMENT_UNKNOWN : `アプリでのお支払いは準備中です。支払い方法は${words.contact}に${words.contact === '担当' ? 'LINEで' : '電話で'}確認してください。`}
            </p>
          ) : (
            <Button
              variant="primary"
              onClick={startPayment}
              disabled={payState === 'starting'}
              className="mt-3"
            >
              {payState === 'starting' ? 'お支払いへ進んでいます…' : 'お支払いへ進む'}
            </Button>
          )}

        </section>
      )}
      <div className="pb-40" aria-hidden="true" />
      <BottomBar>
        <Button variant="primary" onClick={() => liff.closeWindow()}>
          LINEに戻る
        </Button>
        <Button
          variant="secondary"
          onClick={() => navigate({ pathname: '/booking/history', search })}
        >
          予約の履歴を見る
        </Button>
      </BottomBar>
    </div>
  );
}
