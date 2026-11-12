import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_NEN_RANKS,
  DEFAULT_NEN_MILESTONES,
  NenRankValidationError,
  ensureNenRankDefaults,
  getNenLifetimeMilestones,
  getNenMemberKpis,
  getNenRankRules,
  getNenRankSettings,
  listNenMembers,
  resolveRank,
  saveNenLifetimeMilestones,
  saveNenRankSettings,
  setNenRankSyncStatus,
  validateNenRankInputs,
} from './nen-member-ranks.js';

/**
 * 会員ランク（通年）の設定と一覧。★37-1 / 37-1-A / 37-1-B。
 * bootstrap.sql（migration 410 を含む）を流した実SQLiteで、
 * 「初期値が1回だけ入る」「保存で版が上がり同期待ちに戻る」「レギュラーは消せない」
 * 「一覧が見える範囲と絞り込みを守る」を固定する。
 */

const packageRoot = join(import.meta.dirname, '..');
const bootstrap = readFileSync(join(packageRoot, 'bootstrap.sql'), 'utf8');

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
      runSync() { return statement.run(...params); },
      async run<T>() {
        const result = statement.run(...params);
        return { success: true, meta: { changes: result.changes }, results: [] } as T;
      },
    } as unknown as D1PreparedStatement);
    return bound([]);
  }
  const batch = async (statements: D1PreparedStatement[]) => sqlite.transaction(() =>
    statements.map((item) => (item as unknown as { runSync: () => unknown }).runSync()),
  )();
  return { prepare, batch } as unknown as D1Database;
}

const ACCOUNT = 'account-nen';
const NOW = '2026-09-16T10:00:00.000';

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(bootstrap);
  sqlite.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('${ACCOUNT}', 'channel-nen', '然', 'token', 'secret'), ('account-other', 'channel-o', '別', 'token', 'secret');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following, created_at, updated_at) VALUES
      ('friend-a', 'U-a', '見本 141', '${ACCOUNT}', 1, '${NOW}', '${NOW}'),
      ('friend-b', 'U-b', '見本 176', '${ACCOUNT}', 1, '${NOW}', '${NOW}'),
      ('friend-c', 'U-c', '別店の人', 'account-other', 1, '${NOW}', '${NOW}'),
      ('friend-d', 'U-d', 'ブロック中', '${ACCOUNT}', 0, '${NOW}', '${NOW}');
    INSERT INTO nen_ec_member_snapshots (friend_id, customer_id, purchase_count, purchase_amount, point_balance, member_rank, synced_at,
      annual_miles_yen, lifetime_miles_yen, member_rank_key, mile_rate_percent, mile_balance, miles_used_this_month, last_purchased_at) VALUES
      ('friend-a', '10231', 12, 412300, 2840, 'プラチナ', '${NOW}', 138600, 412300, 'platinum', 3, 2840, 500, '2026-09-12'),
      ('friend-b', '10877', 5, 96800, 1120, 'ゴールド', '${NOW}', 72400, 96800, 'gold', 2, 1120, 0, '2026-09-10'),
      ('friend-c', '20000', 1, 5000, 0, '会員', '${NOW}', 5000, 5000, 'regular', 1, 0, 0, NULL),
      ('friend-d', '30000', 1, 5000, 0, '会員', '${NOW}', 5000, 5000, 'regular', 1, 0, 0, NULL);
    INSERT INTO nen_pet_profiles (id, friend_id, name, animal_type, created_at, updated_at) VALUES
      ('pet-a1', 'friend-a', 'そら', 'dog', '${NOW}', '${NOW}'),
      ('pet-a2', 'friend-a', 'ハナ', 'dog', '${NOW}', '${NOW}'),
      ('pet-b1', 'friend-b', 'むぎ', 'cat', '${NOW}', '${NOW}');
  `);
  db = asD1(sqlite);
});

describe('ensureNenRankDefaults', () => {
  it('初期の4ランク・ルール・4節目を1回だけ入れ、既存のランクタグにつなぐ', async () => {
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    const ranks = await getNenRankSettings(db, ACCOUNT);
    expect(ranks.map((r) => [r.rank_key, r.annual_threshold_yen, r.mile_rate_percent, r.tag_id])).toEqual(
      DEFAULT_NEN_RANKS.map((r) => [r.key, r.thresholdYen, r.ratePercent, r.tagId]),
    );
    expect((await getNenRankRules(db, ACCOUNT))?.version).toBe(1);
    expect((await getNenLifetimeMilestones(db, ACCOUNT)).map((m) => m.threshold_yen)).toEqual([300_000, 600_000, 1_000_000, 2_000_000]);
  });

  it('新しい初期節目は通知オフ、既存の節目は再初期化でも変えない', async () => {
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    const initial = await getNenLifetimeMilestones(db, ACCOUNT);
    expect(initial.map(row => row.notify_on_reach)).toEqual([0, 0, 0, 0]);
    sqlite.prepare('UPDATE nen_lifetime_milestones SET notify_on_reach = 1 WHERE id = ?').run(initial[0].id);
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    expect((await getNenLifetimeMilestones(db, ACCOUNT))[0].notify_on_reach).toBe(1);
  });

  it('初期化済みの店が節目を空にした後は再初期化で復活しない', async () => {
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    sqlite.prepare('DELETE FROM nen_lifetime_milestones WHERE line_account_id = ?').run(ACCOUNT);
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    expect(await getNenLifetimeMilestones(db, ACCOUNT)).toEqual([]);
  });

  it.each(['rank', 'milestone'])('%s の途中失敗は全体を巻き戻し、再試行で全件作る', async (target) => {
    const table = target === 'rank' ? 'nen_rank_settings' : 'nen_lifetime_milestones';
    const condition = target === 'rank' ? "NEW.rank_key = 'silver'" : 'NEW.threshold_yen = 600000';
    sqlite.exec(`CREATE TRIGGER fail_init BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    await expect(ensureNenRankDefaults(db, ACCOUNT, NOW)).rejects.toThrow('injected failure');
    const count = (name: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE line_account_id = ?`).get(ACCOUNT) as { n: number }).n;
    expect([count('nen_rank_settings'), count('nen_rank_rules'), count('nen_lifetime_milestones')]).toEqual([0, 0, 0]);
    sqlite.exec('DROP TRIGGER fail_init');
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    expect([count('nen_rank_settings'), count('nen_rank_rules'), count('nen_lifetime_milestones')]).toEqual([4, 1, 4]);
  });

  it('並行する初期化と再試行で重複しない', async () => {
    await Promise.all(Array.from({ length: 8 }, () => ensureNenRankDefaults(db, ACCOUNT, NOW)));
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    expect((await getNenRankSettings(db, ACCOUNT)).map((rank) => rank.rank_key)).toEqual(DEFAULT_NEN_RANKS.map((rank) => rank.key));
    expect(await getNenLifetimeMilestones(db, ACCOUNT)).toHaveLength(DEFAULT_NEN_MILESTONES.length);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM nen_rank_rules WHERE line_account_id = ?').get(ACCOUNT)).toEqual({ n: 1 });
  });

  it('独立した2接続が同時に開始しても初期値は1組だけ作られる', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nen-rank-init-'));
    const file = join(directory, 'synthetic.sqlite');
    try {
      const initial = new Database(file);
      initial.exec(bootstrap);
      initial.exec("INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('synthetic', 'synthetic', 'sample', 'sample', 'sample')");
      initial.close();
      let captured: Array<{ sql: string; args: unknown[] }> = [];
      const captureDb = {
        prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }),
        batch: async (statements: Array<{ sql: string; args: unknown[] }>) => { captured = statements; return []; },
      } as unknown as D1Database;
      await ensureNenRankDefaults(captureDb, 'synthetic', NOW);
      const barrier = new SharedArrayBuffer(4);
      const modulePath = createRequire(import.meta.url).resolve('better-sqlite3');
      const script = `
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.modulePath);
        const db = new Database(workerData.file, { timeout: 10000 });
        const barrier = new Int32Array(workerData.barrier);
        Atomics.add(barrier, 0, 1); Atomics.notify(barrier, 0);
        while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 10000);
        try {
          db.transaction(() => { for (const s of workerData.statements) db.prepare(s.sql).run(...s.args); }).immediate();
          parentPort.postMessage({ ok: true });
        } catch (error) { parentPort.postMessage({ ok: false, error: String(error) }); }
        finally { db.close(); }
      `;
      const run = () => new Promise<void>((resolve, reject) => {
        const worker = new Worker(script, { eval: true, workerData: { file, modulePath, barrier, statements: captured } });
        worker.once('message', (result: { ok: boolean; error?: string }) => result.ok ? resolve() : reject(new Error(result.error)));
        worker.once('error', reject);
      });
      await Promise.all([run(), run()]);
      const result = new Database(file, { readonly: true });
      try {
        for (const [table, expected] of [['nen_rank_settings', 4], ['nen_rank_rules', 1], ['nen_lifetime_milestones', 4]] as const) {
          expect(result.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE line_account_id = ?`).get('synthetic')).toEqual({ n: expected });
        }
      } finally { result.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 20000);

  it('ランクの部分設定と空の節目は保持し、ルールだけ初期化する', async () => {
    sqlite.exec(`INSERT INTO nen_rank_settings (id, line_account_id, rank_key, name, annual_threshold_yen, mile_rate_percent, sort_order, created_at, updated_at)
      VALUES ('partial-rank', '${ACCOUNT}', 'custom', '独自', 0, 4, 0, '${NOW}', '${NOW}')`);
    const before = sqlite.prepare('SELECT * FROM nen_rank_settings WHERE line_account_id = ?').all(ACCOUNT);
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    expect(sqlite.prepare('SELECT * FROM nen_rank_settings WHERE line_account_id = ?').all(ACCOUNT)).toEqual(before);
    expect(await getNenLifetimeMilestones(db, ACCOUNT)).toEqual([]);
    expect(await getNenRankRules(db, ACCOUNT)).not.toBeNull();
  });

  it('既存設定がある状態で失敗しても、既存行を保ち新規分は戻す', async () => {
    sqlite.exec(`INSERT INTO nen_rank_settings (id, line_account_id, rank_key, name, annual_threshold_yen, mile_rate_percent, sort_order, created_at, updated_at)
      VALUES ('partial-rank', '${ACCOUNT}', 'custom', '独自', 0, 4, 0, '${NOW}', '${NOW}');
      CREATE TRIGGER fail_rules BEFORE INSERT ON nen_rank_rules BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const before = sqlite.prepare('SELECT * FROM nen_rank_settings WHERE line_account_id = ?').all(ACCOUNT);
    await expect(ensureNenRankDefaults(db, ACCOUNT, NOW)).rejects.toThrow('injected failure');
    expect(sqlite.prepare('SELECT * FROM nen_rank_settings WHERE line_account_id = ?').all(ACCOUNT)).toEqual(before);
    expect(await getNenRankRules(db, ACCOUNT)).toBeNull();
    expect(await getNenLifetimeMilestones(db, ACCOUNT)).toEqual([]);
  });

  it('既存の部分設定と別アカウントを変更・補完しない', async () => {
    sqlite.exec(`INSERT INTO nen_rank_settings (id, line_account_id, rank_key, name, annual_threshold_yen, mile_rate_percent, sort_order, created_at, updated_at)
      VALUES ('custom-rank', '${ACCOUNT}', 'custom', '独自', 0, 4, 0, '${NOW}', '${NOW}'),
             ('other-rank', 'account-other', 'other', '別設定', 0, 5, 0, '${NOW}', '${NOW}');
      INSERT INTO nen_lifetime_milestones (id, line_account_id, threshold_yen, title, notify_on_reach, sort_order, created_at, updated_at)
      VALUES ('custom-milestone', '${ACCOUNT}', 123456, '独自節目', 0, 0, '${NOW}', '${NOW}'),
             ('other-milestone', 'account-other', 500, '別節目', 0, 0, '${NOW}', '${NOW}');
      INSERT INTO nen_rank_rules (line_account_id, year_start_month, updated_at) VALUES ('${ACCOUNT}', 4, '${NOW}'), ('account-other', 5, '${NOW}');`);
    const snapshot = () => ['nen_rank_settings', 'nen_rank_rules', 'nen_lifetime_milestones'].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    await ensureNenRankDefaults(db, ACCOUNT, '2026-10-01T00:00:00.000');
    expect(snapshot()).toEqual(before);
  });
});

describe('saveNenRankSettings', () => {
  it('しきい値順に並べ直し、版を上げて同期待ちに戻す。渡さなかった行は消える', async () => {
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    const before = await getNenRankSettings(db, ACCOUNT);
    const regular = before.find((r) => r.rank_key === 'regular')!;
    const silver = before.find((r) => r.rank_key === 'silver')!;
    await setNenRankSyncStatus(db, ACCOUNT, 'synced', null, NOW);
    const saved = await saveNenRankSettings(db, ACCOUNT, [
      { name: 'ダイヤモンド', annualThresholdYen: 300_000, mileRatePercent: 5 },
      { id: silver.id, name: 'シルバー', annualThresholdYen: 40_000, mileRatePercent: 1.5 },
      { id: regular.id, name: 'レギュラー', annualThresholdYen: 0, mileRatePercent: 1 },
    ], NOW);
    expect(saved.map((r) => [r.name, r.annual_threshold_yen])).toEqual([
      ['レギュラー', 0], ['シルバー', 40_000], ['ダイヤモンド', 300_000],
    ]);
    expect(saved.find((r) => r.name === 'シルバー')?.id).toBe(silver.id);
    expect(saved.find((r) => r.name === 'ダイヤモンド')?.tag_id).toBeNull();
    const rules = await getNenRankRules(db, ACCOUNT);
    expect(rules?.version).toBe(2);
    expect(rules?.sync_status).toBe('pending');
  });

  it('検証：0円のランクが無い・重なる・還元率が範囲外は保存しない', () => {
    expect(() => validateNenRankInputs([{ name: 'A', annualThresholdYen: 1000, mileRatePercent: 1 }])).toThrow(NenRankValidationError);
    expect(() => validateNenRankInputs([
      { name: 'A', annualThresholdYen: 0, mileRatePercent: 1 },
      { name: 'B', annualThresholdYen: 0, mileRatePercent: 2 },
    ])).toThrow('同じしきい値');
    expect(() => validateNenRankInputs([{ name: 'A', annualThresholdYen: 0, mileRatePercent: 11 }])).toThrow('マイル還元');
    expect(() => validateNenRankInputs([{ name: '', annualThresholdYen: 0, mileRatePercent: 1 }])).toThrow('ランク名');
  });
});

describe('saveNenLifetimeMilestones', () => {
  it('金額順に保存し、消した節目は無くなる', async () => {
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    const saved = await saveNenLifetimeMilestones(db, ACCOUNT, [
      { thresholdYen: 500_000, title: 'NEN FAMILY', notifyOnReach: true },
      { thresholdYen: 100_000, title: 'はじめの一歩', notifyOnReach: false },
    ], NOW);
    expect(saved.map((m) => [m.threshold_yen, m.title, m.notify_on_reach])).toEqual([[100_000, 'はじめの一歩', 0], [500_000, 'NEN FAMILY', 1]]);
    expect((await getNenRankRules(db, ACCOUNT))?.version).toBe(2);
  });
});

describe('resolveRank', () => {
  it('通年の金額でしきい値以上の最上位を選び、ECのランクキーがあればそれを優先する', async () => {
    await ensureNenRankDefaults(db, ACCOUNT, NOW);
    const ranks = await getNenRankSettings(db, ACCOUNT);
    expect(resolveRank(ranks, 72_400).rank?.rank_key).toBe('gold');
    expect(resolveRank(ranks, 72_400).next?.rank_key).toBe('platinum');
    expect(resolveRank(ranks, 0).rank?.rank_key).toBe('regular');
    expect(resolveRank(ranks, 999_999).next).toBeNull();
    expect(resolveRank(ranks, 0, 'platinum').rank?.rank_key).toBe('platinum');
    expect(resolveRank(ranks, 72_400, 'unknown-key').rank?.rank_key).toBe('gold');
  });
});

describe('listNenMembers / getNenMemberKpis', () => {
  it('見える範囲の友だちだけを通年の多い順に返し、ペットの頭数と名前が付く', async () => {
    const { items, total } = await listNenMembers(db, { accountIds: [ACCOUNT] });
    expect(total).toBe(2);
    expect(items.map((i) => i.friend_id)).toEqual(['friend-a', 'friend-b']);
    expect(items[0]!.pet_count).toBe(2);
    expect(items[0]!.pet_names).toBe('そら（犬）、ハナ（犬）');
    expect(items[1]!.pet_names).toBe('むぎ（猫）');
  });

  it('ランク・ペットの有無・検索で絞り込める', async () => {
    expect((await listNenMembers(db, { accountIds: [ACCOUNT], rankKey: 'gold' })).items.map((i) => i.friend_id)).toEqual(['friend-b']);
    expect((await listNenMembers(db, { accountIds: [ACCOUNT], query: '10231' })).items.map((i) => i.friend_id)).toEqual(['friend-a']);
    expect((await listNenMembers(db, { accountIds: [ACCOUNT], query: '176' })).items.map((i) => i.friend_id)).toEqual(['friend-b']);
    expect((await listNenMembers(db, { accountIds: [], })).total).toBe(0);
  });

  it('今月の購入は入金済みの当月注文だけを数える（返金・取消・先月は数えない）', async () => {
    // 本体と同じくJSTで月を取る。JSTの15日正午（＝UTCの15日3時）は実行月の中に必ず入る。
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const stamp = (monthOffset: number) =>
      new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() + monthOffset, 15, 3, 0, 0))
        .toISOString().replace('T', ' ').slice(0, 19);
    const thisMonth = stamp(0);
    const lastMonth = stamp(-1);
    sqlite.exec(`
      INSERT INTO ec_events (id, source, external_event_id, event_type, line_user_id, payload, received_at, updated_at)
      VALUES ('ev-1', 'eccube', 'ext-1', 'order.created', 'U-a', '{}', '${thisMonth}', '${thisMonth}');
      INSERT INTO ec_orders (id, line_account_id, source_key, external_order_id, friend_id, order_number,
        normalized_status, provider_status, total_amount_minor, ordered_at, last_event_id, created_at, updated_at) VALUES
        ('o-a1', '${ACCOUNT}', 'ec', 'ext-a1', 'friend-a', 'N1', 'current', 'paid', 5000, '${thisMonth}', 'ev-1', '${thisMonth}', '${thisMonth}'),
        ('o-a2', '${ACCOUNT}', 'ec', 'ext-a2', 'friend-a', 'N2', 'current', 'paid', 3000, '${thisMonth}', 'ev-1', '${thisMonth}', '${thisMonth}'),
        ('o-b1', '${ACCOUNT}', 'ec', 'ext-b1', 'friend-b', 'N3', 'current', 'paid', 2000, '${thisMonth}', 'ev-1', '${thisMonth}', '${thisMonth}'),
        ('o-b2', '${ACCOUNT}', 'ec', 'ext-b2', 'friend-b', 'N4', 'refunded', 'refunded', 90000, '${thisMonth}', 'ev-1', '${thisMonth}', '${thisMonth}'),
        ('o-a3', '${ACCOUNT}', 'ec', 'ext-a3', 'friend-a', 'N5', 'current', 'paid', 70000, '${lastMonth}', 'ev-1', '${lastMonth}', '${lastMonth}');
    `);
    const kpis = await getNenMemberKpis(db, [ACCOUNT]);
    // 同じ人の2件は金額だけ足し、人数は1人。返金・先月は入らない。
    expect(kpis.monthPurchaseYen).toBe(10_000);
    expect(kpis.monthBuyers).toBe(2);
  });

  it('数値カードの合計はブロック中と別アカウントを含めない', async () => {
    const kpis = await getNenMemberKpis(db, [ACCOUNT]);
    expect(kpis).toEqual({
      members: 2,
      annualTotalYen: 211_000,
      lifetimeTotalYen: 509_100,
      balanceTotal: 3_960,
      usedThisMonth: 500,
      byRank: { platinum: 1, gold: 1 },
      // ★V8 会員帯の3つ。両方ともEC連携済み・ペットあり。当月の注文は無い。
      linkedMembers: 2,
      petMembers: 2,
      monthPurchaseYen: 0,
      monthBuyers: 0,
    });
  });
});
