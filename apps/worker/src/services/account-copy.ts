import { SPECIALIZED_CATALOG_SETTING_KEY } from '@line-crm/shared';

export type AccountCopyItem = 'accountSettings' | 'scenarios' | 'autoReplies';

const ALLOWED_COPY_ITEMS = new Set<AccountCopyItem>([
  'accountSettings',
  'scenarios',
  'autoReplies',
]);

export function normalizeCopyItems(value: unknown): AccountCopyItem[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !ALLOWED_COPY_ITEMS.has(item as AccountCopyItem))) {
    return null;
  }
  return [...new Set(value as AccountCopyItem[])];
}

type Row = Record<string, unknown>;

async function rows(db: D1Database, sql: string, ...bindings: unknown[]): Promise<Row[]> {
  const result = await db.prepare(sql).bind(...bindings).all<Row>();
  return result.results;
}

function insertStatement(db: D1Database, table: string, row: Row): D1PreparedStatement {
  const columns = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .bind(...columns.map((column) => row[column]));
}

function replaceMappedIds(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceMappedIds(item, idMap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceMappedIds(item, idMap)]),
    );
  }
  return value;
}

function remapJson(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.stringify(replaceMappedIds(JSON.parse(value), idMap));
  } catch {
    return value;
  }
}

/**
 * 認証情報・友だち・履歴・実績を除外し、アカウントに紐づく運用設定だけを複製する。
 * D1 batch は一つのトランザクションとして実行されるため、項目の途中だけ複製されない。
 */
export async function copyLineAccountSettings(
  db: D1Database,
  sourceAccountId: string,
  targetAccountId: string,
  items: AccountCopyItem[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  if (items.includes('accountSettings')) {
    for (const row of await rows(db, 'SELECT * FROM account_settings WHERE line_account_id = ?', sourceAccountId)) {
      // 店舗固有の初期目録を、然のテンプレートから引き継がない。
      if (row.key === 'inbox_email_legacy_enabled' || row.key === 'inbox_email_forwarding_connected' || row.key === SPECIALIZED_CATALOG_SETTING_KEY) continue;
      statements.push(insertStatement(db, 'account_settings', {
        ...row,
        id: crypto.randomUUID(),
        line_account_id: targetAccountId,
      }));
    }
  }

  if (items.includes('autoReplies')) {
    for (const row of await rows(db, 'SELECT * FROM auto_replies WHERE line_account_id = ? AND deleted_at IS NULL', sourceAccountId)) {
      statements.push(insertStatement(db, 'auto_replies', {
        ...row,
        id: crypto.randomUUID(),
        line_account_id: targetAccountId,
        is_active: 0,
        lifecycle_status: 'draft',
        current_draft_version_id: null,
        current_published_version_id: null,
      }));
    }
  }

  if (items.includes('scenarios')) {
    const sourceScenarios = await rows(
      db,
      'SELECT * FROM scenarios WHERE line_account_id = ? ORDER BY display_order, created_at',
      sourceAccountId,
    );
    const scenarioIdMap = new Map<string, string>();
    const stepIdMap = new Map<string, string>();
    for (const scenario of sourceScenarios) {
      scenarioIdMap.set(String(scenario.id), crypto.randomUUID());
    }

    for (const scenario of sourceScenarios) {
      const sourceScenarioId = String(scenario.id);
      const targetScenarioId = scenarioIdMap.get(sourceScenarioId)!;
      const mappedCompleteTarget = scenario.on_complete_scenario_id
        ? scenarioIdMap.get(String(scenario.on_complete_scenario_id)) ?? null
        : null;
      statements.push(insertStatement(db, 'scenarios', {
        ...scenario,
        id: targetScenarioId,
        line_account_id: targetAccountId,
        on_complete_scenario_id: mappedCompleteTarget,
        is_active: 0,
        current_published_version_id: null,
      }));

      const sourceSteps = await rows(
        db,
        'SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY step_order',
        sourceScenarioId,
      );
      for (const step of sourceSteps) {
        const targetStepId = crypto.randomUUID();
        stepIdMap.set(String(step.id), targetStepId);
        statements.push(insertStatement(db, 'scenario_steps', {
          ...step,
          id: targetStepId,
          scenario_id: targetScenarioId,
        }));
      }
    }

    const allIdMap = new Map([...scenarioIdMap, ...stepIdMap]);
    for (const scenario of sourceScenarios) {
      const sourceScenarioId = String(scenario.id);
      for (const action of await rows(
        db,
        'SELECT * FROM scenario_actions WHERE scenario_id = ? ORDER BY sort_order, created_at',
        sourceScenarioId,
      )) {
        statements.push(insertStatement(db, 'scenario_actions', {
          ...action,
          id: crypto.randomUUID(),
          scenario_id: scenarioIdMap.get(sourceScenarioId)!,
          step_id: action.step_id ? stepIdMap.get(String(action.step_id)) ?? null : null,
          config_json: remapJson(action.config_json, allIdMap),
          condition_json: remapJson(action.condition_json, allIdMap),
        }));
      }
    }
  }

  if (statements.length > 0) await db.batch(statements);
}
