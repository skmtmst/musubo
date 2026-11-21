import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createScenario,
  createScenarioStep,
  publishScenarioVersion,
  updateScenarioStep,
} from '../src/scenarios/index.js';
import { openSharedD1, type SharedD1 } from './shared-d1-test-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

/*
 * 同時公開を**独立した接続**で確かめる。
 *
 * これまでの競合テストは 1本の :memory: 接続に batch を差し替えて割り込みを
 * 作っていた。それでは「自分の中で自分と競合している」だけで、別の worker が
 * 同時に叩いた状況の証明にならない。ここではファイルの SQLite を WAL で開き、
 * 接続を2本立てて Promise.all で走らせる。文と文のあいだで本当に処理が
 * 入れ替わり、UNIQUE・PRIMARY KEY は実際の制約として効く。
 */
describe('同時公開（独立接続 / 実D1相当）', () => {
  let dir: string;
  let a: SharedD1;
  let b: SharedD1;

  /** A 側を1回だけ待たせる合図。狙った交差を毎回起こすために使う。 */
  let pauseOn: { pattern: RegExp; release: () => Promise<void> } | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lh-scenario-publish-'));
    const file = join(dir, 'test.sqlite');
    pauseOn = null;
    a = openSharedD1(file, {
      onStatement: async (sql) => {
        if (!pauseOn || !pauseOn.pattern.test(sql)) return;
        const hit = pauseOn;
        pauseOn = null; // 1回だけ
        await hit.release();
      },
    });
    a.raw.exec(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'));
    b = openSharedD1(file);
  });

  afterEach(() => {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed() {
    const scenario = await createScenario(a.db, { name: '案内', triggerType: 'manual' });
    const step = await createScenarioStep(a.db, {
      scenarioId: scenario.id,
      stepOrder: 0,
      messageType: 'text',
      messageContent: '1通目',
    });
    return { scenario, step };
  }

  function versions(scenarioId: string): Array<{ id: string; n: number; status: string }> {
    return a.raw
      .prepare(
        `SELECT id, version_number AS n, status FROM scenario_versions
          WHERE scenario_id = ? ORDER BY version_number`,
      )
      .all(scenarioId) as Array<{ id: string; n: number; status: string }>;
  }

  function pointer(scenarioId: string): string | null {
    return (
      a.raw
        .prepare(`SELECT current_published_version_id AS p FROM scenarios WHERE id = ?`)
        .get(scenarioId) as { p: string | null }
    ).p;
  }

  test('別々の接続から同時に公開しても、公開版は常に1つだけ', async () => {
    const { scenario, step } = await seed();
    await publishScenarioVersion(a.db, scenario.id, { staffId: null, idempotencyKey: 'base' });
    await updateScenarioStep(a.db, step.id, { message_content: '直した1通目' });

    // 2本の接続で同時に公開する。文と文のあいだで処理が入れ替わるので、
    // 版番号の読みと INSERT が本当に交差する。
    const [vA, vB] = await Promise.all([
      publishScenarioVersion(a.db, scenario.id, { staffId: null, idempotencyKey: 'conn-a' }),
      publishScenarioVersion(b.db, scenario.id, { staffId: null, idempotencyKey: 'conn-b' }),
    ]);

    const rows = versions(scenario.id);
    // 版番号は重ならない。敗者版（指針の外に残る published）も無い。
    expect(new Set(rows.map((r) => r.n)).size).toBe(rows.length);
    expect(rows.filter((r) => r.status === 'published')).toHaveLength(1);
    expect(pointer(scenario.id)).toBe(rows.find((r) => r.status === 'published')!.id);

    // 内容が同じなので、どちらかは既存版を返す（版を増やさない）か、
    // 片方が新しい版を作って現行になる。いずれにせよ現行版は1つ。
    const published = rows.find((r) => r.status === 'published')!.id;
    expect([vA.id, vB.id]).toContain(published);
  });

  test('別々の接続が同じ確認キーで同時に公開しても、版は増えない', async () => {
    const { scenario, step } = await seed();
    await publishScenarioVersion(a.db, scenario.id, { staffId: null, idempotencyKey: 'base' });
    await updateScenarioStep(a.db, step.id, { message_content: '直した1通目' });

    const results = await Promise.allSettled([
      publishScenarioVersion(a.db, scenario.id, { staffId: null, idempotencyKey: 'same-key' }),
      publishScenarioVersion(b.db, scenario.id, { staffId: null, idempotencyKey: 'same-key' }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // 同じキー・同じ内容なので、返る版は1つに揃う。
    const ids = new Set(ok.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);

    const rows = versions(scenario.id);
    expect(rows).toHaveLength(2); // 最初の1件 + 今回の1件
    expect(rows.filter((r) => r.status === 'published')).toHaveLength(1);
    // キー台帳も1行だけ。
    expect(
      (
        a.raw
          .prepare(`SELECT COUNT(*) AS n FROM scenario_publish_keys WHERE publish_idempotency_key = 'same-key'`)
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  test('版番号を読んだ直後に相手が公開を終えても、敗者版も指針の移動も残らない', async () => {
    const { scenario, step } = await seed();
    await publishScenarioVersion(a.db, scenario.id, { staffId: null, idempotencyKey: 'base' });
    await updateScenarioStep(a.db, step.id, { message_content: '直した1通目' });

    // A が「次の版番号」を読む直前で止め、その隙に B（別接続）が同じ内容の公開を
    // 最後まで終える。A は最新の下書きを照合し、既存の公開版を返す。
    pauseOn = {
      pattern: /COALESCE\(MAX\(version_number\)/,
      release: async () => {
        await publishScenarioVersion(b.db, scenario.id, { staffId: null, idempotencyKey: 'conn-b' });
      },
    };
    const vA = await publishScenarioVersion(a.db, scenario.id, {
      staffId: null,
      idempotencyKey: 'conn-a',
    });

    const rows = versions(scenario.id);
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
    expect(rows.filter((r) => r.status === 'published')).toHaveLength(1);
    expect(rows.find((r) => r.status === 'published')!.id).toBe(vA.id);
    expect(pointer(scenario.id)).toBe(vA.id);
    expect(a.raw.prepare("SELECT version_id FROM scenario_publish_keys WHERE publish_idempotency_key IN ('conn-a','conn-b') ORDER BY publish_idempotency_key").all()).toEqual([{ version_id: vA.id }, { version_id: vA.id }]);
  });

  test('同じ確認キーの相手が先に終えると、こちらの書き込みは丸ごと巻き戻る', async () => {
    const { scenario, step } = await seed();
    await publishScenarioVersion(a.db, scenario.id, { staffId: null, idempotencyKey: 'base' });
    await updateScenarioStep(a.db, step.id, { message_content: '直した1通目' });

    // A が版番号を読む直前で、B が**同じ確認キー・同じ内容**で公開を
    // 終える。A の batch は最後のキー予約で弾かれる。原子でなければ
    // 版と指針だけが進んだ残骸になる。
    pauseOn = {
      pattern: /COALESCE\(MAX\(version_number\)/,
      release: async () => {
        await publishScenarioVersion(b.db, scenario.id, { staffId: null, idempotencyKey: 'shared' });
      },
    };
    const vA = await publishScenarioVersion(a.db, scenario.id, {
      staffId: null,
      idempotencyKey: 'shared',
    });

    const rows = versions(scenario.id);
    // B が作った1件だけ。A の版は残らない。
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
    const published = rows.find((r) => r.status === 'published')!;
    expect(published.n).toBe(2);
    expect(vA.id).toBe(published.id);
    expect(pointer(scenario.id)).toBe(published.id);
    expect(
      (
        a.raw
          .prepare(`SELECT COUNT(*) AS n FROM scenario_publish_keys WHERE publish_idempotency_key = 'shared'`)
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  test('別の接続が同じ確認キーを別内容で使うと 409 になり、残骸も残らない', async () => {
    const { scenario, step } = await seed();
    const v1 = await publishScenarioVersion(a.db, scenario.id, {
      staffId: null,
      idempotencyKey: 'reused',
    });

    await updateScenarioStep(b.db, step.id, { message_content: '別の内容' });
    await expect(
      publishScenarioVersion(b.db, scenario.id, { staffId: null, idempotencyKey: 'reused' }),
    ).rejects.toThrow('SCENARIO_PUBLISH_KEY_CONFLICT');

    const rows = versions(scenario.id);
    expect(rows).toHaveLength(1);
    expect(pointer(scenario.id)).toBe(v1.id);
    expect(rows[0]!.status).toBe('published');
  });

  test('外部キーが有効な接続でも、版と購読の帰属は保たれる', async () => {
    const first = await seed();
    const second = await seed();
    const v1 = await publishScenarioVersion(a.db, first.scenario.id, {
      staffId: null,
      idempotencyKey: 'own-a',
    });
    await publishScenarioVersion(b.db, second.scenario.id, {
      staffId: null,
      idempotencyKey: 'own-b',
    });

    // よそのシナリオの版を指そうとすると、帰属トリガー（364）で止まる。
    expect(() =>
      b.raw
        .prepare(`UPDATE scenarios SET current_published_version_id = ? WHERE id = ?`)
        .run(v1.id, second.scenario.id),
    ).toThrow(/belongs to another scenario/);

    // 存在しない版への固定も止まる（帰属トリガーが先に、外部キーが後で
    // 効く。どちらでも「宙に浮いた版参照」は残らない）。
    b.raw.prepare(`INSERT INTO friends (id, line_user_id, created_at, updated_at) VALUES ('f-1', 'U-1', '2026-08-16', '2026-08-16')`).run();
    expect(() =>
      b.raw
        .prepare(
          `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, updated_at, published_version_id)
           VALUES ('enr-bad', 'f-1', ?, -1, 'active', '2026-08-16', '2026-08-16', 'missing-version')`,
        )
        .run(second.scenario.id),
    ).toThrow(/belongs to another scenario|FOREIGN KEY/i);
  });

  test('同時公開のあいだも、アクションの写しは版ごとに1つずつ揃う', async () => {
    const { scenario, step } = await seed();
    a.raw
      .prepare(
        `INSERT INTO scenario_actions
           (id, scenario_id, hook, step_id, choice_index, sort_order, action_type, config_json, repeat_on_refire, created_at)
         VALUES ('act-1', ?, 'step_sent', ?, NULL, 0, 'tag', '{"op":"add","tagIds":["t1"]}', 1, '2026-08-16')`,
      )
      .run(scenario.id, step.id);
    await publishScenarioVersion(a.db, scenario.id, { staffId: null, idempotencyKey: 'act-base' });
    await updateScenarioStep(a.db, step.id, { message_content: '直した1通目' });

    await Promise.all([
      publishScenarioVersion(a.db, scenario.id, { staffId: null, idempotencyKey: 'act-a' }),
      publishScenarioVersion(b.db, scenario.id, { staffId: null, idempotencyKey: 'act-b' }),
    ]);

    const rows = a.raw
      .prepare(`SELECT id, actions_snapshot AS s FROM scenario_versions WHERE scenario_id = ?`)
      .all(scenario.id) as Array<{ id: string; s: string }>;
    for (const row of rows) {
      const actions = JSON.parse(row.s) as Array<Record<string, unknown>>;
      expect(actions).toHaveLength(1);
      expect(actions[0]!['action_id']).toBe('act-1');
      // 通の指し先は、その版の版所有の通ID。よその版を指さない。
      expect(actions[0]!['version_step_id']).toBe(`${row.id}:0`);
    }
  });
});
