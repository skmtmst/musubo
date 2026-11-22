import { logger } from '@line-crm/shared/server';
import {
  listTenantsDueForPurge,
  markExpiredTrialRetentionAnchors,
  markTenantDataPurged,
  purgeTablesChildFirst,
  recordTenantDataPurgeAudit,
  recordAuditEvent,
  retentionCutoff,
  RETENTION_R2_KEY_COLUMNS,
  tenantScopeCondition,
  toJstString,
  type TenantRetention,
} from '@line-crm/db';

import { preparePurgedTenantBilling } from './tenant-purge-billing-prepare.js';
import { observeBillingHashKeyUnavailable } from './billing-external-review.js';
import { discoverRetainedPurgeAncestors, validateTombstonePolicies, type TombstonePolicy } from './tenant-retain-graph.js';
import { tombstoneRetainedParents } from './tenant-purge-generic.js';
import candidates from './tenant-retain-column-candidates.json';
import policies from './tenant-retain-column-policies.json';
import { claimTenantPurge, deferStaleBillingReceipts, tombstoneLineAccount, tombstoneFriend, tombstoneRestaurantStore, tombstoneRestaurantOrganization, tombstoneBroadcast, tombstoneBookingMenu, tombstonePassPlan, anonymizeMonthlyContract } from './tenant-purge-tombstones.js';


/**
 * 退会・無料体験切れから保存期限が過ぎた統括(テナント)の顧客データを消す（★36-2）。
 *
 * 6時間毎のcronから呼ばれる。1回で全部を消し切る前提は置かない。
 * 消した行数が上限に届いたらそこで止め、次の回が同じ統括をもう一度拾って
 * 続きから消す。途中で止まっても消し残りが「消していない状態」のまま
 * 正しく残るよう、子の表から先に消す。
 *
 * 誰をいつ消すかの判定と、分類表(purge/retain/global)は packages/db にある。
 * ここは「実際に消す」だけを持つ。
 */

/** 1回のcronで扱う統括の数。多くしても1回の行数上限で頭打ちになる。 */
const TENANTS_PER_RUN = 3;
/** 1回のcronで消す行数の上限。ここに届いたら途中でも止めて次の回に回す。 */
const ROWS_PER_RUN = 5000;
/** 1文で消す行数。D1の1文が長くなりすぎないようにする。 */
const ROWS_PER_STATEMENT = 200;
const EXPIRED_CHALLENGES_PER_RUN = 200;

// migration 760 の保護トリガーと一致させる。
const GUARDED_PURGE_TABLES = new Set([
  'action_score_rule_versions',
  'analytics_funnel_versions',
  'analytics_saved_analysis_versions',
  'auto_reply_versions',
  'automation_versions',
  'common_action_binding_migration_events',
  'common_action_versions',
  'conversion_points',
  'friend_add_routing_versions',
  'friend_add_rule_versions',
  'hq_template_distribution_results',
  'hq_template_distribution_runs',
  'hq_template_owned_r2_keys',
  'hq_templates',
  'mileage_redemption_attempts',
  'mileage_redemption_step_deliveries',
  'mileage_redemptions',
  'mileage_reward_versions',
  'reminder_version_steps',
  'reminder_versions',
  'scenario_versions',
]);

/** 表ごとのR2鍵の列。1つの表に複数列ある場合もまとめて扱う。 */
const R2_KEY_COLUMNS_BY_TABLE = RETENTION_R2_KEY_COLUMNS.reduce<Record<string, string[]>>(
  (acc, entry) => {
    (acc[entry.table] ??= []).push(entry.column);
    return acc;
  },
  {},
);

export interface TenantDataPurgeEnv {
  DB: D1Database;
  IMAGES?: R2Bucket;
  PURGED_PAYMENT_HMAC_SECRET?: string;
}

export interface TenantDataPurgeResult {
  /** 無料体験が切れていて保存起点を入れた統括の数。 */
  anchoredTrials: number;
  /** 今回消す対象として取り出した統括の数。 */
  tenants: number;
  /** 今回で全ての表を消し終えた統括の数。 */
  completed: number;
  deletedRows: number;
  deletedObjects: number;
  /** R2の削除に失敗した画像の数。行は消すので次回は拾えない。 */
  failedObjects: number;
  failedTenants: number;
}

// DBの生エラーには顧客情報が混ざり得るため、既知のトリガーだけ固定コードに変換する。
const DELETE_GUARD_CODES: ReadonlyArray<[string, string]> = [
  ['conversion point with events or usages cannot be deleted', 'referenced_conversion_point'],
  ['HQ_TEMPLATE_USE_LOGICAL_ARCHIVE', 'logical_archive_only'],
  ['HQ_TEMPLATE_R2_RECOVERY_LEDGER_IMMUTABLE', 'r2_recovery_ledger'],
  ['HQ_TEMPLATE_RESULT_RECOVERY_LEDGER_IMMUTABLE', 'result_recovery_ledger'],
  ['HQ_TEMPLATE_RUN_RECOVERY_LEDGER_IMMUTABLE', 'run_recovery_ledger'],
  ['published action score version cannot be deleted', 'published_action_score'],
  ['analytics_funnel_version_immutable', 'immutable_funnel_version'],
  ['analytics_saved_version_immutable', 'immutable_analysis_version'],
  ['published auto reply versions cannot be deleted', 'immutable_auto_reply'],
  ['published automation version cannot be deleted', 'published_automation'],
  ['common action binding migration history cannot be deleted', 'binding_migration_history'],
  ['published common action version cannot be deleted', 'published_common_action'],
  ['published friend-add routing versions cannot be deleted', 'immutable_friend_routing'],
  ['published friend-add rule versions cannot be deleted', 'immutable_friend_rule'],
  ['mileage redemption attempt history cannot be deleted', 'redemption_attempt_history'],
  ['mileage redemption step delivery history cannot be deleted', 'redemption_delivery_history'],
  ['mileage redemption history cannot be deleted', 'redemption_history'],
  ['published mileage reward version cannot be deleted', 'published_mileage_reward'],
  ['published reminder version steps are immutable', 'immutable_reminder_steps'],
  ['published reminder versions cannot be deleted', 'immutable_reminder_version'],
  ['published scenario versions cannot be deleted', 'immutable_scenario_version'],
];

function deleteFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return DELETE_GUARD_CODES.find(([guard]) => message.includes(guard))?.[1] ?? 'delete_failed';
}

export async function processTenantDataPurge(
  env: TenantDataPurgeEnv,
  options: { now?: string } = {},
): Promise<TenantDataPurgeResult> {
  const now = options.now ? toJstString(new Date(options.now)) : toJstString(new Date());

  // 所属不明のチャレンジも、期限後は次回の定時処理で回収する。
  // 作成時と同じUTC表記で比較し、未期限のログイン・登録は残す。
  try {
    const challengeCutoff = new Date(options.now ?? Date.now()).toISOString();
    await env.DB.prepare(`DELETE FROM staff_passkey_challenges WHERE rowid IN (
      SELECT rowid FROM staff_passkey_challenges WHERE expires_at <= ? ORDER BY expires_at, rowid LIMIT ?
    )`).bind(challengeCutoff, EXPIRED_CHALLENGES_PER_RUN).run();
  } catch {
    logger.error('tenant_data_purge.passkey_challenge_cleanup_failed');
  }

  // 無料体験の終了はStripeから通知が来ないので、ここで拾って起点を入れる。
  const anchoredTrials = await markExpiredTrialRetentionAnchors(env.DB, now);

  const tenants = await listTenantsDueForPurge(env.DB, { now, limit: TENANTS_PER_RUN });
  const result: TenantDataPurgeResult = {
    anchoredTrials,
    tenants: tenants.length,
    completed: 0,
    deletedRows: 0,
    deletedObjects: 0,
    failedObjects: 0,
    failedTenants: 0,
  };

  // 行数の上限は統括をまたいで共有する。1回のcronの仕事量を一定に保つ。
  let budget = ROWS_PER_RUN;
  for (const tenant of tenants) {
    if (budget <= 0) break;
    const progress: OneTenantResult = { deletedRows: 0, deletedObjects: 0, failedObjects: 0, finished: true };
    let purged: OneTenantResult;
    try { purged = await purgeOneTenant(env, tenant, now, budget, progress); }
    catch (error) {
      progress.finished = false;
      const missingKey = error instanceof Error && error.message === 'purge_payment_hash_key_missing';
      if (missingKey) {
        try { await observeBillingHashKeyUnavailable(env.DB,tenant.id,new Date(now).toISOString()); }
        catch { logger.error('tenant_purge.billing_key_alert_failed'); }
      }
      progress.failure = { table: missingKey ? 'billing_events' : 'unknown', failureCode: missingKey ? 'billing_key_unavailable' : 'unexpected_failure', r2DeletedBeforeFailure: 0 };
      try {
        await recordAuditEvent(env.DB, {
          category: 'business', action: 'tenant_data.purge_failed', tenantId: tenant.id,
          actorPrincipalId: 'system:retention', targetKind: 'tenant', targetId: tenant.id,
          result: 'failed', after: { ...progress.failure, deletedRows: progress.deletedRows, deletedObjects: progress.deletedObjects },
          retentionClass: 'security', createdAt: now,
        });
      } catch { logger.error('tenant_data_purge.audit_failed'); }
      logger.error('tenant_data_purge.tenant_failed');
      purged = progress;
    }
    budget -= purged.deletedRows;
    result.deletedRows += purged.deletedRows;
    result.deletedObjects += purged.deletedObjects;
    result.failedObjects += purged.failedObjects;
    if (purged.finished) result.completed += 1;
    if (purged.failure) result.failedTenants += 1;
  }

  return result;
}

interface OneTenantResult {
  deletedRows: number;
  deletedObjects: number;
  failedObjects: number;
  finished: boolean;
  failure?: { table: string; failureCode: string; r2DeletedBeforeFailure: number };
}

/**
 * 回答フォームだけの消す条件。表の分類どおり利用アカウント（form_accounts）
 * をたどるが、それだけでは統括をまたいで使い回している物まで消してしまう。
 * 別の統括の店に紐づいている物は、どちらの統括の削除でも消さない。
 * 所属の決まっていない店（tenant_id が空）の紐づけも「別」扱いにして消さない。
 */
function formsPurgeCondition(): string {
  return `${tenantScopeCondition('forms')} AND NOT EXISTS (
    SELECT 1 FROM form_accounts fa_other
    WHERE fa_other.form_id = forms.id
      AND fa_other.line_account_id IN (
        SELECT id FROM line_accounts WHERE tenant_id IS NULL OR tenant_id <> ?
      )
  )`;
}

async function purgeOneTenant(
  env: TenantDataPurgeEnv,
  tenant: TenantRetention,
  now: string,
  budget: number,
  out: OneTenantResult,
): Promise<OneTenantResult> {
  const startedAt = now;
  const byTable: Record<string, number> = {};
  let remaining = budget;

  // Keep retained foreign-key parents in place. The claim also prevents account resumption.
  if (!await claimTenantPurge(env.DB, tenant.id, now)) {
    out.finished = false;
    return out;
  }
  if (await deferStaleBillingReceipts(env.DB, tenant.id, new Date(now).toISOString()) === 100) {
    out.finished = false;
    return out;
  }
  await preparePurgedTenantBilling(env.DB,tenant.id,now,env.PURGED_PAYMENT_HMAC_SECRET);
  await env.DB.prepare(`UPDATE mcp_connections SET status='stopped',previous_key_hash=NULL,previous_key_expires_at=NULL,version=version+1
    WHERE organization_id=? AND (status<>'stopped' OR previous_key_hash IS NOT NULL)
      AND EXISTS (SELECT 1 FROM tenants WHERE id=? AND purge_started_at IS NOT NULL AND data_purged_at IS NULL)` ).bind(tenant.id,tenant.id).run();
  const retainedParents = await discoverRetainedPurgeAncestors(env.DB);
  validateTombstonePolicies(retainedParents, candidates, policies as Record<string, TombstonePolicy>);
  const retainedParentSet = new Set(retainedParents);
  const accounts = await env.DB.prepare('SELECT id FROM line_accounts WHERE tenant_id=? AND data_purged_at IS NULL LIMIT ?')
    .bind(tenant.id, remaining).all<{id:string}>();
  for (const account of accounts.results) {
    if (!await tombstoneLineAccount(env.DB, tenant.id, account.id, now)) throw new Error('account_tombstone_failed');
    remaining--;
    out.deletedRows++;
    byTable['line_accounts'] = (byTable['line_accounts'] ?? 0) + 1;
  }
  const contracts = await env.DB.prepare(`SELECT id FROM booking_monthly_contracts WHERE tenant_id=? AND
    (customer_id IS NOT NULL OR payment_method_id IS NOT NULL OR setup_session_id IS NOT NULL OR
     name<>'削除済み' OR state NOT IN ('expired','stopped') OR json_extract(request_json,'$.friendId') IS NOT NULL) LIMIT ?`)
    .bind(tenant.id, remaining).all<{id:string}>();
  for (const contract of contracts.results) {
    await anonymizeMonthlyContract(env.DB, tenant.id, contract.id, now);
    remaining--;
    out.deletedRows++;
    byTable['booking_monthly_contracts'] = (byTable['booking_monthly_contracts'] ?? 0) + 1;
  }
  const friends = await env.DB.prepare(`SELECT f.id,f.line_account_id FROM friends f JOIN line_accounts a ON a.id=f.line_account_id
    WHERE a.tenant_id=? AND f.data_purged_at IS NULL LIMIT ?`).bind(tenant.id,remaining).all<{id:string;line_account_id:string}>();
  for (const friend of friends.results) {
    if (!await tombstoneFriend(env.DB,friend.line_account_id,friend.id,now)) throw new Error('friend_tombstone_failed');
    remaining--;
    out.deletedRows++;
    byTable['friends'] = (byTable['friends'] ?? 0) + 1;
  }
  const plans = await env.DB.prepare(`SELECT p.id FROM booking_pass_plans p JOIN line_accounts a ON a.id=p.line_account_id
    WHERE a.tenant_id=? AND p.data_purged_at IS NULL LIMIT ?`).bind(tenant.id,remaining).all<{id:string}>();
  for (const plan of plans.results) {
    if (!await tombstonePassPlan(env.DB,tenant.id,plan.id,now)) throw new Error('plan_tombstone_failed');
    remaining--;
    out.deletedRows++;
    byTable['booking_pass_plans'] = (byTable['booking_pass_plans'] ?? 0) + 1;
  }

  // 子が先、親が後。親を先に消すと子が親をたどれなくなって消し残る。
  tables: for (const table of purgeTablesChildFirst()) {
    if (remaining <= 0) {
      out.finished = false;
      break;
    }
    if (table === 'line_accounts' || table === 'friends') continue;
    if (table === 'broadcasts' || table === 'menus' || table === 'rt_stores' || table === 'rt_organizations') {
      const condition = table === 'rt_stores'
        ? 'rt_stores.organization_id IN (SELECT id FROM rt_organizations WHERE tenant_id=?)'
        : tenantScopeCondition(table);
      const rows = await env.DB.prepare(`SELECT id FROM ${table} WHERE ${condition} AND data_purged_at IS NULL LIMIT ?`)
        .bind(tenant.id,remaining).all<{id:string}>();
      for (const row of rows.results) {
        const ok = table === 'broadcasts' ? await tombstoneBroadcast(env.DB,tenant.id,row.id,now)
          : table === 'menus' ? await tombstoneBookingMenu(env.DB,tenant.id,row.id,now)
          : table === 'rt_stores' ? await tombstoneRestaurantStore(env.DB,tenant.id,row.id,now)
          : await tombstoneRestaurantOrganization(env.DB,tenant.id,row.id,now);
        if (!ok) throw new Error('parent_tombstone_failed');
        remaining--;
        out.deletedRows++;
        byTable[table] = (byTable[table] ?? 0) + 1;
      }
      if (remaining <= 0) { out.finished = false; break; }
      continue;
    }
    // 回答フォームだけ統括またぎの使い回しを守る条件にする（? が1つ増える）。
    const sharedForm = table === 'forms';
    const scope = sharedForm ? formsPurgeCondition() : tenantScopeCondition(table);
    const tenantParams = sharedForm ? [tenant.id, tenant.id] : [tenant.id];
    const isRetainedParent = retainedParentSet.has(table);
    const condition = scope;
    const keyColumns = R2_KEY_COLUMNS_BY_TABLE[table] ?? [];

    for (;;) {
      const chunk = Math.min(ROWS_PER_STATEMENT, remaining);
      if (chunk <= 0) {
        out.finished = false;
        break;
      }

      // 行を消す前に、同じ行のR2鍵を読んで画像の実体を消す。
      // 読む順と消す順を rowid で揃えるので、両者は必ず同じ行を指す。
      let r2DeletedBeforeFailure = 0;
      if (keyColumns.length > 0) {
        const objectCondition = isRetainedParent
          ? `(${condition}) AND NOT EXISTS (SELECT 1 FROM tenant_purge_tombstone_progress p WHERE p.tenant_id=? AND p.table_name=? AND p.row_id=CAST(${table}.id AS TEXT))`
          : condition;
        const objectParams = isRetainedParent ? [...tenantParams, tenant.id, table] : tenantParams;
        const objects = await deleteR2Objects(env, table, objectCondition, keyColumns, objectParams, chunk);
        out.deletedObjects += objects.deleted;
        r2DeletedBeforeFailure = objects.deleted;
        out.failedObjects += objects.failed;
        if ((table === 'form_submission_files' || isRetainedParent) && objects.failed > 0) {
          // 次回も削除を再試行できるよう、R2 キーと親行への参照を保つ。
          out.finished = false;
          break tables;
        }
      }

      if (isRetainedParent) {
        let count: number;
        try {
          count = await tombstoneRetainedParents(env.DB, {
            tenantId: tenant.id, table, scope, scopeValues: tenantParams, limit: chunk,
            policy: (policies as Record<string, TombstonePolicy>)[table],
          });
        } catch (error) {
          out.finished = false;
          out.failure = { table, failureCode: deleteFailureCode(error), r2DeletedBeforeFailure };
          break tables;
        }
        byTable[table] = (byTable[table] ?? 0) + count;
        out.deletedRows += count;
        remaining -= count;
        if (count < chunk) break;
        continue;
      }

      let deleted: D1Result;
      try {
        const statement = env.DB.prepare(
          `DELETE FROM ${table}
            WHERE rowid IN (
              SELECT ${table}.rowid FROM ${table} WHERE ${condition} ORDER BY ${table}.rowid LIMIT ?
            )`,
        ).bind(...tenantParams, chunk);
        if (GUARDED_PURGE_TABLES.has(table)) {
          // 許可は対象統括・表の DELETE と同じ原子的 batch 内だけに存在する。
          const grant = env.DB.prepare(`INSERT INTO tenant_purge_guard (tenant_id, table_name)
            VALUES ((SELECT id FROM tenants WHERE id = ? AND data_purged_at IS NULL
              AND (plan_status = 'canceled' OR (plan_status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at < ?))
              AND (purge_requested_at IS NOT NULL OR (retention_anchor_at IS NOT NULL AND retention_anchor_at < ?))), ?)`)
            .bind(tenant.id, now, retentionCutoff(now), table);
          const revoke = env.DB.prepare('DELETE FROM tenant_purge_guard WHERE tenant_id = ? AND table_name = ?')
            .bind(tenant.id, table);
          const results = await env.DB.batch([grant, statement, revoke]);
          deleted = results[1];
        } else {
          deleted = await statement.run();
        }
      } catch (error) {
        out.finished = false;
        out.failure = { table, failureCode: deleteFailureCode(error), r2DeletedBeforeFailure };
        break tables;
      }
      const changes = deleted.meta?.changes ?? 0;
      if (changes > 0) {
        byTable[table] = (byTable[table] ?? 0) + changes;
        out.deletedRows += changes;
        remaining -= changes;
      }
      // 上限ちょうどで切れた場合も、次の回が同じ表をもう一度見る。
      if (changes < chunk) break;
    }
  }

  const finishedAt = out.finished ? now : null;
  try {
    await recordTenantDataPurgeAudit(
      env.DB,
      {
        id: crypto.randomUUID(),
        tenantId: tenant.id,
        reason: tenant.purge_requested_at ? 'immediate' : 'expired',
        retentionAnchorAt: tenant.retention_anchor_at,
        startedAt,
        finishedAt,
        deletedRows: out.deletedRows,
        deletedRowsByTable: byTable,
        deletedObjects: out.deletedObjects,
      },
      now,
    );
    if (out.failure) {
      await recordAuditEvent(env.DB, {
        category: 'business', action: 'tenant_data.purge_failed', tenantId: tenant.id,
        actorPrincipalId: 'system:retention', targetKind: 'tenant', targetId: tenant.id,
        result: 'failed', after: { ...out.failure, deletedRows: out.deletedRows, deletedObjects: out.deletedObjects },
        retentionClass: 'security', createdAt: now,
      });
    }
  } catch {
    // 監査に失敗した統括は未完了とし、削除件数を共通上限に反映する。
    out.finished = false;
    out.failure ??= { table: 'tenant_data_purge_audit', failureCode: 'audit_failed', r2DeletedBeforeFailure: 0 };
    logger.error('tenant_data_purge.audit_failed');
  }
  if (out.finished) await markTenantDataPurged(env.DB, tenant.id, now);

  return out;
}

async function deleteR2Objects(
  env: TenantDataPurgeEnv,
  table: string,
  condition: string,
  columns: string[],
  params: readonly string[],
  chunk: number,
): Promise<{ deleted: number; failed: number }> {
  const selected = await env.DB
    .prepare(
      `SELECT ${columns.map((column) => `${table}.${column}`).join(', ')}
         FROM ${table} WHERE ${condition} ORDER BY ${table}.rowid LIMIT ?`,
    )
    .bind(...params, chunk)
    .all<Record<string, string | null>>();

  const keys = (selected.results ?? [])
    .flatMap((row) => columns.map((column) => row[column]))
    .filter((key): key is string => typeof key === 'string' && key.length > 0);
  if (keys.length === 0) return { deleted: 0, failed: 0 };
  if (!env.IMAGES) return { deleted: 0, failed: keys.length };

  try {
    await env.IMAGES.delete(keys);
    return { deleted: keys.length, failed: 0 };
  } catch (error) {
    // 画像が消せなくても行の削除は進める。顧客データを残し続ける方が重い。
    logger.error("tenant_data_purge.delete_r2_objects_failed");
    return { deleted: 0, failed: keys.length };
  }
}
