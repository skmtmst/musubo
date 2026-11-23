import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  isExclusionSavable,
  readConversionExclusion,
} from './conversion-exclusions.js';
import { previewConversionDefinition } from './conversion-definitions/index.js';
import { recordConversionSourceEvent } from './conversion-event-sources.js';
import { trackConversion } from './conversions/index.js';

/*
 * 「数えない条件」・「注文金額と金額なし」の試験。
 *
 * 実SQLite(bootstrap.sql)で、記録と試算の両方を見る。件数だけを見ると
 * 絞り込みを外しても緑のままになる箇所があるため、値・理由文・除外数
 * まで確認し、対象の判断と説明が一致することを確かめる。
 */

const packageRoot = join(import.meta.dirname, '..');
const bootstrap = readFileSync(join(packageRoot, 'bootstrap.sql'), 'utf8');

function asD1(sqlite: Database.Database): D1Database {
  function prepare(query: string): D1PreparedStatement {
    const statement = sqlite.prepare(query);
    const bound = (params: unknown[]): D1PreparedStatement => ({
      bind: (...next: unknown[]) => bound(next),
      async all<T>() {
        return { results: statement.all(...params) as T[], success: true, meta: {} };
      },
      async first<T>() {
        return (statement.get(...params) as T | undefined) ?? null;
      },
      async run<T>() {
        const result = statement.run(...params);
        return { success: true, meta: { changes: result.changes }, results: [] } as T;
      },
    } as unknown as D1PreparedStatement);
    return bound([]);
  }
  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  } as unknown as D1Database;
}

let sqlite: Database.Database;
let db: D1Database;

const VIP_EXCLUSION = {
  operator: 'AND',
  rules: [{ type: 'tag_exists', value: 'tag-test' }],
};

function addPoint(
  id: string,
  over: {
    eventType?: string;
    valueMode?: 'source' | 'fixed' | 'none';
    value?: number | null;
    sourceConfig?: Record<string, unknown>;
  } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO conversion_points
         (id, name, event_type, value, status, measure_method, count_repeat,
          line_account_id, tenant_id, source_config_json, deduplication_mode, value_mode)
       VALUES (?, ?, ?, ?, 'active', 'webhook', 1, 'account-a', 'tenant-1', ?, 'every', ?)`,
    )
    .run(
      id,
      id,
      over.eventType ?? 'tag_added',
      over.value ?? null,
      JSON.stringify(over.sourceConfig ?? {}),
      over.valueMode ?? 'fixed',
    );
}

function valueOf(pointId: string, friendId: string): number | null | undefined {
  const row = sqlite
    .prepare(
      `SELECT value_snapshot FROM conversion_events
        WHERE conversion_point_id = ? AND friend_id = ?`,
    )
    .get(pointId, friendId) as { value_snapshot: number | null } | undefined;
  return row?.value_snapshot;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(bootstrap);
  sqlite.pragma('foreign_keys = OFF');
  sqlite.exec(`
    INSERT OR IGNORE INTO tenants (id, name) VALUES ('tenant-1', 'T1');
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, tenant_id, is_active)
    VALUES ('account-a', 'ch-a', 'A店', 'tok-a', 'sec-a', 'tenant-1', 1);
    INSERT INTO friends (id, line_user_id, line_account_id, display_name, is_following)
    VALUES ('friend-1', 'U0123456789abcdef0123456789abcdef', 'account-a', '一郎', 1),
           ('friend-2', 'Uabcdef0123456789abcdef0123456789ab', 'account-a', '次郎', 1);
    INSERT INTO tags (id, name) VALUES ('tag-test', 'テスト');
    INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-2', 'tag-test');
  `);
  db = asD1(sqlite);
});

describe('readConversionExclusion', () => {
  it('空・壊れた値は除外なし', () => {
    expect(readConversionExclusion(null).condition).toBeNull();
    expect(readConversionExclusion({}).condition).toBeNull();
    expect(readConversionExclusion({ exclusion: { operator: 'AND' } }).invalid).toBe(true);
  });

  it('旧 excludedCondition 文字列はメモへ移し、条件にはしない', () => {
    const read = readConversionExclusion({ triggerKind: 'tag', excludedCondition: 'テスト注文をのぞく' });
    expect(read.condition).toBeNull();
    expect(read.memo).toBe('テスト注文をのぞく');
    expect(read.legacyMemoMigrated).toBe(true);
    expect(read.invalid).toBe(false);
  });

  it('exclusionMemo はそのままメモになり、記録に影響しない', () => {
    const read = readConversionExclusion({ exclusionMemo: '運用メモ' });
    expect(read.memo).toBe('運用メモ');
    expect(read.condition).toBeNull();
    expect(read.legacyMemoMigrated).toBe(false);
  });

  it('有効な除外条件はそのまま返す', () => {
    const read = readConversionExclusion({ exclusion: VIP_EXCLUSION });
    expect(read.invalid).toBe(false);
    expect(read.condition).toEqual({ operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-test' }] });
  });

  it('書きかけ・内部用の条件は不正として扱う', () => {
    expect(readConversionExclusion({
      exclusion: { operator: 'AND', rules: [{ type: 'tag_exists', value: '' }] },
    }).invalid).toBe(true);
    expect(readConversionExclusion({
      exclusion: { operator: 'AND', rules: [{ type: 'friend_id_in', value: ['friend-1'] }] },
    }).invalid).toBe(true);
    expect(readConversionExclusion({ exclusion: { operator: 'MAYBE', rules: [] } }).invalid).toBe(true);
  });

  it('空の条件は除外なし(不正ではない)', () => {
    const read = readConversionExclusion({ exclusion: { operator: 'AND', rules: [] } });
    expect(read.condition).toBeNull();
    expect(read.invalid).toBe(false);
  });
});

describe('isExclusionSavable', () => {
  it('無い・空・有効は保存可、壊れたものは不可', () => {
    expect(isExclusionSavable({})).toBe(true);
    expect(isExclusionSavable({ exclusion: VIP_EXCLUSION })).toBe(true);
    expect(isExclusionSavable({ exclusion: { operator: 'AND', rules: [] } })).toBe(true);
    expect(isExclusionSavable({ exclusion: { operator: 'AND' } })).toBe(false);
    expect(isExclusionSavable({
      exclusion: { operator: 'AND', rules: [{ type: 'tag_exists', value: '' }] },
    })).toBe(false);
  });
});

describe('trackConversion の金額(R42)', () => {
  it('fixed は地点の決まった額になり、起点の申告で上書きされない', async () => {
    addPoint('p-fixed', { valueMode: 'fixed', value: 3000 });
    await trackConversion(db, { conversionPointId: 'p-fixed', friendId: 'friend-1', value: 9999 });
    expect(valueOf('p-fixed', 'friend-1')).toBe(3000);
  });

  it('source は起点の申告値を写す', async () => {
    addPoint('p-source', { valueMode: 'source' });
    await trackConversion(db, { conversionPointId: 'p-source', friendId: 'friend-1', value: 5400 });
    expect(valueOf('p-source', 'friend-1')).toBe(5400);
  });

  it('source で申告が無い・不正なときは0ではなく金額なし(NULL)', async () => {
    addPoint('p-missing', { valueMode: 'source' });
    await trackConversion(db, { conversionPointId: 'p-missing', friendId: 'friend-1' });
    expect(valueOf('p-missing', 'friend-1')).toBeNull();
  });

  it('source で負の申告は金額なし(NULL)', async () => {
    addPoint('p-negative', { valueMode: 'source' });
    await trackConversion(db, { conversionPointId: 'p-negative', friendId: 'friend-1', value: -100 });
    expect(valueOf('p-negative', 'friend-1')).toBeNull();
  });

  it('none は申告があっても金額なし(NULL)', async () => {
    addPoint('p-none', { valueMode: 'none' });
    await trackConversion(db, { conversionPointId: 'p-none', friendId: 'friend-1', value: 5400 });
    expect(valueOf('p-none', 'friend-1')).toBeNull();
  });
});

describe('数えない条件の記録(R40)', () => {
  it('条件に当てはまる友だちは数えず、当てはまらない友だちは数える', async () => {
    addPoint('p-ex', { sourceConfig: { exclusion: VIP_EXCLUSION } });
    await expect(trackConversion(db, {
      conversionPointId: 'p-ex', friendId: 'friend-2',
    })).rejects.toThrow('conversion_excluded');
    await trackConversion(db, { conversionPointId: 'p-ex', friendId: 'friend-1' });
    expect(valueOf('p-ex', 'friend-1')).not.toBeUndefined();
  });

  it('起点の自動計測は除外を数として残し、失敗にしない', async () => {
    addPoint('p-ex', { sourceConfig: { exclusion: VIP_EXCLUSION } });
    const excluded = await recordConversionSourceEvent(db, {
      sourceType: 'tag_added', friendId: 'friend-2', sourceEventId: 'evt-ex-1',
    });
    expect(excluded).toEqual({ matched: 1, recorded: 0, failed: 0, excluded: 1, skipped: null });
    const recorded = await recordConversionSourceEvent(db, {
      sourceType: 'tag_added', friendId: 'friend-1', sourceEventId: 'evt-ex-2',
    });
    expect(recorded.recorded).toBe(1);
    expect(recorded.excluded).toBe(0);
  });

  it('壊れた条件を直書きされても記録は止めない', async () => {
    addPoint('p-broken', { sourceConfig: { exclusion: { operator: 'AND' } } });
    await trackConversion(db, { conversionPointId: 'p-broken', friendId: 'friend-2' });
    expect(valueOf('p-broken', 'friend-2')).not.toBeUndefined();
  });

  it('旧 excludedCondition 文字列だけでは除外しない(メモ扱い)', async () => {
    addPoint('p-legacy', { sourceConfig: { excludedCondition: 'テスト注文をのぞく' } });
    await trackConversion(db, { conversionPointId: 'p-legacy', friendId: 'friend-2' });
    expect(valueOf('p-legacy', 'friend-2')).not.toBeUndefined();
  });
});

describe('数えない条件の試算(R40・R42)', () => {
  function seedPreviewEvents(): void {
    addPoint('p-form', { eventType: 'form_submitted', valueMode: 'source' });
    sqlite
      .prepare(
        `INSERT INTO conversion_events
           (id, conversion_point_id, friend_id, value_snapshot, created_at)
         VALUES
           ('e1', 'p-form', 'friend-1', 5000, '2026-06-01 10:00:00'),
           ('e2', 'p-form', 'friend-1', NULL, '2026-06-02 10:00:00'),
           ('e3', 'p-form', 'friend-2', 7000, '2026-06-03 10:00:00')`,
      )
      .run();
  }

  function previewInput(sourceConfig: Record<string, unknown>) {
    return {
      scope: { allowedAccountIds: ['account-a'], includeUnassigned: false },
      lineAccountId: 'account-a',
      sourceType: 'form_submitted',
      sourceConfig,
      measureMethod: 'webhook' as const,
      deduplicationMode: 'every' as const,
      valueMode: 'source' as const,
      range: { from: '2026-01-01', to: '2026-12-31', timeZone: 'Asia/Tokyo' as const },
    };
  }

  it('除外なしは全件を数える', async () => {
    seedPreviewEvents();
    const preview = await previewConversionDefinition(db, previewInput({}));
    expect(preview.matchedCount).toBe(3);
    expect(preview.uniqueFriendCount).toBe(2);
    expect(preview.excludedCount).toBe(0);
    expect(preview.excludedReasons).toEqual([
      '金額のない過去の成果1件は金額の試算に入っていません',
    ]);
    // 金額の平均は金額のある2件だけ(5000+7000)/2=6000。
    expect(preview.estimatedValue).toBe(3 * 6000);
    expect(preview.missingValueCount).toBe(1);
  });

  it('除外ありは当てはまる過去の成果を除き、理由に件数を出す', async () => {
    seedPreviewEvents();
    const preview = await previewConversionDefinition(
      db, previewInput({ exclusion: VIP_EXCLUSION }),
    );
    expect(preview.matchedCount).toBe(2);
    expect(preview.uniqueFriendCount).toBe(1);
    expect(preview.excludedCount).toBe(1);
    expect(preview.excludedReasons).toContain(
      '「数えない条件」に当てはまる過去の成果1件を除いています',
    );
    expect(preview.estimatedValue).toBe(2 * 5000);
  });

  it('壊れた条件は全件のまま理由だけ出す', async () => {
    seedPreviewEvents();
    const preview = await previewConversionDefinition(
      db, previewInput({ exclusion: { operator: 'AND' } }),
    );
    expect(preview.matchedCount).toBe(3);
    expect(preview.uniqueFriendCount).toBe(2);
    expect(preview.excludedCount).toBe(0);
    expect(preview.excludedReasons).toContain(
      '「数えない条件」が読み取れないため、試算では全件を対象にしています',
    );
  });

  it('旧メモだけでは除かず、メモが記録に影響しないことを出す', async () => {
    seedPreviewEvents();
    const preview = await previewConversionDefinition(
      db, previewInput({ excludedCondition: 'テスト注文をのぞく' }),
    );
    expect(preview.matchedCount).toBe(3);
    expect(preview.uniqueFriendCount).toBe(2);
    expect(preview.excludedCount).toBe(0);
    expect(preview.excludedReasons).toContain(
      '以前の「数えない条件」のメモは記録に影響しません。条件として効かせるには選び直してください',
    );
  });
});
