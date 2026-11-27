import { useEffect, useRef, useState } from 'react';
import type { CustomerBookingWaitlist, CustomerSeatWaitlist } from '@line-crm/shared';
import { api } from '../lib/api.js';
import { formatDateTimeLong } from '../lib/datetime.js';
import Button from './ui/button/index.js';
import BookingPayment from './booking-payment.js';
/** 案内のリンクを開いた本人が、既存の予約口で期限内に確定する。 */
export default function WaitlistOfferSheet({ id, seat = false, decline = false, onClose }: { id: string; seat?: boolean; decline?: boolean; onClose: () => void ;}) {
  const [entry, setEntry] = useState<CustomerBookingWaitlist | CustomerSeatWaitlist | null>(null);
  const [error, setError] = useState<string | null>(null), [working, setWorking] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [paymentBooking, setPaymentBooking] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const key = useRef(crypto.randomUUID());
  const busy = useRef(false);
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => { let alive = true; setEntry(null); setError(null); const request = seat ? api.seatWaitlists(id) : api.bookingWaitlists(id); request.then(r => { if (!alive) return; const own = r.waitlist.find(w => w.id === id); if (own) {
    if (!['waiting', 'invited', 'converted', 'cancelled', 'finished'].includes(own.status) ||
        !Number.isFinite(Date.parse(own.starts_at))) throw new Error('Invalid waitlist offer');
    setEntry(own);
  } else setError('この案内が見つかりません。'); }).catch(() => { if (alive) setError('案内を読み込めません。もう一度お試しください。'); }); const timer = setInterval(() => setNow(Date.now()), 1000); return () => { alive = false; clearInterval(timer); }; }, [id, seat, readAttempt]);
  const active = entry?.status === 'invited' && !!entry.hold_expires_at && Date.parse(entry.hold_expires_at) > now;
  const title = outcome ? '予約の状態をご確認ください' : message ? '手続きが完了しました' : working ? '手続き中です' : error ? (entry ? '手続きを完了できませんでした' : '案内を確認できません') : !entry ? '案内を確認しています' : active ? (decline ? '今回は見送る' : '空きが出ました') : entry.status === 'waiting' ? '空きの案内を待っています' : entry.status === 'converted' ? 'この案内は予約になりました' : 'この待ちは終了しました';
  const remaining = Math.max(0, Math.ceil(((entry?.hold_expires_at ? Date.parse(entry.hold_expires_at) : now) - now) / 1000));
  async function accept() {
    if (!entry || !active || busy.current || outcome) return;
    busy.current = true; setWorking(true); setError(null);
    try {
      if (seat) {
        const { status } = await api.acceptSeatWaitlist(id, key.current);
        const statuses: Record<string, string> = {
          pending: '予約は確認待ちです。予約の状態を確認してください。',
          seated: 'この予約は来店中です。予約の状態を確認してください。',
          visited: 'この予約は来店済みです。予約の状態を確認してください。',
          cancelled: 'この予約は取り消されています。別の日時を選んで予約してください。',
          no_show: 'この予約は来店なしとして記録されています。予約の状態を確認してください。',
        };
        if (status === 'confirmed') setMessage('予約が確定しました。');
        else setOutcome((Object.hasOwn(statuses, status) ? statuses[status] : undefined) ?? '予約の状態を確認できませんでした。予約の状態を確認してください。');
      } else {
        const person = entry as CustomerBookingWaitlist;
        const result = await api.acceptWaitlist({ menu_id: person.menu_id, staff_id: person.staff_id, starts_at: person.starts_at, waitlist_id: id }, key.current);
        const statuses: Record<string, string> = {
          cancelled: 'この予約は取り消されています。別の日時を選んで予約してください。',
          expired: 'この予約の期限は切れています。別の日時を選んで予約してください。',
          rejected: 'この予約は受け付けられませんでした。別の日時を選んで予約してください。',
          completed: 'この予約は終了しています。予約の状態を確認してください。',
          no_show: 'この予約は欠席として記録されています。予約の状態を確認してください。',
        };
        if (result.status !== 'requested' && result.status !== 'confirmed') setOutcome((Object.hasOwn(statuses, result.status) ? statuses[result.status] : undefined) ?? '予約の状態を確認できませんでした。予約の状態を確認してください。');
        else if (result.payment && result.payment.status !== 'paid') setPaymentBooking(result.booking_id);
        else setMessage(result.status === 'confirmed' ? '予約が確定しました。' : '予約を受け付けました。担当の確認をお待ちください。');
      }
    } catch (e) {
      const code = (e as { body?: { error?: string } }).body?.error;
      if (code === 'offer_expired') setOutcome('仮押さえの期限が切れました。別の日時を選んで予約してください。');
      else if (code === 'slot_conflict' || code === 'slot_not_available' || code === 'closure_conflict') setOutcome('この枠は予約できなくなりました。別の日時を選んで予約してください。');
      else setOutcome('予約の結果を確認できませんでした。もう一度申し込む前に、予約の状態を確認してください。');
    } finally { busy.current = false; setWorking(false); }
  }

  async function cancel() { if (busy.current) return; busy.current = true; setWorking(true); setError(null); try { if (seat) await api.cancelSeatWaitlist(id); else await api.cancelWaitlist(id); setMessage('取り消しました。次の方へ案内します。'); } catch { setError('取り消せませんでした。もう一度お試しください。'); } finally { busy.current = false; setWorking(false); } }
  return <div className="fixed inset-0 z-50 text-ink" role="dialog" aria-modal="true" aria-label="空いたら知らせる">
    <Button variant="overlay" aria-label="閉じる" onClick={onClose} />
    <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-md rounded-t-(--liff-radius-lg) bg-canvas p-4 pb-8">
      {!paymentBooking && <h2 className="text-[15px] font-bold text-ink">{title}</h2>}
      {entry && <p className="mt-1 text-[13px] text-liff-sub">{formatDateTimeLong(entry.starts_at)}・{'guest_count' in entry ? `${entry.store_name} ${entry.guest_count}名` : `${entry.menu_name}・${entry.staff_name}`}</p>}
      {paymentBooking ? <BookingPayment bookingId={paymentBooking} onClose={onClose} menuName={('menu_name' in entry! ? entry!.menu_name : '') || 'ご予約'} initialAmount={0} slot={{ date: new Date(entry!.starts_at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }), start: new Date(entry!.starts_at).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }) }} durationMinutes={('ends_at' in entry! && entry!.ends_at) ? (Date.parse(entry!.ends_at) - Date.parse(entry!.starts_at)) / 60000 : 60} /> : outcome ? <p className="mt-3" role="alert">{outcome}</p> : message ? <p className="mt-3" role="status">{message}</p> : entry ? <p className="mt-3 text-[13px]">{active ? `仮押さえは${new Date(entry.hold_expires_at!).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}までです。${decline ? '見送ると次の方へ案内します。' : '期限内に予約を確定してください。'}` : entry.status === 'waiting' ? 'まだ空きの案内を待っています。' : entry.status === 'converted' ? 'この案内は予約になりました。' : 'この待ちは終わりました。仮押さえはありません。'}</p> : !error ? <p className="mt-3">読み込んでいます。</p> : null}
      {active && !outcome && !message && !paymentBooking && <p className="mt-3 text-[13px] text-ink" role="timer">残り{Math.floor(remaining / 60)}分{String(remaining % 60).padStart(2, '0')}秒</p>}
      {error && !entry && <Button variant="secondary" onClick={() => setReadAttempt(n => n + 1)}>もう一度</Button>}
      {error && <p className="mt-3 text-[13px] text-danger" role="alert">{error}</p>}
      {!paymentBooking && <div className="mt-4 flex flex-col gap-2">{!outcome && !message && !paymentBooking && active && !decline && <Button disabled={working} onClick={accept}>この枠で予約する</Button>}{!outcome && !message && !paymentBooking && (entry?.status === 'waiting' || active) && <Button variant="secondary" disabled={working} onClick={cancel}>{active ? '今回は見送る' : '待ちを取り消す'}</Button>}<Button variant="secondary" onClick={onClose}>閉じる</Button></div>}
    </div>
  </div>;
}
