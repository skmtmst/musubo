import { describe, expect, it } from 'vitest';
import {
  NORMAL_MUSUBO_CONDITION, applyMusuboConditionAtApproval,
  lineBasicDiscountForDate, musuboConditionPreview, type MusuboConditionDefinition,
} from './musubo-condition.js';

const special: MusuboConditionDefinition = {
  ...NORMAL_MUSUBO_CONDITION,
  id: 'special-a',
  internalName: '特別条件A',
  trialPeriod: { unit: 'months', value: 3 },
  lineBasicDiscountPercent: 50,
  allowedCompanyName: '株式会社サンプルフード',
  approvalUseUntil: '2026-12-31',
};

describe('運営が承認時に選ぶ利用条件', () => {
  it('通常30日と特別3か月の料金例を分け、割引はLINE基本料金だけにかける', () => {
    expect(musuboConditionPreview(NORMAL_MUSUBO_CONDITION)).toEqual({ oneLineMonthlyYen: 5_900, twoLineMonthlyYen: 19_300 });
    expect(musuboConditionPreview(special)).toEqual({ oneLineMonthlyYen: 2_950, twoLineMonthlyYen: 12_400 });
  });

  it('承認された会社に条件のスナップショットを保存する', () => {
    const definition = { ...special, schedule: { ...special.schedule } };
    const applied = applyMusuboConditionAtApproval(definition, {
      companyName: '株式会社 サンプルフード', approvedAt: '2026-11-08',
    });
    definition.schedule.firstLineYen = 9_900;
    expect(applied).toMatchObject({ sourceConditionId: 'special-a', lineBasicDiscountPercent: 50, trialPeriod: { unit: 'months', value: 3 } });
    expect(applied.schedule.firstLineYen).toBe(5_900);
  });

  it('無効条件・会社違い・承認期限超過を拒否する', () => {
    expect(() => applyMusuboConditionAtApproval({ ...special, status: 'inactive' }, {
      companyName: special.allowedCompanyName!, approvedAt: '2026-11-08',
    })).toThrow(/Inactive/);
    expect(() => applyMusuboConditionAtApproval(special, {
      companyName: '別の会社', approvedAt: '2026-11-08',
    })).toThrow(/restricted/);
    expect(() => applyMusuboConditionAtApproval(special, {
      companyName: special.allowedCompanyName!, approvedAt: '2027-01-01',
    })).toThrow(/deadline/);
  });

  it('個別見積もりに引き継ぐ11個目以降の単価と友だち基準も検証する', () => {
    expect(() => musuboConditionPreview({ ...special, schedule: {
      ...special.schedule, eleventhAndLaterLineYen: -1,
    } })).toThrow(/eleventhAndLaterLineYen/);
    expect(() => musuboConditionPreview({ ...special, schedule: {
      ...special.schedule, friendAllowanceForElevenOrMore: -10,
    } })).toThrow(/friendAllowanceForElevenOrMore/);
  });

  it('期間限定割引は終了日までは基本料金へ適用し、翌日から外す', () => {
    const applied = applyMusuboConditionAtApproval({ ...special, discountEndsOn: '2027-01-31' }, {
      companyName: special.allowedCompanyName!, approvedAt: '2026-11-08',
    });
    expect(lineBasicDiscountForDate(applied, '2027-01-31')).toBe(50);
    expect(lineBasicDiscountForDate(applied, '2027-02-01')).toBe(0);
  });

  it('割引終了後に古い特別条件を承認しない', () => {
    expect(() => applyMusuboConditionAtApproval({ ...special, discountEndsOn: '2026-11-07' }, {
      companyName: special.allowedCompanyName!, approvedAt: '2026-11-08',
    })).toThrow(/discount has already ended/);
    expect(() => applyMusuboConditionAtApproval({ ...special, discountEndsOn: '2026-11-08' }, {
      companyName: special.allowedCompanyName!, approvedAt: '2026-11-08',
    })).not.toThrow();
  });
});
