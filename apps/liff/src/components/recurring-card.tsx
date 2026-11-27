import { jstDate as japanDate } from '@line-crm/shared';
import { useEffect, useState } from 'react';
import { api, type MenuItem, type StaffItem } from '../lib/api.js';
import { logFailure } from '../lib/user-message.js';
import { formatWeekday, utcToJstHm, utcToJstMd } from '../lib/datetime.js';
import Button from './ui/button/index.js';
import Card from './ui/card.js';
import Icon from './ui/icon.js';

export type RecurrenceChoice = { index: number; action: 'keep' | 'skip' | 'alternative'; alternative_starts_at?: string };
export type RecurrenceValue = { count: number; choices: RecurrenceChoice[]; made: number } | 'checking' | null;

type Occurrence = { index: number; starts_at: string; available: boolean; reason?: string; alternatives: string[] };
const jstDay = (iso: string) => japanDate(new Date(iso));
const label = (iso: string) => `${utcToJstMd(iso)}（${formatWeekday(jstDay(iso))}）${utcToJstHm(iso)}`;

/**
 * 確認の「続けて予約」（B4・qOUmy）。メニューが許したときだけ出る（初めはオフ）。
 * 取れない回は予約の前に一覧で見せ、行ごとに［飛ばす］（初め）か［近い時間にする］（候補 3 つから）を選ぶ。
 * 取れない回を黙って作らない。取れた回だけで予約する。回数の上限はメニューの max_count（お客さまは 12 まで）。
 */
export default function RecurringCard({ menu, staff, startsAt, onChange }: {
  menu: MenuItem;
  staff: StaffItem;
  startsAt: string;
  onChange: (value: RecurrenceValue) => void;
}) {
  const max = Math.min(menu.recurring?.max_count ?? 12, 12);
  const [on, setOn] = useState(false);
  const [count, setCount] = useState(Math.min(4, max));
  const [list, setList] = useState<Occurrence[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picks, setPicks] = useState<Record<number, 'skip' | { alt: string }>>({});
  const [choosing, setChoosing] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!on) { setList(null); onChange(null); return; }
    let alive = true;
    setList(null); setFailed(false); onChange('checking');
    api.seriesPreview({ menu_id: menu.id, staff_id: staff.id, starts_at: startsAt, freq: 'weekly', count })
      .then((r) => {
        if (!r || !Array.isArray(r.occurrences) || !r.occurrences.every(o => o &&
          Number.isInteger(o.index) && typeof o.available === 'boolean' &&
          typeof o.starts_at === 'string' && Number.isFinite(Date.parse(o.starts_at)) &&
          Array.isArray(o.alternatives) && o.alternatives.every(a => typeof a === 'string' && Number.isFinite(Date.parse(a))))) {
          throw new Error('Invalid recurring preview response');
        }
        if (alive) { setList(r.occurrences); setPicks({}); }
      })
      .catch((e) => { logFailure('series-preview', e); if (alive) setFailed(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, count, menu.id, staff.id, startsAt, retry]);

  /* 取れた回＋「近い時間」を選んだ回。飛ばす回は数えない。 */
  const made = (list ?? []).filter((o) => o.available || typeof picks[o.index] === 'object').length;
  useEffect(() => {
    if (!on || !list) { if (!on) onChange(null); return; }
    onChange({
      count, made,
      choices: list.map((o) => {
        const pick = picks[o.index];
        if (o.available) return { index: o.index, action: 'keep' as const };
        return typeof pick === 'object' ? { index: o.index, action: 'alternative' as const, alternative_starts_at: pick.alt } : { index: o.index, action: 'skip' as const };
      }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, list, picks, count]);

  const skipped = (list ?? []).filter((o) => !o.available && typeof picks[o.index] !== 'object').length;
  return (
    <section className="space-y-2.5" aria-label="続けて予約">
      <h3 className="text-base font-bold text-ink">続けて予約</h3>
      <Card className="space-y-3 p-3.5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-bold text-ink">毎週この時間で続ける</p>
          <Button variant="switch" selected={on} role="switch" aria-checked={on} aria-label="毎週この時間で続ける" onClick={() => { onChange(on ? null : 'checking'); setOn((v) => !v); }}>
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-canvas shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
          </Button>
        </div>
        {on ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-liff-sub">回数</span>
              <span className="flex items-center gap-4 rounded-(--liff-radius) px-1 outline-1 -outline-offset-1 outline-liff-line-strong">
                <Button variant="icon" aria-label="回数を減らす" disabled={count <= 2} onClick={() => { onChange('checking'); setList(null); setCount((n) => Math.max(2, n - 1)); }}>−</Button>
                <span className="liff-num min-w-10 text-center text-sm font-bold text-ink" aria-live="polite">{`${count} 回`}</span>
                <Button variant="icon" aria-label="回数を増やす" disabled={count >= max} onClick={() => { onChange('checking'); setList(null); setCount((n) => Math.min(max, n + 1)); }}>＋</Button>
              </span>
            </div>
            {failed ? <p role="alert" className="text-[13px] text-danger">空きを確かめられませんでした。<Button variant="link" onClick={() => setRetry((n) => n + 1)}>もう一度</Button></p> : null}
            {!list && !failed ? <p className="text-[13px] text-liff-sub" aria-busy="true">空きを確かめています…</p> : null}
            {list ? (
              <ul className="divide-y divide-liff-divider rounded-(--liff-radius) outline-1 -outline-offset-1 outline-liff-line">
                {list.map((o) => {
                  const pick = picks[o.index];
                  return (
                    <li key={o.index} data-occurrence={o.available ? 'ok' : 'blocked'} className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 text-[13px] ${o.available ? '' : 'bg-liff-wait-bg'}`}>
                      <span className="w-12 shrink-0 text-liff-sub">{`${o.index + 1} 回目`}</span>
                      {o.available ? <><span className="liff-num min-w-0 flex-1 text-ink">{label(o.starts_at)}</span><Icon name="check" className="h-4 w-4 shrink-0 text-liff-primary" /></> : (
                        <>
                          <span className="liff-num min-w-0 flex-1 font-bold text-liff-wait-ink">{typeof pick === 'object' ? label(pick.alt) : `${utcToJstMd(o.starts_at)}${o.reason ? ` ${o.reason}` : ''}`}</span>
                          <span className="flex shrink-0 rounded-(--liff-radius) bg-liff-chip p-0.5" role="group" aria-label={`${o.index + 1} 回目`}>
                            <Button variant="tab" className="whitespace-nowrap" selected={pick === undefined || pick === 'skip'} aria-pressed={pick === undefined || pick === 'skip'} onClick={() => { setPicks((p) => ({ ...p, [o.index]: 'skip' })); setChoosing(null); }}>飛ばす</Button>
                            <Button variant="tab" className="whitespace-nowrap" selected={typeof pick === 'object'} aria-pressed={typeof pick === 'object'} disabled={o.alternatives.length === 0} onClick={() => setChoosing(choosing === o.index ? null : o.index)}>近い時間にする</Button>
                          </span>
                          {choosing === o.index ? (
                            <span className="flex w-full flex-wrap gap-2 pt-1" role="group" aria-label="近い時間">
                              {o.alternatives.slice(0, 3).map((alt) => (
                                <Button key={alt} variant="time" selected={typeof pick === 'object' && pick.alt === alt} onClick={() => { setPicks((p) => ({ ...p, [o.index]: { alt } })); setChoosing(null); }}>{label(alt)}</Button>
                              ))}
                            </span>
                          ) : null}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {list ? <p className="text-xs leading-[18px] text-liff-sub">{skipped > 0 ? `取れない回は飛ばして ${made} 回で予約します。` : `${made} 回すべて予約します。`}1 回ずつ取り消せます。</p> : null}
          </>
        ) : null}
      </Card>
    </section>
  );
}
