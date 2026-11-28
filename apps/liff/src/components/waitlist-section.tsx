import { jstDate as japanDate } from '@line-crm/shared';
import { useCallback, useEffect, useState } from 'react';
import type { CustomerBookingWaitlist } from '@line-crm/shared';
import { api } from '../lib/api.js';
import { logFailure } from '../lib/user-message.js';
import { utcToJstHm, utcToJstMd, formatWeekday } from '../lib/datetime.js';
import Button from './ui/button/index.js';
import LoadErrorView from './load-error-view.js';
import WaitlistOfferSheet from './waitlist-offer-sheet.js';

/** 自分のキャンセル待ち。順番（先着・何番目か）は口が返す。口が無い間は番号を出さない。 */
export type WaitlistRow = CustomerBookingWaitlist & { position?: number | null };

const jstDay = (iso: string) => japanDate(new Date(iso));

/**
 * 予約の履歴 › 「キャンセル待ち中（N）」（★V8・Zm2Vh・xANkO）。
 * 空きが出た人には「あと N 分 お取りしています」と［予約する］（先着・30分、開始2時間前を切ったら10分の仮押さえ）。
 * 時間内に決めなかった人には「時間切れ」と［もう一度キャンセル待ちをする］。1人3件まで・開始の1時間前で締める。
 */
export default function WaitlistSection({ onChanged, upcomingHeading }: { onChanged?: () => void; /** 待ちの下に予約が続くときだけ true。「これからの予約」の見出しで区切る。 */ upcomingHeading?: boolean }) {
  const [loadFailed, setLoadFailed] = useState(false);
  const [rows, setRows] = useState<WaitlistRow[] | null>(null);
  const [now, setNow] = useState(Date.now());
  const [working, setWorking] = useState<string | null>(null);
  const [offerId, setOfferId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadFailed(false);
    Promise.resolve().then(() => api.bookingWaitlists()).then((r) => {
      if (!r || !Array.isArray(r.waitlist) || !r.waitlist.every(row => row &&
        ['waiting', 'invited', 'converted', 'cancelled', 'finished'].includes(row.status))) {
        throw new Error('Invalid waitlist response');
      }
      if (alive) setRows(r.waitlist as WaitlistRow[]);
    }).catch((e) => { logFailure('waitlist-section', e); if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, [reload]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const refresh = useCallback(() => { setReload((n) => n + 1); onChanged?.(); }, [onChanged]);

  /* 見せるのは待っている・案内が来ている・時間切れの 3 つ。予約になった・取り消した待ちは出さない。 */
  const shown = (rows ?? []).filter((w) => w.status === 'waiting' || w.status === 'invited' || (w.status === 'finished' && !!w.hold_expires_at));
  if (loadFailed) return <LoadErrorView compact note="キャンセル待ちはなくなっていません。" onRetry={() => setReload(n => n + 1)} />;
  if (shown.length === 0 && !offerId) return null;

  async function cancel(id: string) {
    if (working) return;
    setWorking(id); setError(null);
    try { await api.cancelWaitlist(id); refresh(); }
    catch (e) { logFailure('waitlist-cancel', e); setError('取り消せませんでした。もう一度お試しください。'); }
    finally { setWorking(null); }
  }
  async function again(w: WaitlistRow) {
    if (working) return;
    setWorking(w.id); setError(null);
    try { await api.registerWaitlist({ staff_id: w.staff_id, menu_id: w.menu_id, starts_at: w.starts_at }); refresh(); }
    catch (e) {
      logFailure('waitlist-again', e);
      const code = (e as { body?: { error?: string } }).body?.error;
      setError(code === 'waitlist_limit' ? 'キャンセル待ちは 3 件までです。ほかの待ちを取り消してから、もう一度お試しください。' : code === 'waitlist_closed' ? '開始の 1 時間前を過ぎたため、キャンセル待ちは締め切りました。' : 'もう一度キャンセル待ちをできませんでした。お試しください。');
    } finally { setWorking(null); }
  }

  const waitingCount = shown.filter((w) => w.status !== 'finished').length;
  return (
    <>
    <section aria-labelledby="liff-waitlist-title" className="space-y-3">
      <h2 id="liff-waitlist-title" className="text-base font-bold text-ink">{`キャンセル待ち中（${waitingCount}）`}</h2>
      {error ? <p role="alert" className="text-[13px] leading-5 text-danger">{error}</p> : null}
      <ul className="space-y-3">
        {shown.map((w) => {
          const invited = w.status === 'invited' && !!w.hold_expires_at && Date.parse(w.hold_expires_at) > now;
          const timedOut = w.status === 'finished' || (w.status === 'invited' && !invited);
          const minutes = invited ? Math.max(1, Math.ceil((Date.parse(w.hold_expires_at!) - now) / 60_000)) : 0;
          const when = `${utcToJstMd(w.starts_at)}（${formatWeekday(jstDay(w.starts_at))}）${utcToJstHm(w.starts_at)}`;
          return (
            <li key={w.id} data-waitlist-state={invited ? 'invited' : timedOut ? 'expired' : 'waiting'}
              className={`flex flex-col gap-3 rounded-(--liff-radius-lg) p-3.5 outline-1 -outline-offset-1 ${invited ? 'bg-liff-wait-bg outline-liff-wait-ink/30' : 'bg-canvas outline-liff-line'}`}>
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="min-w-0 truncate text-sm font-bold text-ink">{`${when} ${w.menu_name ?? ''}`.trim()}</h3>
                {timedOut ? <span className="shrink-0 text-xs font-semibold text-liff-sub">時間切れ</span>
                  : w.position ? <span className={`shrink-0 text-xs font-bold ${invited ? 'text-liff-wait-ink' : 'text-liff-sub'}`}>{`${w.position} 番目`}</span> : null}
              </div>
              <p className="text-[13px] leading-5 text-ink">
                {invited ? `空きが出ました。あと ${minutes} 分 お取りしています`
                  : timedOut ? `${w.hold_minutes} 分のうちにご予約がなかったため、次の方へお回ししました。`
                  : '空いたら LINE でお知らせします'}
              </p>
              {invited ? <Button variant="primary" disabled={working === w.id} onClick={() => setOfferId(w.id)}>予約する</Button> : null}
              {timedOut
                ? <Button variant="secondary" disabled={working === w.id} onClick={() => void again(w)}>もう一度キャンセル待ちをする</Button>
                : <Button variant="secondary" disabled={working === w.id} onClick={() => void cancel(w.id)}>キャンセル待ちを取り消す</Button>}
            </li>
          );
        })}
      </ul>
      {offerId ? <WaitlistOfferSheet id={offerId} onClose={() => { setOfferId(null); refresh(); }} /> : null}
    </section>
    {upcomingHeading ? <h2 className="pt-1 text-base font-bold text-ink">これからの予約</h2> : null}
    </>
  );
}
