import Icon from '../../components/ui/icon.js';
import { RestaurantTimeChoices, RestaurantGuestChoices, FieldError } from '../../components/forms/controls.js';
import Button from '../../components/ui/button/index.js';
import SeatDatePicker from './seat-date-picker.js';
import type { RestaurantUnavailableReason } from '@line-crm/shared';
import {
  closedNote,
  hasOpenSlot,
  slotLabel,
  zonedParts,
  type DayChip,
} from '../../lib/seat-reserve.js';





import type { DaySlots } from './seat-reserve-types.js';

/**
 * ① 人数・日時。人数と日付は札から選び、時刻は空きの札から選ぶ。
 * 選べない時刻 (満席) は押せない。空きを1つも持たない日は札を押せない形にし、下に注を出す。
 */
export default function SeatPick({
  timeZone,guestLabel='人数',dateLabel='日にち・時間',formTitle,
  today,
  chips,
  days,
  reasons = {},
  guestCount,
  date,
  startsAt,
  error,
  onGuest,
  onDate,
  onTime,
  onRetry, onRequestDates,
}: {
  timeZone: string;
  guestLabel?:string;dateLabel?:string;formTitle?:string;
  today: string;
  chips: DayChip[];
  /** 日ごとの空き。札の日＋その次の日を先に読む。 */
  days: Record<string, DaySlots>;
  /** 空きが無い日の理由（臨時休業・貸切・定休日・満席）。 */
  reasons?: Record<string, RestaurantUnavailableReason | undefined>;
  guestCount: number;
  date: string;
  startsAt: string | null;
  error: string | null;
  onGuest: (n: number) => void;
  onDate: (date: string) => void;
  onTime: (startsAt: string) => void;
  onRetry: () => void;
  onRequestDates: (dates:string[], retry?:boolean) => void;
}) {
  const day = days[date];

  // 札の日とその次の日で、空きが1つも無い日を注に出す (今日は営業が終わっただけのことが多いので外す)。
  const noted = [...chips.map((c) => c.date), chips.length ? nextDay(chips) : null]
    .filter((d): d is string => !!d && d !== today)
    .filter((d) => {
      const v = days[d];
      return v === 'closed' || (Array.isArray(v) && !hasOpenSlot(v));
    });
  const note = closedNote(noted, reasons);


  return <div className="space-y-3.5" data-design-node="KRppA">
    <h2 className="text-xl font-bold text-ink">人数と日時を選んでください</h2>
    {formTitle && formTitle !== 'ご予約' ? <p className="text-xs text-liff-sub">{formTitle}</p> : null}
    <p className="text-xs leading-[18px] font-semibold text-liff-sub">{guestLabel}</p>
    <RestaurantGuestChoices label={guestLabel} value={guestCount} onChange={onGuest} />
    <p className="text-xs leading-[18px] font-semibold text-liff-sub">{dateLabel}</p>
    <SeatDatePicker today={today} date={date} days={days} onDate={onDate} onRequestDates={onRequestDates} />
    {day==='loading'||day===undefined ? <p role="status" className="text-xs text-liff-sub">空きを読み込んでいます…</p>
      : day==='error' ? <p className="text-[13px] leading-5 text-liff-sub">空きを読み込めませんでした。<Button variant="text" onClick={onRetry}>もう一度読み込む</Button></p>
      : day==='closed'||!day.length ? <p className="text-[13px] leading-5 text-liff-sub">この日は予約を受け付けていません。ほかの日を選んでください。</p>
      : <RestaurantTimeChoices value={startsAt} onChange={onTime} options={day.map(s => ({ value: s.startsAt, label: zonedParts(s.startsAt, timeZone).hm, accessibleLabel: `${zonedParts(s.startsAt, timeZone).hm} ${slotLabel(s)}`, available: s.available }))} />}
    {Array.isArray(day)&&day.some(s=>!s.available) && <p className="flex items-center gap-3 rounded-(--liff-radius) bg-liff-note px-4 py-3 text-[13px] leading-5 text-liff-sub"><Icon name="info" tone="info" className="h-4 w-4 shrink-0" />{day.filter(s=>!s.available).map(s=>zonedParts(s.startsAt,timeZone).hm).join('・')} は満席です</p>}
    {note&&<p className="text-xs leading-[18px] text-liff-sub">{note}</p>}
    {error&&<FieldError>{error}</FieldError>}
  </div>;
}

function nextDay(chips: DayChip[]): string {
  const last = chips[chips.length - 1]!.date;
  const d = new Date(`${last}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
