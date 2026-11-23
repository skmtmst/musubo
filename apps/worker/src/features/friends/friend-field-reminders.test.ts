import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/restaurant-followup-engine-approval.js',()=>({readFollowupEngineGate:async()=>({managed:false,allowed:true})}));

const getFriendFieldReminders = vi.fn();
const getFriendsWithFieldValuePage = vi.fn();
const setFriendFieldReminderScanCursor = vi.fn();
const enrollFriendsInReminderOnce = vi.fn();

vi.mock('@line-crm/db', () => ({
  getOneTimeFriendFieldReminderRegistrants: async () => [],
  friendFieldReminderTargetStatements: () => [],
  getFriendFieldReminders: (...a: unknown[]) => getFriendFieldReminders(...a),
  getFriendsWithFieldValuePage: (...a: unknown[]) => getFriendsWithFieldValuePage(...a),
  setFriendFieldReminderScanCursor: (...a: unknown[]) => setFriendFieldReminderScanCursor(...a),
  enrollFriendsInReminderOnce: (...a: unknown[]) => enrollFriendsInReminderOnce(...a),
}));

vi.mock('../../services/feature-enforcement.js', () => ({ featureJobCanRun: async () => true }));

/*
 * 走査も公開版の対象条件で絞る。判定の中身は別試験の守備範囲。
 * 条件なしでは従来どおり登録し、判定を読まない。
 */
const getReminderTargetCondition = vi.fn();
const matchesCondition = vi.fn();

vi.mock('../../services/reminder-trigger.js', () => ({
  getReminderTargetCondition: (...a: unknown[]) => getReminderTargetCondition(...a),
}));

vi.mock('../../services/segment-query.js', () => ({
  matchesCondition: (...a: unknown[]) => matchesCondition(...a),
}));

import { processFriendFieldReminders } from './friend-field-reminders.js';

const db = {prepare:()=>({bind:()=>({first:async()=>null})})} as unknown as D1Database;
const jst = (text: string) => new Date(`${text}:00+09:00`);

function reminder(patch: Record<string, unknown> = {}) {
  return {
    id: 'rem-1',
    name: '誕生日',
    trigger_field_id: 'field-birthday',
    repeat_yearly: 1,
    leap_year_policy: 'mar1',
    line_account_id: null,
    scan_cursor: null,
    ...patch,
  };
}

beforeEach(() => {
  getFriendFieldReminders.mockReset();
  getFriendsWithFieldValuePage.mockReset();
  setFriendFieldReminderScanCursor.mockReset().mockResolvedValue(undefined);
  enrollFriendsInReminderOnce.mockReset().mockImplementation(
    async (_db: D1Database, _reminderId: string, candidates: unknown[]) => candidates.length,
  );
  getReminderTargetCondition.mockReset().mockResolvedValue(null);
  matchesCondition.mockReset().mockResolvedValue(true);
});

describe('processFriendFieldReminders', () => {
  it('リマインダが無ければ何もしない', async () => {
    getFriendFieldReminders.mockResolvedValue([]);
    const result = await processFriendFieldReminders(db, jst('2026-05-01T00:05'));
    expect(result).toEqual({ enrolled: 0, skipped: 0, scanned: 0, hasMore: false });
    expect(getFriendsWithFieldValuePage).not.toHaveBeenCalled();
  });

  describe('毎年くり返す（誕生日）', () => {
    it('生まれ年に関係なく、今年のその日をゴールに立てる', async () => {
      getFriendFieldReminders.mockResolvedValue([reminder()]);
      getFriendsWithFieldValuePage.mockResolvedValue([
        { friend_id: 'f-1', value: '1990-05-03' },
      ]);

      const result = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));

      expect(result.enrolled).toBe(1);
      expect(enrollFriendsInReminderOnce).toHaveBeenCalledWith(db, 'rem-1', [{
        friendId: 'f-1',
        // 年ごと比べると一度も当たらない。月日だけを見る。
        targetDate: '2026-05-03T00:00:00+09:00',
      }]);
    });

    it('過ぎていれば来年ぶんを立てる', async () => {
      getFriendFieldReminders.mockResolvedValue([reminder()]);
      getFriendsWithFieldValuePage.mockResolvedValue([
        { friend_id: 'f-1', value: '1990-05-03' },
      ]);

      await processFriendFieldReminders(db, jst('2026-05-04T00:05'));

      expect(enrollFriendsInReminderOnce).toHaveBeenCalledWith(
        db,
        'rem-1',
        [expect.objectContaining({ targetDate: '2027-05-03T00:00:00+09:00' })],
      );
    });

    it('同じ年に二重に立てない', async () => {
      getFriendFieldReminders.mockResolvedValue([reminder()]);
      getFriendsWithFieldValuePage.mockResolvedValue([
        { friend_id: 'f-1', value: '1990-05-03' },
      ]);
      enrollFriendsInReminderOnce.mockResolvedValue(0);

      const result = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));

      expect(result).toEqual({ enrolled: 0, skipped: 1, scanned: 1, hasMore: false });
    });
  });

  describe('2月29日生まれ（419: 3択の方針）', () => {
    const feb29Friend = [{ friend_id: 'f-29', value: '2000-02-29' }];

    it("方針'mar1'は平年に3月1日へ立てる（設定ができる前の動作）", async () => {
      getFriendFieldReminders.mockResolvedValue([reminder({ leap_year_policy: 'mar1' })]);
      getFriendsWithFieldValuePage.mockResolvedValue(feb29Friend);

      await processFriendFieldReminders(db, jst('2026-01-10T00:05'));

      expect(enrollFriendsInReminderOnce).toHaveBeenCalledWith(
        db, 'rem-1',
        [expect.objectContaining({ targetDate: '2026-03-01T00:00:00+09:00' })],
      );
    });

    it("方針'feb28'は平年に2月28日へ立てる", async () => {
      getFriendFieldReminders.mockResolvedValue([reminder({ leap_year_policy: 'feb28' })]);
      getFriendsWithFieldValuePage.mockResolvedValue(feb29Friend);

      await processFriendFieldReminders(db, jst('2026-01-10T00:05'));

      expect(enrollFriendsInReminderOnce).toHaveBeenCalledWith(
        db, 'rem-1',
        [expect.objectContaining({ targetDate: '2026-02-28T00:00:00+09:00' })],
      );
    });

    it("方針'skip'は平年に立てない", async () => {
      getFriendFieldReminders.mockResolvedValue([reminder({ leap_year_policy: 'skip' })]);
      getFriendsWithFieldValuePage.mockResolvedValue(feb29Friend);

      const result = await processFriendFieldReminders(db, jst('2026-01-10T00:05'));

      // 次のゴールはうるう年の 2028-02-29。カーソル走査の時点では立てない。
      expect(enrollFriendsInReminderOnce).toHaveBeenCalledWith(
        db, 'rem-1',
        [expect.objectContaining({ targetDate: '2028-02-29T00:00:00+09:00' })],
      );
      expect(result.enrolled).toBe(1);
    });

    it('うるう年はどの方針でも2月29日へ立てる', async () => {
      for (const policy of ['feb28', 'mar1', 'skip']) {
        getFriendFieldReminders.mockResolvedValue([reminder({ leap_year_policy: policy })]);
        getFriendsWithFieldValuePage.mockResolvedValue(feb29Friend);
        enrollFriendsInReminderOnce.mockClear();

        await processFriendFieldReminders(db, jst('2028-01-10T00:05'));

        expect(enrollFriendsInReminderOnce).toHaveBeenCalledWith(
          db, 'rem-1',
          [expect.objectContaining({ targetDate: '2028-02-29T00:00:00+09:00' })],
        );
      }
    });
  });

  describe('くり返さない（契約更新日など）', () => {
    it('その日が今日なら立てる', async () => {
      getFriendFieldReminders.mockResolvedValue([reminder({ repeat_yearly: 0 })]);
      getFriendsWithFieldValuePage.mockResolvedValue([
        { friend_id: 'f-1', value: '2026-05-03' },
      ]);

      const result = await processFriendFieldReminders(db, jst('2026-05-03T00:05'));

      expect(result.enrolled).toBe(1);
    });

    it('W7: 未来の基準日は当日を待たず、事前の通に間に合うよう立てる', async () => {
      getFriendFieldReminders.mockResolvedValue([reminder({ repeat_yearly: 0 })]);
      getFriendsWithFieldValuePage.mockResolvedValue([
        { friend_id: 'f-1', value: '2026-05-03' },
      ]);

      const result = await processFriendFieldReminders(db, jst('2026-05-02T00:05'));

      expect(result).toEqual({ enrolled: 1, skipped: 0, scanned: 1, hasMore: false });
      expect(enrollFriendsInReminderOnce).toHaveBeenCalledWith(db, 'rem-1', [{ friendId: 'f-1', targetDate: '2026-05-03T00:00:00+09:00' }]);
    });

    it('過去の日付や存在しない日付を登録しない', async () => {
      getFriendFieldReminders.mockResolvedValue([reminder({ repeat_yearly: 0 })]);
      getFriendsWithFieldValuePage.mockResolvedValue([
        { friend_id: 'past', value: '2026-04-30' }, { friend_id: 'invalid', value: '2026-02-30' },
      ]);
      expect(await processFriendFieldReminders(db, jst('2026-05-02T00:05')))
        .toEqual({ enrolled: 0, skipped: 2, scanned: 2, hasMore: false });
    });
  });

  it('読めない値の人は飛ばして、残りは続ける', async () => {
    getFriendFieldReminders.mockResolvedValue([reminder()]);
    getFriendsWithFieldValuePage.mockResolvedValue([
      { friend_id: 'f-1', value: '未記入' },
      { friend_id: 'f-2', value: '1988-05-03' },
    ]);

    const result = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));

    expect(result).toEqual({ enrolled: 1, skipped: 1, scanned: 2, hasMore: false });
  });

  it('1つのリマインダで転んでも、残りのリマインダは続ける', async () => {
    getFriendFieldReminders.mockResolvedValue([
      reminder({ id: 'rem-broken' }),
      reminder({ id: 'rem-ok', trigger_field_id: 'field-2' }),
    ]);
    getFriendsWithFieldValuePage
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce([{ friend_id: 'f-1', value: '1990-05-03' }]);

    const result = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));

    expect(result.enrolled).toBe(1);
  });

  it('UTC で前日になる時刻でも、日本時間の日付で見る', async () => {
    getFriendFieldReminders.mockResolvedValue([reminder({ repeat_yearly: 0 })]);
    getFriendsWithFieldValuePage.mockResolvedValue([
      { friend_id: 'f-1', value: '2026-05-03' },
    ]);

    // 2026-05-02T15:30Z = 2026-05-03 00:30 JST
    const result = await processFriendFieldReminders(db, new Date('2026-05-02T15:30:00Z'));

    expect(result.enrolled).toBe(1);
  });
});

describe('分割と再開', () => {
  it('4,000人の走査枠を複数リマインダへ均等に割り当てる', async () => {
    getFriendFieldReminders.mockResolvedValue([
      reminder({ id: 'rem-a', trigger_field_id: 'field-a', line_account_id: 'account-a' }),
      reminder({ id: 'rem-b', trigger_field_id: 'field-b', line_account_id: 'account-b' }),
    ]);
    getFriendsWithFieldValuePage.mockImplementation(
      async (
        _db: D1Database,
        fieldId: string,
        _lineAccountId: string | null,
        _after: string | null,
        limit: number,
      ) => (
        Array.from({ length: limit }, (_, index) => ({
          friend_id: `${fieldId}-friend-${index + 1}`,
          value: '1990-05-03',
        }))
      ),
    );

    const result = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));

    expect(result).toEqual({ enrolled: 4_000, skipped: 0, scanned: 4_000, hasMore: true });
    expect(getFriendsWithFieldValuePage).toHaveBeenNthCalledWith(
      1, db, 'field-a', 'account-a', null, 2_000, 'rem-a',
    );
    expect(getFriendsWithFieldValuePage).toHaveBeenNthCalledWith(
      2, db, 'field-b', 'account-b', null, 2_000, 'rem-b',
    );
  });

  it('5,001人を4,000人と1,001人の2回に分け、保存カーソルから再開する', async () => {
    const friends = Array.from({ length: 5_001 }, (_, i) => ({
      friend_id: `f-${String(i + 1).padStart(5, '0')}`,
      value: '1990-05-03',
    }));
    let cursor: string | null = null;
    getFriendFieldReminders.mockImplementation(async () => [reminder({ scan_cursor: cursor })]);
    getFriendsWithFieldValuePage.mockImplementation(
      async (
        _db: D1Database,
        _fieldId: string,
        _lineAccountId: string | null,
        after: string | null,
        limit: number,
      ) => {
        const start = after === null
          ? 0
          : friends.findIndex((friend) => friend.friend_id === after) + 1;
        return friends.slice(start, start + limit);
      },
    );
    setFriendFieldReminderScanCursor.mockImplementation(
      async (_db: D1Database, _reminderId: string, next: string | null) => {
        cursor = next;
      },
    );

    const first = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));
    const second = await processFriendFieldReminders(db, jst('2026-04-02T00:05'));

    expect(first).toEqual({ enrolled: 4_000, skipped: 0, scanned: 4_000, hasMore: true });
    expect(second).toEqual({ enrolled: 1_001, skipped: 0, scanned: 1_001, hasMore: false });
    expect(getFriendsWithFieldValuePage).toHaveBeenNthCalledWith(
      2,
      db,
      'field-birthday',
      null,
      'f-04000',
      4_000,
      'rem-1',
    );
    expect(cursor).toBeNull();
  });

  it('カーソル保存前に止まったページを再実行しても登録数を増やさない', async () => {
    getFriendFieldReminders.mockResolvedValue([reminder()]);
    getFriendsWithFieldValuePage.mockResolvedValue([
      { friend_id: 'f-1', value: '1990-05-03' },
    ]);
    enrollFriendsInReminderOnce
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    setFriendFieldReminderScanCursor
      .mockRejectedValueOnce(new Error('cursor write failed'))
      .mockResolvedValueOnce(undefined);

    const first = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));
    const resumed = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));

    expect(first).toEqual({ enrolled: 1, skipped: 0, scanned: 1, hasMore: true });
    expect(resumed).toEqual({ enrolled: 0, skipped: 1, scanned: 1, hasMore: false });
  });

  describe('公開版の対象条件', () => {
    const CONDITION = { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-1' }] };

    function birthdayPage() {
      getFriendFieldReminders.mockResolvedValue([reminder()]);
      getFriendsWithFieldValuePage.mockResolvedValue([
        { friend_id: 'f-1', value: '1990-05-03' },
      ]);
    }

    it('条件なしでは判定を読まず従来どおり登録する', async () => {
      birthdayPage();
      const result = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));
      expect(result.enrolled).toBe(1);
      expect(getReminderTargetCondition).toHaveBeenCalledWith(db, 'rem-1');
      expect(matchesCondition).not.toHaveBeenCalled();
      expect(enrollFriendsInReminderOnce).toHaveBeenCalledWith(db, 'rem-1', [{
        friendId: 'f-1',
        targetDate: '2026-05-03T00:00:00+09:00',
      }]);
    });

    it('条件に当てはまる友だちは登録する', async () => {
      birthdayPage();
      getReminderTargetCondition.mockResolvedValue(CONDITION);
      matchesCondition.mockResolvedValue(true);
      const result = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));
      expect(result.enrolled).toBe(1);
      expect(matchesCondition).toHaveBeenCalledWith(db, 'f-1', CONDITION);
    });

    it('条件に外れる友だちは登録せず、走査は止めない', async () => {
      birthdayPage();
      getReminderTargetCondition.mockResolvedValue(CONDITION);
      matchesCondition.mockResolvedValue(false);
      const result = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));
      expect(result).toEqual({ enrolled: 0, skipped: 1, scanned: 1, hasMore: false });
      expect(enrollFriendsInReminderOnce).toHaveBeenCalledWith(db, 'rem-1', []);
      // カーソルは進める。外れた1人が後続を止めない。
      expect(setFriendFieldReminderScanCursor).toHaveBeenCalled();
    });

    it('判定で転んでもその1人だけ飛ばして続ける', async () => {
      birthdayPage();
      getReminderTargetCondition.mockResolvedValue(CONDITION);
      matchesCondition.mockRejectedValueOnce(new Error('D1 gone'));
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const result = await processFriendFieldReminders(db, jst('2026-04-01T00:05'));
        expect(result).toEqual({ enrolled: 0, skipped: 1, scanned: 1, hasMore: false });
        expect(quiet).toHaveBeenCalled();
      } finally {
        quiet.mockRestore();
      }
    });
  });
});
