import { useEffect, useRef, useState } from 'react';
import { api, type MenuItem, type StaffItem } from '../lib/api.js';
import { resolveLook, type LiffCalendarMode } from '../lib/liff-look.js';
import { jstToday, addDays, formatJpLong, formatWeekday, addMinutesHm } from '../lib/datetime.js';
import { logFailure } from '../lib/user-message.js';
import { useWideViewport } from '../lib/use-wide-viewport.js';
import LoadErrorView from './load-error-view.js';
import LoadingView from './loading-view.js';
import WaitlistSheet from './waitlist-sheet.js';
import Icon from './ui/icon.js';
import BottomBar from './ui/bottom-bar.js';
import Button from './ui/button/index.js';
import SegmentedControl from './ui/segmented-control.js';

/**
 * 選んだ枠。date・start は店の暦日・壁時刻（表示用）。startUtc・timeZone は
 * 空き枠が返した開始の瞬間と店のタイムゾーンで、予約・待ちの登録はこれを送る。
 */
export type SlotPick = { date: string; start: string; startUtc?: string; timeZone?: string };

import { storedView, rememberView, type DateView } from './date-view-storage.js';
export type { DateView } from './date-view-storage.js';

/** 週の並びは5日ぶんずつ。送ると次の5日へ。 */
const WEEK_DAYS = 5;
/** 空き枠の口は28日までしか受けないので、月ぶんは割って呼ぶ。 */
const CHUNK_DAYS = 28;
const WEEKDAY_JP = '日月火水木金土';
const dateViewChoices = [
  { value: 'list', label: '週で見る' },
  { value: 'calendar', label: 'カレンダー' },
] as const;

function monthOf(date: string): string {
  return date.slice(0, 7);
}

type AvailSlot = {
  date: string;
  start: string;
  remaining?: number;
  state?: string;
  startUtc?: string;
  timeZone?: string;
};
/** 時刻の枠。open=false は埋まった枠 (灰色で出す・押せない)。 */
export type TimeSlot = { start: string; open: boolean; startUtc?: string; timeZone?: string };

/**
 * 空き読み出しのまとめ役（週・カレンダー共通）。
 * 月をまたいで28日ずつに割って読むと、同じ日の同じ枠が二重に入ることが
 * ある（口が期間を広めに返す・同じ枠を二口が返す）。同じ枠（担当＋開始
 * 時刻）は1つにまとめる。埋まった枠（残り0）も時刻の札には出すが
 * 押せない灰色にし、「満」の判定にも使う。
 * 残りわずか (state 'limited') の枠は押せるままにし、日単位では金の印に
 * する。日の中にふつうの空きとわずかが混ざったら、空き (緑) を優先する。
 */
function groupSlots(
  buckets: Array<{ staff_id: string; slots: AvailSlot[] }>,
): {
  byDate: Record<string, TimeSlot[]>;
  fullDates: Record<string, true>;
  /** ふつうの空きが無く、残りわずかだけの日。 */
  limitedDates: Record<string, true>;
  /** ふつうの空きがある日。 */
  openDates: Record<string, true>;
} {
  const seen = new Map<string, TimeSlot>();
  const hasSlot: Record<string, true> = {};
  const strictOpen = new Set<string>();
  const limitedOnly = new Set<string>();
  for (const bucket of buckets) {
    for (const s of bucket.slots ?? []) {
      hasSlot[s.date] = true;
      const limited = s.state === 'limited';
      const open = !((s.remaining ?? 1) <= 0 || s.state === 'full' || s.state === 'closed');
      const key = `${bucket.staff_id}\0${s.date}\0${s.start}`;
      const prev = seen.get(`${s.date}\0${s.start}`);
      if (prev) {
        prev.open ||= open;
        prev.startUtc ??= s.startUtc;
        prev.timeZone ??= s.timeZone;
      } else {
        seen.set(`${s.date}\0${s.start}`, {
          start: s.start,
          open,
          ...(s.startUtc ? { startUtc: s.startUtc } : {}),
          ...(s.timeZone ? { timeZone: s.timeZone } : {}),
        });
      }
      if (open && !limited) strictOpen.add(s.date);
      if (limited) limitedOnly.add(s.date);
    }
  }
  const byDate: Record<string, TimeSlot[]> = {};
  for (const [key, t] of seen) {
    const d = key.split('\0')[0];
    (byDate[d] ??= []).push(t);
  }
  for (const d of Object.keys(byDate)) {
    byDate[d].sort((a, b) => (a.start < b.start ? -1 : 1));
  }
  const fullDates: Record<string, true> = {};
  for (const d of Object.keys(hasSlot)) {
    if (!(byDate[d]?.some((t) => t.open))) fullDates[d] = true;
  }
  const limitedDates: Record<string, true> = {};
  for (const d of limitedOnly) {
    if (!strictOpen.has(d)) limitedDates[d] = true;
  }
  const openDates: Record<string, true> = {};
  for (const d of strictOpen) openDates[d] = true;
  return { byDate, fullDates, limitedDates, openDates };
}

function addMonths(month: string, count: number): string {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const d = new Date(Date.UTC(year, mon - 1 + count, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthStart(month: string): string {
  return `${month}-01`;
}

function monthEnd(month: string): string {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}

/** 見ている月のうち、空きのある日を早い順に並べる（今日〜受付期限の内側だけ）。 */
function openDaysOfMonth(
  target: string,
  byDate: Record<string, TimeSlot[]>,
  today: string,
  windowEnd: string,
): string[] {
  const from = monthStart(target) < today ? today : monthStart(target);
  const to = monthEnd(target) > windowEnd ? windowEnd : monthEnd(target);
  return Object.keys(byDate)
    .filter((d) => d >= from && d <= to && (byDate[d]?.some((t) => t.open)))
    .sort();
}

/** [from, to] を CHUNK_DAYS 日ずつに割る（口の上限に収める）。 */
function splitRange(from: string, to: string): Array<[string, string]> {
  const chunks: Array<[string, string]> = [];
  let head = from;
  while (head <= to) {
    const tail = addDays(head, CHUNK_DAYS - 1) <= to ? addDays(head, CHUNK_DAYS - 1) : to;
    chunks.push([head, tail]);
    head = addDays(tail, 1);
  }
  return chunks;
}

type DayState = 'open' | 'few' | 'full' | 'closed' | 'past' | 'off' | 'empty';

/**
 * 読み上げ文。「10月4日 満席」のように日付と状態だけにする。
 * 色・印だけでは伝わらない人に、状態を言葉で渡す。
 * 過ぎた日は「過ぎた日」と読む（期間の外の未来日は「受付期間外」）。
 * 枠が1つも無い日は「空きなし」と読む（「満席」は枠があって全部埋まった日だけ）。
 */
export function dayStateLabel(date: string, state: DayState): string {
  const d = new Date(`${date}T00:00:00Z`);
  const base = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  if (state === 'open') return `${base} 空きあり`;
  if (state === 'few') return `${base} 残りわずか`;
  if (state === 'full') return `${base} 満席`;
  if (state === 'closed') return `${base} お休み`;
  if (state === 'past') return `${base} 過ぎた日`;
  if (state === 'empty') return `${base} 空きなし`;
  return `${base} 受付期間外`;
}

function stateOf(date: string, open: Record<string, true>, limited: Record<string, true>, full: Record<string, true>, closed: Record<string, true>, today: string, windowEnd: string): DayState {
  if (date < today) return 'past';
  if (date > windowEnd) return 'off';
  if (closed[date]) return 'closed';
  if (open[date]) return 'open';
  if (limited[date]) return 'few';
  if (full[date]) return 'full';
  return 'empty';
}

/** 週の日セルの短い印。空き・わずか・満・休み。枠の無い日は「満」に寄せる。 */
function weekMark(state: DayState): string {
  if (state === 'open') return '空き';
  if (state === 'few') return 'わずか';
  if (state === 'closed') return '休み';
  return '満';
}

/** 時刻の札から選んだ枠を作る。開始の瞬間と店のタイムゾーンを持って運ぶ。 */
function pickOf(day: string, t: TimeSlot): SlotPick {
  return {
    date: day,
    start: t.start,
    ...(t.startUtc ? { startUtc: t.startUtc } : {}),
    ...(t.timeZone ? { timeZone: t.timeZone } : {}),
  };
}

/**
 * 選んだ日の時刻3列 (★V8・)。埋まった時刻は灰色で押せない。
 * 埋まった時刻には鈴の印を付ける (booking-plus 2)。鈴を押すと
 * 「空いたら知らせる」の小さなシートが開く（時刻の札名は「10:00」のまま）。
 */
function DaySlots({
  day,
  times,
  selected,
  onSelect,
  onWaitlist,
}: {
  day: string;
  times: TimeSlot[];
  selected: SlotPick | null;
  onSelect: (s: SlotPick) => void;
  /** 満席の時刻の鈴を押したとき。枠（日・時刻）を渡す。 */
  onWaitlist?: (s: SlotPick) => void;
}) {
  return (
    <section aria-label={`${formatJpLong(day)}の空き`}>
      <h3 className="mb-3.5 text-sm font-bold text-ink">{formatJpLong(day)}の空き</h3>
      {times.length === 0 ? (
        <p className="text-[13px] leading-6 text-liff-sub">この日は満席です。別の日を選んでください。</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {times.map((t) => {
            const active = selected?.date === day && selected?.start === t.start;
            const timeButton = (
              <Button variant="time" selected={active} unavailable={!t.open}
                key={t.start}
                type="button"
                onClick={() => onSelect(pickOf(day, t))}
                disabled={!t.open}
                aria-pressed={active}
              >
                {t.start}
              </Button>
            );
            if (t.open || !onWaitlist) return timeButton;
            return (
              <span key={t.start} className="relative block">
                {timeButton}
                <Button variant="notify" className="absolute -top-1.5 -right-1.5"
                  type="button"
                  onClick={() => onWaitlist(pickOf(day, t))}
                  aria-label={`${t.start}に空いたら知らせる`}
                >
                  <Icon name="bell" className="h-[14px] w-[14px]" />
                </Button>
              </span>
            );
          })}
        </div>
      )}
      {times.length > 0 && onWaitlist && times.some((t) => !t.open) ? (
        <p className="mt-2 flex items-center gap-1 text-xs leading-[18px] text-liff-sub">
          <Icon name="bell" className="h-[14px] w-[14px] shrink-0" />
          満席の時間の鈴は「空いたら知らせる」の登録です
        </p>
      ) : null}
    </section>
  );
}

/**
 * 1-c 日時を選ぶ (★V8)。出し方は店が4択（週を先に・月を先に・週だけ・
 * 月だけ）。週だけ・月だけの店では切り替えを出さない。
 * 週は5日の並び（空き・わずか・満・休み）＋選んだ日の時刻3列。
 * カレンダーは月の表（●空きあり・金は残りわずか・灰色は満席か休み）。
 * 空きの点は店が消せる（消しても読み上げは残す）。日を選んで
 * 「この日の時間を選ぶ」で週の表示へ移る。
 * 時刻の札を押すと選ばれるだけで、進むのは下の操作の帯。
 * 空きの無い週は「次の週を見る」「担当を選び直す」の手を出す 。
 * (撮影: 時刻のボタン名は「10:00」のまま。qa-shots.mjs が名前で押す)
 */
export default function DateTimePicker({
  menu,
  staff,
  hint,
  addonIds = [],
  additionalDurationMinutes = 0,
  selected,
  onSelect,
  onConfirm,
  confirmLabel = '内容を確かめる',
  onBackToStaff,
  onLoadState,
  onEmptyState,
}: {
  menu: MenuItem;
  staff: StaffItem;
  hint?: string;
  addonIds?: readonly string[];
  additionalDurationMinutes?: number;
  selected: SlotPick | null;
  onSelect: (s: SlotPick | null) => void;
  /** 下の帯の主ボタン (週: 内容を確かめる / peek: この時間で予約に進む)。 */
  onConfirm: () => void;
  confirmLabel?: string;
  /** 「担当を選び直す」。空きの無い週と下の帯の戻るで使う。 */
  onBackToStaff: () => void;
  /** 読み込み中・失敗・空きが無い間は、下の帯を出さないための合図。 */
  onLoadState?: (ready: boolean) => void;
  onEmptyState?: (empty: boolean) => void;
}) {
  const today = jstToday();
  const addonKey = JSON.stringify(addonIds);
  // 414 幅の板（）は板 ID だけを替える。中身は同じ。
  const wide = useWideViewport();
  // 予約の設定（最初の形・受付期間・カレンダーの出し方・空きの点）。
  // 読めるまで切り替えは出さない。
  const [settings, setSettings] = useState<{
    initialView: DateView;
    windowDays: number;
    calendarMode: LiffCalendarMode;
    vacancyDots: boolean;
  } | null>(null);
  const [view, setView] = useState<DateView | null>(null);
  /** 空いたら知らせるシートを開いている満席の枠。 */
  const [waitSlot, setWaitSlot] = useState<SlotPick | null>(null);

  // 週表示用。5日ぶんずつ読んで足していく。選んだ日を持って戻ってきた
  // ときは、その日が見える位置から始める。
  const [winStart, setWinStart] = useState(() =>
    selected?.date && selected.date > today ? selected.date : today,
  );
  const [weekByDate, setWeekByDate] = useState<Record<string, TimeSlot[]> | null>(null);
  const [weekFull, setWeekFull] = useState<Record<string, true>>({});
  const [weekLimited, setWeekLimited] = useState<Record<string, true>>({});
  const [weekOpen, setWeekOpen] = useState<Record<string, true>>({});
  const [weekClosed, setWeekClosed] = useState<Record<string, true>>({});
  const [loadedWins, setLoadedWins] = useState<Set<string>>(new Set());
  const [weekLoading, setWeekLoading] = useState(false);
  const [weekFailed, setWeekFailed] = useState(false);
  const [weekReloadKey, setWeekReloadKey] = useState(0);
  const [listDay, setListDay] = useState<string | null>(selected?.date ?? null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // カレンダー用。月を送っても読んだぶんは足していく。
  const [calByDate, setCalByDate] = useState<Record<string, TimeSlot[]>>({});
  const [calClosed, setCalClosed] = useState<Record<string, true>>({});
  const [calFull, setCalFull] = useState<Record<string, true>>({});
  const [calLimited, setCalLimited] = useState<Record<string, true>>({});
  const [calOpen, setCalOpen] = useState<Record<string, true>>({});
  const [loadedMonths, setLoadedMonths] = useState<string[]>([]);
  const loadingMonthsRef = useRef<Set<string>>(new Set());
  const [month, setMonth] = useState(monthOf(selected?.date ?? today));
  const [calDay, setCalDay] = useState<string | null>(selected?.date ?? null);
  const [calFailed, setCalFailed] = useState(false);
  const [calReloadKey, setCalReloadKey] = useState(0);
  // 最初に開く月の探索が済んだか。済むまでは空きの無い月を飛ばす。
  const [calAutoDone, setCalAutoDone] = useState(false);
  // 利用者が一度でも日を選んだら、遅れて届く応答の自動選択で上書きしない
  // (週・カレンダー共通。担当が変わると呼び側の key で作り直されるので、
  // 画面の中では消さない。読み直しだけ最初から探し直す)。
  const userPickedDayRef = useRef(!!selected);

  const windowEnd = settings ? addDays(today, settings.windowDays) : addDays(today, 60);

  // 出し方で選べる見せ方。週だけ・月だけのときは1つに決まる。
  function allowedViews(mode: LiffCalendarMode): DateView[] {
    if (mode === 'week-only') return ['list'];
    if (mode === 'month-only') return ['calendar'];
    return ['list', 'calendar'];
  }

  // 最初の形は「端末の覚え → 店の出し方 → 週を先に」の順。
  // 週だけ・月だけの店では、端末の覚えが反対側でも店の出し方に従う。
  // 設定が読めなくても止めない。
  useEffect(() => {
    api
      .bookingSettings()
      .then((r) => {
        const look = resolveLook(r);
        const allowed = allowedViews(look.calendarMode);
        const stored = storedView();
        const initialView =
          stored && allowed.includes(stored)
            ? stored
            : look.calendarMode === 'month-first' || look.calendarMode === 'month-only'
              ? 'calendar'
              : 'list';
        const windowDays =
          Number.isInteger(r.booking_window_days) &&
          r.booking_window_days >= 1 &&
          r.booking_window_days <= 365
            ? r.booking_window_days
            : 60;
        setSettings({
          initialView,
          windowDays,
          calendarMode: look.calendarMode,
          vacancyDots: look.vacancyDots,
        });
        setView(initialView);
      })
      .catch((e) => {
        logFailure('booking-settings', e);
        const fallback = storedView() ?? 'list';
        setSettings({
          initialView: fallback,
          windowDays: 60,
          calendarMode: 'week-first',
          vacancyDots: true,
        });
        setView(fallback);
      });
  }, []);

  // 週表示: 見ている5日ぶんが未読なら読む。読んだぶんは窓を越えて残す。
  useEffect(() => {
    if (view !== 'list' || !settings) return;
    if (loadedWins.has(winStart)) return;
    let cancelled = false;
    const from = winStart;
    const to = addDays(winStart, WEEK_DAYS - 1) <= windowEnd ? addDays(winStart, WEEK_DAYS - 1) : windowEnd;
    setWeekLoading(true);
    setWeekFailed(false);
    api
      .availability(menu.id, staff.id, from, to, JSON.parse(addonKey) as string[])
      .then((r) => {
        if (cancelled) return;
        const { byDate, fullDates, limitedDates, openDates } = groupSlots(
          r.by_staff[0] ? [r.by_staff[0]] : [],
        );
        const closed: Record<string, true> = {};
        for (const d of r.closed_dates ?? []) closed[d] = true;
        setWeekByDate((prev) => ({ ...(prev ?? {}), ...byDate }));
        setWeekFull((prev) => ({ ...prev, ...fullDates }));
        setWeekLimited((prev) => ({ ...prev, ...limitedDates }));
        setWeekOpen((prev) => ({ ...prev, ...openDates }));
        setWeekClosed((prev) => ({ ...prev, ...closed }));
        setLoadedWins((prev) => new Set(prev).add(winStart));
        setWeekLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        logFailure('availability', e);
        setWeekFailed(true);
        setWeekLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, settings, winStart, menu.id, staff.id, addonKey, today, windowEnd, loadedWins, weekReloadKey]);

  // 見ている週が読めたら、空きのある一番早い日を選ぶ。
  // 利用者がまだ日を選んでいない間だけ選び直す。
  useEffect(() => {
    if (view !== 'list' || !settings || !weekByDate) return;
    if (!loadedWins.has(winStart)) return;
    if (userPickedDayRef.current) return;
    setListDay((prev) => {
      if (prev && weekByDate[prev]?.some((t) => t.open)) return prev;
      for (let i = 0; i < WEEK_DAYS; i++) {
        const d = addDays(winStart, i);
        if (d > windowEnd) break;
        if (weekByDate[d]?.some((t) => t.open)) return d;
      }
      return prev ?? null;
    });
  }, [view, settings, weekByDate, loadedWins, winStart, today, windowEnd]);

  // 見ている月のぶんを、28日ずつに割って読む。
  useEffect(() => {
    if (view !== 'calendar' || !settings) return;
    if (loadedMonths.includes(month) || loadingMonthsRef.current.has(`${calReloadKey}:${month}`)) {
      return;
    }
    const loadingKey = `${calReloadKey}:${month}`;
    loadingMonthsRef.current.add(loadingKey);
    const from = monthStart(month) < today ? today : monthStart(month);
    const to = monthEnd(month) > windowEnd ? windowEnd : monthEnd(month);
    if (from > to) {
      setLoadedMonths((prev) => (prev.includes(month) ? prev : [...prev, month]));
      return;
    }
    let cancelled = false;
    let settled = false;
    void Promise.all(
      splitRange(from, to).map(([head, tail]) => api.availability(menu.id, staff.id, head, tail, JSON.parse(addonKey) as string[])),
    )
      .then((results) => {
        settled = true;
        if (cancelled) return;
        const buckets = results.flatMap((r) => (r.by_staff[0] ? [r.by_staff[0]] : []));
        const { byDate: grouped, fullDates, limitedDates, openDates } = groupSlots(buckets);
        const closed: Record<string, true> = {};
        for (const r of results) {
          for (const d of r.closed_dates ?? []) closed[d] = true;
        }
        setCalByDate((prev) => ({ ...prev, ...grouped }));
        setCalClosed((prev) => ({ ...prev, ...closed }));
        setCalFull((prev) => ({ ...prev, ...fullDates }));
        setCalLimited((prev) => ({ ...prev, ...limitedDates }));
        setCalOpen((prev) => ({ ...prev, ...openDates }));
        setLoadedMonths((prev) => (prev.includes(month) ? prev : [...prev, month]));
      })
      .catch((e) => {
        settled = true;
        if (cancelled) return;
        logFailure('availability', e);
        setCalFailed(true);
      });
    return () => {
      cancelled = true;
      // 読み終わる前に月・見せ方を替えたら「読み中」の印を外す。
      // 外さないと、その月へ戻っても読み始めず読み込み中のまま残る。
      if (!settled) loadingMonthsRef.current.delete(loadingKey);
    };
  }, [view, settings, month, menu.id, staff.id, addonKey, today, windowEnd, loadedMonths, calReloadKey]);

  // 見ている月が読めたら、その月で空きのある一番早い日を選ぶ。
  // 利用者がまだ日を選んでいない間だけ選び直す。選んだ後の月送り・
  // 遅れて届く応答では、選んだ日を残す（上書きしない）。
  useEffect(() => {
    if (view !== 'calendar' || !settings) return;
    if (!loadedMonths.includes(month)) return;
    if (userPickedDayRef.current) return;
    const open = openDaysOfMonth(month, calByDate, today, windowEnd);
    setCalDay(open[0] ?? null);
  }, [view, settings, month, loadedMonths, calByDate, today, windowEnd]);

  // 最初に開く月は、空きのある一番早い日がある月にする。
  // 今月に空きが無ければ次の月へ送る（利用者が月を送った後は動かない）。
  useEffect(() => {
    if (view !== 'calendar' || !settings || calAutoDone) return;
    if (!loadedMonths.includes(month)) return;
    const open = openDaysOfMonth(month, calByDate, today, windowEnd);
    if (open.length > 0 || month >= monthOf(windowEnd)) {
      setCalAutoDone(true);
      return;
    }
    setMonth(addMonths(month, 1));
  }, [view, settings, calAutoDone, month, loadedMonths, calByDate, today, windowEnd]);

  // 週・月の「空きあり」判定 (下の帯を出して良いかの合図に使う)。
  const weekDays: string[] = [];
  for (let i = 0; i < WEEK_DAYS; i++) {
    const d = addDays(winStart, i);
    if (d > windowEnd) break;
    weekDays.push(d);
  }
  const weekHasOpen = weekDays.some((d) => weekByDate?.[d]?.some((t) => t.open));
  // 満席の日がある週は日の並びを出す（満席の日を押すと時刻の鈴＝空いたら知らせるへ進める）。
  const weekHasFull = weekDays.some((d) => weekFull[d]);
  const weekShowsStrip = weekHasOpen || weekHasFull;
  const emptyWeek = view === 'list' && !weekFailed && !weekLoading && weekByDate !== null && loadedWins.has(winStart) && !weekShowsStrip;
  useEffect(() => { onEmptyState?.(emptyWeek); }, [emptyWeek, onEmptyState]);
  const calHasSlots = Object.values(calByDate).some((times) => times.some((t) => t.open));
  const monthLoaded = loadedMonths.includes(month);
  useEffect(() => {
    if (view === 'list')
      onLoadState?.(weekByDate !== null && !weekFailed && !weekLoading && weekHasOpen);
    else if (view === 'calendar')
      onLoadState?.(settings !== null && monthLoaded && !calFailed && calHasSlots);
    else onLoadState?.(false);
  }, [view, settings, weekByDate, weekFailed, weekLoading, weekHasOpen, monthLoaded, calFailed, calHasSlots, onLoadState]);

  // 選んでいる日が枠の外にいるときは、横だけ中央に流す (縦には動かさない)。
  useEffect(() => {
    stripRef.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [listDay, weekByDate]);

  function switchView(next: DateView) {
    // 週だけ・月だけの店では反対側へ移れない。
    if (settings && !allowedViews(settings.calendarMode).includes(next)) return;
    // 選んだ日は持って反対側へ移る（切り替えで選択が消えて見えないように）。
    if (next === 'list' && view === 'calendar' && calDay) {
      jumpToWeekDay(calDay);
      return;
    }
    if (next === 'calendar' && view === 'list' && listDay) {
      setMonth(monthOf(listDay));
      setCalDay(listDay);
    }
    setView(next);
    rememberView(next);
  }

  /** カレンダーで選んだ日へ週表示を移す (この日の時間を選ぶ)。 */
  function jumpToWeekDay(day: string) {
    userPickedDayRef.current = true;
    setWinStart(day < today ? today : day);
    setListDay(day);
    // switchView('list') だと calDay 経由でこの関数へ戻るので、直接切り替える。
    setView('list');
    if (settings?.calendarMode !== 'month-only') rememberView('list');
  }

  /** 週を送る。見ている日も次へ進める（前の週で選んだ日を持ち越さない）。
   *  持ち越すと、日の並びに無い日の時刻だけが残って見える。 */
  function moveWeek(dir: 1 | -1) {
    userPickedDayRef.current = false;
    setListDay(null);
    setWinStart((w) => addDays(w, dir * WEEK_DAYS));
  }

  function retryWeek() {
    setWeekFailed(false);
    setWeekByDate(null);
    setWeekFull({});
    setWeekLimited({});
    setWeekOpen({});
    setWeekClosed({});
    setLoadedWins(new Set());
    if (!userPickedDayRef.current) setListDay(null);
    setWeekReloadKey((k) => k + 1);
  }

  if (!settings || view === null) return <LoadingView />;

  const currentMonth = monthOf(today);
  const lastMonth = monthOf(windowEnd);
  const canPrevMonth = month > currentMonth;
  const canNextMonth = month < lastMonth;
  const canPrevWeek = winStart > today;
  const canNextWeek = addDays(winStart, WEEK_DAYS) <= windowEnd;

  // カレンダーの升目。月初の曜日ぶんを空けて、日〜土で7列にする。
  const firstWeekday = new Date(`${monthStart(month)}T00:00:00Z`).getUTCDay();
  const monthDays: string[] = [];
  for (let d = monthStart(month); d <= monthEnd(month); d = addDays(d, 1)) monthDays.push(d);

  const monthFrom = monthStart(month) < today ? today : monthStart(month);
  const monthTo = monthEnd(month) > windowEnd ? windowEnd : monthEnd(month);
  const monthLabel = `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
  const monthHasOpen = monthDays.some((d) => calByDate[d]?.some((t) => t.open));
  const monthHasFew = monthDays.some((d) => calLimited[d]);
  const listTimes = listDay ? (weekByDate?.[listDay] ?? []) : [];

  const slotEnd =
    selected && addMinutesHm(selected.start, staff.duration_minutes + additionalDurationMinutes);

  /** 下の帯。「担当を選び直す」の戻るを添える。 */
  const bar = (
    <BottomBar>
      {view === 'list' ? (
        <>
          {selected && slotEnd && (
            <p className="text-center text-[13px] font-bold text-liff-primary">
              {formatJpLong(selected.date)} {selected.start}〜{slotEnd}
            </p>
          )}
          <Button variant="primary" disabled={!selected} onClick={onConfirm}>
            {selected ? confirmLabel : '時間を選ぶ'}
          </Button>
        </>
      ) : (
        <Button
          variant="primary"
          disabled={!calDay}
          onClick={() => calDay && jumpToWeekDay(calDay)}
        >
          この日の時間を選ぶ
        </Button>
      )}
      {view === 'list' && settings?.calendarMode === 'month-only' ? (
        <Button variant="text" type="button" onClick={() => switchView('calendar')}>日を選び直す</Button>
      ) : null}
    </BottomBar>
  );

  return (
    <div className="space-y-3.5" data-design-node={view === 'calendar' ? 'k3aJKU' : wide ? 'xvtSz' : 'M2p63S'}>
      {!emptyWeek && <div>
        <h2 className="text-xl font-bold text-ink">日時を選んでください</h2>
        <p className="mt-3.5 text-xs leading-[18px] text-liff-sub">
          {`${menu.name}・${staff.display_name}`}
        </p>
      </div>}
      {hint && <p className="text-xs leading-5 text-liff-sub">{hint}</p>}
      {/* 週だけ・月だけの店では切り替えを出さない (見せ方が1つに決まる)。 */}
      {allowedViews(settings.calendarMode).length > 1 && (
        <SegmentedControl role="radiogroup" label="表示の切り替え" choices={dateViewChoices} value={view} onChange={switchView} />
      )}

      {view === 'list' ? (
        weekFailed ? (
          <LoadErrorView onRetry={retryWeek} />
        ) : weekLoading || !weekByDate || !loadedWins.has(winStart) ? (
          <LoadingView />
        ) : !weekShowsStrip ? (
          // ★V8 ：印・題・本文・ボタンを 12 ずつ空け、画面の真ん中の高さに置く。
          <div className="flex min-h-[calc(100dvh-180px)] flex-col items-center justify-center gap-3 px-2 text-center" data-design-node="ADutg">
            <span className="text-liff-idle" aria-hidden="true">
              <Icon name="calendar-x" className="h-10 w-10" />
            </span>
            <p className="text-lg font-bold text-ink">この週は空きがありません</p>
            <p className="text-[13px] leading-[21px] text-liff-sub">{weekDays.length > 1 ? `${formatJpLong(winStart)}〜${formatJpLong(weekDays[weekDays.length - 1])}` : formatJpLong(winStart)}</p>
            <p className="text-[13px] leading-[21px] text-pretty text-liff-sub">
              {staff.is_designation_optional === 0 ? '次の週を見るか、担当を「指名なし」にすると見つかることがあります。' : '次の週を見るか、担当を選び直してください。'}
            </p>
            <div className="flex w-full max-w-55 flex-col gap-2">
              <Button variant="secondary" disabled={!canPrevWeek} onClick={() => moveWeek(-1)}>前の週を見る</Button>
              <Button
                variant="primary"
                disabled={!canNextWeek}
                onClick={() => moveWeek(1)}
              >
                次の週を見る
              </Button>
              <Button variant="secondary" onClick={onBackToStaff}>
                担当を選び直す
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-[5px]" role="group" aria-label="週をえらぶ">
              <Button variant="icon"
                type="button"
                onClick={() => moveWeek(-1)}
                disabled={!canPrevWeek}
                aria-label="前の週"
              >
                <Icon name="chevron-left" className="h-[18px] w-[18px]" />
              </Button>
              <div ref={stripRef} className="grid flex-1 grid-cols-5 gap-[5px]" role="group" aria-label="日付">
                {weekDays.map((d) => {
                  const state = stateOf(
                    d,
                    weekOpen,
                    weekLimited,
                    weekFull,
                    weekClosed,
                    today,
                    windowEnd,
                  );
                  const open = state === 'open';
                  // 残りわずかの日も押せる (金の印だけ付ける)。
                  const selectable = open || state === 'few';
                  // 満席の日も押せる。時刻は灰色で予約できず、鈴から「空いたら知らせる」だけ選べる。
                  const pressable = selectable || state === 'full';
                  const active = d === listDay;
                  return (
                    <Button variant="day" selected={active} unavailable={state === 'closed' || state === 'empty'}
                      key={d}
                      type="button"
                      onClick={() => {
                        userPickedDayRef.current = true;
                        setListDay(d);
                      }}
                      disabled={!pressable}
                      aria-pressed={active}
                      aria-label={dayStateLabel(d, state)}
                      title={dayStateLabel(d, state)}
                    >
                      <span className="text-[10px] text-liff-sub">{formatWeekday(d)}</span>
                      <span
                        className={`liff-num text-base font-bold ${active ? 'text-liff-primary' : selectable || state === 'full' ? 'text-ink' : 'text-liff-off-ink'}`}
                      >
                        {Number(d.slice(8, 10))}
                      </span>
                      {/* 空きの点。消す設定のときは印を出さない (読み上げは残す)。 */}
                      {settings.vacancyDots && (
                        <span
                          className={`text-[9px] ${
                            active || open
                              ? 'text-liff-primary'
                              : state === 'few'
                                ? 'text-liff-dot-few'
                                : state === 'full'
                                  ? 'text-liff-full'
                                  : 'text-liff-off-ink'
                          }`}
                        >
                          {weekMark(state)}
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
              <Button variant="icon"
                type="button"
                onClick={() => moveWeek(1)}
                disabled={!canNextWeek}
                aria-label="次の週"
              >
                <Icon name="chevron-right" className="h-[18px] w-[18px]" />
              </Button>
            </div>
            {listDay && (
              <>
                <DaySlots
                  day={listDay}
                  times={listTimes}
                  selected={selected}
                  onSelect={onSelect}
                  onWaitlist={setWaitSlot}
                />
                {waitSlot && (
                  <WaitlistSheet
                    menu={menu}
                    staff={staff}
                    date={waitSlot.date}
                    start={waitSlot.start}
                    startUtc={waitSlot.startUtc}
                    onClose={() => setWaitSlot(null)}
                  />
                )}
              </>
            )}
          </>
        )
      ) : calFailed ? (
        <LoadErrorView onRetry={() => {
          loadingMonthsRef.current.clear();
          // 読み直しは最初から探し直す（選んだ日も消えるので自動選択を戻す）。
          userPickedDayRef.current = false;
          setCalFailed(false);
          setCalByDate({});
          setCalClosed({});
          setCalFull({});
          setCalLimited({});
          setCalOpen({});
          setLoadedMonths([]);
          setCalDay(null);
          // 読み直しは今月から探し直す。
          setMonth(monthOf(today));
          setCalAutoDone(false);
          setCalReloadKey((k) => k + 1);
        }} />
      ) : (
        <>
          <div>
            {/* 板 k3aJKU：月・曜日・各週・凡例の間は 14。行の高さは月の名前の字の高さ (押す所は 36 のまま上下へはみ出す)。 */}
            <div aria-label="月をえらぶ" className="mb-3.5 flex h-[22px] items-center justify-between">
              <Button variant="icon"
                type="button"
                onClick={() => setMonth(addMonths(month, -1))}
                disabled={!canPrevMonth}
                aria-label="前の月"
              >
                <Icon name="chevron-left" className="h-[18px] w-[18px]" />
              </Button>
              <p aria-live="polite" className="text-[15px] font-bold text-ink">
                {monthLabel}
              </p>
              <Button variant="icon"
                type="button"
                onClick={() => setMonth(addMonths(month, 1))}
                disabled={!canNextMonth}
                aria-label="次の月"
              >
                <Icon name="chevron-right" className="h-[18px] w-[18px]" />
              </Button>
            </div>
            {!monthLoaded ? (
              <LoadingView />
            ) : (
              <>
                <div className="mb-3.5 grid grid-cols-7" aria-label={`${monthLabel}の曜日`}>
                  {WEEKDAY_JP.split('').map((w, i) => (
                    <span
                      key={w}
                      className={`text-center text-[11px] ${i === 0 ? 'text-liff-sun' : i === 6 ? 'text-liff-sat' : 'text-liff-sub'}`}
                    >
                      {w}
                    </span>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-y-3.5" aria-label={`${monthLabel}の日付`}>
                  {Array.from({ length: firstWeekday }).map((_, i) => (
                    <span key={`pad-${i}`} aria-hidden="true" />
                  ))}
                  {monthDays.map((d) => {
                    const state = stateOf(
                      d,
                      calOpen,
                      calLimited,
                      calFull,
                      calClosed,
                      today,
                      windowEnd,
                    );
                    const dayNum = Number(d.slice(8, 10));
                    // 残りわずかの日も押せる (金の点だけ付ける)。
                    const selectable = state === 'open' || state === 'few';
                    // 満席の日も押せる（週の時刻へ移ると、鈴から空いたら知らせるを登録できる）。
                    const pressable = selectable || state === 'full';
                    const active = d === calDay;
                    return (
                      <Button variant="calendarDay" selected={active} unavailable={!selectable} full={state === 'full'}
                        key={d}
                        type="button"
                        onClick={() => {
                          userPickedDayRef.current = true;
                          setCalDay(d);
                        }}
                        disabled={!pressable}
                        aria-pressed={active}
                        aria-label={dayStateLabel(d, state)}
                      >
                        <span className="liff-num text-sm leading-tight">{dayNum}</span>
                        <span className="flex min-h-1.5 items-center text-[11px] leading-none">
                          {state === 'off' ? '受付外' : null}
                          {/* 空きの点 (緑＝空き・金＝残りわずか)。消す設定では点を出さない。 */}
                          {settings.vacancyDots && (state === 'open' || state === 'few') && (
                            <span
                              className={`block h-[5px] w-[5px] rounded-full ${state === 'few' ? 'bg-liff-dot-few' : 'bg-liff-primary'}`}
                              aria-hidden="true"
                            />
                          )}
                        </span>
                      </Button>
                    );
                  })}
                </div>
                {settings.vacancyDots && (
                  <p className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-liff-sub">
                    <span>
                      <span className="text-liff-primary">●</span> 空きあり
                    </span>
                    {/* 残りわずかの日がある月だけ出す (板 k3aJKU は空きありと灰色の2つ)。 */}
                    {monthHasFew && (
                      <span>
                        <span className="text-liff-dot-few">●</span> 残りわずか
                      </span>
                    )}
                    <span>灰色：満席・休み・空きなし・過ぎた日</span>
                    <span>受付外：受付期間の対象外</span>
                  </p>
                )}
                <p className="mt-2 text-[13px] leading-6 text-liff-sub">{monthFrom <= monthTo ? `この月の受付期間：${monthFrom === monthTo ? formatJpLong(monthFrom) : `${formatJpLong(monthFrom)}〜${formatJpLong(monthTo)}`}` : 'この月は受付期間外です。'}</p>
                {!calDay && (
                  <p className="mt-2 text-[13px] leading-6 text-liff-sub">
                    {monthHasOpen ? '日を選んでください。' : 'この月の受付期間内に空きがありません。'}
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
      {/* 下の操作の帯 (週: 選んだ時間で確かめる / カレンダー: その日の週へ)。
          空きの無い週は帯を出さず、中身の中に次の手を置く。 */}
      {view === 'calendar' || (weekByDate && !weekFailed && weekShowsStrip) ? bar : null}
      {/* 帯の分の余白 */}
      <div className="pb-40" aria-hidden="true" />
    </div>
  );
}
