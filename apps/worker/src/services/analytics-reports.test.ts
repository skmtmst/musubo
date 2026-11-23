import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsOverviewContext, AnalyticsReportSchedule } from '@line-crm/db';

import type { AlertRuleEvaluation } from './analytics-reports.js';

/*
 * この試験は送信用のソケット（cloudflare:sockets）を使わない。
 * xserver-mail 経由の読み込みで落ちるため、送る口だけ差し替える
 * （staff-invite.test.ts と同じ形）。
 */
vi.mock('./xserver-mail.js', () => ({ sendXServerMail: vi.fn(async () => undefined) }));

const { evaluateAlertRules, reportText } = await import('./analytics-reports.js');

/**
 * 大きな変化を検出するため、しきい値・最低件数・変化率を前期間と比べる。
 * 選んだ節の数値と、レポート一覧への行き先を通知本文に入れる。
 */

const num = (value: number | null, state = 'available') => ({ value, state, reason: null });

const friendsOf = (added: number | null, removed: number | null, state = 'available') => ({
  metrics: {
    added: num(added, state),
    removed: num(removed, state),
    net: num(added === null || removed === null ? null : added - removed, state),
  },
});

const reactionsOf = (delivered: number | null, state = 'available') => ({
  metrics: { delivered: num(delivered, state), opened: num(null, state) },
});

const blockRule = (over = {}) => ({
  metric: 'block_rate', operator: 'greater_than', threshold: 0.5, minimumSample: 20, ...over,
});

const decreaseRule = (over = {}) => ({
  metric: 'friend_adds', operator: 'decrease_percent', threshold: 20, minimumSample: 20, ...over,
});

const streakRule = (over = {}) => ({
  metric: 'conversions', operator: 'zero_streak_days', threshold: 3, minimumSample: 20, ...over,
});

const scheduleOf = (over = {}): AnalyticsReportSchedule => ({
  id: 'schedule-1', lineAccountId: 'account-1', name: '週次まとめ',
  sections: ['friends', 'reactions', 'routes', 'usage'], savedAnalysisIds: [],
  cadence: 'weekly', weekday: 1, monthDay: null, sendTime: '09:00', timeZone: 'Asia/Tokyo',
  periodDays: 7, recipients: [], channels: ['dashboard'], alertRules: [],
  status: 'active', isOneTime: false, nextRunAt: '2026-09-28T00:00:00.000Z',
  createdBy: 'u-1', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
} as AnalyticsReportSchedule);

const contextOf = (fromDate: string, toDate: string): AnalyticsOverviewContext => ({
  lineAccountId: 'account-1', timeZone: 'Asia/Tokyo', fromDate, toDate,
  from: `${fromDate}T00:00:00.000+09:00`, toExclusive: `${toDate}T00:00:00.000+09:00`,
  dataCutoffAt: '2026-09-27T09:00:00.000Z',
} as AnalyticsOverviewContext);

/** 成果の問い合わせだけに応える仮DB。 */
function conversionDb(timestamps: string[], prevTotal: number): D1Database {
  return {
    prepare(sql: string) {
      const run = () => {
        if (sql.includes('ce.created_at')) return { results: timestamps.map((created_at) => ({ created_at })) };
        return { results: [] as never[] };
      };
      return {
        bind: () => ({
          all: async () => run(),
          first: async () => (sql.includes('COUNT(*)') ? { c: prevTotal } : null),
        }),
      };
    },
  } as unknown as D1Database;
}

const neverDb = conversionDb([], 0);

describe('R77 ブロック増の条件', () => {
  it('監査の再現: 解除3・配信200としきい値0.5%で一致を知らせる', async () => {
    const current = { friends: friendsOf(200, 3), reactions: reactionsOf(200) };
    const [result] = await evaluateAlertRules(
      neverDb, scheduleOf({ alertRules: [blockRule()] }), current, {}, contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('triggered');
    expect(result.observedValue).toBe(1.5);
    expect(result.sampleSize).toBe(200);
  });

  it('しきい値以下は知らせないが、比べたことは残す', async () => {
    const current = { friends: friendsOf(200, 0), reactions: reactionsOf(200) };
    const [result] = await evaluateAlertRules(
      neverDb, scheduleOf({ alertRules: [blockRule()] }), current, {}, contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('ok');
    expect(result.observedValue).toBe(0);
  });

  it('最低件数に足りない配信では判定しない', async () => {
    const current = { friends: friendsOf(5, 2), reactions: reactionsOf(5) };
    const [result] = await evaluateAlertRules(
      neverDb, scheduleOf({ alertRules: [blockRule()] }), current, {}, contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('5件');
  });

  it('集計中の数字では判定しない', async () => {
    const current = { friends: friendsOf(200, 3), reactions: reactionsOf(200, 'partial') };
    const [result] = await evaluateAlertRules(
      neverDb, scheduleOf({ alertRules: [blockRule()] }), current, {}, contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('比べず');
  });

  it('判定に要る節がレポートに入っていなければ判定しない', async () => {
    const [result] = await evaluateAlertRules(
      neverDb, scheduleOf({ alertRules: [blockRule()] }), { friends: friendsOf(200, 3) }, {},
      contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('レポートに入っていません');
  });
});

describe('R77 友だち減少の条件', () => {
  it('前期間100人→今回70人で20%減に一致する', async () => {
    const current = { friends: friendsOf(70, 5) };
    const previous = { friends: friendsOf(100, 5) };
    const [result] = await evaluateAlertRules(
      neverDb, scheduleOf({ alertRules: [decreaseRule()] }), current, previous,
      contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('triggered');
    expect(result.observedValue).toBe(30);
    expect(result.previousValue).toBe(100);
    expect(result.currentValue).toBe(70);
  });

  it('減りが小さければ知らせない', async () => {
    const current = { friends: friendsOf(95, 5) };
    const previous = { friends: friendsOf(100, 5) };
    const [result] = await evaluateAlertRules(
      neverDb, scheduleOf({ alertRules: [decreaseRule()] }), current, previous,
      contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('ok');
    expect(result.observedValue).toBe(5);
  });

  it('前期間が0件では比べない', async () => {
    const current = { friends: friendsOf(10, 0) };
    const previous = { friends: friendsOf(0, 0) };
    const [result] = await evaluateAlertRules(
      neverDb, scheduleOf({ alertRules: [decreaseRule()] }), current, previous,
      contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('skipped');
  });
});

describe('R77 成果0件が続く条件', () => {
  it('9/22〜9/26が0件で3日続けに一致する', async () => {
    const db = conversionDb(
      ['2026-09-20T01:00:00.000Z', '2026-09-21T01:00:00.000Z'],
      25,
    );
    const [result] = await evaluateAlertRules(
      db, scheduleOf({ alertRules: [streakRule()] }), {}, {},
      contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('triggered');
    expect(result.observedValue).toBe(5);
    expect(result.sampleSize).toBe(25);
  });

  it('前期間の成果が少ないときは比べない', async () => {
    const db = conversionDb([], 5);
    const [result] = await evaluateAlertRules(
      db, scheduleOf({ alertRules: [streakRule()] }), {}, {},
      contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('5件');
  });

  it('対応していない組み合わせは判定せず理由を残す', async () => {
    const [result] = await evaluateAlertRules(
      neverDb,
      scheduleOf({ alertRules: [{ metric: 'conversions', operator: 'greater_than', threshold: 2, minimumSample: 5 }] }),
      {}, {}, contextOf('2026-09-20', '2026-09-26'), contextOf('2026-09-13', '2026-09-19'),
    );
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('まだ対応していません');
  });
});

type ReportInput = Parameters<typeof reportText>[1];

function reportOf(current: Record<string, unknown>, results: AlertRuleEvaluation[] = []): ReportInput {
  return {
    context: {
      lineAccountId: 'account-1', timeZone: 'Asia/Tokyo',
      fromDate: '2026-09-20', toDate: '2026-09-26',
      from: '2026-09-20T00:00:00.000+09:00', toExclusive: '2026-09-27T00:00:00.000+09:00',
      dataCutoffAt: '2026-09-27T09:00:00.000Z',
    },
    state: 'available' as const,
    result: {
      period: { from: '2026-09-20', to: '2026-09-26' },
      previousPeriod: { from: '2026-09-13', to: '2026-09-19' },
      timeZone: 'Asia/Tokyo',
      dataCutoffAt: '2026-09-27T09:00:00.000Z',
      current,
      previous: {},
      savedAnalyses: [],
      alertEvaluation: { state: 'evaluated', results },
    },
  };
}

describe('R78 通知本文に数値と行き先を入れる', () => {
  const richCurrent = {
    friends: friendsOf(120, 8),
    reactions: reactionsOf(1200),
    routes: {
      routes: [
        {
          name: '店頭POPのQRコード',
          friendAdds: { value: 38, state: 'available' },
          conversions: { approved: { value: 30, state: 'available' }, pending: { value: 8, state: 'available' } },
          revenue: { value: 312400, state: 'available' },
        },
        {
          name: 'Facebookフィード',
          friendAdds: { value: 10, state: 'available' },
          conversions: { approved: { value: 5, state: 'available' }, pending: { value: 0, state: 'available' } },
          revenue: { value: 0, state: 'available' },
        },
      ],
    },
    usage: { summary: { unusedItems: num(3) } },
  };

  it('監査の再現: 集計値を変えると本文が変わる', () => {
    const schedule = scheduleOf();
    const high = reportText(schedule, reportOf(richCurrent), 'https://admin.example.com');
    const lowCurrent = {
      ...richCurrent,
      friends: friendsOf(10, 2),
      reactions: reactionsOf(50),
    };
    const low = reportText(schedule, reportOf(lowCurrent), 'https://admin.example.com');
    expect(high).not.toBe(low);
    expect(high).toContain('112人増加');
    expect(high).toContain('1,200件配信');
    expect(high).toContain('成果43件');
    expect(high).toContain('売上312,400円');
    expect(high).toContain('いちばんの流入: 店頭POPのQRコード');
  });

  it('レポート一覧への行き先を付ける', () => {
    const text = reportText(scheduleOf(), reportOf(richCurrent), 'https://admin.example.com/');
    expect(text).toContain('くわしく見る: https://admin.example.com/analytics?tab=saved');
  });

  it('行き先が決められないときは従来の案内を残す', () => {
    const text = reportText(scheduleOf(), reportOf(richCurrent), null);
    expect(text).toContain('管理画面の「分析」で詳細を確認してください。');
  });

  it('条件に一致した知らせだけを本文に入れる', () => {
    const schedule = scheduleOf();
    const triggered: AlertRuleEvaluation = {
      metric: 'block_rate', operator: 'greater_than', threshold: 0.5, minimumSample: 20,
      outcome: 'triggered', observedValue: 1.5, sampleSize: 200, currentValue: 3, previousValue: null, reason: null,
    };
    const skipped: AlertRuleEvaluation = {
      metric: 'friend_adds', operator: 'decrease_percent', threshold: 20, minimumSample: 20,
      outcome: 'skipped', observedValue: null, sampleSize: 5, currentValue: 4, previousValue: 5,
      reason: '前期間の追加が5人で、判定に必要な20人に足りません',
    };
    const text = reportText(schedule, reportOf(richCurrent, [triggered, skipped]), null);
    expect(text).toContain('▼すぐの知らせ');
    expect(text).toContain('ブロック率 1.5% がしきい値 0.5% を超えました');
    expect(text).not.toContain('前期間の追加が5人');
  });

  it('一致が無ければ知らせの段を出さない', () => {
    const text = reportText(scheduleOf(), reportOf(richCurrent, []), null);
    expect(text).not.toContain('▼すぐの知らせ');
  });
});
