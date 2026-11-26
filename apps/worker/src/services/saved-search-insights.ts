import {
  jstNow,
  validateSearchConditions,
  type SavedSearch,
  type SearchConditions,
} from '@line-crm/db';


import { compileSavedSearch } from './saved-search-filter.js';

export interface SavedSearchMatchInsight {
  matchCount: number | null;
  matchCountError: string | null;
}

export interface SavedSearchMatchPreview {
  total: number | null;
  byChannel: { line: number | null; mail: number | null };
  calculatedAt: string;
  error: string | null;
}

/** 編集中の条件を、保存済み条件と同じ評価器で数える。 */
export async function getSavedSearchMatchPreview(
  db: D1Database,
  conditions: SearchConditions,
  lineAccountId: string,
): Promise<SavedSearchMatchPreview> {
  const calculatedAt = jstNow();
  const compiled = compileSavedSearch(conditions);
  if (!compiled.ok) {
    return {
      total: null,
      byChannel: { line: null, mail: null },
      calculatedAt,
      error: compiled.error,
    };
  }
  try {
    const row = await db.prepare(
      `SELECT COUNT(DISTINCT f.id) AS total,
              COUNT(DISTINCT CASE
                WHEN NULLIF(f.line_platform_user_id, '') IS NOT NULL THEN f.id END) AS line_total,
              COUNT(DISTINCT CASE
                WHEN json_valid(f.metadata) = 1
                 AND NULLIF(CAST(json_extract(f.metadata, '$.email') AS TEXT), '') IS NOT NULL
                THEN f.id END) AS mail_total
         FROM friends f
        WHERE f.line_account_id = ? AND ${compiled.value.sql}`,
    ).bind(lineAccountId, ...compiled.value.binds).first<{
      total: number | string;
      line_total: number | string;
      mail_total: number | string;
    }>();
    if (!row) throw new Error('saved_search_preview_missing');
    return {
      total: Number(row.total),
      byChannel: { line: Number(row.line_total), mail: Number(row.mail_total) },
      calculatedAt,
      error: null,
    };
  } catch {
    return {
      total: null,
      byChannel: { line: null, mail: null },
      calculatedAt,
      error: '該当人数を確認できませんでした',
    };
  }
}

/**
 * 保存した検索の該当人数を、友だち一覧と同じ条件評価器でまとめて数える。
 *
 * 0人と評価不能を分ける。壊れた条件を0人として返すと「対象はいない」と
 * 読まれ、条件の修正が後回しになるため、理由付きnullを返す。
 */
export async function getSavedSearchMatchInsights(
  db: D1Database,
  rows: SavedSearch[],
  lineAccountId: string,
): Promise<Map<string, SavedSearchMatchInsight>> {
  const output = new Map<string, SavedSearchMatchInsight>();
  const prepared: Array<{ id: string; statement: D1PreparedStatement }> = [];

  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.conditions_json);
    } catch {
      output.set(row.id, { matchCount: null, matchCountError: '条件のJSONが壊れています' });
      continue;
    }
    const validated = validateSearchConditions(raw);
    if (!validated.ok) {
      output.set(row.id, { matchCount: null, matchCountError: validated.error });
      continue;
    }
    const compiled = compileSavedSearch(validated.value);
    if (!compiled.ok) {
      output.set(row.id, { matchCount: null, matchCountError: compiled.error });
      continue;
    }
    prepared.push({
      id: row.id,
      statement: db.prepare(
        `SELECT COUNT(DISTINCT f.id) AS total
           FROM friends f
          WHERE f.line_account_id = ? AND ${compiled.value.sql}`,
      ).bind(lineAccountId, ...compiled.value.binds),
    });
  }

  if (prepared.length === 0) return output;
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(prepared.map((item) => item.statement));
  } catch {
    for (const item of prepared) {
      output.set(item.id, {
        matchCount: null,
        matchCountError: '該当人数を確認できませんでした',
      });
    }
    return output;
  }
  prepared.forEach((item, index) => {
    const result = results[index];
    const first = result?.results?.[0] as { total?: number | string } | undefined;
    if (!result?.success || first?.total === undefined) {
      output.set(item.id, { matchCount: null, matchCountError: '該当人数を確認できませんでした' });
      return;
    }
    output.set(item.id, { matchCount: Number(first.total), matchCountError: null });
  });
  return output;
}
