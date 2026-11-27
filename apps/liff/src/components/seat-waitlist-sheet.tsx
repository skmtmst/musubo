import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { formatDateTimeLong } from '../lib/datetime.js';
import Button from './ui/button/index.js';

/** 人数を指定した満席の時刻だけを、既存の本人用APIへつなぐ。 */
export default function SeatWaitlistSheet({ storeId, storeName, startsAt, guestCount, onClose }: {
  storeId: string; storeName: string; startsAt: string; guestCount: number; onClose: () => void;
}) {
  const [entryId, setEntryId] = useState<string | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const busy = useRef(false);
  useEffect(() => {
    let live = true;
    setEntryId(undefined); setError(null);
    api.seatWaitlists().then(result => {
      if (!result || !Array.isArray(result.waitlist) || !result.waitlist.every(row => row &&
        ['waiting', 'invited', 'converted', 'cancelled', 'finished'].includes(row.status))) {
        throw new Error('Invalid seat waitlist response');
      }
      if (live) setEntryId(result.waitlist.find(row => row.store_id === storeId && Date.parse(row.starts_at) === Date.parse(startsAt) && row.guest_count === guestCount && (row.status === 'waiting' || row.status === 'invited'))?.id ?? null);
    }).catch(() => { if (live) setError('待ちの情報を読み込めませんでした。もう一度お試しください。'); });
    return () => { live = false; };
  }, [storeId, startsAt, guestCount, attempt]);
  async function change() {
    if (busy.current || entryId === undefined) return;
    busy.current = true; setWorking(true); setError(null);
    try {
      if (entryId) {
        await api.cancelSeatWaitlist(entryId); setEntryId(null); setMessage('取り消しました。');
      } else {
        const result = await api.registerSeatWaitlist({ store_id: storeId, starts_at: startsAt, guest_count: guestCount });
        if (!result || typeof result.id !== 'string' || !result.id.trim()) {
          setEntryId(undefined); setError('登録結果を確認できませんでした。もう一度読み込んでください。');
          return;
        }
        setEntryId(result.id); setMessage('登録しました。空いたらLINEで知らせます。');
      }
    } catch (cause) {
      const code = (cause as { body?: { error?: string } }).body?.error;
      setError(code === 'waitlist_limit' ? '待ちは同時に3件までです。ほかの待ちを取り消してから登録してください。'
        : code === 'registration_closed' ? '開始1時間前を過ぎたため、受付を締めました。'
        : code === 'slot_not_full' ? 'この時間には空きがあります。予約の時刻を選び直してください。'
        : '変更できませんでした。もう一度お試しください。');
    } finally { busy.current = false; setWorking(false); }
  }
  return <div className="fixed inset-0 z-50 text-ink" role="dialog" aria-modal="true" aria-label="空いたら知らせる">
    <Button variant="overlay" aria-label="閉じる" onClick={onClose} />
    <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-md rounded-t-(--liff-radius-lg) bg-canvas p-4 pb-8">
      <h2 className="text-[15px] font-bold text-ink">空いたら知らせる</h2>
      <p className="mt-1 text-[13px] text-liff-sub">{storeName}・{formatDateTimeLong(startsAt)}・{guestCount}名</p>
      {message ? <p className="mt-3" role="status">{message}</p> : entryId === undefined && !error ? <p className="mt-3" role="status">読み込んでいます。</p> : entryId ? <p className="mt-3">登録ずみです。空いたらLINEで知らせます。</p> : !error ? <p className="mt-3">満席の時刻に登録すると、空いたらLINEで知らせます。</p> : null}
      {error && <p className="mt-3 text-[13px] text-danger" role="alert">{error}</p>}
      <div className="mt-4 flex gap-2">
        {error && entryId === undefined ? <Button onClick={() => setAttempt(n => n + 1)}>もう一度</Button> : <Button disabled={working || entryId === undefined} variant={entryId ? 'secondary' : 'primary'} onClick={() => void change()}>{entryId ? '取り消す' : '空いたら知らせる'}</Button>}
        <Button variant="secondary" onClick={onClose}>閉じる</Button>
      </div>
      <p className="mt-3 text-[11.5px] text-liff-sub">先着順で案内します。同時に3件まで。開始1時間前に受付を締めます。案内後30分は、あなただけが取れます。開始まで2時間を切ると10分です。</p>
    </div>
  </div>;
}
