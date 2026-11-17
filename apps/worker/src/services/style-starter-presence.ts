import { resourceTables } from './style-starter-resource.js';
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
export async function starterResourceExists(db: D1Database, account: string, row: {kind:string;target_id:string}) {
  return !!await db.prepare(presenceSql(row.kind)).bind(row.kind === 'dashboard' ? account : row.target_id, account).first();
}
/** 作成計画後に実体が復活した場合、補充全体を中止する。 */
export function missingStarterGuard(db: D1Database, account: string, row: {kind:string;target_id:string}) {
  return db.prepare(`SELECT json(CASE WHEN EXISTS(${presenceSql(row.kind)}) THEN 'STYLE_VERSION_CONFLICT' ELSE '{}' END)`)
    .bind(row.kind === 'dashboard' ? account : row.target_id, account);
}
