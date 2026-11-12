import { decryptCredential } from '@line-crm/db';
import {
  deactivatePosIntegration,
  fetchPosData,
  UberEatsError,
  type FetchLike,
  type UberOAuthClient,
  type UberPosData,
} from '../../services/uber-eats.js';
import { getUberApplicationToken } from './application-token.js';
import { acquireWebhookLock, releaseWebhookLock } from './webhook-ingestion.js';

export const POS_DEACTIVATION_STARTED = 'pos_deactivation_started';
export const POS_DEACTIVATION_UNKNOWN = 'pos_deactivation_unknown';
export const POS_DEACTIVATION_CONFIRMED = 'pos_deactivation_confirmed';
export const POS_DISCONNECT_REAUTH_PENDING = 'pos_disconnect_reauthorization_pending';
const PROVISION_REVIEW = 'store_provision_review_required';
const MENU_REVIEW = 'store_menu_refresh_review_required';
const STORE_LOCK_PREFIX = 'uber-store-lifecycle-store:';

type ConnectionStatus = 'pending_store' | 'connected' | 'expired' | 'no_permission' | 'disconnected';

export interface ManagedUberConnection {
  store_id: string;
  account_id: string;
  uber_store_id: string;
  uber_store_name: string | null;
  access_token_enc: string | null;
  access_token_expires_at: number | null;
  granted_scope: string | null;
  status: ConnectionStatus;
  connected_at: number | null;
  provisioned_at: number | null;
  disconnected_at: number | null;
  updated_at: number;
  last_error: string | null;
  version: number;
}

export type ConnectionMutationResult =
  | { ok: true; connection: ManagedUberConnection }
  | { ok: false; status: 409 | 502 | 503; code: string };

/** 遅い OAuth 完了で新しい解除を取り消さないよう、接続の状態を照合して保存する。 */
export async function saveUberOAuthConnection(input: {
  db: D1Database;
  storeId: string;
  accountId: string;
  tenantId: string;
  mode: 'connect' | 'reconnect';
  staffId: string;
  accessTokenEnc: string;
  accessTokenExpiresAt: number;
  grantedScope: string;
  stateCreatedAt: number;
  expectedVersion: number;
  nowMs: number;
}): Promise<boolean> {
  const ownership = `s.id = ? AND s.line_account_id = ? AND s.status = 'active'
    AND o.status <> 'archived' AND o.tenant_id = ?
    AND a.id = s.line_account_id AND a.is_active = 1 AND a.archived_at IS NULL AND a.tenant_id = o.tenant_id
    AND t.id = o.tenant_id AND t.status = 'active'
    AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(t.feature_packs) THEN t.feature_packs ELSE '[]' END)
      WHERE value = 'restaurant')
    AND NOT EXISTS (SELECT 1 FROM rt_store_feature_flags f
      WHERE f.store_id = s.id AND f.feature = 'delivery' AND f.enabled = 0)`;
  if (input.mode === 'reconnect') {
    const refreshed = await input.db.prepare(`UPDATE rt_delivery_uber_connections
      SET access_token_enc = ?, access_token_expires_at = ?, granted_scope = ?,
        status = 'pending_store', last_error = '${POS_DISCONNECT_REAUTH_PENDING}',
        version = version + 1, updated_at = ?
      WHERE store_id = ? AND account_id = ? AND uber_store_id IS NOT NULL AND status <> 'disconnected'
        AND version = ? AND (disconnected_at IS NULL OR disconnected_at < ?)
        AND COALESCE(last_error, '') NOT IN
          ('pos_activation_started', 'pos_activation_unknown',
           'pos_deactivation_started', 'pos_deactivation_unknown',
           '${POS_DISCONNECT_REAUTH_PENDING}',
           'store_provision_review_required', 'store_menu_refresh_review_required')
        AND EXISTS (SELECT 1 FROM rt_stores s
          JOIN rt_organizations o ON o.id = s.organization_id
          JOIN line_accounts a ON a.id = s.line_account_id
          JOIN tenants t ON t.id = o.tenant_id WHERE ${ownership})`)
      .bind(input.accessTokenEnc, input.accessTokenExpiresAt, input.grantedScope, input.nowMs,
        input.storeId, input.accountId, input.expectedVersion, input.stateCreatedAt,
        input.storeId, input.accountId, input.tenantId).run();
    return Number(refreshed.meta.changes ?? 0) === 1;
  }
  const result = await input.db.prepare(`INSERT INTO rt_delivery_uber_connections
    (store_id, account_id, access_token_enc, access_token_expires_at, granted_scope,
      status, connected_by_staff_id, connected_at, disconnected_at, last_error,
      version, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, 'pending_store', ?, ?, NULL, NULL, 1, ?, ?
    WHERE EXISTS (SELECT 1 FROM rt_stores s
      JOIN rt_organizations o ON o.id = s.organization_id
      JOIN line_accounts a ON a.id = s.line_account_id
      JOIN tenants t ON t.id = o.tenant_id WHERE ${ownership})
    ON CONFLICT(store_id) DO UPDATE SET
      account_id = excluded.account_id,
      access_token_enc = excluded.access_token_enc,
      access_token_expires_at = excluded.access_token_expires_at,
      granted_scope = excluded.granted_scope,
      status = 'pending_store', connected_by_staff_id = excluded.connected_by_staff_id,
      connected_at = excluded.connected_at, disconnected_at = NULL, last_error = NULL,
      version = rt_delivery_uber_connections.version + 1, updated_at = excluded.updated_at
    WHERE COALESCE(rt_delivery_uber_connections.last_error, '') NOT IN
      ('pos_activation_started', 'pos_activation_unknown',
       'pos_deactivation_started', 'pos_deactivation_unknown',
       '${POS_DISCONNECT_REAUTH_PENDING}',
       'store_provision_review_required', 'store_menu_refresh_review_required')
      AND rt_delivery_uber_connections.account_id = ?
      AND rt_delivery_uber_connections.version = ?
      AND (rt_delivery_uber_connections.disconnected_at IS NULL
        OR rt_delivery_uber_connections.disconnected_at < ?)
      AND EXISTS (SELECT 1 FROM rt_stores s
        JOIN rt_organizations o ON o.id = s.organization_id
        JOIN line_accounts a ON a.id = s.line_account_id
        JOIN tenants t ON t.id = o.tenant_id WHERE ${ownership})`)
    .bind(input.storeId, input.accountId, input.accessTokenEnc, input.accessTokenExpiresAt,
      input.grantedScope, input.staffId, input.nowMs, input.nowMs, input.nowMs,
      input.storeId, input.accountId, input.tenantId,
      input.accountId, input.expectedVersion, input.stateCreatedAt,
      input.storeId, input.accountId, input.tenantId).run();
  return Number(result.meta.changes ?? 0) === 1;
}

const OWNERSHIP = `s.status = 'active' AND s.line_account_id = u.account_id
  AND o.status <> 'archived'
  AND a.is_active = 1 AND a.archived_at IS NULL AND a.tenant_id = o.tenant_id
  AND t.status = 'active'
  AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(t.feature_packs) THEN t.feature_packs ELSE '[]' END)
    WHERE value = 'restaurant')
  AND NOT EXISTS (SELECT 1 FROM rt_store_feature_flags f
    WHERE f.store_id = u.store_id AND f.feature = 'delivery' AND f.enabled = 0)`;

const JOINS = `FROM rt_delivery_uber_connections u
  JOIN rt_stores s ON s.id = u.store_id
  JOIN rt_organizations o ON o.id = s.organization_id
  JOIN line_accounts a ON a.id = u.account_id
  JOIN tenants t ON t.id = o.tenant_id`;

function unresolvedDeactivation(code: string | null): boolean {
  return code === POS_DEACTIVATION_STARTED || code === POS_DEACTIVATION_UNKNOWN;
}

function unresolvedActivation(code: string | null): boolean {
  return code === 'pos_activation_started' || code === 'pos_activation_unknown';
}

async function exactConnection(db: D1Database, storeId: string, accountId: string): Promise<ManagedUberConnection | null> {
  const rows = await db.prepare(`SELECT u.store_id, u.account_id, u.uber_store_id, u.uber_store_name,
      u.access_token_enc, u.access_token_expires_at, u.granted_scope, u.status, u.connected_at,
      u.provisioned_at, u.disconnected_at, u.updated_at, u.last_error, u.version
    ${JOINS}
    WHERE u.store_id = ? AND u.account_id = ? AND u.uber_store_id IS NOT NULL AND ${OWNERSHIP}
      AND (SELECT COUNT(*) FROM rt_delivery_uber_connections duplicate
        WHERE duplicate.uber_store_id = u.uber_store_id) = 1 LIMIT 2`)
    .bind(storeId, accountId).all<ManagedUberConnection>();
  return rows.results.length === 1 ? rows.results[0]! : null;
}

function leaseFence(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function posMatches(pos: UberPosData, row: ManagedUberConnection, clientId: string): boolean {
  return pos.integrationEnabled
    && pos.integratorStoreId === row.store_id
    && !pos.isOrderManagerPending
    && pos.orderManagerClientId === clientId;
}

function isMissing(error: unknown): boolean {
  return error instanceof UberEatsError && error.kind === 'not_found';
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof UberEatsError ? `uber_${error.kind}` : fallback;
}

async function updateConnection(input: {
  db: D1Database;
  row: ManagedUberConnection;
  lockKey: string;
  owner: string;
  checkedAtMs: number;
  setSql: string;
  binds: unknown[];
  requireNoUnresolvedDispatches?: boolean;
}): Promise<ManagedUberConnection | null> {
  const dispatchFence = input.requireNoUnresolvedDispatches
    ? `AND NOT EXISTS (SELECT 1 FROM rt_delivery_dispatches dispatch
        WHERE dispatch.store_id = target.store_id AND dispatch.account_id = target.account_id
          AND dispatch.service = 'ubereats'
          AND (dispatch.status = 'pending' OR dispatch.error_code = 'delivery_result_unknown'))`
    : '';
  const result = await input.db.prepare(`UPDATE rt_delivery_uber_connections AS target
    SET ${input.setSql}
    WHERE target.store_id = ? AND target.account_id = ? AND target.uber_store_id = ? AND target.version = ?
      AND EXISTS (SELECT 1 ${JOINS} WHERE u.store_id = target.store_id AND u.account_id = target.account_id
        AND u.uber_store_id = target.uber_store_id AND u.version = target.version AND ${OWNERSHIP})
      AND (SELECT COUNT(*) FROM rt_delivery_uber_connections duplicate
        WHERE duplicate.uber_store_id = target.uber_store_id) = 1
      AND EXISTS (SELECT 1 FROM rt_resource_locks lifecycle_lock
        WHERE lifecycle_lock.resource_key = ? AND lifecycle_lock.owner_token = ?
          AND julianday(lifecycle_lock.expires_at) > julianday(?))
      ${dispatchFence}`)
    .bind(...input.binds, input.row.store_id, input.row.account_id, input.row.uber_store_id,
      input.row.version, input.lockKey, input.owner, leaseFence(input.checkedAtMs)).run();
  if (Number(result.meta.changes ?? 0) !== 1) return null;
  return exactConnection(input.db, input.row.store_id, input.row.account_id);
}

async function disconnected(input: {
  db: D1Database; row: ManagedUberConnection; lockKey: string; owner: string; nowMs: number;
}): Promise<ManagedUberConnection | null> {
  return updateConnection({
    ...input,
    checkedAtMs: input.nowMs,
    setSql: `status = 'disconnected', access_token_enc = NULL, access_token_expires_at = NULL,
      granted_scope = NULL, provisioned_at = NULL, disconnected_at = ?,
      last_error = '${POS_DEACTIVATION_CONFIRMED}',
      version = version + 1, updated_at = ?`,
    binds: [input.nowMs, input.nowMs],
  });
}

async function withStoreLease(input: {
  db: D1Database;
  storeId: string;
  accountId: string;
  nowMs: number;
  expectedVersion?: number;
  work: (row: ManagedUberConnection, lockKey: string, owner: string, elapsedNowMs: () => number) => Promise<ConnectionMutationResult>;
}): Promise<ConnectionMutationResult> {
  const before = await exactConnection(input.db, input.storeId, input.accountId);
  if (!before || before.status === 'disconnected') return { ok: false, status: 409, code: 'connection_not_active' };
  if (input.expectedVersion !== undefined && before.version !== input.expectedVersion) return { ok: false, status: 409, code: 'connection_changed' };
  const owner = crypto.randomUUID();
  const lockKey = `${STORE_LOCK_PREFIX}${before.uber_store_id}`;
  const wallStartedAt = Date.now();
  const elapsedNowMs = () => input.nowMs + Math.max(0, Date.now() - wallStartedAt);
  if (!await acquireWebhookLock(input.db, lockKey, owner, Math.floor(input.nowMs / 1000))) {
    return { ok: false, status: 503, code: 'connection_busy' };
  }
  try {
    const current = await exactConnection(input.db, input.storeId, input.accountId);
    if (!current || current.uber_store_id !== before.uber_store_id || current.version !== before.version) {
      return { ok: false, status: 409, code: 'connection_changed' };
    }
    return await input.work(current, lockKey, owner, elapsedNowMs);
  } finally {
    try { await releaseWebhookLock(input.db, lockKey, owner); } catch { /* The bounded lease expires. */ }
  }
}

export async function checkUberConnection(input: {
  db: D1Database;
  storeId: string;
  accountId: string;
  client: UberOAuthClient;
  encryptionKey: string;
  fetcher: FetchLike;
  nowMs?: number;
}): Promise<ConnectionMutationResult> {
  const nowMs = input.nowMs ?? Date.now();
  return withStoreLease({ ...input, nowMs, work: async (row, lockKey, owner, elapsedNowMs) => {
    // DELETE の結果不明は署名付き解除通知か人の確認でだけ解決する。古い可能性のある GET で解除の印を消さない。
    if (unresolvedActivation(row.last_error)) {
      return { ok: false, status: 409, code: 'pos_activation_unknown' };
    }
    if (unresolvedDeactivation(row.last_error)) {
      return { ok: false, status: 409, code: POS_DEACTIVATION_UNKNOWN };
    }
    let accessToken: string;
    try {
      const token = await getUberApplicationToken({
        db: input.db, client: input.client, encryptionKey: input.encryptionKey,
        fetcher: input.fetcher, purpose: 'store', nowMs: elapsedNowMs(),
      });
      accessToken = token.accessToken;
    } catch (error) {
      return { ok: false, status: 502, code: errorCode(error, 'connection_check_failed') };
    }

    let pos: UberPosData;
    try {
      pos = await fetchPosData({
        fetch: input.fetcher, accessToken, hosts: input.client.hosts, singleAttempt: true,
      }, row.uber_store_id);
    } catch (error) {
      if (error instanceof UberEatsError
        && ['auth_expired', 'no_permission', 'not_found', 'invalid_request'].includes(error.kind)) {
        const now = elapsedNowMs();
        const updated = await updateConnection({
          db: input.db, row, lockKey, owner, checkedAtMs: now,
          setSql: `status = ?, provisioned_at = NULL, last_error = ?,
            version = version + 1, updated_at = ?`,
          binds: ['pending_store', error.kind === 'not_found'
            ? PROVISION_REVIEW : `uber_application_${error.kind}`, now],
        });
        return updated ? { ok: true, connection: updated } : { ok: false, status: 409, code: 'connection_changed' };
      }
      return { ok: false, status: 502, code: errorCode(error, 'connection_check_failed') };
    }

    const now = elapsedNowMs();
    const matches = posMatches(pos, row, input.client.clientId);
    const preserveMenuReview = row.last_error === MENU_REVIEW;
    const unchangedConnected = matches && !preserveMenuReview && row.status === 'connected'
      && row.provisioned_at !== null && row.last_error === null && row.disconnected_at === null;
    const updated = await updateConnection({
      db: input.db, row, lockKey, owner, checkedAtMs: now,
      setSql: unchangedConnected
        ? 'updated_at = ?'
        : matches && !preserveMenuReview
        ? `status = 'connected', connected_at = COALESCE(connected_at, ?),
          provisioned_at = COALESCE(provisioned_at, ?), disconnected_at = NULL,
          last_error = NULL, version = version + 1, updated_at = ?`
        : `status = 'pending_store', provisioned_at = NULL, last_error = ?,
          version = version + 1, updated_at = ?`,
      binds: unchangedConnected
        ? [now]
        : matches && !preserveMenuReview
        ? [now, now, now]
        : [preserveMenuReview ? MENU_REVIEW : PROVISION_REVIEW, now],
    });
    return updated ? { ok: true, connection: updated } : { ok: false, status: 409, code: 'connection_changed' };
  }});
}

function hasProvisioningScope(scope: string | null): boolean {
  return (scope ?? '').split(/\s+/).includes('eats.pos_provisioning');
}

async function hasUnresolvedDispatch(db: D1Database, row: ManagedUberConnection): Promise<boolean> {
  return await db.prepare(`SELECT 1 FROM rt_delivery_dispatches
    WHERE store_id = ? AND account_id = ? AND service = 'ubereats'
      AND (status = 'pending' OR error_code = 'delivery_result_unknown') LIMIT 1`)
    .bind(row.store_id, row.account_id).first() !== null;
}

export async function disconnectUberConnection(input: {
  db: D1Database;
  storeId: string;
  accountId: string;
  client: UberOAuthClient;
  encryptionKey: string;
  fetcher: FetchLike;
  nowMs?: number;
  expectedVersion?: number;
}): Promise<ConnectionMutationResult> {
  const nowMs = input.nowMs ?? Date.now();
  return withStoreLease({ ...input, nowMs, work: async (row, lockKey, owner, elapsedNowMs) => {
    if (unresolvedActivation(row.last_error)) {
      return { ok: false, status: 409, code: 'pos_activation_unknown' };
    }
    if (unresolvedDeactivation(row.last_error)) {
      return { ok: false, status: 409, code: POS_DEACTIVATION_UNKNOWN };
    }
    if (row.last_error === POS_DISCONNECT_REAUTH_PENDING) {
      return { ok: false, status: 409, code: 'connection_check_required' };
    }
    if (row.status === 'expired' || row.status === 'no_permission') {
      return { ok: false, status: 409, code: 'reauthorization_required' };
    }
    if (row.last_error === PROVISION_REVIEW || row.last_error === MENU_REVIEW) {
      return { ok: false, status: 409, code: 'connection_review_required' };
    }
    if (!row.access_token_enc || !hasProvisioningScope(row.granted_scope)
      || !row.access_token_expires_at || row.access_token_expires_at <= elapsedNowMs()) {
      return { ok: false, status: 409, code: 'reauthorization_required' };
    }

    let merchantToken: string;
    try {
      merchantToken = await decryptCredential(row.access_token_enc, input.encryptionKey);
    } catch {
      return { ok: false, status: 503, code: 'encryption_key_invalid' };
    }

    try {
      const token = await getUberApplicationToken({
        db: input.db, client: input.client, encryptionKey: input.encryptionKey,
        fetcher: input.fetcher, purpose: 'store', nowMs: elapsedNowMs(),
      });
      const pos = await fetchPosData({
        fetch: input.fetcher, accessToken: token.accessToken, hosts: input.client.hosts, singleAttempt: true,
      }, row.uber_store_id);
      if (!posMatches(pos, row, input.client.clientId)) {
        return { ok: false, status: 409, code: 'provider_ownership_unverified' };
      }
    } catch (error) {
      return { ok: false, status: 502, code: errorCode(error, 'connection_check_failed') };
    }

    const claimed = await updateConnection({
      db: input.db, row, lockKey, owner, checkedAtMs: elapsedNowMs(),
      setSql: `status = 'pending_store', provisioned_at = NULL, last_error = '${POS_DEACTIVATION_STARTED}',
        version = version + 1, updated_at = ?`,
      binds: [elapsedNowMs()],
      requireNoUnresolvedDispatches: true,
    });
    if (!claimed) {
      const dispatching = await hasUnresolvedDispatch(input.db, row).catch(() => false);
      return { ok: false, status: 409, code: dispatching ? 'order_dispatch_in_progress' : 'connection_changed' };
    }

    try {
      await deactivatePosIntegration({
        fetch: input.fetcher, accessToken: merchantToken, hosts: input.client.hosts, singleAttempt: true,
      }, claimed.uber_store_id);
    } catch (error) {
      {
        const ambiguous = isMissing(error) || !(error instanceof UberEatsError)
          || error.status === null || error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500;
        const requiresAuthorization = error instanceof UberEatsError
          && (error.kind === 'auth_expired' || error.kind === 'no_permission');
        const failed = await updateConnection({
          db: input.db, row: claimed, lockKey, owner, checkedAtMs: elapsedNowMs(),
          setSql: requiresAuthorization
            ? `status = ?, last_error = ?, version = version + 1, updated_at = ?`
            : `last_error = ?, version = version + 1, updated_at = ?`,
          binds: requiresAuthorization
            ? [error.kind === 'auth_expired' ? 'expired' : 'no_permission', `uber_${error.kind}`, elapsedNowMs()]
            : [ambiguous ? POS_DEACTIVATION_UNKNOWN : errorCode(error, 'pos_deactivation_failed'), elapsedNowMs()],
        });
        if (!failed) return { ok: false, status: 409, code: 'connection_changed' };
        return { ok: false, status: ambiguous ? 503 : requiresAuthorization ? 409 : 502,
          code: ambiguous ? POS_DEACTIVATION_UNKNOWN
            : requiresAuthorization ? 'reauthorization_required' : errorCode(error, 'pos_deactivation_failed') };
      }
    }

    const updated = await disconnected({ db: input.db, row: claimed, lockKey, owner, nowMs: elapsedNowMs() });
    return updated ? { ok: true, connection: updated } : { ok: false, status: 409, code: 'connection_changed' };
  }});
}
