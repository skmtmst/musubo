import { jstNow } from './utils.js';
import type { HqBannerFolder, HqBannerFolderKind } from '@line-crm/shared';

export class HqFolderError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 422 = 422) { super(code); }
}
type OrderedTable = 'hq_banner_folders' | 'hq_template_folders' | 'hq_broadcast_folders';
interface OrderedFolder { id: string; name: string; display_order: number; revision: number }
async function atomic(db: D1Database, statements: D1PreparedStatement[]) {
  try { return await db.batch(statements); }
  catch (e) {
    if (/malformed JSON|FOLDER_CONFLICT/i.test(String(e))) throw new HqFolderError('VERSION_CONFLICT',409);
    if (/UNIQUE constraint failed: hq_banner_folders\.tenant_id, hq_banner_folders\.kind, hq_banner_folders\.name/i.test(String(e))) throw new HqFolderError('FOLDER_NAME_CONFLICT',409);
    throw e;
  }
}
export async function swapHqFolderOrder(db: D1Database, table: OrderedTable, tenantId: string, id: string,
  input: { withId: string; expectedRevision: number; withExpectedRevision: number }, kind?: HqBannerFolderKind) {
  if (!input.withId || input.withId === id || !Number.isSafeInteger(input.expectedRevision) || !Number.isSafeInteger(input.withExpectedRevision)) throw new HqFolderError('INVALID_FOLDER_ORDER');
  const condition = 'tenant_id=? AND archived_at IS NULL' + (kind ? ' AND kind=?' : '');
  const bindings = [tenantId,...(kind ? [kind] : [])];
  const rows = (await db.prepare(`SELECT id,name,display_order,revision FROM ${table} WHERE ${condition} ORDER BY display_order,name,id`).bind(...bindings).all<OrderedFolder>()).results;
  const a = rows.find(f=>f.id===id), b = rows.find(f=>f.id===input.withId);
  if (!a || !b) throw new HqFolderError('NOT_FOUND',404);
  if (a.revision !== input.expectedRevision || b.revision !== input.withExpectedRevision) throw new HqFolderError('VERSION_CONFLICT',409);
  // 同じ番号の兄弟がいても選んだ2つの位置だけを確実に交換する。
  const aIndex=rows.indexOf(a),bIndex=rows.indexOf(b);
  [rows[aIndex],rows[bIndex]]=[rows[bIndex],rows[aIndex]];
  const now=jstNow();
  await atomic(db,[...rows.map(f=>db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=? AND ${condition} AND revision=?) THEN '{}' ELSE 'FOLDER_CONFLICT' END)`).bind(f.id,...bindings,f.revision)),
    ...rows.map((f,i)=>db.prepare(`UPDATE ${table} SET display_order=?,revision=revision+1,updated_at=? WHERE id=? AND ${condition}`).bind(i,now,f.id,...bindings))]);
  return {swapped:[id,input.withId] as [string,string]};
}
interface BannerFolderRow { id:string; kind:HqBannerFolderKind; name:string; color:string|null; display_order:number; revision:number; item_count:number; created_at:string; updated_at:string }
export async function listHqBannerFolders(db:D1Database,tenantId:string,kind:HqBannerFolderKind):Promise<HqBannerFolder[]> {
  const table=kind==='project'?'banner_projects':'banner_images',live=kind==='project'?'archived_at':'deleted_at';
  const rows=(await db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM ${table} b WHERE b.folder_id=f.id AND b.tenant_id=f.tenant_id AND b.${live} IS NULL) AS item_count FROM hq_banner_folders f WHERE tenant_id=? AND kind=? AND archived_at IS NULL ORDER BY display_order,name,id`).bind(tenantId,kind).all<BannerFolderRow>()).results;
  return rows.map(f=>({id:f.id,kind:f.kind,name:f.name,color:f.color,displayOrder:f.display_order,revision:f.revision,itemCount:f.item_count,createdAt:f.created_at,updatedAt:f.updated_at}));
}
export async function saveHqBannerFolder(db:D1Database,tenantId:string,kind:HqBannerFolderKind,input:{name?:string;color?:string|null;expectedRevision?:number},id?:string) {
  const current=id?(await listHqBannerFolders(db,tenantId,kind)).find(f=>f.id===id):undefined;
  if (id&&!current) throw new HqFolderError('NOT_FOUND',404);
  const name=(input.name??current?.name??'').trim();
  if (!name || name.length>100) throw new HqFolderError('INVALID_FOLDER_NAME');
  const now=jstNow(),folderId=id??crypto.randomUUID();
  if (id) {
    if (input.expectedRevision!==current!.revision) throw new HqFolderError('VERSION_CONFLICT',409);
    await atomic(db,[db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM hq_banner_folders WHERE id=? AND tenant_id=? AND kind=? AND archived_at IS NULL AND revision=?) THEN '{}' ELSE 'FOLDER_CONFLICT' END)").bind(id,tenantId,kind,input.expectedRevision),db.prepare('UPDATE hq_banner_folders SET name=?,color=?,revision=revision+1,updated_at=? WHERE id=? AND tenant_id=? AND kind=?').bind(name,input.color===undefined?current!.color:input.color,now,id,tenantId,kind)]);
  } else {
    await atomic(db,[db.prepare('INSERT INTO hq_banner_folders(id,tenant_id,kind,name,color,display_order,created_at,updated_at) SELECT ?,?,?,?,?,COALESCE(MAX(display_order),-1)+1,?,? FROM hq_banner_folders WHERE tenant_id=? AND kind=? AND archived_at IS NULL').bind(folderId,tenantId,kind,name,input.color??null,now,now,tenantId,kind)]);
  }
  return (await listHqBannerFolders(db,tenantId,kind)).find(f=>f.id===folderId)!;
}
export async function deleteHqBannerFolder(db:D1Database,tenantId:string,kind:HqBannerFolderKind,id:string,expectedRevision:number) {
  if (!(await listHqBannerFolders(db,tenantId,kind)).some(f=>f.id===id)) throw new HqFolderError('NOT_FOUND',404);
  if (!Number.isSafeInteger(expectedRevision)) throw new HqFolderError('INVALID_REVISION');
  const table=kind==='project'?'banner_projects':'banner_images',now=jstNow();
  await atomic(db,[db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM hq_banner_folders WHERE id=? AND tenant_id=? AND kind=? AND archived_at IS NULL AND revision=?) THEN '{}' ELSE 'FOLDER_CONFLICT' END)").bind(id,tenantId,kind,expectedRevision),db.prepare(`UPDATE ${table} SET folder_id=NULL WHERE folder_id=? AND tenant_id=?`).bind(id,tenantId),db.prepare('UPDATE hq_banner_folders SET archived_at=?,revision=revision+1,updated_at=? WHERE id=? AND tenant_id=? AND kind=?').bind(now,now,id,tenantId,kind)]);
  return {id,archived:true};
}
export async function readHqBannerFolderAssignment(db:D1Database,tenantId:string,kind:HqBannerFolderKind,value:unknown) {
  if (value===undefined||value===null) return value;
  if (typeof value!=='string'||!(await db.prepare('SELECT id FROM hq_banner_folders WHERE id=? AND tenant_id=? AND kind=? AND archived_at IS NULL').bind(value,tenantId,kind).first())) throw new HqFolderError('INVALID_FOLDER');
  return value;
}
