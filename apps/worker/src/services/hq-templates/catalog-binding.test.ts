import { afterEach, expect, it } from 'vitest';
import { createTestD1 } from '../../test-utils/d1-sqlite.js';
import { readCatalogBinding } from './catalog-binding.js';

const fixture = createTestD1({ foreignKeys: true });
afterEach(() => fixture.raw.close());
it('同名ではなく統括・店舗・対象IDで対応を読み、出所が変われば拒否する', async () => {
  fixture.raw.exec(`INSERT INTO tenants(id,name) VALUES('t','HQ'),('other','Other');
    INSERT INTO line_accounts(id,name,channel_id,channel_secret,channel_access_token,tenant_id) VALUES('a','A','a','x','x','t'),('b','B','b','x','x','other');
    INSERT INTO hq_templates(id,tenant_id,template_type,name) VALUES('h','t','template','HQ');
    INSERT INTO hq_template_versions(id,tenant_id,template_id,version,definition_json,content_hash) VALUES('v','t','h',1,'{}','hash');
    INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,hq_template_id,hq_template_version_id) VALUES('m','a','名前',60,100,'h','v'),('same','a','名前',60,100,NULL,NULL);
    INSERT INTO hq_template_store_bindings(tenant_id,template_id,target_account_id,kind,target_id,applied_version_id,applied_snapshot_hash,created_at,updated_at) VALUES('t','h','a','booking_menu','m','v','hash','now','now');`);
  expect(await readCatalogBinding(fixture.db,'t','h','a','booking_menu')).toMatchObject({ targetId:'m',appliedVersionId:'v' });
  expect(await readCatalogBinding(fixture.db,'other','h','a','booking_menu')).toBeNull();
  expect(await readCatalogBinding(fixture.db,'t','h','b','booking_menu')).toBeNull();
  await expect(readCatalogBinding(fixture.db,'t','h','a','mileage_reward')).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  fixture.raw.exec("UPDATE menus SET hq_template_id=NULL,hq_template_version_id=NULL WHERE id='m'");
  await expect(readCatalogBinding(fixture.db,'t','h','a','booking_menu')).rejects.toMatchObject({code:'VERSION_CONFLICT'});
});
