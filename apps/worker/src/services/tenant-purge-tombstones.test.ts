import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { activateLineAccount, createLineAccount, upsertFriend, getLineAccountById, getFriendById, getBroadcasts, getBroadcastById } from '@line-crm/db';
import { gapFixture } from '../test-utils/gap1.js';
import { tombstoneLineAccount, tombstoneFriend, tombstoneRestaurantStore, tombstoneRestaurantOrganization, tombstoneBroadcast, tombstoneBookingMenu, tombstonePassPlan } from './tenant-purge-tombstones.js';

test('retained pass plan and referenced menu are stopped and anonymized without changing prices', async () => {
  const f = gapFixture();
  f.raw.pragma('foreign_keys = ON');
  f.raw.exec(`UPDATE tenants SET plan_status='canceled',retention_anchor_at='2026-01-01' WHERE id='t';
    UPDATE menus SET name='private menu',description='private description',fixed_meeting_url='https://private.test' WHERE id='menu';
    INSERT INTO booking_pass_plans(id,line_account_id,kind,name,price,count,valid_days,status,created_by,created_at,idempotency_key,request_json)
      VALUES ('plan','a','ticket','private plan',1000,5,180,'on_sale','private-staff','2026-01-01','private-key','{"name":"private plan","price":1000}');
    INSERT INTO booking_entitlements(id,line_account_id,friend_id,menu_id,plan_id,kind,name,remaining,valid_from,expires_at,created_at,updated_at)
      VALUES ('entitlement','a','f','menu','plan','ticket','ticket',5,'2026-01-01','2028-01-01','2026-01-01','2026-01-01');`);
  const now = '2027-05-01T09:00:00.000+09:00';
  expect(await tombstoneBookingMenu(f.db, 't', 'menu', now)).toBe(false);
  expect(await tombstoneLineAccount(f.db, 't', 'a', now)).toBe(true);
  expect(await tombstoneBookingMenu(f.db, 't', 'menu', now)).toBe(true);
  expect(await tombstonePassPlan(f.db, 't', 'plan', now)).toBe(true);
  expect(await tombstonePassPlan(f.db, 't', 'plan', now)).toBe(false);
  expect(f.raw.prepare("SELECT name,description,base_price,is_active FROM menus WHERE id='menu'").get()).toEqual({name:'削除済み',description:null,base_price:8400,is_active:0});
  expect(f.raw.prepare("SELECT name,price,valid_days,status FROM booking_pass_plans WHERE id='plan'").get()).toEqual({name:'削除済み',price:1000,valid_days:180,status:'stopped'});
  expect(f.raw.prepare("SELECT menu_id,plan_id FROM booking_entitlements WHERE id='entitlement'").get()).toEqual({menu_id:'menu',plan_id:'plan'});
});

test('retained broadcast is anonymized, stopped and does not affect another tenant', async () => {
  const f = gapFixture();
  f.raw.pragma('foreign_keys = ON');
  f.raw.exec(`UPDATE tenants SET plan_status='canceled',retention_anchor_at='2026-01-01' WHERE id='t';
    INSERT INTO broadcasts(id,title,message_type,message_content,line_account_id,internal_memo,status)
      VALUES ('broadcast','private title','text','private message','a','private memo','scheduled'),
             ('other-broadcast','other title','text','other message','b',NULL,'draft');
    INSERT INTO broadcasts(id,title,message_type,message_content,line_account_id,target_type,account_ids)
      VALUES ('mixed','shared title','text','shared message','a','multi-account-dedup','["a","b"]');
    INSERT INTO broadcasts(id,title,message_type,message_content,line_account_id,target_type,account_ids)
      VALUES ('multi','private title','text','private message',NULL,'multi-account-dedup','["a"]');
    INSERT INTO broadcasts(id,title,message_type,message_content,line_account_id,target_type,account_ids)
      VALUES ('foreign-anchor','foreign','text','foreign message','b','multi-account-dedup','["a"]');
    INSERT INTO broadcasts(id,title,message_type,message_content,line_account_id,status)
      VALUES ('sent-broadcast','private','text','private','a','sent');
    INSERT INTO broadcast_ab_tests(broadcast_id,test_ratio_pct,decide_after_minutes,status) VALUES ('sent-broadcast',10,60,'finished');
    INSERT INTO broadcast_approval_events(id,broadcast_id,actor_staff_id,action) VALUES ('approval','broadcast','staff','requested');`);
  const now = '2027-05-01T09:00:00.000+09:00';
  expect(await tombstoneBroadcast(f.db, 't', 'broadcast', now)).toBe(false);
  expect(await tombstoneLineAccount(f.db, 't', 'a', now)).toBe(true);
  expect(await tombstoneBroadcast(f.db, 't', 'mixed', now)).toBe(false);
  expect(await tombstoneBroadcast(f.db, 't', 'multi', now)).toBe(true);
  expect(await tombstoneBroadcast(f.db, 't', 'foreign-anchor', now)).toBe(false);
  expect(await tombstoneBroadcast(f.db, 't', 'sent-broadcast', now)).toBe(false);
  f.raw.exec("DELETE FROM broadcast_ab_tests WHERE broadcast_id='sent-broadcast'");
  expect(await tombstoneBroadcast(f.db, 't', 'sent-broadcast', now)).toBe(true);
  expect(f.raw.prepare("SELECT status,lock_version,stopped_at FROM broadcasts WHERE id='sent-broadcast'").get()).toEqual({status:'sent',lock_version:2,stopped_at:null});
  expect(f.raw.prepare("SELECT title,message_content FROM broadcasts WHERE id='mixed'").get()).toEqual({title:'shared title',message_content:'shared message'});
  expect(await tombstoneBroadcast(f.db, 'other', 'broadcast', now)).toBe(false);
  expect(await tombstoneBroadcast(f.db, 't', 'broadcast', now)).toBe(true);
  expect(await tombstoneBroadcast(f.db, 't', 'broadcast', now)).toBe(false);
  expect(f.raw.prepare("SELECT title,message_content,internal_memo,status FROM broadcasts WHERE id='broadcast'").get()).toEqual({title:'削除済み',message_content:'',internal_memo:null,status:'draft'});
  expect(f.raw.prepare("SELECT broadcast_id FROM broadcast_approval_events WHERE id='approval'").get()).toEqual({broadcast_id:'broadcast'});
  expect(await getBroadcastById(f.db, 'broadcast')).toBeNull();
  expect((await getBroadcasts(f.db)).map(b => b.id)).not.toContain('broadcast');
  expect(f.raw.prepare("SELECT title FROM broadcasts WHERE id='other-broadcast'").get()).toEqual({title:'other title'});
});

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
