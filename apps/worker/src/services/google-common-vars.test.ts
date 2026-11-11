import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { resolveMusuboCommonVarsAt } from './google-common-vars.js';

let fixture: SqliteD1;
beforeEach(() => {
  fixture = createTestD1();
  fixture.raw.exec(`
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('a','ch','サロン','fake','fake');
    INSERT INTO common_vars(id,line_account_id,name,var_key,value) VALUES('v','a','営業時間','business_hours','古い手入力の時間');
    INSERT INTO rt_organizations(id,account_id,name,status) VALUES('o','a','サロン','active');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('s','o','サロン','S','a');
    INSERT INTO rt_google_connections(id,store_id,line_account_id,location_name,status)
      VALUES('c','s','a','accounts/1/locations/2','connected');
  `);
});
afterEach(() => fixture.raw.close());

test('配信の営業時間の共通情報もGoogleの週・特別営業時間を使う', async () => {
  const profile = { profile: { name: 'locations/2', openStatus: 'OPEN', regularHours: {
    SUNDAY: [], MONDAY: [{ open: '10:00', close: '18:00' }], TUESDAY: [], WEDNESDAY: [],
    THURSDAY: [], FRIDAY: [], SATURDAY: [],
  }, specialHours: [{ date: '2026-11-12', closed: true, periods: [] }] } };
  fixture.raw.prepare(`INSERT INTO rt_google_profiles(store_id,location_name,profile_json,fingerprint,fetched_at)
    VALUES('s','accounts/1/locations/2',?,'fp','2026-11-11T00:00:00Z')`).run(JSON.stringify(profile));
  const result = await resolveMusuboCommonVarsAt(fixture.db, 'a', ['business_hours'], '2026-11-11T00:00:00Z');
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.values.business_hours).toContain('月：10:00〜18:00');
    expect(result.values.business_hours).toContain('2026-11-12：休業');
    expect(result.values.business_hours).not.toContain('古い手入力');
    expect(result.entries[0]).toMatchObject({ id: 'v', value: result.values.business_hours });
  }
});

test('接続済みのGoogle写しが壊れていたら古い手入力値を配信しない', async () => {
  const result = await resolveMusuboCommonVarsAt(fixture.db, 'a', ['business_hours'], '2026-11-11T00:00:00Z');
  expect(result).toEqual({ ok: false, failures: [{ varKey: 'business_hours', reason: 'missing' }] });
});

test('Google接続を解除しても古い手入力値へ戻さない', async () => {
  fixture.raw.exec("UPDATE rt_google_connections SET status='disconnected' WHERE id='c'");
  const result = await resolveMusuboCommonVarsAt(fixture.db, 'a', ['business_hours'], '2026-11-11T00:00:00Z');
  expect(result).toEqual({ ok: false, failures: [{ varKey: 'business_hours', reason: 'missing' }] });
});
