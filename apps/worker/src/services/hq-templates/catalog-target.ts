import type { HqCatalogTemplateDefinition, HqCatalogTemplateType } from '@line-crm/shared';
import type { HqTemplateStatement } from '@line-crm/db';
import { bookingMenuData, catalogReferences, catalogSnapshot, menuVersionSnapshotSql, rewardDraftValues, rewardRecordSource, rewardVersionColumns, rewardVersionValues } from './catalog.js';
import { CATALOG_HASH_VERSION, catalogRecord, catalogRecordFields, catalogRecordHash, type CatalogRecord } from './catalog-record.js';
import { HqTemplateError } from './tag.js';

/** 対応表が指す店の物の、今の中身と状態。 */
export interface CatalogTargetState {
  kind: HqCatalogTemplateType;
  accountId: string;
  targetId: string;
  name: string;
  record: CatalogRecord;
  hash: string;
  originTemplateId: string | null;
  originVersionId: string | null;
  /** 店が変えた印。予約メニューは店の編集で立つ印、景品は公開中の上に作った下書き。 */
  customized: boolean;
  /** 公開中の版がある景品。版ごとに在庫・引換コード・払い戻しの計算が結びつく。 */
  published: boolean;
  /** 手渡しの景品。本部の配布では書き換えない。 */
  protectedTarget: boolean;
  rewardKind: string | null;
  draftVersionId: string | null;
  draftRevision: number | null;
  publishedVersionId: string | null;
}

type Row = Record<string, string | number | null>;

export async function readCatalogTarget(db: D1Database, kind: HqCatalogTemplateType, accountId: string, targetId: string): Promise<CatalogTargetState | null> {
  if (kind === 'booking_menu') {
    const row = await db.prepare('SELECT * FROM menus WHERE id=? AND line_account_id=? AND deleted_at IS NULL').bind(targetId, accountId).first<Row>();
    if (!row) return null;
    const record = catalogRecord(kind, row);
    return { kind, accountId, targetId, name: String(row.name), record, hash: await catalogRecordHash(kind, record),
      originTemplateId: (row.hq_template_id as string | null) ?? null, originVersionId: (row.hq_template_version_id as string | null) ?? null,
      customized: Number(row.hq_customized) === 1, published: false, protectedTarget: false, rewardKind: null,
      draftVersionId: null, draftRevision: null, publishedVersionId: null };
  }
  const row = await db.prepare(`SELECT r.*,EXISTS(SELECT 1 FROM mileage_handgift_rewards h WHERE h.reward_id=r.id) AS handgift
    FROM mileage_rewards r WHERE r.id=? AND r.line_account_id=? AND r.archived_at IS NULL AND r.status<>'archived'`).bind(targetId, accountId).first<Row>();
  if (!row) return null;
  const draftId = (row.current_draft_version_id as string | null) ?? null, publishedId = (row.current_published_version_id as string | null) ?? null;
  // 中身は「店が今さわっている版」で比べる。公開しただけでは中身が変わらないので、店が変えたとは扱わない。
  const effectiveId = draftId ?? publishedId;
  const version = effectiveId ? await db.prepare('SELECT * FROM mileage_reward_versions WHERE id=? AND reward_id=?').bind(effectiveId, targetId).first<Row>() : null;
  if (!version) return null;
  const record = catalogRecord(kind, { ...version, name: row.name, description: row.description, image_url: row.image_url, reward_kind: row.reward_kind });
  return { kind, accountId, targetId, name: String(row.name), record, hash: await catalogRecordHash(kind, record),
    originTemplateId: (row.hq_template_id as string | null) ?? null, originVersionId: (row.hq_template_version_id as string | null) ?? null,
    customized: publishedId !== null && draftId !== null, published: publishedId !== null, protectedTarget: Number(row.handgift) === 1,
    rewardKind: String(row.reward_kind), draftVersionId: draftId, draftRevision: draftId ? Number(version.revision) : null, publishedVersionId: publishedId };
}

/** 読んだ時の中身・出所・版から変わっていなければ真になる条件。書く前の guard に使う。 */
export function targetUnchangedCondition(target: CatalogTargetState): { sql: string; bindings: Array<string | number | null> } {
  if (target.kind === 'booking_menu') {
    const fields = catalogRecordFields('booking_menu');
    return { sql: `EXISTS(SELECT 1 FROM menus WHERE id=? AND line_account_id=? AND deleted_at IS NULL AND hq_customized=? AND hq_template_id IS ? AND hq_template_version_id IS ? AND ${fields.map(field => `${field} IS ?`).join(' AND ')})`,
      bindings: [target.targetId, target.accountId, target.customized ? 1 : 0, target.originTemplateId, target.originVersionId, ...fields.map(field => target.record[field] as string | number | null)] };
  }
  const versionId = target.draftVersionId ?? target.publishedVersionId;
  return { sql: `EXISTS(SELECT 1 FROM mileage_rewards r JOIN mileage_reward_versions v ON v.id=? AND v.reward_id=r.id
      WHERE r.id=? AND r.line_account_id=? AND r.archived_at IS NULL AND r.status<>'archived' AND r.current_draft_version_id IS ? AND r.current_published_version_id IS ?
      AND r.hq_template_id IS ? AND r.hq_template_version_id IS ? AND r.name IS ? AND r.description IS ? AND r.image_url IS ? AND r.reward_kind IS ?
      AND (v.status='published' OR v.revision=?))`,
    bindings: [versionId, target.targetId, target.accountId, target.draftVersionId, target.publishedVersionId, target.originTemplateId, target.originVersionId,
      target.name, target.record.description as string | null, target.record.image_url as string | null, target.rewardKind, target.draftRevision ?? 0] };
}

export interface CatalogVersionInput {
  id: string;
  version: number;
  definition: HqCatalogTemplateDefinition;
}

export interface CatalogApplyPlan {
  statements: HqTemplateStatement[];
  hash: string;
  /** 公開中の景品へ取り込んだ時は下書きに入る。お客さまに出すには店が公開する。 */
  publishRequired: boolean;
}

/*
 * 本部の版を、対応表が指す店の物へ当てる書き込み文を作る。
 * 店の状態（受付中か・並び順・担当・お支払いの接続・在庫・引換コード）は書かない。
 * 店の物の名前を書き換えるのは、本部が名前を変えた版だけ。別名で配った店の名前を本部の名前へ戻さない。
 * 公開中の景品の版は書き換えない（払い戻しは交換した版の必要マイルで計算するため）。
 */
export async function catalogApplyPlan(db: D1Database, input: { tenantId: string; templateId: string; target: CatalogTargetState; applied: CatalogVersionInput; candidate: CatalogVersionInput }): Promise<CatalogApplyPlan> {
  const { target, candidate } = input, kind = target.kind;
  if (target.protectedTarget) throw new HqTemplateError('HANDGIFT_PROTECTED', 409);
  const snapshot = await catalogSnapshot(db, target.accountId, kind);
  if (kind === 'booking_menu' && (JSON.parse(snapshot) as { style?: string }).style === 'ec') throw new HqTemplateError('BOOKING_NOT_USED', 422);
  const refs = catalogReferences(candidate.definition, snapshot, kind);
  const name = candidate.definition.settings.name !== input.applied.definition.settings.name ? candidate.definition.settings.name : target.name;
  const settings = { ...candidate.definition.settings, name } as unknown as Record<string, unknown>;
  const statements: HqTemplateStatement[] = [];
  if (kind === 'booking_menu') {
    // 並び順は店が決める物なので、配り直しでは書かない。
    const { sort_order: _storeOrder, ...data } = bookingMenuData(settings, refs), keys = Object.keys(data);
    // 出所の版を同じ文で変えるので、店の編集の印は立たない。念のため次の文でも印を戻す。
    statements.push({ sql: `UPDATE menus SET ${keys.map(key => `${key}=?`).join(',')},hq_template_version_id=?,hq_customized=0,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND line_account_id=? AND deleted_at IS NULL`,
      bindings: [...keys.map(key => data[key]), candidate.id, target.targetId, target.accountId] },
    { sql: 'UPDATE menus SET hq_customized=0 WHERE id=? AND line_account_id=?', bindings: [target.targetId, target.accountId] },
    { sql: menuVersionSnapshotSql, bindings: [crypto.randomUUID(), target.targetId, target.accountId] });
    return { statements, hash: await catalogRecordHash(kind, catalogRecord(kind, data)), publishRequired: false };
  }
  const values = rewardDraftValues(settings, refs);
  if (values.rewardKind !== target.rewardKind) throw new HqTemplateError('REWARD_KIND_CHANGED', 409);
  // 在庫の数は店の物。列の並びから外して、店の値をそのまま残す。
  const columns = rewardVersionColumns.filter(column => column !== 'stock_limit');
  const all = rewardVersionValues(values), kept = columns.map(column => all[rewardVersionColumns.indexOf(column)]);
  let draftId = target.draftVersionId;
  if (!draftId) {
    if (!target.publishedVersionId) throw new HqTemplateError('VERSION_CONFLICT', 409);
    draftId = crypto.randomUUID();
    statements.push({ sql: `INSERT INTO mileage_reward_versions(id,reward_id,version_number,status,stock_limit,${columns.join(',')})
        SELECT ?,reward_id,(SELECT MAX(version_number)+1 FROM mileage_reward_versions WHERE reward_id=?),'draft',stock_limit,${columns.map(() => '?').join(',')}
        FROM mileage_reward_versions WHERE id=? AND reward_id=? AND status='published'`,
      bindings: [draftId, target.targetId, ...kept, target.publishedVersionId, target.targetId] },
    { sql: `UPDATE mileage_rewards SET current_draft_version_id=? WHERE id=? AND line_account_id=? AND current_draft_version_id IS NULL`, bindings: [draftId, target.targetId, target.accountId] });
  } else {
    statements.push({ sql: `UPDATE mileage_reward_versions SET ${columns.map(column => `${column}=?`).join(',')},revision=revision+1 WHERE id=? AND reward_id=? AND status='draft'`,
      bindings: [...kept, draftId, target.targetId] });
  }
  statements.push({ sql: `UPDATE mileage_rewards SET name=?,description=?,image_url=?,hq_template_version_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND line_account_id=? AND current_draft_version_id=?`,
    bindings: [name, values.description, values.imageUrl, candidate.id, target.targetId, target.accountId, draftId] });
  return { statements, hash: await catalogRecordHash(kind, catalogRecord(kind, rewardRecordSource(name, values))), publishRequired: target.published };
}

/** 当てた版を対応表へ記録する。読んだ時の行の版と一致する時だけ書く（guard は呼び出し側が先に置く）。 */
export function bindingAppliedStatement(input: { tenantId: string; templateId: string; accountId: string; rowVersion: number; versionId: string; hash: string }): HqTemplateStatement {
  return { sql: `UPDATE hq_template_store_bindings SET applied_version_id=?,applied_snapshot_hash=?,hash_version=?,pending_version_id=NULL,row_version=row_version+1,updated_at=?
      WHERE tenant_id=? AND template_id=? AND target_account_id=? AND row_version=?`,
    bindings: [input.versionId, input.hash, CATALOG_HASH_VERSION, new Date().toISOString(), input.tenantId, input.templateId, input.accountId, input.rowVersion] };
}
