import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createConversionDefinition,
  deriveDefinitionState,
  getConversionDefinitionReport,
  getConversionReport,
  issueConversionIngestSecret,
  listConversionDefinitionEvents,
  listConversionDefinitions,
  listConversionIngestionEvents,
  publishConversionDefinition,
  recordConversionIngestionEvent,
  resolveConversionIngestSecret,
  setConversionIngestDisabled,
} from '../src/conversion-definitions/index.js';
import { trackConversion } from '../src/conversions/index.js';
import { applyConversionTestSchema } from './conversion-test-schema.js';
import { asD1 } from './d1-test-helper.js';

const scope = { allowedAccountIds: ['account-a'], includeUnassigned: false };
const range = { from: '2026-09-01 00:00:00', to: '2026-09-30 23:59:59', timeZone: 'Asia/Tokyo' as const };
const previousRange = { from: '2026-08-01 00:00:00', to: '2026-08-31 23:59:59', timeZone: 'Asia/Tokyo' as const };
// credential-crypto は base64url の32バイト鍵を受ける(350試験と同じ形)。
const TEST_KEYS = {
  current: Buffer.from(new Uint8Array(32).map((_, i) => (i * 7 + 1) % 256)).toString('base64url'),
};

function setup(): Database.Database {
  const sqlite = new Database(':memory:');
  applyConversionTestSchema(sqlite);
  sqlite.exec(`
    INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('account-a', 'ch-a', 'A', 'token-a', 'secret-a');
    INSERT INTO friends (id, line_user_id, display_name, line_account_id, created_at, updated_at)
    VALUES ('friend-1', 'U1', 'いち', 'account-a', '2026-08-01', '2026-08-01'),
           ('friend-2', 'U2', 'に', 'account-a', '2026-08-01', '2026-08-01'),
           ('friend-3', 'U3', 'さん', 'account-a', '2026-08-01', '2026-08-01');
  `);
  return sqlite;
}

const baseInput = {
  name: '購入完了',
  sourceType: 'ec_order_confirmed',
  sourceConfig: {},
  measureMethod: 'webhook' as const,
  targetUrl: null,
  attributionDays: null,
  lineAccountId: 'account-a',
  deduplicationMode: 'every' as const,
  deduplicationWindowDays: null,
  valueMode: 'fixed' as const,
  fixedValue: 1000,
  reversalPolicy: 'manual' as const,
  usages: [],
  staffId: 'staff-1',
};

describe('成果地点は公開状態に応じて計測と状態表示を切り替える', () => {
  it('下書きで保存すると計測に乗らず、公開で計測できるようになる', async () => {
    const db = asD1(setup());
    const created = await createConversionDefinition(db, { ...baseInput, draft: true });
    expect(created).toMatchObject({ id: expect.any(String) });

    // 下書きは計測しない(理由が分かる別エラー)。
    await expect(trackConversion(db, {
      conversionPointId: created!.id, friendId: 'friend-1',
    })).rejects.toThrow('conversion_point_draft');

    // 一覧では state=draft と理由を返す。
    const list = await listConversionDefinitions(db, {
      scope, range, cursor: 0, limit: 20, sort: 'count_desc',
    });
    expect(list.items[0]).toMatchObject({
      status: 'draft', state: 'draft',
      stateReason: 'まだ公開していません。公開するまで計測しません',
    });
    expect(list.stateCounts).toMatchObject({ draft: 1, active: 0 });

    // 公開すると計測中へ。同じ版の再送は競合として弾く。
    const published = await publishConversionDefinition(db, {
      id: created!.id, scope, expectedVersion: 1, staffId: 'staff-1',
    });
    expect(published).toMatchObject({ status: 'active', version: 2 });
    await expect(publishConversionDefinition(db, {
      id: created!.id, scope, expectedVersion: 1, staffId: 'staff-1',
    })).rejects.toMatchObject({ code: 'version_conflict' });

    const event = await trackConversion(db, {
      conversionPointId: created!.id, friendId: 'friend-1',
    });
    expect(event.conversion_point_id).toBe(created!.id);
  });

  it('入力不良と起点停止を導出状態で区別する', async () => {
    const sqlite = setup();
    sqlite.exec(`
      INSERT INTO conversion_points
        (id, name, event_type, value, measure_method, target_url, line_account_id, status,
         deduplication_mode, value_mode, ingest_disabled_at, created_at, updated_at)
      VALUES
        ('p-url-broken', 'URLなし', 'url_reach', 100, 'url_reach', NULL, 'account-a', 'active',
         'every', 'fixed', NULL, '2026-08-01', '2026-08-01'),
        ('p-src-stop', '受信停止', 'webhook', 100, 'webhook', NULL, 'account-a', 'active',
         'every', 'fixed', '2026-09-10', '2026-08-01', '2026-08-01'),
        ('p-fine', '正常', 'manual', 100, 'manual', NULL, 'account-a', 'active',
         'every', 'fixed', NULL, '2026-08-01', '2026-08-01');
      INSERT INTO conversion_definition_usages
        (id, conversion_point_id, definition_version, line_account_id, ref_kind, ref_id,
         created_by, created_at, updated_at)
      VALUES ('u-1', 'p-fine', 1, 'account-a', 'scenario', 'scenario-1', 'staff-1', '2026-08-01', '2026-08-01');
    `);
    const db = asD1(sqlite);
    const list = await listConversionDefinitions(db, {
      scope, range, cursor: 0, limit: 20, sort: 'name_asc',
    });
    const byId = new Map(list.items.map((item) => [item.id, item]));
    expect(byId.get('p-url-broken')).toMatchObject({ state: 'invalid', stateReason: '到達URLが決まっていません' });
    expect(byId.get('p-src-stop')).toMatchObject({ state: 'sourceStopped', stateReason: '外部からの受信を止めています' });
    expect(byId.get('p-fine')).toMatchObject({ state: 'active' });
    // 使われていない件数は絞り込み全体から正確に数える。
    expect(list.stateCounts).toMatchObject({
      active: 1, invalid: 1, sourceStopped: 1, unused: 2,
    });
    // state 絞り込みは導出状態と一致する。
    const invalidOnly = await listConversionDefinitions(db, {
      scope, state: 'invalid', range, cursor: 0, limit: 20, sort: 'name_asc',
    });
    expect(invalidOnly.items.map((item) => item.id)).toEqual(['p-url-broken']);
    const unusedOnly = await listConversionDefinitions(db, {
      scope, state: 'unused', range, cursor: 0, limit: 20, sort: 'name_asc',
    });
    expect(unusedOnly.items.map((item) => item.id).sort()).toEqual(['p-src-stop', 'p-url-broken']);
  });
});

describe('外部受信の鍵を暗号化し受け口の状態と台帳を管理する', () => {
  it('鍵を発行すると暗号化して保存し、照合には復号した平文を使う', async () => {
    const db = asD1(setup());
    const created = await createConversionDefinition(db, baseInput);
    const issued = await issueConversionIngestSecret(db, {
      id: created!.id, scope, expectedVersion: 1, staffId: 'staff-1', keys: TEST_KEYS,
    });
    expect(issued.secret).toMatch(/^cvwhk_/);

    // 台帳には平文を残さない。
    const raw = await db
      .prepare('SELECT ingest_secret_encrypted FROM conversion_points WHERE id = ?')
      .bind(created!.id).first<{ ingest_secret_encrypted: string }>();
    expect(raw?.ingest_secret_encrypted).not.toBe(issued.secret);
    expect(raw?.ingest_secret_encrypted).toMatch(/^k[^.]*\.v1\./);

    const resolved = await resolveConversionIngestSecret({
      id: created!.id, status: 'active',
      ingest_secret_encrypted: raw!.ingest_secret_encrypted,
      ingest_disabled_at: null,
    }, TEST_KEYS);
    expect(resolved).toBe(issued.secret);
  });

  it('受け口の停止・再開と受信台帳', async () => {
    const db = asD1(setup());
    const created = await createConversionDefinition(db, baseInput);
    const disabled = await setConversionIngestDisabled(db, {
      id: created!.id, scope, expectedVersion: 1, disabled: true, staffId: 'staff-1',
    });
    expect(disabled.disabledAt).not.toBeNull();

    await recordConversionIngestionEvent(db, {
      conversionPointId: created!.id, result: 'rejected',
      reason: 'signature_mismatch', signatureSha256: 'abc123',
      payloadShape: { fields: [], truncated: false },
    });
    await recordConversionIngestionEvent(db, {
      conversionPointId: created!.id, result: 'recorded',
      sourceEventId: 'evt-1', friendId: 'friend-1',
    });
    const events = await listConversionIngestionEvents(db, { id: created!.id, scope });
    expect(events).toHaveLength(2);
    expect(events!.map((event) => event.result).sort()).toEqual(['recorded', 'rejected']);
    // 担当外の地点は履歴も見せない。
    expect(await listConversionIngestionEvents(db, { id: 'point-x', scope })).toBeNull();
  });
});

describe('経路の母数と成果率を数え集計の暦日を揃える', () => {
  it('経路の母数はその経路を踏んだ友だち数、CVRは純成果÷母数', async () => {
    const sqlite = setup();
    sqlite.exec(`
      INSERT INTO conversion_points
        (id, name, event_type, value, line_account_id, status, created_at, updated_at)
      VALUES ('point-a', '購入完了', 'purchase', 1000, 'account-a', 'active', '2026-08-01', '2026-08-01');
      -- route-a を踏んだ友だちは2人。うち1人が成果した → CVR 50%。
      INSERT INTO ref_tracking (id, ref_code, friend_id, created_at)
      VALUES ('rt-1', 'route-a', 'friend-1', '2026-09-10T10:00:00.000+09:00'),
             ('rt-2', 'route-a', 'friend-2', '2026-09-11T10:00:00.000+09:00'),
             ('rt-3', 'route-b', 'friend-3', '2026-09-11T10:00:00.000+09:00');
      INSERT INTO conversion_events
        (id, conversion_point_id, friend_id, value_snapshot, attributed_ref_code, created_at)
      VALUES
        ('ev-1', 'point-a', 'friend-1', 1000, 'route-a', '2026-09-15T12:00:00.000+09:00'),
        ('ev-2', 'point-a', 'friend-3', 1000, 'route-b', '2026-09-30T23:59:59.999+09:00');
    `);
    const db = asD1(sqlite);
    const report = await getConversionDefinitionReport(db, { scope, range, previousRange });
    const routeA = report.byRoute.find((row) => row.routeKey === 'route-a');
    // 母数・CVRが空欄のまま返らない。
    expect(routeA).toMatchObject({ audience: 2, conversionRate: 50 });
    const routeB = report.byRoute.find((row) => row.routeKey === 'route-b');
    expect(routeB).toMatchObject({ audience: 1, conversionRate: 100 });
    // ISO書式(T付き)でも期間末の日(9/30)の成果を落とさない。
    expect(report.kpis.netCount).toBe(2);
  });

  it('旧形の集計も暦日の解釈とスナップショット固定を新レポートと揃える', async () => {
    const sqlite = setup();
    sqlite.exec(`
      INSERT INTO conversion_points
        (id, name, event_type, value, line_account_id, status, created_at, updated_at)
      VALUES ('point-a', '購入完了', 'purchase', 9000, 'account-a', 'active', '2026-08-01', '2026-08-01');
      INSERT INTO conversion_events
        (id, conversion_point_id, friend_id, value_snapshot, created_at)
      VALUES
        ('ev-end-iso', 'point-a', 'friend-1', 1000, '2026-09-15T23:59:59.999+09:00'),
        ('ev-end-space', 'point-a', 'friend-2', 2000, '2026-09-15 10:00:00'),
        ('ev-next', 'point-a', 'friend-3', 3000, '2026-09-16T00:00:00.000+09:00');
    `);
    const db = asD1(sqlite);
    const report = await getConversionReport(db, {
      startDate: '2026-09-15', endDate: '2026-09-15',
    });
    // ISO・datetime 両方の書式で、当日の成果だけを数える。
    expect(report.find((row) => row.conversionPointId === 'point-a'))
      .toMatchObject({ totalCount: 2, totalValue: 3000 });
    // 価格を後から変えても、記録時の金額(value_snapshot)を使う。
    sqlite.prepare('UPDATE conversion_points SET value = 99999 WHERE id = ?').run('point-a');
    const after = await getConversionReport(db, {
      startDate: '2026-09-15', endDate: '2026-09-15',
    });
    expect(after[0]).toMatchObject({ totalValue: 3000 });
  });
});

describe('成果の業務状態を表示し検証受信を本集計から分ける', () => {
  it('確定・確認待ち・却下・取消を業務状態として導出し、新しい順で返す', async () => {
    const sqlite = setup();
    sqlite.exec(`
      INSERT INTO conversion_points
        (id, name, event_type, value, line_account_id, status, created_at, updated_at)
      VALUES
        ('point-a', '購入', 'purchase', 5000, 'account-a', 'active', '2026-08-01', '2026-08-01'),
        ('point-b', '担当外の成果地点', 'purchase', 1000, 'account-b', 'active', '2026-08-01', '2026-08-01');
      INSERT INTO conversion_events
        (id, conversion_point_id, friend_id, approval_status, value_snapshot, metadata, created_at)
      VALUES
        ('ev-confirmed', 'point-a', 'friend-1', NULL, 5000,
         '{"source":"external_ingest","sourceEventId":"se-1"}', '2026-09-20 10:00:00'),
        ('ev-pending', 'point-a', 'friend-2', 'pending', 3000, NULL, '2026-09-19 10:00:00'),
        ('ev-rejected', 'point-a', 'friend-3', 'rejected', 2000, NULL, '2026-09-18 10:00:00'),
        ('ev-cancelled', 'point-a', 'friend-1', 'approved', 4000, NULL, '2026-09-17 10:00:00'),
        ('ev-other', 'point-b', 'friend-1', NULL, 1000, NULL, '2026-09-21 10:00:00');
      -- 取消は報酬台帳の取消調整(reason_type='cancel')で表す。
      INSERT INTO affiliate_reward_entries (id, conversion_event_id) VALUES ('re-1', 'ev-cancelled');
      INSERT INTO affiliate_adjustments (id, source_entry_id, reason_type, amount_minor, created_at)
      VALUES ('adj-1', 're-1', 'cancel', -400000, '2026-09-18 12:00:00');
    `);
    const db = asD1(sqlite);

    const items = await listConversionDefinitionEvents(db, { id: 'point-a', scope });
    expect(items).toHaveLength(4);
    // 新しい順。
    expect(items!.map((item) => item.id)).toEqual([
      'ev-confirmed', 'ev-pending', 'ev-rejected', 'ev-cancelled',
    ]);
    const byId = new Map(items!.map((item) => [item.id, item]));
    expect(byId.get('ev-confirmed')).toMatchObject({
      status: 'confirmed', approvalStatus: null, cancelled: false,
      friendName: 'いち', value: 5000,
      source: 'external_ingest', sourceEventId: 'se-1',
    });
    expect(byId.get('ev-pending')).toMatchObject({ status: 'pending', approvalStatus: 'pending' });
    expect(byId.get('ev-rejected')).toMatchObject({ status: 'rejected', approvalStatus: 'rejected' });
    // 取消は承認済みより強い。返品・取消が入った成果は「確定」に見せない。
    expect(byId.get('ev-cancelled')).toMatchObject({
      status: 'cancelled', approvalStatus: 'approved', cancelled: true,
    });

    // 担当外の地点は一覧ごと見せない(404側へ倒すため null)。
    expect(await listConversionDefinitionEvents(db, { id: 'point-b', scope })).toBeNull();
    // 見えないIDも null。存在しない地点と区別しない。
    expect(await listConversionDefinitionEvents(db, { id: 'point-x', scope })).toBeNull();
  });

  it('検証の受信は isTest で区別し、成果表にも集計にも混入しない', async () => {
    const sqlite = setup();
    sqlite.exec(`
      INSERT INTO conversion_points
        (id, name, event_type, value, line_account_id, status, created_at, updated_at)
      VALUES ('point-a', '購入', 'purchase', 5000, 'account-a', 'active', '2026-08-01', '2026-08-01');
    `);
    const db = asD1(sqlite);

    await recordConversionIngestionEvent(db, {
      conversionPointId: 'point-a', result: 'recorded', isTest: true,
      sourceEventId: 'test-1', friendId: 'friend-1',
    });
    await recordConversionIngestionEvent(db, {
      conversionPointId: 'point-a', result: 'rejected', isTest: true,
      reason: 'signature_mismatch',
    });
    await recordConversionIngestionEvent(db, {
      conversionPointId: 'point-a', result: 'recorded',
      sourceEventId: 'prod-1', friendId: 'friend-1',
    });

    const events = await listConversionIngestionEvents(db, { id: 'point-a', scope });
    expect(events).toHaveLength(3);
    const bySource = new Map(events!.map((event) => [event.sourceEventId, event]));
    expect(bySource.get('test-1')).toMatchObject({ result: 'recorded', isTest: true });
    // 検証の失敗も検証として残り、本番の失敗と見分けられる。
    expect(events!.find((event) => event.result === 'rejected')).toMatchObject({ isTest: true });
    // 既存の受信は本番扱い(既定 false)。
    expect(bySource.get('prod-1')).toMatchObject({ result: 'recorded', isTest: false });

    // 受信台帳だけの書き込みは成果表へ届かない。件数も金額も動かない。
    expect(await listConversionDefinitionEvents(db, { id: 'point-a', scope })).toEqual([]);
    const report = await getConversionReport(db, {
      startDate: '2026-08-01', endDate: '2026-12-31', scope,
    });
    expect(report.find((row) => row.conversionPointId === 'point-a'))
      .toMatchObject({ totalCount: 0, totalValue: 0 });
  });
});
