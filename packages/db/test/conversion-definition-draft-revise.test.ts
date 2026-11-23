import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import { applyConversionTestSchema } from './conversion-test-schema.js';
import { asD1 } from './d1-test-helper.js';
import {
  createConversionDefinition,
  getConversionDefinitionDetail,
  publishConversionDefinition,
  reviseConversionDefinition,
  stopConversionDefinition,
} from '../src/conversion-definitions/index.js';

/*
 * 下書きの編集を許しつつ、認可・版・状態の検査を保つ。
 * 下書きは更新条件にも含め、競合だけを409とし、停止済みは拒否する。
 */

const SCOPE = { allowedAccountIds: ['acc-1'], includeUnassigned: false };

function setup(): DatabaseType.Database {
  const db = new Database(':memory:');
  applyConversionTestSchema(db);
  db.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('acc-1', 'channel-acc-1', 'Test Account', 'token', 'secret')`,
  ).run();
  return db;
}

async function createPoint(
  db: DatabaseType.Database,
  name: string,
  options: { draft?: boolean } = {},
): Promise<string> {
  const created = await createConversionDefinition(asD1(db), {
    name,
    sourceType: 'form_submitted',
    sourceConfig: {},
    measureMethod: 'webhook',
    deduplicationMode: 'every',
    valueMode: 'fixed',
    fixedValue: 100,
    reversalPolicy: 'none',
    attributionDays: 7,
    lineAccountId: 'acc-1',
    usages: [],
    staffId: 'staff-1',
    draft: options.draft,
  });
  return created!.id;
}

function addUsage(db: DatabaseType.Database, pointId: string): void {
  db.prepare(
    `INSERT INTO conversion_definition_usages
       (id, conversion_point_id, definition_version, line_account_id, ref_kind, ref_id, created_by, created_at, updated_at)
     VALUES (?, ?, 1, 'acc-1', 'scenario', 'scenario-1', 'staff-1', '2026-09-01', '2026-09-01')`,
  ).run(`usage-${pointId}`, pointId);
}

function pointState(db: DatabaseType.Database, id: string) {
  return db.prepare('SELECT status, version, name, attribution_days FROM conversion_points WHERE id = ?')
    .get(id) as { status: string; version: number; name: string; attribution_days: number | null };
}

function revisionCount(db: DatabaseType.Database, pointId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM conversion_definition_revisions WHERE conversion_point_id = ?')
    .get(pointId) as { n: number }).n;
}

function usageVersion(db: DatabaseType.Database, pointId: string): number {
  return (db.prepare('SELECT definition_version AS v FROM conversion_definition_usages WHERE conversion_point_id = ?')
    .get(pointId) as { v: number }).v;
}

function revision(pointId: string, expectedVersion: number, name: string) {
  return {
    id: pointId, scope: SCOPE, expectedVersion, staffId: 'staff-1', name,
    sourceType: 'form_submitted', sourceConfig: {}, measureMethod: 'webhook' as const,
    deduplicationMode: 'every' as const, valueMode: 'fixed' as const, fixedValue: 500,
    reversalPolicy: 'none' as const, attributionDays: 14,
  };
}

describe('下書きの成果地点の編集（CONVERSION-07）', () => {
  it('下書きを正常に編集でき、版が進んでも下書きのまま・利用先も次の版へ移る', async () => {
    const db = setup();
    const d1 = asD1(db);
    const id = await createPoint(db, '下書きの地点', { draft: true });
    addUsage(db, id);

    const result = await reviseConversionDefinition(d1, revision(id, 1, '下書きの地点（改）'));
    expect(result.version).toBe(2);
    expect(result.movedUsages).toBe(1);

    const state = pointState(db, id);
    // 名前・日数は編集後の値が保持され、状態は下書きのまま。
    expect(state).toEqual({ status: 'draft', version: 2, name: '下書きの地点（改）', attribution_days: 14 });
    // 監査と利用先の付け替えも同じ版で動く。
    expect(revisionCount(db, id)).toBe(1);
    expect(usageVersion(db, id)).toBe(2);
  });

  it('編集後の再取得でも名前・日数・下書き状態が保持されている', async () => {
    const db = setup();
    const d1 = asD1(db);
    const id = await createPoint(db, '下書きの地点', { draft: true });
    await reviseConversionDefinition(d1, revision(id, 1, '再訪で見える名前'));

    const detail = await getConversionDefinitionDetail(d1, id, SCOPE);
    expect(detail?.status).toBe('draft');
    expect(detail?.state).toBe('draft');
    expect(detail?.name).toBe('再訪で見える名前');
    expect(detail?.attributionDays).toBe(14);
    expect(detail?.version).toBe(2);
  });

  it('下書きを編集してから公開すると計測中になり、その後も編集できる', async () => {
    const db = setup();
    const d1 = asD1(db);
    const id = await createPoint(db, '下書きの地点', { draft: true });
    await reviseConversionDefinition(d1, revision(id, 1, '下書きの地点（改）'));

    const published = await publishConversionDefinition(d1, {
      id, scope: SCOPE, expectedVersion: 2, staffId: 'staff-1',
    });
    expect(published).toMatchObject({ status: 'active', version: 3 });

    const edited = await reviseConversionDefinition(d1, revision(id, 3, '公開後の編集'));
    expect(edited.version).toBe(4);
    expect(pointState(db, id)).toMatchObject({ status: 'active', version: 4, name: '公開後の編集' });
  });

  it('真の版競合だけが409になり、副作用は残さない', async () => {
    const db = setup();
    const d1 = asD1(db);
    const id = await createPoint(db, '下書きの地点', { draft: true });
    addUsage(db, id);

    await expect(reviseConversionDefinition(d1, revision(id, 99, '別の版からの編集')))
      .rejects.toMatchObject({ code: 'version_conflict', status: 409 });
    expect(pointState(db, id)).toEqual({ status: 'draft', version: 1, name: '下書きの地点', attribution_days: 7 });
    expect(revisionCount(db, id)).toBe(0);
    expect(usageVersion(db, id)).toBe(1);
  });

  it('停止済みの地点は編集を拒否する', async () => {
    const db = setup();
    const d1 = asD1(db);
    const id = await createPoint(db, '地点A');
    await stopConversionDefinition(d1, { id, scope: SCOPE, expectedVersion: 1, staffId: 'staff-1' });

    await expect(reviseConversionDefinition(d1, revision(id, 2, '停止後の編集')))
      .rejects.toMatchObject({ code: 'definition_stopped', status: 409 });
    expect(pointState(db, id)).toMatchObject({ status: 'stopped', version: 2, name: '地点A' });
    expect(revisionCount(db, id)).toBe(0);
  });

  it('同じアカウント内で名前が重なる編集は真の409を返す', async () => {
    const db = setup();
    const d1 = asD1(db);
    await createPoint(db, '使われている名前');
    const id = await createPoint(db, '下書きの地点', { draft: true });

    await expect(reviseConversionDefinition(d1, revision(id, 1, '使われている名前')))
      .rejects.toMatchObject({ code: 'duplicate_name', status: 409 });
    expect(pointState(db, id)).toMatchObject({ status: 'draft', version: 1, name: '下書きの地点' });
    expect(revisionCount(db, id)).toBe(0);
  });

  it('稼働中の地点の編集は引き続き成功する', async () => {
    const db = setup();
    const d1 = asD1(db);
    const id = await createPoint(db, '稼働中の地点');

    const result = await reviseConversionDefinition(d1, revision(id, 1, '稼働中の地点（改）'));
    expect(result.version).toBe(2);
    expect(pointState(db, id)).toMatchObject({ status: 'active', version: 2, name: '稼働中の地点（改）' });
  });
});
