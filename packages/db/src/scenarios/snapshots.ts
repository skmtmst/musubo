import type { ScenarioStep } from '../scenario-step-types.js';
import { normalizeVersionStepSnapshot } from '../scenario-step-snapshot.js';
import { resolveStepContent } from '../scenario-resolve.js';
import { type Scenario, type ScenarioVersion, type PinnedScenarioStep, type ScenarioActionSourceRow, type PinnedScenarioAction } from './types.js';


// ============================================================
// Scenario Published Versions (351)
//
// 稼働中の文面・順序を固定する。下書き（scenarios / scenario_steps の
// live 値）は編集し放題で、公開操作だけが不変の版を作る。購読は開始時の
// 版へ固定され、あとの編集は既存配信へ混入しない。
// ============================================================

/**
 * 版に写す通1件ぶん。キーの順序は migration 351 の json_object と同じに
 * する。template を使う通は公開時の文面・質問を解決して写すので、公開後の
 * template 編集は固定済みの版へ混入しない。`id` には版所有の通IDを入れ、
 * live の通IDは live_step_id の控えにだけ残す。
 */
export async function buildVersionSnapshotSteps(
  db: D1Database,
  versionId: string,
  steps: ScenarioStep[],
  lineAccountId: string | null,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const s of steps) {
    // template の解決はシナリオの持ち主アカウントの中だけで行う。
    // よそのアカウントの template や未公開の template は使わず、通の控えへ
    // 倒す。配信時にはもう templates 表を読まないので、境界の判断はここが
    // 最後の砦になる。
    const resolved = await resolveStepContent(db, s, lineAccountId);
    const pins = await db.prepare(`SELECT common_var_id, version_id FROM scenario_step_common_var_pins
      WHERE scenario_step_id = ? ORDER BY common_var_id`).bind(s.id).all<{ common_var_id: string; version_id: string }>();
    out.push({
      ...(pins.results.length ? { common_var_pins: pins.results } : {}),
      version_step_id: `${versionId}:${s.step_order}`,
      step_order: s.step_order,
      delay_minutes: s.delay_minutes,
      message_type: resolved.messageType,
      message_content: resolved.messageContent,
      ...(s.message_bubbles_json ? { message_bubbles_json: s.message_bubbles_json } : {}),
      condition_type: s.condition_type,
      condition_value: s.condition_value,
      next_step_on_false: s.next_step_on_false,
      offset_days: s.offset_days,
      offset_minutes: s.offset_minutes,
      delivery_time: s.delivery_time,
      template_id: s.template_id,
      template_id_at_send: resolved.templateIdAtSend,
      on_reach_tag_id: s.on_reach_tag_id,
      after_send: s.after_send,
      target_condition_json: s.target_condition_json,
      question_json: resolved.questionJson,
      is_draft: s.is_draft,
      live_step_id: s.id,
      created_at: s.created_at,
    });
  }
  return out;
}

/**
 * 公開内容の指紋。配信条件と通の写しを1本の文字列にする。同じ文字列なら
 * 同じものが届くので、版の増減と冪等キーの照合はこれで行う。
 */
export function canonicalPublishPayload(
  scenario: Pick<
    Scenario,
    'delivery_mode' | 'audience_condition_json' | 'on_complete_mode' | 'on_complete_scenario_id'
  >,
  snapshotSteps: Array<Record<string, unknown>>,
  snapshotActions: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    delivery_mode: scenario.delivery_mode ?? 'relative',
    audience_condition_json: scenario.audience_condition_json ?? null,
    on_complete_mode: scenario.on_complete_mode ?? 'pause',
    on_complete_scenario_id: scenario.on_complete_scenario_id ?? null,
    steps: snapshotSteps.map(normalizeVersionStepSnapshot),
    // アクションも指紋に入れる。入れないと「アクションだけ直して公開」が
    // 同内容と判定され、版が増えずに編集が反映されない。
    actions: snapshotActions.map(normalizeVersionActionSnapshot),
  });
}

export function canonicalPayloadOfVersion(version: ScenarioVersion): string | null {
  let raw: unknown;
  let rawActions: unknown;
  try {
    raw = JSON.parse(version.steps_snapshot);
    rawActions = JSON.parse(version.actions_snapshot ?? '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || !Array.isArray(rawActions)) return null;
  return canonicalPublishPayload(
    version,
    raw as Array<Record<string, unknown>>,
    rawActions as Array<Record<string, unknown>>,
  );
}

/**
 * 版を1件読む。持ち主のシナリオも必ず付けて読む（364）。よそのシナリオの
 * 版IDを渡されても null に倒し、文面の混入を拒否する。
 */
export async function getScenarioVersionById(
  db: D1Database,
  scenarioId: string,
  versionId: string,
): Promise<ScenarioVersion | null> {
  return db.prepare(`SELECT * FROM scenario_versions WHERE id = ? AND scenario_id = ?`)
    .bind(versionId, scenarioId)
    .first<ScenarioVersion>();
}

export async function getScenarioPublishedVersion(
  db: D1Database,
  scenarioId: string,
): Promise<ScenarioVersion | null> {
  return db.prepare(
    `SELECT sv.*
       FROM scenarios s
       JOIN scenario_versions sv ON sv.id = s.current_published_version_id
      WHERE s.id = ? AND sv.status = 'published'`,
  ).bind(scenarioId).first<ScenarioVersion>();
}

/**
 * 版のスナップショットを通の配列に戻す。通の正体は版所有の通ID。
 * 壊れていたら空にする（呼ぶ側は「通が無い」と同じく購読を完了させる）。
 */
export function parseScenarioVersionSteps(version: ScenarioVersion): PinnedScenarioStep[] {
  let raw: unknown;
  try {
    raw = JSON.parse(version.steps_snapshot);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const steps: PinnedScenarioStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return [];
    const r = item as Record<string, unknown>;
    if (typeof r['version_step_id'] !== 'string' || typeof r['step_order'] !== 'number') return [];
    steps.push({
      id: r['version_step_id'] as string,
      scenario_id: version.scenario_id,
      step_order: r['step_order'] as number,
      delay_minutes: (r['delay_minutes'] as number) ?? 0,
      message_type: (r['message_type'] as ScenarioStep['message_type']) ?? 'text',
      message_content: (r['message_content'] as string) ?? '',
      ...(r['message_bubbles_json'] ? { message_bubbles_json: r['message_bubbles_json'] as string } : {}),
      condition_type: (r['condition_type'] as string | null) ?? null,
      condition_value: (r['condition_value'] as string | null) ?? null,
      next_step_on_false: (r['next_step_on_false'] as number | null) ?? null,
      offset_days: (r['offset_days'] as number | null) ?? null,
      offset_minutes: (r['offset_minutes'] as number | null) ?? null,
      delivery_time: (r['delivery_time'] as string | null) ?? null,
      template_id: (r['template_id'] as string | null) ?? null,
      template_id_at_send: (r['template_id_at_send'] as string | null) ?? null,
      on_reach_tag_id: (r['on_reach_tag_id'] as string | null) ?? null,
      after_send: (r['after_send'] as string) ?? 'continue',
      target_condition_json: (r['target_condition_json'] as string | null) ?? null,
      question_json: (r['question_json'] as string | null) ?? null,
      is_draft: (r['is_draft'] as number) ?? 0,
      live_step_id: (r['live_step_id'] as string | null) ?? null,
      created_at: (r['created_at'] as string) ?? version.created_at,
    });
  }
  return steps;
}

/**
 * 版に写すアクション1件ぶん。キーの順序は migration 351 の json_object と
 * 同じにする。通に紐づくアクションは版所有の通ID（version_step_id）で指す。
 * live の通が消えても、版の中で行き先を見失わない。
 *
 * `action_id` は公開時点の live のアクションID。「2回目以降は実行しない」の
 * 鍵はこれを使う。版IDを鍵に混ぜると、公開のたびに鍵が変わって
 * 「1回だけ」が「版ごとに1回」になってしまう。
 */
export async function buildVersionSnapshotActions(
  db: D1Database,
  versionId: string,
  scenarioId: string,
  steps: ScenarioStep[],
): Promise<Array<Record<string, unknown>>> {
  const orderByStepId = new Map<string, number>();
  for (const s of steps) orderByStepId.set(s.id, s.step_order);

  const rows = await db
    .prepare(
      `SELECT id, scenario_id, hook, step_id, choice_index, sort_order,
              action_type, config_json, condition_json, repeat_on_refire
         FROM scenario_actions
        WHERE scenario_id = ?
        ORDER BY sort_order ASC, id ASC`,
    )
    .bind(scenarioId)
    .all<ScenarioActionSourceRow>();

  const out: Array<Record<string, unknown>> = [];
  for (const a of rows.results ?? []) {
    // 通に紐づくのに、その通が下書きから消えている行は写さない。行き先の
    // 無いアクションを版に残すと、旧版の購読で永遠に発火しない行が積もる。
    const order = a.step_id === null ? null : orderByStepId.get(a.step_id);
    if (a.step_id !== null && order === undefined) continue;
    const pins = await db.prepare(`SELECT common_var_id, version_id FROM scenario_action_common_var_pins
      WHERE scenario_action_id=? ORDER BY common_var_id`).bind(a.id).all<{ common_var_id: string; version_id: string }>();
    out.push({
      ...(pins.results.length ? { common_var_pins: pins.results } : {}),
      version_action_id: `${versionId}#a${a.id}`,
      action_id: a.id,
      hook: a.hook,
      version_step_id: order === null || order === undefined ? null : `${versionId}:${order}`,
      live_step_id: a.step_id,
      choice_index: a.choice_index,
      sort_order: a.sort_order,
      action_type: a.action_type,
      config_json: a.config_json,
      condition_json: a.condition_json,
      repeat_on_refire: a.repeat_on_refire,
    });
  }
  return out;
}

/**
 * 内容比較用の正規形。版の正体（version_action_id）は同一性の判断から外す。
 * 版IDが決まる前に作った下書きの写しと、保存済みの版の写しを同じ形で比べる。
 * version_step_id も版IDを含むので、通番だけを見る形に落とす。
 */
export function normalizeVersionActionSnapshot(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const versionStepId = entry['version_step_id'];
  const stepOrder =
    typeof versionStepId === 'string' && versionStepId.includes(':')
      ? versionStepId.slice(versionStepId.lastIndexOf(':') + 1)
      : null;
  return {
    action_id: entry['action_id'] ?? null,
    ...(entry['common_var_pins'] ? { common_var_pins: entry['common_var_pins'] } : {}),
    hook: entry['hook'] ?? null,
    step_order: stepOrder,
    live_step_id: entry['live_step_id'] ?? null,
    choice_index: entry['choice_index'] ?? null,
    sort_order: entry['sort_order'] ?? 0,
    action_type: entry['action_type'] ?? null,
    config_json: entry['config_json'] ?? null,
    condition_json: entry['condition_json'] ?? null,
    repeat_on_refire: entry['repeat_on_refire'] ?? 1,
  };
}

/**
 * 版のアクションの写しを読み戻す。壊れていたら空にする（アクション無しと
 * 同じ扱い。live へは戻らない）。
 */
export function parseScenarioVersionActions(version: ScenarioVersion): PinnedScenarioAction[] {
  let raw: unknown;
  try {
    raw = JSON.parse(version.actions_snapshot ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const actions: PinnedScenarioAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return [];
    const r = item as Record<string, unknown>;
    if (typeof r['version_action_id'] !== 'string') return [];
    actions.push({
      id: r['version_action_id'] as string,
      action_key: (r['action_id'] as string | null) ?? (r['version_action_id'] as string),
      scenario_id: version.scenario_id,
      hook: (r['hook'] as string) ?? 'step_sent',
      version_step_id: (r['version_step_id'] as string | null) ?? null,
      live_step_id: (r['live_step_id'] as string | null) ?? null,
      choice_index: (r['choice_index'] as number | null) ?? null,
      sort_order: (r['sort_order'] as number) ?? 0,
      action_type: (r['action_type'] as string) ?? '',
      config_json: (r['config_json'] as string) ?? '{}',
      condition_json: (r['condition_json'] as string | null) ?? null,
      repeat_on_refire: (r['repeat_on_refire'] as number) ?? 1,
    });
  }
  return actions;
}

/**
 * 版に固定された通を1件読む。版所有の通ID（`<版ID>:<通番>`）で引く。
 *
 * 質問の回答処理はこれを使う。live の scenario_steps は読まない。押した
 * ときに live を読むと、公開後に直した返信・タグ・遷移が旧版の購読へ
 * 混入する（下書きの通を消したあとは、そもそも引けない）。
 */
export async function getPinnedScenarioStep(
  db: D1Database,
  versionStepId: string,
): Promise<{ version: ScenarioVersion; step: PinnedScenarioStep } | null> {
  const versionId = parseVersionStepId(versionStepId)?.versionId ?? null;
  if (!versionId) return null;
  const version = await db
    .prepare(`SELECT * FROM scenario_versions WHERE id = ?`)
    .bind(versionId)
    .first<ScenarioVersion>();
  if (!version) return null;
  const step = parseScenarioVersionSteps(version).find((s) => s.id === versionStepId);
  if (!step) return null;
  return { version, step };
}

/**
 * 版所有の通ID を版IDと通番に割る。IDは `<版ID>:<通番>` で、版IDは UUID
 * なので、**右端のコロンから後ろだけ**を通番として切る。左から split すると
 * 版IDにコロンが無い前提に寄りかかることになり、形が変わった瞬間に壊れる。
 */
export function parseVersionStepId(
  versionStepId: string,
): { versionId: string; stepOrder: number } | null {
  const at = versionStepId.lastIndexOf(':');
  if (at <= 0 || at === versionStepId.length - 1) return null;
  const versionId = versionStepId.slice(0, at);
  const stepOrder = Number(versionStepId.slice(at + 1));
  if (!Number.isInteger(stepOrder) || stepOrder < 0) return null;
  return { versionId, stepOrder };
}
