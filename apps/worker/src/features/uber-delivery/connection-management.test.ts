import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptCredential } from '@line-crm/db';
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite.js';
import type { FetchLike, UberOAuthClient } from '../../services/uber-eats.js';
import {
  checkUberConnection,
  disconnectUberConnection,
  POS_DEACTIVATION_CONFIRMED,
  POS_DEACTIVATION_UNKNOWN,
  saveUberOAuthConnection,
} from './connection-management.js';
import { readyDispatchConnection } from './order-dispatch-retry.js';

const NOW = Date.parse('2026-10-23T00:00:00.000Z');
const TENANT = '00000000-0000-4000-8000-000000000001';
const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const client: UberOAuthClient = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://worker.example.test/api/restaurant-test/delivery/ubereats/oauth/callback',
  hosts: {
    authorizeUrl: 'https://login.uber.test/authorize',
    tokenUrl: 'https://login.uber.test/token',
    apiBaseUrl: 'https://api.uber.test',
  },
};

let database: SqliteD1;

function seedOwnership(input: { storeId?: string; accountId?: string; uberStoreId?: string } = {}): void {
  const storeId = input.storeId ?? 'store-1';
  const accountId = input.accountId ?? 'account-1';
  const uberStoreId = input.uberStoreId ?? 'uber-store-1';
  database.raw.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
    VALUES (?, ?, ?, 'token', 'secret', 1, ?)`)
    .run(accountId, `channel-${accountId}`, accountId, TENANT);
  database.raw.prepare(`INSERT INTO rt_organizations (id, account_id, tenant_id, name)
    VALUES (?, ?, ?, 'Restaurant')`).run(`org-${storeId}`, accountId, TENANT);
  database.raw.prepare(`INSERT INTO rt_stores
    (id, organization_id, name, code, area, capacity, status, line_account_id)
    VALUES (?, ?, 'Store', ?, 'Tokyo', 10, 'active', ?)`)
    .run(storeId, `org-${storeId}`, storeId, accountId);
  database.raw.prepare(`INSERT INTO rt_delivery_uber_connections
    (store_id, account_id, uber_store_id, uber_store_name, access_token_enc,
      access_token_expires_at, granted_scope, status, connected_at, provisioned_at,
      last_error, version, created_at, updated_at)
    VALUES (?, ?, ?, 'Uber Store', NULL, NULL, NULL, 'connected', ?, ?, NULL, 1, ?, ?)`)
    .run(storeId, accountId, uberStoreId, NOW - 10_000, NOW - 10_000, NOW - 10_000, NOW - 10_000);
}

async function addMerchantToken(storeId = 'store-1'): Promise<void> {
  database.raw.prepare(`UPDATE rt_delivery_uber_connections
    SET access_token_enc = ?, access_token_expires_at = ?, granted_scope = 'eats.pos_provisioning'
    WHERE store_id = ?`).run(await encryptCredential('merchant-token', KEY), NOW + 3_600_000, storeId);
}

function row(storeId = 'store-1') {
  return database.raw.prepare('SELECT * FROM rt_delivery_uber_connections WHERE store_id = ?').get(storeId) as Record<string, unknown>;
}

function exactPos() {
  return new Response(JSON.stringify({
    integration_enabled: true,
    integrator_store_id: 'store-1',
    order_manager_client_id: client.clientId,
    is_order_manager_pending: false,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function provider(input: {
  pos?: () => Promise<Response> | Response;
  remove?: () => Promise<Response> | Response;
} = {}): { fetcher: FetchLike; calls: Array<{ url: string; authorization: string | null; method: string }> } {
  const calls: Array<{ url: string; authorization: string | null; method: string }> = [];
  const fetcher: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization'), method: init?.method ?? 'GET' });
    if (url === client.hosts.tokenUrl) {
      return new Response(JSON.stringify({ access_token: 'application-token', expires_in: 3600, scope: 'eats.store' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (init?.method === 'DELETE') return input.remove ? input.remove() : new Response(null, { status: 204 });
    return input.pos ? input.pos() : exactPos();
  });
  return { fetcher, calls };
}

beforeEach(() => {
  database = createTestD1({ loginPolicy: 'off' });
  database.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = ?`).run(TENANT);
  seedOwnership();
});

describe('Uber connection management', () => {

  it('refuses an older confirmed connection before contacting Uber', async () => {
    await addMerchantToken();
    const api = provider();
    const result = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW, ...{ expectedVersion: 0 } });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'connection_changed' });
    expect(api.calls).toEqual([]);
    expect(row()).toMatchObject({ status: 'connected', version: 1 });
  });

  it('checks the exact provider ownership with an eats.store application token', async () => {
    database.raw.prepare(`UPDATE rt_delivery_uber_connections
      SET status = 'pending_store', provisioned_at = NULL WHERE store_id = 'store-1'`).run();
    const api = provider();
    const result = await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });

    expect(result.ok).toBe(true);
    expect(row()).toMatchObject({ status: 'connected', last_error: null, version: 2 });
    expect(api.calls).toEqual([
      expect.objectContaining({ url: client.hosts.tokenUrl, method: 'POST' }),
      expect.objectContaining({ authorization: 'Bearer application-token', method: 'GET' }),
    ]);
  });

  it('keeps the connection revision stable for an exact already-connected check', async () => {
    const api = provider();
    const result = await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(result.ok).toBe(true);
    expect(row()).toMatchObject({ status: 'connected', version: 1 });
    expect(Number(row().updated_at)).toBeGreaterThanOrEqual(NOW);
  });

  it('does not turn pending or mismatched POS data green and preserves menu review', async () => {
    database.raw.prepare(`UPDATE rt_delivery_uber_connections SET status = 'pending_store', provisioned_at = NULL,
      last_error = 'store_menu_refresh_review_required' WHERE store_id = 'store-1'`).run();
    const api = provider();
    const result = await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(result.ok).toBe(true);
    expect(row()).toMatchObject({ status: 'pending_store', provisioned_at: null,
      last_error: 'store_menu_refresh_review_required', version: 2 });

    database.raw.prepare(`UPDATE rt_delivery_uber_connections SET last_error = NULL WHERE store_id = 'store-1'`).run();
    const mismatch = provider({ pos: () => new Response(JSON.stringify({
      integration_enabled: true, integrator_store_id: 'other-store',
      order_manager_client_id: client.clientId, is_order_manager_pending: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }) });
    await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: mismatch.fetcher, nowMs: NOW + 1 });
    expect(row()).toMatchObject({ status: 'pending_store', provisioned_at: null,
      last_error: 'store_provision_review_required', version: 3 });
  });

  it('turns a definite missing provider mapping into a fail-closed review state', async () => {
    const api = provider({ pos: () => new Response(null, { status: 404 }) });
    const result = await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(result.ok).toBe(true);
    expect(row()).toMatchObject({ status: 'pending_store', provisioned_at: null,
      last_error: 'store_provision_review_required', version: 2 });
  });

  it('never clears a disconnect tombstone or intentionally disconnected row', async () => {
    database.raw.prepare(`UPDATE rt_delivery_uber_connections SET status = 'pending_store', provisioned_at = NULL,
      last_error = 'pos_deactivation_unknown' WHERE store_id = 'store-1'`).run();
    const api = provider();
    const blocked = await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(blocked).toEqual({ ok: false, status: 409, code: POS_DEACTIVATION_UNKNOWN });
    expect(api.calls).toHaveLength(0);

    database.raw.prepare(`UPDATE rt_delivery_uber_connections SET status = 'disconnected', last_error = NULL
      WHERE store_id = 'store-1'`).run();
    const disconnected = await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(disconnected).toEqual({ ok: false, status: 409, code: 'connection_not_active' });
    expect(api.calls).toHaveLength(0);
  });

  it('does not use management calls to resolve an activation tombstone', async () => {
    await addMerchantToken();
    database.raw.prepare(`UPDATE rt_delivery_uber_connections SET status = 'pending_store', provisioned_at = NULL,
      last_error = 'pos_activation_unknown' WHERE store_id = 'store-1'`).run();
    const api = provider();
    const checked = await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    const removed = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(checked).toEqual({ ok: false, status: 409, code: 'pos_activation_unknown' });
    expect(removed).toEqual({ ok: false, status: 409, code: 'pos_activation_unknown' });
    expect(api.calls).toHaveLength(0);
  });

  it('does not disconnect while provider or menu review is unresolved', async () => {
    await addMerchantToken();
    for (const code of ['store_provision_review_required', 'store_menu_refresh_review_required']) {
      database.raw.prepare(`UPDATE rt_delivery_uber_connections SET status = 'pending_store',
        provisioned_at = NULL, last_error = ? WHERE store_id = 'store-1'`).run(code);
      const api = provider();
      const result = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
        client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
      expect(result).toEqual({ ok: false, status: 409, code: 'connection_review_required' });
      expect(api.calls).toHaveLength(0);
    }
  });

  it('does not let a pre-disconnect OAuth callback revive the connection', async () => {
    database.raw.prepare(`UPDATE rt_delivery_uber_connections
      SET status = 'disconnected', provisioned_at = NULL, disconnected_at = ?,
        last_error = ?, version = 2
      WHERE store_id = 'store-1'`).run(NOW + 1, POS_DEACTIVATION_CONFIRMED);
    const stale = await saveUberOAuthConnection({
      db: database.db, storeId: 'store-1', accountId: 'account-1', tenantId: TENANT, mode: 'connect', staffId: 'owner-1',
      accessTokenEnc: 'encrypted', accessTokenExpiresAt: NOW + 10_000,
      grantedScope: 'eats.pos_provisioning', stateCreatedAt: NOW, expectedVersion: 1, nowMs: NOW + 2,
    });
    expect(stale).toBe(false);
    expect(row()).toMatchObject({
      status: 'disconnected', last_error: POS_DEACTIVATION_CONFIRMED, version: 2,
    });

    const fresh = await saveUberOAuthConnection({
      db: database.db, storeId: 'store-1', accountId: 'account-1', tenantId: TENANT, mode: 'connect', staffId: 'owner-1',
      accessTokenEnc: 'encrypted', accessTokenExpiresAt: NOW + 10_000,
      grantedScope: 'eats.pos_provisioning', stateCreatedAt: NOW + 2, expectedVersion: 2, nowMs: NOW + 3,
    });
    expect(fresh).toBe(true);
    expect(row()).toMatchObject({
      status: 'pending_store', disconnected_at: null, last_error: null, version: 3,
    });
  });

  it('does not save an OAuth token after store ownership changes', async () => {
    database.raw.prepare(`INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active, tenant_id)
      VALUES ('account-2', 'channel-2', 'Other', 'token', 'secret', 1, ?)`).run(TENANT);
    database.raw.prepare("UPDATE rt_stores SET line_account_id = 'account-2' WHERE id = 'store-1'").run();
    const saved = await saveUberOAuthConnection({
      db: database.db, storeId: 'store-1', accountId: 'account-1', tenantId: TENANT, mode: 'connect', staffId: 'owner-1',
      accessTokenEnc: 'new-encrypted-token', accessTokenExpiresAt: NOW + 10_000,
      grantedScope: 'eats.pos_provisioning', stateCreatedAt: NOW, expectedVersion: 1, nowMs: NOW + 1,
    });
    expect(saved).toBe(false);
    expect(row()).toMatchObject({ account_id: 'account-1', access_token_enc: null, version: 1 });
  });

  it('refreshes a mapped merchant token without activation or automatic DELETE', async () => {
    const refreshed = await saveUberOAuthConnection({
      db: database.db, storeId: 'store-1', accountId: 'account-1', tenantId: TENANT,
      mode: 'reconnect', staffId: 'owner-1',
      accessTokenEnc: await encryptCredential('new-merchant-token', KEY),
      accessTokenExpiresAt: NOW + 3_600_000, grantedScope: 'eats.pos_provisioning',
      stateCreatedAt: NOW, expectedVersion: 1, nowMs: NOW + 1,
    });
    expect(refreshed).toBe(true);
    expect(row()).toMatchObject({ uber_store_id: 'uber-store-1', status: 'pending_store',
      provisioned_at: NOW - 10_000, last_error: 'pos_disconnect_reauthorization_pending', version: 2 });

    const api = provider();
    const premature = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW + 2 });
    expect(premature).toEqual({ ok: false, status: 409, code: 'connection_check_required' });
    expect(api.calls).toHaveLength(0);

    const checked = await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW + 3 });
    expect(checked.ok).toBe(true);
    expect(row()).toMatchObject({ status: 'connected', last_error: null, version: 3 });
    const disconnected = await disconnectUberConnection({
      db: database.db, storeId: 'store-1', accountId: 'account-1', client,
      encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW + 4,
    });
    expect(disconnected.ok).toBe(true);
    expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', authorization: 'Bearer new-merchant-token' });
  });

  it('fails closed when ownership, duplicate mapping, connection revision, or lock changes during GET', async () => {
    for (const mutation of ['tenant', 'duplicate', 'version', 'lock'] as const) {
      database = createTestD1({ loginPolicy: 'off' });
      database.raw.prepare(`UPDATE tenants SET feature_packs = '["restaurant"]' WHERE id = ?`).run(TENANT);
      seedOwnership();
      const api = provider({ pos: () => {
        if (mutation === 'tenant') database.raw.prepare("UPDATE line_accounts SET is_active = 0 WHERE id = 'account-1'").run();
        if (mutation === 'version') database.raw.prepare("UPDATE rt_delivery_uber_connections SET version = version + 1 WHERE store_id = 'store-1'").run();
        if (mutation === 'lock') database.raw.prepare("UPDATE rt_resource_locks SET owner_token = 'taken-over'").run();
        if (mutation === 'duplicate') database.raw.prepare(`INSERT INTO rt_delivery_uber_connections
          (store_id, account_id, uber_store_id, status, version, created_at, updated_at)
          VALUES ('store-2', 'account-2', 'uber-store-1', 'connected', 1, ?, ?)`)
          .run(NOW, NOW);
        return exactPos();
      }});
      const result = await checkUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
        client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
      expect(result, mutation).toMatchObject({ ok: false, status: 409 });
      expect(row().version, mutation).toBe(mutation === 'version' ? 2 : 1);
    }
  });

  it('requires a valid provisioning token before disconnect sends anything', async () => {
    const api = provider();
    const result = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(result).toEqual({ ok: false, status: 409, code: 'reauthorization_required' });
    expect(api.calls).toHaveLength(0);
  });

  it.each([200, 202, 204])('claims before DELETE %s and clears credentials only after confirmation', async (status) => {
    await addMerchantToken();
    let claimedBeforeDelete = false;
    const api = provider({ remove: () => {
      claimedBeforeDelete = row().status === 'pending_store'
        && row().last_error === 'pos_deactivation_started'
        && row().provisioned_at === null;
      return new Response(null, { status });
    }});
    const result = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(result.ok).toBe(true);
    expect(claimedBeforeDelete).toBe(true);
    expect(row()).toMatchObject({ status: 'disconnected', access_token_enc: null, granted_scope: null,
      provisioned_at: null, last_error: POS_DEACTIVATION_CONFIRMED, version: 3 });
    expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', authorization: 'Bearer merchant-token' });
  });

  it('retains an ambiguous DELETE tombstone and never automatically repeats it', async () => {
    await addMerchantToken();
    const api = provider({ remove: () => { throw new Error('network'); } });
    const first = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(first).toEqual({ ok: false, status: 503, code: POS_DEACTIVATION_UNKNOWN });
    expect(row()).toMatchObject({ status: 'pending_store', last_error: POS_DEACTIVATION_UNKNOWN,
      access_token_enc: expect.any(String), provisioned_at: null, version: 3 });
    const sent = api.calls.length;

    const second = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW + 1 });
    expect(second).toEqual({ ok: false, status: 409, code: POS_DEACTIVATION_UNKNOWN });
    expect(api.calls).toHaveLength(sent);
  });

  it('advances the connection revision when the provider rejects disconnect authorization', async () => {
    await addMerchantToken();
    const api = provider({ remove: () => new Response(null, { status: 401 }) });
    const result = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'reauthorization_required' });
    expect(row()).toMatchObject({ status: 'expired', last_error: 'uber_auth_expired', version: 3 });
  });

  it('treats DELETE 404 as unknown and never repeats it', async () => {
    await addMerchantToken();
    const api = provider({ remove: () => new Response(null, { status: 404 }) });
    const result = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(result).toEqual({ ok: false, status: 503, code: POS_DEACTIVATION_UNKNOWN });
    expect(row()).toMatchObject({ status: 'pending_store', last_error: POS_DEACTIVATION_UNKNOWN });
    const sent = api.calls.length;
    await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW + 1 });
    expect(api.calls).toHaveLength(sent);
  });

  it('does not claim disconnect while an order dispatch is unresolved', async () => {
    await addMerchantToken();
    database.raw.prepare(`INSERT INTO rt_delivery_dispatches
      (id, account_id, store_id, service, action, target_kind, target_id, status, error_code,
       attempts, requested_at, version, created_at, updated_at)
      VALUES ('dispatch-1', 'account-1', 'store-1', 'ubereats', 'accept', 'order', 'order-1',
        'pending', 'delivery_result_unknown', 1, ?, 1, ?, ?)`).run(NOW, NOW, NOW);
    const api = provider();
    const result = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(result).toEqual({ ok: false, status: 409, code: 'order_dispatch_in_progress' });
    expect(row()).toMatchObject({ status: 'connected', version: 1 });
    expect(api.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('makes new and retry order sends ineligible before DELETE starts', async () => {
    await addMerchantToken();
    let connectionDuringDelete: unknown = 'not-checked';
    const api = provider({ remove: async () => {
      connectionDuringDelete = await readyDispatchConnection({
        db: database.db,
        store: { id: 'store-1', lineAccountId: 'account-1' },
        order: { id: 'order-1', account_id: 'account-1', store_id: 'store-1', external_order_id: 'ext-1',
          status: 'new', version: 1 },
        action: 'accept', now: Math.floor(NOW / 1000),
      });
      return new Response(null, { status: 204 });
    }});
    const result = await disconnectUberConnection({ db: database.db, storeId: 'store-1', accountId: 'account-1',
      client, encryptionKey: KEY, fetcher: api.fetcher, nowMs: NOW });
    expect(result.ok).toBe(true);
    expect(connectionDuringDelete).toBeNull();
  });
});
