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
