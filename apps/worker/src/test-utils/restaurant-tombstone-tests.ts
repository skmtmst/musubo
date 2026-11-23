import { expect, it } from 'vitest';
import type { SqliteD1 } from './d1-sqlite.js';

type Fixture = {
  db: () => SqliteD1;
  seed: () => void;
  session: () => Promise<string>;
  request: (path: string) => Response | Promise<Response>;
  requestAs: (path: string, token: string) => Response | Promise<Response>;
  requestWithMethod: (path: string, method: string, body: unknown) => Response | Promise<Response>;
};

export function registerRestaurantTombstoneTests(fixture: Fixture) {
  const { seed: seedRestaurantFixture, session: createAdminSession, request, requestAs, requestWithMethod } = fixture;
  it('削除済み店舗は一覧に表示せず編集できない', async () => {
    seedRestaurantFixture();
    fixture.db().raw.prepare("UPDATE rt_stores SET data_purged_at='2027-01-01',status='archived' WHERE id='store-yokohama'").run();
    const session = await createAdminSession();
    const snapshot = await requestAs('/api/restaurant-test/snapshot?account_id=account-1', session);
    expect(snapshot.status).toBe(200);
    const json = await snapshot.json() as { data: { stores: Array<{id:string}> } };
    expect(json.data.stores.map(store => store.id)).not.toContain('store-yokohama');
    const response = await requestWithMethod('/api/restaurant-test/stores/store-yokohama?account_id=account-1', 'PATCH', {name:'復活',status:'active',lineAccountId:'account-2'});
    expect(response.status).toBe(400);
    expect(fixture.db().raw.prepare("SELECT status FROM rt_stores WHERE id='store-yokohama'").get()).toEqual({status:'archived'});
  });

  it('削除済み組織は店舗一覧の対象にならない', async () => {
    seedRestaurantFixture();
    fixture.db().raw.prepare("UPDATE rt_organizations SET data_purged_at='2027-01-01',status='archived' WHERE id='org-fixture'").run();
    const snapshot = await request('/api/restaurant-test/snapshot?account_id=account-1');
    expect(snapshot.status).toBe(200);
    const json = await snapshot.json() as {data:{organization:unknown;stores:unknown[]}};
    expect(json.data.organization).toBeNull();
    expect(json.data.stores).toEqual([]);
  });

}
