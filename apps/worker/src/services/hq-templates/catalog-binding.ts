import type { HqCatalogTemplateType } from '@line-crm/shared';
import type { HqTemplateStatement } from '@line-crm/db';
import { CATALOG_HASH_VERSION } from './catalog-record.js';
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

export interface CatalogBindingByTarget extends CatalogBinding {
  tenantId: string;
  templateId: string;
}

/** 店の画面から、店の物に結びついた本部のひな形を探す。統括は店のアカウントの所属で決める。 */
export async function findBindingForTarget(db: D1Database, accountId: string, kind: HqCatalogTemplateType, targetId: string): Promise<CatalogBindingByTarget | null> {
  const row = await db.prepare(`SELECT b.tenant_id,b.template_id,b.target_id,b.applied_version_id,b.pending_version_id,b.dismissed_version_id,b.applied_snapshot_hash,b.hash_version,b.row_version
    FROM hq_template_store_bindings b JOIN line_accounts a ON a.id=b.target_account_id AND a.tenant_id=b.tenant_id
    WHERE b.target_account_id=? AND b.kind=? AND b.target_id=? AND a.is_active=1 AND a.archived_at IS NULL`)
    .bind(accountId, kind, targetId).first<{tenant_id:string;template_id:string;target_id:string;applied_version_id:string;pending_version_id:string|null;dismissed_version_id:string|null;applied_snapshot_hash:string;hash_version:number;row_version:number}>();
  if (!row) return null;
  return { tenantId: row.tenant_id, templateId: row.template_id, targetId: row.target_id, appliedVersionId: row.applied_version_id,
    pendingVersionId: row.pending_version_id, dismissedVersionId: row.dismissed_version_id, appliedSnapshotHash: row.applied_snapshot_hash,
    hashVersion: row.hash_version, rowVersion: row.row_version };
}

export interface BindingRecordInput {
  tenantId: string;
  templateId: string;
  versionId: string;
  accountId: string;
  kind: HqCatalogTemplateType;
  targetId: string;
  snapshotHash: string;
}

/*
 * 統括が作成・上書き・別名を確定した配布と同じ batch で対応を記録する。名前だけで黙って対応を作らない。
 * 同じひな形を同じ店へもう一度配ったら、最後に確定した店の物へ付け替える。別のひな形が持っていた対応は、
 * その店の物が今回のひな形の中身になったので外す（店の物の出所の欄も今回のひな形に書き換わる）。
 */
export function bindingRecordStatements(input: BindingRecordInput): HqTemplateStatement[] {
  const now = new Date().toISOString();
  return [
    { sql: 'DELETE FROM hq_template_store_bindings WHERE tenant_id=? AND target_account_id=? AND kind=? AND target_id=? AND template_id<>?',
      bindings: [input.tenantId, input.accountId, input.kind, input.targetId, input.templateId] },
    { sql: `INSERT INTO hq_template_store_bindings(tenant_id,template_id,target_account_id,kind,target_id,applied_version_id,applied_snapshot_hash,hash_version,row_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(tenant_id,template_id,target_account_id) DO UPDATE SET kind=excluded.kind,target_id=excluded.target_id,
        applied_version_id=excluded.applied_version_id,pending_version_id=NULL,dismissed_version_id=NULL,
        applied_snapshot_hash=excluded.applied_snapshot_hash,hash_version=excluded.hash_version,
        row_version=hq_template_store_bindings.row_version+1,updated_at=excluded.updated_at`,
      bindings: [input.tenantId, input.templateId, input.accountId, input.kind, input.targetId, input.versionId, input.snapshotHash, CATALOG_HASH_VERSION, now, now] },
  ];
}

/** 読んだ時の対応から変わっていなければ通す。0 行の更新を成功と取り違えないため、書く前の guard にする。 */
export function bindingUnchangedCondition(binding: { tenantId: string; templateId: string; accountId: string; rowVersion: number }): { sql: string; bindings: Array<string | number> } {
  return { sql: 'EXISTS(SELECT 1 FROM hq_template_store_bindings WHERE tenant_id=? AND template_id=? AND target_account_id=? AND row_version=?)',
    bindings: [binding.tenantId, binding.templateId, binding.accountId, binding.rowVersion] };
}
