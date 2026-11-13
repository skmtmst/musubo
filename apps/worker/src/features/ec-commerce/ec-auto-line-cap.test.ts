import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { gapFixture, gapApp, gapCall, gapOwner } from '../../test-utils/gap1.js';
import { ecAutoLine } from '../../routes/ec-auto-line.js';
import { reserveAutoLineSimulationCap, resolveUnknownAutoLineSimulationCap } from './ec-auto-line-cap.js';

let d: ReturnType<typeof gapFixture>;
const now = new Date('2026-10-16T03:00:00.000Z');
beforeEach(() => {
  d = gapFixture();
  if (!d.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ec_auto_line_cap_reservations'").get()) {
    d.raw.exec(readFileSync(new URL('../../../../../packages/db/migrations/765_ec_auto_line_cap.sql', import.meta.url), 'utf8'));
  }
  d.raw.exec(`
    INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret,tenant_id) VALUES('a2','ch-a2','二店','test-token','secret','t');
    INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('f3','Uf3','同じ人','a2');
    INSERT INTO users(id,tenant_id) VALUES('u','t');
    INSERT INTO identity_candidates(id,tenant_id,kind,status,confidence_score,detector_version,left_subject_kind,left_subject_id,left_line_account_id,left_snapshot_json,right_subject_kind,right_subject_id,right_line_account_id,right_snapshot_json,evidence_fingerprint,evidence_json,impact_json,detected_at,created_at,updated_at)
      VALUES('candidate','t','friend_duplicate','linked',100,'v1','friend','f','a','{}','friend','f3','a2','{}','fingerprint','[]','[]','2026-10-01','2026-10-01','2026-10-01');
    INSERT INTO friend_identity_links(id,tenant_id,candidate_id,user_id,friend_id,link_method,evidence_snapshot_json,confidence_score,linked_at)
      VALUES('l1','t','candidate','u','f','operator_review','[]',100,'2026-10-01'),('l2','t','candidate','u','f3','operator_review','[]',100,'2026-10-01');
    INSERT INTO friend_delivery_consents(line_account_id,friend_id,purpose,state,reason,source)
      VALUES('a','f','marketing','granted','本人','liff'),('a2','f3','marketing','granted','本人','liff');
    INSERT INTO ec_auto_line_product_identities(tenant_id,account_id,product_id,canonical_product_id,evidence_ref,verified_at)
      VALUES('t','a','red','parent','trusted-catalog:1','2026-10-01'),('t','a2','blue','parent','trusted-catalog:1','2026-10-01');
    INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key)
      VALUES('e1','a','f','cart_add','red','{}','2026-10-15T00:00:00Z','2026-10-15','e1'),('e2','a2','f3','product_view','blue','{}','2026-10-15T00:00:00Z','2026-10-15','e2');
    INSERT INTO ec_auto_line_sends(id,account_id,rule_kind,friend_id,product_id,trigger_event_id,scheduled_at,original_due_at,messages_snapshot_json)
      VALUES('s1','a','cart','f','red','e1','2026-10-16T01:00:00Z','2026-10-16T01:00:00Z','[]'),('s2','a2','browse','f3','blue','e2','2026-10-16T02:00:00Z','2026-10-16T02:00:00Z','[]');
  `);
});
afterEach(() => d.raw.close());

test('同じ会社の別アカウントは先の候補を優先し、日次の枠を共有する', async () => {
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', now)).toMatchObject({ status: 'held' });
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'reserved' });
  d.raw.exec("UPDATE ec_auto_line_sends SET status='simulated' WHERE id='s1'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', now)).toMatchObject({ status: 'held' });
  expect(d.raw.prepare('SELECT count(*) n FROM ec_auto_line_cap_reservations').get()).toEqual({ n: 1 });
});

test('同意・商品・本人の根拠が欠ける、矛盾する場合は枠を作らない', async () => {
  d.raw.exec("UPDATE friend_delivery_consents SET state='unknown' WHERE friend_id='f'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'held' });
  d.raw.exec("UPDATE friend_delivery_consents SET state='granted' WHERE friend_id='f'; UPDATE ec_auto_line_product_identities SET revoked_at='2026-10-15' WHERE account_id='a'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'held' });
  d.raw.exec("UPDATE ec_auto_line_product_identities SET revoked_at=NULL WHERE account_id='a'; UPDATE friend_identity_links SET unlinked_at='2026-10-15' WHERE friend_id='f'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'held' });
});

test('送信結果不明は自動で解放せず、店と担当・理由を確認した解除だけを記録する', async () => {
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'reserved' });
  const row = d.raw.prepare('SELECT id FROM ec_auto_line_cap_reservations').get() as { id: string };
  d.raw.prepare("UPDATE ec_auto_line_cap_reservations SET state='unknown' WHERE id=?").run(row.id);
  d.raw.exec("UPDATE ec_auto_line_sends SET status='simulated' WHERE id='s1'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', new Date('2026-12-01T03:00:00Z'))).toMatchObject({ status: 'held' });
  expect(await resolveUnknownAutoLineSimulationCap(d.db, 't', 'a2', row.id, 'operator', '確認済み', now)).toBe(false);
  expect(await resolveUnknownAutoLineSimulationCap(d.db, 't', 'a', row.id, '', '確認済み', now)).toBe(false);
  expect(await resolveUnknownAutoLineSimulationCap(d.db, 't', 'a', row.id, 'operator', '未送信を確認', now)).toBe(true);
  expect(d.raw.prepare('SELECT state,release_actor,release_reason FROM ec_auto_line_cap_reservations').get()).toEqual({ state:'released', release_actor:'operator', release_reason:'未送信を確認' });
});

test('日をまたいでも色違いの同じ親商品は30日間の枠を共有する', async () => {
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'reserved' });
  d.raw.exec("UPDATE ec_auto_line_sends SET status='simulated' WHERE id='s1'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', new Date('2026-10-17T03:00:00Z'))).toMatchObject({ status: 'held' });
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', new Date('2026-11-16T03:00:00Z'))).toMatchObject({ status: 'reserved' });
});

test('異なる商品でも直近7日間に3枠があれば保留する', async () => {
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'reserved' });
  d.raw.exec("UPDATE ec_auto_line_sends SET status='simulated' WHERE id='s1'");
  for (const [index, day] of [[3, '11'], [4, '12']] as const) {
    d.raw.prepare("INSERT INTO ec_behavior_events(id,account_id,friend_id,type,product_id,product_snapshot_json,occurred_at,received_at,dedupe_key) VALUES(?,'a','f','cart_add','red','{}','2026-10-01','2026-10-01',?)").run(`e${index}`, `e${index}`);
    d.raw.prepare("INSERT INTO ec_auto_line_sends(id,account_id,rule_kind,friend_id,product_id,trigger_event_id,scheduled_at,original_due_at,messages_snapshot_json,status) VALUES(?,'a','cart','f','red',?,'2026-10-01','2026-10-01','[]','simulated')").run(`s${index}`, `e${index}`);
    d.raw.prepare("INSERT INTO ec_auto_line_cap_reservations(id,tenant_id,user_id,account_id,friend_id,candidate_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state) VALUES(?,'t','u','a','f',?,'simulation',? ,'red',?,?, 'accepted')").run(`r${index}`, `s${index}`, 'parent', `2026-10-${day}`, `2026-10-${day}T03:00:00Z`);
  }
  d.raw.exec("UPDATE ec_auto_line_product_identities SET canonical_product_id='another' WHERE account_id='a2'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', new Date('2026-10-17T03:00:00Z'))).toMatchObject({ status: 'held' });
});

test('過去に確保した商品の対応が変わったら、別商品でも根拠の確認まで保留する', async () => {
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'reserved' });
  d.raw.exec("UPDATE ec_auto_line_sends SET status='simulated' WHERE id='s1'; UPDATE ec_auto_line_product_identities SET canonical_product_id='changed' WHERE account_id='a'; UPDATE ec_auto_line_product_identities SET canonical_product_id='other' WHERE account_id='a2'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', new Date('2026-10-17T03:00:00Z'))).toMatchObject({ status: 'held' });
  d.raw.exec("UPDATE ec_auto_line_product_identities SET canonical_product_id='parent' WHERE account_id='a'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', new Date('2026-10-17T03:00:00Z'))).toMatchObject({ status: 'reserved' });
});

test('模擬の枠と実送信の枠を混ぜない', async () => {
  d.raw.exec("INSERT INTO ec_auto_line_cap_reservations(id,tenant_id,user_id,account_id,friend_id,candidate_id,mode,canonical_product_id,source_product_id,day_jst,reserved_at,state) VALUES('live','t','u','a','f','s1','live','parent','red','2026-10-16','2026-10-16T02:00:00Z','unknown')");
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'reserved' });
  const rows = d.raw.prepare('SELECT mode,state FROM ec_auto_line_cap_reservations ORDER BY mode').all();
  expect(rows).toEqual([{ mode: 'live', state: 'unknown' }, { mode: 'simulation', state: 'reserved' }]);
});

test('日次上限は日本時間の午前0時で切り替わる', async () => {
  d.raw.exec("UPDATE ec_auto_line_sends SET scheduled_at='2026-10-15T13:00:00Z', original_due_at='2026-10-15T13:00:00Z'; UPDATE ec_auto_line_product_identities SET canonical_product_id='other' WHERE account_id='a2'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', new Date('2026-10-15T14:59:59Z'))).toMatchObject({ status: 'reserved' });
  d.raw.exec("UPDATE ec_auto_line_sends SET status='simulated' WHERE id='s1'");
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', new Date('2026-10-15T14:59:59Z'))).toMatchObject({ status: 'held' });
  expect(await reserveAutoLineSimulationCap(d.db, 'a2', 's2', new Date('2026-10-15T15:00:00Z'))).toMatchObject({ status: 'reserved' });
});

test('別アカウントの同時取得でも本人の日次枠は1件', async () => {
  const results = await Promise.all([
    reserveAutoLineSimulationCap(d.db, 'a2', 's2', now),
    reserveAutoLineSimulationCap(d.db, 'a', 's1', now),
  ]);
  expect(results.filter((result) => result.status === 'reserved')).toHaveLength(1);
  expect(d.raw.prepare("SELECT count(*) n FROM ec_auto_line_cap_reservations WHERE mode='simulation' AND state='reserved'").get()).toEqual({ n: 1 });
});


test('結果不明の模擬枠は店舗管理者が未送信の確認と理由を添えた時だけ解除できる', async () => {
  expect(await reserveAutoLineSimulationCap(d.db, 'a', 's1', now)).toMatchObject({ status: 'reserved' });
  const row = d.raw.prepare('SELECT id FROM ec_auto_line_cap_reservations').get() as { id: string };
  d.raw.prepare("UPDATE ec_auto_line_cap_reservations SET state='unknown' WHERE id=?").run(row.id);
  const app = (staff=gapOwner, impersonation=false) => gapApp(d, [ecAutoLine], staff, impersonation);
  const list = '/api/ec/auto-line/cap/unknown?account_id=a';
  expect((await gapCall(app({...gapOwner, readOnly:true}), list)).status).toBe(403);
  const available = await (await gapCall(app(), list)).json() as {data:{items:Array<{id:string}>}};
  expect(available.data.items.map(item=>item.id)).toEqual([row.id]);
  const url = `/api/ec/auto-line/cap/unknown/${row.id}/release?account_id=a`;
  const body = { testMode: true, confirmedNotSent: true, reason: '未送信を確認' };
  expect((await gapCall(app({...gapOwner, readOnly:true}), url, 'POST', body)).status).toBe(403);
  expect((await gapCall(app({...gapOwner, role:'staff'}), url, 'POST', body)).status).toBe(403);
  expect((await gapCall(app(gapOwner,true), url, 'POST', body)).status).toBe(403);
  expect((await gapCall(app(), url, 'POST', {...body, confirmedNotSent:false})).status).toBe(400);
  expect((await gapCall(app(), url.replace('account_id=a','account_id=b'), 'POST', body)).status).toBe(404);
  expect((await gapCall(app(), url, 'POST', body)).status).toBe(200);
  expect((await gapCall(app(), url, 'POST', body)).status).toBe(404);
  expect(d.raw.prepare('SELECT state,release_actor,release_reason FROM ec_auto_line_cap_reservations').get()).toEqual({state:'released',release_actor:gapOwner.id,release_reason:'未送信を確認'});
});
