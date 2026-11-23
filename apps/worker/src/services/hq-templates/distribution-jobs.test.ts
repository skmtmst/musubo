import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTestD1 } from '../../test-utils/d1-sqlite.js';
import { useSqliteClock } from '../../test-utils/sqlite-clock.js';
import { catalogDefinitions, createCatalogFixture, type CatalogFixture } from '../../test-utils/hq-catalog-fixture.js';
import { processHqDistributionJobs, REDISTRIBUTION_MAX_ATTEMPTS, runRedistributionItem, type RedistributionItemRow } from './distribution-jobs.js';

let fx: CatalogFixture;
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function open(options: { file?: string } = {}) { fx = createCatalogFixture(options); cleanups.push(() => fx.close()); return fx; }

const menu = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, settings: { ...catalogDefinitions.booking_menu.settings, ...overrides } });
const count = (sql: string, ...args: unknown[]) => (fx.f.raw.prepare(sql).get(...args) as { n: number }).n;
const menuOf = (accountId: string) => fx.f.raw.prepare('SELECT * FROM menus WHERE line_account_id=? AND hq_template_id IS NOT NULL LIMIT 1').get(accountId) as Record<string, unknown>;
const item = (accountId: string) => fx.f.raw.prepare('SELECT * FROM hq_template_distribution_job_items WHERE target_account_id=?').get(accountId) as RedistributionItemRow & { lease_token: string | null; lease_expires_at: string | null };
const job = () => fx.f.raw.prepare('SELECT * FROM hq_template_distribution_jobs').get() as { id: string; status: string; notification_id: string | null };
const finished = () => count("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.redistribution_finished'");
const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

/** 2店へ配ってから本部が値段を変え、配り直しのジョブを受け付けた状態を作る。 */
async function acceptedJob(accountIds = ['a', 'b']) {
  const id = await fx.create('booking_menu');
  expect((await fx.run(id, await fx.check(id, accountIds))).body.data.status).toBe('completed');
  const v2 = await fx.save(id, menu({ base_price: 9000 }));
  const created = await fx.redistribute(id, [(await fx.check(id, accountIds)).preflightId]);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { id, v2, jobId: created.body.data.jobId };
}

describe('配り直しのジョブの札と再開', () => {
  test('期限の切れた札では書けず、取り直した実行者が1回だけ書く', async () => {
    open();
    const { id, v2 } = await acceptedJob(['a']);
    fx.f.raw.prepare("UPDATE hq_template_distribution_job_items SET status='running',lease_token='stale',lease_expires_at=?,attempt_count=1").run(new Date(Date.now() - 1000).toISOString());
    expect(await runRedistributionItem(fx.f.db, item('a'), 'stale')).toBe('retry');
    expect(menuOf('a').base_price).toBe(3000);
    expect(item('a')).toMatchObject({ status: 'running', lease_token: 'stale', attempt_count: 1 });
    const versions = count('SELECT COUNT(*) n FROM menu_versions WHERE menu_id=?', menuOf('a').id);
    await processHqDistributionJobs(fx.f.db);
    expect(item('a')).toMatchObject({ status: 'succeeded', lease_token: null, attempt_count: 2 });
    expect(menuOf('a')).toMatchObject({ base_price: 9000, hq_template_version_id: v2 });
    // 遅れて戻ってきた古い実行者は、終わった店に何も書けない。
    expect(await runRedistributionItem(fx.f.db, item('a'), 'stale')).toBe('retry');
    expect(count('SELECT COUNT(*) n FROM menu_versions WHERE menu_id=?', menuOf('a').id)).toBe(versions + 1);
    expect(count("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.redistributed'")).toBe(1);
    expect(fx.binding(id, 'a')).toMatchObject({ applied_version_id: v2, row_version: 2 });
  });

  test('同じ接続で同時に2回動かしても、店ごとに1回だけ書く', async () => {
    open();
    const { id, v2 } = await acceptedJob();
    const before = { a: count('SELECT COUNT(*) n FROM menu_versions WHERE menu_id=?', menuOf('a').id), b: count('SELECT COUNT(*) n FROM menu_versions WHERE menu_id=?', menuOf('b').id) };
    await Promise.all([processHqDistributionJobs(fx.f.db), processHqDistributionJobs(fx.f.db)]);
    expect([item('a').attempt_count, item('b').attempt_count]).toEqual([1, 1]);
    expect(count('SELECT COUNT(*) n FROM menu_versions WHERE menu_id=?', menuOf('a').id)).toBe(before.a + 1);
    expect(count('SELECT COUNT(*) n FROM menu_versions WHERE menu_id=?', menuOf('b').id)).toBe(before.b + 1);
    expect(count("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.redistributed'")).toBe(2);
    expect(job().status).toBe('completed');
    expect(finished()).toBe(1);
    expect([fx.binding(id, 'a')!.row_version, fx.binding(id, 'b')!.applied_version_id]).toEqual([2, v2]);
  });

  test('別々の接続から同時に動かしても二重にしない', async () => {
    const file = join(tmpdir(), `hq-redistribution-${crypto.randomUUID()}.sqlite`);
    cleanups.push(() => { for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true }); });
    open({ file });
    const { v2 } = await acceptedJob();
    const second = createTestD1({ file, attach: true, foreignKeys: true });
    useSqliteClock(second.raw, () => new Date());
    cleanups.push(() => second.raw.close());
    await Promise.all([processHqDistributionJobs(fx.f.db), processHqDistributionJobs(second.db)]);
    expect([item('a').status, item('b').status]).toEqual(['succeeded', 'succeeded']);
    expect([item('a').attempt_count, item('b').attempt_count]).toEqual([1, 1]);
    expect(count("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.redistributed'")).toBe(2);
    expect([menuOf('a').hq_template_version_id, menuOf('b').hq_template_version_id]).toEqual([v2, v2]);
    expect(finished()).toBe(1);
  });

  test('途中で書けなかった店は待ってから取り直して完了し、完了の知らせは1回だけ作る', async () => {
    open();
    await acceptedJob();
    fx.f.raw.exec("CREATE TRIGGER fail_store_b BEFORE UPDATE OF base_price ON menus WHEN NEW.line_account_id='b' BEGIN SELECT RAISE(ABORT,'store down'); END");
    await processHqDistributionJobs(fx.f.db);
    expect(item('a').status).toBe('succeeded');
    expect(item('b')).toMatchObject({ status: 'pending', attempt_count: 1, lease_token: null });
    expect(job().status).toBe('running');
    expect(finished()).toBe(0);
    // 待つ間は取り直さない。
    await processHqDistributionJobs(fx.f.db);
    expect(item('b').attempt_count).toBe(1);
    fx.f.raw.exec('DROP TRIGGER fail_store_b');
    advance(61_000);
    await processHqDistributionJobs(fx.f.db);
    expect(item('b')).toMatchObject({ status: 'succeeded', attempt_count: 2 });
    expect(menuOf('b').base_price).toBe(9000);
    expect(job().status).toBe('completed');
    expect(finished()).toBe(1);
    expect(fx.f.raw.prepare("SELECT id FROM audit_events WHERE action='hq_template.redistribution_finished'").get()).toEqual({ id: job().notification_id });
  });

  test('書けない店は試行の上限で失敗として閉じ、ジョブは一部できなかったで終わる', async () => {
    open();
    await acceptedJob();
    fx.f.raw.exec("CREATE TRIGGER fail_store_b BEFORE UPDATE OF base_price ON menus WHEN NEW.line_account_id='b' BEGIN SELECT RAISE(ABORT,'store down'); END");
    for (let attempt = 1; attempt <= REDISTRIBUTION_MAX_ATTEMPTS; attempt++) {
      await processHqDistributionJobs(fx.f.db);
      expect(item('b').attempt_count).toBe(attempt);
      advance(61_000);
    }
    expect(item('b').status).toBe('pending');
    await processHqDistributionJobs(fx.f.db);
    expect(item('b')).toMatchObject({ status: 'failed', error_code: 'attempts_exhausted', attempt_count: REDISTRIBUTION_MAX_ATTEMPTS });
    expect(menuOf('b').base_price).toBe(3000);
    expect(job().status).toBe('partial');
    await processHqDistributionJobs(fx.f.db);
    expect(finished()).toBe(1);
  });
});

describe('読んでから書くまでの割り込み', () => {
  /** 店へ書く batch が走る直前に、別の操作で店の物や対応表を変える。 */
  function interrupt(change: () => void) {
    const original = fx.f.db.batch.bind(fx.f.db);
    let done = false;
    fx.f.db.batch = (async (statements: D1PreparedStatement[]) => {
      if (!done && statements.some(statement => /hq_template_version_id=\?,hq_customized=0/.test((statement as unknown as { sql?: string }).sql ?? ''))) { done = true; change(); }
      return original(statements);
    }) as typeof fx.f.db.batch;
  }

  test('店がメニューを変えたら、その batch は書かずに取り直し、次の試行で店の判断待ちにする', async () => {
    open();
    const { id, v2 } = await acceptedJob(['a']);
    interrupt(() => fx.f.raw.prepare('UPDATE menus SET duration_minutes=80 WHERE id=?').run(menuOf('a').id));
    await processHqDistributionJobs(fx.f.db);
    expect(item('a')).toMatchObject({ status: 'pending', attempt_count: 1 });
    expect(menuOf('a')).toMatchObject({ base_price: 3000, duration_minutes: 80 });
    advance(61_000);
    await processHqDistributionJobs(fx.f.db);
    expect(item('a')).toMatchObject({ status: 'succeeded', error_code: 'store_review_pending', attempt_count: 2 });
    expect(menuOf('a')).toMatchObject({ base_price: 3000, duration_minutes: 80 });
    expect(fx.binding(id, 'a')).toMatchObject({ pending_version_id: v2 });
  });

  test('対応表が先に変わったら、その batch は書かずに取り直す', async () => {
    open();
    const { id, v2 } = await acceptedJob(['a']);
    interrupt(() => fx.f.raw.prepare('UPDATE hq_template_store_bindings SET row_version=row_version+1 WHERE template_id=?').run(id));
    await processHqDistributionJobs(fx.f.db);
    expect(item('a')).toMatchObject({ status: 'pending', attempt_count: 1 });
    expect(menuOf('a').base_price).toBe(3000);
    advance(61_000);
    await processHqDistributionJobs(fx.f.db);
    expect(item('a')).toMatchObject({ status: 'succeeded', error_code: null });
    expect(fx.binding(id, 'a')).toMatchObject({ applied_version_id: v2, row_version: 3 });
  });
});

describe('書く直前の確かめ直し', () => {
  test.each([
    ['ひな形が保存し直された', 'template_version_changed', async (id: string) => { await fx.save(id, menu({ base_price: 9900 })); }],
    ['作った人が閲覧のみになった', 'actor_unauthorized', async () => { fx.f.raw.exec("UPDATE staff_members SET access_level='read_only' WHERE id='owner'"); }],
    ['作った人が店ごとの担当になった', 'actor_unauthorized', async () => { fx.f.raw.exec("UPDATE staff_members SET account_scope='accounts' WHERE id='owner'"); }],
    ['店が止まった', 'store_unavailable', async () => { fx.f.raw.exec("UPDATE line_accounts SET is_active=0 WHERE id IN ('a','b')"); }],
    ['ひな形が保管された', 'template_unavailable', async (id: string) => { fx.f.raw.prepare("UPDATE hq_templates SET archived_at='2026-11-16T00:00:00Z' WHERE id=?").run(id); }],
  ] as const)('%s時は書かずに失敗として記録する', async (_label, code, change) => {
    open();
    const { id } = await acceptedJob();
    await change(id);
    await processHqDistributionJobs(fx.f.db);
    expect([item('a'), item('b')].map(row => [row.status, row.error_code])).toEqual([['failed', code], ['failed', code]]);
    expect(fx.f.raw.prepare('SELECT base_price FROM menus WHERE hq_template_id IS NOT NULL OR base_price=3000 ORDER BY line_account_id').all()).toEqual([{ base_price: 3000 }, { base_price: 3000 }]);
    expect(job().status).toBe('failed');
    expect(finished()).toBe(1);
  });

  test('店が削除したメニューは失敗として記録して対応は残し、出所の欄が食い違う店は書かない', async () => {
    open();
    const { id } = await acceptedJob();
    fx.f.raw.prepare("UPDATE menus SET deleted_at='2026-11-16T00:00:00Z' WHERE id=?").run(menuOf('a').id);
    const b = menuOf('b');
    fx.f.raw.prepare('UPDATE menus SET hq_template_id=NULL,hq_template_version_id=NULL WHERE id=?').run(b.id);
    await processHqDistributionJobs(fx.f.db);
    expect([item('a'), item('b')].map(row => [row.status, row.error_code])).toEqual([['failed', 'target_missing'], ['conflict', 'origin_mismatch']]);
    expect(fx.binding(id, 'a')).toBeDefined();
    expect(fx.f.raw.prepare('SELECT base_price FROM menus WHERE id=?').get(b.id)).toEqual({ base_price: 3000 });
    expect(job().status).toBe('failed');
  });
});
