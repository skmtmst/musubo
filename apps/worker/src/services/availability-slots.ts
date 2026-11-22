import {toMin,fromMin,overlaps} from './availability-time-values.js';

export interface Interval {
  start: string; // HH:MM
  end: string;   // HH:MM
}

/**
 * 埋まっている時間帯。
 *
 * sameMenu は「この予約が、いま空きを計算しているメニューのものか」。
 * 同時受付数が2以上のメニュー（グループ施術など）では、同じメニューの
 * 予約は定員まで重ねられるが、別メニューの予約は定員に関係なく塞ぐ。
 * 1対1の施術とグループを同じ時間に入れることはできないため。
 *
 * Googleカレンダーの予定も別メニュー扱い（sameMenu = false）。
 */
export interface BusyInterval extends Interval {
  sameMenu?: boolean;
  /** 埋まりの由来。理由の説明用で、枠計算自体は sameMenu だけを見る。 */
  source?: 'booking' | 'google';
}

export interface ComputeSlotsInput {
  working: Interval[];
  busy: BusyInterval[];
  menu: { duration_minutes: number; buffer_after_minutes: number };
  granularityMinutes: number;
  startOffsetMinutes?: number;
  /** 同時に受けられる件数。省略時は1（従来どおり重ねない） */
  capacity?: number;
}
/**
 * 同時受付数を判定するため、候補の開始時刻ごとに重なる予約件数を数える。
 * 勤務時間から埋まりを引くだけでは重複件数が分からないため、枠ごとの判定を使う。
 */
export function computeSlots(input: ComputeSlotsInput): Interval[] {
  const occupy = input.menu.duration_minutes + input.menu.buffer_after_minutes;
  const display = input.menu.duration_minutes;
  const granularity = input.granularityMinutes;
  // 0 や負の値が入ると全ての枠が消える。設定ミスで予約が一切取れなくなる
  // 方が事故として大きいので、1 に寄せる。
  const capacity = Math.max(1, input.capacity ?? 1);

  const busy = input.busy.map((b) => ({
    start: toMin(b.start),
    end: toMin(b.end),
    sameMenu: b.sameMenu === true,
  }));

  const out: Interval[] = [];
  for (const w of input.working) {
    const wStart = toMin(w.start);
    const wEnd = toMin(w.end);
    const offset = ((input.startOffsetMinutes ?? 0) % granularity + granularity) % granularity;
    let t = Math.ceil((wStart - offset) / granularity) * granularity + offset;
    if (t < wStart) t = wStart;
    for (; t + occupy <= wEnd; t += granularity) {
      const slotEnd = t + occupy;
      let sameMenuCount = 0;
      let blocked = false;
      for (const b of busy) {
        if (!overlaps(t, slotEnd, b.start, b.end)) continue;
        if (!b.sameMenu) {
          blocked = true;
          break;
        }
        sameMenuCount++;
      }
      if (blocked || sameMenuCount >= capacity) continue;
      out.push({ start: fromMin(t), end: fromMin(t + display) });
    }
  }
  return out;
}
