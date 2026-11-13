import { describe, expect, it } from 'vitest';
import {
  changeRule,
  closedNote,
  dayChips,
  deadlineText,
  hasOpenSlot,
  pastDeadline,
  remainingText,
  seatErrorMessage,
  slotState,
  stayText,
  upcomingBookings,
  zonedParts,
  zonedToday,
  dayReason,
  slotLabel,
  seatText,
  lateRule,
  noteProblem,
  phoneProblem,
  normalizePhone,
} from './seat-reserve.js';

const TZ = 'Asia/Tokyo';
const at = (s: string) => new Date(s).toISOString();

describe('席の予約の計算 (E-11)', () => {
  it('店の時間帯で日付・時刻に分ける (UTC の前日でも JST の日付)', () => {
    expect(zonedParts('2026-10-06T16:30:00Z', TZ)).toEqual({ date: '2026-10-07', hm: '01:30' });
    expect(zonedToday(TZ, new Date('2026-10-06T15:00:00Z'))).toBe('2026-10-07');
  });

  it('日の札は今日から5日。今日・明日は「今日／10/7 水」、ほかは「10/9／金」', () => {
    const c = dayChips('2026-10-07');
    expect(c.map((x) => x.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(c[0]).toMatchObject({ top: '今日', bottom: '10/7 水' });
    expect(c[1]).toMatchObject({ top: '明日', bottom: '10/8 木' });
    expect(c[2]).toMatchObject({ top: '10/9', bottom: '金' });
  });

  it('時刻は 空きあり／残りわずか (2席以下)／満席 (空きなし)', () => {
    const s = { startsAt: '', endsAt: '', seatTypes: [] };
    expect(slotState({ ...s, available: true, remainingTables: 4 })).toBe('open');
    expect(slotState({ ...s, available: true, remainingTables: 2 })).toBe('few');
    expect(slotState({ ...s, available: false, remainingTables: 3 })).toBe('full');
    expect(slotState({ ...s, available: true, remainingTables: 0 })).toBe('full');
    expect(hasOpenSlot([{ ...s, available: false, remainingTables: 0 }])).toBe(false);
    expect(hasOpenSlot([])).toBe(false);
  });

  it('空きの無い日の注は日付を並べる。無ければ出さない', () => {
    expect(closedNote(['2026-10-12'])).toBe('10/12（月）は空きがないため選べません');
    expect(closedNote(['2026-10-12', '2026-10-13'])).toBe('10/12（月）・10/13（火）は空きがないため選べません');
    expect(closedNote([])).toBeNull();
  });

  it('休みの理由（臨時休業・貸切・定休日・満席）を注に書き、理由ごとにまとめる', () => {
    expect(closedNote(['2026-10-12'], { '2026-10-12': 'temporary_closed' })).toBe('10/12（月）は臨時休業のため選べません');
    expect(closedNote(['2026-10-12', '2026-10-13', '2026-10-14'], { '2026-10-12': 'private_event', '2026-10-13': 'full', '2026-10-14': 'full' }))
      .toBe('10/12（月）は貸切、10/13（火）・10/14（水）は満席のため選べません');
    expect(closedNote(['2026-10-12'], { '2026-10-12': 'regular_closed' })).toBe('10/12（月）は定休日のため選べません');
    const s = { startsAt: '', endsAt: '', remainingTables: 0, available: false, seatTypes: [] };
    expect(dayReason([{ ...s, unavailableReason: 'private_event' }], undefined)).toBe('private_event');
    expect(dayReason([{ ...s, unavailableReason: 'full' }], 'temporary_closed')).toBe('temporary_closed');
    expect(dayReason([{ ...s, unavailableReason: 'full' }, { ...s, unavailableReason: 'private_event' }])).toBeUndefined();
    expect(slotLabel({ ...s, unavailableReason: 'private_event' })).toBe('貸切');
    expect(slotLabel({ ...s, unavailableReason: 'full' })).toBe('満席');
  });

  it('お席：割り当てた卓の種類、無ければ空いている候補の種類。遅れたときの決まり', () => {
    expect(seatText('table')).toBe('テーブル席（お店で決めます）');
    expect(seatText(null, ['counter', 'table'])).toBe('カウンター席・テーブル席（お店で決めます）');
    expect(seatText(null, [])).toBe('お店で決めます');
    expect(lateRule({ cancelAfterMinutes: 15, message: '15分を過ぎてご連絡がない場合は、取り消しになることがあります。' })).toBe('15分を過ぎてご連絡がない場合は、取り消しになることがあります');
    expect(lateRule({ cancelAfterMinutes: 20, message: '' })).toBe('20分を過ぎてご連絡がない場合は、取り消しになることがあります');
    expect(lateRule(null)).toBe('遅れるときや人数が変わるときは、この LINE でお店へお知らせください');
  });

  it('ご要望と電話の確かめ（口と同じ境目）', () => {
    expect(noteProblem('あ'.repeat(200))).toBe('');
    expect(noteProblem('あ'.repeat(201))).toContain('200字');
    expect(phoneProblem('')).toBe('');
    expect(phoneProblem('090－1111－2222')).toBe('');
    expect(normalizePhone(' ０９０ー００００ー２２２２ ')).toBe('09000002222');
    expect(phoneProblem('03 0000 5678')).toBe('');
    for (const invalid of ['1234567890', '090123456', '090123456789', '+819012345678', '090abcd12345678']) {
      expect(phoneProblem(invalid)).not.toBe('');
    }
    expect(phoneProblem('090-1111-abcd')).toContain('数字');
  });

  it('取り消しの締め切りは 前日・当日・それより前の日付で書き分ける', () => {
    const start = at('2026-10-07T19:00:00+09:00');
    expect(deadlineText(start, 22 * 60, TZ)).toBe('前日 21:00');
    expect(deadlineText(start, 120, TZ)).toBe('当日 17:00');
    expect(deadlineText(start, 3 * 24 * 60, TZ)).toBe('10月4日（日）19:00');
  });

  it('締め切りを過ぎた予約は LINE からの変更を案内しない', () => {
    const start = at('2026-10-07T19:00:00+09:00');
    const before = Date.parse('2026-10-06T20:00:00+09:00');
    const after = Date.parse('2026-10-06T21:00:00+09:00');
    expect(pastDeadline(start, 22 * 60, before)).toBe(false);
    expect(pastDeadline(start, 22 * 60, after)).toBe(true);
    expect(changeRule(start, 22 * 60, TZ, before)).toBe('取り消し・変更は前日 21:00 まで、この LINE からできます');
    expect(changeRule(start, 22 * 60, TZ, after)).toBe('このご予約の取り消し・変更は、お店へ直接ご連絡ください');
  });

  it('残り時間は m:ss・負は 0:00。滞在は（2時間）（1時間30分）', () => {
    expect(remainingText(552_400)).toBe('9:12');
    expect(remainingText(-5)).toBe('0:00');
    expect(stayText(at('2026-10-07T19:00:00+09:00'), at('2026-10-07T21:00:00+09:00'))).toBe('（2時間）');
    expect(stayText(at('2026-10-07T19:00:00+09:00'), at('2026-10-07T20:30:00+09:00'))).toBe('（1時間30分）');
  });

  it('これからの予約だけを早い順に。取り消し・過ぎた・期限切れの仮押さえは外す', () => {
    const now = Date.parse('2026-10-07T09:00:00+09:00');
    const base = { storeId: 's', endsAt: '', guestCount: 2, version: 1, holdExpiresAt: null, note: null, customerPhone: null, seatType: null };
    const rows = [
      { ...base, id: 'late', startsAt: at('2026-10-09T18:00:00+09:00'), status: 'confirmed' },
      { ...base, id: 'early', startsAt: at('2026-10-08T18:00:00+09:00'), status: 'confirmed' },
      { ...base, id: 'gone', startsAt: at('2026-10-06T18:00:00+09:00'), status: 'confirmed' },
      { ...base, id: 'cancel', startsAt: at('2026-10-10T18:00:00+09:00'), status: 'cancelled' },
      { ...base, id: 'held', startsAt: at('2026-10-10T18:00:00+09:00'), status: 'pending', holdExpiresAt: at('2026-10-07T09:05:00+09:00') },
      { ...base, id: 'lapsed', startsAt: at('2026-10-10T18:00:00+09:00'), status: 'pending', holdExpiresAt: at('2026-10-07T08:55:00+09:00') },
    ];
    expect(upcomingBookings(rows, now).map((r) => r.id)).toEqual(['early', 'late', 'held']);
  });

  it('失敗の中身は出さず、理由ごとの1文にする', () => {
    expect(seatErrorMessage({ status: 409, body: { error: 'slot_conflict' } })).toContain('埋まりました');
    expect(seatErrorMessage({ status: 409, body: { error: 'hold_expired' } })).toContain('時間が過ぎました');
    expect(seatErrorMessage({ status: 403, body: { error: 'self_deadline_passed' } })).toContain('締め切り');
    expect(seatErrorMessage(new Error('API 500: {"error":"booking_failed"}'))).not.toMatch(/API|500|booking_failed/);
  });
});
