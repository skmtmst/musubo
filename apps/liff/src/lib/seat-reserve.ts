/**
 * 飲食店の席の予約 (★V8 glL3g→km8EG→sAnyy) の計算だけを集めた所。
 * 画面から切り離して試験する。時刻は店の時間帯 (link の timezone) で見せる。
 */
import type {
  RestaurantCustomerBooking,
  RestaurantCustomerSlot,
  RestaurantLateArrivalPolicy,
  RestaurantUnavailableReason,
} from '@line-crm/shared';

const WEEKDAY_JA = '日月火水木金土';

/** 店の時間帯での日付 (YYYY-MM-DD)・時刻 (HH:MM) に分ける。 */
export function zonedParts(iso: string, timeZone: string): { date: string; hm: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

/** 店の時間帯での今日。 */
export function zonedToday(timeZone: string, now: Date = new Date()): string {
  return zonedParts(now.toISOString(), timeZone).date;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** '2026-10-07' → '10/7'。 */
export function md(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** '2026-10-07' → '水'。 */
export function weekday(date: string): string {
  return WEEKDAY_JA[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** '2026-10-07' → '10月7日（水）'。 */
export function longDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${weekday(date)}）`;
}

export interface DayChip {
  date: string;
  /** 上の行 (今日・明日・10/9)。 */
  top: string;
  /** 下の行 (10/7 水・金)。 */
  bottom: string;
}

/** 今日から5日の札。今日・明日は「今日／10/7 水」、ほかは「10/9／金」。 */
export function dayChips(today: string, count = 5): DayChip[] {
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(today, i);
    if (i === 0) return { date, top: '今日', bottom: `${md(date)} ${weekday(date)}` };
    if (i === 1) return { date, top: '明日', bottom: `${md(date)} ${weekday(date)}` };
    return { date, top: md(date), bottom: weekday(date) };
  });
}

/** 残りの席がこの数以下なら「残りわずか」。 */
export const FEW_TABLES = 2;

export type SlotState = 'open' | 'few' | 'full';

export function slotState(slot: RestaurantCustomerSlot): SlotState {
  if (!slot.available || slot.remainingTables <= 0) return 'full';
  return slot.remainingTables <= FEW_TABLES ? 'few' : 'open';
}

export const SLOT_LABEL: Record<SlotState, string> = {
  open: '空きあり',
  few: '残りわずか',
  full: '満席',
};

/** 空きを1つも持たない日 (休み・貸切・満席)。 */
export function hasOpenSlot(slots: RestaurantCustomerSlot[] | undefined): boolean {
  return (slots ?? []).some((s) => slotState(s) !== 'full');
}

/** 空きが無い理由の言葉 (口の unavailableReason)。お店の内部のメモは口が返さない。 */
export const UNAVAILABLE_LABEL: Record<RestaurantUnavailableReason, string> = {
  temporary_closed: '臨時休業',
  private_event: '貸切',
  regular_closed: '定休日',
  full: '満席',
};

/** 時刻の札の下の言葉。空いていない時刻は理由 (貸切・臨時休業など) があればそれ、無ければ満席。 */
export function slotLabel(slot: RestaurantCustomerSlot): string {
  const st = slotState(slot);
  if (st !== 'full') return SLOT_LABEL[st];
  if (slot.unavailableReason === 'private_event') return '貸切';
  if (slot.unavailableReason === 'temporary_closed') return '休業';
  return SLOT_LABEL.full;
}

/**
 * 選べない日の注。理由ごとにまとめる。「10/12（月）は臨時休業のため選べません」
 * 「10/12（月）は臨時休業、10/13（火）・10/14（水）は満席のため選べません」。理由が分からない日だけなら「空きがないため」。
 */
export function closedNote(dates: string[], reasons: Record<string, RestaurantUnavailableReason | undefined> = {}): string | null {
  if (!dates.length) return null;
  const days = (list: string[]) => list.map((d) => `${md(d)}（${weekday(d)}）`).join('・');
  if (dates.every((d) => !reasons[d])) return `${days(dates)}は空きがないため選べません`;
  const groups: Array<{ label: string; dates: string[] }> = [];
  for (const d of dates) {
    const r = reasons[d];
    const label = r ? Object.hasOwn(UNAVAILABLE_LABEL, r) ? UNAVAILABLE_LABEL[r] : '理由不明' : '空きなし';
    const g = groups.find((x) => x.label === label);
    if (g) g.dates.push(d);
    else groups.push({ label, dates: [d] });
  }
  return `${groups.map((g) => `${days(g.dates)}は${g.label}`).join('、')}のため選べません`;
}

/** 日全体の理由。口の日の理由が無ければ、時刻の理由がそろっていればそれ。 */
export function dayReason(
  slots: RestaurantCustomerSlot[],
  day?: RestaurantUnavailableReason,
): RestaurantUnavailableReason | undefined {
  if (day) return day;
  const list = [...new Set(slots.map((s) => s.unavailableReason).filter(Boolean))];
  return list.length === 1 ? list[0] : undefined;
}

/** 席の種類の言葉 (卓の設定の seat_type)。知らない種類は確認不能と伝える。 */
export const SEAT_TYPE_LABEL: Record<string, string> = {
  table: 'テーブル席',
  counter: 'カウンター席',
  private_room: '個室',
  terrace: 'テラス席',
};

export function seatTypeLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  return Object.hasOwn(SEAT_TYPE_LABEL, type) ? SEAT_TYPE_LABEL[type]! : '席の種類を確認できません';
}

/** ② の「お席」。割り当てた卓の種類か、空いている候補の種類 (1つならそれ、いくつもなら「・」でつなぐ)。 */
export function seatText(assigned: string | null | undefined, candidates: string[] = []): string {
  const one = seatTypeLabel(assigned);
  if (one) return `${one}（お店で決めます）`;
  const list = [...new Set(candidates)].map((t) => seatTypeLabel(t)!).filter(Boolean);
  return list.length ? `${list.join('・')}（お店で決めます）` : 'お店で決めます';
}

/** 遅れたときの決まりの1文 (句点なし)。お店の決まりが無ければ、LINE で知らせる案内。 */
export function lateRule(policy: RestaurantLateArrivalPolicy | null | undefined): string {
  const text = policy?.message?.trim().replace(/[。.]$/, '');
  if (text) return text;
  if (policy?.cancelAfterMinutes) return `${policy.cancelAfterMinutes}分を過ぎてご連絡がない場合は、取り消しになることがあります`;
  return '遅れるときや人数が変わるときは、この LINE でお店へお知らせください';
}

/** ご要望の確かめ (口と同じ：200字まで)。空は送らない。 */
export function noteProblem(note: string): string {
  return [...note.trim()].length > 200 ? 'ご要望は200字までで書いてください。' : '';
}

export { normalizePhone, phoneProblem } from '@line-crm/shared';

/**
 * 取り消し・変更の締め切り。「前日 21:00」「当日 17:00」「10月5日（月）21:00」。
 * 締め切り＝始まり − cancelDeadlineMinutesBefore。
 */
export function deadlineText(startsAt: string, minutesBefore: number, timeZone: string): string {
  const start = zonedParts(startsAt, timeZone);
  const due = zonedParts(new Date(Date.parse(startsAt) - minutesBefore * 60000).toISOString(), timeZone);
  if (due.date === start.date) return `当日 ${due.hm}`;
  if (due.date === addDays(start.date, -1)) return `前日 ${due.hm}`;
  return `${longDate(due.date)}${due.hm}`;
}

/** 締め切りを過ぎたか (取り消し・変更の操作を出さない)。 */
export function pastDeadline(startsAt: string, minutesBefore: number, now: number = Date.now()): boolean {
  return now >= Date.parse(startsAt) - minutesBefore * 60000;
}

/**
 * 取り消し・変更の決まりの1文 (句点なし)。締め切りを過ぎた予約 (当日の予約など) は
 * LINE からはできないので、お店への連絡を案内する。
 */
export function changeRule(
  startsAt: string,
  minutesBefore: number,
  timeZone: string,
  now: number = Date.now(),
): string {
  if (pastDeadline(startsAt, minutesBefore, now)) return 'このご予約の取り消し・変更は、お店へ直接ご連絡ください';
  return `取り消し・変更は${deadlineText(startsAt, minutesBefore, timeZone)} まで、この LINE からできます`;
}

/** 残り時間 'm:ss'。0 未満は 0:00。 */
export function remainingText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 滞在の長さ「（2時間）」「（1時間30分）」。 */
export function stayText(startsAt: string, endsAt: string): string {
  const m = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000);
  if (m <= 0) return '';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `（${h ? `${h}時間` : ''}${r ? `${r}分` : ''}）`;
}

/** 本人の予約のうち、これからのもの (取り消し・期限切れの仮押さえを除く)。早い順。 */
export function upcomingBookings(
  rows: RestaurantCustomerBooking[],
  now: number = Date.now(),
): RestaurantCustomerBooking[] {
  return rows
    .filter((r) => Date.parse(r.startsAt) > now)
    .filter(
      (r) =>
        r.status === 'confirmed' ||
        (r.status === 'pending' && r.holdExpiresAt != null && Date.parse(r.holdExpiresAt) > now),
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export const STATUS_LABEL: Record<string, string> = {
  confirmed: '予約済み',
  pending: 'お取りしている途中',
  cancelled: '取り消し済み',
};

/** 再実行だけ同じ値にする、新規の受付番号 (8〜128文字・英数と - _)。 */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/** 失敗の中身から、お客さまに見せる1文を選ぶ。中身そのものは出さない。 */
export function seatErrorMessage(e: unknown): string {
  const err = e as { status?: number; body?: { error?: string } };
  const code = err?.body?.error;
  if (code === 'slot_conflict') return 'この時刻はほかの方の予約で埋まりました。ほかの時刻を選んでください。';
  if (code === 'hold_expired') return 'お取りしていた時間が過ぎました。時刻を選び直してください。';
  if(code==='reservation_form_changed')return '予約フォームが更新されました。項目を確認して、もう一度予約してください';
  if(code==='reservation_form_unavailable')return '予約フォームを読み取れません。お店へお問い合わせください';
  if(code==='invalid_reservation_answers')return 'お名前・連絡先・必須の項目を確認してください';
  if (code === 'version_conflict' || code === 'state_conflict')
    return 'ご予約の内容が変わっていました。画面を読み直してください。';
  if (code === 'self_deadline_passed')
    return '取り消し・変更の締め切りを過ぎました。お店へ直接ご連絡ください。';
  if (code === 'cannot_book') return 'お店のLINEを友だち追加すると予約できます。';
  return '送信できませんでした。時間をおいて、もう一度お試しください。';
}
