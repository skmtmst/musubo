import { RETENTION_TABLES } from '@line-crm/db';

export interface RetentionForeignKey {
  child: string;
  parent: string;
}

/** Walk every foreign-key ancestor, including ancestors reached through retained tables. */
export function retainedPurgeAncestors(
  categories: Readonly<Record<string, { category: string }>>,
  foreignKeys: readonly RetentionForeignKey[],
): string[] {
  const parents = new Map<string, Set<string>>();
  for (const { child, parent } of foreignKeys) {
    const entries = parents.get(child) ?? new Set<string>();
    entries.add(parent);
    parents.set(child, entries);
  }
  const visited = new Set<string>();
  const pending = Object.keys(categories).filter(name => categories[name].category === 'retain');
  const result = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const parent of parents.get(current) ?? []) {
      if (!categories[parent]) throw new Error(`retention_unknown_parent:${parent}`);
      if (categories[parent].category === 'purge') result.add(parent);
      if (!visited.has(parent)) pending.push(parent);
    }
  }
  return [...result].sort();
}

/** Read schema through SQLite's table-valued PRAGMA; table names are values, not SQL. */
export async function discoverRetainedPurgeAncestors(db: D1Database): Promise<string[]> {
  const rows = await db.prepare(`SELECT s.name AS child, fk."table" AS parent
    FROM sqlite_schema s JOIN pragma_foreign_key_list(s.name) fk
    WHERE s.type='table' AND s.name NOT LIKE 'sqlite_%'`).all<RetentionForeignKey>();
  return retainedPurgeAncestors(RETENTION_TABLES, rows.results);
}
