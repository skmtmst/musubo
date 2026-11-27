import { useEffect, useState } from 'react';
import { api, type MenuItem, type StaffItem } from '../lib/api.js';
import { logFailure } from '../lib/user-message.js';
import { slotStartsAtIso } from '../lib/datetime.js';
import Button from './ui/button/index.js';
import Icon from './ui/icon.js';

/**
 * 待ちの枠の開始 ISO。登録と照会で同じ文字列を使う。空き枠が返した開始の
 * 瞬間（startUtc）があればそれ、無いときだけ日付と時刻を日本時間として読む。
 */
export function waitlistStartsAt(date: string, start: string, startUtc?: string): string {
  return slotStartsAtIso({ date, start, startUtc });
}

/** 「10月4日（土）10:00」と出す。店の暦日（JST）で切る。 */
export function formatWaitlistSlot(date: string, start: string): string {
  const day = new Date(`${date}T00:00:00+09:00`).toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
  return `${day} ${start}`;
}

/**
 * 1-2 空いたら知らせる（booking-plus 2）。
 * 満席の時刻の鈴から開く小さなシート。空いた枠の登録・取り消しをする。
 * 空いたら登録の早い順に1人ずつ LINE に1通だけ知らせる（自動送信）。
 */
export default function WaitlistSheet({
  menu,
  staff,
  date,
  start,
  startUtc,
  onClose,
}: {
  menu: MenuItem;
  staff: StaffItem;
  date: string;
  start: string;
  /** 空き枠が返した開始の瞬間。あれば登録・照会はこれを使う。 */
  startUtc?: string;
  onClose: () => void;
}) {
  const [entryId, setEntryId] = useState<string | null | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [errorMessage,setErrorMessage]=useState<string|null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const startsAt = waitlistStartsAt(date, start, startUtc);

  useEffect(() => {
    let alive = true;
    setFailed(false); setErrorMessage(null); setEntryId(undefined);
    api
      .waitlistMine(staff.id, menu.id, startsAt)
      .then((res) => {
        if (!res || !(res.entry === null || (res.entry && typeof res.entry.id === 'string' && res.entry.id.trim()))) {
          throw new Error('Invalid waitlist lookup response');
        }
        if (alive) setEntryId(res.entry?.id ?? null);
      })
      .catch((e) => {
        if (alive) {
          logFailure('waitlist-mine', e);
          setFailed(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [staff.id, menu.id, startsAt, readAttempt]);

  async function register() {
    setWorking(true);
    setFailed(false);
    try {
      const res = await api.registerWaitlist({ staff_id: staff.id, menu_id: menu.id, starts_at: startsAt });
      if (!res || typeof res.id !== 'string' || !res.id.trim()) {
        setEntryId(undefined); setFailed(true);
        return;
      }
      setEntryId(res.id);
      setDoneMessage('登録しました。空いたらLINEで知らせます。');
    } catch (e) {
      logFailure('waitlist-register', e);
      const code=(e as {body?:{error?:string}}).body?.error;
      if(code==='waitlist_limit'||code==='registration_closed'||code==='slot_not_full'){setErrorMessage(code==='waitlist_limit'?'待ちは同時に3件までです。ほかの待ちを取り消してから登録してください。':code==='registration_closed'?'開始1時間前を過ぎたため、受付を締めました。':'この時間には空きがあります。予約の時刻を選び直してください。');return;}
      // 二重登録（409）は、もう待っているという意味。入り直して取り消せる形にする。
      if ((e as { status?: number }).status === 409) {
        try {
          const mine = await api.waitlistMine(staff.id, menu.id, startsAt);
          if (!mine || !mine.entry || typeof mine.entry.id !== 'string' || !mine.entry.id.trim()) throw new Error('Invalid waitlist lookup response');
          setEntryId(mine.entry?.id ?? null);
          if (!mine.entry) setFailed(true);
        } catch (retryError) {
          logFailure('waitlist-mine', retryError);
          setFailed(true);
        }
      } else {
        setFailed(true);
      }
    } finally {
      setWorking(false);
    }
  }

  async function cancel() {
    if (!entryId) return;
    setWorking(true);
    setFailed(false);
    try {
      await api.cancelWaitlist(entryId);
      setEntryId(null);
      setDoneMessage('取り消しました。');
    } catch (e) {
      logFailure('waitlist-cancel', e);
      setFailed(true);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="空いたら知らせる">
      <Button variant="overlay"
        type="button"
        aria-label="閉じる"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-md rounded-t-(--liff-radius-lg) bg-canvas p-4 pb-8">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-liff-line" aria-hidden="true" />
        <h2 className="text-[15px] font-bold text-ink">空いたら知らせる</h2>
        <p className="mt-1 text-[13px] text-liff-sub">
          {formatWaitlistSlot(date, start)}・{menu.name}・{staff.display_name}
        </p>
        {entryId === undefined && !failed ? (
          <p className="mt-3 text-[13px] text-liff-sub">読み込んでいます。</p>
        ) : doneMessage ? (
          <p className="mt-3 text-[13px] font-semibold text-ink" role="status">{doneMessage}</p>
        ) : entryId ? (
          <p className="mt-3 text-[13px] text-ink">
            登録ずみです。空いたらLINEで1通だけ知らせます。案内後30分は、あなただけが取れます。開始まで2時間を切ると10分です。
          </p>
        ) : (
          <p className="mt-3 text-[13px] text-ink">
            満席の枠に登録すると、空いたらLINEで1通だけ知らせます。案内後30分は、あなただけが取れます。開始まで2時間を切ると10分です。
          </p>
        )}
        {errorMessage&&<p className="mt-3 text-[13px] font-semibold text-danger" role="alert">{errorMessage}</p>}
        {failed && (
          <p className="mt-3 text-[13px] font-semibold text-danger" role="alert">
            読み込めませんでした。電波の良い所でもう一度お試しください。
          </p>
        )}
        <div className="mt-4 flex gap-2">
          {failed && entryId === undefined ? <Button onClick={() => setReadAttempt(n => n + 1)}>もう一度</Button> : entryId ? (
            <Button onClick={cancel} disabled={working} variant="secondary" className="flex-1">
              {working ? '取り消しています…' : '取り消す'}
            </Button>
          ) : (
            <Button onClick={register} disabled={working || entryId === undefined} className="flex-1">
              {working ? '登録しています…' : '空いたら知らせる'}
            </Button>
          )}
          <Button onClick={onClose} variant="secondary" className="flex-1">
            閉じる
          </Button>
        </div>
        <p className="mt-3 flex items-center gap-1 text-[11.5px] text-liff-sub">
          <Icon name="bell" className="h-[14px] w-[14px]" />
          先着順で案内します。同時に3件まで。開始1時間前に受付を締めます。
        </p>
      </div>
    </div>
  );
}
