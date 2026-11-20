import { describe, expect, it } from 'vitest';
import type { CommonVar, CommonVarUsageImpact } from '@line-crm/db';
import { commonVarUsageRevision, serializeCommonVarDeleteImpact, serializeCommonVarChangeImpact } from './contents-definition-serialize-common-var-delete-impact.js';

describe('一斉配信の固定版を変更影響に表示する', () => {
  it('固定値は変更せず削除の使用先として残し、確認後の固定変更を検知する', async () => {
    const variable = { id: 'v', version: 2, name: '店舗', var_key: 'shop_name', value: '新' } as CommonVar;
    const item = { kind: 'broadcast', source_table: 'broadcasts', source_id: 'b', source_parent_id: null, source_name: '案内', source_status: 'draft', source_content: '{{var.shop_name}}', is_historical: 0, fixed_version: 1, fixed_value: '旧' } as const;
    const impact = { items: [item], total: 1, blockingTotal: 1, historicalTotal: 0, unscopedFormTotal: 0, byKind: {} } as unknown as CommonVarUsageImpact;
    expect(serializeCommonVarDeleteImpact(variable, impact)).toMatchObject({ canDelete: false, items: [{ referenceMode: 'pinned', referencedVersion: 1, currentPreview: '旧', blocksDeletion: true }] });
    expect(serializeCommonVarChangeImpact(variable, impact, '新しい値').items[0]).toMatchObject({ changesOnSave: false, currentPreview: '旧', nextPreview: '旧' });
    expect(await commonVarUsageRevision(variable, impact)).not.toBe(await commonVarUsageRevision(variable, { ...impact, items: [{ ...item, fixed_version: 2 }] }));
  });
});
