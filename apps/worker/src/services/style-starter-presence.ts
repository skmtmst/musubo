import { resourceTables, snapshotSql } from './style-starter-resource.js';
import { StyleError } from './style-setup-core.js';

/** 見本が運用者から削除されていないか。タグの見本は記録そのものが実体。 */
function presenceSql(kind: string): string {
  if (kind === 'tag_set') return 'SELECT 1 WHERE ? IS NOT NULL AND ? IS NOT NULL';
  if (kind === 'dashboard') return 'SELECT 1 FROM account_styles WHERE line_account_id=? AND line_account_id=?';
  if (kind === 'form') return "SELECT 1 FROM forms f JOIN form_accounts a ON a.form_id=f.id WHERE f.id=? AND a.line_account_id=? AND f.status!='archived'";
  const resource = resourceTables[kind];
  if (!resource) throw new StyleError('invalid_resource');
  const live = ['template', 'booking_menu', 'reminder'].includes(kind) ? ' AND deleted_at IS NULL' : kind === 'friend_add_rule' ? " AND archived_at IS NULL AND status!='archived'" : kind === 'automation' ? " AND status!='archived'" : '';
  return `SELECT 1 FROM ${resource.table} WHERE id=? AND ${resource.account}=?${live}`;
}
type StarterPresenceRow = {
  item_key: string; target_id: string; kind: string; style: string;
  is_sample: number; source_snapshot: string | null; present: number | null; current_snapshot: string | null;
};

/** 記録と各実体の有無をまとめて読み、対象の数に応じた往復を発生させない。 */
export async function loadStarterPresence(db: D1Database, account: string, snapshots = false): Promise<StarterPresenceRow[]> {
  const kinds = ['tag_set', 'dashboard', 'form', ...Object.keys(resourceTables)];
  const cases = kinds.map(kind => {
    const first = kind === 'dashboard' ? 'i.line_account_id' : 'i.target_id';
    const sql = presenceSql(kind).replace('?', first).replace('?', 'i.line_account_id');
    return `WHEN '${kind}' THEN EXISTS(${sql})`;
  }).join(' ');
  const snapshotsSql = snapshots ? `CASE i.kind ${['form', 'rich_menu'].map(kind => `WHEN '${kind}' THEN ${snapshotSql(kind).replace('?', 'i.target_id').replace('?', 'i.line_account_id')}`).join(' ')} ELSE NULL END` : 'NULL';
  return (await db.prepare(`SELECT i.*, ${snapshotsSql} AS current_snapshot, CASE i.kind ${cases} ELSE NULL END AS present
    FROM style_starter_items i WHERE i.line_account_id=?`).bind(account).all<StarterPresenceRow>()).results;
}

export function starterResourceExists(row: StarterPresenceRow): boolean {
  if (row.present === null) throw new StyleError('invalid_resource');
  return row.present === 1;
}
/** 作成計画後に実体が復活した場合、補充全体を中止する。 */
export function missingStarterGuard(db: D1Database, account: string, row: {kind:string;target_id:string}) {
  return db.prepare(`SELECT json(CASE WHEN EXISTS(${presenceSql(row.kind)}) THEN 'STYLE_VERSION_CONFLICT' ELSE '{}' END)`)
    .bind(row.kind === 'dashboard' ? account : row.target_id, account);
}
