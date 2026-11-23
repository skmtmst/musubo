import {calendarCredentialsForEnv} from '../../features/booking/booking-outlook-busy-runtime/index.js';
import type { Env } from '../../worker-env.js';
import { getAccountTimeZone, getAvailability, tzDateStr, tzHHMM } from '../../services/availability.js';

export const BOOKING_CONFIRMED_AUTOMATION_EVENT = 'calendar_booked' as const;

export function googleCredentials(env: Env['Bindings']) {
  return calendarCredentialsForEnv(env);
}

export type BookingConflictSource = 'internal_booking' | 'google_calendar' | 'schedule';

export function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function isValidShiftDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isClockTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function isValidTimeRange(start: unknown, end: unknown): boolean {
  return isClockTime(start) && isClockTime(end) && minuteOfDay(start) < minuteOfDay(end);
}

/**
 * 確定直前の枠照合。
 *
 * 要求された instant と、いま計算し直した候補の `startUtc` が同じ瞬間で
 * あることだけを見る。壁時刻（YYYY-MM-DD + HH:MM）の突合は使わない。
 * 夏時間の終わる日は同じ壁時刻が2回現れるので、01:30 で照合すると
 * 「空いている方の 01:30」で「埋まっている方の 01:30」を通してしまう。
 *
 * `startUtc` が無い・読めない候補は一致とみなさない（fail-closed）。
 * 壊れた候補を素通りさせると、営業時間外・休業例外・Google の予定を
 * 迂回して予約が入る。
 */
export function findLatestSlotForInstant(
  slots: Array<{ startUtc?: string | null }> | undefined,
  startsAt: Date,
): { startUtc?: string | null } | null {
  const wantedMs = startsAt.getTime();
  if (!Number.isFinite(wantedMs)) return null;
  for (const slot of slots ?? []) {
    const raw = slot?.startUtc;
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const slotMs = new Date(raw).getTime();
    if (!Number.isFinite(slotMs)) continue;
    if (slotMs === wantedMs) return slot;
  }
  return null;
}

/**
 * 要求 instant を店舗タイムゾーンで読み直し、その暦日の候補と突き合わせる。
 * 取得範囲は前後 1 日を含める。UTC より進んだ／遅れた店舗では、要求の
 * instant が隣の暦日に落ちることがあるため。
 */
export async function reverifyLatestSlot(
  db: D1Database,
  env: Env['Bindings'],
  input: {
    lineAccountId: string;
    menuId: string;
    staffId: string;
    startsAt: Date;
    minLeadTimeMinutes: number;
    /** R92: お客さま向けの再照合では店舗共通ルールを既定値として使う。 */
    additionalDurationMinutes?:number;
    applyStoreRules?: boolean;
    /** 予約変更時は変更対象を重なり判定から外す（自予約と衝突しないように）。 */
    excludeBookingId?: string;
    excludeWaitlistId?: string;
    waitlistOffer?: boolean;
  },
): Promise<boolean> {
  const timeZone = await getAccountTimeZone(db, input.lineAccountId);
  const date = tzDateStr(timeZone, input.startsAt);
  const latest = await getAvailability(db, {
    lineAccountId: input.lineAccountId,
    menuId: input.menuId,
    staffId: input.staffId,
    from: date,
    to: date,
    now: new Date(),
    minLeadTimeMinutes: input.minLeadTimeMinutes,
    additionalDurationMinutes:input.additionalDurationMinutes,
    applyStoreRules: input.applyStoreRules,
    googleCredentials: googleCredentials(env),
    forceCalendarRefresh: true,
    excludeBookingId: input.excludeBookingId,
    excludeWaitlistId:input.excludeWaitlistId,waitlistOffer:input.waitlistOffer,
  });
  const slots = latest.by_staff.find((item) => item.staff_id === input.staffId)?.slots;
  return findLatestSlotForInstant(slots, input.startsAt) !== null;
}

export async function bookingConflictAlternatives(
  db: D1Database,
  env: Env['Bindings'],
  input: {
    lineAccountId: string;
    menuId: string;
    staffId: string;
    startsAt: Date;
    durationMinutes: number;
  },
) {
  const endsAt = new Date(input.startsAt.getTime() + input.durationMinutes * 60_000);
  // 代替候補も店舗タイムゾーンで並べる。+09:00 固定だと NY 店舗で
  // 「別の日の・別の時刻の枠」を代わりとして出してしまう。
  const timeZone = await getAccountTimeZone(db, input.lineAccountId);
  const date = tzDateStr(timeZone, input.startsAt);
  const time = tzHHMM(timeZone, input.startsAt);
  const wantedMs = input.startsAt.getTime();
  const [overlap, availability] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS count, MIN(starts_at) AS conflict_from,
              MAX(block_ends_at) AS conflict_to
         FROM bookings
        WHERE line_account_id = ? AND staff_id = ?
          AND status IN ('requested', 'confirmed')
          AND starts_at < ? AND block_ends_at > ?`,
    ).bind(
      input.lineAccountId,
      input.staffId,
      endsAt.toISOString(),
      input.startsAt.toISOString(),
    ).first<{ count: number; conflict_from: string | null; conflict_to: string | null }>(),
    getAvailability(db, {
      lineAccountId: input.lineAccountId,
      menuId: input.menuId,
      from: date,
      to: date,
      now: new Date(),
      minLeadTimeMinutes: 0,
      googleCredentials: googleCredentials(env),
    }),
  ]);
  const selected = availability.by_staff.find((item) => item.staff_id === input.staffId);
  // 「同じ時刻」は instant で見る。fold 日は壁時刻 01:30 が2回あるため、
  // 壁時刻だけで拾うと要求とは別の瞬間の枠を「同じ時刻の代わり」に出す。
  const isRequestedInstant = (slot: { startUtc?: string | null }): boolean => {
    const raw = slot?.startUtc;
    if (typeof raw !== 'string' || raw.trim() === '') return false;
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) && ms === wantedMs;
  };
  const nearbySlots = [...(selected?.slots ?? [])]
    .filter((slot) => slot.date === date && !isRequestedInstant(slot))
    .sort((a, b) => Math.abs(minuteOfDay(a.start) - minuteOfDay(time)) - Math.abs(minuteOfDay(b.start) - minuteOfDay(time)))
    .slice(0, 3);
  const alternateStaff = availability.by_staff
    .filter((item) => item.staff_id !== input.staffId)
    .filter((item) => item.slots.some(isRequestedInstant))
    .slice(0, 3)
    .map((item) => ({
      staffId: item.staff_id,
      displayName: item.display_name,
      slot: item.slots.find(isRequestedInstant)!,
    }));
  const count = Number(overlap?.count ?? 0);
  const source: BookingConflictSource = count > 0 ? 'internal_booking'
    : selected ? 'google_calendar' : 'schedule';
  return {
    conflict: {
      from: overlap?.conflict_from ?? input.startsAt.toISOString(),
      to: overlap?.conflict_to ?? endsAt.toISOString(),
      count: Math.max(1, count),
      source,
    },
    nearbySlots,
    alternateStaff,
  };
}



// JST の暦日全体を UTC の半開区間へ変換する。00:00 JST は前日15:00Zなので、当日の00〜09時を落とさず既存予約との重複を検証する。
export function jstDayWindowUtc(jstDate: string): { startUtc: string; endUtc: string } {
  return {
    startUtc: new Date(`${jstDate}T00:00:00+09:00`).toISOString(),
    endUtc: `${jstDate}T15:00:00Z`,
  };
}
