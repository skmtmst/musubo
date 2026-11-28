import { useCustomerWords, useCustomerStyle } from '../components/customer-style-scope.js';
import { PAYMENT_UNKNOWN } from '../lib/customer-words.js';
import BookingHistoryCancelDialog from '../components/booking-history-cancel-dialog.js';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type BookingHistoryItem } from '../lib/api.js';
import { addDays, slotStartsAtIso, jstToday, formatMd, formatWeekday } from '../lib/datetime.js';
import ConfirmDialog from '../components/ui/confirm-dialog.js';
import { logFailure } from '../lib/user-message.js';
import LoadErrorView from '../components/load-error-view.js';
import LoadingView from '../components/loading-view.js';
import HistoryCard from '../components/history-card.js';
import WaitlistSection from '../components/waitlist-section.js';
import LessonHistorySection from '../components/lesson-history-section.js';
import LiffHeader from '../components/ui/liff-header.js';
import LiffLookScope from '../components/liff-look-scope.js';
import StatusView from '../components/ui/status-view.js';
import liff from '@line/liff';

import BottomBar from '../components/ui/bottom-bar.js';
import Button from '../components/ui/button/index.js';

import Icon from '../components/ui/icon.js';

import { loadPaymentViews,type PaymentView } from '../lib/booking-payment-view.js';

import { CHANGE_RANGE_DAYS,CHANGE_SLOT_LIMIT,cancelFailureMessage,changeFailureMessage,errorCode,type ChangeSlot } from './booking-history-messages';

/** 予約履歴と本人の変更・取消。版が返る予約に操作を出し、支払いの状態と領収書も表示する。 */
export default function BookingHistory() {
  const words = useCustomerWords();
  const style = useCustomerStyle();
  const [data, setData] = useState<{ upcoming: BookingHistoryItem[]; past: BookingHistoryItem[] } | null>(
    null,
  );
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const navigate = useNavigate();
  const { search } = useLocation();
  /* 取消の確認・日時変更の窓と、送っている途中・失敗の文。 */
  const [pendingCancel, setPendingCancel] = useState<BookingHistoryItem | null>(null);
  const [cancelQuoteKey,setCancelQuoteKey]=useState(0);
  const [pendingChange, setPendingChange] = useState<{
    booking: BookingHistoryItem;
    slots: ChangeSlot[] | null;
    slotsFailed: boolean;
    selected: ChangeSlot | null;
    error: string | null;
  } | null>(null);
  /* 振替先を選ぶ間は、その帯が下の操作を担う（下の帯を重ねない）。 */
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /* 予約ごとの支払いの札（nWby5）。読めない予約は札なし＝予約の状態の札を出す。 */
  const [payments, setPayments] = useState<Record<string, PaymentView | null>>({});
  const [paymentKey, setPaymentKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const changeRequest = useRef(0);

  useEffect(() => {
    setFailed(false);
    api
      .me()
      .then(setData)
      .catch((e) => {
        logFailure('booking-history', e);
        setFailed(true);
      });
  }, [reloadKey]);

  // 開いているタブの予約だけ支払いを読む。Stripe から戻ったとき（画面が見えたとき）も読み直す。
  useEffect(() => {
    if (!data) return;
    let alive = true;
    void loadPaymentViews(tab === 'upcoming' ? data.upcoming : data.past).then((views) => {
      if (alive) setPayments((prev) => ({ ...prev, ...views }));
    });
    return () => { alive = false; };
  }, [data, tab, paymentKey]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setPaymentKey((k) => k + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  /** 未払いの先払いを Stripe の支払いページで払う（予約の 5 段目と同じ口。同じ申込は同じページが返る）。 */
  async function runPay(booking: BookingHistoryItem) {
    if (busy) return;
    if (payments[booking.id]?.actionRequired) { setNotice(PAYMENT_UNKNOWN); return; }
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const res = await api.startBookingPayment(booking.id);
      if (!res.checkoutUrl) {
        setActionError(PAYMENT_UNKNOWN);
        return;
      }
      // 決済画面は外のブラウザで開く (店内の WebView では 3D セキュア等が動かないことがある)。
      liff.openWindow({ url: res.checkoutUrl, external: true });
      setNotice('お支払いのページを開きました。終わったらこの画面に戻ると、状態が変わります。');
    } catch (err) {
      logFailure('booking-history-pay', err);
      setPayments((prev) => ({ ...prev, [booking.id]: prev[booking.id] ? { ...prev[booking.id]!, actionRequired: true } : null }));
      setActionError(PAYMENT_UNKNOWN);
    } finally {
      setBusy(false);
    }
  }

  function openReceipt(view: PaymentView) {
    setActionError(null);
    if (!view.receiptUrl) {
      // 領収書の URL を返す口は組1 に依頼中（：入口は置き、押すと準備中の案内）。
      setNotice('領収書は現在準備中です。必要なときはトークでご利用先にご連絡ください。');
      return;
    }
    setNotice(null);
    liff.openWindow({ url: view.receiptUrl, external: true });
  }

  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const withinDeadline = (b: BookingHistoryItem, at: number) => at < Date.parse(b.starts_at)
    && (!b.cancel_deadline_at || at <= Date.parse(b.cancel_deadline_at));
  const canCancel = (b: BookingHistoryItem) => tab === 'upcoming' && (b.status === 'requested' || b.status === 'confirmed') && typeof b.lock_version === 'number' && Number.isInteger(b.lock_version) && b.lock_version >= 0
    && withinDeadline(b, now);
  const canChange = (b: BookingHistoryItem) =>
    canCancel(b) && typeof b.menu_id === 'string' && typeof b.staff_id === 'string';

  const paidCancel = pendingCancel && payments[pendingCancel.id]?.kind === 'paid' ? payments[pendingCancel.id] : null;

  async function runCancel(confirmation?:import('@line-crm/shared').BookingCancellationConfirmation,deadline?:string) {
    const target = pendingCancel;
    if (!target || busy || typeof target.lock_version !== 'number') return;
    if (!withinDeadline({...target,cancel_deadline_at:deadline??target.cancel_deadline_at}, Date.now())) {
      setActionError('キャンセルの期限を過ぎています。トークでご連絡ください。');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      if(confirmation)await api.cancelMyBooking(target.id, target.lock_version,confirmation);
      else await api.cancelMyBooking(target.id,target.lock_version);
      setPendingCancel(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      logFailure('booking-history-cancel', err);
      const code = errorCode(err);
      setActionError(cancelFailureMessage(code));
      if(target.cancellationQuote?.policyAcceptedRequired||code==='cancellation_fee_confirmation_required')setCancelQuoteKey(key=>key+1);
      if (code === 'version_conflict' || code === 'not_editable' || code === 'booking_not_found') {
        setPendingCancel(null);
        setReloadKey((k) => k + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  async function openChange(booking: BookingHistoryItem) {
    if (busy || !canChange(booking) || !withinDeadline(booking, Date.now())) return;
    const request = ++changeRequest.current;
    setActionError(null);
    setPendingChange({ booking, slots: null, slotsFailed: false, selected: null, error: null });
    const from = jstToday();
    try {
      const res = await api.availability(booking.menu_id, booking.staff_id, from, addDays(from, CHANGE_RANGE_DAYS - 1));
      if (!Array.isArray(res.by_staff) || res.by_staff.some((bucket) => !bucket || !Array.isArray(bucket.slots))) throw new Error('invalid_availability');
      if (request !== changeRequest.current) return;
      const current = booking.starts_at;
      const slots: ChangeSlot[] = [];
      for (const bucket of res.by_staff ?? []) {
        for (const slot of bucket.slots ?? []) {
          const open = !((slot.remaining ?? 1) <= 0 || slot.state === 'full' || slot.state === 'closed');
          if (!open) continue;
          if (new Date(slotStartsAtIso(slot)).getTime() === new Date(current).getTime()) continue;
          if (slots.some((s) => s.date === slot.date && s.start === slot.start)) continue;
          slots.push({ date: slot.date, start: slot.start, ...(slot.startUtc ? { startUtc: slot.startUtc } : {}) });
        }
      }
      slots.sort((a, b) => (`${a.date} ${a.start}` < `${b.date} ${b.start}` ? -1 : 1));
      setPendingChange((prev) =>
        prev && prev.booking.id === booking.id ? { ...prev, slots: slots.slice(0, CHANGE_SLOT_LIMIT) } : prev,
      );
    } catch (err) {
      if (request !== changeRequest.current) return;
      logFailure('booking-history-change-slots', err);
      setPendingChange((prev) => (prev && prev.booking.id === booking.id ? { ...prev, slotsFailed: true } : prev));
    }
  }

  async function runChange() {
    const target = pendingChange;
    if (!target || !target.selected || busy || typeof target.booking.lock_version !== 'number') return;
    if (!withinDeadline(target.booking, Date.now())) {
      setPendingChange(prev => prev ? { ...prev, error: '変更の期限を過ぎています。トークでご連絡ください。' } : prev);
      return;
    }
    setBusy(true);
    try {
      await api.rescheduleMyBooking(target.booking.id, {
        // 空き枠が返した開始の瞬間を送る（店が日本時間以外でもずれない）。
        starts_at: slotStartsAtIso(target.selected),
        lock_version: target.booking.lock_version,
      });
      setPendingChange(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      logFailure('booking-history-change', err);
      const message = changeFailureMessage(errorCode(err));
      setPendingChange((prev) =>
        prev && prev.booking.id === target.booking.id ? { ...prev, error: message, selected: null } : prev,
      );
    } finally {
      setBusy(false);
    }
  }

  const list = data ? (tab === 'upcoming' ? data.upcoming : data.past) : [];
  const anySelfChange = list.some((b) => canCancel(b));

  return (
    <LiffLookScope className="min-h-screen bg-canvas">
      <LiffHeader title="予約の履歴" />
      <div
        data-design-node="nWby5"
        className="mx-auto w-full max-w-md space-y-3.5 px-4 pt-3 pb-40"
      >
        <h1 className="text-xl font-bold text-ink">予約の履歴</h1>
        {failed ? (
          <LoadErrorView note="予約はなくなっていません。" onRetry={() => setReloadKey((k) => k + 1)} />
        ) : !data ? (
          <LoadingView />
        ) : (
          <>
            <div
              className="flex rounded-(--liff-radius) bg-liff-chip p-[3px]"
              role="tablist"
              aria-label="予約の期間"
            >
              {(
                [
                  { key: 'upcoming', label: 'これから' },
                  { key: 'past', label: 'これまで' },
                ] as const
              ).map((t) => (
                <Button variant="tab" selected={tab === t.key}
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </Button>
              ))}
            </div>
            {actionError && !pendingCancel && !pendingChange && (
              <p role="alert" className="text-[13px] leading-5 text-danger">{actionError}</p>
            )}
            {tab === 'upcoming' ? <LessonHistorySection onPicking={setPicking} onLater={() => navigate({ pathname: '/mypage', search })} /> : null}
            {tab === 'upcoming' ? <WaitlistSection upcomingHeading={list.length > 0} onChanged={() => setReloadKey((k) => k + 1)} /> : null}
            {notice && (
              <p role="status" className="text-[13px] leading-5 text-ink-secondary">{notice}</p>
            )}
            {list.length === 0 ? (
              tab === 'upcoming' ? (
                <StatusView
                  icon="calendar"
                  title="これからの予約はありません"
                  body={style === 'ec' || style === 'lesson' ? undefined : '空いている日時から、そのまま予約できます。'}
                />
              ) : (
                <StatusView icon="calendar" title="これまでの予約はありません" />
              )
            ) : (
              <ul className="space-y-3.5">
                {list.map((b) => {
                  const pay = payments[b.id] ?? null;
                  return (
                  <HistoryCard
                    key={b.id}
                    booking={b}
                    payment={pay}
                    onPay={pay?.kind === 'unpaid' && !pay.actionRequired && tab === 'upcoming' ? () => void runPay(b) : undefined}
                    onReceipt={pay && !pay.actionRequired && (pay.kind === 'paid' || pay.kind === 'refunded') ? () => openReceipt(pay) : undefined}
                    disabled={busy}
                    onChange={canChange(b) ? () => void openChange(b) : undefined}
                    onCancel={canCancel(b) ? () => { setActionError(null); setCancelQuoteKey(0); setPendingCancel(b); } : undefined}
                  />
                  );
                })}
              </ul>
            )}
            <p className="flex gap-1.5 text-[11.5px] leading-[17px] text-liff-sub">
              <Icon name="message-circle" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {anySelfChange
                  ? words.selfService
                  : `予定の変更・キャンセルは、${words.contact}に LINE でご連絡ください。`}
              </span>
            </p>
          </>
        )}
      </div>
      {data && !failed && !picking && style !== 'ec' && style !== 'lesson' && (
        <BottomBar>
          <Button
            variant="primary"
            onClick={() => navigate({ pathname: '/booking', search })}
          >
            新しく予約する
          </Button>
        </BottomBar>
      )}
      <BookingHistoryCancelDialog booking={pendingCancel} payment={paidCancel || null} busy={busy} error={actionError} refreshKey={cancelQuoteKey}
        onConfirm={(confirmation,deadline) => void runCancel(confirmation,deadline)} onReload={()=>{setPendingCancel(null);setReloadKey(key=>key+1)}} onCancel={() => { if (!busy) setPendingCancel(null) }} />
      <ConfirmDialog
        open={pendingChange !== null}
        title={pendingChange ? `「${pendingChange.booking.menu_name}」の日時を変えますか` : ''}
        description="空いている日時から選びます。新しい日時を取れたときだけ、今の予約が変わります。"
        confirmLabel="日時を変える"
        cancelLabel="閉じる"
        busy={busy}
        error={pendingChange?.error ?? undefined}
        onCancel={() => {
          if (!busy) setPendingChange(null);
        }}
        onConfirm={pendingChange?.selected && !busy ? () => void runChange() : undefined}
      >
        {pendingChange && (
          <div className="mt-3">
            {pendingChange.slots === null && !pendingChange.slotsFailed && (
              <p className="text-sm text-ink-secondary">空いている日時を読み込んでいます…</p>
            )}
            {pendingChange.slotsFailed && (
              <div className="space-y-2">
                <p className="text-sm text-ink-secondary">
                  空いている日時を読み込めませんでした。予約はなくなっていません。
                </p>
                <Button variant="secondary" disabled={busy} onClick={() => void openChange(pendingChange.booking)}>
                  読み直す
                </Button>
              </div>
            )}
            {pendingChange.slots !== null && pendingChange.slots.length === 0 && (
              <p className="text-sm text-ink-secondary">
                {`${CHANGE_RANGE_DAYS}日先までに空いている日時がありません。トークでご連絡ください。`}
              </p>
            )}
            {pendingChange.slots !== null && pendingChange.slots.length > 0 && (
              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {pendingChange.slots.map((slot) => {
                  const selected =
                    pendingChange.selected?.date === slot.date && pendingChange.selected?.start === slot.start;
                  return (
                    <li key={`${slot.date}-${slot.start}`}>
                      <Button variant="optionRow" selected={selected}
                        type="button"
                        disabled={busy}
                        aria-pressed={selected}
                        onClick={() =>
                          setPendingChange((prev) => (prev ? { ...prev, selected: slot, error: null } : prev))
                        }
                      >
                        <span
                          className="liff-num text-sm font-semibold whitespace-nowrap text-ink"
                        >
                          {`${formatMd(slot.date)}（${formatWeekday(slot.date)}） ${slot.start}`}
                        </span>
                        <span
                          className="shrink-0 text-xs whitespace-nowrap text-ink-secondary"
                        >
                          {selected ? 'この日時' : '空きあり'}
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </ConfirmDialog>
    </LiffLookScope>
  );
}
