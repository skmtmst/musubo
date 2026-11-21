import { EMPTY_FRIEND_ADD_RULE_DEFINITION, type FriendAddRuleDefinition } from '@line-crm/db';

import type { StarterItem } from './style-starter-definition.js';

/** 初期セットのごあいさつ。友だち追加した人に 1 通だけ文を送る。 */
export function friendAddWelcomeDefinition(item: StarterItem): FriendAddRuleDefinition {
  return {
    ...EMPTY_FRIEND_ADD_RULE_DEFINITION,
    messageType: 'text',
    messageText: item.text ?? '',
    timing: 'immediate',
  };
}

/**
 * 初回の受け皿（経路が分からなかった人）に、ごあいさつの**下書きの版**を足す文を作る。
 *
 * 受け皿は 1 アカウントに 1 つしか作れないので、新しい決まりは作らない。
 * 公開済みの版は触らないので、［公開する］を押すまで 1 通も送られない。
 * 店が受け皿を設定済み（シナリオ・文・アクションあり）か、下書きが既にある時は
 * 店の設定を上書きしないよう何も作らず null を返す。
 */
export async function friendAddStarterStatements(
  db: D1Database,
  account: string,
  item: StarterItem,
  now: string,
): Promise<{ id: string; statements: D1PreparedStatement[] } | null> {
  const fallback = await db
    .prepare(
      `SELECT r.id,
              (SELECT 1 FROM friend_add_rule_versions d WHERE d.rule_id=r.id AND d.status='draft' LIMIT 1) AS has_draft,
              (SELECT v.definition_snapshot FROM friend_add_rule_versions v WHERE v.id=r.current_version_id) AS current_definition
         FROM friend_add_rules r
        WHERE r.line_account_id=? AND r.friend_kind='first_time'
          AND r.is_unknown_route_fallback=1 AND r.archived_at IS NULL
        LIMIT 1`,
    )
    .bind(account)
    .first<{ id: string; has_draft: number | null; current_definition: string | null }>();
  const statements: D1PreparedStatement[] = [];
  let ruleId: string;
  if (fallback) {
    if (fallback.has_draft || !isUntouched(fallback.current_definition)) return null;
    ruleId = fallback.id;
  } else {
    // 旧設定が残るアカウントは migration が受け皿を作るので、ここでは作らない。
    const legacy = await db
      .prepare(
        `SELECT 1 AS ok FROM account_settings WHERE line_account_id=? AND key='friend_add_routing' AND json_valid(value) LIMIT 1`,
      )
      .bind(account)
      .first();
    if (legacy) return null;
    // ensureFriendAddFallbackRules と同じ ID・中身。先に作られていれば何もしない。
    const defaultRuleId = `friend-add-rule-first_time-${account}`;
    const oldRule = await db.prepare('SELECT 1 FROM friend_add_rules WHERE id=?').bind(defaultRuleId).first();
    ruleId = oldRule ? crypto.randomUUID() : defaultRuleId;
    const versionId = oldRule ? crypto.randomUUID() : `friend-add-rule-version-first_time-${account}`;
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO friend_add_rules(id,line_account_id,friend_kind,name,priority,is_unknown_route_fallback,status,created_at,updated_at) VALUES(?,?,'first_time','経路が分からなかった人',9999,1,'published',?,?)`,
        )
        .bind(ruleId, account, now, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO friend_add_rule_versions(id,rule_id,version_number,definition_snapshot,status,published_at,created_at,updated_at) VALUES(?,?,1,?,'published',?,?,?)`,
        )
        .bind(
          versionId,
          ruleId,
          JSON.stringify({ ...EMPTY_FRIEND_ADD_RULE_DEFINITION, messageType: 'scenario', timing: 'scenario' }),
          now,
          now,
          now,
        ),
      db
        .prepare(
          `UPDATE friend_add_rules SET current_version_id=?,updated_at=? WHERE id=? AND line_account_id=? AND current_version_id IS NULL`,
        )
        .bind(versionId, now, ruleId, account),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO friend_add_rule_versions(id,rule_id,version_number,definition_snapshot,status,created_at,updated_at)
         SELECT ?,?,(SELECT COALESCE(MAX(version_number),0)+1 FROM friend_add_rule_versions WHERE rule_id=?),?,'draft',?,?
          WHERE EXISTS(SELECT 1 FROM friend_add_rules WHERE id=? AND line_account_id=?)
            AND NOT EXISTS(SELECT 1 FROM friend_add_rule_versions WHERE rule_id=? AND status='draft')`,
      )
      .bind(
        crypto.randomUUID(),
        ruleId,
        ruleId,
        JSON.stringify(friendAddWelcomeDefinition(item)),
        now,
        now,
        ruleId,
        account,
        ruleId,
      ),
    db
      .prepare(
        'UPDATE friend_add_rules SET lock_version=lock_version+1,updated_at=? WHERE id=? AND line_account_id=?',
      )
      .bind(now, ruleId, account),
  );
  return { id: ruleId, statements };
}

/** 受け皿が作られた時のまま（何も送らない形）か。読めない版は「設定済み」として触らない。 */
function isUntouched(snapshot: string | null): boolean {
  if (!snapshot) return true;
  try {
    const definition = JSON.parse(snapshot) as Partial<FriendAddRuleDefinition>;
    return (
      !definition.scenarioId &&
      !(definition.messageText ?? '').trim() &&
      !(definition.actions ?? []).length
    );
  } catch {
    return false;
  }
}
