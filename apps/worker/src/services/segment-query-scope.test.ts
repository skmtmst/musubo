import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEFAULT_TENANT_ID, type SegmentCondition } from '@line-crm/shared';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { buildPublicSegmentQuery } from './segment-query.js';
import { restrictSegmentInput, scopeSegmentQuery, scopeStoredBroadcastSegmentQuery } from './segment-query-scope.js';

let fixture: SqliteD1;
beforeEach(() => {
  fixture = createTestD1();
  fixture.raw.prepare("INSERT INTO tenants(id,name) VALUES ('other-tenant','Other')").run();
  for (const [id, tenant] of [['own', DEFAULT_TENANT_ID], ['other', 'other-tenant']]) {
    fixture.raw.prepare(`INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id)
      VALUES (?,?,?,'unused','unused',?)`).run(id, id, id, tenant);
  }
  for (const [id, account] of [['own-friend', 'own'], ['other-friend', 'other'], ['unassigned', null]]) {
    fixture.raw.prepare('INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES (?,?,?,?)').run(id, id, id, account);
  }
  fixture.raw.pragma('query_only = ON');
});
afterEach(() => fixture.raw.close());

async function ids(query: { sql: string; bindings: unknown[] }) {
  const result = await fixture.db.prepare(query.sql).bind(...query.bindings).all<{ id: string }>();
  return result.results.map(row => row.id).sort();
}
const all: SegmentCondition = { operator: 'AND', rules: [] };

it.each([
  { operator: 'OR', rules: ['own', 'other'].map(text => ({ type: 'name', value: { text, targets: ['display'] } })) },
  { operator: 'AND', rules: [{ type: 'tag_not_exists', value: 'none' }] },
  { operator: 'OR', rules: [], groups: [{ operator: 'OR', rules: [{ type: 'tag_not_exists', value: 'none' }] }] },
] as SegmentCondition[])('OR・NOT・副問い合わせ・入れ子でも入力集合を越えない: %j', async conditions => {
  const query = scopeSegmentQuery(buildPublicSegmentQuery(conditions), { allowedAccountIds: ['own'], canSeeUnassigned: false });
  expect(await ids(query)).toEqual(['own-friend']);
});

it('NULLの旧配信は既定統括と未割当だけを含め、他統括を含めない', async () => {
  expect(await ids(await scopeStoredBroadcastSegmentQuery(fixture.db, buildPublicSegmentQuery(all), null)))
    .toEqual(['own-friend', 'unassigned']);
});

it('空の範囲は空のまま、未割当の可否を混同しない', async () => {
  expect(await ids(scopeSegmentQuery(buildPublicSegmentQuery(all), { allowedAccountIds: [], canSeeUnassigned: false }))).toEqual([]);
  expect(await ids(scopeSegmentQuery(buildPublicSegmentQuery(all), { allowedAccountIds: [], canSeeUnassigned: true }))).toEqual(['unassigned']);
});

it('100件以上の範囲でもD1の束縛数を越えず、条件の値との順序を保つ', async () => {
  const query = buildPublicSegmentQuery({ operator: 'AND', rules: [{ type: 'name', value: { text: 'own', targets: ['display'] } }] });
  expect(await ids(scopeSegmentQuery(query, { allowedAccountIds: [...Array.from({ length: 130 }, (_, i) => 'missing-' + i), 'own'], canSeeUnassigned: false })))
    .toEqual(['own-friend']);
});

it('適用できないSQLの形は、無制限の問い合わせを返さず拒否する', () => {
  expect(() => scopeSegmentQuery({ sql: 'SELECT id FROM friends AS f', bindings: [] }, { allowedAccountIds: ['own'], canSeeUnassigned: false })).toThrow();
});

it('旧配信のSQLでも公開用LINE IDを返し、別アカウントの同じIDを含めない', async () => {
  fixture.raw.pragma('query_only = OFF');
  fixture.raw.prepare('UPDATE friends SET line_user_id = ? WHERE id = ?').run('musubo-scope:own-friend:U-shared', 'own-friend');
  fixture.raw.prepare('UPDATE friends SET line_user_id = ? WHERE id = ?').run('U-shared', 'other-friend');
  fixture.raw.pragma('query_only = ON');

  const where = 'WHERE f.display_name LIKE ? OR f.id = ?';
  const query = await scopeStoredBroadcastSegmentQuery(fixture.db, {
    sql: `SELECT f.id, f.line_user_id, f.display_name FROM friends f ${where}`,
    bindings: ['own%', 'other-friend'],
  }, 'own');
  const scoped = restrictSegmentInput(query, 'f.is_following = ?', [1]);

  expect(scoped.sql.endsWith(where)).toBe(true);
  expect(scoped.bindings).toEqual([1, 'own', 'own%', 'other-friend']);
  const { results } = await fixture.db.prepare(scoped.sql).bind(...scoped.bindings).all();
  expect(results).toEqual([{ id: 'own-friend', line_user_id: 'U-shared', display_name: 'own-friend' }]);
});

it('重ねた入力制限も条件のORから外れず、束縛の順序を保つ', async () => {
  const scoped = scopeSegmentQuery(buildPublicSegmentQuery(all), { allowedAccountIds: ['own', 'other'], canSeeUnassigned: true });
  expect(await ids(restrictSegmentInput(scoped, 'f.display_name = ?', ['own-friend']))).toEqual(['own-friend']);
});

it('先頭のCTEや先行する副SELECTへ誤って範囲を付けず、形の変化を拒否する', () => {
  for (const sql of [
    'WITH before_query AS (SELECT * FROM friends f WHERE 1=1) SELECT f.id, f.line_user_id, f.display_name FROM friends f WHERE 1=1',
    'SELECT (SELECT COUNT(*) FROM friends f), f.id, f.line_user_id, f.display_name FROM friends f WHERE 1=1',
  ]) {
    expect(() => scopeSegmentQuery({ sql, bindings: [] }, { allowedAccountIds: ['own'], canSeeUnassigned: false })).toThrow();
  }
});

it('信頼できる条件に置換の特殊文字があっても文字列として保つ', async () => {
  fixture.raw.pragma('query_only = OFF');
  fixture.raw.prepare("INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES ('dollar','Udollar','$&','own')").run();
  fixture.raw.pragma('query_only = ON');
  expect(await ids(restrictSegmentInput(buildPublicSegmentQuery(all), "f.display_name <> '$&'")))
    .toEqual(['other-friend', 'own-friend', 'unassigned']);
});

it('後ろに別の入力集合を足すUNIONも拒否する', () => {
  const sql = 'SELECT f.id, f.line_user_id, f.display_name FROM friends f WHERE 1=1 UNION SELECT f.id, f.line_user_id, f.display_name FROM friends f';
  expect(() => scopeSegmentQuery({ sql, bindings: [] }, { allowedAccountIds: ['own'], canSeeUnassigned: false })).toThrow();
});
