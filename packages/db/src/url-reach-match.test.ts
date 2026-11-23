import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  getUrlReachConversionPoints,
  matchesUrlReachTarget,
  normalizeUrlReachUrl,
} from './conversions/index.js';

/*
 * ページ到達のURL判定を、説明（パラメータ無視・文字どおりの
 * 前方一致）と一致させる。
 *
 * SQL の `? LIKE target_url || '%'` に任せると、
 * - 保存側の `?utm=...` が残ると同じページに当たらない
 * - 保存側の `_`・`%` が別の文字へ広がる
 * - パスの大文字・小文字を区別しない
 * ため、保存側・受信側を同じ形に整え、文字どおりの前方一致で見る。
 * 既存の設定は作り直さなくても正しく当てはまる。
 */

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

function setup(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY, tenant_id TEXT);
    CREATE TABLE conversion_points (
      id TEXT PRIMARY KEY, measure_method TEXT NOT NULL, status TEXT NOT NULL,
      target_url TEXT, line_account_id TEXT, tenant_id TEXT
    );
    INSERT INTO line_accounts (id, tenant_id)
      VALUES ('a1', 'tenant-1'), ('b1', 'tenant-2');
    INSERT INTO conversion_points (id, measure_method, status, target_url, line_account_id, tenant_id) VALUES
      ('plain', 'url_reach', 'active', 'https://example.com/thanks', 'a1', 'tenant-1'),
      ('query-saved', 'url_reach', 'active', 'https://example.com/lp?utm_source=seed', 'a1', 'tenant-1'),
      ('underscore', 'url_reach', 'active', 'https://example.com/order_done', 'a1', 'tenant-1'),
      ('percent', 'url_reach', 'active', 'https://example.com/a%20b', 'a1', 'tenant-1'),
      ('case-path', 'url_reach', 'active', 'https://example.com/Thanks', 'a1', 'tenant-1'),
      ('draft', 'url_reach', 'draft', 'https://example.com/thanks', 'a1', 'tenant-1'),
      ('other-tenant', 'url_reach', 'active', 'https://example.com/thanks', 'b1', 'tenant-2');
  `);
  return sqlite;
}

function ids(points: Array<{ id: string }>): string[] {
  return points.map((point) => point.id).sort();
}

describe('normalizeUrlReachUrl', () => {
  it('パラメータとページ内位置を外し、ホストを小文字へ揃える', () => {
    expect(normalizeUrlReachUrl('https://EXAMPLE.com/thanks?utm_source=x#sec'))
      .toBe('https://example.com/thanks');
    expect(normalizeUrlReachUrl('https://example.com/thanks#sec?x=1'))
      .toBe('https://example.com/thanks');
  });

  it('パスは文字どおりに残す', () => {
    expect(normalizeUrlReachUrl('https://example.com/Thanks')).toBe('https://example.com/Thanks');
    expect(normalizeUrlReachUrl('https://example.com/a%20b')).toBe('https://example.com/a%20b');
    expect(normalizeUrlReachUrl('https://example.com/order_done')).toBe('https://example.com/order_done');
  });

  it('壊れた形は null', () => {
    expect(normalizeUrlReachUrl('')).toBeNull();
    expect(normalizeUrlReachUrl(null)).toBeNull();
    expect(normalizeUrlReachUrl('not a url')).toBeNull();
    expect(normalizeUrlReachUrl('ftp://example.com/x')).toBeNull();
  });
});

describe('matchesUrlReachTarget', () => {
  it('クエリの有無・違いによらず同じページに当たる', () => {
    expect(matchesUrlReachTarget('https://example.com/thanks', 'https://example.com/thanks?x=1')).toBe(true);
    expect(matchesUrlReachTarget('https://example.com/thanks?utm_source=a', 'https://example.com/thanks')).toBe(true);
    expect(matchesUrlReachTarget('https://example.com/thanks?a=1', 'https://example.com/thanks?b=2')).toBe(true);
  });

  it('子ページは当たる・別ページは当たらない', () => {
    expect(matchesUrlReachTarget('https://example.com/thanks', 'https://example.com/thanks/next')).toBe(true);
    expect(matchesUrlReachTarget('https://example.com/thanks', 'https://example.com/other')).toBe(false);
  });

  it('_ と % を別の文字へ広げない', () => {
    expect(matchesUrlReachTarget('https://example.com/order_done', 'https://example.com/orderXdone')).toBe(false);
    expect(matchesUrlReachTarget('https://example.com/a%20b', 'https://example.com/aXYZ20b')).toBe(false);
  });

  it('パスは大文字・小文字を区別し、ホストは区別しない', () => {
    expect(matchesUrlReachTarget('https://example.com/Thanks', 'https://example.com/thanks')).toBe(false);
    expect(matchesUrlReachTarget('https://EXAMPLE.com/thanks', 'https://example.com/thanks')).toBe(true);
  });
});

describe('getUrlReachConversionPoints', () => {
  it('監査の7条件をすべて想定どおりに判定する', async () => {
    const db = asD1(setup());
    // plain
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/thanks', 'a1')))
      .toContain('plain');
    // 保存側のクエリは無視して同じページに当たる
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/lp', 'a1')))
      .toContain('query-saved');
    // 受信側のクエリ違いでも当たる
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/lp?x=1&y=2', 'a1')))
      .toContain('query-saved');
    // _ は別の文字へ広がらない
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/orderXdone', 'a1')))
      .not.toContain('underscore');
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/order_done', 'a1')))
      .toContain('underscore');
    // % は別の文字へ広がらない
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/aXYZ20b', 'a1')))
      .not.toContain('percent');
    // パスは大文字・小文字を区別する
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/thanks', 'a1')))
      .not.toContain('case-path');
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/Thanks', 'a1')))
      .toContain('case-path');
    // 子ページは当たる・別ページは当たらない
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/thanks/next', 'a1')))
      .toContain('plain');
    expect(ids(await getUrlReachConversionPoints(db, 'https://example.com/other', 'a1')))
      .toEqual([]);
  });

  it('下書き・別統括は拾わない（従来の範囲を保つ）', async () => {
    const db = asD1(setup());
    const found = ids(await getUrlReachConversionPoints(db, 'https://example.com/thanks', 'a1'));
    expect(found).not.toContain('draft');
    expect(found).not.toContain('other-tenant');
  });

  it('壊れた受信URLは何も返さない', async () => {
    const db = asD1(setup());
    expect(await getUrlReachConversionPoints(db, 'not a url', 'a1')).toEqual([]);
  });
});
