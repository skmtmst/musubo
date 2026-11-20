import { type CommonVarUsageKind } from './record-types.js';
import { type CommonVarUsageSummary } from './types.js';


export const COMMON_VAR_USAGE_QUERIES: Array<{
  kind: CommonVarUsageKind;
  sql: string;
  values: (varKey: string, token: string, lineAccountId: string) => string[];
}> = [
  {
    kind: 'template',
    sql: `SELECT 'templates' AS source_table, t.id AS source_id, NULL AS source_parent_id, t.name AS source_name,
                 'active' AS source_status,
                 CASE WHEN instr(coalesce(t.message_content, ''), ?) > 0
                      THEN t.message_content
                      WHEN instr(coalesce(t.question_json, ''), ?) > 0
                      THEN t.question_json ELSE coalesce(t.carousel_actions_json, '') END AS source_content,
                 0 AS is_historical
            FROM templates t
           WHERE t.line_account_id = ?
             AND (instr(coalesce(t.message_content, ''), ?) > 0
               OR instr(coalesce(t.question_json, ''), ?) > 0
               OR instr(coalesce(t.carousel_actions_json, ''), ?) > 0
               OR EXISTS (
                 SELECT 1 FROM json_tree(CASE WHEN json_valid(t.carousel_actions_json)
                                              THEN t.carousel_actions_json ELSE 'null' END) j
                  WHERE j.key = 'varKey' AND CAST(j.value AS TEXT) = ?
               ))`,
    values: (varKey, token, account) => [token, token, account, token, token, token, varKey],
  },
  {
    kind: 'broadcast',
    // 送信を始めた配信は、使う共通情報の値を送信開始時点の
    // スナップショットで固定する（common-var-snapshot.ts）。固定済みのものは
    // 共通情報を直してももう変わらないので、予約中とは別の状態名で返す。
    // snapshot がまだ無い sending（開始直後の短い隙間・失敗からの再開待ち）は
    // 再開時にいまの値を読むため、変わる側に残す。
    sql: `SELECT 'broadcasts' AS source_table, b.id AS source_id, NULL AS source_parent_id, b.title AS source_name,
                 CASE WHEN b.status = 'sending' AND b.common_var_snapshot IS NOT NULL
                      THEN 'sending_fixed' ELSE b.status END AS source_status,
                 CASE WHEN instr(coalesce(b.message_content, ''), ?) > 0
                      THEN b.message_content ELSE coalesce(b.message_bubbles_json, '') END AS source_content,
                 CASE WHEN b.status = 'sent' THEN 1 ELSE 0 END AS is_historical
            FROM broadcasts b
           WHERE (b.line_account_id = ? OR EXISTS (
                   SELECT 1 FROM json_each(coalesce(b.account_ids, '[]')) WHERE value = ?
                 ))
             AND (instr(coalesce(b.message_content, ''), ?) > 0
               OR instr(coalesce(b.message_bubbles_json, ''), ?) > 0)`,
    values: (_varKey, token, account) => [token, account, account, token, token],
  },
  {
    kind: 'scenario',
    sql: `SELECT 'scenario_steps' AS source_table, ss.id AS source_id, s.id AS source_parent_id,
                 s.name || '・' || CAST(ss.step_order AS TEXT) || '通目' AS source_name,
                 CASE WHEN s.is_active = 1 THEN 'active' ELSE 'stopped' END AS source_status,
                 CASE WHEN instr(coalesce(ss.message_content, ''), ?) > 0
                      THEN ss.message_content
                      WHEN instr(coalesce(ss.message_bubbles_json, ''), ?) > 0
                      THEN ss.message_bubbles_json ELSE coalesce(ss.question_json, '') END AS source_content,
                 0 AS is_historical
            FROM scenario_steps ss JOIN scenarios s ON s.id = ss.scenario_id
           WHERE s.line_account_id = ?
             AND (instr(coalesce(ss.message_content, ''), ?) > 0
               OR instr(coalesce(ss.message_bubbles_json, ''), ?) > 0
               OR instr(coalesce(ss.question_json, ''), ?) > 0)
           UNION ALL
          SELECT 'scenario_actions' AS source_table, sa.id AS source_id, s.id AS source_parent_id,
                 s.name || '・共通情報操作' AS source_name,
                 CASE WHEN s.is_active = 1 THEN 'active' ELSE 'stopped' END AS source_status,
                 sa.config_json AS source_content, 0 AS is_historical
           FROM scenario_actions sa JOIN scenarios s ON s.id = sa.scenario_id
           WHERE s.line_account_id = ? AND sa.action_type = 'common_var'
             AND json_extract(CASE WHEN json_valid(sa.config_json)
                                   THEN sa.config_json ELSE 'null' END, '$.varKey') = ?
           UNION ALL
          SELECT 'scenario_message_actions' AS source_table, sa.id AS source_id, s.id AS source_parent_id,
                 s.name || '・送信アクション' AS source_name,
                 CASE WHEN s.is_active = 1 THEN 'active' ELSE 'stopped' END AS source_status,
                 CASE WHEN instr(coalesce(sa.config_json,''), ?) > 0 THEN sa.config_json ELSE coalesce(t.message_content,'') END AS source_content,
                 0 AS is_historical
          FROM scenario_actions sa JOIN scenarios s ON s.id=sa.scenario_id
          LEFT JOIN templates t ON t.id=COALESCE(json_extract(CASE WHEN json_valid(sa.config_json) THEN sa.config_json ELSE '{}' END,'$.templateId'), json_extract(CASE WHEN json_valid(sa.config_json) THEN sa.config_json ELSE '{}' END,'$.template_id')) AND t.line_account_id=s.line_account_id AND t.message_bubbles_json IS NULL
          WHERE s.line_account_id=? AND sa.action_type IN ('send_message','send_template')
            AND (instr(coalesce(sa.config_json,''), ?) > 0 OR instr(coalesce(t.message_content,''), ?) > 0)
          UNION ALL
          -- N-186: 公開版スナップショットは編集中の下書きと別物。公開済み版から
          -- 送られる通文は、版を固定した時点で写した内容で差し込まれるため、
          -- 使用先として数える。下書き・廃止版は含めない。
          SELECT 'scenario_versions' AS source_table, v.id AS source_id, s.id AS source_parent_id,
                 s.name || '・公開版v' || CAST(v.version_number AS TEXT) AS source_name,
                 'published' AS source_status,
                 v.steps_snapshot AS source_content, 0 AS is_historical
            FROM scenario_versions v JOIN scenarios s ON s.id = v.scenario_id
           WHERE s.line_account_id = ? AND v.status = 'published'
             AND instr(coalesce(v.steps_snapshot, ''), ?) > 0
          UNION ALL
          SELECT 'scenario_version_actions',v.id,s.id,s.name || '・公開版の送信アクション','published',v.actions_snapshot,0
          FROM scenario_versions v JOIN scenarios s ON s.id=v.scenario_id
          WHERE s.line_account_id=? AND v.status='published' AND (
            instr(coalesce(v.actions_snapshot,''),?)>0 OR EXISTS (
              SELECT 1 FROM json_each(CASE WHEN json_valid(v.actions_snapshot) THEN v.actions_snapshot ELSE '[]' END) action
              JOIN templates t ON t.line_account_id=s.line_account_id AND t.message_bubbles_json IS NULL
                AND t.id=COALESCE(json_extract(CASE WHEN json_valid(json_extract(action.value,'$.config_json')) THEN json_extract(action.value,'$.config_json') ELSE '{}' END,'$.templateId'),
                  json_extract(CASE WHEN json_valid(json_extract(action.value,'$.config_json')) THEN json_extract(action.value,'$.config_json') ELSE '{}' END,'$.template_id'))
              WHERE json_extract(action.value,'$.action_type') IN ('send_template','send_message') AND instr(coalesce(t.message_content,''),?)>0
            ))`,
    values: (varKey, token, account) => [
      token, token, account, token, token, token, account, varKey,
      token, account, token, token, account, token, account, token, token,
    ],
  },
  {
    kind: 'reminder',
    sql: `SELECT 'reminder_steps' AS source_table, rs.id AS source_id, r.id AS source_parent_id, r.name AS source_name,
                 CASE WHEN r.is_active = 1 THEN 'active' ELSE 'stopped' END AS source_status,
                 rs.message_content AS source_content, 0 AS is_historical
            FROM reminder_steps rs JOIN reminders r ON r.id = rs.reminder_id
           WHERE r.line_account_id = ? AND instr(coalesce(rs.message_content, ''), ?) > 0
           UNION ALL
          -- N-186: 公開版スナップショットは編集中の下書きと別物。下書き・
          -- 失効版は含めない。所属は親のLINEアカウントで絞る。
          SELECT 'reminder_versions' AS source_table, v.id AS source_id, r.id AS source_parent_id,
                 r.name || '・公開版v' || CAST(v.version_number AS TEXT) AS source_name,
                 'published' AS source_status,
                 v.settings_snapshot AS source_content, 0 AS is_historical
            FROM reminder_versions v JOIN reminders r ON r.id = v.reminder_id
           WHERE r.line_account_id = ? AND v.status = 'published'
             AND instr(coalesce(v.settings_snapshot, ''), ?) > 0`,
    values: (_varKey, token, account) => [account, token, account, token],
  },
  {
    kind: 'auto_reply',
    sql: `SELECT 'auto_replies' AS source_table, ar.id AS source_id, NULL AS source_parent_id,
                 coalesce(nullif(ar.name, ''), ar.keyword) AS source_name,
                 CASE WHEN ar.is_active = 1 THEN 'active' ELSE 'stopped' END AS source_status,
                 CASE WHEN instr(coalesce(ar.response_content, ''), ?) > 0
                      THEN ar.response_content ELSE coalesce(ar.actions_json, '') END AS source_content,
                 0 AS is_historical
            FROM auto_replies ar
           WHERE ar.line_account_id = ? AND ar.deleted_at IS NULL
             AND (instr(coalesce(ar.response_content, ''), ?) > 0
               OR instr(coalesce(ar.actions_json, ''), ?) > 0
               OR EXISTS (
                 SELECT 1 FROM json_tree(CASE WHEN json_valid(ar.actions_json)
                                              THEN ar.actions_json ELSE 'null' END) j
                  WHERE j.key = 'varKey' AND CAST(j.value AS TEXT) = ?
               ))`,
    values: (varKey, token, account) => [token, account, token, token, varKey],
  },
  {
    kind: 'form',
    sql: `WITH target(token, account_id, var_key) AS (SELECT ?, ?, ?)
          SELECT 'forms' AS source_table, f.id AS source_id, NULL AS source_parent_id, f.name AS source_name,
                 CASE WHEN v.id IS NOT NULL AND (
                            instr(coalesce(v.on_submit_message_content, ''), target.token) > 0
                         OR instr(coalesce(v.fields, ''), target.token) > 0
                         OR instr(coalesce(v.layout, ''), target.token) > 0 OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(v.layout) THEN v.layout ELSE 'null' END,'$.references') j WHERE j.key='varKey' AND CAST(j.value AS TEXT)=target.var_key))
                      THEN 'published'
                      WHEN f.is_active = 1 THEN 'active' ELSE 'stopped' END AS source_status,
                 CASE WHEN instr(coalesce(v.on_submit_message_content, ''), target.token) > 0
                      THEN v.on_submit_message_content
                      WHEN instr(coalesce(v.fields, ''), target.token) > 0 THEN v.fields
                      WHEN instr(coalesce(v.layout, ''), target.token) > 0 OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(v.layout) THEN v.layout ELSE 'null' END,'$.references') j WHERE j.key='varKey' AND CAST(j.value AS TEXT)=target.var_key) THEN v.layout
                      WHEN instr(coalesce(f.on_submit_message_content, ''), target.token) > 0
                      THEN f.on_submit_message_content
                      WHEN instr(coalesce(f.fields, ''), target.token) > 0 THEN f.fields
                      ELSE coalesce(f.layout, '') END AS source_content,
                 0 AS is_historical
            FROM forms f JOIN form_accounts fa ON fa.form_id = f.id
            LEFT JOIN form_versions v ON v.id = f.current_published_version_id
            CROSS JOIN target
           WHERE fa.line_account_id = target.account_id
             AND (instr(coalesce(f.on_submit_message_content, ''), target.token) > 0
               OR instr(coalesce(f.fields, ''), target.token) > 0
               OR instr(coalesce(f.layout, ''), target.token) > 0
               OR instr(coalesce(v.on_submit_message_content, ''), target.token) > 0
               OR instr(coalesce(v.fields, ''), target.token) > 0
               OR instr(coalesce(v.layout, ''), target.token) > 0 OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(f.layout) THEN f.layout ELSE 'null' END,'$.references') j WHERE j.key='varKey' AND CAST(j.value AS TEXT)=target.var_key) OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(v.layout) THEN v.layout ELSE 'null' END,'$.references') j WHERE j.key='varKey' AND CAST(j.value AS TEXT)=target.var_key))`,
    values: (varKey, token, account) => [token, account, varKey],
  },
  {
    kind: 'automation',
    sql: `SELECT 'automations' AS source_table, a.id AS source_id, NULL AS source_parent_id, a.name AS source_name,
                 CASE WHEN a.is_active = 1 THEN 'active' ELSE 'stopped' END AS source_status,
                 CASE WHEN instr(coalesce(a.conditions, ''), ?) > 0
                      THEN a.conditions ELSE coalesce(a.actions, '') END AS source_content,
                 0 AS is_historical
            FROM automations a
           WHERE a.line_account_id = ?
             AND (instr(coalesce(a.conditions, ''), ?) > 0
               OR instr(coalesce(a.actions, ''), ?) > 0
               OR EXISTS (
                 SELECT 1 FROM json_tree(CASE WHEN json_valid(a.actions)
                                              THEN a.actions ELSE 'null' END) j
                  WHERE j.key = 'varKey' AND CAST(j.value AS TEXT) = ?
               ))
           UNION ALL
          SELECT 'automation_definitions' AS source_table, d.id AS source_id, NULL AS source_parent_id, d.name AS source_name,
                 d.status AS source_status, '共通情報を使う操作があります' AS source_content,
                 0 AS is_historical
            FROM automation_definitions d
           WHERE d.line_account_id = ? AND EXISTS (
             SELECT 1 FROM automation_versions v
              WHERE v.automation_id = d.id
                AND v.id IN (d.current_draft_version_id, d.current_published_version_id)
                AND (instr(coalesce(v.trigger_config, ''), ?) > 0
                  OR instr(coalesce(v.condition_config, ''), ?) > 0
                  OR instr(coalesce(v.action_config, ''), ?) > 0
                  OR EXISTS (
                    SELECT 1 FROM json_tree(CASE WHEN json_valid(v.action_config)
                                                 THEN v.action_config ELSE 'null' END) j
                     WHERE j.key = 'varKey' AND CAST(j.value AS TEXT) = ?
                  ))
           )`,
    values: (varKey, token, account) => [
      token, account, token, token, varKey,
      account, token, token, token, varKey,
    ],
  },
  {
    kind: 'friend_add',
    sql: `SELECT 'account_settings' AS source_table, s.id AS source_id, NULL AS source_parent_id,
                 '友だち追加時の設定' AS source_name, 'active' AS source_status,
                 s.value AS source_content, 0 AS is_historical
            FROM account_settings s
           WHERE s.line_account_id = ? AND s.key = 'friend_add_routing'
             AND (instr(coalesce(s.value, ''), ?) > 0 OR EXISTS (
               SELECT 1 FROM json_tree(CASE WHEN json_valid(s.value)
                                            THEN s.value ELSE 'null' END) j
                WHERE j.key = 'varKey' AND CAST(j.value AS TEXT) = ?
             ))`,
    values: (varKey, token, account) => [account, token, varKey],
  },
  {
    kind: 'common_action',
    sql: `SELECT 'common_actions' AS source_table, a.id AS source_id, NULL AS source_parent_id, a.name AS source_name,
                 a.status AS source_status, '共通情報を使う操作があります' AS source_content,
                 0 AS is_historical
            FROM common_actions a
           WHERE a.line_account_id = ? AND EXISTS (
             SELECT 1 FROM common_action_versions v
              WHERE v.common_action_id = a.id
                AND v.id IN (a.current_draft_version_id, a.current_published_version_id)
                AND (instr(coalesce(v.action_config, ''), ?) > 0 OR EXISTS (
                  SELECT 1 FROM json_tree(CASE WHEN json_valid(v.action_config)
                                               THEN v.action_config ELSE 'null' END) j
                   WHERE j.key = 'varKey' AND CAST(j.value AS TEXT) = ?
                ))
           )`,
    values: (varKey, token, account) => [account, token, varKey],
  },
];

export const COMMON_VAR_USAGE_SUMMARY_SQL = `SELECT
  ${COMMON_VAR_USAGE_QUERIES.map((source) =>
    `(SELECT COUNT(*) FROM (${source.sql})) AS ${source.kind}`).join(',\n  ')},
  (SELECT COUNT(*) FROM forms f
    LEFT JOIN form_versions v ON v.id = f.current_published_version_id
    CROSS JOIN (SELECT ? AS token, ? AS var_key) target
    WHERE NOT EXISTS (SELECT 1 FROM form_accounts fa WHERE fa.form_id = f.id)
      AND (instr(coalesce(f.on_submit_message_content, ''), target.token) > 0
        OR instr(coalesce(f.fields, ''), target.token) > 0
        OR instr(coalesce(f.layout, ''), target.token) > 0
        OR instr(coalesce(v.on_submit_message_content, ''), target.token) > 0
        OR instr(coalesce(v.fields, ''), target.token) > 0
        OR instr(coalesce(v.layout, ''), target.token) > 0
        OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(f.layout) THEN f.layout ELSE 'null' END, '$.references') j WHERE j.key = 'varKey' AND CAST(j.value AS TEXT) = target.var_key)
        OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(v.layout) THEN v.layout ELSE 'null' END, '$.references') j WHERE j.key = 'varKey' AND CAST(j.value AS TEXT) = target.var_key))) AS unscoped_form`;

/**
 * 一覧に出す使用先件数をまとめて数える。
 *
 * ブラウザから1行ずつ影響APIを呼ぶと、一覧表示だけで多数のHTTP往復が起きる。
 * ここでは各キーの9種類の走査を1文へまとめ、D1のbatchも80件ずつに区切る。
 */
export async function getCommonVarUsageCounts(
  db: D1Database,
  varKeys: string[],
  lineAccountId: string,
): Promise<Map<string, number>> {
  const summaries = await getCommonVarUsageSummaries(db, varKeys, lineAccountId);
  return new Map([...summaries].map(([key, summary]) => [key, summary.total]));
}

/** 一覧1回で、合計だけでなくテンプレート・配信等の種類別件数も返す。 */
export async function getCommonVarUsageSummaries(
  db: D1Database,
  varKeys: string[],
  lineAccountId: string,
): Promise<Map<string, CommonVarUsageSummary>> {
  const uniqueKeys = [...new Set(varKeys)];
  const summaries = new Map<string, CommonVarUsageSummary>();
  const batchSize = 80;

  for (let offset = 0; offset < uniqueKeys.length; offset += batchSize) {
    const keys = uniqueKeys.slice(offset, offset + batchSize);
    const statements = keys.map((varKey) => {
      const token = `{{var.${varKey}}}`;
      const values = COMMON_VAR_USAGE_QUERIES.flatMap((source) =>
        source.values(varKey, token, lineAccountId));
      return db.prepare(COMMON_VAR_USAGE_SUMMARY_SQL)
        .bind(...values, token, varKey);
    });
    const results = await db.batch<Record<CommonVarUsageKind, number> & { unscoped_form: number }>(statements);
    keys.forEach((varKey, index) => {
      const row = results[index]?.results[0];
      const byKind = Object.fromEntries(COMMON_VAR_USAGE_QUERIES.map(({ kind }) => [
        kind,
        Number(row?.[kind] ?? 0) + (kind === 'form' ? Number(row?.unscoped_form ?? 0) : 0),
      ])) as Record<CommonVarUsageKind, number>;
      summaries.set(varKey, {
        total: Object.values(byKind).reduce((sum, count) => sum + count, 0),
        byKind,
      });
    });
  }

  return summaries;
}
