import { logger } from '@line-crm/shared/server';
import type { AccountStyle, StarterCatalogApplyResult, StarterCatalogSelection } from '@line-crm/shared';
import type { HqTemplateAuthority } from './hq-templates/contract.js';
import { preflightDistribution, distributeTemplate, distributionResult, type DistributionSelection } from './hq-templates/distribution.js';
import { catalogSelection } from './style-starter-catalog-definition.js';
import { catalogResourceSnapshot, catalogResourceKind, catalogResourceCommit } from './style-starter-catalog-resources.js';
import { starter } from './style-starter-set.js';
import { HqTemplateError } from './hq-templates/tag.js';
import { StyleError } from './style-setup-core.js';

export type StarterCatalogRuntime = { bucket?: R2Bucket; publicBaseUrl?: string; manual?: boolean; copyTemplateIds?: string[]; copyFromRuns?: Record<string,string|null>; onlyTemplateIds?:string[]; reportError?: (error: Error) => unknown };
type Item = { template_id: string; template_version_id: string; state: 'pending' | 'running' | 'succeeded' | 'blocked' | 'failed'; distribution_run_id: string | null; error_code: string | null; lease_token: string | null };

/** 公開HTTPから任意のカタログIDや権限を渡せない、承認済みの組専用の実行入口。 */
export async function applyCatalogStarter(db: D1Database, tenant: string, account: string, actor: string, style: AccountStyle, runtime: StarterCatalogRuntime = {}): Promise<StarterCatalogApplyResult> {
  const set = await starter(db, tenant, style);
  const result: StarterCatalogApplyResult = { mode: 'catalog', items: [] };
  if (set.definition.mode !== 'catalog' || (!set.autoInsert && !runtime.manual)) return result;
  const selected = await db.prepare('SELECT version,selection_mode,style,answers_json FROM account_styles WHERE line_account_id=?').bind(account).first<{ version:number; selection_mode: string; style: string; answers_json:string }>();
  if (!selected || (!runtime.manual && (selected.selection_mode !== 'configured' || selected.style !== style))) return result;
  const approval = await db.prepare(`SELECT u.id,u.role FROM style_starter_sets s JOIN staff_members u ON u.id=s.updated_by AND u.tenant_id=s.tenant_id
    JOIN line_accounts a ON a.tenant_id=s.tenant_id WHERE s.id=? AND s.tenant_id=? AND s.version=? AND s.archived_at IS NULL
    AND a.id=? AND a.is_active=1 AND a.archived_at IS NULL AND u.is_active=1 AND u.role IN ('owner','admin')
    AND u.account_scope!='accounts' AND u.access_level!='read_only' AND COALESCE(u.role_bundle,'')!='view_only'
    AND EXISTS(SELECT 1 FROM staff_members i WHERE i.id=? AND i.tenant_id=s.tenant_id AND i.is_active=1 AND i.access_level!='read_only' AND COALESCE(i.role_bundle,'')!='view_only' AND (i.account_scope!='accounts' OR EXISTS(SELECT 1 FROM staff_account_scopes x WHERE x.staff_id=i.id AND x.line_account_id=a.id)))`)
    .bind(set.id, tenant, set.version, account, actor).first<{ id: string; role: 'owner' | 'admin' }>();
  if (!approval) throw new StyleError('catalog_approval_unavailable', 403);
  // 実在する承認者の現在の権限を使う。店の担当者を統括へ読み替えない。
  const authority: HqTemplateAuthority = { tenantId: tenant, actorId: approval.id, role: approval.role, readOnly: false, accountScoped: false };
  const selections = [...(set.definition.selections ?? [])].filter(row=>!runtime.onlyTemplateIds||runtime.onlyTemplateIds.includes(row.templateId)).sort((a, b) => {
    const order = { tag: 0, template: 1, coupon: 1, form: 2, auto_reply: 3, rich_menu: 4 };
    return (order[a.kind as keyof typeof order] ?? 9) - (order[b.kind as keyof typeof order] ?? 9);
  });
  for (const selection of selections) {
    try {
    const newCopy = runtime.manual && runtime.copyTemplateIds?.includes(selection.templateId);
    const answers = JSON.parse(selected.answers_json) as Record<string,{mode:string;value?:unknown}>;
    const key = {coupon:'coupons',rich_menu:'image',template:'content'}[selection.kind as 'coupon'|'rich_menu'|'template'];
    const answer = key ? answers[key] : undefined;
    if (answer && (answer.mode !== 'configured' || answer.value === false)) {
      result.items.push({...selection,state:'blocked',reason:'answer_later'}); continue;
    }
    try { await catalogSelection(db, tenant, selection); } catch(error) {
      if(!(error instanceof StyleError))throw error;
      result.items.push({...selection,state:'blocked',reason:error.code});continue;
    }
    const now = new Date().toISOString();
    await db.prepare(`INSERT OR IGNORE INTO style_starter_catalog_items
      (line_account_id,template_id,template_version_id,tenant_id,set_id,set_version,style,kind,initiated_by,approved_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(account, selection.templateId, selection.versionId, tenant, set.id, set.version, style, selection.kind, actor, approval.id, now, now).run();
    if(newCopy) await db.prepare(`UPDATE style_starter_catalog_items SET template_version_id=?,state='pending',distribution_run_id=NULL,error_code=NULL
      WHERE line_account_id=? AND template_id=? AND tenant_id=? AND state IN ('succeeded','blocked') AND distribution_run_id IS ?`)
      .bind(selection.versionId,account,selection.templateId,tenant,runtime.copyFromRuns?.[selection.templateId]??null).run();
    await db.prepare(`UPDATE style_starter_catalog_items SET template_version_id=?,state='pending',distribution_run_id=NULL,error_code=NULL
      WHERE line_account_id=? AND template_id=? AND tenant_id=? AND template_version_id!=? AND state IN ('pending','failed')
      AND NOT EXISTS(SELECT 1 FROM hq_template_distribution_results r WHERE r.tenant_id=? AND r.target_account_id=? AND r.template_id=? AND r.status IN ('succeeded','pending','staged'))
      AND NOT EXISTS(SELECT 1 FROM hq_template_owned_r2_keys k WHERE k.tenant_id=? AND k.target_account_id=? AND k.run_id IN(SELECT r.run_id FROM hq_template_distribution_results r WHERE r.template_id=? AND r.tenant_id=k.tenant_id AND r.target_account_id=k.target_account_id) AND k.state IN ('staged','cleanup_pending'))`)
      .bind(selection.versionId,account,selection.templateId,tenant,selection.versionId,tenant,account,selection.templateId,tenant,account,selection.templateId).run();
    const item = await db.prepare('SELECT * FROM style_starter_catalog_items WHERE line_account_id=? AND template_id=? AND tenant_id=?')
      .bind(account, selection.templateId, tenant).first<Item>();
    if (!item) throw new StyleError('catalog_application_unavailable', 409);
    if (item.template_version_id !== selection.versionId) {
      result.items.push({ ...selection, state: 'blocked', reason: 'new_version_available' }); continue;
    }
    if (item.state === 'succeeded' || item.state === 'blocked') {
      result.items.push({ ...selection, state: item.state, reason: item.error_code }); continue;
    }
    const lease = crypto.randomUUID();
    const claimed = await db.prepare(`UPDATE style_starter_catalog_items SET state='running',lease_token=?,lease_until=?,updated_at=?,set_id=?,set_version=?,approved_by=?,initiated_by=?
      WHERE line_account_id=? AND template_id=? AND tenant_id=? AND template_version_id=?
      AND (state IN ('pending','failed') OR (state='running' AND lease_until<=?))`)
      .bind(lease, new Date(Date.now() + 120_000).toISOString(), now, set.id,set.version,approval.id,actor, account, selection.templateId, tenant, selection.versionId, now).run();
    if (!claimed.meta.changes) { result.items.push({ ...selection, state: 'running', reason: null }); continue; }
    const scoped = fencedDatabase(db, { tenant, account, setId: set.id, setVersion: set.version, approver: approval.id, templateId: selection.templateId, lease, actor,profileVersion:selected.version,style,manual:Boolean(runtime.manual) });
    try {
      await scoped.batch([scoped.prepare(`INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result,after_json)
        SELECT ?,?,?, 'business',id,role,'style_starter.catalog_started','style_starter_set',?,'success',? FROM staff_members WHERE id=? AND tenant_id=?`)
        .bind(lease,tenant,account,set.id,JSON.stringify({initiatedBy:actor,approvedBy:approval.id,automatic:!runtime.manual,setVersion:set.version,templateId:selection.templateId,versionId:selection.versionId,previousRunId:item.distribution_run_id,copyFromRunId:runtime.copyFromRuns?.[selection.templateId]??null}),actor,tenant)]);
      let runId = item.distribution_run_id;
      if(runId) {
        const previous = await db.prepare(`SELECT p.status,p.created_by,p.expires_at,EXISTS(SELECT 1 FROM hq_template_distribution_results r WHERE r.run_id=p.idempotency_fingerprint AND r.target_account_id=p.target_account_id) has_result
          FROM hq_template_preflights p WHERE p.idempotency_fingerprint=? AND p.tenant_id=? AND p.target_account_id=?`).bind(runId,tenant,account).first<{status:string;created_by:string;expires_at:string;has_result:number}>();
        if(previous && !previous.has_result && (previous.status==='expired' || previous.expires_at<=new Date().toISOString() || previous.created_by!==approval.id)) runId=null;
      }
      if (!runId) {
        const preview = await preflightDistribution(scoped, authority, selection.templateId, [account], runtime.bucket, undefined, { versionId: selection.versionId });
        for (const row of preview.stores[0].items) {
          if (!row.targetId || !row.duplicate) continue;
          const root = row.itemKind === selection.kind || (selection.kind==='coupon' && row.itemKind==='template');
          if(newCopy && root){if(!(row.allowedModes as readonly string[]).includes('alias'))throw new StyleError('catalog_local_changes',409);continue;}
          if(!(row.allowedModes as readonly string[]).includes('overwrite'))throw new StyleError('catalog_local_changes',409);
          const held = await db.prepare('SELECT source_snapshot FROM style_starter_catalog_resources WHERE tenant_id=? AND line_account_id=? AND resource_kind=? AND target_id=?')
            .bind(tenant, account, catalogResourceKind(row.itemKind), row.targetId).first<{ source_snapshot: string }>();
          if (!held || held.source_snapshot !== await catalogResourceSnapshot(db, account, row.itemKind, row.targetId))
            throw new StyleError('catalog_local_changes', 409);
          // 根の同名リソースは再配布で上書きせず、店へ確認を残す。
          if (root) throw new StyleError('catalog_local_changes', 409);
        }
        runId = preview.preflightId;
        await scoped.batch([
          ...preview.stores[0].items.map(row=>{
            const root=row.itemKind===selection.kind || (selection.kind==='coupon' && row.itemKind==='template');
            const mode=row.duplicate?(newCopy&&root?'alias':'overwrite'):row.allowedModes[0];
            return scoped.prepare(`UPDATE hq_template_preflight_resolutions SET resolution_mode=?,alias_name=CASE WHEN ?='alias' THEN 'pending' ELSE NULL END WHERE tenant_id=? AND target_account_id=? AND idempotency_fingerprint=? AND source_id=?`)
              .bind(mode,mode,tenant,account,runId,row.sourceId);
          }),
          scoped.prepare('UPDATE style_starter_catalog_items SET distribution_run_id=? WHERE line_account_id=? AND template_id=? AND lease_token=?').bind(runId,account,selection.templateId,lease),
        ]);
      }
      const resolutions = (await db.prepare('SELECT source_id,item_kind,resolution_mode,target_id FROM hq_template_preflight_resolutions WHERE tenant_id=? AND target_account_id=? AND template_id=? AND idempotency_fingerprint=?')
        .bind(tenant, account, selection.templateId, runId).all<{ source_id: string; item_kind: string; resolution_mode: 'create' | 'overwrite' | 'alias'; target_id:string|null }>()).results;
      const choices: DistributionSelection[] = resolutions.map(row => ({ accountId:account,sourceId:row.source_id,mode:row.resolution_mode }));
      const existing = await db.prepare('SELECT status FROM hq_template_distribution_results WHERE run_id=? AND tenant_id=? AND target_account_id=?').bind(runId, tenant, account).first<{ status: string }>();
      const applied = existing?.status === 'succeeded'
        ? await distributionResult(scoped, authority, selection.templateId, runId, runtime.bucket)
        : await distributeTemplate(scoped, authority, selection.templateId, runId, choices, runtime.bucket, runtime.publicBaseUrl,(target,resolutions)=>catalogResourceCommit(scoped,tenant,target,resolutions));
      const state = applied.stores.find(row => row.accountId === account)?.status;
      if (state !== 'succeeded') throw new StyleError(state === 'pending' || state === 'staged' ? 'catalog_in_progress' : 'catalog_distribution_failed', 409);
      const succeededAt = new Date().toISOString();
      await scoped.batch([scoped.prepare(`UPDATE style_starter_catalog_items SET state='succeeded',error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE line_account_id=? AND template_id=? AND lease_token=?`).bind(succeededAt, account, selection.templateId, lease),
        scoped.prepare(`UPDATE account_styles SET first_starter_at=COALESCE(first_starter_at,?) WHERE line_account_id=? AND changes()=1`).bind(succeededAt, account)]);
      result.items.push({ ...selection, state: 'succeeded', reason: null });
    } catch (error) {
      const reason = error instanceof StyleError || error instanceof HqTemplateError ? error.code : 'catalog_distribution_failed';
      const state = reason === 'catalog_local_changes' ? 'blocked' : 'failed';
      await db.prepare(`UPDATE style_starter_catalog_items SET state=?,error_code=?,lease_token=NULL,lease_until=NULL,updated_at=?
        WHERE line_account_id=? AND template_id=? AND lease_token=?`).bind(state, reason, new Date().toISOString(), account, selection.templateId, lease).run();
      if(!(error instanceof StyleError) && !(error instanceof HqTemplateError && error.status<500)) {
        logger.error('style_starter_catalog_failed');
        try{await runtime.reportError?.(error instanceof Error?error:new Error('catalog_application_failed'))}catch{logger.error('style_starter_catalog_report_failed')}
      }
      result.items.push({ ...selection, state, reason });
      const failed = await db.prepare(`SELECT r.status,EXISTS(SELECT 1 FROM hq_template_owned_r2_keys k WHERE k.run_id=r.run_id AND k.target_account_id=r.target_account_id AND k.state IN ('staged','cleanup_pending')) cleanup
        FROM hq_template_distribution_results r WHERE r.run_id=(SELECT distribution_run_id FROM style_starter_catalog_items WHERE line_account_id=? AND template_id=?) AND r.target_account_id=? AND r.tenant_id=?`)
        .bind(account, selection.templateId, account, tenant).first<{status:string;cleanup:number}>();
      if ((!failed && error instanceof HqTemplateError && ['SELECTION_REQUIRED','SELECTION_CHANGED','VERSION_CONFLICT','NOT_FOUND'].includes(error.code)) || (failed && !failed.cleanup && ['failed','version_conflict','compensated','unsupported'].includes(failed.status)))
        await db.prepare("UPDATE style_starter_catalog_items SET distribution_run_id=NULL WHERE line_account_id=? AND template_id=? AND tenant_id=? AND state='failed' AND lease_token IS NULL")
          .bind(account,selection.templateId,tenant).run();
    }
    } catch(error) {
      const expected=error instanceof StyleError || (error instanceof HqTemplateError && error.status<500);
      if(!expected){
        logger.error('style_starter_catalog_failed');
        try{await runtime.reportError?.(error instanceof Error?error:new Error('catalog_application_failed'))}catch{logger.error('style_starter_catalog_report_failed')}
      }
      if(!result.items.some(row=>row.templateId===selection.templateId))result.items.push({...selection,state:'failed',reason:error instanceof StyleError||error instanceof HqTemplateError?error.code:'catalog_application_failed'});
    }
  }
  return result;
}

function fencedDatabase(db: D1Database, binding: { tenant: string; account: string; setId: string; setVersion: number; approver: string; templateId: string; lease: string; actor:string;profileVersion:number;style:AccountStyle;manual:boolean }): D1Database {
  return new Proxy(db, { get(target, key) {
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      const guard = db.prepare(`SELECT json(CASE WHEN EXISTS(
        SELECT 1 FROM style_starter_catalog_items i JOIN style_starter_sets s ON s.id=i.set_id AND s.tenant_id=i.tenant_id
        JOIN staff_members u ON u.id=s.updated_by AND u.tenant_id=s.tenant_id JOIN line_accounts a ON a.id=i.line_account_id AND a.tenant_id=i.tenant_id
        WHERE i.tenant_id=? AND i.line_account_id=? AND s.id=? AND s.version=? AND u.id=? AND i.template_id=? AND i.lease_token=?
        AND s.archived_at IS NULL AND a.is_active=1 AND a.archived_at IS NULL AND u.is_active=1
        AND u.role IN ('owner','admin') AND u.account_scope!='accounts' AND u.access_level!='read_only' AND COALESCE(u.role_bundle,'')!='view_only'
        AND EXISTS(SELECT 1 FROM staff_members actor WHERE actor.id=? AND actor.tenant_id=i.tenant_id AND actor.is_active=1 AND actor.access_level!='read_only' AND COALESCE(actor.role_bundle,'')!='view_only'
          AND (actor.account_scope!='accounts' OR EXISTS(SELECT 1 FROM staff_account_scopes x WHERE x.staff_id=actor.id AND x.line_account_id=a.id)))
        AND EXISTS(SELECT 1 FROM account_styles p WHERE p.line_account_id=a.id AND p.version=? AND (?=1 OR (p.style=? AND p.selection_mode='configured')))
      ) THEN '{}' ELSE 'STARTER_APPLICATION_CONFLICT' END)`)
        .bind(binding.tenant, binding.account, binding.setId, binding.setVersion, binding.approver, binding.templateId, binding.lease,binding.actor,binding.profileVersion,Number(binding.manual),binding.style);
      try{return (await db.batch([guard, ...statements])).slice(1)}
      catch(error){if(String(error).includes('malformed JSON'))throw new StyleError('catalog_conflict',409);throw error}
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
