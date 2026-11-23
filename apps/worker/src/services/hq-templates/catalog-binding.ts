import type { HqCatalogTemplateType } from '@line-crm/shared';
import { HqTemplateError } from './tag.js';

export interface CatalogBinding {
  targetId: string;
  appliedVersionId: string;
  pendingVersionId: string | null;
  dismissedVersionId: string | null;
  appliedSnapshotHash: string;
  hashVersion: number;
  rowVersion: number;
}

/** The binding identifies the target; a name or legacy origin cannot select it. */
export async function readCatalogBinding(db: D1Database, tenantId: string, templateId: string, accountId: string, kind: HqCatalogTemplateType): Promise<CatalogBinding | null> {
  const row = await db.prepare(`SELECT b.target_id,b.applied_version_id,b.pending_version_id,b.dismissed_version_id,b.applied_snapshot_hash,b.hash_version,b.row_version,b.kind
    FROM hq_template_store_bindings b JOIN line_accounts a ON a.id=b.target_account_id AND a.tenant_id=b.tenant_id
    WHERE b.tenant_id=? AND b.template_id=? AND b.target_account_id=? AND a.is_active=1 AND a.archived_at IS NULL`)
    .bind(tenantId, templateId, accountId).first<{target_id:string;applied_version_id:string;pending_version_id:string|null;dismissed_version_id:string|null;applied_snapshot_hash:string;hash_version:number;row_version:number;kind:string}>();
  if (!row) return null;
  if (row.kind !== kind) throw new HqTemplateError('VERSION_CONFLICT',409);
  const table = kind === 'booking_menu' ? 'menus' : 'mileage_rewards';
  const active = kind === 'booking_menu' ? 'deleted_at IS NULL' : 'archived_at IS NULL';
  const target = await db.prepare(`SELECT hq_template_id,hq_template_version_id FROM ${table} WHERE id=? AND line_account_id=? AND ${active}`)
    .bind(row.target_id,accountId).first<{hq_template_id:string|null;hq_template_version_id:string|null}>();
  if (!target || target.hq_template_id !== templateId || target.hq_template_version_id !== row.applied_version_id) throw new HqTemplateError('VERSION_CONFLICT',409);
  return { targetId: row.target_id, appliedVersionId: row.applied_version_id, pendingVersionId: row.pending_version_id,
    dismissedVersionId: row.dismissed_version_id, appliedSnapshotHash: row.applied_snapshot_hash, hashVersion: row.hash_version, rowVersion: row.row_version };
}
