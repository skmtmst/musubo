/*
 * コンバージョン成果地点の作成・差替・境界の直接試験。
 *
 * - 試算は保存と同じ条件(対象URL・窓つき重複除外・取消)で数える。
 * - 利用先は実在する同じアカウントのオブジェクトだけを保存できる。
 * - 種類の違う成果地点へは差し替えられない(事前検査と削除影響の候補)。
 * - 地点と成果は統括(tenant)を持ち、別の統括の友だちへは記録しない。
 *
 * 軽量構成(conversion-test-schema)に本番と同じ列だけを用意して、
 * 本物のSQLへ当てる。
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { applyConversionTestSchema } from './conversion-test-schema.js';
import {
  addConversionDefinitionUsage,
  createConversionDefinition,
  getConversionDefinitionDeleteImpact,
  previewConversionDefinition,
  replaceConversionDefinitionUsages,
} from '../src/conversion-definitions/index.js';
import {
  createConversionPoint,
  getConversionPointById,
  getUrlReachConversionPoints,
  trackConversion,
} from '../src/conversions/index.js';
import { asD1 } from './d1-test-helper.js';

function setup(): Database.Database {
  const sqlite = new Database(':memory:');
  applyConversionTestSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, purge_started_at TEXT, data_purged_at TEXT);
    CREATE TABLE tenant_purge_tombstone_progress (tenant_id TEXT, table_name TEXT, row_id TEXT);
  `);
  sqlite.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, tenant_id)
     VALUES ('acc-1', 'ch-1', 'A店', 'tok', 'sec', 'tenant-1'),
            ('acc-2', 'ch-2', 'B店', 'tok', 'sec', 'tenant-2'),
            ('acc-d', 'ch-d', '既定店', 'tok', 'sec', ?)`,
  ).run(DEFAULT_TENANT_ID);
  sqlite.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, line_account_id, created_at, updated_at)
     VALUES ('friend-1', 'U-1', '一郎', 'acc-1', '2026-09-01', '2026-09-01'),
            ('friend-2', 'U-2', '二郎', 'acc-2', '2026-09-01', '2026-09-01'),
            ('friend-d', 'U-d', '既定の人', 'acc-d', '2026-09-01', '2026-09-01')`,
  ).run();
  return sqlite;
}

const SCOPE = { allowedAccountIds: ['acc-1'], includeUnassigned: false };
const RANGE = { from: '2026-09-01 00:00:00', to: '2026-09-30 23:59:59', timeZone: 'Asia/Tokyo' };

function definitionInput(over: Record<string, unknown> = {}) {
  return {
    name: '購入完了',
    sourceType: 'ec_order_confirmed',
    sourceConfig: {},
    measureMethod: 'webhook' as const,
    deduplicationMode: 'every' as const,
    valueMode: 'none' as const,
    reversalPolicy: 'manual' as const,
    lineAccountId: 'acc-1',
    usages: [] as Array<{ refKind: 'scenario'; refId: string }>,
    staffId: 'staff-1',
    ...over,
  };
}

async function createPoint(
  sqlite: Database.Database,
  name: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const created = await createConversionDefinition(asD1(sqlite), definitionInput({ name, ...over }));
  return created!.id;
}

function addEvent(
  sqlite: Database.Database,
  pointId: string,
  friendId: string,
  createdAt: string,
  value = 0,
): string {
  const id = `ev-${pointId}-${friendId}-${createdAt}`;
  sqlite.prepare(
    `INSERT INTO conversion_events
       (id, conversion_point_id, friend_id, created_at, value_snapshot)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, pointId, friendId, createdAt, value);
  return id;
}

describe('成果地点の利用先は同じアカウントに存在するIDだけ保存する', () => {
  it('存在しない利用先は作成ごと弾く', async () => {
    const sqlite = setup();
    await expect(createConversionDefinition(asD1(sqlite), definitionInput({
      usages: [{ refKind: 'scenario', refId: 'scenario-ghost' }],
    }))).rejects.toMatchObject({ code: 'usage_ref_not_found', status: 400 });
    // 失敗した作成は地点も残さない。
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM conversion_points').get()).toEqual({ n: 0 });
  });

  it('別アカウントの利用先は弾き、同じアカウントの実IDは通る', async () => {
    const sqlite = setup();
    sqlite.prepare(`INSERT INTO scenarios (id, line_account_id) VALUES ('sc-mine', 'acc-1'), ('sc-other', 'acc-2')`).run();

    await expect(createConversionDefinition(asD1(sqlite), definitionInput({
      usages: [{ refKind: 'scenario', refId: 'sc-other' }],
    }))).rejects.toMatchObject({ code: 'usage_ref_not_found' });

    const created = await createConversionDefinition(asD1(sqlite), definitionInput({
      usages: [{ refKind: 'scenario', refId: 'sc-mine' }],
    }));
    expect(created!.usages).toHaveLength(1);
    expect(created!.usages[0]).toMatchObject({ refKind: 'scenario', refId: 'sc-mine' });
  });

  it('あとから足す利用先も同じ確認を通る', async () => {
    const sqlite = setup();
    sqlite.prepare(`INSERT INTO funnels (id, line_account_id) VALUES ('fn-1', 'acc-1'), ('fn-x', 'acc-2')`).run();
    const id = await createPoint(sqlite, '地点A');

    await expect(addConversionDefinitionUsage(asD1(sqlite), {
      conversionPointId: id, lineAccountId: 'acc-1', expectedVersion: 1,
      refKind: 'analytics', refId: 'fn-x', staffId: 'staff-1',
    })).rejects.toMatchObject({ code: 'usage_ref_not_found' });

    const added = await addConversionDefinitionUsage(asD1(sqlite), {
      conversionPointId: id, lineAccountId: 'acc-1', expectedVersion: 1,
      refKind: 'analytics', refId: 'fn-1', staffId: 'staff-1',
    });
    expect(added.created).toBe(true);
  });
});

describe('成果地点の差し替え先は起点・計測方法・対象URLを照合する', () => {
  it('起点・計測方法・対象URLが違う置換先は409で弾く', async () => {
    const sqlite = setup();
    const source = await createPoint(sqlite, '地点A');
    const otherType = await createPoint(sqlite, '地点B', { sourceType: 'tag_added' });
    const otherMethod = await createPoint(sqlite, '地点C', {
      measureMethod: 'url_reach', sourceType: 'url_reach', targetUrl: 'https://example.com/thanks',
    });
    const compatible = await createPoint(sqlite, '地点D');

    for (const target of [otherType, otherMethod]) {
      await expect(replaceConversionDefinitionUsages(asD1(sqlite), {
        id: source, replacementId: target, scope: SCOPE,
        expectedVersion: 1, replacementExpectedVersion: 1, staffId: 'staff-1',
      })).rejects.toMatchObject({ code: 'incompatible_source_type', status: 409 });
      // 弾かれた差し替えは起点を止めない。
      expect(sqlite.prepare(`SELECT status FROM conversion_points WHERE id = ?`).get(source))
        .toEqual({ status: 'active' });
    }

    const done = await replaceConversionDefinitionUsages(asD1(sqlite), {
      id: source, replacementId: compatible, scope: SCOPE,
      expectedVersion: 1, replacementExpectedVersion: 1, staffId: 'staff-1',
    });
    expect(done).toMatchObject({ status: 'stopped', version: 2 });
  });

  it('同じ起点でも対象URLが違うurl_reach同士は差し替えられない', async () => {
    const sqlite = setup();
    const source = await createPoint(sqlite, '地点A', {
      measureMethod: 'url_reach', sourceType: 'url_reach', targetUrl: 'https://example.com/a',
    });
    const otherUrl = await createPoint(sqlite, '地点B', {
      measureMethod: 'url_reach', sourceType: 'url_reach', targetUrl: 'https://example.com/b',
    });
    await expect(replaceConversionDefinitionUsages(asD1(sqlite), {
      id: source, replacementId: otherUrl, scope: SCOPE,
      expectedVersion: 1, replacementExpectedVersion: 1, staffId: 'staff-1',
    })).rejects.toMatchObject({ code: 'incompatible_source_type' });
  });

  it('削除影響の差替え候補は同じ種類だけを出す', async () => {
    const sqlite = setup();
    const source = await createPoint(sqlite, '地点A');
    await createPoint(sqlite, '地点B', { sourceType: 'tag_added' });
    const compatible = await createPoint(sqlite, '地点C');

    const impact = await getConversionDefinitionDeleteImpact(asD1(sqlite), source, SCOPE);
    expect(impact!.replacementCandidates.map((row) => row.id)).toEqual([compatible]);
  });
});

describe('N-263 地点と成果は統括の中だけで動く', () => {
  it('作成した地点はアカウントの統括を引き継ぐ', async () => {
    const sqlite = setup();
    const id = await createPoint(sqlite, '地点A');
    expect(sqlite.prepare('SELECT tenant_id FROM conversion_points WHERE id = ?').get(id))
      .toEqual({ tenant_id: 'tenant-1' });

    // アカウントを絞らない地点は既定の統括に属する。
    const common = await createConversionPoint(asD1(sqlite), {
      name: '共通地点', eventType: 'purchase', lineAccountId: null,
    });
    expect(common.tenant_id).toBe(DEFAULT_TENANT_ID);
  });

  it('別の統括の友だちへは成果を記録しない', async () => {
    const sqlite = setup();
    const id = await createPoint(sqlite, '地点A');

    await expect(trackConversion(asD1(sqlite), {
      conversionPointId: id, friendId: 'friend-2',
    })).rejects.toThrow('conversion_account_mismatch');

    const event = await trackConversion(asD1(sqlite), {
      conversionPointId: id, friendId: 'friend-1',
    });
    expect(event.tenant_id).toBe('tenant-1');
  });

  it('URL到達の地点も統括をまたいで反応しない', async () => {
    const sqlite = setup();
    await createPoint(sqlite, '地点A', {
      measureMethod: 'url_reach', sourceType: 'url_reach', targetUrl: 'https://example.com/thanks',
    });
    await createConversionPoint(asD1(sqlite), {
      name: '共通URL地点', eventType: 'purchase', measureMethod: 'url_reach',
      targetUrl: 'https://example.com/thanks', lineAccountId: null,
    });

    const forTenant1 = await getUrlReachConversionPoints(
      asD1(sqlite), 'https://example.com/thanks?utm=x', 'acc-1',
    );
    // tenant-1 のアカウントの地点だけ。既定統括の共通地点は拾わない。
    expect(forTenant1).toHaveLength(1);
    expect(forTenant1[0].line_account_id).toBe('acc-1');

    const forDefault = await getUrlReachConversionPoints(
      asD1(sqlite), 'https://example.com/thanks?utm=x', 'acc-d',
    );
    expect(forDefault).toHaveLength(1);
    expect(forDefault[0].line_account_id).toBeNull();
  });
});

describe('N-257 試算は保存と同じ条件で数える', () => {
  it('対象URLが違う地点の成果は試算に混ぜない', async () => {
    const sqlite = setup();
    const a = await createPoint(sqlite, 'Aのページ', {
      measureMethod: 'url_reach', sourceType: 'url_reach', targetUrl: 'https://example.com/a',
    });
    const b = await createPoint(sqlite, 'Bのページ', {
      measureMethod: 'url_reach', sourceType: 'url_reach', targetUrl: 'https://example.com/b',
    });
    addEvent(sqlite, a, 'friend-1', '2026-09-05 10:00:00');
    addEvent(sqlite, b, 'friend-1', '2026-09-05 11:00:00');
    addEvent(sqlite, b, 'friend-1', '2026-09-06 11:00:00');

    const preview = await previewConversionDefinition(asD1(sqlite), {
      scope: SCOPE, lineAccountId: 'acc-1', sourceType: 'url_reach',
      measureMethod: 'url_reach', targetUrl: 'https://example.com/a',
      deduplicationMode: 'every', valueMode: 'none', reversalPolicy: 'manual',
      range: RANGE,
    });
    expect(preview.matchedCount).toBe(1);
    expect(preview.estimatedCount).toBe(1);
  });

  it('窓つき重複除外は記録時と同じ規則で過去データへあてはめる', async () => {
    const sqlite = setup();
    const point = await createPoint(sqlite, '地点A');
    // 同じ友だちの成果が 8/1・8/5・9/30。窓30日なら 8/5 は窓の中で捨て、
    // 9/30 は最後に数えた8/1から60日経っているので数える。計2件。
    addEvent(sqlite, point, 'friend-1', '2026-08-01 10:00:00');
    addEvent(sqlite, point, 'friend-1', '2026-08-05 10:00:00');
    addEvent(sqlite, point, 'friend-1', '2026-09-30 10:00:00');

    const preview = await previewConversionDefinition(asD1(sqlite), {
      scope: SCOPE, lineAccountId: 'acc-1', sourceType: 'ec_order_confirmed',
      measureMethod: 'webhook',
      deduplicationMode: 'window', deduplicationWindowDays: 30,
      valueMode: 'fixed', fixedValue: 1000, reversalPolicy: 'manual',
      range: { ...RANGE, from: '2026-08-01 00:00:00' },
    });
    expect(preview.matchedCount).toBe(3);
    expect(preview.estimatedCount).toBe(2);
    expect(preview.duplicateExcludedCount).toBe(1);
    expect(preview.estimatedValue).toBe(2000);
    expect(preview.deduplicationWindowDays).toBe(30);
  });

  it('取消を差し引く条件のときは取消台帳の件数を返す', async () => {
    const sqlite = setup();
    const point = await createPoint(sqlite, '地点A');
    const eventId = addEvent(sqlite, point, 'friend-1', '2026-09-05 10:00:00');
    sqlite.prepare(`INSERT INTO affiliate_reward_entries (id, conversion_event_id) VALUES ('re-1', ?)`).run(eventId);
    sqlite.prepare(`INSERT INTO affiliate_adjustments (id, source_entry_id, reason_type, amount_minor, created_at)
      VALUES ('adj-1', 're-1', 'cancel', -1000, '2026-09-10 00:00:00')`).run();

    const cancelled = await previewConversionDefinition(asD1(sqlite), {
      scope: SCOPE, lineAccountId: 'acc-1', sourceType: 'ec_order_confirmed',
      measureMethod: 'webhook',
      deduplicationMode: 'every', valueMode: 'none', reversalPolicy: 'source_cancelled',
      range: RANGE,
    });
    expect(cancelled.cancellationCount).toBe(1);

    const manual = await previewConversionDefinition(asD1(sqlite), {
      scope: SCOPE, lineAccountId: 'acc-1', sourceType: 'ec_order_confirmed',
      measureMethod: 'webhook',
      deduplicationMode: 'every', valueMode: 'none', reversalPolicy: 'manual',
      range: RANGE,
    });
    expect(manual.cancellationCount).toBe(0);
  });
});
