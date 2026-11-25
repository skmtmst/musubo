import type { HqTemplateAuthority } from './contract.js';
import { boundedText, HqTemplateError } from './tag.js';
import { saveTemplate, templateDetail, templateCreationRequestId } from './distribution.js';
import { isFolderSelectColor, type HqTemplateFolder } from '@line-crm/shared';


function folderAudit(db: D1Database, auth: HqTemplateAuthority, id: string, action: string) {
  return db.prepare(`INSERT INTO audit_events(id,tenant_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result) VALUES (?,?,'business',?,?,?,'hq_template_folder',?,'success')`).bind(crypto.randomUUID(), auth.tenantId, auth.actorId, auth.role, `hq_template.folder_${action}`, id);
}
export async function listTemplateFolders(db: D1Database, auth: HqTemplateAuthority) {
  return (await db.prepare('SELECT id,name,revision,color,display_order AS displayOrder FROM hq_template_folders WHERE tenant_id=? AND archived_at IS NULL ORDER BY display_order,name,id').bind(auth.tenantId).all<HqTemplateFolder>()).results;
}
export async function saveTemplateFolder(db: D1Database, auth: HqTemplateAuthority, input: Record<string, unknown>, id?: string) {
  if (input.color !== undefined && !isFolderSelectColor(input.color)) throw new HqTemplateError('INVALID_FOLDER_COLOR', 422);
  const name = boundedText(input.name, 100, 'name'), folderId = id ?? crypto.randomUUID();
  if (id) {
    const current = await db.prepare('SELECT revision FROM hq_template_folders WHERE id=? AND tenant_id=? AND archived_at IS NULL').bind(id, auth.tenantId).first<{revision:number}>();
    if (!current) throw new HqTemplateError('NOT_FOUND', 404);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== current.revision) throw new HqTemplateError('VERSION_CONFLICT', 409);
  }
  try {
    if (id) await db.batch([
      db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM hq_template_folders WHERE id=? AND tenant_id=? AND revision=? AND archived_at IS NULL) THEN '{}' ELSE 'CONFLICT' END)").bind(id,auth.tenantId,input.expectedRevision),
      db.prepare("UPDATE hq_template_folders SET name=?,color=CASE WHEN ? THEN ? ELSE color END,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND tenant_id=?").bind(name,input.color !== undefined ? 1 : 0,input.color ?? null,id,auth.tenantId),
      folderAudit(db,auth,id,'updated'),
    ]);
    else await db.batch([db.prepare('INSERT INTO hq_template_folders(id,tenant_id,name,color,display_order) SELECT ?,?,?,?,COALESCE(MAX(display_order),-1)+1 FROM hq_template_folders WHERE tenant_id=? AND archived_at IS NULL').bind(folderId,auth.tenantId,name,input.color ?? null,auth.tenantId),folderAudit(db,auth,folderId,'created')]);
  } catch (e) { if (e instanceof HqTemplateError) throw e; if (String(e).includes('CONFLICT') || String(e).includes('malformed JSON')) throw new HqTemplateError('VERSION_CONFLICT',409); if (/UNIQUE constraint failed: hq_template_folders\.tenant_id, hq_template_folders\.name/i.test(String(e))) throw new HqTemplateError('FOLDER_NAME_CONFLICT',409); throw e; }
  return (await listTemplateFolders(db,auth)).find(f => f.id === folderId)!;
}
export async function deleteTemplateFolder(db: D1Database, auth: HqTemplateAuthority, id: string, revision: unknown) {
  if (!(await listTemplateFolders(db,auth)).some(f => f.id === id)) throw new HqTemplateError('NOT_FOUND',404);
  if (!Number.isSafeInteger(revision)) throw new HqTemplateError('INVALID_REVISION');
  try { await db.batch([
    db.prepare("SELECT json(CASE WHEN EXISTS(SELECT 1 FROM hq_template_folders WHERE id=? AND tenant_id=? AND revision=? AND archived_at IS NULL) THEN '{}' ELSE 'CONFLICT' END)").bind(id,auth.tenantId,revision),
    db.prepare("UPDATE hq_templates SET folder_id=NULL,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE tenant_id=? AND folder_id=?").bind(auth.tenantId,id),
    db.prepare("UPDATE hq_template_folders SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE id=? AND tenant_id=?").bind(id,auth.tenantId),
    folderAudit(db,auth,id,'deleted'),
  ]); } catch { throw new HqTemplateError('VERSION_CONFLICT',409); }
  return { id, archived: true };
}
export async function duplicateTemplate(db: D1Database, auth: HqTemplateAuthority, id: string, input: Record<string, unknown>) {
  const original = await templateDetail(db,auth,id);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== original.template.revision) throw new HqTemplateError('VERSION_CONFLICT',409);
  return saveTemplate(db,auth,{ type:original.template.template_type, name:boundedText(input.name, 200, 'name'), description:original.template.description,
    definition:original.definition, folderId:original.template.folder_id, requestId:templateCreationRequestId(input.requestId) });
}
