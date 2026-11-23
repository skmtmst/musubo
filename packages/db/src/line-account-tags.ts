import { sqlIdSet } from './id-queries.js';
import { DEFAULT_TENANT_ID } from '@line-crm/shared';
import { jstNow } from './utils.js';

const liveTag = (alias:string) => `EXISTS (SELECT 1 FROM tenants t_live WHERE t_live.id=${alias}.tenant_id AND t_live.purge_started_at IS NULL AND t_live.data_purged_at IS NULL) AND NOT EXISTS (SELECT 1 FROM tenant_purge_tombstone_progress p WHERE p.tenant_id=${alias}.tenant_id AND p.table_name='line_account_tags' AND p.row_id=${alias}.id)`;

export interface LineAccountTag {
  id: string;
  tenant_id: string;
  name: string;
  color: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
}
export function serializeLineAccountTag(tag: LineAccountTag) {
  return { id: tag.id, name: tag.name, color: tag.color, displayOrder: tag.display_order,
    createdAt: tag.created_at, updatedAt: tag.updated_at };
}
export async function listLineAccountTags(db: D1Database, tenantId: string): Promise<LineAccountTag[]> {
  const { results } = await db.prepare(`SELECT * FROM line_account_tags WHERE tenant_id = ? AND ${liveTag('line_account_tags')} ORDER BY display_order, name, id`)
    .bind(tenantId).all<LineAccountTag>();
  return results;
}
export async function getLineAccountTag(db: D1Database, tenantId: string, id: string): Promise<LineAccountTag | null> {
  return db.prepare(`SELECT * FROM line_account_tags WHERE tenant_id = ? AND id = ? AND ${liveTag('line_account_tags')}`).bind(tenantId, id).first<LineAccountTag>();
}
export async function createLineAccountTag(db: D1Database, tenantId: string,
  input: { name: string; color?: string | null; displayOrder?: number }): Promise<LineAccountTag> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db.prepare('INSERT INTO line_account_tags (id, tenant_id, name, color, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, tenantId, input.name, input.color ?? null, input.displayOrder ?? 0, now, now).run();
  return (await getLineAccountTag(db, tenantId, id))!;
}
export async function updateLineAccountTag(db: D1Database, tenantId: string, id: string,
  input: { name?: string; color?: string | null; displayOrder?: number }): Promise<LineAccountTag | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of [['name', 'name'], ['color', 'color'], ['displayOrder', 'display_order']] as const) {
    if (key in input) { sets.push(`${column} = ?`); values.push(input[key]); }
  }
  if (sets.length) await db.prepare(`UPDATE line_account_tags SET ${sets.join(', ')}, updated_at = ? WHERE tenant_id = ? AND id = ? AND ${liveTag('line_account_tags')}`)
    .bind(...values, jstNow(), tenantId, id).run();
  return getLineAccountTag(db, tenantId, id);
}
export async function deleteLineAccountTag(db: D1Database, tenantId: string, id: string): Promise<void> {
  await db.batch([
    db.prepare('UPDATE line_accounts SET folder_id=NULL, revision=revision+1, updated_at=? WHERE folder_id=? AND COALESCE(tenant_id,?)=?').bind(jstNow(),id,DEFAULT_TENANT_ID,tenantId),
    db.prepare('DELETE FROM line_account_tag_links WHERE tenant_id = ? AND tag_id = ?').bind(tenantId, id),
    db.prepare(`DELETE FROM line_account_tags WHERE tenant_id = ? AND id = ? AND ${liveTag('line_account_tags')}`).bind(tenantId, id),
  ]);
}
export async function getLineAccountTagsByAccountIds(db: D1Database, tenantId: string, accountIds: string[]) {
  const out: Record<string, ReturnType<typeof serializeLineAccountTag>[]> = {};
  if (!accountIds.length) return out;
  const { results } = await db.prepare(`SELECT t.*, l.line_account_id FROM line_account_tags t
    JOIN line_account_tag_links l ON l.tag_id = t.id AND l.tenant_id = t.tenant_id
    JOIN line_accounts a ON a.id = l.line_account_id
    WHERE t.tenant_id = ? AND ${liveTag('t')} AND a.data_purged_at IS NULL AND COALESCE(a.tenant_id, ?) = ?
      AND l.line_account_id IN (${sqlIdSet(accountIds).sql})
    ORDER BY t.display_order, t.name, t.id`).bind(tenantId, DEFAULT_TENANT_ID, tenantId, ...(accountIds.length ? sqlIdSet(accountIds).binds : []))
    .all<LineAccountTag & { line_account_id: string }>();
  for (const tag of results) (out[tag.line_account_id] ??= []).push(serializeLineAccountTag(tag));
  return out;
}
/** D1の一括処理で付け外しをまとめ、途中でアーカイブされた場合も変更しない。 */
export async function replaceLineAccountTags(db: D1Database, tenantId: string, accountId: string, tagIds: string[]): Promise<boolean> {
  const active = `EXISTS (SELECT 1 FROM line_accounts a WHERE a.id = ? AND COALESCE(a.tenant_id, ?) = ? AND a.archived_at IS NULL)`;
  const scope = [accountId, DEFAULT_TENANT_ID, tenantId];
  const results = await db.batch([
    db.prepare(`UPDATE line_accounts SET folder_id = (SELECT t.id FROM line_account_tags t
        WHERE t.tenant_id = ? AND ${liveTag('t')} AND t.id IN (SELECT value FROM json_each(?))
        ORDER BY t.display_order,t.name,t.id LIMIT 1), revision = revision + 1, updated_at = ? WHERE id = ? AND COALESCE(tenant_id, ?) = ? AND archived_at IS NULL`)
      .bind(tenantId, JSON.stringify(tagIds), jstNow(), ...scope),
    db.prepare(`DELETE FROM line_account_tag_links WHERE line_account_id = ? AND tenant_id = ? AND ${active}`)
      .bind(accountId, tenantId, ...scope),
    ...tagIds.map(id => db.prepare(`INSERT INTO line_account_tag_links (line_account_id, tag_id, tenant_id)
      SELECT ?, id, tenant_id FROM line_account_tags WHERE id = ? AND tenant_id = ? AND ${liveTag('line_account_tags')} AND ${active}`)
      .bind(accountId, id, tenantId, ...scope)),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0;
}

/** 新規登録用。版を進めず、途中の失敗はまとめて巻き戻す。 */
export async function attachLineAccountRegistrationTags(db: D1Database, tenantId: string, accountId: string, tagIds: string[]): Promise<void> {
  if (!tagIds.length) return;
  await db.batch([
    ...tagIds.flatMap(id => [
      db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM line_account_tags WHERE id=? AND tenant_id=? AND ${liveTag('line_account_tags')}) THEN 'true' ELSE 'INVALID_TAG' END)`).bind(id,tenantId),
      db.prepare('INSERT INTO line_account_tag_links (line_account_id, tag_id, tenant_id) VALUES (?, ?, ?)').bind(accountId,id,tenantId),
    ]),
    db.prepare(`UPDATE line_accounts SET folder_id=(SELECT t.id FROM line_account_tags t
      WHERE t.tenant_id=? AND ${liveTag('t')} AND t.id IN (SELECT value FROM json_each(?))
      ORDER BY t.display_order,t.name,t.id LIMIT 1) WHERE id=? AND COALESCE(tenant_id,?)=?`)
      .bind(tenantId,JSON.stringify(tagIds),accountId,DEFAULT_TENANT_ID,tenantId),
  ]);
}

/** 店の汎用Folderと同じ返り値。統括内かつ閲覧可能な現役アカウントだけを数える。 */
export async function listLineAccountFolders(db: D1Database, tenantId: string, accountIds: string[]) {
  const rows = await listLineAccountTags(db, tenantId);
  const counts = accountIds.length ? (await db.prepare(`SELECT folder_id,COUNT(*) AS count FROM line_accounts
    WHERE id IN (${sqlIdSet(accountIds).sql}) AND COALESCE(tenant_id,?)=? AND archived_at IS NULL
    GROUP BY folder_id`).bind(...(accountIds.length ? sqlIdSet(accountIds).binds : []),DEFAULT_TENANT_ID,tenantId).all<{folder_id:string|null;count:number}>()).results : [];
  return { folders: rows.map(row => ({ ...serializeLineAccountTag(row),kind:'line_account',parentId:null,
    itemCount:counts.find(count => count.folder_id===row.id)?.count ?? 0 })),
    total:counts.reduce((n,row)=>n+row.count,0),unclassifiedCount:counts.find(row=>row.folder_id===null)?.count ?? 0 };
}
export async function getLineAccountFoldersByAccountIds(db: D1Database, tenantId: string, accountIds: string[]) {
  const out: Record<string, import('@line-crm/shared').Folder | null> = {};
  if (!accountIds.length) return out;
  const rows = (await db.prepare(`SELECT t.*,a.id AS account_id FROM line_accounts a
    LEFT JOIN line_account_tags t ON t.id=a.folder_id AND t.tenant_id=COALESCE(a.tenant_id,?) AND ${liveTag('t')}
    WHERE COALESCE(a.tenant_id,?)=? AND a.data_purged_at IS NULL AND a.id IN (${sqlIdSet(accountIds).sql})`)
    .bind(DEFAULT_TENANT_ID,DEFAULT_TENANT_ID,tenantId,...(accountIds.length ? sqlIdSet(accountIds).binds : [])).all<LineAccountTag & {account_id:string}>()).results;
  for(const row of rows) out[row.account_id]=row.id ? {...serializeLineAccountTag(row),kind:'line_account',parentId:null} : null;
  return out;
}
