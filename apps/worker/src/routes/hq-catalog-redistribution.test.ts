import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { processHqDistributionJobs } from '../services/hq-templates/distribution-jobs.js';
import { readCatalogTarget } from '../services/hq-templates/catalog-target.js';
import { catalogDefinitions, createCatalogFixture, type CatalogFixture, type RedistributionJobView } from '../test-utils/hq-catalog-fixture.js';

let fx: CatalogFixture;
beforeEach(() => { fx = createCatalogFixture(); });
afterEach(() => fx.close());

const menu = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, settings: { ...catalogDefinitions.booking_menu.settings, ...overrides } });
const count = (sql: string, ...args: unknown[]) => (fx.f.raw.prepare(sql).get(...args) as { n: number }).n;
const menuOf = (accountId: string) => fx.f.raw.prepare('SELECT * FROM menus WHERE line_account_id=? AND hq_template_id IS NOT NULL ORDER BY created_at LIMIT 1').get(accountId) as Record<string, unknown>;
const storeMenu = (menuId: string, action: string, versionId: unknown, accountId = 'a') => fx.request<{ adoptedVersionId?: string; dismissedVersionId?: string }>(`/api/booking/admin/menus/${menuId}/${action}?account_id=${accountId}`, 'POST', { versionId });

describe('配布の確定と対応表', () => {
  test('作成を確定した配布と同じ batch で対応を記録し、同じ名前の既存メニューには対応を作らない', async () => {
    fx.f.raw.exec("INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price,is_active) VALUES('existing','a','初回相談',30,1000,1)");
    const id = await fx.create('booking_menu'), p = await fx.check(id);
    expect(count('SELECT COUNT(*) n FROM hq_template_store_bindings')).toBe(0);
    expect(p.stores[0].redistribution).toEqual({ bound: false, outcome: 'unbound', code: null, notices: [] });
    expect((await fx.run(id, p)).body.data.status).toBe('completed');
    const binding = fx.binding(id, 'a')!;
    expect(binding).toMatchObject({ kind: 'booking_menu', applied_version_id: fx.versionId(id), pending_version_id: null, row_version: 1, hash_version: 1 });
    expect(binding.target_id).not.toBe('existing');
    // 書く前に計算した指紋と、書いた後の行から計算した指紋が一致する。
    expect((await readCatalogTarget(fx.f.db, 'booking_menu', 'a', binding.target_id))!.hash).toBe(binding.applied_snapshot_hash);
    expect(fx.f.raw.prepare('SELECT hq_template_id FROM menus WHERE id=?').get('existing')).toEqual({ hq_template_id: null });
    expect(fx.f.raw.pragma('foreign_key_check')).toEqual([]);
  });

  test('景品の作成・上書き・別名のたびに対応を最後に確定した店の物へ付け替える', async () => {
    const id = await fx.create('mileage_reward');
    expect((await fx.run(id, await fx.check(id))).body.data.status).toBe('completed');
    const first = fx.binding(id, 'a')!;
    expect((await readCatalogTarget(fx.f.db, 'mileage_reward', 'a', first.target_id))!.hash).toBe(first.applied_snapshot_hash);
    expect((await fx.run(id, await fx.check(id), 'overwrite')).body.data.status).toBe('completed');
    expect(fx.binding(id, 'a')).toMatchObject({ target_id: first.target_id, row_version: 2 });
    expect((await fx.run(id, await fx.check(id), 'alias')).body.data.status).toBe('completed');
    const alias = fx.binding(id, 'a')!;
    expect(alias.target_id).not.toBe(first.target_id);
    expect(alias.row_version).toBe(3);
    expect(fx.f.raw.prepare('SELECT name FROM mileage_rewards WHERE id=?').get(alias.target_id)).toEqual({ name: 'お礼 (2)' });
    expect((await readCatalogTarget(fx.f.db, 'mileage_reward', 'a', alias.target_id))!.hash).toBe(alias.applied_snapshot_hash);
    expect(count('SELECT COUNT(*) n FROM hq_template_store_bindings')).toBe(1);
  });

  test('店への書き込みが失敗した店には対応を残さない', async () => {
    const id = await fx.create('booking_menu'), p = await fx.check(id, ['a', 'b']);
    fx.f.raw.exec("CREATE TRIGGER reject_store_b BEFORE INSERT ON menus WHEN NEW.line_account_id='b' BEGIN SELECT RAISE(ABORT,'store failed'); END");
    expect((await fx.run(id, p)).body.data.status).toBe('partial');
    expect(fx.binding(id, 'a')).toBeDefined();
    expect(fx.binding(id, 'b')).toBeUndefined();
  });
});

describe('対応表のある店への配り直し', () => {
  async function distributed(accountIds = ['a', 'b']) {
    const id = await fx.create('booking_menu');
    expect((await fx.run(id, await fx.check(id, accountIds))).body.data.status).toBe('completed');
    return id;
  }

  test('店が変えていない物は新しい版に更新し、受付・並び順・担当・予約の値段の控えは残す。店が変えた物は知らせる', async () => {
    const id = await distributed();
    const a = menuOf('a'), b = menuOf('b');
    fx.f.raw.exec(`UPDATE menus SET is_active=1,sort_order=7 WHERE id='${a.id}';
      INSERT INTO staff(id,line_account_id,name,display_name) VALUES('staff-a','a','担当','担当');
      INSERT INTO staff_menus(staff_id,menu_id,is_offered) VALUES('staff-a','${a.id}',1);
      INSERT INTO friends(id,line_user_id,line_account_id) VALUES('friend-a','line-friend-a','a');
      INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
        VALUES('booked','a','friend-a','staff-a','${a.id}','2026-12-01T10:00:00+09:00','2026-12-01T11:00:00+09:00','2026-12-01T11:00:00+09:00','confirmed',3000,'2026-11-15T10:00:00+09:00');`);
    fx.f.raw.prepare('UPDATE menus SET duration_minutes=80 WHERE id=?').run(b.id);
    const v2 = await fx.save(id, menu({ base_price: 9000 }));
    const p = await fx.check(id, ['a', 'b']);
    expect(p.stores.map(s => [s.accountId, s.redistribution?.outcome, s.redistribution?.notices])).toEqual([['a', 'apply', []], ['b', 'pending', ['store_edited']]]);
    // 確かめだけでは何も書かない。
    expect(fx.binding(id, 'a')!.applied_version_id).not.toBe(v2);
    const created = await fx.redistribute(id, [p.preflightId], 'redistribute-key-1');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'pending', templateVersionId: v2, counts: { total: 2, finished: 0 } });
    const versionsBefore = count('SELECT COUNT(*) n FROM menu_versions WHERE menu_id=?', a.id);

    await processHqDistributionJobs(fx.f.db);
    expect(fx.f.raw.prepare('SELECT base_price,duration_minutes,is_active,sort_order,hq_template_version_id,hq_customized FROM menus WHERE id=?').get(a.id))
      .toEqual({ base_price: 9000, duration_minutes: 60, is_active: 1, sort_order: 7, hq_template_version_id: v2, hq_customized: 0 });
    expect(fx.f.raw.prepare('SELECT staff_id,is_offered FROM staff_menus WHERE menu_id=?').all(a.id)).toEqual([{ staff_id: 'staff-a', is_offered: 1 }]);
    expect(fx.f.raw.prepare("SELECT price_at_booking FROM bookings WHERE id='booked'").get()).toEqual({ price_at_booking: 3000 });
    expect(count('SELECT COUNT(*) n FROM menu_versions WHERE menu_id=?', a.id)).toBe(versionsBefore + 1);
    expect(fx.binding(id, 'a')).toMatchObject({ applied_version_id: v2, pending_version_id: null, row_version: 2 });
    expect((await readCatalogTarget(fx.f.db, 'booking_menu', 'a', String(a.id)))!.hash).toBe(fx.binding(id, 'a')!.applied_snapshot_hash);
    expect(fx.f.raw.prepare('SELECT base_price,duration_minutes,hq_customized FROM menus WHERE id=?').get(b.id)).toEqual({ base_price: 3000, duration_minutes: 80, hq_customized: 1 });
    expect(fx.binding(id, 'b')).toMatchObject({ pending_version_id: v2 });

    const job = await fx.hq<RedistributionJobView>(`/${id}/redistributions/${created.body.data.jobId}`);
    expect(job.body.data).toMatchObject({ status: 'completed', counts: { total: 2, finished: 2, applied: 1, notified: 1, failed: 0 } });
    expect(job.body.data.notificationId).toBeTruthy();
    const notices = "SELECT COUNT(*) n FROM audit_events WHERE source_kind='hq_template_distribution_job' AND action='hq_template.redistribution_finished'";
    expect(count(notices)).toBe(1);
    expect(fx.f.raw.prepare(`SELECT id FROM audit_events WHERE source_kind='hq_template_distribution_job'`).get()).toEqual({ id: job.body.data.notificationId });
    await processHqDistributionJobs(fx.f.db);
    expect(count(notices)).toBe(1);
    expect(count("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.redistributed'")).toBe(2);
    expect(fx.f.raw.pragma('foreign_key_check')).toEqual([]);
  });

  test('店は届いた版を取り込むと本部の中身に戻り、古い版を指した取り込みは409で何も書かない', async () => {
    const id = await distributed(['b']);
    const b = menuOf('b');
    fx.f.raw.prepare('UPDATE menus SET duration_minutes=80,is_active=1 WHERE id=?').run(b.id);
    const v2 = await fx.save(id, menu({ base_price: 9000 }));
    expect((await fx.redistribute(id, [(await fx.check(id, ['b'])).preflightId])).status).toBe(201);
    await processHqDistributionJobs(fx.f.db);
    const status = await fx.request<{ bound: boolean; customized: boolean; pendingVersion: { id: string; notices: string[] } }>(`/api/booking/admin/menus/${b.id}/hq-status?account_id=b`);
    expect(status.body.data).toMatchObject({ bound: true, customized: true, pendingVersion: { id: v2, notices: ['store_edited'] } });
    const stale = await storeMenu(String(b.id), 'hq-adopt', fx.binding(id, 'b')!.applied_version_id, 'b');
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('hq_version_conflict');
    expect(fx.f.raw.prepare('SELECT duration_minutes FROM menus WHERE id=?').get(b.id)).toEqual({ duration_minutes: 80 });
    const adopted = await storeMenu(String(b.id), 'hq-adopt', v2, 'b');
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    expect(fx.f.raw.prepare('SELECT base_price,duration_minutes,is_active,hq_customized,hq_template_version_id FROM menus WHERE id=?').get(b.id))
      .toEqual({ base_price: 9000, duration_minutes: 60, is_active: 1, hq_customized: 0, hq_template_version_id: v2 });
    expect(fx.binding(id, 'b')).toMatchObject({ applied_version_id: v2, pending_version_id: null });
    expect(count("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.store_adopted' AND line_account_id='b'")).toBe(1);
    // 同じ版をもう一度取り込んでも二重に書かない。
    expect((await storeMenu(String(b.id), 'hq-adopt', v2, 'b')).status).toBe(409);
  });

  test('今のままを選ぶとその版の知らせだけ消え、次の版でまた知らせる', async () => {
    const id = await distributed(['b']);
    const b = menuOf('b');
    fx.f.raw.prepare("UPDATE menus SET name='渋谷の初回相談' WHERE id=?").run(b.id);
    const v2 = await fx.save(id, menu({ description: '本部の説明' }));
    expect((await fx.redistribute(id, [(await fx.check(id, ['b'])).preflightId])).status).toBe(201);
    await processHqDistributionJobs(fx.f.db);
    expect(fx.binding(id, 'b')!.pending_version_id).toBe(v2);
    const dismissed = await storeMenu(String(b.id), 'hq-dismiss', v2, 'b');
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
    expect(fx.binding(id, 'b')).toMatchObject({ pending_version_id: null, dismissed_version_id: v2 });
    expect(fx.f.raw.prepare('SELECT name,description FROM menus WHERE id=?').get(b.id)).toEqual({ name: '渋谷の初回相談', description: null });
    // 同じ版はもう知らせない。
    const again = await fx.check(id, ['b']);
    expect(again.stores[0].redistribution?.outcome).toBe('unchanged');
    const v3 = await fx.save(id, menu({ description: '本部の説明2' }));
    expect((await fx.redistribute(id, [(await fx.check(id, ['b'])).preflightId])).status).toBe(201);
    await processHqDistributionJobs(fx.f.db);
    expect(fx.binding(id, 'b')).toMatchObject({ pending_version_id: v3, dismissed_version_id: v2 });
  });

  test('お支払いも本部の版どおりに配り直し、決済をつないでいない店はお店で払うにする。店が変えたお支払いは上書きしない', async () => {
    const id = await distributed();
    const a = menuOf('a'), b = menuOf('b');
    expect(count('SELECT COUNT(*) n FROM booking_payment_menu_settings')).toBe(0);
    fx.f.raw.exec("INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,connected_at) VALUES('a','stripe','acct_test_store_a','2026-11-15T00:00:00Z')");
    fx.f.raw.prepare("INSERT INTO booking_payment_menu_settings(menu_id,line_account_id,mode,provider,created_at,updated_at) VALUES(?,'b','customer_choice','stripe','2026-11-15','2026-11-15')").run(b.id);
    const v2 = await fx.save(id, menu({ paymentMode: 'online' }));
    const p = await fx.check(id, ['a', 'b']);
    expect(p.stores.map(s => [s.accountId, s.redistribution?.outcome])).toEqual([['a', 'apply'], ['b', 'pending']]);
    expect((await fx.redistribute(id, [p.preflightId])).status).toBe(201);
    await processHqDistributionJobs(fx.f.db);
    const payment = (menuId: unknown) => fx.f.raw.prepare('SELECT mode,provider FROM booking_payment_menu_settings WHERE menu_id=?').get(menuId);
    expect(payment(a.id)).toEqual({ mode: 'online', provider: 'stripe' });
    expect(payment(b.id)).toEqual({ mode: 'customer_choice', provider: 'stripe' });
    expect((await readCatalogTarget(fx.f.db, 'booking_menu', 'a', String(a.id)))!.hash).toBe(fx.binding(id, 'a')!.applied_snapshot_hash);
    // 決済をつないでいない店が取り込むと、お店で払うで入る。
    expect((await storeMenu(String(b.id), 'hq-adopt', v2, 'b')).status).toBe(200);
    expect(payment(b.id)).toEqual({ mode: 'onsite', provider: 'onsite' });
    // 本部が店のいつもの方法に戻すと、メニューの上書きを消して店の既定に戻す。
    const v3 = await fx.save(id, menu({ paymentMode: 'default' }));
    expect((await fx.redistribute(id, [(await fx.check(id, ['a', 'b'])).preflightId])).status).toBe(201);
    await processHqDistributionJobs(fx.f.db);
    expect(count('SELECT COUNT(*) n FROM booking_payment_menu_settings')).toBe(0);
    expect([fx.binding(id, 'a')!.applied_version_id, fx.binding(id, 'b')!.applied_version_id]).toEqual([v3, v3]);
  });

  test('本部でひな形を消すと、店の状態の口は対応なしを返し、新しい版の知らせも取り込みも出さない', async () => {
    const id = await distributed(['b']);
    const b = menuOf('b');
    fx.f.raw.prepare('UPDATE menus SET duration_minutes=80 WHERE id=?').run(b.id);
    const v2 = await fx.save(id, menu({ base_price: 9000 }));
    expect((await fx.redistribute(id, [(await fx.check(id, ['b'])).preflightId])).status).toBe(201);
    await processHqDistributionJobs(fx.f.db);
    expect(fx.binding(id, 'b')!.pending_version_id).toBe(v2);
    const detail = await fx.hq<{ template: { revision: number } }>(`/${id}`);
    expect((await fx.hq(`/${id}`, 'DELETE', { expectedRevision: detail.body.data.template.revision })).status).toBe(200);
    const status = await fx.request<{ bound: boolean; detached: string | null }>(`/api/booking/admin/menus/${b.id}/hq-status?account_id=b`);
    expect(status.body.data).toEqual({ bound: false, detached: 'template_archived' });
    expect((await storeMenu(String(b.id), 'hq-adopt', v2, 'b')).body.error).toBe('hq_template_unavailable');
    expect(fx.f.raw.prepare('SELECT duration_minutes,base_price,hq_template_id FROM menus WHERE id=?').get(b.id)).toEqual({ duration_minutes: 80, base_price: 3000, hq_template_id: null });
  });

  test('閲覧のみ・担当外の店・代理ログインの読み取りでは取り込みも今のままもできない', async () => {
    const id = await distributed(['b']);
    const b = menuOf('b');
    fx.f.raw.prepare('UPDATE menus SET duration_minutes=80 WHERE id=?').run(b.id);
    const v2 = await fx.save(id, menu({ base_price: 9000 }));
    expect((await fx.redistribute(id, [(await fx.check(id, ['b'])).preflightId])).status).toBe(201);
    await processHqDistributionJobs(fx.f.db);
    fx.setStaff({ readOnly: true });
    expect((await storeMenu(String(b.id), 'hq-adopt', v2, 'b')).status).toBe(403);
    expect((await storeMenu(String(b.id), 'hq-dismiss', v2, 'b')).status).toBe(403);
    fx.setStaff({ readOnly: false });
    fx.setImpersonation('read');
    fx.setStaff({ readOnly: true });
    expect((await storeMenu(String(b.id), 'hq-adopt', v2, 'b')).status).toBe(403);
    fx.setImpersonation(null);
    fx.setStaff({ readOnly: false, id: 'other-owner', tenantId: 'other' });
    expect((await storeMenu(String(b.id), 'hq-adopt', v2, 'b')).status).toBe(403);
    fx.setStaff({ id: 'owner', tenantId: 't', role: 'staff' });
    expect((await storeMenu(String(b.id), 'hq-adopt', v2, 'b')).status).toBe(403);
    expect(fx.binding(id, 'b')).toMatchObject({ pending_version_id: v2, dismissed_version_id: null });
    expect(fx.f.raw.prepare('SELECT duration_minutes,base_price FROM menus WHERE id=?').get(b.id)).toEqual({ duration_minutes: 80, base_price: 3000 });
    // 書き込みの代理ログインは、店のメニューの編集と同じ入口の判断で取り込める。
    fx.setStaff({ role: 'owner' });
    fx.setImpersonation('write');
    expect((await storeMenu(String(b.id), 'hq-adopt', v2, 'b')).status).toBe(200);
  });
});

describe('配り直しの受け付け', () => {
  async function bound(accountIds = ['a']) {
    const id = await fx.create('booking_menu');
    expect((await fx.run(id, await fx.check(id, accountIds))).body.data.status).toBe('completed');
    await fx.save(id, menu({ base_price: 9000 }));
    return id;
  }

  test('同じ依頼キーの再送は同じジョブを返し、中身の違う再送と使用済みの確かめは断る', async () => {
    const id = await bound(['a', 'b']);
    const p = await fx.check(id, ['a', 'b']);
    const first = await fx.redistribute(id, [p.preflightId], 'same-key-001');
    expect(first.status).toBe(201);
    const replay = await fx.redistribute(id, [p.preflightId], 'same-key-001');
    expect(replay.status).toBe(200);
    expect(replay.body.data.jobId).toBe(first.body.data.jobId);
    const other = await fx.check(id, ['a']);
    expect((await fx.redistribute(id, [other.preflightId], 'same-key-001')).body.code).toBe('IDEMPOTENCY_CONFLICT');
    const reuse = await fx.redistribute(id, [p.preflightId], 'other-key-01');
    expect(reuse.status).toBe(409);
    expect(count('SELECT COUNT(*) n FROM hq_template_distribution_jobs')).toBe(1);
    expect(count('SELECT COUNT(*) n FROM hq_template_distribution_job_items')).toBe(2);
    // 配り直しに使った確かめでは、名前で選ぶ配布もできない。
    const named = await fx.run(id, p, 'create');
    expect(named.status).toBe(409);
    expect(named.body.code).toBe('PREFLIGHT_CONSUMED');
  });

  test('期限切れ・配布に使った確かめ・他人の確かめ・保存で版が進んだ確かめ・対応のない店だけの依頼は断る', async () => {
    const id = await bound();
    const expired = await fx.check(id);
    vi.setSystemTime(new Date('2026-11-16T00:31:00Z'));
    expect((await fx.redistribute(id, [expired.preflightId])).body.code).toBe('PREFLIGHT_EXPIRED');
    const used = await fx.check(id);
    await fx.run(id, used, 'create');
    expect((await fx.redistribute(id, [used.preflightId])).body.code).toBe('PREFLIGHT_CONSUMED');
    const stale = await fx.check(id);
    await fx.save(id, menu({ base_price: 9900 }));
    expect((await fx.redistribute(id, [stale.preflightId])).body.code).toBe('VERSION_CONFLICT');
    const unbound = await fx.check(id, ['b']);
    expect((await fx.redistribute(id, [unbound.preflightId])).body.code).toBe('NO_BOUND_STORES');
    fx.f.raw.exec("INSERT INTO staff_members(id,name,role,api_key,tenant_id) VALUES('owner2','Owner2','owner','unused2','t')");
    const mine = await fx.check(id);
    fx.setStaff({ id: 'owner2' });
    expect((await fx.redistribute(id, [mine.preflightId])).status).toBe(404);
    expect(count('SELECT COUNT(*) n FROM hq_template_distribution_jobs')).toBe(0);
  });

  test('対応のない店は飛ばして返し、閲覧のみ・代理ログイン・別の統括は依頼できない', async () => {
    const id = await bound(['a']);
    const p = await fx.check(id, ['a', 'b']);
    fx.setStaff({ readOnly: true });
    expect((await fx.redistribute(id, [p.preflightId])).status).toBe(403);
    fx.setStaff({ readOnly: false });
    fx.setImpersonation('write');
    expect((await fx.redistribute(id, [p.preflightId])).status).toBe(403);
    fx.setImpersonation(null);
    fx.setStaff({ id: 'other-owner', tenantId: 'other' });
    expect((await fx.redistribute(id, [p.preflightId])).status).toBe(404);
    fx.setStaff({ id: 'owner', tenantId: 't' });
    const created = await fx.redistribute(id, [p.preflightId]);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ skippedAccountIds: ['b'], counts: { total: 1 } });
    // 別の統括からはジョブの結果も見えない。
    fx.setStaff({ id: 'other-owner', tenantId: 'other' });
    expect((await fx.hq(`/${id}/redistributions/${created.body.data.jobId}`)).status).toBe(404);
  });
});
