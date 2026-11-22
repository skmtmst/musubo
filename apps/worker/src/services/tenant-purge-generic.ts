import { redactRetainedJson } from './tenant-purge-json.js';
import type { TombstonePolicy } from './tenant-retain-graph.js';

/** Build values only; the caller must check scope, marker, constraints, and apply them atomically. */
export function buildTombstoneValues(
  table: string,
  rowId: string,
  row: Readonly<Record<string, unknown>>,
  policy: TombstonePolicy,
): Record<string, string | number | null> {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !rowId) throw new Error('invalid_tombstone_identity');
  const values: Record<string, string | number | null> = Object.create(null) as Record<string, string | number | null>;
  for (const [column, decision] of Object.entries(policy.columns)) {
    if (!/^[a-z][a-z0-9_]*$/.test(column) || !Object.hasOwn(row, column)) throw new Error('invalid_tombstone_column');
    switch (decision.action) {
      case 'retain': break;
      case 'null': values[column] = null; break;
      case 'placeholder': values[column] = '（削除済み）'; break;
      case 'zero': values[column] = 0; break;
      case 'empty_array': values[column] = '[]'; break;
      case 'archive': values[column] = 'archived'; break;
      case 'unique': values[column] = `purged:${table}:${column}:${rowId}`; break;
      case 'json':
        if (typeof row[column] !== 'string') throw new Error('invalid_tombstone_json');
        values[column] = redactRetainedJson(row[column] as string);
        break;
      default: throw new Error('tombstone_policy_unresolved');
    }
  }
  return values;
}

/** Tombstone one scoped chunk, remembering each completed row in the same D1 transaction. */
export async function tombstoneRetainedParents(db: D1Database, input: {
  tenantId: string; table: string; scope: string; scopeValues: readonly unknown[]; limit: number; policy: TombstonePolicy;
}): Promise<number> {
  if (!/^[a-z][a-z0-9_]*$/.test(input.table) || !Number.isInteger(input.limit) || input.limit < 1) throw new Error('invalid_tombstone_scope');
  const table = input.table;
  const rows = await db.prepare(`SELECT ${table}.* FROM ${table}
    WHERE (${input.scope}) AND NOT EXISTS (SELECT 1 FROM tenant_purge_tombstone_progress p
      WHERE p.tenant_id=? AND p.table_name=? AND p.row_id=CAST(${table}.id AS TEXT)) ORDER BY ${table}.rowid LIMIT ?`)
    .bind(...input.scopeValues, input.tenantId, table, input.limit).all<Record<string, unknown>>();
  let count = 0;
  for (const row of rows.results) {
    if (typeof row.id !== 'string' || !row.id) throw new Error('invalid_tombstone_identity');
    const changes = buildTombstoneValues(table,row.id,row,input.policy);
    const columns = Object.keys(changes);
    const assignments = columns.length ? columns.map(column=>`"${column}"=?`).join(',') : 'id=id';
    if (columns.length === 0) {
      const markOnly = db.prepare(`INSERT INTO tenant_purge_tombstone_progress(tenant_id,table_name,row_id)
        SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM ${table} WHERE id=? AND (${input.scope}))
          AND EXISTS (SELECT 1 FROM tenants WHERE id=? AND purge_started_at IS NOT NULL AND data_purged_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM tenant_purge_tombstone_progress WHERE tenant_id=? AND table_name=? AND row_id=?)`)
        .bind(input.tenantId,table,row.id,row.id,...input.scopeValues,input.tenantId,input.tenantId,table,row.id);
      const verify = db.prepare("SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'TOMBSTONE_FAILED' END)");
      await db.batch([markOnly,verify]);
      count++;
      continue;
    }
    const update = db.prepare(`UPDATE ${table} SET ${assignments} WHERE id=? AND (${input.scope})
      AND EXISTS(SELECT 1 FROM tenants WHERE id=? AND purge_started_at IS NOT NULL AND data_purged_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM tenant_purge_tombstone_progress WHERE tenant_id=? AND table_name=? AND row_id=?)`)
      .bind(...columns.map(column=>changes[column]),row.id,...input.scopeValues,input.tenantId,input.tenantId,table,row.id);
    const mark = db.prepare(`INSERT INTO tenant_purge_tombstone_progress(tenant_id,table_name,row_id)
      SELECT ?,?,? WHERE changes()=1`).bind(input.tenantId,table,row.id);
    const verify = db.prepare("SELECT json(CASE WHEN changes()=1 THEN 'true' ELSE 'TOMBSTONE_FAILED' END)");
    await db.batch([update,mark,verify]);
    count++;
  }
  return count;
}
