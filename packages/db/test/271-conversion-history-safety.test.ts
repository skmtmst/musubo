import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConversionReport, getUrlReachConversionPoints, stopConversionPoint } from '../src/conversions/index.js';
import { asD1 } from './d1-test-helper.js';

const migration = readFileSync(
  join(import.meta.dirname, '..', 'migrations', '271_conversion_history_safety.sql'),
  'utf8',
);

function setup(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, purge_started_at TEXT, data_purged_at TEXT);
    CREATE TABLE tenant_purge_tombstone_progress (tenant_id TEXT, table_name TEXT, row_id TEXT);
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY, tenant_id TEXT);
    CREATE TABLE conversion_points (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, event_type TEXT NOT NULL, value REAL,
      measure_method TEXT NOT NULL DEFAULT 'manual', target_url TEXT,
      count_repeat INTEGER NOT NULL DEFAULT 1, attribution_days INTEGER,
      line_account_id TEXT, tenant_id TEXT, version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE conversion_events (
      id TEXT PRIMARY KEY, conversion_point_id TEXT NOT NULL REFERENCES conversion_points(id) ON DELETE CASCADE,
      friend_id TEXT NOT NULL, user_id TEXT, affiliate_code TEXT, metadata TEXT,
      affiliate_id TEXT, attributed_ref_code TEXT, approval_status TEXT, approved_at TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO conversion_points
      (id, name, event_type, value, measure_method, target_url, created_at)
    VALUES ('point-a', '購入完了', 'purchase', 1000, 'url_reach', 'https://example.com/thanks', '2026-08-01');
    INSERT INTO conversion_events
      (id, conversion_point_id, friend_id, created_at)
    VALUES ('event-a', 'point-a', 'friend-a', '2026-08-02');
  `);
  sqlite.exec(migration);
  return sqlite;
}

describe('成果地点と過去実績の安全性', () => {
  it('単価を変えても過去成果の金額を変えない', async () => {
    const sqlite = setup();
    sqlite.prepare('UPDATE conversion_points SET value = 9000 WHERE id = ?').run('point-a');
    const report = await getConversionReport(asD1(sqlite));
    expect(report[0]).toMatchObject({ totalCount: 1, totalValue: 1000 });
  });

  it('停止後も過去成果を残し、新しいURL計測から外す', async () => {
    const sqlite = setup();
    await stopConversionPoint(asD1(sqlite), 'point-a', 1);
    expect(sqlite.prepare('SELECT status FROM conversion_points WHERE id = ?').get('point-a'))
      .toEqual({ status: 'stopped' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM conversion_events').get()).toEqual({ n: 1 });
    expect(() => sqlite.prepare('DELETE FROM conversion_points WHERE id = ?').run('point-a'))
      .toThrow(/must be stopped/);
    expect(await getUrlReachConversionPoints(
      asD1(sqlite), 'https://example.com/thanks?utm_source=line', null,
    )).toEqual([]);
  });

  it('同じ成果地点と冪等キーの記録を重複保存できない', () => {
    const sqlite = setup();
    const insert = sqlite.prepare(`
      INSERT INTO conversion_events
        (id, conversion_point_id, friend_id, created_at, idempotency_key)
      VALUES (?, 'point-a', 'friend-a', '2026-08-03', ?)
    `);
    insert.run('event-b', 'order-1:version-1');
    expect(() => insert.run('event-c', 'order-1:version-1')).toThrow(/UNIQUE constraint failed/);
  });
});
