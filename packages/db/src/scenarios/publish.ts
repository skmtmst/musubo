import { jstNow } from '../utils.js';
import { type ScenarioVersion, type Scenario, type ScenarioPublishKey } from './types.js';
import { getScenarioSteps } from './steps.js';
import { buildVersionSnapshotSteps, buildVersionSnapshotActions, canonicalPublishPayload, getScenarioVersionById, getScenarioPublishedVersion, canonicalPayloadOfVersion } from './snapshots.js';


/**
 * 公開 batch が制約で巻き戻ったときの分類。版番号の UNIQUE 違反は同時公開
 * の競合（取り直す）。キー台帳の PRIMARY KEY 違反はキーの競合（読み直して
 * 同内容ならその版、別内容なら 409）。どちらでも書いた分は残らない。
 */
export function classifyPublishBatchError(error: unknown): 'version-number' | 'idempotency-key' | 'unknown' {
  const message = error instanceof Error ? error.message : String(error);
  if (/scenario_publish_keys/i.test(message)) return 'idempotency-key';
  if (/scenario_versions/i.test(message)) return 'version-number';
  return 'unknown';
}

/**
 * 分岐ジャンプで回る輪を見つける。通は step_order の昇順に進み、
 * 条件分岐 (next_step_on_false) で飛べる。飛び先・次の通の両辺で
 * 閉路があれば、その輪を step_order の列で返す。無ければ null。
 */
export function findBranchCycle(
  steps: Array<{ step_order: number; next_step_on_false: number | null }>,
): number[] | null {
  const orders = [...new Set(steps.map((step) => step.step_order))].sort((a, b) => a - b);
  const existing = new Set(orders);
  const edges = new Map<number, number[]>();
  for (let index = 0; index < orders.length; index += 1) {
    const from = orders[index]!;
    const next: number[] = [];
    if (index + 1 < orders.length) next.push(orders[index + 1]!);
    const jump = steps.find((step) => step.step_order === from)?.next_step_on_false;
    if (jump != null && existing.has(jump) && !next.includes(jump)) next.push(jump);
    edges.set(from, next);
  }
  // 深さ優先で「いま辿っている道」に戻る辺を探す。通は多くて数十件のため再帰で足りる。
  const state = new Map<number, number>();
  const stack: number[] = [];
  let found: number[] | null = null;
  const visit = (node: number): boolean => {
    state.set(node, 1);
    stack.push(node);
    for (const to of edges.get(node) ?? []) {
      const target = state.get(to) ?? 0;
      if (target === 1) {
        found = [...stack.slice(stack.indexOf(to)), to];
        return true;
      }
      if (target === 0 && visit(to)) return true;
    }
    stack.pop();
    state.set(node, 2);
    return false;
  };
  for (const node of orders) {
    if ((state.get(node) ?? 0) === 0 && visit(node)) break;
  }
  return found;
}

/**
 * 公開を止める循環の理由。`message` は SCENARIO_PUBLISH_CYCLE 固定で、
 * 画面へ出す理由文は `userMessage` に入れる（保存は止めない・公開だけ止める）。
 */
export class ScenarioPublishCycleError extends Error {
  readonly cycleKind: 'branch' | 'cross_scenario';
  readonly userMessage: string;
  constructor(cycleKind: 'branch' | 'cross_scenario', userMessage: string) {
    super('SCENARIO_PUBLISH_CYCLE');
    this.cycleKind = cycleKind;
    this.userMessage = userMessage;
  }
}

/**
 * 完了後の移動 (on_complete_mode='move') を辿り、輪になっていれば
 * シナリオ名の列で返す。移動先が無い・移動でない・消えている所で止まる
 * （それらは循環ではなく別の検査の仕事）。
 */
export async function findCrossScenarioCycle(
  db: D1Database,
  scenarioId: string,
): Promise<string[] | null> {
  const chain: string[] = [scenarioId];
  const names = new Map<string, string>();
  let current: string | null = scenarioId;
  for (let hops = 0; hops < 50 && current; hops += 1) {
    const row: {
      id: string; name: string; on_complete_mode: string | null; on_complete_scenario_id: string | null;
    } | null = await db.prepare(
      `SELECT id, name, on_complete_mode, on_complete_scenario_id FROM scenarios WHERE id = ?`,
    ).bind(current).first<{
      id: string; name: string; on_complete_mode: string | null; on_complete_scenario_id: string | null;
    }>();
    if (!row) return null;
    names.set(row.id, row.name);
    if (row.on_complete_mode !== 'move' || !row.on_complete_scenario_id) return null;
    const target: string = row.on_complete_scenario_id;
    const revisit = chain.indexOf(target);
    if (revisit >= 0) {
      return [...chain.slice(revisit).map((id) => names.get(id) ?? id), names.get(target) ?? target];
    }
    chain.push(target);
    current = target;
  }
  return null;
}

/**
 * いまの下書きを公開版として固定する。単一原子 protocol。
 *
 * - 書き込み前の判定では何も書かない。同キーの再実行は同版を返し、
 *   別内容・別シナリオの使い回しは SCENARIO_PUBLISH_KEY_CONFLICT（409）。
 * - 書き込みは1回の batch にまとめる（版INSERT・指針・旧版引退・キー予約）。
 *   D1 の batch は原子なので、失敗したら指針だけ進む・版だけ残る・キーの
 *   だけ残る、の途中状態を作らない。CAS の敗者版も残らない。
 * - 同時公開の競合は制約違反で検出する。版番号の重なりは期待値（版番号・
 *   指針・キー台帳）を取り直して再試行し（最大5回）、キーの重なりは
 *   残っている行を読み直して同内容ならその版・別内容なら 409 にする。
 * - 内容が現行の公開版と同じなら版を増やさず、キーだけ残して現行版を返す。
 */
export async function publishScenarioVersion(
  db: D1Database,
  scenarioId: string,
  input: { staffId: string | null; idempotencyKey: string },
): Promise<ScenarioVersion> {
  const scenario = await db.prepare(`SELECT * FROM scenarios WHERE id = ?`)
    .bind(scenarioId)
    .first<Scenario>();
  if (!scenario) throw new Error('SCENARIO_NOT_FOUND');

  const steps = await getScenarioSteps(db, scenarioId);
  const draftSteps = await buildVersionSnapshotSteps(db, '', steps, scenario.line_account_id ?? null);
  const draftActions = await buildVersionSnapshotActions(db, '', scenarioId, steps);
  const draftPayload = canonicalPublishPayload(scenario, draftSteps, draftActions);

  // 循環したまま公開すると購読した友だちに同じ通が回り続ける。下書きの
  // 保存は止めないが、公開だけは止めてどこが回っているかを理由に返す。
  const branchLoop = findBranchCycle(steps);
  if (branchLoop) {
    const trail = branchLoop.map((order) => `${order + 1}通目`).join(' → ');
    throw new ScenarioPublishCycleError(
      'branch',
      `分岐が循環しているため公開できません（${trail}）。分岐先を見直してください`,
    );
  }
  const crossNames = await findCrossScenarioCycle(db, scenarioId);
  if (crossNames) {
    throw new ScenarioPublishCycleError(
      'cross_scenario',
      `完了後の移動が循環しているため公開できません（${crossNames.join(' → ')}）。移動先を見直してください`,
    );
  }

  // 同じキーの再実行・使い回しの判定。ここでは何も書かないので、409 の
  // 経路で公開側の状態は変わらない。
  const replay = await db.prepare(
    `SELECT * FROM scenario_publish_keys WHERE publish_idempotency_key = ?`,
  ).bind(input.idempotencyKey).first<ScenarioPublishKey>();
  if (replay) {
    if (replay.scenario_id !== scenarioId || replay.content_snapshot !== draftPayload) {
      throw new Error('SCENARIO_PUBLISH_KEY_CONFLICT');
    }
    const replayed = await getScenarioVersionById(db, scenarioId, replay.version_id);
    if (!replayed) throw new Error('SCENARIO_NOT_PUBLISHED');
    return replayed;
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    // 期待値の再読込。毎回いまの指針と版番号を取り直す。
    const current = await getScenarioPublishedVersion(db, scenarioId);
    if (current && canonicalPayloadOfVersion(current) === draftPayload) {
      await db.batch([
        db.prepare(
          `INSERT OR IGNORE INTO scenario_publish_keys
             (publish_idempotency_key, scenario_id, version_id, content_snapshot, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(input.idempotencyKey, scenarioId, current.id, draftPayload, jstNow()),
      ]);
      const row = await db.prepare(
        `SELECT * FROM scenario_publish_keys WHERE publish_idempotency_key = ?`,
      ).bind(input.idempotencyKey).first<ScenarioPublishKey>();
      if (!row || row.scenario_id !== scenarioId || row.content_snapshot !== draftPayload) {
        throw new Error('SCENARIO_PUBLISH_KEY_CONFLICT');
      }
      const version = await getScenarioVersionById(db, scenarioId, row.version_id);
      if (!version) throw new Error('SCENARIO_NOT_PUBLISHED');
      return version;
    }

    const next = await db.prepare(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
         FROM scenario_versions WHERE scenario_id = ?`,
    ).bind(scenarioId).first<{ version_number: number }>();
    const versionNumber = Number(next?.version_number ?? 1);
    const id = crypto.randomUUID();
    const snapshotSteps = await buildVersionSnapshotSteps(db, id, steps, scenario.line_account_id ?? null);
    const snapshotActions = await buildVersionSnapshotActions(db, id, scenarioId, steps);
    const now = jstNow();
    try {
      // 単一原子。INSERT は素直な形にし、競合は制約違反で検出する
      // （OR IGNORE で飲むと、書けた分だけ残る分離実行に戻る）。
      await db.batch([
        db.prepare(
          `INSERT INTO scenario_versions
             (id, scenario_id, version_number, delivery_mode, audience_condition_json,
              on_complete_mode, on_complete_scenario_id, steps_snapshot, actions_snapshot,
              status, published_at, published_by_staff_id,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)`,
        ).bind(
          id,
          scenarioId,
          versionNumber,
          scenario.delivery_mode ?? 'relative',
          scenario.audience_condition_json ?? null,
          scenario.on_complete_mode ?? 'pause',
          scenario.on_complete_scenario_id ?? null,
          JSON.stringify(snapshotSteps),
          JSON.stringify(snapshotActions),
          now,
          input.staffId,
          now,
          now,
        ),
        db.prepare(
          `UPDATE scenarios SET content_revision = content_revision + 1, current_published_version_id = ?, updated_at = ?
            WHERE id = ?`,
        ).bind(id, now, scenarioId),
        db.prepare(
          `UPDATE scenario_versions SET status = 'retired', updated_at = ?
            WHERE scenario_id = ? AND status = 'published' AND id != ?`,
        ).bind(now, scenarioId, id),
        db.prepare(
          `INSERT INTO scenario_publish_keys
             (publish_idempotency_key, scenario_id, version_id, content_snapshot, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(input.idempotencyKey, scenarioId, id, draftPayload, now),
      ]);
    } catch (error) {
      const kind = classifyPublishBatchError(error);
      if (kind === 'idempotency-key') {
        // 同じキーを誰かが先に残した。batch は巻き戻っているので版の残骸は
        // ない。残っている行を読み直して同内容ならその版、別内容なら 409。
        const row = await db.prepare(
          `SELECT * FROM scenario_publish_keys WHERE publish_idempotency_key = ?`,
        ).bind(input.idempotencyKey).first<ScenarioPublishKey>();
        if (row && row.scenario_id === scenarioId && row.content_snapshot === draftPayload) {
          const version = await getScenarioVersionById(db, scenarioId, row.version_id);
          if (version) return version;
        }
        throw new Error('SCENARIO_PUBLISH_KEY_CONFLICT');
      }
      if (kind === 'version-number') continue;
      throw error;
    }
    const saved = await getScenarioVersionById(db, scenarioId, id);
    if (!saved || saved.status !== 'published') throw new Error('SCENARIO_NOT_PUBLISHED');
    return saved;
  }
  throw new Error('SCENARIO_PUBLISH_CONFLICT');
}
