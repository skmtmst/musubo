#!/usr/bin/env tsx

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assertStagingCronSource } from '../deploy/staging-cron-policy.mjs';

import {
  analyzeScenarioDeliveryTimestamps,
  buildFriendScenariosDueForDeliveryQuery,
  normalizeScenarioDeliveryTimestamp,
  SCENARIO_DELIVERY_BATCH_LIMIT,
  type ScenarioDeliveryTimestampRow,
} from '../../packages/db/src/scenario-delivery-timestamps.js';

const CONFIG_PATH = 'apps/worker/wrangler.staging.toml';
const SESSION_TTL_MINUTES = 15;
const D1_MAX_ATTEMPTS = 3;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
// D1 rejects LIKE/GLOB patterns longer than 50 bytes. Keep the run UUID out.
const SYNTHETIC_FRIEND_PATTERN = 'verify-b88-line-%';

type D1Envelope<T> = {
  success: boolean;
  result?: Array<{ success: boolean; results?: T[] }>;
  errors?: Array<{ code?: number; message?: string }>;
};

type VerificationTarget = {
  accountId: string;
  databaseId: string;
  workerUrl: string;
};

type QueryD1 = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

type ApiEnvelope<T> = { success: boolean; data: T };

type DueEnrollment = { id: string };

const INSERT_BATCH_SIZE = 10;

function d1FailureCategory(body: D1Envelope<unknown> | null): string {
  const message = body?.errors?.map((error) => error.message ?? '').join(' ').toLowerCase() ?? '';
  if (message.includes('foreign key constraint')) return 'foreign-key-constraint';
  if (message.includes('no such table')) return 'missing-table';
  if (message.includes('no such column')) return 'missing-column';
  if (message.includes('too many sql variables')) return 'too-many-bindings';
  if (message.includes('syntax error')) return 'syntax';
  if (message.includes('locked') || message.includes('busy')) return 'database-busy';
  return 'unknown';
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error('Unexpected staging schema identifier');
  }
  return `"${identifier}"`;
}

export async function findSyntheticFriendReferences(
  query: QueryD1,
  lineUserIdPattern: string,
): Promise<string[]> {
  const tables = await query<{ name: string }>(
    `SELECT name FROM sqlite_schema
      WHERE type = 'table'
        AND sql LIKE '%REFERENCES friends%'
      ORDER BY name`,
  );
  const references: string[] = [];
  for (const row of tables) {
    const table = quoteIdentifier(row.name);
    const foreignKeys = await query<{ table: string; from: string }>(
      `PRAGMA foreign_key_list(${table})`,
    );
    for (const foreignKey of foreignKeys.filter((key) => key.table === 'friends')) {
      const column = quoteIdentifier(foreignKey.from);
      const rows = await query<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${table}
          WHERE ${column} IN (
            SELECT id FROM friends WHERE line_user_id LIKE ?
          )`,
        [lineUserIdPattern],
      );
      const count = Number(rows[0]?.count ?? 0);
      if (count > 0) references.push(`${row.name}.${foreignKey.from}=${count}`);
    }
  }
  return references;
}

export async function countVerificationLeftovers(
  query: QueryD1,
  values: {
    sessionHash: string;
    scenarioId: string;
    lineUserIdPattern: string;
    notificationRuleId: string | null;
  },
): Promise<{ total: number; counts: Record<string, number> }> {
  const checks: Array<{ name: string; sql: string; value: string }> = [
    { name: 'admin_sessions', sql: 'SELECT COUNT(*) AS count FROM admin_sessions WHERE token_hash = ?', value: values.sessionHash },
    { name: 'scenarios', sql: 'SELECT COUNT(*) AS count FROM scenarios WHERE id = ?', value: values.scenarioId },
    { name: 'friends', sql: 'SELECT COUNT(*) AS count FROM friends WHERE line_user_id LIKE ?', value: values.lineUserIdPattern },
    { name: 'friend_scenarios', sql: 'SELECT COUNT(*) AS count FROM friend_scenarios WHERE scenario_id = ?', value: values.scenarioId },
  ];
  if (values.notificationRuleId) {
    checks.push({
      name: 'notification_rules',
      sql: 'SELECT COUNT(*) AS count FROM notification_rules WHERE id = ?',
      value: values.notificationRuleId,
    });
  }
  const counts: Record<string, number> = {};
  for (const check of checks) {
    try {
      const rows = await query<{ count: number }>(check.sql, [check.value]);
      counts[check.name] = Number(rows[0]?.count ?? 0);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown count failure';
      throw new Error(`${check.name}: ${reason}`);
    }
  }
  return {
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts,
  };
}

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function configValue(config: string, key: string): string {
  const match = config.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
  if (!match?.[1]) throw new Error(`Missing ${key} in staging config`);
  return match[1];
}

export function readVerificationTarget(config: string): VerificationTarget {
  if (configValue(config, 'name') !== 'nen-line-stg') {
    throw new Error('Only the staging Worker is allowed');
  }
  if (configValue(config, 'database_name') !== 'nen-line-stg') {
    throw new Error('Only the staging D1 database is allowed');
  }
  assertStagingCronSource(config);

  const workerUrl = configValue(config, 'WORKER_PUBLIC_URL');
  const worker = new URL(workerUrl);
  // 検証対象は staging Worker の workers.dev か、staging 専用カスタムドメインのみ。
  // 本番の api.musubo.jp / nen-line.*.workers.dev はここで拒否する。
  const allowedStagingHost =
    /^nen-line-stg\.[a-z0-9-]+\.workers\.dev$/.test(worker.hostname) ||
    worker.hostname === 'stg-api.musubo.jp';
  if (worker.protocol !== 'https:' || !allowedStagingHost) {
    throw new Error('Unexpected staging Worker URL');
  }
  return {
    accountId: configValue(config, 'account_id'),
    databaseId: configValue(config, 'database_id'),
    workerUrl: worker.origin,
  };
}

export function createD1Query(target: VerificationTarget, apiToken: string): QueryD1 {
  return async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    let lastStatus = 0;
    let lastBody: D1Envelope<T> | null = null;
    for (let attempt = 1; attempt <= D1_MAX_ATTEMPTS; attempt++) {
      let response: Response | null = null;
      try {
        response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId)}/d1/database/${encodeURIComponent(target.databaseId)}/query`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ sql, params }),
          },
        );
      } catch {
        // Network details are intentionally not forwarded to logs.
      }
      let body: D1Envelope<T> | null = null;
      if (response) {
        lastStatus = response.status;
        try {
          body = await response.json() as D1Envelope<T>;
        } catch {
          // A provider error page is not forwarded to logs. It is safe to retry
          // because every verification mutation is idempotent.
        }
      }
      if (body) lastBody = body;
      const result = body?.result?.[0];
      if (response?.ok && body?.success && result?.success) {
        return result.results ?? [];
      }
      if (attempt < D1_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
      }
    }
    const providerCodes = (lastBody?.errors ?? [])
      .map((error) => error.code)
      .filter((code): code is number => typeof code === 'number')
      .join(',') || 'none';
    throw new Error(
      `Staging D1 query failed after ${D1_MAX_ATTEMPTS} attempts`
      + ` (http=${lastStatus || 'none'}, provider=${providerCodes}, category=${d1FailureCategory(lastBody)})`,
    );
  };
}

async function notificationRequest<T>(
  target: VerificationTarget,
  sessionToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  if (!path.startsWith('/api/notifications/rules')) {
    throw new Error('The staging check may only call the notification-rules API');
  }
  const response = await fetch(`${target.workerUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer lh_session:${sessionToken}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !body.success) throw new Error('Staging notification API check failed');
  return body.data;
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function insertSyntheticDeliveryRows(
  query: QueryD1,
  runId: string,
  lineAccountId: string,
  now: string,
  dueAt: string,
): Promise<void> {
  await query(
    `INSERT OR IGNORE INTO scenarios
       (id, name, description, trigger_type, is_active, delivery_mode, line_account_id, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', 1, 'relative', ?, ?, ?)`,
    [`verify-b88-scenario-${runId}`, 'staging verification', 'synthetic; no message steps', lineAccountId, now, now],
  );
  const suffixes = Array.from({ length: 41 }, (_, index) => String(index).padStart(2, '0'));
  for (const batch of batches(suffixes, INSERT_BATCH_SIZE)) {
    await query(
      `INSERT OR IGNORE INTO friends
         (id, line_user_id, display_name, is_following, line_account_id, created_at, updated_at)
       VALUES ${batch.map(() => "(?, ?, 'staging verification', 1, ?, ?, ?)").join(', ')}`,
      batch.flatMap((suffix) => [
        `verify-b88-friend-${runId}-${suffix}`,
        `verify-b88-line-${runId}-${suffix}`,
        lineAccountId,
        now,
        now,
      ]),
    );
  }
  for (const batch of batches(suffixes, INSERT_BATCH_SIZE)) {
    await query(
      `INSERT OR IGNORE INTO friend_scenarios
         (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
       VALUES ${batch.map(() => "(?, ?, ?, -1, 'active', ?, ?, ?)").join(', ')}`,
      batch.flatMap((suffix) => [
        `verify-b88-enrollment-${runId}-${suffix}`,
        `verify-b88-friend-${runId}-${suffix}`,
        `verify-b88-scenario-${runId}`,
        now,
        dueAt,
        now,
      ]),
    );
  }
}

async function main(): Promise<void> {
  if (process.env.VERIFY_ENVIRONMENT !== 'staging') {
    throw new Error('VERIFY_ENVIRONMENT must be staging');
  }
  const target = readVerificationTarget(readFileSync(CONFIG_PATH, 'utf8'));
  const query = createD1Query(
    target,
    required('CLOUDFLARE_API_TOKEN', process.env.CLOUDFLARE_API_TOKEN),
  );
  const runId = randomUUID();
  const sessionToken = randomBytes(32).toString('base64url');
  const sessionHash = createHash('sha256').update(sessionToken).digest('hex');
  const now = normalizeScenarioDeliveryTimestamp(new Date().toISOString());
  const dueAt = normalizeScenarioDeliveryTimestamp(new Date(Date.now() - 60_000).toISOString());
  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000).toISOString();
  if (!now || !dueAt) throw new Error('Could not normalize verification timestamps');

  let notificationRuleId: string | null = null;
  let apiDeletedRule = false;
  const cleanupFailures: string[] = [];
  let report: Record<string, unknown> | null = null;
  let verificationError: unknown = null;

  try {
    // A previously interrupted run can leave only synthetic records. The
    // concurrency key prevents another verification from running in parallel.
    // Expired admin sessions are already unusable and are normal housekeeping.
    await query(
      `DELETE FROM notification_rules
       WHERE name = 'staging verification'
         AND event_type = 'staging_verification'
         AND conditions = '{"synthetic":true}'
         AND is_active = 0`,
    );
    await query(
      `DELETE FROM friend_scenarios WHERE scenario_id LIKE 'verify-b88-scenario-%'`,
    );
    await query(
      `DELETE FROM scenarios WHERE id LIKE 'verify-b88-scenario-%'`,
    );
    await query(
      'DELETE FROM friends WHERE line_user_id LIKE ?',
      [SYNTHETIC_FRIEND_PATTERN],
    );
    await query('DELETE FROM admin_sessions WHERE expires_at <= ?', [new Date().toISOString()]);

    const timestampRows = await query<ScenarioDeliveryTimestampRow>(
      `SELECT id, next_delivery_at FROM friend_scenarios
       WHERE next_delivery_at IS NOT NULL ORDER BY id`,
    );
    const timestampReport = analyzeScenarioDeliveryTimestamps(timestampRows);
    const nonCanonicalTimestamps = timestampReport.normalizable + timestampReport.invalid;
    if (nonCanonicalTimestamps !== 0) {
      throw new Error(`Expected 0 non-canonical timestamps; found ${nonCanonicalTimestamps}`);
    }

    const targets = await query<{ staff_id: string; line_account_id: string }>(
      `SELECT sm.id AS staff_id, la.id AS line_account_id
         FROM staff_members sm
         JOIN line_accounts la
           ON COALESCE(sm.tenant_id, ?) = COALESCE(la.tenant_id, ?)
        WHERE sm.is_active = 1
          AND sm.role IN ('owner', 'admin')
          AND la.is_active = 1
          AND (
            COALESCE(sm.account_scope, 'all') = 'all'
            OR EXISTS (
              SELECT 1 FROM staff_account_scopes sas
               WHERE sas.staff_id = sm.id AND sas.line_account_id = la.id
            )
          )
        ORDER BY sm.id, la.id
        LIMIT 1`,
      [DEFAULT_TENANT_ID, DEFAULT_TENANT_ID],
    );
    const verificationTarget = targets[0];
    if (!verificationTarget) throw new Error('No scoped staging administrator/account pair found');

    const legacyRows = await query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM notification_rules WHERE line_account_id IS NULL',
    );
    const legacyUnscopedRules = Number(legacyRows[0]?.count ?? 0);

    await insertSyntheticDeliveryRows(
      query,
      runId,
      verificationTarget.line_account_id,
      now,
      dueAt,
    );
    const scenarioId = `verify-b88-scenario-${runId}`;
    const deliverySql = buildFriendScenariosDueForDeliveryQuery(true);
    const firstBatch = await query<DueEnrollment>(
      deliverySql,
      [now, scenarioId, SCENARIO_DELIVERY_BATCH_LIMIT],
    );
    if (firstBatch.length !== 40) throw new Error(`Expected first batch 40; found ${firstBatch.length}`);
    await query(
      `UPDATE friend_scenarios SET status = 'completed', updated_at = ?
       WHERE scenario_id = ? AND id IN (${firstBatch.map(() => '?').join(', ')})`,
      [now, scenarioId, ...firstBatch.map((row) => row.id)],
    );
    const secondBatch = await query<DueEnrollment>(
      deliverySql,
      [now, scenarioId, SCENARIO_DELIVERY_BATCH_LIMIT],
    );
    if (secondBatch.length !== 1) throw new Error(`Expected second batch 1; found ${secondBatch.length}`);

    await query(
      'INSERT OR IGNORE INTO admin_sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)',
      [sessionHash, verificationTarget.staff_id, expiresAt],
    );
    const created = await notificationRequest<{ id: string }>(
      target,
      sessionToken,
      '/api/notifications/rules',
      {
        method: 'POST',
        body: JSON.stringify({
          lineAccountId: verificationTarget.line_account_id,
          name: 'staging verification',
          eventType: 'staging_verification',
          conditions: { synthetic: true },
          channels: ['dashboard'],
        }),
      },
    );
    notificationRuleId = created.id;
    const listed = await notificationRequest<Array<{ id: string }>>(
      target,
      sessionToken,
      `/api/notifications/rules?lineAccountId=${encodeURIComponent(verificationTarget.line_account_id)}`,
    );
    if (!listed.some((rule) => rule.id === notificationRuleId)) {
      throw new Error('Created notification rule was not listed');
    }
    await notificationRequest<null>(
      target,
      sessionToken,
      `/api/notifications/rules/${encodeURIComponent(notificationRuleId)}?lineAccountId=${encodeURIComponent(verificationTarget.line_account_id)}`,
      { method: 'DELETE' },
    );
    apiDeletedRule = true;
    const afterDelete = await notificationRequest<Array<{ id: string }>>(
      target,
      sessionToken,
      `/api/notifications/rules?lineAccountId=${encodeURIComponent(verificationTarget.line_account_id)}`,
    );
    if (afterDelete.some((rule) => rule.id === notificationRuleId)) {
      throw new Error('Deleted notification rule was still listed');
    }

    report = {
      environment: 'staging',
      nonCanonicalNextDeliveryAt: nonCanonicalTimestamps,
      firstDueBatch: firstBatch.length,
      secondDueBatch: secondBatch.length,
      notificationRuleSaved: true,
      notificationRuleListed: true,
      notificationRuleDeleted: true,
      legacyUnscopedNotificationRules: legacyUnscopedRules,
      temporarySessionTtlMinutes: SESSION_TTL_MINUTES,
      staleVerificationCleanupCompleted: true,
      lineMessagesSent: 0,
    };
  } catch (error) {
    verificationError = error;
  } finally {
    const cleanups: Array<{ name: string; run: () => Promise<unknown> }> = [
      { name: 'notification-rule', run: () => notificationRuleId
        ? query('DELETE FROM notification_rules WHERE id = ?', [notificationRuleId])
        : Promise.resolve() },
      { name: 'admin-session', run: () => query('DELETE FROM admin_sessions WHERE token_hash = ?', [sessionHash]) },
      { name: 'enrollments', run: () => query('DELETE FROM friend_scenarios WHERE scenario_id = ?', [`verify-b88-scenario-${runId}`]) },
      { name: 'scenario', run: () => query('DELETE FROM scenarios WHERE id = ?', [`verify-b88-scenario-${runId}`]) },
      { name: 'friends', run: () => query('DELETE FROM friends WHERE line_user_id LIKE ?', [SYNTHETIC_FRIEND_PATTERN]) },
    ];
    for (const cleanup of cleanups) {
      try {
        await cleanup.run();
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown cleanup failure';
        if (cleanup.name === 'friends') {
          try {
            const references = await findSyntheticFriendReferences(
              query,
              SYNTHETIC_FRIEND_PATTERN,
            );
            cleanupFailures.push(
              `friends[references=${references.join(',') || 'none'}; reason=${reason}]`,
            );
          } catch (diagnosticError) {
            const diagnosticReason = diagnosticError instanceof Error
              ? diagnosticError.message
              : 'unknown reference diagnostic failure';
            cleanupFailures.push(`friends[reason=${reason}; diagnostic=${diagnosticReason}]`);
          }
        } else {
          cleanupFailures.push(`${cleanup.name}[reason=${reason}]`);
        }
      }
    }
  }

  let leftoverCount = -1;
  let leftoverCounts: Record<string, number> = {};
  try {
    const leftovers = await countVerificationLeftovers(query, {
      sessionHash,
      scenarioId: `verify-b88-scenario-${runId}`,
      lineUserIdPattern: SYNTHETIC_FRIEND_PATTERN,
      notificationRuleId,
    });
    leftoverCount = leftovers.total;
    leftoverCounts = leftovers.counts;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown leftover-check failure';
    cleanupFailures.push(`leftover-check[reason=${reason}]`);
  }
  if (cleanupFailures.length !== 0 || leftoverCount !== 0) {
    throw new Error(
      `Staging cleanup incomplete: stages=${cleanupFailures.join(',') || 'none'},`
      + ` leftovers=${leftoverCount}, counts=${JSON.stringify(leftoverCounts)}`,
    );
  }
  if (verificationError) throw verificationError;
  if (!apiDeletedRule) throw new Error('Notification rule was not deleted through the API');
  console.log(JSON.stringify({ ...report, temporarySessionDeleted: true, verificationRowsDeleted: true }));
}

if (process.argv[1]?.endsWith('verify-staging-operational-path.ts')) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown staging verification failure';
    console.error(JSON.stringify({ success: false, error: message }));
    process.exitCode = 1;
  });
}
