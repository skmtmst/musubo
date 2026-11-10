import { logger } from '@line-crm/shared/server';
import {toMin,fromMin,overlaps,intInRange,isHhmm} from './availability-time-values.js';
import { sqlIdSet } from '@line-crm/db/id-queries';
// computeSlots は区間だけを受ける純粋関数とし、勤務・埋まりの取得や締切・仮担当者の条件は getAvailability で接続する。

import type { AvailabilityByStaff } from '../features/booking/booking-types/index.js';
import { SLOT_GRANULARITY_CHOICES, SLOT_GRANULARITY_MINUTES } from '../features/booking/booking-types/index.js';
import { getStaffGoogleBusy } from '../features/booking/booking-calendar-sync/index.js';
import type { GoogleServiceAccountCredentials } from './google-service-account.js';
import { storeSeatsForSlot, type StoreCapacityWindow } from '../features/booking/booking-store-capacity/index.js';
import { accountOpeningHours, openingDay, type AccountOpeningHours } from './account-opening-hours.js';

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
  /** 同時に受けられる件数。省略時は1（従来どおり重ねない） */
  capacity?: number;
}






/** 重なる稼働区間をまとめる。例外日が複数ある日の union 用。 */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .map((i) => ({ s: toMin(i.start), e: toMin(i.end) }))
    .filter((v) => Number.isFinite(v.s) && Number.isFinite(v.e) && v.s < v.e)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const merged: Array<{ s: number; e: number }> = [];
  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    if (last && cur.s <= last.e) last.e = Math.max(last.e, cur.e);
    else merged.push({ ...cur });
  }
  return merged.map((m) => ({ start: fromMin(m.s), end: fromMin(m.e) }));
}

/** 稼働区間から休憩などの除外区間を差し引く。 */
function subtractIntervals(working: Interval[], excluded: Interval[]): Interval[] {
  let out = mergeIntervals(working);
  const cuts = mergeIntervals(excluded);
  for (const cut of cuts) {
    const cs = toMin(cut.start);
    const ce = toMin(cut.end);
    const next: Interval[] = [];
    for (const w of out) {
      const ws = toMin(w.start);
      const we = toMin(w.end);
      if (ce <= ws || we <= cs) {
        next.push(w);
        continue;
      }
      if (ws < cs) next.push({ start: fromMin(ws), end: fromMin(cs) });
      if (ce < we) next.push({ start: fromMin(ce), end: fromMin(we) });
    }
    out = next;
  }
  return mergeIntervals(out);
}

/** 稼働区間と店舗例外時間の共通部分だけを残す（短縮営業用）。 */
function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(toMin(x.start), toMin(y.start));
      const e = Math.min(toMin(x.end), toMin(y.end));
      if (s < e) out.push({ start: fromMin(s), end: fromMin(e) });
    }
  }
  return mergeIntervals(out);
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
    let t = Math.ceil(wStart / granularity) * granularity;
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



const FALLBACK_TIME_ZONE = 'Asia/Tokyo';

/** booking_settings.timezone を読む。壊れた値は Asia/Tokyo に寄せる。 */
export function normalizeTimeZone(raw: unknown): string {
  const candidate = typeof raw === 'string' && raw.trim() ? raw.trim() : FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    logger.error("booking_availability.validate_timezone_failed");
    return FALLBACK_TIME_ZONE;
  }
}

function tzParts(tz: string, d: Date): { y: number; mo: number; day: number; h: number; mi: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return { y: get('year'), mo: get('month'), day: get('day'), h: get('hour') % 24, mi: get('minute') };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** そのタイムゾーンでの日付（例外日・予約帰属の突合に使う）。 */
export function tzDateStr(tz: string, d: Date): string {
  const p = tzParts(tz, d);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.day)}`;
}

/** そのタイムゾーンでの時刻。 */
export function tzHHMM(tz: string, d: Date): string {
  const p = tzParts(tz, d);
  return `${pad2(p.h)}:${pad2(p.mi)}`;
}

/** UTC 瞬間におけるそのタイムゾーンのずれ（分未満切り捨て）。 */
function tzOffsetMs(tz: string, utcMs: number): number {
  const floored = utcMs - (utcMs % 60_000);
  const p = tzParts(tz, new Date(floored));
  return Date.UTC(p.y, p.mo - 1, p.day, p.h, p.mi) - floored;
}

/** 「そのタイムゾーンの日付+時刻」を UTC 瞬間へ直す（枠・締切の比較用）。 */
function zonedTimeToUtcMs(tz: string, date: string, hhmm: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  // 壁時刻を UTC と見なした値からずれを引く。ずれは推定値に依存する
  //（夏時間）ため、壁時刻を起点に2回求め直す。差分を積むと2重にずれる。
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall - tzOffsetMs(tz, wall);
  guess = wall - tzOffsetMs(tz, guess);
  return guess;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * instant をそのタイムゾーンの offset 付き ISO へ直す（候補の一意識別子）。
 * 同じ壁時刻が2回現れる fold 日でも offset で区別できる
 *（01:30-04:00 と 01:30-05:00）。
 */
function tzInstantIso(tz: string, utcMs: number): string {
  const p = tzParts(tz, new Date(utcMs));
  const offset = tzOffsetMs(tz, utcMs);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const sec = new Date(utcMs).getUTCSeconds();
  return `${p.y}-${pad2(p.mo)}-${pad2(p.day)}T${pad2(p.h)}:${pad2(p.mi)}:${pad2(sec)}`
    + `${sign}${pad2(Math.floor(abs / 3_600_000))}:${pad2(Math.floor((abs % 3_600_000) / 60_000))}`;
}

/** 店舗のタイムゾーン。booking.ts の競合代替候補でも使う。 */
export async function getAccountTimeZone(
  db: D1Database,
  lineAccountId: string,
): Promise<string> {
  const row = await db
    .prepare(`SELECT timezone FROM booking_settings WHERE line_account_id = ?`)
    .bind(lineAccountId)
    .first<{ timezone: string | null }>();
  return normalizeTimeZone(row?.timezone ?? FALLBACK_TIME_ZONE);
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export interface GetAvailabilityParams {
  additionalDurationMinutes?:number;
  lineAccountId: string;
  menuId: string;
  staffId?: string;
  from: string; // 日本時間の YYYY-MM-DD。
  to: string;
  now: Date;
  minLeadTimeMinutes: number;
  /**
   * R92: お客さま向けの判定では店舗共通ルール（受付締切・受付期間）を
   * メニューの個別指定が無いときの既定値として使う。運用者向け
   * （当日の電話予約など）は付けず、従来どおりメニュー値だけを見る。
   */
  applyStoreRules?: boolean;
  googleCredentials?: GoogleServiceAccountCredentials;
  forceCalendarRefresh?: boolean;
  /**
   * 予約内容の変更で、変更対象そのものを空き枠計算から外す。
   * 自予約の古い枠が重なり判定に残ると、同じ担当のまま少しずらす
   * 変更が「自分自身と競合」で通らなくなる。
   */
  excludeBookingId?: string;
  excludeWaitlistId?: string;
  /** 本人確認済みの案内は通常の受付締切を越えて確定できる。 */
  waitlistOffer?: boolean;
}

export interface CalendarSyncState {
  staff_id: string;
  configured: boolean;
  ok: boolean;
  error?: 'unavailable';
}

/**
 * 予約できない理由の分類（ 予約設定の「この日時はなぜ取れないか」）。
 * 画面はこのコードを運用者向けの文へ翻訳する。顧客名・外部予定の内容など
 * 詳細は返さず、「どの条件で塞がっているか」だけを表す。
 */
export type SlotBlockReason =
  /** メニューが無効・削除済み */
  | 'menu_inactive'
  /** このメニューを受け付ける担当がいない */
  | 'staff_not_offered'
  /** 必要な設備の設定が壊れている（fail-closed） */
  | 'invalid_resource'
  /** 受付期間（何日先まで取れるか）の外 */
  | 'booking_window'
  /** 締切（何時間前まで取れるか）を過ぎた */
  | 'past_cutoff'
  /** その壁時刻は存在しない（夏時間の gap 等） */
  | 'invalid_time'
  /** 受付の刻みの開始時刻ではない（刻み幅は店舗設定） */
  | 'not_on_grid'
  /** 休業日・例外日で閉めている */
  | 'exception_closed'
  /** 例外日の時間設定が壊れていて安全側で閉めている */
  | 'exception_invalid'
  /** 勤務・営業時間の外 */
  | 'outside_working'
  /** 勤務・営業の終わりまでに所要時間が収まらない */
  | 'duration_overrun'
  /** 別メニューの予約と重なる */
  | 'other_booking'
  /** 外部カレンダーの予定と重なる */
  | 'google_busy'
  /** 担当の同時受付数がいっぱい */
  | 'capacity_full'
  /** 店舗全体の同時受付枠がいっぱい */
  | 'store_full'
  /** 必要な設備がその時間に足りない */
  | 'resource_shortage'
  /** 外部カレンダーを読めず fail-closed */
  | 'calendar_unavailable'
  /** 上のどれにも特定できない場合の安全側 */
  | 'unavailable';

interface ShiftRow {
  staff_id: string;
  work_date: string;
  start_time: string;
  end_time: string;
}

interface RuleRow {
  staff_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

/** 曜日指定の休憩（staff_breaks）。勤務時間内の休み時間。 */
interface BreakRow {
  staff_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

/** 日付指定の休憩（staff_break_dates）。その日だけの休み時間。 */
interface BreakDateRow {
  staff_id: string;
  work_date: string;
  start_time: string;
  end_time: string;
}

interface BookingRow {
  staff_id: string;
  menu_id: string;
  starts_at: string;
  block_ends_at: string;
}

interface ResourceBookingRow {
  resource_id: string;
  quantity: number;
  starts_at: string;
  block_ends_at: string;
}

interface RequiredResource {
  id: string;
  capacity: number | null;
  quantity: number;
  resource_account_id: string | null;
  is_active: number | null;
}

/** instant 側の埋まり。fold 跨ぎを壁時刻へ潰すと消えるため、壁とは別系統で持つ。 */
interface InstantBusy {
  startMs: number;
  endMs: number;
  sameMenu: boolean;
  source?: 'booking' | 'google';
}

/** その日が例外日で塞がる理由。working が空で block が null なら勤務時間そのものが無い。 */
type DayBlock = 'staff_closed' | 'resource_closed' | 'store_closed' | 'invalid_exception';

/**
 * 空き計算1回分で読む全入力と派生値。
 * getAvailability（枠の列挙）と explainBookingSlot（理由の説明）の両方が
 * この読み込みを経由し、「画面の説明」と「実際の予約判定」が同じデータと
 * 同じ手順から出ることを保証する。
 */
interface LoadedAvailability {
  menuId: string;
  menuForCalc: { duration_minutes: number; buffer_after_minutes: number };
  concurrentCapacity: number;
  staffRows: Array<{ id: string; display_name: string; is_designation_optional: number }>;
  businessHours: BusinessHour[];
  businessHoursConfigured: boolean;
  openingHours: AccountOpeningHours;
  requiredResources: RequiredResource[];
  resourceCapacity: number;
  menuResourceIds: Set<string>;
  exceptions: AvailabilityExceptionRow[];
  timeZone: string;
  shiftRows: ShiftRow[];
  ruleRows: RuleRow[];
  breakRows: BreakRow[];
  breakDateRows: BreakDateRow[];
  bookingRows: BookingRow[];
  resourceBookingRows: ResourceBookingRow[];
  minLeadAt: Date;
  windowLastDate: string | null;
  /**
   * 予約枠の間隔（分）。店舗設定の保存値を使う。行が無い・壊れた
   * 値のときだけ従来の既定（30）に寄せる。
   */
  slotGranularity: number;
  googleBusyByStaff: Map<string, Array<{ start: string; end: string }> | null>;
  calendarSync: CalendarSyncState[];
  bookingMsByStaff: Map<string, InstantBusy[]>;
  storeBookings: Array<{ startMs: number; endMs: number }>;
  storeWindows: StoreCapacityWindow[];
}

type LoadAvailabilityResult =
  | { kind: 'no_menu' }
  | { kind: 'no_staff' }
  /** 必要な設備の設定が壊れている。消費snapshot集計へ進む前に閉じる（fail-closed）。 */
  | {
      kind: 'invalid_resource';
      staffRows: Array<{ id: string; display_name: string; is_designation_optional: number }>;
      timeZone: string;
    }
  | { kind: 'ok'; data: LoadedAvailability };

function weekdayForDate(date: string): number {
  // 暦日の曜日はタイムゾーンに依らない。00:00Z の曜日＝その日付の曜日。
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

interface BusinessHour {
  weekday: number;
  start_time: string;
  end_time: string;
  capacity: number;
}

function storeCapacityWindows(hours: BusinessHour[], timeZone: string, startMs: number, endMs: number, source?: AccountOpeningHours): StoreCapacityWindow[] {
  const windows: StoreCapacityWindow[] = [];
  for (const date of eachDate(tzDateStr(timeZone, new Date(startMs)), tzDateStr(timeZone, new Date(endMs - 1)))) {
    const local = hours.filter(h => h.weekday === weekdayForDate(date));
    const google = source ? openingDay(source, date) : null;
    const periods = google ?? local.map(h => ({ start: h.start_time, end: h.end_time }));
    for (const period of periods) {
      const boundaries = google ? [period.start, period.end, ...local.flatMap(h => [h.start_time, h.end_time])
        .filter(time => period.start < time && time < period.end)].sort() : [period.start, period.end];
      for (let index = 0; index < boundaries.length - 1; index++) {
        const segmentStart = boundaries[index];
        const segmentEnd = boundaries[index + 1];
        const start = Math.max(startMs, zonedTimeToUtcMs(timeZone, date, segmentStart));
        const end = Math.min(endMs, zonedTimeToUtcMs(timeZone, date, segmentEnd));
        const capacity = Number(local.find(h => h.start_time <= segmentStart && segmentEnd <= h.end_time)?.capacity ?? 1);
        if (start < end) windows.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), capacity });
      }
    }
  }
  return windows;
}

export interface StoreCapacitySnapshot {
  windows: StoreCapacityWindow[];
  settingsVersion: number;
}

/** 対象の営業区間だけへ定員を適用する。設定と営業時間を1つの LEFT JOIN で読み、子行のない全休週も含め、返す版と計算に使う状態を一致させる。 */
export async function getStoreCapacitySnapshot(
  db: D1Database,
  accountId: string,
  start: Date,
  end: Date,
): Promise<StoreCapacitySnapshot> {
  const snapshot = await db.prepare(`/* booking_store_capacity_snapshot */
    SELECT bs.timezone, bs.version,
      bh.weekday, bh.start_time, bh.end_time, bh.capacity
    FROM booking_settings bs
    LEFT JOIN booking_business_hours bh ON bh.booking_settings_id = bs.id
    WHERE bs.line_account_id = ?
    ORDER BY bh.weekday, bh.start_time`)
    .bind(accountId)
    .all<BusinessHour & { timezone: string | null; version: number }>();
  const rows = snapshot.results ?? [];
  const timeZone = normalizeTimeZone(rows[0]?.timezone ?? FALLBACK_TIME_ZONE);
  const hours = rows.filter((row) => row.weekday != null);
  const source = await accountOpeningHours(db, accountId);
  return {
    windows: storeCapacityWindows(hours, timeZone, start.getTime(), end.getTime(), source),
    settingsVersion: Number(rows[0]?.version ?? 0),
  };
}

function googleBusyForDate(
  intervals: Array<{ start: string; end: string }>,
  date: string,
  timeZone: string,
): Interval[] {
  const dayStart = zonedTimeToUtcMs(timeZone, date, '00:00');
  const dayEnd = zonedTimeToUtcMs(timeZone, addDays(date, 1), '00:00');
  return intervals.flatMap((interval) => {
    const start = new Date(interval.start).getTime();
    const end = new Date(interval.end).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return [];
    // その日の範囲で切り取り、端点を壁時刻へ直接直す。現地0時からの
    // 実経過分で HH:MM 化すると、夏時間の切替日（存在しない 02:00 台や
    // 25時まである日）にずれる。NY DST 開始の 07:00Z は 03:00 であり、
    // 実経過 120 分の「02:00」ではない。
    const clippedStart = Math.max(start, dayStart);
    const clippedEnd = Math.min(end, dayEnd);
    if (clippedStart >= clippedEnd) return [];
    const busyStart = tzHHMM(timeZone, new Date(clippedStart));
    // 日終端ちょうどは「24:00」と書く（toMin で 1440 になる）。
    const busyEnd = clippedEnd === dayEnd ? '24:00' : tzHHMM(timeZone, new Date(clippedEnd));
    if (toMin(busyStart) >= toMin(busyEnd)) return [];
    return [{ start: busyStart, end: busyEnd }];
  });
}

interface AvailabilityExceptionRow {
  scope_kind: string;
  scope_id: string | null;
  date_from: string;
  date_to: string;
  kind: string;
  hours_json: string;
}

/**
 * 例外日の時間を読む。壊れた行は null（呼び出し側で fail-closed 扱い）。
 *
 * 書き込み口（POST/PATCH /api/booking/admin/exceptions）が形を検証済み
 * だが、手編集の DB でも予約を受けてしまわないよう、ここでも見直す。
 */
function parseExceptionHours(raw: string): Interval[] | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Interval[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return null;
    const value = item as Record<string, unknown>;
    if (typeof value.start !== 'string' || typeof value.end !== 'string') return null;
    if (!isHhmm(value.start) || !isHhmm(value.end) || !(value.start < value.end)) return null;
    out.push({ start: value.start, end: value.end });
  }
  return out;
}

/**
 * 空き計算に必要な行をすべて読み、派生値（締切・受付期間・店舗定員窓・
 * instant 側の埋まり）まで組み立てる。メニュー無し・担当無しは早期に
 * 識別子だけ返し、枠計算へは進まない。
 */
async function loadAvailabilityData(
  db: D1Database,
  params: GetAvailabilityParams,
): Promise<LoadAvailabilityResult> {
  const menu = await db
    .prepare(
      `SELECT m.duration_minutes, m.buffer_after_minutes,
              m.concurrent_capacity, m.booking_window_days, m.cutoff_hours_before,
              sm.override_duration_minutes AS override_duration,
              sm.override_price AS override_price
         FROM menus m
         LEFT JOIN staff_menus sm ON sm.menu_id = m.id AND sm.staff_id = ?
        WHERE m.id = ? AND m.line_account_id = ?
          AND m.deleted_at IS NULL AND m.is_active = 1`,
    )
    .bind(params.staffId ?? '', params.menuId, params.lineAccountId)
    .first<{
      duration_minutes: number;
      buffer_after_minutes: number;
      concurrent_capacity: number;
      booking_window_days: number | null;
      cutoff_hours_before: number | null;
      override_duration: number | null;
    }>();
  if (!menu) {
    return { kind: 'no_menu' };
  }

  // SQL とパラメータ数を一致させる。staffId 未指定時の no-WHERE バリアントは
  // 2 引数に留める。多いと D1 が "Wrong number of parameter bindings" で
  // 500 を返す（本番再現確認済）。番号付き ?NN は D1 と better-sqlite3 で
  // 数え方が違うため、ここでは無名 ? を文の順に並べる。
  const staffStmt = params.staffId
    ? db
        .prepare(
          `SELECT s.id, s.display_name, s.is_designation_optional
             FROM staff s
             INNER JOIN staff_menus sm ON sm.staff_id = s.id AND sm.menu_id = ? AND sm.is_offered = 1
            WHERE s.line_account_id = ? AND s.is_active = 1 AND s.deleted_at IS NULL AND s.id = ?`,
        )
        .bind(params.menuId, params.lineAccountId, params.staffId)
    : db
        .prepare(
          `SELECT s.id, s.display_name, s.is_designation_optional
             FROM staff s
             INNER JOIN staff_menus sm ON sm.staff_id = s.id AND sm.menu_id = ? AND sm.is_offered = 1
            WHERE s.line_account_id = ? AND s.is_active = 1 AND s.deleted_at IS NULL
            ORDER BY s.is_designation_optional DESC, s.sort_order ASC`,
        )
        .bind(params.menuId, params.lineAccountId);
  const staffRows = await staffStmt.all<{
    id: string;
    display_name: string;
    is_designation_optional: number;
  }>();
  if (!staffRows.results.length) return { kind: 'no_staff' };

  const staffIds = staffRows.results.map((s) => s.id);
  const placeholders = sqlIdSet(staffIds).sql;

  const [businessHours, menuResources, exceptionsResult, settingsRow, openingHours] = await Promise.all([
    db.prepare(`SELECT bh.weekday, bh.start_time, bh.end_time, bh.capacity
      FROM booking_business_hours bh
      INNER JOIN booking_settings bs ON bs.id = bh.booking_settings_id
      WHERE bs.line_account_id = ? ORDER BY bh.weekday, bh.start_time`)
      .bind(params.lineAccountId)
      .all<{ weekday: number; start_time: string; end_time: string; capacity: number }>(),
    db.prepare(`SELECT mr.resource_id AS id, mr.quantity, r.capacity,
                       r.line_account_id AS resource_account_id, r.is_active
      FROM booking_menu_resources mr
      LEFT JOIN booking_resources r ON r.id = mr.resource_id
      WHERE mr.menu_id = ?`)
      .bind(params.menuId)
      .all<{
        id: string;
        capacity: number | null;
        quantity: number;
        resource_account_id: string | null;
        is_active: number | null;
      }>(),
    // 休業日・例外日。要求アカウントのものだけ読む（他アカウントの休業を見ない）。
    // 期間が要求範囲と重なる行だけに絞る。変更直後に読むため結果を溜め置かない。
    db.prepare(`SELECT scope_kind, scope_id, date_from, date_to, kind, hours_json
      FROM booking_availability_exceptions
      WHERE line_account_id = ?
        AND date_from <= ?
        AND date_to >= ?`)
      .bind(params.lineAccountId, params.to, params.from)
      .all<AvailabilityExceptionRow>(),
    db.prepare(`SELECT timezone, business_hours_configured, booking_window_days, cutoff_minutes_before, slot_granularity_minutes FROM booking_settings WHERE line_account_id = ?`)
      .bind(params.lineAccountId)
      .first<{ timezone: string | null; business_hours_configured: number; booking_window_days: number | null; cutoff_minutes_before: number | null; slot_granularity_minutes: number | null }>(),
    accountOpeningHours(db, params.lineAccountId),
  ]);
  // 店舗のタイムゾーンで日付・時刻を読む。未設定・壊れた値は Asia/Tokyo。
  const timeZone = normalizeTimeZone(settingsRow?.timezone ?? FALLBACK_TIME_ZONE);
  // 枠生成・可否説明で使う刻み幅は店舗設定の保存値。候補外・欠損は既定へ。
  const storedGranularity = Number(settingsRow?.slot_granularity_minutes);
  const slotGranularity = (SLOT_GRANULARITY_CHOICES as readonly number[]).includes(storedGranularity)
    ? storedGranularity
    : SLOT_GRANULARITY_MINUTES;
  const requiredResources = menuResources.results ?? [];
  const hasInvalidResource = requiredResources.some((row) =>
    row.capacity == null
    || row.resource_account_id !== params.lineAccountId
    || row.is_active !== 1
    || !Number.isInteger(Number(row.quantity))
    || Number(row.quantity) < 1
    || Number(row.quantity) > Number(row.capacity));
  if (hasInvalidResource) {
    // 壊れた資源設定では消費snapshot集計へ進まず閉じる。
    return { kind: 'invalid_resource', staffRows: staffRows.results, timeZone };
  }
  const resourceCapacity = requiredResources.reduce(
    (min, row) => Math.min(min, Math.floor(Number(row.capacity) / Number(row.quantity))),
    Number.POSITIVE_INFINITY,
  );
  const menuResourceIds = new Set(
    (menuResources.results ?? []).map((row) => String(row.id)),
  );
  const exceptions = exceptionsResult.results ?? [];

  const shifts = await db
    .prepare(
      `SELECT staff_id, work_date, start_time, end_time
         FROM staff_shifts
        WHERE staff_id IN (${placeholders})
          AND work_date BETWEEN ? AND ?`,
    )
    .bind(...(staffIds.length ? sqlIdSet(staffIds).binds : []), params.from, params.to)
    .all<{ staff_id: string; work_date: string; start_time: string; end_time: string }>();

  const rules = await db
    .prepare(
      `SELECT staff_id, weekday, start_time, end_time
         FROM staff_availability_rules
        WHERE staff_id IN (${placeholders}) AND is_active = 1`,
    )
    .bind(...(staffIds.length ? sqlIdSet(staffIds).binds : []))
    .all<{ staff_id: string; weekday: number; start_time: string; end_time: string }>();

  // 曜日指定・日付指定の休憩。勤務区間から差し引くため、
  // 空きの列挙と確定前判定の両方で同じく読む。
  const [weeklyBreaks, datedBreaks] = await Promise.all([
    db.prepare(
      `SELECT staff_id, weekday, start_time, end_time
         FROM staff_breaks
        WHERE staff_id IN (${placeholders})`,
    )
      .bind(...(staffIds.length ? sqlIdSet(staffIds).binds : []))
      .all<BreakRow>(),
    db.prepare(
      `SELECT staff_id, work_date, start_time, end_time
         FROM staff_break_dates
        WHERE staff_id IN (${placeholders})
          AND work_date BETWEEN ? AND ?`,
      )
      .bind(...(staffIds.length ? sqlIdSet(staffIds).binds : []), params.from, params.to)
      .all<BreakDateRow>(),
  ]);
  const breaks = weeklyBreaks.results ?? [];
  const breakDates = datedBreaks.results ?? [];

  // 既存予約を読む範囲は、店舗タイムゾーンの暦日の境界そのものにする。
  // 暦日を UTC の 00:00 と見なして前後 1 日ずつ足す形だと、UTC より
  // 遅れた店舗（America/New_York = UTC-5）の夜の予約が範囲から落ちる。
  // NY の 11/02 20:00 は 11/03 01:00Z で、`to+1 の 00:00Z` を越えるため
  // `starts_at < ?` に当たらず、埋まっているのに空き枠として出ていた。
  // 端点は zonedTimeToUtcMs で求めるので、夏時間の切替日でもずれない。
  // 前後の余裕は要らない。`starts_at < 終端 AND block_ends_at > 始端` が
  // 範囲と重なる予約をすべて拾う（日を跨いで始まった予約も含む）。
  const rangeStart = new Date(zonedTimeToUtcMs(timeZone, params.from, '00:00'));
  const rangeEnd = new Date(zonedTimeToUtcMs(timeZone, addDays(params.to, 1), '00:00'));

  const bookings = await db
    .prepare(
      `SELECT staff_id, menu_id, starts_at, block_ends_at
         FROM booking_slot_allocations
        WHERE line_account_id = ?
          AND julianday(starts_at) < julianday(?)
          AND julianday(block_ends_at) > julianday(?)
          AND (? IS NULL OR id != ?) AND (? IS NULL OR COALESCE(waitlist_id,'') != ?)`,
    )
    .bind(
      params.lineAccountId,
      rangeEnd.toISOString(),
      rangeStart.toISOString(),
      params.excludeBookingId ?? null,
      params.excludeBookingId ?? null,
      params.excludeWaitlistId ?? null,
      params.excludeWaitlistId ?? null,
    )
    .all<{ staff_id: string; menu_id: string; starts_at: string; block_ends_at: string }>();

  // 現在のメニューが必要とする資源について、予約時点のsnapshot消費を
  // スタッフ・メニュー横断で読む。現在のメニュー割当を過去予約へ再適用しない。
  const resourceBookings = requiredResources.length === 0
    ? { results: [] as Array<{ resource_id: string; quantity: number; starts_at: string; block_ends_at: string }> }
    : await db.prepare(
      `SELECT a.resource_id,a.quantity,a.starts_at,a.block_ends_at FROM booking_slot_resources a
        JOIN booking_menu_resources mr ON mr.resource_id=a.resource_id AND mr.menu_id=?
        WHERE a.line_account_id=? AND julianday(a.starts_at)<julianday(?) AND julianday(a.block_ends_at)>julianday(?)
        AND (? IS NULL OR a.id<>?) AND (? IS NULL OR COALESCE(a.waitlist_id,'')<>?)`,
    ).bind(params.menuId,params.lineAccountId,rangeEnd.toISOString(),rangeStart.toISOString(),params.excludeBookingId??null,params.excludeBookingId??null,params.excludeWaitlistId??null,params.excludeWaitlistId??null).all<{ resource_id: string; quantity: number; starts_at: string; block_ends_at: string }>();

  const menuForCalc = {
    duration_minutes: (menu.override_duration ?? menu.duration_minutes)+(params.additionalDurationMinutes??0),
    buffer_after_minutes: menu.buffer_after_minutes,
  };
  // 受付の締め切り。全体の最短リード時間とメニューごとの締め切りの、
  // 遅い方を採る。片方だけを見ると、どちらかの設定が黙って無視される。
  // R92: メニューの個別指定が無いとき、お客さま向け (applyStoreRules) は
  // 店舗共通ルールを既定値として使う。要件 -28 §受付期間・締切:
  // 「店舗既定値を持ち、メニューは必要な項目だけ上書きする」。
  // 手編集で壊れた店舗値は無視し、メニュー値だけを見る（従来どおり）。
  const storeCutoffMinutes = intInRange(settingsRow?.cutoff_minutes_before, 0, 43_200);
  const menuCutoffMinutes = menu.cutoff_hours_before == null ? null : menu.cutoff_hours_before * 60;
  const cutoffMinutes = params.waitlistOffer ? 0 : Math.max(
    params.minLeadTimeMinutes,
    params.applyStoreRules
      ? (menuCutoffMinutes ?? storeCutoffMinutes ?? 0)
      : (menuCutoffMinutes ?? 0),
  );
  const minLeadAt = new Date(params.now.getTime() + cutoffMinutes * 60_000);

  // 何日先まで受けるか。未設定なら制限しない。日付で切る。
  // 24 時間の倍数の加算では夏時間の切替日（23 時間・25 時間の日）に
  // 暦日がずれるため、暦日で足す。
  // R92: お客さま向けはメニュー未指定のとき店舗の受付期間を使う。
  const storeWindowDays = intInRange(settingsRow?.booking_window_days, 1, 365);
  const effectiveWindowDays = params.applyStoreRules
    ? (menu.booking_window_days ?? storeWindowDays)
    : menu.booking_window_days;
  const windowLastDate =
    effectiveWindowDays == null
      ? null
      : addDays(tzDateStr(timeZone, params.now), effectiveWindowDays);

  const googleBusyByStaff = new Map<string, Array<{ start: string; end: string }> | null>();
  const calendarSync: CalendarSyncState[] = [];
  for (const staff of staffRows.results) {
    try {
      const busy = await getStaffGoogleBusy(db, params.googleCredentials ?? {}, {
        lineAccountId: params.lineAccountId,
        staffId: staff.id,
        fresh: params.forceCalendarRefresh,
        timeMin: new Date(zonedTimeToUtcMs(timeZone, params.from, '00:00')).toISOString(),
        timeMax: new Date(zonedTimeToUtcMs(timeZone, addDays(params.to, 1), '00:00')).toISOString(),
      });
      googleBusyByStaff.set(staff.id, busy);
      calendarSync.push({ staff_id: staff.id, configured: busy !== null, ok: true });
    } catch (error) {
      // Google の予定が取れないと二重予約になるため、接続設定済みで取得不能なら空き枠を見せず安全側に止める。
      logger.error("booking_availability.load_failed");
      googleBusyByStaff.set(staff.id, []);
      calendarSync.push({ staff_id: staff.id, configured: true, ok: false, error: 'unavailable' });
    }
  }

  // 既存予約の instant 一覧（担当ごと）。壁日付ではなく instant の重なりで
  // 当日分を拾う。fold を跨ぐ予約が壁日付では別日に落ちるため。
  const bookingMsByStaff = new Map<string, Array<{ startMs: number; endMs: number; sameMenu: boolean }>>();
  const storeBookings: Array<{ startMs: number; endMs: number }> = [];
  for (const b of bookings.results ?? []) {
    const startMs = new Date(b.starts_at).getTime();
    const endMs = new Date(b.block_ends_at).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) continue;
    storeBookings.push({ startMs, endMs });
    const list = bookingMsByStaff.get(b.staff_id) ?? [];
    list.push({ startMs, endMs, sameMenu: b.menu_id === params.menuId });
    bookingMsByStaff.set(b.staff_id, list);
  }
  const storeWindows = storeCapacityWindows(businessHours.results ?? [], timeZone, rangeStart.getTime(), rangeEnd.getTime(), openingHours);

  return {
    kind: 'ok',
    data: {
      menuId: params.menuId,
      menuForCalc,
      concurrentCapacity: Number(menu.concurrent_capacity ?? 1),
      staffRows: staffRows.results,
      businessHours: businessHours.results ?? [],
      businessHoursConfigured: settingsRow?.business_hours_configured === 1,
      openingHours,
      requiredResources,
      resourceCapacity,
      menuResourceIds,
      exceptions,
      timeZone,
      shiftRows: shifts.results ?? [],
      ruleRows: rules.results ?? [],
      breakRows: breaks,
      breakDateRows: breakDates,
      bookingRows: bookings.results ?? [],
      resourceBookingRows: resourceBookings.results ?? [],
      minLeadAt,
      windowLastDate,
      slotGranularity,
      googleBusyByStaff,
      calendarSync,
      bookingMsByStaff,
      storeBookings,
      storeWindows,
    },
  };
}

/**
 * その日の例外日・勤務・営業時間・資源の時間を畳み込み、予約を受けられる
 * 壁時刻の区間を返す。塞がったときは block に理由を入れる。理由説明が
 * 「例外日で閉まっている」と「勤務時間そのものが無い」を区別するためで、
 * 枠計算自体は従来どおり返り値の working だけを見る。
 */
function computeDayWorking(
  d: LoadedAvailability,
  staffId: string,
  date: string,
): { working: Interval[]; block: DayBlock | null } {
  // その日の例外日（JST 日付で突合。YYYY-MM-DD の辞書式比較でよい）。
  // 毎週ルール・シフトより例外日を優先する。優先順位は下の通り。
  //
  // 塞ぐ（closed）: 担当・資源（このメニューが使うもの）は絶対に塞ぐ。
  //   店舗 closed は、店舗 open（臨時営業）が同日にあれば open 区間だけ開ける。
  // 時間: 担当 custom が稼働を置き換え、担当 open が足す。店舗 open は
  //   平日には足し、closed 日には open 区間だけ再開する。
  //   店舗 custom と資源の時間（custom/open）は共通部分に絞る。資源は
  //   資源ごとに union し、資源の間で intersection する（全資源が同時
  //   に要るため）。資源に稼働の基準が無いため、資源 open も custom と
  //   同じ絞り込みになる（基準が常時可のため、開ける方向には働かない）。
  // 壊れた時間・空の時間は fail-closed（枠 0）。
  const dayExceptions = d.exceptions.filter(
    (e) => e.date_from <= date && date <= e.date_to,
  );
  // 適用範囲だけを集める。適用外（別担当・使わない資源）の行は読まない。
  const storeRows = dayExceptions.filter((e) => e.scope_kind === 'store');
  const staffExceptionRows = dayExceptions.filter(
    (e) => e.scope_kind === 'staff' && e.scope_id === staffId,
  );
  const resourceRows = dayExceptions.filter(
    (e) => e.scope_kind === 'resource'
      && e.scope_id != null
      && d.menuResourceIds.has(e.scope_id),
  );
  // 適用される時間行を読む。壊れた行が 1 つでもあれば fail-closed。
  let brokenTime = false;
  const readHours = (rows: AvailabilityExceptionRow[], kind: string): Interval[] => {
    const out: Interval[] = [];
    for (const row of rows) {
      if (row.kind !== kind) continue;
      const hours = parseExceptionHours(row.hours_json);
      if (hours === null) {
        brokenTime = true;
        return [];
      }
      out.push(...hours);
    }
    return mergeIntervals(out);
  };
  const staffCustomHours = readHours(staffExceptionRows, 'custom_hours');
  const staffOpenHours = readHours(staffExceptionRows, 'open');
  const storeOpenHours = readHours(storeRows, 'open');
  const storeCustomHours = readHours(storeRows, 'custom_hours');
  // 資源は資源ごとに union する。予約には全ての資源が同時に要るため、
  // 資源の間は後で intersection する。空の資源が1つでもあれば枠0。
  const resourceHoursById = new Map<string, Interval[]>();
  for (const row of resourceRows) {
    if (row.kind !== 'custom_hours' && row.kind !== 'open') continue;
    const hours = parseExceptionHours(row.hours_json);
    if (hours === null) {
      brokenTime = true;
      break;
    }
    const key = row.scope_id as string;
    const list = resourceHoursById.get(key) ?? [];
    list.push(...hours);
    resourceHoursById.set(key, list);
  }
  const hasStaffCustom = staffExceptionRows.some((e) => e.kind === 'custom_hours');
  const hasStaffOpen = staffExceptionRows.some((e) => e.kind === 'open');
  const hasStoreOpen = storeRows.some((e) => e.kind === 'open');
  const hasStoreCustom = storeRows.some((e) => e.kind === 'custom_hours');
  if (brokenTime) return { working: [], block: 'invalid_exception' };
  const staffClosed = staffExceptionRows.some((e) => e.kind === 'closed');
  const resourceClosed = resourceRows.some((e) => e.kind === 'closed');
  const storeClosed = storeRows.some((e) => e.kind === 'closed');
  if (staffClosed) return { working: [], block: 'staff_closed' };
  if (resourceClosed) return { working: [], block: 'resource_closed' };
  // 店舗 open（臨時営業）は店舗 closed を切り抜く。担当・資源 closed は越えない。
  if (storeClosed && storeOpenHours.length === 0) {
    return { working: [], block: 'store_closed' };
  }
  // 空の open 行は fail-closed（足す時間が無いのに開けない）。
  if ((hasStaffOpen && staffOpenHours.length === 0)
    || (hasStoreOpen && storeOpenHours.length === 0)) {
    return { working: [], block: 'invalid_exception' };
  }
  const shift = d.shiftRows.find((r) => r.staff_id === staffId && r.work_date === date);
  const rule = d.ruleRows.find(
    (r) => r.staff_id === staffId && r.weekday === weekdayForDate(date),
  );
  const base = shift ?? rule;
  const coreWorking: Interval[] = hasStaffCustom
    ? staffCustomHours
    : base
      ? [{ start: base.start_time, end: base.end_time }]
      : [];
  /*
   * 店舗の営業時間（週次）で、通常の勤務を切り詰める。
   *
   * これまで `booking_business_hours` は定員の計算にしか使われておらず、
   * 枠の開閉には効いていなかった。営業 10:00-17:00・勤務 09:00-18:00 の
   * 店で 09:00 の枠が出て、17:00-18:00 まではみ出していた。
   *
   * 明示設定前だけは、その曜日の行が1件も無ければ制限しない。
   * 管理画面から一度でも週全体を保存した後は、0行曜日を定休日として閉じる。
   *
   * 同じ曜日に複数行あるときは区間として束ねる（10:00-13:00 と
   * 14:00-18:00 なら昼休みは閉じる）。
   *
   * 臨時営業（例外日の `open`）はこのあと足す。**営業時間では切らない。**
   * 日付を指定して「この日は開ける」と入れたものなので、週次の並びより
   * そちらを採る。`closed` と `custom_hours` の扱いはこれまでどおり。
   */
  const dayHours = d.businessHours.filter((hour) => hour.weekday === weekdayForDate(date));
  const googleDay = openingDay(d.openingHours, date);
  const businessIntervals = mergeIntervals(googleDay ?? dayHours.map((hour) => ({ start: hour.start_time, end: hour.end_time })));
  const shouldApplyBusinessHours = businessIntervals.length > 0
    || d.businessHoursConfigured || googleDay !== null;
  const coreWithinBusiness = shouldApplyBusinessHours
    ? intersectIntervals(coreWorking, businessIntervals)
    : coreWorking;
  let workingList = mergeIntervals([...coreWithinBusiness, ...staffOpenHours]);
  if (!storeClosed) {
    workingList = mergeIntervals([...workingList, ...storeOpenHours]);
  } else {
    // 店舗 closed を open が切り抜く日は、open 区間だけ再開する。
    // 通常勤務は足さない（09-17 勤務＋10-12 open なら 10-12 だけ）。
    workingList = workingList.length === 0
      ? storeOpenHours
      : intersectIntervals(workingList, storeOpenHours);
  }
  // 空の custom 行との共通部分は空になる（fail-closed）。
  if (hasStoreCustom) workingList = intersectIntervals(workingList, storeCustomHours);
  for (const hours of resourceHoursById.values()) {
    workingList = intersectIntervals(workingList, mergeIntervals(hours));
    if (workingList.length === 0) break;
  }
  // 店舗・担当の臨時 open でも Google の営業時間を超えて枠を出さない。
  if (googleDay !== null) workingList = intersectIntervals(workingList, businessIntervals);
  // 休憩を勤務区間から差し引く。その日だけの休憩と、その曜日の
  // いつもの休憩の両方を見る。壊れた行は保存口で弾くため、ここでは
  // 時刻の形が正しいものだけを差し引く。
  if (workingList.length > 0) {
    const weekday = weekdayForDate(date);
    const cuts: Interval[] = [];
    for (const row of d.breakDateRows) {
      if (row.staff_id === staffId && row.work_date === date
        && isHhmm(row.start_time) && isHhmm(row.end_time)
        && row.start_time < row.end_time) {
        cuts.push({ start: row.start_time, end: row.end_time });
      }
    }
    for (const row of d.breakRows) {
      if (row.staff_id === staffId && row.weekday === weekday
        && isHhmm(row.start_time) && isHhmm(row.end_time)
        && row.start_time < row.end_time) {
        cuts.push({ start: row.start_time, end: row.end_time });
      }
    }
    if (cuts.length > 0) workingList = subtractIntervals(workingList, cuts);
  }
  return { working: workingList, block: null };
}

/**
 * その日の埋まり。壁時刻側（枠刻みの判定用）と instant 側（fold 跨ぎ用）を
 * 両方返す。理由説明が「予約」と「外部カレンダーの予定」を言い分けられる
 * よう、source も付ける。
 */
function buildDayBusy(
  d: LoadedAvailability,
  staffId: string,
  date: string,
): { dayBookings: BusyInterval[]; busyMs: InstantBusy[] } {
  const dayBookings: BusyInterval[] = d.bookingRows
    .filter((b) => b.staff_id === staffId)
    .filter((b) => tzDateStr(d.timeZone, new Date(b.starts_at)) === date)
    .map((b) => ({
      start: tzHHMM(d.timeZone, new Date(b.starts_at)),
      end: tzHHMM(d.timeZone, new Date(b.block_ends_at)),
      // 同じメニューの予約だけが定員まで重ねられる。
      sameMenu: b.menu_id === d.menuId,
      source: 'booking',
    }));
  const googleBusy = d.googleBusyByStaff.get(staffId);
  // 外の予定は定員に関係なく塞ぐ（sameMenu を付けない）。
  if (googleBusy) {
    dayBookings.push(
      ...googleBusyForDate(googleBusy, date, d.timeZone)
        .map((interval) => ({ ...interval, source: 'google' as const })),
    );
  }
  // instant 側の busy。当日の範囲と重なるものを instant のまま集める。
  // fold を跨ぐ予約・予定は壁時刻へ潰すと消える（01:30→01:30）ため、
  // 壁とは別に instant の重なりを見る。
  const dayStartMs = zonedTimeToUtcMs(d.timeZone, date, '00:00');
  const dayEndMs = zonedTimeToUtcMs(d.timeZone, addDays(date, 1), '00:00');
  const busyMs: InstantBusy[] = [];
  for (const b of d.bookingMsByStaff.get(staffId) ?? []) {
    if (b.startMs < dayEndMs && dayStartMs < b.endMs) {
      busyMs.push({
        startMs: Math.max(b.startMs, dayStartMs),
        endMs: Math.min(b.endMs, dayEndMs),
        sameMenu: b.sameMenu,
        source: b.source,
      });
    }
  }
  if (googleBusy) {
    for (const interval of googleBusy) {
      const startMs = new Date(interval.start).getTime();
      const endMs = new Date(interval.end).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) continue;
      if (startMs < dayEndMs && dayStartMs < endMs) {
        busyMs.push({
          startMs: Math.max(startMs, dayStartMs),
          endMs: Math.min(endMs, dayEndMs),
          sameMenu: false,
          source: 'google',
        });
      }
    }
  }
  return { dayBookings, busyMs };
}

/** 1つの候補枠への判定結果。emitted は getAvailability が候補として返すか。 */
interface SlotVerdict {
  /** 従来の列挙に残るか（満席の枠も残る）。false なら候補から外れる。 */
  emitted: boolean;
  /** 実際に予約を受けられるか（emitted かつ残数あり）。 */
  bookable: boolean;
  remaining: number;
  capacity: number;
  state: 'available' | 'limited' | 'full';
  /** 受けられない理由（bookable のとき空）。 */
  reasons: SlotBlockReason[];
  /** 候補の開始 instant（startUtc の材料）。 */
  startMs: number;
}

/**
 * 候補枠1件の判定。gap・締切・instant 重なり・店舗定員・設備を従来と同じ
 * 条件で見るが、理由説明のため「どれで落ちたか」も集める。
 */
function evaluateSlot(
  d: LoadedAvailability,
  date: string,
  slot: Interval,
  dayBookings: BusyInterval[],
  busyMs: InstantBusy[],
): SlotVerdict {
  const occupyMs = (d.menuForCalc.duration_minutes + d.menuForCalc.buffer_after_minutes) * 60_000;
  const slotStartMs = zonedTimeToUtcMs(d.timeZone, date, slot.start);
  const fail = (reasons: SlotBlockReason[]): SlotVerdict => ({
    emitted: false,
    bookable: false,
    remaining: 0,
    capacity: 0,
    state: 'full',
    reasons,
    startMs: slotStartMs,
  });
  // gap（存在しない壁時刻。DST 開始日の 02:00 台）は候補にしない。
  // 壁→instant→壁が往復一致するものだけ出す。
  const roundTripped = new Date(slotStartMs);
  if (tzDateStr(d.timeZone, roundTripped) !== date
    || tzHHMM(d.timeZone, roundTripped) !== slot.start) {
    return fail(['invalid_time']);
  }
  if (new Date(slotStartMs) < d.minLeadAt) return fail(['past_cutoff']);
  const slotEndMs = slotStartMs + occupyMs;
  const wallSameCount = dayBookings.filter((booking) => booking.sameMenu === true
    && overlaps(toMin(slot.start), toMin(slot.end), toMin(booking.start), toMin(booking.end))).length;
  // instant 側の重なり。壁側が見落とす fold 跨ぎを拾う。
  // 重なりは真の時間衝突なので、壁で空いていても塞ぐ。
  const instantReasons = new Set<SlotBlockReason>();
  let instantSameCount = 0;
  for (const busy of busyMs) {
    if (slotStartMs < busy.endMs && busy.startMs < slotEndMs) {
      if (!busy.sameMenu) {
        instantReasons.add(busy.source === 'google' ? 'google_busy' : 'other_booking');
      } else {
        instantSameCount++;
      }
    }
  }
  const sameMenuCount = Math.max(wallSameCount, instantSameCount);
  const staffCapacity = Math.max(1, d.concurrentCapacity);
  const storeSeats = storeSeatsForSlot(d.storeWindows, d.storeBookings, slotStartMs, slotEndMs);
  let resourceRemaining = Number.POSITIVE_INFINITY;
  for (const resource of d.requiredResources) {
    const overlapping = d.resourceBookingRows.flatMap((booking) => {
      if (booking.resource_id !== resource.id) return [];
      const startMs = new Date(booking.starts_at).getTime();
      const endMs = new Date(booking.block_ends_at).getTime();
      return startMs < slotEndMs && slotStartMs < endMs
        ? [{ startMs, endMs, quantity: Number(booking.quantity) }]
        : [];
    });
    const points = [
      slotStartMs,
      ...overlapping.map((booking) => booking.startMs)
        .filter((point) => slotStartMs < point && point < slotEndMs),
    ];
    const peakUsed = points.reduce((peak, point) => Math.max(
      peak,
      overlapping.reduce(
        (used, booking) => used + (
          booking.startMs <= point && point < booking.endMs ? booking.quantity : 0
        ),
        0,
      ),
    ), 0);
    resourceRemaining = Math.min(
      resourceRemaining,
      Math.max(0, Math.floor(
        (Number(resource.capacity) - peakUsed) / Number(resource.quantity),
      )),
    );
  }
  // 列挙から外す条件（従来の continue と同じ）。理由として全部集める。
  const reasons: SlotBlockReason[] = [...instantReasons];
  if (storeSeats.remaining === 0) reasons.push('store_full');
  if (resourceRemaining === 0) reasons.push('resource_shortage');
  if (reasons.length > 0) return fail(reasons);
  const effectiveCapacity = Math.min(staffCapacity, storeSeats.capacity, d.resourceCapacity);
  const remaining = Math.max(0, Math.min(
    staffCapacity - sameMenuCount,
    storeSeats.remaining,
    resourceRemaining,
  ));
  const state = remaining === 0 ? 'full' : remaining < effectiveCapacity ? 'limited' : 'available';
  return {
    emitted: true,
    bookable: remaining > 0,
    remaining,
    capacity: effectiveCapacity,
    state,
    // 満席で列挙にだけ残る枠は「担当の同時受付数いっぱい」が理由。
    reasons: remaining === 0 ? ['capacity_full'] : [],
    startMs: slotStartMs,
  };
}

/**
 * 枠刻みの候補に挙がらなかった開始時刻の理由を、computeSlots と同じ条件
 * （勤務内に収まるか・刻みに乗るか・埋まりと重なるか）で説明する。
 */
function diagnoseRejectedStart(
  working: Interval[],
  busy: BusyInterval[],
  startMin: number,
  occupyMin: number,
  granularity: number,
  capacity: number,
): SlotBlockReason[] {
  // 所要時間込みで勤務区間に収まるか
  const containing = working.filter(
    (w) => toMin(w.start) <= startMin && startMin + occupyMin <= toMin(w.end),
  );
  if (containing.length === 0) {
    const startsInside = working.some(
      (w) => toMin(w.start) <= startMin && startMin < toMin(w.end),
    );
    return [startsInside ? 'duration_overrun' : 'outside_working'];
  }
  // computeSlots と同じ刻み: 区間の先頭を刻みへ切り上げた所から granularity ごと
  const onGrid = containing.some((w) => {
    const first = Math.ceil(toMin(w.start) / granularity) * granularity;
    return startMin >= first && (startMin - first) % granularity === 0;
  });
  if (!onGrid) return ['not_on_grid'];
  const reasons = new Set<SlotBlockReason>();
  let sameMenuCount = 0;
  for (const b of busy) {
    if (!overlaps(startMin, startMin + occupyMin, toMin(b.start), toMin(b.end))) continue;
    if (!b.sameMenu) {
      reasons.add(b.source === 'google' ? 'google_busy' : 'other_booking');
    } else {
      sameMenuCount++;
    }
  }
  if (sameMenuCount >= Math.max(1, capacity)) reasons.add('capacity_full');
  // computeSlots は busy 以外で候補を落とさない。ここに来るなら理由の
  // 取りこぼしなので、安全側の総称を返す。
  if (reasons.size === 0) reasons.add('unavailable');
  return [...reasons];
}

export async function getAvailability(
  db: D1Database,
  params: GetAvailabilityParams,
): Promise<{ by_staff: AvailabilityByStaff[]; closed_dates: string[] }> {
  const loaded = await loadAvailabilityData(db, params);
  if (loaded.kind === 'no_menu' || loaded.kind === 'no_staff') {
    return { by_staff: [], closed_dates: [] };
  }
  if (loaded.kind === 'invalid_resource') {
    return {
      by_staff: loaded.staffRows.map((staff) => ({
        staff_id: staff.id,
        display_name: staff.display_name,
        slots: [],
      })),
      closed_dates: [],
    };
  }
  const d = loaded.data;
  // 担当者・メニューの同時受付と、店舗全体の席数を別々に検査する。
  const staffCapacity = Math.max(1, d.concurrentCapacity);
  const by_staff: AvailabilityByStaff[] = [];
  // LIFF カレンダーの「休」の印用。担当ごとに閉まっている日を集め、
  // 全担当で閉まっている日だけを返す（外部カレンダー故障で読めない
  // 担当は除外し、休みと決めつけない）。枠の有無の判定は変えない。
  const closedSets: Array<Set<string>> = [];
  for (const s of d.staffRows) {
    const slots: AvailabilityByStaff['slots'] = [];
    const syncState = d.calendarSync.find((state) => state.staff_id === s.id);
    if (syncState?.configured && !syncState.ok) {
      by_staff.push({ staff_id: s.id, display_name: s.display_name, slots });
      continue;
    }
    const closed = new Set<string>();
    for (const date of eachDate(params.from, params.to)) {
      if (d.windowLastDate && date > d.windowLastDate) continue;
      const day = computeDayWorking(d, s.id, date);
      if (day.block !== null || day.working.length === 0) {
        closed.add(date);
        continue;
      }
      const workingList = day.working;
      const { dayBookings, busyMs } = buildDayBusy(d, s.id, date);
      const daySlots = computeSlots({
        working: workingList,
        busy: dayBookings,
        menu: d.menuForCalc,
        granularityMinutes: d.slotGranularity,
        capacity: staffCapacity,
      });
      for (const slot of daySlots) {
        const verdict = evaluateSlot(d, date, slot, dayBookings, busyMs);
        if (!verdict.emitted) continue;
        slots.push({
          date,
          start: slot.start,
          end: slot.end,
          timeZone: d.timeZone,
          startUtc: tzInstantIso(d.timeZone, verdict.startMs),
          endUtc: tzInstantIso(d.timeZone, verdict.startMs + d.menuForCalc.duration_minutes * 60_000),
          capacity: verdict.capacity,
          remaining: verdict.remaining,
          state: verdict.state,
        });
      }
    }
    closedSets.push(closed);
    by_staff.push({ staff_id: s.id, display_name: s.display_name, slots });
  }
  const closed_dates = [...(closedSets[0] ?? [])]
    .filter((date) => closedSets.every((set) => set.has(date)))
    .sort();
  return { by_staff, closed_dates, calendar_sync: d.calendarSync } as {
    by_staff: AvailabilityByStaff[];
    closed_dates: string[];
    calendar_sync: CalendarSyncState[];
  };
}

// ----------------------------------------------------------------
//  予約設定: 「この日時はなぜ予約できないか」の説明
// ----------------------------------------------------------------

export interface ExplainSlotParams {
  lineAccountId: string;
  menuId: string;
  staffId?: string;
  /** 店舗タイムゾーンの暦日（YYYY-MM-DD）。 */
  date: string;
  /** 店舗タイムゾーンの壁時刻（HH:MM）。 */
  time: string;
  now: Date;
  minLeadTimeMinutes: number;
  /** R92: お客さま向けの説明では店舗共通ルールを既定値として使う。 */
  applyStoreRules?: boolean;
  waitlistOffer?: boolean;
  googleCredentials?: GoogleServiceAccountCredentials;
}

export interface SlotCheckStaff {
  staff_id: string;
  display_name: string;
  /** その担当でこの日時に予約できるか。 */
  bookable: boolean;
  /** bookable のときの残数と受付数。 */
  remaining: number | null;
  capacity: number | null;
  reasons: SlotBlockReason[];
}

export interface SlotCheckResult {
  date: string;
  time: string;
  timeZone: string;
  /** 担当未指定なら誰か1人でも取れれば true。 */
  bookable: boolean;
  /** bookable=false のとき全担当分の理由を集約したもの。 */
  reasons: SlotBlockReason[];
  per_staff: SlotCheckStaff[];
  /**
   * 判定に実際に使った枠間隔（分）。理由文が適用値を表示するために使う。
   * 追加の項目なので、読まない呼び出し側の動きは変わらない。
   */
  slotGranularityMinutes?: number;
}

/**
 * 「この日時はなぜ予約できないか」を、実際の空き枠計算と同じ入力・同じ
 * 手順で説明する。読み取りだけで予約は作らない。理由は条件の種類だけを
 * 返し、他担当の非公開予定の内容（件名・相手など）は含めない。
 */
export async function explainBookingSlot(
  db: D1Database,
  params: ExplainSlotParams,
): Promise<SlotCheckResult> {
  const loaded = await loadAvailabilityData(db, {
    lineAccountId: params.lineAccountId,
    menuId: params.menuId,
    staffId: params.staffId,
    from: params.date,
    to: params.date,
    now: params.now,
    minLeadTimeMinutes: params.minLeadTimeMinutes,
    applyStoreRules: params.applyStoreRules,
    waitlistOffer:params.waitlistOffer,
    googleCredentials: params.googleCredentials,
  });
  const d0 = loaded.kind === 'ok' ? loaded.data : null;
  const result = (partial: Partial<SlotCheckResult>): SlotCheckResult => ({
    date: params.date,
    time: params.time,
    timeZone: FALLBACK_TIME_ZONE,
    bookable: false,
    reasons: [],
    per_staff: [],
    // 刻み幅が要る理由文のため、読めたときは適用値を添える。
    ...(d0 ? { slotGranularityMinutes: d0.slotGranularity } : null),
    ...partial,
  });
  if (loaded.kind === 'no_menu') return result({ reasons: ['menu_inactive'] });
  if (loaded.kind === 'no_staff') return result({ reasons: ['staff_not_offered'] });
  if (loaded.kind === 'invalid_resource') {
    return result({
      timeZone: loaded.timeZone,
      reasons: ['invalid_resource'],
      per_staff: loaded.staffRows.map((staff) => ({
        staff_id: staff.id,
        display_name: staff.display_name,
        bookable: false,
        remaining: null,
        capacity: null,
        reasons: ['invalid_resource' as SlotBlockReason],
      })),
    });
  }
  const d = loaded.data;
  const base = { timeZone: d.timeZone };
  // 入力時刻そのものが不正（HH:MM の形でない、または存在しない壁時刻）
  if (!isHhmm(params.time)) return result({ ...base, reasons: ['invalid_time'] });
  const slotStartMs = zonedTimeToUtcMs(d.timeZone, params.date, params.time);
  const roundTripped = new Date(slotStartMs);
  const globalReasons: SlotBlockReason[] = [];
  if (tzDateStr(d.timeZone, roundTripped) !== params.date
    || tzHHMM(d.timeZone, roundTripped) !== params.time) {
    globalReasons.push('invalid_time');
  }
  if (d.windowLastDate && params.date > d.windowLastDate) {
    globalReasons.push('booking_window');
  }
  if (slotStartMs < d.minLeadAt.getTime()) globalReasons.push('past_cutoff');
  const occupyMin = d.menuForCalc.duration_minutes + d.menuForCalc.buffer_after_minutes;
  const startMin = toMin(params.time);
  const staffCapacity = Math.max(1, d.concurrentCapacity);
  const per_staff: SlotCheckStaff[] = [];
  for (const s of d.staffRows) {
    const reasons: SlotBlockReason[] = [...globalReasons];
    let remaining: number | null = null;
    let capacity: number | null = null;
    let bookable = false;
    if (reasons.length === 0) {
      const syncState = d.calendarSync.find((state) => state.staff_id === s.id);
      if (syncState?.configured && !syncState.ok) {
        reasons.push('calendar_unavailable');
      } else {
        const day = computeDayWorking(d, s.id, params.date);
        if (day.block !== null) {
          reasons.push(day.block === 'invalid_exception' ? 'exception_invalid' : 'exception_closed');
        } else if (day.working.length === 0) {
          reasons.push('outside_working');
        } else {
          const { dayBookings, busyMs } = buildDayBusy(d, s.id, params.date);
          const daySlots = computeSlots({
            working: day.working,
            busy: dayBookings,
            menu: d.menuForCalc,
            granularityMinutes: d.slotGranularity,
            capacity: staffCapacity,
          });
          const candidate = daySlots.find((slot) => slot.start === params.time);
          if (!candidate) {
            reasons.push(...diagnoseRejectedStart(
              day.working,
              dayBookings,
              startMin,
              occupyMin,
              d.slotGranularity,
              staffCapacity,
            ));
          } else {
            const verdict = evaluateSlot(d, params.date, candidate, dayBookings, busyMs);
            reasons.push(...verdict.reasons);
            bookable = verdict.bookable;
            if (verdict.emitted) {
              remaining = verdict.remaining;
              capacity = verdict.capacity;
            }
          }
        }
      }
    }
    per_staff.push({
      staff_id: s.id,
      display_name: s.display_name,
      bookable,
      remaining,
      capacity,
      reasons,
    });
  }
  const bookable = per_staff.some((staff) => staff.bookable);
  const reasons = bookable
    ? []
    : [...new Set(per_staff.flatMap((staff) => staff.reasons))];
  return result({ ...base, bookable, reasons, per_staff });
}
