import { describe, expect, it, vi } from 'vitest';
import {
  isWithinActiveWindow,
  isCoolingDown,
  isOperatorHandling,
  jstHhmm,
  shouldReply,
  isOnRespondingDay,
} from './auto-reply-conditions.js';

describe('時間帯の判定', () => {
  const w = (from: string | null, until: string | null) => ({
    active_from: from,
    active_until: until,
  });

  it('未設定なら常に返す', () => {
    expect(isWithinActiveWindow(w(null, null), '03:00')).toBe(true);
  });

  it('日中の時間帯', () => {
    expect(isWithinActiveWindow(w('09:00', '18:00'), '12:00')).toBe(true);
    expect(isWithinActiveWindow(w('09:00', '18:00'), '08:59')).toBe(false);
    expect(isWithinActiveWindow(w('09:00', '18:00'), '20:00')).toBe(false);
  });

  it('開始は含み、終了は含まない', () => {
    // 09:00-18:00 と 18:00-22:00 を並べたとき、18:00 が両方に入らないように。
    expect(isWithinActiveWindow(w('09:00', '18:00'), '09:00')).toBe(true);
    expect(isWithinActiveWindow(w('09:00', '18:00'), '18:00')).toBe(false);
  });

  it('日をまたぐ時間帯（営業時間外の自動応答）', () => {
    // ここを単純な範囲比較にすると常に偽になり、機能が丸ごと動かない。
    const night = w('22:00', '06:00');
    expect(isWithinActiveWindow(night, '23:30')).toBe(true);
    expect(isWithinActiveWindow(night, '02:00')).toBe(true);
    expect(isWithinActiveWindow(night, '05:59')).toBe(true);
    expect(isWithinActiveWindow(night, '06:00')).toBe(false);
    expect(isWithinActiveWindow(night, '12:00')).toBe(false);
    expect(isWithinActiveWindow(night, '21:59')).toBe(false);
  });

  it('開始だけの指定は「それ以降ずっと」', () => {
    expect(isWithinActiveWindow(w('18:00', null), '20:00')).toBe(true);
    expect(isWithinActiveWindow(w('18:00', null), '17:59')).toBe(false);
  });

  it('終了だけの指定は「それまでずっと」', () => {
    expect(isWithinActiveWindow(w(null, '06:00'), '05:00')).toBe(true);
    expect(isWithinActiveWindow(w(null, '06:00'), '06:00')).toBe(false);
  });

  it('開始と終了が同じときは時間帯なしとして扱う', () => {
    // 24時間か一瞬か判別できない。応答が止まる方が害が大きいので、応答する側に倒す。
    expect(isWithinActiveWindow(w('09:00', '09:00'), '03:00')).toBe(true);
  });
});

describe('JSTの時刻', () => {
  it('UTCから9時間ずらす', () => {
    expect(jstHhmm(new Date('2026-08-15T00:30:00Z'))).toBe('09:30');
  });

  it('日付をまたいでも時刻だけ正しく出す', () => {
    expect(jstHhmm(new Date('2026-08-15T16:00:00Z'))).toBe('01:00');
  });
});

function dbReturning(value: unknown) {
  const first = vi.fn().mockResolvedValue(value);
  return {
    prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })),
    _first: first,
  } as unknown as D1Database & { _first: ReturnType<typeof vi.fn> };
}

describe('連投の抑制', () => {
  const now = new Date('2026-08-15T03:00:00Z');

  it('未設定なら問い合わせもしない', async () => {
    const db = dbReturning(null);
    expect(await isCoolingDown(db, 'f-1', null, now)).toBe(false);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('0分も「抑制しない」', async () => {
    const db = dbReturning(null);
    expect(await isCoolingDown(db, 'f-1', 0, now)).toBe(false);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('直近の自動応答があれば抑制する', async () => {
    const db = dbReturning({ 1: 1 });
    expect(await isCoolingDown(db, 'f-1', 30, now)).toBe(true);
  });

  it('直近になければ抑制しない', async () => {
    const db = dbReturning(null);
    expect(await isCoolingDown(db, 'f-1', 30, now)).toBe(false);
  });
});

describe('有人対応の判定', () => {
  it('対応中なら true', async () => {
    expect(await isOperatorHandling(dbReturning({ status: 'in_progress' }), 'f-1')).toBe(true);
  });

  it('未読は対応中ではない', async () => {
    // 誰も見ていないのに自動応答まで止まると、問い合わせが放置される。
    expect(await isOperatorHandling(dbReturning({ status: 'unread' }), 'f-1')).toBe(false);
  });

  it('解決済みも対応中ではない', async () => {
    expect(await isOperatorHandling(dbReturning({ status: 'resolved' }), 'f-1')).toBe(false);
  });

  it('トーク行が無くても落ちない', async () => {
    expect(await isOperatorHandling(dbReturning(null), 'f-1')).toBe(false);
  });
});

describe('3条件をまとめた判定', () => {
  const now = new Date('2026-08-15T03:00:00Z'); // JST 12:00
  const base = {
    id: 'rule-1',
    active_from: null,
    active_until: null,
    cooldown_minutes: null,
    skip_when_operator_active: 0,
    once_per_friend: 0,
    friend_conditions_json: null,
    response_weekdays_json: null,
    response_holiday_rule: null,
  };

  it('条件が無ければ返す', async () => {
    expect(await shouldReply(dbReturning(null), base, 'f-1', now)).toBe(true);
  });

  it('時間帯の外なら、DBを引かずに返さない', async () => {
    const db = dbReturning(null);
    const ok = await shouldReply(
      db,
      { ...base, active_from: '18:00', active_until: '22:00' },
      'f-1',
      now,
    );
    expect(ok).toBe(false);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('有人対応中は返さない', async () => {
    const db = dbReturning({ status: 'in_progress' });
    expect(
      await shouldReply(db, { ...base, skip_when_operator_active: 1 }, 'f-1', now),
    ).toBe(false);
  });

  it('設定が切ってあれば有人対応でも返す', async () => {
    const db = dbReturning({ status: 'in_progress' });
    expect(await shouldReply(db, base, 'f-1', now)).toBe(true);
    // skip が 0 なら chats を引かない。
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('抑制中は返さない', async () => {
    const db = dbReturning({ 1: 1 });
    expect(await shouldReply(db, { ...base, cooldown_minutes: 30 }, 'f-1', now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 曜日・祝日・1人につき1回
// ---------------------------------------------------------------------------

describe('応答する曜日', () => {
  const base = {
    active_from: null,
    active_until: null,
    response_weekdays_json: null,
    response_holiday_rule: null,
  };
  /** 日本時間の "YYYY-MM-DDTHH:MM" を Date にする。 */
  const jst = (text: string) => new Date(`${text}:00+09:00`);

  it('設定が無ければ、どの曜日でも応答する', () => {
    expect(isOnRespondingDay(base, jst('2026-08-20T12:00'))).toBe(true);
  });

  it('選んだ曜日だけ応答する', () => {
    // 2026-08-20 は木曜（4）、21 は金曜（5）
    const rule = { ...base, response_weekdays_json: '[4]' };
    expect(isOnRespondingDay(rule, jst('2026-08-20T12:00'))).toBe(true);
    expect(isOnRespondingDay(rule, jst('2026-08-21T12:00'))).toBe(false);
  });

  it('UTC で日付が変わる時刻でも、日本時間の曜日で見る', () => {
    // 2026-08-20T15:30Z = 2026-08-21 00:30 JST（木→金）
    const rule = { ...base, response_weekdays_json: '[5]' }; // 金
    expect(isOnRespondingDay(rule, new Date('2026-08-20T15:30:00Z'))).toBe(true);
  });

  it('読めない設定なら曜日を問わない（応答が黙って止まらないように）', () => {
    expect(isOnRespondingDay({ ...base, response_weekdays_json: '{壊れた' }, jst('2026-08-20T12:00'))).toBe(
      true,
    );
  });

  describe('祝日', () => {
    // 2026-08-11 は火曜で「山の日」。2026-08-18 は火曜の平日。
    it('include なら、選んでいない曜日でも祝日は応答する', () => {
      const rule = { ...base, response_weekdays_json: '[3]', response_holiday_rule: 'include' };
      expect(isOnRespondingDay(rule, jst('2026-08-11T12:00'))).toBe(true);
    });

    it('exclude なら、選んだ曜日でも祝日は応答しない', () => {
      const rule = { ...base, response_weekdays_json: '[2]', response_holiday_rule: 'exclude' };
      expect(isOnRespondingDay(rule, jst('2026-08-11T12:00'))).toBe(false);
      expect(isOnRespondingDay(rule, jst('2026-08-18T12:00'))).toBe(true);
    });

    /*
     * 2027年も公式の祝日で判定する（計算で出す方式）。
     * 2027-01-01 は金曜の元日、2027-02-23 は火曜の天皇誕生日、
     * 2027-01-11 は成人の日、2027-03-21 は春分の日。
     */
    it('R253 2027年元日は祝日として扱う（金曜＋除外なら止める）', () => {
      const rule = { ...base, response_weekdays_json: '[5]', response_holiday_rule: 'exclude' };
      expect(isOnRespondingDay(rule, jst('2027-01-01T12:00'))).toBe(false);
      // 同じ金曜でも平日なら応答する（2027-01-08 は金曜の平日）。
      expect(isOnRespondingDay(rule, jst('2027-01-08T12:00'))).toBe(true);
    });

    it('R253 2027年の祝日は追加でも応答する（火曜＋追加）', () => {
      const rule = { ...base, response_weekdays_json: '[2]', response_holiday_rule: 'include' };
      // 天皇誕生日（火）。選んだ曜日でなくても祝日なら応答する。
      expect(isOnRespondingDay(rule, jst('2027-02-23T12:00'))).toBe(true);
      // 成人の日（月）・春分の日（日）も祝日として応答する。
      expect(isOnRespondingDay(rule, jst('2027-01-11T12:00'))).toBe(true);
      expect(isOnRespondingDay(rule, jst('2027-03-21T12:00'))).toBe(true);
      // 振替休日（3/22・月）も休みとして応答する。
      expect(isOnRespondingDay(rule, jst('2027-03-22T12:00'))).toBe(true);
    });

    it('R253 計算の範囲外の年は祝日ではない日として扱い、警告を出す', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const rule = { ...base, response_weekdays_json: '[2]', response_holiday_rule: 'exclude' };
        // 2100-01-05 は火曜。範囲外は祝日扱いしないので応答する。
        expect(isOnRespondingDay(rule, new Date('2100-01-05T12:00:00+09:00'))).toBe(true);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('日をまたぐ時間帯', () => {
    // 「金曜 22:00〜02:00」。土曜の未明は「金曜の夜」として扱う。
    const rule = {
      active_from: '22:00',
      active_until: '02:00',
      response_weekdays_json: '[5]', // 金
      response_holiday_rule: null,
    };

    it('金曜の夜は応答する', () => {
      expect(isOnRespondingDay(rule, jst('2026-08-21T23:00'))).toBe(true);
    });

    it('土曜の未明も、前日（金）の曜日で見る', () => {
      expect(isOnRespondingDay(rule, jst('2026-08-22T01:00'))).toBe(true);
    });

    it('土曜の夜は対象外（土曜は選んでいない）', () => {
      expect(isOnRespondingDay(rule, jst('2026-08-22T23:00'))).toBe(false);
    });
  });
});
