import { hqRoleForStaff } from '@line-crm/shared';
import type { HqTemplateStatement } from '@line-crm/db';
import { isCatalogType } from './catalog.js';
import { sha256Hex } from './catalog-record.js';
import { requireHqTemplateAuthority, type HqTemplateAuthority } from './contract.js';
import { guardStatement, loadCatalogVersions, planRedistribution, type RedistributionPlan } from './redistribution.js';
import { HqTemplateError } from './tag.js';

/** 1店ずつの試行の上限。使い切ったら失敗で閉じ、ジョブを終わらせる。 */
export const REDISTRIBUTION_MAX_ATTEMPTS = 5;
/** 1店を処理する間だけ持つ札の長さ。切れたら別の実行者が取り直せる。 */
export const REDISTRIBUTION_LEASE_MS = 120_000;
/** 書けなかった店を次に試すまでの間。 */
export const REDISTRIBUTION_RETRY_DELAY_MS = 60_000;
const MAX_PREFLIGHTS = 10;
const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export type RedistributionItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'conflict';
interface JobRow { id: string; tenant_id: string; template_id: string; template_version_id: string; request_key: string; request_hash: string; status: string; created_by: string; notification_id: string | null; created_at: string; updated_at: string; finished_at: string | null }
export interface RedistributionItemRow { tenant_id: string; job_id: string; target_account_id: string; preflight_id: string; status: RedistributionItemStatus; attempt_count: number; error_code: string | null; finished_at: string | null }

async function batch(db: D1Database, statements: readonly HqTemplateStatement[]) {
  return db.batch(statements.map(statement => db.prepare(statement.sql).bind(...statement.bindings)));
}

export function redistributionRequestKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new HqTemplateError('INVALID_REQUEST_ID');
  return value;
}

function readPreflightIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PREFLIGHTS || value.some(id => typeof id !== 'string' || !id) || new Set(value).size !== value.length) throw new HqTemplateError('INVALID_PREFLIGHT');
  return [...value as string[]].sort();
}

function jobSummary(job: JobRow, items: RedistributionItemRow[], skippedAccountIds: string[] = []) {
  const outcome = (item: RedistributionItemRow) => item.status === 'succeeded' ? (item.error_code === 'store_review_pending' ? 'notified' : item.error_code === 'unchanged' ? 'unchanged' : 'applied') : item.status;
  return {
    jobId: job.id, status: job.status, templateVersionId: job.template_version_id, createdAt: job.created_at, finishedAt: job.finished_at,
    notificationId: job.notification_id, skippedAccountIds,
    counts: { total: items.length, finished: items.filter(item => ['succeeded', 'failed', 'conflict'].includes(item.status)).length,
      applied: items.filter(item => outcome(item) === 'applied').length, notified: items.filter(item => outcome(item) === 'notified').length,
      unchanged: items.filter(item => outcome(item) === 'unchanged').length, failed: items.filter(item => item.status === 'failed' || item.status === 'conflict').length },
    stores: items.map(item => ({ accountId: item.target_account_id, status: item.status, outcome: outcome(item), code: item.status === 'succeeded' ? null : item.error_code, attempts: item.attempt_count, finishedAt: item.finished_at })),
  };
}

async function readJob(db: D1Database, tenantId: string, jobId: string) {
  const job = await db.prepare('SELECT * FROM hq_template_distribution_jobs WHERE id=? AND tenant_id=?').bind(jobId, tenantId).first<JobRow>();
  if (!job) return null;
  const items = (await db.prepare('SELECT tenant_id,job_id,target_account_id,preflight_id,status,attempt_count,error_code,finished_at FROM hq_template_distribution_job_items WHERE tenant_id=? AND job_id=? ORDER BY target_account_id')
    .bind(tenantId, jobId).all<RedistributionItemRow>()).results;
  return { job, items };
}

export async function redistributionJobResult(db: D1Database, authority: HqTemplateAuthority, templateId: string, jobId: string) {
  const found = await readJob(db, authority.tenantId, jobId);
  if (!found || found.job.template_id !== templateId) throw new HqTemplateError('NOT_FOUND', 404);
  return jobSummary(found.job, found.items);
}

/*
 * 配る前の確かめ（30分）から、対応表に記録がある店だけの配り直しジョブを作る。
 * 確かめの期限はここで確かめ、ジョブを長く待たせても期限を延ばさない。店に書く直前には、
 * 対応表・店の物・権限・ひな形の版をもう一度確かめる。対応表が無い店は含めず、今の配布の流れで選んでもらう。
 */
export async function createRedistributionJob(db: D1Database, authority: HqTemplateAuthority, templateId: string, input: { preflightIds: unknown; requestKey: unknown }) {
  const requestKey = redistributionRequestKey(input.requestKey), preflightIds = readPreflightIds(input.preflightIds);
  const template = await db.prepare('SELECT id,current_version_id,archived_at,catalog_type FROM hq_templates WHERE id=? AND tenant_id=?').bind(templateId, authority.tenantId)
    .first<{ id: string; current_version_id: string | null; archived_at: string | null; catalog_type: string | null }>();
  if (!template || template.archived_at) throw new HqTemplateError('NOT_FOUND', 404);
  if (!template.catalog_type || !isCatalogType(template.catalog_type)) throw new HqTemplateError('UNSUPPORTED', 422);
  const requestHash = await sha256Hex(JSON.stringify({ templateId, preflightIds }));
  const replay = async () => {
    const existing = await db.prepare('SELECT * FROM hq_template_distribution_jobs WHERE tenant_id=? AND request_key=?').bind(authority.tenantId, requestKey).first<JobRow>();
    if (!existing) return null;
    if (existing.request_hash !== requestHash || existing.template_id !== templateId) throw new HqTemplateError('IDEMPOTENCY_CONFLICT', 409);
    const found = await readJob(db, authority.tenantId, existing.id);
    return { created: false, job: jobSummary(found!.job, found!.items) };
  };
  const previous = await replay();
  if (previous) return previous;
  const preflights = (await db.prepare(`SELECT id,target_account_id,template_version_id,idempotency_fingerprint,status,created_by,expires_at FROM hq_template_preflights
      WHERE tenant_id=? AND template_id=? AND idempotency_fingerprint IN (${preflightIds.map(() => '?').join(',')}) ORDER BY target_account_id`)
    .bind(authority.tenantId, templateId, ...preflightIds).all<{ id: string; target_account_id: string; template_version_id: string; idempotency_fingerprint: string; status: string; created_by: string | null; expires_at: string | null }>()).results;
  if (preflightIds.some(id => !preflights.some(p => p.idempotency_fingerprint === id)) || preflights.some(p => p.created_by !== authority.actorId)) throw new HqTemplateError('NOT_FOUND', 404);
  // 名前で選ぶ配布に使った確かめは、期限より先に使用済みとして断る。
  const runs = await db.prepare(`SELECT 1 AS used FROM hq_template_distribution_runs WHERE tenant_id=? AND idempotency_fingerprint IN (${preflightIds.map(() => '?').join(',')}) LIMIT 1`)
    .bind(authority.tenantId, ...preflightIds).first();
  if (runs || preflights.some(p => p.status === 'consumed')) throw new HqTemplateError('PREFLIGHT_CONSUMED', 409);
  const now = new Date().toISOString();
  if (preflights.some(p => p.status !== 'ready' || !p.expires_at || p.expires_at <= now)) throw new HqTemplateError('PREFLIGHT_EXPIRED', 409);
  if (preflights.some(p => p.template_version_id !== template.current_version_id)) throw new HqTemplateError('VERSION_CONFLICT', 409);
  const accounts = preflights.map(p => p.target_account_id);
  if (new Set(accounts).size !== accounts.length) throw new HqTemplateError('INVALID_ACCOUNTS');
  const bound = new Set((await db.prepare(`SELECT b.target_account_id FROM hq_template_store_bindings b JOIN line_accounts a ON a.id=b.target_account_id AND a.tenant_id=b.tenant_id
      WHERE b.tenant_id=? AND b.template_id=? AND a.is_active=1 AND a.archived_at IS NULL AND b.target_account_id IN (${accounts.map(() => '?').join(',')})`)
    .bind(authority.tenantId, templateId, ...accounts).all<{ target_account_id: string }>()).results.map(row => row.target_account_id));
  const targets = preflights.filter(p => bound.has(p.target_account_id)), skippedAccountIds = accounts.filter(id => !bound.has(id));
  if (!targets.length) throw new HqTemplateError('NO_BOUND_STORES', 409);
  const jobId = `hqj_${await sha256Hex(JSON.stringify([authority.tenantId, requestKey]))}`;
  const statements: HqTemplateStatement[] = [
    guardStatement({ sql: 'EXISTS(SELECT 1 FROM hq_templates WHERE id=? AND tenant_id=? AND archived_at IS NULL AND current_version_id=?)', bindings: [templateId, authority.tenantId, template.current_version_id] }),
    guardStatement({ sql: `NOT EXISTS(SELECT 1 FROM hq_template_distribution_runs WHERE tenant_id=? AND idempotency_fingerprint IN (${preflightIds.map(() => '?').join(',')}))`, bindings: [authority.tenantId, ...preflightIds] }),
    ...targets.map(p => guardStatement({ sql: `EXISTS(SELECT 1 FROM hq_template_preflights WHERE id=? AND tenant_id=? AND status='ready' AND expires_at>${SQL_NOW})
      AND NOT EXISTS(SELECT 1 FROM hq_template_distribution_job_items WHERE tenant_id=? AND preflight_id=?)
      AND EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL)`, bindings: [p.id, authority.tenantId, authority.tenantId, p.id, p.target_account_id, authority.tenantId] })),
    { sql: `INSERT INTO hq_template_distribution_jobs(id,tenant_id,template_id,template_version_id,request_key,request_hash,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?,?)`,
      bindings: [jobId, authority.tenantId, templateId, template.current_version_id!, requestKey, requestHash, authority.actorId, now, now] },
    ...targets.map(p => ({ sql: `INSERT INTO hq_template_distribution_job_items(tenant_id,job_id,target_account_id,preflight_id,status,attempt_count,created_at,updated_at) VALUES (?,?,?,?,'pending',0,?,?)`,
      bindings: [authority.tenantId, jobId, p.target_account_id, p.id, now, now] })),
    { sql: `INSERT INTO audit_events(id,tenant_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result,after_json) VALUES (?,?,'business',?,?,'hq_template.redistribution_requested','hq_template',?,'success',?)`,
      bindings: [crypto.randomUUID(), authority.tenantId, authority.actorId, authority.role, templateId, JSON.stringify({ jobId, stores: targets.length })] },
  ];
  try { await batch(db, statements); }
  catch {
    // 同じ依頼キーの同時要求は、先に入った方の結果を返す。
    const raced = await replay();
    if (raced) return raced;
    throw new HqTemplateError('VERSION_CONFLICT', 409);
  }
  const found = await readJob(db, authority.tenantId, jobId);
  return { created: true, job: jobSummary(found!.job, found!.items, skippedAccountIds) };
}

/** 書く直前に、ジョブを作った人がまだ統括の編集権限を持つか、担当者の表から確かめ直す。 */
async function jobActorStillAuthorized(db: D1Database, job: JobRow): Promise<{ role: string } | null> {
  const member = await db.prepare('SELECT id,role,access_level,is_active,tenant_id,account_scope,role_bundle,assigned_line_account_id FROM staff_members WHERE id=?').bind(job.created_by)
    .first<{ id: string; role: string; access_level: string | null; is_active: number; tenant_id: string | null; account_scope: string | null; role_bundle: string | null; assigned_line_account_id: string | null }>();
  if (!member || member.is_active !== 1 || member.tenant_id !== job.tenant_id) return null;
  const decision = requireHqTemplateAuthority({ tenantId: job.tenant_id, actorId: member.id, role: member.role, hqRole: hqRoleForStaff(member),
    readOnly: member.access_level === 'read_only', accountScoped: member.account_scope === 'accounts' });
  return decision.kind === 'AUTHORIZED' && !decision.authority.readOnly ? { role: member.role } : null;
}

const actorCondition = (job: JobRow) => ({ sql: `EXISTS(SELECT 1 FROM staff_members WHERE id=? AND tenant_id=? AND is_active=1 AND COALESCE(access_level,'full')<>'read_only' AND COALESCE(account_scope,'all')<>'accounts'
    AND (role IN ('owner','admin') OR (role='staff' AND role_bundle='hq_operator' AND assigned_line_account_id IS NULL AND account_scope='all')))`, bindings: [job.created_by, job.tenant_id] });
const leaseCondition = (item: RedistributionItemRow, token: string) => ({ sql: `EXISTS(SELECT 1 FROM hq_template_distribution_job_items WHERE tenant_id=? AND job_id=? AND target_account_id=? AND status='running' AND lease_token=? AND lease_expires_at>${SQL_NOW})`,
  bindings: [item.tenant_id, item.job_id, item.target_account_id, token] });

function finishStatement(item: RedistributionItemRow, token: string, status: RedistributionItemStatus, code: string | null): HqTemplateStatement {
  return { sql: `UPDATE hq_template_distribution_job_items SET status=?,error_code=?,lease_token=NULL,lease_expires_at=NULL,finished_at=${SQL_NOW},updated_at=${SQL_NOW}
      WHERE tenant_id=? AND job_id=? AND target_account_id=? AND lease_token=?`, bindings: [status, code, item.tenant_id, item.job_id, item.target_account_id, token] };
}

function itemResult(plan: RedistributionPlan): { status: RedistributionItemStatus; code: string | null } {
  if (plan.outcome === 'apply') return { status: 'succeeded', code: null };
  if (plan.outcome === 'pending' || plan.outcome === 'unchanged') return { status: 'succeeded', code: plan.code };
  if (plan.outcome === 'missing') return { status: 'failed', code: plan.code };
  if (plan.outcome === 'unbound') return { status: 'failed', code: 'binding_missing' };
  return { status: plan.code === 'booking_not_used' ? 'failed' : 'conflict', code: plan.code };
}

async function claimItem(db: D1Database, item: RedistributionItemRow, leaseMs: number, maxAttempts: number): Promise<string | null> {
  const token = crypto.randomUUID(), now = new Date();
  const claimed = await db.prepare(`UPDATE hq_template_distribution_job_items SET status='running',lease_token=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=?
      WHERE tenant_id=? AND job_id=? AND target_account_id=? AND status IN ('pending','running') AND (lease_expires_at IS NULL OR lease_expires_at<=${SQL_NOW}) AND attempt_count<?`)
    .bind(token, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), item.tenant_id, item.job_id, item.target_account_id, maxAttempts).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) return null;
  await db.prepare(`UPDATE hq_template_distribution_jobs SET status='running',updated_at=? WHERE id=? AND tenant_id=? AND status='pending'`).bind(now.toISOString(), item.job_id, item.tenant_id).run();
  return token;
}

/** 札を持ったまま書けなかった店は、少し待ってから取り直せる状態へ戻す。札を失った・切れていたら何もしない（もう他の実行者が取れる）。 */
async function releaseForRetry(db: D1Database, item: RedistributionItemRow, token: string, delayMs: number) {
  await db.prepare(`UPDATE hq_template_distribution_job_items SET status='pending',lease_token=NULL,lease_expires_at=?,updated_at=? WHERE tenant_id=? AND job_id=? AND target_account_id=? AND lease_token=? AND lease_expires_at>${SQL_NOW}`)
    .bind(new Date(Date.now() + delayMs).toISOString(), new Date().toISOString(), item.tenant_id, item.job_id, item.target_account_id, token).run();
}

/*
 * 1店分を札つきで処理する。店への書き込み・対応表・店ごとの結果・操作の記録を同じ batch で確定する。
 * batch の先頭で札がまだ自分の物で期限内かを確かめ、期限切れの実行者は何も書けない。
 */
export async function runRedistributionItem(db: D1Database, item: RedistributionItemRow, token: string, options: { retryDelayMs?: number } = {}): Promise<RedistributionItemStatus | 'retry'> {
  const close = async (status: RedistributionItemStatus, code: string | null, statements: HqTemplateStatement[] = []) => {
    await batch(db, [guardStatement(leaseCondition(item, token)), ...statements, finishStatement(item, token, status, code)]);
    return status;
  };
  try {
    const job = await db.prepare('SELECT * FROM hq_template_distribution_jobs WHERE id=? AND tenant_id=?').bind(item.job_id, item.tenant_id).first<JobRow>();
    if (!job) return await close('failed', 'job_missing');
    const template = await db.prepare('SELECT current_version_id,archived_at,catalog_type FROM hq_templates WHERE id=? AND tenant_id=?').bind(job.template_id, job.tenant_id)
      .first<{ current_version_id: string | null; archived_at: string | null; catalog_type: string | null }>();
    if (!template || template.archived_at || !template.catalog_type || !isCatalogType(template.catalog_type)) return await close('failed', 'template_unavailable');
    // 受け付けた後にひな形が保存し直されたら、古い版を配り続けない。
    if (template.current_version_id !== job.template_version_id) return await close('failed', 'template_version_changed');
    const actor = await jobActorStillAuthorized(db, job);
    if (!actor) return await close('failed', 'actor_unauthorized');
    const account = await db.prepare('SELECT id FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL').bind(item.target_account_id, job.tenant_id).first();
    if (!account) return await close('failed', 'store_unavailable');
    const kind = template.catalog_type;
    const candidate = (await loadCatalogVersions(db, job.tenant_id, job.template_id, kind, [job.template_version_id])).get(job.template_version_id);
    if (!candidate) return await close('failed', 'template_unavailable');
    // 配る前の確かめで解決した店のタグ・処理・シナリオ。実行時の解決がこれと違えば書かない。
    const expectedReferences = (await db.prepare('SELECT source_id,target_id,expected_revision FROM hq_template_preflight_resolutions WHERE preflight_id=? AND tenant_id=? AND source_id<>?')
      .bind(item.preflight_id, job.tenant_id, kind).all<{ source_id: string; target_id: string | null; expected_revision: string | null }>()).results
      .map(row => ({ sourceId: row.source_id, targetId: row.target_id, expectedRevision: row.expected_revision }));
    const plan = await planRedistribution(db, { tenantId: job.tenant_id, templateId: job.template_id, kind, accountId: item.target_account_id, candidate, expectedReferences });
    const result = itemResult(plan);
    const statements: HqTemplateStatement[] = [
      guardStatement(actorCondition(job)),
      guardStatement({ sql: 'EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL)', bindings: [item.target_account_id, job.tenant_id] }),
      guardStatement({ sql: 'EXISTS(SELECT 1 FROM hq_templates WHERE id=? AND tenant_id=? AND archived_at IS NULL AND current_version_id=?)', bindings: [job.template_id, job.tenant_id, job.template_version_id] }),
      ...plan.statements,
      { sql: `INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result,after_json) VALUES (?,?,?,'business',?,?,'hq_template.redistributed','hq_template',?,?,?)`,
        bindings: [crypto.randomUUID(), job.tenant_id, item.target_account_id, job.created_by, actor.role, job.template_id, result.status === 'succeeded' ? 'success' : 'failed',
          JSON.stringify({ jobId: job.id, outcome: plan.outcome, code: result.code, notices: plan.notices })] },
    ];
    return await close(result.status, result.code, statements);
  } catch {
    // 途中で読めなかった・書けなかった店は、札を返して後で取り直す。上限は次の掃除で閉じる。
    await releaseForRetry(db, item, token, options.retryDelayMs ?? REDISTRIBUTION_RETRY_DELAY_MS);
    return 'retry';
  }
}

/*
 * 全部の店が終わったジョブを確定する。結果の確定と、統括の操作の記録への完了の知らせを同じ batch で作る。
 * 知らせはジョブごとに一意のキーで作るので、確定を何度試しても1件だけになる。外部へは送らない。
 */
export async function finalizeRedistributionJobs(db: D1Database, limit = 20): Promise<number> {
  const done = (await db.prepare(`SELECT j.id,j.tenant_id FROM hq_template_distribution_jobs j WHERE j.status IN ('pending','running')
      AND NOT EXISTS(SELECT 1 FROM hq_template_distribution_job_items i WHERE i.tenant_id=j.tenant_id AND i.job_id=j.id AND i.status IN ('pending','running'))
      ORDER BY j.created_at LIMIT ?`).bind(limit).all<{ id: string; tenant_id: string }>()).results;
  for (const job of done) {
    const notificationId = `hqjn_${await sha256Hex(JSON.stringify([job.tenant_id, job.id]))}`;
    // 店ごとの結果は ? で渡した同じジョブだけを数える。表の別名に頼らない。
    const succeeded = `(SELECT COUNT(*) FROM hq_template_distribution_job_items WHERE tenant_id=? AND job_id=? AND status='succeeded')`;
    const total = `(SELECT COUNT(*) FROM hq_template_distribution_job_items WHERE tenant_id=? AND job_id=?)`;
    await batch(db, [
      { sql: `UPDATE hq_template_distribution_jobs SET status=CASE WHEN ${succeeded}=${total} THEN 'completed' WHEN ${succeeded}>0 THEN 'partial' ELSE 'failed' END,
          notification_id=?,finished_at=${SQL_NOW},updated_at=${SQL_NOW}
          WHERE id=? AND tenant_id=? AND status IN ('pending','running')
          AND NOT EXISTS(SELECT 1 FROM hq_template_distribution_job_items WHERE tenant_id=? AND job_id=? AND status IN ('pending','running'))`,
        bindings: [job.tenant_id, job.id, job.tenant_id, job.id, job.tenant_id, job.id, notificationId, job.id, job.tenant_id, job.tenant_id, job.id] },
      { sql: `INSERT OR IGNORE INTO audit_events(id,source_kind,source_id,tenant_id,category,actor_principal_id,action,target_kind,target_id,result,after_json)
          SELECT ?,'hq_template_distribution_job',?,tenant_id,'business',created_by,'hq_template.redistribution_finished','hq_template',template_id,
            CASE status WHEN 'failed' THEN 'failed' ELSE 'success' END,
            json_object('jobId',id,'status',status,'succeeded',${succeeded},'total',${total})
          FROM hq_template_distribution_jobs WHERE id=? AND tenant_id=? AND notification_id=? AND status IN ('completed','partial','failed')`,
        bindings: [notificationId, JSON.stringify([job.tenant_id, job.id]), job.tenant_id, job.id, job.tenant_id, job.id, job.id, job.tenant_id, notificationId] },
    ]);
  }
  return done.length;
}

/** 定期処理の入口。試行を使い切った店を閉じ、取れる店を札つきで進め、終わったジョブを確定する。 */
export async function processHqDistributionJobs(db: D1Database, options: { limit?: number; leaseMs?: number; maxAttempts?: number; retryDelayMs?: number } = {}) {
  const maxAttempts = options.maxAttempts ?? REDISTRIBUTION_MAX_ATTEMPTS;
  await db.prepare(`UPDATE hq_template_distribution_job_items SET status='failed',error_code='attempts_exhausted',lease_token=NULL,lease_expires_at=NULL,finished_at=${SQL_NOW},updated_at=${SQL_NOW}
      WHERE status IN ('pending','running') AND attempt_count>=? AND (lease_expires_at IS NULL OR lease_expires_at<=${SQL_NOW})`).bind(maxAttempts).run();
  const due = (await db.prepare(`SELECT i.tenant_id,i.job_id,i.target_account_id,i.preflight_id,i.status,i.attempt_count,i.error_code,i.finished_at
      FROM hq_template_distribution_job_items i JOIN hq_template_distribution_jobs j ON j.id=i.job_id AND j.tenant_id=i.tenant_id
      WHERE i.status IN ('pending','running') AND (i.lease_expires_at IS NULL OR i.lease_expires_at<=${SQL_NOW}) AND i.attempt_count<? AND j.status IN ('pending','running')
      ORDER BY j.created_at,i.created_at,i.target_account_id LIMIT ?`).bind(maxAttempts, options.limit ?? 30).all<RedistributionItemRow>()).results;
  const results: Array<RedistributionItemStatus | 'retry' | 'skipped'> = [];
  for (const item of due) {
    const token = await claimItem(db, item, options.leaseMs ?? REDISTRIBUTION_LEASE_MS, maxAttempts);
    results.push(token ? await runRedistributionItem(db, item, token, { retryDelayMs: options.retryDelayMs }) : 'skipped');
  }
  const finalized = await finalizeRedistributionJobs(db);
  return { processed: results.filter(result => result !== 'skipped').length, results, finalized };
}
