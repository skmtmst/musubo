import { describe, expect, test, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createScenario,
  createScenarioStep,
  publishScenarioVersion,
  updateScenario,
  updateScenarioStep,
} from '../src/scenarios/index.js';
import { asD1 } from './d1-test-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'));
  db = asD1(sqlite);
});

async function seedTwoSteps(nextStepOnFalse: number | null = null) {
  const scenario = await createScenario(db, { name: '案内', triggerType: 'manual' });
  await createScenarioStep(db, {
    scenarioId: scenario.id, stepOrder: 0, messageType: 'text', messageContent: '1通目',
  });
  await createScenarioStep(db, {
    scenarioId: scenario.id, stepOrder: 1, messageType: 'text', messageContent: '2通目',
    nextStepOnFalse,
  });
  return scenario;
}

/*
 * 分岐の循環は保存はできるが公開は止める。
 *
 * 循環したまま公開すると、購読した友だちに同じ通が回り続ける。
 * 下書きの保存自体は止めない（直している途中の保存を奪わない）。公開操作
 * だけが 409 で止まり、どこが回っているかを理由として返す。
 */
describe('公開前の循環検査 (P1-05)', () => {
  test('分岐が循環していると公開できない (SCENARIO_PUBLISH_CYCLE)', async () => {
    const scenario = await seedTwoSteps(0);
    await expect(
      publishScenarioVersion(db, scenario.id, { staffId: null, idempotencyKey: 'key-cycle-1' }),
    ).rejects.toThrow('SCENARIO_PUBLISH_CYCLE');
  });

  test('循環していても下書きの保存はできる', async () => {
    const scenario = await seedTwoSteps(0);
    const steps = sqlite.prepare(`SELECT * FROM scenario_steps WHERE scenario_id = ?`).all(scenario.id) as Array<{ id: string }>;
    // 保存は通る（公開だけが止まる）。
    await updateScenarioStep(db, steps[1]!.id, { messageContent: '2通目なおし中' });
  });

  test('循環がないときは公開できる', async () => {
    const scenario = await seedTwoSteps(null);
    const version = await publishScenarioVersion(db, scenario.id, { staffId: null, idempotencyKey: 'key-linear-1' });
    expect(version.scenario_id).toBe(scenario.id);
  });

  test('自分自身へ戻る分岐も止める', async () => {
    const scenario = await seedTwoSteps(1);
    await expect(
      publishScenarioVersion(db, scenario.id, { staffId: null, idempotencyKey: 'key-self-1' }),
    ).rejects.toThrow('SCENARIO_PUBLISH_CYCLE');
  });

  test('完了後の移動が循環していると公開できない (A→B→A)', async () => {
    const a = await createScenario(db, { name: 'A', triggerType: 'manual' });
    const b = await createScenario(db, { name: 'B', triggerType: 'manual' });
    for (const scenario of [a, b]) {
      await createScenarioStep(db, {
        scenarioId: scenario.id, stepOrder: 0, messageType: 'text', messageContent: '1通目',
      });
    }
    await updateScenario(db, a.id, { on_complete_mode: 'move', on_complete_scenario_id: b.id });
    await updateScenario(db, b.id, { on_complete_mode: 'move', on_complete_scenario_id: a.id });
    await expect(
      publishScenarioVersion(db, a.id, { staffId: null, idempotencyKey: 'key-xcycle-1' }),
    ).rejects.toThrow('SCENARIO_PUBLISH_CYCLE');
  });

  test('完了後の移動が一方通行なら公開できる', async () => {
    const a = await createScenario(db, { name: 'A', triggerType: 'manual' });
    const b = await createScenario(db, { name: 'B', triggerType: 'manual' });
    for (const scenario of [a, b]) {
      await createScenarioStep(db, {
        scenarioId: scenario.id, stepOrder: 0, messageType: 'text', messageContent: '1通目',
      });
    }
    await updateScenario(db, a.id, { on_complete_mode: 'move', on_complete_scenario_id: b.id });
    const version = await publishScenarioVersion(db, a.id, { staffId: null, idempotencyKey: 'key-xlinear-1' });
    expect(version.scenario_id).toBe(a.id);
  });
});

test('共通情報の固定変更は次に公開した版だけに写す', async () => {
  const scenario = await seedTwoSteps();
  const step = sqlite.prepare('SELECT id FROM scenario_steps WHERE scenario_id=? ORDER BY step_order LIMIT 1').get(scenario.id) as { id: string };
  sqlite.exec(`INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES('pin-a','pin-c','A','token','secret');
    INSERT INTO common_vars(id,line_account_id,name,var_key,value) VALUES('pin-var','pin-a','案内','notice','新');
    INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES
      ('pin-v1','pin-var',1,'案内','旧','test'),('pin-v2','pin-var',2,'案内','新','test');`);
  sqlite.prepare('INSERT INTO scenario_step_common_var_pins VALUES (?,?,?)').run(step.id, 'pin-var', 'pin-v1');
  const first = await publishScenarioVersion(db, scenario.id, { staffId: null, idempotencyKey: 'pin-first' });
  sqlite.prepare('UPDATE scenario_step_common_var_pins SET version_id=? WHERE scenario_step_id=?').run('pin-v2', step.id);
  const second = await publishScenarioVersion(db, scenario.id, { staffId: null, idempotencyKey: 'pin-second' });
  expect(second.id).not.toBe(first.id);
  expect(sqlite.prepare('SELECT scenario_version_id,version_id FROM scenario_version_common_var_pins ORDER BY version_id').all()).toEqual([
    { scenario_version_id: first.id, version_id: 'pin-v1' }, { scenario_version_id: second.id, version_id: 'pin-v2' },
  ]);
});

test('公開の途中に編集版が変わると、新しい公開版と固定の写しを残さない', async () => {
  const scenario = await seedTwoSteps();
  const batch = db.batch.bind(db);
  vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
    sqlite.prepare('UPDATE scenarios SET content_revision=content_revision+1 WHERE id=?').run(scenario.id);
    return batch(statements);
  });
  await expect(publishScenarioVersion(db, scenario.id, { staffId: null, idempotencyKey: 'publish-race' })).rejects.toThrow();
  expect(sqlite.prepare('SELECT count(*) AS n FROM scenario_versions WHERE scenario_id=?').get(scenario.id)).toEqual({n:0});
  expect(sqlite.prepare('SELECT count(*) AS n FROM scenario_version_common_var_pins').get()).toEqual({n:0});
  expect(sqlite.prepare('SELECT count(*) AS n FROM scenario_publish_keys WHERE scenario_id=?').get(scenario.id)).toEqual({n:0});
});

test('内容が同じ公開でも途中に編集版が変わると、公開キーを残さない', async () => {
  const scenario = await seedTwoSteps();
  await publishScenarioVersion(db, scenario.id, { staffId: null, idempotencyKey: 'publish-before-race' });
  const batch = db.batch.bind(db);
  vi.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
    sqlite.prepare('UPDATE scenarios SET content_revision=content_revision+1 WHERE id=?').run(scenario.id);
    return batch(statements);
  });
  await expect(publishScenarioVersion(db, scenario.id, { staffId: null, idempotencyKey: 'publish-same-race' })).rejects.toThrow();
  expect(sqlite.prepare("SELECT count(*) AS n FROM scenario_publish_keys WHERE publish_idempotency_key='publish-same-race'").get()).toEqual({n:0});
  expect(sqlite.prepare('SELECT count(*) AS n FROM scenario_versions WHERE scenario_id=?').get(scenario.id)).toEqual({n:1});
});
