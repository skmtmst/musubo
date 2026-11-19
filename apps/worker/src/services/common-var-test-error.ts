import type { CommonVarResolutionFailedError } from './interpolation-context.js';

/** 表示名を対象のLINEアカウントから取得し、見つからない場合はキーを使う。 */
export async function commonVarTestError(db: D1Database, accountId: string | null, error: CommonVarResolutionFailedError) {
  const keys = [...new Set(error.failures.map(failure => failure.varKey))];
  let rows: Array<{var_key:string;name:string}> = [];
  if (accountId) {
    try {
      rows = (await db.prepare(`SELECT var_key,name FROM common_vars WHERE line_account_id=? AND var_key IN (SELECT value FROM json_each(?))`)
        .bind(accountId, JSON.stringify(keys)).all<{var_key:string;name:string}>()).results;
    } catch {
      // 名前を読めなくても従来どおり送信は拒否する。
    }
  }
  const names = new Map(rows.map(row => [row.var_key, row.name]));
  return {
    success: false as const,
    code: 'COMMON_VAR_UNRESOLVED',
    error: `共通情報を解決できません: ${error.failures.map(failure => `{{var.${failure.varKey}}}`).join(', ')}`,
    data: { variables: keys.map(key => ({ key, displayName: names.get(key) ?? key })) },
  };
}
