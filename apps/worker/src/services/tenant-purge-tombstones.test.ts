import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { activateLineAccount, createLineAccount, upsertFriend, getLineAccountById, getFriendById } from '@line-crm/db';
import { gapFixture } from '../test-utils/gap1.js';
import { tombstoneLineAccount, tombstoneFriend, tombstoneRestaurantStore, tombstoneRestaurantOrganization } from './tenant-purge-tombstones.js';

test('organization duplicate preflight reports conflicts without modifying data', () => {
  const f = gapFixture();
  const sql = readFileSync(new URL('../../../../scripts/db/check-restaurant-organization-duplicates.sql', import.meta.url), 'utf8');
  f.raw.exec("INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES ('one','account-one','one','t')");
  expect(f.raw.prepare(sql).all()).toEqual([]);
  f.raw.exec('DROP INDEX idx_rt_organizations_tenant_unique');
  f.raw.exec("INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES ('two','account-two','two','t')");
  expect(f.raw.prepare(sql).all()).toEqual([{tenant_id:'t',duplicate_count:2}]);
  expect(f.raw.prepare('SELECT COUNT(*) AS n FROM rt_organizations').get()).toEqual({n:2});
});

test('retained restaurant organization is anonymized without deleting approvals or agreements', async () => {
  const f = gapFixture();
  f.raw.pragma('foreign_keys = ON');
  f.raw.exec(`UPDATE tenants SET plan_status='canceled',retention_anchor_at='2026-01-01' WHERE id='t';
    INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES ('org','a','private org','t');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES ('store','org','private','private','a');
    INSERT INTO rt_organization_agreements(id,organization_id,document_key,document_version) VALUES ('agreement','org','terms','1');
    INSERT INTO rt_approval_requests(id,organization_id,store_id,kind,title) VALUES ('approval','org','store','menu_change','test');`);
  const now = '2027-05-01T09:00:00.000+09:00';
  expect(await tombstoneRestaurantOrganization(f.db, 'other', 'org', now)).toBe(false);
  expect(await tombstoneRestaurantOrganization(f.db, 't', 'org', now)).toBe(false);
  expect(await tombstoneLineAccount(f.db, 't', 'a', now)).toBe(true);
  expect(await tombstoneRestaurantOrganization(f.db, 't', 'org', now)).toBe(false);
  expect(await tombstoneRestaurantStore(f.db, 't', 'store', now)).toBe(true);
  expect(await tombstoneRestaurantOrganization(f.db, 't', 'org', now)).toBe(true);
  expect(await tombstoneRestaurantOrganization(f.db, 't', 'org', now)).toBe(false);
  f.raw.exec("INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES ('new-org','new-account','new','t')");
  expect(() => f.raw.exec("INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES ('duplicate','duplicate-account','duplicate','t')")).toThrow(/UNIQUE constraint failed/);
  expect(f.raw.prepare("SELECT name,status FROM rt_organizations WHERE id='org'").get()).toEqual({name:'削除済み',status:'archived'});
  expect(f.raw.prepare("SELECT organization_id FROM rt_approval_requests WHERE id='approval'").get()).toEqual({organization_id:'org'});
  expect(f.raw.prepare("SELECT organization_id FROM rt_organization_agreements WHERE id='agreement'").get()).toEqual({organization_id:'org'});
});

test('retained restaurant store is anonymized only under its eligible tombstoned account', async () => {
  const f = gapFixture();
  f.raw.pragma('foreign_keys = ON');
  f.raw.exec(`UPDATE tenants SET plan_status='canceled',retention_anchor_at='2026-01-01' WHERE id='t';
    INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES ('org','a','private org','t');
    INSERT INTO rt_stores(id,organization_id,name,code,area,line_account_id,latitude,longitude)
      VALUES ('store','org','private name','private code','private area','a',35,139);
    INSERT INTO rt_stores(id,organization_id,name,code) VALUES ('unlinked-store','org','private','unlinked');
    INSERT INTO rt_organizations(id,account_id,name,tenant_id) VALUES ('other-org','b','other org','other');
    INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES ('other-store','other-org','other store','other','b');
    INSERT INTO rt_approval_requests(id,organization_id,store_id,kind,title) VALUES ('approval','org','store','menu_change','test');`);
  const now = '2027-05-01T09:00:00.000+09:00';
  expect(await tombstoneRestaurantStore(f.db, 't', 'store', now)).toBe(false);
  expect(await tombstoneLineAccount(f.db, 't', 'a', now)).toBe(true);
  f.raw.exec("UPDATE tenants SET plan_status='active' WHERE id='t'");
  expect(await tombstoneRestaurantStore(f.db, 't', 'store', now)).toBe(false);
  f.raw.exec("UPDATE tenants SET plan_status='canceled' WHERE id='t'");
  expect(await tombstoneRestaurantStore(f.db, 'other', 'store', now)).toBe(false);
  expect(await tombstoneRestaurantStore(f.db, 't', 'store', now)).toBe(true);
  expect(await tombstoneRestaurantStore(f.db, 't', 'unlinked-store', now)).toBe(true);
  expect(await tombstoneRestaurantStore(f.db, 't', 'store', now)).toBe(false);
  expect(f.raw.prepare("SELECT name,area,latitude,longitude,status FROM rt_stores WHERE id='store'").get()).toEqual({name:'削除済み',area:null,latitude:null,longitude:null,status:'archived'});
  expect(f.raw.prepare("SELECT code FROM rt_stores WHERE id='store'").get()).not.toEqual({code:'private code'});
  expect(f.raw.prepare("SELECT store_id FROM rt_approval_requests WHERE id='approval'").get()).toEqual({store_id:'store'});
  expect(f.raw.prepare("SELECT name,status,data_purged_at FROM rt_stores WHERE id='other-store'").get()).toEqual({name:'other store',status:'active',data_purged_at:null});
});

test('tombstones erase identifiers and secrets, are hidden and are not reused', async () => {
  const f = gapFixture();
  f.raw.exec("UPDATE line_accounts SET login_channel_id='login-private',login_channel_secret='secret-login',liff_id='private-liff',channel_access_token_encrypted='enc-private' WHERE id='a'; UPDATE friends SET real_name='private',private_memo='memo',metadata='{\"private\":\"value\"}',picture_url='https://private.test',status_message='secret' WHERE id='f'");
  expect(await tombstoneLineAccount(f.db, 't', 'a', '2027-05-01T00:00:00Z')).toBe(false);
  f.raw.exec("UPDATE tenants SET plan_status='canceled',retention_anchor_at='2026-01-01T00:00:00Z' WHERE id='t'");
  expect(await tombstoneLineAccount(f.db, 't', 'b', '2027-05-01T00:00:00Z')).toBe(false);
  expect(await tombstoneLineAccount(f.db, 't', 'a', '2027-05-01T00:00:00Z')).toBe(true);
  f.raw.exec("UPDATE tenants SET plan_status='active' WHERE id='t'");
  expect(await tombstoneFriend(f.db, 'a', 'f', '2027-05-01T00:00:00Z')).toBe(false);
  f.raw.exec("UPDATE tenants SET plan_status='canceled' WHERE id='t'");
  expect(await tombstoneFriend(f.db, 'a', 'f', '2027-05-01T00:00:00Z')).toBe(true);
  expect(await tombstoneFriend(f.db, 'a', 'f', '2027-05-01T00:00:00Z')).toBe(false);
  const account = f.raw.prepare("SELECT * FROM line_accounts WHERE id='a'").get() as Record<string,unknown>;
  const friend = f.raw.prepare("SELECT * FROM friends WHERE id='f'").get() as Record<string,unknown>;
  expect(account).toMatchObject({name:'削除済み',is_active:0,channel_access_token:'',channel_secret:'',channel_access_token_encrypted:null,login_channel_id:null,login_channel_secret:null,liff_id:null});
  expect(friend).toMatchObject({display_name:null,real_name:null,private_memo:null,metadata:'{}',picture_url:null,status_message:null,is_following:0,is_hidden:1});
  expect(friend.line_user_id).not.toBe('Uf');
  expect(account.channel_id).not.toBe('ch');
  expect(await getLineAccountById(f.db, 'a')).toBeNull();
  expect(await activateLineAccount(f.db, 'a')).toBeNull();
  expect(f.raw.prepare("SELECT is_active FROM line_accounts WHERE id='a'").get()).toEqual({is_active:0});
  const newAccount = await createLineAccount(f.db, {channelId:'ch',name:'新しいアカウント',channelAccessToken:'new-token',channelSecret:'new-secret',tenantId:'other'}, Buffer.alloc(32).toString('base64'));
  expect(newAccount.id).not.toBe('a');
  expect(newAccount.channel_id).toBe('ch');
  expect(await getFriendById(f.db, 'f')).toBeNull();
  const added = await upsertFriend(f.db, {lineUserId:'Uf',lineAccountId:'b',displayName:'新しい友だち'});
  expect(added.id).not.toBe('f');
  expect(added.line_user_id).toBe('Uf');
  expect(f.raw.prepare("SELECT channel_id FROM line_accounts WHERE id='b'").get()).toEqual({channel_id:'ch2'});
});
