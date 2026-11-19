import { describe, expect, it } from 'vitest';
import { getCommonVarUsageImpact } from '../../../../packages/db/src/common-vars/definitions.js';
import { getCommonVarUsageSummaries } from '../../../../packages/db/src/common-vars/usage-queries.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';

describe('共通情報の使用数', () => {
  it('所属不明フォームの構造化参照も一覧と影響確認で同じように数える', async () => {
    const store = createTestD1();
    store.raw.prepare('INSERT INTO forms (id, name, layout) VALUES (?, ?, ?)').run(
      'unknown-form', '未割当フォーム', JSON.stringify({ references: [{ varKey: 'hours' }] }),
    );
    store.raw.prepare('INSERT INTO forms (id, name, layout) VALUES (?, ?, ?)').run(
      'other-form', '別の参照', JSON.stringify({ references: [{ varKey: 'hours_extra' }] }),
    );
    const summary = await getCommonVarUsageSummaries(store.db, ['hours', 'hours_extra'], 'account-a');
    const impact = await getCommonVarUsageImpact(store.db, 'hours', 'account-a');
    expect(summary.get('hours')?.total).toBe(1);
    expect(summary.get('hours')?.byKind.form).toBe(1);
    expect(summary.get('hours_extra')?.total).toBe(1);
    expect(impact.unscopedFormTotal).toBe(1);
    expect(impact.blockingTotal).toBe(1);
  });
});
