import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildHoursParsePrompt,
  buildPatch,
  diffFieldLabel,
  effectiveHoursFor,
  emptyWeekly,
  getProfile,
  parseHoursResponse,
  patchProfile,
  specialFromGoogle,
  specialToGoogle,
  todayIn,
  validatePeriods,
  validateSpecialDay,
  weekdayOf,
  weeklyFromGoogle,
  weeklyToGoogle,
} from './google-business-profile.js';
import type { FetchLike } from './google-business.js';
type F = FetchLike;
import { holidaysOfYear, upcomingHolidays } from './jp-holidays.js';

const LOCATION = 'accounts/111/locations/222';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('営業時間の変換', () => {
  it('Googleの regularHours を曜日ごとの枠に直し、日跨ぎは開始側の曜日にまとめる', () => {
    const weekly = weeklyFromGoogle([
      { openDay: 'FRIDAY', openTime: { hours: 11 }, closeDay: 'FRIDAY', closeTime: { hours: 15 } },
      { openDay: 'FRIDAY', openTime: { hours: 18 }, closeDay: 'SATURDAY', closeTime: { hours: 2 } },
      { openDay: 'SUNDAY', openTime: { hours: 11, minutes: 30 }, closeDay: 'SUNDAY', closeTime: { hours: 24 } },
    ]);
    expect(weekly.FRIDAY).toEqual([{ open: '11:00', close: '15:00' }, { open: '18:00', close: '02:00' }]);
    expect(weekly.SUNDAY).toEqual([{ open: '11:30', close: '00:00' }]);
    expect(weekly.MONDAY).toEqual([]);
  });

  it('曜日ごとの枠を Google の形式に戻す（日跨ぎは closeDay が翌日、00:00 は 24:00）', () => {
    const weekly = emptyWeekly();
    weekly.FRIDAY = [{ open: '18:00', close: '02:00' }];
    weekly.SUNDAY = [{ open: '11:00', close: '00:00' }];
    expect(weeklyToGoogle(weekly).periods).toEqual([
      { openDay: 'FRIDAY', openTime: { hours: 18, minutes: 0 }, closeDay: 'SATURDAY', closeTime: { hours: 2, minutes: 0 } },
      { openDay: 'SUNDAY', openTime: { hours: 11, minutes: 0 }, closeDay: 'SUNDAY', closeTime: { hours: 24, minutes: 0 } },
    ]);
  });

  it('specialHours は日付ごとにまとめ、休業は closed=true で全体を送る', () => {
    const days = specialFromGoogle([
      { startDate: { year: 2026, month: 9, day: 23 }, endDate: { year: 2026, month: 9, day: 23 }, closed: true },
      { startDate: { year: 2026, month: 9, day: 25 }, openTime: { hours: 9 }, endDate: { year: 2026, month: 9, day: 25 }, closeTime: { hours: 17 } },
    ]);
    expect(days).toEqual([
      { date: '2026-09-23', closed: true, periods: [] },
      { date: '2026-09-25', closed: false, periods: [{ open: '09:00', close: '17:00' }] },
    ]);
    expect(specialToGoogle(days).specialHourPeriods).toHaveLength(2);
    expect(specialToGoogle(days).specialHourPeriods[0]).toMatchObject({ closed: true });
  });

  it('specialHours の 0:00 終了は「同日 24:00」で送り、翌日にまたがせない（翌日が24時間営業になる事故の再発防止）', () => {
    const sent = specialToGoogle([
      { date: '2026-09-29', closed: false, periods: [{ open: '17:00', close: '00:00' }] },
      { date: '2026-10-03', closed: false, periods: [{ open: '18:00', close: '02:00' }] },
    ]).specialHourPeriods;
    expect(sent[0]).toEqual({ startDate: { year: 2026, month: 9, day: 29 }, openTime: { hours: 17, minutes: 0 }, endDate: { year: 2026, month: 9, day: 29 }, closeTime: { hours: 24, minutes: 0 } });
    expect(sent[1]).toEqual({ startDate: { year: 2026, month: 10, day: 3 }, openTime: { hours: 18, minutes: 0 }, endDate: { year: 2026, month: 10, day: 4 }, closeTime: { hours: 2, minutes: 0 } });
  });

  it('Google が「翌日 0:00 まで」で返す枠は 00:00 終了として読み、送り直しても同じ意味になる（往復で変わらない）', () => {
    const fromGoogle = specialFromGoogle([
      { startDate: { year: 2026, month: 7, day: 13 }, openTime: { hours: 11 }, endDate: { year: 2026, month: 7, day: 13 }, closeTime: { hours: 15 } },
      { startDate: { year: 2026, month: 7, day: 13 }, openTime: { hours: 17 }, endDate: { year: 2026, month: 7, day: 14 }, closeTime: { hours: 0 } },
      { startDate: { year: 2026, month: 7, day: 20 }, openTime: { hours: 17 }, endDate: { year: 2026, month: 7, day: 20 }, closeTime: { hours: 24 } },
      { startDate: { year: 2026, month: 7, day: 25 }, openTime: { hours: 18 }, endDate: { year: 2026, month: 7, day: 26 }, closeTime: { hours: 2 } },
    ]);
    expect(fromGoogle).toEqual([
      { date: '2026-07-13', closed: false, periods: [{ open: '11:00', close: '15:00' }, { open: '17:00', close: '00:00' }] },
      { date: '2026-07-20', closed: false, periods: [{ open: '17:00', close: '00:00' }] },
      { date: '2026-07-25', closed: false, periods: [{ open: '18:00', close: '02:00' }] },
    ]);
    const resent = specialToGoogle(fromGoogle).specialHourPeriods;
    // 7/14・7/21 などの「翌日」に枠が生えない
    expect(resent.map((p) => `${p.startDate!.day}->${p.endDate!.day}:${p.closeTime!.hours}`)).toEqual(['13->13:15', '13->13:24', '20->20:24', '25->26:2']);
  });

  it('枠の検証：重なり・上限・日跨ぎの位置', () => {
    expect(validatePeriods([{ open: '11:00', close: '15:00' }, { open: '14:00', close: '22:00' }])).toMatchObject({ ok: false });
    expect(validatePeriods([{ open: '18:00', close: '02:00' }, { open: '11:00', close: '15:00' }])).toMatchObject({ ok: true });
    expect(validatePeriods([{ open: '22:00', close: '02:00' }, { open: '23:00', close: '23:30' }])).toMatchObject({ ok: false });
    expect(validatePeriods([{ open: '11:00', close: '15:00' }, { open: '18:00', close: '00:00' }])).toMatchObject({ ok: true });
    expect(validatePeriods([{ open: '1:00', close: '2:00' }])).toMatchObject({ ok: false });
    expect(validatePeriods([{ open: '01:00', close: '02:00' }, { open: '03:00', close: '04:00' }, { open: '05:00', close: '06:00' }, { open: '07:00', close: '08:00' }])).toMatchObject({ ok: false });
  });

  it('特別営業時間の検証：過去日・1年先・営業なのに枠なし', () => {
    expect(validateSpecialDay({ date: '2026-09-22', closed: false, periods: [{ open: '11:00', close: '15:00' }] }, '2026-09-23')).toMatchObject({ ok: false });
    expect(validateSpecialDay({ date: '2027-10-01', closed: true, periods: [] }, '2026-09-23')).toMatchObject({ ok: false });
    expect(validateSpecialDay({ date: '2026-09-25', closed: false, periods: [] }, '2026-09-23')).toMatchObject({ ok: false });
    expect(validateSpecialDay({ date: '2026-09-25', closed: true, periods: [] }, '2026-09-23')).toEqual({ ok: true });
  });

  it('日付の道具：今日（TZ）、曜日、加算', () => {
    expect(todayIn('Asia/Tokyo', new Date('2026-09-23T16:30:00Z'))).toBe('2026-09-24');
    expect(weekdayOf('2026-09-25')).toBe('FRIDAY');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
  });

  it('その日の営業時間は特別営業時間を優先する', () => {
    const regular = emptyWeekly();
    regular.FRIDAY = [{ open: '11:00', close: '15:00' }];
    expect(effectiveHoursFor({ regularHours: regular, specialHours: [] }, '2026-09-25')).toEqual({ periods: [{ open: '11:00', close: '15:00' }], closed: false, special: false });
    expect(effectiveHoursFor({ regularHours: regular, specialHours: [{ date: '2026-09-25', closed: true, periods: [] }] }, '2026-09-25')).toEqual({ periods: [], closed: true, special: true });
  });
});

describe('プロフィールAPI', () => {
  it('locations.get を readMask 付きで呼び、画面の形に直す', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return jsonResponse({
        name: 'locations/222',
        title: 'こもれび食堂 渋谷店',
        storefrontAddress: { postalCode: '150-0001', administrativeArea: '東京都', locality: '渋谷区', addressLines: ['神宮前1-2-3'] },
        phoneNumbers: { primaryPhone: '03-0000-5678' },
        websiteUri: 'https://example.jp',
        profile: { description: '紹介文' },
        openInfo: { status: 'OPEN' },
        regularHours: { periods: [{ openDay: 'MONDAY', openTime: { hours: 11 }, closeDay: 'MONDAY', closeTime: { hours: 15 } }] },
        metadata: { mapsUri: 'https://maps.google.com/?cid=1' },
      });
    };
    const profile = await getProfile({ fetch: fetch as unknown as F, accessToken: 'at' }, LOCATION);
    expect(calls[0]).toContain('/v1/locations/222?readMask=');
    expect(profile.title).toBe('こもれび食堂 渋谷店');
    expect(profile.address?.postalCode).toBe('150-0001');
    expect(profile.regularHours.MONDAY).toEqual([{ open: '11:00', close: '15:00' }]);
    expect(profile.fingerprint).toHaveLength(32);
  });

  it('patch は updateMask をその項目だけにする', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetch: FetchLike = async (url, init) => {
      captured = { url, init };
      return jsonResponse({ name: 'locations/222', profile: { description: '新しい紹介文' } });
    };
    await patchProfile({ fetch: fetch as unknown as F, accessToken: 'at' }, LOCATION, { field: 'description', value: '新しい紹介文' });
    expect(captured!.url).toContain('updateMask=profile.description');
    expect(captured!.init?.method).toBe('PATCH');
    expect(JSON.parse(String(captured!.init?.body))).toEqual({ profile: { description: '新しい紹介文' } });
    expect(buildPatch({ field: 'phone', value: '03-0000-0000' }).updateMask).toBe('phoneNumbers.primaryPhone');
    expect(buildPatch({ field: 'address', value: { postalCode: '1', administrativeArea: '東京都', locality: '渋谷区', addressLines: ['x'] } }).body).toMatchObject({ storefrontAddress: { regionCode: 'JP' } });
  });

  it('403 は no_permission、400 はメッセージ付きの invalid_request', async () => {
    const fetch: FetchLike = async () => jsonResponse({ error: { message: 'Invalid hours' } }, 400);
    await expect(getProfile({ fetch: fetch as unknown as F, accessToken: 'at' }, LOCATION)).rejects.toMatchObject({ kind: 'invalid_request', message: 'Invalid hours' });
  });

  it('R108: 変更提案の項目名を日本語にし、画面で扱わない項目も素のままにしない', () => {
    expect(diffFieldLabel('title')).toBe('店舗名');
    expect(diffFieldLabel('regularHours')).toBe('通常の営業時間');
    expect(diffFieldLabel('relationshipData')).toBe('店舗の属性');
    expect(diffFieldLabel('relationshipData.someField')).toBe('店舗の属性');
  });
});

describe('文章→変更案', () => {
  it('プロンプトに基準日・通常営業時間・祝日を入れ、入力文を信頼しないと書く', () => {
    const weekly = emptyWeekly();
    weekly.FRIDAY = [{ open: '11:00', close: '15:00' }];
    const p = buildHoursParsePrompt({ storeTitle: '店', timeZone: 'Asia/Tokyo', today: '2026-09-23', todayWeekday: 'WEDNESDAY', regularHours: weekly, text: '今週の金曜は休み', holidays: [{ date: '2026-09-23', name: '秋分の日' }] });
    expect(p.system).toContain('2026-09-23');
    expect(p.system).toContain('金: 11:00–15:00');
    expect(p.system).toContain('秋分の日');
    expect(p.system).toContain('信頼しない資料');
    expect(p.user).toBe('今週の金曜は休み');
  });

  it('AIの出力を検証し、欠けていれば null、質問は question で返す', () => {
    expect(parseHoursResponse('{"kind":"special","dates":["2026-09-25"],"closed":true,"periods":[]}')).toEqual({ kind: 'special', dates: ['2026-09-25'], weekdays: [], closed: true, periods: [], question: null });
    expect(parseHoursResponse('```json\n{"kind":"regular","weekdays":["FRIDAY"],"closed":false,"periods":[{"open":"11:00","close":"23:00"}]}\n```')).toMatchObject({ kind: 'regular', weekdays: ['FRIDAY'] });
    expect(parseHoursResponse('{"kind":"special","dates":["2026-02-30"],"closed":true}')).toBeNull();
    expect(parseHoursResponse('{"kind":"special","dates":["2026-09-25"],"closed":false,"periods":[]}')).toBeNull();
    expect(parseHoursResponse('{"kind":"question","question":"どの金曜日ですか？"}')).toMatchObject({ kind: 'question', question: 'どの金曜日ですか？' });
    expect(parseHoursResponse('わかりません')).toBeNull();
  });
});

describe('日本の祝日', () => {
  it('2026年の祝日を計算で出す（振替休日を含む）', () => {
    const h = holidaysOfYear(2026);
    const names = Object.fromEntries(h.map((x) => [x.date, x.name]));
    expect(names['2026-01-01']).toBe('元日');
    expect(names['2026-01-12']).toBe('成人の日');
    expect(names['2026-03-20']).toBe('春分の日');
    expect(names['2026-05-06']).toBe('休日（振替休日）'); // 5/3 が日曜
    expect(names['2026-07-20']).toBe('海の日');
    expect(names['2026-09-21']).toBe('敬老の日');
    expect(names['2026-09-23']).toBe('秋分の日');
    expect(names['2026-09-22']).toBe('休日（国民の休日）');
    expect(names['2026-10-12']).toBe('スポーツの日');
  });

  it('今後30日の祝日だけを返す', () => {
    expect(upcomingHolidays('2026-09-23', 30).map((h) => h.date)).toEqual(['2026-09-23', '2026-10-12']);
  });
});
