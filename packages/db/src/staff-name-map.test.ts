import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { getStaffNameMap } from './staff.js';

/*
 * メディアの「入れた人」が内部ID（UUID）で出る。
 * 内部IDのまま残し、画面に出す表示名をまとめて引く。
 */

const packageRoot = join(import.meta.dirname, '..');

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
    async batch<T>(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run())) as T;
    },
  } as unknown as D1Database;
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(packageRoot, 'bootstrap.sql'), 'utf8'));
  db = asD1(sqlite);
  sqlite.prepare(
    `INSERT INTO staff_members (id, name, role, api_key, is_active) VALUES ('staff-1', '見本 141', 'admin', 'key-1', 1)`,
  ).run();
});

describe('getStaffNameMap（R35）', () => {
  it('内部IDから表示名を引く', async () => {
    const names = await getStaffNameMap(db, ['staff-1']);
    expect(names.get('staff-1')).toBe('見本 141');
  });

  it('退職・削除済みで引けないIDは載せない', async () => {
    const names = await getStaffNameMap(db, ['staff-1', 'gone-uuid']);
    expect(names.get('staff-1')).toBe('見本 141');
    expect(names.has('gone-uuid')).toBe(false);
  });

  it('空・null・重複は問い合わせずに空で返す', async () => {
    expect(await getStaffNameMap(db, [])).toEqual(new Map());
    expect(await getStaffNameMap(db, [null, undefined])).toEqual(new Map());
    const names = await getStaffNameMap(db, ['staff-1', 'staff-1']);
    expect(names.size).toBe(1);
  });
});
